# Roadmap

Gaps, ordered. Informed by reading `the reference project`,
a production Storyblok + Next.js build (87 block schemas, 38 component folders).

## Done

**Stable story IDs.** Stories are keyed by an opaque `id`, which is also the
Durable Object name, so renaming or moving a page never orphans its draft or
mutation log. `path` is derived from the ancestor chain and recomputed for the
whole affected subtree on rename or move.

**Content tree.** `parent_id` + a fractional `ord`, the same ordering primitive
as blocks. Full CRUD (`GET/POST/PATCH/DELETE /folio/stories`), drag to reorder
and reparent, cascade delete, cycle rejection, slug collision handling.

**Content at `/`.** The root story has `path = ''`. No `home` special-case
anywhere, unlike the reference project which special-cases it in three places.

**Non-CMS routes.** `folio.handle()` returns `null` for anything it does not
own, *including* a preview request for a path with no story behind it, so host
routes always win. No system-path blocklist needed.

**Page metadata in the document.** `title`, `description`, `socialImage`,
`noindex` are ordinary fields on the root block, selectable in the tree as
"Page settings". They inherit sync, multiplayer, undo and versioning, and
publish atomically with content. Only routing structure lives in D1; `title` is
denormalised there purely as a cache for rendering the tree.

**Page history.** Two separate things, deliberately not conflated:

- **Versions** in D1 — coarse and meaningful. Every publish writes one; editors
  can name a checkpoint. Listable without opening a socket, and the list query
  omits the document payload.
- **Activity** from the DO log — fine-grained who-changed-what, summarised into
  phrases like "Changed Hero · Heading +2 more". Good for "who broke this",
  useless for restoring.

**Restore never overwrites the document.** `diff(live, target)` in core produces
a minimal mutation set, which is applied as one ordinary transaction. So a
restore syncs to other editors, appears in the activity trail, and Cmd+Z undoes
it. Verified: reverting a title change plus an added block yields exactly two
mutations, not a wholesale replace.

**Content model completeness.** `multilink`, `asset`, `multiasset`, `richtext` and
`reference` all work end to end. Links and references store ids and resolve at
render, so renaming a page fixes every link to it without rewriting a document.
Richtext is TipTap in the admin and a JSON walker everywhere else, so published
pages still ship nothing. See `PARITY.md` for what was deliberately left
out.

**Unpublish.** Publish's missing pair: one nullable-column write
(`published_doc`/`published_at` cleared, `unpublished_at`/`unpublished_by` set)
rather than the only previous route off "live", which was delete — cascading
the subtree, dropping every version and purging the Durable Object. No
cascade, idempotent, the draft and history untouched, one click to reverse.
`folio.status(env, path)` lets a host answer `410 Gone` for a page taken down
on purpose instead of guessing at `404`. See `docs/specs/editing/unpublish.md`.

**Multiple content types, and singletons.** `createFolio` takes a `types` array
rather than one `root` block type: each type names its own root block, so an
insight is not a page with six unused fields. `kind` decides the routing
consequence and nothing else does — a `page` lives in the tree and owns a URL, a
`record` and a `singleton` leave the tree entirely with `parent_id` and `path`
both null, which is what stops a record called "Contact" taking `/contact` from
the page that needs it. A singleton's id is *derived* from its type name, so
"exactly one" needs no column and no constraint. Deliberately **not** built:
per-type routing rules, since Folio derives a path from the tree and a
`pathPrefix` would only be a second derivation to keep in step. `reference` and
`multilink` can now be narrowed by type, enforced in the picker and again at
resolve. Spec: `docs/specs/foundation/document-types.md`.

**Globals: a singleton loaded into every page, rendered by the host's own
shell.** `FolioConfig.globals` names the subset of declared singletons a page
render pulls in; `resolve()` folds their ids into the same query `reference`
fields already run, so a site with a header and a footer costs no extra D1
read. `folio.renderGlobal(resolution, name)` emits the same
`data-folio-global` wrapper in every mode, host-placed rather than
Folio-laid-out, and `folio.global(env, name)` is the plain "read a singleton
by name" call for one read once at boot. A singleton previews in the context
of a real page via its type's `previewPath` and `?_folio=preview&as=<name>`;
one with none gets a bare preview instead. Deliberately **not** built:
template interpolation (`{{ settings.phone }}` inside a field) — a block that
needs it reads the global directly. Spec: `docs/specs/content-model/globals.md`.

