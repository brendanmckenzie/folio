# Feature: Auth providers, part 2 — kinds, trusted identity, and finishing SSO

> **Group:** foundation
> **Build order:** 28
> **Size:** L
> **Status:** done
> **Wire version:** none
> **Migration:** `0006_auth.sql` — restamped from the `0005` this was drafted with,
> because 30 built first and took `0005_content_fts.sql`. Every mention below is
> `0006`.
> **Build sequence:** 3 of 4 — 31 → 30 → 28 → 29 (owner, 2026-09-05). The **Build order** above is this spec's identity, not its place in the queue.
> **Last updated:** 2026-09-05

## Summary

`AuthProvider` is a bag of optional functions switched on `redirect: boolean`
(`src/server/auth/config.ts:34-55`), and both the routes and the login page re-derive
what a provider *is* from which functions it happens to carry. There is no way for a
host that already authenticates people — behind Cloudflare Access, behind its own
session, behind a proxy — to hand Folio a verified identity, and the two things spec 10
deferred for SSO (roles from claims, a provider a domain must use) have nowhere to
attach. This spec replaces the bag with four provider *kinds*, adds a trusted-identity
kind with a Cloudflare Access helper, finishes SSO, and routes every sign-in through one
function — `completeSignIn` — so that the provider stamp, domain enforcement and the
audit row cannot be skipped by any path, including one a host writes. It also fixes a
visible bug it found on the way: `users.provider` is only ever written by OIDC
provisioning (`src/server/routes/auth.ts:272-283`), so the Access screen's "Signs in
with" column reads "—" for every magic-link user.

Scope is still **CMS auth**: who may edit. Who may *read* a published page is
`platform/visitor-access.md` (spec 31). SAML is not here and will not be: a SAML-only
identity provider reaches Folio through a broker — Cloudflare Access, or an IdP that
fronts SAML with OIDC — and arrives as either the `redirect` or the `trusted` kind.

## Ground truth

Verified 2026-09-05 against the tree at `0f0df54`. Paths are `src/…`; the older specs'
`packages/folio/src/…` prefix is the same file.

**core (`src/core/`):**
- Nothing auth-shaped lives in core. The one dependency the auth layer takes on it is
  `fallbackColour` (`src/core/protocol.ts`), which `users.ts:63-65` uses to derive a
  presence colour for a row with none. The provider union below is a server type.

**server (`src/server/`):**
- `auth/config.ts:34-55` — `AuthProvider<Env>`: `id`, `label`, `redirect: boolean`
  (40), then four optionals — `send?` (42), `start?` taking `{ redirectUri, next }`
  (45-48), `callback?` taking `{ url, redirectUri, state }` (50-53), `provision?`
  (55). `OidcState` (58-63) carries `state`, `nonce`, `verifier` **and `next`**, so
  the state cookie is OIDC-shaped rather than provider-shaped. `VerifiedIdentity`
  (65-68) is `{ email, name? }` and nothing else — no room for a claim.
  `Provisioning` (76), `AuthConfig` (78-89), `ResolvedAuth` (92-94).
- `auth/config.ts:107-157` — `resolveAuth` validates at construction: non-empty
  providers, non-empty unique ids, a non-redirect provider must have `send`
  (129-133), a redirect one must have `start` (134-138), a provision role must pass
  `isRole` (139-146), positive `sessionDays`/`linksPerHour`. Nothing checks that a
  redirect provider has a `callback`.
- `auth/config.ts:175-185` — `AuthPolicyProvider` projects a provider as five named
  fields including `redirect: boolean` (179); `authPolicy` (227-244) builds it with
  `redirect: Boolean(p.redirect)` (232). The projection-by-name rule at 162-174 is the
  guard against a host's `clientSecret` shipping to a client; the new shape keeps it.
- `auth/magic-link.ts:31-43` — `MAGIC_LINK_ID = 'magic'`; `magicLink()` returns
  `{ id, label, redirect: false, send }`.
- `auth/oidc.ts:30` — `OIDC_ID = 'oidc'` is fixed, so two OIDC tenants cannot coexist
  in one configuration. `OidcOptions` (40-56): `issuer`, `clientId`, `clientSecret`,
  `scopes?`, `provision?`, `label?`, `fetchImpl?`. The JWS primitives — `base64url`
  (92), `fromBase64url` (100), `algorithmFor` (131), `verifyParams` (147) — are
  module-private. `verifyIdToken` (159-216) **requires a nonce** in `expect` (161) and
  compares it at 210, so it cannot verify a JWT that has none — which is every
  Cloudflare Access assertion. `oidc()` (219-305) returns `id: OIDC_ID` (226),
  `redirect: true` (228); `start(env, { redirectUri, next })` (231) puts `next` in the
  state (232-237); `callback` (254) answers `{ email, name }` (303).
- `routes/auth.ts:54` — `SENT`, the byte-identical answer `POST /login/email` gives
  whether or not an address is known. `signIn` (97-110) mints the cookie from
  `createSession`. `GET /login` (112-130) renders `loginPage` with a fixed error
  vocabulary `link | refused | provider`. `POST /login/email` (139-177) finds its
  provider by sniffing `!p.redirect && typeof p.send === 'function'` (141), then
  `userByEmail` (149), the rate check, `createChallenge`, `send`. `GET /login/verify`
  (187-207): `consumeChallenge`, `userByEmail` (196), refuse a vanished account
  (200-202), `signIn` (205). `GET /login/:provider` (212-238) calls
  `provider.start(c.env, { redirectUri, next })` (222). `GET /login/:provider/callback`
  (240-300): `provider.callback` (261-265), then **the identity → user logic inline**
  (272-283) — `userByEmail`, `provision` check, `createUser({ …, provider: provider.id })`
  (276-281). **That `createUser` is the only write to `users.provider` in the tree.**
  `sessionRoutes` (302): `POST /logout` (318-331) revokes and clears both cookie
  names, answering `{ ok: true }`; `GET /me` (350-378) calls `resolveActor` (352) and
  answers `{ mode, actor, loginUrl, policy? }`. `encodeState` (388-393);
  `decodeState` (397-421) hard-codes the three OIDC fields (405-409) and `next` (415).
- `auth/session.ts:40-59` — `createSession` inserts five columns (52-53) in a batch
  with `touchUserStatement` (56). `readSession` (85-139) is one `sessions ⋈ users`
  read and **hard-codes `provider: null`** on the `UserRow` it builds (126).
  `sessionExpiry` (143-149), `revokeSession` (153-158), `revokeUserSessions`
  (162-164). `deleteExpiredSessions` (167-170) has **no caller outside
  `src/server/auth/`**; neither has `challenges.ts:99-105`'s `deleteStaleChallenges`.
  There is no auth housekeeping entry on `Folio`; `runSchedules`
  (`src/server/types.ts:622`, wired at `index.tsx:644`) is the only sweep a host calls.
- `auth/users.ts:16-26` — `UserRow` has `provider: string | null` (23). `createUser`
  (131-151) writes `provider: input.provider ?? null` (139). `updateUser` (157-175)
  touches name, role, colour only. `deleteUser` (187-195) deletes sessions explicitly
  rather than resting on the cascade pragma. `touchUserStatement` (199-201) updates
  `last_seen_at` and nothing else — so a magic-link sign-in never stamps a provider.
- `auth/resolve.ts:34-39` `credentialOf`; `resolveActor` (53-62) — cookie, then bearer,
  else null, **no D1 read with neither**; `originAllowed` (83-94) applies only to
  cookie-authenticated mutations and passes an absent `Origin`.
- `resolveActor` has **four callers**: `middleware.ts:99` (inside `withActor`, 85-102),
  `index.tsx:303` (the `?_folio=` preview branch), `index.tsx:428` (`draftAt`), and
  `routes/auth.ts:352` (`/me`). Anything that changes what a credential *is* touches
  all four.
- `middleware.ts:120-134` `requireAccess`; `requireHtmlAccess` (162-180) answers an
  unauthenticated browser with `302 {base}/login?next=` (176-178);
  `requireAuthConfigured` (187-192) 404s a surface that only exists with accounts.
- `routes/editor.ts:66-98` — the socket route builds `SocketIdentity` from the actor
  (81-88: `actor`, `name`, `colour`, `role`, `session`, `expiresAt`) and hands it to
  the object with `withIdentity` (98; `auth/identity.ts:79-86` always sets or deletes
  the header). `sockets.ts:96-129` `liveSession` re-checks `sessionExpiry(db,
  a.session)` (112) once per `SESSION_RECHECK_MS` and closes 4003 (`sockets.ts:26`)
  when the row is gone. **A `UserActor` without a `session` and `expiresAt` cannot
  open a socket**, which is why trusted identity has to end in a session row.
- `auth/cookie.ts` — four families: session (13, 17), OIDC state (20-21), share
  (32-33), draft (47-48). `serialiseCookie` (190-200), `clearCookies` (209-213),
  `readOidcCookie` (110-112).
- `routes/access.ts:9-12` — no bootstrap route, on purpose. `toJson` (39-50) sends
  `provider` (46). Every route is `requireAuthConfigured` + `ADMIN` (58-61).
  `PATCH /users/:id` (102-140): the comment at 92-100 argues that a role change must
  revoke every session; self-demotion is refused with `conflict` (130-135);
  `revokeUserSessions` at 139.
