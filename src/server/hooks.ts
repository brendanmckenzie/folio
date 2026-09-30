/**
 * The after-commit extension point: a typed callback per lifecycle event, run
 * once a write has already landed (`publish-hooks.md`).
 *
 * Deliberately not a webhook system — no secret, no retry queue, no delivery
 * log. A hook is a function the host wrote, running in the host's own Worker,
 * with the host's own bindings (`config.bindings`). It reaches D1, R2, a
 * Queue, whatever `env` already offers; this file only decides *when* it runs
 * and *what happens if it throws*.
 *
 * Nothing here knows about Hono or a Request, matching `publish.ts`'s own
 * rule: a Durable Object alarm (no `ExecutionContext`) has to be able to fire
 * these too (see `runtime.ts`'s `alarmHookCtx`).
 */
import type { Doc } from '../core/doc'
import { DEFAULT_SITE, type GroupRef, type SiteRef } from '../core/sites'
import type { StoryMeta } from '../core/story'
import type { PurgeIssued } from './cache-purge'
import type { FormResponse, SubmittedFile } from './form-responses'
import type { FormMeta } from './forms'
import type { FolioLogger } from './types'
import type { VersionMeta } from './versions'

export type HookEvent =
  | 'published'
  | 'unpublished'
  | 'pathsChanged'
  | 'created'
  | 'deleted'
  | 'checkpointed'
  | 'updated'
  | 'migrated'
  | 'reindexed'
  | 'redirectsChanged'
  | 'formChanged'
  | 'submitted'
  | 'siteChanged'

/**
 * The same list at runtime, for `validateHooks`. A name must appear in both or
 * it is either a hook nobody can configure (missing from the type) or one
 * `createFolio` refuses at construction (missing from here) — pinned by
 * `every event in the type is a key validateHooks accepts` in
 * `test/unit/server/pure.test.ts`.
 */
const HOOK_EVENTS: readonly HookEvent[] = [
  'published',
  'unpublished',
  'pathsChanged',
  'created',
  'deleted',
  'checkpointed',
  'updated',
  'migrated',
  'reindexed',
  'redirectsChanged',
  'formChanged',
  'submitted',
  'siteChanged',
]

/** Every hook payload's common shape. Nothing else is injected: a hook that
 * wants D1 or R2 uses `config.bindings(env)`, the same accessor the host
 * already wrote for every other route. */
export interface HookBase<Env> {
  env: Env
  waitUntil: (p: Promise<unknown>) => void
  actor: string | null
  /**
   * The scope that owns what changed (`../../docs/specs/foundation/multi-site.md`
   * decision 16): the site, group or `shared` a story, form or redirect belongs to,
   * `default` on a deployment with no `sites`, and the changed registry row's own
   * id for `siteChanged`. **Null for the two events that are about the whole
   * deployment** (`migrated`, `reindexed`), which touch every scope's rows.
   *
   * Set by the runner from the payload it is given, so an emitter that omits it
   * cannot leave it out: a story's own `site`, else `default`.
   */
  site: string | null
  /**
   * The brand of `site` (`../../docs/specs/foundation/multi-brand.md` decision 16):
   * what lets `hooks.submitted` send one brand's enquiry email and another's Jambo
   * forward. **Null on a deployment with no `brands`**, and for an event about the
   * whole deployment. `migrated` and `reindexed` run per brand, so each carries the
   * brand it ran for.
   *
   * Set by the runner from the brand it was made for, never from the payload, so an
   * emitter cannot leave it out or name another brand's.
   */
  brand: string | null
  /**
   * Exactly what Folio's own purger asked Workers Cache for, when this event made
   * it purge anything (decision 16): the tags, or a flush. A purge reaches only the
   * entrypoint that issues it, so a headless host whose front end caches on its own
   * entrypoint forwards this there instead of recomputing it.
   *
   * **Filled in by the runner from the internal hook's own return value**, so it
   * cannot drift from what was issued. Absent for an event that purged nothing
   * (`created`, `checkpointed`, a redirect change on a single-site deployment, a
   * non-title `updated`). Set before a host hook runs, never before an internal
   * one.
   */
  purge?: PurgeIssued
}