**Identity and access: the CMS is closed.** `FolioConfig.auth` is **required**
with no default — either it names sign-in providers or it says `auth: 'open'` in
as many words, and `createFolio` throws otherwise, because a host that simply
forgot the key used to get a publicly editable CMS silently. Sessions are rows
in D1 behind an opaque 32-byte cookie stored as a SHA-256: no HMAC secret to
rotate, revocation is a `delete`, and a dumped database yields no usable
cookies. Two providers ship — `magicLink({ send })`, where the *host* sends the
mail because only the host has the binding and the from-address, and
`oidc({ issuer, clientId, clientSecret })` with PKCE, whose id tokens are
verified against the JWKS rather than decoded. Roles are global —
`viewer | editor | publisher | admin` — and each route declares its own minimum
at its mount; API tokens carry scopes instead, because a token is not a person.
Editor identity is no longer self-reported: the Worker validates the session
before the upgrade and hands the verified identity to the Durable Object as a
header, which is trustworthy because a DO namespace is not publicly
addressable. `hello`'s self-reported identity is advisory and
ignored (and at v3 it is one optional nested field rather than three required
ones — see Localisation below). A revoked session closes an open socket within a bounded window —
the expiry rides in the attachment and the D1 re-check is once a minute per
socket, deliberately not per keystroke. The login page ships no JavaScript.
Spec: `docs/specs/foundation/identity-and-access.md`.

**Content migrations: done.** Block schemas are code and documents are data, and
nothing reconciled the two. A migration is now a pure function from a document to
a list of mutations, which is what lets one function reach all three copies of a
document — the live draft through `StoryDO.commit` (so it syncs, lands in the
activity trail and undoes), `stories.published_doc` through `applyAll` and one D1
write, and a `versions.doc` row on *read* only, so history stays byte-true.
Migrations are **idempotent** and that is the correctness mechanism, not a
nicety: applied to an already-migrated document one produces zero mutations,
which makes the runner re-runnable after a partial failure and makes "did that
work" answerable by running it again. `field.rename/remove/default/map/split` and
`block.retype/wrap` implement that once each, so it is not reimplemented per
migration. The runner is explicit (`folio.migrate(env)`, or `POST /folio/migrate`
behind `admin`), batched with a `continueFrom` cursor, and chunks a document over
`MAX_TX_MUTATIONS` rather than refusing it. A drifted document shows a banner in
the editor, never a lock. `GET /folio/audit` is a separate read-only drift report
(orphan keys, unknown types, missing fields, plus two schema-only checks
`conditional-fields.md` deferred). Spec:
`docs/specs/foundation/schema-migrations.md`.

**The mutation vocabulary can express a type change.** `Mutation` gained
`retype`, and `PROTOCOL_VERSION` went to 2 — the first bump. It closes the one
gap in the vocabulary: `insert` refuses a duplicate uid and `remove` cascades
over the subtree, so "this block is a `quote` now" could not be written as a
transaction at all, and consolidating two block types meant an editor recreating
content by hand. A retype keeps the uid, the position and the children, touches
no field data, is invertible like everything else, and is emitted by `diff` —
which matters more than it sounds, because a restore is `diff(live, target)`, so
a diff blind to a type change would have restored the fields and silently left
the old type in place. The change is additive to a logged mutation: a `set`
written under v1 is still a `set`, which is the only rule a wire bump has to
satisfy, since the log outlives every deploy.

**Localisation: done, field-level, one document per story.** A translatable
field's source value stays in `Blok.data`; a translation is an entry in
`Blok.i18n[code]`, and `set` gained an optional `locale` (`PROTOCOL_VERSION` → 3).
The reason for that shape rather than a story row per language: a translation is
then an ordinary mutation, so it inherits multiplayer, undo, versioning, the
activity trail, atomic publish and per-keystroke preview with no new mechanism —
and two translators in different languages on the same page never conflict,
because they are writing different keys of the same blok. The cost is stated
plainly: a translator cannot restructure a page. `fieldValue` implements one rule
in one place — first defined and non-null wins, so `''` is a deliberate emptiness
and `null` reads as untranslated, which is how *un*-translating is expressible at
all. `translatable` is opt-in per field and the audit reports the text-ish fields
nobody marked, so the omissions are findable. Publishing publishes every language
at once, with the admin naming what is incomplete first. Paths are
locale-independent and the *host* owns how a locale reaches a URL — Folio derives
the inverse for its own preview by calling `route`, so a prefix, a subdomain and
`?lang=` all work with no convention encoded anywhere. Spec:
`docs/specs/content-model/localisation.md`.

