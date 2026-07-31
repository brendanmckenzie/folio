# Feature: Scheduled publish and unpublish

> **Group:** platform
> **Build order:** 19, per docs/specs/README.md
> **Size:** M ≈ a few days
> **Status:** done
> **Wire version:** none
> **Migration:** `0003_schedules.sql`
> **Last updated:** 2026-07-31

## Summary

An editor cannot say "this goes live on Tuesday". Storyblok, Contentful and Strapi
all ship it, and `docs/completion-plan.md` names it as the first of the gaps that
stop a real delivery — the most-asked-for thing a client wants that Folio has no
answer to.

The groundwork was laid two specs ago and then left. `server/publish.ts:1-9` says in
its own header that `publish` and `unpublish` were written against D1 and a draft
rather than a Request *because* a scheduled publish would have no Request to offer,
and `server/routes/stories.ts:540` says the story's existence is "the workflow's to
check, because a scheduled publish has to check it too". Nothing calls either from
anywhere but an HTTP route. What is missing is the row that records the intention,
and the thing that fires it.

## Ground truth

Verified against the tree at `d0dd209` (2026-07-31).

**core (`packages/folio/src/core/`):**
- `story.ts:108` — `StoryState = 'draft' | 'unpublished' | 'live' | 'changed'`,
  derived by `draftState(publishedAt, unpublishedAt, draftSyncId, publishedSyncId)`
  from four stored columns. Four **mutually exclusive** descriptions of the present.
- `pagination.ts:24` — `Page<T> = { rows, cursor, total? }`, and `paginate` /
  `encodeCursor` / `decodeCursor` are the one codec. `CursorPart` is
  `string | number` and non-nullable.
- `protocol.ts` — `PROTOCOL_VERSION` is 4. **Nothing here touches the wire**: a
  schedule is a D1 row and four HTTP routes, and no socket frame changes shape.

**server (`packages/folio/src/server/`):**
- `publish.ts:91` — `StorySelector = string | StoryMeta`, with the comment "An alarm
  only ever has the id, which is why the workflows look the row up at all". So
  `publish(deps, 'sty_x', actor)` already works, and `requireStory` throws
  `FolioError('not_found', 'Unknown story')` for an id D1 no longer has.
- `publish.ts:100-179` — `publish` writes a retained `versions` row, `published_doc`,
  `published_at`, `published_sync_id`, `title`, `title_i18n` and the `content_index`
  projection **in one batch**, then fires the `published` hook. `publish.ts:192` —
  `unpublish` reads no draft at all and is idempotent.
- `publish.ts:18-73` — `PublishDeps` is `{ db, draft, draftWithSyncId, titleFor,
  titlesFor?, projection?, hooks? }` and is assembled in exactly one place,
  `runtime.ts:716`'s `publishDeps(bindings, hookCtx)`.
- `runtime.ts:803` — `alarmHookCtx(env)` is the `HookRunnerCtx` for a caller with no
  `ExecutionContext`; `index.tsx`'s `reindex` and `migrate` both use it.
- **`story-do.ts:394` is the load-bearing fact for decision 2.** `applyTransaction`
  does `if ((await this.ctx.storage.getAlarm()) === null) setAlarm(now + 2000)` for
  the debounced draft watermark, and `alarm()` at `story-do.ts:277` writes
  `draft_sync_id`/`draft_updated_at` into D1. **A Durable Object has exactly one
  alarm.** `StoryDO` has already spent it.
- `migrate.ts:36-101` and `reindex.ts:25-51` — the batched-job shape: a
  `DEFAULT_*_BATCH`, a `MAX_*`, `continueFrom`, a report with per-item `failed:
  [{ storyId, reason }]`, and a completion count asked directly (`countBehind`)
  rather than accumulated.
- `stories.ts:1555` — `deleteStoryStatement` returns `{ ids, paths, types, statement,
  redirectStatements, indexStatements }`, all of which a caller must batch. Three
  callers: `routes/stories.ts`, `routes/api/documents.ts`, `deleteStory`.
- `auth/roles.ts:177` — `PUBLISH = { role: 'publisher', scope: 'publish' }`, which
  gates `POST /story/:id/publish` and `/unpublish`.
- `app.ts:59-79` — **a version segment is a promise.** `{base}/api/v1/*` is a
  contract; `{base}/api/*` is internal and may change in any commit.
