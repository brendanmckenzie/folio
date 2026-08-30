# Roadmap

Gaps, ordered. Informed by reading a production Storyblok + Next.js build
(87 block schemas, 38 component folders) as a reference project.

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

### 1. Pagination, everywhere, as a rule

**Nothing may be unpaginated — no route, no list, no panel.** Found while
planning the UI rebuild (`docs/design-system.md`), and it is a bigger constraint
than the thing that surfaced it: the admin's command palette was going to rank
documents client-side over the list the tree already fetches, which is only cheap
because something worse is already happening.

Audited 2026-07-30, and the state is three-tiered:

**Properly paginated — two, and one of them is the pattern to copy:**

- `GET /redirects` → `listRedirects` (`server/redirects.ts:169`): a real keyset
  cursor over `(created_at, from_path)`, `limit` defaulted to 50 and clamped to
  200. This is the shape everything else should take.
- `GET /api/v1/documents` → `rt.query`, which is `collections.md`'s engine and
  pages properly.

**Capped but not paginated — silent truncation with no page two:**

- `GET /assets` → `listAssets(db, limit = 200)` (`server/assets.ts:37`). No
  search either, so asset 201 is unreachable by any means.
- `GET /story/:id/versions` → `listVersions(..., limit = 50)`.
- `GET /story/:id/activity` → `limitParam(limit, 60, 200)`.

**Unbounded — the whole table, every request:**

- `GET /stories` → `listStories(db)`. The worst one, and the sharpest detail:
  `listStories` **already takes `{ limit, offset }`** and not one of its seven
  callers passes it.
- `GET /documents` → `listDocuments`, every unrouted document or every row of a
  type.
- `GET /users`, `GET /tokens` → `listUsers`, `listTokens`, whole table each.
- `GET /audit` → no limit anywhere in `server/audit.ts`.

**Status 2026-07-31: every read on this list is paged, and the list is closed.**
It took two passes and the second one is the interesting one.

`docs/specs/foundation/pagination.md` paged assets, versions, users, tokens and the
stories tree. Three survived it deliberately, each because paging them meant deciding
a *screen's* shape and deciding it twice was the cost of doing it early — and all
three then came back differently from the spec's guess when the screen was built:

- **`GET {base}/api/documents`** (`ui-architecture.md` port phase 3). Its envelope
  carries the `indexed` column values, which turned out to belong **on the row** and
  not in a sibling map keyed by id — paging is what makes that a rule rather than a
  preference, since a map left over from the previous page would quietly supply
  values for rows no longer on screen. And *asking is what creates a singleton* moved
  to its own request, `?kind=singleton`, because ensuring is a **write** and hanging
  it off an unqualified list meant `?cursor=` decided whether a document came into
  existence. That request is uncursored and is not an exception to the rule: a
  singleton set is bounded by the host's own `types` literal, so it cannot grow when
  somebody publishes.
- **`GET {base}/api/story/:id/activity`** (same phase). The one where paging was not
  a nicety: the Durable Object's log grows with every transaction, so before it the
  501st entry was unreachable by any means. Its keyset is the first **one-column**
  one — `sync_id` is monotonic within a document, so a tiebreak could never fire, and
  `Keyset` grew `[string] | [string, string]` rather than accept a fictional second
  column.
- **`GET {base}/api/audit`** (port phase 5, with the Model screen). It read the whole
  `stories` table through `publishedDocsAll`, and it survived longest because the
  audit is an operator's tool rather than a screen — which is precisely the argument
  for paging it: an operator runs it on the site that has a problem, and that is the
  big one. It now walks `publishedDocsAfter` over a `continueFrom` cursor and the
  panel merges batches client-side, the way `migrate` already did. `publishedDocsAll`
  is deleted; the audit was its only caller.

Two things `pagination.md` also left owed are done: **`GET {base}/api/search`** is
real and the palette is on it (the `?flat=1&q=` stopgap could reach neither a record
nor a `content_index` value), and the admin's **boot path holds no unbounded read at
all**. `Editor.tsx`'s `buildResolution` was the last unpaged read and it **went with
the file**: port phase 8 deleted the old editor, and the rebuilt one resolves an open
document from `useEditor`'s narrowed id set instead.

The UI half is the same story from the other end, and is now history. Every admin
list *was* one unpaged request; `DataTable` paged **20 rows client-side over the full
list**, and `StoryTree` capped a level at 50 rows with "Show all N" — a *render* cap
over data already transferred, which is the worst of both: it paid the cost and hid
the rows anyway. Both files are deleted; every screen under `admin/ui/` reads a paged
route, and the tree appends a level at a time.

