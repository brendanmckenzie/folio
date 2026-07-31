import { compareSiblings, type Doc, keyAtIndex } from '../core/doc'
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import {
  canNest,
  type DocumentType,
  isRouted,
  SINGLETON_PREFIX,
  singletonId,
  typeByName,
} from '../core/schema'
import {
  buildTree,
  DEFAULT_SEARCH_SORT,
  derivePaths,
  descendants,
  type DocumentSort,
  draftState,
  type FlatSort,
  type SearchSort,
  joinPath,
  newStoryId,
  slugify,
  storyState,
  type StoryFilter,
  type StoryMeta,
  type StoryNode,
} from '../core/story'
import { type Direction, type Keyset, keysetWhere, orderBy, SIBLING_ORDER, whereOf } from './keyset'
import {
  clearIndexStatements,
  clearInboundRefStatements,
  countReferencesTo,
  type IndexedValue,
  indexedValuesFor,
  referencesTo,
} from './content-index'
import type { StoryChange } from './hooks'
import { clearRedirectAtStatement, redirectStatements } from './redirects'
import { clearSchedulesStatements } from './schedules'

const COLS = `id, type, parent_id as parentId, slug, path, ord, title, title_i18n,
              published_at as publishedAt, unpublished_at as unpublishedAt,
              updated_at as updatedAt, draft_sync_id as draftSyncId,
              draft_updated_at as draftUpdatedAt, published_sync_id as publishedSyncId,
              schema_id as schemaId`

/**
 * `StoryState`, in SQL — the same rule `core/story.ts`'s `draftState` states in
 * TypeScript, over the same four stored columns.
 *
 * Needed because a state filter has to be answered **server-side** once a list is
 * paged: a client-side predicate over one page filters the page, not the site
 * (`../../../docs/specs/foundation/pagination.md` decision 4).
 *
 * A SQL expression rather than a stored `state` column, deliberately. A column
 * would be indexable and faster to filter, and it would be a denormalisation of
 * four values that can disagree with them — which here decides whether a page
 * appears in a publisher's list at all. Every input is already stored, so there is
 * nothing to gain by storing the conclusion too.
 *
 * **The risk this creates is two implementations of one rule**, so it is answered
 * with a test rather than a comment: `test/workers/story-state.test.ts` runs this
 * expression and `draftState` over the same rows and asserts they agree, including
 * the case where an edit that cancelled itself out still reads `changed`.
 *
 * Unqualified column names, matching `COLS`: every reader uses `from stories` with
 * no alias.
 */
export const STATE_EXPR = `case
  when published_at is not null and draft_sync_id > published_sync_id then 'changed'
  when published_at is not null then 'live'
  when unpublished_at is not null then 'unpublished'
  else 'draft'
end`

/**
 * `COLS`, for the one module that assembles its own `select` over `stories`:
 * `query.ts`, which joins `content_index` and therefore cannot go through any of
 * the readers here. Exported rather than duplicated so a column added to a story
 * row appears in a query result without anybody remembering to add it twice.
 *
 * Unqualified on purpose — `query.ts` uses `from stories` with no table alias, and
 * `content_index` shares none of these names, so there is nothing to qualify.
 */
export const STORY_COLS = COLS

/**
 * A `COLS` row before `state`/`hasUnpublishedChanges` are derived onto it.
 *
 * `title_i18n` keeps its column name rather than being aliased, because it is
 * JSON in D1 and a `string` here — `withState` is what turns it into the
 * `titleI18n` record callers see, so the parse happens once for every reader.
 */
export type StoryRow = Omit<StoryMeta, 'state' | 'hasUnpublishedChanges' | 'titleI18n'> & {
  title_i18n?: string | null
}

/**
 * `state` is derived here, once, rather than stored: the four columns it needs
 * (see `draftState`) are the only ones it reads, so every reader of a story row
 * — the tree, `folio.stories(env)`, a future content API — agrees on what a
 * badge means without a column that could itself drift out of sync with the
 * ones it summarises. `hasUnpublishedChanges` is the same derivation, named for
 * callers that only want the yes/no (`unpublished-changes.md`).
 */
function withState(row: StoryRow): StoryMeta {
  const { title_i18n, ...rest } = row
  const state = draftState(row.publishedAt, row.unpublishedAt, row.draftSyncId, row.publishedSyncId)
  return {
    ...rest,
    titleI18n: parseTitleI18n(title_i18n),
    state,
    hasUnpublishedChanges: state === 'changed',
  }
}

/**
 * `stories.title_i18n` as a record, or null.
 *
 * Total over its input, deliberately: this is a cache, and a row whose JSON was
 * hand-edited into nonsense must degrade to "no translated titles" — a tree
 * label falling back to the source locale — rather than throw out of every
 * story read on the site. Non-string values are dropped for the same reason.
 */
function parseTitleI18n(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const out: Record<string, string> = {}
  for (const [code, title] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof title === 'string') out[code] = title
  }
  return Object.keys(out).length > 0 ? out : null
}

/** `withState`, for `query.ts`. See `STORY_COLS`. */
export const toStoryMeta = withState

/**
 * Every story row.
 *
 * `opts` is `folio.stories(env, { page, perPage })`
 * (`../content-model/collections.md` decision 6): the unpaginated form still
 * answers everything, because a sitemap of 40 pages should not have to page, and a
 * sitemap of 2,000 now can. Ordered by `id` when paged, so the pages partition the
 * set — without an ORDER BY, SQLite's row order is not something to page over.
 */
export async function listStories(
  db: D1Database,
  opts?: { limit: number; offset: number },
): Promise<StoryMeta[]> {
  const { results } = opts
    ? await db
        .prepare(`select ${COLS} from stories order by id limit ? offset ?`)
        .bind(opts.limit, opts.offset)
        .all<StoryRow>()
    : await db.prepare(`select ${COLS} from stories`).all<StoryRow>()
  return results.map(withState)
}

/**
 * The story rows a narrowed resolution needs: some by id (a link's or a
 * reference's target), some by path (the rendered story's ancestors, for
 * breadcrumbs) — in **one** query, which is the whole reason ancestors are
 * addressed by path rather than walked up `parent_id`
 * (`../content-model/collections.md` decision 6, and `ancestorPaths`).
 *
 * Empty in, empty out: `in ()` is not valid SQL, and a document with no links,
 * no references and no ancestors should cost no read at all.
 */
export async function storiesFor(
  db: D1Database,
  ids: readonly string[],
  paths: readonly string[] = [],
): Promise<StoryMeta[]> {
  if (ids.length === 0 && paths.length === 0) return []
  const clauses: string[] = []
  if (ids.length > 0) clauses.push(`id in (${ids.map(() => '?').join(', ')})`)
  if (paths.length > 0) clauses.push(`path in (${paths.map(() => '?').join(', ')})`)
  const { results } = await db
    .prepare(`select ${COLS} from stories where ${clauses.join(' or ')}`)
    .bind(...ids, ...paths)
    .all<StoryRow>()
  return results.map(withState)
}

/**
 * How many bound parameters one `storiesFor` call may carry.
 *
 * D1's own ceiling is higher; this is deliberately conservative because the
 * caller's input is not — a document with three hundred internal links is
 * legitimate (`pagination.md`'s edge cases), and so is a breadcrumb over a deep
 * path. The chunk size is the constraint's, not the caller's.
 */
const BIND_CHUNK = 100

/**
 * `storiesFor`, chunked, deduplicated by id, and safe for any size of input.
 *
 * This is what `GET {base}/api/stories?ids=` answers with, and the reason it is
 * not just `storiesFor`: the route's input arrives off a query string, so its
 * length is whatever a client sent. Rows come back in no particular order — a
 * batch by id is not a page, and its consumer looks rows up by id rather than
 * reading them in sequence.
 */
export async function storiesForChunked(
  db: D1Database,
  ids: readonly string[],
  paths: readonly string[] = [],
): Promise<StoryMeta[]> {
  const batches: Promise<StoryMeta[]>[] = []
  for (let at = 0; at < ids.length; at += BIND_CHUNK) {
    batches.push(storiesFor(db, ids.slice(at, at + BIND_CHUNK)))
  }
  for (let at = 0; at < paths.length; at += BIND_CHUNK) {
    batches.push(storiesFor(db, [], paths.slice(at, at + BIND_CHUNK)))
  }
  const seen = new Map<string, StoryMeta>()
  for (const rows of await Promise.all(batches)) {
    // An id and a path can name the same row — a breadcrumb's leaf is its own
    // ancestor chain's last entry — so the dedupe is not defensive, it is the
    // normal case.
    for (const row of rows) seen.set(row.id, row)
  }
  return [...seen.values()]
}

