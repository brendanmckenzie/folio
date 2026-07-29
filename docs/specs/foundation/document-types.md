# Feature: Document types — more than one kind of document

> **Group:** foundation
> **Build order:** 8
> **Size:** M
> **Status:** done
> **Wire version:** none
> **Migration:** `0006_document_types.sql`
> **Last updated:** 2026-07-29

## Summary

`createFolio` takes exactly one root block type (`src/server/types.ts:44`), so
every story in a Folio site is the same shape of document, and every document is a
routable page. Three of the wants in `docs/feedback.md` — collections, global
variables for headers and footers, and non-visual data objects — are all "a
document that is not a page", and none of them can be specified until a document
has a type.

This spec introduces a set of document types, each with its own root block, its own
`kind` (routable page, unrouted record, or singleton), and its own place in the
admin. Story rows gain a `type` column, `path` becomes nullable so an unrouted
document stops squatting the URL namespace, and `reference` finally gains the type
filter its own source comment says it is missing.

Nothing about the document model itself changes. A record and a page are both
`{ root, bloks }`, both live in a Durable Object named by their story id, both
sync, version, publish and undo through the same machinery. Only the root block
type and the routing consequence differ.

## Ground truth

**core (`packages/folio/src/core/`):**
- `Manifest = { root: string; blocks: BlockSchema[] }` (`schema.ts:20-24`), built by
  `toManifest(registry, root)` (`block.ts`) and served verbatim by
  `GET /folio/schema` (`server/app.ts`).
- `blankBlok(schema, type, parent, slot, order)` (`schema.ts`) fills defaults for
  every non-`blocks` field. This is how both a new block and a new document's root
  block are created.
- `fields.ts`'s `reference` variant carries the comment: *"Filtering candidates by
  document type needs multiple document types, which Folio does not have yet, so
  every story is offered."*
- `buildResolution(stories, assetBase)` (`resolve.ts`) maps **every** story to a
  `StoryRef` with a `url`, and `resolveLink`'s `story` case reads
  `resolution.stories[link.id]`, treating a missing entry as `broken: true`.
- `resolveReference(value, resolution)` (`resolve.ts`) needs both a `StoryRef` and
  a loaded document, and returns null if either is missing.
- `derivePaths(rows)` (`story.ts`) derives a path for every row from its ancestor
  chain. `buildTree(rows)` nests every row by `parentId`.

**server (`packages/folio/src/server/`):**
- `FolioConfig.root: string` — *"Block type used as the document root. Also where
  page metadata lives."* (`types.ts:43-44`).
- `createRuntime`'s `seed(title)` (`runtime.ts:77-81`) builds a new document from
  `config.root` and writes `title` into it if the root block has that field.
  `draftFor` passes it to `StoryDO.getOrInit`, so **a document's shape is decided
  the first time anything touches its Durable Object**.
- `publishStoryStatement` (`stories.ts`) derives the cached title from
  `doc.bloks[doc.root]?.data.title`. A document type without a `title` field would
  publish with an empty title today.
- `createStory(db, { title, slug, parentId })` (`stories.ts`) — no type parameter.
  `uniqueSlug` dedupes within `(parentId)`, `orderAt` places a fractional `ord`.
- `updateStory` refuses to reslug or reparent the root story (`path === ''`), and
  refuses a move into a story's own subtree.
- `storyByPath(db, path)` is the only routing lookup, and `folio.published(env,
  path)` reads `published_doc` for that path with no type check.
- `migrations/0001_initial.sql`: `stories.path text not null unique`.
  `migrations/0002_slug_unique.sql`: `unique index stories_parent_slug on stories
  (coalesce(parent_id, ''), slug)` — with a long comment explaining why
  `coalesce` is needed and why the index cannot be made idempotent over data.

**admin (`packages/folio/src/admin/`):**
- The admin never reads `manifest.root`. Every reference to "root" in the admin is
  `doc.root` — the *uid* of the root blok, not its type (`BlockTree.tsx:18`,
  `Editor.tsx:101`, `History.tsx:167` which labels it "Page settings").
  **So changing `Manifest` costs the admin nothing.**
