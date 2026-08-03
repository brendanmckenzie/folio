# Feature: Draft preview sharing — a link that shows unpublished work to somebody with no account

> **Group:** platform
> **Build order:** 21, per docs/specs/README.md
> **Size:** M ≈ a few days
> **Status:** done
> **Wire version:** none
> **Migration:** `0004_shares.sql`
> **Last updated:** 2026-07-31

## Summary

The whole point of a CMS with a live preview is showing work to somebody before it is
public, and today that is impossible: every surface that renders a draft is behind
`requireHtmlAccess(READ_DRAFT)` or `allows(actor, READ_DRAFT)`, so reviewing a draft
means holding an account and a role. `src/server/index.tsx`'s preview branch is the
file that proves it — it resolves an actor and hands the request back to the host
unless that actor may read drafts, which is the correct behaviour and leaves a client
reviewer with no way in at all.

This adds a **signed, expiring, revocable link** for one document: `POST` mints it,
the reviewer's browser exchanges the token for a cookie, and the *same* preview branch
and the *same* `previewPage` render the draft. Contentful and Storyblok both ship this;
it is how a client reviews work.

## Ground truth

**server (`packages/folio/src/server/`):**
- `index.tsx:198-249` — the `?_folio=preview` branch of `handle()`. It resolves an
  actor (`resolveActor` + `allows(actor, READ_DRAFT)`), refuses **by handing the
  request back to the host** rather than by answering 401, resolves the path with
  `rt.pathForLocale` + `storyByPath`, and calls `previewPage`. This is the only
  draft-rendering surface outside `basePath`, and it is where a share has to be
  honoured — anywhere else would fork the renderer.
- `runtime.ts:354-360` — `previewUrlFor(path, locale)` is `config.route(path, locale)`
  with `_folio=preview` appended. `runtime.ts:373-388` — `withUrls` puts it on
  `StoryMeta.previewUrl`. **A preview URL is the host's own `route()` function's
  answer**; the redirect target must come from here rather than be assembled.
- `auth/secrets.ts` — `mintSecret()` (32 bytes → 64 hex), `hashToken()` (lowercase-hex
  SHA-256), `mintId(prefix)`. Its header states the rule for every credential in the
  feature: handed out once in the clear, stored only as a hash, revoked by a `delete`
  or a stamp rather than a blocklist.
- `auth/tokens.ts` — `api_tokens` is the closest existing model: `id` *is* the hash,
  `scopes` is a JSON array, `expires_at` is **nullable**, revoke is a `revoked_at`
  stamp, and `readToken` puts the read and the `last_used_at` stamp in **one D1
  batch** so a token-authenticated request costs one round trip.
- `auth/resolve.ts:33-38` — `credentialOf` reads exactly two things: the session
  cookie (`readSessionCookie`, two names) and `Authorization: Bearer`. Anything under
  any other cookie name is invisible to the actor model. `resolveActor` reads no D1
  for a request presenting neither.
- `auth/roles.ts:190-195` — `allows(actor, access)` is the one predicate every gate
  goes through, and it takes an `Actor`: `{ kind: 'user', role, … }` or
  `{ kind: 'token', scopes, … }`. A value that is neither cannot be passed to it.
- `auth/roles.ts:177` — `PUBLISH = { role: 'publisher', scope: 'publish' }`, the gate
  on `POST /story/:id/publish` and on all four schedule routes.
- `middleware.ts:128-146` — `requireHtmlAccess` 302s an unauthenticated *browser* to
  the login page and 403s an authenticated one; `requireAccess` answers the JSON
  envelope. `middleware.ts:153-158` — `requireAuthConfigured` 404s a route that only
  means something on a deployment with real accounts, which is what `/users` and
  `/tokens` use under `auth: 'open'`.
- `pages.tsx:116-182` — `previewPage(rt, bindings, story, opts)`: `rt.draftFor`, then
  `rt.resolve(..., { draft: true, locale, story })`, then the preview shell with
  `__FOLIO__` bootstrapped. `pages.tsx:305-313` — every page here answers `NO_STORE`
  and carries no `Cache-Tag`, and the comment says why: the same URL returns draft HTML
  to an editor and published HTML to a visitor, and `Cookie` neither bypasses Workers
  Cache nor forms part of its key.
- `routes/shell.ts:70-71` — a wildcard on every bare path under the mount, gated
  `READ_DRAFT`. **Anything that must keep a bare path has to register ahead of it in
  `app.ts`**, or it 302s to the login page.
- `routes/editor.ts:66-99` — the socket refuses a token actor with close code 4004 and
  an absent actor with 4003, by upgrading and closing rather than failing the
  handshake.