**Why this is a spec and not a sweep of `limit` clauses.** Three things depend on
`GET /stories` returning everything, and each needs a different answer:

1. **The tree.** Paging a tree means paging *within a parent*, so the tree loads
   one level at a time, ordered by `ord`. That also makes collapse mean something
   and retires "Show all 812".
2. **Link and reference pickers.** They currently filter the full list in memory.
   They need a search route, which is the same route the palette needs.
3. **`buildResolution(flat, …)` in the admin**, which needs every story to turn a
   link's target id into a URL for the open preview. This is the load-bearing one
   and the reason the full fetch has survived. The answer already exists
   server-side: `storiesFor(db, ids, paths)` (`server/stories.ts`) resolves a
   batch in one query, so the admin wants `GET /stories?ids=…` and to ask for the
   ids a document actually mentions — exactly what `resolve()` does on the server.

Open decision for the spec: **keyset cursors everywhere, and the UI stops
promising page numbers.** Keyset matches the redirects precedent, is correct under
concurrent writes and needs no `count(*)`; the cost is that "Page 3 of 7" becomes
"next/previous", which over live content was a lie anyway. A separate cheap
`count(*)` can still front a header ("24 documents") where one is worth a second
query.

Sequenced **before** `docs/specs/admin/url-and-shell.md`, because the URL's list
parameters (`?q=&sort=&page=`) have no meaning until this decides what a page is.

### 1a. The admin's internal JSON moves off the bare paths

Found by building the shell prototype (`admin/ui/`, 2026-07-30), and the same
conversation as pagination because both decide what a list route looks like.

`docs/ui-architecture.md` gives the screens `{base}/content`, `{base}/assets`,
`{base}/documents/:type` and `{base}/redirects`. **All four answer JSON today**,
so no screen can have its own URL until the API moves. The prototype is mounted at
`{base}/ui` for exactly that reason: the screens win the pretty paths because a
screen is what a person links to and bookmarks, and `server/app.ts` already
declares those routes internal to the admin and free to change with it.

**Resolved 2026-07-31: the internal prefix is `{base}/api/`**, alongside the
existing `{base}/api/v1/*`, under one rule — **a version segment is a promise, and
its absence is the absence of one.** A workers test pins the partition so nobody
adds an internal route under a versioned prefix. Rejected `{base}/_/`
(unguessable), the screens under `{base}/admin/` (a segment on every human-facing
URL forever), and content negotiation on one path (fails silently the first time
something sends the wrong header).

Cost: mechanical but wide — roughly 265 literal paths across `test/` and
`scripts/`. The client is nearly free, because every admin fetch already goes
through `boot.apiBase` and the rebuilt router is relative to its mount.

**Specified in full** in `docs/specs/foundation/pagination.md` decision 3, as its
phase 3 — a rename with no response body changed.

### 1b. The icon system. Done — drawn, not imported

**This entry described the unicode glyphs as still shipping, and they have not been
for some time.** Found 2026-08-04 while about to write a spec for work that was
already built, which is the reason the correction is worth as much as the entry was:
`admin/ui/icons.tsx` is the answer to every question this asked.

Every question it posed, answered in that file: **drawn by hand**, not a set
imported — a 24-unit box rendered at 16px, `stroke="currentColor"` with no `fill` so
dark mode is free. **The grid, the stroke (1.5), the caps and the joins live in one
`svg()` wrapper and no individual icon states any of them**, so an icon cannot
express a different weight without editing the wrapper. `IconName` is a closed
union and `ICONS` is a `Record` over it, so a tenth nav item that forgets a drawing
is a type error in two places rather than a blank 16px box in the rail.

The defect it fixed is also recorded more precisely there than here: not that the
glyphs were ugly, but that `⚿` had **no glyph at all** in most UI fonts and drew as
tofu, `⚙` was doing duty for two different nav items, and `◆` is solid black beside
`⌂`'s hairline. A set assembled from whatever a font happens to contain has no
consistent weight, grid or optical size.

Two things left, both small: the 16px render size is a literal rather than a token,
and icons still appear only in the sidebar and the collapsed rail — the design
system's primitives use none, which was the second half of this entry's question and
remains unanswered because nothing has asked for one.

### 2. Scheduled publishing. Done — and *not* with a DO alarm

Shipped as `docs/specs/platform/scheduled-publishing.md` (spec 19), the first of
`docs/completion-plan.md`'s delivery gaps. A `schedules` table (`0003`), four routes
under `{base}/api/`, `folio.runSchedules(env)` for a host's own `scheduled()` handler,
and a cron trigger in `examples/demo/wrangler.jsonc`. Both actions: a publish and an
unpublish are one `action` column, so a campaign window is two rows.