/**
 * The page tree. `buildTree` drops unrouted rows, so this is `page`-kind types
 * only without a `where` clause of its own — the same list every reader of the
 * tree gets (`document-types.md`). `listDocuments` is the unrouted counterpart.
 *
 * **No route answers with this any more.** `GET {base}/api/stories` pages one
 * level at a time (`listStoryLevel`), so the only callers left are server-side
 * ones that genuinely need the whole shape — and the tree is a shape, not a list,
 * which is why it is still here rather than deleted.
 */
export async function storyTree(db: D1Database): Promise<StoryNode[]> {
  return buildTree(await listStories(db))
}

/* --------------------------------------------------------- paged tree reads --- */

/**
 * One story row plus how many children it has.
 *
 * **A finding from building the Content screen, not something the spec asked
 * for.** Per-level paging means the client no longer holds `node.children`, so
 * nothing tells it whether a row has a disclosure twisty — and the two wrong
 * answers are both visible: draw a twisty on every row and half of them open on
 * nothing, or draw none and a site's structure becomes unreachable.
 *
 * A correlated subquery over `stories_parent_ord`, so it costs one index probe
 * per row of the page rather than a scan. `path is not null` inside it for the
 * same reason the level query has it: an unrouted document carries
 * `parent_id = null` and is not a child of anything in the tree.
 */
export interface StoryLevelRow extends StoryMeta {
  childCount: number
}

/**
 * Every ordering a story list can be read in, as keysets — flat mode's three
 * (`FlatSort`) and the Documents screen's three (`DocumentSort`), which overlap
 * in two.
 *
 * One table rather than one per reader, because `edited` is a **rule** and not
 * merely a column list. `draft_updated_at` is nullable — null until a document's
 * first debounced write — and SQLite sorts nulls last under `desc`, so ordering by
 * the bare column puts a page created five minutes ago *below* one last edited
 * three years ago, in a list called "last edited". The coalesce is what makes it
 * mean what it says, `stories_edited` indexes exactly that expression
 * (`migrations/0001_init.sql`), and `admin/ui/screens/content-rows.ts`'s `when()`
 * is the same rule a third time in TypeScript. Two copies of it in this file was
 * one too many.
 *
 * `path` needs no real tiebreak — `stories_path` is unique over non-null paths —
 * but it gets `id` anyway so every sort goes through one code path.
 */
const ORDERS = {
  ord: SIBLING_ORDER,
  edited: { columns: ['coalesce(draft_updated_at, updated_at)', 'id'], direction: 'desc' },
  title: { columns: ['title', 'id'], direction: 'asc' },
  path: { columns: ['path', 'id'], direction: 'asc' },
} satisfies Record<FlatSort | DocumentSort, Keyset>

/**
 * The sort key of a row, component for component with `ORDERS`. The
 * correspondence is the one thing `paginate` cannot check for its caller, which
 * is why both live in one place rather than beside their own reader.
 */
function keyOf(order: keyof typeof ORDERS, row: StoryMeta): [string | number, string] {
  switch (order) {
    case 'ord':
      return [row.ord, row.id]
    case 'edited':
      return [row.draftUpdatedAt ?? row.updatedAt, row.id]
    case 'title':
      return [row.title, row.id]
    case 'path':
      return [row.path ?? '', row.id]
  }
}

export interface StoryPageOptions {
  limit?: number
  cursor?: string
  /** Everything except `parentId`, which the level reader takes as its own
   * argument because it is structure rather than a filter. */
  filter?: StoryFilter
  /** Adds `total` for the same filter — one extra `count(*)`, only when asked
   * (`../../../docs/specs/foundation/pagination.md` decision 5). */
  count?: boolean
}

/**
 * The `where` fragments and binds for the filters the story reads share.
 *
 * `state` goes through `STATE_EXPR` rather than a stored column, which is what
 * makes a state chip answerable server-side once the list is paged: a
 * client-side predicate over one page filters the page, not the site.
 *
 * **`parentId` and `routed` are here but no list route sends them.** Each paged
 * reader below states its own scope positionally — `listStoryLevel` takes the
 * parent, `listStoriesFlat` and `listDocumentPage` hardcode their side of `path is
 * not null` — because for those two readers the scope is the list's *identity*
 * rather than a narrowing of it, and `storyFilterQuery` deliberately reads neither
 * off a query string. The one caller that sends them is a **captured selection**
 * (`../../../docs/specs/platform/bulk-writes.md`), which has no positional
 * arguments to state a scope with: it is a JSON object that has to reproduce the
 * exact set a list header counted. A filter carrying `routed: true` into
 * `listStoriesFlat` would therefore emit `path is not null` twice, which is a
 * harmless no-op, and one carrying `routed: false` would emit a contradiction and
 * answer nothing — so don't; the two keys belong to `countStories` and
 * `storiesMatching`.
 */
function storyFilters(
  filter: StoryFilter | undefined,
  opts: { indexedText?: boolean } = {},
): { sql: string[]; binds: unknown[] } {
  const sql: string[] = []
  const binds: unknown[] = []
  if (!filter) return { sql, binds }
  // Absent is every level; `null` is the top one. `!== undefined` rather than
  // `in`, because a valibot-parsed body carries the key with an `undefined` value
  // for an absent optional and the two must stay tellable apart.
  if (filter.parentId !== undefined) {
    if (filter.parentId === null) {
      sql.push('parent_id is null')
    } else {
      sql.push('parent_id = ?')
      binds.push(filter.parentId)
    }
  }
  if (filter.routed !== undefined) {
    sql.push(filter.routed ? 'path is not null' : 'path is null')
  }
  if (filter.type) {
    sql.push('type = ?')
    binds.push(filter.type)
  }
  if (filter.state) {
    sql.push(`(${STATE_EXPR}) = ?`)
    binds.push(filter.state)
  }
  if (filter.q) {
    // Title, slug and path: the three things a person types when looking for a
    // page, and the same three `matches` compared client-side in the prototype.
    // `coalesce(path, '')` because an unrouted row has none and `null like ?` is
    // null rather than false — which would drop the whole row from an OR chain.
    const like = `%${filter.q}%`
    if (opts.indexedText) {
      sql.push(`(title like ? or slug like ? or coalesce(path, '') like ? or ${INDEXED_TEXT})`)
      binds.push(like, like, like, like)
    } else {
      sql.push("(title like ? or slug like ? or coalesce(path, '') like ?)")
      binds.push(like, like, like)
    }
  }
  return { sql, binds }
}

/**
 * Does any of this document's **indexed values** contain the search term?
 *
 * Opt-in rather than always on, because it changes what a search box reaches and
 * therefore what it costs. Two callers want it and one does not:
 *
 *  - The **Documents screen's** search box does. `DataTable.tsx`'s `filterRows`
 *    matched the title *and every indexed value* on screen, so a person searching
 *    People for `Analyst` found the row. Dropping that when the search moved
 *    server-side would be a silent regression in the one place the values are the
 *    columns.
 *  - `GET {base}/api/search` does, and it is half of what
 *    `pagination.md` decision 8 specifies: "over `stories.title`, `slug`, `path`
 *    **and `content_index`'s text values**".
 *  - The **tree and flat reads** do not. Their columns are title, slug, path and
 *    state — nothing on those rows comes from `content_index`, so matching on it
 *    would return pages for a reason the list cannot show.
 *
 * A correlated `exists` probing `(story_id, locale, …)`, which is
 * `content_index`'s primary-key prefix, so it is one index probe per candidate
 * row rather than a scan of the table. `locale = ''` matches
 * `indexedValuesFor`: the source locale is what the columns show, so it is what
 * the search over those columns reaches.
 */
const INDEXED_TEXT = `exists (select 1 from content_index ci
                              where ci.story_id = stories.id
                                and ci.locale = ''
                                and ci.text_value like ?)`

/**
 * One parent's children, paged over `(ord, id)`.
 *
 * `(ord, id)` is exactly what `core/doc.ts`'s `compareSiblings` compares and
 * exactly what `stories_parent_ord` covers, so the page boundary is total even
 * when two clients insert between the same neighbours and produce the same `ord`
 * (`../../../docs/specs/foundation/pagination.md` decision 2).
 *
 * `parentId: null` is the top level, and it is **not** the same as absent — which
 * is why it is a positional argument rather than something to forget inside
 * `filter`. `path is not null` is what keeps records and singletons out: every
 * unrouted row carries `parent_id = null`, so without it the top level of the
 * page tree would list every record on the site.
 */