export interface PublishedHookPayload<Env> extends HookBase<Env> {
  story: StoryMeta
  doc: Doc
  version: VersionMeta
  publishedAt: number
}

export interface UnpublishedHookPayload<Env> extends HookBase<Env> {
  story: StoryMeta
}

export interface PathsChangedHookPayload<Env> extends HookBase<Env> {
  changes: { id: string; from: string; to: string }[]
}

export interface CreatedHookPayload<Env> extends HookBase<Env> {
  story: StoryMeta
}

export interface DeletedHookPayload<Env> extends HookBase<Env> {
  ids: string[]
  /** `ids`' own paths, same order. `null` for an unrouted document
   * (`document-types.md`), which never had a URL for a cache to hold. */
  paths: (string | null)[]
  /**
   * `ids`' own document types, same order. Here for the same reason `paths` is:
   * the rows are gone by the time anything could look them up again, and a
   * deleted document leaves every collection over its type
   * (`../../docs/specs/platform/caching.md`) — so a consumer that has to invalidate an index
   * page needs the type and has no second chance to read it.
   */
  types: string[]
}

export interface CheckpointedHookPayload<Env> extends HookBase<Env> {
  story: StoryMeta
  version: VersionMeta
}

/**
 * A field of the story *row* — its title and its place in the tree — that a
 * patch actually changed. Not content: a page's own title lives on its root
 * block and travels through the mutation log.
 */
export type StoryChange = 'title' | 'slug' | 'parent' | 'ord'

export interface UpdatedHookPayload<Env> extends HookBase<Env> {
  story: StoryMeta
  /**
   * What the patch changed, at least one entry — `updated` does not fire for a
   * patch that changed nothing.
   *
   * The event exists because of the gap `caching.md`'s ground truth found:
   * `pathsChanged` is gated on a path actually moving, so a **title-only**
   * patch writes `stories.title`, alters `StoryRef.title` on every page that
   * links to this one, and fires nothing at all. `slug`/`parent` usually come
   * with a `pathsChanged` as well; on an unrouted document (no path to move)
   * they arrive here alone.
   */
  changed: StoryChange[]
}

export interface MigratedHookPayload<Env> extends HookBase<Env> {
  /**
   * The documents whose **published snapshot** this batch rewrote — not every
   * document it touched. A draft-only migration changes no bytes a reader can
   * see. `runMigrations` is batched and resumable, so this fires once per call
   * with that call's ids, not once for the whole run.
   */
  ids: string[]
  /** The migration ids the run is applying, in run order. */
  migrations: string[]
}

export interface ReindexedHookPayload<Env> extends HookBase<Env> {
  /** Documents reindexed in this batch. */
  count: number
}

export interface RedirectsChangedHookPayload<Env> extends HookBase<Env> {
  /** The source paths added or removed, normalised (no leading slash). */
  from: string[]
}

/**
 * A **structural** save on a form: a question added, removed, renamed, retyped,
 * made required, or its option values changed
 * (`../../docs/specs/content-model/forms.md` architecture decision 7). A label,
 * help, placeholder or translation edit fires nothing at all — `shapeOf` is what
 * decides, and `updateForm` is what asks it.
 *
 * `redirectsChanged`'s shape: an event for a write that changes published bytes
 * without publishing anything. Folio's own internal hook purges `form:<id>` off
 * it, which is the whole reason it is not enough to stamp a version — a page
 * cached for a week is still handing visitors markup for the old shape, and
 * every one of them would submit something the live form now refuses.
 */
export interface FormChangedHookPayload<Env> extends HookBase<Env> {
  form: FormMeta
  /** The version this save bumped to. Always present: the event does not fire
   *  for a save that did not bump one. */
  version: number
}