- `runtime.ts:352-379` — the construction-time chain: `validatePresets`,
  `validateTypes`, `validateHooks`, `validateGlobals`, `validateMigrations`,
  `validateLocales`, then `resolveAuth(config.auth)` (379). `FolioRuntime.auth:
  ResolvedAuth<unknown>` (161).
- `index.tsx:149-171` exports `magicLink`, `oidc`, and the types `AuthConfig`,
  `AuthProvider`, `MagicLinkMail`, `Provisioning`, `VerifiedIdentity`.
  `types.ts:309` is the required `auth` key. `app.ts:122-123` mounts `sessionRoutes`
  then `accessRoutes` under `/api`; `app.ts:195` mounts `authRoutes` first on the bare
  mount so `/login/verify` is never read as `/login/:provider`.
- `pages.tsx:305-312` `LoginPageOptions { next, sent?, error? }`; `loginPage`
  (329-387) partitions providers by `!p.redirect` (331-332) and renders the form for
  `mail[0]` and an `<a>` per redirect provider. No script, by spec 10 decision 7.
- `migrations/0001_init.sql:238-254` — `users`; the `provider` comment (249-251) says
  "How they last signed in: 'magic', 'oidc', or null for an invited user who never
  has", which is a description of behaviour the code does not have. `sessions`
  (264-273) has no provider column. `login_challenges` (280-286), `api_tokens`
  (294-306).

**admin (`src/admin/`):**
- `me.ts:28-45` — `Me { mode, actor, loginUrl, policy? }`; `fetchMe` (146-160)
  synthesises `loginUrl` from `base` on a 401.
- `ui/Prototype.tsx:313-326` — the user menu. As of this writing "Sign out" shows a
  toast and issues no request; the same-day fix ahead of this spec POSTs
  `{apiBase}/logout` and navigates to `Me.loginUrl`. This spec changes what that route
  answers (decision 4), so the item changes once more.
- `ui/screens/settings-model.ts:557-568` — `providerRows` reads `provider.redirect`
  (561) to choose between two flow strings. `test/unit/admin/settings-screen.test.ts:
  489-531` pins it, and its last case (521-531) asserts the **exact five keys** of a
  policy provider, `redirect` among them.
- `ui/screens/Access.tsx:262-273` — the "Signs in with" column: a `Badge` for
  `user.provider`, "—" otherwise, with a comment that reads the blank as "invited,
  never signed in". Every magic-link user reads that way today. The role `Select`
  (238-258) is disabled only for self.
- `api.ts:28-30` `onUnauthorized`, `:37` `signInUrl`.

**tests:**
- `test/unit/server/auth.test.ts:241-290` — `resolveAuth`'s construction refusals, one
  `it` per rule; the cookie name and attribute tests at 65-120.
- `test/workers/auth-login.test.ts` — the login page ships no bundle (110) and renders
  one button per redirect provider (123); `/login/email` answers an unknown address
  byte-identically (184); the verify flow (234-318); `/me` (329-355); logout (357, 372);
  the OIDC round trip against a stand-in IdP injected through `fetchImpl` (433-480,
  tests 499-668); `verifyIdToken` (670-750).
- `test/workers/auth-http.test.ts` — role gates (182-372) including "a role change
  signs a user out of every browser" (354); the access surface is admin-only and 404
  under open (286); the origin check (446-490); the socket (572-830).
- `test/workers/auth-session.test.ts` — the `users`/`sessions`/`api_tokens` helpers.
- `test/workers/migrations.test.ts:406-418` and `437-449` assert the **exact column
  lists** of `users` and `sessions` with `toEqual`; `0006` grows both.
- `test/workers/wrangler.jsonc` — `nodejs_compat`, `compatibility_date` 2026-07-27.
- `scripts/auth-test.mjs:63` asserts the login page contains no `<script`. Unchanged by
  this spec; spec 29 is the one that revisits it.
- `examples/demo/src/index.tsx:104-112` configures magic link only, with a `send` that
  logs; `/dev/last-signin` (206-211) is localhost-gated; `scheduled()` (365-) loops on
  `runSchedules`.

**docs:**
- `docs/specs/foundation/identity-and-access.md:158-190` — decision 2, "Providers are
  the host's, the session is Folio's", and the Cloudflare Access rejection (187-190):
  "it gates the whole route rather than carrying a per-user role into the editor".
  Out of scope (593-606): SSO group → role mapping (600-601), passkeys (602-603), an
  `auth_events` table (604-606).
- `ROADMAP.md:588-592` restates the SSO mapping and `auth_events` deferrals;
  `README.md:2382-2386` lists them under "Not built yet".
- `docs/specs/platform/mcp-server.md:1114-1116` — Folio is an OIDC *client*, not a
  provider; nothing here changes that.
- `docs/specs/foundation/multi-site.md:196-215` — decision 5 moves the global `role`
  to `site_members`. It says nothing about who *set* the role.

## Owner decision checkpoints

1. **An enforced-domain magic-link request answers `302` to the domain's provider —
   recommended.** `POST /login/email` for `ann@client.com`, where `client.com` is
   claimed by `oidc`, answers `302 {base}/login/oidc?next=…`, identically for every
   address at that domain whether or not a user row exists. That is non-enumerating
   *with respect to accounts*, which is the property `SENT` protects; what it discloses
   is a configuration fact about a domain, and the SSO button on the same page already
   discloses that. The real alternative: (a) answer the byte-identical `SENT` page and
   send nothing — literally satisfies the rule, and strands a legitimate user waiting
   for a mail that never comes, so the spec would then owe the login page a static
   line "Staff at client.com sign in with SSO", which is the same disclosure by another
   route. Rejected: (b) send the mail and refuse at `/login/verify` — a mail per
   refusal, to say something the form could have said.
2. **A role set by an identity provider refuses admin edits — recommended.** When
   `roleFrom` placed a user's role, `PATCH /users/:id { role }` answers `409` naming
   the provider and the Access screen disables the `Select` with that reason. The
   alternative — allow the edit and let the next sign-in overwrite it — is the "it
   quietly changed" failure this codebase refuses everywhere else. Cost: the remedy for
   a group change is in the IdP, which is where an SSO tenant expects it to be.
3. **`roleFrom` answering `null` for a user it previously placed refuses the sign-in —
   recommended.** Their group was removed; keeping the stored role would be stale
   privilege. Alternative: fall back to `provision.role`. Rejected because "in no
   group" would then silently mean "editor" on a tenant that delegated roles to its
   directory.
4. **`auth_events` is in, as a table with two routes and no admin screen —
   recommended.** Argued under decision 8. The alternative is deferring it a third
   time, and this spec adds three things that happen with nobody clicking.
5. **The demo gains a localhost-gated `trusted()` provider for the live test —
   recommended.** It reads an `x-folio-dev-identity` header and refuses any hostname
   but `localhost`/`127.0.0.1`, the guard `/dev/last-signin` already uses. It is the
   only way `scripts/auth-test.mjs` can exercise the trusted kind against a real
   server. It is also exactly the pattern a careless host would copy without the
   guard, so its comment has to be blunt. Alternative: workers tests only.

## User stories

### The site is behind Cloudflare Access already
**As** a developer whose whole site sits behind Access **I want to** list
`cloudflareAccess({ teamDomain, aud })` as a provider **so that** the people Access
lets through are signed into the editor as themselves, with a Folio role, and nobody
sees a second login page.

### The host has its own accounts
**As** a developer with a membership system of my own **I want to** hand Folio a
verified email per request **so that** my staff use the session they already hold and
Folio still owns who may edit, at what role, and revocation.

### Roles come from the directory
**As** an admin at a tenant with SSO **I want** the `cms-admins` group to mean
`admin` and `cms-editors` to mean `editor` **so that** joining or leaving a group is
the whole of access management and nobody edits a role by hand in two places.

### One domain, one door
**As** the owner of an agency deployment **I want** every `@client.com` address to sign
in through the client's IdP and nothing else **so that** the client's directory
controls revocation and a mailbox cannot become a way around it.

### Sign-in is on the record
**As** an admin **I want** sign-ins, refusals and role changes recorded **so that**
"who signed in as Bob last Tuesday" and "why did Ann become an admin" have answers.

## Architecture decisions

### 1. A provider is one of four kinds, and each kind has exactly its functions