**This entry used to say "a DO alarm per story. Small, and a real Cloudflare
advantage: no cron worker, no queue, no polling." It was wrong**, for a reason that is
only visible from `server/story-do.ts`: **a Durable Object has exactly one alarm, and
`StoryDO` already spends it** on the debounced draft watermark (`applyTransaction` sets
it 2s out, guarded by `getAlarm() === null` meaning "already scheduled"). The two uses
cannot coexist. A publish alarm set for Tuesday makes `getAlarm()` non-null for days,
so no watermark is ever written and the tree stops reporting unpublished changes on
that page; let the watermark win instead and any keystroke on Monday resets the alarm
to `now + 2s`, at which point `alarm()` has to decide which job it is — and the honest
version of that is `where at <= ?` reimplemented in SQLite inside every object.

A cron also answers a question an alarm structurally cannot: **"what is scheduled
across this site"** is one indexed D1 read, where an alarm-based design would have to
wake every Durable Object. A schedule nobody can list is a schedule nobody trusts,
which is why `GET {base}/api/schedules` exists and why a failed schedule is retained.

What the prediction got right: `unpublish()` taking no `Request` and no `Env` is
exactly what made the second half free, and a scheduled publish does write a version
like any other — attributed to whoever scheduled it, not to the cron.

The cost of a cron is granularity: a minute at finest, best-effort within it, so a
schedule fires on the first sweep *at or after* its due time. Never early, late by at
most one tick. A site with nothing scheduled pays one probe of an empty partial index.

### 3. Bulk write endpoints. Done — and the count turned out to be two mechanisms

Shipped as `docs/specs/platform/bulk-writes.md` (spec 20), the second of
`docs/completion-plan.md`'s delivery gaps and `docs/ui-architecture.md`'s dependency 7.
Five routes under `{base}/api/bulk/` — publish, unpublish, duplicate, move, delete —
over a selection that is either the ids somebody ticked or `{ all: true, filter,
expected, exclude }`, with no ids materialised at all. No migration, no wire change: the
guard is the same `count(*)` a list header opts into and the job's state is one opaque
cursor in the caller's hand, exactly as `migrate`, `reindex` and `runSchedules` work.

**`ui-architecture.md` decision 7a specified this in unusual detail and one thing was
missing from it.** "The count is validated once, at the start of the job" leaves nothing
to stop a set that *grows* under a long run from enlarging it — publish all 12 matching
drafts, somebody creates nine more while the job walks, and a cursorless-set walk
publishes 21. So the count is also the **ceiling**: a run touches at most
`expected - exclude.length` documents however many batches it takes, carried in the
cursor so it survives the caller re-calling. "Delete all 12 matching" can never delete
13.

Two smaller findings worth keeping:

- **`routed` had to become a `StoryFilter` key before the guard could work at all.** A
  list route states its scope positionally (`listStoryLevel(db, parentId)`,
  `path is not null` hardcoded in flat mode) and a captured filter is JSON with no
  positions, so the guard counted records too and refused every select-all Content could
  make — permanently, which is a wall rather than a door. This is the concrete form of
  `foundation/pagination.md` decision 5's warning that the header's count and the bulk
  guard must not drift, and it was invisible until the third reader of `StoryFilter`
  existed.
- **Duplicate is the one action that cannot take a select-all**, and refusing it is not
  a shortcut: a copy of a draft is a draft, so it joins the very filter the job is
  walking. Excluding what the job created means remembering the ids it created, which is
  materialising the id list the shape exists to avoid.

Nothing here is atomic and the report says so — successes counted, refusals named, one
document at a time in its own `try`. The three per-document workflows (duplicate, move,
delete) moved out of their routes into `server/documents.ts` on the way, because the
delete batch already existed in two copies and a third is where one of them forgets the
schedule cleanup.


## Uncovered from the reference project

**Cookie-based draft mode. Done 2026-08-30, as spec 25** (`platform/draft-mode.md`),
merged with the host-layout draft render below, because they are one feature: browsing
the *real* site in draft across navigations is what "a draft rendered in the host's own
layout" means once you can follow a link. The reference does it with `/api/preview` +
`/api/exit-preview` setting a signed cookie, and the shape carries over —
`{base}/draft/enter` and `{base}/draft/exit` — but the cookie is not signed, because
Folio's session and share cookies are both opaque tokens matched against D1 rather than
HMACs, and a third mechanism to rotate is worse than reusing the two that exist.
Share-a-preview-link is already built (spec 21); what this adds is that it lands on the
host's own page.

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