- `keyset.ts:21-40` — `Keyset.columns` is `[string, string] | [string]`. **A pair**,
  and the tiebreak must be unique on its own.
- `errors.ts:130` — any `UNIQUE constraint failed` becomes a `conflict` envelope, so
  a uniqueness guard needs no server code.

**migrations (`packages/folio/migrations/`):**
- Two: `0001_init.sql` (the whole schema) and `0002_asset_refs.sql`. Next is `0003`.
- `0001_init.sql:163` — `versions.kind` carries a CHECK, and **that is why an
  unpublish is not representable in `versions` to this day**: SQLite cannot widen a
  CHECK without rebuilding the table. `0002_asset_refs.sql:10-12` praises
  `content_refs.kind` for having none.
- `0001_init.sql:238-257` — `sessions.user_id references users(id) on delete
  cascade`, and `test/workers/auth-session.test.ts:87` says the delete is done
  **explicitly anyway**, because "whether D1 enforces foreign keys is a property of
  the database".
- `0001_init.sql:222` — `redirects.story_id` is "informational, not a foreign key:
  redirects deliberately outlive the story that created them".

**tests:**
- `test/workers/migrations.test.ts` asserts the shape table by table, including two
  deliberate *absences* (`stories_draft_updated`, an index on `assets.filename`).
- `test/workers/api-partition.test.ts:37` enumerates every internal route and asserts
  it 404s under `/api/v1`.
- `test/workers/story-state.test.ts` pins `STATE_EXPR` against `draftState`.
- `test/workers/smoke.test.ts:54` asserts the exact list of tables.

**admin:** untouched. Three agents are mid-rebuild under `src/admin/ui/screens/`;
this spec ships no UI (see *Out of scope*).

## Owner decision checkpoints

1. **`scheduled` is not a fifth `StoryState`** — decision 1. The alternative changes
   `STATE_EXPR`, `draftState`, every state chip and the `?state=` filter, and it makes
   a live page with an embargo end stop answering `?state=live`.
2. **A cron trigger, not a Durable Object alarm** — decision 2. `ROADMAP.md` predicted
   the alarm; `StoryDO`'s single alarm is already spent on the watermark.
3. **A schedule survives a manual publish** — decision 5. `editing/unpublish.md`
   already recorded this answer in its edge cases before the feature existed.
4. **Both actions ship together** — decision 6.
5. **No admin UI in this spec.** The routes are shaped so a screen is obvious.

## User stories

### Editor plans an announcement
**As** an editor **I want to** set a page to publish at 9am on Tuesday **so that** an
embargoed announcement goes out on time without me being at a laptop.

### Editor ends a campaign
**As** an editor **I want to** set a campaign page to come down on Friday at 5pm
**so that** an expired offer stops being public without anybody remembering to
remove it.

### Editor trusts the schedule
**As** an editor **I want to** see what is scheduled and cancel it **so that** I am
not relying on a promise I have no way to check. A schedule nobody can list is a
schedule nobody trusts.

### Publisher finds out it failed
**As** a publisher **I want** a schedule that could not fire to say why **so that**
"the announcement never went out" is something I discover before the client does.

### Developer integrates it
**As** a developer **I want** the scheduler to be one call from my own `scheduled()`
handler **so that** adopting it is a cron line and five lines of code, not a queue.

### Site owner pays nothing for it
**As** a site owner with nothing scheduled **I want** the feature to cost nothing
**so that** a minutely cron is not a minutely table scan.

## Architecture decisions

### 1. `scheduled` is not a fifth `StoryState`; it is a separate fact, read separately

`StoryState`'s four values are **mutually exclusive descriptions of what a document
is doing now**, which is exactly what lets `server/stories.ts`'s `STATE_EXPR` be a
`case` expression returning one of them, and what lets `?state=live` mean something.

A schedule is a fact about the *future*, and it is orthogonal to all four: a draft can
carry one, an unpublished page can carry one, and a **live page with a scheduled
unpublish is still live**. A fifth value would have to displace one of the four, so
that page would stop appearing under `?state=live` — a filter that no longer lists
the page that is, in fact, live. The same document can also carry *two* schedules (a
campaign window), which a single-valued state cannot express at all.

What the alternative would have cost, concretely: `STATE_EXPR` gains a branch and a
subquery against a second table (so the expression stops being a function of the row);
`draftState` gains a parameter that is not a column on the story; `story-state.test.ts`
has to feed both a story and its schedules; every state chip on Content and Documents
gains a value; and `?state=scheduled` starts competing with `?state=live` for a page
that is both.

