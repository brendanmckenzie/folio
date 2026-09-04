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
  type ContentPage,
  type ContentQuery,
  type ContentWhere,
  isRangeOp,
  MAX_PER_PAGE,
  normaliseQuery,
} from '../core/query'
import { dataOf } from '../core/locales'
import type { ReferenceTarget } from '../core/resolve'
import type { StoryMeta } from '../core/story'
import { FolioError } from './errors'
import { STORY_COLS, type StoryRow, toStoryMeta } from './stories'
import type { FolioDb } from './db'

/** A statement's text and its binds, kept together so a test can read both. */
export interface Sql {
  text: string
  binds: unknown[]
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
): { count: Sql; page: Sql; normalised: ReturnType<typeof normaliseQuery> } {
  const n = normaliseQuery(q, perPageMax)

  for (const w of n.where) {
    if (!indexed.has(w.field)) throw unknownField(w.field, indexed)
  }
  const builtInOrder = n.order.field in BUILT_IN_ORDERS
  if (!builtInOrder && !indexed.has(n.order.field)) throw unknownField(n.order.field, indexed)

  // `contains` is a `like '%x%'`, which cannot use the index — it is a scan of
  // every row for the field. Allowed, and capped: only alongside something that
  // *can* narrow first, so the scan is over a type's rows rather than the site's.
  // Full-text search is the real answer and is out of scope (D1 has FTS5; it is a
  // separate index, a separate write path and a separate ranking question).
  const narrowing =
    n.type.length > 0 || n.parent !== undefined || n.where.some((w) => w.op !== 'contains')
  if (n.where.some((w) => w.op === 'contains') && !narrowing) {
    throw new FolioError(
      'bad_request',
      "A 'contains' filter is a scan; combine it with a type, a parent or another filter",
    )
  }

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

  const where = clauses.join(' and ')
  const dir = n.order.dir === 'asc' ? 'asc' : 'desc'

  // `s.id` is appended to every sort, always. Without a total order, offset
  // pagination is free to show one row on two pages and skip another entirely.
  const orderBinds: unknown[] = []
  let join = ''
  let orderBy: string
  if (builtInOrder) {
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

  return {
    count: { text: `select count(*) as n from stories where ${where}`, binds },
    page: {
      // Order binds come first: they are in the JOIN, which precedes the WHERE.
      text: `select ${STORY_COLS}, published_doc from stories ${join} where ${where}
             order by ${orderBy} limit ? offset ?`,
      binds: [...orderBinds, ...binds, n.perPage, (n.page - 1) * n.perPage],
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
  const { count, page, normalised } = contentSql(q, deps.indexed, localeKey, opts.perPageMax)

  const [totalRow, rows] = await Promise.all([
    deps.db
      .prepare(count.text)
      .bind(...count.binds)
      .first<{ n: number }>(),
    deps.db
      .prepare(page.text)
      .bind(...page.binds)
      .all<StoryRow & { published_doc: string | null }>(),
  ])

  const total = totalRow?.n ?? 0
  const items: ReferenceTarget[] = []
  for (const raw of rows.results) {
    const { published_doc, ...row } = raw
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
