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
import type { StoryMeta } from '../core/story'
import type { VersionMeta } from './versions'

export type HookEvent =
  | 'published'
  | 'unpublished'
  | 'pathsChanged'
  | 'created'
  | 'deleted'
  | 'checkpointed'

const HOOK_EVENTS: readonly HookEvent[] = [
  'published',
  'unpublished',
  'pathsChanged',
  'created',
  'deleted',
  'checkpointed',
]

/** Every hook payload's common shape. Nothing else is injected: a hook that
 * wants D1 or R2 uses `config.bindings(env)`, the same accessor the host
 * already wrote for every other route. */
export interface HookBase<Env> {
  env: Env
  waitUntil: (p: Promise<unknown>) => void
  actor: string | null
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
  paths: string[]
}

export interface CheckpointedHookPayload<Env> extends HookBase<Env> {
  story: StoryMeta
  version: VersionMeta
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

/** What a caller must supply for one event: the payload minus what the
 * runner already knows (`env`, `waitUntil`) from its own `ctx`. */
export type HookExtra<Env, E extends HookEvent> = Omit<HookPayloadMap<Env>[E], 'env' | 'waitUntil'>

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
 * event (decision 5) — the seam `../editing/live-collaboration.md`'s
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
): Promise<void> {
  try {
    await fn(payload)
  } catch (err) {
    // The library's second observability hook after `app.onError`'s route
    // logging (errors.ts): one line, naming the event, and nothing else — a
    // Slack outage or a broken search index must never make publishing
    // impossible (decision 2).
    console.error(`folio: hook ${name} failed`, err)
  }
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
): HookRunner<Env> {
  const awaited = new Set(hooks?.await ?? [])

  return {
    async run(name, extra) {
      const hostFn = hooks?.[name] as ((payload: unknown) => unknown) | undefined
      const internalFns = internal.length
        ? (internal.map((h) => h[name]).filter(Boolean) as ((payload: unknown) => unknown)[])
        : []
      if (!hostFn && internalFns.length === 0) return // no hook, no cost, no allocation

      const payload: unknown = { ...extra, env: ctx.env, waitUntil: ctx.waitUntil }

      const task = (async () => {
        // Internal hooks always run first: a host hook for the same event
        // can assume they have already completed (decision 5).
        for (const fn of internalFns) await runOne(name, fn, payload)
        if (hostFn) await runOne(name, hostFn, payload)
      })()

      if (awaited.has(name)) await task
      else ctx.waitUntil(task)
    },
  }
}