export async function listStoryLevel(
  db: D1Database,
  parentId: string | null,
  opts: StoryPageOptions = {},
): Promise<Page<StoryLevelRow>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const resume = keysetWhere(SIBLING_ORDER, cursor)
  const filters = storyFilters(opts.filter)

  const scope = parentId === null ? 'parent_id is null' : 'parent_id = ?'
  const scopeBinds = parentId === null ? [] : [parentId]
  const narrow = ['path is not null', scope, ...filters.sql]
  const narrowBinds = [...scopeBinds, ...filters.binds]

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLS}, ${CHILD_COUNT} from stories
         ${whereOf(...narrow, resume.sql)} ${orderBy(SIBLING_ORDER)} limit ?`,
      )
      .bind(...narrowBinds, ...resume.binds, limit + 1)
      .all<StoryRow & { childCount: number }>(),
    opts.count
      ? db
          .prepare(`select count(*) as n from stories ${whereOf(...narrow)}`)
          .bind(...narrowBinds)
          .first<{ n: number }>()
      : null,
  ])

  const page = paginate(
    rows.results.map((row) => ({ ...withState(row), childCount: row.childCount })),
    limit,
    (row) => [row.ord, row.id],
  )
  return total ? { ...page, total: total.n } : page
}

/** The correlated child count. See `StoryLevelRow`. */
const CHILD_COUNT = `(select count(*) from stories kids
                      where kids.parent_id = stories.id and kids.path is not null) as childCount`

/**
 * Every routed page, flat and paged, in one of three orderings — the `[ Tree |
 * Flat ]` toggle's other half (`pagination.md` decision 2a).
 *
 * Two views of one thing, because they answer different questions: a tree tells
 * you how the site is *shaped*, a flat sortable list tells you what was touched
 * last, and on a large site the second is how a person finds anything. No
 * `childCount`, because flat mode has no structure to disclose.
 */
export async function listStoriesFlat(
  db: D1Database,
  sort: FlatSort,
  opts: StoryPageOptions = {},
): Promise<Page<StoryMeta>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const keyset = ORDERS[sort]
  const resume = keysetWhere(keyset, cursor)
  const filters = storyFilters(opts.filter)
  const narrow = ['path is not null', ...filters.sql]

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLS} from stories ${whereOf(...narrow, resume.sql)} ${orderBy(keyset)} limit ?`,
      )
      .bind(...filters.binds, ...resume.binds, limit + 1)
      .all<StoryRow>(),
    opts.count
      ? db
          .prepare(`select count(*) as n from stories ${whereOf(...narrow)}`)
          .bind(...filters.binds)
          .first<{ n: number }>()
      : null,
  ])

  const page = paginate(rows.results.map(withState), limit, (row) => keyOf(sort, row))
  return total ? { ...page, total: total.n } : page
}

/* ---------------------------------------------------- the document listing --- */

/**
 * One document row as the Documents screen's table wants it: the story, plus the
 * **published** values of its type's `indexed` fields.
 *
 * On the row rather than in a sibling map keyed by id, which is what the unpaged
 * route answered with. `StoryLevelRow`'s `childCount` set the precedent one phase
 * ago, and paging is what turns the precedent into a rule: a map covering one
 * page's ids is a structure the client has to zip against `rows`, and a map left
 * over from the *previous* page would quietly supply values for rows no longer on
 * screen. A self-describing row cannot do that.
 *
 * Two honest limits, both inherited from `indexedValuesFor` and both visible in
 * the UI rather than hidden. Values are **published**, because `content_index` is
 * written inside the publish batch — so a draft document's cells are blank, and
 * the screen's `changed` badge is what explains a cell that disagrees with the
 * document. And they are the **source locale** only: a column per locale is a
 * second dimension nobody asked for.
 */
export interface DocumentRow extends StoryMeta {
  indexed: Record<string, IndexedValue>
}

export interface DocumentPageOptions extends StoryPageOptions {
  /** Fetch the `indexed` values. Skipped on a site that marks nothing `indexed`,
   * where the query would be one round trip for an empty answer. */
  indexed?: boolean
  /**
   * Reverses the ordering. Absent means each sort's natural direction — `title`
   * ascending, `edited` newest first — which is what a column header shows on its
   * first click.
   *
   * Free to support and worth supporting: `keysetWhere` and `orderBy` both read
   * the direction off the `Keyset`, so flipping one flips the comparison and the
   * `order by` together and cannot leave them disagreeing. `DataTable.tsx` toggled
   * direction on every column, so a paged replacement that could only sort one way
   * would be a regression somebody notices on the first click.
   */
  dir?: Direction
}

/**
 * One type's documents, paged — the Documents screen's list
 * (`ui-architecture.md` port phase 3), and the last unbounded read the admin had.
 *
 * `sort` is one of three `stories` columns and never an `indexed` field;
 * `core/story.ts`'s `DocumentSort` carries that argument and the two shapes it
 * beat. `ord` rides the `stories_type (type, ord)` index that already exists,
 * which is the ordering this listing had before it was paged.
 *
 * With a `type`, that type's rows **whether they are routed or not**, so a page
 * type's flat listing is reachable too. With no `type`, every *unrouted* document
 * across every type — records and singletons, which is what "not in the tree"
 * means.
 *
 * **It no longer ensures singletons.** That moved to `listSingletons`, because
 * ensuring is a write and a write must not depend on which page was asked for:
 * `?cursor=` would otherwise decide whether a document comes into existence. The
 * route keeps the rule the old one embodied — *asking is what creates a
 * singleton* — by making the thing you ask for the singletons themselves.
 */
export async function listDocumentPage(
  db: D1Database,
  type: string | undefined,
  sort: DocumentSort,
  opts: DocumentPageOptions = {},
): Promise<Page<DocumentRow>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const keyset: Keyset = opts.dir ? { ...ORDERS[sort], direction: opts.dir } : ORDERS[sort]
  const resume = keysetWhere(keyset, cursor)
  // `type` is the positional argument and not `filter.type`, for the same reason
  // `parentId` is on the level reader: it is the list's identity rather than a
  // narrowing of it, and its absence means something specific (every unrouted
  // document) rather than "any type".
  const filters = storyFilters(opts.filter, { indexedText: true })
  const narrow = type ? ['type = ?', ...filters.sql] : ['path is null', ...filters.sql]
  const narrowBinds = type ? [type, ...filters.binds] : filters.binds

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLS} from stories ${whereOf(...narrow, resume.sql)} ${orderBy(keyset)} limit ?`,
      )
      .bind(...narrowBinds, ...resume.binds, limit + 1)
      .all<StoryRow>(),
    opts.count
      ? db
          .prepare(`select count(*) as n from stories ${whereOf(...narrow)}`)
          .bind(...narrowBinds)
          .first<{ n: number }>()
      : null,
  ])

  const page = paginate(rows.results.map(withState), limit, (row) => keyOf(sort, row))
  // Over the page's ids only, and *after* the window has been cut rather than
  // over the over-fetched row too: the extra row exists to answer "is there
  // more" and is never shown, so fetching its values would be work for a cell
  // nobody draws.
  const indexed = opts.indexed
    ? await indexedValuesFor(
        db,
        page.rows.map((row) => row.id),
      )
    : {}
  const rowsWithValues = page.rows.map((row) => ({ ...row, indexed: indexed[row.id] ?? {} }))
  return total
    ? { ...page, rows: rowsWithValues, total: total.n }
    : { ...page, rows: rowsWithValues }
}

/**
 * Every declared singleton, ensured into existence and returned.
 *
 * **Uncursored, and that is not an exception to "no list is unbounded".** A
 * singleton set is bounded by the *schema* rather than by content: `types` is a
 * literal in the host's `createFolio` call, so this list cannot grow when somebody
 * publishes. `?ids=` is uncursored for the same reason — a batch whose size the
 * caller already knows is not a page.
 *
 * This is where "asking is what creates a singleton" now lives. An editor never
 * creates one — there is exactly one and its id is derived — so first *access* is
 * the only moment left, and the admin's shell needs them to exist before anybody
 * clicks a global in the sidebar (`nav.ts` links straight at `sng_<type>`). One
 * bounded request at boot replaces the whole-table read that used to carry this
 * side effect.
 */
export async function listSingletons(
  db: D1Database,
  types: readonly DocumentType[],
  schemaId: string | null = null,
): Promise<StoryMeta[]> {
  const singletons = types.filter((t) => t.kind === 'singleton')
  const rows: StoryMeta[] = []
  // Sequential rather than `Promise.all`: each is a read then a conditional
  // insert on the same table, and a site declares a handful of globals, not
  // hundreds. Declaration order is also the order the sidebar shows them in.
  for (const type of singletons) rows.push(await ensureSingleton(db, type, schemaId))
  return rows
}

/* ------------------------------------------------------- site-wide recency --- */

/**
 * The most recently edited documents, **across every type** — pages, records and
 * singletons together.
 *
 * `ui-architecture.md` dependency 5, and the other half of what Home's *Latest
 * changes* block is. `listStoriesFlat` looks like it already answers this and does
 * not: it filters `path is not null`, so it is every routed *page*. "What was
 * touched last" on a site whose editors spend the afternoon on People has to
 * include People.
 *
 * That one dropped clause is the whole difference in the SQL and the whole point of
 * the reader existing separately rather than gaining a flag. A `routed?: boolean`
 * option on `listStoriesFlat` would have been smaller and would have made the flat
 * *screen* one boolean away from silently listing records in the page tree's twin —
 * which is exactly the confusion `path is not null` exists to prevent.
 *
 * Ordered by the `edited` coalesce, so `stories_edited` covers it with no new index:
 * `draft_updated_at` is null until a document's first debounced write, and SQLite
 * sorts nulls last under `desc`, so the bare column would put a document created
 * five minutes ago below one last edited three years ago. The same rule
 * `content-rows.ts`'s `when()` states in TypeScript and `ORDERS.edited` states in
 * SQL, and the reason both say so out loud.
 */
export async function listRecentlyEdited(
  db: D1Database,
  opts: StoryPageOptions = {},
): Promise<Page<StoryMeta>> {
  const limit = clampLimit(opts.limit, 20, 100)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const keyset = ORDERS.edited
  const resume = keysetWhere(keyset, cursor)
  const filters = storyFilters(opts.filter)

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLS} from stories ${whereOf(...filters.sql, resume.sql)} ${orderBy(keyset)} limit ?`,
      )
      .bind(...filters.binds, ...resume.binds, limit + 1)
      .all<StoryRow>(),
    opts.count
      ? db
          .prepare(`select count(*) as n from stories ${whereOf(...filters.sql)}`)
          .bind(...filters.binds)
          .first<{ n: number }>()
      : null,
  ])

  const page = paginate(rows.results.map(withState), limit, (row) => keyOf('edited', row))
  return total ? { ...page, total: total.n } : page
}