**The cost of this choice, paid honestly:** a screen that wants to show "publishes
Tuesday" beside a row needs a second read (`GET {base}/api/schedules`). That is one
request per screen, not one per row, and it is the same shape every other cross-cutting
fact in this admin already has.

### 2. A cron trigger on the host's Worker, not a Durable Object alarm per story

`ROADMAP.md:458` says "A DO alarm per story. Small, and a real Cloudflare advantage:
no cron worker, no queue, no polling." **It is wrong**, and the reason is only visible
from `story-do.ts`: a Durable Object has exactly **one** alarm, and `StoryDO` already
spends it on the debounced draft watermark (`applyTransaction` sets it 2s out, guarded
by `getAlarm() === null` meaning "already scheduled"). The two uses cannot coexist:

- A publish alarm set for Tuesday makes `getAlarm()` non-null for days, so **no
  watermark is ever written** for that document and the tree stops reporting
  unpublished changes on it.
- Let the watermark win instead and any keystroke on Monday resets the alarm to
  `now + 2s`, at which point `alarm()` has to decide which job it is. The honest
  version of that is a due-time table inside every object — `where at <= ?`
  reimplemented per document, in SQLite, once per story.

A cron also answers a question an alarm structurally cannot: **"what is scheduled
across this site"** is one indexed D1 read here and a fan-out that wakes every Durable
Object there. Decision 4 makes that question load-bearing.

**What is given up is exactness, and the granularity is the cron's.** Cloudflare cron
is a minute at finest and best-effort within it. A schedule fires on the first sweep
**at or after** its due time, so it is never early and is late by at most one period.
For a CMS publishing a press release that is the right trade; nothing here is a market
open. `examples/demo/wrangler.jsonc` uses `* * * * *`, and nothing in Folio assumes
the period.

**Rejected: a Cloudflare Queue with a delayed message.** Delays cap at 12 hours (so
"next Tuesday" needs re-enqueueing anyway), an enqueued message cannot be cancelled,
and a cancel therefore still needs the D1 row to consult — which makes the queue pure
overhead on top of the design that already works.

### 3. A `schedules` table, not two columns on `stories`

`stories.publish_at` / `unpublish_at` is the smaller change, and it has nowhere to
record *who* asked, how many attempts have failed, or why. Decision 4 makes all three
necessary, and a nullable timestamp has room for none of them. A second table also
keeps a schedule out of `COLS`, so all eleven readers in `server/stories.ts` are
untouched and `STATE_EXPR` stays a function of the story row.

The row is `(id, story_id, action, at, status, actor, created_at, attempts,
last_error)`. Three things about it are decisions rather than mechanics:

- **A synthetic `id`, not `primary key (story_id, action)`.** The list route pages by
  keyset, `keyset.ts`'s `Keyset` holds a **pair**, and the tiebreak must be unique on
  its own. Two schedules for one instant would need `(at, story_id, action)` to be
  total. Every other paged table here has a text primary key for the same reason.
- **No CHECK on `action` or `status`**, following `content_refs.kind` and
  deliberately not `versions.kind` — whose CHECK is the reason an unpublish still has
  no version row. A third action (a scheduled checkpoint) is one enum value and no
  DDL.
- **At most one *pending* schedule per `(story_id, action)`**, enforced by a partial
  unique index. Rescheduling replaces, so "when does this go live" has exactly one
  answer; a queue of contradictory instructions has none. A publish on Tuesday and an
  unpublish on Friday are two rows and two actions, so a campaign window needs
  nothing widened.

### 4. What happens when a scheduled publish cannot happen: four answers, not one

"A scheduler that dies on one story and skips the rest" and "one that silently
swallows a failure nobody ever sees" are both real, and they want different answers
for different causes. Every schedule is attempted in its own `try`, the same
discipline `runMigrations` applies per document, and then:

| Cause | Answer | Why |
| --- | --- | --- |
| **The document has been deleted** | Drop the row, count it in `report.dropped` | An instruction to publish something that does not exist is not an instruction. Retrying it three times and retaining it as a broken schedule for a document nothing can show is noise. `deleteStoryStatement` clears schedules in the delete batch, so this only fires for a delete that raced the sweep, or a row a script wrote for an id that never existed. |
| **Already live, or live and unchanged** | Publish anyway | Unconditional, and this is the case the obvious guard gets wrong. "Skip if `state === 'live'`" would skip exactly what an editor means by scheduling: "publish the edits I make between now and Tuesday" — at the moment of scheduling nothing has changed yet. It costs a redundant `versions` row for byte-identical content, which is the honest record that two publishes happened. |
| **A transient failure** (Durable Object unreachable, D1 blip) | Leave it pending, `attempts + 1`, record `last_error`, retry next sweep | Fixed by trying again in a minute. |
| **Still failing after `MAX_SCHEDULE_ATTEMPTS` (3)** | `status = 'failed'`, stop | Retrying forever fills a log with one line and burns a batch slot other schedules need. Three attempts is ~3 minutes on a minutely cron: long enough to outlast a blip, short enough that an editor watching for their page notices. |

**A document whose schema is behind the model is not a failure case at all**, contrary
to the brief that commissioned this. `publish()` snapshots the draft as it stands and
stamps `meta.schemaId` on the version precisely so a version can say it is
unmigrated; it has no check to fail. A scheduled publish of a behind-the-model
document publishes it exactly as a manual one does.

**A failure is retained and a success is deleted.** The success is already recorded in
`versions`, attributed to `actor` — the identical record a manual publish leaves — so
a retained row would be a second, weaker copy of history that nothing prunes. A
failure is recorded nowhere else. The consequence is that the table is bounded by
"pending, plus whatever is broken", which is the set somebody would actually want to
look at, and there is no `'done'` status and nothing to prune.

**Rejected: a `schedule_runs` log table.** It is the audit trail this already has, one
table further out, and it would need its own retention policy on day one.

### 5. A schedule survives a manual publish

Somebody schedules Tuesday and publishes by hand on Monday. **Tuesday still fires.**

Publishing by hand says "make it live now"; it does not say "and never publish again
on Tuesday". And Tuesday's publish snapshots whatever the draft is *on Tuesday*, which
is a different document if anybody edited in between — so cancelling on the editor's
behalf would mean those edits silently never went live, which is the failure this
feature exists to prevent. Cancelling has an explicit affordance
(`DELETE {base}/api/story/:id/schedule?action=publish`); guessing has none.

`editing/unpublish.md`'s edge cases already reached this answer, in writing, before
there was anything to schedule: "the schedule stands and will re-publish it. Correct:
a schedule is an instruction about the future." The corollary is that a scheduled
*unpublish* also stands through a manual publish, which is a campaign window working
as designed.

### 6. Scheduled unpublish is the same mechanism, and it ships

One `action` column, one sweep, two workflow calls. It costs an enum value and it is a
genuinely different product feature: an embargo ending, an offer expiring, a campaign
page coming down. `unpublish()` was written to take no `Request` for exactly this
reason (`editing/unpublish.md` decision 3) and reads no draft, so a scheduled
unpublish touches no Durable Object at all.

### 7. Publish, *then* clear the row

At-least-once, deliberately. Clearing first would be at-most-once: a failure between
the two loses the publish silently and forever. Publishing first means a crash between
them leaves the row pending and the next sweep publishes again, costing a second
`versions` row for byte-identical content. **One redundant version beats one page that
never went live.**

The clear therefore swallows its own failure rather than throwing, which is the second
half of the same choice: the publish has already committed by then, so a throw would
abort the sweep and skip every schedule behind this one — the exact bug the
per-schedule `try` exists to prevent, arriving through the back door. And it is not
counted as a failed attempt: the publish worked, so incrementing `attempts` would
march a healthy schedule toward `status: 'failed'` three sweeps later.

### 8. The sweep resumes by an opaque `(at, id)` cursor, and there is no `complete` flag

Two departures from `MigrateReport`, both forced:

- `continueFrom` is a **cursor**, not a story id. The sweep runs in *due* order
  because the batch limit can truncate a backlog and the row that should fire first
  is the one that was due longest ago — so its resume key is a pair.
  `migrate.ts`/`reindex.ts` walk by primary key because any order will do.
- A cursor is needed **at all** only because of retries: a schedule that fires is
  deleted, so the due set shrinks as the sweep walks it and re-reading the first batch
  would be correct — except a transiently-failed row stays pending and stays due, and
  a cursorless sweep would retry it forever inside one run and never reach the rows
  behind it.