- **`{base}/mcp` speaks MCP revision `2026-07-28`. Done 2026-08-04, Modern-only**, and
  the spec's amendment (`platform/mcp-server.md`) carries the six non-obvious parts. Two
  are worth having on this list.

  **HTTP status became protocol-significant**, which is the part that could have shipped
  wrong and green. Every JSON-RPC error used to travel on a `200`, which is ordinary
  practice; now `-32601` must be a `404` and the version and header errors must be `400`,
  because a dual-era client reads status *and* body together to decide whether to fall back
  to a handshake. A wrong status fails no request — it silently makes such a client fall
  back to `initialize` and then fail there.

  **The endpoint was already the shape the new revision assumes.** `2026-07-28` moved MCP
  to a stateless core: no handshake, no session, no server-to-client stream. Decision 9
  rejected the SDK, SSE, the session and a Durable Object back when that read as a
  shortcut, and every one of those rejections is now what the protocol takes for granted.
  The migration was a constant, a method rename and a validator.

  What stays open is not a decision but a fact about the ecosystem: which of Anthropic's
  client surfaces speak `2026-07-28` today is not published, and `docs/mcp.md` names four.
  A dual-era client probes `server/discover` and works; a surface still pinned to Legacy
  gets a `400` naming the revision that would work. That is the accepted cost of the
  decision, recorded so nobody re-opens it as a bug.

- **A draft has no render inside the host's own layout, so "does this look right"
  is answered against Folio's preview shell.** Spec 24 added `?_folio=draft` — the
  draft with no editing chrome, no marker divs and no bridge — and its
  `preview_document` tool screenshots it. But `folio.handle()` answering that URL
  means the *host's* own page render never runs, so what a share link and a
  screenshot both show is Folio's preview shell: the document's own content, on the
  host's block CSS, with globals stacked above it rather than placed the way the
  host places them. The document subtree is node-for-node what the published page
  renders, which is what a screenshot clipped to one block is about; the chrome
  around it is not the host's. `server/pages.tsx` has said so in place since long
  before this ("a simplification, not a claim of visual fidelity"), and
  `preview_document` now captions the limit in its own result rather than letting a
  model infer the host's layout from Folio's approximation.

  **Specified 2026-08-04 as spec 25, `docs/specs/platform/draft-mode.md`**, which also
  absorbs *Uncovered*'s "cookie-based draft mode" — browsing the real site in draft
  across navigations is the same feature seen from the other end. The decision this
  entry said Folio had not made is made there: a documented `folio.draftAt(env, req,
  path)` the host branches on in its own `fetch`, rejecting a `handle()` that hands a
  draft back, because that inverts a contract which today returns either a `Response`
  or `null` and would serve nothing for a host that ignored the third case. The
  unwired-host question is answered by a `draftMode` config key rather than by
  inference: with it a share link lands on the page's real URL, without it on
  `?_folio=draft` exactly as now.

  Writing it turned up that most of the machinery is already public: `folio.draft(env,
  id)` returns a draft, `folio.render(doc, { mode: 'mark' })` renders one with no
  chrome, and the share cookie already scopes a grant to one story. What is missing is
  the contract, not the capability.

  **Built 2026-08-30.** `folio.draftAt(env, req, path, locale)` is that contract: a
  host calls it in its own miss branch before `published`, and Folio answers only
  "may this request see this draft". Two credentials satisfy it — an editor holding
  a session whose role reaches `READ_DRAFT` *and* the `folio_draft` flag set at
  `{base}/draft/enter`, which drafts every page; or a reviewer's share cookie, which
  drafts exactly the granted story. A request carrying neither costs **no D1 read**,
  which is what makes a call on every page render affordable and is the one
  assertion the tests spend a binding spy on. `folio.noStore()` ships beside
  `cacheHeaders` because the two look interchangeable and one of them caches
  unpublished content at the edge under the page's real URL. `draftMode: true` is
  the host's promise that the branch exists, and it flips where a share link lands.

- **The admin still computes a restore in the browser, and the route that would do it
  server-side is already live.** `admin/hooks/useVersions.ts:375` builds
  `diff(live, target)` client-side and posts the mutations; spec 24 shipped
  `POST {base}/api/v1/documents/:id/restore`, which does the same read-diff-commit
  behind one request and is tested. Nothing is broken — the client-side diff is the
  same `diff()` the server runs, and the restore still lands as one ordinary
  transaction — so this is duplication rather than a defect: two callers of the same
  core function, one of which has to hold the whole target document in the browser to
  call it. Spec 24 named this as its optional phase 6 and it was deliberately not
  built, on the grounds that the route wanted a consumer chosen on purpose rather than
  by reflex.

