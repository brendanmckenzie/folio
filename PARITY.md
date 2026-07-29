# Parity roadmap: delivering the Reference site on Folio

What Folio needs before `the reference project` could be rebuilt on it
instead of Storyblok + Next.js.

Derived from that repo: 87 block schemas, 38 component folders, Next 15 App
Router, Lucia auth on Postgres, S3 uploads, visx charts.

## The important framing

**Most of that repo is application code and stays application code.** The charts,
carousels, forms UI, typewriter effects, filtering, schema.org output, the Lottie
animations — all of it is React that consumes CMS data. Porting it is
framework-migration work (Next → Vite/Workers), not CMS work.

Folio's job is to supply the primitives those components read. That is where the
real gaps are, and it is a much smaller list than "87 blocks".

Sizing below is deliberately coarse: **S** ≈ a day, **M** ≈ a few days, **L** ≈ a
week or two. Treat as relative weight, not a quote.

## Already working

Content tree with stable ids, page metadata in the document, drafts synced
per-keystroke with multiplayer, versions with preview and restore, publish
snapshots, activity trail, zero-JS published pages, host-owned routing.

---

## Phase 1 — Content model completeness

Nothing else can be built on placeholder fields. Counted usages across the real
schema:

| Field | Uses | Work | Size | State |
| --- | --- | --- | --- | --- |
| `richtext` | 31 | TipTap in the admin, structured JSON storage, a renderer component, and marks/nodes constrained per field | **L** | **done**, minus tables and embedded bloks |
| `asset` | 32 | R2 upload proxied through the Worker, media library, alt text, focal point, and resizing via the `IMAGES` binding | **L** | **done** |
| `multilink` | 37 | Union field: internal story reference, external URL, email, anchor, asset. Needs story-reference resolution at render | **M** | **done** |
| `multiasset` | 2 | Falls out of `asset` | **S** | **done** |

Also needed here: **`reference` fields**. The reference project resolves
`Form Selection.form`, inlining a referenced Form story at fetch time. **Done** —
see below.

**Phase 1 is complete.** All four field types plus `reference` work end to end,
covered by 75 checks in `scripts/fields-test.mjs`, with the sync and history
suites still green. What remains inside these fields is listed under *Deferred*
below; none of it blocks Phase 2.

### Done: `multilink`

Stores `{ kind: 'story', id }` for internal links and resolves the id to a URL at
render time, so renaming a page rewrites every link to it without touching a
single document. Verified in `scripts/fields-test.mjs`. The reference project
stores `cached_url` instead and would need a rewrite pass over every story.

Blocks receive links already resolved, and `rel="noopener noreferrer"` is added
automatically alongside `target="_blank"` so a block author cannot omit it.

Resolution travels as a `Resolution` map beside the document rather than being
fetched per render, because the preview re-renders in the browser per keystroke.
The admin builds it from the story tree it has already loaded, so links cost it
no extra requests.

All five kinds are complete, including linking to an uploaded file.

### Done: `asset` and `multiasset`

Uploads proxy through the Worker into R2, so no credentials and no S3 endpoint are
needed and `wrangler dev` works out of the box. A D1-backed media library makes a
file reusable.

Two departures from the reference project, both deliberate:

- **Alt text and focal point are per usage.** Storyblok keeps them on the asset
  record, which forces one alt string per file across every place it appears.
  Folio copies the library default in on pick and lets the two diverge.
- **The focal point is a normalised `{x, y}`, not a pixel crop box.** Storyblok's
  `focus` string only means anything alongside the original dimensions; ours
  survives any resize and drives both `object-position` in CSS and `gravity` in a
  server-side crop.

Dimensions are read from the file header on upload (PNG, JPEG, GIF, WebP), so a
page can reserve space for an image without an Images binding being configured.

Resizing lives behind `/folio/asset/:key` and uses the `IMAGES` binding, which
takes the R2 stream directly. That keeps the resizing strategy out of stored
values entirely, so the same document renders on a zone, on `workers.dev` and in
local dev. Falls back to the original when a transform fails *or returns an empty
body* — the latter is real, and a 1x1 source triggers it.

