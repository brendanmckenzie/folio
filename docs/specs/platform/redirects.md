# Feature: Redirects — a rename does not have to break every inbound link

> **Group:** platform
> **Build order:** 2
> **Size:** S
> **Status:** draft
> **Wire version:** none
> **Migration:** `0004_redirects.sql`
> **Last updated:** 2026-07-29

## Summary

Paths are derived from the ancestor chain and recomputed for the whole affected
subtree on rename or move. That design is what makes internal links survive a
reorganisation — a link stores a story id, so it is rewritten for free
(`scripts/fields-test.mjs` proves it). It does nothing for the links Folio does not
own: bookmarks, Google's index, the newsletter that went out last week, the partner
site linking to `/services/strategy`. Rename that page and every one of them 404s,
silently, with nothing recorded anywhere.

This is the one item in the competitor scan that is not really a steal. Payload ships
a redirects plugin; Contentful, Storyblok, Sanity and Strapi all leave it to the
application. Folio can do it better than any of them for one specific reason:
`updateStory` already computes every old path and its replacement, in one place, at
the exact moment the change is true. Capturing them is a `db.batch` entry.

## Ground truth

**server (`packages/folio/src/server/stories.ts`):**
- `updateStory(db, id, patch)` loads every row, builds `next`, merges it, and calls
  `derivePaths(merged)`. It then computes
  `changed = merged.filter((r) => paths.get(r.id) !== r.path || r.id === id)` and
  writes those rows in one `db.batch`.
  **For each changed row, `r.path` is the old path and `paths.get(r.id)` is the new
  one** — both in hand, already batched. That is the whole data requirement of this
  feature, and it is currently thrown away.
- `deleteStoryStatement(db, id)` returns `{ ids, statement }` after calling
  `listStories`, so the deleted rows' paths are available to the caller before the
  delete runs.
- `updateStory` refuses to reslug or reparent the root story (`path === ''`), so `/`
  can never need a redirect.
- `uniqueSlug` appends `-2`, `-3`… on collision, so a rename can land on a path that
  differs from what the editor typed — the redirect must record the path that was
  actually written, not the requested one.

**server (`packages/folio/src/server/index.tsx`):**
- `handle()` returns `null` for anything Folio does not own, *including* a preview
  request for a path with no story, so **host routes always win**. A redirect is for a
  path Folio no longer owns, so serving it from inside `handle()` would shadow a host
  route that legitimately lives there now. The lookup therefore has to be something
  the host asks for — see decision 2.
- Path normalisation everywhere is `url.pathname.replace(/^\/+|\/+$/g, '')`, and
  `stories.path` is stored in that form (no leading or trailing slash, `''` for the
  root). Redirect rows must use the identical form or half of them will never match.

**core (`packages/folio/src/core/values.ts`):**
- `isSafeHref` is the existing allow-list that kills `javascript:` URLs in `asLink`,
  richtext link marks and `resolveLink`. A redirect target is a URL a Worker will put
  in a `Location` header, so it goes through the same guard rather than a new one.

## Owner decision checkpoints

1. **Auto-capture on rename and move, permanent by default (recommended).** Every
   path change writes a `301`. The alternative — asking the editor each time — trains
   people to click through a dialog, and the cost of an unwanted redirect (delete one
   row) is far below the cost of a missing one (a dead link nobody notices for
   months).
2. **The host consults the redirect table; Folio does not intercept (recommended).**
   `folio.redirect(env, path)` in the host's 404 branch. Intercepting inside
   `handle()` would break the invariant that a host's own routes win at any path,
   which is a load-bearing property of the integration surface, not a detail.
3. **Chains are collapsed at write time, not followed at read time (recommended).**
   Renaming A→B then B→C rewrites the A→B row to A→C, so a lookup is always one
   indexed read and a loop is unrepresentable. The alternative — following hops on
   read — costs N queries and needs cycle detection on the hot path.
4. **One table for automatic and manual redirects (recommended).** A `source` column
   distinguishes them. Editors will want to add redirects for URLs that never existed
   in Folio (a print campaign, a legacy CMS), and the lookup, the safety check and the
   admin list are identical. Cost: one more column.
5. **Redirects outlive the story that created them (recommended).** Deleting a page is
   exactly when its old URL most needs to point somewhere. `story_id` stays on the row
   as information, not as a foreign key, matching how `versions.story_id` is already
   treated.

## User stories

### Editor renames without breaking the internet
**As** an editor **I want** the old URL to keep working after I rename a page **so
that** search results and other people's links do not break.

