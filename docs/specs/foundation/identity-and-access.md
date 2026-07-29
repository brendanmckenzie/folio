# Feature: Identity and access — who is editing, and what they may do

> **Group:** foundation
> **Build order:** 10
> **Size:** L
> **Status:** draft
> **Wire version:** none (`hello`'s identity fields become advisory; they are removed at v3 with localisation)
> **Migration:** `0007_identity.sql`
> **Last updated:** 2026-07-29

## Summary

There is no auth. Anyone who reaches `/folio/edit` can edit and publish, and the
Durable Object believes whatever a client says about itself: the actor id, display
name and colour all arrive in the `hello` frame from the browser
(`src/admin/store.ts:115-158`), so the activity trail, the version list and the
presence dots are all self-reported. `src/server/routes/editor.ts:49` carries the
TODO.

This is the standing biggest gap in `ROADMAP.md`, and it is a companion to two of
the wants in `docs/feedback.md` rather than one of them: programmable data access
needs tokens and scopes, and "proper multiplayer" needs an identity that is not a
random 8 characters.

Scope: **CMS auth only** — who may edit. Site-visitor auth (who may *read* a
published page) is a different problem and is out of scope, with a note on where it
would attach.

## Ground truth

**server (`packages/folio/src/server/`):**
- `routes/editor.ts` — `GET /folio/edit/:id` serves the admin to anyone, and
  `GET /folio/story/:id/socket` upgrades for anyone. The socket route already has
  the pattern this spec needs for refusing a connection: for a deleted story it
  **accepts the upgrade and immediately closes with an application code** (4002),
  because a plain HTTP failure is indistinguishable on the wire from a dropped
  handshake and makes the client retry forever.
- `routes/stories.ts:97` reads the publishing actor from the `x-folio-actor`
  request header (`actorHeader` in `validate.ts:294-297`, bounded to 64 chars).
  `useVersions.checkpoint` sends `actor: store.name` in the *body*. Both are
  whatever the client typed.
- `errors.ts` — `FolioErrorCode` is `bad_request | not_found | conflict |
  too_large | unsupported`, mapping to 400/404/409/413/501. **There is no 401 or
  403**, so both codes and statuses need extending.
- `middleware.ts` — `withBindings` installs a *memoised thunk*, deliberately, so
  routes that answer from the config alone (`/schema`, a 404, a refused upgrade)
  do not start depending on the host's accessor. An auth middleware must respect
  the same rule: no D1 read for a request that does not need one.
- `publish()` and `checkpoint()` (`publish.ts`) take `actor: string | null` as a
  parameter and neither takes a `Request` — the seam is already cut for a verified
  identity to be passed in.
- `versions.actor` (`migrations/0001_initial.sql`) and the DO log's
  `actor` / `actor_name` columns (`story-do.ts`) exist and are already written.

**core (`packages/folio/src/core/`):**
- `protocol.ts:184-192` — `normalizeHello` caps and defaults the identity a client
  asserts (strips control and bidi characters, falls back to `Anonymous`, derives a
  deterministic colour from the actor id when the given one is malformed). It
  normalises; it cannot verify.
- `parseClientFrame` rebuilds each frame from only the fields its type declares, so
  junk keys never reach a broadcast.
- Close codes in use: 4001 (protocol version), 4002 (story purged). The client
  treats both as terminal and stops reconnecting (`store.ts:259-263`).

**story-do.ts — the detail that matters:**
- The `hello` handler *creates* the socket attachment
  (`ws.serializeAttachment(attachment)`), and `broadcast` uses
  `if (!socket.deserializeAttachment()) continue` as its **pre-hello quarantine**:
  a socket that has not said hello has no watermark, so it must not receive
  deltas. Attaching a server-verified identity at upgrade time would give every
  socket an attachment immediately and silently break that quarantine. It needs an
  explicit `joined` flag (decision 3).

**admin (`packages/folio/src/admin/`):**
- `store.ts:115-118` — `actor = crypto.randomUUID().slice(0, 8)`, `name = 'Editor
  ' + actor.slice(0,3)`, `colour` picked at random from six.
- `TopBar.tsx` renders `store.colour` for "me" and `p.colour` / `p.name` for peers.
- `api.ts` centralises the one error envelope: every mutating call goes through
  `expectOk`, which throws the envelope's message. A 401 arriving there today would
  surface as a toast reading whatever the message says — so the redirect-to-login
  behaviour has exactly one place to live.

## Owner decision checkpoints

1. **Opaque random session tokens, stored hashed (recommended).** 32 bytes from
   `crypto.getRandomValues`, SHA-256 in D1, the raw value only in the cookie. No
   HMAC secret to configure, rotate or leak, and revocation is a `delete`. The
   alternative — a signed/JWT cookie — is stateless but cannot be revoked, which is
   the wrong trade for a CMS where "remove that person's access now" is the point.
2. **`auth: 'open'` must be written explicitly or `createFolio` throws
   (recommended).** Folio is a library; a host that forgets to configure auth
   currently gets a publicly editable CMS, silently. Failing at construction makes
   that impossible to do by accident, and the demo says `auth: 'open'` in one line
   with a comment. Overriding this means keeping today's default and accepting that
   the failure mode is a defaced site.
3. **Roles are global, not per-space (recommended).** `viewer | editor | publisher
   | admin` on the user row. Folio has no concept of a space or a site yet, so
   per-space roles would be modelling something that does not exist. Cost: a
   multi-site deployment needs this revisited before it is useful.
4. **Origin checking rather than CSRF tokens (recommended).** Every mutating route
   is a JSON `POST`/`PATCH`/`DELETE`, the cookie is `SameSite=Lax`, and the
   middleware additionally refuses a mutating request whose `Origin` is not the
   worker's own. That is three overlapping defences and no token plumbing. The
   alternative — a synchroniser token — costs a per-form round trip for no gain
   here.
5. **A revoked session closes an open socket within a bounded window
   (recommended).** The session's expiry rides in the socket attachment and is
   checked on every frame; explicit revocation is picked up on the next connect or
   the next expiry check, whichever comes first. The alternative — the Durable
   Object querying D1 per frame — puts a database read in the keystroke path. Cost:
   a revoked editor may keep typing for up to the check window (proposed: the
   attachment carries `expiresAt`, and the DO re-checks against D1 at most once a
   minute per socket).

## User stories

### Owner controls who can edit
**As** the site owner **I want** editors to sign in, and to be able to remove
someone's access **so that** the CMS is not open to anyone who finds the URL.

### History says who did it
**As** an editor investigating a change **I want** the activity trail and version
list to name a real person **so that** "who broke this" has an answer that cannot
be spoofed by editing a JavaScript variable.

### Client editor signs in without an account to manage
**As** a client editor **I want** to receive a sign-in link by email **so that** I
do not need to be added to a directory I am not part of.

### Staff sign in with their work account
**As** a staff editor **I want** to sign in with Microsoft 365 **so that** access
follows my employment rather than a password in a spreadsheet.

### Reviewer can look without publishing
**As** an owner **I want** to give someone read access to drafts without letting
them publish **so that** a reviewer can see work in progress safely.

### Script authenticates as itself
**As** a developer **I want** a scoped API token **so that** an import script can
write content without impersonating a person or holding a session cookie.

## Architecture decisions

### 1. Sessions in D1, behind an opaque httpOnly cookie

`sessions.id` stores the SHA-256 of a 32-byte random token; the cookie holds the
raw token. Lookup is one indexed read; revocation is one delete; there is no secret
in the environment. Sessions carry `expires_at` (proposed: 30 days, renewed on use
past the halfway mark) and `user_id`.

Cookie name is `__Host-folio_session` with `Secure`, `HttpOnly`, `SameSite=Lax`,
`Path=/`. The `__Host-` prefix requires HTTPS, which `http://localhost` under
`wrangler dev` is not — so the name is chosen per request: `__Host-` prefixed when
the request URL is `https:`, plain `folio_session` otherwise. Both are read on the
way in, so a developer moving between local and deployed is never stuck with a
cookie the server will not accept.

### 2. Providers are the host's, the session is Folio's

Folio owns sessions, roles and the cookie. It does not own the mail account or the
identity provider, so both are configured:

```ts
const folio = createFolio<Env>({
  blocks, types,
  bindings: (env) => ({ db: env.DB, story: env.STORY, media: env.MEDIA }),
  auth: {
    providers: [
      // Sign-in link by email. Folio renders and stores the challenge; the host
      // sends the mail, because only the host has the binding and the from-address.
      magicLink({ send: (env, { email, url, expiresAt }) => sendEmail(env, …) }),
      // OIDC with PKCE. Discovery document, client id, and a secret from the env.
      oidc({
        issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
        clientId: (env) => env.OIDC_CLIENT_ID,
        clientSecret: (env) => env.OIDC_CLIENT_SECRET,
        // A verified email that matches no user is refused by default; set this
        // to auto-provision staff on first sign-in.
        provision: 'refuse',
      }),
    ],
    sessionDays: 30,
  },
})
```

Cloudflare Access is deliberately not the plan (`ROADMAP.md` says so): it is
IdP-shaped, it gates the whole route rather than carrying a per-user role into the
editor, and it cannot represent "this client editor may edit these pages but not
publish".

### 3. Identity is attached to the socket before `hello`, and the quarantine gets an explicit flag

The worker validates the session, then hands the verified identity to the Durable
Object as a request header on the upgrade (`routes/editor.ts` already forwards
`c.req.raw` to `rt.stub(...).fetch()`). Durable Object namespaces are not publicly
addressable — the only way to reach the object is through this Worker — so a header
the Worker sets is trustworthy in a way the `hello` frame never was.

`StoryDO.fetch` reads it and calls `serializeAttachment` immediately after
`acceptWebSocket`, so the identity exists before the first frame is parsed:

```ts
interface Attachment {
  actor: string          // user id, server-supplied
  name: string           // display name, server-supplied
  colour: string         // from the user row
  role: Role             // server-supplied
  expiresAt: number      // session expiry; checked per frame
  joined: boolean        // has said hello — the quarantine flag
  selection: string | null
}
```

`joined` is the load-bearing part. `broadcast` currently uses "has an attachment"
as its membership test, which stops a socket that has not said hello from receiving
a delta it cannot place against a watermark. With identity attached at upgrade
time every socket has an attachment, so the test becomes
`if (!a?.joined) continue`, and `hello` sets `joined: true` rather than creating the
attachment. Missing this is a silent correctness regression in the sync engine, not
a login bug.

`hello`'s `actor`, `name` and `colour` become **advisory and ignored** — the shape
guard keeps accepting them, so no protocol bump is needed and an old tab keeps
working (it just cannot lie any more). They are deleted from `ClientMsg` at the
next bump, which `localisation.md` already spends.

### 4. An unauthenticated socket is accepted and closed with 4003

Exactly the pattern `routes/editor.ts` already uses for a purged story, and for the
same documented reason: a failed HTTP upgrade is indistinguishable from a dropped
connection, so the client would reconnect on a backoff forever. Two new application
close codes:

- **4003 — not signed in / session expired.** Terminal in the client, which shows
  "Your session ended. Sign in again." with a link, and — importantly — keeps its
  `pending` queue, so nothing typed is lost (`store.ts`'s `pending` survives
  `disconnect()` by design).
- **4004 — forbidden.** The session is valid but the role may not edit this story.

### 5. Roles gate at the door, in one table

| | read drafts | edit (tx) | publish / checkpoint | create / delete / move | manage users & tokens |
| --- | --- | --- | --- | --- | --- |
| `viewer` | yes | no | no | no | no |
| `editor` | yes | yes | no | no | no |
| `publisher` | yes | yes | yes | yes | no |
| `admin` | yes | yes | yes | yes | yes |

Enforced in two places and no more: a Hono middleware for the HTTP routes, and the
`tx` case in the Durable Object, which answers a `viewer` with the existing
`reject` envelope (`{ type: 'reject', txId, reason }`). That envelope already makes
the client drop the transaction from `pending` and surface the reason, so a
read-only editor degrades into a read-only editor rather than a broken one.

The admin additionally disables the affordances, but the server is the authority —
the reject path must be correct even if the UI is wrong.

### 6. API tokens are the same table set, with scopes instead of a role

`api_tokens` rows hold a SHA-256 of the token, a name, a scope list, an optional
expiry and a `last_used_at`. Presented as `Authorization: Bearer folio_<random>`.
Scopes: `content:read`, `content:read:draft`, `content:write`, `publish`,
`assets:write`, `admin`. A token resolves to an actor string of
`token:<name>` so the activity trail and version list say
`token:import-script` rather than naming a person who was not there.

Tokens are defined here because they belong with sessions and share the middleware;
they are *used* by `../platform/content-api.md`.

### 7. The login page ships no JavaScript

`GET /folio/login` is server-rendered HTML with a form, in the same `Shell` the
admin and preview pages use (`server/Document.tsx`). A CMS login page that cannot
work without a client bundle is a worse failure than an ugly one, and the pattern
matches the project's existing rule for published pages.

## Wire & schema changes

### D1 migration `0007_identity.sql`

```sql
-- Editors. Not site visitors: reading a published page needs no account, and
-- site-visitor auth is deliberately a separate problem (see Out of scope).
create table if not exists users (
  id          text primary key,          -- usr_<12 hex>
  email       text not null unique,      -- lowercased on write
  name        text not null,
  -- Presence colour. Defaults to protocol.ts's deterministic fallbackColour(id)
  -- when null, so a user row never has to carry one.
  colour      text,
  role        text not null default 'editor'
                check (role in ('viewer', 'editor', 'publisher', 'admin')),
  provider    text,                      -- 'magic' | 'oidc' | null (invited, never signed in)
  created_at  integer not null,
  last_seen_at integer
);

-- One row per signed-in browser. `id` is the SHA-256 of the cookie's token, so a
-- leaked database gives no usable cookies.
create table if not exists sessions (
  id          text primary key,
  user_id     text not null references users(id) on delete cascade,
  created_at  integer not null,
  expires_at  integer not null,
  -- Diagnostics only, never trusted for anything.
  user_agent  text
);

create index if not exists sessions_user on sessions (user_id);
create index if not exists sessions_expiry on sessions (expires_at);

-- Single-use sign-in challenges. Same hashing rule as sessions.
create table if not exists login_challenges (
  id          text primary key,          -- SHA-256 of the emailed token
  email       text not null,
  created_at  integer not null,
  expires_at  integer not null,
  consumed_at integer
);

-- Programmatic access. Scopes rather than a role: a token is not a person.
create table if not exists api_tokens (
  id           text primary key,         -- SHA-256 of the presented token
  name         text not null,
  scopes       text not null,            -- JSON array
  created_by   text references users(id) on delete set null,
  created_at   integer not null,
  expires_at   integer,
  last_used_at integer,
  revoked_at   integer
);
```

### Core / server types

- `FolioErrorCode` gains `unauthorized` (401) and `forbidden` (403);
  `FolioErrorStatus` gains both. `errors.ts` is the only place that changes.
- `FolioVars` gains `actor: Actor | null` — `{ kind: 'user', id, name, colour,
  role } | { kind: 'token', name, scopes }` — set by the auth middleware as a
  value, not a thunk: unlike bindings, resolving it *is* the middleware's job.
- `FolioConfig.auth: AuthConfig | 'open'`, required.
- `publish()`/`checkpoint()` keep their `actor: string | null` parameter; the route
  passes `c.var.actor` instead of the header. `actorHeader` and its `x-folio-actor`
  reads are deleted, and so is `actor` in the checkpoint body.
- `Attachment` in `story-do.ts` per decision 3.

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/folio/login` | none | Sign-in page (HTML, no JS) |
| POST | `/folio/login/email` | none, rate limited | Request a sign-in link. **Always** answers 200 with the same body, whether or not the email is known |
| GET | `/folio/login/verify?t=` | none | Consume a challenge, create a session, redirect to `/folio/edit` |
| GET | `/folio/login/oidc` | none | Start OIDC with PKCE + state in a short-lived cookie |
| GET | `/folio/login/oidc/callback` | none | Exchange, match or provision a user, create a session |
| POST | `/folio/logout` | session | Delete the session, clear the cookie |
| GET | `/folio/me` | session or token | The current actor, for the admin's user menu |
| GET/POST/PATCH/DELETE | `/folio/users[/:id]` | admin | Manage editors |
| GET/POST/DELETE | `/folio/tokens[/:id]` | admin | Manage API tokens; POST is the only response that ever contains the raw token |
| — | everything else under `/folio` | session or token | Per the role/scope table |

`GET /folio/asset/:key` stays **public**: published pages point `<img>` tags at it.
That is the one deliberate hole, and it is the same one the published page itself
is.

## Acceptance criteria

### The editor is closed
```
GIVEN no session cookie
WHEN GET /folio/edit/:id is requested
THEN it responds 302 to /folio/login?next=… and no admin bundle is served
AND WHEN GET /folio/stories is requested
    THEN it responds 401 with { error: { code: 'unauthorized', … } }
```

### An unauthenticated socket is refused terminally
```
GIVEN no session cookie
WHEN the sync socket is opened
THEN the upgrade succeeds and the socket is closed with code 4003
AND the client shows "sign in again", stops reconnecting, and keeps its pending queue
```

### Identity cannot be asserted
```
GIVEN a signed-in user "Ann" (usr_abc)
WHEN their client sends hello with actor 'bob', name 'Bob', colour '#000000'
THEN presence broadcasts Ann's id, name and colour
AND a transaction from that socket logs actor usr_abc / actor_name 'Ann'
AND a publish from that session records actor usr_abc, whatever headers were sent
```

### The pre-hello quarantine still holds
```
GIVEN a socket that has upgraded with a valid session but has not sent hello
WHEN another editor's transaction is broadcast
THEN that socket receives nothing
AND after it sends hello it receives a bootstrap or catchup, and deltas from then on
```

### Roles
```
GIVEN a viewer session
WHEN a tx frame is sent
THEN the object answers { type: 'reject', txId, reason: 'read-only: your role may not edit' }
AND nothing is logged, nothing is broadcast, and the client drops the tx
AND POST /folio/story/:id/publish answers 403
AND the admin renders the inspector read-only and disables Publish
```

### Publishing needs a publisher
```
GIVEN an editor (not publisher) session
WHEN POST /folio/story/:id/publish is called
THEN 403 forbidden, and no version row and no published_doc write happen
```

### Sign-in link is single use and short lived
```
GIVEN a sign-in link emailed to a known editor
WHEN it is opened once
THEN a session is created and the challenge is marked consumed
AND WHEN the same link is opened again, or opened after 15 minutes
    THEN it is refused with the same generic message, and no session is created
```

### Email addresses are not enumerable
```
GIVEN POST /folio/login/email for an address with no user
THEN the response is byte-identical to the known-address case and no mail is sent
```

### Revocation
```
GIVEN an editor with an open socket
WHEN an admin deletes their user (or their session)
THEN their next HTTP request answers 401
AND their socket is closed with 4003 within the check window
AND transactions they had already logged remain, attributed to them
```

### Tokens
```
GIVEN a token with scopes ['content:read']
WHEN it calls a write route
THEN 403 forbidden naming the missing scope
AND the token's last_used_at is updated either way
AND a revoked token answers 401
```

### Construction refuses ambiguity
```
GIVEN createFolio called with no `auth` key
THEN it throws: auth must be configured, or set auth: 'open' deliberately
```

## Implementation plan

Deploy order: phases 1–3 are additive and can ship with `auth: 'open'` still
configured; phase 4 is the switch-over, and phase 5 is the deletion of the
self-reported paths.

### Phase 1 — session core

1. Migration `0007_identity.sql`.
2. `server/auth/session.ts`: token generation, SHA-256 hashing (`crypto.subtle`),
   `createSession`, `readSession` (with sliding renewal), `revoke`,
   `deleteExpired`. Pure over a `D1Database`, no Request.
3. `server/auth/cookie.ts`: name selection by scheme, serialise/parse, clear.
4. `errors.ts`: `unauthorized`, `forbidden`.
5. Tests: `test/workers/auth-session.test.ts` — hashing, expiry, renewal window,
   revocation, the cookie-name rule.

### Phase 2 — providers and the login page

1. `server/auth/magic-link.ts`: challenge create/consume, generic responses,
   per-address and per-IP rate limits.
2. `server/auth/oidc.ts`: discovery, PKCE, state cookie, code exchange, id-token
   validation (issuer, audience, `nonce`, `exp`, signature via JWKS), the
   `provision` rule.
3. `server/pages.tsx`: `loginPage()` in the existing `Shell`, with a provider
   button per configured provider and an error banner. No client entry.
4. `server/routes/auth.ts`: the routes in the table.
5. Tests: `test/workers/auth-login.test.ts` — single use, expiry, enumeration
   resistance, OIDC state/nonce mismatch refusals, `provision: 'refuse'`.

### Phase 3 — enforcement

1. `server/middleware.ts`: `withActor` (session cookie, then bearer token, then
   null) and `requireRole(...)` / `requireScope(...)`. `withActor` must not read D1
   for a request with neither credential — the memoised-thunk discipline applies.
2. `server/app.ts`: mount `withActor` after `withBindings`; leave `/schema`,
   `/login*`, `/asset/:key` open; gate the rest.
3. `routes/editor.ts`: 302 for the HTML route; upgrade-and-close-4003/4004 for the
   socket; pass the verified identity to the object as a header.
4. `story-do.ts`: read the identity header in `fetch`, attach it after
   `acceptWebSocket`, add `joined`, fix `broadcast`'s membership test, gate `tx` on
   role, check `expiresAt` per frame.
5. `routes/stories.ts` / `history.ts` / `assets.ts`: role gates; `actor` from
   `c.var.actor`.
6. Tests: `test/workers/story-do.test.ts` — the quarantine with an attachment
   present, refused `tx`, expiry close; `test/workers/http.test.ts` — every route's
   role gate.

### Phase 4 — admin

1. `api.ts`: one place turns a 401 into a redirect to `/folio/login?next=`. It must
   not become a toast: the existing `expectOk` throw path is where this hooks in.
2. `store.ts`: drop the generated actor/name/colour; read them from `/folio/me`;
   handle 4003/4004 as terminal with a sign-in link.
3. `TopBar.tsx`: a user menu (name, role, sign out) in place of the anonymous "me"
   dot.
4. A read-only mode driven by role: inspector disabled, Publish disabled, the
   reason on hover. Reuses the `readOnly` path `useVersions`' viewing mode already
   established in `Editor.tsx`.
5. An admin screen for users and tokens (`admin` role only).

### Phase 5 — remove the self-reported paths

1. Delete `actorHeader`, the `x-folio-actor` reads, and `actor` from the checkpoint
   body.
2. Flip the demo to a real provider, keep `auth: 'open'` documented for local dev.
3. `README.md`: an Auth section, and remove "Auth (there is none — anyone can
   edit)" from *Not built yet*. `ROADMAP.md`: move both auth items out.

## Edge cases

- **Session expires mid-edit with unsent transactions** → the socket closes 4003,
  `pending` survives (by design), and after signing in again the queue flushes with
  its original txIds, which the log dedupes. Nothing typed is lost. This is worth a
  test.
- **Role downgraded mid-session** → HTTP requests answer 403 immediately; the open
  socket keeps the role in its attachment until the expiry re-check. Bounded and
  documented (checkpoint 5).
- **Two tabs, one signs out** → the cookie is cleared for both; the other tab's
  next request 401s and its socket closes at the next check. Acceptable.
- **A user deleted while a version row names them** → `versions.actor` stores a
  string, not a foreign key, so history keeps the id and the admin shows "(removed
  user)" when it cannot resolve it. History must not be rewritten by an access
  change.
- **`provision: 'auto'` and a personal Microsoft account** → the issuer check
  refuses anything not from the configured tenant. Email domain is *not* the check;
  the issuer is.
- **Clock skew on a magic link** → 15 minutes of validity with a 60-second leeway
  on `exp` comparisons, the same leeway the OIDC id-token check uses.
- **Login rate limiting** without a KV or Durable Object counter → a per-address
  count in `login_challenges` (challenges created in the last hour) plus a
  Cloudflare rate-limiting rule at the zone for the IP dimension. Named as a
  partial answer rather than pretended complete.
- **`__Host-` cookie on a `workers.dev` preview** → HTTPS, so the prefixed name
  applies and works.
- **Host that mounts Folio under a different `basePath`** → cookie `Path=/` covers
  it; the `__Host-` prefix requires `Path=/` anyway.
- **An open socket to a story the user may read but not edit** (future per-story
  rules) → 4004 is reserved for it now; today it cannot happen because roles are
  global.

## Testing requirements

**Unit:** cookie name selection; scope and role predicates; the normalisation that
`hello` no longer performs (keep the existing `protocol.test.ts` coverage — the
functions stay, they simply stop being load-bearing).

**Workers (real workerd):** every acceptance criterion above. Two are structural
rather than about auth and must not be skipped: the pre-hello quarantine with an
attachment present, and the unsent-queue survival across a 4003.

**End to end (`scripts/auth-test.mjs`, new):** sign in with a magic link against
the dev server, edit, publish, sign out, confirm the editor and the socket are both
refused afterwards, and confirm a published page still renders and its assets still
serve while signed out.

## Dependencies

- Nothing in this set. It is fourth in build order for value, not because it is
  blocked.
- Host-side: an email sending path for magic links (Cloudflare Email Sending is the
  obvious one) and an OIDC app registration. Neither is Folio's to own.
- `../platform/content-api.md` and `../editing/live-collaboration.md` both depend
  on this.

## Out of scope

- **Site-visitor auth** — who may *read* a published page (the reference project's
  `access_level`, roles, OTP login). It attaches in two places when wanted: a field
  on the root block, which `document-types.md` already makes per-type, and a host
  check before `folio.published()`. Deliberately not smuggled into a CMS-auth spec.
- **Per-story and per-branch permissions.** Needs a way to name a set of stories;
  revisit after `collections.md`.
- **Multi-tenant spaces.** Roles are global (checkpoint 3).
- **SSO group → role mapping.** `provision` sets a default role; mapping groups
  needs claims configuration per tenant and is a follow-up.
- **Passkeys, TOTP, password login.** Magic link plus OIDC covers both audiences,
  and a password store is a liability nobody asked for.
- **A separate audit log.** The activity trail plus version rows already record who
  changed content; auth events (sign-in, role change, token created) are the gap,
  and one `auth_events` table is a follow-up rather than a prerequisite.

## Open questions

- Should a `viewer` be allowed to open the sync socket at all? Read-only via the
  socket is how they see live changes, so yes as specified — but it means a viewer
  holds an editing session and appears in presence. Alternative: viewers get a
  draft-mode preview cookie (`ROADMAP.md`'s *Cookie-based draft mode*) and no
  socket, which is cheaper and arguably more honest about what they are.