- `StoryTree.tsx` is headed "Pages", offers one "+ New" affordance, and renders a
  `draft` badge when `!node.publishedAt`.
- `useBlocks.ts` builds new blocks with `blankBlok(schema, type, …)` and enforces
  `field.allow` on add and move — the same enforcement a type filter needs.

**tests:**
- `test/workers/stories.test.ts` (383 lines) covers tree CRUD, cascade delete,
  cycle rejection and slug collisions.
- `test/workers/seed-fixture.ts` deliberately globs `examples/demo/seed.sql` as the
  test fixture, so seed rows and migrations are checked against each other.

## Owner decision checkpoints

1. **One `stories` table for every kind of document (recommended).** A record is a
   story with a different `type`. The alternative — a separate `records` table —
   forks the story tree, versions, publish, the Durable Object naming rule, the
   history routes and the admin, for the sake of two columns being null. Cost of
   the recommendation: `stories` grows columns that only apply to some rows.
2. **Unrouted documents leave the page tree entirely (recommended):**
   `parent_id = null`, `path = null`, ordered by `ord` within their type. The
   alternative — letting records keep a derived path and refusing to serve them by
   type — means a record called "About" takes the `/about` URL and blocks the page
   that wanted it. Cost: `path` must become nullable, which SQLite can only do by
   rebuilding the table (SQL in full below).
3. **No per-type routing rules (recommended).** `PARITY.md` describes
   "each with its own routing rule", which is a Next.js artefact: Folio derives a
   path from the tree, so an `insight` living under the `insights` page already
   serves at `/insights/whatever` with no rule to configure. Overriding this means
   a `pathPrefix` per type and a second path-derivation rule to keep in step.
4. **A singleton is a document with a derived id (recommended):** `sng_<type>`,
   created on first access. The alternative — a `singleton boolean` column plus a
   lookup — needs a uniqueness constraint to stop a second one existing, which the
   derived id gives for free.

## User stories

### Developer defines more than one shape of document
**As** a developer **I want to** declare `page`, `insight`, `person` and
`siteSettings` as separate document types with their own fields **so that** an
insight is not a page with six unused fields and a comment explaining which ones
matter.

### Editor creates the right kind of thing
**As** an editor **I want** "New" to ask what kind of document I am making, and
the tree to show me what each row is **so that** I do not have to know that a
"team member" is secretly a page with no route.

### Block author narrows a picker
**As** a block author **I want** `reference({ types: ['form'] })` to offer only
forms **so that** an editor cannot wire a form-embed block to the homepage.

### Editor cannot break routing with a data record
**As** an editor **I want** a data record to have no URL at all **so that** naming
one "Contact" does not silently take the `/contact` path away from the page that
needs it.

## Architecture decisions

### 1. `types` replaces `root`, and `root` stays as sugar

```ts
const folio = createFolio<Env>({
  blocks,
  types: [
    { name: 'page',     label: 'Page',     kind: 'page',      root: 'page' },
    { name: 'insight',  label: 'Insight',  kind: 'page',      root: 'insightRoot' },
    { name: 'person',   label: 'Person',   kind: 'record',    root: 'personRecord' },
    { name: 'settings', label: 'Settings', kind: 'singleton', root: 'settingsRoot' },
  ],
  bindings: (env) => ({ … }),
})
```

`root: 'page'` on its own keeps working and is expanded to
`[{ name: 'page', label: 'Page', kind: 'page', root: 'page' }]`. The demo needs no
change, and neither does any host that has not asked for a second type. Exactly one
`kind: 'page'` type may be marked `default: true` (implicitly the first one), and
that is the type a bare "New page" creates.

The two config keys are mutually exclusive and `createFolio` throws on both, at
construction, before a request is served. A configuration mistake in a CMS should
not become a runtime 500 on one code path.

### 2. `DocumentType.kind` is the whole routing story

