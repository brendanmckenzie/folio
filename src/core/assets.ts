/**
 * The media library's organisation vocabulary
 * (`../../docs/specs/content-model/media-library.md`): folders, tags, the
 * filter that narrows a list to both, and the tag identity function.
 *
 * `AssetSort` / `DEFAULT_ASSET_SORT` live here too, moved from `core/story.ts` —
 * they were only ever there because there was no assets module yet. The rule
 * that put them in `core/` in the first place still applies and is why this
 * whole file is here rather than in `server/`: a value that travels in a URL has
 * to be shared by the screen that writes it and the reader that answers it, and
 * `core/` is the only thing both import.
 *
 * Nothing here resolves an id, reads a database, or knows about a Durable
 * Object. `AssetFilter` is exactly what a captured *select all* holds
 * (`core/bulk.ts`'s `FilterSelection<F>`, phase 5) and what a list route parses
 * off its query string — a snapshot of intent, never a query result.
 */

/**
 * A folder in the tree. `path` is the slash-joined chain of slugified ancestor
 * names, this folder last — `stories.path`'s shape (`core/story.ts`'s
 * `derivePaths`), copied on purpose (decision 3). Filtering by a folder is a
 * range comparison on `path`, never `LIKE`: every descendant of `p` sorts
 * inside `[p || '/', p || '0')`, because `'/'` (0x2F) sorts before `'0'`
 * (0x30) and nothing else in ASCII does that for a path separator.
 *
 * A folder is metadata only (decision 1): filing a file changes `folder_id` on
 * one row and issues no R2 operation, so nothing here is or ever becomes part
 * of a key or a URL.
 */
export interface AssetFolder {
  id: string
  parentId: string | null
  name: string
  path: string
  createdAt: number
}

/**
 * A tag: free-form, editor-created, many-to-many with assets (decision 4).
 * `slug` is the identity — `tagSlug`'s output — and `name` is what was typed
 * first and is what is displayed. `count` is present only where a route was
 * asked for it (`?counts=1`); it is never populated speculatively.
 */
export interface AssetTag {
  id: string
  name: string
  slug: string
  count?: number
}

/**
 * What a captured select-all holds for the media library, and what a list
 * route parses off its query string.
 *
 * Folders and tags are both *filters* (decision 2): the grid stays flat, and a
 * folder or a tag chip is one more clause in the same `where` as `q` and
 * `kind` already are — nothing here means "navigate into", only "narrow to".
 */
export interface AssetFilter {
  q?: string
  kind?: string
  /** A folder `path`. Includes descendants — decision 3. */
  folder?: string
  /** Tag slugs, ANDed. At most 8 (decision 4). */
  tags?: readonly string[]
  /** `folder_id is null`. Mutually exclusive with `folder`. */
  unfiled?: boolean
  /** No tagging rows. The retro-organise starting point. */
  untagged?: boolean
  /** `described_at is null`. Drives the enrichment backlog view. */
  undescribed?: boolean
}

/** The four operations a selection of assets can be run through (phase 5's
 * `runAssetBulk`), mirroring `core/story.ts`'s `BulkAction` for stories. */
export type AssetBulkAction = 'tag' | 'untag' | 'move' | 'delete'

/**
 * The tag identity: lowercased, trimmed, with every run of inner whitespace
 * removed rather than merely squashed to one space. `Headshot`, `headshot`
 * and `  head shot  ` all reduce to the same string, which is what makes them
 * one tag and not three (decision 4) — and the comparison has to be *exact*,
 * because creating a colliding tag is meant to find the existing row, not fail
 * a `unique` constraint that a caller then has to recover from.
 */
export function tagSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * The Assets screen's ordering — `docs/ui-architecture.md`'s Assets section asks
 * for "sort by date or name or size", and the library was hard-wired to newest
 * first before it.
 *
 * Here rather than in `server/assets.ts` for the reason the whole file is here:
 * the value travels in a URL, so the screen that writes it and the reader that
 * answers it have to share one vocabulary, and `core/` is the only thing both
 * import.
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
