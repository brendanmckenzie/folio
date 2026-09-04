/**
 * Duplicating, moving and deleting a document, as functions rather than as routes —
 * the sibling of `publish.ts`, and written for the reason its header gives: a caller
 * with no `Request` has to be able to reach the identical workflow.
 *
 * **These three were inline in their routes, twice each.** `routes/stories.ts` (the
 * admin) and `routes/api/documents.ts` (the versioned content API) each held their
 * own copy of the delete batch, the purge-after-commit ordering and the two patch
 * hooks; the API's copy even carries a comment saying "reimplementing either would
 * mean two orderings to keep right", above a reimplementation of both. Bulk writes
 * (`../../docs/specs/platform/bulk-writes.md`) would have been a third copy, and a
 * third copy is where `deleteStoryStatement`'s five statement arrays start getting
 * batched in four places and only three of them remember the schedules.
 *
 * So there is one of each here, and the routes are translation layers over them:
 * input validation, the status code, and the response shape. What each route keeps is
 * its own answer to *absence* — the admin's delete answers `{ deleted: [] }` for an id
 * that is already gone and the API's 404s — which is why `deleteDocument` returns
 * `null` rather than choosing for them.
 *
 * Every hook these fire is fired here, not at the call site. That is the property that
 * makes a bulk delete purge a host's cache exactly as a single delete does
 * (`../platform/caching.md`), and a host hook unable to tell which door a write came
 * through (`../platform/publish-hooks.md`).
 */
import { cloneDoc } from '../core/clone'
import type { Doc } from '../core/doc'
import type { DocumentType } from '../core/schema'
import type { StoryMeta } from '../core/story'
import type { HookRunner } from './hooks'
import {
  deleteStoryStatement,
  duplicateStory,
  type StoryPatch,
  updateStoryStatement,
} from './stories'
import type { StoryStub } from './types'
import { deleteVersionsStatement } from './versions'
import type { FolioDb } from './db'

/**
 * What these three need, assembled from bindings alone — no Request, no Hono, no
 * `Env`. The same discipline `PublishDeps` and `MigrateDeps` follow, and
 * `BulkDeps` (`bulk.ts`) is this plus `PublishDeps` so one job can do all five
 * actions.
 */
export interface DocumentDeps<Env = unknown> {
  db: FolioDb
  /** Declared types. Load-bearing rather than incidental: it is what says a
   * document is a singleton, and both duplicating and deleting one is refused. */
  types: readonly DocumentType[]
  /** The story's Durable Object — a duplicate seeds one, a delete purges one. */
  stub: (id: string) => StoryStub
  /** The story's live draft, created from its row on first touch. */
  draft: (story: StoryMeta) => Promise<Doc>
  /** Fires the after-commit lifecycle hooks. Absent only in tests that exercise a
   * workflow with no `createRuntime` behind it. */
  hooks?: HookRunner<Env>
}

/**
 * Copy a document (`../../docs/specs/editing/duplicate-and-paste.md`).
 *
 * **Row first, document second** (that spec's decision 4): if the insert fails
 * nothing else has happened, and if the Durable Object seed after it fails the result
 * is a story row with a blank document — a state this system already understands (a
 * page somebody created and never filled in), rather than an orphaned object.
 *
 * The **draft** is cloned, not the published snapshot: an editor duplicating a page
 * means "give me what I am looking at". A singleton is refused inside
 * `duplicateStory` rather than here, so a direct caller cannot route around it.
 */
export async function duplicateDocument<Env>(
  deps: DocumentDeps<Env>,
  source: StoryMeta,
  patch: { title?: string; parentId?: string | null },
  actor: string | null,
): Promise<StoryMeta> {
  const created = await duplicateStory(deps.db, source.id, patch, deps.types)

  // Fired the moment the row exists, same as a plain create: the D1 insert has
  // already committed, and the seed below cannot un-commit it.
  await deps.hooks?.run('created', { story: created, actor })

  const draft = await deps.draft(source)
  await deps.stub(created.id).getOrInit(cloneDoc(draft))

  return created
}