- **No `complete`.** `remaining` is asked directly after the run (like `countBehind`)
  and is a diagnostic. A row that failed in *this* sweep is still pending and still
  due, so `while (!complete)` spins on it. Offering the flag would be an invitation to
  write that loop, so the report does not have one and `Folio.runSchedules`' doc says
  "loop on `continueFrom`".

### 9. A site with nothing scheduled pays one empty index probe

Both indexes are **partial on `status = 'pending'`**. An index over a condition no row
satisfies is an empty B-tree, so a minutely sweep on a site with nothing scheduled is
one indexed range probe that touches no rows. A full index on `(at, id)` would carry
every retained failure forever and be paid for on every write.
`migrations.test.ts` asserts it as an `explain query plan`, because "the sweep uses
`schedules_due`" is the property and prose cannot keep it true.

### 10. `POST {base}/api/schedules/run` exists, and the cron is still the mechanism

Three narrower reasons, all of them the `POST {base}/api/migrate` precedent: an
operator whose cron did not fire wants to catch up without waiting for the next tick;
a host that has adopted the routes and not yet added `triggers.crons` is otherwise
sitting on a table nothing reads; and `scripts/scheduled-test.mjs` needs a
deterministic trigger.

`PUBLISH`, not `ADMIN`: everything it can do it does by calling the same `publish` and
`unpublish` a `publisher` can already call directly, and it fires only what is
*already due*. **`ScheduleRunOptions.now` is deliberately not readable off the body** —
that would turn a publisher into somebody who can fire every future schedule on the
site at once by posting a date far enough ahead, which is a capability nothing else in
this surface grants.

### 11. A time in the past is a 400, not "fire on the next sweep"

The two are observationally similar and mean different things. A caller asking for a
moment that has gone has a bug, almost always a date assembled in the wrong unit or
the wrong timezone (seconds sent where milliseconds were meant reads as 1970), and
`POST /story/:id/publish` is what "now" means. Accepting it would publish immediately
under a UI that says "scheduled". A ten-year horizon catches the same mistake in the
other direction (milliseconds sent where seconds were meant reads as the year 56,000),
mirroring the ceiling `TokenCreateBody.expiresInDays` puts on a token's life.

## Wire & schema changes

### D1 migration `0003_schedules.sql`

```sql
create table schedules (
  id         text primary key,
  story_id   text not null,
  action     text not null,                    -- 'publish' | 'unpublish', no CHECK
  at         integer not null,                 -- epoch ms, UTC
  status     text not null default 'pending',  -- 'pending' | 'failed', no CHECK
  actor      text,
  created_at integer not null,
  attempts   integer not null default 0,
  last_error text
);

create index schedules_due on schedules (at, id) where status = 'pending';

create unique index schedules_story_action
  on schedules (story_id, action) where status = 'pending';
```

No `schedules_story`: `?story=` without a status cannot use the partial index, so that
one query scans a table bounded by "pending plus broken". `migrations.test.ts` asserts
the absence, the way it does for `stories_draft_updated` and `assets`.

### Core types

`core/story.ts` gains `ScheduleAction`, `ScheduleStatus` and `Schedule` — in `core/`
rather than `server/` for the reason `StoryFilter` and `FlatSort` are there: the
values travel in a URL and a body, so the screen that writes them and the reader that
answers have to share one vocabulary. **`StoryState` is unchanged** (decision 1).

Nothing about `Doc`, `Blok`, `Field`, `Mutation`, `Resolution` or the protocol moves.
`PROTOCOL_VERSION` stays at 4: a schedule is a row and four routes, and no frame
changes shape.

### New or changed routes

All internal (`{base}/api/*`), so they may change shape in any commit. Nothing lands
under `/api/v1`: that would be a promise to somebody's script about a surface nothing
outside the admin reads yet.

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `{base}/api/schedules` | `READ` | `?story=&status=&action=&limit=&cursor=&count=1` | `Page<Schedule>`, soonest first |
| POST | `{base}/api/story/:id/schedule` | `PUBLISH` | `{ action, at }` | `201` + `Schedule` |
| DELETE | `{base}/api/story/:id/schedule` | `PUBLISH` | `?action=` (**required**) | `{ deleted: n }` |
| POST | `{base}/api/schedules/run` | `PUBLISH` | `{ dryRun?, batch?, continueFrom? }` | `ScheduleRunReport` |

Errors: `400` for a past or too-distant `at`, an unknown `action`, a missing `?action=`
on the cancel, or a malformed cursor; `404` for a document that does not exist;
`409` for two concurrent schedules of the same `(story, action)`.

