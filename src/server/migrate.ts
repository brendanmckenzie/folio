/**
 * The content-migration runner (`../../docs/specs/foundation/schema-migrations.md`
 * architecture decision 5).
 *
 * A migration produces *mutations*, and this is what applies them:
 *
 *   - a story's live **draft** through `StoryDO.commit`, the real log path, so it
 *     syncs to open editors, lands in the activity trail and is undoable;
 *   - the **published snapshot** through `applyAll` and one D1 write, batched with
 *     the watermark;
 *   - **version rows** are not touched at all — they are migrated on read (see
 *     `versions.ts`), so history stays byte-true.
 *
 * Explicit, never automatic on boot (checkpoint 5): a migration that runs itself
 * on the first request after a deploy runs inside a request whose CPU limit it
 * can exceed, on a cold Worker, with nobody watching. It is one HTTP call to
 * `POST {base}/migrate`, or `folio.migrate(env, opts)` from a script.
 *
 * Batched with a cursor rather than streamed (the spec's resolved open question):
 * one call migrates up to `batch` documents and answers `continueFrom`, and the
 * client re-calls until it is null. A stream would have to hold a response open
 * across exactly the CPU limit this design exists to stay under.
 */
import type { Doc } from '../core/doc'
import { migrateDoc, type Migration, pendingFor } from '../core/migrate'
import { applyAll, type Mutation } from '../core/mutations'
import { MAX_TX_MUTATIONS } from '../core/protocol'
import type { SchemaIndex } from '../core/schema'
import type { StoryMeta } from '../core/story'
import type { HookRunner } from './hooks'
import type { FolioRuntime } from './runtime'
import { countBehind, stampSchemaStatement, storiesBehind } from './stories'
import type { StoryStub } from './types'

/** How many documents one call sweeps before handing back a cursor. */
export const DEFAULT_MIGRATE_BATCH = 25

/** Ceiling on `batch`, so a caller cannot ask for a run that outlives the request. */
export const MAX_MIGRATE_BATCH = 200

export interface MigrateOptions {
  /** Compute everything, write nothing. Answers the same report shape. */
  dryRun?: boolean
  /** Resume after this story id — the `continueFrom` of the previous call. */
  continueFrom?: string | null
  batch?: number
  /** Recorded on the ledger row and on every transaction the run commits. */
  actor?: string | null
}

export interface MigrateFailure {
  storyId: string
  reason: string
}

export interface MigrateOversized {
  storyId: string
  /** Mutations the migrations produced for this document's draft. */
  mutations: number
  /** Transactions it was split into, each within `MAX_TX_MUTATIONS`. */
  transactions: number
}

export interface MigrateReport {
  /** Migration ids not yet recorded in `schema_migrations`, in run order. */
  pending: string[]
  /** Documents examined in this call. */
  stories: number
  /** Documents that produced at least one mutation. */
  changed: number
  /**
   * Documents already in the target shape — zero mutations. The number that
   * makes "did this work" answerable by running it again (checkpoint 2): a
   * second run reports every document here.
   */
  unchanged: number
  /** Mutations committed to drafts (or, on a dry run, that would be). */
  mutations: number
  /**
   * Mutations applied to published snapshots. Counted separately because they
   * are computed *independently*: a snapshot taken before an earlier edit is a
   * different document from the draft, so it needs its own answer, not the
   * draft's mutations replayed at it.
   */
  publishedMutations: number
  /** Transactions committed. Higher than `changed` when a document was chunked. */
  transactions: number
  /** Documents over `MAX_TX_MUTATIONS`, named so chunking is never a surprise. */
  oversized: MigrateOversized[]
  failed: MigrateFailure[]
  dryRun: boolean
  /**
   * The story id to resume after, or null when the sweep reached the end. The
   * client re-calls with `{ continueFrom }`.
   */
  continueFrom: string | null
  /** Documents still behind the configured migrations after this call. */
  behind: number
  /** True when nothing is behind: every document has had every migration. */
  complete: boolean
}

