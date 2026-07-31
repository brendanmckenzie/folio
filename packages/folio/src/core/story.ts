import { compareSiblings } from './doc'

/**
 * Story *structure*. Page metadata lives in the document's root block, not
 * here — see migrations/0001_init.sql. The only content field mirrored into this table is
 * `title`, cached so the tree renders without loading every Durable Object.
 */
export interface StoryMeta {
  id: string
  /**
   * Document type name, resolved against the `types` passed to `createFolio`.
   * A record and a page are the same row with a different value here
   * (`document-types.md` checkpoint 1) — there is no second table.
   */
  type: string
  parentId: string | null
  slug: string
  /**
   * Null for an unrouted document (a record or a singleton), which leaves the
   * page tree entirely rather than squatting a URL: naming a record "Contact"
   * must not take `/contact` away from the page that needs it
   * (`document-types.md` checkpoint 2). Derived from the ancestor chain for
   * everything else.
   */
  path: string | null
  /** Fractional index among siblings: within the parent for a routed document,
   * within the type for an unrouted one. */
  ord: string
  title: string
  publishedAt: number | null
  /** Set the moment a live page is taken down; cleared by the next publish. */
  unpublishedAt: number | null
  updatedAt: number
  /**
   * The Durable Object's log position last mirrored into D1, and the position
   * that was actually published — `unpublished-changes.md`'s watermark pair.
   * Both start at 0 for a story whose object has never been touched or never
   * published, which reads as "nothing changed" rather than "everything
   * changed" (see `stories.draft_sync_id` in migrations/0001_init.sql).
   */
  draftSyncId: number
  /** When the watermark above was last written. Null until the first debounced write. */
  draftUpdatedAt: number | null
  publishedSyncId: number
  /**
   * The last content migration applied to this document
   * (`schema-migrations.md`), or null for "before the first migration" — which
   * is the correct reading for every row written before the column existed.
   *
   * Optional on the type rather than required, unlike the watermark pair above:
   * it is read by exactly two places (the runner's sweep and the admin's
   * behind-the-model banner), and making it required would mean touching every
   * hand-built `StoryMeta` literal in the tree for no gain at either.
   */
  schemaId?: string | null
  /**
   * Translated titles by locale code, from `stories.title_i18n`
   * (`localisation.md` architecture decision 7) — so a translator's tree is not
   * in English.
   *
   * A cache of a cache, and best-effort by definition: `title` is already the
   * denormalised source-locale title and the *document* is the truth for both.
   * Written by publish, which is the one path holding the whole document and
   * therefore every locale's title at once. A stale entry costs a wrong label in
   * a tree, never wrong content on a page.
   *
   * Optional for the same reason `schemaId` is: making it required would mean
   * touching every hand-built `StoryMeta` literal in the tree for no gain.
   */
  titleI18n?: Record<string, string> | null
  /** Derived, not stored — see `draftState`. */
  state: StoryState
  /** Derived, not stored: `state === 'changed'`, named for callers that only
   * care about the yes/no rather than the whole state machine. */
  hasUnpublishedChanges: boolean
  /** Filled server-side from the host's `route` config. */
  url?: string
  previewUrl?: string
  /**
   * The same two, per locale, filled only when `FolioConfig.locales` is
   * configured — the host's own `route(path, locale)` called once per declared
   * language (`localisation.md`). Absent on a single-locale site, so its payload
   * is byte-identical to what it was.
   *
   * `previewUrls` is what the admin's locale switcher navigates the iframe to
   * (decision 6): switching language reloads the preview rather than pushing a
   * new resolution, because the host's own chrome and `<html lang>` are part of
   * what changes and no postMessage can reach them.
   */
  urls?: Record<string, string>
  previewUrls?: Record<string, string>
}

export interface StoryNode extends StoryMeta {
  children: StoryNode[]
}

/**
 * The tree's four states (`unpublish.md`'s architecture decision 2), named
 * once so the tree, the content API and any host reading `folio.stories(env)`
 * agree on what a badge means.
 *
 * `'changed'` — live, with draft edits the last publish does not reflect — is
 * not derivable from `publishedAt`/`unpublishedAt` alone; it needs a watermark
 * comparison (or, for the story currently open, a real diff). `storyState`
 * below never returns it; `draftState` wraps it to do so.
 */
export type StoryState = 'draft' | 'unpublished' | 'live' | 'changed'

/**
 * `published_doc is not null` is the actual liveness switch (server/stories.ts),
 * but `publishStoryStatement` and `unpublishStoryStatement` always write
 * `published_at` in lockstep with it, so testing `publishedAt` here costs no
 * extra column and never disagrees with the document.
 */