Worth recording for the migration: the brief assumed `/cdn-cgi/image/` was the
only URL-based option and that it rules out `workers.dev`. That holds for the URL
form, but `fetch(url, { cf: { image } })` works on `workers.dev` and is mocked in
`wrangler dev`. It was still passed over, because it needs the Worker to fetch its
own asset URL and therefore a `Via: image-resizing` loop guard.

### Done: `richtext`

TipTap in the admin; the renderer walks the stored JSON and imports no TipTap, so
published pages still ship nothing. The build is checked for TipTap leaking into
the preview bundle, since that single mistake would undo the whole proposition.

Stored as one field value per the decision taken up front, which makes concurrent
edits to one field last-write-wins, as in Storyblok.

`marks` and `nodes` constrain a field, and this is enforced twice on purpose: the
editor's ProseMirror schema is built from the list, so **paste is filtered on the
way in**, and the renderer sanitises again for content arriving from an importer
or the API. Dropping a node unwraps it, so a pasted heading becomes a paragraph
rather than disappearing.

Links inside prose store a `LinkValue`, not an `href`, so a rename reaches them
too. This is a departure from TipTap's own Link extension, which stores the URL.

Two things the reference project's renderer does that Folio does not: **tables**,
and a **text colour** mark. Neither is hard; both were left out to keep the field
vocabulary honest. Its renderer also silently drops embedded `blok` nodes inside
richtext — a bug there rather than a feature to copy — and Folio has no equivalent
either way. Host projects also cannot yet override how a node renders; that is
fine while the output is semantic HTML, and will need revisiting when it is not.

Note for the importer: node names follow TipTap's camelCase (`bulletList`), while
Storyblok emits snake_case (`bullet_list`). The mapping is mechanical but real.

### Done: `reference`

Replaces `resolve_relations: 'Form Selection.form'`. Folio derives the referenced
id set from the schema, so there is no per-fetch configuration to forget and a page
with no references costs no extra reads.

Preview resolves the referenced **draft**; a live page resolves the **published**
copy, so public pages never leak another story's unpublished work. Resolution is
bounded to one level, which matches Storyblok and stops a self-reference from
recursing.

**Filtering by document type: done**, with Phase 2's document types. The reference
project's schema uses `filter_content_type: ["Form"]`; the equivalent here is
`reference({ types: ['form'] })`, and `multilink({ types })` narrows a story link
the same way. Enforced twice, like `richtext`'s `marks`: the picker only offers
matching documents, and resolution re-checks, because content also arrives from an
importer or over the API. A wrong-type value resolves to `null` and the block
renders its empty state.

### Deferred, and not blocking Phase 2

- Richtext tables and a text colour mark.
- Embedded bloks inside richtext.
- Host-defined rendering overrides for richtext nodes.
- Presigned uploads, which would only matter for files far larger than images.
- `required` is still declared and ignored, as noted in Phase 5.

Richtext is the single biggest item in the whole roadmap and I would not
underestimate it — constrained marks, embedded blocks inside richtext, and
paste-handling are where these always get expensive.

## Phase 2 — Multiple document types, querying, singletons

The site has at least five root types: `Page`, `Insights`, `Resources`,
`ProgramContent`, `Config`.

- **Document types: done.** `createFolio` takes a `types` array, each entry naming
  its own root block, so an insight is not a page with six unused fields.
  `stories` gained a `type` column and `path` became nullable
  (`migrations/0006_document_types.sql`). `root: 'page'` still works, as sugar
  for a single `page` type.

  One thing the reference project has that Folio deliberately does **not**: a
  per-type routing rule. That is a Next.js artefact. Folio derives a path from
  the tree, so an insight under the "Insights" page already serves at
  `/insights/whatever` — a `pathPrefix` would only be a second path-derivation
  rule to keep in step with the first. Instead a type's `kind` decides whether it
  is in the tree at all, and `under` constrains where in it a document may go.