```ts
// src/server/auth/config.ts

export interface VerifiedIdentity {
  email: string
  name?: string
  /**
   * Whatever else the provider verified — id-token claims, an Access JWT payload —
   * for `roleFrom`. Never stored and never projected to a client.
   */
  claims?: Readonly<Record<string, unknown>>
}

/** Maps a verified identity to a role. `null` means "this identity holds no role
 * here"; decision 5 says what that does. */
export type RoleMapper = (identity: VerifiedIdentity) => Role | null

interface ProviderBase {
  id: string
  /** Button label on the login page. */
  label: string
  /** Email domains this provider is the only door for. Lowercase, no `@`, exact. */
  domains?: readonly string[]
}

/** Only kinds that *produce* a VerifiedIdentity get the identity → user knobs. */
interface Provisions {
  provision?: Provisioning
  roleFrom?: RoleMapper
}

export interface MailProvider<Env = unknown> extends ProviderBase {
  kind: 'mail'
  send: (env: Env, mail: MagicLinkMail) => unknown
}

/** Opaque to Folio: the provider's own round-trip state. Folio adds `next` in the
 * cookie envelope and the provider never sees it. */
export type RedirectState = Readonly<Record<string, string>>

export interface RedirectProvider<Env = unknown> extends ProviderBase, Provisions {
  kind: 'redirect'
  start: (env: Env, ctx: { redirectUri: string }) => Promise<{ url: string; state: RedirectState }>
  callback: (
    env: Env,
    ctx: { params: URLSearchParams; redirectUri: string; state: RedirectState },
  ) => Promise<VerifiedIdentity>
  /** Where "sign out" sends the browser after Folio's own session is revoked. */
  signOutUrl?: string
}

export interface TrustedProvider<Env = unknown> extends ProviderBase, Provisions {
  kind: 'trusted'
  /**
   * Null when this request carries no identity from the host. **Throws** when it
   * carries one that does not verify — that is a provider error, not "nobody".
   */
  resolve: (env: Env, req: Request) => Promise<VerifiedIdentity | null>
  signOutUrl?: string
}

/** `foundation/passkeys.md`. Constructed only by `passkeys()`; its routes are Folio's. */
export interface PasskeyProvider extends ProviderBase {
  kind: 'passkey'
  id: 'passkey'
  rpName?: string
}

export type AuthProvider<Env = unknown> =
  | MailProvider<Env>
  | RedirectProvider<Env>
  | TrustedProvider<Env>
  | PasskeyProvider

export type ResolvedAuth<Env = unknown> =
  | { mode: 'open' }
  | {
      mode: 'session'
      config: AuthConfig<Env>
      sessionDays: number
      linksPerHour: number
      mail: MailProvider<Env> | null
      passkey: PasskeyProvider | null
      redirects: readonly RedirectProvider<Env>[]
      trusted: readonly TrustedProvider<Env>[]
      /** domain → provider id, compiled from every provider's `domains`. */
      domains: ReadonlyMap<string, string>
    }
```