| kind | routable | in the page tree | how many | example |
| --- | --- | --- | --- | --- |
| `page` | yes | yes, with `parent_id`/`path` | many | Page, Insight |
| `record` | no | no (`parent_id` and `path` null) | many | Person, Office |
| `singleton` | no | no | exactly one | Site settings, Header |

Everything else that differs between types — which fields, which blocks the root
allows, what labels it in a list — is already expressible as a block schema.

`kind` is checked in exactly three places: routing (`storyByPath` /
`publishedDoc`), path derivation (`derivePaths` skips unrouted rows), and the
admin's tree. Everywhere else a document is a document.

### 3. Page metadata stays on the root block, per type

The existing rule — `title`, `description`, `socialImage`, `noindex` are ordinary
fields on the root block, edited in the same inspector as everything else — is what
makes metadata inherit multiplayer, undo, versioning and atomic publish. That does
not change. What changes is that a `record` root has no reason to carry
`socialImage`, and a `settings` singleton has no reason to carry `noindex`.

So each type declares which of its root fields is the display title:

```ts
{ name: 'person', kind: 'record', root: 'personRecord', titleField: 'fullName' }
```

`titleField` defaults to `'title'` when the root block has one, then to the root
block's `summary` field, then to the literal `'Untitled'`. This replaces the
hard-coded `doc.bloks[doc.root]?.data.title` read in `publishStoryStatement` and
`versions.ts`'s `docTitle` with one shared `titleOf(doc, type)` helper in core, so
the tree cache, the version list and the admin all agree on what a document is
called.

### 4. `path` becomes nullable, and the unique indexes become partial

This is the one genuinely awkward change, and it is worth it (checkpoint 2). SQLite
cannot drop a `NOT NULL`, so `0006` rebuilds `stories`. The two indexes from `0001`
and `0002` are recreated as **partial** indexes so unrouted rows — all of which
have `path = null` and `parent_id = null` — do not collide with each other:

- `unique index stories_path on stories (path) where path is not null`
- `unique index stories_parent_slug on stories (coalesce(parent_id, ''), slug)
  where path is not null`

The second one keeps `0002`'s `coalesce` trick for exactly the reason `0002`
documents (SQLite treats each NULL in a unique index as distinct, so top-level
siblings would never collide), and adds `where path is not null` so a hundred
records with the slug `contact` are legal.

Records keep a `slug`, because they need a stable machine-readable handle for the
content API (`../platform/content-api.md`) and for `sitemap`-style host code, but
that slug is unique per type rather than per parent:

- `unique index stories_type_slug on stories (type, slug) where path is null`

### 5. Type filtering is enforced twice, like richtext constraints

`reference({ types: ['form'] })` and `multilink({ allow: ['story'], types: ['page'] })`
narrow the admin's picker *and* are re-checked at resolve time. Same discipline as
`richtext`'s `marks`/`nodes`, and for the same reason: content can also arrive from
an importer or over the API, and a reference pointing at the wrong type of document
must be visible rather than rendering something strange.

A reference whose target is the wrong type resolves to `null`, exactly like a
deleted target, and in edit mode the block's own empty state shows. A `multilink`
pointing at an unrouted document resolves to `{ broken: true }` — the same
treatment a deleted story already gets, because "there is no URL for this" and
"this URL is gone" are the same problem for an editor.

### 6. `StoryRef` gains `type` and `routable`; `url` keeps its meaning

`buildResolution` still maps every story, because a `reference` to a record needs
a `StoryRef` for its title even though it has no URL. `StoryRef` gains
`type: string` and `routable: boolean`, and `url` is `''` for unrouted documents —
not `null`, because `StoryRef.url` is a published type read by host code, and
turning a `string` into `string | null` is a breaking change to force on every
consumer for a value they should not be reading anyway. `resolveLink` refuses to
emit an href from a non-routable ref, which is the guard that matters.

### 7. Singletons are created on demand, and never by an editor

`ensureSingleton(db, type)` inserts a row with `id = 'sng_' + type.name`,
`path = null`, `parent_id = null`, `slug = type.name`, on first read. Called from
the admin's type list, the content API and `folio.global()`
(`../content-model/globals.md`). An editor never creates or deletes one: a
singleton exists because the schema says it does, and deleting it would only mean
it comes back empty.

