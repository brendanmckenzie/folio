# Feature: Many sites in one deployment

> **Group:** foundation
> **Build order:** 23, per docs/specs/README.md
> **Size:** XL
> **Status:** draft
> **Wire version:** 5 (the space channel gains a site dimension)
> **Migration:** `0005_sites.sql` — a new table and a `site_id` column on six others

## Summary

One Worker, one D1, one R2, one admin, and several brand sites inside it — All
About Africa on `harbour.example`, Meridian on `meridian.example`, the next one
on whatever it is called. Each with its own content tree, its own block set, its
own editors and its own domain.

**Folio has no site dimension at all today**, and the absence is not a missing
column so much as an assumption threaded through the schema, the routing, the
Durable Object naming, the auth cookie and the cache tags. This spec is the
inventory of that assumption and the decision about which axis to add.

The forcing case is real rather than hypothetical: `meridian/` holds two sibling
sites on the same stack (React Router 7, Workers, Kestrel GraphQL), one agency, one
team of editors, and — after `consumer-site-b`'s `folio-cms` branch —
one of them with a CMS in it. The second one should not mean a second D1, a
second R2, a second set of accounts and a second URL to sign in to.

## Ground truth

Verified against the tree at `120314c`. Everything below is a place that assumes
exactly one site.

**Schema (`packages/folio/migrations/0001_init.sql`).** No table has a site
column. Four unique indexes are global and are the load-bearing ones:

- `stories_path` (line 108) — `unique (path) where path is not null`. Two sites
  cannot both have an `/about`, and neither can have a root story, because the
  root's path is `''` and there can be one.
- `stories_parent_slug` (line 124) — sibling slug uniqueness. Scoped by parent, so
  it survives a site column *if* every site has a distinct root.
- `stories_type_slug` (line 129) — `unique (type, slug) where path is null`. Two
  sites cannot each have a `person` record called `jane`.
- `redirects.from_path` (line 215) is the **primary key**, so a redirect is
  site-wide by construction.
- `assets.key` (line 193) is unique, which is correct and stays: an R2 key is
  global whatever owns it.
- `users.email` (line 243) is unique, which is a decision rather than an obstacle
  — see decision 5.

**Singleton ids are derived from the type name.** `SINGLETON_PREFIX = 'sng_'`
(`core/schema.ts:170`) and a singleton's id is `sng_<type>`. That is what makes
"exactly one" need no column and no constraint (`document-types.md` decision 4) —
and it is exactly what breaks first: two sites cannot each have a `header`.

**The space Durable Object is a singleton by name.** `SPACE_NAME = 'space'`
(`server/space-events.ts:37`), reached with `ns.idFromName(SPACE_NAME)`
(`runtime.ts:440`, `space-events.ts:72`). Every editor in the deployment lands in
one presence channel and receives every structural event, so an editor working on
Meridian would see Harbour's tree updates and the names of people
editing a site they cannot open. `StoryDO` is keyed by story id and needs no
change at all.

**Path lookup takes a path and nothing else.** `storyByPath(db, path)`
(`server/stories.ts:972`) is `select … where path = ?`, and `folio.published(env,
path, locale)` is its caller. The request's host never reaches the query.

**The session cookie is `__Host-` prefixed.** `SECURE_COOKIE =
'__Host-folio_session'` (`server/auth/cookie.ts:13`). `__Host-` forbids a
`Domain` attribute, so the cookie is bound to exactly the origin that set it —
which is a security property worth keeping and is simultaneously the reason one
sign-in cannot span two domains.

**`SITE_TAG = 'site'`** (`core/cache-tags.ts:24`) is a single literal on every
render, so any publish that flushes it flushes every site's pages.

**`createFolio` is one config object.** `blocks`, `types`, `globals`, `locales`,
`route`, `auth`, `basePath` and `bindings` are all singular
(`server/types.ts`). A host mounts one instance.

**`content_index`, `content_refs`, `versions`, `schedules`, `shares` and
`login_challenges`** all hang off a story id and inherit whatever the story
belongs to. They need a `site_id` only where a query starts from them rather than
from a story — the audit and the schedule sweep both do.

## Owner decision checkpoints

1. **Is a site a row or a deployment?** This spec assumes a row (decision 1) on
   the strength of the two-sibling-brands case. The alternative is real and
   cheaper and is argued in place.