`resolveAuth` validates **by kind**, at construction, and throws naming the provider:
`kind` is one of the four; ids non-empty and unique; labels non-empty. `mail`: `send`
is a function; **at most one**, because the no-JavaScript login page has one address
field and two mail providers are unrepresentable on it; `domains` is forbidden ("a
domain enforced to the mail provider is the default"). `redirect`: `start` **and**
`callback` are functions — today nothing checks the second. `trusted`: `resolve` is a
function. `passkey`: at most one, `id` must be `'passkey'`, `domains` forbidden, and it
may not be the *only* provider (spec 29: nobody could ever enrol). `provision` and
`roleFrom` are refused on `mail` and `passkey`: a link proves an address and a passkey
proves a device, and neither is an identity provider's assertion about a person. Each
`domains` entry must match `/^[a-z0-9.-]+\.[a-z]{2,}$/` after lowercasing, and a domain
claimed by two providers throws naming both.

`magicLink()` returns `{ kind: 'mail', id: 'magic', label, send }`. `oidc()` returns
`kind: 'redirect'` and gains `id?` (default `'oidc'`, so two tenants can coexist),
`signOutUrl?`, `roleFrom?` and `domains?`; its `start` no longer receives `next`, and
its state shrinks to `{ state, nonce, verifier }`. `trusted()` and `cloudflareAccess()`
are decision 4's; `passkeys()` is spec 29's.

**Rejected: keep the bag and add `resolve?`.** A fifth optional function makes
`resolveAuth`'s cross-checks quadratic in prose ("a provider with `resolve` may not
have `send` unless…"), and `pages.tsx` would go on rendering by sniffing which
functions exist — which is how a provider with `start` and no `callback` passes
construction today. **Rejected: an abstract `Provider` class.** Every other thing a
host configures is a plain object or a closure — `send`, `bindings`, `route`, `hooks` —
and a class would be the first, for no property a discriminant does not give.

### 2. Folio owns every route and every `Response`; a provider returns data

| Kind | Routes Folio mounts | What the provider returns |
| --- | --- | --- |
| `mail` | `POST {base}/login/email`, `GET {base}/login/verify` | nothing — `send` is fire-and-forget |
| `redirect` | `GET {base}/login/:id`, `GET {base}/login/:id/callback` | `{ url, state }`, then a `VerifiedIdentity` |
| `trusted` | implicitly on `GET {base}/login`; explicitly `GET {base}/login/:id` | `VerifiedIdentity \| null` |
| `passkey` | spec 29 | internal |

The callback is **GET only, `response_mode=query`**. A `form_post` response is a
cross-site POST, which `SameSite=Lax` withholds the state cookie from; supporting it
means a `SameSite=None` state cookie, and that is a decision for a spec that needs it.

**Rejected: `mount(app: Hono)` — a provider registers its own routes.** It would let a
host write a SAML POST binding or a device-code flow natively, and every such provider
would have to re-implement what `completeSignIn` does: the cookie-name rule, `safeNext`,
clearing both names, the provider stamp, domain enforcement, the audit row. Each is a
thing a host-written provider could get wrong or leave out, and a session minted around
those rules is a session the rest of the server cannot reason about. The flows that
*need* arbitrary routes — SAML, chiefly — are exactly the ones the owner has ruled go
through a broker. A host that authenticates in some other shape already owns its
Worker: it authenticates however it likes and hands Folio the result through
`trusted.resolve`, which is the controlled version of the same hook. That is why
arbitrary mounting loses: trusted identity covers its legitimate cases with none of
its risks.

### 3. One function turns a verified identity into a session

```ts
// src/server/auth/sign-in.ts (new)

export type SignInRefusal = 'refused' | 'provider'

export type SignInResult =
  | { ok: true; user: UserRow; session: NewSession; roleChanged: boolean }
  | { ok: false; reason: SignInRefusal }

export async function completeSignIn(
  db: FolioDb,
  auth: Extract<ResolvedAuth, { mode: 'session' }>,
  provider: AuthProvider,
  identity: VerifiedIdentity,
  ctx: { userAgent: string | null; now?: number },
): Promise<SignInResult>
```

In order: **(1) domain enforcement** — `auth.domains.get(domainOf(identity.email))`;
set and not equal to `provider.id` → `refused`, with an event. **(2)** `userByEmail`.
**(3) role mapping**, per decision 5, for kinds that carry `Provisions`. **(4)
provisioning**, likewise — `mail` and `passkey` never provision. **(5) one
`db.batch`**: an optional `update users set role = ?, role_from = ?`; an optional
`delete from sessions where user_id = ?` when the role changed; `insert into sessions
(…, provider)`; `update users set last_seen_at = ?, provider = ?`; `insert into
auth_events`. The raw session token comes back for the route to put in a cookie, as
`createSession` already does.

Every sign-in path calls it — verify, callback, trusted implicit, trusted explicit,
passkey — and `signIn` in `routes/auth.ts:97-110` becomes the cookie-serialising
wrapper around it. **Rejected: keep the identity → user logic in each route.** It is
already duplicated between `verify` (`routes/auth.ts:196-206`) and `callback`
(`272-283`) with *different* provisioning rules (a link never provisions, a callback
may), and this spec would add three more callers. The provider stamp is the proof: it
is written in one of the two places today, which is the bug in the Summary.

### 4. Trusted identity runs on `GET {base}/login`, mints an ordinary session, and nowhere else

When `GET {base}/login` arrives with no cookie that resolves to an actor, and its query
carries none of `error`, `sent` or `signedout`, Folio calls each `trusted` provider's
`resolve(env, req)` in declaration order. The first identity goes to `completeSignIn`;
`ok` answers `302 next` with the session cookie; `refused` renders the page **in place**
with the `refused` notice; a throw is logged and renders the page in place with the
`provider` notice. Neither failure redirects back to `/login`, because a redirect there
would resolve again — and a page carrying `error`, `sent` or `signedout` is a page to
be read, not one to be bounced from, so implicit resolution skips those too. From the
`302` on, the browser holds a Folio session and **nothing downstream changes**:
`resolveActor`, the socket's identity header, the object's per-minute revocation
re-check, `originAllowed`. `requireHtmlAccess`'s `302 {base}/login?next=` and the
admin's `onUnauthorized` navigation both land on this page, so for a host behind Access
the whole sign-in is two redirects nobody sees.

Also, for every deployment: `GET /login` with a cookie that resolves to an actor
answers `302 next`. Today it renders the form to a signed-in person, which is harmless
and pointless, and under trusted identity it would be a form that signs you in again.

**Rejected: resolve trusted identity inside `resolveActor` when no cookie is present**
(stateless, every request). Four callers acquire a dependency on provider code
(`middleware.ts:99`, `index.tsx:303`, `index.tsx:428`, `routes/auth.ts:352`).
`UserActor.session` and `expiresAt` are required — the socket route copies them into
the identity header (`routes/editor.ts:81-88`) and `liveSession` re-checks the row
(`sockets.ts:112`), closing 4003 when it finds none — so a stateless actor would need a
synthetic session anyway. `userByEmail` would run on every anonymous request, which is
a D1 read where `resolve.ts:10-14`'s rule says there must be none. And CSRF: the edge
injects `Cf-Access-Jwt-Assertion` on a cross-site POST exactly as on a same-site one,
so `originAllowed`'s "cookie-only" narrowing (`resolve.ts:74-78`) would need a second
branch for a credential that is ambient but not a cookie. **Rejected: resolve on every
request only as a fallback** when no cookie is present — the same four objections at a
lower frequency, and a session cookie would then be optional, which is a second
authentication model to keep correct.

**Sign-out.** `POST {base}/api/logout` reads the session row's `provider` before
deleting it and answers `{ ok: true, next }`, where `next` is that provider's
`signOutUrl` if it has one, else `{base}/login?signedout=1`. The admin navigates to
`next`. The `?signedout=1` page suppresses implicit resolution and shows "You have
signed out" plus one button per trusted provider — its `label`, linking to
`GET {base}/login/<id>?next=` — so a host whose upstream session cannot be ended (a
proxy header) gets an honest page rather than a sign-out that looks broken because
the next request signs you straight back in. For Cloudflare Access `signOutUrl`
defaults to `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout`, which does
end the upstream session; the next visit to `/login` goes through Access's own login
first.

**CSRF.** The only thing a trusted header can do is sign *its own holder* in, on a
GET. That is login-CSRF, and the outcome — the victim is signed in as themselves — is
not an attack. `originAllowed` is unchanged.

**`auth: 'open'`.** Unchanged: no providers exist and `/login` 404s. Cloudflare Access
in front of an *open* deployment is still spec 10's rejected shape — a whole-route gate
with no per-user role — and still works as one. Listing `cloudflareAccess()` as a
provider is how a host gets roles out of it. One sentence in the README keeps the two
shapes apart.

**The Cloudflare Access helper.**

```ts
// src/server/auth/cloudflare-access.ts (new)

export function cloudflareAccess<Env>(opts: {
  /** `acme` or `acme.cloudflareaccess.com`. */
  teamDomain: string
  /** The application's AUD tag, from the Access dashboard or a secret binding. */
  aud: string | ((env: Env) => string)
  id?: string                     // default 'cloudflare-access'
  label?: string                  // default 'Continue with Cloudflare Access'
  signOutUrl?: string             // default https://<team>.cloudflareaccess.com/cdn-cgi/access/logout
  provision?: Provisioning
  roleFrom?: RoleMapper
  domains?: readonly string[]
  fetchImpl?: typeof fetch        // injected in tests, as oidc() does
}): TrustedProvider<Env>
```

`resolve` reads `Cf-Access-Jwt-Assertion` — the header only; the `CF_Authorization`
cookie carries the same token, but a header set by the edge is the canonical carrier
and a cookie is the shape `readSessionCookie` deliberately does not look at. Absent →
`null`. Present → fetch `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
(per-isolate cache, one hour, the same shape as `oidc.ts`'s `discoveryCache`), verify
RS256 against its `keys`, check `iss === https://<team>.cloudflareaccess.com`, `aud`
contains the tag, `exp` with `CLOCK_LEEWAY_MS`, and `email` present → `{ email, claims:
payload }`. Anything wrong **throws**, which is `error=provider` and a log line.
Verifying the signature is the entire point: the header is spoofable by anything that
reaches the Worker without going through Access — a `workers.dev` preview, a
misconfigured route — so the header alone is never trusted.

Prerequisite: extract `verifyJws(token, { jwks, algs }) → { header, payload }` from
`oidc.ts:92-216` into `auth/jwt.ts`, and make `verifyIdToken` a caller that adds
issuer, audience, nonce and expiry on top. Spec 29 reuses `fromBase64url` and
`algorithmFor` from the same module. Two facts to **confirm against a live Access
deployment during phase 2** rather than assert here: the certs JSON carries a `keys`
array of JWKs (beside `public_certs`), and `iss` is the bare team URL with no path.

> **Both are still assumptions** (phase 2, 2026-09-05). There is no Access tenant
> to point at from this tree — no remote, nothing deployed — so neither could be
> confirmed, and the helper was built against them with a stand-in certs endpoint
> injected through `fetchImpl`, exactly as `auth-login.test.ts` injects a stand-in
> IdP. What makes that safe to ship is that **each assumption fails loudly**: a
> certs document with no `keys` throws (`the certs document carried no keys`) and
> an `iss` that is not the bare team URL throws (`the assertion names a different
> team`). Either way the outcome is `?error=provider`, a log line and no session —
> a refused sign-in, never a verification that quietly stops happening. The first
> host to put this behind a real Access application is the one that finds out; if
> `iss` turns out to carry a path or an application segment, the fix is one
> comparison in `auth/cloudflare-access.ts` and the failure that reports it is
> unmistakable. `resetAccessCertsCache()` is the test seam, matching
> `resetDiscoveryCache()`.

### 5. `roleFrom` is a function; `roleFromClaim` is a helper that returns one

```ts
export function roleFromClaim(opts: {
  claim: string                  // 'groups' | 'roles' | a dotted path 'custom.groups'
  map: Record<string, Role>      // claim value → role
  default?: Role                 // when nothing matches; omitted means null
}): RoleMapper
```

The highest-ranking match wins when a person is in several mapped groups. A function
rather than a declarative-only `oidc({ roles: { claim, map } })` because a callback
covers what a DSL cannot: Entra's app `roles` versus `groups`, a group *overage* claim
that points at Graph, a role derived from the email domain, an Access JWT's `custom`
claims. The config idiom throughout Folio is a small host function, not a schema. What
is lost is projecting the mapping onto the Settings screen; it shows "Roles: from
<provider>" instead, which is the fact an editor needs. A mapper that returns something
`isRole` rejects, or throws, is a configuration bug: `console.error` and
`error=provider`, never a silent default.

`users.role_from` (new column) records **who decided the role**: `null` for Folio (an
admin invited or edited them), else the provider id. The interaction table, where
`mapped` is `undefined` when the provider has no `roleFrom`:

| User exists | `mapped` | Outcome |
| --- | --- | --- |
| no | `undefined` | as today: `provision` refuses, or creates with `provision.role ?? 'editor'`, `role_from = null` |
| no | `Role` | `provision.create` → create with `Role`, `role_from = provider.id`; else refuse |
| no | `null` | `provision.create && provision.role` → create with `provision.role`, `role_from = null`; else refuse |
| yes | `undefined` | sign in; role untouched |
| yes | `Role`, ≠ stored | update role, set `role_from`, revoke the user's other sessions (mirrors `access.ts:92-100`), `role_changed` event with `actor: 'provider:<id>'` |
| yes | `Role`, = stored | sign in; no write, no event |
| yes | `null` | `role_from === provider.id` → **refuse** (checkpoint 3); otherwise sign in, role untouched |

`PATCH /users/:id { role }` answers `409 conflict` when `role_from` is set, naming the
provider (checkpoint 2). `DELETE /users/:id` is always Folio's: removing someone is
not a role.

### 6. Enforced domains are declared per provider and compiled to one map

`oidc({ domains: ['client.com'] })` reads as "this provider owns client.com", and
`resolveAuth` compiles every provider's list into `ResolvedAuth.domains`, throwing at
construction when a domain is claimed twice. `completeSignIn` enforces the map for
**every kind**, so a magic link, a second SSO provider, a trusted header or a passkey
for `@client.com` all refuse unless they *are* the domain's provider. An enforced
domain is exactly one door: the point is that the client's IdP controls revocation,
and a passkey or a mailbox would be a second door around it. `POST /login/email`
consults the map **before any D1 read** and answers per checkpoint 1. Exact match
only; `*.client.com` is out of scope.

**Rejected: `AuthConfig.require: { domains: Record<domain, providerId> }`.** The same
validation, one more place to look, and the provider id is a string one can misspell —
whereas `domains` on the provider cannot name the wrong provider.

### 7. `users.provider` becomes true, and `sessions` learns its provider too

`users.provider` is the provider that signed this user in most recently, stamped inside
`completeSignIn`'s batch by folding it into the `touchUserStatement` update.
`sessions.provider` is the provider that minted this session, for logout's `next`
(decision 4) and for spec 29's sessions list. Passkeys stamp `'passkey'`; a trusted
provider its own id. `readSession` fills `UserActor.provider` from the join so `/me`
can answer `session: { provider }`.

**Rejected: drop the column.** The Access screen already draws it, `0001_init.sql`
already describes it as "how they last signed in", and enforced domains make it a
sharper admin question than it was: "who was still signing in by magic link before we
enforced SSO?"

### 8. `auth_events`: in, as a table, two routes and no screen

Three things this spec adds happen **without a person clicking**: a trusted sign-in, a
role rewritten from claims, a refusal because a group vanished. Each is exactly the "it
quietly changed" failure the codebase refuses elsewhere, and `versions` plus the
activity trail record none of them. The table is one insert batched into
`completeSignIn`, plus one each in logout, invite, admin role change and delete.
Refusals of *verified* identities — OIDC and trusted, where the IdP vouched for the
address — are recorded with `user_id null` and the email in `detail`, because "Bob
tried SSO and is not invited" is the admin's cue to invite him, and the IdP's
assertion is not attacker input. Magic-link unknown addresses never reach an event: no
challenge is created for them, as today, and recording them would be recording
whatever a stranger typed.

Routes: `GET {base}/api/auth-events?user=&cursor=&limit=` (admin; keyset newest-first
on `(at, id)`, the `api_tokens_created` shape) and `GET {base}/api/me/events` (the
caller's own last twenty; spec 29's account screen reads it). No admin screen: the
Access screen has no per-user detail view to hang one on, and inventing one is a UI
spec. `kind` is text with **no CHECK**, so spec 29 adds `passkey_added`,
`passkey_removed` and `sessions_revoked` without the `alter` SQLite cannot do; unknown
kinds are screened on read, as `parseScopes` screens `api_tokens.scopes`.

Housekeeping: `folio.sweepAuth(env, { now? })` deletes expired sessions, stale
challenges and events older than `AUTH_EVENT_RETENTION_MS` (90 days), answering
`{ sessions, challenges, events }`. The demo's `scheduled()` calls it beside
`runSchedules`. This gives `deleteExpiredSessions` and `deleteStaleChallenges` their
first caller.

**And it is a new host obligation with no signal when it is forgotten**, which is the
same shape as the cross-entrypoint purge trap the README documents: a host that never
wires `sweepAuth` into a cron accumulates `auth_events` forever, never reaps an
expired session row and never clears a stale challenge, and nothing anywhere says so.
Nothing *breaks* — an expired session already fails `sessionExpiry` on read, so this
is unbounded growth rather than a security hole — but unbounded growth on a table
with a documented 90-day retention is a promise the deployment is quietly not
keeping. Two things follow, both cheap and both required:

- The README's Auth section states it in the same voice it states the purge trap, and
  the `sweepAuth` doc comment says "nothing calls this for you".
- `GET {base}/api/auth-events` reports the age of its oldest row, so an admin looking
  at the surface that would show the symptom can see it. A route that answers "the
  oldest event here is 400 days old" on a table with 90-day retention has said the
  thing no log line was going to say.

**Rejected: sweeping opportunistically** — a probabilistic delete on some fraction of
sign-ins. It puts an unbounded write on the latency path of the one request a person
is waiting on, and it makes the retention window a function of traffic. **Rejected:
Folio owning a cron.** Folio is a library mounted by a host Worker; `runSchedules`
already establishes that the host owns the `scheduled()` handler and Folio owns what
it calls.

## Wire & schema changes

### D1 migration `0006_auth.sql`

```sql
-- Auth providers, part 2 (docs/specs/foundation/auth-providers.md): who decided a
-- role, which provider minted a session, and a record of sign-ins.
--
-- Two `alter table add column`s and one `create table`, in the plain shape 0002-0005
-- established. Both new columns go at the end of their tables, so the exact column
-- lists `test/workers/migrations.test.ts` asserts grow by one entry each.

-- Who decided this user's role: null for Folio — an admin invited or edited them —
-- or the id of the provider whose claims set it at their last sign-in. When set,
-- `PATCH {base}/api/users/:id` refuses to change `role` (409): the remedy for a
-- group change is in the identity provider, and letting an admin edit a role the
-- next sign-in will overwrite is the "it quietly changed" failure this schema
-- refuses elsewhere. `DELETE` is always Folio's; removing someone is not a role.
alter table users add column role_from text;

-- Which provider minted this session. Read by `POST {base}/api/logout` to decide
-- where the browser goes next — a redirect or trusted provider may have its own
-- sign-out URL — and shown beside each browser on the account screen
-- (foundation/passkeys.md). Nothing gates on it.
alter table sessions add column provider text;

-- Sign-ins, refusals, sign-outs, role changes, invitations, removals. One row per
-- event, appended in the same batch as the session or the change it describes, so
-- an event cannot exist without the thing it records or vice versa.
--
-- **`kind` has no CHECK constraint, deliberately** — the reasoning `content_refs.kind`
-- (0002) and `schedules.action` (0003) record: SQLite cannot widen a CHECK without
-- rebuilding the table, and the passkeys spec adds kinds. Unknown kinds are screened
-- on read, exactly as `api_tokens.scopes` are.
--
-- **A refused identity is recorded with no `user_id`**, and that is on purpose: an
-- OIDC or trusted refusal is an address the identity provider vouched for, so "this
-- person tried and is not invited" is the admin's cue rather than a stranger's input.
-- A magic-link request for an unknown address never reaches this table — no
-- challenge is created for it (routes/auth.ts) — because that *is* a stranger's input.
create table auth_events (
  -- evt_<12 hex>, minted server-side. A synthetic key for the reason every paged
  -- table here has one: the keyset tiebreak over `(at, id)` must be unique on its own.
  id       text primary key,
  -- Epoch milliseconds, UTC, like every other timestamp Folio stores.
  at       integer not null,
  -- sign_in | sign_in_refused | sign_out | role_changed | user_invited | user_removed
  kind     text not null,
  -- The account the event is about. Null for a refused identity Folio has no row
  -- for. Informational rather than a foreign key, matching every cross-table
  -- reference in this schema except `sessions.user_id`: a removed user's events stay
  -- readable, which is what makes the table a record.
  user_id  text,
  -- Who caused it: the user's own id for a sign-in, an admin's `users.id` for an
  -- invitation or an edit, `token:<name>` for a script, or `provider:<id>` when an
  -- identity provider's claims changed a role with nobody clicking — which is the
  -- case this table exists to record.
  actor    text,
  -- The provider involved, when one was: 'magic', 'oidc', 'cloudflare-access', a
  -- host's own id, 'passkey'.
  provider text,
  -- JSON, shaped by `kind`: `{ from, to }` for role_changed, `{ email, reason }` for
  -- sign_in_refused, `{}` otherwise. Text rather than columns because the shape is
  -- per kind and the passkeys spec adds kinds.
  detail   text
);

-- `GET {base}/api/auth-events?user=` and `GET {base}/api/me/events`: one user's
-- history, newest first.
create index auth_events_user on auth_events (user_id, at desc);

-- `GET {base}/api/auth-events` with no `?user=`, and the 90-day sweep in
-- `folio.sweepAuth`, both walk this.
create index auth_events_at on auth_events (at desc);

-- **Deliberately no index on `kind` or `provider`.** Neither is a filter any route
-- takes; adding one later is a deliberate act with a measurement behind it, which is
-- the rule `stories_draft_updated`'s removal established.
```

### Core / server types

- `auth/config.ts`: the union in decision 1; `OidcState` is deleted; `RedirectState`,
  `RoleMapper`, `MailProvider`, `RedirectProvider`, `TrustedProvider`,
  `PasskeyProvider` exported from `src/server/index.tsx` beside `AuthProvider`;
  `trusted`, `cloudflareAccess` and `roleFromClaim` exported beside `magicLink` and
  `oidc`.
- `AuthPolicyProvider`: `redirect: boolean` → `kind: AuthProvider['kind']`, plus
  `rolesFromProvider: boolean`, `domains: string[]` and `signOut: boolean`. Still
  projected field by field; still no function ever crosses.
- `UserRow` gains `roleFrom: string | null`. `readSession` fills `provider` from the
  join instead of `null` (`session.ts:126`). `UserActor` gains `provider: string`.
  `SocketIdentity` is unchanged — it is built field by field (`routes/editor.ts:81-88`)
  and nothing on the wire needs the provider.
- `Me` (admin) gains `session?: { provider: string }`.
- The redirect-state cookie's payload becomes the envelope `{ next: string; state:
  RedirectState }`; `decodeState` checks `next` is a string and `state` is a
  string-valued record, and hands only `state` to the provider.
- `Folio` gains `sweepAuth: (env, opts?: { now?: number }) => Promise<{ sessions:
  number; challenges: number; events: number }>`, beside `runSchedules`
  (`types.ts:622`).
- `PROTOCOL_VERSION` is unchanged: no socket or postMessage frame changes shape.

### New or changed routes

| Method | Path | Gate | Change |
| --- | --- | --- | --- |
| GET | `{base}/login` | none | renders by kind; a cookie that resolves → `302 next`; implicit trusted resolution unless `error`/`sent`/`signedout` is present; `?signedout=1` renders the signed-out page with one button per trusted provider |
| GET | `{base}/login/:id` | none | `redirect`: start, as today; `trusted`: explicit resolve → sign in, or `302 /login?error=refused\|provider`; `mail`/`passkey`/unknown: 404 |
| GET | `{base}/login/:id/callback` | none | `redirect` only; `params` is the query; the state cookie is the `{ next, state }` envelope |
| POST | `{base}/login/email` | none | an enforced domain answers `302 {base}/login/<provider>?next=` before any D1 read, for every address at that domain, whatever the `Accept` header; otherwise `SENT`, byte-identical, as today |
| GET | `{base}/login/verify` | none | consumes, then `completeSignIn` (which re-checks the domain map defensively) |
| POST | `{base}/api/logout` | cookie, none required | answers `{ ok: true, next: string }` and clears both cookie names, as today |
| GET | `{base}/api/me` | session | `+ session: { provider }`; `policy.providers[].kind`, `rolesFromProvider`, `domains`, `signOut` |
| PATCH | `{base}/api/users/:id` | admin | `409 conflict` when `role` is given and `role_from` is set: "Their role is set by <provider>. Change it there." |
| GET | `{base}/api/auth-events` | admin | new: `?user=&cursor=&limit=` → `{ events, cursor, oldestAt }`, newest first. `oldestAt` is the epoch of the oldest row in the table (null when empty) — the one place a deployment that never wired `sweepAuth` can see that it never wired `sweepAuth` (decision 8) |
| GET | `{base}/api/me/events` | session, user actor | new: the caller's own last twenty |

`?error=` gains no new values. An enforced-domain refusal and a group-vanished refusal
are both `refused`; a trusted resolver that throws is `provider`.

## Acceptance criteria

### Construction refuses by kind

```
GIVEN providers: [magicLink({ send }), magicLink({ send })]
WHEN createFolio runs
THEN it throws naming both ids and saying the login page has one address field

