-- Scheduled publish and unpublish: "this goes live on Tuesday", and "this comes
-- down on Friday".
--
-- `docs/specs/platform/scheduled-publishing.md` is the spec. The groundwork was
-- already laid: `server/publish.ts`'s `publish` and `unpublish` take a **story**
-- rather than a Request, and `routes/stories.ts` has said since spec 1 that the
-- story's own existence is "the workflow's to check, because a scheduled publish
-- has to check it too". This table is the missing half.
--
-- **A new table, not two columns on `stories`.** `stories.publish_at` /
-- `unpublish_at` is the smaller change and it was rejected: there is nowhere on a
-- story row to record *who* asked, how many times a run has failed, or why. A
-- scheduled publish that quietly never happens is the failure mode this feature has,
-- and a nullable timestamp has no room to say so — which is decision 3 of the spec.
-- A second table also keeps a schedule out of `COLS`, so every one of the eleven
-- readers in `server/stories.ts` is untouched.
--
-- **`scheduled` is deliberately not a fifth `StoryState`.** The four states
-- (`core/story.ts`) are mutually exclusive descriptions of what a document is doing
-- *now*, and `server/stories.ts`'s `STATE_EXPR` is a `case` that returns exactly
-- one of them. A schedule is a fact about the future, and it is orthogonal to all
-- four: a draft can carry one, so can a live page with an embargo end. Adding a
-- fifth value would mean a live page with a scheduled unpublish stopped answering
-- `?state=live` — a filter that no longer lists the page that is, in fact, live.
-- See the spec's architecture decision 1.

create table schedules (
  -- sch_<12 hex>, minted server-side.
  --
  -- A synthetic key rather than `primary key (story_id, action)`, and the reason is
  -- pagination: the list route pages by keyset over `(at, id)`, `server/keyset.ts`'s
  -- `Keyset` holds a **pair**, and the tiebreak has to be unique on its own. Two
  -- schedules for the same instant would need `(at, story_id, action)` — three
  -- components — to be total. Every other paged table here has a text primary key
  -- for exactly this reason.
  id         text primary key,
  -- The document. Informational rather than a foreign key *in the DDL*, matching
  -- every other cross-table reference in this schema except `sessions`: whether D1
  -- enforces foreign keys is a property of the database, so the cleanup is explicit
  -- instead (`deleteStoryStatement` batches `scheduleStatements` with the delete,
  -- and the sweep drops a schedule whose document has gone regardless).
  --
  -- Note the contrast with `redirects.story_id`, which is informational because a
  -- redirect deliberately *outlives* the story that created it. A schedule must not:
  -- an instruction to publish a document that no longer exists is not an instruction.
  story_id   text not null,
  -- 'publish' | 'unpublish'. **No CHECK constraint, deliberately** — the same
  -- reasoning `content_refs.kind` records in `0002_asset_refs.sql`: SQLite cannot
  -- widen a CHECK without rebuilding the table (`versions.kind` is the standing
  -- example of what that costs), and nothing but this library ever writes here.
  -- A third action — a scheduled checkpoint, say — would then cost no DDL at all.
  action     text not null,
  -- When it should happen: epoch **milliseconds, UTC**, like every other timestamp
  -- Folio stores. A schedule fires on the first sweep at or after this instant, so
  -- lateness is bounded by the cron's period and earliness is impossible. Rendering
  -- it in an editor's own timezone is the screen's job.
  at         integer not null,
  -- 'pending' | 'failed'. No CHECK, for the reason `action` gives.
  --
  -- **There is no 'done'.** A schedule that fires is *deleted*: the publish it
  -- performed already left a `versions` row attributed to `actor`, which is the same
  -- record a manual publish leaves, so a retained schedule row would be a second,
  -- weaker copy of history that nothing prunes. What is retained is a failure,
  -- because that is recorded nowhere else — and a table bounded by "pending, plus
  -- whatever is broken" is the set somebody would actually want to look at.
  status     text not null default 'pending',
  -- Who scheduled it: a `users.id`, `token:<name>`, or null under `auth: 'open'`.
  -- Passed straight to `publish(deps, story, actor)` when the sweep fires, so the
  -- version row and the `published` hook name the person who asked rather than the
  -- cron that ran.
  actor      text,
  created_at integer not null,
  -- Failed attempts so far. The sweep publishes and *then* clears the row
  -- (at-least-once, because the other order is at-most-once), so a transient D1 or
  -- Durable Object failure leaves the row pending and the next sweep retries it.
  -- After `MAX_SCHEDULE_ATTEMPTS` (server/scheduler.ts) it flips to 'failed' and
  -- stops, rather than retrying every minute forever.
  attempts   integer not null default 0,
  -- Why the last attempt failed. Null until one does. This column is the whole of
  -- "so is one that silently swallows a failure nobody ever sees": it is what
  -- `GET {base}/api/schedules?status=failed` shows.
  last_error text
);

-- The sweep: `where status = 'pending' and at <= ? order by at, id`.
--
-- **Partial on `status = 'pending'`, which is what makes a site with nothing
-- scheduled pay nothing for the feature.** An index over a partial condition that
-- no row satisfies is an empty B-tree, so the sweep is one indexed range probe that
-- touches no rows and returns immediately. A full index on `(at, id)` would instead
-- carry every failed row forever and be paid for on every write.
create index schedules_due on schedules (at, id) where status = 'pending';

-- At most one *pending* schedule per document per action. Rescheduling replaces
-- (`setScheduleStatements` deletes then inserts, in one batch), so "when does this
-- go live" always has exactly one answer — which is what a screen can show and a
-- queue of contradictory instructions could not.
--
-- Partial on `status = 'pending'` so a retained failure never blocks a fresh
-- schedule. It also serves `?story=&status=pending`, which is the editor's own
-- read: the index's condition implies the query's, so SQLite can use it.
--
-- A publish on Tuesday and an unpublish on Friday are two rows and two actions, so
-- a campaign window is representable without widening anything.
create unique index schedules_story_action
  on schedules (story_id, action) where status = 'pending';

-- **Deliberately no `schedules_story`.** `?story=` *without* a status cannot use
-- the partial index above, so that one query is a scan — over a table bounded by
-- "pending plus broken", which is small by construction. `stories_draft_updated`
-- was an index created for a query nobody had written and it cost every story write
-- for ten migrations; `assets` records the same refusal for its two new sorts.
-- `test/workers/migrations.test.ts` asserts the absence, so adding one later is a
-- deliberate act with a measurement behind it.