const EMPTY = (dryRun: boolean): MigrateReport => ({
  pending: [],
  stories: 0,
  changed: 0,
  unchanged: 0,
  mutations: 0,
  publishedMutations: 0,
  transactions: 0,
  oversized: [],
  failed: [],
  dryRun,
  continueFrom: null,
  behind: 0,
  complete: true,
})

/** `ms` split into transactions no larger than the wire's per-tx cap. */
export function chunk(ms: readonly Mutation[], size = MAX_TX_MUTATIONS): Mutation[][] {
  if (ms.length === 0) return []
  const out: Mutation[][] = []
  for (let i = 0; i < ms.length; i += size) out.push(ms.slice(i, i + size))
  return out
}

/** The migration ids `schema_migrations` already records, newest last. */
export async function appliedMigrations(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare('select id from schema_migrations order by id')
    .all<{ id: string }>()
  return results.map((r) => r.id)
}

/**
 * Refuses a migration inserted *before* one that has already run — `0001b`
 * appearing between `0001` and `0002` after `0002` is applied.
 *
 * The spec put this at construction, which cannot work: construction reads no
 * D1, and "already applied" is a database fact. So it is checked here, once, at
 * the top of a run. The alternative it rules out is a run order that depends on
 * when you happened to deploy.
 */
export function outOfOrderMigration(
  migrations: readonly Migration[],
  applied: readonly string[],
): string | null {
  const highest = applied.length > 0 ? applied[applied.length - 1]! : null
  if (highest === null) return null
  const appliedSet = new Set(applied)
  for (const m of migrations) {
    if (!appliedSet.has(m.id) && m.id < highest) {
      return `migration '${m.id}' sorts before '${highest}', which has already been applied — a migration cannot be inserted into the past`
    }
  }
  return null
}

/**
 * What the runner needs, assembled from bindings alone — no Request, no Hono, no
 * `Env`. The same discipline `PublishDeps` follows, and for the same reason: a
 * deploy script and a route must be able to reach this identically.
 */
export interface MigrateDeps {
  db: D1Database
  schema: SchemaIndex
  migrations: readonly Migration[]
  typeOf: FolioRuntime['typeOf']
  /** The story's live draft, created from its row on first touch. */
  draft: (story: StoryMeta) => Promise<Doc>
  /** The story's Durable Object, for `commit`. */
  stub: (id: string) => StoryStub
  /**
   * Fires `migrated` once per batch (`../platform/caching.md`). Optional, like
   * `PublishDeps.hooks`, and absent is the behaviour every caller had before
   * the event existed: a run rewrites `published_doc` per story through
   * `stampSchemaStatement` and used to tell nobody, so a cached page could
   * outlive the schema change that rewrote it.
   */
  hooks?: HookRunner<unknown>
}

/**
 * One batch of the sweep. See the file header for the shape; every guarantee it
 * relies on is `commit`'s (atomic per chunk, refused as a value not a throw).
 */