GIVEN oidc({ id: 'a', domains: ['client.com'] }) and oidc({ id: 'b', domains: ['client.com'] })
WHEN createFolio runs
THEN it throws naming 'a', 'b' and 'client.com'

GIVEN a mail provider with `domains`, or a mail provider with `roleFrom`
WHEN createFolio runs
THEN it throws naming the provider and the key that does not belong on its kind

GIVEN { kind: 'trusted', id: 't', label: 'T' } with no `resolve`
  OR { kind: 'redirect', id: 'r', label: 'R', start } with no `callback`
WHEN createFolio runs
THEN it throws naming the provider and the missing function
```

### Nothing a working host notices changes, except the provider column

```
GIVEN the demo's configuration, unchanged
WHEN every test in auth-login, auth-http and auth-session runs against phase 1
THEN every assertion that held before holds now

GIVEN a known address signs in by magic link
WHEN GET /folio/api/users is read as an admin
THEN that user's `provider` is 'magic', and the Access screen's column shows it
```

### Trusted identity signs in on the login page

```
GIVEN a trusted provider whose resolve answers { email: 'ann@x.com' } for a request carrying a header
  AND a users row for ann@x.com
WHEN GET /folio/login?next=/folio/edit arrives with that header and no cookie
THEN the response is 302 to /folio/edit with a session cookie
  AND sessions.provider and users.provider both read the provider's id
  AND one auth_events row of kind sign_in names the user and the provider

