/**
 * The shape of a content query, its canonical form, and the queries a document's
 * `collection` fields contain (`../../../docs/specs/content-model/
 * collections.md` architecture decisions 4 and 5).
 *
 * Core rather than server, because three parties have to agree on it without
 * coordinating: the server turns one into SQL, the admin sends one over
 * `GET /folio/content`, and the renderer looks its answer up on the `Resolution`
 * by key. The SQL itself lives in `server/query.ts`; nothing here knows about D1.
 *
 * A collection is a **query, not a folder** (decision 4). There is no new entity
 * and no membership table: "the insights under /insights" is a filter on `type`
 * and `parent`, which cannot drift the way an explicit list of ids does the moment
 * somebody publishes an insight without touching the index page. Hand-picked lists
 * are `references()` in `data-documents.md`, which is the honest answer for the
 * case where a query is the wrong tool.
 */
import type { Doc, Json } from './doc'
import type { Field } from './fields'
import { fieldValue, type LocaleContext } from './locales'
import type { ReferenceTarget } from './resolve'
import type { SchemaIndex } from './schema'
import type { SnippetPart } from './search-projection'

/** Operators over a `content_index` row's `text_value`. */
export type TextOp = 'eq' | 'ne' | 'in' | 'contains' | 'startsWith'
/** Operators over `num_value`, or `text_value` when the bound is a string. */
export type RangeOp = 'gt' | 'gte' | 'lt' | 'lte'

export type ContentWhere =
  | { field: string; op: TextOp; value: string | readonly string[] }
  | { field: string; op: RangeOp; value: number | string }

const TEXT_OPS: readonly string[] = ['eq', 'ne', 'in', 'contains', 'startsWith']
const RANGE_OPS: readonly string[] = ['gt', 'gte', 'lt', 'lte']

export const WHERE_OPS: readonly string[] = [...TEXT_OPS, ...RANGE_OPS]

export const isTextOp = (op: string): op is TextOp => TEXT_OPS.includes(op)
export const isRangeOp = (op: string): op is RangeOp => RANGE_OPS.includes(op)

/**
 * Sort keys that are columns of `stories` rather than index rows, so they work
 * with no `indexed` field declared anywhere.
 *
 * Each carries the direction it means when named bare: newest first for a date,
 * tree order and alphabetical for the other two.
 */
export const BUILT_IN_ORDERS: Readonly<Record<string, 'asc' | 'desc'>> = {
  publishedAt: 'desc',
  ord: 'asc',
  title: 'asc',
  // Not a column of `stories` at all but of the full-text join
  // (`../../docs/specs/content-model/full-text-search.md` decision 2): bm25 is
  // negated in the SQL so a bigger score is a better match, which lets
  // `relevance` mean `desc` like every other "best first" order. `contentSql`
  // refuses it without a `search` term rather than sorting by a column that is
  // not in the statement.
  relevance: 'desc',
}

export interface ContentOrderSpec {
  field: string
  dir: 'asc' | 'desc'
}

/**
 * `order` accepts a **single** field (the spec's resolved open question). One was
 * enough for every case examined, and a second is additive later — a tuple here
 * would have to be threaded through the canonical form, the query string and the
 * SQL for a case nothing has yet asked for.
 */
export type ContentOrder = ContentOrderSpec | 'publishedAt' | 'ord' | 'title' | 'relevance'

export interface ContentQuery {
  /** One type or several. Absent queries every type, records included. */
  type?: string | readonly string[]
  /** Direct children only. `null` means the top level; absent means anywhere. */
  parent?: string | null
  /** Filters and sorts against this locale's index rows. Absent is the source. */
  locale?: string
  where?: readonly ContentWhere[]
  order?: ContentOrder
  /**
   * Full-text term (`../../docs/specs/content-model/full-text-search.md`
   * decision 4). Trimmed, whitespace-collapsed and capped at
   * `MAX_SEARCH_LENGTH` by `normaliseQuery`; dropped entirely when nothing is
   * left of it.
   *
   * Visitor input, and it is **never** a bad request: `ftsQuery` tokenises it
   * before it reaches FTS5, so a stray quote or a bare `NOT` is a term rather
   * than syntax, and a string with no token at all answers an empty page.
   */
  search?: string
  /** 1-based. */
  page?: number
  /** Default 20, capped at 100. */
  perPage?: number
  /**
   * Published only, which is the only value there is
   * (the spec's *Out of scope*). Draft-status queries are deliberately not this
   * route's job: the index is published-only by construction, and the admin's
   * list views read `stories` directly — a document, not a query over content.
   */
  status?: 'published'
}

/**
 * One row of a `ContentPage`: the shape a `reference` already resolves to, plus
 * the two things only a full-text query can answer
 * (`../../docs/specs/content-model/full-text-search.md` decision 4).
 *
 * Both are present **only** when the query carried `search`, so a block that
 * renders a plain collection sees exactly what it saw before.
 */