`READ` on the list, matching every other list route: a schedule is metadata about a
row `GET /stories` already returns to a viewer, and knowing a draft is due to go live
discloses nothing its state chip does not. `PUBLISH` on the writes, matching
`POST /story/:id/publish` exactly — scheduling a publish *is* publishing, with a delay.

### Host-facing API

`Folio.runSchedules(env, opts?) => Promise<ScheduleRunReport>`, assembled from
`publishDeps(bindings, alarmHookCtx(env))` exactly as `migrate` and `reindex` are.
`folio/server` also re-exports `Schedule`, `ScheduleAction`, `ScheduleStatus`,
`ScheduleFailure`, `ScheduleRunOptions`, `ScheduleRunReport` and
`MAX_SCHEDULE_ATTEMPTS`.

## Acceptance criteria

### It happens with nobody watching
```
GIVEN a page whose draft says "Scheduled A" and a publish scheduled two seconds out
WHEN the sweep runs after that instant, with no browser open
THEN the report names the document under `published`
AND GET / serves 200 with "Scheduled A"
AND a `versions` row of kind 'publish' exists, attributed to whoever scheduled it
AND the schedule row is deleted rather than marked done
```

### Never early
```
GIVEN a publish scheduled for instant T
WHEN a sweep runs at T-1
THEN nothing fires
WHEN a sweep runs at T
THEN it fires
```

### A campaign window
```
GIVEN a publish scheduled for Tuesday and an unpublish for Friday on one document
WHEN Tuesday's sweep runs
THEN the page is live and the Friday row is still pending
WHEN Friday's sweep runs
THEN the page is unpublished, the host answers 410, and the draft is untouched
```

### A schedule survives a manual publish
```
GIVEN a publish scheduled for T, published by hand before T, and edited again after
WHEN the sweep runs at T
THEN it publishes again
AND the live page shows the draft as it stood when the schedule fired, not when it
    was set
```

### Failure is visible and bounded
```
GIVEN a due publish whose Durable Object is unreachable
WHEN the sweep runs three times
THEN each run reports it under `failed` with a reason and an attempt count
AND the row stays pending for the first two, so a blip self-heals
AND after the third it reads status 'failed' with `last_error` set, and stops
AND GET {base}/api/schedules?status=failed lists it
```

### One failure does not skip the rest
```
GIVEN two due publishes, the first of which cannot publish
WHEN the sweep runs
THEN the first is reported failed and the second is published
```

### A deleted document takes its schedule with it
```
GIVEN a document with a pending schedule
WHEN it is deleted
THEN the schedule row is gone in the same batch
AND a sweep that races the delete drops the row rather than failing it
```

### Nothing scheduled costs nothing
```
GIVEN a site with no pending schedules
WHEN the sweep runs
THEN it reports { due: 0, remaining: 0, continueFrom: null } and writes nothing
AND the query plan uses the partial index `schedules_due`
```

### Batched and resumable
```
GIVEN three due schedules and batch: 1
WHEN the sweep is called three times, each with the previous `continueFrom`
THEN each fires one, and the third answers continueFrom: null
```

## Implementation plan

### Phase 1 — the row and the sweep

1. `migrations/0003_schedules.sql`.
2. `core/story.ts`: `ScheduleAction`, `ScheduleStatus`, `Schedule`; a note on
   `StoryState` recording why there is no fifth value.
3. `server/schedules.ts`: the SQL — `listSchedules`, `dueSchedules`, `countDue`,
   `setScheduleStatements`, `clearSchedule`, `clearSchedulesStatements`,
   `completeScheduleStatement`, `failScheduleStatement`, `checkScheduleTime`.
4. `server/scheduler.ts`: `runSchedules(deps: PublishDeps, opts)`, the report, the
   two constants. Split from (3) so `stories.ts` can import the cleanup statements
   without dragging `publish.ts` in behind them.
5. `server/stories.ts`: `deleteStoryStatement` returns `scheduleStatements`;
   `deleteStory` batches them.
6. `server/routes/stories.ts`, `server/routes/api/documents.ts`: batch them too.
7. `test/workers/migrations.test.ts`, `test/workers/smoke.test.ts`: the schema.

### Phase 2 — the routes and the host seam

1. `server/validate.ts`: `ScheduleBody`, `RunSchedulesBody`, `scheduleActionQuery`,
   `scheduleActionFilter`, `scheduleStatusQuery`.