GIVEN the same request without the header
WHEN resolve answers null
THEN the ordinary login page renders, with the form and buttons, and no D1 write happens

GIVEN resolve throws
WHEN GET /folio/login arrives
THEN the page renders in place with the provider notice, no session exists, the error is logged

GIVEN ann@x.com has no users row and provision is 'refuse'
WHEN GET /folio/login arrives with the header
THEN the page renders in place with the refused notice
  AND one sign_in_refused event carries her email and no user_id

GIVEN a cookie that resolves to an actor
WHEN GET /folio/login?next=/folio/edit arrives
THEN the response is 302 to /folio/edit and no provider is consulted
```

### Signing out under trusted identity does not loop

```
GIVEN a session minted by a trusted provider with no signOutUrl
WHEN POST /folio/api/logout
THEN the body is { ok: true, next: '/folio/login?signedout=1' } and both cookie names are cleared
  AND GET /folio/login?signedout=1 with the header still present renders the signed-out page
  AND that page contains one button linking to /folio/login/<id> and sets no session cookie
  AND following that link signs in

GIVEN a provider with signOutUrl 'https://acme.cloudflareaccess.com/cdn-cgi/access/logout'
WHEN POST /folio/api/logout
THEN next is that URL
```

### Cloudflare Access

```
GIVEN cloudflareAccess({ teamDomain: 'acme', aud: 'tag', fetchImpl }) where fetchImpl serves a certs
      document holding an RS256 JWK
  AND a JWT signed by that key with iss https://acme.cloudflareaccess.com, aud ['tag'], a future exp,
      and email ann@x.com
WHEN GET /folio/login arrives with Cf-Access-Jwt-Assertion set to it
THEN ann is signed in and claims are handed to roleFrom

GIVEN the same JWT with a wrong aud, a wrong iss, an exp in the past, or a signature by another key
WHEN GET /folio/login arrives
THEN the page renders in place with the provider notice and no session exists

GIVEN no Cf-Access-Jwt-Assertion header
WHEN GET /folio/login arrives
THEN the ordinary page renders and the certs endpoint is never fetched
```

### Roles come from claims

```
GIVEN oidc({ roleFrom: roleFromClaim({ claim: 'groups', map: { 'cms-admins': 'admin', 'cms-editors': 'editor' } }) })
  AND an existing editor row for bob@x.com with role_from null
WHEN bob completes the callback with groups ['cms-admins']
THEN users.role is 'admin', users.role_from is 'oidc', his other sessions are gone
  AND a role_changed event records { from: 'editor', to: 'admin' } with actor 'provider:oidc'

WHEN bob signs in again with the same groups
THEN no update, no revocation and no role_changed event

GIVEN bob's row now has role_from 'oidc'
WHEN he completes the callback with groups []
THEN the callback redirects to /folio/login?error=refused and no session exists

GIVEN carol's row has role_from null and roleFrom answers null for her
WHEN she completes the callback
THEN she is signed in and her role is untouched

GIVEN roleFrom returns 'owner'
WHEN the callback completes
THEN the redirect is ?error=provider, the mistake is logged, no session exists

GIVEN bob's role_from is 'oidc'
WHEN an admin PATCHes /folio/api/users/<bob> with { role: 'viewer' }
THEN 409 conflict, naming 'oidc', and the row is unchanged
WHEN the admin PATCHes { name: 'Robert' }
THEN 200
```

### One domain, one door

```
GIVEN oidc({ id: 'okta', domains: ['client.com'] }) and magicLink
WHEN POST /folio/login/email with ann@client.com, known or unknown
THEN 302 to /folio/login/okta?next=…, no login_challenges row, no D1 read

WHEN POST /folio/login/email with dan@agency.example, known
THEN SENT, byte-identical to today, and a link is sent

GIVEN a challenge somehow minted for ann@client.com
WHEN GET /folio/login/verify?t=…
THEN ?error=refused and no session

GIVEN a second redirect provider 'entra' completes a callback for ann@client.com
THEN ?error=refused

GIVEN a trusted provider resolves ann@client.com
THEN the login page renders the refused notice
```

### Events and housekeeping

```
GIVEN a sign-in, a logout, an admin invitation, an admin role change and an admin delete
WHEN GET /folio/api/auth-events as an admin
THEN five rows, newest first, with the kinds sign_in, sign_out, user_invited, role_changed, user_removed
  AND GET /folio/api/auth-events?user=<id> narrows to that user
  AND GET /folio/api/me/events as that user lists their own, and 403s a token actor

GIVEN sessions past expiry, consumed challenges, and an event 91 days old
WHEN folio.sweepAuth(env)
THEN each is deleted and the report counts them; a 89-day-old event survives
```

## Implementation plan

### Phase 1 — the SPI and the single sign-in path (behaviour-preserving)

1. `src/server/auth/config.ts`: the union, `RedirectState`, `RoleMapper`,
   `VerifiedIdentity.claims`; `resolveAuth` by kind with the new `ResolvedAuth`
   fields (`mail`, `passkey`, `redirects`, `trusted`, `domains`); `AuthPolicyProvider`
   by kind; `authPolicy` projecting the new fields.
2. `src/server/auth/magic-link.ts`, `src/server/auth/oidc.ts`: return kinds; `oidc`
   gains `id`, `signOutUrl`, `roleFrom`, `domains`; `start` drops `next`; state is
   the three OIDC fields; `callback` takes `params`.
3. `src/server/auth/jwt.ts` (new): `verifyJws`, `fromBase64url`, `algorithmFor`
   extracted from `oidc.ts`; `verifyIdToken` becomes a caller.
4. `migrations/0006_auth.sql`; `test/workers/migrations.test.ts:406-418` and
   `437-449` gain one column each; a new `it` asserts `auth_events`' columns and
   exactly its two indexes.
5. `src/server/auth/sign-in.ts` (new): `completeSignIn`. `session.ts`:
   `createSession` takes and writes `provider`; `readSession` joins it.
   `users.ts`: `UserRow.roleFrom`, `touchUserStatement` gains `provider`. The events
   insert is stubbed as a statement builder in `src/server/auth/events.ts` so phase 4
   adds routes, not writes.
6. `src/server/routes/auth.ts`: switch on kind; the `{ next, state }` envelope in
   `encodeState`/`decodeState`; `verify` and `callback` call `completeSignIn`;
   `signIn` becomes the cookie wrapper.
7. `src/server/pages.tsx`: `loginPage` renders by kind (`rt.auth.mail`,
   `rt.auth.redirects`).
8. `src/admin/ui/screens/settings-model.ts`: `providerRows` by kind, plus a roles
   column ("Set in Folio" / "From <label>") and a domains column.
9. Tests updated in place: `test/unit/server/auth.test.ts` (every `resolveAuth`
   refusal, by kind), `test/workers/auth-login.test.ts` (unchanged assertions, plus
   "a magic-link sign-in stamps users.provider"), `test/unit/admin/settings-screen.test.ts`
   (the eight-key pin replaces the five-key one). Tree green; the demo runs unchanged.

### Phase 2 — trusted identity

1. `src/server/auth/trusted.ts` (new): `trusted({ id, label, resolve, provision?,
   roleFrom?, domains?, signOutUrl? })`.
2. `routes/auth.ts`: implicit resolution in `GET /login` behind the three-query guard
   and the "already signed in → 302" branch; explicit `GET /login/:id` for the trusted
   kind; `?signedout=1` rendering in `pages.tsx` with one button per trusted provider;
   `POST /api/logout` reads `sessions.provider` and answers `{ ok, next }`; `/me`
   answers `session: { provider }`.
3. `src/server/auth/cloudflare-access.ts` (new), on `auth/jwt.ts`.
4. Admin: `me.ts` `Me.session`; the user menu's Sign out follows `next` from the
   logout response.
5. `test/workers/auth-trusted.test.ts` (new): every criterion above, with a stand-in
   certs endpoint through `fetchImpl` as `auth-login.test.ts:433-480` does for JWKS.
6. Demo: the localhost-gated dev provider (checkpoint 5); `scripts/auth-test.mjs`
   gains a block that signs in through it, signs out, asserts `next`, and asserts the
   `?signedout=1` page sets no cookie.

### Phase 3 — SSO finishing

1. `roleFromClaim` in `src/server/auth/roles-from.ts`; `completeSignIn` applies the
   interaction table; `users.role_from` written.
2. `routes/access.ts`: `PATCH /users/:id` 409 on `role` when `role_from` is set;
   `toJson` sends `roleFrom`.
3. `src/admin/ui/screens/Access.tsx`: the role `Select` disabled with "Set by
   <provider>" as its reason, and a small badge in the cell; `access-model.ts` gains
   the predicate; `test/unit/admin/access-screen.test.ts` pins it.
4. Domains: compiled in `resolveAuth` (phase 1 already validates), enforced in
   `completeSignIn`, and `POST /login/email` consults the map first.
5. Tests: `auth-login.test.ts` (an id token with `groups`, the whole refusal table,
   two `oidc({ id })` providers, the enforced-domain `302` and the untouched `SENT`
   otherwise, `/login` while signed in); `auth-http.test.ts` (the 409).

### Phase 4 — `auth_events`

1. `src/server/auth/events.ts`: `recordEvent` statement builder (from phase 1),
   `listEvents(db, { user?, cursor?, limit? })` keyset, `sweepEvents`.
2. Writes: `completeSignIn` (`sign_in`, `sign_in_refused`, `role_changed`); logout
   (`sign_out`); `access.ts` invite (`user_invited`), role patch (`role_changed` with
   the admin as actor), delete (`user_removed`).
3. Routes: `GET {base}/api/auth-events` in `accessRoutes`; `GET {base}/api/me/events`
   in `sessionRoutes` behind `requireAccess(READ)` and a user-actor check.
4. `folio.sweepAuth` in `index.tsx`/`types.ts`; the demo's `scheduled()` calls it
   after `runSchedules`.
5. Tests: `auth-http.test.ts` (events routes, sweep), `auth-session.test.ts`
   (`listEvents` keyset).

### Phase 5 — docs

1. `README.md` Auth section: trusted identity and the Access helper, the two shapes
   Access can take, `roleFromClaim`, `domains`, `sweepAuth`; the "Not built yet"
   paragraph loses SSO mapping and `auth_events`.
2. `docs/specs/README.md`: row 28, the migration ledger, the status paragraph; spec
   23's claimed migration number moves along.
3. `docs/specs/foundation/identity-and-access.md` Out of scope: a dated note pointing
   the SSO and audit items here. `ROADMAP.md:588-592` likewise.
4. This spec restamped with `## Implementation notes`.