export async function runMigrations(
  deps: MigrateDeps,
  opts: MigrateOptions = {},
): Promise<MigrateReport> {
  const { db, schema, migrations } = deps
  const dryRun = opts.dryRun === true
  if (migrations.length === 0) return EMPTY(dryRun)

  const latestId = migrations[migrations.length - 1]!.id
  const applied = await appliedMigrations(db)
  const outOfOrder = outOfOrderMigration(migrations, applied)
  if (outOfOrder) throw new Error(`folio: ${outOfOrder}`)

  const appliedSet = new Set(applied)
  const pending = migrations.filter((m) => !appliedSet.has(m.id)).map((m) => m.id)

  const size = Math.min(Math.max(opts.batch ?? DEFAULT_MIGRATE_BATCH, 1), MAX_MIGRATE_BATCH)
  const rows = await storiesBehind(db, latestId, opts.continueFrom ?? null, size)

  const report: MigrateReport = { ...EMPTY(dryRun), pending, stories: rows.length }
  const actor = { id: opts.actor ?? `migration:${latestId}`, name: `Migration ${latestId}` }
  /**
   * Stories whose **published** snapshot this batch rewrote, for the `migrated`
   * hook. The published half rather than `report.changed`, deliberately: a
   * draft-only migration changes no bytes any reader can see, and the whole
   * point of naming ids at all (`caching.md` decision 6) is that a precise set
   * is *complete* — `story:X` is tagged on every page that loaded X, not only
   * on X's own page, so purging these also catches everything referencing them.
   */
  const republished: string[] = []

  for (const { story, publishedDoc } of rows) {
    const due = pendingFor(story.schemaId ?? null, migrations)
    const type = deps.typeOf(story.type)
    if (!type) {
      // A row whose type was removed from the code has no `MigrationContext.type`
      // to hand a migration. Recorded rather than skipped: the document genuinely
      // has not been migrated, so the ledger must not claim the run is complete,
      // and `/folio/audit` reports the same drift from the other direction.
      report.failed.push({
        storyId: story.id,
        reason: `unknown document type '${story.type}' — nothing declares it any more`,
      })
      continue
    }

    let draftMutations: Mutation[]
    try {
      const draft = await deps.draft(story)
      draftMutations = migrateDoc(draft, due, schema, type).mutations
    } catch (err) {
      // A transiently unreachable Durable Object. Recorded, ledger not
      // completed, re-run picks it up (the spec's own edge case).
      report.failed.push({ storyId: story.id, reason: reasonOf(err) })
      continue
    }

    // Computed independently of the draft, deliberately. A published snapshot was
    // taken at some past publish, so it can hold a field the draft has already
    // had migrated — replaying the draft's mutations at it would migrate what
    // happens to overlap and silently miss the rest. A migration is a pure
    // function of a document; there are two documents here.
    const publishedResult = publishedDoc
      ? migrateDoc(publishedDoc, due, schema, type)
      : { mutations: [] as Mutation[], doc: publishedDoc }

    const chunks = chunk(draftMutations)
    report.mutations += draftMutations.length
    report.publishedMutations += publishedResult.mutations.length

    if (draftMutations.length === 0 && publishedResult.mutations.length === 0) {
      report.unchanged++
    } else {
      report.changed++
    }
    if (draftMutations.length > MAX_TX_MUTATIONS) {
      report.oversized.push({
        storyId: story.id,
        mutations: draftMutations.length,
        transactions: chunks.length,
      })
    }

    if (dryRun) {
      report.transactions += chunks.length
      continue
    }

    // Chunking splits a large migration into several transactions, which means
    // several undo steps rather than one. That is the honest trade: the
    // alternative is refusing to migrate documents over a size, and a CMS that
    // cannot migrate its biggest pages is not much use.
    let rejected: string | null = null
    let committed = 0
    for (const [i, part] of chunks.entries()) {
      // A fresh txId per chunk, deliberately *not* derived from the migration
      // id. A deterministic id would let two concurrent runs collide: run B
      // reads a document run A has partly migrated, computes a shorter chunk 0,
      // and the log's dedupe would answer it with A's delta — B would believe
      // its own (different) mutations had landed. Value-idempotence is the real
      // protection here (checkpoint 2), so the same `set` applied twice is
      // simply the same `set`. Dedupe stays what it is for: a resend.
      const result = await deps.stub(story.id).commit(part, actor)
      if ('rejected' in result) {
        rejected = `chunk ${i + 1}/${chunks.length}: ${result.rejected}`
        break
      }
      committed++
    }
    report.transactions += committed

    if (rejected !== null) {
      // Nothing partial landed *within* a chunk — `commit` is atomic — but an
      // earlier chunk of the same document may have. The watermark is
      // deliberately not stamped, so the next run recomputes from wherever this
      // one got to and finishes the job.
      report.failed.push({ storyId: story.id, reason: rejected })
      continue
    }

    // One statement, so the migrated snapshot and the watermark that claims it
    // can never land separately.
    await stampSchemaStatement(
      db,
      story.id,
      latestId,
      publishedResult.mutations.length > 0
        ? applyAll(publishedDoc!, publishedResult.mutations)
        : undefined,
    ).run()
    if (publishedResult.mutations.length > 0) republished.push(story.id)
  }

  // A short batch means the sweep reached the end of the table.
  report.continueFrom = rows.length === size ? (rows[rows.length - 1]?.story.id ?? null) : null
  // Asked directly rather than accumulated: right however many calls this run
  // took, and right across two runs that overlapped.
  report.behind = await countBehind(db, latestId)
  report.complete = report.behind === 0

  // The ledger is written when the sweep is done and nothing is behind, not
  // per batch: a row here means "this migration has reached every document",
  // which is the only claim worth recording. A dry run writes nothing at all.
  if (!dryRun && report.continueFrom === null && report.complete && pending.length > 0) {
    await writeLedger(db, pending, report, opts.actor ?? null)
  }

  // After every write this batch makes, like every other lifecycle hook. A dry
  // run rewrote nothing, so it fires nothing; a batch that changed no published
  // document has an empty set and fires nothing either, rather than an event
  // whose only honest reading is "nothing happened".
  if (!dryRun && republished.length > 0) {
    await deps.hooks?.run('migrated', {
      ids: republished,
      migrations: pending,
      actor: opts.actor ?? null,
    })
  }

  return report
}