- `schedules.ts:68-78` — `checkScheduleTime` **refuses** rather than clamps an
  out-of-range time, and says why: silently accepting is the worst of both answers.
- `keyset.ts:97` — `NEWEST_FIRST` is `(created_at, id)` desc, which `api_tokens`,
  `assets` and `versions` all page by.
- `validate.ts:504-535` — `TokenCreateBody`, including `expiresInDays` bounded 1–3650.

**core (`packages/folio/src/core/`):**
- `resolve.ts` / `refs.ts` — in `draft: true` mode, `runtime.ts:557-586` loads the
  **drafts** of the documents this one pulls in (`reference` fields) and of every
  configured global. So a shared preview's `Resolution` transitively contains draft
  content the shared document itself renders. That is the existing behaviour of an
  editor's preview and it is what decision 1a settles.
- `cache-tags.ts` — `NO_STORE` is `'private, no-store'`, not `'no-store'`.
- No `WebSocket` anywhere in `src/preview/`: the preview client talks to a parent frame
  by `postMessage` and opens no socket, so a shared viewer with no parent frame simply
  sits idle.

**migrations (`packages/folio/migrations/`):**
- `0001_init.sql:297-312` — `api_tokens` and its single `api_tokens_created` index on
  `(created_at desc)`.
- `0003_schedules.sql` — the closest model for style: a synthetic `sch_` key because a
  keyset tiebreak must be unique on its own, no CHECK on either enum column because
  SQLite cannot widen one without a table rebuild, and a *documented absence* of
  `schedules_story` with `migrations.test.ts` asserting it.

**tests:**
- `test/workers/seed-fixture.ts` runs `examples/demo/seed.sql` verbatim inside a
  `beforeEach` in five files, so every fixed-key row the seed grows collides on the
  second test in each of them. `stories.test.ts:78-80` records that being discovered
  twice already (`users`, then `api_tokens`).
- `test/workers/auth-http.test.ts:72-77` — `raw()` keeps `handle()`'s null, which the
  preview branch's refusals need.
- `test/workers/smoke.test.ts:54-68` asserts the exact table list.
- `scripts/lib/auth.mjs` — `signInGlobally()` wraps `globalThis.fetch` **and**
  `globalThis.WebSocket` to carry the admin's cookie, and returns
  `{ cookie, realFetch, RealWebSocket }`. The unwrapped pair is the only way an e2e
  script can act as somebody with no account.

## Owner decision checkpoints

1. **One document, not a subtree (recommended).** A subtree grant covers a set that
   changes after the grant is made, so a page created tomorrow is disclosed by
   yesterday's link. Three pages is three links, each individually revocable. Cost: a
   reviewer cannot click from a shared page into its children — they get the published
   page or a 404, which is what a dangling link already does.
2. **A one-time query parameter that redirects into a cookie (recommended).** The
   token is in the link because that is all a link can carry; it is out of the URL
   within one hop, so it never enters an address bar, a `Referer`, a bookmark or an
   analytics event. The alternative — leaving `?token=` on every request — is simpler
   and puts a live credential in every log line the reviewer's visit produces.
3. **Hashed at rest, exactly as `api_tokens` (recommended).** With one addition to the
   existing argument: a share link is pasted into email and chat, so it is archived and
   indexed by systems nobody administers, which is a reason for the database not to be
   a second copy rather than against it.
4. **Seven days by default, ninety at most, editor's choice in between
   (recommended).** `expires_at` is `not null`, unlike `api_tokens.expires_at`: a token
   with no expiry is a legitimate shape and a share link with no expiry is a permanent
   public URL for unpublished content.
5. **A lapsed link gets an explaining page at 404, identical for every reason
   (recommended).** The prose is the useful part; the status is honest; and not
   distinguishing expired from revoked from never-issued keeps the route from being an
   oracle for "was this string ever a token".

## User stories

### Client reviews work before it is public
**As** a client **I want to** open a link and see the page as it will look **so that**
I can approve it without being given a CMS account.

### Editor sends the link and keeps control of it
**As** an editor **I want to** send a preview link and later see and revoke it **so
that** an unpublished page does not stay readable by a URL in an old email thread.

### Owner knows the link reaches nothing else
**As** the site owner **I want** a preview link to authorise one document and nothing
more **so that** handing one to an outsider is not handing them the CMS.

### Editor knows whether it was read
**As** an editor **I want to** see whether the link was opened **so that** "did you
look at it?" has an answer.

## Architecture decisions

### 1. A grant is one document, checked against the story the requested path resolves to

`shares.story_id` is one id, and `claimShare(db, tokens, storyId)` takes the story the
URL resolved to and answers yes or no. There is no call that answers "which documents
does this link cover", because the question has one answer by construction.