/**
 * How many documents match a filter, and nothing else.
 *
 * Home's quick-access cards want a number per type and no rows at all. Asking the
 * list route for `?limit=1&count=1` answers it and pays for a row nobody draws plus
 * a cursor nobody follows — which is what Home's page-count card does today, and it
 * is fine for one card and wrong for one per declared type.
 *
 * The same `count(*)` the list routes run, over the same `storyFilters`, so the
 * number on a card and the number in `Showing n of N` cannot disagree — which is the
 * property `pagination.md` decision 5 asks for when it says one count implementation
 * serves the header and the bulk guard. **It is now literally the bulk guard**
 * (`../../../docs/specs/platform/bulk-writes.md` decision 3): the number a person
 * read and the number the server re-checks come out of this one function.
 *
 * `routed` used to be a third positional argument. It is `filter.routed` now, for
 * the reason the field's own doc gives: a captured selection is JSON and has no
 * positional arguments to put a scope in, and two ways of saying "pages only" is
 * exactly the drift decision 5 exists to prevent.
 */
export async function countStories(db: D1Database, filter?: StoryFilter): Promise<number> {
  const filters = storyFilters(filter)
  const row = await db
    .prepare(`select count(*) as n from stories ${whereOf(...filters.sql)}`)
    .bind(...filters.binds)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * One batch of the documents a filter matches, walked by `id`, for a bulk write
 * (`../../../docs/specs/platform/bulk-writes.md`).
 *
 * **By `id` rather than by any of the orderings a screen offers**, because the set
 * this walks is *changing as it is walked*: a bulk publish removes each row it
 * touches from `state = 'draft'`, a delete removes it from everything. `id` is the
 * primary key, it is stable under every write here, and it is the same reason
 * `storiesBehind` and `publishedDocsAfter` walk by it. A keyset over
 * `coalesce(draft_updated_at, updated_at)` would resume after a value the job had
 * just changed.
 *
 * `exclude` is applied in **SQL** rather than by filtering the rows afterwards, so a
 * batch does `limit` documents of *work* rather than reading `limit` rows and
 * skipping most of them. It is bounded by what a person can tick off, which is what
 * makes `id not in (…)` an acceptable shape here and not in general.
 *
 * No `Page<T>`: a bulk job's cursor carries a second component that has nothing to
 * do with sorting (how many documents the job has consumed against its ceiling), so
 * it is `bulk.ts`'s own encoding rather than this reader's.
 */
export async function storiesMatching(
  db: D1Database,
  filter: StoryFilter,
  opts: { limit: number; after?: string | null; exclude?: readonly string[] },
): Promise<StoryMeta[]> {
  const filters = storyFilters(filter)
  const sql = [...filters.sql]
  const binds = [...filters.binds]
  if (opts.after) {
    sql.push('id > ?')
    binds.push(opts.after)
  }
  if (opts.exclude && opts.exclude.length > 0) {
    sql.push(`id not in (${opts.exclude.map(() => '?').join(', ')})`)
    binds.push(...opts.exclude)
  }
  const { results } = await db
    .prepare(`select ${COLS} from stories ${whereOf(...sql)} order by id limit ?`)
    .bind(...binds, opts.limit)
    .all<StoryRow>()
  return results.map(withState)
}

/* ------------------------------------------------------------------ search --- */

export interface SearchOptions extends StoryPageOptions {
  /**
   * Restrict to these declared type names. The route resolves `?kind=` into it,
   * because `kind` is a property of a *declared type* and nothing on a story row
   * records one.
   *
   * **Absent is every type; empty is none** — the same absent-versus-empty
   * distinction `?parentId=` turns on, and it matters for exactly one case:
   * `?kind=singleton` on a site that declares no singleton has to answer an empty
   * page, not the whole table.
   */
  types?: readonly string[]
  /** Which twenty rows get ranked. See `core/story.ts`'s `SearchSort`. */
  sort?: SearchSort
}

/**
 * Documents matching a string, across every kind — the one route the palette,
 * both pickers and every screen's search box share
 * (`../../../docs/specs/foundation/pagination.md` decision 8).
 *
 * Substring, not full-text: `like` over title, slug and path plus a probe into
 * `content_index`'s values, which is what makes a *record* findable by the field
 * that identifies it rather than only by the title cache. FTS5 is rejected in
 * decision 8 — a second index with a second write path, for a fuzziness nobody has
 * asked for.
 *
 * **Ordered by title, and the consumer ranks.** That is a deliberate limit rather
 * than an oversight, and the reason is consistency with the decision one screen
 * over: a relevance tier ("a title match beats a hidden field value") would make
 * the sort key a triple, and `DocumentSort` has just finished explaining why a
 * three-component keyset is not worth its machinery here. Every consumer shows one
 * page of twenty and `admin/ui/rank.ts` already ranks what it is given, so the
 * ordering that matters is the one on screen. Cross-page relevance is what FTS5
 * would be for.
 *
 * No `q` at all is a legitimate request and answers every candidate row by title,
 * which is what a picker wants the moment it opens.
 */
export async function searchStories(
  db: D1Database,
  opts: SearchOptions = {},
): Promise<Page<StoryMeta>> {
  const limit = clampLimit(opts.limit, 20, 100)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const sort = opts.sort ?? DEFAULT_SEARCH_SORT
  const keyset = ORDERS[sort]
  const resume = keysetWhere(keyset, cursor)
  const filters = storyFilters(opts.filter, { indexedText: true })

  // `1 = 0` rather than an early return, so `count` is answered by the same code
  // path and comes back as 0 instead of being quietly absent.
  const types = opts.types
  const scope =
    types === undefined
      ? ''
      : types.length > 0
        ? `type in (${types.map(() => '?').join(', ')})`
        : '1 = 0'
  const narrow = [scope, ...filters.sql]
  const narrowBinds = [...(types ?? []), ...filters.binds]

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLS} from stories ${whereOf(...narrow, resume.sql)} ${orderBy(keyset)} limit ?`,
      )
      .bind(...narrowBinds, ...resume.binds, limit + 1)
      .all<StoryRow>(),
    opts.count
      ? db
          .prepare(`select count(*) as n from stories ${whereOf(...narrow)}`)
          .bind(...narrowBinds)
          .first<{ n: number }>()
      : null,
  ])

  const page = paginate(rows.results.map(withState), limit, (row) => keyOf(sort, row))
  return total ? { ...page, total: total.n } : page
}

/*
 * `listDocuments(db, type?)` was here, unpaged, and it is **deleted** rather than
 * kept beside the paged reader above.
 *
 * Its one non-test caller was the route `listDocumentPage` replaces. `storyTree`
 * survived the same treatment one phase ago because it has server-side callers
 * that need the whole shape; this had none, and a reader with only tests behind it
 * is the shape `stories_draft_updated` was in when it turned out to have been
 * indexing a column nothing read for ten migrations.
 */

/**
 * One document that points at another, as the delete confirmation names it. The
 * whole story row rather than a projection of it, so the route can put the
 * host's own `route()` over it with `withUrls` — the URL shape is the host's, and
 * this reader has no business knowing it.
 */
export interface UsageRef {
  story: StoryMeta
  kind: 'link' | 'reference'
}

export interface DocumentUsage {
  published: UsageRef[]
  /** Distinct published documents — what "Used on N published pages" counts. */
  total: number
  links: number
  references: number
}

/**
 * What points at this document, for the warning shown before it is deleted
 * (`../content-model/data-documents.md` architecture decision 4).
 *
 * **Published references only, and the dialog says so.** `content_refs` is
 * written inside the publish batch, so that is all the table holds. Covering
 * drafts would mean an edge table maintained per keystroke or a scan of every
 * Durable Object; neither is worth it for a confirmation dialog, and the failure
 * it would prevent already degrades safely — `resolveReference` returns null and
 * the block renders its empty state.
 *
 * `total` is **distinct documents**, because that is what "Used on 4 published
 * pages" counts. `links` and `references` are the row counts, which differ: a
 * page that both links to and references the same target contributes two rows
 * and one document, and appears twice in `published` so the list can say which.
 *
 * A row whose source story has since been deleted is dropped rather than
 * reported as an untitled usage. `deleteStoryStatement` now removes a deleted
 * story's rows in both directions, so this should no longer happen on a live
 * site — but the check stays: a database carrying rows from before that, or an
 * import that wrote edges directly, would otherwise show the dialog a usage with
 * no title and no URL. `total` counts what survives the join; `links` and
 * `references` come from the raw row counts and can exceed it.
 */
export async function documentUsage(db: D1Database, id: string): Promise<DocumentUsage> {
  const [counts, rows] = await Promise.all([countReferencesTo(db, id), referencesTo(db, id)])
  if (rows.length === 0) return { published: [], total: 0, links: 0, references: 0 }

  /**
   * `storiesForChunked`, not `storiesFor` — and the difference is a real bug rather
   * than a tidy-up.
   *
   * `storiesFor` binds every id in one statement. Outbound edges are capped at
   * `MAX_ROWS` (400) per document by `indexStatements`, so the *from* side of this
   * table is bounded; **inbound edges are not capped by anything.** A record every
   * page on the site references — an office in a footer, a person in a byline — has
   * as many inbound edges as there are pages, and this is the reader behind a delete
   * confirmation, which is exactly when somebody is looking at a heavily referenced
   * document. Past D1's bind limit the query fails, so the dialog reports an error
   * on the one document where the warning matters most.
   *
   * Found by the agent building asset usage, which hit the same shape and reached for
   * the chunked reader from the start.
   */
  const sources = await storiesForChunked(db, [...new Set(rows.map((r) => r.from))])
  const byId = new Map(sources.map((s) => [s.id, s]))

  const published: UsageRef[] = []
  for (const row of rows) {
    const story = byId.get(row.from)
    if (story) published.push({ story, kind: row.kind === 'link' ? 'link' : 'reference' })
  }
  // Routed documents first, by path, then unrouted by title: an editor scanning
  // "what breaks" wants the pages before the records.
  published.sort(
    (a, b) =>
      (a.story.path === null ? 1 : 0) - (b.story.path === null ? 1 : 0) ||
      (a.story.path ?? a.story.title).localeCompare(b.story.path ?? b.story.title) ||
      a.kind.localeCompare(b.kind),
  )

  return {
    published,
    total: new Set(published.map((p) => p.story.id)).size,
    links: counts.links,
    references: counts.references,
  }
}

/**
 * The one routing lookup. Needs no `path is not null` guard: an unrouted row
 * stores NULL, and SQL equality never matches NULL, so a record can never be
 * reached by path however it is spelled — which is exactly what
 * `document-types.md` checkpoint 2 buys. Same for `storyStatus` and
 * `publishedDoc` below.
 */
export async function storyByPath(db: D1Database, path: string): Promise<StoryMeta | null> {
  const row = await db
    .prepare(`select ${COLS} from stories where path = ?`)
    .bind(path)
    .first<StoryRow>()
  return row && withState(row)
}

export async function storyById(db: D1Database, id: string): Promise<StoryMeta | null> {
  const row = await db
    .prepare(`select ${COLS} from stories where id = ?`)
    .bind(id)
    .first<StoryRow>()
  return row && withState(row)
}

/**
 * What a host answers for a path that is not currently serving: `'live'` never
 * happens here (a live path has a document to return instead), so this is only
 * ever `'unpublished'` or `'unknown'` — the two `folio.status` promises,
 * `unpublish.md`'s architecture decision 5. `'unknown'` covers both a path with
 * no story at all and a story that has never been published: neither has ever
 * served the public, so a host answering 404 for both is correct.
 */
export async function storyStatus(
  db: D1Database,
  path: string,
): Promise<'live' | 'unpublished' | 'unknown'> {
  const row = await db
    .prepare(
      'select published_at as publishedAt, unpublished_at as unpublishedAt from stories where path = ?',
    )
    .bind(path)
    .first<{ publishedAt: number | null; unpublishedAt: number | null }>()
  if (!row) return 'unknown'
  const state = storyState(row.publishedAt, row.unpublishedAt)
  return state === 'draft' ? 'unknown' : state
}

export async function publishedDoc(db: D1Database, path: string): Promise<Doc | null> {
  const row = await db
    .prepare('select published_doc from stories where path = ?')
    .bind(path)
    .first<{ published_doc: string | null }>()
  return row?.published_doc ? (JSON.parse(row.published_doc) as Doc) : null
}

/**
 * Published documents for a set of story ids, for resolving `reference` fields on
 * a live page. One query, and never touches a Durable Object. Ids with nothing
 * published are simply absent, which the renderer treats as unresolvable.
 */
export async function publishedDocsByIds(
  db: D1Database,
  ids: readonly string[],
): Promise<Record<string, Doc>> {
  if (ids.length === 0) return {}
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`select id, published_doc from stories where id in (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; published_doc: string | null }>()

  const out: Record<string, Doc> = {}
  for (const row of results) {
    if (row.published_doc) out[row.id] = JSON.parse(row.published_doc) as Doc
  }
  return out
}