export function storyState(
  publishedAt: number | null,
  unpublishedAt: number | null,
): Exclude<StoryState, 'changed'> {
  if (publishedAt !== null) return 'live'
  if (unpublishedAt !== null) return 'unpublished'
  return 'draft'
}

/**
 * `storyState` widened to report `'changed'` — the watermark comparison from
 * `unpublished-changes.md`'s architecture decision 3. A story reads `'changed'`
 * rather than `'live'` when its Durable Object's log position (`draftSyncId`)
 * has moved past the position that was actually published (`publishedSyncId`).
 *
 * Deliberately coarser than a diff: an edit that cancels itself out still
 * advances the watermark, so a row can read `'changed'` with nothing left to
 * publish. That is the accepted trade for rendering a tree without opening
 * every Durable Object — the open story's own diff (the admin's
 * `usePublishedDoc`) overrides this comparison for the page being edited.
 */
export function draftState(
  publishedAt: number | null,
  unpublishedAt: number | null,
  draftSyncId: number,
  publishedSyncId: number,
): StoryState {
  const base = storyState(publishedAt, unpublishedAt)
  return base === 'live' && draftSyncId > publishedSyncId ? 'changed' : base
}

/**
 * What narrows a list of stories, as one flat serialisable object.
 *
 * **Three things hold this same shape, and that is the whole reason it is flat**
 * (`../../../docs/specs/foundation/pagination.md` decision 9): the query string on
 * the Content screen, the argument to a paged read, and the `filter` a select-all
 * *captures* at the moment it was clicked (`docs/ui-architecture.md` decision 7a).
 * A filter that needed a class or a closure could not be put in a URL or stored in
 * a batched job, so anything added here has to stay JSON.
 *
 * Every field is optional and absent means "do not narrow on this", with one
 * exception worth stating: `parentId: null` is **not** the same as absent. Null
 * means the top level of the tree; absent means every level, which is what flat
 * mode asks for.
 */
export interface StoryFilter {
  /** `null` for the top level. Absent for "any parent" — see above. */
  parentId?: string | null
  /** A document type name. */
  type?: string
  state?: StoryState
  /** Substring, matched against title, slug and path. */
  q?: string
  /** A locale code, for translation completeness. */
  locale?: string
}

/**
 * Flat mode's ordering (`pagination.md` decision 2a) — the other half of the
 * Content screen's `[ Tree | Flat ]` toggle.
 *
 * Here rather than in `server/stories.ts` for the same reason `StoryFilter` is:
 * it is a value that travels in a URL, so the screen that writes the URL and the
 * reader that answers it have to agree on the vocabulary, and only `core/` is
 * shared by both.
 *
 * Three and no fourth. `state` would be the obvious next one — it is the one
 * filter that is also a plausible ordering — and it is deliberately absent: it
 * would need a fourth index for a sort nobody has asked for, over an expression
 * with four distinct values. Adding it later is one index and one `order by`.
 */
export type FlatSort = 'edited' | 'title' | 'path'

/** `edited`, the default: "what changed lately" is the question flat mode exists
 * to answer, so a URL that omits the sort wants it rather than an error. */
export const DEFAULT_FLAT_SORT: FlatSort = 'edited'

/**
 * The Documents screen's ordering — one type's records as a table
 * (`ui-architecture.md` port phase 3).
 *
 * Three, and **every one of them is a column on `stories`**. That is the decision
 * rather than an accident of what was easy: the screen's other columns come from
 * the type's `indexed` fields, whose values live in `content_index`, and sorting
 * by one of those means a keyset over a joined row — which does not work here for
 * three separate reasons.
 *
 *  - A value is **two columns** (`num_value` then `text_value`, and
 *    `content-index.ts`'s `IndexedValue` says why), so the key is a triple and
 *    `server/keyset.ts`'s `Keyset` holds a pair.
 *  - Index rows are written **inside the publish batch**, so an unpublished
 *    document has none and the sort column is null. `core/pagination.ts`'s
 *    `CursorPart` is non-nullable on purpose: a cursor over a nullable column
 *    cannot express "resume after null" in a way that agrees with SQL's own null
 *    ordering.
 *  - No index helps. `content_index_lookup (field, locale, text_value)` cannot be
 *    intersected with `stories.type = ?`, so it is a sort either way.
 *
 * The consequence is small in practice and worth stating: `dataColumns`' rule —
 * carried into `documents-model.ts` — skips the type's `titleField` as a field
 * column, because its value *is* the title. So the one sort anybody reaches for on
 * a record list ("people by name") is `title`, and it is a real indexed column.
 *
 * **Rejected: widening `Keyset` to three components** and coalescing both index
 * columns to sentinels. Exact, and it pages stably; it also collapses every
 * unpublished document into one sentinel block ordered by id, and it is still a
 * sort rather than an index walk — so it buys reach at the cost of the one thing
 * that made a keyset worth having. It is the shape this takes when somebody asks.
 *
 * **Rejected: offset paging when the sort names an `indexed` field**, reusing the
 * join `server/query.ts` already writes. Two envelopes on one route told apart by
 * a query parameter, page numbers back in a live admin list (decision 1), and
 * `query.ts` filters `published_doc is not null` — so it is a parallel
 * implementation, not a call.
 */