`sng_<type>` is a valid Durable Object name and a valid story id — nothing parses
a story id, everything compares it (same property `newStoryId` relies on) — so
the draft, log, versions and publish path all work unchanged.

## Wire & schema changes

### D1 migration `0006_document_types.sql`

```sql
-- Rebuild, because `path` has to become nullable and SQLite cannot drop a
-- NOT NULL in place. `stories` has no foreign keys pointing at it (versions
-- references story_id by convention only), so a rebuild is safe as long as
-- nothing writes while it runs.
--
-- Ordering matters: the new table is created and filled before the old one is
-- dropped, so a failure mid-file leaves the original table intact.

create table stories_new (
  id            text primary key,
  -- Document type name, resolved against the `types` passed to createFolio.
  -- 'page' by default: every row written before this migration was the single
  -- root type, which the config now expands to a type of that name.
  type          text not null default 'page',
  parent_id     text,
  slug          text not null,
  -- Null for unrouted documents (records and singletons), which leave the page
  -- tree entirely rather than squatting a URL. Derived from the ancestor chain
  -- for everything else, and recomputed on rename and move.
  path          text,
  ord           text not null,
  title         text not null,
  published_doc text,
  published_at  integer,
  created_at    integer not null default (unixepoch()),
  updated_at    integer not null default (unixepoch()),
  -- From 0003 (unpublish). A rebuild has to carry every column added before it,
  -- which is the only reason this migration's number matters: adding one after
  -- 0006 is an ordinary `alter table`, but anything before it has to appear here
  -- or the rebuild silently drops it.
  unpublished_at     integer,
  unpublished_by     text,
  -- From 0005 (draft watermark).
  draft_sync_id      integer not null default 0,
  draft_updated_at   integer,
  published_sync_id  integer not null default 0
);

insert into stories_new
  (id, type, parent_id, slug, path, ord, title, published_doc, published_at,
   created_at, updated_at, unpublished_at, unpublished_by,
   draft_sync_id, draft_updated_at, published_sync_id)
select
  id, 'page', parent_id, slug, path, ord, title, published_doc, published_at,
  created_at, updated_at, unpublished_at, unpublished_by,
  draft_sync_id, draft_updated_at, published_sync_id
from stories;

drop table stories;
alter table stories_new rename to stories;

create index stories_parent_ord on stories (parent_id, ord);
create index stories_type on stories (type, ord);
create index stories_draft_updated on stories (draft_updated_at desc);

-- Partial: only routed documents live in the URL namespace. Unrouted rows all
-- carry path = null and parent_id = null and would otherwise all collide.
create unique index stories_path on stories (path) where path is not null;

-- 0002's index, narrowed. The coalesce is still needed for the reason 0002
-- documents: SQLite treats every NULL in a unique index as distinct, so
-- top-level siblings sharing a slug would never collide without it.
create unique index stories_parent_slug
  on stories (coalesce(parent_id, ''), slug) where path is not null;

-- Unrouted documents still need a stable machine-readable handle for the
-- content API, unique within their type rather than within a parent.
create unique index stories_type_slug on stories (type, slug) where path is null;
```

### Core types

```ts
// core/schema.ts
export type DocumentKind = 'page' | 'record' | 'singleton'

export interface DocumentType {
  name: string
  label: string
  kind: DocumentKind
  /** Block type used as this document's root. */
  root: string
  /** Root field holding the display title. See `titleOf`. */
  titleField?: string
  /** Only this type's documents may be created under a document of these types. */
  under?: readonly string[]
  /** The type a bare "New page" creates. Implicitly the first `page` type. */
  default?: boolean
}

export interface Manifest {
  types: DocumentType[]
  blocks: BlockSchema[]
  /** @deprecated The default page type's root block. Kept for one release. */
  root: string
}

export function titleOf(doc: Doc, type: DocumentType, schema: SchemaIndex): string
```

`Field` additions: `reference` and `multilink` gain `types?: readonly string[]`.
Both are additive and both default to "every type", so every existing document and
every existing block definition keeps its meaning.