**Rejected: a subtree grant** ("this page and its children"), which is how a client
reviewing a section would naturally think about it. It loses on consent: the set is
defined by the tree *at read time*, so a page created under the shared one tomorrow is
disclosed by a link issued today, and the person who issued it cannot have agreed to a
document that did not exist. It also makes revocation coarse — you can turn off the
section but not the one page you regret — and makes the list route unable to say what
is outstanding without walking the tree.

**Rejected: a site-wide draft-mode grant** (Next.js's `draftMode`, Netlify's
`__prerender_bypass`). It is the simplest possible design and would have removed the
need for the cookie to hold a list (decision 2b). It loses for the same reason, one
notch harder: one leaked link discloses every unpublished page on the site.

Three pages to review is three links. That composes, and it is the only shape where
"revoke that one" means anything.

### 1a. The grant covers the document *as rendered*, which is the closure `resolve()` already computes

A `reference` field pulls another document into this one, and in `draft: true` mode
`resolve()` loads that document's **draft** (`runtime.ts:557-586`), as do all the
configured globals. So a shared preview's payload transitively contains draft content
from documents the grant does not name.

That is deliberate and it is not a subtree by the back door. The set is chosen by the
shared document's own author, is bounded by its own content, and is not enumerable —
there is no way to ask for a document this one does not pull in. It is also *exactly*
what a signed-in editor's preview of the same page shows.

**Rejected: resolving everything a shared page pulls in from published content
instead.** It sounds tighter and is worse in both directions. A page whose referenced
record is being drafted in the same round of changes would show the reviewer stale
content and they would approve the wrong thing; and it would mean `previewPage` had two
resolution modes decided by *who was asking*, which is a fork in the renderer this
whole design exists to avoid.

**Links out are the case worth stating.** A `multilink` or a richtext link mark stores
a story id and the href is derived at render from `stories.path` — a URL, not content.
A reviewer clicking one lands on the host's published page for that document, or its
404 if it is not live. That is the existing "a dangling link degrades safely" property
preserved rather than fought: the token does not cover that document, so its draft is
not shown, and nothing leaks beyond a URL that was in the shared page's own prose.

### 2. The token arrives in a query parameter and leaves in a cookie, in one hop

`GET {base}/share?t=<64 hex>` validates the token, sets a cookie, and 302s to
`rt.withUrls(story).previewUrl`. Every render after that is authorised by the cookie.

What this protects against is **the credential's afterlife in places nobody audits**: a
URL with a live token in it lands in the browser's address bar and history, in the
`Referer` of every outbound link the previewed page contains, in bookmarks, in
analytics page-view events, in a screenshot pasted into a ticket, and in any reverse
proxy or CDN access log the request passes through. A cookie is in none of those.

**Rejected: `?token=` on every preview request.** No redirect, no cookie, no list to
manage, and it works in a browser with cookies disabled. It loses on all of the above,
and the leak is silent — the feature keeps working perfectly while the credential
spreads.

**Rejected: the token in a path segment** (`{base}/share/<token>`). It reads better and
is worse: a path is what every log format records unconditionally, and half the
tooling that redacts query strings does not redact paths. A secret never goes in a
path.

The one accepted cost: a reviewer whose browser blocks cookies gets the published page.
That is the same refusal everything else in this branch produces, and it is the right
side to fail on.

### 2b. The cookie holds a bounded list of tokens, not one

`shareCookieTokens` parses up to `MAX_SHARE_COOKIE_TOKENS` (5) screened 64-hex values
out of a `.`-separated cookie; `withShareToken` prepends the one just used and caps.
`claimShare` hashes them all and asks D1 once with `token_hash in (…) and story_id = ?`.

A grant covers one document, so a reviewer sent three links holds three grants. With a
single-valued cookie the third click would silently unseat the first: going back to an
earlier tab and refreshing would show the ordinary published page with no explanation
of what changed — precisely the "it quietly stopped working" failure this codebase
refuses elsewhere.

**Rejected: one cookie per share, name-suffixed.** Unbounded header growth and nothing
to evict.

**Rejected: accepting the single-value behaviour** and telling the reviewer to click
the link again. It costs twenty lines and one bounded `in (…)` to not have that
conversation.

### 3. Hashed at rest, and the primary key is *not* the hash

`token_hash` is the lowercase-hex SHA-256, `not null`, with a named unique index. `id`
is a synthetic `shr_<12 hex>`.

The hashing follows `auth/secrets.ts` unchanged, with one reason of its own added to
the file: a share link lives in an inbox and a chat archive, so systems nobody
administers will hold copies of the plaintext, and the database being one more of them
buys nothing.