## Edge cases

- **Two trusted providers both resolve an identity** → declaration order wins.
  `resolveAuth` does not forbid two: a host moving from one proxy to another wants
  both for a week.
- **A trusted identity for an address with no row and `provision: 'refuse'`** →
  the refused notice, in place, with an event carrying the email. A second visit
  resolves and refuses again, which is correct and reads as "you are not invited".
- **The `?signedout=1` page** → the resolver is not called; the button is the consent.
  It sets no cookie.
- **A trusted resolver on a `GET /login` that already carries `?error=`** → skipped;
  the page is being read.
- **`signOutUrl` on a `redirect` provider** → honoured identically; RP-initiated OIDC
  logout is the host's URL to supply, not derived from discovery.
- **A claim-driven role change while the person has a socket open elsewhere** → the
  other sessions are revoked in the same batch; `liveSession` closes that socket with
  4003 within `SESSION_RECHECK_MS`, exactly as an admin `PATCH` does today.
- **A mapper answering the stored role** → no write, no revocation, no event.
- **A `role_from` user deleted and re-invited by an admin** → a new row with
  `role_from = null`; their next SSO sign-in re-takes it. Correct: the IdP still has
  an opinion, and the admin's invitation was the door, not the role.
- **An enforced domain and an *existing* magic-link user at that domain** →
  `POST /login/email` sends them to SSO; their live sessions are untouched.
  Enforcement is a sign-in rule, not a revocation; an admin who wants the latter uses
  the Access screen.
- **Upper-case or trailing-dot domains in config** → lowercased, then validated, at
  construction. Emails are already lowercased by `normaliseEmail`.
- **The Access certs endpoint is unreachable** → the resolver throws → the provider
  notice, logged; the page still offers every other provider.
- **A `workers.dev` preview not behind Access** → no header → `null` → the ordinary
  page. No bypass, because the header is never trusted without a verified signature.
- **A JSON caller (`Accept: application/json`) posts an enforced-domain address to
  `/login/email`** → the same `302`. Scripts follow redirects; the admin never calls
  this route.
- **`GET /login/:id` for a `mail` or `passkey` id** → 404, as an unknown id is today.

## Testing requirements

**Unit (`test/unit/server/auth.test.ts`, `test/unit/server/jwt.test.ts`,
`test/unit/admin/`):**
- `resolveAuth` by kind: every throw in decision 1, each naming the provider; the
  compiled `domains` map; lowercasing.
- `roleFromClaim`: a nested claim path, several groups with the highest winning, the
  default, an absent claim → `null`, a non-string claim value ignored.
- `domainOf` and the redirect-state envelope encode/decode (a payload with no `next`,
  with a non-record `state`, with a non-string value inside `state` → `null`).
- `authPolicy` by kind never carries a function and carries the eight named keys.
- `verifyJws`: a good token, a wrong `kid`, an unsupported `alg`, a malformed JWS.
- Admin: `providerRows` by kind (flow text, roles text, domains); `Me.session` in the
  menu model; the Access `Select` reason for a `roleFrom` user.

**Workers (`test/workers/`, real workerd):**
- `auth-trusted.test.ts` (new): implicit sign-in, null, throwing, refused-with-event,
  already-signed-in `302`, the `?signedout=1` page and its button, `signOutUrl` in
  logout's `next`, the Access JWT good and each bad claim, domains refusing a trusted
  identity, two trusted providers in declaration order.
- `auth-login.test.ts`: every existing assertion; plus "a magic-link sign-in stamps
  `users.provider`", roles from an id token with `groups` (the whole interaction
  table), two `oidc({ id })` providers, the enforced-domain `302` and the byte-identical
  `SENT` otherwise, `/login` while signed in.
- `auth-http.test.ts`: the `409` and its wording; `GET /api/auth-events` paging,
  `?user=`, and `oldestAt` (null on an empty table, the oldest row's `at` otherwise,
  and unchanged by a `?user=` filter — it is a fact about the table, not the page);
  `GET /api/me/events` for a user and `403` for a token; `sweepAuth` deleting across
  all three tables and answering its three counts.
- `migrations.test.ts`: the grown column lists; `auth_events` columns and exactly
  `auth_events_at` and `auth_events_user`.

**End to end (`scripts/auth-test.mjs` against the demo on port 5199):**
- Sign in through the dev trusted header on `GET /login`; assert the cookie.
- Sign out; assert `next` is `/folio/login?signedout=1`; fetch it with the header
  still present and assert no `Set-Cookie` and a button.
- A magic-link sign-in, then `GET /folio/api/users` as admin: `provider` reads
  `magic`.
- `GET /folio/api/me/events` lists the sign-in.
- The existing "ships no JavaScript" assertion (line 63) is untouched.

## Dependencies

- **Spec 10 (identity and access)** — everything here is a second pass over its
  tables, routes and cookie discipline. Decision 2's "providers are the host's, the
  session is Folio's" is kept and made enforceable by `completeSignIn`.
- **Spec 23 (multi-site)** — its decision 5 moves `role` to `site_members`. Nothing
  here fights that: `role_from` records who set a role and would move with it;
  `sessions.provider`, `auth_events` and the domains map are site-agnostic. Note in
  23 that a `site_members` row needs the same `role_from` treatment.
- **Spec 29 (passkeys)** depends on phases 1 and 2 here: the `passkey` kind in the
  union, `completeSignIn`, `sessions.provider`, `auth/jwt.ts`'s primitives, and
  `GET /api/me/events`.
- **Spec 31 (visitor access)** is unaffected: it gates page reads for visitors, and
  this spec never touches a visitor.
- Cloudflare resources: none new for Folio. A host using `cloudflareAccess()` needs
  an Access application in front of its admin origin and its AUD tag; a host using
  `oidc({ domains })` needs nothing it did not already have.

## Out of scope

- **SAML, natively.** Owner decision: a SAML-only IdP fronts through Cloudflare Access
  or an IdP broker and arrives here as `redirect` or `trusted`. XML canonicalisation
  and signature verification on workerd is a week of work whose every line exists to
  support a protocol the brokers already translate.
- **Wildcard domains** (`*.client.com`). Exact match is the whole of what the agency
  case needs; a wildcard is a policy language.
- **`form_post` callbacks.** Needs a `SameSite=None` state cookie; a decision for a
  spec with a provider that requires it.
- **Projecting the group mapping onto Settings.** A `RoleMapper` is a function; showing
  it needs a DSL, which decision 5 rejected. "Roles: from <provider>" is the fact an
  editor needs.
- **An admin screen for `auth_events`.** The Access screen has no per-user detail view;
  building one is a UI spec.
- **First-admin bootstrap over HTTP.** Unchanged from spec 10 and `access.ts:9-12`.
- **Trusted identity for bearer callers.** A script is an API token, and service
  tokens are Folio's own; an Access service token is a different credential with a
  different lifecycle.
