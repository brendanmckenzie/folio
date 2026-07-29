import { compareSiblings } from './doc'

/**
 * Story *structure*. Page metadata lives in the document's root block, not
 * here — see migrations/0001_initial.sql. The only content field mirrored into this table is
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
   * changed" (see migrations/0005_draft_watermark.sql).
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