- **`adminCss` under `build.cssCodeSplit: false`. Fixed 2026-08-04, and the fix was
  a branch rather than the mechanism this entry predicted.** The plugin computed
  `__FOLIO_ASSETS__` as `['/folio-admin.css']` unconditionally; with code splitting
  off, Vite bundles every stylesheet in the client build into one hashed
  `assets/style-<hash>.css` and emits no such file, so a production build linked a
  stylesheet that 404s and the admin rendered unstyled behind a 200. Dev was fine —
  Vite injects entry CSS from JS there, which is why `adminCss` is `[]` — so the
  first sign of it was a deploy. Found building a consumer host, which sets
  the flag; the demo does not, so the demo's build was correct and proved nothing.

  **This entry said the fix needed `generateBundle` plus a runtime lookup, "not a
  one-liner", and that was wrong.** A `define` is indeed baked at transform time, but
  `config()` is handed the host's own `userConfig` — and `build.cssCodeSplit` is a
  flag the host sets in exactly that object. So the strategy is visible at the moment
  the constant is computed, and the fix is to read it: when it is off, the one
  stylesheet is pinned to `folio-client.css` and both `adminCss` and `previewCss`
  point there. It is named `client` and not `admin` because it holds the host's CSS
  too — one stylesheet is all there is, which is the cost of the flag rather than of
  the fix.

  Two things worth keeping. The residual hole is a **plugin** setting the flag, which
  `config()` cannot see; `configResolved` throws for that case, naming the cause,
  because the paths are already baked by then and refusing to ship is all that is
  left. And the missing **tripwire** mattered as much as the bug:
  `test/unit/vite/plugin.test.ts` is the plugin's first test at all, driving the
  `config()` hook directly, and two of its assertions fail against the old code. The
  emitted name was verified against a real `cssCodeSplit: false` build rather than
  guessed — Vite calls the bundle `style.css`, which is why it did not match the
  `folio-` test that pins the other fixed names.

- **A framework plugin's array of client entries used to break the build
  outright**, and that half is fixed (`foldClientEntries`). Recorded here because
  the shape recurs: this plugin's `config()` contributions are merged with every
  other plugin's, and Vite concatenates when either side is an array. Anything it
  returns under `build.rollupOptions` should assume a framework got there first.

- **A story whose D1 row arrives without its Durable Object is unrecoverable through
  any supported write.** Found 2026-08-30 on a real staging environment, and it is the
  predictable consequence of copying a database between environments: `stories` and
  `versions` copy, Durable Object storage cannot. The first editor open then calls
  `draftFor` → `getOrInit(seed(...))`, which seeds a **blank** document with a **fresh
  root uid** (`runtime.ts`'s `seed` mints one through `blankSubtree`; it is not derived
  from the story id, so purging and reopening produces a third one).

  From there every write path is closed, because `diff` refuses documents with
  different roots (`core/diff.ts:29`) and its own comment states the assumption that
  has just been broken: *"Both documents must share a root uid. They always do for a
  given story, since the root block is created once and never replaced."* True when a
  document is created through Folio, false when its row was imported. So `POST
  /documents/:id/restore` and `PUT /documents/:id/content` **both** fail, the second
  only when the payload names the old root — and the admin's Restore button reports
  `Cannot diff documents with different roots`, which describes the mechanism and not
  the cause.

  The escape that does exist is not obvious: `fromNested` uses `base.root` rather than
  the payload's (`core/nested.ts:313`), so `PUT /documents/:id/content` **with the
  root's `uid` omitted** rebuilds the published content under whatever root the draft
  already has, and the diff then succeeds. That is a workaround, not a fix — it
  requires knowing the internals to find.

  The fix is to seed from the published document instead of from blank when one
  exists: a story with `published_doc` and no draft should draft from what is live,
  which is the only case whose behaviour changes (a document created through Folio has
  no published copy at seed time). The cost is that the seed has to become lazy —
  `getOrInit` takes a `Doc`, so today the seed is computed on every draft read and used
  almost never, and reading `published_doc` eagerly to build it would put a D1 read on
  the hot path. Wants a spec rather than a patch.

- **A block's `render` gets no `Resolution`**, so it cannot `resolveAsset` a
  *referenced* document's asset field — it works only while such assets use the `url`
  arm. `core/block.ts:38` is the signature:
  `render?: (props: PropsOf<F> & { uid: string }) => ReactNode`. Found by the first
  host outside the demo (2026-08-01) and recorded until now only in that project's own
  code comment, which is why `foundation/documentation.md` moved it here: a defect a
  consumer meets on day one, written down in a repository the consumer does not have,
  is not written down. The fix is a second argument rather than a wider props object —
  a resolution is not a field and merging it into `props` puts it in the type a block
  author reads as "my fields".