`StoryMeta` gains `type: string`, and `path: string | null`.

### Routes

- `GET /folio/schema` — response gains `types`, keeps `root`.
- `POST /folio/stories` — body gains `type` (default: the default page type).
  Rejects `record`/`singleton` with a `parentId`, and rejects a `type` the config
  does not declare (`unsupported`, not `not_found` — the request is well-formed,
  the server just has no such type).
- `GET /folio/stories` — the tree, unchanged, now `page` types only.
- `GET /folio/documents?type=person` — flat list per type, for records and
  singletons. Pagination arrives with `../content-model/collections.md`; this
  route is the minimum the admin needs to render a type's list.
- `PATCH /folio/stories/:id` — rejects a `parentId` or `slug` change that would
  move a document between routed and unrouted, and rejects a `type` change
  entirely (changing a document's type is a schema migration, see
  `schema-migrations.md`).
- `DELETE /folio/stories/:id` — refuses a singleton.

## Acceptance criteria

### A second page type routes from the tree
```
GIVEN types page and insight, both kind 'page'
WHEN an editor creates an insight titled "Hello" under the page at /insights
THEN its path is 'insights/hello', it serves at /insights/hello once published,
     and its document's root block is insightRoot
```

### A record has no URL
```
GIVEN a record type person
WHEN an editor creates a person named "Contact"
THEN the row has parent_id null and path null
AND GET /contact still 404s (or reaches the host's own routes) rather than
    serving the record
AND another editor can still create a page whose slug is 'contact'
```

### Records do not appear in the page tree
```
GIVEN two pages and three people
WHEN GET /folio/stories is called
THEN it returns the two pages
AND GET /folio/documents?type=person returns the three people
```

### Reference filtering
```
GIVEN reference({ types: ['form'] }) on a block
WHEN an editor opens the picker
THEN only documents of type form are offered
AND WHEN a document written by an importer points that field at a page id
    THEN the field resolves to null and the block renders its empty state
```

### Links cannot point at an unrouted document
```
GIVEN a multilink field and a person record
WHEN a stored value names that record as a story link
THEN resolveLink returns { kind: 'story', href: '#', broken: true }
AND the editor's link picker never offered it in the first place
```

### Singletons
```
GIVEN a singleton type settings and no row for it
WHEN anything asks for it (admin list, folio.global, content API)
THEN a row with id 'sng_settings' is created, its Durable Object is seeded from
     the settings root block, and subsequent asks return the same row
AND DELETE on it is refused
AND creating a second one is impossible: there is no route that can
```

### Titles come from the type
```
GIVEN a person record whose root block has no `title` field and titleField 'fullName'
WHEN it is published
THEN stories.title caches the fullName value, and the version row records the same
```

### Back compatibility
```
GIVEN a host still passing `root: 'page'` and a database written before 0006
WHEN 0006 is applied and the worker deployed
THEN every existing row reads type 'page', every path is unchanged, every URL
     still resolves, and the demo's own tests pass untouched
```

## Implementation plan

### Phase 1 — core

1. `core/schema.ts`: `DocumentKind`, `DocumentType`, `Manifest.types`, `titleOf`.
2. `core/block.ts`: `toManifest(registry, types)`; keep the `root` field.
3. `core/fields.ts`: `types?` on `reference` and `multilink`.
4. `core/resolve.ts`: `StoryRef.type`/`routable`; `resolveLink` refuses unrouted
   targets; `resolveReference` checks the field's `types`. `resolveValue` needs the
   field, which it already has.
5. `core/story.ts`: `StoryMeta.type`, `path: string | null`; `derivePaths` skips
   rows with a null path; `buildTree` ignores them.
6. Tests: `test/unit/core/resolve.test.ts` (type filtering, unrouted link),
   `story.test.ts` (paths with records present), `schema` tests for `titleOf`.

### Phase 2 — server

1. Migration `0006_document_types.sql`. Update `examples/demo/seed.sql` (the test
   fixture) to insert `type` explicitly.
