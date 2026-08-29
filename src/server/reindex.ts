/**
 * Rebuilding `content_index` and `content_refs` from `published_doc`
 * (`../../docs/specs/content-model/collections.md` architecture decision 3).
 *
 * Publish-time writing covers every ordinary case, and this exists for the one it
 * cannot: a schema change that adds `indexed: true` to a field that already has
 * content. Nothing republishes, so nothing would ever write the new rows.
 *
 * Shaped like `runMigrations` on purpose — batched, resumable by an `id` cursor,
 * explicit rather than automatic — because it has the same two problems: it walks
 * every published document, and a Worker request has a CPU limit it must not
 * exceed. One call sweeps up to `opts.batch` documents and answers `continueFrom`;
 * re-call with it until it is null.
 *
 * Idempotent, which is what makes racing a publish harmless: both write the same
 * rows for the same document, delete-then-insert, so the worst case is a row
 * written twice.
 */
import type { LocaleConfig } from '../core/locales'
import type { DocumentType, SchemaIndex } from '../core/schema'
import { contentProjection, indexStatements } from './content-index'
import type { HookRunner } from './hooks'
import { publishedDocsAfter } from './stories'

const DEFAULT_BATCH = 50
const MAX_BATCH = 200

export interface ReindexOptions {
  /** How many documents this call may sweep. Default 50, capped at 200. */
  batch?: number
  /** The previous call's `continueFrom`. */
  continueFrom?: string | null
  /** Computes everything, writes nothing, and answers the same shape. */
  dryRun?: boolean
  /** Who asked, for the `reindexed` hook. Off the session, never the body. */
  actor?: string | null
}

export interface ReindexReport {
  /** Documents examined in this call. */
  documents: number
  /** `content_index` rows written across them. */
  indexRows: number
  /** `content_refs` rows written across them. */
  refRows: number
  /** Documents that projected to no rows at all — no indexed field has a value. */
  empty: number
  /** Pass back as `continueFrom` to sweep the next batch. Null when done. */
  continueFrom: string | null
  dryRun: boolean
}

export interface ReindexDeps {
  db: D1Database
  schema: SchemaIndex
  typeOf: (name: string | undefined) => DocumentType | undefined
  locales?: LocaleConfig
  /**
   * Fires `reindexed` once per batch (`../platform/caching.md`). Optional for
   * the reason `MigrateDeps.hooks` is: absent is what every caller did before
   * the event existed. Unlike a migration this one cannot name what it
   * affected — it changes what *every* collection query answers, and which
   * pages hold a collection is precisely what nothing records.
   */
  hooks?: HookRunner<unknown>
}

export async function reindex(
  deps: ReindexDeps,
  opts: ReindexOptions = {},
): Promise<ReindexReport> {
  const batch = Math.min(Math.max(Math.trunc(opts.batch ?? DEFAULT_BATCH), 1), MAX_BATCH)
  const dryRun = opts.dryRun === true
  const docs = await publishedDocsAfter(deps.db, opts.continueFrom ?? null, batch)

  let indexRows = 0
  let refRows = 0
  let empty = 0
  const statements: D1PreparedStatement[] = []

  for (const row of docs) {
    const projection = contentProjection(
      row.id,
      row.doc,
      deps.typeOf(row.type),
      deps.schema,
      deps.locales,
    )
    indexRows += projection.index.length
    refRows += projection.refs.length
    if (projection.index.length === 0 && projection.refs.length === 0) empty++
    // The deletes are emitted even for a document that projects to nothing: that
    // is the case a *removed* `indexed` flag produces, and leaving the old rows
    // behind would keep a field queryable that the schema no longer declares.
    statements.push(...indexStatements(deps.db, row.id, projection))
  }

  // One batch for the whole sweep rather than one per document: a partial sweep
  // is recoverable (re-run it), but a partially-rewritten *document* — its deletes
  // landed and its inserts not — is a document silently missing from every
  // collection until somebody notices.
  if (!dryRun && statements.length > 0) await deps.db.batch(statements)

  // After the write, like every other lifecycle hook, and only when there was
  // one: a dry run and an empty sweep both leave the index exactly as it was.
  if (!dryRun && docs.length > 0) {
    await deps.hooks?.run('reindexed', { count: docs.length, actor: opts.actor ?? null })
  }

  return {
    documents: docs.length,
    indexRows,
    refRows,
    empty,
    // A short batch means the walk reached the end. A full one might have, and
    // costs one more empty call to find out — the same trade `runMigrations` makes.
    continueFrom: docs.length < batch ? null : (docs[docs.length - 1]?.id ?? null),
    dryRun,
  }
}