export interface ContentItem extends ReferenceTarget {
  /**
   * The matched extract, already split into parts (decision 6) — never a
   * `<mark>…</mark>` string a host would have to trust as HTML or escape.
   */
  snippet?: SnippetPart[]
  /** bm25, negated: bigger is a better match. */
  score?: number
}

export interface ContentPage {
  items: ContentItem[]
  total: number
  page: number
  perPage: number
  pages: number
}

/** What a `collection` field hands to `render`. */
export interface ResolvedCollection extends ContentPage {
  /**
   * The list was resolved against **published** content while an editor is
   * looking at a draft (decision 3). A block can say "this list shows published
   * items"; a live page never sees it.
   */
  stale?: boolean
}

export const DEFAULT_PER_PAGE = 20
export const MAX_PER_PAGE = 100
/** How much of a search box reaches the index. The same bound `?q=` carries. */
export const MAX_SEARCH_LENGTH = 200

/** The zero value: what a block gets for a query nothing ran. */
export function emptyContentPage(page = 1, perPage = DEFAULT_PER_PAGE): ContentPage {
  return { items: [], total: 0, page, perPage, pages: 0 }
}

const clampPage = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 1
  return v < 1 ? 1 : v
}

const clampPerPage = (n: unknown, max = MAX_PER_PAGE): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : DEFAULT_PER_PAGE
  return Math.min(Math.max(v, 1), Math.min(max, MAX_PER_PAGE))
}

/**
 * A search box's contents, canonicalised: whitespace collapsed so two spellings
 * of one phrase share a `queryKey`, and **truncated** at `MAX_SEARCH_LENGTH`
 * rather than refused.
 *
 * Truncated, deliberately. Everything else this function meets is a developer's
 * or an editor's mistake; this one is a visitor's paste, and a 10 kB string is
 * far likelier to be a fat finger than an attack. `ftsQuery` keeps twelve tokens
 * of whatever survives, so the cap decides nothing a visitor would notice.
 */
const clampSearch = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return collapsed ? collapsed.slice(0, MAX_SEARCH_LENGTH) : undefined
}

/**
 * The canonical form of a query: defaults applied, `type` a sorted array, `where`
 * sorted, `order` expanded, `page`/`perPage` clamped.
 *
 * Sorting matters because this is what `queryKey` serialises: two blocks written
 * in different key orders, or listing the same two types the other way round, are
 * the same query and must cost one D1 read, not two.
 */
export function normaliseQuery(
  q: ContentQuery,
  perPageMax = MAX_PER_PAGE,
): Required<Pick<ContentQuery, 'page' | 'perPage'>> & {
  type: readonly string[]
  parent?: string | null
  locale?: string
  search?: string
  where: readonly ContentWhere[]
  order: ContentOrderSpec
} {
  const type = q.type === undefined ? [] : typeof q.type === 'string' ? [q.type] : [...q.type]
  const search = clampSearch(q.search)
  const where = [...(q.where ?? [])]
    .filter((w) => w && typeof w.field === 'string' && WHERE_OPS.includes(w.op))
    .map((w) => ({
      field: w.field,
      op: w.op,
      // An `in` of one value and an `eq` are different queries, so the array is
      // not collapsed — only sorted, so the same set spells the same key.
      value: Array.isArray(w.value) ? [...w.value].sort() : w.value,
    })) as ContentWhere[]
  where.sort(
    (a, b) =>
      a.field.localeCompare(b.field) ||
      a.op.localeCompare(b.op) ||
      String(a.value).localeCompare(String(b.value)),
  )

  const order: ContentOrderSpec =
    typeof q.order === 'string'
      ? { field: q.order, dir: BUILT_IN_ORDERS[q.order] ?? 'asc' }
      : q.order && typeof q.order.field === 'string'
        ? { field: q.order.field, dir: q.order.dir === 'asc' ? 'asc' : 'desc' }
        : search !== undefined
          ? // Best match first, which is the only thing a search result page
            // could mean by default (decision 4). A caller who wants a search
            // sorted by date says so and still gets a `score` on every item.
            { field: 'relevance', dir: 'desc' }
          : // Newest first: what a CMS list means when it says nothing. Deterministic
            // either way — `server/query.ts` always appends `s.id` as the tiebreak,
            // without which offset pagination could show one row on two pages.
            { field: 'publishedAt', dir: 'desc' }

  return {
    type: type.slice().sort(),
    ...(q.parent !== undefined ? { parent: q.parent } : {}),
    ...(q.locale ? { locale: q.locale } : {}),
    ...(search !== undefined ? { search } : {}),
    where,
    order,
    page: clampPage(q.page),
    perPage: clampPerPage(q.perPage, perPageMax),
  }
}

