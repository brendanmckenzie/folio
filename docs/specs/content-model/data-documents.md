# Feature: Data documents — structured content with nothing to render

> **Group:** content model
> **Build order:** 14
> **Size:** M
> **Status:** done
> **Wire version:** none
> **Migration:** none — uses `0006` (types) and `0010` (`content_refs`)
> **Last updated:** 2026-07-29

## Summary

Some content is not a page and is not a block: a person, an office, a product
specification, a partner logo with a link and an alt text. It has fields, it is
edited by editors, it is referenced from many places, and it has no layout of its
own.

`../foundation/document-types.md` makes such a thing storable — `kind: 'record'`,
no route, out of the page tree. This spec makes it *usable*: a block definition
that does not have to pretend to render, an admin surface that is a table and a form
rather than a tree and a preview iframe, a `references()` field for hand-picked
ordered lists, and a usage count so deleting one is not a guess.

## Ground truth

**core (`packages/folio/src/core/`):**
- `BlockDef.render` is **required** (`block.ts`), and `RenderBlok` calls
  `def.render(props as never)` unconditionally (`preview/Render.tsx`). A root block
  with nothing to render currently has to return `null` from a mandatory function.
- `reference` resolves to `ResolvedReference = ReferenceTarget & { content: ReactNode }`,
  where `content` is the referenced document rendered
  (`resolve.ts`, `Render.tsx`) and `data` is the referenced root block's field data —
  *"or read source.data yourself"* (`README.md`). So a block already has both ways
  to consume a referenced document, and a record only needs the second.
- `reference` is single-valued and stores a bare story id string
  (`resolveReference` checks `typeof value === 'string'`).
- `defaultValue(field)` returns `[]` for `multiasset`, which is the precedent for a
  plural field's empty value.

**server (`packages/folio/src/server/`):**
- `previewPage` needs a story with a public URL and `handle()` returns `null` for a
  path with no story, so an unrouted document simply has no preview route — no guard
  needed, it cannot be reached.
- `publish()` is type-agnostic: it snapshots a draft and writes a version. A record
  publishes with no changes at all.

**admin (`packages/folio/src/admin/`):**
- `Editor.tsx` is a composition over hooks after the earlier refactor, with the
  preview iframe and the rails as siblings — so a mode with no iframe is a layout
  branch, not a rewrite.