export type DocumentSort = 'ord' | 'title' | 'edited'

/**
 * `title`, the default, because it is what the list this replaces showed:
 * `DataTable.tsx` opened on `{ key: 'title', dir: 'asc' }` over the whole set.
 *
 * Not `ord`, even though that is the order the rows come out of the table in. A
 * record list is read alphabetically; `ord` is offered because a record *has* a
 * manual position (`createStory` appends, so it reads as creation order and the
 * screen labels it "Added"), not because it is the useful default.
 */
export const DEFAULT_DOCUMENT_SORT: DocumentSort = 'title'

/**
 * `GET {base}/api/search`'s ordering (`pagination.md` decision 8).
 *
 * Two, and `edited` is the one that earns its keep. The route narrows and the
 * *consumer* ranks — `admin/ui/rank.ts`, shared by the palette and both pickers —
 * so what the ordering decides is **which twenty rows get ranked**, not what order
 * they end up in. Recency is a far better prior for that than the alphabet: a
 * palette showing the twenty most recently edited matches has the page you were
 * working on in it, and one showing the twenty alphabetically first has whatever
 * begins with "A".
 *
 * `path` is absent because a record has none, and this route spans every kind.
 */
export type SearchSort = 'title' | 'edited'

/** `title`, so a picker that opens with no query reads as a list rather than a
 * feed. The palette asks for `edited` explicitly, because it *is* a feed. */
export const DEFAULT_SEARCH_SORT: SearchSort = 'title'

/**
 * The Assets screen's ordering — `docs/ui-architecture.md`'s Assets section asks
 * for "sort by date or name or size", and the library was hard-wired to newest
 * first before it.
 *
 * Here rather than in `server/assets.ts` for the same reason the three sorts above
 * are here: the value travels in a URL, so the screen that writes it and the
 * reader that answers it have to share one vocabulary, and `core/` is the only
 * thing both import.
 *
 * **Each one's natural direction is the one a person means by naming it**, and
 * `?dir=` reverses it (`server/validate.ts`'s `sortDirQuery`). That is not
 * decoration — it is what makes a column header's *first* click useful:
 *
 *  - `created` **descending**. Newest first, and the only ordering with an index
 *    behind it (`assets_created`). What you want after an upload is the file you
 *    just uploaded.
 *  - `filename` **ascending**. Alphabetical, the way every file browser shows a
 *    folder, so `a-logo.svg` is where a person expects to find it.
 *  - `size` **descending**, and this is the one worth arguing. Nobody sorts a
 *    media library to find the smallest file; they sort it because the bucket is
 *    bigger than they expected and they are looking for the 8MB PNG somebody
 *    dropped in. Ascending would put a row of 1KB favicons on page one every
 *    time. **Rejected: ascending for consistency with `filename`** — a shared
 *    direction across unrelated columns is not something anybody perceives, and
 *    it would spend the useful click on the useless end.
 *
 * Three and no fourth. `contentType` is the obvious next one and is deliberately
 * absent: `?kind=` already filters on a content-type prefix, which is what
 * somebody grouping by type actually wants, and sorting by it would order by the
 * spelling of a MIME string.
 */
export type AssetSort = 'created' | 'filename' | 'size'

/**
 * `created`, because the library is a feed: a person arriving at Assets has
 * usually just uploaded something, and "what is newest" is the question the screen
 * opens on. It is also the one sort an index already covers.
 *
 * **It beat `filename`**, which is what a filesystem defaults to and what the old
 * picker's grid looked like — alphabetical buries a fresh upload in the middle of
 * the list, where the person who just made it has no idea to look.
 */
export const DEFAULT_ASSET_SORT: AssetSort = 'created'

export function joinPath(parentPath: string, slug: string): string {
  if (!slug) return parentPath
  return parentPath ? `${parentPath}/${slug}` : slug
}

