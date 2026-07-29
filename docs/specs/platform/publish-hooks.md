# Feature: Lifecycle hooks — letting the host react to a publish

> **Group:** platform
> **Build order:** 7
> **Size:** S
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-07-29

## Summary

Folio has no server-side extension point of any kind. When a page is published there is
nowhere for a host to hang "purge the cache", "update the search index", "ping the
sitemap", "tell the channel". `publish()` writes its batch and returns.

Payload has hooks; Strapi, Contentful, Storyblok and Sanity all solve this with
webhooks — an HTTP callback, a shared secret, a retry queue and a delivery log.
**Folio needs none of that**, and `ROADMAP.md` already says why in the context of cache
invalidation: *"We own both sides, so publish can purge directly — no webhook, no
secret, no eventual consistency window."* The host's Worker and Folio are the same
process. A hook is a typed function call.

This is the smallest spec in the set and it unblocks the most host-side work: caching,
search indexing, notifications, and any hybrid host that needs to revalidate something.

## Ground truth

**server (`packages/folio/src/server/`):**
- `publish.ts` — `publish(deps, story, actor)` and `checkpoint(deps, story, input)`.
  `PublishDeps` is `{ db, draft }` and the file's header comment is explicit about why:
  *"Neither takes a Request, a Context or an `Env`: scheduled publishing (a Durable
  Object alarm, next on the roadmap) has none of those to offer."* A hook that needs
  `env` therefore has to arrive through `deps`, not through a request.
- `publish()` ends with one `db.batch([versionStatement, publishStatement])`. Anything
  after that line is running against a committed write, which is exactly where a hook
  belongs.
- `routes/stories.ts` handlers have `c.env` and `c.executionCtx`, so both halves of a
  hook context are available at every HTTP call site.
- `createRuntime`'s `publishDeps(bindings)` is *"the one place that assembly lives, for
  a route today and a Durable Object alarm next phase"* — the single seam to extend.
- The delete route already batches `deleteStoryStatement` with
  `deleteVersionsStatement` and then purges each Durable Object, so "after the write"
  is a well-defined moment there too.

**admin (`packages/folio/src/admin/api.ts`):**
- `afterWrite(refresh)` exists precisely for this class of problem on the client, with
  the rule written out: *"A read taken after a mutation has already landed is the other
  half of it: its failure is not the write's, and reporting it as one contradicts the
  success the user has just been shown."* Server-side hooks need the identical rule,
  and it is worth pointing at the precedent rather than re-deriving it.

**core (`packages/folio/src/core/`):**
- Nothing. Hooks are a server concern; documents and blocks never see them.

## Owner decision checkpoints

1. **After-commit only. No `before` hooks, no veto, no payload mutation
   (recommended).** A hook that could reject or rewrite a publish would have to run
   inside the batch, and a hook that throws mid-batch leaves D1 and the Durable Object
   disagreeing about what "the last publish" was — the exact failure the atomic batch
   was built to prevent. The host does not need `before` anyway: it owns the Worker and
   is already upstream of every call into Folio, so "check something first" is a line
   in its own route.
2. **A hook failure never fails the operation (recommended).** Caught, logged with the
   event name, dropped — the server-side twin of `afterWrite`. The alternative is a
   Slack outage making publishing impossible.
3. **`waitUntil` by default, `await` opt-in per hook (recommended).** Most hooks should
   not add latency to the editor's Publish click. A cache purge sometimes should, so
   that the next read is correct. One flag, and the default is the safe one for
   perceived speed.
4. **Not a delivery-guaranteed bus (recommended).** At most once, no retries, no
   ordering guarantees between hooks. A host that needs durability writes one line
   inside the hook to a Cloudflare Queue, which is the right tool and already available
   to it. Pretending otherwise would mean building a delivery log, and that is a
   product.
5. **The built-in consumers use the same mechanism (recommended).** The space-channel
   broadcast in `../editing/live-collaboration.md` and any future cache purge are
   internal hooks on the same list, so there is one after-commit path rather than two
   conventions.

## User stories

### Developer purges a cache
**As** a developer **I want** a publish to purge the cached page **so that** the live
site updates immediately without a revalidation window.