/**
 * The key a query's answer travels under on a `Resolution`.
 *
 * **The canonical form itself, not a hash of it.** The spec asked for "a stable
 * hash of the normalised query"; the purpose it names — the admin and the server
 * agreeing on the key without coordinating — is served exactly by the canonical
 * string, and a hash would trade a key you can read in a payload for a collision
 * that silently serves one block another block's list. A page carries a handful of
 * collections, so the bytes are not worth the risk.
 */
export function queryKey(q: ContentQuery, perPageMax = MAX_PER_PAGE): string {
  const n = normaliseQuery(q, perPageMax)
  // Explicit key order rather than JSON.stringify over the object, so the key is
  // stable against a future field being added in the middle of the interface.
  // `search` is the eighth element for exactly that reason: appended, never
  // inserted, so every key written before it existed still reads the same.
  return JSON.stringify([
    n.type,
    n.parent ?? null,
    n.locale ?? '',
    n.where.map((w) => [w.field, w.op, w.value]),
    [n.order.field, n.order.dir],
    n.page,
    n.perPage,
    n.search ?? '',
  ])
}

/**
 * A query as `GET /folio/content` spells it.
 *
 * Core rather than admin, and paired with `queryFromParams` (server side) rather
 * than each end inventing its own encoding: the admin's collection hook and the
 * route have to agree on `field:op:value` exactly, and one of them living next to
 * the other's tests is how they stay agreed.
 */
export function queryToParams(q: ContentQuery, perPageMax = MAX_PER_PAGE): URLSearchParams {
  const n = normaliseQuery(q, perPageMax)
  const params = new URLSearchParams()
  if (n.type.length > 0) params.set('type', n.type.join(','))
  // Present-and-empty means the top level, which is a real filter; omitted means
  // anywhere. `undefined` and `null` are different queries, so both are spellable.
  if (n.parent !== undefined) params.set('parent', n.parent ?? '')
  if (n.locale) params.set('locale', n.locale)
  if (n.search) params.set('search', n.search)
  for (const w of n.where) {
    params.append(
      'where',
      `${w.field}:${w.op}:${Array.isArray(w.value) ? w.value.join(',') : w.value}`,
    )
  }
  params.set('order', `${n.order.field}:${n.order.dir}`)
  params.set('page', String(n.page))
  params.set('perPage', String(n.perPage))
  return params
}

/* ------------------------------------------------- the collection field --- */

/** The `collection` field's own declaration, narrowed off `Field`. */
export type CollectionField = Extract<Field, { kind: 'collection' }>

/**
 * What the editor's choices are stored as. Plain JSON in `Blok.data`, so it
 * travels through the same `set` mutation as a text field and inherits sync,
 * undo, versioning and atomic publish with no new mechanism.
 */
export interface CollectionValue {
  where?: readonly ContentWhere[]
  order?: ContentOrderSpec
  perPage?: number
  page?: number
  /**
   * An editor-typed full-text term (`../../docs/specs/content-model/
   * full-text-search.md` architecture decision 10). Only ever reaches a query
   * when the field itself declares `searchable: true` — `collectionQuery` drops
   * it otherwise, the same double enforcement `filterable` already has.
   */
  search?: string
}

export function asCollectionValue(value: Json | undefined): CollectionValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const v = value as Record<string, Json>
  const out: CollectionValue = {}
  if (Array.isArray(v.where)) {
    const where: ContentWhere[] = []
    for (const raw of v.where) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const entry = raw as Record<string, Json>
      const field = entry.field
      const op = entry.op
      if (typeof field !== 'string' || !field) continue
      if (typeof op !== 'string' || !WHERE_OPS.includes(op)) continue
      const value = entry.value
      if (isRangeOp(op)) {
        if (typeof value !== 'string' && typeof value !== 'number') continue
        where.push({ field, op, value })
        continue
      }
      if (typeof value === 'string') where.push({ field, op: op as TextOp, value })
      else if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
        where.push({ field, op: op as TextOp, value: value as string[] })
      }
    }
    out.where = where
  }
  const order = v.order
  if (order && typeof order === 'object' && !Array.isArray(order)) {
    const field = (order as Record<string, Json>).field
    const dir = (order as Record<string, Json>).dir
    if (typeof field === 'string' && field) {
      out.order = { field, dir: dir === 'asc' ? 'asc' : 'desc' }
    }
  }
  if (typeof v.perPage === 'number') out.perPage = v.perPage
  if (typeof v.page === 'number') out.page = v.page
  if (typeof v.search === 'string') out.search = v.search
  return out
}