/**
 * Rename, reslug, reparent or reorder a document — and write the redirects that fall
 * out of it (`../platform/redirects.md` decision 1).
 *
 * `updateStoryStatement` owns every rule that applies: the root's fixed slug, the
 * cycle check, `under` constraints, fractional indices, unique slugs among siblings,
 * and the whole affected subtree's recomputed paths. This runs its statements and
 * fires the two hooks that describe what happened.
 *
 * Both hooks, and they are not alternatives. `pathsChanged` is what a host purges a
 * vacated URL with, and stays silent for a title-only patch because nothing was
 * vacated; `updated` fires for exactly that case, because a title change alters
 * `StoryRef.title` on every page that links here (`../platform/caching.md`). A rename
 * fires both, which is correct — they describe different facts about one write.
 *
 * `changes` comes back alongside the row for the reason `updateStoryStatement` computes
 * it in the first place: which paths this move vacated is gone the moment the statements
 * run, so a caller that wanted it would have to recompute a "before" that no longer
 * exists. No route reads it today; the hook does.
 */
export async function moveDocument<Env>(
  deps: DocumentDeps<Env>,
  id: string,
  patch: StoryPatch,
  actor: string | null,
): Promise<{ next: StoryMeta; changes: { id: string; from: string; to: string }[] }> {
  const { next, statements, changes, updated } = await updateStoryStatement(
    deps.db,
    id,
    patch,
    deps.types,
  )
  if (statements.length) await deps.db.batch(statements)

  if (changes.length) await deps.hooks?.run('pathsChanged', { changes, actor })
  if (updated.length) await deps.hooks?.run('updated', { story: next, changed: updated, actor })

  return { next, changes }
}

/**
 * Delete a document, its descendants, their versions, their query-index rows, their
 * pending schedules and (by default) the redirects to its parent.
 *
 * `null` for an id nothing is behind, so each caller keeps its own answer to absence.
 *
 * **One batch, then the purge, then the hook**, and the order of those three is the
 * whole of what this function is:
 *
 * - *One batch* so a reader never finds versions for a story that is gone, a
 *   collection that still lists it, a schedule due to publish it next Tuesday, or a
 *   redirect for a delete that never committed.
 * - *The purge second*, because purging first and then failing the D1 write would
 *   leave the id deletable-again while its object already held a blank document.
 *   Failing the other way leaves an orphaned object, which is the safer side: it is
 *   unreachable under this id, only under a *reused* one.
 * - *The hook regardless of the purge*, because the rows are gone either way and a
 *   host's cache must be purged either way (`../platform/publish-hooks.md`'s edge
 *   case "partial success in the delete path").
 */
export async function deleteDocument<Env>(
  deps: DocumentDeps<Env>,
  id: string,
  opts: { redirect?: boolean },
  actor: string | null,
): Promise<{ deleted: string[]; paths: (string | null)[]; types: string[] } | null> {
  const found = await deleteStoryStatement(deps.db, id, { redirect: opts.redirect }, deps.types)
  if (!found) return null

  const versions = deleteVersionsStatement(deps.db, found.ids)
  await deps.db.batch([
    found.statement,
    ...found.redirectStatements,
    ...found.indexStatements,
    ...found.scheduleStatements,
    ...(versions ? [versions] : []),
  ])

  // Best-effort, and deliberately outside any caller's try/catch: the rows are
  // already gone, so a purge failure must never be reported back as a failed
  // delete — the caller got what it asked for.
  await Promise.all(
    found.ids.map((descendant) =>
      deps
        .stub(descendant)
        .purge()
        .catch(() => {}),
    ),
  )

  await deps.hooks?.run('deleted', {
    ids: found.ids,
    paths: found.paths,
    types: found.types,
    actor,
  })

  return { deleted: found.ids, paths: found.paths, types: found.types }
}
