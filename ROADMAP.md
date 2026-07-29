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
the outbound edges in the same batch, which is what "used by N documents" and, later,
a cache purge set will read. Spec: `docs/specs/content-model/collections.md`.

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

**Cache invalidation on publish (and unpublish).** The reference runs
`revalidate = 60` plus a Storyblok webhook hitting `/api/revalidate` with a
shared secret. We own both sides, so publish can purge directly — no webhook,
no secret, no eventual consistency window. Unpublish has to purge the same
keys, or a cached page outlives the row that served it. The seam now exists
(`docs/specs/platform/publish-hooks.md`): a host's `hooks.published` and
`hooks.unpublished` fire after each write commits, with the story and, for
`published`, the document. What is still missing is only the cache layer
itself (Cache API or KV in front of D1) for a hook to purge — this item is
now "pick a cache", not "invent a mechanism". One wrinkle globals.md adds:
publishing a global has to purge *every* page that rendered it, not one, so
the purge key for a page must include the globals it rendered, not just its
own path.

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
- a11y in the admin: click-only tree rows, no keyboard reorder, no focus trap in
  the media library, no aria-live on toasts. Biome's a11y rules are deliberately
  off until this is done properly (see biome.json).
- `MultiAssetInput` keys cards by index, so reordering drops focus; needs stable
  local ids (noted inline where the suppression lives).
- Translated slugs are out: a French URL contains English words. Additive when it
  is asked for (`stories.path_i18n` plus a locale-aware `storyByPath`), and
  deliberately not now — per-locale paths fork the unique index, the `derivePaths`
  walk, the tree and every link resolution.
- The content tree's translation-completeness badge is drawn for the *open* story
  only, from the draft already in the store. Every row would be one request per
  row; a route exists (`GET /folio/story/:id/translation`) for a caller that wants
  one story's answer, and a tree-wide answer wants a single query over
  `published_doc` rather than N Durable Object reads.
- Nothing warns when a document's *bytes* approach `MAX_DOC_BYTES`, which
  localisation makes reachable: eight languages of long richtext is eight times
  the payload at the same block count. The audit is the right place for it.
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
  id, so it does not have `MultiAssetInput`'s focus bug — but the spec asked for
  drag, and that is the same a11y-shaped work as the tree's keyboard reordering.
- `min` on a `references()` field warns in the editor and is not enforced on write.
  Consistent with `required` across the whole field system, and it should be fixed
  in one place for every field rather than here first.
- Nothing prunes `content_refs` rows pointing *at* a deleted story. Another
  document still names it, which is the fact "used by N" reads, and the row is
  rewritten when that document is next published — but a site that never republishes
  accumulates edges to ids that no longer exist.
- The admin's `useReferencedDocs` still walks source-locale `reference` values only.
  The server's resolution walks every locale, so a live page is right; the editor's
  own copy would miss a target only a translation points at.

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
