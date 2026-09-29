# Feature: Many sites in one deployment

> **Group:** foundation
> **Build order:** 23, per docs/specs/README.md
> **Size:** XL
> **Status:** review — built on the branch `multi-site` (phases 1 to 9); release and staging verification pending, so not `done`
> **Wire version:** bumps PROTOCOL_VERSION to 5
> **Migration:** `0011_sites.sql` (the site registry, a site dimension on nine tables,
> grants, preview grants, every global unique index rebuilt with the site leading);
> `0012_users_role_contract.sql` one release later, dropping the two `users` columns
> 0011 retires (decision 18)
> **Last updated:** 2026-09-29

## Summary

One Worker, one D1, one R2, one admin, and many sites inside it: each with its own
hostnames, its own pages and records, its own editors, and a **shared scope** above
them that holds what every site inherits: default pages, a catalogue of shared
records, the base layer of every global. Between the two sits an optional **group**,
so a region can carry content and settings of its own and an editor can look after
the region rather than one site. Sites and groups are rows a platform admin creates
from the admin, and each site carries the settings a host declares for it — its
theme, its features, its contact details — layered the same way as every global.

**Folio has no site dimension at all today**, and the absence is a premise threaded
through the schema (`stories_path` is `unique (path)`,
`migrations/0001_init.sql:108`), the lookups (`storyByPath` is `where path = ?`,
`src/server/stories.ts:1040`), the roles (one `users.role`,
`migrations/0001_init.sql:248-251`), the Durable Object naming
(`SPACE_NAME = 'space'`, `src/server/space-events.ts:37`), the cookies (`__Host-`,
`src/server/auth/cookie.ts:18`), the preview bridge (same-origin only,
`src/admin/hooks/usePreviewBridge.ts:240`) and the cache tags (`SITE_TAG = 'site'`,
`src/core/cache-tags.ts:24`).

Two cases force it. **A retail property portfolio of about fifty sites**: one visual
design with per-site theme tokens and a small closed set of template variants, a
national team that owns default pages and a catalogue of national retailers, site
marketing managers who may touch only their own site, a central team that
administers everything, SSO groups mapped per site, publish-to-live under a minute,
and a front end that serves every hostname from one deployment and may read Folio
headlessly. The alternative on the table for it is roughly fifty-three separate CMS
instances, chosen only because the other product has no per-site roles. And **two
sibling brand sites** run by one agency on the same stack, where a second site
should not mean a second D1, a second R2, a second set of accounts and a second URL
to sign in to.

A deployment that configures no `sites` behaves exactly as it does today: one
implicit site called `default`, no shared scope, no registry to read, one role per
person, the same cache tags, the same URLs.

## Ground truth

Verified against the tree at `133bb7f`. Everything below is a place that assumes
exactly one site, or a constraint this design has to fit.

**Schema (`migrations/`).** Nine migrations, `0001`–`0008` and `0010`. **`0009` stays
a permanent gap.** It was this spec's claim, and a migration numbered below
`0010_forms.sql` cannot alter `forms` and `form_responses`, which this spec must:
wrangler and `test/workers/apply-schema.ts` (`compareMigrationFilenames`) apply by
numeric prefix, so on a fresh database it would run before the tables exist.
Renumbering `0010` would be editing a landed migration. So this spec takes the next
free numbers, `0011` and `0012`, and nothing will ever be numbered `0009`.

No table has a site column. The global unique constraints, every one of which becomes
wrong with two sites:

- `stories_path` — `unique (path) where path is not null` (`0001_init.sql:108`). Two
  sites cannot both have `about`, and only one can have a root (`path = ''`).
- `stories_parent_slug` — `unique (coalesce(parent_id, ''), slug) where path is not
  null` (`0001_init.sql:124`). Two sites' top-level pages both have a null parent.
- `stories_type_slug` — `unique (type, slug) where path is null` (`0001_init.sql:129`).
- `redirects.from_path` is the **primary key** (`0001_init.sql:215`). SQLite cannot
  change a primary key in place, so `redirects` is a rebuild.
- `asset_folders.path` is `text not null unique` (`0008_asset_organisation.sql:22`) and
  `asset_tags.slug` is `text not null unique` (`0008_asset_organisation.sql:38`) —
  **column constraints**, backed by `sqlite_autoindex_*` indexes that cannot be
  dropped, so both tables are rebuilds. `media-library.md` (Dependencies) asks this
  spec to scope them.
- `forms_name` — `unique (name)` (`0010_forms.sql:52`), a separate index.
  `forms.md` (Dependencies) asks this spec to scope `forms` and `form_responses`.
- **Two statements name those constraints as conflict targets**:
  `insert … on conflict (slug) do nothing` (`src/server/asset-tags.ts:170`) and
  `insert … on conflict (name) do nothing` (`src/server/forms.ts:642`). Re-keying the
  index without changing the statement is `ON CONFLICT clause does not match any
  PRIMARY KEY or UNIQUE constraint`. The `redirects` writes are `insert or replace`
  (`src/server/redirects.ts:145,341`); every other `on conflict` in `src/server`
  targets `id` (`stories.ts:1577`, `migrate.ts:397`, `auth/passkeys.ts:155`).
- `assets.key` is unique (`0001_init.sql:193`), correctly. `users.email` is unique
  (`0001_init.sql:243`), and that stays.
- `users.role` is `not null default 'editor' check (…)` (`0001_init.sql:248-251`);
  `users.role_from` was added by `0006_auth.sql:14`. `updateUser` writes `role` on
  every patch (`auth/users.ts:211`). `auth-providers.md` (Dependencies) asks this spec
  to carry `role_from` onto whatever replaces the role.
- **Nothing relies on foreign-key enforcement, deliberately.** `deleteUser` deletes
  sessions and passkeys explicitly "rather than left to the `on delete cascade` their
  columns declare" (`auth/users.ts:217-240`), `deleteStoryStatement` says the same
  (`stories.ts:1928-1935`), and `test/workers/auth-session.test.ts` asserts it with
  foreign keys off. Sessions end by plain `delete from sessions` at
  `auth/session.ts:148,225,294,303,308`, `auth/sign-in.ts:232` and `users.ts:236`.
- `content_index`, `content_refs`, `content_text`, `versions`, `schedules`, `shares`,
  `login_challenges` all hang off an id. `content_text`'s search join goes through
  `stories` (`src/server/query.ts:186`, `contentSql`).

**The root is special and has no creation path.** `createStory` slugifies the wanted
slug and `slugify('')` answers `'untitled'` (`src/core/story.ts:553-561`); roots come
from seeds (`examples/demo/seed.sql:15`). `deleteStoryStatement` refuses the root
(`stories.ts:1947`) and it cannot be reslugged (`stories.ts:1721-1722`). A top-level
page has a null parent (`stories.ts:1465-1556`). `derivePaths`
(`src/core/story.ts:488`) walks `parent_id`.

**Singleton ids are derived from the type name.** `singletonId(type)` is `sng_<type>`
(`src/core/schema.ts:170-174`), parsed in one place (`routes/api/documents.ts:155-156`),
which then calls `ensureSingleton` (`stories.ts:1558-1590`), which inserts the row
only. The draft is seeded by `seed()` (`src/server/runtime.ts:602-610`): the root's
`default` preset, every field default (`schema.ts:530`), the type label in the title.
Defaults are write-time only: nothing supplies them on read, and `required` is
declared-and-ignored across the field system (`src/core/fields.ts:158`). The v1
nested create writes every non-`blocks` default (`src/core/nested.ts:563-567`) and
refuses a non-array `blocks` value (`nested.ts:585-587`); `fromNested(input, schema,
base, opts)` (`nested.ts:287`) knows no document id, so any id-dependent rule has to
arrive in `opts` from its caller (`routes/api/documents.ts:350,407`). Story ids pass
`^[A-Za-z0-9_.:-]+$`, 64 characters at most (`src/server/validate.ts:58-64`). **Type
names are not charset-checked at construction**: `validateTypes` (`schema.ts:294-340`)
checks presence and uniqueness only.

**Globals are loaded by derived id into every resolution.** `FolioConfig.globals` is
`readonly string[]` (`src/server/types.ts:679`); `resolve()` maps each to
`singletonId` (`runtime.ts:707`), reads drafts with `ensureSingleton` in draft mode
(`runtime.ts:756-769`) and published docs by id otherwise (`runtime.ts:771-800`),
dropping a global with nothing published. `cacheTags` tags only the globals present
(`cache-tags.ts:172`).

**Lookups take a path and nothing else.** `storyByPath` (`stories.ts:1040`),
`storyStatus` (`:1064`), `pathMiss` (`:1104`), `pageAt` (`:1145`), `publishedDoc`
(`:1161`) are `where path = ?`. `storiesFor` (`:213`) and `publishedDocsByIds`
(`:1181`) take ids with no scope, so **a reference on one site to another site's story
id would resolve today**. `resolve()`'s breadcrumb ancestors are fetched by path
(`ancestorPaths`, `src/core/story.ts:442`).

**The render path.** `folio.reader(env, req)` (`src/server/index.tsx:466`), whose
`page()` does one `pageAt` read and decides draft authority, gate access and cache
headers (`index.tsx:640-700`, headers by `cacheHeaders(resolution, { story })` at
`:700`). `handle()` answers `{base}/*` through the Hono app and the
`?_folio=preview|draft` branch itself (`index.tsx:318-452`). The one-shot methods
delegate to a throwaway reader (`index.tsx:742-788`). `folio.cacheTags` and
`folio.cacheHeaders` are the raw core functions (`index.tsx:852-853`), also exported
from `folio/core` (`src/core/index.ts:22-23`), and the documented host pattern is
`folio.cacheHeaders(resolution, { story: story.id })` (`types.ts:965,1037`).

**`createFolio`'s keys are all singular**: `blocks`, `root`, `types`, `bindings`,
`auth`, `basePath`, `route`, `locales`, `adminCss`, `previewCss`, `previewWrap`,
`assets`, `hooks`, `logger`, `gate`, `describe`, `forms`, `globals`, `migrations`,
`mcp`, `draftMode` (`types.ts:502-730`). `route?: (path, locale?) => string`
(`types.ts:565`) and same-origin preview is a hard requirement (`types.ts:545-553`).

**Roles are global and single-valued.** `ROLES` (`auth/roles.ts:13`), seven token
scopes (`roles.ts:43-51`), `allows(actor, access)` is role-or-scope with no resource
(`roles.ts:231-236`) — **a token passes by its scopes alone** — enforced by
`requireAccess` (`src/server/middleware.ts:120-137`) and `ensureAccess`
(`middleware.ts:146`). `ADMIN` gates deployment-wide acts (users, tokens, auth events,
reindex, migrate, audit, bulk describe) and content acts (deleting a form, its
responses, the CSV) (`routes/access.ts:66-70`, `routes/forms.ts:248,349,398,421`,
`routes/content.ts:189`, `routes/migrations.ts:56,105`, `routes/assets.ts:536`).
`POST /api/tokens` mints the scopes the body names (`routes/access.ts:309-318`).
`readSession` reads the role in one `sessions join users` statement
(`auth/session.ts:129-190`). `RoleMapper` is `(identity) => Role | null`
(`auth/config.ts:50`); `roleFromClaim` picks the highest match
(`auth/roles-from.ts:58-106`); `completeSignIn` owns the interaction table
(`auth/sign-in.ts:79`).

**Credentials are stored hashes; there is no signing secret** (`auth/secrets.ts:1-10`).
`safeNext` screens every redirect target (`validate.ts:804`, `routes/draft.ts:50,71`).

**D1 sessions.** Every read runs on a session; the default is `first-unconstrained`
(`db.ts:52`), which may be a lagging replica; `first-primary` is the write
constraint (`db.ts:117`).

**The cookies are bound to one origin.** `__Host-folio_session` (`auth/cookie.ts:18`),
`_oidc` (`:25`), `_share` (`:37`), `_draft` (`:52`), `_webauthn` (`:271`); plain on
`http:` (`cookie.ts:61-84`); `SameSite=Lax`. The draft cookie is a bare `1` whose
authority is the session beside it (`cookie.ts:40-51`).

**Preview is same-origin on both ends** (`usePreviewBridge.ts:201,240,258`,
`src/preview/mount.tsx:36-41,61`). A share link is built from the admin request's URL
(`routes/preview.ts:138`) and redeemed on whatever origin serves it
(`routes/preview.ts:235-300`). MCP's `preview_document` passes the caller's
`authorization`/`cookie` as `setExtraHTTPHeaders` (`src/server/mcp/shot.ts:125,178`).

**MCP dispatches inside the app**: `app.fetch(...)` (`routes/mcp.ts:225`), copying only
`authorization`/`cookie` (`:157-165`), behind a `${rt.base}/api/v1/` guard (`:194`).

**v1 answers documents, not pages.** No route under `src/server/routes/api/` resolves a
document or emits a tag; hook payloads carry the subject, not the tags purged
(`src/server/hooks.ts:61-205`).

**Passkeys take `rpId` from the request host** (`routes/passkeys.ts:86-87,259`).

**The space channel is a singleton** (`runtime.ts:618`, `space-events.ts:74`). The
story socket copies the actor's `role` into the attachment (`routes/editor.ts:88`),
and the object refuses a viewer's `tx` (`src/server/story-do.ts:642`).

**`PROTOCOL_VERSION = 4`** (`src/core/protocol.ts:39`). No delete-key mutation
(`src/core/mutations.ts:7-36`); in `i18n` a `null` means "untranslated, fall back"
(`src/core/doc.ts:28-38`).

**Cache.** `cacheTags` adds the bare `site` tag and `type:<name>` per collection
(`cache-tags.ts:167-205`); publish purges `story:`, `type:`, `type:*`, and
`global:<name>` for a global (`src/server/cache-purge.ts:139-142`); the purger is
built at `runtime.ts:956`; reindex `purgeEverything` (`cache-purge.ts:284-302`);
100 tags per call (`cache-purge.ts:45`). **The Workers Cache key is path, entrypoint,
`ctx.props` and version, "not by hostname"** (developers.cloudflare.com/workers/cache/).
`cacheVerdictFor` bypasses a request carrying the session, draft or share cookie
(`src/server/cache-request.ts:131`).

**In-process entry points take no `Request`**: `folio.write`, `draft`, `query`,
`stories`, `tree`, `global`, `reindex`, `runSchedules`, `sweepAuth`, `migrate`,
`audit` (`types.ts:806-1120`).

**The admin threads one `apiBase`** (`src/admin/ui/Admin.tsx:335`) into roughly eighty
`fetch` call sites.

**Tests and seeds that pin what this spec moves.** `migrations.test.ts` pins every
`stories` column in order, the `stories_edited` expression index, and the `users.role`
check (`:534-536`); `read-session.test.ts` counts statements; `api-partition.test.ts`
pins `/api` versus `/api/v1`. Seeds inserting `users (…, role, …)`:
`examples/demo/seed.sql:28`, `examples/starter/seed.sql:29`,
`test/workers/pagination.test.ts:568`, `migrations.test.ts:527-536,666`; bootstrap SQL
of that shape in `docs/configuration.md` and `docs/handbook.md`.

## Owner decision checkpoints

All five are settled by the owner (2026-09-29) and written below as decisions.

1. **Shared pages fall back, and overriding is a fork** — decision 5.
2. **Globals layer per field**, shared → group → site; objects merge, arrays replace,
   `null` removes; the editor shows each field as inherited or overridden — decision 8.
3. **Groups are in the first version** — decisions 3, 6 and 10.
4. **The spec stays generic**, here and in every file this spec causes to change.
5. **Sites and groups live in D1 and are managed from the admin**, and implementors
   can declare extra site-level fields that admins set per site — decisions 1 and 2.

## User stories

### A platform admin launches a site
**As** a platform admin **I want to** create a site in the admin — name, group,
hostnames, preview host, status — fill in its settings, preview it while it is a
draft, and move it to preview and then live **so that** a new site needs no deploy.

### A site gets its own look
**As** a platform admin or a site's admin **I want to** set the site's theme colours,
font set, radius, template variant, logo and feature flags on its settings screen,
seeing which values it inherits **so that** the site looks like itself while
everything I do not set follows the defaults.

### A site manager edits only their own site
**As** a marketing manager for one site **I want to** edit and publish its pages,
stores and events, and fork a default page my site inherits, without being able to
change any other site or the shared content.

### A regional editor looks after a group
**As** an editor with a role on a group **I want to** edit the group's sites and the
group itself, and publish a campaign once, to the region.

### The national team owns shared content, and sees it on every site
**As** a member of the national team **I want to** edit the default pages, the
retailer catalogue and the base layer of every global, and **preview my drafts
rendered on any site that inherits them** **so that** I can see what fifty sites will
show before I publish — without being able to edit any site or administer accounts.

### SSO decides who can edit where
**As** the operator **I want** directory groups to map to a role on a site, a group or
the shared scope, the highest role per scope to win, a group for another site to grant
nothing here, and no match to refuse sign-in.

### Preview on the site's own origin
**As** an editor **I want** the preview pane, a draft-mode tab and a share link to
render on my site's preview host, although the admin lives on one central origin.

### A headless front end serves every site
**As** the developer of a separate front end serving every hostname **I want to** map
a request's host to a site and its status with a read-only token, ask for the page the
site serves at a path with its cache tags, and be told what to purge when something
publishes **so that** I meet publish-to-live under a minute without reimplementing
Folio's rules or holding an admin credential.

### A visitor only ever sees one site
`alpha.example/about` and `bravo.example/about` are different documents, and a link,
reference, collection or search on one site never resolves to another site's content.

### Upstream master data syncs in
**As** an integrator **I want** a token bound to the shared scope to upsert the
retailer catalogue, and a token bound to each site to upsert its tenancies.

### A single-site host changes nothing
**As** an existing host **I want** to upgrade without touching my config.

## Architecture decisions

### 1. Sites and groups are a registry in D1, managed by platform admins

`sites` holds one row per site and per group: `id`, `kind` (`site` | `group`), `name`,
`group_id`, `status` (`draft` | `preview` | `live`, sites only) and `preview_origin`
(sites only). `site_hosts` maps each live hostname to one site, the hostname the
primary key. A platform admin creates, edits and deletes both from the **Sites**
screen through platform-tier routes (decision 10). No deploy adds a site; routing a
new hostname to the Worker is still Cloudflare's act.

**Config says only what must exist before the first row:**

```ts
createFolio({
  sites: {
    admin: 'https://cms.example',   // the one origin of the admin, sign-in and passkeys
    settings: 'siteSettings',       // the singleton type holding site-level fields (decision 2)
    resolve?: (req, registry) => string | null,   // chooses a candidate; Folio still gates it
  },
})
```

The presence of `sites` turns multi-site on. The admin origin is config because a
person must sign in to create the first site, and passkeys bind to it (decision 12).

**Who may do what.** Creating and deleting sites and groups, hostnames, preview
origin, group membership and status are platform admin. A site's own admins may edit
its **settings** (content, decision 2) but not its registry row.

**Deleting** a site or group is refused while any content row (`stories`, `assets`,
`asset_folders`, `asset_tags`, `forms`, `redirects`) or site in it exists. Its grants
are not a reason to refuse: the delete removes every `site_roles` row on the scope in
the same batch, whoever set it, so a retired site never waits on fifty people signing
in again. A later sign-in whose mapper still names the scope drops that entry
(decision 17).