**Rejected: the hash as the primary key, as `api_tokens` does it.** Consistency is the
argument for it and it is not enough. With a synthetic key, `DELETE
{base}/api/shares/:id` and every row a screen holds carry **no secret-derived material
at all** — defence in depth against the whole "the id ended up in a log, a referrer, an
analytics event" family, which is the exact family decision 2 exists to keep a token
out of. The `schedules.id` argument applies too: a keyset tiebreak must be unique on
its own, and a synthetic text key is how every paged table here gets one.

### 4. Seven days by default, ninety at most, and `expires_at` is `not null`

`DEFAULT_SHARE_DAYS = 7`, `MAX_SHARE_DAYS = 90`, `expiresInDays` on the body bounded
1–90 by the schema *and* refused by `shareExpiry` — the same double bound `POST
/migrate` puts on `batch`, where the schema bounds what may reach the column and the
function states the product rule for a programmatic caller.

A week because a review cycle is a week and the default has to be right for somebody
who never thinks about it. Ninety as the ceiling because a link nobody has revoked is a
link nobody is thinking about, and the failure mode of this feature is an unpublished
page reachable from a two-year-old email.

**Rejected: nullable, matching `api_tokens.expires_at`.** A CI token that outlives
everyone who set it up is a legitimate shape; a preview link with no expiry is a
permanent public URL for unpublished content, which is the one thing this must not
become. The column insists so no code path can forget.

**Rejected: clamping an over-long request to ninety days.** `checkScheduleTime`'s rule:
a caller asking for two years has a different intent, and giving them ninety while
their screen says two years is the worst of both answers.

### 5. A lapsed link gets a page that explains itself, at 404, identically for every reason

`expiredLinkPage()` is server-rendered, ships no JavaScript, says `no-store`, and
answers **404**. A malformed token, an unknown one, an expired one, a revoked one, and
one whose document has been deleted all produce the byte-identical response.

The prose is there because the reader is a client with no account who was sent a URL:
"ask whoever sent it for a new link" is the entire useful content of the response, and
a bare 404 conveys none of it. The status is 404 because there is nothing to serve;
410 would be a claim about history that four of the five cases cannot support.

**The identical body is the part that matters.** Distinguishing the cases would make
the route an oracle for "was this string ever one of our tokens" — infeasible to
exploit against a 256-bit secret, and worth nothing either, because the reader's next
action is the same in all five. Usefulness comes from the explanation, not the
diagnosis. The page also names neither the site nor the document, which is why
`expiredLinkPage` takes no `FolioRuntime` at all.

At the **document's own URL**, a lapsed cookie gets a different answer: the request is
handed back to the host, which serves its ordinary published page. That is the existing
refusal shape of the preview branch and it must stay — a 401 or an explaining page at a
URL the public also uses would be a status code that varies by cookie on a cacheable
public path.

### 6. A share is never an `Actor`, and that is enforced by three things at once

`readShareByToken` and `claimShare` answer a `ShareGrant`: `{ id, storyId, expiresAt }`.
No `kind`, no `role`, no `scopes`, so `allows(grant, …)` does not type-check and no
route gate in the server can be satisfied by one.

Three independent mechanisms, deliberately overlapping:

1. **The cookie's name.** `credentialOf` reads `__Host-folio_session` /
   `folio_session` and `Authorization: Bearer`. `__Host-folio_share` is neither, so the
   share cookie is invisible to `resolveActor` — a request carrying only it resolves to
   `actor: null` and every gate refuses it with no share-specific code involved.
2. **The type.** There is nothing to widen `allows` with.
3. **The schema.** `shares` has no `role`, `scopes` or `user_id` column, asserted as an
   absence in `migrations.test.ts`, so the change that would turn a review link into a
   credential is a visible act.

**Rejected: a fourth `Actor` kind, `{ kind: 'share', storyId }`.** It is the obvious
design and it is the dangerous one: it would put a share into `resolveActor`, and from
there every `requireAccess` in the server becomes a place where somebody has to have
remembered that this actor is different. `READ_DRAFT` would pass for it, which is
`{ role: 'viewer', scope: 'content:read:draft' }` — the gate on the whole admin shell.

**Rejected: a per-story `Access`** (`{ role, scope, storyId }`), which would let the
existing middleware do the narrowing. Every one of the ~forty existing gates would
have to be audited for what it does with the new field, and the ones that ignore it
would ignore it silently.

### 7. `PUBLISH` on all three management routes, and `requireAuthConfigured` on all four

Creating a link makes an unpublished document readable by somebody outside the
organisation. That is a disclosure decision of the same shape publishing is, which is
why the gate matches `POST /story/:id/publish`.