/** `insert or replace`, so a re-run refreshes the counts and clears `failed`. */
async function writeLedger(
  db: D1Database,
  ids: readonly string[],
  report: MigrateReport,
  actor: string | null,
): Promise<void> {
  const at = Date.now()
  const failed = report.failed.length > 0 ? JSON.stringify(report.failed) : null
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          `insert into schema_migrations
             (id, applied_at, actor, stories_seen, stories_changed, mutations, failed)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set
             applied_at = excluded.applied_at, actor = excluded.actor,
             stories_seen = excluded.stories_seen, stories_changed = excluded.stories_changed,
             mutations = excluded.mutations, failed = excluded.failed`,
        )
        .bind(id, at, actor, report.stories, report.changed, report.mutations, failed),
    ),
  )
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What `GET {base}/migrations` answers. */
export interface MigrationStatus {
  /** Every configured migration, in run order, with whether it has been applied. */
  migrations: { id: string; description: string; applied: boolean }[]
  /** Ids not yet recorded in `schema_migrations`, in run order. */
  pending: string[]
  /** Documents whose own `schema_id` is behind the last configured migration. */
  behind: number
  /**
   * The story `?story=` named, when it was given: whether *that* document is
   * behind, and which migrations it is missing. This is what the editor's banner
   * reads — a per-document answer, because `schema_migrations` is per-migration
   * and would say "nothing pending" while this one page was still behind.
   */
  story?: {
    id: string
    schemaId: string | null
    behind: boolean
    pending: { id: string; description: string }[]
  }
}

export async function migrationStatus(
  db: D1Database,
  migrations: readonly Migration[],
  storyId?: string,
): Promise<MigrationStatus> {
  const applied = new Set(await appliedMigrations(db))
  const latestId = migrations.length > 0 ? migrations[migrations.length - 1]!.id : null

  const status: MigrationStatus = {
    migrations: migrations.map((m) => ({
      id: m.id,
      description: m.description,
      applied: applied.has(m.id),
    })),
    pending: migrations.filter((m) => !applied.has(m.id)).map((m) => m.id),
    behind: latestId === null ? 0 : await countBehind(db, latestId),
  }

  if (storyId !== undefined) {
    const row = await db
      .prepare('select schema_id as schemaId from stories where id = ?')
      .bind(storyId)
      .first<{ schemaId: string | null }>()
    // A story that does not exist is reported as up to date rather than 404: the
    // banner is an explanation, and refusing the whole request over an id the
    // editor is closing anyway would surface as an error toast.
    const schemaId = row?.schemaId ?? null
    const due = row ? pendingFor(schemaId, migrations) : []
    status.story = {
      id: storyId,
      schemaId,
      behind: due.length > 0,
      pending: due.map((m) => ({ id: m.id, description: m.description })),
    }
  }

  return status
}
