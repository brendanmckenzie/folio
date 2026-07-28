import { compareSiblings } from './doc'

/**
 * Story *structure*. Page metadata lives in the document's root block, not
 * here — see schema.sql. The only content field mirrored into this table is
 * `title`, cached so the tree renders without loading every Durable Object.
 */
export interface StoryMeta {
  id: string
  parentId: string | null
  slug: string
  path: string
  ord: string
  title: string
  publishedAt: number | null
  updatedAt: number
  /** Filled server-side from the host's `route` config. */
  url?: string
  previewUrl?: string
}

export interface StoryNode extends StoryMeta {
  children: StoryNode[]
}

export function joinPath(parentPath: string, slug: string): string {
  if (!slug) return parentPath
  return parentPath ? `${parentPath}/${slug}` : slug
}

export function buildTree(rows: readonly StoryMeta[]): StoryNode[] {
  const byId = new Map<string, StoryNode>()
  for (const row of rows) byId.set(row.id, { ...row, children: [] })

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
 * Paths for every row, derived from the ancestor chain. Run after a rename or
 * a move and write back only the rows whose path actually changed.
 */
export function derivePaths(rows: readonly StoryMeta[]): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]))
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

  for (const row of rows) pathOf(row)
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
