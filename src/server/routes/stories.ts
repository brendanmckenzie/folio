/**
 * The content tree: CRUD over stories, the draft a `reference` field resolves
 * against, and publishing.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { cloneDoc } from '../../core/clone'
import type { StoryMeta } from '../../core/story'
import { rethrow } from '../errors'
import type { HookRunnerCtx } from '../hooks'
import { loadStory } from '../middleware'
import { publish, unpublish } from '../publish'
import type { FolioRuntime } from '../runtime'
import {
  createStory,
  deleteStoryStatement,
  duplicateStory,
  storyTree,
  updateStoryStatement,
} from '../stories'
import type { FolioEnv } from '../types'
import {
  actorHeader,
  idParam,
  parseBody,
  parseOptionalBody,
  StoryCreateBody,
  StoryDuplicateBody,
  StoryPatchBody,
} from '../validate'
import { deleteVersionsStatement } from '../versions'

/** `c.env` and a `waitUntil` built from `c.executionCtx`, the two things
 * every hook-firing route needs alongside `rt.publishDeps`
 * (`../../../docs/specs/platform/publish-hooks.md` decision 3). */
function hookCtx<Env>(c: Context<FolioEnv<Env>>): HookRunnerCtx {
  return { env: c.env, waitUntil: (p) => c.executionCtx.waitUntil(p) }
}