### Developer keeps a search index current
**As** a developer **I want** to reindex a document when it is published or unpublished
**so that** search results never point at content that is not live.

### Developer notifies the team
**As** a developer **I want** a publish to post to a channel **so that** the team sees
content go out without watching the CMS.

### Developer integrates a hybrid front end
**As** a developer running something in front of Folio **I want** a typed callback on
publish **so that** I do not have to build a webhook receiver inside my own Worker to
talk to myself.

### Developer is not punished for a broken integration
**As** a developer **I want** a failing hook to be logged and ignored **so that** a
third-party outage never stops editors publishing.

## Architecture decisions

### 1. One `hooks` object, one handler per event, typed per event

```ts
const folio = createFolio<Env>({
  blocks, types,
  bindings: (env) => ({ … }),
  hooks: {
    async published({ story, doc, version, actor, env, waitUntil }) {
      await caches.default.delete(new Request(`https://site/${story.path}`))
      waitUntil(indexForSearch(env, story, doc))
    },
    async unpublished({ story, env }) { await removeFromIndex(env, story.id) },
    async pathsChanged({ changes, env }) {          // rename or move
      for (const { from, to } of changes) await purge(env, from, to)
    },
    async deleted({ ids, paths, env }) { await purgeAll(env, paths) },
  },
})
```

Named keys rather than `on('published', fn)`: each event gets its own payload type, an
editor's autocomplete lists what exists, and a typo is a compile error instead of a
handler that never fires.

Every payload carries `env` (the host's own, unmodified) and `waitUntil`. Nothing else
is injected — a hook that wants D1 uses `config.bindings(env)`, the same accessor the
host already wrote.

### 2. The events, and why each one exists

| Event | Fires after | Payload | Why a host needs it |
| --- | --- | --- | --- |
| `published` | the publish batch commits | `story`, `doc`, `version`, `publishedAt`, `actor` | Purge, index, notify |
| `unpublished` | `unpublish` commits | `story`, `actor` | De-index, purge (`../editing/unpublish.md`) |
| `pathsChanged` | `updateStory`'s batch commits | `changes: { id, from, to }[]`, `actor` | Purge **old** paths; the only event that knows them |
| `created` | `createStory` commits | `story`, `actor` | Warm a cache, seed an external record |
| `deleted` | the delete batch commits and objects are purged | `ids`, `paths`, `actor` | Purge, de-index |
| `checkpointed` | a version row is written | `story`, `version`, `actor` | Rarely needed; free to add, and cheap to leave out of docs |

`pathsChanged` is the one that would be missed if the list were written from
imagination rather than from the code: `updateStory` is the only place that knows both
the old and the new path of every affected row (see `../platform/redirects.md`, which
consumes the same fact), and after it commits that information is gone.

### 3. Hooks arrive through `publishDeps`, so an alarm can fire them too

`PublishDeps` gains `hooks?: HookRunner`, assembled by `createRuntime.publishDeps
(bindings, hookCtx)`. `hookCtx` is `{ env, waitUntil }`, built from `c.env` and
`c.executionCtx.waitUntil` at an HTTP call site, and from `env` plus a fallback
`waitUntil = (p) => { void p.catch(log) }` inside a Durable Object alarm, which has no
`ExecutionContext`.

So a scheduled publish fires `published` exactly like a manual one, and the hook cannot
tell the difference — which is the whole point of `publish()` not taking a `Request`.

A hook marked `{ await: true }` is awaited even under the fallback runner. A hook that
is not awaited is still `void`-caught, so an unhandled rejection cannot escape into the
Worker's error handler.

### 4. Failure and timing are isolated, in one runner

```ts
// server/hooks.ts
async function run<E extends HookEvent>(name: E, payload: HookPayload[E]): Promise<void> {
  const hook = hooks?.[name]
  if (!hook) return                                    // no hook, no cost, no allocation
  const task = Promise.resolve()
    .then(() => hook(payload))
    .catch((err) => console.error(`folio: hook ${name} failed`, err))
  if (awaited.has(name)) await task
  else payload.waitUntil(task)
}
```

One function, one `catch`, one log line format. The log message names the event, which
is the library's second observability hook after `app.onError`'s route logging, and it
should read the same way.

### 5. What this deliberately does not become

Not a webhook sender, not a queue, not an event log, not a plugin system. The
distinction worth holding: a hook is a function the host wrote, running in the host's
own Worker, with the host's own bindings. That is why it needs no secret, no signature,
no retry policy and no delivery table — and why turning it into any of those things
would be a different feature with a different name.

## Wire & schema changes

None.

### Core / server types

```ts
export type HookEvent =
  | 'published' | 'unpublished' | 'pathsChanged' | 'created' | 'deleted' | 'checkpointed'