**The second wire bump, and the rule it clarified.** v3 also sheds `hello`'s three
top-level identity fields, which have been advisory since accounts landed: what
remains is one optional nested `identity`, read in exactly one situation —
`auth: 'open'`, where there are no accounts and a client's self-report is all that
tells two anonymous tabs apart. `docs/sync-design.md` gained rule 10 out of this:
a change must be additive to a logged mutation and every old entry must replay
under its old meaning forever, so **a `set` with no locale is a source-locale
write, permanently**. The bump was still necessary — a v2 client handed a
locale-scoped delta would drop the locale and write into `data`, which is silent
divergence, not a missing feature.

**Collections, and story enumeration with them.** `folio.query(env, { type, where,
order, page, perPage })`, `GET /folio/content`, and a `collection` field an editor
narrows — filter, sort and offset-page over published documents. Filters and sorts
read `content_index`, a scalar projection of each document's **root** block written
*inside the publish batch*, one row per field per locale holding what that locale
renders. So a query cannot describe something that is not live, a failed publish
leaves neither, and a French index page filtering a French topic matches. An index
table rather than an expression index over `json_extract`, because the root blok's
uid is random (so the path is not a constant), it would need one index per field per
locale, and it could never reach a nested block. `POST /folio/reindex` is the
rebuild, for the one case publish cannot cover: a field newly marked `indexed`. A
`where` on a field nobody indexed is a 400 naming it, never an empty page.

It also fixed a scaling problem the *Uncovered* list did not name: **`resolve()`
loaded every story in the site on every page render**, every tree render and every
preview boot. It now loads the ids the document needs — its links (including the
story ids inside richtext link marks, which carry no href), its references, the same
sets for the documents it pulls in, and its own ancestors — with `stories: 'all'`
as the explicit opt-in for a host that wants the full map. `content_refs` records
the outbound edges in the same batch, which is what "used by N documents" reads.
(It is **not** what the cache purge set reads — that promise was wrong, and
`docs/specs/platform/caching.md` is where it is unpicked.) Spec: `docs/specs/content-model/collections.md`.

**Data documents.** Document types made a person *storable*; this made one usable.
`BlockDef.render` is now optional and `defineRecord` is the sugar that omits it, so
a record root no longer returns `null` from a mandatory function — deliberately
optional on every block rather than on a new definition kind, because the type
system cannot tell a record root from any other block and a marker to enforce it
would buy nothing. Absent renders nothing on a published page and a neutral
`folio-unrendered` note in the editor. A record **may** keep a renderer, and then it
is what `reference.content` renders; without one, `content` is **literally null** so
a block's `office.content ?? <own markup>` is not dead code.

`references()` is the plural of `reference`: a hand-picked, ordered array of story
ids resolving to one `ResolvedReference` each, with the same `types` filtering
re-checked at resolution. Not a collection with a filter — a query cannot express
"these three, in this order", and the records' own `ord` is one global order rather
than a per-usage one. An unresolvable entry is **dropped rather than left as a
hole**, so a deleted person shortens the list instead of rendering an empty card,
while the editor's input names it as "missing (deleted)" — renderer hides the
damage, editor surfaces it. Both ref walks (`referencedIds`,
`referencedIdsAllLocales`) see both kinds, which is what makes a hand-picked list
count as a usage.

The admin's Data rail is now an index of non-page types with counts, and selecting
one opens a table: the title, the root block's `indexed` fields, the draft state and
when it was last touched — sortable, searchable, twenty rows a page, all client-side
over the list `GET /folio/documents` already returns in full. It lists *documents*,
not published content, so an unpublished person appears with a draft badge; the
columns come from `content_index` and are therefore published values, which the
footer says out loud rather than leaving a blank cell to be misread as an empty
field. A record opens **full width with no preview**: there is nothing to preview,
and previewing it inside a page that references it is ambiguous the moment two pages
reference it differently. `GET /folio/documents/:id/usage` is what the delete
confirmation reads — it names the published documents pointing here, states that
drafts are not counted, and **proceeds**, because a broken reference already degrades
safely. Spec: `docs/specs/content-model/data-documents.md`.