**Validated on write.** An id matching `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`,
unique across sites and groups, not `shared`, `default` (except the migration's own
row) or `*`, immutable once written. A group that exists. `preview_origin` is stored
as `new URL(x).origin` — lowercase, default port removed — and must be `https:` (or
`http:` on `localhost` / `*.localhost`). Hostnames are stored lowercased without
port. **Every hostname is unique across both columns**: no live host may equal
another site's live host, any site's preview-origin host, or the admin origin's host,
and no preview-origin host may equal any live host, another preview-origin host, or
the admin origin's host.
The host's `route('', undefined, site)` must answer an absolute URL.

**The migration inserts the `default` site's row** (`live`, no hosts, no preview
origin), so an existing deployment that turns multi-site on finds its content under a
site it can give hostnames to.

**Beat sites declared in `createFolio`** (this spec's first draft): a site and every
status change would be a deploy, which the portfolio's central team should not need a
developer for fifty times. **Beat one deployment per site**: fifty-three `users`
tables and fifty-three sets of tokens is what the portfolio case is escaping.

### 2. Site-level fields are a layered settings document, not columns on the site row

`sites.settings` names a **singleton document type** the host declares like any
other; its root block's fields are the site-level fields — a theme block with colour,
font set, radius and template-variant fields, a features block of booleans, a logo,
contact details, opening hours, integration ids, navigation. That type is **always
loaded as a global** and **layers as every global does** (decision 8): the shared
layer holds the portfolio defaults, a group layer the region's, the site's layer what
is particular to it. The Sites screen's **Settings** tab edits the selected scope's
layer with the inherited / overridden / removed labels. It has a draft, a preview, a
publish, a history and an activity trail because it is a document.

**How a host reads it.** At render time it is `resolution.globals[settingsType]`,
merged for the rendering site; `folio.settings(resolution)` answers the merged root as
a plain nested value (`toNested`'s shape: a `max: 1` blocks field as an object, a
blocks field as an array), or `null` with no settings type. `resolution.site` carries
the registry fields. A headless front end gets both from the page route (decision 16).
`folio.audit` gains a per-site check that the merged settings satisfy every `required`
field — the only place `required` is read, as a report, since a layer on its own is
partial by design.

**How a change is cached and purged.** As a global (decision 15): the shared layer
purges `global:<type>`, a group layer `global:<type>@<group>`, a site layer
`global:<type>@<site>`. A registry edit — name, group, status, hostnames — purges
`site:<id>` for each site it touches.

**Beat a typed schema on the site row** (a JSON column validated by a host-declared
schema): a second field language beside the block schema, with no drafts, preview,
history, per-field inheritance or translation — and site-level fields are exactly the
shape that wants all five.

### 3. Content is owned by exactly one scope, and reads walk a chain

Every `stories`, `assets`, `asset_folders`, `asset_tags`, `forms` and `redirects` row
carries `site_id`, the one scope that owns it: a site, a group, or the reserved
**`shared`**. **`default`** is the implicit site of a deployment with no `sites` and the
scope every existing row is backfilled into; **`*`** is never a content scope, only
"every scope" in a grant. The **chain**, nearest first:

| Scope | Chain |
| --- | --- |
| site `alpha` in group `north` | `alpha`, `north`, `shared` |
| site `bravo`, no group | `bravo`, `shared` |
| group `north` | `north`, `shared` |
| `shared` | `shared` |
| `default` (no `sites`) | `default` |

`chain()` and `sitesUnder()` (a site → itself; a group → its sites; `shared` → every
site) live in `src/core/sites.ts`, pure, over the registry snapshot. One group per
site, one level of groups.

**References, links, collections, search, forms and assets resolve only within the
chain of the scope being rendered.** Every id-set read in `resolve()` takes the chain
and adds `site_id in (…)`; the pickers offer only the chain. An id outside the chain
resolves exactly like a deleted one.

**Beat a fence with no hierarchy**: it cannot express default pages or a shared
catalogue. **Beat cross-site references between siblings**: a page a site editor
publishes would depend on content they cannot see.

### 4. A request maps to a site through a cached registry snapshot, then a status gate

Each isolate holds the registry (`sites` plus `site_hosts`, one batched read on a
**`first-primary`** session, so a lagging replica can never hand an isolate a registry
older than the last write) for **10 seconds**, refreshed lazily by the first request
after expiry. The isolate that writes a change drops its snapshot at once. **Beat a
read per request**: a round trip before every page read. **Beat a version row read
per request**: the same round trip under another name.

A registry edit purges `site:<id>` twice: immediately, and again **25 seconds** later
under the request's `waitUntil` — past any other isolate's 10-second snapshot and any
render that began inside it, inside `waitUntil`'s limit — so a stale isolate that
re-rendered a page into the cache in the window cannot leave it there for a week.

**Two steps, and only the first is replaceable.**

0. **The admin origin comes first.** A request on `sites.admin` is the admin's before
   any candidate is considered, so no registry row — whatever validation it slipped
   past, or a later change to `sites.admin` — can take the admin, sign-in or the
   registry routes offline.
1. **Candidate.** The default picks, from `new URL(req.url)`: the site whose live host
   it is (surface `live`), or the site whose preview origin it is (surface
   `preview`), or none. `sites.resolve(req, registry)` replaces this step only.
2. **Gate, always Folio's.** A candidate that is not a `kind = 'site'` row is no site.
   Then:

| Surface | `draft` | `preview` | `live` |
| --- | --- | --- | --- |
| `live` host | no site | no site | the site |
| `preview` origin | the site **only** for `{base}/site/enter`, `{base}/draft/enter`, `{base}/draft/exit`, `{base}/share`, `{base}/asset/:key`, a request whose grant cookie verifies for this site, or a request whose share cookie verifies for a story this site serves | the site | the site |

"No site" is never `default` or any other site: `handle()` returns `null` so the
host's routing answers (its 404), and a reader answers as a site with no content. So
**an unregistered hostname, the live hostnames of a site not yet live, and a draft
site's preview origin without a grant or share are all the host's 404.** A share on
a draft site is how a stakeholder sees a pre-launch page: its cookie admits the
request, and the share rule still limits it to its one story. The grant check is a
D1 read and happens in `handle()` / the reader after the synchronous candidate step,
never in the resolver. `handle()` passes the gated site and surface to the app in an
internal request header it first deletes from every inbound request.

**Where status is enforced, exactly.** Status governs **serving**: `handle()`, the
reader, `folio.cacheProps`, and v1's page-shaped reads (`GET /pages/…` and
`GET /documents/by-path/…`, decision 16). It does not govern the content API's
document reads for a credentialed caller (`GET /documents/:id`, queries, search):
those are a script reading content it holds a token for, whatever the site's launch
state, exactly as it can read a draft today.

### 5. Pages fall back to the nearest scope that has one; overriding is a fork

A site serves, at each path, by walking its chain nearest first:

1. the scope's story at the path, if **live** → it serves;
2. if **unpublished** (was live, deliberately taken down) → `gone` on this site, which
   is how a site suppresses an inherited page;
3. otherwise (a draft, or no row) the scope's **redirect** at the path → it redirects;
4. otherwise the next scope.

A site's own redirect therefore beats an inherited page, and a fork being prepared
does not blank the page visitors see. **Draft mode and preview choose differently**:
an authorised viewer sees the first row in chain order whatever its state, across
the whole chain (decision 13). `pageAt`, `storyByPath`, `storyStatus`, `pathMiss` and `publishedDoc` become
`…(db, chain, path)`: one `db.batch` of the stories rows (`where path = ? and site_id
in (…)`) and the redirect rows; the pick is in TypeScript (`pickServing` /
`pickEditing` in `src/server/stories.ts`), so a render costs today's round trips.

**Breadcrumb ancestors follow the same rule**: pass one fetches them across the chain
and keeps, per path, the row `pickServing` would serve.

**Overriding is a fork**: `POST {base}/~<site>/api/stories/:id/fork` copies a routed
story owned higher in the chain into the site, same slug, under the site's own story
at the parent path, as a draft, taking the source's published document (or its draft
when nothing is published) with fresh uids, and recording `stories.forked_from`.
Publishing the fork shadows the source; unpublishing suppresses the path; deleting it
falls back. Creating a page by hand at an inherited path is the same override.

**A fork needs the parent path to be the site's own, or to be top level**; forking
`info/parking` into a site that inherits `info` is refused with "fork Info first".

**The root.** A scope has at most one root (`path = ''`). `default`'s is the seeded
one. A scope gets one only by **Create home page** or by forking an inherited root:
`createStory` gains `root: true`, writing `slug = ''`, `path = ''`, `parent_id =
null`, refused when the scope already has one. `deleteStoryStatement`'s root refusal
(`stories.ts:1947`) becomes: **refused when no scope above it in the chain has a
root, evaluated at delete time** — so `shared`'s and `default`'s roots are never
deletable, and a site's or group's root is deletable exactly when something above
would replace it. The reslug refusal stays.

**Later edits to the shared page do not reach a fork** — the owner's accepted cost.
A fork whose source has been published since the fork was created reads "the shared
version has changed since you forked it", with a link.

**Beat patch-by-block-id inheritance**: a shared edit that deletes or retypes a block
would orphan every site's patch silently. **Beat a site page under a shared parent**:
renaming one shared section would rewrite paths on fifty sites at once.

### 6. Collections, search and the served set dedupe by the same walk

A `collection` on `alpha` queries `site_id in ('alpha', 'north', 'shared')`, and a
routed row is dropped when a nearer scope has, at the same path, **a non-draft story
or a redirect** — decision 5's walk in `contentSql` as a `not exists` over `stories`
and `redirects` in the nearer scopes. Records never shadow. Search is the same
predicate with the FTS join on top. `reader.stories()` (the sitemap) answers the same
served set, so a sitemap never advertises a URL that redirects on that site;
`reader.tree()` builds it into a tree by path.

Targeting a campaign at a subset of sites, or hiding an inherited record on one site,
is a host field and a `where`.

### 7. One block registry and one set of document types

`blocks` and `types` stay single values, reversing the first draft's per-site maps: a
shared page renders on every site in its chain, so every site must render every block
it holds. Variation is a site setting (decision 2). `validateTypes` gains the
`^[A-Za-z0-9_-]+$` check, the same charset `validate.ts:72-78` already requires of a
type named in a request, so no type a host can use today is newly refused and none can
be named `promo:north`.

### 8. Globals layer per field: shared, then group, then site

Each singleton in `FolioConfig.globals`, and the settings type, has one **layer
document per scope**: `sng_<type>:shared`, `sng_<type>:<group>`, `sng_<type>:<site>`,
and `sng_<type>` for `default`, so every existing singleton id is untouched.
`resolve()` loads the chain's layers in the statements that load globals today and
merges them, most general first, into `Resolution.globals[name]`. With no `sites` the
chain is `['default']` and the result is byte-identical.

**The merge, per field of the layer's root blok** (`mergeLayers`, `src/core/layers.ts`):

| In the more specific layer | Result |
| --- | --- |
| key absent from `data` and, for a `blocks` field, no children in the slot | **inherited** |
| `null` in `data` | **removed** |
| a `max: 1` blocks field whose child has the inherited child's type | **object**: merged recursively |
| a `max: 1` blocks field whose child has a different type | **replaced** by that child |
| a many-blocks field with children | **array**: replaces the inherited children |
| any other value | **replaced** |

A block is the object, a slot of many blocks the array, a field value a value. **Beat
merging JSON field values structurally**: a link merged over a link is a value nobody
wrote.

**Translations keep their meaning.** In a layer's `i18n`, an absent key inherits the
layer below for that locale; `null` keeps today's meaning — untranslated, fall back to
the merged source value — and never means removed. *Remove* exists only for source
`data`.

**Inheriting needs a delete-key**: `{ t: 'unset'; uid; field; locale? }`; `invert` of a
`set` on an absent key is an `unset`, and of an `unset` the `set` it undid. **Beat a
sentinel** such as `{ $inherit: true }`: data every reader would have to know is not
data.

**A preview never writes a layer into existence.** On a multi-site deployment,
draft-mode `resolve()` reads each layer's row and draft without `ensureSingleton`: a
layer with no row reads as absent, so every field is inherited from below, and no
`stories` row or Durable Object is created by rendering. A layer row is created only
by an editor's first write — opening it in the admin, or a v1 create — which is also
what keeps a draft site that was previewed but never edited deletable (decision 1).
Single-site draft mode keeps today's `ensureSingleton`, unchanged.

**Only a layer with something below it starts empty.** When a **site or group** layer
is created it is seeded with a bare root (`data: {}`, no preset, no title) in `seed()`
and in `ensureSingleton`; a root seeded with defaults would override every inherited
field.
The **`shared`** layer and `default`'s `sng_<type>` are the bottom of their chains and
seed exactly as today, defaults and preset included — so a host's declared defaults
are what every site inherits, and single-site globals are unchanged. The test is the
chain, not the id: `layerSeed(scope)` answers `'bare'` only when `chain(scope)` has a
scope below it. The v1 nested shape follows the same rule: `fromNested` receives
`opts.layer = 'bare'` from `routes/api/documents.ts` for such a layer, writes no
defaults, treats an absent key as inherited and `null` as removed, and accepts `null`
for a `blocks` field only then.

