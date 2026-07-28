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

export interface WriteVersionInput {
  storyId: string
  kind: VersionKind
  doc: Doc
  label?: string | null
  actor?: string | null
  fallbackTitle: string
}

function buildVersionMeta(input: WriteVersionInput): VersionMeta {
  return {
    id: newVersionId(),
    storyId: input.storyId,
    kind: input.kind,
    label: input.label?.trim() || null,
    title: docTitle(input.doc, input.fallbackTitle),
    actor: input.actor ?? null,
    createdAt: Date.now(),
  }
}

/** The insert, unrun: lets a caller batch it alongside another write it must
 * land atomically with (see `versionStatement` below and the publish route). */
function versionStatement(db: D1Database, meta: VersionMeta, doc: Doc): D1PreparedStatement {
  return db
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
      JSON.stringify(doc),
      meta.createdAt,
    )
}

/**
 * Builds the version row's statement without running it, for a caller that must
 * batch it together with another write (publish's stories-row update) so the two
 * can never land disagreeing with each other.
 */
export function buildVersionWrite(
  db: D1Database,
  input: WriteVersionInput,
): { meta: VersionMeta; statement: D1PreparedStatement } {
  const meta = buildVersionMeta(input)
  return { meta, statement: versionStatement(db, meta, input.doc) }
}

export async function writeVersion(db: D1Database, input: WriteVersionInput): Promise<VersionMeta> {
  const { meta, statement } = buildVersionWrite(db, input)
  await statement.run()
  return meta
}

/** The delete, unrun, or null when there is nothing to remove: a caller batches
 * this alongside the stories-row delete so a story and its version history
 * disappear together. */
export function deleteVersionsStatement(
  db: D1Database,
  storyIds: readonly string[],
): D1PreparedStatement | null {
  if (!storyIds.length) return null
  const placeholders = storyIds.map(() => '?').join(', ')
  return db.prepare(`delete from versions where story_id in (${placeholders})`).bind(...storyIds)
}

export async function deleteVersionsFor(
  db: D1Database,
  storyIds: readonly string[],
): Promise<void> {
  await deleteVersionsStatement(db, storyIds)?.run()
}