- **The write paths no longer read every story on the site. Done 2026-08-04.**
  `createStory`, `updateStoryStatement` and `deleteStoryStatement` each called the
  unbounded `listStories(db)`, so creating, renaming, moving or deleting one document
  read every document on the site, and `duplicateStory` inherited it through
  `createStory`. `routes/editor.ts`'s `/edit` fallback was a fourth, taking
  `(await listStories(db))[0]` to answer "is there anything at all" — now `limit 1`.

  Two narrow readers replaced them, both sitting beside the pure function they feed:
  `siblingGroupRows` is `inGroup`'s predicate in SQL, which is all `uniqueSlug` and
  `orderAt` ever look at, and `subtreeRows` is `descendants` in SQL — a **recursive
  CTE over `parent_id`**, not a `path like` prefix, because the root story's path is
  `''` (no prefix describes its children) and a drifted path would move a row in or
  out of a subtree that `parent_id` disagrees about. The point was to read fewer rows,
  not to quietly change which rows.

  **Two hazards, both real, both already covered — verified by breaking the code
  rather than by reading it.** Removing the ancestor chain from `updateStoryStatement`
  fails 3 tests; writing `parent_id = ?` bound to null instead of `parent_id is null`
  fails 8. The second is the SQL trap worth remembering: equality against null is
  null, so every top-level page would have believed itself the only one and the first
  slug collision would have surfaced as a unique-index refusal instead of a suffix.
  The first is subtler — `derivePaths` treats a row whose parent is absent from its
  input as top-level, so a subtree-only read silently promotes a moved page to the
  root. One test was added for the case the suite could not reach: depth. Every
  existing case works one level from the root or from null, so a derivation that only
  ever climbed one level passed all of them.

  **This entry used to count `storyTree` among them, and that was wrong.** Its one
  caller is `folio.tree(env)` (`server/index.tsx:409`), a documented public API where
  handing back the whole tree is the entire point — a shape, not a list, as the
  function's own comment says. `runtime.ts`'s remaining call is the `stories: 'all'`
  opt-in and is likewise deliberate. Both are untouched, and the miscount mattered: a
  sweep that trusted this list would have broken the one call a host makes to build a
  navigation.

  One accidental capability is gone, named rather than mourned: because
  `derivePaths` used to run over every row, a rename would repair *any* stored path
  that had drifted from its ancestor chain, anywhere on the site. Nothing specified
  that and nothing relied on it; it now repairs the subtree it is rewriting and the
  chain above it.