**The editor.** In a site or group scope, a global (or the Settings tab) edits that
scope's layer, labelled **Inherited from Shared** / **Inherited from North**,
**Overridden here** or **Removed here**. *Override* writes the inherited value; for a
`max: 1` blocks field it inserts a child of the inherited child's type with empty
`data`, so its fields stay inherited one by one; for a many-blocks field it copies the
inherited children with fresh uids. *Reset to inherited* is `unset` (and removes the
layer's children in a slot). *Remove* is `set` to `null`. `layerStates()` computes the
labels. In the shared scope a global is an ordinary document.

### 9. Records, and singletons not in `globals`, do not layer

A store record merged over a national retailer record is a `reference` the host's
block reads both ends of. Folding it into Folio would put a second inheritance
mechanism beside references for one case.

### 10. Three tiers of permission, stored as grants

`site_roles (user_id, scope_id, role, role_from)` replaces `users.role`:

| `scope_id` | Tier | Grants |
| --- | --- | --- |
| a site id | site role | the role on the site's own content |
| a group id | site role, group-scoped | the role on the group's content and every site in it |
| `shared` | shared-content role | the role on shared content |
| `*` | platform | the role everywhere; `*` + `admin` is **platform admin** |

A user's **effective role on scope X** is the highest of their grants on X, on `*`,
and (for a site) on its group. **Reads flow up the chain; writes never do**: a role on
a site implies `viewer` on its chain. Nothing flows down for editing. **Previewing is
the one exception, and it is read-only** (decision 13): anyone holding `READ_DRAFT` on
any scope in a site's chain may preview that site, whole-chain drafts included.

**Platform-tier routes** — the registry, users, tokens, auth events, reindex, migrate,
audit, bulk describe — require `*` + `admin` for a person, and for a token the `admin`
scope **and** `site_id` null. A bound token is refused by every platform route and can
never be minted with the `admin` scope. The site tier keeps the other `ADMIN` uses at
`admin` on the form's scope. `Access` gains `tier: 'platform' | 'scope'`.

With no `sites`, every user has one grant, on `*` — today's role one table over — and
`allows()` answers what it answers today.

**Beat roles on the user row plus a membership table**: two places a role lives.

**How a request gets its role.** `withActor` resolves the credential, then puts the
effective role on the request's scope (decision 11) on `UserActor.role`, so `allows()`
and every mount keep their shape. Grants that do not reach the scope are a 403 naming
it — **except on the routes marked `reach: 'preview'`**, which are `site/start` and
nothing else: there `withScope` admits a caller who may preview the site (decision 13)
with no effective role on it, and the route checks preview eligibility itself, so a
shared-only or group-only role is never refused at the start of a preview.
`scope-partition.test.ts` asserts that exemption list exactly. `/me`'s `previewable`
is unscoped and needs no exemption. `readSession` reads grants in the same statement as the session (a correlated
`json_group_array`), so the statement count does not move.

**Row checks make the scope a fence.** Every loader that turns an id into a row
answers 404 for a row not in the request's scope (a write) or chain (a read). The v1
singleton branch checks a parsed layer id's scope is in the chain **before**
`ensureSingleton`, and for a `GrantActor` never calls it: a missing layer answers the
merged view with no row created, because a preview never writes (decision 8). `test/workers/scope-partition.test.ts` walks every mounted route.

**Sockets carry the scope's role**: the story socket takes the effective role on the
story's scope (`routes/editor.ts:88`), so a site editor on a shared page is a viewer.

**Grants naming a scope that no longer exists** are ignored and listed on the Access
screen; the registry delete removes them in the same batch in any case (decision 1).

### 11. The scope is a path segment: `{base}/~<scope>/…`

`{base}/~alpha/edit/:id`, `{base}/~alpha/api/stories`, `{base}/~shared/api/v1/documents`,
`{base}/~north/mcp`, `{base}/~alpha/api/space/socket`. `handle()` strips the segment
and passes the scope in an internal header it first deletes from every inbound request
(`withIdentity`'s discipline, `auth/identity.ts:79`); `withScope` reads it into
`c.var.scope`. One mechanism covers the admin (`apiBase` becomes `{base}/~<scope>/api`),
a WebSocket, an MCP client, a v1 script and a pasted link.

**MCP dispatch sets the header itself**: it calls `app.fetch` below `handle()`
(`routes/mcp.ts:225`), keeps its unscoped `{base}/api/v1/…` URL and guard
(`routes/mcp.ts:194`), and sets the internal scope header from its own `c.var.scope`,
which came from `handle()` or the token's binding, never from a client.

**A scoped route with no scope on a multi-site deployment is `400 site_required`.**
Unscoped routes (sign-in, `/api/me`, passkeys, sessions, the registry, users, tokens,
auth events, reindex, migrate, audit, `/api/schema`, v1 `sites/resolve`) ignore it.
With no `sites`, a `~` segment is a 404.

**A bound token** supplies its scope when the URL has none; another scope is a 403
except a read up the binding's chain. **A group-bound token** writes the group's
content and every site in it, as a group grant does.

### 12. The admin, sign-in and passkeys live on one origin

`sites.admin` is the one origin answering the admin, its API, sign-in, OIDC callbacks,
passkeys, the registry and MCP. On a site's **live** hosts `handle()` answers only
`{base}/asset/:key` and `{base}/f/:id`. On its **preview origin** it answers those,
`{base}/share`, `{base}/site/enter`, `{base}/draft/enter|exit`, the `?_folio=` branch,
and `GET {base}/~<site>/api/v1/*` for that site (reads). Everything else is `null`.
`rpId` is always the admin host. **Beat a cross-domain session**: `__Host-` forbids
`Domain`, and fifty registrable domains cannot share a cookie.

### 13. Drafts reach a preview origin through a one-time, site-bound handoff

In a multi-site deployment **drafts are served only on a site's preview origin**. The
preview origin must route `{base}/*` and `_folio=` requests to Folio (in-process
`folio.handle()`, or a service binding from a separate front end).

**Who may preview, and what they see** (owner, 2026-09-29). A person may preview
site S when their grants give `READ_DRAFT` on **any scope in S's chain** — S, its
group, `shared`, or `*`. **Anyone allowed to preview a site sees the whole chain's
drafts**: the site's own, its group's and the shared scope's, so the page shows the
site as it would look with everything published. The national team previewing a
shared draft on `alpha` therefore also sees `alpha`'s drafts; a regional editor sees
the group's sites exactly as their own editors do. **Preview is read-only**: a grant
confers no write anywhere, reaches no admin route and no socket, and previewing a site
is not a role on it.

**Beat scoping every draft load by owner** (this spec's third draft: a grant carried
the nearest scope its holder's role reached, and drafts were shown only for rows owned
at or above it). Every draft read in `resolve()` — references, collections, forms,
every layer of every global — would have needed the scope threaded through, a miss in
any one of them leaked a site's drafts to a shared-only previewer, and the page it
produced was one nobody would ever see live: shared drafts over a site's published
state. The whole-chain preview is what will ship, and it needs no scope anywhere.

**The trace, for a site in any status:**

1. **Admin origin.** `GET {base}/~<site>/site/start?next=<path>`: `handle()` strips
   `~<site>`, the app's `withActor` resolves the session (the route is
   `reach: 'preview'`, decision 10), and the route checks preview eligibility (403
   when the caller holds `READ_DRAFT` on no scope in the chain); screens `next` with
   `safeNext` (a path, never an origin); inserts a `site_grants` row (`session_id`,
   `site_id`, `code_hash`, 60-second `expires_at`); 302s to
   `<preview_origin>{base}/site/enter?code=…&next=…`.
2. **Preview origin, `site/enter`.** `handle()`'s candidate step answers the site from
   the host; the gate admits `{base}/site/enter` in every status (the code is its
   credential); the app route consumes the code in one statement —
   `update site_grants set code_hash = null, token_hash = ?, expires_at = ? where
   code_hash = ? and site_id = ? and expires_at > ? returning session_id, token_id` — so
   two redemptions cannot both win; sets `__Host-folio_grant` (`folio_grant` on
   `http:`) with `Secure; HttpOnly; SameSite=None; Partitioned; Path=/`, expiring with
   the grant (the earlier of 24 hours and the session's expiry); 302s to itself with
   `check=1`. `Referrer-Policy: no-referrer`.
3. **Preview origin, `check=1`.** The gate admits it (a grant cookie that verifies,
   or `site/enter`'s own path); if the cookie arrived it 302s to `next`, otherwise it
   renders "your browser refused the preview cookie" and, in an iframe, posts
   `grant-blocked` to the admin.
4. **Preview origin, the page.** `handle()` reads the grant; for a `draft` site the
   gate admits the request only now. `credentialOf` carries the grant; `resolveActor`
   answers a **`GrantActor`**; `allows()` grants it `READ` and `READ_DRAFT` on the
   site's chain and nothing else. The `?_folio=preview` branch renders; a host's own
   route calling `reader.page()` gets the chain's drafts by `pickEditing`.

**A grant is re-checked against current roles on every read.** `readGrant` is one
statement that requires, beside the grant row: its session live and unexpired (or its
token unrevoked, for a token grant), **and** a current `site_roles` row for the holder
whose scope is `*` or in the site's chain and whose role gives `READ_DRAFT` (for a
token grant, the token's binding still reaching the site and its scopes still holding
`content:read:draft`). So signing out, being removed, having a grant edited on the
Access screen, or losing it to an SSO change ends every preview it admitted on the
next request, with no revocation step to remember and whether or not foreign keys are
enforced. **Beat deleting preview grants on every role change**: four writers change
roles (the Access screen, SSO sign-in, user deletion, registry deletion), and a fifth
added later would forget. Sessions are still deleted with their grants in the same
batch at every `delete from sessions` (`session.ts:148,225,294,303,308`,
`sign-in.ts:232`, `users.ts:236`), which keeps the table small rather than keeping it
correct.

**Preview URLs carry the story.** The pane previews story X at path P as
`P?_folio=preview&_folio_id=X`. The branch renders X when it is in the site's chain,
its path is P, and the actor may preview the site — even when a nearer scope shadows
P — with a banner "Alpha overrides this page". So the national team previews
the shared page itself on a site that forked it, not the fork.

**Partitioned, because the pane is a cross-site iframe**: a `SameSite=Lax` cookie is
never sent there and Safari blocks unpartitioned cookies. CHIPS keys the cookie by the
top-level site too, so the pane's grant is visible only inside the admin, and a
top-level *Open preview* lands in the preview origin's own partition. CHIPS ships in
Chrome, Firefox and Safari 26.2 (webkit.org, "WebKit Features for Safari 26.2").

**Beat an HMAC-signed stateless grant**: no signing secret exists by design, and it
could not be revoked early. **Beat the grant token in the redirect URL**: a 24-hour
bearer in history and logs. **Beat previewing on the admin origin**: draft mode and
shares exist to show the site's own layout. **Beat a postMessage handshake**: the
first render is a server render.

**Every surface:**

- **The pane** loads `…/site/start?next=<preview path>` on each (re)load. The bridge
  accepts frames only from the site's preview origin and the iframe it owns; the
  preview posts only to `sites.admin`, written into its bootstrap. Folio's responses on
  a preview origin carry `Content-Security-Policy: frame-ancestors <sites.admin>`.
- **Draft mode**: `{base}/draft/enter` on a preview origin accepts a grant in place of
  a session, and with neither redirects to `site/start` with `next` pointing back.
  `reader.page()` / `draftAt()` answer drafts only on the preview origin.
- **Shares** are minted as `<preview_origin>{base}/share?t=…`, target the preview
  origin's copy of the page, record `shares.site_id`, and redeem only when the gated
  site equals it. Minting needs `PUBLISH` on the story's scope and a render site in
  `sitesUnder` of it, so the national team shares a shared page on any site.
- **A headless front end** forwards the visitor's `Cookie` on its service-binding call
  to the preview origin's `{base}/~<site>/api/v1/…?status=draft`; the grant
  authenticates that read.
- **MCP `preview_document`** on a multi-site deployment mints a **token grant** (five
  minutes, `site_grants.token_id`, readable only while the token is unrevoked and
  still able to read the site's drafts) and screenshots
  `site/enter` with the code, forwarding no `authorization` or `cookie`. **A
  single-site deployment keeps today's behaviour** — the caller's headers on Folio's
  same-origin preview shell — because it has no preview origin to put a grant on, and
  mounting `site/enter` on the admin origin would put a `GrantActor` beside `/api/*`
  on one origin for no gain.

### 14. Tokens are bound to a scope or to none

`api_tokens.site_id` is nullable; null is today's token. A token bound to `shared`
upserts the shared catalogue; to `alpha`, writes `alpha` and reads its chain; to
`north`, as decision 11. Idempotent upsert is the existing v1 surface (an indexed
external-id field, `GET /documents?where=…`, then `POST`/`PUT`), scoped by the binding.
`folio/engine` builds mutations and needs no site concept.

### 15. Cache entries are keyed by site and surface, and tags are scoped

**The key**: the gateway passes props on its loopback:

```ts
return this.ctx.exports.CachedPages({ props: await folio.cacheProps(req) }).fetch(req, {
  cf: { cacheKey: folio.cacheKey(req.url) },
})
```

`folio.cacheProps(req)` answers `{ site, surface }` for a gated site, `{}` for no site
or no `sites`. **The surface is in the key** so a preview origin and the live hosts
never share an entry: headers a host sets only on its preview origin
(`X-Robots-Tag: noindex`, Folio's `frame-ancestors`) can never be served on the live
site. **Beat folding the site into `cf.cacheKey`**: Cloudflare names props as the key
component for this. A tag purge reaches every props variant.

**The tags**, with `sites` configured (single-site renders today's set):

| Tag | Emitted by a render on `alpha` | Purged by |
| --- | --- | --- |
| `site:alpha` | always | a registry edit touching `alpha`, twice (decision 4); the degraded fallback |
| `story:<id>` | as today | as today |
| `global:<name>` | every configured global and the settings type | publishing its shared layer |
| `global:<name>@north`, `global:<name>@alpha` | every configured global and the settings type, per other chain scope, **whether or not that layer exists** | publishing that layer |
| `type:<name>@<scope>`, `type:*@<scope>` | per collection, per chain scope | a publish of that type (or any) in that scope |
| `path:alpha:<path>` | the page's own path | a publish, unpublish, delete, path change or redirect change at that path in any scope whose `sitesUnder` includes `alpha` |
| `form:<id>` | as today | as today |

**`cacheTags(resolution, opts)` keeps its signature.** What the new tags need rides on
the resolution: `resolution.site` carries `chain` and `layered` (the configured globals
and the settings type), and `resolution.path` the rendered story's path when `resolve`
was given one. So a host calling `folio.cacheHeaders(resolution, { story })` directly
gets every tag, first-layer publishes included, and `index.tsx:700` does not change.
Reindex and migrate stay `purgeEverything`. `cacheVerdictFor` treats the grant cookie
as a Folio credential, so no draft request reaches the cached entrypoint.

### 16. A headless front end resolves hosts, reads pages, and is told what to purge

**Host to site, without an admin token.** `GET {base}/api/v1/sites/resolve?host=<host>`
(`READ`, `content:read` for a token; unscoped) answers the gate's result for that host
as a first request would see it: `{ site: { id, name, group, status }, surface }`, or
`404` for no site. For a draft site's preview origin it answers `{ …, grantRequired:
true }`. `GET {base}/api/v1/sites` (`READ`) lists every `preview`/`live` site with its
hosts and preview origin, for a front end that keeps its own map; a bound token sees
its scope's sites only. `siteChanged` hook payloads carry the changed site, so a map
can be refreshed on the event instead of on a timer.

**Pages.** `GET {base}/~<site>/api/v1/pages/{path}` (`READ`; `?status=draft` needs
`READ_DRAFT` on the chain or a grant) is `reader.page()` over HTTP:
`{ story, document, resolution, draft, access }`, the tags in a `folio-cache-tags`
response header. **It applies the status gate**: the caller names the surface it is
serving (`?surface=live|preview`, default `live`), and a site that surface would not
serve is `404` unless the caller holds `READ_DRAFT` on the site's chain or a grant for
it. A front end cannot see a draft by lying about the surface; the most it can do is
serve a `preview`-status site's published pages on the wrong host, which is its own
routing, not a leak. `GET /documents/by-path/…` applies the same gate.

**Purging a front end's own cache**: a purge reaches only the entrypoint that issues
it. Every hook payload that triggers a purge (`published`, `unpublished`,
`pathsChanged`, `deleted`, `updated`, `migrated`, `reindexed`, `formChanged`,
`redirectsChanged`, and the new `siteChanged`) gains **`purge: { tags: string[] } |
{ everything: true }`**, exactly what Folio's purger computed; a headless host's hook
forwards it to its front end's cached entrypoint.

**Beat headless consumers rebuilding the resolution from document reads**: fallback,
shadowing and layering are Folio's rules, and a second implementation would drift.

### 17. Sign-in maps directory groups to grants

`RoleMapper` may answer `Role | RoleGrants | null` (`RoleGrants` a record of scope id or
`*` to role; a bare role is `{ '*': role }`). `roleFromClaim`'s map values become
`RoleTarget | RoleTarget[]`, `RoleTarget = Role | { scope, role }`, highest match
**per scope**. `completeSignIn` keeps `auth-providers.md` decision 5's table with
"role" read as "the grant set": the mapper's answer replaces the whole set, stamped
`role_from`; a changed set revokes other sessions and grants and records one
`role_changed` with before and after; `null` refuses when any row is `role_from =
provider.id`; provider-set grants cannot be edited by hand (`409`). An entry naming a
scope not in the registry is dropped with a log line and an `auth_events` note; if
nothing remains, it is `null`. With `sites`, a provider may not carry
`provision.role`, and `provision.create` requires `roleFrom` (`resolveAuth`).

### 18. `0011` expands, `0012` contracts one release later; no triggers

`0011_sites.sql` creates `site_roles` and backfills it from `users.role` and
`users.role_from` as `*` grants. **New code reads and writes only `site_roles`**;
`users.role` and `users.role_from` stay in place, ignored, until
`0012_users_role_contract.sql` drops them in the release after. New code inserts users
without naming `role` (the column's default fills it, unread).

**The migrate-to-deploy window is accepted, not engineered around.** Between applying
0011 and the new code serving, a role change or new user made through the old code
lands only in `users.role` and does not carry over. `UPGRADING.md` says: **do not
change roles or invite users between applying 0011 and the deploy finishing.** Both
consumers deploy within minutes. A self-provisioned sign-in in the window
(`provision.create` over OIDC or a trusted provider) cannot be forbidden by an
instruction, so `UPGRADING.md` also gives one idempotent statement to run when the
deploy finishes, which gives any user without a grant the `*` grant their row says:

```sql
insert into site_roles (user_id, scope_id, role, role_from, created_at)
  select id, '*', role, role_from, created_at from users
  where id not in (select user_id from site_roles);
```

Role *changes* made by old code in the window are still lost, which is what the
instruction covers. **Beat triggers on `users`** that mirror the old
column into `site_roles` (this spec's second draft): they collided with the seeds'
own grant insert on every fresh database, and on a rollback they minted `*` grants
from any old-code edit — `updateUser` writes `role` on every patch — which then
survived the roll-forward.

**Rollback.** Old code against 0011 reads `users.role`, which is each user's role as of
the migration, or the `'editor'` default for a user new code created. On a deployment
that never turned `sites` on, every grant is a `*` grant, and `UPGRADING.md` gives the
one statement that restores the column before a rollback:

```sql
update users set
  role = coalesce(
    (select role from site_roles where site_roles.user_id = users.id and scope_id = '*'),
    'viewer'),
  role_from =
    (select role_from from site_roles where site_roles.user_id = users.id and scope_id = '*');
```

A deployment that has turned `sites` on cannot roll back to code that has no site
dimension: that code would serve every site's rows as one site. `UPGRADING.md` states
that turning `sites` on is the point of no return. Old code also cannot create an
asset tag or a form against 0011, because its conflict targets (`asset-tags.ts:170`,
`forms.ts:642`) no longer match a unique index.

**Skipping the expand release** — applying 0011 and 0012 together from a pre-0011
build — drops `users.role` under still-running old code and takes sign-in down for the
build window. `UPGRADING.md` requires deploying the 0011 release before 0012's, and
0012's entry repeats it.

### 19. `PROTOCOL_VERSION` goes to 5

Three wire changes, one bump: `unset` (decision 8), the bridge's cross-origin rule
(decision 13), and the space channel per scope — `idFromName('space')` for `default`,
`idFromName('space:<scope>')` otherwise, events broadcast to the story's own scope.

## Wire & schema changes

### D1 migration `0011_sites.sql`

```sql
-- The registry: sites and groups, and the hostnames that reach each site.
create table sites (
  id             text primary key,
  kind           text not null check (kind in ('site', 'group')),
  name           text not null,
  group_id       text,
  status         text check (status in ('draft', 'preview', 'live')),
  preview_origin text,
  created_at     integer not null,
  updated_at     integer not null
);
create unique index sites_preview on sites (preview_origin) where preview_origin is not null;
create index sites_group on sites (group_id);
create table site_hosts (
  host    text primary key,
  site_id text not null
);
create index site_hosts_site on site_hosts (site_id);
insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at)
  values ('default', 'site', 'Default', null, 'live', null,
          unixepoch() * 1000, unixepoch() * 1000);

-- stories: owner scope, fork provenance, every index with the site leading.
alter table stories add column site_id text not null default 'default';
alter table stories add column forked_from text;
drop index stories_path;
create unique index stories_path on stories (site_id, path) where path is not null;
drop index stories_parent_slug;
create unique index stories_parent_slug
  on stories (site_id, coalesce(parent_id, ''), slug) where path is not null;
drop index stories_type_slug;
create unique index stories_type_slug on stories (site_id, type, slug) where path is null;
drop index stories_parent_ord;
create index stories_parent_ord on stories (site_id, parent_id, ord);
drop index stories_type;
create index stories_type on stories (site_id, type, ord);
drop index stories_edited;
create index stories_edited
  on stories (site_id, coalesce(draft_updated_at, updated_at) desc, id desc);
drop index stories_title;
create index stories_title on stories (site_id, title, id);

-- redirects: rebuilt, because the primary key changes.
create table redirects_next (
  from_path  text not null,
  to_path    text not null,
  status     integer not null default 301 check (status in (301, 302, 307, 308)),
  source     text not null default 'auto' check (source in ('auto', 'manual')),
  story_id   text,
  created_at integer not null,
  site_id    text not null default 'default',
  primary key (site_id, from_path)
);
insert into redirects_next (from_path, to_path, status, source, story_id, created_at, site_id)
  select from_path, to_path, status, source, story_id, created_at, 'default' from redirects;
drop table redirects;
alter table redirects_next rename to redirects;
create index redirects_to on redirects (site_id, to_path);

-- assets and their organisation.
alter table assets add column site_id text not null default 'default';
drop index assets_created;
create index assets_created on assets (site_id, created_at desc);
drop index assets_filename;
create index assets_filename on assets (site_id, filename, id);
drop index assets_size;
create index assets_size on assets (site_id, size desc, id);

create table asset_folders_next (
  id         text primary key,
  parent_id  text,
  name       text not null,
  path       text not null,
  created_at integer not null,
  site_id    text not null default 'default'
);
insert into asset_folders_next (id, parent_id, name, path, created_at, site_id)
  select id, parent_id, name, path, created_at, 'default' from asset_folders;
drop table asset_folders;
alter table asset_folders_next rename to asset_folders;
create unique index asset_folders_path on asset_folders (site_id, path);
create index asset_folders_parent on asset_folders (parent_id, name);

create table asset_tags_next (
  id         text primary key,
  name       text not null,
  slug       text not null,
  created_at integer not null,
  site_id    text not null default 'default'
);
insert into asset_tags_next (id, name, slug, created_at, site_id)
  select id, name, slug, created_at, 'default' from asset_tags;
drop table asset_tags;
alter table asset_tags_next rename to asset_tags;
create unique index asset_tags_slug on asset_tags (site_id, slug);

-- forms: owned by a scope; a response records the site it was submitted on.
alter table forms add column site_id text not null default 'default';
drop index forms_name;
create unique index forms_name on forms (site_id, name);
drop index forms_updated;
create index forms_updated on forms (site_id, updated_at desc, id);
alter table form_responses add column site_id text not null default 'default';
create index form_responses_site on form_responses (form_id, site_id, created_at desc, id);

-- shares render in one site's context; tokens may be bound to one scope.
alter table shares add column site_id text not null default 'default';
alter table api_tokens add column site_id text;

-- grants: a role on a scope. `*` is every scope. Backfilled once; no triggers.
create table site_roles (
  user_id    text not null references users(id) on delete cascade,
  scope_id   text not null,
  role       text not null check (role in ('viewer', 'editor', 'publisher', 'admin')),
  role_from  text,
  created_at integer not null,
  primary key (user_id, scope_id)
);
create index site_roles_scope on site_roles (scope_id, user_id);
insert into site_roles (user_id, scope_id, role, role_from, created_at)
  select id, '*', role, role_from, created_at from users;

-- the preview handoff: a code, then a grant, on one row; a session's or a token's.
create table site_grants (
  id         text primary key,
  session_id text,
  token_id   text,
  site_id    text not null,
  code_hash  text,
  token_hash text,
  created_at integer not null,
  expires_at integer not null,
  check ((session_id is null) <> (token_id is null))
);
create unique index site_grants_code on site_grants (code_hash) where code_hash is not null;
create unique index site_grants_token on site_grants (token_hash) where token_hash is not null;
create index site_grants_session on site_grants (session_id);
create index site_grants_expiry on site_grants (expires_at);
```

Columns added by `alter` land last, so the `stories` column-order assertion gains two
entries at the end. `stories_edited` stays an expression index over the coalesce with
the site leading; `stories_draft_updated` stays absent. Plain statements: applied
twice it fails loudly. Every table it alters exists by `0010`.

### D1 migration `0012_users_role_contract.sql` (the release after)

```sql
alter table users drop column role_from;
alter table users drop column role;
```

### Seeds and bootstrap SQL, at every phase

From Phase 1 on, every seed and bootstrap snippet creates a user in the shape that
works on a fresh database before **and** after 0012:

```sql
insert into users (id, email, name, created_at) values ('usr_admin', 'admin@example.com', 'Admin', 0);
insert into site_roles (user_id, scope_id, role, created_at) values ('usr_admin', '*', 'admin', 0);
```

`users.role` is not named, so its default fills it while it exists and nothing breaks
when 0012 drops it; there is no trigger to collide with the second insert.

### Core types

Additive to documents and logs already written; the one stored-shape change is the
layer ids, which exist only on multi-site deployments.

```ts
// src/core/sites.ts
export const SHARED_SCOPE = 'shared'
export const DEFAULT_SITE = 'default'
export const ALL_SCOPES = '*'
export type SiteStatus = 'draft' | 'preview' | 'live'
export type Surface = 'live' | 'preview'
export interface SiteRef { id: string; name: string; group: string | null; status: SiteStatus; hosts: readonly string[]; preview: string | null }
export interface GroupRef { id: string; name: string }
export interface Registry { sites: readonly SiteRef[]; groups: readonly GroupRef[] }
export function chain(registry: Registry, scope: string): readonly string[]
export function sitesUnder(registry: Registry, scope: string): readonly string[]
export function layerId(type: string, scope: string): string            // 'sng_<type>' for default
export function singletonTypeOf(id: string): { type: string; scope: string } | null
export function layerSeed(registry: Registry, scope: string): 'bare' | 'full'
export function candidate(registry: Registry, url: URL): { site: string; surface: Surface } | null
export function gate(registry: Registry, c: { site: string; surface: Surface }, req: { path: string; grantFor: string | null }): SiteRef | null

// src/core/layers.ts
export function mergeLayers(layers: readonly (Doc | undefined)[], schema: SchemaIndex): Doc | undefined
export type LayerState = { state: 'inherited' | 'overridden' | 'removed'; from: string | null }
export function layerStates(layers: readonly (Doc | undefined)[], scopes: readonly string[], schema: SchemaIndex): Record<string, LayerState>

// src/core/mutations.ts
| { t: 'unset'; uid: string; field: string; locale?: string }

// src/core/story.ts — StoryMeta
site: string
forkedFrom?: string | null

// src/core/resolve.ts — Resolution (both absent with no `sites`)
site?: { id: string; name: string; group: string | null; status: SiteStatus; surface: Surface; chain: readonly string[]; layered: readonly string[] }
path?: string
```

```ts
// src/server/types.ts
interface SitesConfig {
  admin: string
  settings?: string
  resolve?: (req: Request, registry: Registry) => string | null
}
FolioConfig.sites?: SitesConfig
FolioConfig.route?: (path: string, locale?: string, site?: SiteRef) => string
Folio.reader: (env: Env, from?: Request | { site: string }) => FolioReader
FolioReader.site: () => Promise<SiteRef | null>
Folio.cacheProps: (req: Request, env: Env) => Promise<{ site?: string; surface?: Surface }>
Folio.settings: (resolution: Resolution) => NestedValue | null
HookBase.site: string
HookBase.purge?: { tags: string[] } | { everything: true }
HookEvent: … | 'siteChanged'
FolioGateContext.site: SiteRef | null

// src/server/auth/config.ts
type RoleGrants = Readonly<Record<string, Role>>
type RoleMapper = (identity: VerifiedIdentity) => Role | RoleGrants | null

// src/server/auth/roles-from.ts
type RoleTarget = Role | { scope: string; role: Role }

// src/server/auth/roles.ts
interface GrantActor { kind: 'grant'; id: string; userId: string | null; tokenId: string | null; name: string; site: string; expiresAt: number }
type Actor = UserActor | TokenActor | GrantActor
interface Access { role: Role; scope: Scope; tier: 'platform' | 'scope' }
interface TokenActor { /* … */ site: string | null }
```

Construction-time validation (`validateSites`, `src/server/runtime.ts`): `admin` is an
absolute origin; `settings` names a declared `singleton`; `route` is present; every
layered type's `layerId` fits 64 characters for a 32-character scope id. The
provisioning rules are `resolveAuth`'s (decision 17). Everything about particular sites
is validated on the registry write (decision 1).

### New or changed routes

**Tables**

| Table | Scoping |
| --- | --- |
| `sites`, `site_hosts` | new: the registry, platform tier |
| `stories` | `site_id`; reads by chain, writes by scope; paths by decision 5 |
| `versions`, `content_index`, `content_text`/`content_fts`, `content_refs` | through `stories` |
| `schedules` | through `stories`; the sweep is deployment-wide |
| `redirects` | `site_id`; consulted per scope within decision 5's walk and decision 6's dedupe |
| `assets` | `site_id`; library by scope, picker by chain; `{base}/asset/:key` public by key |
| `asset_folders`, `asset_tags` | `site_id`; tagging across scopes refused |
| `asset_taggings` | through `assets` and `asset_tags` |
| `forms` | `site_id`; embeddable by chain; `/f/:id` for a form in the submitting site's chain |
| `form_responses` | `site_id` = submitting site; read with `FORMS` on the form's scope (all) or the submitting site (its own) |
| `shares` | `site_id` = render site; redeemed only there |
| `api_tokens` | nullable `site_id` |
| `users`, `sessions`, `passkeys`, `login_challenges`, `auth_events` | deployment-wide, platform tier |
| `site_roles`, `site_grants` | new |
| `schema_migrations` | deployment-wide |

**Admin API (`{base}/~<scope>/api/*` on `sites.admin`)**

| Route | Rule |
| --- | --- |
| `GET /stories`, `/documents`, `/counts` | scope's own rows |
| `GET /search` | chain, each hit carrying its `site` |
| `POST /stories` | create in scope; `root: true` creates the scope's root |
| `PATCH`/`DELETE /stories/:id`, `/story/:id/*` | row in scope (writes) or chain (reads) |
| `POST /stories/:id/duplicate` | source in chain, copy in scope |
| **`POST /stories/:id/fork`** | `CREATE` on scope; routed source owned above; parent path the scope's own or top level |
| **`GET /inherited`** | routed rows owned above, keyset-paged by path, each with `shadowedBy` and `forkedSince` |
| `GET /…/:id/usage` (documents, assets, forms) | uses in readable scopes listed; others counted |
| `GET /schedules`, `/shares`, `/published`, `/redirects`, `/forms`, `/assets`, `/assets/folders`, `/assets/tags` | scope's own rows; `/assets` and `/forms` take `?chain=1` |
| `POST /schedules/run` | `PUBLISH` on scope; runs the deployment-wide sweep of what is due |
| `/bulk/*`, `/assets/bulk/*` | every id in scope |
| `GET /content` | chain, deduped per decision 6 |
| `GET /space/socket` | `space:<scope>` |
| `/forms/:id/responses*` | as `form_responses` |

**Unscoped admin API (`{base}/api/*` on `sites.admin`)**

| Route | Rule |
| --- | --- |
| **`GET`/`POST /sites`**, **`PATCH`/`DELETE /sites/:id`**, **`PUT /sites/:id/hosts`** | platform tier; decision 1; each write drops the snapshot, purges per decision 4, fires `siteChanged` |
| `/me` | adds reachable `sites`, `groups`, `scopes` with effective roles, `previewable` sites, and `platform` |
| `/users*`, `/tokens*`, `/auth-events`, `/reindex`, `/migrate`, `/audit`, `POST /assets/describe` | platform tier; `/users` carries grants; `POST /tokens` takes `site`, refusing `admin` with a binding |
| `/migrations`, `/schema`, `/me/*` passkeys and sessions | unscoped, as today |

**Admin pages and handoff (`sites.admin`)**: `GET {base}/~<scope>/…` (the shell);
`GET {base}/` redirects to the caller's first scope; `GET {base}/sites` (the Sites
screen); **`GET {base}/~<site>/site/start?next=`** (decision 13).

**Preview origins**: **`GET {base}/site/enter`** and `…&check=1`; `GET
{base}/draft/enter|exit`; `GET {base}/share`; `?_folio=preview|draft` (with
`_folio_id`); `GET {base}/~<site>/api/v1/*` reads.

**Live hosts**: `GET {base}/asset/:key`, `POST {base}/f/:id`.

**Machine surfaces**

- `{base}/~<scope>/api/v1/*` — every route as today, scoped; `ApiDocumentMeta.site`
  on multi-site deployments; `GET /documents/by-path/…` and **`GET /pages/{path}`**
  gated per decision 16.
- **`GET {base}/api/v1/sites/resolve?host=`**, **`GET {base}/api/v1/sites`** — decision
  16.
- `{base}/~<scope>/mcp` — dispatch per decision 11.

Error codes: `400 site_required`; `403` naming the site; `404` outside the fence, for a
gated-out site, and for no site; `409` for a fork whose parent is not the site's, a
second root, a protected root delete, or deleting a registry row that owns content.

## Acceptance criteria

### Nothing changes for a single-site host

```
GIVEN examples/demo, unmodified, with no `sites` key
WHEN every unit, workers and e2e test runs after 0011 is applied
THEN all pass unchanged except those this spec edits for the migration, the role table and the seeds
AND a published page's Cache-Tag header, Resolution payload and URLs are byte-identical
AND a global's first draft is seeded with its defaults and preset exactly as today
AND {base}/~default/api/stories is a 404, and no registry read happens on any request
```

```
GIVEN a fresh database
WHEN 0001–0008, 0010, 0011 are applied in filename order and examples/demo/seed.sql runs
THEN every statement succeeds, and the seeded admin signs in with an '*' admin grant
AND the same holds with 0012 applied too
```

```
GIVEN a database with users at every role before 0011
WHEN 0011 is applied
THEN every user holds exactly one grant, on '*', at the role and role_from they had
```

### Registry and status

```
GIVEN a platform admin
WHEN they create site gamma in group north with host gamma.example, preview origin https://preview.gamma.example, status draft
THEN gamma.example and preview.gamma.example are the host's 404 for an anonymous request
AND folio.cacheProps answers {} for both
WHEN the platform admin opens gamma's preview from the admin
THEN site/start → site/enter → check → the page each succeed on preview.gamma.example, and the draft renders
WHEN an editor mints a share for a gamma page while gamma is draft
THEN its recipient, with no account, sees that one page's draft on preview.gamma.example, and any other gamma path is still a 404
WHEN an editor with no grant cookie opens preview.gamma.example{base}/draft/enter
THEN a redirect to site/start on the admin origin, not a 404
WHEN the status becomes preview    THEN preview.gamma.example serves published content to anyone; gamma.example is still a 404
WHEN the status becomes live       THEN gamma.example serves; site:gamma is purged at once and after 25 seconds
AND another isolate answers the new status within ten seconds
```

```
GIVEN hostnames P.EXAMPLE and https://p.example:443 offered as a live host and a preview origin on two sites
THEN the second write is refused as already claimed
GIVEN a custom sites.resolve that answers 'north' or a draft site for a live host
THEN the gate answers no site
GIVEN a preview origin whose host equals the admin origin's
THEN the write is refused, and a row that holds one anyway (written by SQL) still leaves the admin reachable
```

```
GIVEN a site admin of alpha, a shared-content publisher, and a token bound to alpha with every scope
WHEN each attempts POST {base}/api/sites    THEN 403
WHEN the platform admin deletes a site that still owns stories    THEN 409
WHEN it deletes an empty site on which provider-set grants exist  THEN it succeeds and the grants are gone
```

### Site settings

```
GIVEN settings type siteSettings with a theme block (max: 1) holding primary and radius, radius defaulting to rounded
AND the shared layer, created on a multi-site deployment, therefore reads radius rounded
AND alpha's layer overrides the theme child, setting primary #e00
WHEN a page on alpha resolves
THEN folio.settings(resolution).theme is { primary: '#e00', radius: 'rounded' }
WHEN the shared radius becomes square and is published
THEN global:siteSettings is purged and alpha reads radius square with primary #e00
WHEN north publishes its first siteSettings layer
THEN global:siteSettings@north is on every cached north page, including those cached before the layer existed
AND a host calling folio.cacheHeaders(resolution, { story }) directly emits it too
```

### Isolation

```
GIVEN sites alpha and bravo, each with a published story at 'about'
THEN each serves its own document
AND a reference on alpha to bravo's story id resolves as absent
AND a collection and a search on alpha return no bravo row
AND preview.alpha.example/about and alpha.example/about have different cache props
```

### Fallback and fork

```
GIVEN a shared story 'stores', published, and site alpha with no story at 'stores'
WHEN alpha.example/stores is rendered     THEN the shared document in alpha's context
WHEN alpha forks it and publishes         THEN the fork serves, and the purge includes path:alpha:stores
WHEN alpha renames the fork to our-stores
THEN alpha.example/stores redirects to our-stores
AND alpha's sitemap and page collections list our-stores and not stores
AND bravo still serves the shared page
WHEN the fork is unpublished              THEN alpha.example/our-stores is gone
WHEN it is deleted                        THEN alpha serves the shared 'stores' again
```

```
GIVEN the shared root, published, and alpha with no root
WHEN alpha forks it and publishes    THEN alpha's home is its own
WHEN alpha deletes its root          THEN alpha's home is the shared one again
WHEN anyone deletes the shared root  THEN 409
GIVEN no shared or group root, and alpha created a home page
WHEN anyone deletes alpha's root     THEN 409
```

```
GIVEN a shared 'info/parking' and alpha owns no 'info'
WHEN an alpha editor forks 'info/parking'   THEN 409 naming Info
GIVEN alpha has forked 'info'
THEN the shared 'info/parking' on alpha shows alpha's Info in its breadcrumb and carries its tag
```

### Layered globals

```
GIVEN header layers: shared {title: 'A', cta: 'Visit'}, north {cta: 'Hello'}, alpha {title: null}
THEN header on alpha reads cta 'Hello' and no title; bravo reads title 'A', cta 'Visit'
AND layerStates for alpha: title removed here, cta inherited from north
WHEN the alpha editor resets title                         THEN an unset is written and title reads 'A'
WHEN the alpha editor untranslates French cta (null)       THEN French cta falls back to 'Hello'
WHEN a new alpha layer is created, in the admin or by a v1 create   THEN its root data is {} and every field reads inherited
WHEN the shared layer is first created                     THEN it carries the type's defaults and preset
```

### Permissions

```
GIVEN U with {alpha: publisher}
THEN U publishes alpha pages, not shared ones; reads shared pages under ~alpha; is 403 under ~bravo and on /api/users
GIVEN R with {north: editor}        THEN R edits alpha and north content, not bravo or shared
GIVEN N with {shared: publisher}    THEN N publishes shared content, cannot edit alpha or list users
GIVEN P with {'*': admin}           THEN P does everything
```

```
GIVEN an OIDC provider whose roleFromClaim maps g-alpha → {alpha, editor}, g-alpha-lead → {alpha, publisher}, g-central → admin
WHEN a person in g-alpha and g-alpha-lead signs in   THEN their grants are {alpha: publisher}
WHEN a person matching nothing signs in              THEN refused, with an auth_events row
WHEN a person's groups change                        THEN grants replaced, other sessions and grants revoked, role_changed recorded
WHEN a mapped group names a deleted site             THEN that entry is dropped and the rest applies
```

```
GIVEN a token bound to alpha
WHEN it POSTs /~alpha/api/v1/documents or /api/v1/documents   THEN created in alpha
WHEN it POSTs /~bravo/api/v1/documents                        THEN 403
WHEN it GETs a shared document under ~shared                  THEN 200
WHEN it calls /api/tokens, /api/users or /api/sites           THEN 403
WHEN an unbound admin token mints a token with site alpha and scope admin   THEN 400
GIVEN a token bound to north   THEN it writes alpha, not bravo
GIVEN an MCP client at {base}/~alpha/mcp with an alpha-bound token
THEN query_documents and create_document run on alpha, and a client-sent internal header is ignored
```

### Preview across origins

```
GIVEN an editor signed in on sites.admin with READ_DRAFT on alpha
WHEN the pane loads {base}/~alpha/site/start?next=/about?_folio=preview
THEN the draft renders on alpha's preview origin, with frame-ancestors naming sites.admin
AND the code cannot be redeemed twice, concurrently, after 60 seconds, or on bravo's preview origin
AND next=https://elsewhere.example is replaced by the fallback path on both hops
WHEN the editor signs out, is removed, or has their alpha grant removed on the Access screen while keeping a session, with foreign keys off
THEN the next request on alpha's preview origin renders no draft
```

```
GIVEN draft site gamma with no layer rows, previewed by a platform admin
THEN no stories row and no Durable Object is created for any layer, and every setting reads inherited
AND deleting gamma afterwards succeeds
```

```
GIVEN N with {shared: publisher} and no other grant, a shared draft 'offers', a draft of alpha's own page 'about', and an unpublished edit to alpha's settings layer
WHEN N opens {base}/~alpha/site/start                  THEN 302 to alpha's preview origin, not 403
WHEN N previews 'offers' on alpha                      THEN the shared draft renders, with alpha's draft settings
WHEN N previews alpha's 'about'                        THEN alpha's draft of 'about'
WHEN N writes anything on alpha, with the grant or the session   THEN refused
GIVEN alpha has forked 'stores'
WHEN N previews the shared 'stores' on alpha (_folio_id)   THEN the shared draft, with the "Alpha overrides this page" banner
WHEN N mints a share for the shared 'offers' on alpha      THEN its URL is on alpha's preview origin
GIVEN R with {north: editor} and no alpha grant
WHEN R edits an alpha page and the pane reloads        THEN R sees that edit as a draft, with north's and shared drafts
WHEN R previews bravo (no group)                       THEN 403
```

```
GIVEN a grant cookie on alpha's preview origin
WHEN it is presented to any write, any {base}/api admin route, or a socket   THEN refused
WHEN it is presented to GET {base}/~alpha/api/v1/documents/:id?status=draft there   THEN the draft
WHEN a live alpha hostname receives it                                       THEN no draft
GIVEN preview_document on a multi-site deployment
THEN the browser request carries no authorization header and no session cookie
```

### Headless

```
GIVEN a front end holding an unbound content:read token
WHEN it calls /api/v1/sites/resolve?host=alpha.example        THEN { site: alpha, surface: live }
WHEN it calls it for gamma.example while gamma is draft        THEN 404
WHEN it calls it for preview.gamma.example                     THEN grantRequired
WHEN it calls /~gamma/api/v1/pages/about                       THEN 404, with or without surface=preview, while gamma is draft
WHEN it forwards an editor's grant cookie to preview.gamma.example's /~gamma/api/v1/pages/about?status=draft   THEN the draft
WHEN something publishes on alpha                              THEN the hook payload's purge equals what Folio purged
```

### Cache

```
GIVEN a multi-site render on alpha of a page with a collection over 'event'
THEN Cache-Tag includes site:alpha, path:alpha:<path>, type:event@alpha, type:event@north, type:event@shared,
     and global:<name>, global:<name>@north, global:<name>@alpha for every configured global and the settings type
WHEN an event is published in bravo   THEN no tag alpha carries is purged
```

## Implementation plan

Ten phases, each committable and green on its own, each owning its files. **Order:**
1 → 2 → {3 ∥ 6} → 4 → 5 → 7 → 8 → 9, and 10 in the release after. Only 3 and 6 run
together, and they share no file: 3 owns `src/server/auth/*`, `middleware.ts`,
`routes/access.ts`, `routes/editor.ts`, `routes/sites.ts` and the id loaders in
`routes/*` including `routes/api/documents.ts`; 6 owns `src/core/cache-tags.ts`,
`src/server/cache-purge.ts` and the one purger-construction line at `runtime.ts:956`.
Each phase's tests exercise only what exists by the end of it. Every agent reads
`CLAUDE.md`'s invariants, `docs/1.0-plan.md`'s orchestration rules and this spec first,
and gates on exit codes (`./node_modules/.bin/biome ci .`, `pnpm typecheck`,
`pnpm test`).

### Phase 1 — The migration and the role table (behaviour-identical)

Suggested agent: implementer, opus.

1. `migrations/0011_sites.sql`.
2. `asset-tags.ts:170`, `forms.ts:642`: conflict targets `(site_id, slug)` and
   `(site_id, name)`, `site_id` bound; `redirects.ts:145,341` bind `site_id`.
3. `test/workers/migrations.test.ts`: the new tables; the two `stories` columns; every
   re-keyed index by `sql`; rebuilt tables with their data; the backfill; the default
   site row; the expression index; a fresh-database run in filename order.
4. `auth/users.ts`, `auth/session.ts`, `auth/sign-in.ts`, `routes/access.ts`,
   `auth/events.ts`: roles read from and written to `site_roles` scope `*` only; users
   inserted without naming `role`; `deleteUser` deletes `site_roles` explicitly.
5. `src/core/story.ts` `StoryMeta.site`, `forkedFrom`; `stories.ts` `COLS`; every write
   binds `site_id = 'default'`.
6. Seeds and bootstrap SQL in the shape above: `examples/demo/seed.sql`,
   `examples/starter/seed.sql`, `test/workers/pagination.test.ts:568`,
   `docs/configuration.md`, `docs/handbook.md`. `./scripts/e2e-all.sh` passes.
7. `UPGRADING.md`: 0011, the window rule, the rollback statement, 0012 to follow and
   not to be applied in the same step.
8. `test/workers/users-contract.test.ts`: applies 0012's two statements to its own
   database (storage is per test file), then signs in by magic link and by a trusted
   provider, reads a session, lists, creates and patches users, resolves a token, and
   runs the seed shape. It fails on any code that still reads the columns, whatever the
   SQL spells them (`u.role`, a `COLUMNS` string, `select role from users`). Test code
   that reads them moves first: `test/workers/auth-http.test.ts:389` reads the grant.
   **Beat a source-text grep**: the column is read today as `u.role` (`session.ts:138`)
   and inside `COLUMNS` (`users.ts:66`), neither of which a pattern like `users.role`
   matches, while a comment (`auth/roles.ts:124`) does.
9. `UPGRADING.md` also carries the post-deploy grant statement (decision 18).

### Phase 2 — Registry, scopes, resolution and fallback

Suggested agent: implementer, opus. Depends on 1.

1. `src/core/sites.ts` and unit tests; `validateTypes`' charset (`schema.ts`).
2. `src/server/sites.ts` (new): the registry read on `first-primary`, the snapshot and
   write-side drop, write-time validation and normalisation.
3. `src/server/types.ts`: every type in Core types except the auth ones.
4. `src/server/runtime.ts`: `validateSites`; `withUrls` / `previewUrlFor` take a
   `SiteRef`; `resolve()` takes the rendering site, filters every id-set read by
   chain, resolves ancestors per decision 5, fills `Resolution.site` and `.path`.
5. `src/server/stories.ts`: the chain lookups with `pickServing` / `pickEditing` and the scope's redirects in
   the same batch; list readers by scope; `createStory` (scope, `root: true`),
   `duplicateStory`, `ensureSingleton` (scope, layer ids); the root-delete rule.
   `redirects.ts` likewise.
6. `src/server/query.ts` `contentSql`: the chain clause and the `not exists` over
   nearer-scope stories and redirects.
7. `src/server/index.tsx`: the `~<scope>` strip and internal headers; host confinement;
   candidate and gate, admitting a draft site's preview origin for nobody yet (phase 5
   adds grants); `reader` from a request or `{ site }`; the one-shot reads throw on a
   multi-site deployment naming `folio.reader(env, req | { site })`; served-set
   `stories()` and path-built `tree()`; **`folio.cacheProps`** and
   **`folio.settings`**.
8. `src/server/middleware.ts` `withScope`, `site_required`.
9. `src/server/routes/sites.ts` (new): the registry routes behind today's `ADMIN` gate
   (which only `*` grants can satisfy until phase 3), dropping the snapshot on write.
10. `test/workers/multi-site.test.ts`: two sites, a group and shared, seeded by SQL
    (registry rows, stories, forks written directly); the resolver and gate tables for
    anonymous requests; Isolation; the fallback walk, redirects and root rules without
    the fork route or purges; `folio.settings` over a hand-built resolution (layer
    loading arrives in phase 4).

### Phase 3 — Permission tiers and SSO grants

Suggested agent: implementer, opus; reviewer after. Depends on 2. Parallel with 6.

1. `auth/roles.ts`: `Access.tier`, effective roles, `GrantActor` in the union with its
   `allows` rule (the credential is wired in phase 5).
2. `middleware.ts` `withActor`: effective role; the no-grant 403 and the
   `reach: 'preview'` exemption (with `previewEligible(grants, chain)` in
   `auth/roles.ts`, which phase 5's `site/start` calls); token binding; platform-tier
   refusal of bound tokens.
3. Every id loader enforces the fence, including `routes/api/documents.ts`'s singleton
   branch; `routes/editor.ts` socket identity.
4. `auth/config.ts`, `auth/roles-from.ts`, `auth/sign-in.ts`, `resolveAuth`: decision 17.
5. `auth/tokens.ts`, `routes/access.ts`: token binding and its `admin` refusal;
   `grants` on users; the 409. `routes/sites.ts`: platform tier; the delete removes the
   scope's grants.
6. `test/workers/scope-partition.test.ts`; every Permissions criterion except MCP; the
   registry-permission criterion; `auth-login.test.ts` the grant-set table.

### Phase 6 — Cache key and tags

Suggested agent: implementer, sonnet. Depends on 2. Parallel with 3.

1. `src/core/cache-tags.ts`: scoped builders; `cacheTags` reads `resolution.site`
   (`chain`, `layered`) and `resolution.path`; single-site unchanged.
2. `src/server/cache-purge.ts`: owner-scoped tags for every event whose payload
   already carries a story — `published`, `unpublished`, `updated`, `checkpointed` —
   read from `story.site` (on `StoryMeta` since phase 1), with their `path:` fan-out
   through `sitesUnder`; layer publishes; `purgeSite(id)` with the 25-second second
   purge; every purge function returns the set it issued. **`deleted`, `pathsChanged`
   and `redirectsChanged` carry ids and paths but no scope** (`hooks.ts:78-150`), so
   their owner-scoped purges land in phase 7 with the payload change, not here.
3. `runtime.ts:956`: the purger is built with the registry accessor.
4. Unit tests for every Cache criterion and the first-layer tag.

### Phase 4 — Layered globals, settings and `unset`

Suggested agent: implementer, sonnet. Depends on 3 and 6.

1. `src/core/mutations.ts` `unset`; `src/core/protocol.ts` `PROTOCOL_VERSION = 5`;
   `story-do.ts` accepts it on the `set` path.
2. `src/core/layers.ts` with unit tests for every row of decision 8, `i18n` included.
3. `runtime.ts` `resolve()`: layer ids for the chain in the same statements; the
   settings type always loaded; on multi-site, draft mode reads layers without
   `ensureSingleton` (a missing layer is absent); `seed()` by `layerSeed`.
4. `src/core/nested.ts` `opts.layer`; `routes/api/documents.ts` passes it for a bare
   layer.
5. `src/server/index.tsx` layered `reader.global`; `src/server/audit.ts` the per-site
   merged-settings check.
6. `test/workers/globals.test.ts`, `read-session.test.ts`: counts unchanged
   single-site; every Layered globals and Site settings criterion, the purge lines
   included (phase 6 is in).

### Phase 5 — Preview, draft mode and shares across origins

Suggested agent: implementer, opus; reviewer after. Depends on 4.

1. `src/server/auth/grants.ts` (new): mint, consume, `readGrant` (joining `sessions` or
   `api_tokens`, and current `site_roles` or the token's binding and scopes), sweep; `auth/cookie.ts`; `auth/resolve.ts`
   `credentialOf` / `resolveActor`; every session-deleting path deletes its grants;
   `sweepAuth` sweeps `site_grants`.
2. `src/server/routes/handoff.ts` (new): `site/start`, `site/enter`, `check`, both hops
   through `safeNext`; mounted in `app.ts`.
3. `src/server/index.tsx`: the gate admits a draft site's preview origin per decision 4;
   drafts only on the preview origin, across the chain; `_folio_id`; the gate admits
   `share`, `draft/enter` and share-cookie requests on a draft site;
   `frame-ancestors`. `routes/draft.ts` accepts a grant; `routes/preview.ts` share URLs,
   `shares.site_id`, redemption check, and the `sitesUnder` render-site rule;
   `mcp/shot.ts` the multi-site token grant, single-site unchanged.
4. `cache-request.ts` `cacheVerdictFor`: the grant cookie bypasses.
5. `src/admin/hooks/usePreviewBridge.ts`, `src/preview/mount.tsx`: the configured
   origins both ways; `grant-blocked`; the pane's `src` through `site/start`.
6. Workers tests for every Preview criterion and the draft-site, share and
   `draft/enter` rows in Registry, with foreign keys off for the revocation ones.

### Phase 7 — The remaining surfaces

Suggested agent: implementer, sonnet. Depends on 5.

1. Assets, folders, tags (`assets.ts`, `asset-folders.ts`, `asset-tags.ts`,
   `asset-bulk.ts`, `routes/assets.ts`); forms and responses (`forms.ts`,
   `form-responses.ts`, `routes/forms.ts`, `/f/:id` recording the submitting site);
   redirects, schedules and shares lists; `routes/content.ts`; `routes/stories.ts`
   (fork, inherited, usage, root create); `routes/history.ts` `/published`.
2. `routes/api/*`: scoping, `ApiDocumentMeta.site`, `GET /pages/{path}` and
   `/documents/by-path` with the status gate and `folio-cache-tags`,
   `GET /sites/resolve` and `GET /sites`; `routes/mcp.ts` dispatch per decision 11.
3. `space-events.ts`, `runtime.ts:618`, `routes/space.ts`: per-scope channel.
4. `hooks.ts` and every emitter (`server/documents.ts`, `redirects.ts`, the routes
   that fire): `site`, `purge` (from phase 6's return values) and `siteChanged` on every
   payload; then, in `cache-purge.ts`, the owner-scoped `deleted`, `pathsChanged` and
   `redirectsChanged` purges with their `path:` fan-out, which need that `site`;
   `routes/sites.ts` calls `purgeSite` and fires `siteChanged`; `gate` context `site`.
5. `multi-site.test.ts` and `scope-partition.test.ts`: the fork and rename Fallback
   criteria with their purges, the Registry purge lines, Headless, MCP.

### Phase 8 — The admin

Suggested agent: implementer, sonnet. Depends on 7.

1. `src/admin/me.ts`, `ui/Admin.tsx`, `ui/route.ts`, `ui/useRouter.ts`: the scope
   segment in every URL and `apiBase`; `TopBar.tsx` / `Sidebar.tsx`: the scope switcher.
2. `ui/screens/Sites.tsx`, `sites-model.ts`, a dialog on `useFocusTrap`: the registry,
   platform admins only; its **Settings** tab opens the scope's settings layer.
3. `ui/screens/Home.tsx` / `home-model.ts`: **Inherited pages** with *Fork*, "overridden
   here", *Create home page*; `EditorShell.tsx`: the forked-since notice and a
   "preview in" site picker from `/me`'s `previewable`.
4. `ui/screens/Inspector.tsx`, `inspector-model.ts`, `fields/FieldRow.tsx`: layer labels
   and actions.
5. `ui/screens/Access.tsx`, `access-model.ts`, `AccessInviteDialog.tsx`,
   `AccessTokenDialog.tsx`: grants; token binding; single-site looks as today.
6. `ui/screens/AssetPicker.tsx`, `fields/DocumentPicker.tsx`, `fields/FormField.tsx`:
   chain pickers badged by scope.
7. Render tests under `test/unit/admin/render/`; any new portal re-declares `scoped()`.

### Phase 9 — Documentation

Suggested agent: implementer, sonnet. Depends on 8.

`README.md` and `AGENTS.md` (the "multi-site is not built" lines); `docs/handbook.md` (a
Multi-site section: registry and status, settings, fallback and fork, layered globals,
grants and SSO, preview origins and what they must route, preview for shared and group
roles, the cache gateway with `cacheProps`, the headless surfaces); `docs/configuration.md`;
`UPGRADING.md` (the admin origin must not be a site host, and moving it invalidates
every passkey, which editors re-enrol); `docs/specs/README.md` (status, and the ledger:
0009 a permanent gap, 0011 and 0012 this spec's); `docs/specs/platform/caching.md`;
this spec's Implementation notes.

### Phase 10 — The contract (the release after)

Suggested agent: mechanic. After a release carrying phases 1–9 is deployed everywhere.

`migrations/0012_users_role_contract.sql`; `migrations.test.ts` loses the `users.role`
assertions (`:534-536`) and its `role` inserts (`:527-536,666`);
`users-contract.test.ts` is deleted, its premise now being the schema; `UPGRADING.md`'s 0012 entry,
repeating that 0011's release must be deployed first. The seeds need no change.

## Edge cases

- **A browser refuses the partitioned cookie** → the `check` step says so and posts
  `grant-blocked`; the admin offers *Open preview in a new tab*, whose top-level
  navigation sets a first-party cookie. Without the check an editor would approve a
  published page as their draft.
- **A shared page's preview** → the editor picks a site from `/me`'s `previewable`; the
  pane says "Previewing in Alpha".
- **A site whose preview origin is unset** (the `default` row after upgrade) → preview,
  draft mode and shares for it are unavailable and say why.
- **A registry edit seen late by another isolate** → at most ten seconds, read from the
  primary, and the second purge at 25 seconds covers what that isolate cached.
- **Hostnames in the registry but not routed to the Worker** → requests never arrive;
  the Sites screen says Cloudflare routing is separate.
- **A story moved between scopes** → refused: fork, then delete the original.
- **An untranslated site override** → *Override* on a translated field copies every
  locale's inherited value at once.
- **A `blocks` field overridden to empty** → `null`, written by *Remove*.
- **Two sites on one hostname under path prefixes** → a custom `resolve`; the gate still
  applies.
- **A form submitted on alpha whose form is shared** → recorded with `site_id =
  'alpha'`; the per-IP throttle stays deployment-wide.
- **An asset uploaded to alpha fetched on bravo's hostname by key** → served, as today;
  isolation is editorial, not adversarial.
- **An editor opens a shared page from their site scope** → read-only, with *Fork into
  Alpha*.
- **A role change during the 0011 deploy window** → lost; `UPGRADING.md` forbids it
  (decision 18).
- **`auth: 'open'` with `sites`** → every scope editable by anyone reaching the admin,
  every preview origin shows drafts without a grant, the registry open too;
  `createFolio` logs a warning.

## Testing requirements

**Unit (`test/unit/`):**
- `core/sites.test.ts` — chain, `sitesUnder`, `layerSeed`, `candidate`, `gate` (every
  cell of decision 4's table, a group or `shared` candidate refused), `layerId` /
  `singletonTypeOf`.
- `core/layers.test.ts` — every row of decision 8; `i18n` absent versus `null`.
- `core/mutations.test.ts` — `unset`.
- `core/schema.test.ts` — the type-name charset.
- `core/cache-tags.test.ts` — single-site byte-identical; the multi-site set from the
  resolution alone; degraded fallback.
- `server/cache-purge.test.ts` — `path:` fan-out; redirect changes; layer publishes;
  `purgeSite` twice.
- `server/sites.test.ts` — the snapshot TTL, primary read, write-side drop; every
  write-time validation and normalisation.
- `server/roles-from.test.ts` — per-scope highest match.
- (`users-contract.test.ts` is a workers test, below.)

**Workers (`test/workers/`):** `migrations.test.ts`; `multi-site.test.ts` (grown phase
by phase as listed); `scope-partition.test.ts`; `read-session.test.ts`;
`auth-login.test.ts`; `auth-session.test.ts` (grant revocation with foreign keys off);
`users-contract.test.ts` (until phase 10).

**End to end:** the existing twenty-two via `./scripts/e2e-all.sh`, from Phase 1 on,
are the single-site regression gate, seeds included.

**Not observable in this repository, and how each is checked instead:**
- **A cross-site iframe with a partitioned cookie** — phase 5 ends with a manual run on
  `http://localhost:5199` framing `http://alpha.localhost:5199` and on a deployment, in
  Chrome, Firefox and Safari 26.2, recorded in Implementation notes.
- **A hit keyed by `ctx.props`, and a purge reaching it** — `scripts/cache-probe.mjs`
  against a multi-site staging deployment: two hostnames and one preview origin, one
  path.

## Dependencies

- **Every spec that is done** is an input rather than a blocker; this spec changes 10
  and 28 (roles), 17 (tags, key), 21 (shares), 24 (MCP), 25 (draft mode), 29 (admin
  origin), 30 (`contentSql`), 31 (gate context), 32 and 33 (scoped tables).
- **Cloudflare:** each site's hostnames and preview origin routed to the Worker (or,
  for a separate front end, `{base}/*` and `_folio=` requests forwarded over a service
  binding); `enable_ctx_exports` and the cached-entrypoint split, with `props`.
- **Browsers:** CHIPS for the in-admin preview pane — Chrome, Firefox, Safari 26.2+.

## Out of scope

- **Multi-tenant SaaS.** Adversarial isolation is a different product.
- **Site-scoped account administration.** The central team administers accounts.
- **More than one level of groups, or a site in several groups.**
- **Attaching hostnames to the Worker from Folio.**
- **Per-site block registries and document types** (decision 7).
- **Record-over-reference merging** (decision 9).
- **Copying a page sideways between sibling sites.** Fork runs up the chain only.
- **Status gating of the content API's document reads** for a credentialed caller
  (decision 4).
- **Per-site theming of the admin.**
- **Moving a site between deployments.**

## Implementation notes

### Phase 1 (2026-09-29)

`0011_sites.sql` is the "D1 migration `0011_sites.sql`" block above, byte for byte,
under a header comment. Where the spec was wrong or silent:

- **"With foreign keys off" is not available.** D1 in workerd pins
  `PRAGMA foreign_keys` at 1: the statement is accepted and changes nothing, so
  `site_roles`' `on delete cascade` fires in every test whatever the batch does.
  (Ground truth's "`auth-session.test.ts` asserts it with foreign keys off" was
  already untrue at `133bb7f`; that file's passkeys test says so.) `deleteUser`'s
  explicit `delete from site_roles` is proven the way the passkeys delete is: a
  proxy records the batch's statements, the test asserts the delete is in it,
  unnarrowed by scope and ahead of the row's own, and then that no grant is left on
  either of two scopes. Removing the statement turns that test red and leaves
  `users-contract.test.ts`' own "no grant is left" assertions green: the cascade
  hides it everywhere a proxy is not watching. The same substitution governs
  phase 5's grant-revocation tests: revoke by an `update` that expires the session
  or token, so no cascade runs and only the join can refuse (owner, 2026-09-29).
- **`StoryMeta.site` is optional on the type**, not the `site: string` of Core
  types. Every row read from D1 carries it (`COLS` selects `site_id as site,
  forked_from as forkedFrom`) and `createStory` sets it, but a required field
  breaks the hand-built `StoryMeta` literals in eleven unit test files, which is
  the reason `schemaId` is optional too. A later phase that reads `story.site`
  reads it as `string | undefined` until those literals carry one.
- **Two tests outside the phase's file list pin what 0011 moves**, and the
  phase is not green without them: `test/workers/smoke.test.ts` lists every table
  (0011 adds four), and `test/unit/server/pure.test.ts` pins
  `redirectStatements`' bind list (it gains `site_id`). Ground truth's "Tests and
  seeds that pin what this spec moves" names neither.
- **`readSession` reads the `*` grant by a left join**, not decision 10's
  correlated `json_group_array`, which is phase 3's when grants on other scopes
  start to matter. A user with no `*` grant reads as `viewer`, the same
  fail-closed answer an unknown role gets; the statement count does not move.
- **`listUsers` reads the grant by correlated subqueries, not a join**: its keyset
  resumes over bare `created_at` and `id`, which `site_roles` also has.
- **`updateUser` writes the grant only when `role` is in the patch**, carrying
  `role_from` through as the old `update users set role = ?` did. A rename writes
  no grant. Every role write is an upsert on `(user_id, scope_id)`, so a user
  created by old code in the migrate-to-deploy window gets a grant from the first
  role change rather than an update that matches nothing.
- `auth/events.ts` reads no role and needed no change.
- **The index set before and after 0011 differs only by the intended re-keys**,
  asserted in `migrations.test.ts` over a database rebuilt from nothing inside the
  test (`0001`…`0010`, a row in every table 0011 alters or rebuilds and a user at
  every role, then 0011): thirteen indexes gain `site_id` as their leading column
  and are otherwise the same statement; `redirects`' primary key becomes
  `(site_id, from_path)`; the `unique` column constraints on `asset_folders.path` and
  `asset_tags.slug` (`sqlite_autoindex_asset_folders_2`, `_asset_tags_2`) become
  the named `asset_folders_path` and `asset_tags_slug`; `form_responses` gains
  `form_responses_site`; the four new tables bring eight named indexes and four
  primary keys. Every other index is unchanged, and every
  row of every touched table survives with `site_id = 'default'` (`api_tokens`
  null).

### Phase 2 (2026-09-29)

`src/core/sites.ts`, `src/server/sites.ts` and `src/server/routes/sites.ts` are new;
the chain-taking lookups, the served set, `Resolution.site` and `.path`, `handle()`'s
scope segment and host confinement, `withScope`, `folio.cacheProps`,
`folio.settings` and `folio.reader(env, req | { site })` landed as specified. A
published single-site page's `Cache-Tag` and `Resolution` are pinned byte for byte by
`test/workers/single-site-pin.test.ts`, written at `cb51211` before any of this.
Where the spec was wrong or silent:

- **Within one scope a redirect beats an unpublished row**, the reverse of decision
  5's order (live, unpublished → gone, redirect). `pathMiss` has always answered the
  redirect for a path holding both, `read-session.test.ts` pins it, and a single-site
  deployment is a chain of one scope whose answers must not move. Across scopes the
  two orders agree. `pickServing` walks: live serves, then that scope's redirect,
  then its unpublished row is `gone`, then the next scope.
- **`Resolution.site` and `.path` live in `src/core/resolve.ts`**, which the phase's
  file list left out. Two optional fields, absent with no `sites`.
- **Byte-identity at the Phase 1 head rested on scan order.** After `0011` put
  `site_id` first in `stories_path`, `resolve()`'s pass-one read
  (`id in (…) or path in (…)`) scanned the table and so answered in `rowid` order,
  and the story map serialises in insertion order. Binding the chain made both halves
  seeks, which reorders the rows; `storiesFor` therefore orders by `rowid` when a path
  is in the statement and by `id` (the primary key's order) when only ids are, and
  `listStories` unpaged by `rowid`. Ordering pass one by `id` alone turns the pin
  test red.
- **`withUrls` stayed one-argument**; `rt.urlsFor(site)` returns the site's
  decorator. `rows.map(rt.withUrls)` is the idiom, and a second parameter would have
  been handed the index. On a site with a preview origin, `previewUrl` and `draftUrl`
  are the live URL's path on that origin.
- **`HostResolveOptions` omits `site`.** Which site a render is for is the reader's
  to decide; a host passing one in could resolve another site's content.
  `ResolveOptions.site` is `SiteRender | null`, `null` being a multi-site render for
  no site (an empty chain, which resolves nothing).
- **`storiesFor` and `publishedDocsByIds` take the chain as an optional last
  argument**, not required. An id read is a primary-key seek whether or not it is
  scoped, and five callers outside `resolve()` (usage, bulk, versions, assets, forms)
  read ids a route already holds. A **path** read without a chain throws, because
  there it is both meaningless and a scan. Every read `resolve()` makes passes one.
  The path lookups (`storyByPath`, `storyStatus`, `pathMiss`, `pageAt`,
  `publishedDoc`, `lookupRedirect`) take it required and second, as the spec says.
- **A single-site render issues exactly the statements it did.** The lookups batch
  the redirect rows only on a chain of more than one scope: with one scope a redirect
  only matters where the story is not live, and every reader that skips it answers
  "nothing here" for such a row anyway. `pathMiss` always batches both, as before.
- **The gate's `req.path` is the path below `{base}`** (`'/site/enter'`), null
  outside it, and `grantFor` is the site a grant **or share** cookie verified for;
  phase 5 computes it. `handle()` passes the real path, so a draft site's preview
  origin answers the pre-grant paths now; nothing on it serves a page without the
  grant phase 5 adds.
- **A custom `sites.resolve` picks the site; the URL picks the surface**: `preview`
  exactly when the URL's origin is the chosen site's preview origin.
- **`folio.reader(env, { site })` is gated as that site's live surface**, so a
  sitemap build for a draft or preview-status site reads nothing.
- **Readers answer drafts only on a preview surface** on a multi-site deployment,
  whatever the cookie. Who may, there, is phase 5's grant.
- **`handle()`'s `?_folio=` branch hands every request back on a multi-site
  deployment**, for phase 5: `previewPage` (`pages.tsx`) resolves without a site, and
  drafts there need the grant.
- **`site_required` is not one of `errors.ts`'s codes**, so `requireScope`
  (`middleware.ts`) answers the envelope itself. It is mounted on no route yet: which
  routes are scoped is phases 3 and 7's to declare. `withScope` is mounted in `app.ts`
  ahead of `withActor`, which will need it.
- **The registry routes refuse to delete `default`** (409): its id is reserved
  against re-creation, so a deployment that deleted it could never have it back.
  Removing the scope's `site_roles` in the delete batch is phase 3 item 5; the purges
  and `siteChanged` are phase 7's.
- **Draft-mode globals on a multi-site deployment read only rows the chain already
  holds**, with no `ensureSingleton`, so rendering never writes. Until phase 4's
  layers a non-default site therefore sees no global at all.
- **`validateSites` requires `sites.admin` to be an origin with no path**, `https:`
  or `http:` on `localhost`; a layered type name may be at most 27 characters
  (`sng_` + name + `:` + a 32-character scope id within 64); `auth: 'open'` with
  `sites` logs a warning, as the edge cases ask.
- **`reader.tree()` on a chain is built by path**, not `parent_id`: an inherited
  `info/parking` under a site's own forked `info` has the shared Info as its parent
  row, and that row is not in the site's served set.
- **Deferred, with the phase that owns each:**
  - forms in `resolve()` are read by id with no chain (`forms.ts`, phase 7);
  - the redirect *writes* bind no `site_id` in their `delete` and `update`
    (`redirectStatements`, `deleteRedirect`), so on a multi-site deployment a rename
    on one site would rewrite another's redirects (phase 7, with the routes that call
    them);
  - the list readers (`listStoryLevel`, `listStoriesFlat`, `listDocumentPage`,
    `listRecentlyEdited`, `countStories`, `storiesMatching`) take a `scope` option
    defaulting to `default`, and `searchStories` a `chain`; no route passes one yet
    (phase 7);
  - call sites outside this phase bound to `SINGLE_SITE_CHAIN` until their phase:
    `routes/api/documents.ts` (by-path), `routes/editor.ts` (`/edit`'s root),
    `routes/redirects.ts` (the occupied check and the loop check), `routes/stories.ts`
    (`?ids=`/`?paths=`);
  - readers outside this phase that still scan since `0011`: `forms.ts` by name
    and the forms list, `asset-tags.ts` by slug and the tag list, `asset-folders.ts`
    by path and the folder list, and the asset lists in `assets.ts` and
    `asset-bulk.ts` (all phase 7). `test/workers/query-plan.test.ts` pins the hot
    story and redirect readers on a one-scope and a three-scope chain.

### Phase 3 (2026-09-29)

Effective roles, the platform tier, token binding, the reach 403 with its one
`reach: 'preview'` exemption, the id-loader fence, the socket's role and decision 17
landed. `test/workers/scope-partition.test.ts` walks every route Hono has mounted
(`app.routes`) three ways: platform refusals, `site_required`, and the 403 naming the
scope. Where the spec was wrong or silent:

- **`ADMIN` is the platform tier**, and the content acts it used to gate (a form's
  delete, its responses, the CSV) moved to a new `SCOPE_ADMIN`. The spec suggests a new
  platform constant beside an unchanged `ADMIN`. The reverse was chosen because an
  unexamined use then fails closed. One use is stricter than intended:
  MCP's `delete_document` declares `need: ADMIN` (`mcp/tools.ts`). A site admin
  therefore no longer sees that tool, and has to delete through v1. That is phase 7's.
- **Which routes are unscoped is a list in `middleware.ts`** (`UNSCOPED_API`,
  `UNSCOPED_PAGES`, `PREVIEW_REACH`), enforced once in `withActor`. `requireScope` is
  not mounted at each route. A new route is therefore scoped unless it is listed.
  `site_required` answers only under `{base}/api`: a page or `/mcp` with no scope reaches
  no row, because the fence has no scope to match. An unscoped route ignores a scope in
  the URL, and the person's role there is their `*` grant, or `viewer` with none.
- **`GrantActor` is defined, and `allows()` answers for it (`READ`, `READ_DRAFT`,
  nothing else), but it is not in the `Actor` union.** `/me` (`routes/auth.ts:755`)
  narrows `Actor` to two kinds and would not compile. Joining the union is phase 5's
  edit, alongside the credential that produces the actor.
- **On `site/start` a caller with no role on the site gets `viewer`**, because a
  `Role` cannot be empty. The route itself (phase 5) checks `previewEligible`.
- **A token bound to a scope that has since been deleted is a 403** at use.
  `deleteSite` does not revoke tokens bound to the site.
- **`readSession` keeps the `*` left join** for `role` and `role_from`. It adds the
  other grants as a correlated `json_group_object`, so the statement count stays one.
- **A write needs the row's scope to equal the request's**, not merely to be a scope
  whose grant writes it. A north grant writes alpha's rows under `~alpha`, and under
  `~north` those rows are not there.
- **Narrower than the spec until phase 7:**
  - duplicate (admin and v1) is write-fenced (source in the request's scope, not
    only its chain), because `duplicateDocument` still lands the copy in the source's
    scope;
  - a bulk selection by filter (`all: true`) is `501` on a multi-site deployment,
    because the filters read `default`;
  - the share mint's loader is write-fenced, and decision 13's minting rule is phase 5's.
- **Not fenced yet: the asset, folder, tag and form id loaders.** Their readers
  (`assets.ts`, `asset-folders.ts`, `asset-tags.ts`, `forms.ts`) do not return
  `site_id`, and those files belong to phase 7.
- **`{base}/preview/global/:name` is a 404 on a multi-site deployment until phase 4**.
  It would otherwise create `default`'s layer for anyone.
- **Decision 17's registry check reads `sites` from D1 inside `completeSignIn`.** There
  is one statement, and only when a mapper named a scope other than `*`: the sign-in
  routes that call it are not phase 3's, so they could not pass a snapshot. `shared` is
  always known. A dropped scope logs a warning and rides on the `sign_in` (or
  `sign_in_refused`) event's `detail` as `dropped`. `role_changed` keeps `{ from, to }`
  as roles when both sides are a lone `*` grant, and records both sets otherwise.
- **`validateSitesAuth` runs where the registry routes are built** (`routes/sites.ts`),
  which `createFolio` does at construction. Its place is beside `resolveAuth` in
  `validateSites`, but `runtime.ts` belonged to phase 6 in this run.
- **`/users` carries `grants`**, each entry with its `roleFrom`, sorted by scope.
  `POST /users` and `PATCH /users/:id` accept `grants` (the whole set) on a
  deployment with `sites`, and refuse them without one. A body naming both `role` and
  `grants` is a 400. If any grant in the set was placed by a provider, a hand edit of
  either field is a 409. `POST /tokens` takes `site`: it must name `shared` or a
  registry row (never `*`), is refused with `admin`, and is refused on a single-site
  deployment.
- **`deleteSite`'s grant delete is proven by the rows alone.** No foreign key names
  `site_roles.scope_id`, so there is no cascade that could hide a missing statement.
- **Not exported from `folio/server` yet:** `SCOPE_ADMIN`, `Grants`, `GrantActor`,
  `RoleGrants`, `RoleTarget` (`index.tsx` was outside the phase's files). `/me` does not
  yet carry `scopes`, `previewable` or `platform` (the route table's `/me` row).

- **After the phase 3 review (2026-09-29)**, six findings were fixed:
  - **MCP is scoped.** A bare `{base}/mcp` with no scope and no binding is
    `400 site_required`. Dispatch sets the internal scope header from its own
    `c.var.scope`, never from the client. `preview_document`, MCP's one direct
    loader, is fenced (read), so a story outside the chain is an unknown document.
    `delete_document` is `SCOPE_ADMIN` (it was `ADMIN`, which is now platform tier).
  - **The form id routes are fenced** (`fenceForm`, reading `forms.site_id`). A form
    read up the chain is allowed. Its responses (list, CSV, one response, its file,
    the deletes) need the form in the request's own scope, even to read: up the chain
    they would be every site's submissions to a shared form. That is a narrowing
    until phase 7 scopes responses by submitting site.
  - **Shares follow their story's scope.** `GET /shares` lists the scope's own, and
    `DELETE /shares/:id` refuses another scope's. `shares.site_id` is not used,
    because it is the render site, which phase 5 sets.
  - **A parent outside the chain is a 404** (`fenceParent`, on every create, move,
    duplicate and bulk move). The request routes check it before `createStory` or
    `updateStoryStatement` runs, so their 409 naming the parent only answers for a
    parent the caller can read. Those two functions have no registry to tell the
    two cases apart.
  - **`POST /users` on a deployment with `sites` needs `role` or `grants`**. The old
    default is an `*` editor, which there would be an editor on every site.
  - **`scope-partition.test.ts` accounts for every mounted route with an id
    parameter**: it is fence-tested, unscoped by design, fenced and tested
    separately (the socket, the editor page), or on a deferred list. The deferred
    list is the asset, folder and tag id routes, the redirect delete and the public
    form submit (phase 7), and `/preview/global/:name` (phase 4). Fencing one fails
    the test until it leaves the list.
  - **Still open, and phase 7's:** the list readers the review named (schedules,
    redirects, `/published`, the story and document lists, content, search), usage
    counts naming other sites' pages, form creation and `/forms/resolved` (not in
    scope), the space channel, and `roleFromClaim`'s `default` as a `*` grant.

### Phase 6 (2026-09-29)

- **`cacheTags` reads `resolution.site` and `resolution.path`** and emits decision 15's
  set; without `site` the code path is the old one, and `single-site-pin.test.ts` plus an
  exact-array test in `cache-tags.test.ts` pin it. The scoped builders (`siteTag`,
  `scopedGlobalTag`, `scopedTypeTag`, `scopedAnyTypeTag`, `pathTag`) are exported from
  `core/cache-tags.ts` and are the only spelling either end uses. The shared layer's tag
  is the unscoped `global:<name>`; every other chain scope gets `@<scope>`, whether or not
  the layer exists. `path:` values are `encodeURIComponent`ed like every other tag, so
  `stores/a` is `path:alpha:stores%2Fa`.
- **A degraded page keeps `site:<id>`, its `path:` tag and its own `story:`.** The path
  tag is kept because a path change is one of the things that must still reach it.
- **The purger takes `sites?: { registry, layered }` as a fourth parameter**, wired at the
  one construction line in `runtime.ts`. With it, `published`, `unpublished` and `updated`
  (title) purge the owner's scoped set with `path:` fan-out through `sitesUnder`; a layer
  of a configured global purges only its layer tag (plus `story:`). A registry that cannot
  be read flushes (`purgeEverything`) rather than guess a fan-out.
- **`checkpointed` still purges nothing.** The plan lists it among the scoped events, but a
  checkpoint publishes nothing, so no cached page describes it; giving it a purge would
  flush pages on every autosave-adjacent checkpoint for no staleness. Left as it was.
- **Purge functions return what they issued** (`{ tags } | { everything: true }`), also
  when the capability is absent, so phase 7 can put it in the payload's `purge`.
  `purgeSite(id, waitUntil, opts?)` is exported and purges `site:<id>` now and after
  `SITE_PURGE_DELAY_MS` (25 s) under `waitUntil`; nothing calls it yet (phase 7).
- **Left to phase 7:** the owner-scoped `deleted`, `pathsChanged` and `redirectsChanged`
  purges. They still emit today's unscoped tags on a multi-site deployment: `story:<id>`
  is right, the unscoped `type:` and `global:` tags reach nothing a multi-site render
  carries, and the `path:` tags are missing.

### Phase 4 (2026-09-29)

`unset`, `PROTOCOL_VERSION = 5`, `core/layers.ts`, layered `resolve()` and
`reader.global`, bare layer seeding, `opts.layer` on the nested shape, the per-site
audit check and `/preview/global/:name` on multi-site landed as specified. Where the
spec was wrong, silent or split across files it did not name:

- **`layerSeed` and `layerId` were already in `core/sites.ts`** (phase 2), with the
  registry as a parameter; `core/layers.ts` holds `mergeLayers`, `layerStates` and
  `isBareLayer`. `isBareLayer(id)` is `layerSeed` answered without a registry, for the
  callers that hold a story id and no snapshot (`draftFor` seeds the object): every
  scope in a registry has `shared` below it except `shared` itself, so the two agree.
- **`default` seeds bare on a multi-site deployment.** Decision 8 says `default`'s
  `sng_<type>` seeds "exactly as today", but "the test is the chain, not the id", and
  on a multi-site deployment `default` is an ordinary site row whose chain is
  `default`, `shared`. The chain test wins: a `default` layer created there is bare and
  inherits `shared`. A deployment with no `sites` seeds exactly as before.
- **The seed is chosen in `draftFor`, not in `ensureSingleton`.** `ensureSingleton`
  creates only the D1 row; how the layer's document starts is decided where its Durable
  Object is first touched (`draftFor`, `draftForWithSyncId`, `draft`, through
  `seedFor`), so every path that opens a layer agrees. `stories.ts` needed no change.
- **`mergeLayers` of a chain of one returns that layer, the same object.** That is the
  byte-identical single-site guarantee. A longer chain is always rebuilt, so a `null`
  in the lowest existing layer reads as no value rather than as a stored `null`.
  Merged `data` drops a removed key rather than storing `null`; the merged root keeps
  the most specific layer's uid, and an inherited child is re-parented under it.
- **A removed source field drops the lower layers' translations of it.** The spec is
  silent; a translation of a field with no value has nothing to translate and would
  otherwise render French for a field the site removed.
- **`layerStates` keys nested fields as `slot.field`** for a `max: 1` child that merges
  into the inherited one, and reports `from: null` for a field nothing below holds.
- **`diff` needed a layer mode, and so did `writeDocument`.** `diff` reads an absent
  key and `null` as the same thing, so `PUT /content` on a bare layer could neither
  remove a field (`null` from absent produced no mutation) nor reset one (a vanished
  key was written as `null`, i.e. removed, not inherited). `diff(from, to, { layer:
  'bare' })` reads presence: a vanished key is an `unset`, an appeared one a `set`
  even of `null`, in `data` and in every locale map. `writeDocument` takes the same
  option. Beyond the spec's file list, and necessary for `opts.layer` to have any
  effect over the API.
- **`toNested` takes `layer: 'bare'` too**, reading a removed slot as `null` where an
  inherited one reads `[]`, so a read-modify-write keeps what the layer removed.
- **A v4 wire consequence:** `invert` of a `set` on an absent key is now an `unset`, so
  an undo restores absent rather than leaving `null`. Two `store.test.ts` expectations
  and five `mutations.test.ts` ones changed with it; `history-model.ts` describes an
  `unset` ("Reset ...").
- **`/preview/global/:name` lives in `routes/editor.ts`.** On a multi-site deployment
  it shows the request's own scope's layer and only if its row exists: no row is a 404,
  never an `ensureSingleton`, and no scope is a 404. It is listed in
  `scope-partition.test.ts`' `FENCED_ELSEWHERE`, with its own cases, since it takes no
  id a URL could point at another scope with.
- **The settings type is loaded as a global on a multi-site deployment**, deduplicated
  against `globals` (`sites.layered`), so `Resolution.globals` is `{}` rather than
  absent when nothing is published.
- **The audit's per-site check is `AuditReport.settings`**, present only on a
  deployment with `sites` and a settings type: one entry per site per `required` field
  with no value in the merged published settings (`auditSettings`), read in one
  statement for every layer of every site. A bare layer is exempt from `missing-field`.
  `rt.auditContext(env)` builds the context for both `folio.audit` and `GET /audit`.
- **`validateSitesAuth` runs in `validateSites`**, beside `resolveAuth`, and no longer
  where the registry routes are built.
- **The purge lines are tested through `cachePurgeHooks` with the runtime's own
  `sites.layered`**, not by a publish through the API: the publish hook's purge
  capability is the platform's, which a test cannot observe.

### Phase 5 (2026-09-29)

`src/server/auth/grants.ts` and `src/server/routes/handoff.ts` are new; decision 13's
four-step trace, the grant cookie, `GrantActor` in the `Actor` union, the gate's grant
and share admission for a draft site's preview origin, `_folio_id` with its banner,
`frame-ancestors`, site-bound shares, MCP's token grant and the cache bypass landed as
specified. `test/workers/handoff.test.ts` walks the trace one step per section, then the
"Preview across origins" criteria and the draft-site rows of "Registry and status".
Where the spec was wrong, silent or split across files it did not name:

- **The browser matrix moved to the plan's Phase V.** "Testing requirements" puts a
  manual run in Chrome, Firefox and Safari 26.2 at the end of this phase. No test here
  can observe a partitioned cookie in a real browser, and a deployment is the first place
  one can be seen, so both passes (same-site, then cross-site through a `workers.dev`
  preview origin) run there. The accepted cost is that a browser-level defect is found
  after release and fixed forward.
- **Revocation is proven by `update`, never `delete`** (owner, 2026-09-29). D1 in
  workerd pins foreign keys on, so "with foreign keys off" is not available. Each
  `readGrant` refusal test expires the session, revokes, rebinds or narrows the token, or
  moves the holder's `site_roles` row off the chain, all by `update`, with every row
  still present, so only the statement's own conditions can refuse
  (`auth-session.test.ts`, "readGrant"). `site_grants` declares no foreign key, so the
  deletes that keep the table small are proven twice: a proxy records each `batch` call
  as SQL and asserts the grant delete and the session delete went in one batch, grants
  first, for every path in `session.ts` and `users.ts`; and the Access-screen and SSO
  role changes are proven by the rows alone through `handle()`, since nothing but the
  batch can remove them.
- **There are eight `delete from sessions` paths, not seven.** Ground truth lists
  `session.ts` (five), `sign-in.ts` and `users.ts`. `routes/access.ts`' grant-set
  replacement (`PATCH /users/:id` with `grants`) deletes the user's sessions too. It,
  `sign-in.ts` and `revokeUserSessions` batch `userSessionsDelete` (`session.ts`), which
  is the grants delete and then the sessions delete. `users.ts`' `deleteUser` spells the
  two statements out rather than importing `session.ts`, which imports it.
- **Grants are read on a `first-primary` session.** A grant is written on the primary by
  `site/enter` one redirect before the first page asks for it, and a replica behind that
  write would refuse it, so the pane's first render would show the published page as the
  draft. `PreviewSite.db` carries that session; only a request with a grant cookie on a
  preview origin pays the primary round trip. On a `draft` site's preview origin a
  `?_folio=` render reads the grant twice, once for the gate and once for the actor.
- **The consume statement also writes the grant's expiry.** It is still one `update …
  where code_hash = ? and site_id = ? and expires_at > ? returning …`. `expires_at` is a
  `case`: for a session grant, the earlier of a day and the session's own expiry (read by
  a subquery); for a token grant, five minutes.
- **`withActor` resolves a grant only for a read on a preview origin's v1 routes or
  `draft/enter`** (`GRANT_READS`, `middleware.ts`). Anywhere else a grant cookie is no
  credential, so the request is as anonymous as it would be without it. This is a
  second fence below `handle()`'s host confinement, and each is tested on its own: a walk
  over every mounted route asserts the grant cookie changes no status except on that
  allowlist, and `handle()` answers `null` for an admin route, a socket and `/mcp` on a
  preview origin. `resolveActor` tries the session cookie, then the grant (when told the
  preview site), then the bearer header, so a headless front end forwarding a visitor's
  `Cookie` reads that visitor's drafts whatever its own token holds.
- **The candidate step is exported** (`candidateFor`, `server/sites.ts`) so `handle()`
  and the reader can gate a refused preview-origin request again with the grant or share
  it carries (`routeGranted`, `index.tsx`). Only a draft site's preview origin is ever
  refused there, so only its requests pay for the second look, and none without a cookie.
  Under `auth: 'open'` every preview origin is admitted without a grant, as the edge
  cases say.
- **`site/start` checks eligibility before it checks the preview origin**, so a caller
  who may not preview a site learns nothing about how it is set up. Its refusal does not
  quote the site id, which is how `scope-partition.test.ts` tells it apart from the scope
  403 every other route answers. A group, `shared`, or no scope at all is not a site and
  answers 404, or 400 for no scope. A site with no preview origin is a 409 saying so.
- **Share minting names its render site with `?site=`**, not a body field. The body's
  schema (`ShareCreateBody`, `validate.ts`) is the single-site one, and valibot drops a
  field it does not know without a word. `?site=` defaults to the request's scope when
  that is a site; it must be in `sitesUnder` of the story's scope and have a preview
  origin. A redeemed link on a multi-site deployment lands on Folio's draft render on the
  preview origin with `_folio_id` naming the story, so the one page the link covers
  renders even where a nearer scope shadows its path. With `draftMode` it lands on the
  page's own path on the preview origin.
- **`auth/shares.ts` and `routes/mcp.ts` changed, beyond the phase's file list.**
  `createShare` writes `site_id`; `readShareByToken` and `claimShare` take the gated site
  and require it; `shareAdmitsSite` is the gate's share check. MCP's `previewContext`
  passes the scope, the actor and the registry to `shot.ts` on a deployment with sites.
- **MCP's `preview_document` renders on the request's scope when that is a site, else on
  the story's own site.** A shared or group page from a shared- or group-scoped call is
  answered with a sentence naming the sites to call it from. The grant is the token's for
  a token caller and the session's for a person. A fresh code is minted per capture
  attempt, because each attempt is a new browser. A global's bare preview is an
  admin-origin route behind a session, so on a multi-site deployment it degrades to the
  rendered HTML rather than being photographed. With no `browser` binding nothing is
  minted and the answer carries the plain preview-origin draft URL.
- **`check=1` tests the cookie's presence, not its validity.** The step asks whether the
  browser kept the cookie; what the grant is worth is `readGrant`'s, on the page itself.
- **The grant cookie is `Secure` under both names.** `SameSite=None` and `Partitioned`
  both require it, and `http://localhost` is a secure context that keeps a `Secure`
  cookie.
- **`folio.sweepAuth` sweeps `site_grants` without counting them.** The report's shape is
  `Folio.sweepAuth`'s public type in `types.ts`, and the sweep also drops grants whose
  session or token is gone or revoked.
- **The admin bridge and preview mount take the origins; the pane's wiring is phase 8's.**
  `usePreviewBridge` accepts `origin` (the site's preview origin: it hears only that
  origin, and only from its own iframe, and posts only to it), `onGrantBlocked`, and
  exports `paneSrc` for the pane's `site/start` URL. `preview/mount.tsx` posts only to,
  and hears only from, `__FOLIO__.admin`, which `previewPage` writes into the bootstrap on
  a preview origin. Passing the site's preview origin, routing the pane's `src` through
  `paneSrc` and offering *Open preview in a new tab* on `grant-blocked` are the editor
  screen's (`useEditor.ts`, `EditorShell.tsx`), beside phase 8's "preview in" site picker
  from `/me`'s `previewable`. Until then a multi-site admin's pane does not show drafts.
- **A token grant's binding must reach the site.** A token bound to `shared` cannot
  preview a shared page on alpha, because it cannot reach `~alpha` at all
  (`tokenScopesOn`). A person's shared grant can, by decision 13's whole-chain rule.

- **After the phase 5 review (2026-09-29)**, seven findings were fixed. Each has a
  permanent test that goes red when its fix is removed:
  - **Every draft authority on a preview origin is held to decision 13 for the gated
    site** (critical). The render paths asked `allows(actor, READ_DRAFT)`, which ignores
    the scope, so a bravo editor's session, a person with no grant at all, and a
    bravo-bound `content:read:draft` token all read alpha's drafts through `?_folio=` and
    `reader.page()`. `mayPreviewDrafts(actor, registry, site)` (`auth/roles.ts`) is now
    the one rule:
    - a grant must be for the site;
    - a person must hold `READ_DRAFT` on a scope of its chain or `*`;
    - a token's binding must reach the site, with `content:read:draft` there.

    `?_folio=`, `reader.page()` / `draftAt()` and draft mode's switch ask it. v1
    `?status=draft` reaches the same answer through `scopedActor` and `ensureAccess`, and
    `handoff.test.ts` asserts the two agree for every credential kind.
  - **A session that may not preview the site no longer hides the grant.** On a preview
    origin, `resolveActor` keeps a session only if `mayPreviewDrafts` admits it. Otherwise
    it tries the grant, then the bearer token.
  - **`frame-ancestors` never replaces a policy a route set** (critical). It had
    overwritten `{base}/asset/:key`'s `default-src 'none'; sandbox`, so an uploaded SVG
    ran script as the preview origin, beside the grant cookie. An asset's policy is now
    byte-identical on every surface.
  - **`safeNext` refuses every form a browser normalises into another host**, for every
    caller, login included, which predates this spec. That covers any C0 control or DEL
    anywhere (the URL parser strips tab, newline and carriage return), a backslash
    anywhere, leading whitespace, and percent-encoded forms that decode to any of these
    or to `//`. The value must also parse against a placeholder origin and keep it.
    `/\t/evil.example` was the case that got through.
  - **A share on a draft site admits only its own story.** The gate admits a share only
    for a host path at which it covers a story (`sharedStoriesAt`). A reader so admitted
    reads nothing but that story, as its draft: its chain is empty for every other
    lookup, and `page()` / `draftAt()` refuse any other id. One link could otherwise
    browse a whole unlaunched site through a host route.
  - **MCP's grant is five minutes whoever calls.** A session caller's screenshot minted
    a day-long grant. A short grant is marked by its id prefix (`sgs_`), which the
    consume statement reads, because `0011` has landed and a column would be a new
    migration for one flag.
  - **With `draftMode`, a share lands on its own story.** When a nearer scope's fork
    shadows the story's path on the render site, the link lands on Folio's draft render
    of the story by `_folio_id`, not on the host's page, which would render the fork.
  - **A share-admitted reader still reads its site's globals** (re-review, 2026-09-29).
    Its empty chain had made `reader.global()` null, so a shared pre-launch page rendered
    with no header or navigation. `global()` now reads the gated site's whole chain, the
    same one `page()` resolves with, and reads published layers only: the share drafts its
    one story and nothing else. `tree()`, `stories()` and `query()` stay empty for such a
    request, because a listing would enumerate a pre-launch site. `FolioReader`'s doc
    comment in `types.ts` says so.
- **After phase 9 (2026-09-29)**, `reader.page()` / `draftAt()` on a preview origin treat
  a presented credential as the ask, as step 4 says: a grant, session or token that
  `mayPreviewDrafts` admits gets the chain's drafts by `pickEditing` with no draft cookie,
  `no-store`. Until then a grant alone only authenticated and the host route still needed
  `{base}/draft/enter`'s cookie. Live hosts and single-site are unchanged; a share keeps
  its one-story restriction. `handoff.test.ts` "gives reader.page() the draft for a grant
  alone" and its two neighbours, and `draft-mode.test.ts` "gives reader.page() no draft
  for a session without the draft cookie", pin it.

### Phase 7 (2026-09-29)

Assets, folders, tags, forms and responses, redirects, the schedules, published and
shares lists, the story and document lists, content, search, the v1 API (three new
routes), MCP, the space channel, hook payloads, the three remaining owner-scoped
purges, `siteChanged` and the fork route landed. `test/workers/scope-partition.test.ts`'s
deferred list is empty and asserted empty; `api-partition.test.ts` pins the v1 surface
as a list. New tests: `multi-site-fork.test.ts`, `multi-site-library.test.ts`,
`multi-site-headless.test.ts`, `test/unit/server/hooks-purge.test.ts`, and additions to
`query-plan.test.ts` (every new list reader and scope-bound write, on the single-site chain and a site in a group, none a `SCAN`). Where the spec
was wrong, silent or split across files it did not name:

- **`storiesFor` and `publishedDocsByIds` take the chain as a required argument.**
  `null` means *every scope* and is written out at the six places that ask for it: the
  three usage readers (`documentUsage`, `assetUsage`, `formUsage`, which read a row
  wherever it lives and then split it into *named* and *counted*), `listRecentPublishes`
  and the bulk id batch (both already fenced by the route or by the statement), and the
  platform audit. A path read with `null` still throws. `assetsFor`, `countAssets`,
  `assetsMatching`, `listAssets` and `listAssetsByPage` take an `AssetScope`
  (`readonly string[] | null`) the same way, defaulting to the single-site chain; only
  the platform tier's describe run passes `null`.
- **Write functions default their scope to `default`; the routes always pass it.** That
  is phase 2's pattern (`createStory({ site })`, `ensureSingleton(…, scope = DEFAULT_SITE)`),
  kept so a single-site caller and every existing test are unchanged. The proof that a
  route passes it is not the default: it is `scope-partition.test.ts` walking every id
  route and `multi-site-library.test.ts` writing through each as a site with a sibling.
- **Defence in depth on writes.** An asset, folder, tag or form id route is fenced by
  middleware (`fenceRow`, `fenceForm`) **and** its statement binds `site_id`
  (`update … where id = ? and site_id = ?`, `ownFolder`, `ownTag`), so a fence that is
  ever dropped from a mount still cannot act on another scope's row. The break-its show
  it: dropping the middleware from a body-less `DELETE` (a folder, an asset) leaves the walk
  green, and only removing the statement's binding as well turns it red. A route that
  parses a body first (a tag's `PATCH`) turns red on the missing fence alone, its 404
  having become a 400. The read routes have the middleware alone.
- **Redirect writes bind the scope in all three statements** (`redirectStatements`
  now requires `site`), and `DELETE /redirects/:from` and the list bind it too. A rename
  on `alpha` used to delete `bravo`'s redirect away from the new path and rewrite every
  `bravo` redirect that pointed at the old one.
- **A fork's rename redirect outlives the fork.** Renaming a fork writes `stores →
  our-stores` in alpha's scope, and deleting the fork does not remove it (it never has:
  `redirect=false` only stops a *new* one). That redirect still beats the inherited page
  (decision 5), so "WHEN it is deleted THEN alpha serves the shared `stores` again" holds
  only once the redirect is removed too; the test does that through `DELETE /redirects/
  stores`. Whether deleting a page should clear the redirects that point at it is a
  question for `redirects.md`, not this phase; it is the same on a single-site
  deployment. (The delete's own auto-redirect is fixed: see "After the phase 7 review".)
- **Hook payloads.** `HookBase` gains `site` (the owning scope; `default` on a
  single-site deployment; `null` for `migrated` and `reindexed`, which touch every scope)
  and `purge`. The runner fills `site` from the emitter or the story, and `purge` from the
  **return value of the internal purge hook**, so it is the record of the act and not a
  second computation. Every purge function already answered what it issued (phase 6);
  `reindexed` now does so without a platform too. `redirectsChanged` and `siteChanged`
  are registered on the purger only on a deployment with `sites`, so a single-site
  deployment's internal hook set is what it was. Single-site payloads gain `site:
  'default'`, which is additive; two runner tests that pin a payload exactly moved.
- **`siteChanged`** carries `{ site, kind, change, row }`, `row` being the registry
  entry after the write (`null` once deleted), and Folio's own hook for it is
  `purgeSite`: `site:<id>` now and again 25 seconds later, under the request's
  `waitUntil`. It is the hook rather than a call from the route so that `purge` on the
  payload is what was issued. `purgeSite` schedules no second purge when there is no
  platform to purge on: it would be the same no-op, held open for 25 seconds.
- **`deleteSite` also deletes `site_grants` and `shares` naming the site as their render
  site**, in the same batch. `shares.site_id` is not a foreign key, and a link can never
  redeem on a site that is gone.
- **The fork** is `forkStory` (`stories.ts`) behind `POST /stories/:id/fork`. It copies
  the source's published document (its draft when nothing is published) with fresh uids
  and records `forked_from`. It is refused with a 409 for a parent the site does not own,
  naming it ("Fork Info first"), for a site that already has a page at the path, for a
  page the site already owns, and for a second root; a record is a 400 and a page outside
  the chain a 404. It takes `CREATE` on the scope, so a viewer is a 403.
- **"The shared version has changed since you forked it"** is `forkedSince` on each
  `GET /inherited` row and `changed` on the new `GET /story/:id/fork`. `stories.created_at`
  is in **seconds** and `published_at` in milliseconds; the comparison treats the fork's
  whole creation second as "before", so a source published in the same second a fork was
  made is not news. Both routes mount only on a deployment with `sites`, as does the fork.
- **Duplicate is "source in chain, copy in scope"** (admin, v1 and bulk). A copy in another
  scope than its source's has no parent of the source's to sit under, so it lands at the top
  unless the caller names one of the scope's own. Share minting needed no change: phase 5's
  `?site=` already lets `~shared` mint on any site under it.
- **Bulk filter selections are scoped, not refused.** `BulkOptions.scope` is what a
  captured filter is counted and walked against; the `501` is gone. An explicit id list is
  checked against the scope (a duplicate against the chain) before the run starts, whole.
  The same for `AssetBulkOptions.scope`, whose tags and folder must also be in it.
- **Responses are a read of the form's chain, narrowed by the submitting site.**
  `form_responses.site_id` is now written (`POST /f/:id` records the live host's site) and
  every response reader takes the sites it may see: undefined on the form's own scope, the
  sites the request's scope reaches otherwise. The duplicate window is per site, so the same
  answer on two sites is two responses. `POST /f/:id` needs a live host of a site with the
  form in its chain; the admin origin, a preview origin and a sibling's form answer the
  unknown-form reply. `submitted` carries the receiving site, which is not always the
  form's owner.
- **Forms in `resolve()` are read within the chain.** `formsByIds` takes it (default the
  single-site chain), as does `/forms/resolved`; a form outside it resolves like a deleted one.
- **Usage counts.** The three usage routes name the uses in the chain and add `elsewhere`, a
  count of the uses in scopes outside it (multi-site payloads only). A form's `responses` and
  `files` in that payload are the submitting sites' the caller may see.
- **`GET /assets` and `GET /forms` take `?chain=1`**; the folder and tag lists are the scope's
  own. Tagging and filing across scopes are refused (`Unknown tag`, `Unknown folder`), and
  the describe run's model is offered only the asset's own scope's tags (`DescribeDeps.scoped`),
  with `addAssetTags` joining an asset only to a tag of its own scope in the statement itself.
- **URLs are the request's site's.** `requestUrls` (`middleware.ts`) hands a route
  `rt.urlsFor(site)` for a scope that is a site, so the admin's `url` and `previewUrl` are the
  host's `route()` answer for that site and its preview origin, not a path on the admin origin.
- **The v1 additions.** `GET /api/v1/sites/resolve` and `GET /api/v1/sites` are unscoped and
  `READ`; a token bound to a scope sees that scope's sites only, and resolves no others. A
  host is tried as `https` and then `http`, through the same `candidateFor` a first request
  takes, so a custom `sites.resolve` sees what it would see there. `GET /~<site>/api/v1/pages/
  {path}` is `reader.page()` over HTTP through an internal `GatedReaderFrom` (not public API):
  the route runs the status gate once (`routes/api/served.ts`) and hands the gated row in, so
  the gate is in one place. **The status gate reads "unless the caller holds `READ_DRAFT` on
  the site's chain or a grant" as an override on both surfaces**: `mayPreviewDrafts` callers
  are admitted whatever `?surface=` says, being able to read the site's drafts anyway.
  `folio-cache-tags` is absent for a draft and for a page the visitor gate did not call public.
  `documents/by-path` applies the same gate. `ApiDocumentMeta.site` is sent on a multi-site
  deployment only. None of the three routes exists on a single-site deployment.
- **The space channel.** `spaceNameFor(scope)` is `space` for `default` and `space:<scope>`
  otherwise, used by `rt.space(bindings, scope)`, the socket route and the broadcast hooks,
  which name the story's own scope from `payload.site`.
- **`roleFromClaim`'s `default` is refused at construction on a deployment with `sites`.**
  Decision 17 is silent on it, and a bare role for "anybody the map does not name" is a grant
  on `*`: the same hazard `validateSitesAuth` already refuses for `provision.role`. A
  `roleFromClaim` mapper records its bare `default` in a `WeakMap` (`defaultRoleOf`) so the
  opaque function can be checked. A scoped `default` was not added.
- **Beyond the phase's file list**, all necessary and none a design change: `validate.ts`
  (`root` on the create bodies), `schedules.ts` and `versions.ts` (a `scope` on the two list
  readers, as a correlated `exists` on `stories`' primary key), `bulk.ts` (`scope`),
  `describe.ts` (the scoped vocabulary and the tagging guard), `reindex.ts` and `migrate.ts`
  (`site: null`), `audit.ts` (`null` chain), `middleware.ts` (`fenceRow`, `requestUrls`,
  `requestSite`, `chainResolver`), `types.ts`, `index.tsx`, `app.ts` and `runtime.ts`
  (the reader factory, forms in `resolve()`), and `test/unit/server/pure.test.ts`,
  `test/unit/server/cache-purge.test.ts` and `test/workers/stories.test.ts`, whose pinned
  payloads and calls moved.
- **Left, with the reason.** `form_responses` submitted from a site that is later deleted keep
  their `site_id` (the delete refuses on `forms`, not on responses, as decision 1 lists);
  they are the form owner's to read. `folio.sweepAuth` still does not count `site_grants`.
  The stale comments named in the carry-forward at `mcp/tools.ts` were already corrected by
  the phase 3 review.

#### After the phase 7 review (2026-09-29)

The review found no cross-site read or write. Four problems, fixed:

- **A delete no longer writes a redirect at a path a scope above still serves.**
  `deleteStoryStatement` skips the auto-redirect for a row whose path a scope further up
  the deleting story's chain serves (a non-draft story there, or a redirect there), so
  deleting a fork, or any page that shadows an inherited one, falls back (decision 5)
  through the admin Delete, v1, MCP and bulk delete alike, on their default `redirect`.
  Elsewhere the redirect is written as before, and a single-site chain has nothing above
  it, so single-site is unchanged. The fork test now uses the default flag, top level and
  nested. (A rename's redirect is a different thing and still outlives its fork.)
- **Usage names every scope the caller can read.** `readableScopes` is the request's
  chain plus every scope the caller holds a role on (a platform admin reads all); the
  rest are counted in `elsewhere`. The routes' comments now say so.
- **`deleteSite` is an extension of decision 1's list.** It also deletes every
  `api_tokens` row bound to the scope (and the preview grants minted from them) in the
  same batch, and is refused while any `form_responses` row carries the site id, the error
  naming `form_responses`, so a re-registered id revives neither. The earlier note that
  responses were "left" is superseded.
- **The `byPath` comment** now says the status gate covers only the page-shaped reads,
  `/pages` and `/documents/by-path`, and deliberately not `/documents`, `/documents/:id`
  or search for a credentialed caller (decision 4). No behaviour change.

Single-site hook payloads gain `purge` (when the event purged anything, and `reindexed`
even with no platform) as well as `site: 'default'`; both are additive.

### Phase 8 (2026-09-29)

The admin: the scope in the URL and the API, the switcher, the Sites screen, inherited
pages with Fork and *Create home page*, the fork and override notices, the pane on the
handoff, the layer labels, the grants on the Access screen, and chain pickers. Nothing
in `src/server/` changed except `/me`. New tests: `test/unit/admin/multi-site-admin.test.ts`
(the models, in Node), `test/unit/admin/render/multi-site.test.tsx` (the shell, the
Sites screen, the inspector and the pane, mounted), `test/unit/server/me-sites.test.ts`
and `test/workers/me-sites.test.ts`. Where the plan was wrong, silent or reached past
the files it named:

- **The scope is part of the mount.** `route.ts`'s `splitScope` reads `{base}/~<scope>`
  once and `Admin` hands every screen a mount and an `apiBase` that already carry it, so
  `parse`, `href` and the forty places that build a link needed no change, and a
  single-site URL splits to the bare mount it always was. **Changing scope is a page
  load** (`switchScopeUrl`), not a state change: a scope's lists, open document and
  socket cannot outlive it, and `useRouter` refuses to take over a link into another
  scope (`isInsideMount`). Rejected: a `scope` field on `Route` threaded through every
  `href` call, which is the same fact in forty more places. The one component handed
  only `apiBase`, a picker, learns its scope from it (`scopeOfApiBase`).
- **`/me` gains one key, `sites`, and only on a deployment with `sites`.** The spec's
  row lists `sites`, `groups`, `scopes`, `previewable` and `platform`; they are one
  object (`server/auth/me-sites.ts`): `scopes` holds shared, every group and every site
  the caller reaches with `kind`, their effective role, its `chain`, a site's status and
  preview origin; `previewable` carries each site's own `chain`, because a shared-only
  role reaches no site's `scopes` entry and still previews all of them; `platform`,
  `grants` and the `settings` type name. A token is sent none, and `auth: 'open'` is
  every role on every scope. **`actor.role` is still the `*` grant**, which is what makes
  a site admin *not* an admin to `canManageAccess`, `canAdmin` and `model-model.ts`'s
  own `isAdmin`; the role on the scope being shown is `me.ts`'s `roleOf`, read through
  `atScope(me, scope)`, and every predicate in the file goes through it.
- **`canDeleteForms` is no longer `canAdmin`.** The server split `ADMIN` (platform) from
  `SCOPE_ADMIN` in phase 3; the admin had one predicate for both. `canAdmin` is the
  platform tier (the describe run) and `canDeleteForms` is admin on the form's scope.
  Single-site they are the same question.
- **A page is written under its owner's role, not the shown scope's.** An alpha editor
  opening a shared page reads it (reads flow up) and cannot write it, so the editor's
  `readOnly`, Publish and Unpublish ask `canEditIn(me, story.site)`, and the banner says
  "this page belongs to Shared" with *Fork into Alpha* for someone who may create.
- **The pane is `site/start` on the admin origin, never the preview URL.** `paneSource`
  turns the story's `previewUrl` into the handoff (`paneSrc`, now pure) with `next` set
  to its path and query plus `_folio_id`, so a page a fork shadows previews *this* page;
  a document with no path names none. The bridge is given the site's preview origin and
  `grant-blocked` shows *Open preview in a new tab* (the same URL: top-level, so the
  cookie is first-party). The picker offers the sites whose chain reads from the page's
  owner; a site with no preview origin, or a caller who may preview none, gets the
  reason in the bar and in the empty stage rather than the host's "no route" sentence.
  A global has no preview on multi-site unless a host page carries it: the
  `{base}/preview/global/:name` fallback is an admin-origin page a cross-origin pane
  cannot use.
- **The Settings tab is a list of links into the ordinary editor** on each scope's layer
  (`settingsHref`), not a second editing surface: the layer is a document and already has
  the draft, publish and history. Opening it is what creates the layer (decision 8).
- **Layer labels come from `layerStates`, fetched once per open layer.** The layers below
  are read as drafts when the layer opens (`useLayerDocs`) and not kept live; an
  inherited value another editor changes is picked up on the next open. Labels appear only
  when `isLayerDocument` (a layer of any scope but `shared`, on a deployment with `sites`)
  and the inspector is handed `layers`; without it no field carries a label or an action.
  An inherited field shows the inherited value and is read-only until *Override* writes it,
  every locale's at once; *Reset* unsets the source and every locale the layer holds;
  *Remove* writes `null`. Only the root's fields and a `max: 1` child's are labelled
  (`slot.field`); a many-blocks slot is replaced whole and has no per-field state.
- **Grants are edited whole.** `PATCH /users/:id` replaces the set and answers 409 for a
  person any of whose grants a sign-in placed, so those rows carry the sentence in place
  of *Edit access*. A grant naming a deleted scope is listed as ignored and stays in the
  set the editor starts from, so saving drops none unseen. A bound token cannot hold
  `admin`: the binding removes *Full access* and the individual `admin` scope.
- **Home reads `/inherited` for a scope with something above it** and the scope's own root
  (`/stories?paths=`) for *Create home page*; Fork is refused with "Fork Info first" only
  when the parent is on the page in hand, and left to the server's 409 otherwise.
- **Pickers.** The document picker searches `/search` (chain-wide) on multi-site and badges
  a hit from another scope; the asset and form pickers pass `chain=1`. **They carry no
  badge:** neither the asset row nor the form row the list routes answer has a `site`, so
  the scope cannot be named client-side. A server change, for a later pass.
- **`{base}` redirects to the first scope on the client**, after `/me` answers: the shell
  is one static page at every path and only `/me` knows who is asking. A page with no scope
  (`{base}/sites`, `{base}/account`) has no singletons, and the boot's singleton request
  is answered `400 site_required` there and read as no rows.
- **Known gaps, none a regression.** `useGlobalDocs` fetches the current scope's layer
  (`sng_<type>:<scope>`, `sng_<type>` for `default`), so "Edit ‹global› →" fires for a block
  in the layer being edited, but not for one inherited from a layer further down the
  chain. The asset and form pickers offer the chain but cannot badge a row by scope:
  their list rows carry no `site`. The scope switcher is in the sidebar and so is hidden with it collapsed, which is
  the editor's default. `Shell.tsx`, `assets-model.ts` and `useAssets.ts` were touched
  beyond the files the plan names (a pass-through prop, and the pickers' `chain` flag).

### Phase 9 (2026-09-29)

The documentation and the probe. Files: `README.md` (a tour section and a config-table
row), `AGENTS.md` ("A multi-site host", replacing the "not built" limitation),
`docs/handbook.md` (the chapter "Many sites in one deployment", the hooks and Auth
sections, the probe paragraph under Caching, "Not built yet"), `docs/configuration.md`
(`sites`, `route`'s third parameter, the `roleFrom` grant forms, the hooks table and
payload fields, `cacheProps` under the entrypoint rule, the construction refusals),
`UPGRADING.md` (the wire version, the ledger, "Turning `sites` on: what the host
changes", four troubleshooting rows), `docs/specs/README.md`, `docs/specs/platform/
caching.md` (a dated addendum, nothing rewritten), this spec's header and this entry,
and `scripts/cache-probe.mjs`. Where the docs follow the implementation notes rather
than the spec's first plan:

- **Everything documented is what landed.** In particular: `ADMIN` is the platform tier
  and `SCOPE_ADMIN` the scope's (phase 3); `/me` carries one `sites` object (phase 8);
  the pane goes through `site/start` (phase 5, wired in 8); `roleFromClaim`'s bare
  `default` and `provision.role` are refused at construction with `sites` (phases 3
  and 7); a share's render site is named with `?site=` (phase 5); a delete does not write
  an auto-redirect where a scope above still serves the path (phase 7); `deleteSite` also
  removes tokens and shares and is refused while responses name it (phase 7); default
  seeds bare on a multi-site deployment (phase 4).
- **`UPGRADING.md` already held the `0011` section from phase 1** (the window, the
  post-deploy grant statement and its check, the rollback statement, the roll-forward
  resync, the point of no return, `0012` never in the same step). It is extended rather
  than repeated: a wire-version line (4 to 5), the ledger paragraph ("`0011` has landed;
  next free `0013`; `0012` claimed"), and a new section for the host code and DNS changes
  that turning `sites` on needs, including that the admin origin must not be a site host
  and that moving it invalidates every passkey. It says plainly that every existing
  person's `*` grant becomes a role on every site the moment a second site exists.
- **`folio.cacheProps(req, env)`** is documented with `env`, as the plan resolved
  (decision 15's snippet omits it). **`folio.reader(env)` with neither a request nor a
  site throws** and every doc says so; a single-site deployment is unaffected.
- **A preview grant does not, by itself, make a host's `reader.page()` return drafts.**
  `wantsDraft` asks for the draft cookie or a share; the grant authenticates. The docs
  therefore describe `{base}/draft/enter` on the preview origin (which accepts a grant)
  as the way a host's own route comes to show drafts, and the `?_folio=` branch as the
  one the pane uses.
- **The probe** takes `--admin` and `--site` together (either alone is a usage error,
  exit 2) and `--preview` on its own. With `--admin` the writes go to
  `<admin>/folio/~<site>/api/v1`. It reports whether the preview origin answers, that it
  is a separate entry from the live host's (a MISS while the live entry is HIT, and SKIP
  rather than a false pass if the preview entry was already warm), a preview MISS then
  HIT, and after a publish that both entries stop being HIT. The publish is of the page's
  own document and only when it is `live` with no newer draft; a page the site inherits
  from a scope above is not written at all. The global and type checks are skipped with
  `--admin`, because their ids and tags carry the scope. Without the three flags the
  output is line for line what it was: checked against the previous script by running
  both over a local stand-in server, with and without a token. It was **not** run
  against a deployment; that is the plan's Phase V.
- **Exports.** `SitesConfig`, `SiteRef` (the type of `route`'s third parameter),
  `GroupRef`, `Registry`, `SCOPE_ADMIN`, `Grants`, `GrantActor`, `RoleGrants`,
  `RoleTarget`, `SiteChangedHookPayload` and `PurgeIssued` are not exported from
  `folio/server`, and the scoped tag builders are not exported from `folio/core`
  (`SITE_TAG` and the older builders are). The documents describe shapes in prose and
  tables and never tell a host to import one of these. Exporting them is a decision for
  the owner of `index.tsx`, and `docs/handbook.md`'s "The exported surface" is
  unchanged until it is made.


### After staging verification (2026-09-30)

- **`reader.page()`'s `headers` carry `frame-ancestors <sites.admin>` on the preview surface.** Decisions 13 and 15 expected it, but only Folio's own responses passed through `framedBy`; a page a host renders and answers with `page.headers` did not, so a preview-origin page was frameable by anyone. It is added in `page()` for a multi-site deployment's preview surface only, never live and never single-site, and no policy is replaced (`cacheHeaders` and `no-store` set none). `draftAt()` returns a document, not headers, so it needs nothing.
- **A sign-in with no `next` lands on `{base}/` on a multi-site deployment, and an unscoped `{base}/edit` redirects there.** The default was `{base}/edit`, which has no root to open without a scope and 404s (decision 11), so the magic-link email ended on a 404. `editorUrl` in `routes/auth.ts` and the login redirect in `requireHtmlAccess` now default to the unscoped shell when `rt.sites` is set (single-site keeps `{base}/edit`), and `GET {base}/edit` with no scope is a 302 to `{base}/` for old bookmarks. `{base}/edit/:id` with no scope is unchanged. An explicit `next` still wins.

### Staging (2026-09-30)

- **What staging runs.** `staging.allaboutafrica.au` runs Folio
  `11cfc71c9fa1097a9b5154030b7cc8a6f4fbd6f4` with `sites` on: the admin is
  `staging-cms.allaboutafrica.au`, `staging.allaboutafrica.au` is the `default` site's
  live host, and `staging-preview.allaboutafrica.au` its preview origin. `0011` is
  applied to its D1; `0012` is applied nowhere and is not written. Production
  `allaboutafrica.au` and `takeoffgo.com` stay on their earlier pins.
- **Verified from the far side.** The `0011` read-back (one `*` grant per user, the
  re-keyed `stories_path`, `site_id, forked_from` last); `sites/resolve` answering
  `live` and `preview` for the two hosts; `cache-probe` with `--admin --site --preview`
  13 passed, 0 failed: live MISS then HIT, the preview a separate entry, both purged by
  one publish; `noindex` on every staging host, `frame-ancestors` naming the admin on
  the preview origin and absent on the live host, `site:default` in the live page's
  `Cache-Tag`.
- **Browser pass 1, same-site** (Chrome, Firefox, Safari 26.2+): the pane showed the
  draft, *Open preview in a new tab* showed it top-level, signing out ended it, and a
  share opened its one page's draft in a private window and nothing else. **Pass 2,
  cross-site**, with the preview origin pointed at the Worker's `workers.dev`
  hostname for its duration: passed in all three, so the partitioned grant cookie
  works where a same-site iframe could not prove it. The preview origin was switched
  back afterwards and read back.
- **What staging found that no test did**, each fixed and released before the passes
  finished: a host's `reader.page()` on the preview origin carried no
  `frame-ancestors`; a sign-in with no `next` landed on an unscoped `{base}/edit` that
  404s; and the documented host redirect of `{base}/…` on every non-admin host bounced
  the preview origin's handoff (the rule is live hosts only). `wrangler d1 export`
  refuses a database with FTS5 tables, so the pre-`0011` rollback on staging is a Time
  Travel bookmark plus a data-only export of the real tables.
- **Next:** spec phase 10, `0012_users_role_contract.sql`, is the release after this
  one, once this release is deployed everywhere it will go.

