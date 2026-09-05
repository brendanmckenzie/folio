/**
 * `ContentQuery` → SQL (`../../docs/specs/content-model/collections.md`
 * architecture decision 4).
 *
 * The shape of a query, its canonical form and its key live in `core/query.ts`,
 * because the admin and the renderer share them. This file is the half that knows
 * about D1, and it has three jobs and no others: refuse a field the schema does not
 * declare `indexed`, bind every value, and clamp the page.
 *
 * **Nothing is interpolated.** Every table and column name in here is a literal;
 * the only names a caller supplies — a document type, a field, a locale — are
 * *values* in this schema and travel as binds. So there is no string a client can
 * send that reaches SQL as SQL, and the `indexed` check exists for a different
 * reason: a filter on a field nobody indexed must be a 400 naming the field, never
 * a silent empty result. That is the failure mode that costs an afternoon.
 *
 * Offset pagination, not keyset (decision 2). Keyset is strictly better at scale
 * and the scale is wrong: a CMS index page is hundreds of rows deep, not millions,
 * and offset is what lets a page render "page 4 of 9" — which keyset cannot without
 * a count anyway. Revisit past ~10k rows in one collection.
 */
import type { Doc } from '../core/doc'
import type { LocaleContext } from '../core/locales'
import {
  BUILT_IN_ORDERS,
  type ContentItem,
  type ContentPage,
  type ContentQuery,
  type ContentWhere,
  isRangeOp,
  MAX_PER_PAGE,
  normaliseQuery,
} from '../core/query'
import { dataOf } from '../core/locales'
import { ftsQuery, splitSnippet } from '../core/search-projection'
import { projectValue } from '../core/index-projection'
import type { StoryMeta } from '../core/story'
import { FolioError } from './errors'
import { STORY_COLS, type StoryRow, toStoryMeta } from './stories'
import type { FolioDb } from './db'

/** A statement's text and its binds, kept together so a test can read both. */
export interface Sql {
  text: string
  binds: unknown[]
}

/** The three columns the search statement adds to a story row. Absent from
 * every non-search query, which is why each is optional here. */
interface SearchRow {
  score?: number
  snippet?: string | null
  fts_rowid?: number
}

/** `stories` columns the built-in sort keys name. */
const BUILT_IN_COLUMNS: Readonly<Record<string, string>> = {
  publishedAt: 'stories.published_at',
  ord: 'stories.ord',
  title: 'stories.title',
}