- **The table-bodied screens' headings are 4px out from their own cells.** `Access`,
  `Model` and `Redirects` put a section heading in `ListHeader` — an 8px row gutter —
  above `Table` cells with a 12px gutter, so nothing quite lines up vertically. It is
  the same defect the Settings h1 had at 8px, and it has the same cause:
  `.header`'s padding exists to align a title with `List` **rows**, and a screen whose
  body is a table has no rows. Settings cancels it locally and `List.module.css` says
  why that is the right shape rather than a `level === 1` special case.

  Fixing it properly is an alignment pass over every screen — deciding one gutter and
  making the header, the rows and the cells all consume it — not an edit to one rule.
  Cosmetic at 4px, which is why it is here and not in the change that found it.
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
- The library ships built JavaScript now — `dist/`, esbuild, one
  bundle per entry with source maps and no minification, and `exports` pointing at
  it (`docs/specs/foundation/package-build.md`). Two things are deliberately still
  source, and one is deliberately still blocked:
  - `folio/preview` and `folio/admin-entry` ship as TypeScript **on purpose**, and
    permanently. They are entry points of the *host's* client bundle — the Vite
    plugin puts them in `rollupOptions.input` — so the host's Vite owns their TSX
    and their 33 `*.module.css` files. A project reaching them has Vite by
    construction, and prebuilding the admin would move the
    "`/folio-admin.css` exists and is not a hashed chunk asset" tripwire out of
    `pnpm build`, which is the only thing that catches it.
  - **`folio/core`, `folio/engine` and `folio/server` now point `types` at
    `dist/types`, all three together** (2026-08-01). `src/server` emits
    declarations at last, and the entry this bullet used to hold was wrong about
    how: it offered `#private` as the cheap alternative to a declared return
    type, and `#private` fixes nothing. tsc reports `Property '#sql' …` in the
    same place and reports `ctx` and `env` besides, which are `protected` on
    `DurableObject` and are not ours to rename — **a class expression extending
    `DurableObject` cannot be serialised into a `.d.ts` at all**. So
    `createStoryDO` and `createSpaceDO` declare their return types, and
    `StoryDOInstance` / `SpaceDOInstance` are the names the emitter writes.

    `examples/demo/dts-probe/` came out of it and stayed: everything else in the
    repo resolves `folio/*` through the `development` condition, so nothing
    compiled against the emitted declarations. It is one `createFolio` call in a
    tsconfig without `customConditions` — `pnpm --filter demo typecheck:dist` —
    and it reproduces the split-entries failure on demand. A tool, not CI,
    because `dist/` is gitignored.
  - Flipping `private: true` is the actual release step, along with a version, a
    licence and a package-level README. `pnpm pack` already produces the right
    tarball: 292 files, `dist/` + `src/` + `migrations/`.
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
- a11y in the admin: **the hard half is done** (2026-07-31, `ui-architecture.md`
  port phase 2). The rebuilt Content screen's rows are real `treeitem`s with a
  roving tabindex, and `⌥↑ ⌥↓ ⌥← ⌥→` reorder and reparent — the question this
  entry called "a UI question before it is an a11y one" was answered by moving one
  page at a time, so "between these two siblings" never has to be expressed.
  `content-model.ts`'s `gestureMove` is the arithmetic and is unit tested.
  **The sweep is done too** (2026-07-31, port phase 8): `biome.json`'s `overrides`
  entry is gone and `"a11y": "on"` sits in the top-level rule set, so the rules apply
  to the whole tree — `src/`, `test/`, `scripts/` and `examples/demo` alike. It found
  **nothing**, which is the expected result rather than a suspicious one: every file
  the scoped rules did not cover was the old admin, and phase 8 deleted all of it.
  Note the switch is `"a11y": "on"` and not merely dropping `"a11y": "off"` — the
  `recommended` preset carries a *subset* of the group, so removing the override
  without the explicit `on` would have quietly turned four rules off for `ui/**`,
  including the `noNoninteractiveElementInteractions` a suppression in `FieldRow.tsx`
  depends on. Two things the rules caught earlier, in code that had passed review:
  `Table.tsx` carried `aria-sort` on the sort *button* rather than the header cell,
  where it is announced by nothing, and a `role={x ? 'a' : 'b'}` expression makes
  every `aria-*` on the element unverifiable — literal roles per branch are the fix.
  Still open: `references()` reorders with ↑ ↓ buttons and the tree has no *drag*
  at all (the keyboard is the only route today; a pointer user must use the row
  menus).
- Translated slugs are out: a French URL contains English words. Additive when it
  is asked for (`stories.path_i18n` plus a locale-aware `storyByPath`), and
  deliberately not now — per-locale paths fork the unique index, the `derivePaths`
  walk, the tree and every link resolution.
- The content tree's translation-completeness badge is drawn for the *open* story
  only, from the draft already in the store. Every row would be one request per
  row; a route exists (`GET /folio/story/:id/translation`) for a caller that wants
  one story's answer, and a tree-wide answer wants a single query over
  `published_doc` rather than N Durable Object reads.
- **A row whose document type is no longer declared is reachable again** —
  `unknown-document-type`, a story check on `GET {base}/api/audit`, drawn by the Model
  screen's audit panel with a link per row. `DataList.tsx` listed these under an
  "Unknown type" heading, on the grounds that a row made invisible by a code change is
  a row nobody can recover, and the generated nav means an undeclared type has no
  `/documents/:type` to list them on — so the panel's link is not a convenience here,
  it is the only route to the document.

  **This entry used to claim the audit "already reports `unknown types` in full", and
  that was false in a way that mattered.** `unknown-type` is about a `blok.type` —
  a *block* inside a document whose definition is gone. `DataList`'s heading was about
  `stories.type`, the document's own kind. Two different faults, one of which was not
  reported at all, which is why building the panel needed a new check rather than a
  new view. The distinction is easy to lose again: both read as "unknown type" in
  prose.

  **Narrower than `DataList`'s was, in two ways**, so do not assume parity. It sees
  **published documents only**, because that is the only copy the audit reads
  (`publishedDocsAfter`, no Durable Object) — an unrouted *draft* of an undeclared type
  is still unreachable, and reaching it means a `stories` read this report deliberately
  does not make. And it is **silent when no document types are declared**, matching
  `unusableIndex`: no types means "cannot judge", not "every type is undeclared".