- **Per-IP rate limiting.** Still a zone rule.
- **OAuth 2.1 for the MCP endpoint.** Folio stays an OIDC client
  (`mcp-server.md:1114-1116`); nothing here makes it an authorization server.

## Open questions

None. **All five checkpoints answered by the owner on 2026-09-05**, each to its
recommendation. Two were put back with their real alternatives spelled out, and both
were confirmed rather than waved through:

- **Checkpoint 1** — an enforced-domain `POST /login/email` answers `302` to the
  domain's provider. The rule `SENT` protects is non-enumeration *with respect to
  accounts*, and the `302` holds it: it is identical for every address at that domain
  whether or not a user row exists. What it discloses is a configuration fact the SSO
  button on the same page already discloses.
- **Checkpoint 4** — `auth_events` is in, table and both routes, after two previous
  deferrals. The "table now, routes later" middle option was offered and declined:
  spec 29's account screen reads `GET /api/me/events`, so the routes have a consumer
  in the next spec rather than in a hypothetical one.

**Build order: this spec is third of the four**, after 31 and 30 and before 29. That
is a change from the 28 → 29 → 30 → 31 order recorded when the four were drafted: 31
and 30 are M-sized, independent of auth, and interact with each other in a way that is
cheaper to settle first.

**Spec 23 is still live** (owner, 2026-09-05), and this spec is built as written rather
than shaped around it. `role_from`, the `PATCH` refusal and the Access screen's
disabled state all move with `role` when 23 puts it on `site_members`; that rework is
accepted, and the note this spec asks for in 23's decision 5 is what makes it a
migration rather than a rediscovery.

## Implementation notes

All five phases landed as designed. `AuthProvider` is a union of four kinds
instead of a bag switched on `redirect`, validated by kind rather than by which
optional functions a bag happens to carry, and every sign-in path — verify,
OIDC callback, trusted implicit, trusted explicit, and spec 29's passkey —
funnels through one function, `completeSignIn`, so the provider stamp, domain
enforcement and the audit row cannot be skipped by any of them, including a
trusted provider a host writes itself. `trusted()`, `cloudflareAccess()`,
`roleFromClaim` and `auth_events` are all in the tree, exercised by the new
`test/workers/auth-trusted.test.ts` and `test/unit/server/jwt.test.ts` and by
the grown assertions in `auth-login.test.ts`, `auth-http.test.ts` and
`auth-session.test.ts`. The bug the Summary opened with — `users.provider`
reading "—" for every magic-link user — is fixed: `completeSignIn`'s batch
stamps it on every sign-in, not only an OIDC one.

**The most important thing recorded here: two Cloudflare Access facts remain
unverified against a real tenant.** The helper was built against two
assumptions phase 2 wrote into the spec rather than confirmed as Ground
truth, because there is no Access tenant in this tree to point at — no
remote, nothing deployed — only a stand-in certs endpoint injected through
`fetchImpl`, exactly as `auth-login.test.ts` already does for OIDC's JWKS:
that `/cdn-cgi/access/certs` answers a `keys` array of JWKs beside
`public_certs`, and that a verified assertion's `iss` is the bare team URL
with no path. Both fail loudly rather than silently if wrong — a certs
document with no `keys` throws (`the certs document carried no keys`), an
`iss` that is not the bare team URL throws naming the team — and either way
the outcome is a refused sign-in, `?error=provider` and a log line, never a
verification that quietly stops happening. The first real deployment behind
Access is the one that finds out; if `iss` turns out to carry a path or an
application segment, the fix is one comparison in `cloudflare-access.ts` and
the failure that reports it is unmistakable. `resetAccessCertsCache()` is the
test seam, matching `resetDiscoveryCache()`.

**`sign_in_refused` landed in phase 3, not phase 4 as the plan had it.** The
plan's phase 4 step 2 claimed that write; it was built in phase 3 instead,
batched inside `completeSignIn` beside the refusal it records, because a
refusal and the row explaining it are one decision and splitting them across
two phases is how one of them ends up missing. Phase 4 was explicitly told
not to add it a second time, and didn't — what phase 4 owns on that path is
only the routes that read the table (`GET {base}/api/auth-events`,
`GET {base}/api/me/events`). A refusal records `user_id` when Folio already
has a row for that person, not always `null` as the acceptance criteria's one
worked example implied: `0006_auth.sql`'s own column comment is the authority
— null is for an identity Folio has no row for — and a group that vanished or
a mapper answering a non-role happens to somebody who already has a row, so
recording those with `user_id` null would make them invisible to `?user=`,
the query `auth_events_user` exists for. `detail.reason` is one of four
machine words — `domain`, `not_invited`, `role_removed`, `mapper` — fixing a
shape the schema comment left open.

The rest of what diverged from the plan, none of it a design change:

- **`UserActor.provider` is optional, and it is filled from
  `sessions.provider`, not `users.provider`.** The plan conflated two columns:
  `users.provider` is the door this person last came through *anywhere*;
  `sessions.provider` is the door *this browser* came through, which is what
  `/me`'s `session: { provider }` means. Optional because a `UserActor` is not
  always a session read — a permission test builds one — and requiring the
  field would have made an unrelated fixture the reason for it.
- **`session.ts` gained `sessionProvider(db, token)`**, unnamed in the plan.
  Logout reads the provider before revoking the row, and `sessions` SQL lives
  in that file and nowhere else.
- **`trusted({ resolve })` may answer synchronously.** A header read needs no
  `await`; the factory's `async` wrapper turns a synchronous throw into the
  rejected promise every other failure on this path already is.
- **`cloudflareAccess` throws at construction for a missing `aud`**, where the
  plan typed it required. A host reading an unset binding gets `undefined`,
  and a provider that verifies a signature and then checks the audience
  against `undefined` is a provider with no audience check.
- **Trusted sign-out buttons render only on the `?signedout=1` page.** On
  every other rendering of `/login` the resolver has already been consulted a
  moment earlier, so a button there is either redundant or a dead end.
- **`GET {base}/login/:id` for a trusted provider that resolves `null`**
  redirects to `?error=refused`, unstated in the plan: it is where the
  signed-out page's button leads, and the landing page carries `error` so it
  does not resolve again and cannot loop.
- **`domainOf` lives in `sign-in.ts`**, not beside `normaliseEmail` in
  `users.ts`, and **`roleSetByReason` lives in `roles-from.ts`** rather than
  being inlined at each call site — both exported and imported by both the
  route that enforces the rule and the admin screen that explains it
  pre-emptively, so the explanation and the refusal it predicts cannot drift
  apart.
- **`roleFromClaim` validates its `map` and `default` at construction**,
  throwing for a value that is not a role. The alternative was a mapper that
  only fails at sign-in time, refused by `completeSignIn` as `error=provider`
  months later, to whichever person happened to be in that group first.
- **Not every `auth_events` write shares a batch with the change it
  describes, and that is a scope boundary, not a change of mind about the
  rule.** `user_invited` does, through `createUserStatement` (already exported
  for `completeSignIn`'s own use). `role_changed` (admin actor), `user_removed`
  and `sign_out` are a second round trip after `updateUser`/`deleteUser`/
  `revokeSession`, because reaching into those functions to add the event
  would have duplicated batches this repo already treats as consolidated at
  one call site — the same shape `passkeys.ts` already uses for its own
  events. A crash between the two writes leaves the state change real and its
  event missing, never the reverse.
- **`listEvents`'s `kind` is typed `string`, not the closed union.** The union
  is this build's vocabulary for *writing*; a row a later migration's code
  wrote with a kind this build has never heard of must still read back as
  data, so `toEvent` also treats undecodable `detail` JSON as `null` rather
  than throwing.
- **`GET {base}/api/me/events` composes `requireAccess(READ)` with an explicit
  `actor.kind === 'user'` check.** The middleware alone is not enough: a
  read-scoped token passes `requireAccess(READ)` cleanly, so the kind check
  after it is load-bearing, not defensive.
- **`folio.sweepAuth` reads `config.bindings(env).db` directly, on the
  primary**, matching `reindex` and `migrate` rather than a per-request
  reader — a background delete with no request to serve, which the
  session-routing rule in `db.ts` was never about.
- `test/unit/server/jwt.test.ts` is new; phase 1's step list omitted a direct
  test for the extracted `verifyJws`, which previously had none of its own —
  only whatever `verifyIdToken` happened to reach.
- `PATCH {base}/api/users/:id` costs one extra read only when `role` is in
  the body — `role_from` has to be known before the write, not after — and
  nothing otherwise.
- `Access.module.css`'s `.roleCell` became a flex column so the provider
  badge sits under the role `<select>`, the one file phase 3 touched that its
  own plan did not name.

Both `auth-http.test.ts` and `auth-session.test.ts` needed one addition none
of the earlier baselines did: `delete from auth_events` in `beforeEach`, since
`POST /users`, `PATCH /users/:id`, `DELETE /users/:id` and `POST /logout` all
write rows now, where they wrote none before. `auth-session.test.ts`'s
`listEvents` tests insert rows directly through `recordEventStatement` with
distinct `at` values rather than through a real sign-in, because every event
in one sign-in batch shares a timestamp and a `(at, id)` keyset cannot be
exercised honestly from one batch.

Nothing from the plan was deferred past this spec — every acceptance
criterion an earlier phase's notes called "not yet true" is exercised by the
phase that follows it. What remains open is the one thing no phase could
have closed, the Cloudflare Access assumptions above; everything this spec
deliberately left out is recorded under *Out of scope*.