2. `server/types.ts`: `FolioConfig.types` (with `root` as sugar), validated in
   `createRuntime` — throw on both keys, on an unknown `root` block name, on two
   defaults, on a duplicate type name, on `kind: 'singleton'` with `under`.
3. `server/runtime.ts`: `seed(type, title)`; `typeOf(story)` lookup;
   `resolve` unchanged.
4. `server/stories.ts`: `type` in `COLS`; `createStory` takes a type and branches
   routed/unrouted; `uniqueSlug` scopes by parent for routed and by type for
   unrouted; `updateStory` refuses cross-kind moves and type changes;
   `publishStoryStatement` uses `titleOf`; `ensureSingleton`; `listDocuments(db,
   type)`.
5. `server/publish.ts` and `versions.ts`: `docTitle` → `titleOf`.
6. `server/routes/stories.ts`: the route changes above, with valibot schemas in
   `validate.ts`.
7. `folio.published` and `previewPage`: refuse unrouted documents (a preview
   request for one is `null`, so the host's routing wins — the same rule
   `handle()` already follows).
8. Tests: `test/workers/stories.test.ts` for every acceptance criterion above;
   `test/workers/http.test.ts` for the new routes and refusals; a migration test
   that applies `0001`→`0006` over a database seeded at `0002` and asserts every
   path survives.

### Phase 3 — admin

1. `useStories.ts`: fetch types from `/folio/schema`; keep the page tree on
   `/folio/stories`; add a per-type document list.
2. `StoryTree.tsx`: "+ New" becomes a menu when more than one page type exists;
   rows show a type chip when the site has more than one; `under` narrows what can
   be created where and what a drag may drop into.
3. `LinkInput.tsx` / the reference input: filter candidates by `field.types` and
   omit unrouted documents from link pickers.
4. `Inspector.tsx` / `History.tsx`: "Page settings" becomes the type's label
   (`"Person details"`), read from the manifest.
5. A **Data** section for `record` and `singleton` types — deliberately thin here;
   `../content-model/data-documents.md` owns it.
6. Tests: `test/unit/admin/` for the picker filters and the create menu.

### Phase 4 — docs

1. `README.md`: the mount snippet, the "Stories, paths and page metadata" section,
   and the `reference` section's "cannot filter by document type" caveat.
2. `PARITY.md`: Phase 2's "Document types" and "Singletons" items.
3. `ROADMAP.md`: move "Multiple content types" and "Singleton / config documents"
   out of *Uncovered*.

## Edge cases

- **A type whose `root` block does not exist in the registry** → `createFolio`
  throws at construction, naming the type and the missing block.
- **A document whose `type` is no longer in the config** (type removed from code,
  rows still in D1) → the tree renders it with an "Unknown type" chip and opening
  it shows the same "Unknown block type" affordance the renderer already has for
  blocks. Not an error: deleting rows because code changed is worse.
- **Changing a document's type** → refused by the API. It is a schema migration
  (`schema-migrations.md` adds the `retype` mutation that makes it expressible at
  all).
- **`under` cycles** (`insight` only under `page`, `page` only under `insight`) →
  validated at construction: every `under` chain must reach a type with no `under`.
- **The root story** (`path = ''`) → still special-cased exactly as it is today:
  it cannot be reslugged, reparented or deleted, and it must be a `page` type.
- **A record referenced by a published page, then deleted** → the reference
  resolves to null and the block renders its empty state, unchanged from today.
  Usage counts before deletion arrive with `data-documents.md`.
- **Slug collision between a record and a page** → impossible to observe: they are
  in different index namespaces.
- **Applying `0006` to a database with duplicate paths** → cannot exist, `0001`'s
  unique index prevented it; the rebuild's `insert … select` would fail loudly
  before the drop if it somehow did.
- **A host that never upgrades its config** → `root` keeps working. The
  deprecation is documented, not enforced.

## Testing requirements

**Unit:** type filtering in `resolveLink`/`resolveReference`; `titleOf` fallback
chain; `derivePaths` with unrouted rows interleaved; `buildTree` ignoring them.