**Rejected: `EDIT` for the create.** An editor sharing their own draft for feedback is
an ordinary thing to want. It loses because the audience is outside the organisation
and an editor is not the person who knows what an unpublished page is commercially
worth.

**Rejected: `READ` for the list, matching `GET /schedules`.** A schedule is a fact
about a document; a share is a live credential against it. The set who can see which
credentials are outstanding should not be wider than the set who can issue them — and
one gate for all three means a screen's three calls have one answer, so nobody sees a
list with a disabled revoke button.

**Rejected: `ADMIN`, matching `/tokens`.** A token belongs to the access model; a share
belongs to a document, and putting a routine review step behind the role that manages
accounts makes it unusable by the people who need it.

`requireAuthConfigured` on all four — including the entry route — so the whole surface
**404s under `auth: 'open'`**, following `/users` and `/tokens`. On such a deployment
anybody can already append `?_folio=preview` to any URL, so a sharing mechanism there
would be ceremony around an open door.

### 8. Nothing prunes `shares` when a document is deleted

`deleteStoryStatement` already returns five things a caller must batch and does not
grow a sixth.

A share for a deleted document is unreachable: the entry route looks the story up and
answers the lapsed page, and `claimShare` matches on an id `crypto.randomUUID` will
never mint twice, so no future document can inherit the grant. What the row still does
is answer "which links did we send, for what, and when did they stop working" — the
`api_tokens` argument for revoking rather than deleting, and the `versions.actor`
argument for history surviving an access change.

Contrast `schedules.story_id`, which **must** not outlive its story: an instruction to
publish a document that no longer exists is not an instruction. A receipt for a link
that no longer works is still a receipt. `deleteLapsedShares` is the housekeeping
sweep, on no request path, alongside `deleteExpiredSessions` and
`deleteStaleChallenges`.

## Wire & schema changes

### D1 migration `0004_shares.sql`

```sql
create table shares (
  id             text primary key,   -- shr_<12 hex>, synthetic (decision 3)
  token_hash     text not null,      -- lowercase-hex SHA-256; the only stored form
  story_id       text not null,      -- one document (decision 1)
  created_by     text,               -- users.id | token:<name> | null
  created_at     integer not null,
  expires_at     integer not null,   -- not null, unlike api_tokens (decision 4)
  revoked_at     integer,
  last_viewed_at integer,
  views          integer not null default 0,
  note           text
);

create unique index shares_token   on shares (token_hash);
create index        shares_created on shares (created_at desc);
-- Deliberately no shares_story: `?story=` scans a table bounded by links somebody
-- typed by hand. Asserted as an absence in migrations.test.ts.
-- No CHECK on anything: live/lapsed is `revoked_at is null and expires_at > now`,
-- computed in the where clause, so there is no enum to widen.
```

`stories` is untouched. No wire change: `PROTOCOL_VERSION` stays at 4, because nothing
about a socket frame or an admin↔preview frame moves — a shared viewer opens no socket
and has no parent frame.

### Core types

None. `ShareRow` and `ShareState` live in `server/auth/shares.ts` and are re-exported
from `folio/server`; `ShareGrant` is deliberately **not** exported, because it is
meaningful only inside `handle()`'s preview branch and putting it on the public surface
would invite a second gate built out of it.

### New or changed routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `{base}/api/story/:id/share` | `PUBLISH` + auth configured | Mint a link. `{ expiresInDays?: 1–90, note?: string }`, both optional → `201 { url, share }`. **The only response that ever carries the token.** `400` for an unrouted document, `404` for an unknown id |
| GET | `{base}/api/shares` | `PUBLISH` + auth configured | `?story=&state=live\|lapsed&limit=&cursor=&count=1` → `{ shares, cursor, total? }`. Newest first. No token, no hash, no title |
| DELETE | `{base}/api/shares/:id` | `PUBLISH` + auth configured | Revoke → `{ revoked: true }`; `404` for unknown or already-revoked |
| GET | `{base}/share?t=` | none, auth configured | Exchange the token for a cookie and `302` to the document's own preview URL. `no-store`. `404` + explaining page for anything that does not resolve; plain `404` with no `?t=` |
| GET | *the document's own preview URL* | share cookie **or** `READ_DRAFT` | Unchanged route (`handle()`'s preview branch), one new way to satisfy it |

The cookie is `__Host-folio_share` on HTTPS and `folio_share` otherwise, `HttpOnly`,
`SameSite=Lax`, `Path=/`, `Max-Age` = the grant's remaining life, value = a `.`-joined
list of up to five tokens.

## Acceptance criteria

