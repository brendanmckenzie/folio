import { compareSiblings, type Doc, keyAtIndex } from '../core/doc'
import {
  buildTree,
  derivePaths,
  descendants,
  newStoryId,
  slugify,
  storyState,
  type StoryMeta,
  type StoryNode,
} from '../core/story'

const COLS = `id, parent_id as parentId, slug, path, ord, title,
              published_at as publishedAt, unpublished_at as unpublishedAt,
              updated_at as updatedAt`

/** A `COLS` row before `state` is derived onto it. */
type StoryRow = Omit<StoryMeta, 'state'>

/**
 * `state` is derived here, once, rather than stored: `publishedAt` and
 * `unpublishedAt` are the only columns it needs (see `storyState`), so every
 * reader of a story row — the tree, `folio.stories(env)`, a future content API
 * — agrees on what a badge means without a column that could itself drift out
 * of sync with the two it summarises.
 */
function withState(row: StoryRow): StoryMeta {
  return { ...row, state: storyState(row.publishedAt, row.unpublishedAt) }
}

export async function listStories(db: D1Database): Promise<StoryMeta[]> {
  const { results } = await db.prepare(`select ${COLS} from stories`).all<StoryRow>()
  return results.map(withState)
}

export async function storyTree(db: D1Database): Promise<StoryNode[]> {
  return buildTree(await listStories(db))
}

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

/**
 * Fractional key placing a story at `index` among the children of `parentId`.
 *
 * Sorted through `compareSiblings`, the comparator `buildTree` uses, so the sibling
 * list an index counts into is the one the user was looking at. A raw comparator
 * returns 0 on tied `ord` values and leaves the two orders free to disagree.
 */
function orderAt(
  rows: readonly StoryMeta[],
  parentId: string | null,
  index: number,
  ignore?: string,
) {
  const sibs = rows
    .filter((r) => r.parentId === parentId && r.id !== ignore)
    .sort((a, b) => compareSiblings(a.ord, a.id, b.ord, b.id))
  return keyAtIndex(
    sibs.map((r) => r.ord),
    index,
  )
}

function uniqueSlug(
  rows: readonly StoryMeta[],
  parentId: string | null,
  wanted: string,
  ignore?: string,
) {
  const taken = new Set(
    rows.filter((r) => r.parentId === parentId && r.id !== ignore).map((r) => r.slug),
  )
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n++) {
    const candidate = `${wanted}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function createStory(
  db: D1Database,
  input: { title: string; slug?: string; parentId?: string | null },
): Promise<StoryMeta> {
  const rows = await listStories(db)
  const parentId = input.parentId ?? null
  if (parentId && !rows.some((r) => r.id === parentId)) throw new Error('Unknown parent')

  const slug = uniqueSlug(rows, parentId, slugify(input.slug || input.title))
  const parentPath = parentId ? (rows.find((r) => r.id === parentId)?.path ?? '') : ''
  const story: StoryMeta = {
    id: newStoryId(),
    parentId,
    slug,
    path: parentPath ? `${parentPath}/${slug}` : slug,
    ord: orderAt(rows, parentId, rows.filter((r) => r.parentId === parentId).length),
    title: input.title.trim() || 'Untitled',
    publishedAt: null,
    unpublishedAt: null,
    state: 'draft',
    updatedAt: Date.now(),
  }

  await db
    .prepare(
      `insert into stories (id, parent_id, slug, path, ord, title, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(story.id, story.parentId, story.slug, story.path, story.ord, story.title, story.updatedAt)
    .run()

  return story
}

/**
 * Rename, retitle or move. Paths for the whole affected subtree are recomputed
 * in one batch. Cheap enough to do in JS at any realistic page count, and much
 * easier to get right than a recursive CTE.
 */
export async function updateStory(
  db: D1Database,
  id: string,
  patch: { title?: string; slug?: string; parentId?: string | null; index?: number },
): Promise<StoryMeta> {
  const rows = await listStories(db)
  const current = rows.find((r) => r.id === id)
  if (!current) throw new Error('Unknown story')

  // The root story owns '/' and cannot be reslugged or reparented.
  const isRoot = current.path === ''
  const subtree = new Set(descendants(rows, id))

  const parentId = patch.parentId !== undefined && !isRoot ? patch.parentId : current.parentId
  if (parentId && subtree.has(parentId)) throw new Error('Cannot move a story into its own subtree')
  if (parentId && !rows.some((r) => r.id === parentId)) throw new Error('Unknown parent')

  const next: StoryMeta = {
    ...current,
    title: patch.title?.trim() || current.title,
    slug: isRoot
      ? ''
      : uniqueSlug(rows, parentId, slugify(patch.slug ?? patch.title ?? current.slug), id),
    parentId,
    ord:
      patch.index !== undefined || parentId !== current.parentId
        ? orderAt(rows, parentId, patch.index ?? 0, id)
        : current.ord,
    updatedAt: Date.now(),
  }

  const merged = rows.map((r) => (r.id === id ? next : r))
  const paths = derivePaths(merged)

  const changed = merged.filter((r) => paths.get(r.id) !== r.path || r.id === id)
  const statements = changed.map((r) =>
    db
      .prepare(
        `update stories set parent_id = ?, slug = ?, path = ?, ord = ?, title = ?, updated_at = ?
         where id = ?`,
      )
      .bind(r.parentId, r.slug, paths.get(r.id) ?? r.path, r.ord, r.title, Date.now(), r.id),
  )
  if (statements.length) await db.batch(statements)

  return { ...next, path: paths.get(id) ?? next.path }
}

/**
 * What deleting `id` would remove, and the statement that does it, unrun: a
 * caller batches this alongside the versions cleanup so a story's rows and its
 * version history disappear in one transaction rather than one succeeding
 * while the other fails. Null when there is no such story.
 */
export async function deleteStoryStatement(
  db: D1Database,
  id: string,
): Promise<{ ids: string[]; statement: D1PreparedStatement } | null> {
  const rows = await listStories(db)
  const target = rows.find((r) => r.id === id)
  if (!target) return null
  if (target.path === '') throw new Error('Cannot delete the root story')

  const ids = descendants(rows, id)
  const placeholders = ids.map(() => '?').join(', ')
  const statement = db.prepare(`delete from stories where id in (${placeholders})`).bind(...ids)
  return { ids, statement }
}

/** Removes the story and everything beneath it. */
export async function deleteStory(db: D1Database, id: string): Promise<string[]> {
  const found = await deleteStoryStatement(db, id)
  if (!found) return []
  await found.statement.run()
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
 */
export function publishStoryStatement(
  db: D1Database,
  id: string,
  doc: Doc,
  fallbackTitle: string,
): { publishedAt: number; title: string; statement: D1PreparedStatement } {
  const title = String(doc.bloks[doc.root]?.data.title ?? '').trim() || fallbackTitle
  const publishedAt = Date.now()
  const statement = db
    .prepare(
      `update stories set published_doc = ?, published_at = ?, title = ?, updated_at = ?,
       unpublished_at = null, unpublished_by = null
       where id = ?`,
    )
    .bind(JSON.stringify(doc), publishedAt, title, publishedAt, id)
  return { publishedAt, title, statement }
}

/** Snapshot a draft into D1, caching the document's title for the tree. */
export async function publishStory(
  db: D1Database,
  id: string,
  doc: Doc,
  fallbackTitle: string,
): Promise<number> {
  const { publishedAt, statement } = publishStoryStatement(db, id, doc, fallbackTitle)
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