/**
 * Somebody filled in a form (`../../docs/specs/content-model/forms.md`
 * checkpoint 4). **The entire programmatic surface for responses**: there is no
 * `/api/v1` route and no MCP tool, deliberately (checkpoint 20), so this is how a
 * host forwards a lead to a CRM, posts it to Slack or emails it.
 *
 * Fires **after the row has committed**, and only for a row that was actually
 * written: a submission that filled the honeypot stores nothing and fires
 * nothing, and one that collapsed into an identical submission from thirty
 * seconds ago fires nothing either — a double-click that reached a CRM twice is
 * exactly what the collapse exists to prevent (decision 14).
 *
 * `actor` is **always null**, unlike every other event here. The route is
 * unauthenticated and the response is a stranger's; attributing it to whichever
 * editor happened to be signed in in that browser would be a lie about who filled
 * the form in.
 *
 * `runOne` swallows a throw with one logged line (`FolioConfig.logger`, default
 * `console`), as it does for every hook: the row is already committed and a
 * Slack outage must not turn a submission into a 500 for the person who made
 * it. `verify` is the opposite posture and runs before the write, which is
 * where a refusal belongs (decision 11).
 */
export interface SubmittedHookPayload<Env> extends HookBase<Env> {
  form: FormMeta
  response: FormResponse
  /** The files that came with it. Metadata only — a host that wants the bytes
   *  reads them back through `GET {base}/api/forms/:id/responses/:rid/file/:name`
   *  or holds the `media` binding. */
  files: readonly SubmittedFile[]
}

/**
 * A registry row changed (`multi-site.md` decisions 1 and 16): a site or group
 * created, edited (status, hosts, preview origin, group, name) or deleted. `site`
 * is the row's id, so a front end that keeps its own host map can refresh that one
 * entry on the event instead of on a timer.
 *
 * `purge` is the `site:<id>` purge Folio issued. The second one, 25 seconds later
 * (decision 4), is the same tag by construction and is not a separate event.
 */
export interface SiteChangedHookPayload<Env> extends HookBase<Env> {
  site: string
  kind: 'site' | 'group'
  change: 'created' | 'updated' | 'deleted'
  /** The row as it stands after the change, or null once it is deleted. */
  row: SiteRef | GroupRef | null
}

/** Every event's full payload, keyed by name — what `FolioHooks` hands a
 * handler and what `HookRunner.run` builds before calling one. */
export interface HookPayloadMap<Env> {
  published: PublishedHookPayload<Env>
  unpublished: UnpublishedHookPayload<Env>
  pathsChanged: PathsChangedHookPayload<Env>
  created: CreatedHookPayload<Env>
  deleted: DeletedHookPayload<Env>
  checkpointed: CheckpointedHookPayload<Env>
  updated: UpdatedHookPayload<Env>
  migrated: MigratedHookPayload<Env>
  reindexed: ReindexedHookPayload<Env>
  redirectsChanged: RedirectsChangedHookPayload<Env>
  formChanged: FormChangedHookPayload<Env>
  submitted: SubmittedHookPayload<Env>
  siteChanged: SiteChangedHookPayload<Env>
}

/**
 * Named keys rather than `on('published', fn)`: each event gets its own
 * payload type, a host's autocomplete lists what exists, and a typo is a
 * compile error instead of a handler that never fires (architecture
 * decision 1).
 */