2. **Do editors span sites?** Decision 5 says one account, per-site roles. The
   alternative — an account per site, which is what a `users.email` unique index
   already implies — is simpler and worse for a five-person agency.
3. **Does a block set span sites?** Decision 3 says yes by default and per-site by
   declaration. This is the one most likely to be wrong: it may be that every site
   wants its own vocabulary and sharing is the exception.

## User stories

### An editor signs in once and works on two brands

Signs in at `cms.meridian.example`, sees a site switcher naming both sites, opens All
About Africa's tree, publishes a guide. The published page appears on
`harbour.example`, not on the CMS domain.

### A developer adds a third brand

Adds a `sites` row and a `types`/`blocks` entry for it, points a domain at the
existing Worker, and creates content. No new database, no new bucket, no new
deployment, no migration.

### A visitor gets one site's content and never another's

`harbour.example/about` and `meridian.example/about` are different documents. A
link, a reference or a collection query on one site can never resolve to a story
on the other, and a bug that let it would fail a test rather than leak.

## Architecture decisions

### 1. A site is a row, and `site_id` goes on `stories`

Beat **one deployment per site**, which is what exists now and which is genuinely
cheaper: no migration, no new failure mode, perfect isolation, and Cloudflare
bills nothing extra for a second Worker. It loses on the thing the agency case is
actually about — *people*. Two deployments means two `users` tables, two sets of
sign-in links, two admin URLs, two sets of API tokens, and an editor who
maintains their own mental index of which one they are in. The multiplication is
per-brand and the agency's whole business is having more brands.

Beat **a site column on every table**, which is the same idea done exhaustively.
`site_id` belongs on `stories` and on the four tables that are queried
*without* a story in hand — `redirects`, `assets`, `users` (via a join table, see
decision 5), and `api_tokens`. Everything else reaches a site through its story,
and denormalising it there is a second copy to keep in step for no query that
needs it.

**The root story is where this gets decided or fudged.** Today the root has
`path = ''`, and `stories_path` is unique over non-null paths, so exactly one
document can be the site root. The index becomes `unique (site_id, path)`, and
that one change carries most of the routing: every site gets its own `''`, its own
`/about`, its own everything.

### 2. The host resolves the site, not Folio

`folio.handle()` and `folio.published()` take a `Request` or a path; neither takes
a site. Rather than adding a `site` argument to eleven functions, **`createFolio`
gains `sites: (req) => string | null`** — the same shape `bindings` and `route`
already have, and the same reasoning: only the host knows how it encoded the
thing. Hostname is the obvious implementation and is not assumed; a path prefix, a
subdomain, a header from a service binding and a hard-coded constant all work,
which is what keeps a single-site host writing nothing at all.

Beat **Folio matching hostnames from the `sites` table**, which is one line
shorter for the common case and wrong for every other one: preview and share URLs
run on a different origin from the published site, `localhost` matches nothing,
and a site reachable at two hostnames needs a second table.

Absent, the resolver defaults to a single implicit site whose id is `default`, so
**every existing host keeps working with no config change and no migration
visible to it.** The migration backfills `site_id = 'default'` on every row.

### 3. Block sets are per-site, defaulting to shared

`createFolio` takes `blocks` and `types` today. It gains the option of a map keyed
by site id, with a shared entry:

```ts
blocks: { '*': shared, harbour: [guidePage, …], meridian: [postPage, …] }
```

Beat **one registry for the deployment**, which is what the manifest, the admin's
block picker and `resolveValue`'s exhaustive switch all assume today. It fails on
the first collision: two brands both want a block called `hero` and they are not
the same hero. Namespacing block names by site (`aaa:hero`) was considered and
rejected — it puts a site id inside every stored `blok.type`, which is the one
string a document cannot cheaply rewrite.

Beat **a package per site**, which is decision 1's rejected alternative wearing a
different hat.

The manifest becomes per-site, which the admin already fetches per boot, so the
block picker narrows for free. `SchemaIndex` becomes per-site and every function
that takes one takes the site's.

### 4. The space channel is per-site; the story object is not

`SPACE_NAME` becomes the site id, so `ns.idFromName(siteId)`. One presence channel
per site, which is the correct blast radius: an editor sees who is in *their*
site's tree. `StoryDO` is already keyed by story id, which is globally unique
whatever site owns it, so it needs no change — and that is worth stating because
it is the part that would have been expensive.

