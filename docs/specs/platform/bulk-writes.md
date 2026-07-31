# Feature: Bulk write endpoints

> **Group:** platform
> **Build order:** 20, per docs/specs/README.md
> **Size:** M ≈ a few days
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-07-31

## Summary

Content's selection bar can publish, unpublish, duplicate, move and delete, and it
does it as **N sequential calls from the browser** (`admin/ui/screens/Content.tsx`'s
`runBulk`). That works for the twelve rows somebody ticked and cannot be made to work
for the other thing `ui-architecture.md` decision 7a specifies: *select all matching
the filter*. `admin/ui/screens/content-model.ts:301` says why the affordance is
absent rather than disabled — "offering 'select all 51,420 matching' over per-item
client calls would mean fetching 51,420 rows to loop over them, which is the single
thing the shape exists to avoid".

This is dependency 7, the endpoint that removes that blocker: a selection is either a
list of ids or **a flag, a captured filter, an expected count and any exclusions**, and
the server re-runs the filter, checks the count once, and executes a batched job
resumable by a cursor. It is the second of `docs/completion-plan.md`'s delivery gaps,
and it needs no migration and no wire change — the whole feature is a filter the client
already knows how to build and a count the list header already displays.

## Ground truth

Verified against the tree at `6bc1c55` (2026-07-31).

**core (`packages/folio/src/core/`):**
- `story.ts:231` — `StoryFilter` is `{ parentId?, type?, state?, q?, locale? }`, one
  flat serialisable object, and `pagination.md` decision 9 names the three things that
  read it: a URL, a paged read, and **a captured selection**. This is the third.
- `pagination.ts:24` — `Page<T> = { rows, cursor, total? }`; `total` is absent unless
  asked for. `encodeCursor` / `decodeCursor` are the one codec, over a tuple of
  `string | number`.
- `protocol.ts` — `PROTOCOL_VERSION` is 4. **Nothing here touches the wire.** A bulk
  write is HTTP and the socket frames it produces are the ones `publish` already
  produces, one per document.

**server (`packages/folio/src/server/`):**
- `stories.ts:328` — `storyFilters(filter, { indexedText })` is the shared `where`
  builder, and `state` goes through `STATE_EXPR` rather than a stored column.
  **`parentId` was not read here**: the level reader took it positionally.
- `stories.ts:695` (before this spec) — `countStories(db, filter?, routed?)`, added for
  Home's cards, with its own comment saying it is "the property `pagination.md`
  decision 5 asks for when it says one count implementation serves the header and the
  bulk guard". The `routed` axis was a **positional boolean**, which a JSON selection
  has no way to express.
- `stories.ts:1416` — `updateStoryStatement` encodes every tree rule: the root's fixed
  slug, `Cannot move a story into its own subtree`, `under` constraints, unique slugs
  among siblings, fractional `ord` via `orderAt`, and the recomputed paths of the whole
  affected subtree plus the redirects for each vacated one.
- `stories.ts:1556` — `deleteStoryStatement` returns **five** things (`ids`, `paths`,
  `types`, `statement`, `redirectStatements`, `indexStatements`, `scheduleStatements`),
  all of which a caller must batch, and refuses the root and a singleton.
- `stories.ts:1336` — `duplicateStory` refuses a singleton *inside the reader*, "so a
  direct caller cannot route around it". The precedent for where `runBulk` puts its own
  refusals.
- **`updateStoryStatement`, `createStory` and `deleteStoryStatement` each begin with
  `listStories(db)` — an unbounded read of every story row** (`stories.ts:1434`,
  `:1205`, `:1612`). They need the sibling set and the subtree to derive `ord` and
  paths. That is the per-document cost of three of the five actions and the reason the
  default batch is small; see decision 8.
- `publish.ts:91` — `StorySelector = string | StoryMeta`, so a caller that already
  holds the row is not charged a second lookup. `publish` writes the version row,
  `published_doc`, the watermark and the `content_index` projection in one batch and
  fires `published`; `unpublish` is idempotent and reads no draft.
- `migrate.ts:36-101`, `reindex.ts:25-51`, `scheduler.ts:52-114` — the batched-job
  shape, three times: a `DEFAULT_*_BATCH`, a `MAX_*`, `continueFrom`, a per-item
  `failed: [{ …, reason }]`, a dry run, and **no server-side job record** — the caller
  passes the cursor back.
- `scheduler.ts:187` — the per-item `try`, with the comment "a sweep that died on one
  story and skipped the rest is the bug to avoid".
- `errors.ts:92-134` — `rethrow`'s table is the only thing that decides what a message
  may say. `UNIQUE constraint failed` becomes a `conflict` with the D1 text
  **replaced**, because "raw D1 text names tables and constraints".
- `errors.ts:65` — the envelope is exactly `{ error: { code, message } }`, and
  `FolioError` carries no room for structured data.