### A client with no account sees the draft
```
GIVEN a published page whose draft has since been edited
AND a preview link minted for it
WHEN a browser with no session cookie opens the link
THEN it is redirected to the document's own preview URL with a share cookie set
AND that URL renders the DRAFT, with cache-control: private, no-store
AND the same URL without the cookie renders the PUBLISHED page
```

### The link reaches nothing else
```
GIVEN a browser holding only a share cookie
WHEN it requests the admin shell, the editor, or any {base}/api or {base}/api/v1 route
THEN it gets 302 to sign in (HTML) or 401 (JSON), never 200
AND another document's preview URL is handed back to the host
AND `?as=<global>` on the shared document's own URL is handed back to the host
AND the sync socket closes with 4003
AND presenting the share token under the session cookie's name is 401
```

### Only a publisher may issue or revoke
```
GIVEN a viewer or editor session
WHEN POST {base}/api/story/:id/share, GET {base}/api/shares or DELETE {base}/api/shares/:id
THEN 403, naming the required role
AND a token holding only content:read:draft is 403 naming the missing 'publish' scope
AND a token holding publish succeeds
```

### Expiry and revocation
```
GIVEN a link minted with no expiresInDays
THEN it expires seven days later, and expiresInDays: 400 is a 400
AND WHEN it is revoked
    THEN the document's preview URL stops showing the draft immediately
    AND reopening the link answers 404 with a page explaining it no longer works
    AND that page is byte-identical to an unknown, expired or deleted-document link
    AND the row stays in the list with revokedAt set
    AND any other outstanding link is untouched
```

### The editor keeps the receipt
```
GIVEN two links, one per document
WHEN GET {base}/api/shares?count=1
THEN both are listed newest first with a total, filterable by ?story= and ?state=
AND each carries views, lastViewedAt, note and createdBy
AND no response anywhere contains the token or its hash
```

### Under auth: 'open' the feature does not exist
```
GIVEN auth: 'open'
WHEN any of the four routes is requested
THEN 404
```

## Implementation plan

Four phases, each committable and green.

### Phase 1 — the row and the reader

1. `migrations/0004_shares.sql`.
2. `server/auth/shares.ts`: `createShare`, `listShares`, `revokeShare`,
   `readShareByToken`, `claimShare`, `shareExpiry`, `deleteLapsedShares`, and the
   `ShareGrant` / `ShareRow` types.
3. `server/auth/cookie.ts`: the third cookie name, `shareCookieTokens`,
   `withShareToken`, `clearShareCookies`.
4. Tests: the `shares` block in `migrations.test.ts`; the cookie and expiry blocks in
   `test/unit/server/auth.test.ts`.

### Phase 2 — the routes

1. `server/validate.ts`: `ShareCreateBody`, `shareStateQuery`.
2. `server/pages.tsx`: `expiredLinkPage`, and a `status` parameter on the private
   `html` helper.
3. `server/routes/preview.ts`: `shareRoutes` (JSON) and `sharePageRoutes` (HTML).
4. `server/app.ts`: mount both, the second **ahead of `shellRoutes`**.

### Phase 3 — honouring it

1. `server/index.tsx`: the preview branch reads the share cookie when the actor gate
   fails, checks `claimShare` against the resolved story, and refuses `?as=`.
2. `server/index.tsx`: export `ShareRow`, `ShareState`, `DEFAULT_SHARE_DAYS`,
   `MAX_SHARE_DAYS`.
3. Tests: `test/workers/shares.test.ts`, including the enumeration table.

### Phase 4 — the demo and the live proof

1. `examples/demo/seed.sql`: a seeded link with a precomputed hash, so `wrangler dev`
   demonstrates it with one paste.
2. `examples/demo/src/index.tsx`: a comment recording that the host-side cost is zero.
3. `test/workers/seed-fixture.ts`: clear what the seed writes credentials into.
4. `scripts/preview-share-test.mjs`.

## Edge cases

- **The shared document is deleted** → the entry route answers the lapsed page; the
  row stays as a receipt. The id can never be re-minted, so no future document
  inherits the grant (decision 8).
- **The shared document is unpublished, or never was published** → the preview renders
  regardless: it reads the draft, and the story row's liveness is not consulted. That
  is the case the feature exists for.
- **The document is renamed while a link is outstanding** → the link keeps working. The
  grant names an id, not a path, and the entry route resolves the story fresh on every
  click; `previewUrl` is derived from the current row. A reviewer who bookmarked the
  *old* preview URL gets the host's redirect (`redirects.md`) or its 404, which is
  correct — that URL is not the document's URL any more.
- **A reviewer holds six links** → the cookie keeps the five most recent. The sixth
  click evicts the oldest, and re-clicking the evicted link restores it.