/**
 * The query one `collection` field on one blok actually runs: the field's
 * declaration constrains the editor's stored choices, **again**, on the way out.
 *
 * The same double enforcement `richtext`'s `marks` has, for the same reason. The
 * admin only offers filters from `filterable` and counts up to `maxPerPage`, but a
 * value can also arrive from an importer, from the content API, or from a
 * `filterable` list that has since been shortened — so a filter the field does not
 * permit is dropped here rather than reaching SQL.
 *
 * `page` is the render's page, which is how a host paginates a published index:
 * it reads `?page=` and passes it to `folio.resolve`, offsetting every collection
 * in the document. A page on the stored value is the editor's own starting point
 * and loses to it. `search` is the same trade
 * (`../../docs/specs/content-model/full-text-search.md` architecture decision
 * 10): a render-time term — a host's `?q=` passed to `folio.resolve` — wins over
 * whatever an editor typed into the field's own Search input.
 */
export function collectionQuery(
  field: CollectionField,
  value: Json | undefined,
  page?: number,
  search?: string,
): ContentQuery {
  const stored = asCollectionValue(value)
  const filterable = new Set(field.filterable ?? [])
  // `relevance` is orderable only when the field itself accepts a search term
  // (full-text-search.md decision 10): `contentSql` refuses `relevance` without
  // one, so offering (or keeping) it on a field that can never carry `search`
  // would be a sort that silently falls back to `defaultOrder` — the same trap
  // `CollectionField.tsx`'s dropdown used to fall into by building itself from
  // every key of `BUILT_IN_ORDERS`.
  const orderable = new Set([
    ...filterable,
    ...Object.keys(BUILT_IN_ORDERS).filter((k) => k !== 'relevance' || field.searchable),
  ])

  const preOrder =
    stored.order && orderable.has(stored.order.field) ? stored.order : field.defaultOrder

  // Without `searchable: true`, both the stored and the render-time term are
  // dropped here — the same double enforcement `filterable` has, because a
  // value can also arrive from an importer or over the content API.
  const term = field.searchable ? (search ?? stored.search) : undefined

  // `relevance` ranks by a term that can be gone the moment a visitor or an
  // editor clears the search box while the sort is still stored as `relevance`
  // — `contentSql` refuses `order: 'relevance'` with no `search` outright
  // (decision 4's `bad_request`), so a resolve must never hand it that
  // combination. Dropped exactly as an order naming an unfilterable field
  // already is, so `normaliseQuery` picks the ordinary default instead.
  const order = preOrder?.field === 'relevance' && !term ? undefined : preOrder

  return {
    ...(field.type !== undefined ? { type: field.type } : {}),
    where: (stored.where ?? []).filter((w) => filterable.has(w.field)),
    ...(order ? { order } : {}),
    ...(term ? { search: term } : {}),
    page: page ?? stored.page ?? 1,
    perPage: Math.min(stored.perPage ?? field.maxPerPage ?? DEFAULT_PER_PAGE, maxPerPageOf(field)),
    status: 'published',
  }
}

export const maxPerPageOf = (field: CollectionField): number =>
  Math.min(field.maxPerPage ?? MAX_PER_PAGE, MAX_PER_PAGE)

/**
 * The distinct queries a document contains, keyed exactly as the `Resolution`
 * keys their answers.
 *
 * The same treatment `referencedIds` gets, one level up: collect the queries, run
 * each once, put the answers on the resolution. So a page with no collection field
 * costs no extra reads at all, two blocks with the same configuration cost one
 * read between them, and the preview client re-renders per keystroke against data
 * it already holds — the constraint that shapes every resolution decision here.
 */
export function collectionQueries(
  doc: Doc,
  schema: SchemaIndex,
  page?: number,
  /** Read through `fieldValue` like every other field read (`localisation.md`).
   * A `collection` cannot be `translatable` — the type forbids it, because the
   * locale belongs on the *query*, not on the configuration — so this only ever
   * matters for a value an importer put in `i18n`. Threaded anyway so this and
   * `resolveCollection` cannot read different values and compute different keys. */
  locale?: LocaleContext,
  /** The render's full-text term, from `Resolution.search`
   * (`../../docs/specs/content-model/full-text-search.md` architecture decision
   * 10) — passed to every `collection` field in the document, exactly as `page`
   * is, and dropped by `collectionQuery` for a field that is not `searchable`. */
  search?: string,
): Map<string, ContentQuery> {
  const out = new Map<string, ContentQuery>()
  for (const blok of Object.values(doc.bloks)) {
    const fields: Record<string, Field> | undefined = schema[blok.type]?.fields
    if (!fields) continue
    for (const [name, field] of Object.entries(fields)) {
      if (field.kind !== 'collection') continue
      const q = collectionQuery(field, fieldValue(blok, name, locale), page, search)
      const key = queryKey(q, maxPerPageOf(field))
      if (!out.has(key)) out.set(key, q)
    }
  }
  return out
}