**A Content API — `/folio/api/v1`, token-scoped, versioned, and writing through the
mutation log.** Reference: `docs/api.md`.

The decision the whole thing turns on is that **there is no second door into a
document**. A script's write is read-diff-commit through `StoryDO.commit`, exactly
as a keystroke is — so it appears in every open editor as a delta, lands in the
activity trail as `token:<name>`, is undoable with Cmd+Z, and cannot leave the draft
and the Durable Object disagreeing. Writing `published_doc` or the object's `doc`
row would have been faster to build and would have broken all four silently, visible
only to whoever happened to have the page open. An unchanged payload produces zero
mutations and writes nothing, so a nightly sync of 400 products of which three
changed is three writes.

Consumers send and receive **nested documents** — `{ type: 'hero', fields: { heading,
actions: [ … ] } }` — not the normalised graph, so nobody outside the library has to
know that fractional indexing exists. `toNested` / `fromNested` (`folio/engine`) are
the conversion and are public because the Storyblok importer needs them too. **uids
round-trip**: optional on the way in, where present means "this blok, in place" and
absent means "a new one, between its neighbours", which is what keeps version diffs
minimal, presence attached to the right block and undo granular. Order is positional,
and existing sibling keys are kept wherever they can be, so inserting at the front of
a list of fifty is one insert and zero moves.

`PUT /content` defaults to **merge** — an absent field, `i18n` or slot leaves what is
stored alone — which makes a partial payload safe and makes the locale problem
disappear. `mode: 'replace'` is opt-in and is the only mode that can lose content it
was not told about, so a replace omitting `i18n` on a blok holding translations is
refused with the locales named rather than diffing them away. `PATCH /fields` is the
narrower tool: one `set` per field, no structure touched, `locale` scoping the whole
request.

`Idempotency-Key` rides on the log's own `tx_id` unique index rather than a table of
its own, so a retry is answered `replayed: true` with the original `syncId` from
machinery that already existed. Scoped per document, because the log is.

A second surface over one set of services, deliberately: the admin's routes ship
inside the library and stay free to change with it, while `/api/v1` is a contract
with somebody's script and changes by gaining a `v2`. A session cookie works on both
at the equivalent role, so there is one enforcement point rather than two.
`folio.write(env, id, mutations, opts)` is the same path with no HTTP for a host's
own Worker. Spec: `docs/specs/platform/content-api.md`.

**Caching published pages, and purging them on publish.** Two headers from
`folio.cacheHeaders(resolution, { story })` on the host's published response, plus
`"cache": { "enabled": true }` in its wrangler config, and a publish invalidates
every page that rendered the published document — globally, from inside the
Worker, with no webhook, no shared secret, no API token, no zone and no paid plan.

