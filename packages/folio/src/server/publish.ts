/**
 * Publishing and checkpointing, as functions rather than as routes.
 *
 * Neither takes a Request, a Context or an `Env`: scheduled publishing (a Durable
 * Object alarm, next on the roadmap) has none of those to offer — a cron cannot
 * fake a request — so the workflow is written against D1 and the story's live
 * draft alone. The HTTP routes are a translation layer over these two functions
 * and hold nothing but input validation and the response shape.
 */
import type { Doc } from '../core/doc'
import { draftState, type StoryMeta } from '../core/story'
import { FolioError } from './errors'
import type { HookRunner } from './hooks'
import { publishStoryStatement, storyById, unpublishStoryStatement } from './stories'
import { buildVersionWrite, type VersionMeta, writeVersion } from './versions'

export interface PublishDeps<Env = unknown> {
  db: D1Database
  /**
   * The story's live draft, created from its row on first touch. Passed in rather
   * than reached for: the draft lives in a Durable Object, and which object that
   * is only the caller's bindings can say.
   */
  draft: (story: StoryMeta) => Promise<Doc>
  /**
   * The draft plus the Durable Object's log position it was read at, together —
   * `publish()`'s own read. Two separate calls (`draft`, then a `head()`) are not
   * atomic across the object's request boundary: a transaction landing between
   * them could leave `published_sync_id` ahead of the bytes actually snapshotted,
   * silently hiding a real change (`unpublished-changes.md`'s publish-race
   * acceptance criterion; see `story-do.ts`'s `getOrInitWithSyncId`).
   * `checkpoint` has no need of the position, so it keeps using `draft` alone.
   */
  draftWithSyncId: (story: StoryMeta) => Promise<{ doc: Doc; syncId: number }>
  /**
   * The document's display title, per its own document type's `titleField`
   * (`document-types.md` architecture decision 3). Injected rather than computed
   * here for the same reason `draft` is: resolving it needs the block schema and
   * the `types` config, which only `createRuntime` has. Required, with no
   * default, because a silently-wrong cached title is exactly the bug this
   * replaced.
   */
  titleFor: (story: StoryMeta, doc: Doc) => string
  /**
   * Fires the after-commit lifecycle hooks (`publish-hooks.md`). Absent only in
   * tests that exercise a workflow directly with no `createRuntime` behind it —
   * every real caller gets one from `FolioRuntime.publishDeps`.
   */
  hooks?: HookRunner<Env>
}

export interface PublishResult {
  publishedAt: number
  /** The Durable Object log position that was actually snapshotted; see `draftWithSyncId`. */
  publishedSyncId: number
  version: VersionMeta
}

/**
 * The story a workflow acts on: its id, or the row itself when the caller has
 * already loaded it.
 *
 * An alarm only ever has the id, which is why the workflows look the row up at
 * all. A route that has to answer 404 *before* it does anything else — reading
 * the request body included — has to have looked it up already, and passing the
 * row it found is what keeps that from being a second query for the same row.
 */
export type StorySelector = string | StoryMeta

async function requireStory(db: D1Database, ref: StorySelector): Promise<StoryMeta> {
  if (typeof ref !== 'string') return ref
  const meta = await storyById(db, ref)
  if (!meta) throw new FolioError('not_found', 'Unknown story')
  return meta
}