export interface HookBase<Env> {
  env: Env
  waitUntil: (p: Promise<unknown>) => void
  actor: string | null
}

export interface FolioHooks<Env> {
  published?: (e: HookBase<Env> & { story: StoryMeta; doc: Doc; version: VersionMeta;
                                    publishedAt: number }) => unknown
  unpublished?: (e: HookBase<Env> & { story: StoryMeta }) => unknown
  pathsChanged?: (e: HookBase<Env> & {
                    changes: { id: string; from: string; to: string }[] }) => unknown
  created?: (e: HookBase<Env> & { story: StoryMeta }) => unknown
  deleted?: (e: HookBase<Env> & { ids: string[]; paths: string[] }) => unknown
  checkpointed?: (e: HookBase<Env> & { story: StoryMeta; version: VersionMeta }) => unknown
  /** Events to await before responding. Everything else rides waitUntil. */
  await?: readonly HookEvent[]
}
```

`FolioConfig.hooks?: FolioHooks<Env>`, validated at construction only for unknown keys
(a typo in `await` should not be discovered six months later).

## Acceptance criteria

### `published` fires after the commit, with the version
```
GIVEN a hook on published
WHEN a story is published
THEN it is called exactly once, after published_doc and the version row are committed,
     with the story row, the published document, the version metadata and the actor
AND the route's response is not delayed (the hook rode waitUntil)
```

### A throwing hook does not fail the publish
```
GIVEN a published hook that throws
WHEN a story is published
THEN the publish succeeds, the response is a normal 200, the editor sees "Published",
     and one error line is logged naming the event
```

### `await: ['published']`
```
GIVEN await: ['published'] and a hook that takes 50 ms
WHEN a story is published
THEN the response is sent after the hook completes
AND a throwing hook still does not fail the publish
```

### `pathsChanged` carries old and new
```
GIVEN a section page with two descendants, all published
WHEN the section is renamed
THEN the hook receives three changes, each with the correct from and to
AND it fires after the rename batch commits
```

### `unpublished` and `deleted`
```
GIVEN hooks on both
WHEN a story is unpublished, then deleted
THEN unpublished fires with the story, and deleted fires with the removed ids and
     their paths, after the Durable Objects are purged
```

### A scheduled publish fires the same hook
```
GIVEN a publish invoked from a Durable Object alarm (no ExecutionContext)
WHEN it runs
THEN published fires with the same payload shape, and an unawaited hook's rejection
     is caught rather than escaping into the alarm handler