**The dependency set is computed at render, not looked up at purge.** That is the
whole design and it is the opposite of what this file used to promise. A
`Resolution` already *is* the set of ids a page loaded, so it is emitted as
`Cache-Tag` — `story:<id>` per id (links, references, ancestors, collection items
and the page's own), `global:<name>` per global, `type:<name>` per collection
query, plus `site` — and a publish becomes `purge({ tags })` with no lookup
anywhere. No table, no migration, no reverse index.

`Cache-Control` is `public, max-age=0, s-maxage=604800, must-revalidate`, and the
zero is the load-bearing part: a purge reaches the edge and **cannot** reach a
browser cache, so any nonzero `max-age` buys a stale copy nothing can evict. The
edge TTL is a week because invalidation is the mechanism and the TTL is only the
fallback for a purge that never arrived.

Folio purges; the host tags. The purge is an *internal* hook on
`publish-hooks.md`'s own seam rather than something each host writes, because the
purge set is derived from Folio's internals and every host would reimplement that
mapping and drift from it. Four events were added for write paths that changed
published bytes and fired nothing at all: `updated` (a **title-only** patch
changes every page linking to that document and `pathsChanged` skips it by
design), `migrated`, `reindexed` and `redirectsChanged`. A migration purges the
ids it rewrote, precisely, batching at 100 tags and flushing past five calls — one
minute of the Free plan's budget; a reindex always flushes, because which pages
hold a collection is exactly what nothing records. Preview is a hard bypass
(`private, no-store`, no tag).

Nothing about it is observable locally — miniflare simulates no part of Workers
Cache — so every computation is a pure function with unit tests behind it and
`scripts/cache-probe.mjs` covers the rest against a deployment. Spec:
`docs/specs/platform/caching.md`.

## Next

### 1. Scheduled publishing

A DO alarm per story. Small, and a real Cloudflare advantage: no cron worker, no
queue, no polling. Now unblocked: a scheduled publish writes a version like any
other. Scheduled *un*publishing (an expiry date) is a one-line addition to the
same alarm once this exists: `unpublish()` (`server/publish.ts`) already takes
no `Request` and no `Env`, for exactly this reason.

## Uncovered from the reference project

**Cookie-based draft mode.** Preview today is iframe-only (`?_folio=preview`).
Editors also need to browse the *real* site in draft, across navigations. The
reference does this with `/api/preview` + `/api/exit-preview` setting a signed
cookie. We should do the same; it also makes share-a-preview-link work.

**Cache invalidation on publish (and unpublish). Done** — see *Caching* under
*Done* above. Kept here because the shape of the answer is the useful part: the
reference runs `revalidate = 60` plus a Storyblok webhook hitting
`/api/revalidate` with a shared secret, and none of that was needed, because the
host's Worker and the CMS are the same process.

**This entry used to say the item was "pick a cache, not invent a mechanism".
That was wrong**, and it stayed wrong right up until somebody tried to compute a
purge set. It is not computable from anything stored: globals leave no
`content_refs` edge because they come from config rather than a field, collection
membership is a query run at render, a title-only patch changes every linking page
and fires no event at all, ancestors are loaded by path and are never an edge, and
`content_refs` truncates at 400 rows per document. A reverse index over it —
which `ROADMAP.md:190` promised, in this very file — would have been silently
incomplete five different ways.

Two more things that only measurement caught, recorded here because both are the
kind of wrong that ships green. `caches.default.delete()` is **per-colo**, so the
obvious purge-in-a-publish-hook is a TTL with extra steps. And the `cache` export
of `cloudflare:workers` is **request-scoped**: holding a reference at module scope
gives a permanent no-op that never purges, never errors and passes every unit
test. Neither is discoverable from the types. Spec:
`docs/specs/platform/caching.md`.

**Per-story access control, for site visitors.** The reference has an
`access_level` field on story content and gates *rendering* on the visitor's
roles. CMS auth is now built, and this is deliberately not the same problem:
identity-and-access.md scoped itself to who may edit, and reading a published
page still needs no account. It attaches in two places when wanted — a field on
the root block, which document types already make per-type, and a host check
before `folio.published()`. Per-story *editor* permissions are the other half,
and want a way to name a set of stories: revisit after
`docs/specs/content-model/collections.md`.

**SSO group → role mapping.** `oidc({ provision })` sets a default role for a
staff account on first sign-in; mapping IdP groups onto Folio roles needs claims
configuration per tenant and is a follow-up. So is an `auth_events` table: the
activity trail and version rows already record who changed content, but sign-ins,
role changes and token creation are not recorded anywhere.

**SEO metadata.** Mostly done: `title`, `description`, `socialImage`, `noindex`
are fields on the root block and the demo renders them into `<head>`. Still
missing schema.org / article structured data, which the reference generates.

**Scale of the block picker.** 87 block types. The current "+ Add block" menu is
an unsorted flat list, which stops working somewhere around 15.

## Known smaller issues

- The space channel does not carry a sibling **reorder**: nothing in `stories`
  changes path when two siblings swap places, so `pathsChanged` does not fire and a
  peer's tree keeps the old order until its next load. Closing it means a second
  after-commit path for the sake of a row moving up one place, so it is named
  rather than built.
- Live propagation of a *draft* edit inside a global into another page's open
  preview is unbuilt. `global.changed` fires on **publish** and the admin refetches
  its copy from it, so the seam exists and the published case works; the draft case
  would mean `StoryDO` holding the space binding and emitting on every transaction,
  which is content on the space channel in all but name.
- A structural event triggers one `GET /folio/stories` rather than patching the
  tree in place. Not laziness: `StoryNode.url` is computed by the host's own
  `route` on the server, so a client cannot derive the URL of a page whose path just
  moved, and a tree holding the new path with the old URL would leave every link in
  the open preview pointing at the vacated address. Patching would need the event to
  carry server-rendered URLs.
- Login rate limiting is a partial answer, and says so: sign-in links are capped
  per address per hour out of `login_challenges`, but the IP dimension needs a
  Cloudflare rate-limiting rule at the zone, which is not Folio's to configure.
- No way to bootstrap the first admin over HTTP, on purpose: an endpoint that
  creates an admin is an endpoint that creates an admin. The first `users` row is
  a `wrangler d1 execute` deploy step.
- Passkeys, TOTP and password login are all out. Magic link plus OIDC covers both
  audiences, and a password store is a liability nobody asked for.
- The library ships TypeScript source; the host compiles it. Fine for now, wrong
  for a release. (The `folio/core` / `folio/engine` export split is done; build
  artifacts and `.d.ts` generation are not.)
- The DO mutation log grows without bound. Fine against the 10GB per-object
  limit, but it wants compaction eventually. The `tx_id` unique index and
  contiguous syncIds make a compaction watermark straightforward now.
- `versions` also grows without bound: every publish stores a full doc copy and
  nothing prunes checkpoints. Wants a retention policy.
- Content migrations have no `down`. Every mutation is invertible and the log
  holds what happened, so one is writable when something needs it — but a
  generated inverse over 142 documents applied hours later is a worse tool than a
  new forward migration, and offering it would imply a safety it does not have.
- A migration over a huge document lands as several transactions and therefore
  several undo steps, not one. Named in the dry run's `oversized` list rather than
  hidden; the alternative was refusing to migrate the biggest pages at all.
- a11y in the admin, what is left of it: the content tree's rows are click-only
  and there is no keyboard reorder. Dialogs and toasts are done (see the 2026-07-30
  pass below), so what remains is the hard half — reordering is drag-and-drop over
  a fractional index, and the keyboard equivalent has to express "between these two
  siblings" with no pointer, which is a UI question before it is an a11y one. The
  same shape as `references()`'s ↑ ↓ buttons. Biome's a11y rules stay off until
  it is done, and turning them on is its own sweep across every admin file
  (see biome.json).
- Translated slugs are out: a French URL contains English words. Additive when it
  is asked for (`stories.path_i18n` plus a locale-aware `storyByPath`), and
  deliberately not now — per-locale paths fork the unique index, the `derivePaths`
  walk, the tree and every link resolution.
- The content tree's translation-completeness badge is drawn for the *open* story
  only, from the draft already in the store. Every row would be one request per
  row; a route exists (`GET /folio/story/:id/translation`) for a caller that wants
  one story's answer, and a tree-wide answer wants a single query over
  `published_doc` rather than N Durable Object reads.
- The audit has no admin surface. `GET /folio/audit` answers in full, but
  `Migrations.tsx` renders migration status and nothing else, so every drift
  finding — orphan keys, unknown types, missing fields, and now document size —
  is reachable only by a script or a curl. The report shape is stable and three
  families wide now, which is the argument for building the panel rather than
  against it.
- `content_index` is keyed on the field *name*, not on (type, field). So filtering
  one document type on a field only another type declares matches nothing rather
  than 400ing, and two blocks declaring the same indexed name are one queryable
  field. Correct for every case examined and cheap to tighten if it bites.
- A collection's `order` takes a single field. One was enough everywhere it was
  looked at, and a second is additive — but it has to be threaded through the
  canonical form, the query string and the SQL, so it is not free.
- The Data list view sorts, searches and pages **client-side**, over the whole list
  `GET /folio/documents` returns in one request. Correct and free at the scale
  examined, and the same ceiling collections sets — but a type with thousands of
  documents wants the paging pushed into SQL, which means a `stories`-sourced query
  that can also `order by` a joined `content_index` row.
- The Data list view's columns are **published** values, source locale. A draft
  document's cells are blank (the footer says so), and a translated value is not a
  column. Both would want the same server-side query as the point above.
- `references()` reorders with ↑ ↓ buttons rather than drag-and-drop. Keyed by story
  id, so it never needed the local ids `MultiAssetInput` now mints — but the spec
  asked for drag, and that is the same a11y-shaped work as the tree's keyboard
  reordering.
- `min` on a `references()` field warns in the editor and is not enforced on write.
  Consistent with `required` across the whole field system, and it should be fixed
  in one place for every field rather than here first.
- The admin has no dialog primitive. Six dialogs share one hand-rolled shell
  (overlay, scrim button, panel) and `hooks/useFocusTrap.ts` is the only piece
  actually factored out; the CSS is duplicated five times over too. A seventh
  dialog is the point at which a `<Modal>` wrapper beats the hook, and the hook is
  what it would be built on.

## Fixed 2026-07-30 (the small-items pass)

Four bullets off the list above, plus two clauses of the a11y one. Taken because
they were small, not because they were next; recorded here so the list stays
honest.

- Deleting a story clears its `content_refs` rows in **both** directions, in the
  same batch as the story rows. Unpublish deliberately keeps the inbound half —
  the story still exists, so "used by N" is still a true warning about it — which
  is why the two are separate statement builders and not one, and why
  `records.test.ts` pins the difference against a later tidy-up that folds them.
- `GET /folio/audit` grew a third finding family, one per document rather than per
  blok or per declaration, warning at three quarters of `MAX_DOC_BYTES` with a
  per-locale breakdown of where the weight went. `docBytes` (`core/protocol.ts`)
  is now the single measurement and `docCapError` was rewired through it, so the
  warning counts bytes exactly the way the door enforces them; a test asserts that
  equality, because a warning that drifts from the cap it warns about is worse
  than no warning. The threshold is 75% because the cap has no soft landing — the
  transaction that crosses it is refused whole — so the warning has to arrive
  before a locale-sized jump rather than during one.
- `useReferencedDocs` walks every locale, through the same
  `referencedIdsAllLocales` the server resolves with, so the editor no longer
  misses a target that only a translation points at.
- `MultiAssetInput` mints a stable local card id per entry, so reordering a
  gallery moves DOM nodes instead of remounting them. The stored value is
  untouched — the ids are React keys and nothing else. Matching is two-pass,
  byte-identical first for a reorder and then `key ?? url`, because one pass would
  remount the card on every alt-text keystroke, which is a worse bug than the one
  being fixed.
- Every dialog in the admin is a real modal, over one implementation
  (`hooks/useFocusTrap.ts`): focus in on open, back to the opener on close, Tab
  cycling, Escape to close. The five confirmations had none of it and were
  mouse-only. They also stopped naming their own scrim as part of the dialog, and
  swapped `aria-label` for `aria-labelledby` on a heading they already render, so
  a screen reader says "Delete /blog/old-post?" rather than "Delete document".
  Dismissal by scrim or Escape is inert exactly while Cancel is, so a dialog
  cannot disable Cancel to say an irreversible delete is past calling back and
  then let Escape call it back.
- The toast is a permanently mounted `role="status" aria-live="polite"` region
  whose text changes, rather than a div that appears. A live region has to exist
  before its content changes to be announced reliably, which is why it is
  unconditional, and why it collapses on `:empty` rather than `display: none` —
  hiding it would take it back out of the accessibility tree and reintroduce the
  same problem.

Not covered by tests, and named rather than faked: focus movement, Tab cycling
and focus restore. `test/unit/admin` runs under Node with no jsdom and no
`@testing-library/react`, so the pure predicates (`keyAssets`, `isTabbable`) are
unit-tested instead and the DOM behaviour is not. A test rendering a
hand-duplicated copy of the markup would assert against the copy.

## Fixed 2026-07-29 (the hardening pass)

Everything below was a "known issue" or review finding before this date;
recorded here so the list above stays honest. Tests: 584 across unit (Node) and
workers (workerd). CI runs typecheck, Biome, both suites and the demo build.

- Publishing is atomic (version row + `published_doc` in one batch) and every
  publish retains a version.
- Deleting a story purges its Durable Object; drafts no longer resurrect.
- The sync engine converges: clients rebase pending txs over server order,
  offline edits queue and replay with txId dedupe, the watermark is contiguous,
  invalid mutations (cycles, orphans, root moves, uid collisions) are rejected
  at the door and no-ops on replay. See docs/sync-design.md.
- `diff()` emits inserts → moves → sets → removes, so version restore cannot
  destroy rescued children (property-tested).
- Every HTTP input is validated (valibot) and every failure is one envelope
  shape; wire frames are versioned, size-capped and shape-checked.
- Uploads are typed by magic bytes and size-capped before buffering; SVG and
  unknown types download instead of executing; transforms are clamped and
  cached.
- `javascript:` URLs die in `asLink`, richtext link marks and `resolveLink`.
- D1 has real migrations; `db:remote` can no longer drop tables.