export interface FolioHooks<Env> {
  published?: (e: PublishedHookPayload<Env>) => unknown
  unpublished?: (e: UnpublishedHookPayload<Env>) => unknown
  pathsChanged?: (e: PathsChangedHookPayload<Env>) => unknown
  created?: (e: CreatedHookPayload<Env>) => unknown
  deleted?: (e: DeletedHookPayload<Env>) => unknown
  checkpointed?: (e: CheckpointedHookPayload<Env>) => unknown
  /**
   * The four events `../../docs/specs/platform/caching.md` added, for write paths that change
   * published bytes and used to fire nothing at all. Each one is a way a cached
   * page can go stale without any other event noticing:
   *
   * - `updated` — a title-only patch, which `pathsChanged` skips by design
   * - `migrated` — `runMigrations` rewrites `published_doc` per story
   * - `reindexed` — `POST {base}/reindex` changes what every collection answers
   * - `redirectsChanged` — a manual redirect added or removed
   */
  updated?: (e: UpdatedHookPayload<Env>) => unknown
  migrated?: (e: MigratedHookPayload<Env>) => unknown
  reindexed?: (e: ReindexedHookPayload<Env>) => unknown
  redirectsChanged?: (e: RedirectsChangedHookPayload<Env>) => unknown
  /**
   * A form's *shape* changed (`../../docs/specs/content-model/forms.md`). Folio's
   * own internal hook already purges `form:<id>`; this is for a host with its own
   * work to hang off one — regenerating a static form, telling a CRM the columns
   * moved.
   */
  formChanged?: (e: FormChangedHookPayload<Env>) => unknown
  /**
   * A response arrived (`../../docs/specs/content-model/forms.md` checkpoint 4).
   * Folio always stores it; this is the sink a host forwards it to — a CRM, a
   * Slack channel, an email through whatever it already uses.
   *
   * There is no retry queue, no delivery log and no dead-letter queue behind it,
   * for this file's stated reason: the row has already committed, and a host that
   * needs durable delivery has a Queue binding and a row in D1 to read from.
   */
  submitted?: (e: SubmittedHookPayload<Env>) => unknown
  /**
   * A site or group in the registry was created, edited or deleted. Folio purges
   * `site:<id>` itself, now and again 25 seconds later; this is for a host that
   * keeps a front end's host map or cache of its own.
   */
  siteChanged?: (e: SiteChangedHookPayload<Env>) => unknown
  /** Events to await before responding. Everything else rides `waitUntil`. */
  await?: readonly HookEvent[]
}

/**
 * Throws naming the unknown key and listing the valid ones. Construction
 * time, alongside `validatePresets` (`field-defaults-and-presets.md`) — a
 * typo in `hooks` (or in `await` itself) is a config mistake that should
 * surface once, not a handler that silently never fires for six months.
 */
export function validateHooks<Env>(hooks: FolioHooks<Env> | undefined): void {
  if (!hooks) return
  const known = new Set<string>([...HOOK_EVENTS, 'await'])
  for (const key of Object.keys(hooks)) {
    if (!known.has(key)) {
      throw new Error(`folio: unknown hook "${key}" (valid: ${[...known].sort().join(', ')})`)
    }
  }
}

/**
 * What a caller must supply for one event: the payload minus what the runner
 * already knows (`env`, `waitUntil`) from its own `ctx`, and minus the two fields
 * it fills itself. `site` may be given (a form's, a redirect's, `null` for the
 * whole deployment); left out, it is the payload's `story.site`, else `default`.
 * `purge` is given only by an emitter that issued the purge itself.
 */
export type HookExtra<Env, E extends HookEvent> = Omit<
  HookPayloadMap<Env>[E],
  'env' | 'waitUntil' | 'site' | 'brand' | 'purge'
> & { site?: string | null; purge?: PurgeIssued }

export interface HookRunner<Env> {
  run<E extends HookEvent>(name: E, extra: HookExtra<Env, E>): Promise<void>
}

/** `env` plus the one thing every call site can offer, however differently
 * they offer it: `waitUntil`, native from `c.executionCtx` at an HTTP call
 * site, or the fallback `alarmHookCtx` builds for a Durable Object alarm. */
export interface HookRunnerCtx<Env = unknown> {
  env: Env
  waitUntil: (p: Promise<unknown>) => void
}

/**
 * Hooks Folio registers on itself, run before any host hook for the same
 * event (decision 5) — the seam `../../docs/specs/editing/live-collaboration.md`'s
 * space-channel broadcast hangs its own entry off, so there ends up being one
 * after-commit path rather than two conventions. A plain array of partial
 * `FolioHooks` literals: each internal consumer contributes its own object,
 * exactly as a host does, with no merge logic of its own to maintain. Empty
 * today — `createRuntime` (`runtime.ts`) owns the one array that exists.
 */
export type InternalHooks<Env> = readonly FolioHooks<Env>[]