/** `%`, `_` and the escape character itself, so a filter for "50%" is a filter for "50%". */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`)

/**
 * One `where` clause as an `exists` (or `not exists`) subquery against
 * `(story_id, locale, field)` — the leading columns of `content_index`'s primary
 * key, so each one is an index seek. Several clauses are anded.
 */
function wherePredicate(w: ContentWhere, locale: string, n: number): Sql {
  const alias = `ci${n}`
  const head = `select 1 from content_index ${alias}
     where ${alias}.story_id = stories.id and ${alias}.locale = ? and ${alias}.field = ?`
  const binds: unknown[] = [locale, w.field]

  if (isRangeOp(w.op)) {
    const op = w.op === 'gt' ? '>' : w.op === 'gte' ? '>=' : w.op === 'lt' ? '<' : '<='
    // A numeric bound compares `num_value`, a string bound `text_value`. An ISO
    // date is stored in both columns, so either spelling of "since March" works.
    const column = typeof w.value === 'number' ? 'num_value' : 'text_value'
    binds.push(w.value)
    return { text: `exists (${head} and ${alias}.${column} ${op} ?)`, binds }
  }

  switch (w.op) {
    case 'eq':
      binds.push(scalar(w.value))
      return { text: `exists (${head} and ${alias}.text_value = ?)`, binds }
    case 'ne': {
      // `not exists`, deliberately, so a document with **no value** for the field
      // matches. "topic is not 'ai'" is true of an insight with no topic, and an
      // `exists (… <> ?)` would silently exclude every one of them.
      binds.push(scalar(w.value))
      return { text: `not exists (${head} and ${alias}.text_value = ?)`, binds }
    }
    case 'in': {
      const values = Array.isArray(w.value) ? w.value : [w.value]
      if (values.length === 0) return { text: '0 = 1', binds: [] }
      const holes = values.map(() => '?').join(', ')
      binds.push(...values)
      return { text: `exists (${head} and ${alias}.text_value in (${holes}))`, binds }
    }
    case 'startsWith':
      binds.push(`${escapeLike(String(scalar(w.value)))}%`)
      return { text: `exists (${head} and ${alias}.text_value like ? escape '\\')`, binds }
    case 'contains':
      binds.push(`%${escapeLike(String(scalar(w.value)))}%`)
      return { text: `exists (${head} and ${alias}.text_value like ? escape '\\')`, binds }
  }
}

const scalar = (value: string | number | readonly string[]): string | number =>
  Array.isArray(value) ? (value[0] ?? '') : (value as string | number)

/**
 * What `contentSql` needs of `ResolvedGate` (`gate.ts`) to scope a search
 * (`../../docs/specs/content-model/full-text-search.md` decision 11). Structural
 * rather than the resolved object itself, so this file stays a pure compiler
 * with no opinion about how a gate is configured or validated.
 */
export interface SearchGate {
  /** The root-block field holding the gate value. `indexed: true`, guaranteed. */
  field: string
  /** The one value that means "no gate". */
  public: string | number | boolean
  /**
   * The **document type** names whose root declares the field — `stories.type`,
   * which is the only thing SQL can see. Not the root block names: SQL cannot
   * see those, and two types may share one root.
   */
  types: ReadonlySet<string>
}

/**
 * Decision 11: on a gated deployment a search is scoped to the gate's public
 * value, because `snippet()` hands back a marked extract of precisely the prose
 * `redactDoc` exists to withhold.
 *
 * **The predicate keys off `stories.type`, and that is the load-bearing line in
 * this file.** `projectValue` answers null for an absent value, so a document
 * with no value for an indexed field gets *no* `content_index` row — which makes
 * two very different documents identical to any test for a missing row: a
 * `record` whose root never declares the gate field, which must stay searchable,
 * and a gated `page` that declares it and holds nothing, which spec 31
 * checkpoint 2 fails **closed**. `exists … or not exists …` would admit the
 * second and silently reverse that checkpoint; requiring the row outright would
 * exclude the first and make records unsearchable. The type list tells them
 * apart: absence from it means "this type has no gate at all", and a declaring
 * type with no value falls to the `exists` and is excluded, which is what
 * fail-closed means here.
 */
function gatePredicate(gate: SearchGate, locale: string): Sql {
  const types = [...gate.types]
  const holes = types.map(() => '?').join(', ')
  // The value as `content_index` stores it, through the same function publish
  // wrote the row with: a `boolean` is 'true'/'false' there and a `number` is
  // its digits, so comparing against the raw config value would compare a
  // boolean bind to a text column. Null (an empty-string `public`) binds `''`,
  // which no row holds either — the same exclusion, arrived at honestly.
  const value = projectValue(gate.public)?.text ?? ''
  return {
    text: `(stories.type not in (${holes})
      or exists (select 1 from content_index cg
                  where cg.story_id = stories.id and cg.locale = ?
                    and cg.field = ? and cg.text_value = ?))`,
    binds: [...types, locale, gate.field, value],
  }
}

/**
 * The two statements a query runs: a `count(*)` for `total`, and the page itself.
 *
 * The page selects `published_doc` alongside the story columns rather than taking a
 * third round trip through `publishedDocsByIds`: the bytes are identical either
 * way, and the id list it would bind is the id list this statement just produced.
 * The spec costed the read at three statements; two is the same work with one fewer
 * hop.
 */
export function contentSql(
  q: ContentQuery,
  indexed: ReadonlySet<string>,
  /** The index locale key: `''` for the source locale. */
  locale: string,
  perPageMax = MAX_PER_PAGE,
  /** `ResolvedGate`, narrowed. Decision 11; absent on an ungated deployment,
   * and then not one character of SQL below changes. */
  gate?: SearchGate,
): { count: Sql; page: Sql; normalised: ReturnType<typeof normaliseQuery> } {
  const n = normaliseQuery(q, perPageMax)

  for (const w of n.where) {
    if (!indexed.has(w.field)) throw unknownField(w.field, indexed)
  }
  const builtInOrder = n.order.field in BUILT_IN_ORDERS
  if (!builtInOrder && !indexed.has(n.order.field)) throw unknownField(n.order.field, indexed)
  // `relevance` sorts by a column that is only in the statement when there is a
  // `MATCH` to score. Refused rather than quietly demoted to `publishedAt`: a
  // list silently sorted by something other than what was asked for is the
  // failure nobody notices.
  if (n.order.field === 'relevance' && n.search === undefined) {
    throw new FolioError('bad_request', "order 'relevance' needs a search")
  }

  // `contains` is a `like '%x%'`, which cannot use the index — it is a scan of
  // every row for the field. Allowed, and capped: only alongside something that
  // *can* narrow first, so the scan is over a type's rows rather than the site's.
  // `search` counts as narrowing, and is the strongest of the four: the join
  // hands the scan the handful of rows FTS5 matched.
  const narrowing =
    n.search !== undefined ||
    n.type.length > 0 ||
    n.parent !== undefined ||
    n.where.some((w) => w.op !== 'contains')
  if (n.where.some((w) => w.op === 'contains') && !narrowing) {
    throw new FolioError(
      'bad_request',
      "A 'contains' filter is a scan; combine it with a type, a parent or another filter",
    )
  }

  // Visitor input as `MATCH` syntax, or null when it held no token at all
  // (`???`, an emoji). Null is an *answer*, not an error: the statement below
  // gets `0 = 1` and no join, which is an honest empty page rather than a 500
  // or — far worse — everything.
  const match = n.search === undefined ? null : ftsQuery(n.search)
  const searching = match !== null

  const clauses: string[] = ['stories.published_doc is not null']
  const binds: unknown[] = []

  if (n.type.length > 0) {
    clauses.push(`stories.type in (${n.type.map(() => '?').join(', ')})`)
    binds.push(...n.type)
  }
  if (n.parent !== undefined) {
    if (n.parent === null) clauses.push('stories.parent_id is null')
    else {
      clauses.push('stories.parent_id = ?')
      binds.push(n.parent)
    }
  }
  n.where.forEach((w, i) => {
    const pred = wherePredicate(w, locale, i)
    clauses.push(pred.text)
    binds.push(...pred.binds)
  })

  // Decision 11, and its opt-out. A caller who names the gate field in a `where`
  // has taken the scoping on itself — `where: [{ field: 'access', op: 'in',
  // value: ['public', 'members'] }]` is how a host builds a members' search over
  // members' content — and the same double enforcement `filterable` uses says
  // the caller wins. Emitted last, so its binds land last among the where binds.
  if (gate && n.search !== undefined && gate.types.size > 0) {
    if (!n.where.some((w) => w.field === gate.field)) {
      const pred = gatePredicate(gate, locale)
      clauses.push(pred.text)
      binds.push(...pred.binds)
    }
  }

  // Decision 5's empty token set. The clause rather than an early return so
  // every other refusal above has already had its say.
  if (n.search !== undefined && !searching) clauses.push('0 = 1')

  const where = clauses.join(' and ')
  const dir = n.order.dir === 'asc' ? 'asc' : 'desc'

  // `s.id` is appended to every sort, always. Without a total order, offset
  // pagination is free to show one row on two pages and skip another entirely.
  const orderBinds: unknown[] = []
  let join = ''
  let orderBy: string
  if (n.order.field === 'relevance') {
    // No join to sort by when the term held no token: the page is empty and the
    // id tiebreak is the whole of the order.
    orderBy = searching ? `fts.score ${dir}, stories.id asc` : 'stories.id asc'
  } else if (builtInOrder) {
    orderBy = `${BUILT_IN_COLUMNS[n.order.field]} ${dir}, stories.id asc`
  } else {
    join = `left join content_index co
              on co.story_id = stories.id and co.locale = ? and co.field = ?`
    orderBinds.push(locale, n.order.field)
    // `nulls last` spelled out rather than left to SQLite's default: a document
    // with no value for the sort field has no index row, and where it lands must
    // not depend on the direction. `num_value` first so a date or a number sorts
    // numerically, `text_value` behind it for a field that is neither.
    orderBy = `co.num_value ${dir} nulls last, co.text_value ${dir} nulls last, stories.id asc`
  }

  const limit = [n.perPage, (n.page - 1) * n.perPage]

  if (!searching) {
    return {
      count: { text: `select count(*) as n from stories where ${where}`, binds },
      page: {
        // Order binds come first: they are in the JOIN, which precedes the WHERE.
        text: `select ${STORY_COLS}, published_doc from stories ${join} where ${where}
             order by ${orderBy} limit ? offset ?`,
        binds: [...orderBinds, ...binds, ...limit],
      },
      normalised: n,
    }
  }

  // One row per matching (story, locale), and the locale filter is an equality
  // *after* the match rather than a term inside it: fallback text is indexed
  // under each locale at publish, so a French visitor's hit is a French row.
  // `content_fts` is never aliased in here — FTS5's hidden `MATCH` column bears
  // the table's own name, and an alias makes `content_fts match ?` unresolvable.
  const matchJoin = (cols: string) => `join (select ${cols}
                      from content_fts
                      join content_text ct on ct.id = content_fts.rowid
                     where content_fts match ? and ct.locale = ?) fts
                 on fts.story_id = stories.id`

  const inner = `select ${STORY_COLS}, published_doc, fts.score, fts.rowid as fts_rowid
             from stories
             ${matchJoin('ct.story_id, ct.id as rowid, -bm25(content_fts, 10.0, 1.0) as score')}
             ${join} where ${where}
             order by ${orderBy} limit ? offset ?`

  return {
    count: {
      text: `select count(*) as n from stories
             ${matchJoin('ct.story_id')}
             where ${where}`,
      binds: [match, locale, ...binds],
    },
    page: {
      // **The snippet is a correlated subquery over the paged rows, and that is
      // the whole reason for the nesting.** Inside the match subquery `snippet()`
      // would run for every hit before the sort — a 2,000-hit query reading 2,000
      // bodies to show twenty. Out here it runs `perPage` times, and
      // `match ? and rowid = ?` is an equality probe FTS5 answers directly.
      //
      // The select-list `?` is textually first, so it binds first: the order is
      // [snippet match, join match, locale, order, where, limit, offset].
      text: `select p.*,
                    (select snippet(content_fts, 1, char(1), char(2), '…', 32)
                       from content_fts
                      where content_fts match ? and content_fts.rowid = p.fts_rowid) as snippet
             from (${inner}) p`,
      binds: [match, match, locale, ...orderBinds, ...binds, ...limit],
    },
    normalised: n,
  }
}

function unknownField(field: string, indexed: ReadonlySet<string>): FolioError {
  const known = [...indexed].sort().join(', ')
  return new FolioError(
    'bad_request',
    known
      ? `No indexed field named '${field}'. Queryable fields: ${known}`
      : `No indexed field named '${field}'. No field is marked 'indexed: true' on a root block`,
  )
}

export interface QueryDeps {
  db: FolioDb
  /** Field names marked `indexed` on some declared type's root block. */
  indexed: ReadonlySet<string>
  /** A locale code as `content_index` keys it: `''` for the source or an unknown code. */
  localeKey: (code: string | undefined) => string
  /** A story's public URL, for the item's `url`. `FolioRuntime.withUrls`. */
  withUrls: <T extends StoryMeta>(story: T) => T
  /** `FolioRuntime.gate`, narrowed — absent on a deployment with no gate.
   * Scopes a `search` and nothing else (decision 11). */
  gate?: SearchGate
}

/**
 * A query, run: two statements, then the page's rows turned into
 * `ReferenceTarget`s — the shape `reference` already resolves to, so a block author
 * who can render a reference can render a collection item.
 *
 * `locale` reads each item's root-block `data` in the render's language, exactly as
 * `resolveReference` does, so an item's fields and a referenced document's fields
 * come back in the same language.
 */
export async function runQuery(
  deps: QueryDeps,
  q: ContentQuery,
  opts: { locale?: LocaleContext; perPageMax?: number } = {},
): Promise<ContentPage> {
  // `opts.locale` wins over `q.locale`: a render's locale rides on the
  // `Resolution`, deliberately *outside* the query — so `queryKey` is the same
  // string in every language and a French page and an English one share one
  // canonical form. An HTTP caller has no resolution and names the locale in the
  // query instead.
  const localeKey = opts.locale ? opts.locale.code : deps.localeKey(q.locale)
  const { count, page, normalised } = contentSql(
    q,
    deps.indexed,
    localeKey,
    opts.perPageMax,
    deps.gate,
  )

  const [totalRow, rows] = await Promise.all([
    deps.db
      .prepare(count.text)
      .bind(...count.binds)
      .first<{ n: number }>(),
    deps.db
      .prepare(page.text)
      .bind(...page.binds)
      .all<StoryRow & SearchRow & { published_doc: string | null }>(),
  ])

  const total = totalRow?.n ?? 0
  const items: ContentItem[] = []
  for (const raw of rows.results) {
    const { published_doc, score, snippet, fts_rowid, ...row } = raw
    if (!published_doc) continue
    const doc = JSON.parse(published_doc) as Doc
    const story = deps.withUrls(toStoryMeta(row))
    const root = doc.bloks[doc.root]
    items.push({
      id: story.id,
      title: story.title,
      // `''` for an unrouted document, matching `StoryRef`: a record has no place
      // in the URL namespace, and a block testing `item.url` gets a falsy answer.
      path: story.path ?? '',
      url: story.path === null ? '' : (story.url ?? `/${story.path}`),
      data: root ? dataOf(root, opts.locale) : {},
      doc,
      // Only when the query asked, so a plain collection's items are byte for
      // byte what they were before search existed.
      ...(normalised.search === undefined
        ? {}
        : { score: score ?? 0, snippet: splitSnippet(snippet ?? null) }),
    })
  }

  return {
    items,
    total,
    page: normalised.page,
    perPage: normalised.perPage,
    pages: Math.ceil(total / normalised.perPage),
  }
}