2. `server/routes/schedules.ts`: the four routes.
3. `server/app.ts`: mount after `storyRoutes`.
4. `server/types.ts`, `server/index.tsx`: `Folio.runSchedules` and the type exports.
5. `test/workers/schedules.test.ts`, `test/workers/api-partition.test.ts`.

### Phase 3 — the demo, end to end

1. `examples/demo/wrangler.jsonc`: `triggers.crons`.
2. `examples/demo/src/index.tsx`: the `scheduled()` handler, with the batching loop.
3. `scripts/scheduled-test.mjs`.
4. `ROADMAP.md`: correct the alarm prediction; `docs/specs/README.md`: build order.

## Edge cases

- **Two editors schedule the same document at once** → the partial unique index makes
  the loser a `409 conflict` rather than two contradictory pending rows.
- **A document is unpublished by hand while a publish is scheduled** → the schedule
  stands and will republish it. Decision 5, and the answer `unpublish.md` already gave.
- **A schedule set for a document that is already live** → publishes. Decision 4.
- **The cron does not fire** (misconfigured, or a Cloudflare incident) → schedules stay
  pending and fire on the next sweep, however late. Nothing expires, and the manual
  `POST /schedules/run` is the catch-up.
- **Two sweeps overlap** (a long cron tick plus a manual run) → both read the same due
  rows and both may publish. Idempotent in effect: the same draft bytes, a second
  version row, and the second `completeScheduleStatement` deletes nothing. Not
  serialised, because the lock would have to live somewhere and the harm is one
  redundant version.
- **A schedule for an unrouted document** (a record, a singleton) → works and is
  meaningful: publishing a record makes it resolve as a live `reference`. There is no
  path to serve, which is the only difference.
- **500 documents due at 9am** → 25 per call, so 20 batches, which one cron tick's
  internal loop covers. A tick that runs out of time leaves the rest due, and the next
  minute picks them up.
- **The clock inside a Worker** → `Date.now()` advances only at I/O boundaries in
  workerd, which made a "schedule 5ms out, sleep 25ms" workers test flake under load.
  Tests inject `now`; the e2e script waits on real seconds against a live server.
- **The cache purge from a cron invocation** → `cachePurgeHooks` runs on `published`
  and `unpublished` regardless of who fired them, and `caching.md`'s rule that
  `cloudflare:workers`' `cache` export must be dereferenced *inside* the hook is what
  makes that work from a context with no request. Not observable locally — miniflare
  simulates no part of Workers Cache — so `scripts/cache-probe.mjs` against a
  deployment is the only check.

## Testing requirements

**Workers (`test/workers/`, real workerd):**
- `migrations.test.ts` — the columns, the defaults, both partial indexes, the absence
  of a third, the absence of a CHECK on either enum, the `explain query plan`.
- `schedules.test.ts` — `checkScheduleTime`; the writer's replace and
  failure-clearing; `clearSchedule`'s count; `listSchedules`' order, paging, filters
  and opt-in `total`; the sweep's every acceptance criterion, with an injected `now`;
  the four routes over `SELF`.
- `smoke.test.ts` — the table list.
- `api-partition.test.ts` — `/api/schedules` answers, its bare twin does not, and
  `/api/v1/schedules` 404s.

**End to end (`scripts/scheduled-test.mjs`):** the whole feature against a live dev
server — input refusals, list/replace/cancel, a real two-second wait then a sweep that
publishes and serves the page, the manual-publish-then-fire sequence, a scheduled
unpublish answering 410, a dry run, the delete cleanup, and batching by cursor.

**Unit:** none. Everything here is either SQL or a workflow over D1, and there is no
pure function in this feature that a Node test could reach that a workers test cannot.

## Dependencies

- `editing/unpublish.md` for `unpublish()` and the `'unpublished'` state.
- `platform/publish-hooks.md` for `alarmHookCtx` — the seam that lets a caller with no
  `ExecutionContext` fire the same after-commit hooks.
- `foundation/pagination.md` for the keyset codec, the `Page` envelope and the
  `{base}/api/` partition rule.
- **Host config:** a cron trigger in `wrangler.jsonc` and a `scheduled()` handler. No
  new binding, no queue, no paid plan.

## Out of scope

- **Admin UI.** Three agents are rebuilding the editor and the screens; the routes are
  shaped so a screen is obvious, and the surface gets wired separately.