- `BlockTree.tsx` walks the document's root block and its slots, which a record with
  a `blocks` field (a person's bio, a list of accreditations) still needs.
- `Inspector.tsx` draws inputs from the selected blok's schema, with no assumption
  that the document is a page.
- `LinkInput.tsx` is the model for a picker that has to search stories.

## Owner decision checkpoints

1. **`render` becomes optional, rather than adding a second definition kind
   (recommended).** `defineRecord({ … })` is provided as sugar that omits it, but a
   record root is still a `BlockDef` and still flows through `toSchemaIndex`,
   `blankBlok`, the manifest and the inspector unchanged. The alternative — a
   separate `RecordDef` type — forks the schema pipeline for one missing function.
2. **A record may still have a renderer, and it is used for `reference.content`
   (recommended).** A "Person card" is genuinely useful: a block that references a
   person can drop `{person.content}` and get a consistent card. Records without one
   give `content: null` and blocks read `data`.
3. **Records are edited full-width with no preview (recommended).** There is nothing
   to preview. The alternative — previewing the record inside a page that references
   it — sounds appealing and is ambiguous the moment two pages reference it
   differently. Singletons solve their own version of this with `previewPath`
   (`globals.md`) because a header genuinely renders in one place; a person does not.
4. **Deleting a referenced record warns with a count, and proceeds (recommended).**
   The count comes from `content_refs` (`collections.md`), so it is published
   references only. Blocking the delete would mean maintaining referential integrity
   across draft documents nobody can see, and a broken reference already degrades
   safely (`resolveReference` returns null and the block renders its empty state).

## User stories

### Editor maintains a list of people
**As** an editor **I want** a Team section in the CMS where I add, edit and reorder
people **so that** a person's biography lives in one place and every page that shows
them stays in step.

### Block author picks people in order
**As** a block author **I want** `references({ types: ['person'], max: 6 })` **so
that** an editor hand-picks and orders six team members for a leadership section.

### Editor sees what a record affects
**As** an editor about to delete an office **I want** to be told it is used on four
published pages **so that** I do not silently empty a section of the site.

### Developer reads records from a route
**As** a developer **I want** to query records like anything else **so that** an
office finder is ordinary application code over `folio.query`.

### Editor edits a record without a fake page
**As** an editor **I want** a record to open as a form, not as a page preview with
a blank white area **so that** the tool matches what I am editing.

## Architecture decisions

### 1. `defineRecord` is `defineBlock` with `render` optional

```ts
export const personRecord = defineRecord({
  name: 'personRecord',
  label: 'Person',
  summary: 'fullName',
  fields: {
    fullName: text({ required: true, indexed: true }),
    role:     text({ translatable: true }),
    photo:    asset({ accept: 'image/*' }),
    bio:      richtext({ translatable: true, nodes: ['paragraph'] }),
    email:    text(),
  },
  // Optional. Present here so a `reference` to a person can render a card.
  render: ({ fullName, role, photo }) => (
    <figure className="person">
      {photo ? <img src={photo.srcFor({ width: 320 })} alt={photo.alt} /> : null}
      <figcaption>{fullName}<span>{role}</span></figcaption>
    </figure>
  ),
})
```

`BlockDef.render` becomes `render?`, and `RenderBlok` guards it: absent renders
`null` on a published page and a `folio-unrendered` placeholder in edit mode, naming
the type. That is the same posture as an unknown block type, and the same reason —
an editor must be able to see that something is there and not renderable, and a
published page must never show scaffolding.

Making `render` optional on *every* block, not just record roots, is deliberate: the
type system cannot tell a record root from any other block (both are `BlockDef`), and
inventing a marker to enforce it would buy nothing. A content block with no renderer
is a mistake, and it is a visible one.

### 2. Records live in a Data section, listed by type, edited as a form

The admin's left rail gains a section per non-page type, beneath the page tree:

```
Pages            (tree, as today)
Data
  People      24
  Offices      6
Globals
  Header
  Footer
```

Selecting a type opens a **list view** — a table whose columns are the type's
`indexed` fields plus its title, sortable and paginated over
`GET /folio/content?type=person&status=draft` (`collections.md`) — with New, Delete
and a search box.

Selecting a record opens the editor in **form mode**: the block tree and inspector
occupy the full width, no iframe, no viewport switcher, no "View live" link. Publish,
History, undo, presence and multiplayer are all unchanged, because none of them ever
depended on there being a preview.

A record with `blocks` fields still shows the block tree, so "a person with a list of
accreditations" works exactly like a page's body.

### 3. `references()` — a plural, ordered, hand-picked reference

```ts
fields: { team: references({ types: ['person'], max: 6, min: 1 }) }
render: ({ team }) => <ul>{team.map((p) => <li key={p.id}>{p.content}</li>)}</ul>
```

- Stored as an array of story ids, in the editor's chosen order.
  `defaultValue` is `[]`, following `multiasset`.
- Resolves to `ResolvedReference[]`, with unresolvable entries **dropped** rather
  than left as holes — a deleted person should not render an empty card — while the
  admin's input shows them as "missing (deleted)" so the editor can see why the list
  got shorter. The renderer hides the damage; the editor surfaces it. That split is
  the same one `multilink`'s `broken` flag makes.
- `referencedIds` collects them, so a `references()` field costs exactly one extra
  document read per distinct target, batched with everything else.
- The input reuses `MultiAssetInput`'s card-list pattern for reordering — and must
  not reuse its bug: that component keys cards by index, so reordering drops focus
  (`ROADMAP.md` records it). `references()` keys by story id, which it has.

Why not a collection with a manual filter: order. A query cannot express "these
three, in this order", and `ord` on the records themselves is one global order, not a
per-usage one.

### 4. Usage counts come from `content_refs`, and are honest about what they cover

`GET /folio/documents/:id/usage` returns
`{ published: [{ id, title, url, kind }], total }` from `content_refs`
(`collections.md` writes it inside the publish batch). The delete confirmation reads
"Used on 4 published pages" and lists them.

It is **published references only**, and the dialog says so, because
`content_refs` is written at publish. Covering drafts would mean an edge table
maintained per keystroke or a scan of every Durable Object; neither is worth it for a
confirmation dialog, and the failure it would prevent is already graceful.

### 5. Records are ordinary documents everywhere else

No new storage, no new publish path, no new history path, no new sync path. A record:

- has a Durable Object named by its story id, so drafts, multiplayer, undo and the
  activity trail work;
- publishes into `published_doc` with a retained version, because a page referencing
  it renders **published** values (`resolveReference` reads `Resolution.docs`, which
  is populated from `publishedDocsByIds` on a live page and from drafts in preview —
  so an editor previewing a page sees the person as they just edited them, and the
  live page does not);
- is indexed by `collections.md` on publish, so it is queryable;
- carries per-locale values (`localisation.md`) for free.

The only thing a record does not have is a URL, and that is the point.

## Wire & schema changes

### D1

None. `type` comes from `0006`; `content_refs` from `0010`.

### Core types

- `BlockDef.render` becomes optional; `defineRecord` sugar added and exported from
  `folio/core`.
- New field kind: `references` — `{ kind: 'references'; types?: readonly string[];
  min?: number; max?: number }`, `ValueOf` → `ResolvedReference[]`,
  `defaultValue` → `[]`.
- `referencedIds` collects `references` alongside `reference`.
- `resolveReferences(value, resolution)` in `core/resolve.ts`, and a
  `resolveValue` case that returns `[]` for absent values.

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/folio/documents/:id/usage` | editor+ | Published documents referencing this one |

Everything else it needs already exists: `POST /folio/stories` with a `type`
(`0006`), `GET /folio/content?type=` (`collections.md`), `/folio/edit/:id`, the
history and publish routes.

## Acceptance criteria

### A record type with no renderer
```
GIVEN a record type with no `render`
WHEN a page references one and is published
THEN reference.content is null, reference.data holds the record's root fields, and
     the page renders whatever the referencing block chose to build
AND in the editor, opening the record shows a form with no preview pane
AND nothing anywhere renders a placeholder into a published page
```

### A record with a renderer
```
GIVEN a person record with a render function
WHEN a block drops {person.content}
THEN the person card renders, without data-folio-uid markers and without being
     clickable in the referencing page's preview (it belongs to another document)
```

### Records are not in the page tree and have no URL
```
GIVEN 24 people
WHEN the content tree loads
THEN no person appears in it, and the Data section lists People (24)
AND no path resolves to a person
```

### List view
```
GIVEN 24 people and a page size of 20
WHEN the People list opens
THEN 20 rows show with columns for the indexed fields, sortable, with page 2
     available
AND an unpublished person appears in the list (the admin lists documents, not
     published content)
```

### references(), ordered
```
GIVEN references({ types: ['person'], max: 6 })
WHEN an editor picks three people and drags the third to first
THEN the stored value is three ids in that order, written as one set mutation
AND the block renders them in that order
AND a fourth pick beyond max is refused by the input
AND a person of the wrong type cannot be picked
```

### A deleted target shortens the list, visibly in the editor
```
GIVEN a references() value naming three people, one since deleted
WHEN the page renders
THEN two cards render, with no hole and no error
AND the editor's input shows the third as "missing (deleted)" with a remove action
```

### Usage count before deletion
```
GIVEN an office referenced by four published pages and one unpublished draft
WHEN the editor deletes it
THEN the confirmation says "Used on 4 published pages", lists them, and notes that
     unpublished references are not counted
AND on confirm the record and its versions are deleted, its Durable Object purged,
    and the four pages render their blocks' empty states
```

### Records publish and version like pages
```
GIVEN a person edited and published twice
WHEN their History tab opens
THEN two publish versions are listed, previewable read-only and restorable as one
     ordinary transaction
```

### Multiplayer on a record
```
GIVEN two editors on the same person
WHEN one types
THEN the other sees it per keystroke, with presence dots on the same fields as on
     a page
```

## Implementation plan

### Phase 1 — core

1. `core/block.ts`: `render?`, `defineRecord`.
2. `preview/Render.tsx`: guard `def.render`; `folio-unrendered` placeholder in edit
   mode only; a stylesheet rule for it in `preview.css`.
3. `core/fields.ts`: the `references` kind, `ValueOf`, `defaultValue`.
4. `core/resolve.ts`: `resolveReferences` (drops unresolvable, filters by
   `field.types`), `resolveValue` case, `referencedIds` collecting both kinds.
5. Tests: `resolve.test.ts` (order preserved, unresolvable dropped, type filtering,
   absent → `[]`); a render test for the missing-renderer branch in both modes.

### Phase 2 — admin

1. `useStories.ts` / `FolioContext`: types from the manifest, split into pages, data
   and globals; a document list per type.
2. A `DataList` component: table, columns from `indexed` fields, sort, paginate,
   search, New, Delete.
3. `Editor.tsx`: form mode when the open document's type is not `kind: 'page'` —
   full-width rails, no iframe, no viewport switcher, no live link. Publish,
   History, presence unchanged.
4. `ReferencesInput`: search-and-pick modelled on `LinkInput`, card list modelled on
   `MultiAssetInput` **keyed by story id**, drag to reorder, min/max enforcement,
   missing-target state.
5. Delete confirmation reading `/folio/documents/:id/usage`.
6. Tests: `test/unit/admin/` for the input (order, max, missing) and for the mode
   branch.

### Phase 3 — server

1. `server/routes/documents.ts`: the usage route over `content_refs`.
2. Tests: `test/workers/` for usage counts including the drafts caveat.

### Phase 4 — docs

1. `README.md`: a Data documents section, `defineRecord`, `references()`.
2. `PARITY.md`: note that `reference` now filters by type, which Phase 1
   recorded as the one place it was thinner than the reference project.

## Edge cases

- **A record whose root has a `blocks` field** → works; the block tree renders and
  the blocks are part of the record's document. This is how a person gets a
  repeatable list of accreditations.
- **A page referenced through `references()`** (not just records) → allowed if the
  field's `types` permits it. Nothing about the field is record-specific; records are
  just its main use.
- **`references()` containing the referencing document itself** → resolution is
  bounded to one level (`RenderBlok` empties `docs` on the way down), so it renders
  once. Same guard `reference` already relies on.
- **A record with nothing published, referenced by a live page** → resolves to
  nothing and the block renders its empty state, exactly as
  `README.md` already documents for `reference`.
- **Reordering `references()`** → one `set` with the whole array, which is one undo
  step. Consistent with how every array-valued field behaves.
- **`min` on `references()`** → surfaced in the admin as a warning, not enforced on
  write, because `required` is still declared-and-ignored across the whole field
  system (`PARITY.md` Phase 5) and this field should not invent its own
  enforcement ahead of the rest.
- **A record type renamed in code** → rows keep the old `type` string and show as
  "Unknown type" until a migration moves them. `../foundation/schema-migrations.md`
  explicitly leaves cross-type moves as hand-written, and this is the case it meant.
- **Thousands of records** → the list view is paginated and the index is queryable,
  so the limit is the same one `collections.md` sets. The page tree is unaffected
  because records were never in it.
- **A singleton with no renderer** → same as a record: `globals.md` renders a global
  through `renderGlobal`, which needs a renderer, so a global without one renders
  nothing. Correct, and the audit can report it.

## Testing requirements

**Unit:** `resolveReferences` (order, dropping, type filter, empty); the optional
renderer in both modes; `referencedIds` over both field kinds.

**Workers:** the usage route; publish/version/delete over a record; that no path
resolves to one.

**End to end (`scripts/records-test.mjs`, new):** create two people through the API,
publish them, reference them from a page in a chosen order, assert the published page
renders both in that order with no `<script>`, delete one, assert the page renders
the survivor and the usage count warned first.

## Dependencies

- `../foundation/document-types.md` — `kind: 'record'`, unrouted rows, `reference`
  type filtering. This spec is the usable half of that one.
- `collections.md` — the list view is a query, and `content_refs` is the usage
  count.
- `localisation.md` — records get translatable fields with no extra work; not a hard
  dependency.

## Out of scope

- **A generic relational model** (records referencing records with a declared
  inverse, "all pages by this author" as a first-class field). `content_refs` makes
  the reverse lookup possible; declaring it in the schema and keeping it consistent
  is a much bigger feature and nothing needs it yet.
- **Bulk editing** in the list view (select ten people, set a field). Wants the
  content API's write path and a progress UI; a follow-up.
- **CSV import/export of a record type.** Application code over
  `../platform/content-api.md`, and much better placed there than in the admin.
- **Field-level `required` enforcement.** Site-wide gap, not this spec's to fix.
- **Records as taxonomy** (a `topic` record type used to tag insights). It works
  today via `reference`, but the *filtering* side — "insights whose topic reference is
  this record" — needs the index to hold reference values, which `collections.md`
  restricts to scalars. Named here because it is the first thing someone will try:
  the workaround is an indexed `select` for filtering plus a reference for display.

## Open questions

Resolved. The Data list view **does** show draft state per row, as a sortable
`Status` column drawn with the same `badgeLabel` the page tree uses — free now
that `../editing/unpublished-changes.md`'s watermark exists, since `state`
already rides on every `StoryMeta` the list request returns.

## Implementation notes

Built 2026-07-29 in five commits. 1566 tests → 1651 (63 files); typecheck,
`biome ci`, `vitest` and the demo build all exit 0. New e2e
`scripts/records-test.mjs` at **38/38**, run live against a fresh database.

### What landed

**Core.** `BlockDef.render` is optional and `defineRecord` is exported from
`folio/core` (checkpoint 1). It is `defineBlock` under the skin, as the
checkpoint's own wording implies — the value is the name at the call site, and
the return type is the same `BlockDef<F>`, so nothing downstream forks.
`RenderBlok` guards the absence *above* its props loop, so a block with nothing
to render also does no resolution work, and does not descend into children — the
same posture as an unknown type, because a placeholder that then drew its slots
would be scaffolding pretending to be a layout.

**One thing the spec did not say, and it matters.** The acceptance criteria say
`reference.content` **is null** for a record with no renderer. The existing code
would have produced an *element* that renders nothing, which is truthy — so
`{person.content ?? <MyOwnCard/>}` would have been dead code. A shared
`referenceContent` helper in `preview/Render.tsx` now returns literal `null` when
the target's root block has no renderer, for both `reference` and `references`.
The demo's `officeCard` is the demonstration and the e2e asserts it.

**`references()`** is a new `Field` kind with `types`/`min`/`max`, `ValueOf` →
`ResolvedReference[]`, `defaultValue` → `[]`, and a `resolveValue` case (the
switch is exhaustive, per spec 13). `asStoryIds` in `core/values.ts` is the
reader: stored order preserved, junk dropped, **duplicates dropped** (the same
document twice has no sensible rendering, and keeping both would make `max` count
something the editor cannot see), and a bare string tolerated so a `reference`
widened by a content migration reads as one entry. `resolveReferences` drops
unresolvable entries. Both ref walks see both kinds — `referencedIds`
(resolve.ts, source locale) and `referencedIdsAllLocales` (refs.ts, every
locale). The second is load-bearing for decision 4: without it a `references()`
usage would have been invisible to the very warning this spec is about.

**Server.** `GET /folio/documents/:id/usage` at `EDIT` (editor+, as the route
table says). `documentUsage(db, id)` in `server/stories.ts` composes spec 13's
`countReferencesTo` and `referencesTo`, returns whole story rows rather than a
projection so the route can decorate with `rt.withUrls` (the URL shape is the
host's), drops a row whose source story has since been deleted, and reports
`total` as **distinct documents** — a page that both links to and references one
target is two rows and one document, and appears twice in `published` so the list
can say which. `links`/`references` stay row counts.

`GET /folio/documents` additionally carries `indexed`: one `content_index` query
for the whole list, giving each document's indexed values as
`{ text, num }` per field. `text` is what a cell shows; `num` is what a numeric
sort uses, which is the only way a publish-date column sorts chronologically
rather than lexicographically. Skipped entirely when nothing is `indexed`, so the
payload is byte-identical on a site that marks nothing.

**Admin.** The Data rail is now an index of non-page types with counts
(`DataList.tsx`); selecting one opens `DataTable.tsx` in the stage. Form mode is
a class plus a conditional on `Editor.tsx`, as the Ground truth predicted.
`ReferencesInput.tsx` reuses `referenceCandidates` (the picker) and
`MultiAssetInput`'s card shape, keyed by story id rather than by index — the bug
the spec explicitly told it not to reuse. `useDocumentUsage` fetches only while a
confirmation is open, and a failed fetch shows **nothing** rather than "used on 0
documents": reporting no usage because a request failed is the one way this
dialog could do harm.

### Deliberate deviations, all small

1. **The usage route lives in `routes/stories.ts`**, not a new
   `routes/documents.ts` as phase 3 step 1 sketched. `GET /documents` is already
   there (it is the listing that ensures a singleton into existence), and one
   route is not worth splitting the `/documents` prefix across two files.
2. **Phase 3 was built before phase 2.** The admin's delete confirmation consumes
   the usage route, so building the route second would have left one commit with
   an admin fetching a 404.
3. **The list view sorts, searches and pages client-side**, over the flat list
   `GET /folio/documents` already returns in full — not over
   `GET /folio/content?type=…&status=draft` as decision 2 wrote. There is no
   `status` parameter on that route, and there should not be: it queries
   `content_index`, which is published-only, so it can never satisfy the resolved
   open question that an unpublished person appears in the list. Client-side is
   free at this scale, needs no route, and keeps the source at `stories` exactly
   as the resolved open question requires. Recorded in ROADMAP as wanting SQL
   paging for a type with thousands of documents.
4. **The columns are published values, source locale**, from `content_index`. The
   spec assumed the values would arrive with the list and did not say where from;
   this is the only source that costs one query rather than one Durable Object
   read per row. A draft document's cells are blank beside its own draft badge,
   and the table footer states it rather than leaving it to be misread.
5. **Two extra columns beyond "indexed fields plus its title":** `Status` (the
   resolved open question) and `Updated`. Both are free from `StoryMeta` and both
   are what an editor scanning a list of twenty-four people actually sorts by.
   The type's `titleField` is *skipped* as a field column, because its value
   already is the title column and a table printing a name twice looks like a
   feature.
6. **`references()` reorders with ↑ ↓ buttons, not drag** (phase 2 step 4 said
   drag). Keyed by story id so it has none of `MultiAssetInput`'s focus problem;
   drag is the same a11y-shaped work as the tree's keyboard reordering and is in
   ROADMAP.
7. **Orphaned documents stay a plain list in the rail**, with no table. The
   columns come from a declared type's root block, and an orphan has no declared
   type to read them from — which is the "a record type renamed in code" edge
   case seen from the UI side.
8. **Two things form mode needed that the spec did not mention.** The migration
   banner lived inside the stage, and there is no stage in form mode, so it moves
   above the body there — otherwise a record behind the model stops explaining
   itself. And the root block is auto-selected once the document arrives, because
   with no preview to click nothing would ever select it and the inspector would
   sit asking to be clicked in a pane that does not exist.
9. **A singleton keeps its preview**, so form mode is records (and
   unknown-type documents) only. That is `globals.md`'s decision 4 standing, and
   consistent with checkpoint 3's own aside about `previewPath`.

### Where the spec's Ground truth had drifted

- `summary`/`blankBlok`/`BlockSchema` live in `core/schema.ts`, not
  `core/block.ts` (spec 4 recorded this).
- Field reads go through `fieldValue`/`dataOf` from `core/locales.ts`; a
  `references` value is read that way in `RenderBlok`, so a translation can pick a
  different list.
- `deleteStoryStatement` returns four fields including `indexStatements`, and
  `Field` gained a `collection` kind whose `resolveValue` switch is exhaustive —
  both accounted for.
- `DataList.tsx` already existed, as spec 8's deliberately thin placeholder, and
  said so in its own header comment. It was replaced rather than extended.

### Deliberately not built

- **Bulk editing, CSV import/export, a generic relational model with declared
  inverses, records-as-taxonomy filtering, field-level `required`** — all named
  out of scope by the spec and all still out.
- **`min` enforcement on write.** Warns in the editor only, per the spec's own
  edge case: `required` is declared-and-ignored site-wide and this field should
  not invent its own enforcement ahead of the rest.

### Tests added

- `test/unit/core/records.test.ts` — 20: `asStoryIds`, `resolveReferences`
  (order, dropping, type filter, empty, the one-level bound), `resolveValue`'s
  new case, both ref walks including i18n and self-edges, `defineRecord`.
- `test/unit/preview/records-render.test.tsx` — 11: the missing renderer in both
  modes, `reference.content` null vs. a card, `references()` order, a deleted
  target leaving no hole, wrong-type dropping, no uid markers on inlined content.
- `test/unit/admin/records.test.ts` — 37: column derivation, cells, six sort
  behaviours (including numeric and ISO-date columns, and blanks sorting last
  either way), search, pagination at the spec's own 24-at-20 example, the
  references input's entries and candidates, the usage sentence, and
  `deleteConfirmation` for an unrouted document.
- `test/workers/records.test.ts` — 14: the usage route against real D1
  (a `references()` member as a usage, one document counted once across two
  reference fields, an unpublished referrer excluded, an unknown id answering
  200/zero), the `indexed` map, a record publishing twice and versioning with no
  path, duplication, and a referenced record deleting while its referrer stays
  live.
- `scripts/records-test.mjs` — 38 checks, live: rendered order, reorder, the
  no-renderer fallback, usage counts and their URL decoration, the unpublished
  referrer, delete-and-survive with exactly one figure remaining and no
  `<script>`, and the two facts the resolved open question turns on.