### Editor reorganises a whole section
**As** an editor moving `/services` under `/what-we-do` **I want** every descendant's
old URL to redirect **so that** a restructure is not a traffic event.

### Editor adds a redirect by hand
**As** an editor **I want** to point `/summer-sale` at `/offers` **so that** a printed
QR code keeps working even though that page never existed here.

### Editor retires a page
**As** an editor deleting a page **I want** to be offered a redirect to its parent
**so that** the URL degrades to something useful instead of a 404.

### Developer wires it up once
**As** a developer **I want** one call in my 404 branch **so that** redirects work for
every path without me maintaining a list.

## Architecture decisions

### 1. Capture happens inside the write that causes it

`updateStory` gains redirect statements in the batch it already builds:

```ts
const changed = merged.filter((r) => paths.get(r.id) !== r.path || r.id === id)

for (const r of changed) {
  const from = r.path                    // what it was
  const to = paths.get(r.id) ?? r.path   // what it now is
  if (from === to || from === null) continue
  statements.push(...redirectStatements(db, { from, to, storyId: r.id }))
}
```

In the same `db.batch` as the row updates, so a rename either records its redirects or
does not happen. A separate write after the fact could leave a renamed page with no
redirect, which is precisely the failure this feature exists to prevent.

`redirectStatements` is three statements, and they are the whole of decision 3:

1. `delete from redirects where from_path = ?` with the **new** path — the page lives
   there now, so any redirect *away* from it is wrong and must go.
2. `update redirects set to_path = ? where to_path = ?` — old path to new path,
   collapsing every existing chain that pointed at the old one.
3. `insert or replace into redirects (from_path, to_path, …) values (?, ?, …)` for the
   old path. `or replace` because the same path can be vacated more than once over a
   site's life, and the latest answer is the right one.

**Statement 1 must run before statement 2**, and that is the whole of the loop
safety. Renaming `a`→`b` and then back to `a`: without the delete first, statement 2
would rewrite the existing `a → b` row into `a → a`, a self-redirect that loops
forever in a browser. Deleting every row whose source is the newly occupied path
first means statement 2 can only ever touch rows pointing *at* the vacated path, and
the only row left afterwards is `b → a`. D1 runs a batch's statements in order, so
this is guaranteed rather than hoped for — and it is worth a test of its own.

### 2. The host asks, in its 404 branch

```ts
// host worker, after folio.published returns null
const hit = await folio.redirect(env, path)
if (hit) return Response.redirect(new URL(hit.to, url.origin), hit.status)

const status = await folio.status(env, path)         // from unpublish.md
return new Response('Not found', { status: status === 'unpublished' ? 410 : 404 })
```

Three lines in the README's mount snippet, and it composes with `unpublish.md`'s
`folio.status` so a host can answer `301`, `410` and `404` correctly with no
bookkeeping of its own.

`folio.redirect` returns `{ to, status } | null`. `to` is either a path (resolved
against the request origin by the host) or an absolute URL for a manual redirect
pointing off-site. Both are re-checked with `isSafeHref` on the way out, not only on
the way in, so a row written by a script or an older build cannot put
`javascript:` in a `Location` header.

### 3. Normalisation is the same rule `stories.path` uses

Stored without leading or trailing slashes, lowercased on write, query string
stripped. A lookup normalises identically. Trailing-slash and case variants
therefore hit the same row, which is the behaviour every editor expects and none of
them would think to ask for.

Query strings are deliberately dropped from matching and **preserved on the
redirect**: `/old?utm_source=x` → `/new?utm_source=x`, so campaign tracking survives.
That is done by the host in its redirect call (the helper returns the target path and
the host reattaches `url.search`), because only the host knows what it did with the
rest of the URL.

### 4. Deleting a page offers a redirect to its parent

The delete confirmation gains a checked-by-default "Redirect `/old-page` to
`/parent`", and the delete route writes the row in the batch it already builds for the
story and version deletes. For a subtree delete, each descendant redirects to the
deleted node's parent, since that is the nearest surviving ancestor.

Unchecking it is the escape hatch for a page that should genuinely be gone (an
accidental page, a spam import).

### 5. Unpublish does not create a redirect

An unpublished page is expected back; its URL is still its own. Creating a redirect
away from it would mean the page cannot be republished at its own path without
deleting the redirect first — and republishing already deletes nothing. So unpublish
leaves the table alone and the host answers `410` via `folio.status`.

## Wire & schema changes

### D1 migration `0004_redirects.sql`