`PROTOCOL_VERSION` goes to **5**: the space channel's frames carry story ids and
titles from a site the receiving client may not be able to open, so the site has
to be on the frame for a client to filter. A story socket needs nothing new.

### 5. One account, roles per site

`users.email` stays unique — one person, one row, one sign-in — and the global
`role` column moves to a `site_members (site_id, user_id, role)` table.

Beat **an account per site**, which needs no join table and is what the current
unique index already implies. Rejected because the case that motivates the whole
spec is one team working across brands: an account per site means three sign-in
links to three admin URLs for one person, and revoking somebody who leaves means
remembering all three.

A **platform admin** — somebody who can create sites and manage accounts — is a
`role` on the user row that survives the move, because "may create a site" cannot
be a per-site permission without a chicken-and-egg. Two levels, and no more.

The `__Host-` cookie stands, which forces the admin onto **one origin**
(`cms.meridian.example`, or `/folio` on any one of the sites). That is a constraint
rather than a cost: preview already runs on the published site's own origin
through `folio.handle()`, and the alternative is a cross-domain session, which is
a shared secret and a redirect dance to save one bookmark.

### 6. Cache tags gain the site, and `site` becomes `site:<id>`

`SITE_TAG` is a bare literal today, so a reindex — which always flushes it — would
purge every brand. `site:<id>` per render, and `story:<id>` needs nothing because
a story id is already unique. Cheap, and it has to land in the same change as
decision 1 or the first reindex on a two-site deployment is an outage for both.

### 7. Assets are shared, with a site column for the library's own listing

One R2 bucket and one `assets` table, because `assets.key` is already globally
unique and an image used by two brands should not be uploaded twice. `site_id` is
recorded so the media library defaults to *this* site's uploads, and it is a
filter rather than a fence — the picker offers "all sites" because an agency's
brand marks legitimately cross over.

Beat **a bucket per site**, which is real isolation and the right answer for a
multi-tenant SaaS. This is not one: the sites belong to one organisation, and the
isolation that matters is editorial, not adversarial.

## Wire & schema changes

### D1 migration `0005_sites.sql`

- `create table sites (id text primary key, name text not null, created_at …)`.
- `site_id text not null default 'default'` on `stories`, `redirects`, `assets`,
  `api_tokens`.
- `site_members (site_id, user_id, role)`, primary key on the pair; backfilled
  from `users.role` for the `default` site.
- Rebuild the four unique indexes with `site_id` leading: `stories_path`,
  `stories_parent_slug`, `stories_type_slug`, and `redirects` (which loses its
  `from_path` primary key for a composite).
- **Rebuilding `stories` is on the table**, not to be avoided: `redirects` needs a
  new primary key, which SQLite cannot alter in place, and `CLAUDE.md` says a
  rebuild is a correctness chore rather than a reason not to.

### Core types

- `Site { id, name }`, and `Resolution.site`.
- `FolioConfig.sites?: (req: Request) => string | null`.
- `FolioConfig.blocks` / `types` / `globals` accept a per-site map.
- `SINGLETON_PREFIX` composition becomes `sng_<site>_<type>`, which is the one
  stored-id change in the spec and the reason it cannot be purely additive.

### New or changed routes

- `GET {base}/api/sites` — the switcher's list, scoped to the caller's memberships.
- Every list route gains an implicit site scope from the resolver; **none gains a
  `?site=` parameter**, because a scope a caller can set is a scope a caller can
  forget.

## Acceptance criteria

### Isolation

- Two sites each with an `/about` both resolve, to different documents.
- A `reference` field on site A cannot be pointed at a story on site B: the
  picker does not offer it and `resolveReference` returns null if one is written
  by an importer.
- A collection query on site A never returns a site B document, with a test that
  seeds both.
- A publish on site A purges no site B tag.

### Nothing changes for a single-site host

- `examples/demo` runs unmodified, with no `sites` resolver and no config change.
- The migration over an existing database leaves every path, id and URL identical.

## Implementation plan

Four phases, each green on its own.

### Phase 1 — the column and the indexes

`0005_sites.sql`, the `default` backfill, `site_id` threaded through
`server/stories.ts`'s queries. No config surface, no admin change: the deployment
has exactly one site and nothing can create a second. This is the phase that
touches the most files and changes the least behaviour.

