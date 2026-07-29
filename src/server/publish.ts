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
import type { StoryMeta } from '../core/story'
import { FolioError } from './errors'
import { publishStoryStatement, storyById, unpublishStoryStatement } from './stories'
import { buildVersionWrite, type VersionMeta, writeVersion } from './versions'

export interface PublishDeps {
  db: D1Database
  /**
   * The story's live draft, created from its row on first touch. Passed in rather
   * than reached for: the draft lives in a Durable Object, and which object that
   * is only the caller's bindings can say.
   */
  draft: (story: StoryMeta) => Promise<Doc>
}

export interface PublishResult {
  publishedAt: number
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

  const doc = await deps.draft(meta)
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
    fallbackTitle: meta.title,
  })
  const { publishedAt, statement: publishStatement } = publishStoryStatement(
    deps.db,
    storyId,
    doc,
    meta.title,
  )
  await deps.db.batch([versionStatement, publishStatement])

  return { publishedAt, version }
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

  if (meta.publishedAt === null && meta.unpublishedAt !== null) {
    return { unpublishedAt: meta.unpublishedAt }
  }

  const { unpublishedAt, statement } = unpublishStoryStatement(deps.db, meta.id, actor)
  await statement.run()
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

  return writeVersion(deps.db, {
    storyId: meta.id,
    kind: 'checkpoint',
    doc: await deps.draft(meta),
    label: input.label ?? null,
    actor: input.actor ?? null,
    fallbackTitle: meta.title,
  })
}