**Workers:** the migration over a pre-`0006` database; create/patch/delete refusals
per kind; singleton lazy creation and its refusal to be deleted; `publishedDoc`
refusing an unrouted document; slug uniqueness in all three namespaces.

**End to end:** extend `scripts/fields-test.mjs` with a reference restricted by
type (picker offers one, a wrong-type value resolves to nothing) and a link to a
record coming back `broken`.

## Dependencies

- `../editing/unpublish.md` and `../editing/unpublished-changes.md` — only because
  `0006` rebuilds `stories` and must carry `0003`'s two columns and `0005`'s three
  forward. Any spec that adds a `stories` column *before* this one has to appear in
  the rebuild; anything after it is an ordinary `alter table`. If the build order
  changes, this migration changes with it.
- No new Cloudflare resources.

## Out of scope

- **Per-type routing rules / path prefixes** (checkpoint 3).
- **Per-type permissions** — needs roles; `identity-and-access.md`.
- **Querying, filtering and pagination over a type** — `collections.md`. This spec
  adds a flat `GET /folio/documents?type=` because the admin cannot render a list
  without one, and nothing more.
- **The record editing UI** (a table instead of a page tree, a form instead of a
  preview iframe) — `data-documents.md`.
- **Moving a document between types** — `schema-migrations.md`.
- **Nested records** (a person owning addresses as child documents). Blocks inside
  the record's own document already express that, and it stays that way until
  something real needs otherwise.

## Open questions

None. Resolved as built:

- **`under` constrains drag targets as well as creation**, with a refusal notice
  rather than a silent no-op — checked in `updateStoryStatement` (a 400 whose
  message names the allowed parents) and mirrored client-side in
  `StoryTree.dropRefusal`, so the editor is told before the request rather than
  by it. Two deliberate narrowings fell out of building it, both aimed at the
  "less likely to make an existing tree undraggable" half of the original
  question: the server checks `under` **only when the parent actually changes**,
  so a plain title edit on a tree that predates the constraint still works; and
  the admin lets a row whose own type is no longer declared be dragged anywhere,
  since a config change must not freeze a tree and the server has the final say
  regardless.

## Implementation notes

Landed 2026-07-29 across four commits (49d2444, a545b39, c2cdf3d, plus this
restamp). All four gates green by exit code: typecheck, `biome ci`, 1008 tests
(38 files, up from 853/35), demo build. All four e2e scripts green from a fresh
database: fields 106/106 (up from 80), sync 16/16, history 41/41, redirects 8/8.

**Phases 1 and 2 shipped as one commit.** `StoryMeta.type` is required and
`path` became nullable, which means core cannot compile without the server
reading the new column — there is no green intermediate state between them. The
phase boundary was real as a *plan*, not as a commit boundary.

### What the spec got wrong about the codebase

- **`toManifest(registry, root)` → `toManifest(registry, types)`.** The spec's
  core plan said "keep the `root` field", which it does, but it is now *derived*
  as the default page type's root block rather than passed in.
- **`publishStoryStatement`'s 4th parameter changed meaning**, from
  `fallbackTitle` to the already-resolved `title`, and `WriteVersionInput`'s
  `fallbackTitle` likewise became `title`. The spec described `titleOf` replacing
  the `data.title` read *inside* those functions, but they have no access to the
  document's type or the schema. `PublishDeps` gained a required
  `titleFor(story, doc)` instead, injected by `createRuntime` — the same shape
  `draft`/`draftWithSyncId` already had, and required rather than defaulted
  because a silently-wrong cached title is the bug being fixed. `versions.ts`'s
  `docTitle` is gone entirely.
- **`deleteStoryStatement`'s `paths` is `(string | null)[]`**, and so is the
  `deleted` hook payload's. The spec did not mention it; `''` is the root story's
  path and a record never had one, so the two must not be spelled the same.
- **`derivePaths` returns a map that simply omits unrouted rows** rather than
  mapping them to anything. `paths.get(id) ?? row.path` then preserves their
  null, which is what stops a rename writing a path onto a record.