- **Singletons: done.** A singleton is a document with a *derived* id
  (`sng_settings`), created on first access — no `singleton boolean` column and no
  uniqueness constraint, because there is no other id a second one could be
  created under. The document itself is editable and publishable like any
  other, and refuses to be deleted or duplicated.
- **Globals: done.** `Config`-style host-side reading — `folio.global(env,
  'settings')`, and `FolioConfig.globals` for the subset loaded into every
  page's `Resolution` for free, alongside whatever `reference` fields already
  fetch. `folio.renderGlobal(resolution, name)` is the host's own shell
  placing one; a singleton previews in the context of a real page via its
  type's `previewPath`. Not built: template interpolation inside a field —
  a block reads a global directly instead. `docs/specs/content-model/globals.md`.
- **Localisation: done, and the reference project does not use it** — recorded
  here because it changes the *document* model, which everything on this list
  reads. One document per story holds every language: a translatable field's
  source value stays in `Blok.data` and a translation is an entry in
  `Blok.i18n[code]`, written by an ordinary `set` with a `locale` on it. So an
  importer, the query API and full-text search below each need to decide which
  language they are reading, and `fieldValue(blok, name, resolution.locale)` is
  the one answer. Not built, deliberately: **translated slugs** (a French URL
  contains English words — per-locale paths fork the unique index, the path
  derivation, the tree and every link resolution) and **per-locale publishing**
  (one document, one snapshot, so a half-translated page goes live with
  fallbacks). `docs/specs/content-model/localisation.md`.
- **Query API** — this is the sleeper. `sitemap.ts` pages through every story;
  the insights index filters by topic and paginates. Storyblok gives
  `getStories({ content_type, filter_query, per_page, page, sort_by })`. Folio has
  a tree endpoint and nothing else. Needs a real list/filter/paginate API over
  published docs, which means indexing selected fields out of the JSON into
  queryable columns on publish. **L**
- **Full-text search** — there is a `SearchComponent`. D1 supports FTS5, which is
  what EmDash uses. Index on publish. **M**
- **Datasources** — Storyblok key/value lists; their revalidate webhook handles
  `datasource_id`, so they are in use. **S**

## Phase 3 — Authentication, twice over

Two separate concerns that are easy to conflate:

**CMS auth** — who may edit. Folio has none; anyone reaching `/folio/edit` can
publish. Also required to make multiplayer identity real: the DO currently trusts
a self-reported name in `hello`, so the Worker must validate the session before
the WebSocket upgrade and pass the verified user in. Sessions in D1 behind a
signed httpOnly cookie; OIDC to Microsoft 365 for staff, magic link for client
editors. Not Cloudflare Access, per your call. **M**

**Site auth** — who may read. The reference has `roles`, `users`, `user_roles`,
`sessions`, `otp_codes` in its own Postgres, an `access_level` field on story
content, role-based redirects, and email OTP login. On Folio the field is trivial
(metadata already lives on the root block); the substance is porting Lucia +
Postgres to D1, and OTP email to Cloudflare Email Sending. Mostly application
work, but Folio must expose access rules to the renderer. **M**

## Phase 4 — Preview, caching, publishing

- **Cookie draft mode** — preview is iframe-only today. Editors need to browse
  the real site in draft across navigations, and share preview links. Replaces
  their `/api/preview` + `/api/exit-preview`. **S**
- **Cache + purge on publish** — they run `revalidate = 60` plus a Storyblok
  webhook with a shared secret. We own both sides, so publish purges directly: no
  webhook, no secret, no consistency window. Needs a cache layer first (Cache API
  or KV in front of D1). **M**
- **Scheduled publishing** — a DO alarm per story. **S**

## Phase 5 — Editor at 87 block types

Real scale breaks the current UI:

- The "+ Add block" menu is an unsorted flat list. **Grouping is done**: one
  entry per allowed type, in declaration order, with that type's presets
  nested beneath it (`field-defaults-and-presets.md`). Search and icons or
  thumbnails are still open, and matter more once presets have multiplied the
  menu's entries. **M** (down from a flat list to search/icons remaining)
- **Field defaults and presets** (`default`, `presets`, `presetsOnly`) —
  done. A block starts as its kind's zero value unless a field declares a
  `default`, layered under a named `preset`'s own override — and a preset can
  carry children, so "Hero — with button" inserts both as one transaction.
  This is very likely the honest answer to a meaningful chunk of the 87 block
  schemas: several of those are near-identical variants (`HeroDark`,
  `HeroLight`, `HeroVideo`) that collapse into one block plus three presets,
  which is one schema to maintain instead of three and one design change
  instead of three edits. Worth an explicit pass over
  `components.3001038.json` once Phase 6's stub generator exists, rather than
  guessing here. See `docs/specs/editing/field-defaults-and-presets.md`.
- **Duplicate a block**, and copy/paste blocks between pages — done. Every
  copy is `insert` mutations through the ordinary store (one transaction, so
  it inherits sync, undo and the activity trail for free), uids are always
  re-allocated, and pasting validates the payload against the schema before
  building a single mutation. Duplicating a whole document works the same way
  one level up: the *draft* is cloned into a brand-new, unpublished story with
  no version history of its own. See
  `docs/specs/editing/duplicate-and-paste.md`.
- **Collapse/expand** in the block tree, which gets unusable deep in a
  `Collage → Item → Link` nest. **S**
- **Field-level validation surfaced in the UI** — `required` is declared and
  currently ignored. **S**. When this lands: `required` must be evaluated only
  for **visible** fields (`conditional-fields.md`'s decision 3's follow-on note)
  — a field hidden by `showIf` cannot block publishing with an error the editor
  has no way to act on.
- **Conditional fields** (`showIf`/`hidden`) — done. A `hero` with a `layout`
  select and four fields that only apply when `layout === 'split'` is one
  block instead of three: `showIf` is a small declarative condition (`eq`/
  `ne`/`in`/`isSet`, `all`/`any`/`not`) evaluated by `matches` in `folio/core`
  against the block's own sibling data, and `hidden: true` retires a field
  without losing its stored value. See `docs/specs/editing/conditional-fields.md`.

## Phase 6 — Migration

Non-negotiable for actually delivering an existing site.

- Generate Folio `defineBlock` stubs from `components.3001038.json` — the same
  file they already pull with `storyblok pull-components`. Mechanical. **M**
- Import stories: Storyblok's nested `content` tree → Folio's normalised
  `{root, bloks}`, allocating uids and fractional orders. Richtext and asset
  payloads need mapping, and assets need re-hosting to R2. **L**
- A reconciliation report: which blocks and fields did not map. **S**

---

## Explicitly staying application code

Not Folio's problem, ports as ordinary React: visx charts and the CSV data
pipeline, Swiper carousels, Lottie, form UI and validation (react-hook-form),
reCAPTCHA, form submission storage and notification email, schema.org output,
breadcrumbs, theming, Sentry, Google Tag Manager, the admin dashboard.

The one caveat is Next-specific APIs: `draftMode()`, `revalidatePath`,
`generateStaticParams`, `next/image`, RSC. Those need Folio or Workers
equivalents, which Phases 2 and 4 provide.

## Honest read on the critical path

**Richtext, the query API, and the Storyblok import are the three items that
decide whether this is feasible.** Each is a week-plus on its own, and all three
are unavoidable. Everything else on this list is comparatively routine.

Suggested order, because each unblocks the next: Phase 1 (richtext, assets,
links) → Phase 2 (types, querying) → Phase 6 spike (import 3 real pages to test
the model against actual content) → Phase 3 (auth) → Phase 4 → Phase 5.

Doing a *small* slice of Phase 6 early is the highest-value de-risking move
available: importing three real Reference pages will expose model mismatches far
sooner than building the remaining field types on assumptions.