```sql
-- Paths a request should be redirected away from. Written inside the same batch as
-- the rename or move that vacated them, so a path change cannot happen without its
-- redirect. Chains are collapsed on write (see the spec), so a lookup is always one
-- indexed read and a loop is unrepresentable.
create table if not exists redirects (
  -- Normalised exactly like stories.path: no leading or trailing slash, lowercased,
  -- no query string. The primary key, because one source path has one answer.
  from_path  text primary key,
  -- A path in the same form, or an absolute URL for a manual off-site redirect.
  -- Re-checked with isSafeHref on read as well as write.
  to_path    text not null,
  status     integer not null default 301 check (status in (301, 302, 307, 308)),
  -- 'auto' (a rename, move or delete) or 'manual' (an editor added it).
  source     text not null default 'auto' check (source in ('auto', 'manual')),
  -- Which story vacated the path. Informational, not a foreign key: redirects
  -- deliberately outlive the story that created them.
  story_id   text,
  created_at integer not null
);

-- For chain collapsing (update … where to_path = ?), which is the only query that
-- does not go through the primary key.
create index if not exists redirects_to on redirects (to_path);
```

### Core / server types

```ts
export interface Redirect {
  from: string
  to: string
  status: 301 | 302 | 307 | 308
  source: 'auto' | 'manual'
  storyId: string | null
  createdAt: number
}

interface Folio<Env> {
  /** A redirect for a path, or null. One indexed read. */
  redirect: (env: Env, path: string) => Promise<{ to: string; status: number } | null>
}
```

`server/redirects.ts`: `lookupRedirect`, `redirectStatements`, `listRedirects`,
`upsertRedirect`, `deleteRedirect`, `normalisePath`.

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/folio/redirects` | editor+ | List, newest first, paginated |
| POST | `/folio/redirects` | publisher | Create or replace a manual redirect |
| DELETE | `/folio/redirects/:from` | publisher | Remove one |

`POST` refuses a `from` that a live story currently occupies (`conflict`, naming the
story) — a redirect that can never fire is a trap, not a row.

## Acceptance criteria

### A rename records a redirect
```
GIVEN a published page at services/strategy
WHEN its slug is changed to strategy-consulting
THEN GET /services/strategy resolves to a 301 pointing at /services/strategy-consulting
AND the redirect row was written in the same batch as the rename
AND every internal link to the page still resolves without a redirect (links store ids)
```

### A move records one redirect per descendant
```
GIVEN services with two descendants, all published
WHEN services is reparented under what-we-do
THEN three redirect rows exist, one per old path, each pointing at the new path
AND all three were written in one batch with the row updates
```

### Renaming back cannot produce a self-redirect or a loop
```
GIVEN a redirect a → b, created by renaming a to b
WHEN the page is renamed back to a
THEN the a → b row is deleted, because the page occupies a again
AND exactly one row remains: b → a, for the path just vacated
AND no row points at itself, and a lookup for either path answers in one read
```

### Chains collapse
```
GIVEN a → b after one rename
WHEN the page is renamed from b to c
THEN the row for a points at c, and a row for b points at c
AND no lookup ever needs to follow a second hop
```

### Collision-adjusted slugs are recorded correctly
```
GIVEN a sibling already using the slug 'team'
WHEN another page is renamed to 'team' and is written as 'team-2'
THEN the redirect points at the path that was actually written, not at the requested one
```

### Deleting offers a redirect to the parent
```
GIVEN /about/history published under /about
WHEN it is deleted with the redirect option left checked
THEN /about/history 301s to /about
AND the story, its versions and its Durable Object are gone as they are today
AND with the option unchecked, no row is written and the path 404s
```

### Manual redirects
```
GIVEN no story at summer-sale
WHEN an editor adds a manual redirect summer-sale → offers
THEN GET /summer-sale 301s to /offers, and the row is marked manual
AND an attempt to add a redirect from a path a live story occupies is refused,
    naming that story
```

### Live pages always win
```
GIVEN a redirect from a and a story later created at a
WHEN /a is requested
THEN the story is served (the host reaches folio.published first and never asks
     for a redirect)