- **`ensureSingleton(db, type)` takes the resolved `DocumentType`**, not a name.
  Same for `createStory`'s `input.type`. The `types` array is a separate
  positional argument wherever `under` has to resolve a *parent's* type.
- `path === ''` (the root story) and `path === null` (unrouted) are distinct
  everywhere. Every `?? ''` on a path was reviewed for this.

### Beyond the spec, deliberately

- **`validateTypes` throws for `under` on any non-page kind**, not only
  `singleton`. A record has no place in the tree either, so the key would read as
  a constraint and enforce nothing.
- **At least one `kind: 'page'` type is required.** Without one nothing can be
  routed, the root story could not exist, and `defaultType` would have nothing
  to return.
- **`StoryPatchBody` declares `type`** and `updateStoryStatement` refuses a
  *change* while accepting a match. valibot strips unknown keys, so without the
  declaration a `type` in the body would have been silently ignored — which is
  not the refusal the spec asked for.
- **`GET /folio/documents` with no `?type`** returns every unrouted document and
  ensures every declared singleton. The spec only named the `?type=` form; the
  admin needs one request for the whole Data rail, and "first access" is exactly
  what should bring a singleton into being.
- **`POST /folio/stories` refuses `kind: 'singleton'`** with a 409. The spec said
  "creating a second one is impossible: there is no route that can", which was
  true only because the route did not check — a `type: 'settings'` body would
  otherwise have minted an ordinary `sty_` row of that type.
- **`test/workers/migrations.test.ts` is new** and pins the rebuilt table's
  column list, nullability, watermark defaults, index list and all three slug
  namespaces. The spec asked for "a migration test over a pre-`0006` database",
  which the workers pool cannot express (it applies the whole directory in
  `beforeAll`). Data survival across the rebuild was verified out-of-band instead
  — rows written between `0002` and `0006` against a real local D1, compared
  before and after, byte for byte — and this file is what stops a later migration
  quietly undoing the structure.

### Deferred

- **Host-side reading of a singleton.** `folio.global('settings')` is
  `../content-model/globals.md`'s. What exists is the document: created on first
  access, editable, publishable, undeletable, unduplicatable. The demo says so in
  `blocks/settings.tsx`.
- **The real record-editing UI.** Opening an unrouted document today gives the
  block tree and the inspector, with an explanation where the preview iframe
  would be and no Address panel. A table instead of a list, and a form instead of
  an iframe, is `../content-model/data-documents.md`'s.
- **Pagination and filtering over a type.** `../content-model/collections.md`'s.
  `GET /folio/documents` is a flat list and nothing more.

### Debt paid off

`duplicate-and-paste.md` deferred "duplicating a singleton must be refused" to
this spec. Done, in `duplicateStory` rather than at the route, so a direct caller
cannot route around it. `duplicateStory`'s `types` argument is required for that
reason — it cannot decide without it, and a default would have turned an omission
into a runtime throw.

### For whoever writes the next migration

`stories` after `0006`, with every index. Anything added from here is an ordinary
`alter table`; nothing else will need a rebuild.

```sql
create table stories (
  id            text primary key,
  type          text not null default 'page',
  parent_id     text,
  slug          text not null,
  path          text,                                    -- null = unrouted
  ord           text not null,
  title         text not null,
  published_doc text,
  published_at  integer,
  created_at    integer not null default (unixepoch()),
  updated_at    integer not null default (unixepoch()),
  unpublished_at    integer,                              -- 0003
  unpublished_by    text,                                 -- 0003
  draft_sync_id     integer not null default 0,           -- 0005
  draft_updated_at  integer,                              -- 0005
  published_sync_id integer not null default 0            -- 0005
);

create index stories_parent_ord on stories (parent_id, ord);
create index stories_draft_updated on stories (draft_updated_at desc);
create index stories_type on stories (type, ord);
create unique index stories_path on stories (path) where path is not null;
create unique index stories_parent_slug
  on stories (coalesce(parent_id, ''), slug) where path is not null;
create unique index stories_type_slug on stories (type, slug) where path is null;
```
