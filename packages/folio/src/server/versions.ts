import type { Doc } from '../core/doc'
import { migrateDoc, type Migration, pendingFor } from '../core/migrate'
import type { DocumentType, SchemaIndex } from '../core/schema'

export type VersionKind = 'publish' | 'checkpoint'

export interface VersionMeta {
  id: string
  storyId: string
  kind: VersionKind
  label: string | null
  title: string
  actor: string | null
  createdAt: number
  /**
   * Which content migration this document was written at
   * (`schema-migrations.md`), or null for "before the first migration" — the
   * correct reading for every row written before the column existed.
   *
   * The row itself is never rewritten (checkpoint 3): `getVersion` applies the
   * migrations it is missing on the way out. History stays byte-true, and a
   * restore across a migration diffs two documents in the same shape rather
   * than reintroducing pre-migration keys.
   */
  schemaId: string | null
}

const META = `id, story_id as storyId, kind, label, title, actor,
              created_at as createdAt, schema_id as schemaId`

/** `META` qualified, for the one query that joins `stories` (see `getVersion`). */
const V_META = `v.id, v.story_id as storyId, v.kind, v.label, v.title, v.actor,
                v.created_at as createdAt, v.schema_id as schemaId`

function newVersionId(): string {
  return `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
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

/**
 * What `getVersion` needs to bring an old version document up to the current
 * model on the way out (`schema-migrations.md` checkpoint 3).
 *
 * Optional at the call site: a caller with no migrations configured, and every
 * existing test, gets the stored bytes unchanged.
 */
export interface VersionMigrations {
  migrations: readonly Migration[]
  schema: SchemaIndex
  typeOf: (name: string | undefined) => DocumentType | undefined
}

/**
 * A version's metadata and its document, **migrated on read**.
 *
 * The stored row is never rewritten. That keeps history byte-true — the record
 * of what was actually published survives a schema change — and it is what makes
 * a restore across a migration correct: the admin computes `diff(live, target)`,
 * so a target still holding pre-migration keys would reintroduce them into the
 * live draft. This is the subtle bug the whole decision exists to avoid.
 *
 * The story's *type* comes off a join rather than a second query: it is what
 * `MigrationContext.type` needs, and a version whose story has since been
 * deleted has no type to migrate against, so it is handed back as stored.
 */
export async function getVersion(
  db: D1Database,
  id: string,
  migrate?: VersionMigrations,
): Promise<{ meta: VersionMeta; doc: Doc; migrated: string[] } | null> {
  const row = await db
    .prepare(
      `select ${V_META}, v.doc, s.type as storyType
       from versions v left join stories s on s.id = v.story_id
       where v.id = ?`,
    )
    .bind(id)
    .first<VersionMeta & { doc: string; storyType: string | null }>()
  if (!row) return null
  const { doc: json, storyType, ...meta } = row
  const stored = JSON.parse(json) as Doc

  const due = migrate ? pendingFor(meta.schemaId, migrate.migrations) : []
  const type = migrate && storyType !== null ? migrate.typeOf(storyType) : undefined
  if (due.length === 0 || !type || !migrate) return { meta, doc: stored, migrated: [] }

  const { doc } = migrateDoc(stored, due, migrate.schema, type)
  return { meta, doc, migrated: due.map((m) => m.id) }
}

export interface WriteVersionInput {
  storyId: string
  kind: VersionKind
  doc: Doc
  label?: string | null
  actor?: string | null
  /**
   * The document's display title, already resolved by the caller. This file used
   * to derive it from `doc.bloks[doc.root].data.title` and fall back — which is
   * only correct for a root block that happens to have a `title` field. Which
   * field holds it is a property of the *document type* now (`titleOf`), so the
   * caller that knows the type resolves it and the version row records exactly
   * what `stories.title` caches.
   */
  title: string
  /**
   * The migration this document is written at — `FolioRuntime.schemaId`, the
   * last configured migration. Stamped so `getVersion` knows what this row is
   * *missing*: a version written today needs nothing applied, and one written
   * before the first migration reads null and gets the lot.
   */
  schemaId?: string | null
}

function buildVersionMeta(input: WriteVersionInput): VersionMeta {
  return {
    id: newVersionId(),
    storyId: input.storyId,
    kind: input.kind,
    label: input.label?.trim() || null,
    title: input.title.trim() || 'Untitled',
    actor: input.actor ?? null,
    createdAt: Date.now(),
    schemaId: input.schemaId ?? null,
  }
}

/** The insert, unrun: lets a caller batch it alongside another write it must
 * land atomically with (see `versionStatement` below and the publish route). */
function versionStatement(db: D1Database, meta: VersionMeta, doc: Doc): D1PreparedStatement {
  return db
    .prepare(
      `insert into versions (id, story_id, kind, label, title, actor, doc, created_at, schema_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      meta.schemaId,
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