/**
 * A hook function dispatched by event name rather than called directly: `E`
 * is only known at the call site inside `run` (a generic type parameter, not
 * a literal), so nothing short of a cast can tell the checker which member of
 * `FolioHooks`'s union it is about to invoke. The cast is confined to this one
 * function; `HookRunner<Env>.run`'s own signature stays fully typed for every
 * caller.
 */
async function runOne(
  name: HookEvent,
  fn: (payload: unknown) => unknown,
  payload: unknown,
  logger: FolioLogger = console,
): Promise<unknown> {
  try {
    return await fn(payload)
  } catch (err) {
    // The library's second observability hook after `app.onError`'s route
    // logging (errors.ts): one line, naming the event, and nothing else — a
    // Slack outage or a broken search index must never make publishing
    // impossible (decision 2). This swallow is correct and does not change;
    // only where the line goes does (`FolioConfig.logger`).
    logger.error(`folio: hook ${name} failed`, err)
    return undefined
  }
}

/** A return value that is a purge's record (`cache-purge.ts`'s `PurgeIssued`). */
function isPurgeIssued(value: unknown): value is PurgeIssued {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { tags?: unknown; everything?: unknown }
  return (
    v.everything === true || (Array.isArray(v.tags) && v.tags.every((t) => typeof t === 'string'))
  )
}

/** The scope the payload's own row belongs to: `extra.site` when the emitter named
 * one (`null` included), else the story's, else the one scope a single-site
 * deployment has. */
function siteOf(extra: { site?: string | null; story?: { site?: string } }): string | null {
  if (extra.site !== undefined) return extra.site
  return extra.story?.site ?? DEFAULT_SITE
}

/**
 * One runner for every publish workflow and every route that mutates a
 * story (decision 4). No hook configured for an event — host or internal —
 * costs nothing: `run` returns before a task promise is ever built.
 */
export function createHookRunner<Env>(
  hooks: FolioHooks<Env> | undefined,
  ctx: HookRunnerCtx<Env>,
  internal: InternalHooks<Env> = [],
  logger: FolioLogger = console,
  /** The brand every payload this runner builds carries; null with no `brands`. */
  brand: string | null = null,
): HookRunner<Env> {
  const awaited = new Set(hooks?.await ?? [])

  return {
    async run(name, extra) {
      const hostFn = hooks?.[name] as ((payload: unknown) => unknown) | undefined
      const internalFns = internal.length
        ? (internal.map((h) => h[name]).filter(Boolean) as ((payload: unknown) => unknown)[])
        : []
      if (!hostFn && internalFns.length === 0) return // no hook, no cost, no allocation

      const payload = {
        ...(extra as object),
        env: ctx.env,
        waitUntil: ctx.waitUntil,
        site: siteOf(extra as { site?: string | null; story?: { site?: string } }),
        brand,
      } as HookBase<Env>

      // Internal hooks always run first, and are **always awaited**, whatever
      // the host's `await` list says. That is not a courtesy to the host: the
      // cache purge (`cache-purge.ts`) has to land before the response, or the
      // editor's reload — the very next thing they do after publishing — races
      // it and is served the entry that was just superseded
      // (`../../docs/specs/platform/caching.md` decision 5). The other internal consumer, the
      // space broadcast, hands its RPC to `waitUntil` itself and so costs
      // nothing to await. A host hook for the same event can still assume they
      // have completed.
      //
      // What the purge hook returns is what it asked Workers Cache for
      // (`PurgeIssued`), and it becomes the payload's `purge` for everything after
      // it — so a host's hook sees exactly what was issued, not a second
      // computation of it (`multi-site.md` decision 16).
      for (const fn of internalFns) {
        const out = await runOne(name, fn, payload, logger)
        if (payload.purge === undefined && isPurgeIssued(out)) payload.purge = out
      }
      if (!hostFn) return

      const task = runOne(name, hostFn, payload, logger)
      if (awaited.has(name)) await task
      else ctx.waitUntil(task)
    },
  }
}