/* ---------------------------------------------- content migrations (0008) --- */

/** One document the migration runner has work to consider (`schema-migrations.md`). */
export interface BehindStory {
  story: StoryMeta
  /** The published snapshot as stored, or null when nothing is live. */
  publishedDoc: Doc | null
}

/**
 * The predicate for "this document has not had every migration": null reads as
 * "before the first migration", which is what makes a row written before 0008
 * pick up the whole set.
 */
const BEHIND = '(schema_id is null or schema_id < ?)'

/**
 * Documents behind `latestId`, in `id` order, starting after `after` — the
 * runner's batch (`schema-migrations.md` architecture decision 5).
 *
 * Ordered by the primary key and resumed by a cursor rather than by OFFSET,
 * because the rows this returns are the rows the batch is about to *change*: an
 * OFFSET over a set that shrinks as you walk it skips documents.
 */
export async function storiesBehind(
  db: D1Database,
  latestId: string,
  after: string | null,
  limit: number,
): Promise<BehindStory[]> {
  const { results } = await db
    .prepare(
      `select ${COLS}, published_doc from stories
       where ${BEHIND} and id > ? order by id limit ?`,
    )
    .bind(latestId, after ?? '', limit)
    .all<StoryRow & { published_doc: string | null }>()

  return results.map(({ published_doc, ...row }) => ({
    story: withState(row),
    publishedDoc: published_doc ? (JSON.parse(published_doc) as Doc) : null,
  }))
}

/**
 * How many documents are still behind. The runner's completion test, and the
 * admin's "N documents to migrate" — asked directly rather than accumulated
 * across batches, so it is right however many calls a run took and however many
 * runs there have been.
 */