export function storyRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  app.get('/stories', async (c) => c.json(rt.decorate(await storyTree(c.var.bindings().db))))

  app.post('/stories', async (c) => {
    const body = await parseBody(c.req, StoryCreateBody)
    const bindings = c.var.bindings()

    let story: StoryMeta
    try {
      story = await createStory(bindings.db, body)
    } catch (e) {
      // `Unknown parent` is the client's mistake; a path collision is a
      // conflict; a D1 failure is nobody's business but the log's.
      rethrow(e)
    }

    const actor = actorHeader(c.req.header('x-folio-actor'))
    await rt.publishDeps(bindings, hookCtx(c)).hooks?.run('created', { story, actor })

    return c.json(rt.withUrls(story))
  })

  app.patch('/stories/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseBody(c.req, StoryPatchBody)
    const bindings = c.var.bindings()

    let next: StoryMeta
    let changes: { id: string; from: string; to: string }[]
    try {
      const result = await updateStoryStatement(bindings.db, id, body)
      next = result.next
      changes = result.changes
      if (result.statements.length) await bindings.db.batch(result.statements)
    } catch (e) {
      rethrow(e)
    }

    // Nothing renamed or moved (a plain title edit, say) has no old path for
    // a host to purge, so `pathsChanged` stays silent rather than firing an
    // empty `changes` array.
    if (changes.length) {
      const actor = actorHeader(c.req.header('x-folio-actor'))
      await rt.publishDeps(bindings, hookCtx(c)).hooks?.run('pathsChanged', { changes, actor })
    }

    return c.json(rt.withUrls(next))
  })

  /**
   * Duplicate a document (`duplicate-and-paste.md`). Row first, seed second
   * (architecture decision 4): if `duplicateStory`'s insert fails, nothing
   * else has happened; if the DO seed after it fails, the result is a story
   * row with a blank document — a state this system already understands (a
   * page someone created and never filled in), not an orphaned Durable
   * Object. The *draft* is cloned, not the published snapshot: an editor
   * duplicating a page means "give me what I am looking at" (decision 4's
   * sibling on version history — the copy starts with none of its own).
   *
   * No singleton refusal yet: that lands with
   * `../foundation/document-types.md`, which is what makes "singleton"
   * mean anything at all.
   */
  app.post('/stories/:id/duplicate', loadStory<Env>(), async (c) => {
    const bindings = c.var.bindings()
    const source = c.var.story
    const body = await parseOptionalBody(c.req, StoryDuplicateBody)

    let created: Awaited<ReturnType<typeof duplicateStory>>
    try {
      created = await duplicateStory(bindings.db, source.id, body)
    } catch (e) {
      rethrow(e)
    }

    // Fired the moment the row exists, same as a plain create: the D1 insert
    // already committed, and a story with no draft seeded yet is a state this
    // system already understands (a page someone created and never filled in).
    const actor = actorHeader(c.req.header('x-folio-actor'))
    await rt.publishDeps(bindings, hookCtx(c)).hooks?.run('created', { story: created, actor })

    const draft = await rt.draftFor(bindings, source)
    await rt.stub(bindings, created.id).getOrInit(cloneDoc(draft))

    return c.json({ story: rt.withUrls(created) }, 201)
  })

  app.delete('/stories/:id', async (c) => {
    const bindings = c.var.bindings()
    const target = idParam('id', c.req.param('id'))
    // redirects.md's architecture decision 4: checked by default in the admin's
    // confirmation, an escape hatch for a page that should genuinely 404.
    const redirect = c.req.query('redirect') !== 'false'

    let found: Awaited<ReturnType<typeof deleteStoryStatement>>
    try {
      found = await deleteStoryStatement(bindings.db, target, { redirect })
      if (!found) return c.json({ deleted: [] })

      // One batch for the story rows, their version history and (optionally)
      // the redirect to the parent: all three disappear or land together, so a
      // reader never finds versions for a story that is already gone, or a
      // redirect for a delete that never actually committed.
      const versions = deleteVersionsStatement(bindings.db, found.ids)
      await bindings.db.batch([
        found.statement,
        ...found.redirectStatements,
        ...(versions ? [versions] : []),
      ])
    } catch (e) {
      // Nothing has committed yet at this point, so reporting a failure here
      // is accurate. `Cannot delete the root story` is a conflict; a failed
      // batch is internal.
      rethrow(e)
    }

    // The Durable Object is purged only once that batch has committed.
    // Purging first and then failing the D1 write would leave this id
    // deletable-again while its object already has a blank doc — the
    // opposite of the bug this guards against, but a data-loss bug all the
    // same. Purging after means a crash between the two leaves an orphaned
    // object rather than a resurrected one, which is the safer side to fail on.
    //
    // This runs outside the try/catch above on purpose: the D1 rows are
    // already gone by now, so a purge failure must never be reported back as
    // a failed delete — the caller already got what it asked for. It is
    // best-effort cleanup of an object that a reused id would otherwise
    // resurrect from; an object left un-purged here still cannot be reached
    // under this id (D1 no longer has it), only under a *reused* one, which is
    // the narrow, already-documented window above.
    await Promise.all(
      found.ids.map((id) =>
        rt
          .stub(bindings, id)
          .purge()
          .catch(() => {}),
      ),
    )

    // Fires even if a purge above failed: the rows are gone regardless, and a
    // host's cache must be purged regardless (`publish-hooks.md`'s edge case
    // "partial success in the delete path"). The purge failure is swallowed
    // above, as it already was before this hook existed.
    const actor = actorHeader(c.req.header('x-folio-actor'))
    await rt
      .publishDeps(bindings, hookCtx(c))
      .hooks?.run('deleted', { ids: found.ids, paths: found.paths, actor })

    return c.json({ deleted: found.ids })
  })

  /**
   * A translation layer over publish.ts and nothing more: both inputs are checked
   * before any work happens — neither the Durable Object nor D1 should be touched
   * on a request that cannot land — and the story's own existence is the
   * workflow's to check, because a scheduled publish has to check it too.
   */
  app.post('/story/:id/publish', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const actor = actorHeader(c.req.header('x-folio-actor'))

    const { publishedAt, publishedSyncId, version } = await publish(
      rt.publishDeps(c.var.bindings(), hookCtx(c)),
      id,
      actor,
    )
    return c.json({ ok: true, publishedAt, publishedSyncId, version })
  })

  /**
   * Clears the published snapshot. `loadStory` runs first so an unknown id
   * 404s before `unpublish` does anything, and hands the row it already found
   * straight to the workflow instead of a second lookup by id.
   */
  app.post('/story/:id/unpublish', loadStory<Env>(), async (c) => {
    const actor = actorHeader(c.req.header('x-folio-actor'))
    const { unpublishedAt } = await unpublish(
      rt.publishDeps(c.var.bindings(), hookCtx(c)),
      c.var.story,
      actor,
    )
    return c.json({ ok: true, unpublishedAt })
  })

  /**
   * A story's live draft, for resolving a `reference` in the admin.
   *
   * The admin fetches this when the *set* of referenced ids changes, not per
   * render, and pushes the result into the preview with the resolution. The
   * preview re-renders on every keystroke and must never reach the network.
   */
  app.get('/story/:id/document', loadStory<Env>(), async (c) =>
    c.json({ doc: await rt.draftFor(c.var.bindings(), c.var.story) }),
  )

  return app
}
