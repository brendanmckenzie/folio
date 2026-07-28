import { compareSiblings, type Doc, keyAtIndex } from '../core/doc'
import {
  buildTree,
  derivePaths,
  descendants,
  newStoryId,
  slugify,
  type StoryMeta,
  type StoryNode,
} from '../core/story'

const COLS = `id, parent_id as parentId, slug, path, ord, title,
              published_at as publishedAt, updated_at as updatedAt`

export async function listStories(db: D1Database): Promise<StoryMeta[]> {
  const { results } = await db.prepare(`select ${COLS} from stories`).all<StoryMeta>()
  return results
}

export async function storyTree(db: D1Database): Promise<StoryNode[]> {
  return buildTree(await listStories(db))
}

export async function storyByPath(db: D1Database, path: string): Promise<StoryMeta | null> {
  return db.prepare(`select ${COLS} from stories where path = ?`).bind(path).first<StoryMeta>()
}

export async function storyById(db: D1Database, id: string): Promise<StoryMeta | null> {
  return db.prepare(`select ${COLS} from stories where id = ?`).bind(id).first<StoryMeta>()
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
      `update stories set published_doc = ?, published_at = ?, title = ?, updated_at = ?
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
