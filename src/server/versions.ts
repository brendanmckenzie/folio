import type { Doc } from '../core/doc'

export type VersionKind = 'publish' | 'checkpoint'

export interface VersionMeta {
  id: string
  storyId: string
  kind: VersionKind
  label: string | null
  title: string
  actor: string | null
  createdAt: number
}

const META = `id, story_id as storyId, kind, label, title, actor, created_at as createdAt`

function newVersionId(): string {
  return `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function docTitle(doc: Doc, fallback: string): string {
  return String(doc.bloks[doc.root]?.data.title ?? '').trim() || fallback
}

/** Newest first. Excludes the document payload so this stays cheap to list. */
export async function listVersions(
  db: D1Database,
  storyId: string,
  limit = 50,
): Promise<VersionMeta[]> {
  const { results } = await db
    .prepare(
      `select ${META} from versions where story_id = ? order by created_at desc, id desc limit ?`,
    )
    .bind(storyId, limit)
    .all<VersionMeta>()
  return results
}

export async function getVersion(
  db: D1Database,
  id: string,
): Promise<{ meta: VersionMeta; doc: Doc } | null> {
  const row = await db
    .prepare(`select ${META}, doc from versions where id = ?`)
    .bind(id)
    .first<VersionMeta & { doc: string }>()
  if (!row) return null
  const { doc, ...meta } = row
  return { meta, doc: JSON.parse(doc) as Doc }
}

export async function writeVersion(
  db: D1Database,
  input: {
    storyId: string
    kind: VersionKind
    doc: Doc
    label?: string | null
    actor?: string | null
    fallbackTitle: string
  },
): Promise<VersionMeta> {
  const meta: VersionMeta = {
    id: newVersionId(),
    storyId: input.storyId,
    kind: input.kind,
    label: input.label?.trim() || null,
    title: docTitle(input.doc, input.fallbackTitle),
    actor: input.actor ?? null,
    createdAt: Date.now(),
  }

  await db
    .prepare(
      `insert into versions (id, story_id, kind, label, title, actor, doc, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      meta.id,
      meta.storyId,
      meta.kind,
      meta.label,
      meta.title,
      meta.actor,
      JSON.stringify(input.doc),
      meta.createdAt,
    )
    .run()

  return meta
}

export async function deleteVersionsFor(
  db: D1Database,
  storyIds: readonly string[],
): Promise<void> {
  if (!storyIds.length) return
  const placeholders = storyIds.map(() => '?').join(', ')
  await db
    .prepare(`delete from versions where story_id in (${placeholders})`)
    .bind(...storyIds)
    .run()
}