```

### No hooks configured
```
GIVEN no hooks key
WHEN anything is published
THEN no allocation, no promise, no log line, and no behaviour change of any kind
```

### Construction validation
```
GIVEN hooks: { publish: fn } (a typo for published)
WHEN createFolio is called
THEN it throws naming the unknown hook key and listing the valid ones
```

## Implementation plan

### Phase 1 — the runner

1. `server/hooks.ts`: types, `createHookRunner(hooks, ctx)`, the one `run` from
   decision 4, and the unknown-key check.
2. `server/types.ts`: `FolioConfig.hooks`.
3. `server/runtime.ts`: `publishDeps(bindings, hookCtx)`; a `hookCtx` helper for the
   alarm case.
4. Tests: `test/unit/server/pure.test.ts` — the runner in isolation (fires once,
   catches, awaits when asked, no-ops when absent).

### Phase 2 — the call sites

1. `publish.ts`: `published` after the batch; `checkpointed` after `writeVersion`;
   `unpublished` after the unpublish statement (`../editing/unpublish.md`).
2. `stories.ts` / `routes/stories.ts`: `created` after the insert; `pathsChanged` after
   `updateStory`'s batch, built from the same `changed` rows the redirect statements use;
   `deleted` after the delete batch and the object purges.
3. Tests: `test/workers/http.test.ts` — each event fires once, after the write, with the
   right payload; a throwing hook leaves the response untouched; a failed write fires
   nothing.

### Phase 3 — docs

1. `README.md`: a Hooks section with the cache-purge example, and the explicit note that
   Folio needs no webhooks because the host is the same Worker.
2. `ROADMAP.md`: the cache-invalidation item can now name where the purge goes.

## Edge cases

- **A hook that never resolves** → `waitUntil` bounds it to the Worker's lifetime; the
  response has already been sent. An awaited hook that hangs will hit the Worker's
  own limit and fail the request, which is why `await` is opt-in and documented as
  such.
- **A hook mutating content** (calling back into `folio.write` from
  `../platform/content-api.md`) → allowed and occasionally legitimate (stamping a
  field on publish). Reentrancy is the host's problem: a `published` hook that
  publishes will loop, and the docs say so rather than the library guessing a depth
  limit.
- **A failed write** → no hook. The runner is called after the `await` on the batch, so
  a thrown D1 error skips it entirely.
- **Partial success in the delete path** (rows deleted, one object purge fails) →
  `deleted` still fires, because the rows are gone and a host's cache must be purged
  regardless. The purge failure is logged separately, as today.
- **Two publishes in flight for one story** → two `published` events, in commit order.
  No coalescing: a host that wants debouncing does it in the hook.
- **`console.error` in a hook's catch and no observability configured** → the demo's
  `wrangler.jsonc` already enables observability, and `app.onError` already sets the
  precedent that a log line is the library's error surface.
- **Hooks and `../editing/live-collaboration.md`'s space events** → the broadcast is
  registered as an internal hook on the same list (decision 5), so there is one
  after-commit path. Internal hooks always run before host hooks, so a host hook can
  assume other editors have already been told.

## Testing requirements

**Unit:** the runner — fires once, catches and logs, awaits only listed events, absent
hooks cost nothing, unknown keys throw at construction.

**Workers:** every event at its real call site, with payload assertions and the
after-commit ordering; a throwing hook not affecting any response; a failed write firing
nothing.

**End to end:** none needed. A host-facing callback is fully covered by the workers
tests, and a browser adds nothing.

## Dependencies

- `../editing/unpublish.md` for the `unpublished` event — build order puts it first, so
  the event ships with the rest.
- `../platform/redirects.md` shares `updateStory`'s `changed` rows with
  `pathsChanged`; neither depends on the other, but they should be read together
  because they are the two consumers of the same fact.

## Out of scope

- **Webhooks.** A host can `fetch()` in a hook. A real webhook product needs signing,
  retries, a delivery log and a management UI, and Folio's host does not need one to
  talk to itself.
- **Field- or document-level `beforeChange` hooks** (checkpoint 1). Note that the
  *editing* path has no natural place for one anyway: an edit is a mutation validated
  inside a Durable Object that deliberately knows nothing about schemas, so a
  before-write hook there would mean pushing host code into the object.
- **A plugin system.** EmDash's sandboxed plugin isolates are the interesting answer
  to a problem Folio does not have: it is a library, the host owns the Worker, and
  there is no third-party code to isolate. Worth revisiting only if Folio ever ships as
  an application.
- **Cache invalidation itself.** `ROADMAP.md`'s item; this spec provides the seam it
  needs and deliberately does not choose a cache.

## Implementation notes

All five owner decision checkpoints landed as recommended. Both phases of the plan
shipped, though not as two independently-green commits: `publishDeps` gaining a
required `hookCtx` second parameter (decision 3) breaks every existing call site in
the same edit that adds it, so phase 1 (the runner) and the `publish.ts` half of
phase 2 (the call sites) landed together, with the `created`/`pathsChanged`/`deleted`
call sites and their workers tests as a second commit, and docs as a third.

**Ground truth was accurate.** `publish()`'s single `db.batch([versionStatement,
publishStatement])` was exactly where the spec said, and `PublishDeps`/`createRuntime`
carried the extra required parameters carryover flagged (`draftWithSyncId`,
`publishedSyncId`) with no surprises.

**What the spec's sketch did not anticipate, because it predates the specs that
built the code paths it hooks:**

- `updateStory` (rename/move) had no way to hand `pathsChanged`'s caller the
  `changes` list without either recomputing the diff a second time or changing
  `updateStory`'s own return shape (used by ~15 existing tests as a bare
  `StoryMeta`). Resolved the way `deleteStoryStatement`/`deleteStory` already split
  the same problem: a new `updateStoryStatement(db, id, patch)` returns
  `{ next, statements, changes }` unrun, and `updateStory` is now a two-line wrapper
  that runs it and returns `next`, unchanged for every existing caller. The route is
  the only caller of the new function.
- `deleteStoryStatement` gained a `paths: string[]` field (same order as `ids`) for
  the same reason — `deleted`'s payload needs the paths and the row is gone by the
  time anything could look them up again.
- `pathsChanged` and `created` fire only when something actually changed: a plain
  title edit that leaves every path alone fires no `pathsChanged` (an empty
  `changes` array would purge nothing), and a failed write fires nothing, per the
  edge cases already in this spec. Not spelled out as its own acceptance criterion,
  but a direct reading of "the event that knows both the old and the new path" —
  there has to be an old and a new that differ.
- Unpublishing an already-unpublished story (the idempotent no-write path) fires no
  `unpublished` — nothing committed, so there is nothing for an after-commit hook to
  be about.

**The internal-hook seam (decision 5, for `../editing/live-collaboration.md`):**
`server/hooks.ts` exports `InternalHooks<Env> = readonly FolioHooks<Env>[]` — a plain
array of the same `FolioHooks` object shape a host writes, not a parallel type or a
per-event array map. `createHookRunner(hooks, ctx, internal = [])` takes it as a
third, optional parameter; `createRuntime` holds one such array (empty today, with a
comment naming the seam) and threads it into every `publishDeps` call. On `run(name,
...)`, every internal hook registered for that event executes — each wrapped in its
own try/catch, logged exactly like a host hook's failure — strictly before the host's
own handler for the same event, so a host hook can assume other editors have already
been told. Spec 16 adds its space-channel broadcast by pushing one `FolioHooks`
literal onto that array; nothing else in this file needs to change.

**Deferred:** the Durable Object alarm call site itself. Scheduled publishing has no
route or alarm handler yet ("next on the roadmap" per `publish.ts`'s own header), so
there is nothing to wire `alarmHookCtx` into beyond the helper existing and being
unit-tested directly. Whoever builds scheduled publishing calls
`publish(deps, story, actor)` with `deps.hooks` built from `createHookRunner(config
.hooks, alarmHookCtx(env), internalHooks)` and nothing else changes.

**Tests:** 25 added (853 total, was 828) — 15 unit (`test/unit/server/pure.test.ts`:
the runner in isolation, `validateHooks`, and `alarmHookCtx`'s fallback waitUntil) and
10 workers (`test/workers/http.test.ts`: every event at its real HTTP call site, a
throwing hook not affecting the response, a failed write firing nothing, the
idempotent-unpublish and no-path-change silences). The workers tests build their own
`createFolio` instance per test (`app.test.ts`'s existing pattern) rather than adding
hooks to the shared `test/workers/worker.ts` fixture — that fixture is the pool's
`main` module, and vitest-pool-workers proxies named exports from it over an RPC
boundary that cannot carry a plain array back to the test file. A second, purpose-built
instance sharing the same `env` (same D1, same Durable Object namespace) sidesteps
that entirely, and `waitOnExecutionContext` drains a non-awaited hook's `waitUntil`
task before a test inspects what it recorded. No e2e script: the spec's own Testing
requirements section says a host-facing callback needs none, and a browser adds
nothing a workers test does not already cover.
