# Upgrading Folio

Folio is installed from a git SHA, so an upgrade is deliberate: nothing changes
under you until you move the pin. What follows is the procedure, then the
per-migration ledger of what each schema change needs, then the things that are
silent when you skip them.

**Backwards compatibility is not a design constraint here.** There are a handful
of consumers, each pinned to a SHA, and each upgrades on purpose. A wrong design
gets replaced rather than deprecated, and the breaking change lands as a line in
your upgrade commit. Read [the ledger](#the-schema-ledger) before you bump, not
after.

---

## The procedure

```bash
# 1. Find the SHA you want. A full 40 characters — never a branch, never a short SHA.
git ls-remote https://github.com/brendanmckenzie/folio main

# 2. Read what changed between your pin and it.
#    (Commit subjects here are statements of what is now true, so this reads well.)
git log --oneline <your-current-sha>..<new-sha>

# 3. Bump the pin, and delete the installed copy FIRST. See the trap below.
rm -rf node_modules/folio
npm install github:brendanmckenzie/folio#<new-sha>

# 4. Apply any new D1 migrations — local first, then staging, then production.
wrangler d1 migrations list  folio --local
wrangler d1 migrations apply folio --local

# 5. Typecheck. This is where a breaking API change surfaces.
npm run typecheck

# 6. Run it locally and click through the editor.
npm run dev

# 7. Deploy, then apply the same migrations remotely.
wrangler d1 migrations apply folio --remote
npm run deploy
```

Steps 4 and 7 are in that order on purpose: **apply migrations before the
Worker that needs them goes live.** Every landed migration up to `0010` is
additive (`create table` / `alter table add column`), so applying one ahead of the
deploy that uses it is safe — the old code never looks at the new column. The
reverse is not: a new Worker reading a column that does not exist yet is a 500 on
every request until the migration lands. `0011` is the first that is not purely
additive, and [its section](#0011-roles-move-to-site_roles-2026-09-29) says what
that costs between the two steps.

### The trap that catches everybody

> **`rm -rf node_modules/folio` before reinstalling.**

npm skips a git package's `prepare` build when the directory is already there,
so you end up with the new source and **no `dist/`**. The symptom is imports
failing from a stack that names nothing you wrote. A clean install has never had
this problem, which is exactly why it survives so long unnoticed.

If you use pnpm, `pnpm store prune` is not enough either — remove the directory.

---

## The schema ledger

D1 migrations live in the **package**, and your `wrangler.jsonc` points
`migrations_dir` at `./node_modules/folio/migrations`, so bumping the pin is
what puts new files in front of `wrangler d1 migrations apply`. It records what
it has run, so it never re-runs one and never drops a table.

`wrangler d1 migrations list folio --remote` is the authoritative answer to
"what does this database still need". The table below is what each one is for,
and whether it needs anything from you beyond applying it.

| | Adds | Anything else to do |
| --- | --- | --- |
| `0001_init.sql` | The whole base schema | Nothing. See the note below about applying it over an existing database. |
| `0002_asset_refs.sql` | Asset edges in `content_refs`, so the media library can answer "used by N" | **Republish or reindex** — existing published documents have no asset edges until something writes them. |
| `0003_schedules.sql` | Scheduled publish and unpublish | Add `"triggers": { "crons": ["* * * * *"] }` and a `scheduled()` handler that calls `folio.runSchedules`. Without them the routes work and nothing ever fires. |
| `0004_shares.sql` | Draft share links | Nothing required. Set `draftMode: true` and render through `reader.page()` if you want reviewers to land on real URLs. |
| `0005_content_fts.sql` | `content_text` + an FTS5 index over it | **Reindex** — the index is written at publish, so existing content is invisible to search until you rebuild it. |
| `0006_auth.sql` | `sessions.provider`, a role-decided column, `auth_events` | Wire `folio.sweepAuth(env)` into your cron. Nothing breaks without it; the table just grows forever. |
| `0007_passkeys.sql` | The WebAuthn credential store | Add `passkeys()` to `auth.providers`. Listing it is the whole opt-in. |
| `0008_asset_organisation.sql` | Asset folders, tags, and six columns on `assets` | Nothing. Existing assets land at the root with no tags. |
| `0009` | **Permanently absent.** Nothing will ever take it: a migration numbered below `0010` cannot alter the tables `0010` creates on a fresh database, so the number is unusable. | — |
| `0010_forms.sql` | Forms and responses | Nothing required. Add a `form()` field to a block to embed one, and a `submitted` hook to forward responses. |
| `0011_sites.sql` | The site registry, a site column on stories, redirects, assets, folders, tags, forms, responses and shares, roles as grants in `site_roles`, preview grants; every global unique index re-keyed with the site leading | **Apply it, then deploy, within minutes, with no role changes or invitations in between**, then run the post-deploy grant statement. Read [the 0011 section](#0011-roles-move-to-site_roles-2026-09-29) first: it changes what a rollback can do. |
| `0013_site_brands.sql` | One nullable `sites.brand` column | **Apply it before you deploy, on every deployment with `sites`**: this release's registry read selects the column, so a Worker deployed first fails every registry read with `no such column`. It is additive and safe ahead of the deploy. It changes nothing until you configure `brands`; read [the brands section](#0013-and-turning-brands-on-2026-09-30) before you do. |

`0011` and `0013` have landed. `0012` is still claimed and is **not in the package yet**: `0012_users_role_contract.sql` drops the two `users` columns `0011` retires, in the release after the one that carries `0011`, and its entry will repeat that it must never be applied in the same step as `0011`. Next free number is `0014`. `0013` is numbered after a file that does not exist yet, which is fine: wrangler applies whatever is unapplied by filename, so a database that takes `0013` first takes `0012` later.

**A note on `0001_init.sql`:** it is plain `create table`, not
`create table if not exists`. Applying it over a database that already has those
tables **fails loudly** rather than adopting it, which is deliberate — a silent
adoption would leave an older schema in place under a ledger claiming otherwise.
If you hit this locally, delete `.wrangler/state` and start again.

### Reindexing

Two migrations above say "reindex". So does any schema change of your own that
marks an existing field `indexed: true` or `searchable: true` — publish writes
those rows, so nothing existing has them.

```bash
curl -X POST https://your-site/folio/api/reindex \
  -H "authorization: Bearer $FOLIO_TOKEN"
```

Or `folio.reindex(env)` from a deploy step. It is batched and resumable — re-call
with the previous answer's `continueFrom` until it is null — and idempotent, so
racing a publish is harmless.

---

## Two ledgers with confusingly similar names

They are unrelated and both are called "migrations".

| | **D1 migrations** | **Content migrations** |
| --- | --- | --- |
| What | Folio's database schema | *Your* documents, when *your* block schemas change |
| Where | `node_modules/folio/migrations/*.sql` | `src/migrations.ts` in your project |
| Written by | Folio | You |
| Run by | `wrangler d1 migrations apply` | `folio.migrate(env)`, or `POST {base}/api/migrate` |
| When | On upgrade | When you rename a field or a block type |

You need a **content** migration when you change a block's schema in a way that
strands stored data, which happens quietly:

- Rename a field and every stored document keeps writing to the old key. The
  value is still sitting in `blok.data`, invisible, and the field the admin now
  draws is empty.
- Rename a block *type* and every existing instance renders "Unknown block type"
  in the editor and nothing at all on the live page.
- Add a field with a `default` and existing documents have no such key at all —
  `Field.default` is read at *creation* only.

Both failures are quiet by construction, because the renderer iterates the
schema's fields and a key the schema no longer declares is never read again.

```ts
// src/migrations.ts
import { defineMigration, field } from 'folio/engine'

export const migrations = [
  defineMigration({
    id: '0001-hero-heading-to-title',
    description: 'Hero: heading → title',
    up: (_doc, ctx) => ctx.each('hero', (blok) => field.rename(blok, 'heading', 'title')),
  }),
]
```

Then `migrations` in `createFolio`, and run it from a deploy step:

```bash
curl -X POST https://your-site/folio/api/migrate -H "authorization: Bearer $FOLIO_TOKEN"
```

**Nothing runs automatically**, deliberately: a migration that ran itself on the
first request after a deploy would run inside a request whose CPU limit it can
exceed, on a cold Worker, with nobody watching.

The ids must **sort in run order** — `stories.schema_id` records how far a
document has come and compares lexicographically — and `createFolio` throws at
construction if the declared order and the sort order disagree.

Applying a migration to an already-migrated document produces **zero**
mutations, which is what makes the runner re-runnable after a partial failure
and makes "did that actually work" answerable by running it again and watching
nothing happen.

### The drift audit

The audit tells you which schema changes have already stranded data, so you can
find out before an editor does:

```bash
curl https://your-site/folio/api/audit -H "authorization: Bearer $FOLIO_TOKEN"
```

Or `folio.audit(env)`. It is also the Model screen in the admin.

---

## Things that need an eye on upgrade

### The wire version

`PROTOCOL_VERSION` (`src/core/protocol.ts`, currently **5**) is carried by every
socket frame and every admin↔preview message. A mismatch is refused rather than
guessed at. **The release that carries `0011` bumps it from 4 to 5** (three wire
changes ride the one bump: the mutation log's `unset`, the preview bridge's
cross-origin rule, and the space channel being per scope), so an editor with a tab
open across that deploy is told to reload.

**This is not a compatibility mechanism and needs nothing from you.** Both ends
ship in the same deploy, so it is a guard against a stale browser tab, not
against a version skew you have to manage. The user-visible symptom of a bump is
that an editor who left a tab open across your deploy has to reload. Bumps are
cheap and are made freely.

### 0011: roles move to `site_roles` (2026-09-29)

`0011_sites.sql` gives every row a site (`default`, on a deployment that
configures no `sites`) and moves each person's role off `users` into a grant in
`site_roles` on the scope `*`. The migration backfills one `*` grant per user from
`users.role` and `users.role_from`. **From this release on, Folio reads and writes
roles only in `site_roles`.** `users.role` and `users.role_from` stay in place,
unread, until `0012` drops them. With no `sites` configured nothing you can see
changes: one site, one role per person, the same URLs and cache tags.

**Apply `0011`, then deploy, within minutes, and change no roles and invite nobody
in between.** Until the new Worker is serving, the old one is still reading and
writing `users.role`: a role changed or a person invited through it in that window
lands only in the old column and is not carried over. The old code also **cannot
create an asset tag or a form** in the window: its `on conflict (slug)` and
`on conflict (name)` no longer match a unique index, so both fail. Nothing closes the window
for you, deliberately — a trigger mirroring the old column would collide with the
seeds' own grant insert and, on a rollback, mint grants from every old-code edit.

**When the deploy finishes, run this once.** It is idempotent. It gives anyone who
signed in for the first time during the window (a provider that creates accounts
cannot be told to wait) the `*` grant their row says, and touches nobody else:

```sql
insert into site_roles (user_id, scope_id, role, role_from, created_at)
  select id, '*', role, role_from, created_at from users
  where id not in (select user_id from site_roles);
```

Then check that it left nobody out, which should answer `0`:

```sql
select count(*) from users where id not in (select user_id from site_roles);
```

**Seeds and bootstrap SQL change shape.** A user is two inserts now, and neither
names `users.role`, so the same statement works before and after `0012`:

```sql
insert into users (id, email, name, created_at) values ('usr_admin', 'admin@example.com', 'Admin', 0);
insert into site_roles (user_id, scope_id, role, created_at) values ('usr_admin', '*', 'admin', 0);
```

A script of your own that inserts `users (…, role, …)` still runs against `0011`,
but the role it names is ignored: the person signs in as `viewer` until they have
a grant. Change it to the shape above.

**Rolling back to a build before `0011`** works on a deployment that never turned
`sites` on, with two costs. The old code reads `users.role`, which is each
person's role as of the migration, so first restore the column from the grants,
which are all `*` grants on such a deployment:

```sql
update users set
  role = coalesce(
    (select role from site_roles where site_roles.user_id = users.id and scope_id = '*'),
    'viewer'),
  role_from =
    (select role_from from site_roles where site_roles.user_id = users.id and scope_id = '*');
```

And the old code **cannot create an asset tag or a form** against `0011`: its
`on conflict (slug)` and `on conflict (name)` no longer match a unique index, so
both inserts fail until you roll forward again. Everything else works.

**Rolling forward again** after a rollback: the grants are as they were when you
rolled back, and the old code wrote only to `users.role`, so a role it changed is
stale in `site_roles` — a person it demoted would get their old role back. Deploy,
then resync every `*` grant from the column once (instead of the post-deploy
statement above, which fills only missing grants):

```sql
insert into site_roles (user_id, scope_id, role, role_from, created_at)
  select id, '*', role, role_from, created_at from users where true
  on conflict (user_id, scope_id) do update
    set role = excluded.role, role_from = excluded.role_from;
```

**Turning `sites` on is the point of no return.** Once a deployment has a second
site, code with no site dimension would serve every site's rows as one site, so
there is no rolling back past this release from there. Roll forward instead.

**`0012` comes in the release after, never in the same step.** It drops
`users.role` and `users.role_from`. Applied together with `0011` from a build
before `0011`, it removes the column the still-running old Worker signs people in
with, and takes sign-in down until the deploy finishes. Deploy the release that
carries `0011` everywhere it will go, then take `0012` with the next one.

### Turning `sites` on: what the host changes (2026-09-29)

Applying `0011` and deploying this release changes nothing you can see. **Adding
`sites` to `createFolio` is a separate act with its own costs**, and the point of no
return: once a second site exists, code with no site dimension would serve every
site's rows as one, so there is no rolling back past it (roll forward). Do it on
staging first, and only after the post-deploy grant statement above has answered `0`.

**1. Three kinds of hostname, and the admin moves.** Each site has live hosts
(`alpha.example`), optionally a preview origin (`https://preview.alpha.example`), and
the deployment has one admin origin (`sites.admin`, `https://cms.example`). Route all
of them to the Worker. **The admin origin must not be any site's live host or preview
origin**, and every hostname is unique across the deployment; the registry refuses a
clash. If the admin was on a site's host until now, **it moves, and that has two
costs for editors**: their session cookie belongs to the old host, so they sign in
again, and passkeys bind to the admin host (`rpId`), so they **re-enrol each passkey**
on the new one. Moving `sites.admin` later costs the same again.

**2. `createFolio`.**

```ts
sites: { admin: 'https://cms.example', settings: 'siteSettings' },   // settings is optional
route: (path, locale, site) => {          // required with `sites`; `site` is the third parameter
  const tail = path ? `/${path}` : '/'
  return site?.hosts[0] ? `https://${site.hosts[0]}${tail}` : tail   // absolute on a site's host
},
```

`route` gained its third parameter and, with `sites`, must answer an **absolute** URL
for a site, because the admin is on another origin. A host with no `sites` keeps
`(path, locale)` and is not affected.

**3. Every reader is built from a request.** `folio.reader(env, req)`, or
`folio.reader(env, { site: 'alpha' })` for a caller with no request (a sitemap build,
a cron), which reads that site's live surface. **`folio.reader(env)` throws** with
`sites`, as does every top-level one-shot read (`folio.published(env, …)`), because
answering as no site would give an empty sitemap and no error. Grep for `.reader(env)`
and for `folio.published(`, `folio.storyAt(`, `folio.query(` in your own code.

**4. The cached loopback passes props.**

```ts
this.ctx.exports.CachedPages({ props: await folio.cacheProps(req, this.env) })
  .fetch(req, { cf: { cacheKey: folio.cacheKey(req.url) } })
```

Without it two sites at the same path share one cache entry, and a preview origin's
`noindex` reaches the live site. `cacheProps` takes the environment because the
registry read needs the binding. To check it against a deployment, run, from a checkout of the Folio repository (scripts
are not in the package),
`node scripts/cache-probe.mjs <live url> --admin <admin origin> --site <id> --preview <preview origin> --token …`
(the script's `--help` has the rest): it reports that the preview origin is its own
entry and that one publish purges both.

**5. Live hosts answer only `{base}/asset/:key` and `POST {base}/f/:id`.** An editor's
bookmark to `alpha.example/folio` would fall to your router's 404. Add, before
`folio.handle`, a redirect for a `GET` or `HEAD` on any host that is not the admin
origin, for `{base}` and `{base}/…` other than `{base}/asset/…` and `{base}/f/…`, to
the same path and query on the admin origin.

**6. Scripts and tokens.** Writes go to the admin origin under the site's segment:
`https://cms.example/folio/~alpha/api/v1`. A route that needs a scope and gets none is
`400 site_required`, and that includes a bare `{base}/mcp`; use `{base}/~alpha/mcp` or
a token bound to the site. Existing tokens are unbound (`site` null) and keep working
with the `~<site>` segment. Mint a bound one with `POST /tokens` and `site` (a bound
token can never hold `admin`). Idempotent upserts are unchanged, scoped by the
binding.

**7. People.** Roles become grants per scope. Every existing person holds one grant on
`*`, which on a deployment with `sites` means **that role on every site**: after you
turn `sites` on, edit each person's grants on the Access screen (or
`PATCH /users/:id` with `grants`) before you create the second site, or they are an
editor of all of it. Sign-in providers: `provision.role`, `roleFromClaim`'s `default`,
and `provision: { create: true }` with no `roleFrom` are **refused at construction**;
map directory groups to scopes with `roleFromClaim({ map: { group: { scope, role } } })`
or a `RoleMapper` answering `{ alpha: 'editor' }`. A person placed by a provider has
their grants replaced at each sign-in and cannot be edited by hand.

**8. Sites.** `0011` inserted the `default` site (`live`, no hosts). In the Sites
screen (or `POST /api/sites`) give it its hosts and, if you want drafts previewed on
their own origin, a preview origin. Until a site has a live host and status `live`, its
host is your router's 404. Then create the others.

**9. Hooks and the wire.** Every hook payload gains `site` and, when the event purged,
`purge`; `siteChanged` is new. Both are additive. Open editor tabs reload once
([the wire version](#the-wire-version)).

**Getting it wrong is mostly loud**: the constructor throws for a missing `route`, a
bad `sites.admin`, or a provisioning shape it cannot honour, and `reader(env)` throws
where it would otherwise answer empty. What is silent is a cache with no props (two
sites sharing an entry) and a purge issued from the wrong entrypoint, so run the probe.

### 0013 and turning `brands` on (2026-09-30)

`0013_site_brands.sql` adds one nullable column, `sites.brand`. **Applying it and
deploying this release changes nothing you can see beyond the additive fields
below.** Apply it before the deploy on a deployment with `sites`, because the new
Worker selects the column on every registry read. A deployment with no `sites` never
reads the table.

**What every deployment sees, `brands` or not.** All additive, all new keys:

- **Every hook payload carries `brand`**, `null` without `brands`, on single-site
  deployments too. A host that forwards a payload verbatim, or compares one for exact
  equality, now sees the key.
- **`GET {base}/api/sites` rows and `/me`'s `sites.scopes[]` carry `brand: null`**, and
  `GET {base}/api/sites` answers `shared: true` at the top.
- **`GET {base}/~<site>/api/v1/schema` gains `scope`** on a multi-site deployment, and a
  scoped MCP session's `instructions` gain one sentence naming the site.
- **A v1 404 from `pages/{path}` and `documents/by-path/{path}` carries `error.miss`**
  (`redirect`, `gone` or `not-found`), and `reader.miss()` answers `headers` (`Cache-Control`
  and the `Cache-Tag` a later publish at the path purges). A client that treats any 404 as
  a miss is unchanged.
- **`MagicLinkMail` gains `scope?`** on a deployment with `sites`, parsed from the
  sign-in's `next`.
- **`folio/server` and `folio/core` export the multi-site types and the scoped tag
  builders** (`SitesConfig`, `SiteRef`, `HookBase`, `siteTag`, `pathTag`, and the rest).
- **A block registry that repeats a name now throws at construction**, and so does an
  object registry whose key is not its block's name. Both used to keep the last block
  and drop the first without a word.
- **A v1 read of a layer nobody has written is now `404`, and a layer is created by its
  first write.** Before, reading a layer created the row. It
  applies to every deployment with `sites`; a deployment with no `sites` still creates a
  singleton by asking for it. A script that read a layer to create it writes first
  (`PATCH …/fields` with `{ fields: {} }`).
- **`FolioConfig` is a union**, `FolioSingleConfig | FolioBrandedConfig`. Every config
  literal still type-checks; `Partial<FolioConfig>` no longer spreads over a base config, so
  write `Partial<FolioSingleConfig>`.

**Turning `brands` on is its own change**, for a deployment whose sites do not share a
design. Each brand has its own blocks, types, preview and policy, and a site belongs to
one. Do it on staging first.

**1. Set every existing row's brand, right after `0013` and before the deploy that
configures `brands`.** A site or group with no brand, or a brand `brands` does not name,
is left out of the registry: it has no chain and answers `404 No site or group` at every
`~<scope>` and its hosts serve nothing. `0011` inserted `default` with no brand, so on
its own the deploy serves every `default` page as a 404:

```sql
update sites set brand = 'allaboutafrica' where id = 'default';
```

Use your own brand id, and repeat for every other site and group you already have. The
column is unread until `brands` is configured, so this is safe to run ahead of the
deploy. Groups take their sites' brand, and a site and its group must agree.

**2. There is no `shared` scope.** A branded deployment's chain is a site and its group,
and `~shared` is a `404` whose rows nothing can read or write. If you keep content in
`shared`, copy it into each brand's own scope first.

**3. Config moves.** `blocks`, `root`, `types`, `globals`, `previewCss`, `previewWrap`,
`gate`, `forms`, `describe` and `migrations` move into `brands.<id>`, and `sites.settings`
becomes `brands.<id>.settings`. Everything about people and requests stays at the top.
[The configuration reference](docs/configuration.md#many-brands-in-one-deployment) has the
shape and the construction refusals, which name the key.

**4. The Vite plugin takes a record.** `folio({ blocks: { allaboutafrica: './…', takeoffgo:
'./…' } })` builds `folio-preview-<brand>.js` and `.css` per brand and defines
`__FOLIO_ASSETS__` with a `brands` map, which you pass to `createFolio`'s `assets`
unchanged. **A record with `cssCodeSplit: false` fails the build**, at the top level or on
the client environment, because one stylesheet would carry every brand's CSS into every
brand's preview. Remove the flag. A string `blocks` is unchanged, byte for byte, and keeps
`cssCodeSplit: false`.

**5. Content migration ids carry the brand.** Every id starts `<brand>/`
(`takeoffgo/0001-fifty-fifty-to-feature`), refused at construction otherwise, because
`schema_migrations` is keyed by id alone. **Converting an existing deployment is not
supported.** Its documents carry the old unprefixed ids in `stories.schema_id`, and
`schema_migrations` records them, so after the rename every document reads as behind and
the next `migrate` runs every migration again. The built-in `field.*` helpers are
idempotent; an `up` of your own may not be. A brand that has no migrations is unaffected.

**6. Hosts read through a brand.** `folio.registry` throws on a branded deployment;
`folio.registryFor(brand)` answers a brand's block registry, and `folio.render(doc,
{ resolution })` takes its brand from `resolution.site`, throwing without one.
`folio.reader(env, req)` reads the request's site as before, and `(await
reader.site())?.brand` is the brand. A hook tells brands apart by the payload's `brand`.

**7. Scripts and tokens name a scope.** On a branded deployment `{base}/api/v1/schema`
with no scope is `400 site_required`, as are unscoped `POST /migrate`, `/reindex`, `GET
/audit`, `/migrations` and `/assets/describe`. Call them under `{base}/~<site>/…` (the
route runs that site's brand over that brand's sites), or bind the token to a site. A
bound token cannot reach a site of another brand.

**8. The brand id is permanent once rows carry it.** Renaming or removing a key in
`brands` takes every row holding the old id out of the registry, so its hosts stop
routing and every `~scope` is a `404`, and `PATCH { brand }` is `409` on a scope that
holds content even where the registry is the same. Repair it with SQL, applied with the
deploy that renames the key:

```sql
update sites set brand = '<new>' where brand = '<old>';
```

Changing a site's brand through the admin works only while the scope holds no content
(stories, assets, folders, tags, forms, responses or redirects), and never on a group
that has sites. Do it on a scope nobody is editing: another Worker isolate answers the
old brand for up to ten seconds after the change.

**9. The admin origin is brand-neutral and moving it costs every passkey.** A branded
deployment has one sign-in, so `sites.admin` belongs to no brand, and sign-in mail is
sent from one address. `MagicLinkMail.scope.brand` lets `send` word the mail per brand.
Passkeys bind to the admin host; see [step 1 of turning `sites` on](#turning-sites-on-what-the-host-changes-2026-09-29).

**Going back** is a config change: remove `brands` and restore the single-registry keys.
The brand column is then unread, `shared` is a scope again, and nothing stored changes.
Brand-prefixed migration ids stay in `schema_migrations` and in `stories.schema_id`, so a
deployment that goes back renames its list to the old ids by hand.

### A title-only patch no longer moves the page (2026-09-06)

**Two bugs, one upgrade, and both were silent.** Read this one even if you skip
the rest.

`PATCH /documents/:id` with a `title` and no `slug` re-derived the slug from the
new title, so **renaming a page changed its URL**, recorded a redirect and fired
`pathsChanged` — while the handbook had documented the opposite all along ("a
title-only patch … fires no `pathsChanged`, by design"). Creating a document
still derives its slug from its title, which is right; updating one no longer
does. Pass `slug` when you mean to move a page.

**Check your content.** Anything that patched a title through the API or the
admin may have moved. Renamed pages are still reachable — a redirect was
recorded — but their URLs are slugified titles rather than the slugs somebody
chose. Look for auto redirects whose target is a long slugified title:

```sql
select from_path, to_path from redirects where source = 'auto' order by created_at desc;
```

Fix one by patching the slug back (`PATCH /documents/:id {"slug":"safari"}`) and
republishing; the redirect from the accidental path stays, which is harmless.

And `FolioMiss.to` is now **rooted** — `/guides/new`, not `guides/new`. It is the
one path-shaped value in the API that leaves as a `Location` header, where a bare
path is a *relative* URL: the browser resolves it against the page it is already
on, so `/guides/safari` redirecting to `guides/new` landed on
`/guides/safari/guides/new` and 404'd. Every rename redirect was broken in that
shape on any host that wrote `redirect(miss.to)` — which is what `AGENTS.md` and
`README.md` both showed, and both are corrected. If you copied the careful
spelling from the handbook or either example (`new URL(miss.to, url.origin)`),
nothing changes for you: that answers the same URL either way. An absolute
off-site target is untouched.

### Collection items no longer carry each document (2026-09-06)

`item.doc` on a `collection` field and on a `folio.query` result is now
**absent unless the query asks for it**. `item.data` — the root block's fields,
which is what a card renders from — is unchanged and still on every item.

Ask for the body where a block genuinely inlines one:

```ts
list: collection({ type: 'guide', withDoc: true })
// or, over the API and in a host's own query:
await folio.query(env, { type: 'guide', withDoc: true })
// GET {base}/content?type=guide&doc=1
```

**Why, and what it is worth.** An item carried a full `Doc` on every query, so a
list paid for every body whether or not anything rendered one. Measured on a live
site: an eleven-item guides rail put **250 kB** of unrendered prose into the SSR
payload of the home page and of all thirteen guide pages — 68% of a 367 kB
response, and 92% of the hydration payload once gzipped. The D1 read is unchanged
(`published_doc` is still read, because `item.data` comes out of it); the bytes
come off the response.

**What to check when you bump.** `tsc` finds the render sites for you — `doc` is
now `Doc | undefined`. Anything that reads `item.doc` without declaring
`withDoc` is a page that was rendering an inlined document and will now render
nothing, so it fails to compile rather than silently emptying. Two other surfaces
change shape for the same reason, both additively reversible with `doc=1`:
`GET {base}/content` and `GET {base}/api/v1/documents`.

`queryKey` is unchanged for a field that does not declare `withDoc`, so
`Resolution.collections` keys are byte for byte what they were.

**The read shrank too, not just the response.** A query without `withDoc` no
longer selects `published_doc` at all: SQLite projects the root block out of it
(`json_extract(published_doc, '$.bloks."' || … || '"')`) and ships that instead.
On one production database that is 27 kB against 542 kB across 32 published
pages. Nothing to do on your side — `item.data` is identical either way, and a
test asserts exactly that by running the same query both ways and comparing.

### Durable Object migration tags

If you are upgrading from a pin old enough to predate `SpaceDO`, you need both
the binding and a **second** migration tag:

```jsonc
"durable_objects": { "bindings": [
  { "name": "STORY", "class_name": "StoryDO" },
  { "name": "SPACE", "class_name": "SpaceDO" }
]},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["StoryDO"] },
  { "tag": "v2", "new_classes": ["SpaceDO"] }
]
```

`new_classes`, not `new_sqlite_classes`: `SpaceDO` holds no storage at all —
presence lives in socket attachments and nothing it knows outlives them. That
distinction **cannot be changed for an already-deployed class**, which is why
each gets its own tag rather than sharing one.

Without the binding, Folio degrades cleanly: per-story presence, and a tree you
refresh yourself. No error, no retry loop.

### Your agent instructions

`AGENTS.md` ships a paste block delimited by `<!-- folio:begin -->` /
`<!-- folio:end -->` for your own `AGENTS.md` or `CLAUDE.md`. The markers exist
so an upgrade can replace it wholesale without disturbing what surrounds it:

```bash
npx github:brendanmckenzie/folio#<new-sha> agents
```

Or copy it by hand out of `node_modules/folio/AGENTS.md`.

---

## Rolling back

Move the pin back and redeploy. A SHA keeps resolving as long as it is reachable
from a pushed ref, so an older pin is always installable.

**The database does not roll back.** Content migrations have no `down`, and D1
migrations are not reverted by pointing `migrations_dir` at an older package —
`wrangler` will simply report fewer pending files than the database has already
applied. Every landed migration up to `0010` is additive, so an older Worker
against a newer schema works: it ignores the columns and tables it does not know
about. **`0011` is the exception**: rolling back past it needs one statement first
and loses two writes, and is impossible once `sites` is on — see
[its section](#0011-roles-move-to-site_roles-2026-09-29).

The exception is content. A content migration that rewrote documents has already
rewritten them, through the mutation log — so the recovery is the History tab
(restore a version) rather than a schema operation.

---

## If something is wrong after an upgrade

| What you see | What it is |
| --- | --- |
| Imports fail; `node_modules/folio/dist` is missing | npm skipped `prepare` because the directory already existed. `rm -rf node_modules/folio` and install again. |
| `no such column` / `no such table` on every request | The Worker deployed ahead of its migrations. `wrangler d1 migrations apply folio --remote`. |
| Editors get "reload to continue" once, then it is fine | `PROTOCOL_VERSION` was bumped and their tab predates the deploy. Working as intended. |
| Search returns nothing for content that exists | The FTS index has no rows for documents published before `0005`. Reindex. |
| "Used by N" says 0 for an asset that is plainly in use | Asset edges are written at publish. Reindex, or republish. |
| Editor loads but shows no other cursors and the tree never updates | The `space` binding is absent, or its migration tag was never added. |
| Typecheck reports two incompatible `Plugin` types | Folio got installed by directory path or symlink instead of a SHA. It resolves `vite` from Folio's own tree. |
| Scheduled publishes stopped firing | The cron trigger, or the `scheduled()` handler, did not survive the merge. |
| `400 site_required` from a script or `{base}/mcp` | The deployment has `sites`, and the route needs a scope. Use `{base}/~<site>/…`, or a token bound to the site. |
| Every page of a site is a `404` and `~<site>` answers `No site or group`, on a deployment with `brands` | The row's `brand` is null or is not a key of `brands`. `GET {base}/api/sites` lists it; set the column (see [turning `brands` on](#0013-and-turning-brands-on-2026-09-30)). |
| `createFolio` throws `folio: 'blocks' belongs to a brand beside 'brands'` (or another moved key) | The config has `brands` and one of the keys that moved into a brand. Move it. |
| The build fails with `blocks` is a record of brands, which cannot be built with `cssCodeSplit: false` | Remove `build.cssCodeSplit: false`. |
| `folio.reader` throws "a read must say which site it is for" | The deployment has `sites`. Pass the request, or `{ site }`. |
| Editors can sign in but their passkey is gone | The admin origin moved, and passkeys bind to its host. Re-enrol. |
| A site's pages are the host's 404 | The site is not `live`, or the hostname is not in the registry. Check `GET {base}/api/v1/sites/resolve?host=…`. |

More of these, including the ones that are not upgrade-specific, are in
[`AGENTS.md`](AGENTS.md) under "When something breaks".

---

## See also

- [`README.md`](README.md) — what Folio is, and the quick start.
- [`docs/configuration.md`](docs/configuration.md) — every config key, with its
  default and its failure mode.
- [`docs/handbook.md`](docs/handbook.md) — "Content migrations" has the full
  argument, including why the same function has to reach three copies of a
  document.
- [`docs/specs/README.md`](docs/specs/README.md) — the record of what every
  migration added, per feature.