/**
 * Every ancestor path of a routed path, nearest last, including the root (`''`).
 *
 * Derived from the path rather than walked up `parent_id`, and that is the whole
 * point: `resolve()` narrows itself to the ids a document needs
 * (`../../../docs/specs/content-model/collections.md` decision 6) and a breadcrumb
 * needs its ancestors, so it has to reach them in **one** query alongside
 * everything else — which a recursive parent walk cannot do. A path *is* the
 * ancestor chain, so `where path in (?, ?)` is the whole lookup.
 *
 * `''` for the root story's own path, which has no ancestors.
 */
export function ancestorPaths(path: string | null): string[] {
  if (path === null || path === '') return []
  const segments = path.split('/')
  const out: string[] = ['']
  for (let i = 1; i < segments.length; i++) out.push(segments.slice(0, i).join('/'))
  return out
}

/**
 * The page tree. Unrouted rows (`path === null`) are skipped entirely rather
 * than surfacing as extra top-level nodes: they are not in the tree, which is
 * the whole of `document-types.md` checkpoint 2, and `GET /folio/stories`
 * becomes page-types-only for free. `listDocuments` is how a record or a
 * singleton is listed instead.
 */
export function buildTree(rows: readonly StoryMeta[]): StoryNode[] {
  const byId = new Map<string, StoryNode>()
  for (const row of rows) {
    if (row.path === null) continue
    byId.set(row.id, { ...row, children: [] })
  }

  const roots: StoryNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sort = (nodes: StoryNode[]) => {
    nodes.sort((a, b) => compareSiblings(a.ord, a.id, b.ord, b.id))
    for (const n of nodes) sort(n.children)
  }
  sort(roots)
  return roots
}

/**
 * Paths for every *routed* row, derived from the ancestor chain. Run after a
 * rename or a move and write back only the rows whose path actually changed.
 *
 * Unrouted rows (`path === null`) are absent from the result rather than
 * mapped to something: they have no ancestor chain — `parent_id` is null too —
 * and a caller writing `paths.get(id) ?? row.path` therefore keeps their null
 * untouched.
 */
export function derivePaths(rows: readonly StoryMeta[]): Map<string, string> {
  const byId = new Map(rows.filter((r) => r.path !== null).map((r) => [r.id, r]))
  const out = new Map<string, string>()
  const seen = new Set<string>()

  const pathOf = (row: StoryMeta): string => {
    const cached = out.get(row.id)
    if (cached !== undefined) return cached
    if (seen.has(row.id)) return row.slug // cycle guard
    seen.add(row.id)

    const parent = row.parentId ? byId.get(row.parentId) : undefined
    const path = parent ? joinPath(pathOf(parent), row.slug) : row.slug
    out.set(row.id, path)
    return path
  }

  for (const row of byId.values()) pathOf(row)
  return out
}

/**
 * `id` plus every descendant.
 *
 * Visits each row once, so a `parent_id` cycle degrades instead of overflowing the
 * stack — the same reason `derivePaths` carries a guard. Concurrent moves in D1 are
 * last-write-wins, and the two operations that could clean a cycle up (`updateStory`
 * and `deleteStory`) both walk through here.
 */
export function descendants(rows: readonly StoryMeta[], id: string): string[] {
  const children = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.parentId) continue
    const list = children.get(r.parentId)
    if (list) list.push(r.id)
    else children.set(r.parentId, [r.id])
  }
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (cur: string) => {
    if (seen.has(cur)) return
    seen.add(cur)
    out.push(cur)
    for (const child of children.get(cur) ?? []) walk(child)
  }
  walk(id)
  return out
}

/**
 * The *live* descendants of `id` — what unpublish's confirmation names as
 * staying up, per `unpublish.md`'s architecture decision 3 (no cascade, but
 * the editor is told what it does not cascade to). Excludes `id` itself,
 * unlike `descendants`, since a story is never its own descendant here.
 *
 * `'changed'` counts as live: it is `'live'` with unpublished edits on top
 * (`draftState`), and a page mid-edit is still serving the public exactly like
 * an untouched one — unpublishing its ancestor must still warn that it stays up.
 */
export function liveDescendants(rows: readonly StoryMeta[], id: string): StoryMeta[] {
  const ids = new Set(descendants(rows, id))
  ids.delete(id)
  return rows.filter((r) => ids.has(r.id) && (r.state === 'live' || r.state === 'changed'))
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'untitled'
  )
}

export function newStoryId(): string {
  return `sty_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}
