/**
 * Folio's own after-commit hook: turning a lifecycle event into a space-channel
 * broadcast (`live-collaboration.md` architecture decision 4).
 *
 * It is a plain `FolioHooks` literal, written exactly the way a host writes one,
 * registered on the internal-hooks array `publish-hooks.md` decision 5 created
 * for it. That is the whole point: there is **one** after-commit path in this
 * codebase, not a host-facing one and a private one that drift. Nothing here
 * knows about Hono, a Request or an `ExecutionContext` — the payload's own
 * `waitUntil` is whatever the call site had, native at an HTTP route and the
 * `alarmHookCtx` fallback inside a Durable Object alarm.
 *
 * Two rules govern everything below.
 *
 * **After the commit, never before.** These fire from hooks, which by
 * construction run once the D1 write has landed, and the RPC itself rides
 * `waitUntil`, so a space object that is unreachable, hibernating awkwardly or
 * simply not bound cannot fail a publish that already succeeded. The same rule
 * `api.ts`'s `afterWrite` follows on the client.
 *
 * **Only what the hook already holds.** Every payload here is assembled from the
 * hook's own fields and nothing else: no second query to enrich an event, because
 * an event that costs a database read is an event nobody wants firing on every
 * rename. A client applies what it can and reloads the tree for the rest — one
 * refetch is cheaper than a wrong tree, and the events are idempotent, so a
 * missed one is corrected by the next load anyway.
 */
import type { SpaceEvent } from '../core/protocol'
import type { FolioHooks } from './hooks'
import type { FolioConfig, SpaceStub } from './types'

/**
 * The name of the one space instance. One for the whole site, because the whole
 * point is knowing who is in the *site*; per-space sharding is named as the
 * escape hatch in the spec and is not built.
 */
export const SPACE_NAME = 'space'

/**
 * Sends one event, swallowing everything. Errors are logged, never thrown: the
 * caller is inside a hook whose write has already committed.
 */
function emit(
  space: SpaceStub | null,
  event: SpaceEvent,
  waitUntil: (p: Promise<unknown>) => void,
) {
  if (!space) return // no binding: the whole channel is absent, by design
  waitUntil(
    space.broadcastEvent(event).catch((err: unknown) => {
      console.error(`folio: could not broadcast ${event.kind} to the space channel`, err)
    }),
  )
}

/**
 * The internal hook set. `config` is read lazily inside each handler rather than
 * resolved once, because `bindings` takes the host's `env` and only the hook's
 * own payload carries it.
 *
 * `globals` is `FolioConfig.globals` as the runtime resolved it — the explicit
 * list, not every singleton (`content-model/globals.md`'s resolved open
 * question) — so `global.changed` fires for the header and not for a person
 * record that happens to be a singleton.
 */
export function spaceBroadcastHooks<Env>(
  config: FolioConfig<Env>,
  globals: readonly string[],
): FolioHooks<Env> {
  const spaceFor = (env: Env): SpaceStub | null => {
    const ns = config.bindings(env).space
    return ns ? (ns.get(ns.idFromName(SPACE_NAME)) as unknown as SpaceStub) : null
  }

  return {
    created: ({ env, waitUntil, story, actor }) => {
      emit(
        spaceFor(env),
        {
          kind: 'story.created',
          id: story.id,
          parentId: story.parentId,
          title: story.title,
          type: story.type,
          actor,
        },
        waitUntil,
      )
    },

    /**
     * A rename or a move. `changes` is every row whose path moved, which for a
     * move includes the whole subtree — so a client can tell whether anything it
     * is looking at is affected without asking.
     *
     * A pure **reorder** among siblings does not appear here, because no path
     * changes and `pathsChanged` does not fire. That is a real and accepted gap:
     * sibling order is the one structural change whose only symptom is a tree
     * that is stale until the next load, and closing it would mean a second
     * after-commit path for the sake of a row moving up one place.
     */
    pathsChanged: ({ env, waitUntil, changes, actor }) => {
      emit(spaceFor(env), { kind: 'story.updated', changes, actor }, waitUntil)
    },

    deleted: ({ env, waitUntil, ids, actor }) => {
      emit(spaceFor(env), { kind: 'story.deleted', ids, actor }, waitUntil)
    },

    /**
     * Two events from one publish, when the published document is a configured
     * global: the story event every open admin uses to recompute its badge, and
     * the `global.changed` hint for anything rendering that global's content.
     */
    published: ({ env, waitUntil, story, version, publishedAt, actor }) => {
      const space = spaceFor(env)
      emit(
        space,
        {
          kind: 'story.published',
          id: story.id,
          title: story.title,
          at: publishedAt,
          actor,
          versionId: version.id,
        },
        waitUntil,
      )
      if (globals.includes(story.type)) {
        emit(
          space,
          { kind: 'global.changed', name: story.type, storyId: story.id, actor },
          waitUntil,
        )
      }
    },
  }
}