AND creating that story deleted the row anyway, so the trap cannot persist
```

### Unsafe targets never reach a Location header
```
GIVEN a row whose to_path is 'javascript:alert(1)' (written by an older build or a script)
WHEN it is looked up
THEN folio.redirect returns null and logs, rather than handing it to the host
```

### Query strings survive
```
GIVEN a redirect old → new
WHEN /old?utm_source=x is requested
THEN the host redirects to /new?utm_source=x
```

## Implementation plan

### Phase 1 — capture and lookup

1. Migration `0004_redirects.sql`.
2. `server/redirects.ts`: `normalisePath`, `redirectStatements` (the three statements
   of decision 1), `lookupRedirect` (with the `isSafeHref` re-check), `listRedirects`,
   `upsertRedirect`, `deleteRedirect`.
3. `server/stories.ts`: add the statements to `updateStory`'s batch; add the optional
   parent redirect to the delete path; delete any redirect whose `from_path` equals a
   newly created story's path inside `createStory`.
4. `server/index.tsx`: `folio.redirect`.
5. Tests: `test/workers/stories.test.ts` — rename, move-with-descendants, rename-back,
   chain collapse, collision-adjusted slug, create-over-a-redirect, delete with and
   without the option; `test/unit/server/pure.test.ts` for `normalisePath`.

### Phase 2 — routes and admin

1. `routes/redirects.ts`: the three routes, with valibot schemas and the
   live-story conflict check.
2. A **Redirects** screen in the admin (a flat list is enough): source path, target,
   status, auto/manual, created; add and delete; filter by source. Reachable from the
   same rail as the content tree.
3. The delete confirmation's redirect checkbox (`StoryTree.tsx`'s delete flow).
4. Tests: `test/workers/http.test.ts` for the routes; an admin unit test for the
   delete-confirmation state.

### Phase 3 — docs

1. `README.md`: the three-line 404 branch in the mount snippet, and a short Redirects
   section explaining why internal links need none of this.
2. `ROADMAP.md`: nothing to remove — this was never on it, which is the point.

## Edge cases

- **A path vacated and reoccupied by a different story** → `createStory` deletes any
  redirect from that path, so the new page is reachable. Without this, a new page
  would be shadowed by an old redirect at the host level for as long as nobody
  noticed.
- **A redirect to a path that is later vacated** → chain collapsing only fires on a
  rename; a redirect pointing at a deleted page becomes a redirect to a 404. The
  admin list flags rows whose target resolves to nothing, which is the honest fix (a
  cascade would guess).
- **Case and trailing slashes** → normalised on both sides (decision 3).
- **A manual redirect to an external URL** → allowed, `isSafeHref` checked, and the
  host redirects off-site. This is how a retired microsite is handled.
- **Redirect loops through manual rows** (`a → b` and `b → a`, both manual) → the
  `POST` route refuses a manual row whose target already redirects back to its
  source. Auto rows cannot loop by construction (decision 3).
- **Many redirects** → the table is keyed by `from_path`, so a lookup is one indexed
  read whatever the size, and it only happens on a request that was going to 404
  anyway.
- **Unpublish** → deliberately no redirect (decision 5).
- **Records and singletons** (`../foundation/document-types.md`) → they have no path,
  so a rename produces no redirect. `derivePaths` already skips them and the
  `from === null` guard in decision 1 covers it.
- **Localisation** (`../content-model/localisation.md`) → paths are locale-independent
  in that spec, so one redirect covers every locale prefix. If translated slugs ever
  land, redirects become per-locale, and this table gains a `locale` column with `''`
  meaning "every locale".
- **A host that never adds the 404-branch call** → redirects are recorded and do
  nothing. Silent, which argues for saying so loudly in the README rather than for a
  mechanism.

## Testing requirements

**Unit:** `normalisePath` (slashes, case, query strings, the root); the statement
builder's three-statement output for each scenario.

**Workers:** every acceptance criterion, with the batch assertions (a failed rename
writes no redirect); `isSafeHref` rejection on read; lookup cost (one statement).

**End to end (`scripts/redirects-test.mjs`, new):** publish a nested page, rename its
parent, assert the old descendant URL 301s to the new one and that an internal link on
another page points at the new path directly with no redirect; delete a page with the
option checked and assert the parent redirect; add a manual redirect and assert it
fires.

## Dependencies

- None to build. `unpublish.md`'s `folio.status` makes the host's 404 branch complete,
  and the two are naturally documented together.
- `../foundation/document-types.md` rebuilds `stories` in `0006`; this table is
  untouched by that rebuild.

## Out of scope

- **Redirect expiry / retention.** Rows accumulate forever, which is correct for SEO
  and cheap. The admin list plus delete is the answer if a site ever wants a clear-out.
- **Regex or wildcard redirects** (`/blog/* → /insights/*`). Real want, different
  feature: it needs an ordered rule list evaluated on every 404 rather than a keyed
  lookup, and manual rows cover the cases that motivate it today.
- **Redirect analytics** ("this old URL still gets 400 hits a month"). Cloudflare
  analytics answers it without Folio storing anything.
- **Serving the redirect from inside `handle()`** (checkpoint 2).
- **Importing a redirect list** from an old CMS. One loop over
  `POST /folio/redirects`, and better placed in `../platform/content-api.md`'s import
  story.
