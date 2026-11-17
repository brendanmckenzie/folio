# Feature: Admin extensions: the editor session, host pages, sourced selects and linked-data panels

> **Group:** platform
> **Build order:** 44
> **Size:** L
> **Status:** done (built 2026-11-17, ships in `v1.7.0`; the owner's browser pass on the demo is outstanding)
> **Wire version:** none. `PROTOCOL_VERSION` stays at 5; the host-page frames are a separate, versioned public protocol (decision 9)
> **Migration:** none
> **Release:** v1.7.0 (minor; every change is additive, decision 22)
> **Last updated:** 2026-11-17

## Summary

A host that runs a shop on the same Worker as Folio needs its own admin screens
(orders, products and variants, prices, stock, discounts) and today has nowhere to put
them. It cannot ask who the signed-in editor is without re-implementing session
lookup against Folio's tables, it cannot add a screen to Folio's navigation, an editor
cannot pick "which product is this page about" from the host's catalogue, and a record
cannot show the host's live facts about itself. `AGENTS.md` says it in one line under
"Limitations": **"No host-defined custom field types. The field set is what
`folio/core` exports."** `src/admin/ui/nav.ts:72` builds the sidebar from the manifest
and the caller's role alone, and `src/server/types.ts:1110` (`Folio<Env>`) has no
method that answers an identity.

This spec adds four narrow, stable extension points, in priority order:

1. **`folio.editor(req, env, opts)`** and **`folio.requireEditor(req, env, opts)`**:
   the host asks Folio, in-process, who the signed-in editor is and what their role is
   on a scope, with every sign-in provider and every multi-site rule Folio already has.
2. **`admin.pages`**: host-served pages listed in Folio's sidebar and shown inside the
   admin's chrome as a same-origin iframe, with a small message protocol for title and
   breadcrumbs, a stylesheet of Folio's tokens, and a client helper (`folio/host`).
3. **`select({ optionsFrom })`** on document fields: a host option source (the forms
   mechanism of spec 37) supplies a select's choices. The stored value is the host's
   id. `reference` is evaluated and deliberately not extended (decision 15).
4. **`panels`**: per document type, a host function returns a small structured
   summary that Folio renders, read-only, in the inspector.

A full React component plugin system, host-defined field kinds and host code running
inside the admin bundle are out of scope (Out of scope).

## Ground truth

Verified 2026-11-17 against `main` at `4faff49` (v1.6.1).

**auth (`src/server/auth/`):**
- `resolveActor(db, auth, credential, { preview? })` (`resolve.ts:84-116`) is
  deliberately not Hono middleware: "Three callers need this answer and only one of
  them has a `Context`" (`:5-9`). Without `preview` it answers a session (cookie first)
  or a token, never a grant (`:92-95`), and reads no D1 for a request with neither
  credential (`:11-15`). Under `auth: 'open'` it answers null with no read (`:90`).
- `credentialOf(req)` (`resolve.ts:44-51`) and `originAllowed(req, credential)`
  (`:137-148`): the CSRF Origin check, applied only to cookie-authenticated unsafe
  methods, with an absent `Origin` passing.
- Every provider (magic link, OIDC, `trusted()`, `cloudflareAccess()`, passkeys) ends in
  `completeSignIn` and an ordinary D1 session (`docs/handbook.md` "Auth", lines
  4030-4050). There is one credential to read whatever the door.
- The session cookie is `__Host-folio_session` on HTTPS, `folio_session` otherwise,
  `HttpOnly; SameSite=Lax; Path=/` (`cookie.ts:15-22`, handbook line 3925). `__Host-`
  binds it to the exact host: a host route on the **same origin** receives it, any
  other origin never does.
- `Role` is `viewer < editor < publisher < admin` (`roles.ts:15`); `atLeast`
  (`:33`), `ROLES`, `SCOPES`, `hasScope` and the type `Role` are already exported from
  `folio/server` (`server/index.tsx:314-328`).
- `effectiveRole(grants, registry, scope)` (`roles.ts:129-140`) is the per-scope role;
  `tokenScopesOn` (`:167-177`) the per-scope token scopes. `UserActor.grants`
  (`:227`) holds every grant, `*` included. Neither may be asked about an unknown scope:
  `writersOf` always appends `*` (`:116-118`), so `effectiveRole` answers the `*` grant
  for any id, and `:126-127` relies on `withScope` (`middleware.ts:127`) having refused
  it first.
- `readSession` sets `UserActor.role` to `viewer` when the person has no `*` row
  (`session.ts:200`), and `/me` answers that `role`, so the client cannot read the `*`
  grant from `/me`; `me.sites` carries the effective role per reachable scope
  (`me-sites.ts:20-27`).
- `safeNext` (`validate.ts:837-851`) accepts any same-origin path, so
  `{base}/login?next=/admin/orders/42` returns to a host path after sign-in.

**server (`src/server/`):**
- `withActor` (`middleware.ts:390-415`) is the admin's resolution: origin check, then
  `resolveActor`, then `scopedActor` (`:266-331`) for the per-scope role. A host route
  never passes through it, because `folio.handle()` answers `null` for host paths.
- Every D1 read runs on a session (`CLAUDE.md` invariants; `db.ts:152-158`
  `sessionFor`). The reader opens one with `sessionFor(bound.db, { bookmark:
  readBookmark(cookie) })` (`server/index.tsx:1049`). A new read path needs the same.
- `Folio<Env>` is `types.ts:1110-1609`. `FolioSingleConfig` is `:817-1082`,
  `FolioBrandedConfig` `:772-815`, `FolioBrand` `:745-770`. `BRAND_KEYS`
  (`runtime.ts:706-718`) lists the keys that move into a brand and are refused beside
  `brands`; `validateBrands` (`:731`) enforces it. Construction-time validators run per
  brand at `runtime.ts:830-880` (`validateTypes`, `validateGate`, `validateForms`, …).
- Folio sets **no** Content-Security-Policy on the admin (`pages.tsx:635-637`: "Folio
  sets no CSP itself"); it sets `frame-ancestors <sites.admin>` only on preview-origin
  responses (`server/index.tsx:491-505`).
- The admin shell is one wildcard, `GET {base}/*`, gated `READ_DRAFT`
  (`routes/shell.ts:75-76`). It resolves no bindings, and `app.test.ts` enforces that.
- `GET {base}/api/me` (`routes/auth.ts:763`) is where per-session admin flags live
  (`space`, `policy`, `passkeys`), "only put things here that every route rendering this
  page can answer" (`pages.tsx:111-114`). It is authenticated; `{base}/api/schema` is not.
- `FolioErrorCode` (`errors.ts:14-49`) has no 503; `STATUS` is `:51-61`.
- `UNSCOPED_API` (`middleware.ts:191-209`) lists unscoped admin routes; every other
  `{base}/api` route is scoped and `scope-partition.test.ts` fails on a mounted id route
  that is not fence-tested.

**option sources (spec 37):**
- Core vocabulary is `src/core/option-sources.ts`: `OptionsFrom` (`:50-53`),
  `readOptionsFrom` (`:83`), `optionListKey(settings, locale)` (`:168`),
  `screenOptionLabel` (`:181`), `MAX_SOURCED_OPTIONS = 500` (`:30`),
  `MAX_OPTION_LABEL = 200` (`:33`).
- The registry is `FolioForms.sources` (`form-responses.ts:2516`), typed
  `FolioOptionSource<Env>` (`:2533-2551`: `label`, `settings`, `ttl`, `localised`,
  `load`), validated by `validateSources` (`:2647-2695`), held per brand as
  `BrandRuntime.forms.sources` (`runtime.ts:298`).
- The store is `option_lists`, one row per `(brand, source, key)`
  (`server/option-sources.ts:1-12`). `refreshList` (`:339`) leases (`LEASE_MS` 30 s),
  calls `load` under a timeout, screens (`screenItems`, `:182`, values 1 to
  `MAX_OPTION_VALUE = 120` characters), stores the last good list and keeps it through
  failures. A render never calls `load`.
- `referencedLists` (`:599-626`) builds the cron's working set **from saved forms
  only** (`select … from forms where fields like '%"optionsFrom"%'`), and `pruneLists`
  (`:791-822`) deletes week-old rows that set does not name. A list a document field
  needs would be pruned today.
- `previewHostList` (`:836-875`) is the admin's read: a referenced key is refreshed
  through the lease when missing or stale.
- `hostListsOf` (`:570-590`) reads `brand.forms?.sources`.
- `forms.sources` is exposed at three surfaces: `GET {base}/api/forms/registry` lists it
  to any `READ` caller (`routes/forms.ts:349-360`); the builder preview runs `load` with
  caller-chosen settings (`:539-560`); a published form renders it to anonymous visitors
  (`runtime.ts:1945-1995`).

**core fields (`src/core/`):**
- `select` is `{ kind: "select"; options: readonly SelectOption[] } & Common & Indexable`
  (`fields.ts:217`); the builder requires `options` (`:384-386`); `ValueOf` infers the
  value union from `options` (`:430-433`); `defaultValue` is `options[0]?.value ?? ""`
  (`:467-468`).
- `fieldShapeError` (`nested.ts:958`) is the one place API input meets the schema, pure
  and synchronous; a `select` value must be `""` or one of `options` (`:967-970`). The
  v1 `PATCH /documents/:id/fields` route calls it per value
  (`routes/api/documents.ts:659`), as does the nested writer (`nested.ts:670`, `:742`).
  The nested writer runs inside `writeDocument`'s synchronous `target` transform
  (`write.ts:177-188`, called at `routes/api/documents.ts:596-605`).
  The admin writes through the Durable Object, which knows no schema.
- `indexRowsFor` projects a root `select` into `content_index.text_value`
  (`index-projection.ts:48`).
- `stories.draft_data` mirrors the draft root's scalars, written by the story Durable
  Object on a 2 s debounce (`story-do.ts:45`, `:444-461`).

**checks (`src/server/checks.ts`):**
- `CheckContext` (`:98-117`) supplies at most-once async reads (`targets`,
  `gatedAssets`); a check name "is a v1 contract from v1.4.0: add names, never rename or
  remove one" (`:33-34`).

**MCP (`src/server/mcp/tools.ts`):**
- Eighteen tools (`get_schema` `:127` … `update_asset` `:571`), pinned by
  `test/unit/mcp/tools.test.ts:118` (`toHaveLength(18)`).

**admin (`src/admin/`):**
- `Screen` is a closed union (`ui/route.ts:25-58`), parsed by `screenOf` (`:212-235`) and
  formatted by `pathOf` (`:276-298`); `crumbs` (`:399-446`) and `documentTitle`
  (`:451-455`) derive the top bar and the tab title. Pure, Node-tested.
- `nav(input)` (`ui/nav.ts:72-96`) builds groups: primary, Globals, record groups,
  administration. On a multi-site deployment with no scope chosen it draws only Sites
  (`:76-78`). `IconName` is a closed union of eleven (`ui/icons.tsx:44-55`).
- `Shell` (`ui/Shell.tsx:42-81`) is sidebar + top bar + `<main>`; `bare` removes the
  gutter. `Admin.tsx:838-1170` is the screen switch.
- The preview bridge (`hooks/usePreviewBridge.ts`) is the existing iframe precedent: it
  "hears only this origin, and only from the iframe it owns" (`:37-43`) and stamps
  `PROTOCOL_VERSION` on every frame (`:103-105`).
- `ui/tokens.css` is the token layer: a scale tier and a semantic tier on `:root`
  (`:18-160`), a dark block on `prefers-color-scheme` (`:166-205`) and `[data-theme]`
  (`:218`), and the global layer scoped under `.folio-ui` (`:288`). The admin never
  sets `data-theme` itself.
- `Inspector.tsx` draws the selected blok: head, help, the Address block on a routed
  root (`:255-272`), notes, then the field runs (`:288`). `Control.tsx:114-127` draws a
  `select` from `field.options`.
- The Vite plugin emits fixed-name root assets (`src/vite/index.ts:26-29`,
  `folio-admin.css`), built by `scripts/build-admin.mjs`.

**release:**
- `package.json` `exports` has seven subpaths (`core`, `engine`, `server`, `vite`,
  `form`, `render`, `preview`) plus `./admin-entry` (`:52-89`); `CLAUDE.md`'s "`folio/form`
  is the eighth" counts `admin-entry`. This spec adds two entries, `./host` and
  `./host.css`. `scripts/release.mjs:390-432` checks `anchors` per built file.
- `test/unit/cli/ledger.test.ts:218-226` fails for any `###` heading naming a version the
  ledger lacks; `:233-246` allows one release above `package.json`'s version and requires
  a `date` only at or below it, so an undated in-progress entry is legal.
- `upgrade-ledger.json` `releases[]` entries carry `version`, `date`, `rollback`
  (`safe | conditional | none`), `migrations`, `headings`; `test/unit/cli/ledger.test.ts`
  ties headings to `UPGRADING.md` `###` titles naming the tag and to `CHANGELOG.md`.
  v1.4.0 (no migration, additive) is the shape this release follows: `rollback: "safe"`.

## User stories

### A host gates its own routes with Folio's sign-in
**As** a host developer **I want** to ask `folio.requireEditor(req, env, { role: 'publisher' })`
in my `/admin/discounts` loader **so that** the editor signs in once, through whichever
door the site uses, and my route refuses anyone below publisher.

### An operator works on orders without leaving the CMS
**As** a shop operator **I want** Orders, Products, Stock and Discounts in the same
sidebar as Pages and Assets **so that** I move between the product page and its stock
without a second login, a second tab or a second look.

### A deep link survives
**As** an operator **I want** to paste `cms.example/folio/host/orders/1042` to a
colleague **so that** they land on order 1042 inside the admin, and Back returns them
through the order list as it would anywhere else.

### An editor picks a product, not a string
**As** an editor **I want** a page's Product field to offer the shop's products by name
**so that** I never paste an id, and an agent writing the same page cannot store one the
shop does not have.

### A record shows the shop's facts about itself
**As** an editor on a Product record **I want** to see "6 variants · from $28.50 · 3
editions left" beside the fields **so that** I write copy that matches what is on sale,
with a link to the variants screen when I need more.

## Architecture decisions

### Feature 1: the editor session

#### 1. `folio.editor()` answers a plain, redacted projection of the actor; `requireEditor()` turns it into a response

```ts
// src/server/editor.ts (new), types re-exported from folio/server
export interface FolioEditorOptions {
  /**
   * The scope the role is computed on, on a deployment with `sites`: a site, a
   * group or `shared` id. Absent is the `*` grant (the deployment-wide role).
   * Ignored with no `sites`, where every grant is on `*`.
   */
  scope?: string;
  /** Accept an API token (`Authorization: Bearer folio_…`) as well as a session. Default false. */
  tokens?: boolean;
}

export interface FolioEditorUser {
  kind: "user";
  user: { id: string; name: string; email: string | null };
  /** The effective role on `scope` (or the `*` grant without one). Null: no grant reaches it. */
  role: Role | null;
  /** Every grant the person holds, by scope id, `*` included. `{ "*": role }` with no `sites`. */
  grants: Readonly<Record<string, Role>>;
  /** The scope `role` was computed on; null for the `*` grant. */
  scope: string | null;
  /** The scope's brand on a deployment with `brands`; null otherwise. */
  brand: BrandRef | null;
  /** Which provider minted this browser's session, and when it expires (epoch ms). */
  session: { provider: string | null; expiresAt: number };
}

export interface FolioEditorToken {
  kind: "token";
  token: { id: string; name: string };
  /** What the token's scopes are worth on `scope` (`tokenScopesOn`). Empty when its binding does not reach it. */
  scopes: readonly Scope[];
  /** The scope the token is bound to, or null for an unbound token. */
  site: string | null;
  role: null;
  scope: string | null;
  brand: BrandRef | null;
}

export type FolioEditor = FolioEditorUser | FolioEditorToken;

// Folio<Env> gains:
editor(req: Request, env: Env, opts?: FolioEditorOptions): Promise<FolioEditor | null>;
requireEditor(
  req: Request,
  env: Env,
  opts: FolioEditorOptions & { role?: Role; page?: string },
): Promise<{ editor: FolioEditor; headers: Record<string, string> } | Response>;
signInUrl(req: Request, next?: string): string;
```

`editor()` is the data; `requireEditor()` is the one-line gate a host route writes:

```ts
const gate = await folio.requireEditor(req, env, { page: "orders" })
if (gate instanceof Response) return gate
const { editor, headers } = gate        // headers: HOST_PAGE_HEADERS, spread onto the response
```

The admitted answer carries the headers (`HOST_PAGE_HEADERS`, decision 12a) beside the
editor, so the line that gates a host page also hands it the `frame-ancestors` and
`no-store` it must send; a host has to discard them on purpose to forget them.

`requireEditor` answers, in order:

| Condition | Response |
| --- | --- |
| no editor, `GET`/`HEAD` | `302` to `signInUrl(req)` (`{base}/login?next=<path+query>`, on `sites.admin` with `sites`) |
| no editor, any other method | `401`, `text/plain` "Sign in to Folio first." |
| `role` given (or the page's `role`) and `editor.role` null or below it | `403`, `text/plain` naming the required role, with the `refusalOf` wording |
| a token, when `tokens` is not set | treated as no editor |
| `page` given: the page's `brands` does not include the scope's brand, or a `site` page has no usable scope | `403`, decision 12 |

Every response it builds carries `cache-control: private, no-store`.

The projection omits `session.id` (the cookie hash), `colour` and `roleFrom`. `/me`
already redacts the same way (`routes/auth.ts:769-794`): the smallest object is the one
that cannot leak later.

**Rejected: hand the host the `Actor` type.** `Actor` carries the session hash, is a
three-way union including `GrantActor` (which must never reach a host route), and its
`role` means "effective on the request's scope" only after `scopedActor` has run, which a
host route never gets. A host reading `actor.role` on a multi-site deployment would read
the `*` grant believing it was the site role.

**Rejected: a Hono middleware export.** The host's router is not necessarily Hono
(React Router is the documented shape, `AGENTS.md`), and `resolve.ts:5-9` already chose
"a function, not middleware" for the same reason.

**Rejected: the user's example field name `scopes` for per-site roles.** In Folio
`Scope` is a token permission (`roles.ts:45-55`) and "scope" is a site, group or
`shared`. The per-scope roles are `grants`, the name `UserActor` and `site_roles` use.

#### 2. One credential read per request, on a D1 session, with no read for a request carrying no credential

`editor()` opens `sessionFor(config.bindings(env).db, { bookmark:
readBookmark(cookie) })`, the reader's exact shape (`server/index.tsx:1049`), and calls
`resolveActor` without `preview`. With neither a session cookie nor (when `tokens`) a
bearer header it returns `null` before calling `bindings`, so an anonymous public
request through a host route that calls it costs nothing.

The answer is memoised per `Request` object in a `WeakMap<Request, Promise<Actor |
null>>` **held in the closure `createFolio` returns**, never at module scope: two Folio
instances in one isolate (the workers tests build one per test; a host may hold two
with different `auth`) must never answer each other's resolution. The raw resolution is
memoised and the scope applied after, so a loader and an action, or a layout and a page,
that both ask cost one read.

Session renewal (`readSession` renews past half-life) happens exactly as it does on
Folio's own routes. Revocation is immediate, because the row is read every request.

#### 3. The scope is the host's to name, is checked against the registry, and is a selection, never an authority

With `sites`, `editor(req, env, { scope })` first establishes that the scope is one Folio
serves, with the rule `withScope` applies to a `~<scope>` URL (`middleware.ts:127`:
`chain(registry, scope).length === 0` is a 404) and, on a deployment with `brands`, the
rule that a scope of no configured brand serves nothing (`rt.forScope(registry, scope)`
null, `CLAUDE.md` "A null brand serves nothing"). This step is required, not defensive:
`effectiveRole` cannot be asked about an unknown scope, because `writersOf` always
appends `*` (`roles.ts:116-118`) and so answers the `*` grant for any id at all, and
`tokenScopesOn` answers an unbound token's every scope whatever the id (`:173`). The
comment at `roles.ts:126-127` says exactly this: "`withScope` has already 404'd a scope
nobody registered before this is asked". `editor()` is that check for a host route.

- **A served scope:** `role` is `effectiveRole(grants, registry, scope)`, a token's
  `scopes` is `tokenScopesOn(…)`, and `brand` is `rt.forScope(registry, scope).brand`.
- **Any other value** (a typo, a deleted site, `shared` on a registry with no shared
  scope, a row of no configured brand, a string failing the site-id pattern): `role:
  null`, `scopes: []`, `brand: null`, `scope` echoed. It does not throw, because the value
  usually comes from a URL parameter and a throw would turn a typo into a 500. A host
  must read `role === null` as refused; `requireEditor` does.
- **No scope:** the role is the `*` grant (`grants['*'] ?? null`, never `UserActor.role`,
  which `readSession` defaults to `viewer` for a person with no `*` row,
  `session.ts:200`). Deployment-wide data is checked against the deployment-wide role,
  and a person whose grants are all on sites is refused it. A token with no scope keeps
  its scopes only when unbound.

The registry snapshot is read only when a scope is given.

#### 4. On a deployment with `sites`, only the admin origin answers

`editor()` returns `null` for a request whose origin is not `sites.admin`. Cookies
ignore ports, so in local development a session cookie leaks from the admin port to a
live host's port (`resolve.ts:97-100` names the same leak); a host route on a live host
that trusted it would admit an editor where no editor should be. Host admin pages are
therefore served on the admin origin, which is also what the iframe in decision 7
requires.

#### 5. CSRF: the existing three defences, applied inside `editor()`

For a method other than `GET`, `HEAD` and `OPTIONS`, `editor()` applies `originAllowed`
to the request and returns `null` when it refuses. The host gets the Origin check by
calling the function it was going to call anyway, with nothing to remember. The other
two defences are already in place: the session cookie is `SameSite=Lax` (a cross-site
form `POST` carries no cookie), and a host mutation is a `POST`. `folio.originAllowed(req)`
is also exported for a host that wants the check on a route that does not read the
editor.

**Rejected: CSRF tokens.** Folio refused them for its own admin (`resolve.ts:121-136`):
a per-form token round trip buys nothing the Origin check and `Lax` do not already
give, and a host with forms in an iframe would have to fetch and thread one.

#### 6. Under `auth: 'open'`, `editor()` answers `null`

Open mode has no users to resolve and every Folio gate short-circuits on the mode. A
host gate cannot short-circuit on a mode it does not see, and answering a synthetic
admin would make a shop's order screens public on any deployment that forgot `auth`.
`null` fails closed. Construction refuses `admin.pages` under `auth: 'open'`
(decision 12), because every host page would then refuse everyone.

### Feature 2: host pages inside the admin shell

#### 7. A same-origin iframe of the host's route, not a content-area load

The admin draws its chrome and an `<iframe>` whose `src` is the host's own route on the
same origin. The host page is a normal document from the host's own router.

**Rejected: a same-origin content-area load** (fetch the host's HTML and mount it in
`<main>`). Folio's admin is a prebuilt React 19 SPA (`main.tsx`, `CLAUDE.md` "The admin
ships prebuilt"). Injected HTML runs no scripts, so any interactive host page (a React
Router route, a filter, a form with validation) would have to be re-booted into Folio's
document by host code that shares Folio's `window`, CSS cascade and React instance.
`tokens.css` is scoped under `.folio-ui` precisely so Folio does not restyle a host
document (`CLAUDE.md` invariants); a content-area load inverts that and lets the host
restyle Folio. It also needs a fragment contract (no `<html>`, no `<head>`), which is a
host rewrite, and a full component plugin system is out of scope.

The iframe gives isolation of script, style and routing for free, works with any host
framework unchanged, and has a precedent in the editor's preview pane. Its costs are
each addressed below: history (decision 8), height (decision 10), look (decision 11) and
title and breadcrumbs (decision 9).

**No `sandbox` attribute.** The page is the host's own code on the admin's own origin;
`sandbox="allow-scripts allow-same-origin"` is no boundary at all (the frame can remove
its own sandbox), and anything narrower breaks forms, downloads and `window.open`.
Isolation between Folio and the host is not a goal: they are one Worker.

#### 8. Deep links, Back and the scope: the admin URL mirrors the frame with `replaceState`, never pushes for it, and keeps a site page's scope on every request

**Admin route.** `{mount}/host/<pageId>/<rest…>?<query>`, where `{mount}` is `{base}` or
`{base}/~<scope>` (`route.ts:112-122`). A new `Screen` `{ name: "host"; id: string;
rest: string }`, parsed when the first segment is `host` and the second a page id;
`rest` is the remaining path, **kept percent-encoded segment by segment** (`parse`
decodes each segment, `route.ts:208`, so `pathOf` re-encodes each with
`encodeURIComponent` and `framedSrc` joins the encoded segments: a host id holding
`%2F`, `%3F` or `%23` round-trips to the same host path, never to a deeper path, a query
or a fragment). `''` is the page root.

**Which mount a page lives under (multi-site).** A `deployment` page is a screen at the
bare mount **and** under every scoped mount: it needs no scope, and the bare-mount nav
draws it (decision 13). A `site` page is a screen only under `{base}/~<scope>`; at the
bare mount `{base}/host/<id>/…` renders a chooser, "Open Orders in which site?", listing
the scopes from `me.sites` where the caller's role reaches the page's `role` and whose
brand the page's `brands` allows; choosing one navigates to
`{base}/~<scope>/host/<id>/<rest>?<query>`. With no `sites`, every page is at `{base}`.

**Frame source.** `framedSrc(page, rest, query, scope)` = `page.path` + (`rest` ? `/` +
rest : '') + `?` + query, plus `folio_scope=<scope>` for a `site` page under a scoped
mount. The result is resolved against the admin origin and must still start with
`page.path` (followed by `/`, `?` or end) after URL normalisation, so `../` in `rest`
cannot leave the page; otherwise the screen is `missing`.

**Keeping the scope on every request a site page makes.** Only the frame's first URL is
built by Folio; every later request (a link, a form `action`, a `fetch`) is the host's.
Three layers, so a site page keeps its scope however it is written:

1. **`requireEditor({ page })` reads the scope from the `folio_scope` query parameter, else
   the `x-folio-scope` request header**, so a host `fetch` carries it in a header and its
   URLs stay clean.
2. **`folio/host` carries it for the host.** `connectHostPage()` reads `folio_scope` from
   `location` on first load and keeps it in `sessionStorage` under `folio:scope:<pageId>`
   (per tab, so two tabs on two sites never share it). While it holds one, a capture-phase
   `click` and `submit` listener adds `folio_scope` to every same-origin link and form
   target that lacks it, and `scoped(init?)` returns `fetch` init with the
   `x-folio-scope` header. `scope()` returns the held value.
3. **The admin heals a frame that dropped it.** When the frame loads a `site` page's
   location with no `folio_scope` (a host page without the helper, a redirect the host
   wrote), the admin calls `contentWindow.location.replace` with the mount's scope
   appended. That costs one extra load, adds no history entry, and replaces the `403`
   `requireEditor` answered.

**History rules**, which together make Back and deep links behave:

1. **The admin pushes history only for its own navigations** (a sidebar click, a crumb,
   a palette jump), exactly as today.
2. **In-frame navigation is the frame's history.** Browsers keep one joint session
   history, so a link followed inside the frame adds an entry Back will traverse.
3. **The admin mirrors, never pushes.** On every frame `load`, and on every `announce`
   frame carrying `path` (decision 9), it reads the frame's location (same origin, so
   `contentWindow.location` is readable) and calls `history.replaceState` to the
   matching admin URL: the page id whose `path` prefixes it, the remainder as `rest`
   (raw encoded segments), the query less `folio_scope`, under the current mount.
4. **On the admin's own `popstate`** landing on a host screen, the admin compares the
   computed `src` with the frame's current location **with `folio_scope` removed from
   both**; only when they differ does it call `contentWindow.location.replace(src)`, which
   adds no entry. A Back that traversed a frame entry has already moved the frame, the
   comparison is equal, and nothing reloads. Switching to a different page id remounts
   the iframe (`key={page.id}`), which adds no entry either.
5. **Promotion.** A frame location is promoted to the top window only when it is an
   `http:` or `https:` URL on the admin origin that is under no declared page path (a
   link to `/`, to a Folio document, to an undeclared page): the admin calls
   `window.location.assign` with it. `about:blank` (some browsers fire `load` for the
   initial empty document), `blob:` and `data:` locations are ignored and never promoted.
   **The sign-in page is a special case:** a frame landing on `{base}/login` (an expired
   session meeting `requireEditor`) is promoted to `{base}/login` with `next` set to the
   admin URL of this host screen, so after signing in the user returns to the page inside
   the chrome, and an OIDC provider that refuses to be framed is never framed.
6. **A frame Folio cannot read.** When reading `contentWindow.location` throws
   `SecurityError`:
   - on the **first** `load` after the admin set a same-origin `src`, the frame was
     refused (the browser blocks a page that sends `X-Frame-Options` or a
     `frame-ancestors` that excludes the admin, and Chromium still fires `load`): the
     admin replaces it with "This page refused to be shown inside Folio. Check its
     X-Frame-Options and Content-Security-Policy headers." and *Open in a new tab*;
   - on any later `load`, the frame navigated cross-origin: it is not promoted, because
     that would be an open redirect driven by host content. The admin replaces it with
     "This page left the admin" and an *Open in a new tab* link to the last same-origin
     location it read.

**A host page opened top level** (a bookmarked `/admin/orders/1042`) is the host's
page, unframed. `connectHostPage({ frame: true, base })` redirects such a visit into
the admin when the host wants its own URLs to land in the chrome; it is opt-in, because
a host may want its pages usable both ways. The target it builds:

| Page | Scope known to the helper (`folio_scope` in the URL, else the tab's `sessionStorage`) | Redirect target |
| --- | --- | --- |
| no `sites` | n/a | `{base}/host/<id>/<rest>?<query>` |
| `deployment` page | ignored | `{base}/host/<id>/<rest>?<query>` (the bare mount) |
| `site` page | yes | `{base}/~<scope>/host/<id>/<rest>?<query>` |
| `site` page | no | `{base}/host/<id>/<rest>?<query>`, which renders the site chooser above |

The helper learns the page id and kind from `connectHostPage({ page: { id, scope } })`,
because a host page knows which page it is and the helper has no config to read.

**Rejected: an admin `pushState` per frame navigation.** The frame's navigation has
already added a joint-history entry; a second one from the admin makes every Back press
need two clicks.

**Rejected: carrying the scope in a cookie.** A cookie is per browser, not per tab, so
an operator with two sites open in two tabs would act on whichever site was opened last.

**Rejected: carrying the scope in the host's path** (`/admin/orders/~alpha/1042`). It
dictates the host's route tree, and an absolute link written without it loses the scope
exactly as a query parameter does, so the healing layer would be needed anyway.

**Rejected: putting the host path in a query (`{mount}/host/orders?path=…`).** The URL
is the state (`docs/design-system.md`'s first commitment); a path segment keeps a deep
link readable and lets `crumbs` treat it like any other screen.

#### 9. Title and breadcrumbs: read on load, and a versioned `postMessage` protocol for the rest

With no host code at all, on each frame `load` the admin reads `contentDocument.title`
and draws `Shop / Orders / <title>` (page `group`, page label, title). A host page that
wants more posts frames, through the `folio/host` helper or by hand:

```ts
// The whole protocol, version 1. `src/core/host-page.ts` (pure, shared by both ends).
export const HOST_PAGE_PROTOCOL = 1;

export type HostPageFrame =
  | {
      folio: "host-page"; v: 1; type: "announce";
      /** The last crumb and the tab title. At most 120 characters. */
      title?: string;
      /** Crumbs after the page's own label, last one current. At most 4, each at most 60
       *  characters; `href` a same-origin path under a declared page path, else dropped. */
      crumbs?: readonly { text: string; href?: string }[];
      /** The frame's path and query after an in-page (`pushState`) navigation. */
      path?: string;
    }
  | {
      folio: "host-page"; v: 1; type: "notice";
      /** Shown in the admin's toast. At most 200 characters. */
      message: string;
      tone?: "info" | "error";
    };
```

The admin accepts a frame only when `event.origin === location.origin`,
`event.source === iframe.contentWindow`, `data.folio === "host-page"` and `data.v === 1`.
Every string goes through `screenOptionLabel`'s printable rule and the caps above, and is
rendered as React text. A crumb `href` is mapped to its admin URL (`{mount}/host/<id>/…`),
so a crumb click is an admin navigation (rule 1 of decision 8). A frame of an unknown
`v` is ignored, with one `console.warn` per page load naming the version.

`folio/host` (a new export subpath, browser-only, no dependencies, no React):

```ts
export function framed(): boolean;                         // true inside the admin's frame
export function announce(a: { title?: string; crumbs?: HostCrumb[]; path?: string }): void;
export function notice(message: string, tone?: "info" | "error"): void;
export function connectHostPage(opts: {
  /** Which declared page this is, and its kind (`HostPage.id`, `HostPage.scope`). */
  page: { id: string; scope?: "deployment" | "site" };
  /** Announce `document.title` and `location` now and on `popstate`. Default true. */
  track?: boolean;
  /** Redirect a top-level visit into the admin's frame (decision 8's table). Default false. */
  frame?: boolean;
  /** Folio's basePath, for `frame`. Default `/folio`. */
  base?: string;
}): () => void;                                            // disconnect
/** The scope a `site` page holds (decision 8), or null. */
export function scope(): string | null;
/** `fetch` init with `x-folio-scope` set when a scope is held. */
export function scoped(init?: RequestInit): RequestInit;
```

`announce` and `notice` are no-ops when `framed()` is false, and post with
`targetOrigin = location.origin`. `connectHostPage` also installs decision 8's scope
carrying for a `site` page, framed or not. `track` listens to `popstate` and wraps nothing: a host router calls
`announce({ path })` from its own navigation hook, which `connectHostPage` documents with
a React Router example. Folio does not patch `history`.

**Not `PROTOCOL_VERSION`.** That number is a private stale-tab guard, "cheap to bump"
(`CLAUDE.md`), because both ends ship in one deploy. Host pages are the other end of
this protocol and do not ship with Folio, so it is a public contract with its own
version that changes only by adding a `v: 2` the admin accepts beside `v: 1`.

**Rejected: `<meta>` tags read from the frame's DOM** for crumbs. They cannot change
after an in-page navigation without the host also announcing it, so the protocol would
be needed anyway, and two mechanisms for one fact disagree.

#### 10. Height: the frame fills the content area and the page scrolls itself

The host screen renders `Shell` with `bare` and an iframe at `width: 100%; height:
100%; border: 0`, filling `<main>`. The shell is already a fixed `100dvh` application
with its own scrolling regions (`Shell.module.css`), so the frame is one more of them:
sticky table headers, infinite lists and `position: fixed` dialogs inside the host page
all behave as they do top level, and nothing resizes.

**Rejected: auto-height** (the frame reports its content height and the admin sizes
it). It needs a resize protocol, `ResizeObserver` in the host, and it loops on content
whose height depends on the viewport (`100vh` sections, sticky footers). It also breaks
`position: fixed` inside the host page, which would be positioned against a frame as tall
as the content.

A frame with no `load` after 15 seconds shows an overlay, "This page is taking a while",
with *Open in a new tab*. Errors inside the frame (a host 500) are the host's to render.

#### 11. The look: `folio-host.css`, Folio's semantic tokens under a `--folio-` prefix and a small element layer

A new stylesheet, `folio-host.css`, built by `scripts/build-admin.mjs` from
`src/admin/ui/tokens.css` and a new `src/admin/host/host.css`, emitted by the Vite
plugin at the build root beside `folio-admin.css` (`/folio-host.css`), and exported for
bundlers as `folio/host.css`.

- **Tokens.** The semantic tier only, renamed with a `--folio-` prefix by the build
  (`--fg` → `--folio-fg`), declared on `:root` with the same light, `prefers-color-scheme:
  dark` and `[data-theme]` blocks as `tokens.css`. The prefix keeps them from colliding
  with the host's own custom properties in the host's own document. The **public set**
  from v1.7.0 is: `--folio-bg-app`, `--folio-bg-panel`, `--folio-bg-inset`,
  `--folio-bg-hover`, `--folio-fg`, `--folio-fg-muted`, `--folio-fg-subtle`,
  `--folio-fg-accent`, `--folio-border`, `--folio-border-strong`, `--folio-ring`,
  `--folio-state-{ok,warn,danger,accent}-{bg,border,fg}`,
  `--folio-text-{xs,sm,base,lg,xl}`, `--folio-space-{0..6}`,
  `--folio-radius-{sm,md,lg,full}`, `--folio-font-ui`, `--folio-font-mono`. The scale
  tier is not published (`tokens.css:1-9`: "the scale has no dark-mode answer").
- **Element layer**, opt-in under `body.folio-host` (the `.folio-ui` precedent):
  body background, font and padding (`--folio-space-5`); headings; links; `table`,
  `th`, `td`; `button` and `.folio-button[data-variant="primary|subtle|danger"]`;
  `input`, `select`, `textarea`; `.folio-badge[data-tone="ok|warn|danger|accent"]`;
  `.folio-muted`. Nothing outside `body.folio-host` but the `:root` tokens.

A host that wants its own styling ignores the element layer and reads the tokens, or
ignores both.

**Rejected: inline the admin's own `folio-admin.css` into the host page.** It is the
admin's component CSS (hashed modules) and changes in any commit; publishing it would
freeze the admin's internals.

#### 12. `admin.pages` is deployment-wide config, filtered per brand, refused when it cannot work

```ts
// FolioSingleConfig and FolioBrandedConfig both gain:
admin?: {
  pages?: readonly HostPage[];
};

export interface HostPage {
  /** `/^[a-z][a-z0-9-]{0,31}$/`, unique. The admin route segment: `{mount}/host/<id>`. */
  id: string;
  /** The sidebar label and first crumb. 1 to 40 characters. */
  label: string;
  /** The host route, same origin: starts with `/`, not `//`, no `?` or `#`, no trailing
   *  `/`, not `{basePath}` or under it, and no page's path a prefix of another's. */
  path: string;
  /** One of `HOST_PAGE_ICONS`. Default `"window"`. */
  icon?: HostPageIcon;
  /** The minimum role. Default `"viewer"`. The admin hides the item below it; the host
   *  route enforces it through `requireEditor({ page })`. */
  role?: Role;
  /** A sidebar heading, like `DocumentType.group`. 1 to 40 characters. */
  group?: string;
  /** `"deployment"` (default): the data belongs to no site; the role is the `*` grant.
   *  `"site"`: the data is per site; the frame gets `folio_scope` and the role is the
   *  effective role on it. Meaningful only with `sites`. */
  scope?: "deployment" | "site";
  /** With `brands` and `scope: "site"` only: shown and admitted only under a scope of
   *  these brands. Every id configured. */
  brands?: readonly string[];
}

export const HOST_PAGE_ICONS = [
  "window", "receipt", "box", "tag", "stack", "percent", "people", "chart",
] as const;
export type HostPageIcon = (typeof HOST_PAGE_ICONS)[number];
```

`admin` is deployment-wide (it is not in `BRAND_KEYS`) because the admin is one origin
and one sidebar; `brands` narrows a page to some brands. At most 20 pages.

`validateAdmin(config, rt)` runs with the other construction validators and throws
naming the key for: an unknown key on `admin` or on a page; a bad or duplicate `id`; a
`label` or `group` outside its length; a `path` that breaks any rule above; an unknown
`icon` or `role`; `scope: "site"` without `sites`; `brands` without `brands`;
**`brands` on a `deployment` page** (a deployment page has no scope to take a brand from,
so the filter could be drawn in the sidebar and never enforced); an unconfigured brand id; more than 20 pages; and **any page under `auth: 'open'`**
(decision 6).

`requireEditor(req, env, { page: id })` enforces everything the page declares, so the
sidebar's filtering is never the only filter:

1. The editor (decision 1), else `302`/`401`.
2. For a `site` page on a deployment with `sites`: the scope from `folio_scope`, else
   `x-folio-scope` (decision 8). None, or one that is not a served scope (decision 3):
   `403` "Open this page from the admin, inside a site." The editor's `role` is the
   effective role on that scope. For a `deployment` page, or with no `sites`: the `*`
   grant.
3. `brands`: `editor.brand?.id` must be in the page's `brands`, else `403` "This page is
   not part of <brand label>."
4. `role`: `editor.role` must be at least the page's `role`, else `403` with the
   `refusalOf` wording.

An unknown page id throws (a programming error, caught by the first request in
development).

#### 12a. `HOST_PAGE_HEADERS` ride with the admission

`HOST_PAGE_HEADERS` (exported from `folio/server`) is `{ "content-security-policy":
"frame-ancestors 'self'", "cache-control": "private, no-store", "x-content-type-options":
"nosniff", "referrer-policy": "same-origin" }`, and `requireEditor` returns it as
`headers` with every admission (decision 1). `frame-ancestors 'self'` matters beyond the
cross-site case: `SameSite=Lax` sends the session cookie to a frame embedded by a
**same-site** sibling (`www.example.com` framing `cms.example.com`), so without it a
sibling page could clickjack a host page. A host that sets its own CSP merges the
directive. A host route that sends no such header is framable by a same-site sibling;
the default fails open only if the host discards `headers`, which the handbook's snippet
never does.

**Rejected: per-brand `brands.<id>.admin.pages`.** Two brands sharing one shop would
declare it twice and drift; one list with a `brands` filter is one declaration.

#### 13. The pages reach the admin on `GET {base}/api/me`, not on the manifest

`/me` gains `hostPages`, present when `admin.pages` is non-empty:

```ts
hostPages?: {
  id: string; label: string; path: string; icon: HostPageIcon; role: Role;
  group?: string; scope: "deployment" | "site"; brands?: string[];
  /** For a `deployment` page: whether the caller's `*` grant reaches `role`, computed on
   *  the server from `grants['*']`. Absent on a `site` page. */
  allowed?: boolean;
}[]
```

It is authenticated, so a host's admin paths are never in the unauthenticated
`{base}/api/schema`, and `/me` is already where per-deployment admin flags live
(`pages.tsx:111-114`). The shell's HTML route stays binding-free.

`allowed` is computed on the server because the client cannot know the `*` grant:
`MeUser.role` is `UserActor.role`, which `readSession` defaults to `viewer` for a person
with no `*` row (`session.ts:200`), so a site-only editor would read as a deployment
viewer and see a page the host then refuses. For a `site` page the client already has
the truth: `me.sites` lists each reachable scope with the caller's effective `role` on it
(`me-sites.ts:20-27`), and with no `sites` the `*` grant is the only grant and `allowed`
is set on every page.

**`nav()`** places one group per declared `group` (first-appearance order, collapsible),
then the ungrouped pages in one unheaded group, after the record groups and before
administration. An item is absent (not disabled, `ui-architecture.md`'s rule) when:
a `deployment` page has `allowed: false`; a `site` page's `role` is above the caller's
role on the shown scope, or the shown scope's brand is not in its `brands`.

**The bare multi-site mount.** `nav()` today draws only Sites there (`nav.ts:76-78`). It
now draws Sites (for the platform) **and the `deployment` pages with `allowed: true`**,
in their groups, because those pages need no scope (decision 8). `site` pages are not
drawn at the bare mount; their deep links render decision 8's chooser.

`activeItem` matches `{ name: "host", id }`. The palette lists host pages like any nav
item. `SCOPE_STABLE` gains `host`; a `site` page whose `brands` excludes the target
scope's brand renders the `missing` screen with the nav around it, and switching scope
on a `deployment` page keeps the page and reloads nothing in the frame (the page's
`src` carries no scope).

### Feature 3: option sources on document `select` fields

#### 14. `select({ optionsFrom })`: the stored value is the source's value (the host's id), and the render gets the value only

```ts
// src/core/fields.ts
| ({
    kind: "select";
    options: readonly SelectOption[];
    /** Choices from a host option source (`optionSources`), materialised before `options`.
     *  `options` are then typed extras, kept after the sourced list, and win a collision. */
    optionsFrom?: OptionsFrom;
  } & Common & Indexable)

// The builder: `options` optional, defaulting to [], when `optionsFrom` is given.
export function select<const T extends readonly SelectOption[]>(
  o: Omit<Opts<"select">, "options" | "default" | "optionsFrom"> & { options: T; default?: T[number]["value"] },
): …;
export function select(
  o: Omit<Opts<"select">, "options" | "default" | "optionsFrom" | "translatable"> & {
    optionsFrom: OptionsFrom; options?: readonly SelectOption[]; default?: string;
  },
): …;
```

`ValueOf` gains a branch ahead of the inferred union: `F extends { optionsFrom: object }
? string`. `Field` keeps `options` required (the builder fills `[]`), so every existing
reader of `field.options` compiles and reads the extras. `defaultValue` (`fields.ts:461`)
gains an explicit branch: a select with `optionsFrom` defaults to `""`, never to its first
typed extra, because the extras are fallbacks an editor chooses deliberately; a declared
`default` is still written by `blankBlok` as for every field.

- **Stored:** the source's `value` string (1 to 120 printable characters, `screenItems`'
  rule), or `""`/`null` for none. Exactly what a static `select` stores, so
  `content_index`, `fieldValue`, `dataOf`, the v1 nested shape, migrations and the
  Durable Object need no change.
- **Rendered:** the value. `resolveValue` is unchanged and a block's `render` receives the
  id (`"prod_8812"`). Rendering the product is the host's job: it owns the data, and a
  render that read a label from `option_lists` would add a D1 read and a cache tag per
  page for something the host already has. So a changed list never purges a page.
- **Index:** with `indexed: true` the id lands in `content_index.text_value`, so
  `folio.query({ type: "product-page", where: [{ field: "product", op: "eq", value: id }] })`
  finds the editorial page for a product, and the shop's product route can render it.
  Ordering by the field orders by id, not by label; the handbook says so.

**Rejected: storing `{ value, label }`.** It changes a select's stored shape, so
`fieldShapeError`, index projection, the v1 nested shape and every host reading the field
would branch on it, and the label would still go stale the moment the shop renames the
product.

#### 15. `reference` is not extended to external sources

`reference` means "a Folio story": its value is a story id, it is fenced to the
request's chain, it writes `content_refs` (the "used by N" warning on delete), it is
resolved two hops deep into `Resolution.docs`, link checks and `check_document` look up
its row, and the picker searches stories. An external id fails every one of those, and
a stored value that is sometimes a story id and sometimes a product id would need a
discriminator everywhere it is read. The need, "pick one external thing by id", is a
sourced `select`. Plural external picks (several products in order) are out of scope
here (Out of scope); a host gets an ordered list today with a `blocks` slot of a
one-field block holding a sourced select.

#### 16. Field sources are their own per-brand registry, `optionSources`; fields may also name a form source, forms never name a field source

```ts
// FolioSingleConfig and FolioBrand gain (and BRAND_KEYS gains "optionSources"):
optionSources?: Readonly<Record<string, FolioOptionSource<Env>>>;

// FolioOptionSource<Env> gains one optional method:
/** Labels for stored values no longer in the list, for the admin only (decision 19).
 *  Called with at most 20 values, under the source's load timeout. Never stored. */
lookup?(values: readonly string[], input: OptionSourceInput, env: Env):
  readonly OptionSourceItem[] | Promise<readonly OptionSourceItem[]>;
```

The two registries stay separate at every surface, because they are exposed
differently:

- **`forms.sources` is unchanged.** It is listed to every `READ` caller by
  `GET {base}/api/forms/registry` (`routes/forms.ts:349-360`), previewed with
  caller-chosen settings by the builder (`:539-560`, through `previewHostList`'s
  unreferenced branch, which runs `load` with those settings), and rendered to anonymous
  visitors on a published form (`runtime.ts:1945-1995`). Form questions, the builder, the
  registry route, `checkOptionSources` and the form renderer keep reading
  `brand.forms.sources` only.
- **`optionSources` is for fields only**, and appears in none of those surfaces. A host
  can register `customers` for an admin-only picker and know that no form can list it,
  preview it or publish it.
- **A field may name either.** `BrandRuntime.fieldSources: ReadonlyMap<string,
  ResolvedOptionSource>` is the union of `optionSources` and `forms.sources`; a source a
  host already exposes to forms gains nothing by also being pickable in a field, and
  sharing one row saves a load. The union is one-way: `fieldSources` is read by field
  code only.
- **An id in both throws at construction**, because `option_lists` is keyed by
  `(brand, source, key)` and two sources under one id would overwrite each other's rows.

Both are validated by the same `validateSources` (`form-responses.ts:2647`, extended to
accept `lookup`). `hostListsOf` gains a parameter naming which map it reads, so the forms
callers pass `brand.forms.sources` exactly as today and the field callers pass
`brand.fieldSources`.

**Rejected: one merged registry.** It would offer an admin-only source to every form
builder and to the public (the three surfaces above), which is the opposite of what a
host registering a customer list expects.
**Rejected: an opt-in flag on the source (`forms: true`).** It is the same two
registries spelled as one, with the default being the thing to get right; two keys make
the exposure visible in the config itself.
**Rejected: reuse `forms.sources` as the field registry.** A shop with no forms would
declare `forms: { sources }` to configure a product field, and every such source would
be exposed to the form surfaces.
**Rejected: a deployment-wide registry.** Spec 37 decision 1 rejected it: a source
written for one brand would be offered to another brand's schema.

#### 17. A field's source and settings are code, validated at construction; `content` is refused

`validateFieldSources(schema, fieldSources)` runs per brand after `validateTypes` and
throws naming block and field for: a source id in neither `optionSources` nor
`forms.sources` of the brand;
`source: "content"` ("use `reference({ types })`"); a `settings` key the source does not
declare, or a value of the wrong kind, or a `select` setting outside its options;
`translatable: true`; a `default` that is not one of the typed extras; and `optionsFrom`
on a non-`select`. `validateGate` additionally refuses a sourced select as the gate field
(its public value cannot be checked against a list that loads later).

Settings arrive through `effectiveSettings` (`server/option-sources.ts:246`), so the
list key is `optionListKey(effectiveSettings(source, settings), locale)`, the same
`(brand, source, key)` row a form question with equal settings reads.

Because settings are code, the field-options routes take a block and a field and read
the settings from the schema; no field route accepts settings. So a source registered
only under `optionSources` runs only with the settings the schema declares. A source the
host also registered under `forms.sources` keeps the exposure spec 37 gave it (the
builder preview runs it with any settings), and the handbook says so beside the two keys.

#### 18. The list is cached in `option_lists`, refreshed by the cron, the admin and a write, and never pruned while the schema names it

Nothing new is stored. A field's list is a row like a form question's, with the same
TTL, lease, last-good rule and failure categories (spec 37 decisions 6 and 7):

- **`referencedLists`** unions the forms rows with every brand's schema-declared lists:
  for each brand runtime, each block field with `optionsFrom` (resolved in
  `fieldSources`), each of `hostLocales(source, locales)`. That set needs no D1 read.
  Its early `if (results.length === 0) return []` (`server/option-sources.ts:607`) moves
  below the schema half, or a deployment with no sourced form would never refresh a
  field list. The cron
  (`folio.refreshOptionSources`) therefore refreshes field lists, and `pruneLists` keeps
  them.
- **The admin's field-options route** (decision 19) reads the row and, when missing or
  stale, refreshes it through the lease (`previewHostList` with `referenced: true`), with
  a 10 s load deadline.
- **A v1 write** that needs a never-loaded list refreshes it under the lease with a 10 s
  deadline before deciding (decision 20).

A field list changing purges the source tag as today (harmless: no page carries it for a
field). Localised sources load per locale; the admin asks for the editor's current
locale and falls back to `''`.

#### 19. The admin picks from the list; a value the list no longer has is shown, labelled where possible, never silently cleared

`GET {base}/api/field-options?block=<type>&field=<name>&locale=<code>[&story=<id>]`
(internal, scoped, `READ`; with `story`, fenced to the chain like every id route)
answers:

```ts
{
  source: string;
  status: "fresh" | "stale" | "never-loaded";
  loadedAt: number | null;
  failure?: "timeout" | "threw" | "malformed" | "empty";
  options: { value: string; label: string }[];   // sourced, then typed extras (materialiseOptions)
  missing?: { value: string; label: string | null }[];  // stored values of `story` not in `options`
}
```

**`lookup` is asked only about values a document actually stores.** With `story`, the
route reads that story's draft through `draftFor`, collects the distinct values the
document holds in this block type's field (every blok of the type, source data and
`i18n`), keeps those not in the list, and calls the source's `lookup` with at most 20 of
them, under the source's timeout, storing nothing. Without `lookup`, or when it fails,
`label` is `null`. A caller cannot choose the values, so the route is no label oracle
for arbitrary ids: it answers labels only for ids an editor has already put in a
document the caller may read. Host traffic is one `lookup` call per inspector open of a
document holding a retired value, which the open itself bounds; the route caches
nothing, because a retired product's label is rarely asked twice and a cache would be a
fourth copy of host data with no purge.

The inspector's `select` control, for a field with `optionsFrom`, becomes a
`SourcedSelect`: the options from that route; a stored value not in them drawn as its
`lookup` label, else its raw value, with "No longer offered by <source label>" beneath
it, and kept until the editor picks another; a `never-loaded` list drawn as a disabled
control with "Products could not be loaded (<category>)" and a Retry; a `stale` list used
as is. A list over 20 options draws a filterable combobox rather than a native
`<select>` (the existing `Select` primitive below that). The editor writes through the
Durable Object as for any field.

**The other two places the admin draws a select's options** read the same route without
`story`: a `collection` filter on a sourced select (`QueryControls.tsx:123-134`, which
today maps `def.options` and would offer only "Any") lists the sourced options followed
by the extras, and the Model screen's field detail (`settings-model.ts:393`, which joins
`field.options`) reads "from <source label>" instead of a value list, with no request.

#### 20. API and MCP writes are checked against the last good list; a list that never loaded refuses with `503 unavailable`

Both v1 write paths (`PATCH {base}/api/v1/documents/:id/fields` and the nested `PUT
…/content` and `POST …/documents`, which `patch_fields`, `write_content` and
`create_document` dispatch to) gain one async step between computing the mutations and
committing them.

**Where it runs.** `fromNested`, which calls `fieldShapeError`, runs inside the
synchronous `target` transform `writeDocument` takes (`write.ts:177-188`,
`routes/api/documents.ts:596-605`), so an async read cannot sit inside it.
`writeDocument` (today `(deps, target, actor, key?, layer?)`) gains an optional sixth
parameter, `check?: (mutations: Mutation[]) => Promise<void>`, called after `diff` and
before `commitAll`; it throws a `FolioError` to
refuse. The PATCH route builds its mutations itself (`documents.ts:640-672`) and calls
the same checker before its own `commitAll`. Checking the mutations rather than the
payload gives "changed values only" for free: a merge payload that hands back a stored
retired id produces no `set` and is not refused.

`checkSourcedSets(brand, db, mutations, draft)` (`server/option-sources.ts`):

1. Keep the `set` mutations whose blok's type declares the field with `optionsFrom`
   (the blok's type read from the draft, or from the mutation's own insert for a new
   blok). Source-locale and per-locale sets both check the source-locale list, since the
   stored value is an id, not a label.
2. Read the lists on the request's session, one `readLists` per brand.
3. A value in the last good list, or a typed extra, or `""`/`null`: accepted, whether the
   list is fresh or stale (spec 37 owner decision 1: an outage does not become the
   writer's problem).
4. A value not in a list that holds options: `400 bad_request`, "fields.product is not a
   value the `products` source offers (see GET /api/v1/options/page/product or
   list_field_options)".
5. A list that never loaded: refresh under the lease (10 s); still never loaded:
   `503 unavailable`, "The `products` option source has not loaded, so fields.product
   cannot be checked. Try again later."

`fieldShapeError` (pure, `core`) changes for a sourced select: any printable string of 1
to 120 characters, or `""`, or a typed extra. It cannot see the list, so the membership
check is the route's, the split spec 37 decision 11 made for conditions.

The admin path (keystrokes through the Durable Object) is not checked, like every other
field; the picker offers only listed values, and `check_document` reports drift. Publish
does not check either: a product archived after a page was written must not block an
unrelated edit's publish.

`FolioErrorCode` gains `unavailable` (HTTP 503): "a host dependency Folio needs to
answer has never answered". Added, as check names are, never renamed.

**Rejected: fail open on a never-loaded list.** A token with `content:write` could then
store any string under a field whose whole point is that it holds a real product.
**Rejected: check at publish.** Decided above.

### Feature 4: a read-only linked-data panel

#### 21. Structured JSON, rendered by Folio; the host function is called per inspector open, with a timeout, and nothing is cached on the server

```ts
// FolioSingleConfig and FolioBrand gain (and BRAND_KEYS gains "panels"):
panels?: Readonly<Record<string, FolioPanel<Env>>>;   // keyed by document type name

export interface FolioPanel<Env> {
  /** The card's heading in the inspector. 1 to 40 characters. */
  label: string;
  /** The minimum role on the document's scope to see it. Default "viewer". */
  role?: Role;
  /** Milliseconds before the call is abandoned. 500 to 10000, default 3000. */
  timeoutMs?: number;
  /** The summary, or null for "nothing linked" (the card is then not drawn). A method,
   *  for the bivariance reason `FolioGate` gives. */
  load(ctx: FolioPanelContext, env: Env): FolioPanelSummary | null | Promise<FolioPanelSummary | null>;
}

export interface FolioPanelContext {
  story: StoryMeta;
  /** The draft root block's data in the source locale (`dataOf`): what the editor sees. */
  data: Readonly<Record<string, Json>>;
  /** The inspector's locale, or null for the source locale. */
  locale: string | null;
  scope: string | null;
  brand: BrandRef | null;
  /** Who is looking, projected with `editorOf` from the route's own scoped actor
   *  (`c.var.actor`, no second credential read). Null under `auth: 'open'`. */
  editor: FolioEditor | null;
  /** Aborts at `timeoutMs`. */
  signal: AbortSignal;
}

export interface FolioPanelSummary {
  /** At most 8. `label` 1 to 40 characters, `value` 1 to 80. */
  items: readonly { label: string; value: string; tone?: "neutral" | "ok" | "warn" | "danger" }[];
  /** At most 280 characters. */
  note?: string;
  /** A same-origin path (rewritten to the admin's host-page URL when under a declared
   *  page path) or an `https:` URL (opened in a new tab). `label` 1 to 40 characters. */
  link?: { label: string; href: string };
}
```

"6 variants, from $28.50, 3 editions left" is `items: [{ label: "Variants", value: "6" },
{ label: "From", value: "$28.50" }, { label: "Editions left", value: "3", tone: "warn" }]`
with `link: { label: "Open in Products", href: "/admin/products/prod_8812" }`.

**JSON, not HTML.** Folio renders every string as React text, in its own tokens, in
light and dark, with the inspector's spacing and an accessible definition list. HTML from
the host would need a sanitiser (and one more place for an XSS bug in the editor that
holds every editor's session) or a sandboxed frame inside the inspector (a second
iframe protocol and a height problem decision 10 avoided). A host that needs more than a
summary links to its host page, which is what feature 2 is for.

**The route.** `GET {base}/api/stories/:id/panel?locale=` (internal, scoped, `READ`,
`fenceStory` to the chain) loads the draft through `draftFor` (the sanctioned draft read,
`CLAUDE.md` invariants), builds the context, and gates it in both currencies, as
`Access` does (`roles.ts:324-335`): a person needs `panel.role` or above as their
effective role on the scope; a token needs `content:read:draft` on the scope (the panel
is computed from the draft, the scope `READ_DRAFT` names), and a panel's `role` above
`viewer` admits no token at all, because a role has no token equivalent. Either refusal
is `403`. `ctx.editor` is `editorOf(c.var.actor, …)`, the actor `withActor` already
resolved and scoped. The route then races `load` against `timeoutMs` exactly as `loadScreened` does
(`server/option-sources.ts:283-337`): a signal that aborts, a race that abandons a
`load` that ignores it, a swallowed late rejection. It answers `200` with one of:

```ts
| { status: "ok"; summary: FolioPanelSummary; at: number }
| { status: "none" }                                    // load returned null
| { status: "error"; reason: "timeout" | "threw" | "malformed" }
```

`screenPanel(raw)` (pure, `core/panels.ts`) enforces the caps and the printable rule,
drops an item that fails, drops a `link` whose `href` is neither a `safeNext`-valid path
nor an `https:` URL, and answers `malformed` when nothing survives and there is no note.
A thrown value is logged with `rt.logger.error("folio: panel <type> failed (<reason>)",
err)`; the editor sees the category and never the message (spec 37 decision 16).

**No server cache.** `load` receives the editor, so a shared cache would leak one
editor's view to another; the Cache API is per colo and unpurgeable (`CLAUDE.md`), and a
D1 table would be a migration and a write per read for a summary measured in seconds. The
host caches inside `load` when its own data is expensive, with whatever it already uses.
The admin keeps the last answer per story for the life of the open editor, refetches when
a root scalar of the draft changes (debounced 3 s), on a Refresh button, and on re-open;
it never polls.

**Manifest.** `Manifest.panels?: Record<string, { label: string; role: Role }>`, absent
when the brand declares none, so a host without panels gets a byte-identical manifest.
Labels are not secrets (they are headings like "Shop"); the route is the gate.

**Placement.** On the root blok of a document of that type, after the head and block
help and before the Address block and the fields: context first, then the form. A card
with the panel's `label` as heading, the items as a definition list with tone badges, the
note muted, the link as a button. Loading is a skeleton of the card's last known height;
`error` is one line, "Couldn't load Shop (timed out)", with Retry.

**Rejected: a panel keyed per block type.** The host's question is about the document
(this product), and a block can sit in many documents.

### Release

#### 22. v1.7.0 is a minor release: every change adds, nothing narrows

- New `Folio` methods (`editor`, `requireEditor`, `signInUrl`, `originAllowed`), new
  optional config keys (`admin`, `optionSources`, `panels`), a new optional property on a
  field (`optionsFrom`) and a builder overload, new types, a new export subpath
  (`folio/host`) and an asset export (`folio/host.css`), one new v1 route, one new MCP
  tool, two new check names and one new error code.
- `FolioErrorCode` and `ContentCheck.check` are open vocabularies by contract (added to,
  never renamed). A host that switches exhaustively over `FolioErrorCode` in TypeScript
  sees a compile error naming `unavailable`; `UPGRADING.md` says so.
- No migration, no `PROTOCOL_VERSION` change, no new binding, no new Durable Object.
- A host that declares none of the new keys gets byte-identical `{base}/api/schema`,
  `{base}/api/v1/schema` and `/me` answers (pinned by test).

## Wire and schema changes

### D1

None. Field lists reuse `option_lists` (`0016`).

### Core types

- `Field` `select` gains `optionsFrom?: OptionsFrom`. Backward compatible with stored
  documents and logs: the stored value is a string as before.
- `ValueOf<select with optionsFrom>` is `string`.
- `Manifest.panels?` (decision 21). Absent unless declared.
- New `core/host-page.ts` (`HOST_PAGE_PROTOCOL`, `HostPageFrame`, `screenHostFrame`) and
  `core/panels.ts` (`FolioPanelSummary`, `screenPanel`), both pure.
- `fieldShapeError` changes for a sourced select only (decision 20).

### New or changed routes

| Method and path | Surface | Auth | Notes |
| --- | --- | --- | --- |
| `GET {base}/api/v1/options/:block/:field?locale=` | v1, scoped | `READ` (`content:read`) | `{ source, status, loadedAt, failure?, options }`. `404` for an unknown block or field, `400` for a field with no `optionsFrom`. Refreshes a missing or stale list under the lease (10 s). |
| `PATCH {base}/api/v1/documents/:id/fields`, `PUT {base}/api/v1/documents/:id/content`, `POST {base}/api/v1/documents` | v1 | unchanged | Sourced-select membership (decision 20): new `400` message, new `503 unavailable`. |
| `GET {base}/api/field-options?block&field&locale&story` | internal, scoped | `READ` | Decision 19; `story` fenced to the chain. |
| `GET {base}/api/stories/:id/panel?locale=` | internal, scoped | `READ` + panel role | Decision 21. Fence-tested in `scope-partition.test.ts`. |
| `GET {base}/api/me` | internal, unscoped | unchanged | Gains `hostPages`, with `allowed` on `deployment` pages. |
| `GET {base}/api/schema`, `GET {base}/api/v1/schema` | unchanged | unchanged | A sourced select's field carries `optionsFrom`; the brand manifest gains `panels` when declared. |
| `GET /folio-host.css` | static asset | public | Emitted by the Vite plugin. |
| `GET {base}/host/<id>/…` | admin shell | `READ_DRAFT` | No server change: the existing shell wildcard answers it; the client router parses it. |

Error envelope: `FolioErrorCode` gains `unavailable` (503).

### Effect by surface

| | REST API | MCP | Content check API |
| --- | --- | --- | --- |
| 1. Editor session | none (in-process only) | none | none |
| 2. Host pages | `/api/me` (internal) only | none | none |
| 3. Sourced select | v1 schema shows `optionsFrom`; new `GET /api/v1/options/:block/:field`; v1 writes check membership (`400`, `503 unavailable`) | `get_schema` shows `optionsFrom`; new nineteenth tool `list_field_options({ block, field, locale? })` dispatching to the v1 route; `patch_fields`, `write_content`, `create_document` surface the new refusals | `field-shape` accepts a sourced value of the right shape; new `option-not-offered` (warning, `fix: "patch_fields"`, `detail: { source, value }`) and `option-list-unavailable` (info, `fix: "schema"`, `detail: { source }`), read through a new at-most-once `CheckContext.optionLists` |
| 4. Panels | none in v1 (internal route only) | none | none |

Panels stay out of v1 and MCP on purpose: the summary is the host's data, the host owns
its own API for it, and a v1 route is a promise Folio would be making about the host's
shop. An agent that needs product facts calls the host.

## Security

**1. Editor session.** Fails closed on every path: no credential, open auth, a token
without `tokens`, a refused Origin on an unsafe method, a non-admin origin with `sites`,
a revoked or expired session, and a scope Folio does not serve (decision 3: checked
against the registry before any role is computed, because `effectiveRole` would answer
the `*` grant for it). A grant or share cookie is never a credential here (`resolveActor`
without `preview` cannot return a grant, and share cookies are another name). The
projection carries no session hash. The per-request memo lives in the instance's
closure, so two Folio instances never share a resolution. `requireEditor`'s responses are
`private, no-store`, and its admissions carry `HOST_PAGE_HEADERS`.

**2. Host pages.** Folio's sidebar is an affordance; the host route is the authority
and calls `requireEditor({ page })` on every request, including `POST`s and the host's
own JSON endpoints the page calls. That call enforces the page's `role`, its scope and
its `brands` (decision 12), so a brand-B editor passing a brand-B `folio_scope` to a
brand-A page is refused there, not only in the sidebar. `brands` is refused on a
`deployment` page at construction, so no page declares a filter nothing enforces.
`HOST_PAGE_HEADERS` (decision 12a) carry `frame-ancestors 'self'`, which also closes
same-site sibling framing that `SameSite=Lax` does not; a host that discards the
`headers` `requireEditor` hands it is framable by a same-site sibling, and the handbook
says so beside the snippet. The admin shell itself is unchanged (it sets no CSP today,
`pages.tsx:635-637`); this spec does not alter that. The admin trusts a `postMessage`
only from its own frame on its own origin, caps and screens every field, and renders it
as text. Promotion to top level happens only for `http(s):` locations on the admin
origin; `about:blank`, `blob:` and `data:` are ignored, and a cross-origin frame is
replaced by a notice (decision 8 rule 6), so host content cannot turn the admin into an
open redirect. `folio_scope` and `x-folio-scope` select a scope; decision 3 checks it and
`effectiveRole` decides. The `sessionStorage` copy is a convenience for the host's own
requests and grants nothing: every request is re-checked.

**3. Sourced select.** A source under `optionSources` is reachable only from field code:
never listed by `/forms/registry`, never previewed by the builder, never rendered on a
form (decision 16), and never run with settings an HTTP caller chose (decision 17). A
source under `forms.sources` keeps the exposure spec 37 gave it, whether or not a field
also names it. `load` runs only in the refresh paths (cron, the admin's field-options
route, a v1 write's never-loaded refresh), under a lease and a timeout, never during a
render. `lookup` runs only for values a readable document already stores, at most 20 per
inspector open (decision 19), so it is not an oracle over arbitrary ids; the handbook
still says it must answer only what a viewer may see. Values and labels are screened
before they are stored or drawn. Settings are in the unauthenticated manifest (as `help`
is), so they hold no secret. v1 writes fail closed on a never-loaded list.

**4. Panels.** JSON only, rendered as text; `href` screened (`safeNext` path or
`https:`), external links `rel="noopener noreferrer"`. The route is fenced to the
story's chain and gated in both currencies: a person by the panel's role on the scope, a
token by `content:read:draft` and only when the panel's role is `viewer` (decision 21).
`ctx.editor` comes from the already-scoped actor. No server cache, so no cross-editor
leakage. Timeouts bound a hung host call to the request.

## Acceptance criteria

### `editor()` reads the session and costs nothing without one
```
GIVEN a deployment with magicLink and no sites
WHEN a host route calls folio.editor(req, env) with no cookie
THEN it answers null and config.bindings is never invoked
WHEN it calls it with a valid session cookie
THEN it answers { kind: 'user', user: { id, name, email }, role, grants: { '*': role }, scope: null, brand: null }
AND a second call on the same Request issues no second D1 statement
```

### Every sign-in door is one session
```
GIVEN cloudflareAccess() as a provider and no session
WHEN requireEditor runs on GET /admin/orders
THEN it answers 302 to {base}/login?next=%2Fadmin%2Forders
AND following it through the trusted sign-in returns to /admin/orders with a session editor() recognises
```

### Scope decides the role
```
GIVEN sites, a person with editor on group 'harbour' and nothing on '*'
WHEN editor(req, env, { scope: 'alpha' }) for alpha in harbour
THEN role is 'editor'
WHEN editor(req, env) with no scope
THEN role is null and grants is { harbour: 'editor' }
WHEN the request's origin is a live host rather than sites.admin
THEN editor() answers null
GIVEN a person holding admin on '*'
WHEN editor(req, env, { scope: 'ghost' }) for an id the registry does not serve
THEN role is null, brand is null, and requireEditor({ page }) for a site page answers 403
AND the same holds for an unbound token with tokens: true, whose scopes are []
```

### Brands are enforced where the request is
```
GIVEN brands a and b, and a site page { id: 'orders', scope: 'site', brands: ['a'] }
WHEN an editor of brand-b site 'bravo' requests /admin/orders?folio_scope=bravo
THEN requireEditor answers 403 'This page is not part of <b's label>.'
GIVEN a deployment page declaring brands
THEN createFolio throws naming admin.pages[].brands
```

### CSRF
```
GIVEN a valid session cookie
WHEN a POST to a host route carries Origin: https://evil.example
THEN editor() answers null and requireEditor answers 401
WHEN the same POST carries the admin's own Origin
THEN editor() answers the user
```

### A host page appears, frames and enforces
```
GIVEN admin.pages [{ id: 'orders', label: 'Orders', path: '/admin/orders', role: 'editor', group: 'Shop', icon: 'receipt' }]
WHEN an editor opens {base}/host/orders/1042?tab=items
THEN the sidebar shows Shop > Orders, active
AND the iframe src is /admin/orders/1042?tab=items
WHEN a viewer signs in
THEN no Orders item is drawn, and GET /admin/orders answers 403 from requireEditor({ page: 'orders' })
```

### Back and deep links
```
GIVEN the Orders page framed at /admin/orders
WHEN the operator follows an in-frame link to /admin/orders/1042
THEN the admin URL is replaced with {base}/host/orders/1042, with no extra history entry
WHEN the operator presses Back once
THEN the frame shows /admin/orders and the admin URL is {base}/host/orders
```

### A site page keeps its scope
```
GIVEN sites, a site page 'orders' framed under {base}/~alpha with folio_scope=alpha
WHEN the operator follows a plain <a href="/admin/orders/1042"> inside the page
THEN with connectHostPage the request carries folio_scope=alpha and is admitted
AND without the helper the frame loads once without it, then the admin replaces it with folio_scope=alpha appended, with no history entry added
WHEN the page fetches /admin/api/orders with scoped()
THEN the request carries x-folio-scope: alpha and requireEditor admits it
WHEN the operator presses Back after the in-frame link
THEN the frame shows /admin/orders and is not reloaded a second time
```

### Multi-site deep links
```
GIVEN sites, a deployment page 'stock' and a site page 'orders'
WHEN a platform admin opens {base}/host/stock/sku-1 at the bare mount
THEN the shell frames /admin/stock/sku-1, with the bare-mount nav showing Sites and Stock
WHEN they open {base}/host/orders/1042 at the bare mount
THEN the shell shows the site chooser, and choosing alpha navigates to {base}/~alpha/host/orders/1042
WHEN /admin/orders/1042?folio_scope=alpha is opened top level with connectHostPage({ page: { id: 'orders', scope: 'site' }, frame: true })
THEN it redirects to {base}/~alpha/host/orders/1042
```

### Title and crumbs
```
GIVEN a framed page that posts announce({ title: 'Order #1042', crumbs: [{ text: 'Open orders', href: '/admin/orders?state=open' }] })
THEN the top bar reads Shop / Orders / Open orders / Order #1042, the tab title 'Order #1042 · Folio'
AND a message from any other window or origin, or with v: 2, changes nothing
```

### Session expiry inside the frame
```
GIVEN an expired session while a host page is framed
WHEN the frame navigates and requireEditor redirects it to {base}/login?next=/admin/orders/1042
THEN the admin navigates the top window to {base}/login?next={base}/host/orders/1042
```

### A sourced select offers the host's list
```
GIVEN optionSources.products returning [{ value: 'prod_1', label: 'Classic tee' }] and a page root field select({ optionsFrom: { source: 'products' }, indexed: true })
WHEN an editor opens the page
THEN the Product control lists 'Classic tee', and choosing it stores 'prod_1'
AND folio.query({ where: [{ field: 'product', op: 'eq', value: 'prod_1' }] }) finds the published page
AND the block's render receives 'prod_1'
```

### A field-only source stays out of forms
```
GIVEN optionSources.customers and no forms.sources.customers
THEN GET /api/forms/registry does not list customers
AND saving a form question with optionsFrom { source: 'customers' } is refused as an unknown source
AND a field select({ optionsFrom: { source: 'customers' } }) is accepted at construction
GIVEN the id 'products' under both optionSources and forms.sources
THEN createFolio throws naming both keys
```

### A retired value stays visible
```
GIVEN a page storing 'prod_9' and a list that no longer has it, and a lookup answering 'Archived tee'
WHEN the editor opens it (the inspector asks GET /api/field-options with story=<its id>)
THEN the control shows 'Archived tee' with 'No longer offered by Products', and the stored value is unchanged
```

### API writes are checked
```
GIVEN a loaded products list without 'prod_x'
WHEN PATCH /api/v1/documents/:id/fields sets product to 'prod_x'
THEN 400 bad_request naming the field and the source
GIVEN a list that has never loaded and a load that throws
WHEN the same PATCH sets 'prod_1'
THEN 503 with code 'unavailable'
GIVEN a stale list containing 'prod_1' whose refresh fails
WHEN the PATCH sets 'prod_1'
THEN it is accepted
```

### The list survives the cron and the prune
```
GIVEN a field list loaded nine days ago and no form naming the source
WHEN folio.refreshOptionSources runs
THEN the row is refreshed, not pruned
```

### A panel renders a summary, safely
```
GIVEN panels.product.load answering items with a 300-character value and a javascript: link
WHEN the editor opens a product record
THEN the value is cut to 80 characters with '…', the link is dropped, and the other items render
GIVEN a load that takes 5 s with timeoutMs 3000
THEN the route answers { status: 'error', reason: 'timeout' } after about 3 s and the card offers Retry
GIVEN panel role 'publisher' and an editor
THEN the route answers 403 and the card is not drawn
GIVEN a content:read:draft token and a panel of role 'viewer'
THEN the route answers ok; with panel role 'editor' it answers 403
```

### Nothing changes for a host that declares none of it
```
GIVEN a config with no admin, optionSources, panels or optionsFrom
THEN /api/schema, /api/v1/schema and /api/me answer byte-identically to v1.6.1, and MCP lists the new tool only
```

## Edge cases

- **Two host pages whose paths nest** (`/admin` and `/admin/orders`) → refused at
  construction: the frame's location must map to exactly one page.
- **`about:blank` or a `blob:` PDF in the frame** → ignored by the mirror; never promoted.
- **A host page path equal to a route the host does not serve** → the frame shows the
  host's 404. Folio cannot know the host's routes.
- **A host page that sets `X-Frame-Options: DENY`** → the browser refuses the frame;
  the admin shows decision 8 rule 6's "refused to be shown inside Folio" notice with
  *Open in a new tab*, and the handbook's troubleshooting table names the header.
- **A host page loading Folio's own admin in the frame** (a link to `{base}/content`)
  → promoted to top level by decision 8 rule 5, so the admin is never nested.
- **A `site` page with no scope** (opened top level, in a fresh tab) → `requireEditor`
  answers `403` with the sentence in decision 12. With `connectHostPage({ page, frame:
  true })` the visit is redirected into the admin first: to the scoped mount when the tab
  holds a scope, else to the bare mount's site chooser (decision 8's table).
- **A host link with an encoded slash** (`/admin/products/a%2Fb`) → the admin URL keeps
  `a%2Fb` as one segment and the frame gets the same path back (decision 8).
- **An editor switches scope while on a `site` host page** → the admin navigates to the
  same page in the new scope; the frame reloads with the new `folio_scope`. A page whose
  `brands` excludes the new scope's brand renders `missing`.
- **A sourced select on a nested (non-root) block** → allowed; it is not indexed (only
  root fields index), and v1 writes check it like a root field.
- **A source that answers more than 500 options** → the first 500 are kept and a warning
  is logged (`screenItems`); a stored value past the cut reads as "No longer offered".
  The 500 cap (`MAX_SOURCED_OPTIONS`) stays for fields as for forms (owner decision,
  2026-11-17): a larger catalogue is narrowed with settings, for example one field per
  product collection.
- **The same source and settings on a form question and a field** → one row, one load.
- **A localised source** → the admin shows labels in the inspector's locale; the stored
  value is the same in every locale, so `translatable` is refused.
- **`lookup` throws or times out** → `label: null` for those values; the control shows
  the raw value. Nothing is logged at error level (it is a cosmetic call); one `warn`.
- **A panel's `load` reads the draft data while the editor types** → the route reads
  through `draftFor`, so it sees the Durable Object's current draft, not the 2 s
  `draft_data` mirror.
- **A panel on a page type, not a record** → allowed; the card shows on the root blok
  of any document of a type with a panel.
- **A panel's `link` under a host page path** → rewritten to `{mount}/host/<id>/…`, so it
  opens inside the chrome; any other same-origin path navigates the admin top level; an
  `https:` URL opens a new tab.
- **Two `editor()` calls on different `Request` objects for one logical request**
  (a framework that clones the request) → two reads. Correct, and the handbook says to
  pass the original request.

## Testing requirements

**Unit (`test/unit/`):**
- `server/editor.test.ts`: `editorOf(actor, registry, scope)` projection for a user, a
  token (bound and unbound), and every refusal; no session hash in the output; scope
  roles through `effectiveRole`; an unknown, deleted, brandless or malformed scope gives
  `role: null`, `scopes: []`, `brand: null` even for a `*` admin and an unbound token
  (the `writersOf` trap, decision 3); no scope reads `grants['*']`, not `role`.
- `server/admin-config.test.ts`: every `validateAdmin` refusal named in decision 12,
  including `auth: 'open'`, nested paths, a path under `basePath`, an unknown brand,
  and `brands` on a `deployment` page.
- `core/host-page.test.ts`: `screenHostFrame` (origin and source are the admin's check;
  this pins shape, caps, printable rule, crumb `href` mapping, unknown `v`).
- `admin/host-page-model.test.ts`: `framedSrc` (query passthrough, `folio_scope` for
  `site` pages under a scoped mount only, `..` refused, a `rest` segment holding `%2F`,
  `%3F` or `%23` round-trips unchanged); `mirror(location, pages, mount)` (page match,
  raw encoded segments kept, `folio_scope` stripped, outside-all promotes, `about:blank`,
  `blob:` and `data:` ignored, `{base}/login` promotion rewrites `next`); `needsScopeHeal`
  (a `site` page location without `folio_scope`); the popstate replace decision with
  `folio_scope` removed from both sides (equal after a frame traversal, so no reload);
  the first-load `SecurityError` versus later-load classification; `frameRedirectTarget`
  for all four rows of decision 8's table.
- `admin/ui-route.test.ts`: `host` screen parse and `href` round trip at the bare and a
  scoped mount, with encoded segments; `crumbs` and `documentTitle` with and without
  announced crumbs.
- `admin/ui-nav.test.ts`: groups and order; `deployment` pages filtered by `allowed`,
  `site` pages by the scope's role and brand; `activeItem`; the bare multi-site root
  draws Sites plus allowed `deployment` pages and no `site` pages; absent with no pages.
- `admin/me.test.ts`: `hostPages` parsing, `allowed` honoured over `actor.role`.
- `admin/render/host-helper.test.ts` (happy-dom, the `render` project, which is the
  suite's only DOM, `test/unit/admin/render/**`): `connectHostPage` seeds
  `sessionStorage` per page id, adds `folio_scope` to a clicked same-origin link and a
  submitted form that lack it and to nothing cross-origin, `scoped()` sets
  `x-folio-scope`, `framed()` false makes `announce` a no-op.
- `admin/built-css.test.ts`: `folio-host.css` exists, declares every public `--folio-*`
  token in light and dark, and has no rule outside `:root`, the dark blocks and
  `body.folio-host`.
- `core/fields.test.ts` and a type test (`@ts-expect-error`): `select({ optionsFrom })`
  without `options` compiles, `translatable` with `optionsFrom` does not, `ValueOf` is
  `string`; `fieldShapeError` for a sourced select; `defaultValue` is `""` with and without
  typed extras.
- `server/option-sources.test.ts`: `validateFieldSources` refusals; `fieldSources` is
  the union and `forms.sources` is untouched; the duplicate-id refusal; `hostListsOf`
  with each map; schema lists in `referencedLists` with zero sourced forms (the moved
  early return); `pruneLists` keeps them; `checkSourcedSets` over mutations (a merge
  payload handing back a retired id produces no `set` and passes).
- `admin/sourced-select-model.test.ts`: option merge with extras, the retired-value row,
  the combobox threshold, the `QueryControls` filter options and the Model-screen detail
  "from <source>".
- `server/checks.test.ts`: `option-not-offered`, `option-list-unavailable`, and
  `field-shape` silent for a well-formed sourced value.
- `core/panels.test.ts`: `screenPanel` caps, tones, `href` rules, `malformed`.
- `server/panels-config.test.ts`: `validatePanels` (unknown type, label length,
  `timeoutMs` range, `load` not a function, unknown key).
- `admin/linked-panel-model.test.ts`: refetch key from root scalars, debounce, link
  rewrite to host-page URLs.
- `mcp/tools.test.ts`: nineteen tools (`:113` title and `:118` count),
  `list_field_options` dispatching to the v1 route at `READ`.
- `mcp/scopes.test.ts`: `READS` (`:45-52`, compared at `:82` and `:104`) gains
  `list_field_options`.
- `cli/ledger.test.ts`: passes at every step, with the undated `1.7.0` entry from step 2
  on and its date from step 19.

**Workers (`test/workers/`, real workerd):**
- `host-editor.test.ts`: a purpose-built `createFolio` per test (the `publish-hooks`
  pattern): no-cookie null with a throwing `bindings` (no read); session user; revoked
  session null; token null by default, accepted with `tokens: true`; cross-origin POST
  null; same-origin POST user; multi-site scope roles and non-admin origin; branded
  `brand`; open auth null; memoisation (statement count through `withSession` and
  `bind`, per `CLAUDE.md`); `requireEditor` 302 with `next`, 401, 403 wording, `no-store`;
  `requireEditor({ page })` with a `site` page via `folio_scope` and via `x-folio-scope`,
  with none (403), with an unserved scope (403 even for a `*` admin), with a scope of a
  brand outside `brands` (403); admissions return `HOST_PAGE_HEADERS`; two instances
  built in one test never share a memoised answer.
- `auth-trusted.test.ts`: a trusted-provider sign-in followed by `editor()` on a host
  path.
- `host-pages.test.ts`: `/api/me` carries `hostPages` exactly when configured, with
  `allowed` from `grants['*']` (a site-only editor reads `false` for a viewer page); byte
  identity of `/me`, `/api/schema`, `/api/v1/schema` with nothing configured;
  construction throws under open auth and for `brands` on a `deployment` page.
- `field-sources.test.ts`: v1 PATCH and PUT accept, refuse (400) and refuse (503
  `unavailable`) per decision 20, stale-accepted; MCP `patch_fields` and `write_content`
  surface the same; `GET /api/v1/options/:block/:field` (fresh, refresh of stale, 404,
  400); `GET /api/field-options` with `story` (`lookup` called only with that draft's
  retired values, at most 20; its timeout; another site's story 404); an
  `optionSources`-only source absent from `GET /api/forms/registry`, refused in a form
  question's `optionsFrom` by `checkOptionSources`, and refused by the builder preview;
  a brand's source invisible from another brand's scope; index query by sourced value;
  cron refreshes a field list and does not prune it.
- `checks.test.ts`: the two new findings end to end over `check_document`.
- `panels.test.ts`: `ok`, `none`, each `error` reason (a `load` that never resolves, one
  that throws, one that answers garbage); role 403; a `content:read:draft` token admitted
  to a `viewer` panel and refused by an `editor` one; fence (another site's story 404);
  `load` receives the Durable Object draft's root data and the editor; no D1 write by
  the route; manifest `panels` present only when declared.
- `scope-partition.test.ts` and `api-partition.test.ts`: the new internal and v1 routes
  are in the right partitions and fence-tested.
- `mcp.test.ts`: `READS` (`:250`) gains `list_field_options` (so `READS_DRAFT`, `:266`,
  and the `:542`, `:554`, `:568`, `:591` comparisons follow), and the two
  `toHaveLength(18)` (`:580`, `:604`) become 19; `patch_fields` and `write_content`
  surface decision 20's refusals.

**End to end (`scripts/*-test.mjs`):**
- `scripts/host-page-test.mjs` against the demo: `{base}/host/orders` answers the shell;
  `/admin/orders` with a session answers 200 with `frame-ancestors 'self'` and
  `no-store`; without one, 302 to login with `next`; as `viewer@example.com`, 403;
  `/folio-host.css` answers CSS.
- `scripts/mcp-test.mjs` is checked and needs no change: it asserts membership with
  `includes` (`:221-226`) and the `assets:write` token's exact pair (`:240-244`), and
  `list_field_options` needs `content:read`, which that token lacks.

**Not testable in these tiers, and why:** the iframe's joint-history behaviour (Back
after in-frame navigation), the `replaceState` mirror, the 15 s overlay, the promotion
on login, and the look of `folio-host.css` need a browser, and this repository has no
browser tier (`CLAUDE.md`, "End-to-end scripts": "no browser"). Their decisions are pure
functions with unit tests (`host-page-model.ts`); the owner's browser pass on the demo
checks the rest before the release is tagged, as spec 34 was.

## Docs and handbook

- **`docs/handbook.md`**
  - "Auth": a new subsection, "Your own routes behind Folio's sign-in", with
    `editor()`, `requireEditor()`, `signInUrl()`, scopes, the admin-origin rule, CSRF
    and open mode.
  - A new chapter, "Extending the admin", after "Hooks": host pages (config, the frame,
    deep links and Back, `folio/host`, `folio-host.css`, headers, the troubleshooting
    table: `X-Frame-Options`, a page on a live host, a missing `folio_scope`) and
    linked-data panels.
  - "Forms" > "Options from a source": sources are now `optionSources` and shared with
    fields; `lookup`.
  - "Data documents": a sourced select on a record, and the panel.
  - "Many sites in one deployment" > "What a host does": host pages live on
    `sites.admin`; `scope: 'site'` pages and `folio_scope`.
  - "Many brands": `optionSources` and `panels` per brand; `admin.pages[].brands`.
  - "Content API" and "An MCP server": the options route, the write refusals, the tool.
  - "The exported surface": `folio/host`, `folio/host.css`, the new `folio/server`
    names; "Not built yet": host-defined field kinds and plural external picks remain.
- **`docs/configuration.md`**: `admin.pages` and every `HostPage` key; `optionSources`;
  `panels`; `select.optionsFrom`; each with default and failure mode.
- **`docs/api.md`**: `GET /api/v1/options/:block/:field`; the new write refusals; the
  `unavailable` code.
- **`docs/mcp.md`**: `list_field_options`.
- **`AGENTS.md`**: a section "Your own admin screens" (the `requireEditor` snippet, the
  headers, `folio/host`, the admin-origin rule on a multi-site host), a Rules line ("Gate
  every host admin route, and its JSON endpoints, with `requireEditor`; the sidebar is not
  a permission"), and the "Limitations" line on custom field types amended to name the
  sourced select.
- **`README.md`**: one line per feature in the tour.
- **`CLAUDE.md`**: the MCP count (nineteen), the export entries (`folio/host` and
  `folio/host.css` join seven subpaths and `./admin-entry`; the "eighth" sentence is
  corrected to say what it counts),
  two invariants ("`folio.editor` reads on a session and only on the admin origin";
  "host-page frames are a public protocol versioned apart from `PROTOCOL_VERSION`"),
  and spec 44 in "Specs".
- **`docs/specs/README.md`**: row 44.
- **`CHANGELOG.md`**, **`UPGRADING.md`**, **`upgrade-ledger.json`**: below.
- **`examples/demo`**: an `orders` host page and a `product` panel and sourced field
  wired to a fake in-memory catalogue. **`examples/starter` is not changed** (what
  `folio init` copies stays minimal).

## UPGRADING and ledger

Four `###` headings under "Things that need an eye on upgrade", each naming the tag:

- `### Host access to the editor session (v1.7.0)`: nothing to do. `folio.editor`,
  `folio.requireEditor`, `folio.signInUrl` and `folio.originAllowed` are new, and
  `folio/server` exports `HOST_PAGE_HEADERS`. Under `auth: 'open'` `editor()` answers null. On a
  deployment with `sites` it answers only on `sites.admin`.
- `### Host pages in the admin (v1.7.0)`: nothing to do until `admin.pages` is set.
  Serve each page on the admin origin, send `HOST_PAGE_HEADERS`, and gate it with
  `requireEditor({ page })`. `admin.pages` is refused under `auth: 'open'`. New exports:
  `folio/host`, `folio/host.css`, `/folio-host.css`.
- `### Option sources on document fields (v1.7.0)`: `optionSources` (per brand with
  `brands`) registers sources for document fields only; forms never see them. A field
  may also name a `forms.sources` source. `forms.sources` is unchanged, and an id in both
  throws. `select({ optionsFrom })` is new. v1 writes to a sourced select are checked
  against its list and may answer `503` with the new code `unavailable`; a TypeScript
  switch that is exhaustive over `FolioErrorCode` must add it. `check_document` gains
  `option-not-offered` and `option-list-unavailable`. MCP gains `list_field_options`. If
  you register a source used only by fields, keep `folio.refreshOptionSources` in
  `scheduled()`.
- `### Linked-data panels (v1.7.0)`: nothing to do until `panels` is set.

Rolling back to v1.6.x is safe once `admin`, `optionSources`, `panels` and every
`optionsFrom` are removed. Do not move field-only sources under `forms.sources` to keep
them: that exposes them to the form builder and to published forms (decision 16). A field that held a
sourced id becomes `text({ indexed: true })` for the rollback, so the stored strings
stay valid and indexed.

**The ledger entry lands with the first heading, undated, and grows.**
`test/unit/cli/ledger.test.ts:218-226` fails for a `###` heading naming `v1.7.0` while
the ledger has no `1.7.0` release, and `:93-96` requires a release's `headings` to equal
exactly the headings naming its tag. The same test allows one release above
`package.json`'s version (`:233-238`), requires a `date` only at or below it
(`:240-246`), and lets the in-progress release lack a `CHANGELOG.md` section (`:154-160`).
So:

- **Step 2** appends to `releases`:

  ```json
  {
    "version": "1.7.0",
    "rollback": "safe",
    "migrations": [],
    "headings": ["Host access to the editor session (v1.7.0)"]
  }
  ```

- **Steps 8, 15 and 18** each append their heading to that entry's `headings`, in the
  same commit as the `UPGRADING.md` heading: `"Host pages in the admin (v1.7.0)"`,
  `"Option sources on document fields (v1.7.0)"`, `"Linked-data panels (v1.7.0)"`.
- **Step 19** adds `"date"` (the ISO date of that commit, as every entry was written,
  `CLAUDE.md` "Releasing" step 1), bumps `package.json` and `FOLIO_VERSION` to `1.7.0`,
  and adds the `CHANGELOG.md` section. Nothing else in the entry changes.

## Build sequence

One commit per step, each leaving `pnpm typecheck`, `./node_modules/.bin/biome ci .` and
`pnpm test` green (gate on exit codes). Conventional Commits per `commitlint.config.mjs`
(`@commitlint/config-conventional`): `type(scope): subject`, imperative, lowercase, no
trailing period, under about 72 characters. Work on a `feat/admin-extensions` branch;
`main` is reached only through a squash-merged pull request.

**Order and parallelism.** Steps 1–2 first (feature 1; step 2 creates the undated
`1.7.0` ledger entry every later docs step appends to). Then three tracks that share no
source file and can run in parallel: **B** (steps 3–8), **C** (steps 9–15) and **D**
(steps 16–18). D's step 16 needs step 1's `editorOf`. Tracks C and D both touch
`upgrade-ledger.json` and `UPGRADING.md` in their docs steps and both touch the
inspector (`Control.tsx` and `Inspector.tsx`); merge B, then C, then D, rebasing each
docs step's one-line ledger append. Step 19 last.

**Ledger rule for every docs step:** a commit that adds an `UPGRADING.md` `###` heading
naming `v1.7.0` appends the same text to the `1.7.0` entry's `headings` in
`upgrade-ledger.json`, or `test/unit/cli/ledger.test.ts` is red (`:93-96`, `:218-226`).

1. **`feat(server): add folio.editor and requireEditor for host routes`**
   New `src/server/editor.ts`: `editorOf(actor, registry, scope, rt)` (projection and
   decision 3's served-scope check), `editorFor` (credential read on a session,
   origin and admin-origin rules), the per-`Request` memo created inside `createFolio`'s
   closure. `Folio<Env>` additions in `src/server/types.ts:1110`; wiring in
   `src/server/index.tsx`; exports (`FolioEditor`, `FolioEditorUser`, `FolioEditorToken`,
   `FolioEditorOptions`, `HOST_PAGE_HEADERS`) from `folio/server`. `requireEditor`
   accepts `role` and `scope` and returns `{ editor, headers }` (the `page` option
   arrives in step 3). Tests: `test/unit/server/editor.test.ts`,
   `test/workers/host-editor.test.ts`, the trusted case in `auth-trusted.test.ts`. Add
   `HOST_PAGE_HEADERS` to `release.mjs` anchors for `dist/server.js`.
2. **`docs: document host routes behind folio's sign-in`**
   Handbook "Auth" subsection, `AGENTS.md` Rules line, `UPGRADING.md` heading "Host
   access to the editor session (v1.7.0)", and the undated `1.7.0` entry in
   `upgrade-ledger.json` holding that one heading (UPGRADING and ledger, above).
3. **`feat(server): validate admin.pages and serve them on /api/me`**
   `admin` on both config shapes (`types.ts`), `HOST_PAGE_ICONS`, `validateAdmin` called
   from `createRuntime` (including `brands` refused on `deployment` pages), `/me`
   `hostPages` with server-computed `allowed` (`routes/auth.ts:763`),
   `requireEditor({ page })` with decision 12's four checks, reading `folio_scope` or
   `x-folio-scope`. Tests: `test/unit/server/admin-config.test.ts`,
   `test/workers/host-pages.test.ts`, the page cases in `host-editor.test.ts`.
4. **`feat(host): add the folio/host helper and host page protocol`**
   `src/core/host-page.ts` (protocol, `screenHostFrame`), `src/host/index.ts`
   (`framed`, `announce`, `notice`, `connectHostPage` with scope carrying and
   `frameRedirectTarget`, `scope`, `scoped`); `package.json` `exports["./host"]`; the
   `build:js` entry; `release.mjs` anchors for `dist/host.js`. Tests:
   `test/unit/core/host-page.test.ts`, `test/unit/admin/render/host-helper.test.ts`.
5. **`feat(admin): build folio-host.css from the admin tokens`**
   `src/admin/host/host.css`; `scripts/build-admin.mjs` (prefix rewrite to `--folio-*`,
   semantic tier only); `src/vite/index.ts` emits `folio-host.css` at the build root in
   build and serves it in dev; `package.json` `exports["./host.css"]`. Tests:
   `test/unit/admin/built-css.test.ts`, `test/unit/vite/plugin.test.ts`.
6. **`feat(admin): frame host pages in the shell with nav and crumbs`**
   `ui/route.ts` (`host` screen at bare and scoped mounts, encoded segments, crumbs,
   title), `ui/nav.ts` (groups, `allowed` and scope filtering, bare-mount deployment
   pages, `activeItem`), `ui/icons.tsx` (seven new icons beside `window`), `src/admin/me.ts`
   (`hostPages`), new `ui/screens/host-page-model.ts` and `ui/screens/HostPage.tsx`
   (iframe, mirror, scope heal, popstate replace, promotion rules, refused-frame and
   left-the-admin notices, site chooser, message listener, overlay), the `Admin.tsx`
   case with `bare`, palette entries. Tests: `ui-route`, `ui-nav`, `me`,
   `host-page-model`.
7. **`feat(demo): add an orders host page to the demo`**
   `examples/demo`: `admin.pages` entry, `/admin/orders` and `/admin/orders/:id` routes
   gated by `requireEditor`, its `headers`, `folio-host.css`, `connectHostPage`, an
   in-memory order list. New `scripts/host-page-test.mjs` (picked up by
   `scripts/e2e-all.sh`).
8. **`docs: document host pages in the admin`**
   Handbook "Extending the admin" (host pages half, including scope carrying and the
   multi-site deep-link table), "Many sites" and "Many brands" notes,
   `docs/configuration.md` `admin.pages`, `AGENTS.md` "Your own admin screens",
   `CLAUDE.md` (export entries, the protocol invariant), `UPGRADING.md` heading "Host
   pages in the admin (v1.7.0)" and its ledger append.
9. **`feat(core): let a select take its options from a source`**
   `src/core/fields.ts` (type, builder overload, `ValueOf`, the `defaultValue` branch),
   `src/core/nested.ts` `fieldShapeError`; the manifest carries `optionsFrom` through
   `toManifest` unchanged. Tests: `test/unit/core/fields` and nested tests, the type
   test.
10. **`feat(server): register field-only option sources per brand`**
    `optionSources` on `FolioSingleConfig` and `FolioBrand`, `BRAND_KEYS`
    (`runtime.ts:706`), `BrandRuntime.fieldSources` (union, duplicate refusal;
    `forms.sources` untouched), `FolioOptionSource.lookup` in `validateSources`,
    `validateFieldSources`, `validateGate`'s refusal, `hostListsOf` taking the map,
    schema lists in `referencedLists` with the early return moved, prune keeping them.
    Tests: `test/unit/server/option-sources.test.ts`, `brands-config.test.ts`, the cron
    and forms-isolation cases in `test/workers/option-sources.test.ts` and
    `form-sources-admin.test.ts` (registry route, builder preview, `checkOptionSources`).
11. **`feat(api): check sourced select values on content api writes`**
    `errors.ts` (`unavailable`, 503, `FolioErrorStatus`), `writeDocument`'s `check`
    parameter (`write.ts:177`), `checkSourcedSets`, wired into PATCH fields, PUT content
    and POST create in `routes/api/documents.ts`. Tests:
    `test/workers/field-sources.test.ts` (write cases), `test/unit/server/write.test.ts`
    (the hook runs between `diff` and `commitAll` and a throw commits nothing),
    `test/workers/mcp.test.ts` (refusals through `patch_fields` and `write_content`).
12. **`feat(api): add the field options route and list_field_options`**
    `GET /api/v1/options/:block/:field` in `routes/api/`; `list_field_options` in
    `server/mcp/tools.ts` at `READ`, placed after `list_versions`; `api-partition` and
    `scope-partition` entries. **Every test that pins the tool set changes in this
    commit:** `test/unit/mcp/tools.test.ts` (`:113` title, `:118` count 19, the new
    tool's route), `test/unit/mcp/scopes.test.ts` (`READS`, `:45-52`),
    `test/workers/mcp.test.ts` (`READS`, `:250`, and the two `toHaveLength(18)` at `:580`
    and `:604`), plus `field-sources.test.ts` (the route). `scripts/mcp-test.mjs` was
    checked and is unaffected (Testing requirements).
13. **`feat(checks): report sourced values a list no longer offers`**
    `CheckContext.optionLists`, `option-not-offered`, `option-list-unavailable`,
    `field-shape` for sourced values, wiring in the check route. Tests: unit and
    workers `checks.test.ts`.
14. **`feat(admin): pick a sourced select value from its list`**
    Internal `GET /api/field-options` (with `story` and `lookup`),
    `ui/screens/fields/SourcedSelect.tsx` and `sourced-select-model.ts`, `Control.tsx:114`
    branching on `optionsFrom`, `QueryControls.tsx:123` reading the route for a sourced
    filter, `settings-model.ts:393` describing the source. Tests:
    `test/unit/admin/sourced-select-model.test.ts`, `field-sources.test.ts` (internal
    route, `lookup` bounds and timeout), `scope-partition` fence entry.
15. **`docs: document option sources on document fields`**
    Handbook "Options from a source" (the two registries and their exposure),
    "Data documents" (the block-list pattern for several products), "Content API",
    "An MCP server", "Not built yet"; `docs/configuration.md`; `docs/api.md`;
    `docs/mcp.md`; `CLAUDE.md` MCP count; `AGENTS.md` Limitations line; `UPGRADING.md`
    heading "Option sources on document fields (v1.7.0)" and its ledger append. Demo: a
    `product` field on a record type.
16. **`feat(server): add per-type linked-data panels and their route`**
    `panels` on `FolioSingleConfig` and `FolioBrand`, `BRAND_KEYS`, `validatePanels`,
    `src/core/panels.ts` (`screenPanel`), `GET /api/stories/:id/panel` (draft through
    `draftFor`, both-currency gate, `ctx.editor` from `editorOf(c.var.actor)`, timeout
    race), `Manifest.panels`. Tests: `test/unit/core/panels.test.ts`,
    `test/unit/server/panels-config.test.ts`, `test/workers/panels.test.ts`,
    `scope-partition` fence entry.
17. **`feat(admin): show a linked-data panel in the inspector`**
    `ui/screens/LinkedPanel.tsx` and `linked-panel-model.ts`, placement in
    `Inspector.tsx` before the Address block (`:255`), link rewrite to host pages.
    Tests: `test/unit/admin/linked-panel-model.test.ts`, a render test under
    `test/unit/admin/render/`.
18. **`docs: document linked-data panels`**
    Handbook "Extending the admin" (panels half), `docs/configuration.md` `panels`,
    `UPGRADING.md` heading "Linked-data panels (v1.7.0)" and its ledger append,
    `README.md` tour lines, spec 44 row in `docs/specs/README.md`. Demo: a `product`
    panel.
19. **`chore(release): prepare v1.7.0`**
    `package.json` `version` and `src/server/version.ts` `FOLIO_VERSION` to `1.7.0`, the
    `1.7.0` ledger entry's `date`, the `CHANGELOG.md` section, the UPGRADING rollback
    paragraph. Tests: `version.test.ts`, `cli/ledger.test.ts`. Tagging (`git tag -a
    v1.7.0` and the push) is the owner's act after the browser pass, per `CLAUDE.md`
    "Releasing", and is not part of this sequence.

**Rollback during the build.** Each step is a revertable commit; no step writes D1
schema or changes the wire, so reverting any of them needs no data repair. Reverting a
docs step also removes its ledger heading (they are one commit). Reverting step 2
requires reverting every later docs step, which append to the entry it creates.
Reverting step 10 after step 11 requires reverting 11 to 15 too (they read
`fieldSources`).

## Dependencies

- Spec 37 (form option sources): the store, the lease, the screens and `effectiveSettings`.
- Spec 23 and 34 (multi-site, multi-brand): scopes, `effectiveRole`, `rt.forScope`,
  `BRAND_KEYS`.
- Spec 28 and 29 (auth providers, passkeys): every provider ends in one session.
- Spec 40 (content checks): the check vocabulary and `CheckContext`.
- No Cloudflare resource, binding or `wrangler.jsonc` change.

## Out of scope

- **A React component plugin system, or host code in the admin bundle.** The admin ships
  prebuilt (`CLAUDE.md`); loading host components into it would put the host's React,
  CSS and bugs into every editor's session. The iframe is the boundary instead.
- **Host-defined field kinds.** `resolveValue` and `fieldShapeError` are exhaustive
  switches by design; a host kind would need render, storage, index, audit and check
  semantics. The sourced select covers "pick from the host's data".
- **Plural external picks** (a multi-value select with a source), by owner decision
  (2026-11-17). It needs a new stored shape (an array) through index projection, the
  nested shape and the checks. The supported pattern is a block list: a `blocks` slot
  allowing one block whose only field is the sourced select, which keeps the editor's
  order (decision 15). The handbook shows it.
- **Live search against the host** (a picker that queries the host as the editor types).
  It would call host code on every keystroke and make the write check depend on a live
  call. The list stays the 500-option cached list of spec 37, and the cap is not raised
  for fields (owner decision, 2026-11-17).
- **Panels in v1 or MCP**, and **panel HTML** (decision 21).
- **Host pages on live hosts or preview origins.** They live on the admin origin
  (decision 4).
- **An admin-to-host-page message** (theme, scope push). The scope is in the URL and the
  theme follows `prefers-color-scheme` on both sides, as the admin itself does today.

## Implementation notes

Built 2026-11-17 on `feat/admin-extensions` in the sequence's order, one commit per step (a `docs(spec)` commit
first, one `fix(admin)` commit for a content-list column overflow that was asked for beside it). No migration, no
wire change, no new binding; `PROTOCOL_VERSION` stays at 5. Ships as `v1.7.0`. **The iframe's joint history, the
`replaceState` mirror, the 15 s overlay, the login promotion and the look of `folio-host.css` need a browser and are
not yet checked**; their decisions are pure functions with unit tests, and the owner's pass on the demo is what
remains before tagging.

**Where the spec was wrong or ambiguous, and what was done.**

1. **`connectHostPage` needs the page's path for `frame: true`.** The spec's `page: { id, scope }` gives the helper no way
   to turn the location into the admin URL's remainder. `page` gains an optional `path` (`HostPage.path`); without it
   the redirect lands on the page root. `frameRedirectTarget` lives in `core/host-page.ts` (pure, shared) and is tested
   in `core/host-page.test.ts`.
2. **`requireEditor({ page })` precedence.** An explicit `scope` option wins over `folio_scope`, then `x-folio-scope`, and
   the stricter of `opts.role` and the page's `role` applies. A scope the registry does not serve answers the "Open
   this page from the admin, inside a site." `403`, found by asking the registry, because the role of an unserved scope
   is `null` and would otherwise read as a plain role refusal.
3. **Eight host page icons are new, not seven.** `window` was not in the nav's closed set of eleven.
4. **Switching scope on a `deployment` host page is a full page load** (a new mount is a navigation in this router), so
   the frame reloads. The spec's "reloads nothing in the frame" needs client-side scope switching, which the router
   does not have.
5. **The mirror uses the router's `replace`**, not a bare `history.replaceState`, so route state, the sidebar and `same()`
   stay in step. Comparing the computed `src` with the frame's location (`folio_scope` removed, paths canonicalised)
   is what stops it reloading the frame, and it runs on every `src` change rather than only on `popstate`. A repeated
   query key collapses to its last value in the admin URL, the router's own rule; the frame keeps its own.
6. **A group crumb with no link renders as plain text**, so the page keeps its one `h1`.
7. **The demo's Orders page speaks the protocol by hand** (an inline script): the demo Worker serves plain HTML and has no
   client bundle to import `folio/host` from. `connectHostPage` (scope carrying, `frame: true`) is covered by happy-dom
   tests and cannot be exercised on the demo.
8. **The write check also covers `insert`s.** `diff` turns a new blok into an `insert`, so a PUT or create that added a blok
   would bypass a check on `set`s alone. A create is checked as `diff(blank seed, seeded)` before the row is written. The
   refusal names `<block>.<field>`, not the payload path, because it runs on mutations.
9. **The options routes answer the source's `label`** (additive), because the admin names it in "No longer offered by
   Products" and the manifest carries ids only. The Model screen therefore says "from <source id>". The filterable list past
   20 options is a filter box above the native `<select>`, not a custom combobox. `lookup` runs under a fixed 3 s deadline.
10. **The field-options route's story fence is tested** with a sited Folio in `field-sources.test.ts`, and the panel route's in
    `panels.test.ts`, not as `scope-partition.test.ts` rows (that walk finds id routes by `:param` in the path and its
    config declares no panel). The panel route is in `FENCED_ELSEWHERE`; `GET /api/v1/options/:block/:field` is in
    `UNSCOPED_IDS` (it names a block and a field, not a row).
11. **`isPanelHref` restates `safeNext`'s rule in core**, because core cannot import `server/validate.ts`. A `panels` key
    naming a type nobody declared throws.
12. **`dist/admin/folio-host.css`** is built by `build-admin.mjs` beside the admin's files and emitted by the Vite plugin for
    the client environment whether or not the admin is built from source.