export async function countBehind(db: D1Database, latestId: string): Promise<number> {
  const row = await db
    .prepare(`select count(*) as n from stories where ${BEHIND}`)
    .bind(latestId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Stamps a document's migration watermark, and its migrated published snapshot
 * when there is one, unrun.
 *
 * Unrun so the caller can batch the two writes together: a `published_doc` in
 * the new shape with a `schema_id` still claiming the old one would make the
 * next run migrate it twice — harmless, since migrations are idempotent, but
 * only by luck. `undefined` leaves `published_doc` alone, which is the case for
 * a document that has never been published.
 */
export function stampSchemaStatement(
  db: D1Database,
  id: string,
  schemaId: string,
  publishedDoc?: Doc,
): D1PreparedStatement {
  return publishedDoc === undefined
    ? db.prepare('update stories set schema_id = ? where id = ?').bind(schemaId, id)
    : db
        .prepare('update stories set schema_id = ?, published_doc = ? where id = ?')
        .bind(schemaId, JSON.stringify(publishedDoc), id)
}

/*
 * `publishedDocsAll` was here — every published document in one query, for the drift
 * audit. It is **deleted**: `GET {base}/api/audit` walks `publishedDocsAfter` over a
 * `continueFrom` cursor now (port phase 5), so its only caller is gone.
 *
 * It was also the last of the five unbounded reads `pagination.md` opened with, and
 * the one that survived longest because the audit is an operator's tool rather than a
 * screen — which is precisely the argument for paging it: an operator runs it on the
 * site that has a problem, and that is the big one.
 */

/**
 * One batch of published documents, in `id` order, starting after `after` —
 * `POST /folio/reindex`'s resumable read (`../content-model/collections.md`).
 *
 * Ordered by the primary key and resumed by a cursor rather than by OFFSET, the
 * same reasoning `storiesBehind` above spells out: the rows are the rows the
 * batch is about to write, and an OFFSET over a set something else is publishing
 * into skips documents.
 */
export async function publishedDocsAfter(
  db: D1Database,
  after: string | null,
  limit: number,
): Promise<PublishedDocRow[]> {
  const { results } = await db
    .prepare(
      `select id, type, published_doc from stories
       where published_doc is not null and id > ? order by id limit ?`,
    )
    .bind(after ?? '', limit)
    .all<{ id: string; type: string; published_doc: string }>()
  return results.map((row) => ({
    id: row.id,
    type: row.type,
    doc: JSON.parse(row.published_doc) as Doc,
  }))
}

/**
 * One published document as a batch reader hands it over.
 *
 * Deliberately **no `title`**, even though the audit panel wants one to label a
 * finding's link with. Adding it here was the first attempt and it was the wrong
 * place: it denormalises a column into a reporting module that has no other use for
 * it, and `reindex` — the other caller — would carry the wider projection for nothing.
 * `GET {base}/api/stories?ids=` already resolves a batch of ids to rows, chunked, and
 * exists for exactly this (`pagination.md` decision 7), so the *screen* resolves the
 * ids it is about to draw.
 */
export interface PublishedDocRow {
  id: string
  type: string
  doc: Doc
}

/**
 * The set of rows a document's `slug` must be unique within and its `ord` is
 * ordered against — the two things that differ between a routed and an unrouted
 * document, named once so `orderAt` and `uniqueSlug` share one definition and
 * the two partial unique indexes in `migrations/0001_init.sql` have an
 * exact counterpart in code.
 *
 * A routed document is grouped by its parent (`stories_parent_slug`); an
 * unrouted one by its type (`stories_type_slug`), because every unrouted row
 * carries `parent_id = null` and grouping those by parent would make a hundred
 * records collide with each other and with every top-level page.
 */
type SiblingGroup = { routed: true; parentId: string | null } | { routed: false; type: string }

function inGroup(row: StoryMeta, group: SiblingGroup): boolean {
  return group.routed
    ? row.path !== null && row.parentId === group.parentId
    : row.path === null && row.type === group.type
}

/**
 * Fractional key placing a story at `index` among its siblings.
 *
 * Sorted through `compareSiblings`, the comparator `buildTree` uses, so the sibling
 * list an index counts into is the one the user was looking at. A raw comparator
 * returns 0 on tied `ord` values and leaves the two orders free to disagree.
 */
function orderAt(rows: readonly StoryMeta[], group: SiblingGroup, index: number, ignore?: string) {
  const sibs = rows
    .filter((r) => inGroup(r, group) && r.id !== ignore)
    .sort((a, b) => compareSiblings(a.ord, a.id, b.ord, b.id))
  return keyAtIndex(
    sibs.map((r) => r.ord),
    index,
  )
}

function uniqueSlug(
  rows: readonly StoryMeta[],
  group: SiblingGroup,
  wanted: string,
  ignore?: string,
) {
  const taken = new Set(rows.filter((r) => inGroup(r, group) && r.id !== ignore).map((r) => r.slug))
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n++) {
    const candidate = `${wanted}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * The `under` refusal, worded once: it is thrown from creation *and* from a
 * move, because constraining one without the other means a tree can be dragged
 * into a shape the same config refuses to create (`document-types.md`'s
 * resolved open question). `errors.ts` maps it to a 400, so the notice reaches
 * the editor rather than the move silently doing nothing.
 */
function underError(type: DocumentType): Error {
  return new Error(
    `A '${type.name}' document is only allowed under: ${(type.under ?? []).join(', ')}`,
  )
}

export interface CreateStoryInput {
  title: string
  slug?: string
  parentId?: string | null
  /**
   * Which shape of document this is. A `page` kind lands in the tree with a
   * derived path; anything else is created unrouted, with `parent_id` and `path`
   * both null.
   */
  type: DocumentType
  /**
   * The content-migration watermark to stamp (`schema-migrations.md`). Callers
   * pass `FolioRuntime.schemaId` — the last configured migration — because a
   * document created now is seeded by `blankSubtree` from the *current* schema
   * and is therefore already in the target shape. Leaving it null would put a
   * "this page has not been updated for the latest content model" banner on a
   * page created five seconds ago, and make every run re-read it.
   *
   * `undefined` writes null, which is the honest answer for a caller that has no
   * migrations to speak of.
   */
  schemaId?: string | null
}

/**
 * `types` is the whole declared set, needed only so a prospective parent's own
 * type can be resolved for the `under` check. Defaulted to empty so a caller
 * with no `under` constraint to enforce can leave it off.
 */
export async function createStory(
  db: D1Database,
  input: CreateStoryInput,
  types: readonly DocumentType[] = [],
): Promise<StoryMeta> {
  const rows = await listStories(db)
  const type = input.type
  const routed = isRouted(type)

  if (!routed && input.parentId) throw new Error('An unrouted document cannot have a parent')

  const parentId = routed ? (input.parentId ?? null) : null
  const parent = parentId ? rows.find((r) => r.id === parentId) : undefined
  if (parentId && !parent) throw new Error('Unknown parent')
  // A record has no path, so nothing beneath it could derive one.
  if (parent && parent.path === null) {
    throw new Error('Cannot create a page under an unrouted document')
  }
  if (routed && !canNest(type, typeByName(types, parent?.type))) throw underError(type)

  const group: SiblingGroup = routed
    ? { routed: true, parentId }
    : { routed: false, type: type.name }
  const slug = uniqueSlug(rows, group, slugify(input.slug || input.title))
  const story: StoryMeta = {
    id: newStoryId(),
    type: type.name,
    parentId,
    slug,
    path: routed ? joinPath(parent?.path ?? '', slug) : null,
    ord: orderAt(rows, group, rows.filter((r) => inGroup(r, group)).length),
    title: input.title.trim() || 'Untitled',
    publishedAt: null,
    unpublishedAt: null,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    schemaId: input.schemaId ?? null,
    state: 'draft',
    hasUnpublishedChanges: false,
    updatedAt: Date.now(),
  }

  // A redirect can only ever be a trap once something is created at the path it
  // claims (redirects.md's edge case "a path vacated and reoccupied by a
  // different story"): batched with the insert so the new page is reachable
  // the instant it exists, never shadowed by a stale row at the host level.
  // An unrouted document claims no path, so there is nothing to clear.
  const insert = db
    .prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, schema_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      story.id,
      story.type,
      story.parentId,
      story.slug,
      story.path,
      story.ord,
      story.title,
      story.updatedAt,
      story.schemaId ?? null,
    )
  await db.batch(
    story.path === null ? [insert] : [insert, clearRedirectAtStatement(db, story.path)],
  )

  return story
}

/**
 * The row for a singleton, created on first access (`document-types.md`
 * architecture decision 7). An editor never creates or deletes one: a singleton
 * exists because the schema says it does, and deleting it would only mean it
 * comes back empty.
 *
 * The id is derived (`sng_<type>`), which is what makes a second one
 * unrepresentable — there is no other id it could be created under, so no
 * uniqueness constraint is needed to enforce "exactly one".
 * `on conflict do nothing` handles two concurrent first accesses: the loser's
 * insert is a no-op and both then read the same row.
 */
export async function ensureSingleton(
  db: D1Database,
  type: DocumentType,
  /** The migration watermark to stamp on a freshly created row; see
   * `CreateStoryInput.schemaId` for why a new document is born up to date. */
  schemaId: string | null = null,
): Promise<StoryMeta> {
  if (type.kind !== 'singleton') {
    throw new Error(`Document type '${type.name}' is not a singleton`)
  }
  const id = singletonId(type)
  const existing = await storyById(db, id)
  if (existing) return existing

  const now = Date.now()
  await db
    .prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, schema_id)
       values (?, ?, null, ?, null, 'a0', ?, ?, ?)
       on conflict (id) do nothing`,
    )
    .bind(id, type.name, type.name, type.label, now, schemaId)
    .run()

  const row = await storyById(db, id)
  if (!row) throw new Error(`Could not create the '${type.name}' singleton`)
  return row
}

/**
 * The row for a duplicated document (`duplicate-and-paste.md`): everything
 * `createStory` already does — slug dedupe, path derivation, a fresh
 * `clearRedirectAtStatement` batch — reused rather than restated, by passing
 * the *source's own slug* through as the wanted slug.
 *
 * That single choice is what makes both of architecture decision 5's cases
 * fall out of `createStory` with no special case written here: an ordinary
 * page's slug (`'about'`) collides with the still-live original and
 * `uniqueSlug` bumps it to `'about-2'`, while the root's slug is `''` —
 * falsy — so `createStory`'s own `input.slug || input.title` falls through to
 * deriving the slug from the new title instead, exactly the "a top-level
 * page with a slug derived from its title" the root's duplicate needs.
 *
 * `parentId` defaults to the source's own parent (a duplicate is offered as
 * a sibling), which is `null` for the root — already what a top-level page
 * needs, again with no `isRoot` check written here.
 *
 * Reads only the D1 row: the *document* (the draft to actually clone, and
 * the watermark-driven title override) is the caller's job
 * (`routes/stories.ts`), because that needs the Durable Object, which
 * nothing else in this file touches.
 */
export async function duplicateStory(
  db: D1Database,
  id: string,
  patch: { title?: string; parentId?: string | null },
  /** Required, unlike everywhere else this appears: the source's own type is
   * what says whether it is a singleton, and duplicating one has to be refused.
   * A default would turn a caller's omission into a runtime throw. */
  types: readonly DocumentType[],
): Promise<StoryMeta> {
  const source = await storyById(db, id)
  if (!source) throw new Error('Unknown story')

  const type = typeByName(types, source.type)
  if (!type) throw new Error(`Unknown document type: ${source.type}`)
  // The debt `duplicate-and-paste.md` deferred to this spec: there is exactly
  // one of a singleton by definition, so a second copy is not a document its
  // own schema can describe. Refused here rather than at the route so a direct
  // caller cannot route around it.
  if (type.kind === 'singleton') throw new Error('Cannot duplicate a singleton document')

  const title = patch.title?.trim() || `${source.title} (copy)`
  return createStory(
    db,
    {
      title,
      slug: source.slug,
      // An unrouted source has no parent to be a sibling of; `createStory`
      // refuses a parent for it anyway, so this is only ever read for a page.
      parentId: patch.parentId !== undefined ? patch.parentId : source.parentId,
      type,
      // The source's own watermark, not the latest: the copy's *document* is a
      // clone of the source's draft, so it is in exactly the shape the source is
      // in. Claiming otherwise would leave a duplicate of a behind page
      // permanently unmigrated (`schema-migrations.md`).
      schemaId: source.schemaId ?? null,
    },
    types,
  )
}

/**
 * A path this rename or move actually vacated, and where it now lives —
 * exactly the fact `redirectStatements` needs, and the one
 * `../platform/publish-hooks.md`'s `pathsChanged` hook fires with, because it
 * is the only place both the old and the new path of every affected row are
 * known at once. Gone once `updateStoryStatement` returns, which is why that
 * hook has to fire at the route, not inside this file.
 */
export interface PathChange {
  id: string
  from: string
  to: string
}

/**
 * Rename, retitle or move, computed but not yet run: `updateStory` batches
 * these statements immediately, while the PATCH route (`routes/stories.ts`)
 * needs the same statements *and* the `changes` list its `pathsChanged` hook
 * fires with — reusing this rather than restating the diff is what keeps the
 * hook's payload from ever being able to drift from what the redirects
 * (`redirects.md`) actually captured.
 *
 * Paths for the whole affected subtree are recomputed in one batch. Cheap
 * enough to do in JS at any realistic page count, and much easier to get
 * right than a recursive CTE.
 */
export interface StoryPatch {
  title?: string
  slug?: string
  parentId?: string | null
  index?: number
  /**
   * Accepted only when it matches the row's existing type, so a client that
   * round-trips a whole story object is not punished for it. An actual change is
   * refused: moving a document between types is a schema migration, which needs
   * the `retype` mutation `../platform/schema-migrations.md` adds.
   */
  type?: string
}

export async function updateStoryStatement(
  db: D1Database,
  id: string,
  patch: StoryPatch,
  types: readonly DocumentType[] = [],
): Promise<{
  next: StoryMeta
  statements: D1PreparedStatement[]
  changes: PathChange[]
  /**
   * Which of the row's own fields this patch actually altered, for the
   * `updated` hook (`../platform/caching.md`). Computed here, beside the
   * `changes` diff, for the reason that one is: the "before" is gone once these
   * statements run, and a caller recomputing it would be a second answer that
   * could drift from this one.
   */
  updated: StoryChange[]
}> {
  const rows = await listStories(db)
  const current = rows.find((r) => r.id === id)
  if (!current) throw new Error('Unknown story')
  if (patch.type !== undefined && patch.type !== current.type) {
    throw new Error("Cannot change a document's type")
  }

  // The root story owns '/' and cannot be reslugged or reparented.
  const isRoot = current.path === ''
  // An unrouted document is not in the tree at all, so there is no parent for a
  // patch to change. An explicit `null` is allowed through as the no-op it is.
  const unrouted = current.path === null
  if (unrouted && patch.parentId != null) {
    throw new Error('Cannot move an unrouted document into the page tree')
  }
  const subtree = new Set(descendants(rows, id))

  const parentId = unrouted
    ? null
    : patch.parentId !== undefined && !isRoot
      ? patch.parentId
      : current.parentId
  if (parentId && subtree.has(parentId)) throw new Error('Cannot move a story into its own subtree')
  const parent = parentId ? rows.find((r) => r.id === parentId) : undefined
  if (parentId && !parent) throw new Error('Unknown parent')
  if (parent && parent.path === null) {
    throw new Error('Cannot move a page under an unrouted document')
  }
  // `under` is re-checked here, so a drag is constrained exactly as creation is
  // — but only when the parent actually changes. Checking it on every patch
  // would make a plain title edit fail on a tree that predates the constraint.
  if (!unrouted && parentId !== current.parentId) {
    const type = typeByName(types, current.type)
    if (type && !canNest(type, typeByName(types, parent?.type))) throw underError(type)
  }

  const group: SiblingGroup = unrouted
    ? { routed: false, type: current.type }
    : { routed: true, parentId }
  const next: StoryMeta = {
    ...current,
    title: patch.title?.trim() || current.title,
    slug: isRoot
      ? ''
      : uniqueSlug(rows, group, slugify(patch.slug ?? patch.title ?? current.slug), id),
    parentId,
    ord:
      patch.index !== undefined || parentId !== current.parentId
        ? orderAt(rows, group, patch.index ?? 0, id)
        : current.ord,
    updatedAt: Date.now(),
  }

  const merged = rows.map((r) => (r.id === id ? next : r))
  // Routed rows only: an unrouted one has no ancestor chain to derive from and
  // is absent from the map, so `paths.get(r.id) ?? r.path` keeps its null.
  const paths = derivePaths(merged)

  const changed = merged.filter(
    (r) => r.id === id || (r.path !== null && paths.get(r.id) !== r.path),
  )
  const statements = changed.map((r) =>
    db
      .prepare(
        `update stories set parent_id = ?, slug = ?, path = ?, ord = ?, title = ?, updated_at = ?
         where id = ?`,
      )
      .bind(r.parentId, r.slug, paths.get(r.id) ?? r.path, r.ord, r.title, Date.now(), r.id),
  )

  // redirects.md's decision 1: every path this rename or move actually vacates
  // gets its redirect written in the same batch as the row update, so a rename
  // either records where it used to live or does not happen at all. An unrouted
  // document vacates nothing, so it contributes no redirect.
  const changes: PathChange[] = []
  for (const r of changed) {
    const from = r.path
    const to = paths.get(r.id) ?? r.path
    if (from === null || to === null || from === to) continue
    changes.push({ id: r.id, from, to })
    statements.push(...redirectStatements(db, { from, to, storyId: r.id }))
  }

  // The target row only. A descendant whose path moved because its ancestor did
  // has none of *its* own fields changed, and is already fully described by
  // `changes`.
  const updated: StoryChange[] = []
  if (next.title !== current.title) updated.push('title')
  if (next.slug !== current.slug) updated.push('slug')
  if (next.parentId !== current.parentId) updated.push('parent')
  if (next.ord !== current.ord) updated.push('ord')

  return { next: { ...next, path: paths.get(id) ?? next.path }, statements, changes, updated }
}

/** `updateStoryStatement`, run. What every caller wanted before this spec's
 * `pathsChanged` hook needed the `changes` list as well. */
export async function updateStory(
  db: D1Database,
  id: string,
  patch: StoryPatch,
  types: readonly DocumentType[] = [],
): Promise<StoryMeta> {
  const { next, statements } = await updateStoryStatement(db, id, patch, types)
  if (statements.length) await db.batch(statements)
  return next
}

/**
 * What deleting `id` would remove, and the statement that does it, unrun: a
 * caller batches this alongside the versions cleanup so a story's rows and its
 * version history disappear in one transaction rather than one succeeding
 * while the other fails. Null when there is no such story.
 *
 * `redirect: true` (redirects.md's architecture decision 4, "deleting a page
 * offers a redirect to its parent") adds one redirect statement per
 * descendant, each pointing at the deleted node's parent — the nearest
 * surviving ancestor, since the whole subtree is going away together.
 * `redirectStatements` (not the plain delete `deleteStoryStatement` would
 * otherwise need) is reused here too, so a path a redirect already claims
 * before this delete still collapses correctly rather than doubling up.
 */
export async function deleteStoryStatement(
  db: D1Database,
  id: string,
  opts: { redirect?: boolean } = {},
  types: readonly DocumentType[] = [],
): Promise<{
  ids: string[]
  /**
   * `ids`' own paths, same order — what `publish-hooks.md`'s `deleted` hook
   * fires with, so a host can purge a cache without a second lookup for rows
   * this call already read and is about to remove. `null` for an unrouted
   * document, which never had a URL for a cache to hold.
   */
  paths: (string | null)[]
  /**
   * `ids`' own document types, same order — the third fact that is gone the
   * moment this statement runs, needed for the same reason `paths` is: a
   * deleted document leaves every collection over its type, and
   * `../platform/caching.md`'s purge hook has to name that type.
   */
  types: string[]
  statement: D1PreparedStatement
  redirectStatements: D1PreparedStatement[]
  /**
   * `content_index` / `content_refs` rows for the same ids
   * (`../content-model/collections.md`), for the same batch: a deleted story must
   * leave every collection in the same transaction it leaves the tree, or a query
   * returns an id with no document behind it.
   *
   * **Both directions.** The outbound rows go because the source is gone; the
   * inbound ones (`to_story in ids`) go because the *target* is, and an edge to
   * an id with no document behind it is a fact nothing reads —
   * `data-documents.md`'s "used by N" warning is only ever asked about a document
   * somebody has open. Left behind they are rewritten only when the referring
   * document is next published, so a site that never republishes accumulates
   * them forever.
   */
  indexStatements: D1PreparedStatement[]
  /**
   * Pending and failed schedules for the same ids
   * (`../platform/scheduled-publishing.md`), for the same batch.
   *
   * A schedule must **not** outlive its story, which is the opposite of a
   * `redirect`: a redirect exists precisely because the page stopped being at that
   * path, whereas an instruction to publish a document that no longer exists is not
   * an instruction. Left behind, the row would be retried three times and then sit
   * in `?status=failed` naming a document nothing can show.
   *
   * A separate array rather than an `on delete cascade` in the DDL, matching
   * `deleteUser`'s explicit session delete: whether D1 enforces foreign keys is a
   * property of the database, and `test/workers/auth-session.test.ts` already says
   * so in as many words. The sweep drops an orphan too, for the delete that races
   * it.
   */
  scheduleStatements: D1PreparedStatement[]
} | null> {
  const rows = await listStories(db)
  const target = rows.find((r) => r.id === id)
  if (!target) return null
  if (target.path === '') throw new Error('Cannot delete the root story')
  // A singleton exists because the schema says it does (`document-types.md`
  // architecture decision 7). Recognised by its declared kind, falling back to
  // the derived id so a row whose type has since been removed from the code is
  // still refused rather than quietly deleted.
  if (
    typeByName(types, target.type)?.kind === 'singleton' ||
    target.id.startsWith(SINGLETON_PREFIX)
  ) {
    throw new Error('Cannot delete a singleton document')
  }

  const ids = descendants(rows, id)
  const paths = ids.map((descId) => rows.find((r) => r.id === descId)?.path ?? null)
  const types_ = ids.map((descId) => rows.find((r) => r.id === descId)?.type ?? '')
  const placeholders = ids.map(() => '?').join(', ')
  const statement = db.prepare(`delete from stories where id in (${placeholders})`).bind(...ids)

  const redirects: D1PreparedStatement[] = []
  if (opts.redirect) {
    const parent = target.parentId ? rows.find((r) => r.id === target.parentId) : undefined
    const parentPath = parent?.path ?? ''
    for (const descId of ids) {
      const row = rows.find((r) => r.id === descId)
      // No path vacated, so no redirect to write.
      if (!row || row.path === null) continue
      redirects.push(...redirectStatements(db, { from: row.path, to: parentPath, storyId: row.id }))
    }
  }

  return {
    ids,
    paths,
    types: types_,
    statement,
    redirectStatements: redirects,
    indexStatements: [...clearIndexStatements(db, ids), ...clearInboundRefStatements(db, ids)],
    scheduleStatements: clearSchedulesStatements(db, ids),
  }
}

/** Removes the story and everything beneath it. */
export async function deleteStory(
  db: D1Database,
  id: string,
  types: readonly DocumentType[] = [],
): Promise<string[]> {
  const found = await deleteStoryStatement(db, id, {}, types)
  if (!found) return []
  await db.batch([found.statement, ...found.indexStatements, ...found.scheduleStatements])
  return found.ids
}

/**
 * The stories-row update for a publish, unrun: a caller batches it alongside the
 * version-row insert (see versions.ts's `buildVersionWrite`) so a publish either
 * lands both writes or neither — `published_doc` and the retained version can no
 * longer disagree about what "the last publish" was.
 *
 * Also clears `unpublished_at`/`unpublished_by`: republishing is an ordinary
 * publish (`unpublish.md`), so a story taken down and then republished must not
 * keep answering `folio.status` as `'unpublished'` from a stale marker.
 *
 * `publishedSyncId` is the Durable Object's log position *at the moment `doc`
 * was read* (`unpublished-changes.md`'s architecture decision 4) — the caller
 * must read it atomically with the draft it snapshots (see `story-do.ts`'s
 * `getOrInitWithSyncId`), or a transaction landing between the two reads could
 * leave this watermark ahead of the bytes actually published, silently hiding a
 * real change.
 *
 * `title` is the *already-resolved* display title, not a fallback: which root
 * field holds it depends on the document's type (`titleOf`, `document-types.md`
 * architecture decision 3), and only the caller has the type to hand. This used
 * to read `doc.bloks[doc.root].data.title` directly, which cached an empty title
 * for any root block that had no such field.
 *
 * `titleI18n` is the same fact per locale (`localisation.md` architecture
 * decision 7), and publish is the natural place to write it: it is the one path
 * holding the whole document, so every language's title is resolvable in one
 * pass. **Optional, and `undefined` leaves the column alone** — a caller with no
 * locales configured writes nothing rather than clobbering a cache it knows
 * nothing about. `null` clears it, which is what a site that has removed its
 * locales wants.
 */
export function publishStoryStatement(
  db: D1Database,
  id: string,
  doc: Doc,
  title: string,
  publishedSyncId: number,
  titleI18n?: Record<string, string> | null,
): { publishedAt: number; title: string; statement: D1PreparedStatement } {
  const publishedAt = Date.now()
  const i18nJson = titleI18n && Object.keys(titleI18n).length > 0 ? JSON.stringify(titleI18n) : null
  const statement =
    titleI18n === undefined
      ? db
          .prepare(
            `update stories set published_doc = ?, published_at = ?, title = ?, updated_at = ?,
             unpublished_at = null, unpublished_by = null, published_sync_id = ?
             where id = ?`,
          )
          .bind(JSON.stringify(doc), publishedAt, title, publishedAt, publishedSyncId, id)
      : db
          .prepare(
            `update stories set published_doc = ?, published_at = ?, title = ?, title_i18n = ?,
             updated_at = ?, unpublished_at = null, unpublished_by = null, published_sync_id = ?
             where id = ?`,
          )
          .bind(JSON.stringify(doc), publishedAt, title, i18nJson, publishedAt, publishedSyncId, id)
  return { publishedAt, title, statement }
}

/** Snapshot a draft into D1, caching the document's title for the tree. */
export async function publishStory(
  db: D1Database,
  id: string,
  doc: Doc,
  fallbackTitle: string,
  publishedSyncId: number,
  titleI18n?: Record<string, string> | null,
): Promise<number> {
  const { publishedAt, statement } = publishStoryStatement(
    db,
    id,
    doc,
    fallbackTitle,
    publishedSyncId,
    titleI18n,
  )
  await statement.run()
  return publishedAt
}

/**
 * The stories-row update for an unpublish, unrun for the same batching reason
 * as `publishStoryStatement`: a future caller (`../content-model/collections.md`'s
 * publish batch) needs to drop query-index rows in the same transaction. This
 * spec's own `unpublish()` (`publish.ts`) has nothing else to batch it with —
 * it is the one workflow that writes D1 alone, with no version row and no
 * Durable Object call — so it just runs this statement by itself.
 *
 * Clears `published_doc` and `published_at` together, which is the entire
 * liveness switch (`published_doc is not null`) going off; `published_at` is
 * cleared alongside it because every existing reader — the tree, a host's
 * sitemap — already treats it as "is this live".
 */
export function unpublishStoryStatement(
  db: D1Database,
  id: string,
  actor: string | null,
): { unpublishedAt: number; statement: D1PreparedStatement } {
  const unpublishedAt = Date.now()
  const statement = db
    .prepare(
      `update stories set published_doc = null, published_at = null,
       unpublished_at = ?, unpublished_by = ?, updated_at = ?
       where id = ?`,
    )
    .bind(unpublishedAt, actor, unpublishedAt, id)
  return { unpublishedAt, statement }
}