- **The audit has an admin surface**: the Model screen's audit panel
  (`ui-architecture.md` port phase 5). All four families are drawn — orphan keys,
  unknown block types, missing fields, document size — plus the schema-only checks and
  the new `unknown-document-type`, grouped by which of `server/audit.ts`'s three arrays
  they came from, and **each finding links to the documents it is about**. Three things
  the panel needed that the route did not have, all now landed:
  - **`?continueFrom=&batch=`.** It read the whole `stories` table in one query,
    which was the last unbounded read in the admin and the one place a *read-only*
    report could exceed a request's CPU limit. `publishedDocsAll` is deleted.
  - **`ContentFinding.sample`.** A tally is a count by design, so a finding had no
    document to link to. Five ids per finding plus the remaining count answers both.
  - **`Explained.note`.** Every `detail` was a varying head and a boilerplate tail, so
    nine findings drew as nine copies of one sentence. The check now says what
    *differs*, and omits the field when nothing does.
- `content_index` is keyed on the field *name*, not on (type, field). So filtering
  one document type on a field only another type declares matches nothing rather
  than 400ing, and two blocks declaring the same indexed name are one queryable
  field. Correct for every case examined and cheap to tighten if it bites.
- A collection's `order` takes a single field. One was enough everywhere it was
  looked at, and a second is additive — but it has to be threaded through the
  canonical form, the query string and the SQL, so it is not free.
- **Sorting a Documents column by an `indexed` field is not offered.** The list
  itself sorts, searches and pages server-side now (`ui-architecture.md` port phase
  3), over three `stories` columns — `ord`, `title`, `coalesce(draft_updated_at,
  updated_at)`. An `indexed` field is the one axis missing, and it is missing for
  three reasons rather than for effort: the value is two columns (`num_value` then
  `text_value`), index rows are written inside the publish batch so the column is
  **null** for anything unpublished, and `content_index_lookup` cannot be intersected
  with `stories.type`. `core/story.ts`'s `DocumentSort` names the shape it takes when
  somebody asks — a three-component keyset with sentinel coalescing — and why that
  buys reach at the cost of the property a keyset is for. Mitigated in practice:
  `documentColumns` skips the type's `titleField` as a field column because its value
  *is* the title, so the sort anybody reaches for on a record list is `title`.
- The Documents screen's columns are **published** values, source locale. A draft
  document's cells are blank and the row's own `changed`/`draft` badge is what says
  why — which replaced a standing footer note apologising for it on every page. A
  translated value is still not a column, and would want a second dimension nobody
  has asked for.
- `references()` reorders with ↑ ↓ buttons rather than drag-and-drop. Keyed by story
  id, so it never needed the local ids `MultiAssetInput` now mints — but the spec
  asked for drag, and that is the same a11y-shaped work as the tree's keyboard
  reordering.
- `min` on a `references()` field warns in the editor and is not enforced on write.
  Consistent with `required` across the whole field system, and it should be fixed
  in one place for every field rather than here first.
- **The dialog primitive exists. This entry was stale**, found in the same
  2026-08-04 sweep as the icon one. `admin/ui/Dialog.tsx` is the shell — portal,
  scrim, panel, footer actions, `useFocusTrap` inside it rather than beside it — and
  fifteen files render a `<Dialog>`, so the "seventh dialog is the point at which a
  wrapper beats the hook" prediction was right and was acted on. It carries a
  `danger` prop for the reason its own comment gives: `variant="danger"` is a
  *quiet* button by design, which in a footer left Cancel looking heavier than
  Delete — the affirmative action reading as the lesser of the two is the worst
  hierarchy available for the one control that cannot be undone.

  Five surfaces still call `useFocusTrap` directly rather than through `Dialog`
  (`BlockPicker`, `DocumentPicker`, `RichTextField`, `FocusMode`, `HistoryPanel`).
  That is not obviously wrong — a rail, a focus mode and a panel are not modal
  questions — but it is the thing to look at before adding a sixth.

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
- A `multiasset` field mints a stable local card id per entry, so reordering a
  gallery moves DOM nodes instead of remounting them. The stored value is
  untouched — the ids are React keys and nothing else. Matching is two-pass,
  byte-identical first for a reorder and then `key ?? url`, because one pass would
  remount the card on every alt-text keystroke, which is a worse bug than the one
  being fixed. `keyAssets` was `MultiAssetInput`'s and now lives in
  `admin/ui/screens/assets-model.ts`, with the same test — it was imported across the
  old/new seam for the whole port rather than copied, so port phase 8 moved one
  function instead of reconciling two.
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
- Uploads are typed by magic bytes and size-capped before buffering; unknown
  types download instead of executing, and SVG renders inline only behind
  `default-src 'none'; sandbox` and never through a transform; transforms are
  clamped and cached.
- `javascript:` URLs die in `asLink`, richtext link marks and `resolveLink`.
- D1 has real migrations; `db:remote` can no longer drop tables.
