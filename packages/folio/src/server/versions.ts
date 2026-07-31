import type { Doc } from '../core/doc'
import { migrateDoc, type Migration, pendingFor } from '../core/migrate'
import type { DocumentType, SchemaIndex } from '../core/schema'
import type { StoryMeta } from '../core/story'
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import { keysetWhere, NEWEST_FIRST, orderBy, whereOf } from './keyset'
import { storiesFor } from './stories'

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

/**
 * Newest first, paged over `(created_at, id)` — which `versions_story` already
 * indexes, and which was already this route's `order by`. Excludes the document
 * payload so listing stays cheap.
 *
 * Was capped at 50 with no cursor: a page published weekly for a year had a
 * history that stopped a year short.
 */
export async function listVersions(
  db: D1Database,
  storyId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<Page<VersionMeta>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const resume = keysetWhere(NEWEST_FIRST, opts.cursor ? decodeCursor(opts.cursor) : null)
  const { results } = await db
    .prepare(
      `select ${META} from versions ${whereOf('story_id = ?', resume.sql)} ${orderBy(NEWEST_FIRST)} limit ?`,
    )
    .bind(storyId, ...resume.binds, limit + 1)
    .all<VersionMeta>()
  return paginate(results, limit, (row) => [row.createdAt, row.id])
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

/* ---------------------------------------------------------- site-wide reads --- */

/**
 * One recent publish, across the whole site: the version row and the story it
 * belongs to.
 *
 * **Both, not a merged row**, and the split is load-bearing in two directions. The
 * *version* carries the title as it was **at the moment of publishing**, which is the
 * right label for "what went live" — a page renamed since is not what was published.
 * The *story* is what a link needs, and it has to be a whole `StoryMeta` because
 * `rt.withUrls` is typed on one: a URL is the host's own `route()` function's answer,
 * so neither this reader nor the route may derive one from a path.
 *
 * It is also what stops the two colliding. `versions` and `stories` both have an
 * `id`, a `title` and a timestamp, so a single flat row would need every column
 * aliased twice and one of each pair would end up meaning whichever the driver
 * returned last.
 *
 * `ui-architecture.md` dependency 5, and the spec calls it "cheap and exact"
 * correctly: `versions` already holds one row per publish with its actor and its
 * timestamp, so this is a query over data written for another purpose. Nothing new is
 * stored to answer it.
 */
export interface RecentPublish {
  version: VersionMeta
  story: StoryMeta
}

/**
 * The most recent publishes, newest first.
 *
 * **`kind = 'publish'` and not every version.** A checkpoint is a version too and is
 * not a publish; a list called "latest published" that counted an editor's private
 * save point as a release would be worse than no list.
 *
 * **Two queries rather than a join**, which is the interesting choice here. The join
 * version needs both projections in one row, and `versions` and `stories` share
 * three column names — so it needs every column aliased and a reader that unpicks
 * them, which is how a column silently starts meaning the wrong table's value. This
 * pages the versions over `versions_story`'s ordering and then asks `storiesFor` for
 * the ids it found, which is one extra round trip for a reader anybody can check by
 * eye. The page size is at most 100, so the second query binds at most 100 ids.
 *
 * A version whose story is **gone** is dropped rather than returned with a null
 * story. `deleteStoryStatement` batches `deleteVersionsStatement` alongside the story
 * rows, so this cannot normally happen; dropping means a bug there shows up as a
 * missing row rather than as a link to nothing. It does mean a page can come back
 * shorter than `limit` — which is why the cursor comes off the *version* rows and not
 * off what survived the join.
 */
export async function listRecentPublishes(
  db: D1Database,
  opts: { limit?: number; cursor?: string } = {},
): Promise<Page<RecentPublish>> {
  const limit = clampLimit(opts.limit, 20, 100)
  const resume = keysetWhere(NEWEST_FIRST, opts.cursor ? decodeCursor(opts.cursor) : null)
  const { results } = await db
    .prepare(
      `select ${META} from versions ${whereOf("kind = 'publish'", resume.sql)}
       ${orderBy(NEWEST_FIRST)} limit ?`,
    )
    .bind(...resume.binds, limit + 1)
    .all<VersionMeta>()

  const page = paginate(results, limit, (row) => [row.createdAt, row.id])
  const stories = await storiesFor(db, [...new Set(page.rows.map((row) => row.storyId))])
  const byId = new Map(stories.map((story) => [story.id, story]))
  return {
    ...page,
    rows: page.rows.flatMap((version) => {
      const story = byId.get(version.storyId)
      return story ? [{ version, story }] : []
    }),
  }
}