- **A `{base}/api/v1` schedule surface.** A version segment is a promise, and nothing
  outside the admin reads this yet. Adding it later is a `v1` route over the same
  reader.
- **Timezone storage.** `at` is epoch ms UTC like every other timestamp here; which
  timezone an editor typed is a rendering concern, and storing it would make the
  column two facts.
- **Recurring schedules.** Nothing has asked, and "every Monday" needs a recurrence
  model no competitor's CMS ships either.
- **Scheduled checkpoints, moves or deletes.** `action` takes a third value with no
  DDL when something wants one.
- **Notifying an editor that a schedule failed.** There is no notification channel;
  `publish-hooks.md` is where a host would hang one, and `?status=failed` is what a
  screen reads meanwhile.
- **Serialising overlapping sweeps.** See the edge case: the lock would need a home
  and the harm is one redundant version row.

## Open questions

None.

## Implementation notes

All eleven architecture decisions landed as written, every acceptance criterion is
covered, and the three phases are one change.

**Where the commissioning brief was wrong, and it matters twice:**

- **`ROADMAP.md`'s "DO alarm per story" is not viable**, and the reason is not
  aesthetic. A Durable Object has one alarm and `StoryDO` already spends it on the
  debounced watermark (`story-do.ts:394`). The brief asked for this to be checked
  rather than assumed; checking it is what produced decision 2. `ROADMAP.md` has been
  corrected in place.
- **`publish()` does not throw for a document whose schema is behind the model.** The
  brief listed that among the failure cases to handle; it is not one. `publish`
  snapshots the draft as it stands and stamps `meta.schemaId` on the version
  *precisely so* a version can admit it is unmigrated. The three real failure causes
  are an unknown story, a transient dependency failure, and an `action` this code does
  not recognise.

**What landed beyond the plan's letter:**

- `checkScheduleTime` lives in `server/schedules.ts` rather than `validate.ts`, because
  the bound is relative to `now` and a valibot schema has no clock. `validate.ts`
  bounds what may reach the column; the module bounds what is a schedule.
- `deleteStoryStatement` returns a **fifth** array (`scheduleStatements`) and all three
  callers batch it. `CLAUDE.md` warns that it "returns four things now"; it returns
  five, and the warning still applies to the next person.
- The failure recorded by `recordFailure` is best-effort: a failure to *record* a
  failure logs and does not abort the sweep, leaving the row pending with `attempts`
  unchanged — a retry too many rather than a schedule abandoned without a trace.
- `MAX_SCHEDULE_HORIZON_MS` and the 500-character cap on `last_error` are both bounds
  the plan did not name.
- The demo's `scheduled()` handler logs per tick only when something happened, and
  logs each failure individually. A scheduled publish happens with nobody watching, so
  "the run that fired nothing" and "the run that could not" have to be tellable apart
  after the fact.

**Where a test had to change shape:** two HTTP tests originally scheduled 5ms ahead and
slept 25ms. They passed alone and failed twice under the full suite, because workerd's
`Date.now()` only advances at I/O boundaries. They backdate the row in D1 instead, and
the due-instant boundary is pinned separately with an injected `now`. The e2e script
keeps the real waits, which is what an e2e script is for.

**Tests added:** 48 workers — 41 in a new `schedules.test.ts` and 7 in a new
`schedules` block in `migrations.test.ts`, plus an extended table list in
`smoke.test.ts` and one more internal route in `api-partition.test.ts`. `pnpm test` is
**2,755 passing**, from a baseline of 2,707. Plus `scripts/scheduled-test.mjs` at
**42/42** and `scripts/history-test.mjs` still at 46/46, both run live against
`pnpm dev` from a freshly migrated and seeded local D1.

**One thing worth knowing before running any e2e script here:** `scripts/e2e.sh`'s
`pkill -f 'vite'` also matches **vitest**, so a run of it kills a concurrent
`vitest run` in the same checkout. Harmless alone and confusing with several agents in
one repo; `pkill -f 'vite/bin/vite.js'` is the narrow form.

**Deliberately deferred:** everything under *Out of scope*, and one thing worth naming
again — the admin surface. What a screen needs is small and is listed in the route
table above: `GET {base}/api/schedules?story=` for the editor's own top bar, the same
route unfiltered for a site-wide panel, and `GET {base}/api/stories?ids=` to resolve
titles, because `Schedule` deliberately carries none.