### Phase 2 — the resolver and the routing

`FolioConfig.sites`, `storyByPath(db, siteId, path)`, `folio.published` and every
route scoped. Cache tags. `SPACE_NAME` becomes the site id and
`PROTOCOL_VERSION` goes to 5.

### Phase 3 — per-site schemas

The blocks/types map, per-site manifest, per-site `SchemaIndex`, and the singleton
id change. Wants its own phase because `resolveValue`'s exhaustive switch and the
admin's manifest fetch both assume one registry.

### Phase 4 — accounts and the admin

`site_members`, the platform-admin role, `GET /api/sites`, and the switcher in the
shell. The admin work is small — the sidebar already groups, and every screen's
data is already scoped by the routes underneath it.

## Edge cases

- **A story moved between sites.** Out of scope, and it should refuse rather than
  half-work: its path, its references and its inbound links all belong to the old
  site.
- **A site deleted.** Refuse while it has stories. A cascade that drops a brand's
  entire content on one click is not a feature.
- **The resolver returns an unknown site id.** A 404 from `handle()` and `null`
  from `published()`, never a fallback to `default` — falling back means a
  misconfigured domain silently serves another brand.
- **Two sites, one hostname, different path prefixes.** Works, because the
  resolver takes the whole request. Nothing else in the spec assumes hostname.
- **An asset deleted while another site uses it.** Already answered by
  `content_refs`' asset kind; the usage warning simply counts across sites.

## Testing requirements

- A workers test that seeds two sites and asserts every isolation criterion above.
  This is the spec's whole risk surface and deserves the fixture.
- A migrations test asserting the four rebuilt indexes and the `default` backfill,
  alongside the two `0001_init` assertions `migrations.test.ts` already pins.
- A unit test that a `Resolution` for site A contains no site B story.
- **Not** a test that two hostnames route correctly: that is the host's resolver,
  and Folio's half is one function call.

## Dependencies

- **Spec 18 (pagination) should land first.** Every list route changes shape in
  that spec and gains a scope in this one, and doing both at once means resolving
  two sets of conflicts in ~265 literal paths.
- Nothing else. Caching, bulk writes, scheduling and sharing all reach a site
  through a story.

## Out of scope

- **Multi-tenant SaaS.** Sites here belong to one organisation. Adversarial
  isolation — per-tenant encryption, per-tenant buckets, noisy-neighbour limits —
  is a different product and would reject decision 7 first.
- **Cross-site content reuse.** A block on site A embedding a document from site
  B. It sounds cheap and it means `resolve()` crossing the boundary the whole
  spec exists to draw.
- **Per-site theming of the admin.** The admin is one product.
- **Moving a site between deployments.** An export/import concern.

## Open questions

**All three resolved 2026-08-04, each to the leaning it already carried.** Recorded
as decisions rather than deleted, because the reasoning is what a reviewer needs and
"the spec used to be unsure about this" is worth knowing.

1. **`basePath` stays one value. Resolved: yes.** The admin is on one origin
   (decision 5), so there is one mount to name. A host that wants Folio at `/folio`
   on each site's own domain is asking for per-site *admin* origins, which decision 5
   already rejected for a stronger reason than this one — one account signing in once
   is the point. Preview running on the site's origin is not a counter-example: it is
   reached by an absolute URL built from the host's own `route`, so it never needed
   `basePath` to vary.
2. **`types` is a per-site map. Resolved: as decision 3 says.** The alternative — one
   shared list with each site naming a subset — is both less expressive (two sites
   cannot have a differently-shaped `page`) and, contrary to first impression, *more*
   to keep in step: a subset list is a second place a type's existence is recorded,
   and the two drift the first time a type is renamed.
3. **`ContentQuery` gains an explicit `site`, required for an in-process caller.
   Resolved.** It does contradict "no `?site=` parameter", and the contradiction is
   the point rather than a compromise: that rule exists so an *untrusted* caller
   cannot select a site, and `folio.query(env, …)` is the host's own Worker, which is
   trusted by construction and has no `Request` to resolve one from. The HTTP route
   keeps resolving the site from the request and never reads a `site` field, so the
   two paths cannot be confused — and a query with no `site` from in-process code is
   a type error rather than a silent read of every site's content.