- **The reviewer's browser blocks cookies** → they see the published page. The same
  refusal everything else in this branch produces.
- **A `?locale=` on the shared preview** → honoured, because it is the same document in
  another language (`localisation.md` checkpoint 3). Nothing about the grant is
  per-locale, and a reviewer who is meant to check the French copy needs it.
- **Two live tokens for the same document in one cookie** → both match, the first row
  is used, and both are stamped. `views` double-counts on that one request. A
  pathological input, and the alternative is a `limit 1` on the update that SQLite
  cannot express with a stable choice.
- **An asset in the shared draft that is not published** → served, because
  `GET {base}/asset/:key` is public. That is the standing deliberate hole
  (`identity-and-access.md`'s route table says so in as many words), unchanged here: a
  key is unguessable and a published page's `<img>` tags point at the same route. Named
  rather than pretended closed.
- **The reviewer clicks an internal link in the shared page** → the host's published
  page for that document, or its 404. The grant covers one document (decision 1a).
- **Clock skew on the expiry** → no leeway, unlike `CLOCK_LEEWAY_MS` on a 15-minute
  sign-in link. Seven days does not need a minute of slack, and the comparison happens
  in SQL against one server's clock.

## Testing requirements

**Unit (`packages/folio/test/unit/`):** the share cookie's screen, cap, de-duplication
and newest-first append; that `readSessionCookie` does not see it; the expiry default,
ceiling and refusals. All pure — no D1, no Request.

**Workers (`packages/folio/test/workers/`, real workerd):** every acceptance criterion.
Two are structural and must not be skipped: the **enumeration table** (every other
route family, as data rather than prose, so a route added later without a gate fails
here) and the byte-identical lapsed page across all its causes. Plus the `shares` block
in `migrations.test.ts` asserting the columns, the two indexes, the *absence* of
`shares_story`, the *absence* of any role or scope column, and `expires_at not null`
against `api_tokens.expires_at`.

**End to end (`scripts/preview-share-test.mjs`, new):** the half a workers test cannot
do. "Unauthenticated" in a workers test is a header the test chose not to set; here it
is a real HTTP client that never had a credential, following a real 302 and a real
`Set-Cookie` through a real Worker. `signInGlobally()` to mint, then **`realFetch`**
for every reviewer request, with an assertion inside the helper that no session cookie
has leaked into its jar — a test that accidentally sends the admin's cookie proves
nothing. `RealWebSocket` for the socket refusal, since undici refuses an `Upgrade`
header on `fetch`.

## Dependencies

- `foundation/identity-and-access.md` for `auth/secrets.ts`, the cookie discipline, the
  `Actor` model this deliberately stays outside of, and `requireAuthConfigured`.
- `content-model/globals.md` for `?as=`, which the grant must refuse.
- `foundation/pagination.md` for the `{base}/api` prefix, the keyset helpers and the
  opt-in `count`.
- No Cloudflare resources, no bindings, no host config. The host-side cost is zero.

## Out of scope

- **Sharing a record or a singleton.** They have `path === null` and therefore no page
  to preview; `POST` refuses with a message saying so. Honouring a grant at
  `{base}/preview/global/:name` would be a second entry point into a second rendering
  path.
- **Comments on a shared preview.** The obvious next want, and it needs an identity for
  the commenter, a store, and a notification path — a feature, not an addition.
- **A password on the link.** Two secrets where one suffices; the link *is* the
  credential, and a password that is emailed alongside it protects nothing.
- **Per-link locale pinning.** A grant is per document and every locale is the same
  document.
- **An admin UI.** Owned separately; what a screen needs is in the notes below.
- **Site-visitor auth.** Still out of scope, still `identity-and-access.md`'s note.

## Open questions

None outstanding.

## Implementation notes

Built as planned, in the four phases named. Everything in *Architecture decisions*
landed as argued. Six things are worth recording.

1. **`applySeedFixture` now clears what the seed writes credentials into.** Adding a
   seeded share to `examples/demo/seed.sql` broke 203 tests across five files at once,
   because that fixture re-applies the real seed inside a `beforeEach` and
   `shares_token` is unique. The same failure had already been fixed twice by adding a
   `delete` to whichever test file failed (`users`, then `api_tokens`), which is why it
   happened a third time. The clears moved into the fixture, which is the one module
   that knows which tables the seed touches. `stories` is deliberately left to the
   callers, several of which seed extra rows around the demo three.
2. **`expiredLinkPage` takes no `FolioRuntime`,** and the signature is the point rather
   than an oversight: it must not name the site, link into it, or say which document
   the link was for. `tsc` caught the unused parameter, which turned out to be the
   design telling the truth.
3. **The `?as=` refusal was found by writing decision 1a down, not by testing.** The
   grant covers one page; `?as=<global>` renders a *singleton's* draft in that page's
   context, and nothing about "one story id" would have stopped it. It is refused
   before the global is looked up, so the refusal cannot depend on which globals a host
   configured.
4. **The share check sits after `storyByPath`, not beside the actor check**, and it has
   to: a grant names one story id and the story is only known once the path has been
   resolved. The "no D1 read for a request with no credential" discipline is preserved
   by testing for the cookie's *presence* up at the actor check and returning null
   there when it is absent — so a stranger appending the flag to a random URL still
   costs the database nothing.
5. **`NO_STORE` is `'private, no-store'`.** Three test assertions were written against
   the literal `'no-store'` and failed; they now import the constant, which is what
   they should have done.
6. **The e2e script's seeded-link check earns its place.** It is the only thing that
   verifies the precomputed SHA-256 in `seed.sql` matches the plaintext in its own
   comment — a workers test cannot, because it would compute the hash the same way the
   server does and agree with itself.

**Amended 2026-08-03 by spec 24 (`platform/mcp-server.md`): a share link now lands on
`?_folio=draft`, not `?_folio=preview`.** This spec shipped a bug and nobody decided it.
There was exactly one draft render and it was the *editing* one, so `preview.ts`'s redirect
to `rt.withUrls(story).previewUrl` sent a client reviewing a draft into the editor's view of
the page: `folio-editing` on the body, a dashed outline following their cursor
(`mount.tsx`'s `attachBridge` is unconditional), and **every link on the page dead**,
because the bridge calls `preventDefault` on any click inside a marked block. That is not
what "send this to the client for review" means — decision 1's own framing here is a
reviewer looking at the page, and a page whose links do not work is not the page.

Spec 24 decision 5 added a second mode, `?_folio=draft`, which renders the same document
with no `folio-editing`, no marker wrappers and **no client entry at all**, so the bridge
cannot attach. `shareUrl` points there; the admin's own iframe keeps `preview`. A sanctioned
behaviour change, and the only one this spec's work needed. `shares.test.ts` has one flipped
expectation and one new test that follows the link and asserts the absence of both the
chrome and the bridge; its other `?_folio=preview` assertions are untouched, because they
pin the *gate*, which did not move.

One limit spec 24 established and this spec never claimed either way: the draft render is
Folio's own preview shell, not the host's page layout. A reviewer following a share link
sees the document's own content correctly, on the host's block CSS, with globals stacked
above it rather than placed as the host would place them.

**Gates.** `pnpm typecheck` 0. `./node_modules/.bin/biome ci .` 0. `vitest run` 0 —
93 files, 2798 tests, all passing. `./scripts/e2e.sh scripts/preview-share-test.mjs`
47/47. `./scripts/e2e.sh scripts/auth-test.mjs` 44/44, unchanged by this work.

**No admin UI, by arrangement.** What a screen needs, precisely:

- **Where it belongs: the editor's top bar**, beside Publish — "Share a preview". It is
  a publish-shaped act and `PUBLISH` is its gate, so it sits with the other one.
- **`canShare(me)` = `canPublish(me)`** in `admin/me.ts`, and `whyNot` gains a
  `'share'` need whose refusal reads "may not publish" — the routes answer 403 with
  exactly that wording.
- **A dialog on click**, through `useFocusTrap` like the other six: an optional note
  ("For Rachel's Friday review"), a day count defaulting to 7 and bounded 1–90, and a
  Create button. `POST {base}/api/story/:id/share` → `201 { url, share }`.
- **The URL is shown exactly once.** It is the only response that ever contains it, so
  the dialog must present it with a copy button and say plainly that it cannot be shown
  again — the same treatment `POST {base}/api/tokens` already gets on the Access
  screen, and the same component should serve both.
- **A list in the same dialog**, from `GET {base}/api/shares?story=<id>&state=live`:
  note, who made it, when it expires, `views` and `lastViewedAt` ("opened 3 times, last
  yesterday" is the answer to "did they look?"), and a Revoke button per row →
  `DELETE {base}/api/shares/:id`, which 404s a second time so the button should
  disappear on success rather than stay clickable.
- **The button is disabled for an unrouted document** with the reason on hover: a
  record or singleton has no page to preview and the route answers 400. `story.path
  === null` is the test, available on every row the shell already holds.
- **Nothing on the Content screen.** A site-wide share list is a real want and it is
  not this: `GET {base}/api/shares` without `?story=` already answers it, and the
  natural home is a rail on the Access screen beside Tokens, where the other
  outstanding credentials are.