export async function publish(
  deps: PublishDeps,
  story: StorySelector,
  actor: string | null,
): Promise<PublishResult> {
  const meta = await requireStory(deps.db, story)
  const storyId = meta.id

  // `doc` and `syncId` come from one atomic read: see `draftWithSyncId`'s own
  // doc for why two separate calls would race.
  const { doc, syncId } = await deps.draftWithSyncId(meta)
  // Resolved once and used for both writes, so the cached tree title and the
  // retained version's title can never disagree about what the document is
  // called (`document-types.md`'s acceptance criterion "Titles come from the
  // type").
  const resolvedTitle = deps.titleFor(meta, doc)
  // Every publish is a retained version, so "restore what was live before" is
  // always possible. The version row and the stories.published_doc update
  // land in one batch: run separately, a failure between the two could leave
  // a retained version nothing points at, or a live page with no version to
  // restore it from — the two are no longer allowed to disagree.
  const { meta: version, statement: versionStatement } = buildVersionWrite(deps.db, {
    storyId,
    kind: 'publish',
    doc,
    actor,
    title: resolvedTitle,
    // The story's *own* watermark, not the latest configured migration
    // (`schema-migrations.md`). The bytes going into this row are the draft as it
    // stands, so a version of a page that has not been migrated yet must say so —
    // otherwise `getVersion` would hand it back unmigrated while claiming it was
    // current, and a restore from it would reintroduce pre-migration keys.
    schemaId: meta.schemaId ?? null,
  })
  const {
    publishedAt,
    title,
    statement: publishStatement,
  } = publishStoryStatement(deps.db, storyId, doc, resolvedTitle, syncId)
  await deps.db.batch([versionStatement, publishStatement])

  // Built from `meta` plus the writes just committed, rather than re-read: the
  // batch above is the only truth this function needs, and re-querying D1
  // for a row this function just wrote would be a second read of the same
  // fact for no reason (`publish-hooks.md`'s after-commit hook is the only
  // consumer, and waitUntil already keeps it off the response's critical path).
  const state = draftState(publishedAt, null, meta.draftSyncId, syncId)
  const publishedMeta: StoryMeta = {
    ...meta,
    title,
    publishedAt,
    unpublishedAt: null,
    publishedSyncId: syncId,
    updatedAt: publishedAt,
    state,
    hasUnpublishedChanges: state === 'changed',
  }
  await deps.hooks?.run('published', { story: publishedMeta, doc, version, publishedAt, actor })

  return { publishedAt, publishedSyncId: syncId, version }
}

/**
 * Clears the published snapshot. Unlike `publish` and `checkpoint`, this never
 * reads `deps.draft`: it does not touch the draft, the Durable Object, or
 * versions at all — an unpublish is not a document snapshot, just the row
 * saying the site should no longer serve one (`unpublish.md`).
 *
 * Idempotent: unpublishing something already unpublished (`publishedAt` null,
 * `unpublishedAt` set) answers with the existing timestamp and performs no
 * write, rather than stamping a new one — taking a page down is exactly the
 * kind of action someone double-clicks.
 */
export async function unpublish(
  deps: PublishDeps,
  story: StorySelector,
  actor: string | null,
): Promise<{ unpublishedAt: number }> {
  const meta = await requireStory(deps.db, story)

  // Idempotent, and deliberately silent about it: nothing was written, so
  // there is no commit for an after-commit hook to fire about either.
  if (meta.publishedAt === null && meta.unpublishedAt !== null) {
    return { unpublishedAt: meta.unpublishedAt }
  }

  const { unpublishedAt, statement } = unpublishStoryStatement(deps.db, meta.id, actor)
  await statement.run()

  const updated: StoryMeta = {
    ...meta,
    publishedAt: null,
    unpublishedAt,
    updatedAt: unpublishedAt,
    state: 'unpublished',
    hasUnpublishedChanges: false,
  }
  await deps.hooks?.run('unpublished', { story: updated, actor })

  return { unpublishedAt }
}

/**
 * A named version of the draft as it stands, written on its own: a checkpoint
 * changes nothing about what is live, so there is no second write for it to have
 * to land atomically with.
 */
export async function checkpoint(
  deps: PublishDeps,
  story: StorySelector,
  input: { label?: string | null; actor?: string | null },
): Promise<VersionMeta> {
  const meta = await requireStory(deps.db, story)
  const actor = input.actor ?? null
  const doc = await deps.draft(meta)

  const version = await writeVersion(deps.db, {
    storyId: meta.id,
    kind: 'checkpoint',
    doc,
    label: input.label ?? null,
    actor,
    title: deps.titleFor(meta, doc),
    // Same as publish: the shape of the document this row holds, not the shape
    // the code currently wants.
    schemaId: meta.schemaId ?? null,
  })
  await deps.hooks?.run('checkpointed', { story: meta, version, actor })

  return version
}