- `auth/roles.ts:145-183` — `CREATE` is `editor`/`content:write`, `MANAGE` is
  `publisher`/`content:write`, `PUBLISH` is `publisher`/**`publish`**. Three different
  gates across the five actions, and the token scopes differ too.
- `routes/stories.ts` and `routes/api/documents.ts` **each held their own copy** of the
  delete batch, the purge-after-commit ordering and the two patch hooks — the API's copy
  under a comment reading "reimplementing either would mean two orderings to keep
  right", directly above a reimplementation of both.
- `app.ts:59-79` — a version segment is a promise; `{base}/api/*` with none is internal.

**admin (`packages/folio/src/admin/`) — read, not touched:**
- `ui/screens/content-model.ts:312` — `Selection` is `ReadonlySet<string>`, with the
  comment recording that select-all-matching is deliberately absent because these
  endpoints do not exist.
- `ui/screens/content-model.ts:386` — `reportOf(action, done, failures)` takes
  `failures: { title, message }[]` and builds the sentence. The report shape here is
  written to feed it with no mapping step.
- `ui/screens/Content.tsx:280` — `runBulk`, N sequential `fetch`es, with a comment on
  why sequential rather than `Promise.all`: every one of these writes reads the story
  table, so forty in parallel is forty readers racing the same rows.
- `ui/screens/Content.tsx:828` — `writeFor`, which passes **`index: 0` for every
  document of a bulk move**, so a moved set lands reversed.

**tests:**
- `api-partition.test.ts` enumerates every internal route and asserts it 404s under
  `/api/v1`. Its `routed()` helper uses **GET**, so a POST-only route cannot go in that
  list as it stands.
- `recency.test.ts:98` pins `countStories`, including the `routed` axis.
- `schedules.test.ts` is the model for a runner test: the real workflows, a stubbed
  Durable Object, and the sweep's own acceptance criteria.

## Owner decision checkpoints

1. **Five routes, not one `/bulk/:action`** — decision 1. The gate is per action and
   `requireAccess` is declared at the mount.
2. **No server-side job record** — decision 2. A half-finished job is a *reported*
   partial application, not a corrupt state, and the alternative is a queue.
3. **The count is the ceiling as well as the guard** — decision 5. It is the answer to
   "the guard is checked once, so what stops a growing set enlarging the run".
4. **Duplicate refuses select-all** — decision 6. It is the one action that adds to the
   set it is walking.
5. **No admin UI, and no host-facing `folio.bulk`** — *Out of scope*, both with reasons.

## User stories

### Publisher publishes a filtered set safely
**As** a publisher **I want** "publish all 51,420 matching" to send a filter and a
count rather than 51,420 ids **so that** the operation is possible at all, and is
refused if the set moved underneath me.

### Publisher re-confirms in one click
**As** a publisher **I want** a refusal to tell me the new number **so that** I can
agree to it immediately instead of guessing what changed.

### Editor tidies twelve pages
**As** an editor **I want** to tick twelve rows and move them into a section **so
that** I am not opening twelve pages to do it, and they arrive in the order I saw them.

### Anybody finds out what did not happen
**As** anybody running a bulk action **I want** the refusals named **so that** "40 of
42" is something I can act on rather than a mystery.

### Operator does not take the Worker down
**As** an operator **I want** a run over 51,420 documents to be batched **so that** one
request never exceeds a Worker's CPU limit, and a big job finishes.

## Architecture decisions

### 1. Five routes, one per action — not `POST {base}/api/bulk/:action`

`POST {base}/api/bulk/publish`, `/unpublish`, `/duplicate`, `/move`, `/delete`.

**The gate is the reason, and it is not a style preference.** Each bulk route carries
the *same* `requireAccess` its single-document twin carries: `PUBLISH` for publish and
unpublish, `CREATE` (editor+) for duplicate, `MANAGE` (publisher+) for move and delete.
Publishing forty pages must be neither more nor less privileged than publishing forty
pages one at a time.

One route cannot do that. `requireAccess` is middleware declared at the mount, so an
action read out of a path parameter or a discriminated body leaves two options, both
worse:

- **Gate inside the handler**, after the body is parsed. That hides the gate from the
  place `identity-and-access.md` decision 5 insists it is visible — beside the handler
  rather than in a table of paths somewhere else.
- **Gate on the union of all five.** For a session that is `publisher`, which is
  survivable. For an **API token** it is not: scopes are `content:write` and `publish`,
  and the union demands both, so a token holding only `publish` could not bulk publish
  while it can publish each document individually. A capability that shrinks when you
  batch it is a bug in the surface.

The bodies fall along the same seam and confirm it: move takes a destination, delete
takes the redirect switch, the other three take nothing but a selection. A discriminated
body would express that as a variant per action — five schemas either way, with the
gate moved somewhere less visible as the only difference.

**Rejected: `POST {base}/api/stories/bulk`** with the action in the body. Same gate
problem, plus it reads as a sub-resource of `stories` while duplicate creates rows and
delete removes subtrees.

What is *not* duplicated is the work: one `runBulk` behind all five (`bulk.ts:181`),
and five route handlers holding a body schema and a status code.

### 2. The job lives in the caller's hand between batches, and there is no job record

`continueFrom` comes back in the report and the caller passes it in, exactly as
`runMigrations`, `reindex` and `runSchedules` already work. No `bulk_jobs` table, no
cron advancing it, no id to poll.

**The hazard this leaves is real and small: a client that stops calling.** Close the tab
after batch three and 75 documents are published and 51,345 are not. That is worth
saying plainly, and then measuring against what it replaces — **today's client loop has
exactly the same failure**, one document at a time, and against what fixing it costs:

- A `bulk_jobs` row holding the action, the selection, the cursor and the counts.
- A sweep to advance it, which means a second cron consumer and a decision about
  concurrency with the first.
- A resumption story for each action, of which **duplicate is not idempotent** — a job
  resumed at an uncertain point can produce a second copy.
- A surface for a job nobody is watching: listing them, cancelling them, and reporting a
  job that failed at 3am, which is the whole of `scheduled-publishing.md` decision 4
  again for a feature nobody asked to be asynchronous.

And the property that makes it optional: **a half-finished bulk write is not a corrupt
state.** Every document is its own transaction, the tree is consistent after each one,
and decision 7 already establishes that nothing here is atomic and the UI must not imply
it is. A partial run is the honest outcome, and the report is what says so.

So: not now, and named rather than forgotten. What makes it *cheap later* is that the
cursor is already opaque and self-describing — a job record would store the same string.

**Rejected: holding the response open and streaming progress.** It is the one shape that
cannot work: a stream has to hold a request open across exactly the CPU limit the
batching exists to stay under (`migrate.ts:19-22` rejected it for this feature's sake
first).

### 3. The count is the guard, checked once, and `countStories` is the one that does it

`FilterSelection.expected` is the number the person was shown — `total` from `?count=1`
on the list they were looking at. The server re-runs the captured filter through
**`countStories`** (`stories.ts:730`), compares, and refuses on a mismatch before
anything is written. Optimistic concurrency, with the count as the version.

`pagination.md` decision 5 required this and said why: one `count(*)` implementation
serves the header and the guard, "and they must not drift, which they would if the
header got a cheap approximation baked into the envelope". So the guard is not a second
count — it is a call to the function Home's cards already call.

**Once, at the start, and never per batch.** Re-checking every batch would make a long
job un-completable on any site with live editors: somebody publishes a draft in minute
two and a 51,420-document run refuses at batch 40. The guard's purpose is to confirm
*intent*, not to freeze the database.

**Rejected: no guard at all**, executing whatever currently matches. That is the failure
this exists to prevent — a bulk publish quietly including nine pages nobody looked at.

**Rejected: a guard per batch.** See above; it makes the feature unusable at the size it
exists for.

### 4. `routed` moves onto `StoryFilter`, because a captured filter has no positional arguments

`countStories(db, filter, routed)` becomes `countStories(db, filter)` and
`StoryFilter` gains `routed?: boolean`. `storyFilters` also learns `parentId`.

**Without this the guard refuses every select-all Content can make.** Content's flat list
counts with `path is not null` hardcoded in the reader; a guard counting the same filter
without that clause counts records too, so `expected` and `actual` differ by however many
unrouted documents the site has, forever. A mismatch that cannot be re-confirmed is a
wall, which decision 7a forbids by name.

The general form of the problem: a list route states its scope **positionally** because
for a list the scope is an identity (`listStoryLevel(db, parentId)`,
`listDocumentPage(db, type)`), and a captured selection is JSON with no positions at all.
Moving both axes into the filter is what lets the third reader of `StoryFilter` reproduce
the set the first two produced.

The cost, paid honestly: `storyFilters` now emits clauses no list route sends, so a
filter carrying `routed: true` into `listStoriesFlat` would emit `path is not null`
twice (a no-op) and `routed: false` would emit a contradiction (an empty list).
`storyFilterQuery` reads neither off a query string, so no route can produce one; the
bulk body is the only source, and the constraint is stated at `storyFilters` itself.

**Rejected: a `scope` field beside `filter` in the selection.** It keeps `StoryFilter`
untouched and makes the selection carry two things that both narrow a list, so a reader
would have to remember to apply both — which is the drift decision 9 exists to prevent.

**Rejected: leaving `countStories`' third argument and adding a fourth for `parentId`.**
Two ways of saying the same thing, and the guard would be free to disagree with the
header depending on which one the caller reached for.

### 5. The count is also the job's ceiling

A run acts on at most `expected - exclude.length` documents, however many batches it
takes. The counter lives in the **cursor**, so it survives the caller re-calling.

This is what makes a once-checked guard mean something. Without it, "delete all 12
matching" walks the filter until it is exhausted — and if nine drafts are created while
it runs, it deletes 21. With it, the run stops at 12 and the nine survive. **The number
somebody agreed to is the number of documents that get written to**, which for a
destructive action is the property worth having.

It also makes the walk's one weakness harmless. The walk is `id > cursor` over the
captured filter, re-read per batch, so a row created mid-job with an id ahead of the
cursor *can* be included — the set is not frozen (decision 3 says why it must not be).
The ceiling bounds that to "some substitution within the agreed count", never "more than
was agreed".

`exclude` is applied in **SQL** (`id not in (…)`) rather than by filtering rows after
reading them, so a batch does `limit` documents of *work* rather than reading 25 rows and
skipping 24. It is bounded by what a person can tick off, which is what makes
`id not in (…)` acceptable here and nowhere general.

**Rejected: no ceiling, on the grounds that the filter defines the set.** It does, at one
instant; the job spans many.

**Rejected: freezing the set with a snapshot bound** — `created_at <= startedAt` — which
was the first attempt. Two things kill it: `stories.created_at` defaults to
`unixepoch()` (**seconds**) while every other timestamp written to that table is
`Date.now()` (**milliseconds**), so the comparison is a unit trap waiting for a reader;
and it only excludes *new* rows, so it does nothing about a row that was edited into the
filter.

### 6. `duplicate` takes an explicit id list and refuses a select-all

Refused in `runBulk` rather than at the route, so a direct caller cannot route around it
— the placement `duplicateStory`'s singleton refusal already uses.

**Duplicate is the one action that adds documents to the very set it is walking.** The
copy of a draft is a draft, so "duplicate everything matching `state: draft`" is a
question whose answer changes while it is being answered: the walk resumes after the last
id, a copy's minted id can sort after it, and the job duplicates a duplicate. The other
four remove rows from the set (publish, unpublish, delete) or leave it alone (move).

Fixing it properly would mean excluding what the job created, which means **remembering
the ids it created** — materialising the id list this whole shape exists to avoid. That
is not a trade, it is a contradiction, so the affordance is refused with a message
saying why.

**Rejected: duplicating select-all anyway and accepting copies-of-copies.** It produces
the right *number* of documents and the wrong ones, silently.

**Rejected: excluding rows created after a start instant.** Decision 5's rejected
snapshot bound, with the same unit trap.

### 7. The refusal is a 409 whose body is the error envelope *plus* the counts

```json
{
  "error": {
    "code": "conflict",
    "message": "15 documents matched when you chose them and 16 match now. Check the number and try again."
  },
  "refused": "count",
  "expected": 15,
  "actual": 16
}
```

Three constraints meet here. It has to be a **409**, because a well-formed request was
refused over the state of the world. It has to carry the **new count**, because
`ui-architecture.md` decision 7a requires re-confirming to be one click. And
`errors.ts`' envelope is exactly `{ error: { code, message } }` with nowhere to put a
number.

A superset of the envelope satisfies all three. `error` stays exactly where every client
already looks, so a generic fetch wrapper shows a readable sentence without knowing this
route exists; the machine-readable numbers sit beside it for the client that does. And
`errors.ts` remains the only place a *thrown* error becomes JSON: `runBulk` returns the
refusal as a **value** (`BulkRefusal`, `bulk.ts:118`), the way `StoryDO.commit` answers a
rejection, and the route turns it into a response. A refusal is an outcome of the
request, not an error in it.

**Rejected: widening `FolioError` with a `details` object.** It changes the one envelope
every route in the library shares, for one route family's benefit.

**Rejected: a bespoke body with no `error` key.** The existing client code path reads
`error.message` and would show `HTTP 409` — a wall, which is the thing being avoided.

**Rejected: 200 with `{ refused: 'count' }`.** A refusal that answers OK is a refusal
somebody's error handling will miss.

**And the answer to `ui-architecture.md` open question 2 — "does a refused bulk job
report *what* changed?" — is no, and it is structural rather than a cost/benefit
call.** Saying *which* documents joined or left the set means comparing the old set to
the new one, and the old set was never materialised: that is the entire point of the
shape. The cheap approximation (a second query for "rows matching now, minus the ones I
would have touched") is still 51,420 ids. What replaces it is already specified: the
refusal names both numbers, and decision 7a's own recovery path is *Show only selected*,
which switches the view to the captured conditions and answers "what is in there" as an
ordinary paged read. A refusal points at that; it does not try to be it.

### 8. One `runBulk`, and the per-document work is the single-document workflow

`server/documents.ts` (new) holds `duplicateDocument`, `moveDocument` and
`deleteDocument`: the three write workflows that existed only inline, in routes, twice
each. `runBulk` calls them, and so do `routes/stories.ts` and
`routes/api/documents.ts`.

The alternative was a third copy, and the second copy is already visibly wrong: the v1
API's delete carries the comment "reimplementing either would mean two orderings to keep
right" above a reimplementation of both. `deleteStoryStatement` returns five statement
arrays a caller must batch, in an order that matters (`CLAUDE.md` warns that it "returns
four things now" — it returns five), then a purge that must come *after* the commit, then
a hook that must fire *regardless* of the purge. Three copies of that is one copy that
forgets the schedules.

So a bulk delete purges the Durable Objects and fires `deleted` exactly as a single
delete does, and a bulk move writes the same redirects and fires both `pathsChanged` and
`updated`. Not because `runBulk` remembers to, but because there is one implementation.

`BulkDeps` is `PublishDeps & DocumentDeps` (`bulk.ts:165`) — nothing new, just both
halves, assembled in one place.

**Rejected: `runBulk` calling the HTTP routes internally.** It is the shape a client
already has, and it would make every bulk action pay request parsing, middleware and
auth resolution per document.

**Rejected: leaving the workflows inline and writing a third copy in `runBulk`.** It is
the smaller diff and it is how the delete batch loses a statement.

The honest cost of *not* rewriting more: `updateStoryStatement`, `createStory` and
`deleteStoryStatement` each read **every story row** to derive paths and fractional
indices, so a batch of 25 moves is 25 full-table reads. That is why
`DEFAULT_BULK_BATCH` is 25 rather than 200, and narrowing those reads is named in
*Out of scope* rather than smuggled into this spec.

### 9. Sequential per document, with each one in its own `try`

The same discipline `runMigrations` and `runSchedules` apply, for two reasons that both
already exist in the codebase:

- **A run that died on one document and skipped the rest is the bug to avoid**
  (`scheduler.ts:155`). Each document is attempted alone and a refusal is a line in the
  report.
- **Not `Promise.all`.** Every one of these writes reads the story table and derives
  `ord` or paths from it, so 25 in parallel is 25 readers racing over the same rows —
  two moves into the same parent computing the same fractional index from the same
  snapshot. `Content.tsx:275` already knew this from the client side. Sequential also
  makes the failure report deterministic, which is what lets a test assert it.

### 10. A failure message goes through `rethrow`, or it does not go at all

`BulkFailure.message` is prose rendered straight into a toast, and the messages
`stories.ts` throws include D1's own `UNIQUE constraint failed` text, which names a table
and an index. So `reasonOf` (`bulk.ts:440`) runs the error through `rethrow` — the one
translation table — and takes the message only if it came back a `FolioError`. Anything
`rethrow` declines to translate is a bug or a platform failure: it gets the generic
message and the real one goes to the log, which is exactly what `app.onError` does for a
request, applied per document.

**Rejected: `String(err)` per item**, which is what a first pass writes. It publishes
schema details to whoever clicked a button.

### 11. The report feeds `reportOf`, and says which numbers are the call's

`{ action, done, failed, total, seen, continueFrom, dryRun }`.

`done` and `failed` are **this call's**; `total` and `seen` are the **job's**. That
asymmetry is deliberate and is the same one `MigrateReport` has (`stories` is per call,
`behind` is global), because the server cannot know what an earlier call did and a
progress display cannot work without the job's numbers.

`failed` is `{ id, title, message }[]` — **`message`, not the `reason`
`MigrateFailure` and `ScheduleFailure` carry**. The audience differs: those two are
diagnostics for whoever reads a report, and this one is client-facing prose whose
consumer is `reportOf(action, done, failures)`, which takes `{ title, message }[]`.
Naming it `reason` would buy consistency with two runners nothing renders, at the price
of a mapping step in the one caller that exists — and a mapping step is where a title
becomes `undefined`.

There is deliberately **no `remaining`**. `runSchedules` has one and calls it "a
diagnostic, never a loop condition"; here it would be worse than useless — for `move`
the filter still matches every document afterwards, so `remaining` would never fall and
a `while (remaining > 0)` loop would never end. **Loop on `continueFrom`.**

### 12. The cursor is `(lastId, seen)`, and the walk is by `id`

`encodeCursor([lastId, seen])`, decoded by `runBulk` (`bulk.ts:417`).

**By `id`, not by any ordering a screen offers.** The set being walked changes as it is
walked: a publish removes each row from `state = 'draft'`, a delete removes it from
everything. `id` is the primary key and no write here moves it, which is why
`storiesBehind` and `publishedDocsAfter` walk by it too. A keyset over
`coalesce(draft_updated_at, updated_at)` would resume after a value the job had just
changed.

The second component is not a sort key at all — it is the ceiling's counter — which is
why this is `encodeCursor` directly rather than a `Page<T>`. Keeping it inside the opaque
cursor rather than in the body means a caller cannot enlarge the allowance by editing a
number.

For an **explicit id list** the two components read differently and both are needed:
`seen` is the slice offset (the client re-posts the same array), and `lastId` is a
consistency check against `ids[seen - 1]`. A mismatch is a 400 rather than something to
absorb, because the two ways of absorbing it are skipping documents and doing some of
them twice — and duplicate is not idempotent. The check runs *before* the ceiling check,
so an exhausted allowance cannot answer a changed list with a placid "nothing left to
do".

A client can of course fabricate a cursor and skip the count guard. Worth naming, and it
buys nothing: the guard confirms intent, the role check is the security boundary, and a
caller authorised to post this could post the ids instead.

### 13. One endpoint serves both kinds of selection, and a mixed body is refused

`{ ids: [...] }` or `{ all: true, filter, expected, exclude? }`, as a union — and the
two options are **`v.strictObject`**, which nothing else in `validate.ts` uses.

One endpoint because the *action* half of the request is identical either way and the
selection is one argument with two shapes; two endpoints would make ten routes and force
a client to choose a URL by selection mode.

The strictness is the one place this file's usual tolerance is wrong. Everywhere else an
undeclared key is stripped in silence and that is right — a stale tab still sending
`actor` is not asking for anything. Here a stripped key changes **which documents get
written to**: `{ ids, expected }` would become a plain id list with the count guard
quietly dropped, and `{ all: true, filter, expected, ids }` would ignore the ids
entirely. Both are silent, and both are wrong in the direction of doing more than was
asked.

`expected` is required with `all` and unrepresentable without it. An explicit list needs
no count: **the ids are the version of the set**, and one that has since been deleted is
reported as a single named failure rather than refusing the other eleven.

### 14. A bulk move lands the set in walk order, and `delete` keeps `?redirect`'s default

Two small behaviours that are the product's, not the implementation's.

**Move**: `index` is where the *first* document lands among its new siblings, and each
one after it goes below. `Content.tsx:844` passes `index: 0` per document, which lands
the set **reversed** — visible the moment somebody moves three pages. The job's own
position is added to the caller's `index`, so the order survives a batch boundary too.

**Delete**: `redirect` defaults to **true**, as `DELETE {base}/api/stories/:id` does
(`redirects.md` decision 4). A bulk delete has to leave the redirects a hundred single
deletes would, or "delete these forty pages" is a different operation from doing it forty
times. It lives in the **body** rather than the query string, unlike the single-document
route, because everything else about a bulk call is in the body and a caller assembling
one should not have to know that one parameter went somewhere else.

## Wire & schema changes

### D1 migration

**None.** The guard is a `count(*)` over the same filter the list route already counts,
the job's state is one opaque string in the caller's hand, and every write is one the
schema already supports. `migrations.test.ts` is untouched, deliberately: nothing here
adds a table, a column or an index.

### Core types

Additive, in `core/story.ts`, and here rather than in `server/` for the reason
`ScheduleAction` and `StoryFilter` are: the values travel in a URL and a body, so the
screen that writes them and the runner that answers share one vocabulary.

- `BulkAction = 'publish' | 'unpublish' | 'duplicate' | 'move' | 'delete'` — the same
  five `admin/ui/screens/content-model.ts`'s `BULK_ACTIONS` lists.
- `IdSelection`, `FilterSelection`, `BulkSelection`.
- `StoryFilter.routed?: boolean` (decision 4).

No `Doc`, `Blok`, `Field`, `Mutation`, `Resolution` or protocol change. **`PROTOCOL_VERSION`
stays at 4**: a bulk write is HTTP, and the socket frames it produces are the ones
`publish` produces, one per document.

### New or changed routes

All internal (`{base}/api/*`), so they may change shape in any commit. Nothing lands
under `/api/v1`: that would be a promise to somebody's script about a surface only the
admin reads.

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `{base}/api/bulk/publish` | `PUBLISH` | `{ selection, batch?, continueFrom?, dryRun? }` | `BulkReport`, or `409` + refusal |
| POST | `{base}/api/bulk/unpublish` | `PUBLISH` | the same | the same |
| POST | `{base}/api/bulk/duplicate` | `CREATE` | the same, `selection.all` refused | the same |
| POST | `{base}/api/bulk/move` | `MANAGE` | the same plus `parentId` (**required**, nullable) and `index?` | the same |
| POST | `{base}/api/bulk/delete` | `MANAGE` | the same plus `redirect?` (default **true**) | the same |

```ts
// request
{
  selection:
    | { ids: string[] }                                              // ≤ 500
    | { all: true, filter: StoryFilter, expected: number, exclude?: string[] },
  batch?: number,          // 1–200, default 25
  continueFrom?: string,   // the previous call's cursor
  dryRun?: boolean,
}

// 200
{
  action: BulkAction,
  done: number,            // this call
  failed: { id, title, message }[],   // this call
  total: number,           // the job: ids.length, or expected − exclude.length
  seen: number,            // the job, this call included
  continueFrom: string | null,        // loop on this
  dryRun: boolean,
}

// 409 — the set moved
{ error: { code: 'conflict', message }, refused: 'count', expected, actual }
```

Errors: `400` for a malformed or mixed selection, an empty id list, a selection over 500
ids, a missing `parentId` on move, a malformed cursor, a cursor that disagrees with the
posted id list, or a select-all duplicate. `403` for the wrong role or scope. `409` for a
count mismatch. Per-document refusals are **200 with `failed`**, never a status.

### Host-facing API

**None**, and that is a decision. `folio.migrate`, `folio.reindex` and
`folio.runSchedules` exist because each is an *operational* task a host's own script or
cron has to be able to run. A bulk write is an admin-UI capability over a selection a
person made; a script wanting to publish 500 documents already has `folio.publish`-shaped
access through the v1 API and a loop it controls. Adding a method for symmetry would be a
public surface with no caller.

## Acceptance criteria

### Select-all-matching is possible at all
```
GIVEN a site with 51,420 pages matching `state: draft`
WHEN a publisher posts { all: true, filter: { state: 'draft', routed: true }, expected: 51420 }
THEN no request carries 51,420 ids
AND the run is batched, resumable by `continueFrom`, and reaches every document
```

### The guard refuses a set that moved, and says what it moved to
```
GIVEN a selection captured when 15 pages matched
WHEN somebody else creates a sixteenth before the run starts
THEN the response is 409 with { refused: 'count', expected: 15, actual: 16 }
AND nothing has been written
AND re-posting with expected: 16 runs
```

### The guard is not re-checked mid-job
```
GIVEN a batched run that has completed one batch
WHEN a page is created that matches the captured filter
THEN the next call with `continueFrom` runs rather than refusing
```

### The count is the ceiling
```
GIVEN a selection of 16 live pages and a batch size of 2
WHEN two more pages are published while the run is walking
THEN the run unpublishes exactly 16 documents and stops
AND two pages are still live
```

### Failures are named, and one does not stop the rest
```
GIVEN a selection holding the root story and one ordinary page
WHEN it is deleted in bulk
THEN the page is deleted and reported under `done`
AND the root appears in `failed` with "Cannot delete the root story"
AND the response is 200
```

### A bulk write is the single write, N times
```
GIVEN a page with a child and a published snapshot
WHEN it is deleted in bulk
THEN its subtree, versions, index rows and schedules go in one batch
AND every descendant's Durable Object is purged
AND a redirect to the parent exists for every vacated path
AND the `deleted` hook has fired
```

### Each route's gate is its twin's
```
GIVEN a signed-in editor
WHEN they post to /bulk/duplicate
THEN it runs, because CREATE is editor+
WHEN they post to /bulk/publish, /bulk/move or /bulk/delete
THEN each is 403
```

### A moved set arrives in the order it was seen
```
GIVEN three pages selected in order and a destination
WHEN they are moved in bulk
THEN they are the destination's children in that order, not reversed
AND every path is recomputed from the new parent
```

### Nothing lands on the versioned surface
```
GIVEN POST {base}/api/v1/bulk/publish
THEN it is 404
```

## Implementation plan

### Phase 1 — the selection, the count and the reader

1. `core/story.ts`: `BulkAction`, `IdSelection`, `FilterSelection`, `BulkSelection`,
   `StoryFilter.routed`.
2. `server/stories.ts`: `storyFilters` learns `parentId` and `routed`;
   `countStories(db, filter?)` loses its positional third argument; `storiesMatching`.
3. `server/routes/stories.ts`: `/counts` passes `{ routed: true }`.
4. `test/workers/recency.test.ts`: the two call sites.

### Phase 2 — the workflows, extracted

1. `server/documents.ts`: `duplicateDocument`, `moveDocument`, `deleteDocument`.
2. `server/routes/stories.ts` and `server/routes/api/documents.ts`: both become
   translation layers over them, each keeping its own answer to absence.

### Phase 3 — the runner and the routes

1. `server/bulk.ts`: `runBulk`, the report, the refusal, the cursor, the two constants.
2. `server/validate.ts`: `SELECTION`, `BulkBody`, `BulkMoveBody`, `BulkDeleteBody`.
3. `server/routes/bulk.ts`: the five routes.
4. `server/app.ts`: mount after `storyRoutes`.

### Phase 4 — the tests

1. `test/workers/bulk.test.ts`: the guard, the ceiling, batching, the five actions, the
   report, the routes, the role gates, the reader.
2. `test/workers/api-partition.test.ts`: the internal **POST** surface, which its
   GET-based helper could not see.
3. `scripts/bulk-test.mjs`.

## Edge cases

- **A selection holding a page and one of its own descendants, deleted** → the ancestor's
  delete takes the descendant, and the descendant is then counted under `done`, not
  `failed`. The caller asked for it to be gone and it is; reporting a failure would make
  correct behaviour look broken. Same reasoning as `unpublish`'s idempotence.
- **An id in an explicit selection that no longer exists** → one named failure ("No such
  document"), except for `delete`, where it is `done`.
- **A row leaves the filter as the job runs** (a published draft) → it is behind the
  cursor, so it is never revisited. The walk is by `id` for exactly this.
- **A row joins the filter mid-job with an id ahead of the cursor** → it may be included,
  bounded by the ceiling. Freezing the set instead would need the guard to be a snapshot,
  which decision 3 rejects.
- **A batch of documents all refused** → `done: 0`, `failed` full, and the cursor still
  advances. This is why the loop condition is `continueFrom` and not a count.
- **Two overlapping runs of the same selection** → both walk the same rows and both act.
  Idempotent in effect for publish, unpublish and move; a duplicate produces two copies,
  and a delete's second attempt reports `done` for rows already gone. Not serialised,
  because the lock would need a home and the harm is small — the same trade
  `scheduled-publishing.md` makes for overlapping sweeps.
- **A `q` filter captured from the Documents screen** → the guard would drift. That
  screen's reader passes `indexedText: true`, so its header count reaches
  `content_index`'s values and `countStories` does not. Not a live problem —
  `ui-architecture.md` gives bulk actions to **Content** only, whose two views both
  search title, slug and path — and named here because a Documents selection bar would
  need the axis on `StoryFilter` before it could be trusted, exactly as `routed` was.
- **`expected: 0`** → allowed, and it runs a job with an empty ceiling, reporting
  `done: 0`. Refusing it would mean a screen has to special-case "nothing matches", and
  the honest answer to "act on the zero matching documents" is that it is done.
- **A batch larger than `MAX_BULK_BATCH`** → clamped, not refused, per `limitParam`'s
  rule: an out-of-range limit has an obvious right answer.
- **A publisher who cannot reach a Durable Object** → that document's publish throws, is
  reported under `failed` with the translated message, and the rest of the batch runs.
  There is no retry: unlike a schedule, somebody is watching, and the selection is still
  in front of them.

## Testing requirements

**Workers (`test/workers/`, real workerd):**
- `bulk.test.ts` — the guard passing, refusing and re-confirming; the ceiling under a
  set that grows; exclusions; batching to exhaustion by cursor; the cursor consistency
  check and a malformed cursor; each of the five actions against the real workflows
  (including the version rows a publish leaves, the object a duplicate seeds, the objects
  a delete purges and the redirects it writes); the tree rules refusing one document
  without failing a batch; the report's per-call and per-job numbers; a dry run;
  `rethrow`-translated failure prose; the five routes over `SELF` including the 409 body;
  the role gates against a `createFolio` with a provider configured; `storiesMatching`.
- `api-partition.test.ts` — the internal POST routes answer, do not answer a GET, and
  404 under `/api/v1` and `/api/v2`.
- `recency.test.ts` — `countStories` over `{ routed }` as a filter key.

**End to end (`scripts/bulk-test.mjs`):** the whole feature against a live dev server —
and specifically **the guard racing a real write**, which is the one thing a workers test
stages rather than observes: the count comes off a real `?count=1` header, a second real
request creates a page before the button is pressed, and the 409 comes back over HTTP
with the new count in it.

**Unit:** none. Everything here is SQL, a workflow over D1, or an HTTP shape; the one
pure function (`encodeCursor`) already has unit coverage.

## Dependencies

- `foundation/pagination.md` for `StoryFilter`, the cursor codec, the opt-in count and
  the `{base}/api/` partition rule.
- `platform/redirects.md` for the delete's redirect default.
- `editing/duplicate-and-paste.md` for `duplicateStory` and the singleton refusal.
- `platform/publish-hooks.md` and `platform/caching.md` for the hooks each workflow
  fires, which is what a bulk write must not skip.
- **No new binding, no migration, no host config.**

## Out of scope

- **The admin UI.** The routes are shaped so Content's selection bar is a small change;
  what it needs is listed in the implementation notes below.
- **A `{base}/api/v1/bulk` surface.** A version segment is a promise, and nothing outside
  the admin reads this yet.
- **A server-side job record.** Decision 2, with the cost named.
- **`folio.bulk(env, …)`.** No caller; see *Host-facing API*.
- **Bulk field editing** (Payload's Edit, WordPress's Bulk Edit panel).
  `ui-architecture.md` decision 7a rejects it for the first pass with a reason — a second
  editing surface with its own validation and preview problems — and the machinery for it
  is `schema-migrations.md`'s runner rather than this.
- **Narrowing `listStories` out of `updateStoryStatement`, `createStory` and
  `deleteStoryStatement`.** It is the largest remaining per-document cost here (decision
  8) and it is a rewrite of the tree's write path, which deserves its own spec rather
  than being smuggled in behind a bulk endpoint.
- **Bulk scheduling** (`POST /bulk/schedule`). One `action` value away and nothing has
  asked; `scheduled-publishing.md` already parks a third action the same way.
- **Bulk actions on the Documents screen.** No selection bar is specified there, and the
  `q`-scope drift in *Edge cases* is what would have to be settled first.

## Open questions

None. `ui-architecture.md`'s open question 2 is answered in decision 7.

## Implementation notes

All fourteen decisions landed as written. **No migration, no wire change, no new table**
— the guard is a `count(*)` and the job's state is one opaque string.

**What the brief got right and what it left to be found:**

- The brief asked whether a half-finished job is a real hazard. It is a *reported*
  partial application rather than a corrupt state, which is what makes decision 2
  defensible — but the finding that settles it is that **duplicate is not idempotent**,
  so a server-resumed job needs an exactly-once story the other four do not.
- **The count being checked once needed a second mechanism, and the brief did not name
  it.** "Validated once, at the start" leaves nothing to stop a growing set enlarging the
  run, and the first two candidate fixes both failed: a `created_at` snapshot bound is a
  unit trap (that column defaults to `unixepoch()` — **seconds** — while `updated_at` is
  written as `Date.now()`), and remembering created ids is materialising the id list. The
  ceiling in the cursor is decision 5, and it is the one design idea here that is not in
  `ui-architecture.md`.
- **`routed` had to move onto `StoryFilter` before the guard could work at all**
  (decision 4). Without it every select-all Content makes counts records too and is
  refused forever — a wall, which is the exact failure decision 7a forbids. This is the
  concrete form of `pagination.md` decision 5's warning about drift, and it was invisible
  until the third reader of `StoryFilter` existed.
- **The two existing copies of the delete batch were worse than the comment admitted.**
  `routes/api/documents.ts` says "reimplementing either would mean two orderings to keep
  right" directly above a reimplementation of both. `documents.ts` is what a third caller
  forced, and it is a net deletion at the two call sites.

**What landed beyond the plan's letter:**

- `wasRefused(outcome)` is exported rather than leaving callers to write `'refused' in
  outcome`, so the narrowing is one function and tests read as prose.
- `v.strictObject` appears in `validate.ts` for the first time, for the two selection
  options only, and decision 13 carries the argument: everywhere else a stripped key is
  harmless and here it changes which documents get written to.
- `api-partition.test.ts` gained an `INTERNAL_POST` list. Its existing `routed()` helper
  uses GET, so **no POST-only internal route was covered by the partition test** —
  `/api/migrate` and `/api/schedules/run` included. Both are in the new list.
- The `index` arithmetic for a bulk move is the job's position plus the caller's `index`,
  so the walk order survives a batch boundary. The admin's current client loop passes
  `index: 0` per document and reverses the set; that is a real defect this fixes, and it
  is visible the first time somebody moves three pages.

**What Content's selection bar needs to adopt this**, precisely:

1. **A second selection shape in `content-model.ts`.** `Selection` is
   `ReadonlySet<string>` today; it becomes that *or*
   `{ all: true, filter: StoryFilter, expected: number, exclude: Set<string> }`. The
   comment at `content-model.ts:301` saying why the second is absent can go — with
   `toggleSelected` meaning "add to `exclude`" in that mode.
2. **`expected` off the header it already draws.** Flat mode already requests
   `?count=1`; that `total` is the number to capture, together with the filter it was
   read with **plus `routed: true`**, because Content is the routed list. Capture at
   click time, not at run time.
3. **One `fetch` per action instead of N.** `writeFor` becomes
   `POST {apiBase}/bulk/{action}` with `{ selection }`, plus `parentId`/`index` for move.
   `runBulk`'s loop becomes a loop over `continueFrom`, summing `done` and concatenating
   `failed`, and `reportOf(action, done, failed)` is called once at the end — the report's
   `failed` already has the `{ title, message }` shape it wants.
4. **A 409 branch.** On `refused === 'count'`, show the new `actual` and offer one button
   that re-posts with `expected: actual`. That is the whole of "a door, not a wall".
5. **Progress, for a run that takes several calls.** `total` and `seen` are in every
   report; `Showing 240 of 51,418` needs no arithmetic.
6. **`Show only selected` for a select-all** means navigating to the captured filter,
   which the URL already expresses — and it is also the answer to "what changed" that
   decision 7 declines to compute server-side.

**Deliberately deferred:** everything under *Out of scope*, and one thing worth naming
twice — the whole-table read inside `updateStoryStatement`, `createStory` and
`deleteStoryStatement`. It bounds how large a batch of the three tree-shaped actions can
usefully be, and it is a rewrite of the tree's write path rather than a tidy-up.

**Tests added:** 43 workers in a new `bulk.test.ts`, plus 2 in
`api-partition.test.ts`. `pnpm test` is **2,721 passing** (92 files). Plus
`scripts/bulk-test.mjs` at **38/38** against a freshly migrated and seeded local D1.
