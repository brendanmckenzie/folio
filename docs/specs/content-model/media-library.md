# Feature: Media library organisation

> **Group:** content model
> **Build order:** 32
> **Size:** L
> **Status:** draft
> **Wire version:** none — nothing here crosses the socket or the admin↔preview bridge
> **Migration:** `0008_asset_organisation.sql` (a claim, not a landing — see below)
> **Build sequence:** after 29, before 23 (owner, 2026-09-05)
> **Last updated:** 2026-09-05

> **Migration number is a claim.** On the decided order 28 takes `0006`, 29 takes
> `0007`, so this takes `0008` and spec 23 (`foundation/multi-site.md`) restamps to
> `0009`. Whichever builds first takes the next free number and the others restamp
> — the standing rule in `docs/specs/README.md`.

> **Written while specs 31 and 30 were in flight.** Ground truth below was read at
> commit `c318967` with spec 31's work uncommitted. Four files were being edited at
> the time — `src/core/index.ts`, `src/server/index.tsx`, `src/server/runtime.ts`,
> `src/server/types.ts` — so **line numbers cited in those four have moved**, and
> `src/core/gate.ts` / `src/server/gate.ts` did not exist yet. Everything cited in
> `src/server/assets.ts`, `src/admin/ui/screens/*`, `migrations/` and `test/` was
> untouched and is exact. This spec deliberately touches no file that was in
> flight; the implementation will, once 31 → 30 → 28 → 29 have landed.

## Summary

The media library is a flat dumping ground. `assets` is nine columns and one index
(`migrations/0001_init.sql:190-203`), and the whole of its organisation is a filename
substring, a `content_type` prefix and three sorts (`src/server/assets.ts:74-107`).
There is no way to group files, no way to say what a file is about, no way to act on
more than one at a time, and no metadata beyond a default `alt` string that is empty
on every row until somebody types into it. At a few hundred hand-uploaded files that
is adequate, which is precisely the argument `migrations/0002_asset_refs.sql` made
when it refused to index `filename` and `size`. At thousands it is not.

This adds folders (a hierarchy, metadata only, never a key prefix), tags (free-form,
many-to-many), bulk selection over both, and an optional host-supplied enrichment
seam that writes alt text and chooses tags for images without an editor typing them.

## Ground truth

**core (`src/core/`):**

- `values.ts:27` — `AssetValue` is `{ key, filename, contentType, size, width?,
  height?, alt }`. **No id and no organisation**, and that is forced rather than
  chosen: `migrations/0002_asset_refs.sql` records that the projection walk which
  produces `content_refs` rows is pure and synchronous, so it cannot resolve a key to
  an id. `asAsset` at `:140`, `isImageAsset` at `:210`.
- `story.ts:450` — `AssetSort = 'created' | 'filename' | 'size'`; `DEFAULT_ASSET_SORT`
  at `:461`. In `story.ts` rather than an assets module because there is no assets
  module in `core/`; it is there for the stated reason that a value travelling in a
  URL must be shared by the screen that writes it and the reader that answers it.
- `story.ts:281-326` — `IdSelection`, `FilterSelection`, `BulkSelection`. The
  select-all contract: **no ids are materialised**, the filter is *captured* at the
  moment of the click, `expected` is the count the person was shown, and `exclude` is
  what they ticked off afterwards. `FilterSelection.filter` is typed `StoryFilter` and
  is the only story-specific member of any of the three.
- `story.ts:8` — `StoryMeta`, what `assetUsage` answers with.

**server (`src/server/`):**

- `assets.ts:28` — `AssetRow`, nine fields, mirroring the table exactly. `COLS` at
  `:40` is the single select list every read goes through, which is what makes adding
  a column a one-line change in one place.
- `assets.ts:54` — `ORDERS`, three keysets; `keyOf` at `:63` must stay component for
  component with it, and the file says so where they sit next to each other.
- `assets.ts:74-107` — `ListAssetsOptions`: `limit`, `cursor`, `q`, `kind`, `count`,
  `sort`, `dir`. `q` is `filename like ?` (`:117`) and nothing else; `kind` is
  `content_type like ?` (`:121`).
- `assets.ts:109-146` — `listAssets`. Keyset-paged, filters composed through
  `whereOf`, and an optional `count(*)` over the *same* filter with the cursor
  deliberately ignored, per `foundation/pagination.md` decision 5.
- `assets.ts:150` `assetById`; `:207` `assetUsage`, **keyed by R2 key rather than id**
  because that is what a stored value holds; `:230` `toAssetValue`, which copies `alt`
  in as a starting point after which the two are independent.
- `assets.ts:286` — `uploadAsset`. Mints `ast_<12 hex>-<safeFilename>`, sniffs the
  content type from the bytes rather than trusting the header, puts to R2 **first**
  then inserts, with a compensating `bucket.delete` if the insert throws.
- `assets.ts:366` — `updateAsset`, `alt` only, and it short-circuits to a read when
  `alt` is absent.
- `assets.ts:390` — `deleteAsset`. Batches the row delete with
  `clearInboundRefStatements`, D1 before R2, and swallows an R2 failure because the
  row is already committed gone.
- `assets.ts:912` — `listAssetsByPage`, the `/api/v1` offset-paged reader. **No
  filters at all**: `order by created_at desc, id desc limit ? offset ?` and a bare
  `count(*)`.
- `routes/assets.ts:46` list, `:89` usage, `:127` by id, `:138` upload, `:158` patch,
  `:166` delete. `assetFileRoutes` at `:193` is the public `GET {base}/asset/:key`,
  deliberately outside `{base}/api` because **its URL is baked into published HTML**
  through `Resolution.assetBase`.
- `routes/api/index.ts:78` — `GET {base}/api/v1/assets`, the versioned contract:
  `{ assets, page, perPage, total }`, offset-paged.
- `auth/roles.ts:145` `READ` (viewer), `:180` `ASSETS = { role: 'editor', scope:
  'assets:write' }`, `:183` `ADMIN`.
- `bulk.ts:49` `DEFAULT_BULK_BATCH = 25`, `:61` `MAX_BULK_BATCH = 200`, `:79`
  `BulkReport`, `:119` `BulkRefusal`, `:128` `wasRefused`, `:132` `BulkOptions`,
  `:166` `BulkDeps` (`PublishDeps & DocumentDeps` — story-shaped throughout), `:182`
  `runBulk`. `stories.ts:779` `countStories` is the count guard's reader.
- `db.ts:146` — `D1_BIND_CAP = 100`, **per statement, not per batch**; `:178`
  `bindChunks`. `content-index.ts:77-78` sizes its chunks from binds-per-row rather
  than a magic number.
- `validate.ts:212` — `AssetPatchBody` is `{ alt?: bounded(500) }` and nothing else;
  `:691` `ASSET_KEY`, anchored to Folio's own mint format; `:1189` `assetSortQuery`.
- `types.ts:71` — `FolioBindings`. `media?`, `images?` and `browser?` are each
  optional, and each absence is a *legible refusal* rather than a 500. `:354`
  `FolioConfig`; `gate?` is the "a host function in config, not a binding" precedent.
  **This file was in flight; these numbers have moved.**

**admin (`src/admin/`):**

- `ui/screens/assets-model.ts:100` — `AssetsUrl` is `{ view, sort, dir, kind, q,
  asset }`. `assetsParams` at `:240` is the single writer of the request, so the URL
  shown and the request made cannot disagree. `KindFilter` at `:46` has exactly two
  real values because no `video/` row can exist.
- `ui/screens/AssetBrowser.tsx:52` — `AssetBrowserProps`. **`selected: string |
  undefined`** — single selection, and the header states the seam explicitly: the
  browser knows which row is pointed at and nothing about what pointing means.
  `:110` the component. Two mounts, `Assets.tsx` and `AssetPicker.tsx:77`, and the
  header calls one implementation the load-bearing requirement of that phase.
- `ui/screens/useAssets.ts:27` `PAGE = 48` (divides by every column count the grid
  uses), `:44` `DEBOUNCE_MS = 150`, `:58` `useAssets`, `:169` `useAsset`, `:255`
  `useUploads`, `:379` `useDropTarget`.
- `ui/screens/AssetDetail.tsx:73` the panel, `:200` the alt-text editor, `:303` the
  usage list.
- `ui/nav.ts:93` — `{ label: 'Assets', icon: 'assets', screen: { name: 'assets' } }`.
  One flat entry, no sub-nav.

**migrations and tests:**

- `migrations/0001_init.sql:190-203` — `assets`, nine columns, and `assets_created`
  is the only index.
- `migrations/0002_asset_refs.sql` — **the standing refusal, and this spec's premise
  is what reverses it**: *"No new index on `assets`. … An asset table is bounded by
  what somebody uploaded by hand, so the scan-and-sort is over hundreds of rows,
  while an index is a write cost on every upload forever."*
- `test/workers/migrations.test.ts:344` —
  `expect(await indexesOf('assets')).toEqual(['assets_created'])`. An **exact
  equality**, so any new index on `assets` fails this test until it is edited; `:348`
  asserts the exact column list with the same property. Both are working as designed:
  they make widening `assets` a deliberate act.
- `test/workers/assets.test.ts`, `test/workers/asset-usage.test.ts`,
  `test/unit/admin/assets-screen.test.ts`, `test/unit/admin/asset-keys.test.ts`.

## Owner decision checkpoints

**All ten answered by the owner on 2026-09-05, before drafting**, each to its
recommendation. Recorded here as the record of what was decided rather than as
questions outstanding.

1. **Folders *and* tags.** A folder is where a file lives (one, hierarchical, the
   browse spine); a tag is what a file is about (many, cross-cutting, the filter).
   Rejected: tags alone, which loses the browse-down affordance; folders alone, which
   forces an asset that is both "Q3 campaign" and "headshots" to pick one.
2. **The LLM half lives in this spec, in its later phases** — not a separate spec.
   The enrichment is what makes the tag-vocabulary decision load-bearing, and
   deciding the vocabulary without that constraint is how it gets decided wrong.
3. **Tags are editor-created and free-form; the enrichment may only reuse them.**
   Rejected: a host-declared vocabulary in config, which blocks an editor behind a
   PR; and a seeded-plus-extensible hybrid, which has two sources for one vocabulary
   and no rule for a collision.
4. **Bulk selection is in scope.** Retro-organising an existing flat library is only
   possible with it, and that library is the thing that prompted this.
5. **`describe` is a host function, and Folio ships an adapter.** Rejected: a
   provider name and an API key in config, which makes Folio own the prompt, the
   model default, retries and a vendor list; and a Workers AI binding, which is not
   "their own LLM key".
6. **An enrichment run writes the stored defaults directly**, into columns separate
   from the human-entered ones. Rejected: a review queue, which nobody empties at
   3,000 images.
7. **Search widens to the new text columns and stays a substring scan**, with a
   stated revisit trigger. Rejected: putting assets into spec 30's FTS5 index, which
   would be a second write path into machinery that spec kept deliberately single.
8. **Build order: after 29, before 23.** Lands these tables before multi-site scopes
   every list route, so 23 scopes them in the same pass rather than retrofitting.
9. **Folders nest without limit**, `parent_id` + a denormalised `path`, the shape
   `stories` already has. Rejected: one flat level of albums.
10. **Filtering by a folder returns its descendants too**, and the Assets screen
    stays **flat-first** — a grid of everything, narrowed by a folder in a sidebar and
    by tag chips. Rejected: navigating *into* a folder, which puts two kinds of thing
    in one grid and forces every existing control (sort, search, the pager, the
    arrow-key grid) to decide what it means inside a folder.

## User stories

### Editor files a shoot
**As** an editor **I want to** drop sixty photographs into `Clients › Acme › 2026`
**so that** they are somewhere findable rather than at the top of one endless grid.

### Editor finds every headshot
**As** an editor **I want to** filter by the `headshot` tag across every folder **so
that** "what portraits do we have" is one click and not a scroll.

### Editor tidies an existing library
**As** an editor **I want to** select four hundred matching files and tag or file them
in one action **so that** organising a library that is already flat is possible at all.

### Editor narrows a picker
**As** an editor **I want** the asset picker in a field to offer the same folder and
tag filters as the library **so that** choosing an image from three thousand does not
mean paging.

### Developer wires up their own model
**As** a host developer **I want to** supply one function that describes an image
**so that** alt text and tags are written for me, using my own key, my own provider
and my own prompt.

### Editor gets alt text they did not type
**As** an editor **I want** an uploaded photograph to arrive already described **so
that** the accessible default is present rather than empty, and I edit it rather than
author it.

### Publisher deletes safely in bulk
**As** a publisher **I want to** be told how many of the four hundred files I am about
to delete are used on published pages **so that** I can stop before I break them.

## Architecture decisions

### 1. A folder is metadata. It is never part of the R2 key, and never a URL

`GET {base}/asset/:key` is public and **its URL is baked into published HTML** through
`Resolution.assetBase` (`routes/assets.ts:177-191`). A key is minted once by
`uploadAsset` (`assets.ts:296-300`) and pinned by `ASSET_KEY`'s regex
(`validate.ts:691`), which is anchored to that mint format precisely so the public
read cannot be turned into a primitive for arbitrary keys.

So filing an asset changes one integer-width column on one row and nothing else. It
does not move an object, does not rewrite a key, does not invalidate a cache entry,
and cannot break a published page.

**Rejected: folders as key prefixes**, the filesystem model, which is what every
S3-backed media library reaches for first. Moving a file would then mean copying the
object, deleting the original, and rewriting every `AssetValue` in every published
document and every draft that names the old key — a rewrite of other people's drafts
from an asset operation, which `deleteAsset`'s header already refuses to do for the
much stronger case of a delete. It would also widen `ASSET_KEY` to admit slashes,
which is the one property making the public route safe.

### 2. Folders and tags are both *filters*, and the grid stays flat

The Assets screen keeps showing one grid of everything, newest first. A folder tree in
a sidebar narrows it; tag chips narrow it further; both write to the URL the way
`kind` and `q` already do (`assets-model.ts:100-145`).

This is what makes the change cheap and the screen coherent. Every control the screen
already has — the `[ Grid | Table ]` toggle, the three sorts, the pager, the roving
tabindex, the `?count=1` header, the debounce — keeps working with no new meaning,
because a folder is one more clause in the same `where`. `assetsParams` stays the
single writer of the request. And *show me everything* stays one click, which is the
question a library is asked most often.

**Rejected: navigating into folders.** The grid would then hold two kinds of row, and
every one of the controls above would have to decide what it means inside a folder —
does sorting by size sort the subfolders, does the pager page them, does search leave
the current folder or not. Three of those have no good answer.

**Consequence worth naming:** because folders and tags are filters, they compose with
`kind` and `q` for free, and `isNarrowed` (`assets-model.ts:225`) — which is what
tells "nothing uploaded yet" from "nothing matches" — needs only two more terms.

### 3. The folder tree is `parent_id` plus a denormalised `path` of **slugified names**, and the tree route is paged like everything else

`asset_folders` carries `parent_id` for the structure and `path` for the query: a
slash-joined chain of slugified ancestor names, `unique`, recomputed on rename and
move. This is `stories.path`'s shape (`core/story.ts:526` `derivePaths`) and it is
copied on purpose — there is a working implementation of "recompute a subtree of
paths" in this repo, and a second, different one is how the two come to disagree.

Three things follow, and each is the reason for the choice:

- **Descendant filtering is a range, not a recursion.** No recursive CTE, no
  materialising a list of folder ids, no caller-sized bind list. One join to a table
  of hundreds of rows.
- **`order by path` is depth-first *and* alphabetical among siblings**, by
  construction. So the folder list route can be keyset-paged like every other list —
  honouring `foundation/pagination.md`'s rule with no exception to argue for — and a
  client paging it appends rows to a tree in the order they arrive, never sorting.
- **There is no `ord` column.** Manual sibling ordering would break the property
  above and nobody orders folders by hand. Alphabetical is what every media library
  does. Asserted as an absence in the migration test, the same way
  `stories_draft_updated` and `schedules_story` are, so restoring it is a deliberate
  act.

**The prefix filter is a range comparison, not `like`.** SQLite's `LIKE` is
case-insensitive for ASCII by default, which means `path like 'clients/%'` both
matches rows it should not and **cannot use the index** on `path`. The range form
does both correctly, and it is exact rather than clever: `'/'` is `0x2F` and `'0'` is
`0x30`, so every descendant path sorts inside `[p || '/', p || '0')`.

```sql
where f.path = ?1 or (f.path > ?1 || '/' and f.path < ?1 || '0')
```

**Rejected: a path of folder *ids* rather than names.** It makes a rename free — only
a move rewrites the subtree — which is a real advantage, and it loses on the second
bullet: an id path sorts randomly among siblings, so the paged tree route would need a
client-side sort over rows it has not all received yet, which is the one thing paging
makes impossible. A rename is rare; the tree renders on every load.

**Rejected: denormalising `folder_path` onto `assets` too**, which would remove the
join. A folder rename or move would then rewrite every asset row beneath it — the
thing this design is meant to avoid — and the join it saves is against a table bounded
by hand-created folders.

### 4. Tags are two tables, asset-only, with a slug for identity and a name for display

```
asset_tags     (id, name, slug unique, created_at)
asset_taggings (asset_id, tag_id)
```

`slug` is the identity — lowercased, trimmed, inner whitespace collapsed — so
`Headshot`, `headshot` and `head shot ` are one tag and not three. `name` is what was
typed first and is what is displayed. Creating a tag that slugifies onto an existing
one returns the existing one rather than erroring; that is what makes free-form entry
with autocomplete tolerable.

**Multiple tag filters are AND, and capped at eight.** Eight is a bind budget, not a
guess: the `having count(*) = n` form binds one parameter per tag plus the list's own,
and `D1_BIND_CAP` is 100 per statement (`db.ts:146`). Eight leaves the rest of the
filter and the keyset room to grow without the cap being a surprise later.

**Rejected: a generic `taggings (tag_id, target_id, kind)`**, widened the way
`content_refs` was in `0002` so documents could be tagged later. `content_refs` was
widened because *the machine that maintains it* already got three hard things right
and a second table would duplicate all three; there is no such machine here, and
documents already have `content_index` for filterable root fields. This is greenfield
and `CLAUDE.md` is explicit that a rewrite is allowed later; building the abstraction
for a second user who may never arrive is the more expensive mistake.

### 5. `assets` gains six columns and four indexes, and `0002`'s refusal is reversed with the measurement that reverses it

`0002_asset_refs.sql` refused to index `filename` and `size` on a stated premise: *an
asset table is bounded by what somebody uploaded by hand*. The premise is the thing
that changed. This spec exists because the library is expected to hold thousands, and
a scan-and-sort over thousands behind a debounced search box that also drags a
`count(*)` is the measurement `0002` said would be needed.

Columns:

| Column | Why |
| --- | --- |
| `folder_id` | Nullable. Null is *unfiled*, a real state and the one every existing row starts in. |
| `description` | Human, longer than `alt`, and searchable. `alt` is what a screen reader says; a description is what the file *is*. Conflating them makes one of them bad. |
| `alt_auto` | Machine-written alt. Separate from `alt` so a human edit is never clobbered and a re-run is idempotent — decision 9. |
| `description_auto` | The same, for the description. |
| `described_at` | Null means never attempted. What makes the backlog a partial index and the run resumable. |
| `describe_error` | Null, or a short message. `described_at` set with this non-null is *tried and failed*, which is what stops a permanently failing asset being retried on every pass forever. |

Indexes:

| Index | Reader |
| --- | --- |
| `assets_folder (folder_id, created_at desc)` | The default sort inside a folder filter, which is the screen's most common state after "everything". |
| `assets_filename (filename, id)` | `ORDERS.filename`, unindexed since `0001`. |
| `assets_size (size desc, id)` | `ORDERS.size`, same. |
| `assets_undescribed (described_at) where described_at is null` | The enrichment backlog walk. Partial, the shape `0003_schedules.sql` established. |

**No index for tags on `assets`** — the tag filter is served by
`asset_taggings_tag (tag_id, asset_id)`, on the join table where it belongs. Asserted
as an absence.

**`test/workers/migrations.test.ts:344` and `:348` must be edited**, and that is the
point of them: they are exact-equality assertions, so this change cannot land by
accident. Update them to the new lists, and add the absence assertions above.

### 6. `BulkSelection` becomes generic; the runner does not

The select-all contract in `core/story.ts:281-326` is the valuable part and it is not
about stories: a captured filter, a count the person was shown, a server-side re-check
that refuses on a mismatch, and an `exclude` list bounded by what a person can see.
Every word of that applies to assets.

So `FilterSelection<F>` and `BulkSelection<F>` become generic over the filter, and
they move — with `BulkAction`, `BulkReport`, `BulkRefusal` and `wasRefused` — into
`src/core/bulk.ts`. That is the same rule that put them in `core/` in the first place:
*the value appears in a URL, so the screen that posts it and the runner that performs
it share one vocabulary.* `BulkSelection<StoryFilter>` at existing call sites,
`BulkSelection<AssetFilter>` here.

**No default type parameter.** `BulkSelection<F = StoryFilter>` would keep every
existing call site unedited, and it is exactly how the asset runner ends up silently
holding a `StoryFilter` and compiling.

**The runner is new and small.** `runBulk` (`bulk.ts:182`) is story-shaped to its
bones — `BulkDeps extends PublishDeps, DocumentDeps`, five actions that all read the
story table, a cursor that walks story ids, `countStories` as the guard's reader.
Generifying *it* would turn `BulkDeps` into a union of two unrelated dependency bags
for the sake of a `for` loop. `runAssetBulk` (`src/server/asset-bulk.ts`) is four
actions over ids — `tag`, `untag`, `move`, `delete` — sharing the report shapes, the
`(lastId, seen)` cursor rule (`bulk-writes.md` decision 12), the per-item `try` and
the count guard, and duplicating none of them.

**Rejected: copying the selection types.** Two implementations of the `expected` guard
is how they come to disagree about what an off-by-one means, and the guard is the
safety mechanism.

### 7. Organisation never reaches `AssetValue`

A folder and a tag are facts about the *library*. `AssetValue` (`core/values.ts:27`)
is a snapshot copied into a document at pick time, and `toAssetValue`'s header already
records the rule for `alt`: copied in as a starting point, independent from then on.

If tags rode along in the value they would be a snapshot of a mutable set, stale from
the first re-tag, indexed into `content_refs` as though they were content, and part of
every published document's bytes. A host that wants to render "tagged: headshot" wants
a query against the library, not a frozen copy of it.

**One change to `toAssetValue`**, and it is the effective-alt rule from decision 9:
the value takes `alt || alt_auto`, so a machine description reaches a newly picked
field the same way a human one does, and neither reaches a document already written.

### 8. `describe` is a host function in config; Folio ships an adapter; absence is a legible refusal

```ts
describe?: {
  /** The host's own model call. Folio holds no key and picks no provider. */
  fn: (input: DescribeInput) => Promise<DescribeResult>
  /** Describe a new upload in the background. Default true. */
  onUpload?: boolean
  /** In-flight calls per batch. Default 4, clamped to 1–8. */
  concurrency?: number
}
```

This is `gate`'s shape (`types.ts`, spec 31) rather than a binding's: two host
predicates in config, called by Folio, owned by the host. Folio never holds an API
key, never chooses a model, never writes a prompt and makes no outbound HTTP call of
its own — which also means it needs no allowlist, no timeout policy anyone will
disagree with, and no vendor list to maintain.

Absence is the whole of "this site does not do this": no column is written, no host
code runs, the *Describe* controls are not rendered, and the routes answer
`FolioError('unsupported', …)` — exactly as `media` and `browser` already do
(`routes/assets.ts:140`, `:168`).

**`DescribeInput` hands over a transformed URL and a lazy `bytes()`:**

```ts
interface DescribeInput {
  id: string
  filename: string
  contentType: string
  width: number | null
  height: number | null
  /** `{base}/asset/:key?w=512&f=webp` when `images` is bound, the original
   * otherwise. Public, so a model API can fetch it directly. */
  url: string
  /** The same bytes, for a host whose deployment is not publicly reachable —
   * a local `wrangler dev`, a preview behind Access. Lazy: not read unless called. */
  bytes: () => Promise<ArrayBuffer>
  /** Every tag that exists, for the prompt. Decision 11 is why this is here. */
  tags: readonly { id: string; name: string }[]
}
```

**The URL goes through the transform route.** A 512px WebP is an order of magnitude
fewer tokens than a 20MB original, and the route to produce one already exists
(`assets.ts:551` `serveAsset`), clamped and cached. Sending originals would be the
default that quietly costs the most.

**Rejected: bytes only.** At `concurrency: 4` and a 20MB ceiling that is 80MB of
`ArrayBuffer` live in one isolate, per batch. **Rejected: a URL only.** It does not
work on `wrangler dev`, which is the environment a host will first try this in — the
same trap `browser` documents about Cloudflare's remote browser and `localhost`.

**Folio ships `anthropicDescriber({ apiKey, model?, prompt? })` from `folio/server`**,
so the common case is one line rather than a research project. It is an adapter over
`fn`, not a second seam: it returns a `DescribeInput => Promise<DescribeResult>` and
has no privileged access to anything.

### 9. An enrichment run writes the stored defaults, and it cannot touch a published page

This is safe for a structural reason worth stating rather than assuming.
`assets.alt` is only ever a *default*: `toAssetValue` (`assets.ts:230`) copies it into
the field value at pick time and the two are independent from then on. So a run over
3,000 images seeds future picks and changes not one byte of any published document,
any draft, or any rendered page. Nothing is purged, nothing is republished, no
mutation log is written.

`alt_auto` and `description_auto` are separate columns from `alt` and `description`,
and the human ones win when non-empty. Three things fall out of that and each is worth
having:

- An editor's text is **never** clobbered, by any run, ever.
- A re-run is idempotent and safe: it overwrites only machine columns.
- "Which of these did a human actually check" is a query, not an archaeology problem.

The admin shows machine text in the detail panel marked as such, with the human field
empty beneath it; typing into the human field is what promotes it.

**Rejected: a proposals table and a review queue.** It is the more careful design and
it does not survive contact with 3,000 images: the queue is never emptied, so the
feature's real behaviour becomes "nothing has alt text, plus there is a queue".

### 10. The run is caller-driven batches; a new upload is described in `waitUntil`

The bulk run is `bulk-writes.md` decision 2 verbatim: a bounded batch per request, the
cursor in the caller's hand between batches, **no job record and nothing to
reconcile** if the tab closes. It needs no new Cloudflare resource, it reuses a
decision this repo has already made and tested, and `dryRun` answers "how many and
what would it cost" before anything is spent.

The batch ceiling is lower than `MAX_BULK_BATCH`: `DEFAULT_DESCRIBE_BATCH = 10`,
`MAX_DESCRIBE_BATCH = 25`. A batch here is *N model calls*, not N D1 writes, and a
Worker has a wall-clock budget. Ten at `concurrency: 4` is comfortably inside it.

A new upload is described in the background via `ctx.waitUntil`, so the upload
response is unchanged and unslowed. If it fails, `describe_error` is set and the asset
is in the backlog, which is the same place a never-attempted one is.

**Rejected: Cloudflare Queues.** It survives a closed tab and retries properly, and it
adds a binding plus a consumer to every host that wants this, for a job whose failure
mode is "run it again". **Rejected: a cron over the backlog.** No progress to watch,
and `CLAUDE.md`'s warning about a `scheduled()` handler picking its own entrypoint
applies to any write routed that way.

### 11. The model may only choose tags that already exist

`DescribeResult.tags` is matched against existing tag **slugs**; anything unmatched is
dropped. This is the whole reason the vocabulary decision and the enrichment decision
belong in one document.

A model handed an open vocabulary invents a near-synonym per image — `portrait`,
`headshot`, `head-shot`, `person`, `face` — and a filter over that vocabulary is worse
than no filter, because it looks like it works. Constraining the model to a set an
editor curated is what makes the tags a taxonomy rather than a word cloud.

**Drops are counted, not silent.** The batch report carries `tagsIgnored`, so a host
whose prompt keeps proposing `product-shot` finds out and creates the tag.

### 12. Search widens to five columns and stays a substring scan, with the trigger for reversing it written down

`q` becomes:

```sql
(filename like ? or alt like ? or alt_auto like ?
 or description like ? or description_auto like ?)
```

Five binds of the same value — well inside `D1_BIND_CAP` alongside the rest of the
filter — and it composes with the folder join, the tag join, `kind` and the keyset
through `whereOf` with no new machinery.

It is a scan. Over thousands of rows that is the right trade, and it buys the thing
that matters most: **a machine-written description is reachable by the one control an
editor uses first.** A description nothing can search for is a description nobody
reads.

**The trigger for reversing this**, stated so the reversal is a measurement and not a
mood: the library passing ~50,000 rows, or a settled `q` exceeding ~200ms at p50
against a real deployment. That is the same discipline `0002` applied to the index it
refused and `pagination.md` decision 8 applied to FTS5 — a refusal with a named
condition, which spec 30 then met.

**Rejected: assets in spec 30's FTS5 index.** `content_text` and `content_fts` are
keyed to published *documents* and written inside the publish batch by the same
`indexStatements` as `content_index` — decision 1 of that spec is precisely that there
is no second write path. An asset has no publish, so putting it in that index means
inventing one, which is the thing spec 30 was careful not to do.

### 13. `/api/v1/assets` gains filters; folders and tags get no versioned routes

**A version segment is a promise** (`foundation/pagination.md` decision 3, and a
workers test pins the partition). `GET {base}/api/v1/assets` gains `folder`, `tag` and
a widened `q` as optional query parameters, which is additive: a caller passing none
gets exactly the rows and the envelope it gets today.

`listAssetsByPage` (`assets.ts:912`) has no filters at all, so this is real work rather
than a pass-through — and it is the same work as `listAssets`, which is why the filter
composition moves into one shared `assetFilterSql(filter)` that both readers call. Two
`where` builders over one table is how they come to mean different things by `folder`.

**No `{base}/api/v1/folders` and no `{base}/api/v1/tags`.** Nobody has asked for them,
and a versioned route is a contract with somebody's script that cannot then be
reshaped. The admin's own needs are served by unversioned `{base}/api/assets/folders`
and `{base}/api/assets/tags`, which may change shape in any commit. Adding the v1
pair later is additive; adding it now and getting it wrong is not.

### 14. Deleting a folder never deletes an asset; deleting a tag never deletes an asset

A folder delete re-parents its children to its own parent and sets `folder_id = null`
on its assets, which land back in *Unfiled*. A tag delete removes its `asset_taggings`
rows.

The alternative — cascade, or refuse while non-empty — both fail the same way: they
make an organisational mistake destructive. Filing is meant to be cheap to undo, and
an editor who miscategorised forty photographs must not be able to delete them by
tidying up. This is `deleteAsset`'s "warn and proceed" applied one level up, and it is
the same instinct `data-documents.md` decision 4 records for a referenced record.

Both dialogs say what will happen and how many rows it affects.

### 15. The bulk delete's usage warning is one aggregate, not N queries

`assetUsage` (`assets.ts:207`) is per-asset and answers *which* documents. Four hundred
of those is four hundred round trips, and the answer nobody can read anyway.

So the bulk delete confirmation runs `dryRun: true` and reads one added field:
`usedOnPublished`, the count of selected assets having at least one `content_refs` row
with `kind = 'asset'`. One `count(distinct to_id)` — joined against the filter for a
`FilterSelection`, chunked at `D1_BIND_CAP` for an `IdSelection`.

It **warns and proceeds**. It does not gate, for exactly the reasons `assetUsage`'s
header already gives: a broken reference degrades visibly and fixably, and a delete
that refuses leaves an editor unable to remove a file at all.

### 16. The bulk describe run is `ADMIN`; everything else is `ASSETS`

Every other route here is `ASSETS` (`roles.ts:180`, editor+), matching the upload,
patch and delete it sits beside — filing, tagging and describing one asset are editing
the library, which is what that role is.

The **bulk** describe run is `ADMIN`. It is the only route in Folio that spends the
host's money against a third-party API, at a rate the caller chooses, over a set that
can be "all 40,000". A count guard bounds the *set*; it does not bound the bill. An
editor should not be able to start that, and an admin who can mint API tokens is the
right bar for who can.

**Rejected: `ASSETS` for both**, which is consistent and makes the one genuinely
expensive button in the admin available to the most numerous role. **Rejected: a
configured spend ceiling**, which is Folio guessing at a host's pricing for a provider
it does not know.

*Worth an override if the owner prefers it flat — it is the one gate here chosen on
consequence rather than on symmetry with the routes around it.*

## Wire & schema changes

### D1 migration `0008_asset_organisation.sql`

```sql
-- Folders, tags, and six columns on `assets`.
--
-- Every path in `asset_folders` is a query key and NEVER a URL and NEVER an R2
-- key prefix. `docs/specs/content-model/media-library.md` decision 1: an asset's
-- key is minted once and baked into published HTML through `Resolution.assetBase`,
-- so filing a file must not move an object.

create table asset_folders (
  -- 'fld_<12 hex>', minted like an asset id.
  id         text primary key,
  parent_id  text,
  -- As typed. Displayed; not the identity.
  name       text not null,
  -- Slash-joined chain of slugified ancestor names, this folder last. Unique, so
  -- two siblings cannot slugify onto one another. Recomputed on rename and move,
  -- the way stories.path is (core/story.ts derivePaths).
  --
  -- Sorted, this is depth-first AND alphabetical among siblings, which is what
  -- lets the folder list be keyset-paged like every other list with no
  -- client-side sort. Do not replace it with a chain of ids: they sort randomly
  -- among siblings and that property is lost (decision 3).
  path       text not null unique,
  created_at integer not null
);

-- The tree render, and the only query not going through `path`.
create index asset_folders_parent on asset_folders (parent_id, name);

create table asset_tags (
  -- 'tag_<12 hex>'.
  id         text primary key,
  -- As first typed. Displayed.
  name       text not null,
  -- The identity: lowercased, trimmed, inner whitespace collapsed. 'Headshot',
  -- 'headshot' and 'head  shot ' are one tag. Creating a colliding tag returns
  -- the existing one rather than erroring, which is what makes free-form entry
  -- with autocomplete tolerable.
  slug       text not null unique,
  created_at integer not null
);

create table asset_taggings (
  asset_id text not null,
  tag_id   text not null,
  primary key (asset_id, tag_id)
);

-- The tag filter's reader, and the sidebar's per-tag counts. The primary key
-- above serves "this asset's tags"; this serves "this tag's assets", which is
-- the direction the screen actually filters in.
create index asset_taggings_tag on asset_taggings (tag_id, asset_id);

-- Null is 'unfiled', a real state and the one every existing row starts in. Not
-- a foreign key: `asset_folders` deletes null this out (decision 14), and D1 has
-- foreign keys off by default anyway.
alter table assets add column folder_id        text;
-- Human, longer than `alt`, searchable. What the file IS, as against what a
-- screen reader should say.
alter table assets add column description      text not null default '';
-- Machine-written. Separate columns so a human edit is never clobbered and a
-- re-run is idempotent (decision 9). Readers want `alt || alt_auto`.
alter table assets add column alt_auto         text not null default '';
alter table assets add column description_auto text not null default '';
-- Null means never attempted. Set with `describe_error` non-null means tried and
-- failed, which is what stops a permanently failing asset being retried forever.
alter table assets add column described_at     integer;
alter table assets add column describe_error   text;

-- `0002_asset_refs.sql` refused these two by name, on the premise that an asset
-- table is 'bounded by what somebody uploaded by hand'. That premise is what
-- changed: this migration exists because the library is expected to hold
-- thousands. The refusal was correct when it was written and it named the
-- measurement that would reverse it.
create index assets_filename on assets (filename, id);
create index assets_size     on assets (size desc, id);

-- The default ordering inside a folder filter, which is the screen's most common
-- state after 'everything'.
create index assets_folder   on assets (folder_id, created_at desc);

-- The enrichment backlog walk. Partial, the shape 0003_schedules.sql
-- established: the index holds only the rows the query wants.
create index assets_undescribed on assets (described_at) where described_at is null;

-- Deliberately absent, each asserted in test/workers/migrations.test.ts so
-- adding one is a deliberate act with a measurement behind it:
--
--   * an `ord` on asset_folders — manual sibling ordering breaks `path`'s
--     depth-first-and-alphabetical property and nobody orders folders by hand
--     (decision 3);
--   * any tag index on `assets` — the tag filter is served by
--     asset_taggings_tag, on the join table where it belongs;
--   * an index on asset_tags.name — the vocabulary is hundreds of rows and the
--     unique index on `slug` already serves lookup;
--   * an index on assets.description — search is a scan by decision 12, and an
--     index cannot serve a leading-wildcard LIKE anyway.
--
-- No CHECK constraint anywhere here, following 0002/0003/0004: SQLite cannot
-- widen one without rebuilding the table, and `versions.kind` is the standing
-- reminder of what that costs.
```

### Core types

New file `src/core/assets.ts`, and `AssetSort` / `DEFAULT_ASSET_SORT` move into it
from `core/story.ts:450-461` — they were only ever in `story.ts` because there was no
assets module.

```ts
export interface AssetFolder {
  id: string
  parentId: string | null
  name: string
  path: string
  createdAt: number
}

export interface AssetTag {
  id: string
  name: string
  slug: string
  /** Present only where a route was asked for counts. */
  count?: number
}

/** What a captured select-all holds, and what a list route parses. */
export interface AssetFilter {
  q?: string
  kind?: string
  /** A folder `path`. Includes descendants — decision 3. */
  folder?: string
  /** Tag slugs, ANDed. At most 8 (decision 4). */
  tags?: readonly string[]
  /** `folder_id is null`. Mutually exclusive with `folder`. */
  unfiled?: boolean
  /** No tagging rows. The retro-organise starting point. */
  untagged?: boolean
  /** `described_at is null`. Drives the enrichment backlog view. */
  undescribed?: boolean
}

export type AssetBulkAction = 'tag' | 'untag' | 'move' | 'delete'

/** Lowercase, trim, collapse inner whitespace. The tag identity. */
export function tagSlug(raw: string): string
```

New file `src/core/bulk.ts`, holding what moves out of `core/story.ts:277-326`, made
generic:

```ts
export interface IdSelection { ids: string[]; all?: never }
export interface FilterSelection<F> {
  all: true
  filter: F
  expected: number
  exclude?: string[]
  ids?: never
}
export type BulkSelection<F> = IdSelection | FilterSelection<F>
```

`BulkReport`, `BulkFailure`, `BulkRefusal`, `BulkOutcome` and `wasRefused` move here
from `server/bulk.ts:73-130` unchanged. `StoryBulkAction` (today's `BulkAction`) stays
in `core/story.ts`.

**Backwards compatibility:** not a consideration, per `CLAUDE.md`. Nothing stored
changes meaning; the mutation log is untouched; no wire frame gains or loses a field.
`PROTOCOL_VERSION` stays at 4.

### Server types

```ts
// FolioConfig
describe?: FolioDescribe<Env>

export interface FolioDescribe<Env> {
  fn: (input: DescribeInput, env: Env) => Promise<DescribeResult>
  onUpload?: boolean      // default true
  concurrency?: number    // default 4, clamped 1–8
}

export interface DescribeInput {
  id: string
  filename: string
  contentType: string
  width: number | null
  height: number | null
  url: string                                  // transformed when `images` is bound
  bytes: () => Promise<ArrayBuffer>            // lazy
  tags: readonly { id: string; name: string }[]
}

export interface DescribeResult {
  alt?: string           // bounded 500, matching AssetPatchBody
  description?: string   // bounded 2000
  tags?: readonly string[]  // matched to existing slugs; unmatched are dropped
}
```

Validated at construction alongside `gate` and `migrations`: `fn` must be a function,
`concurrency` an integer in range, and no unknown keys — the same treatment `hooks`
gets, because a configuration mistake in a CMS should not become a runtime 500.

`AssetRow` (`assets.ts:28`) gains the six columns; `COLS` (`:40`) gains them once and
every reader follows.

### New or changed routes

All under `{base}/api` (the admin's internal, unversioned surface) except where noted.

**Folders**

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/assets/folders` | `READ` | Keyset-paged over `path`, so the page order *is* tree order. `?count=1` for the total. |
| `POST` | `/assets/folders` | `ASSETS` | `{ name, parentId }` → the row. 409 on a path collision, naming the sibling. |
| `PATCH` | `/assets/folders/:id` | `ASSETS` | `{ name?, parentId? }`. Recomputes the subtree's paths in one statement. 409 on a cycle, 409 on collision. |
| `DELETE` | `/assets/folders/:id` | `ASSETS` | Re-parents children, unfiles assets (decision 14). `{ deleted: true, unfiled: n, reparented: n }`. |

**Tags**

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/assets/tags` | `READ` | Paged over `slug`. `?counts=1` adds `count` per tag — one grouped query, opt-in, exactly `?count=1`'s rule. |
| `POST` | `/assets/tags` | `ASSETS` | `{ name }`. Returns the **existing** tag on a slug collision, `200` rather than `201`, so autocomplete-then-create is one call. |
| `PATCH` | `/assets/tags/:id` | `ASSETS` | `{ name }`. Re-slugs; 409 if that collides. |
| `DELETE` | `/assets/tags/:id` | `ASSETS` | Drops taggings. `{ deleted: true, removedFrom: n }`. |

**Assets**

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/assets` | `READ` | Gains `folder`, `tags` (repeated), `unfiled`, `untagged`, `undescribed`. `q` widens to five columns. |
| `PATCH` | `/assets/:id` | `ASSETS` | `AssetPatchBody` gains `description`, `folderId`, `tags` (the full set, replacing). |
| `POST` | `/assets/bulk/tag` | `ASSETS` | `{ selection, tagIds }` — adds. |
| `POST` | `/assets/bulk/untag` | `ASSETS` | `{ selection, tagIds }` — removes. |
| `POST` | `/assets/bulk/move` | `ASSETS` | `{ selection, folderId }`; `null` unfiles. |
| `POST` | `/assets/bulk/delete` | `ASSETS` | `{ selection }`. Report carries `usedOnPublished` (decision 15). |

**Describe**

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `POST` | `/assets/:id/describe` | `ASSETS` | One asset, synchronous. `unsupported` with no `describe` configured. |
| `POST` | `/assets/describe` | `ADMIN` | Batched run (decision 16). `{ selection, batch?, continueFrom?, dryRun? }` → report plus `tagsIgnored`. |

**Versioned**

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `{base}/api/v1/assets` | Gains `folder`, `tag`, widened `q`. Additive; envelope unchanged. |

Every bulk route answers the shared outcome shape: a `BulkReport`, or a `409` carrying
`BulkRefusal` plus the error envelope, per `bulk-writes.md` decision 7.

## Acceptance criteria

### Filing never touches an object

```
GIVEN an asset used on a published page
WHEN it is moved into a folder, or out of one
THEN its `key` is unchanged
AND `GET {base}/asset/:key` returns the same bytes with the same headers
AND no R2 operation of any kind was issued
AND the published page's HTML is byte-identical
```

### A folder filter includes descendants

```
GIVEN folders `clients`, `clients/acme`, `clients/acme/2026`
AND one asset filed directly in each
WHEN the list is filtered by folder `clients`
THEN all three assets are returned
AND the query used a range comparison on `asset_folders.path`, not `LIKE`
```

### Renaming a folder moves its subtree

```
GIVEN `clients/acme/2026` holding assets
WHEN `acme` is renamed to `acme-group`
THEN every descendant's `path` is rewritten in one statement
AND every asset's `folder_id` is unchanged
AND filtering by `clients/acme-group` returns what `clients/acme` returned
AND filtering by `clients/acme` returns nothing
```

### The folder list pages in tree order

```
GIVEN 60 folders across four levels
WHEN `GET {base}/api/assets/folders?limit=25` is paged to exhaustion
THEN every folder appears exactly once
AND every folder appears after its parent
AND siblings appear in alphabetical order
AND the client performed no sort
```

### Tags are identified by slug

```
GIVEN a tag named `Headshot`
WHEN a tag named `  head shot ` is created
THEN the slug collides and the existing tag is returned with status 200
AND no second row exists in `asset_tags`
```

### Multiple tag filters are AND

```
GIVEN asset A tagged `headshot`, asset B tagged `headshot` and `bw`
WHEN the list is filtered by both `headshot` and `bw`
THEN only B is returned
```

### The count guard holds for assets

```
GIVEN a filter matching 400 assets, shown to a person as "400"
AND 3 assets are then tagged elsewhere so 403 now match
WHEN a bulk tag is posted with `expected: 400`
THEN it is refused with 409, `refused: 'count'`, `expected: 400`, `actual: 403`
AND nothing was written
AND re-posting with `expected: 403` runs
```

### A bulk run is the single write, N times

```
GIVEN a selection of 30 assets and `batch: 10`
WHEN the run is driven to completion through `continueFrom`
THEN each asset ends in the state a single PATCH would have left it
AND `seen` reaches 30 and `continueFrom` is null
AND a batch in which every asset failed still advanced the cursor
```

### A bulk delete warns before it acts

```
GIVEN a selection of 400 assets, 12 of which are referenced by published documents
WHEN the delete is posted with `dryRun: true`
THEN the report carries `usedOnPublished: 12`
AND nothing was written
AND the same call with `dryRun: false` deletes all 400
```

### Deleting a folder is not destructive

```
GIVEN folder `clients/acme` holding 40 assets and one subfolder
WHEN it is deleted
THEN 0 assets are deleted
AND those 40 assets have `folder_id` null
AND the subfolder's parent is now `clients` and its path is rewritten
```

### Describing is a no-op with nothing configured

```
GIVEN a host with no `describe` in config
WHEN `POST {base}/api/assets/:id/describe` is called
THEN it answers `unsupported` with a message naming the config key
AND the admin renders no Describe control
AND uploading an image behaves exactly as it does today
```

### An enrichment run cannot clobber a human

```
GIVEN an asset whose `alt` was typed by an editor
WHEN a describe run covers it
THEN `alt` is unchanged
AND `alt_auto` holds the model's text
AND `toAssetValue` returns the editor's `alt`
AND no published document changed
```

### The model may not invent a tag

```
GIVEN tags `headshot` and `bw` exist
WHEN `fn` returns tags `['headshot', 'product-shot']`
THEN the asset is tagged `headshot` only
AND no `product-shot` tag is created
AND the batch report's `tagsIgnored` is 1
```

### Search reaches machine text

```
GIVEN an asset whose `alt_auto` reads "a woman cycling past a red brick wall"
AND whose filename is `IMG_4471.jpg`
WHEN the library is searched for `brick`
THEN the asset is returned
```

### The versioned contract did not move

```
GIVEN a caller using `GET {base}/api/v1/assets?page=2&perPage=50` as it exists today
WHEN this spec has landed
THEN the response envelope, ordering and row shape are unchanged apart from the
     six new row fields
AND no v1 route was added for folders or tags
```

## Implementation plan

Eight phases. Phases 1–5 are the organisation and are independently valuable;
6–8 are the enrichment and can be deferred without leaving anything half-built.

### Phase 1 — the migration and the core vocabulary

1. `migrations/0008_asset_organisation.sql`, exactly as above.
2. `src/core/assets.ts` — `AssetFolder`, `AssetTag`, `AssetFilter`,
   `AssetBulkAction`, `tagSlug`; move `AssetSort` and `DEFAULT_ASSET_SORT` in from
   `core/story.ts`.
3. Extend `AssetRow` and `COLS` (`server/assets.ts:28`, `:40`) with the six columns.
4. **Edit `test/workers/migrations.test.ts:344` and `:348`** to the new index and
   column lists, and add the four absence assertions the migration names.

Leaves the tree green with new columns nothing yet reads.

### Phase 2 — folders, server side

1. `src/server/asset-folders.ts` — `listFolders` (keyset over `path`), `createFolder`,
   `renameFolder`, `moveFolder`, `deleteFolder`. The subtree rewrite is one
   `update … set path = ? || substr(path, ?) where path = ? or (path > … and path < …)`.
   The cycle check is "the destination's path is not inside mine", which the
   materialised path answers with a string comparison.
2. `assetFilterSql(filter)` in `server/assets.ts` — the one composer both `listAssets`
   and `listAssetsByPage` call (decision 13).
3. `listAssets` gains `folder` and `unfiled`.
4. Routes in `routes/assets.ts`; validators in `validate.ts`.

### Phase 3 — tags, server side

1. `src/server/asset-tags.ts` — `listTags` (with opt-in counts), `ensureTag`
   (create-or-return), `renameTag`, `deleteTag`, `setAssetTags`, `tagsForAssets`.
2. `listAssets` gains `tags`, `untagged`; the `having count(*) = n` form, capped at 8.
3. `AssetPatchBody` gains `description`, `folderId`, `tags`.
4. Routes.

### Phase 4 — the admin, single-asset

1. `assets-model.ts` — `AssetsUrl` gains `folder`, `tags`, `unfiled`, `untagged`;
   `assetsParams`, `assetsQuery`, `parseAssetsUrl`, `withFilter` and `isNarrowed`
   follow. Pure, so it lands with its unit tests.
2. A folder tree and a tag chip list in the Assets sidebar; `useFolders`, `useTags`.
3. `AssetDetail` gains folder, tags and description editors beside the alt editor.
4. **`AssetBrowser` gains the filters and the picker gets them too** — the same one
   implementation, two mounts, which is the property `AssetBrowser.tsx:94-109` exists
   to hold.

### Phase 5 — bulk

1. `src/core/bulk.ts`; generify `FilterSelection`/`BulkSelection`; move the report
   shapes; update every existing call site to `BulkSelection<StoryFilter>`.
2. `countAssets(db, filter)` mirroring `countStories`.
3. `src/server/asset-bulk.ts` — `runAssetBulk`, four actions, `(lastId, seen)` cursor,
   per-item `try`, count guard, `usedOnPublished` on the delete report.
4. Routes; the selection UI in `AssetBrowser` (a checkbox layer over the tile grid and
   the table, and *select all matching* in the header).
5. **The picker must not get it.** The selection layer is a prop the screen passes and
   the picker does not, exactly as `kinds` already works.

### Phase 6 — the describe seam

1. `FolioDescribe` in config; validation at construction.
2. `src/server/describe.ts` — `describeAsset(deps, row)`: build the transformed URL,
   the lazy `bytes()`, the tag list; call `fn`; clamp and bound the result; match tags
   to slugs; write the machine columns, `described_at` and `describe_error`.
3. `toAssetValue` returns `alt || alt_auto`.
4. `POST {base}/api/assets/:id/describe`.

### Phase 7 — the run, and on-upload

1. `runDescribe` — batched, `concurrency` in flight, `dryRun`, `tagsIgnored`,
   `continueFrom`, over `AssetFilter` (with `undescribed`).
2. `POST {base}/api/assets/describe` at `ADMIN`.
3. `uploadAsset`'s route fires it under `ctx.waitUntil` when `onUpload` is not false.
4. Admin: a *Describe* action on the detail panel, and a run panel with progress
   driven by `continueFrom`.

### Phase 8 — the adapter and the prose

1. `anthropicDescriber({ apiKey, model?, prompt? })` exported from `folio/server`,
   with a default prompt that asks for alt text, a description and a choice from the
   supplied tag list.
2. `README.md` — the config key, the R2/Images prerequisites, and the fact that
   filing never moves an object.
3. `ROADMAP.md` — strike the flat-library entry; record what was deferred here.

## Edge cases

- **An asset whose folder was deleted mid-request** → `folder_id` is not a foreign
  key, so the row survives with a dangling id. Readers treat an unresolvable
  `folder_id` as unfiled, and the folder delete's own statement nulls them in the same
  batch, so the window is a batch and the failure is benign.
- **A folder moved into its own descendant** → refused, 409, with the path that made
  it a cycle. Checkable as a string comparison because the path is materialised.
- **Two siblings whose names slugify identically** → the `unique` on `path` refuses
  the second with a 409 naming the existing sibling. Not silently de-duplicated: they
  are different names and the editor should choose.
- **A tag filter naming a slug that does not exist** → returns nothing, not an error.
  A filter is a question; "no matches" is an answer. The chip renders as unknown.
- **More than 8 tag filters** → the ninth is refused by the validator with a message
  naming the cap, rather than being silently dropped. A silently dropped filter
  returns *more* rows than asked for, which is the dangerous direction.
- **A bulk move to a folder deleted mid-run** → each item's `try` fails with a named
  message; the run continues and the report names them, per `bulk-writes.md`
  decision 9.
- **A select-all whose count moved between the dry run and the real run** → refused by
  the count guard on the real run. The dry run does not reserve anything, deliberately:
  a reservation is a lock, and this is not a system with locks.
- **`describe` configured but `media` absent** → `unsupported`, the media refusal
  first. Nothing to describe.
- **`describe` configured but `images` absent** → the URL is the original rather than
  a 512px WebP. It works and costs more; the admin says so once in the run panel.
- **`fn` throws, times out, or returns junk** → `describe_error` records a bounded
  message, `described_at` is set, and the asset leaves the backlog. It is retried only
  by an explicit run over `describe_error is not null`, which the run panel offers.
- **`fn` returns a 4,000-character description** → bounded to 2,000 by the same
  `bounded()` validator a human's input goes through. A model is a caller.
- **`fn` returns tags for a non-image** → matched and applied like any other. Nothing
  about tagging is image-specific; only the *default* prompt is.
- **A non-image reaches an enrichment run** → skipped, `described_at` set, no call
  made and no cost. `isImageAsset` (`core/values.ts:210`) is the test.
- **An upload during an enrichment run** → described by `waitUntil` on its own, and
  invisible to the run's captured filter, which is the point of capturing.
- **An editor clears their `alt` back to empty** → `alt_auto` becomes effective again.
  That is the right answer: clearing means "I have nothing better", not "show nothing".

## Testing requirements

**Unit (`test/unit/`):**

- `core/assets.test.ts` — `tagSlug` (case, trim, inner whitespace, unicode, empty);
  `AssetFilter` round-trips.
- `core/bulk.test.ts` — the generified selection types compile against both filters;
  `wasRefused` unchanged.
- `admin/assets-screen.test.ts` (extend) — `parseAssetsUrl` / `assetsQuery` round-trip
  the four new terms; defaults leave the URL; `assetsParams` emits repeated `tags`;
  `withFilter` keeps the open asset; `isNarrowed` counts the new terms.
- `admin/asset-folders.test.ts` — building a tree from a `path`-ordered page stream
  without sorting; breadcrumbs from a path; the cycle predicate.
- `server/describe.test.ts` — result clamping; unmatched tags dropped and counted;
  human columns never written; a non-image skipped without calling `fn`.

**Workers (`test/workers/`, real workerd):**

- `migrations.test.ts` (edit) — the new column and index lists; the four absences.
- `asset-folders.test.ts` — descendant range vs `LIKE` (assert the range form returns
  nothing for a differently-cased sibling); subtree rewrite on rename and on move;
  cycle refusal; delete re-parents and unfiles; the paged tree order property.
- `asset-tags.test.ts` — slug collision returns the existing row at 200; AND
  semantics; the 8-tag cap; delete removes taggings only.
- `assets.test.ts` (extend) — `q` across five columns; filters compose with `kind`,
  the keyset and `?count=1`; `assetFilterSql` gives `/api/v1` the same answer as the
  admin route for the same filter.
- `asset-bulk.test.ts` — the count guard refuses and then admits; the cursor advances
  through an all-failed batch; `usedOnPublished`; `dryRun` writes nothing.
- `describe-run.test.ts` — batching and `continueFrom`; `concurrency` respected;
  `unsupported` with no config; a throwing `fn` records and moves on.

**End to end (`scripts/`, live dev server on port 5199):**

- `scripts/media-library-test.mjs` — upload, create a folder tree, file, tag, filter by
  folder and by two tags, bulk-tag a select-all, bulk-move, delete a folder and assert
  the assets survive unfiled. Follows both conventions: `signInGlobally()` from
  `scripts/lib/auth.mjs`, and `import './lib/ts-resolve.mjs'` first. No socket frames,
  so no `PROTOCOL_VERSION` stamping is needed — but if one is added later, stamp every
  frame.
- Run it as `./scripts/e2e.sh scripts/media-library-test.mjs`, never against a stale
  database.

## Dependencies

- **Spec 20 (`platform/bulk-writes.md`)** — done. Supplies the selection contract, the
  count guard, the cursor rule and the report shapes, all of which are reused rather
  than restated.
- **Spec 18 (`foundation/pagination.md`)** — done. Every new list route is keyset-paged
  under its rule, and `?count=1` is what the select-all guard compares against.
- **Spec 10 (`foundation/identity-and-access.md`)** — done. `ASSETS` and `ADMIN`.
- **Specs 31, 30, 28, 29** — none of them is a dependency. This spec is sequenced
  after them because that is the queue, not because it needs anything they build.
- **Spec 23 (`foundation/multi-site.md`)** — *the reverse*: 23 will need to scope
  `asset_folders`, `asset_tags` and `asset_taggings` with `site_id` and add them to its
  list-route pass. Landing this first is what makes that one pass rather than two.
- **Cloudflare:** no new binding. `media` (R2) is already required for uploads and
  `images` is already optional; the enrichment uses both exactly as they are. The host
  supplies its own LLM credentials to its own `fn` and Folio never sees them.

## Out of scope

- **Per-folder permissions.** Roles are global (`auth/roles.ts`), and a per-folder ACL
  is an access-control model, not a filing feature. It would also have to be enforced
  in the picker, in `/api/v1`, in MCP and in `assetUsage`, which is spec 10's surface
  area for a want nobody has stated.
- **Folder or tag routes on `{base}/api/v1`, and MCP tools for either.** A version
  segment is a promise (decision 13). `upload_asset` stays the only asset tool.
  Additive later.
- **Assets in the FTS5 index.** Decision 12, with the trigger for revisiting written
  down.
- **Tagging documents.** `content_index` already filters documents by root fields, and
  decision 4 declines to build the generic table for a second user who has not arrived.
- **Duplicate detection.** A content hash on upload would find re-uploads of the same
  file, which a library of thousands certainly contains. It is a different feature with
  a different migration and its own question (what should the second upload *do*), and
  bundling it here would make this spec two specs.
- **Renaming an asset's file, or replacing its bytes in place.** The key is immutable
  by decision 1; replacing bytes under a stable key would defeat the `immutable` cache
  headers `uploadAsset` sets.
- **A trash or an undo for a bulk delete.** `deleteAsset` is immediate today and this
  does not change that. A restore path wants versioned objects in R2 and is its own
  spec.
- **Automatic filing** — the model choosing a *folder* as well as tags. A tag is
  additive and reversible; a folder is where the file lives, and a model moving forty
  thousand files is the one enrichment outcome that is expensive to undo.
- **Spend controls on the enrichment run.** Decision 16 gates it by role instead.
  Folio does not know the host's pricing and should not invent a budget.

## Open questions

None. All ten checkpoints were answered by the owner on 2026-09-05 before drafting,
each to its recommendation, and are recorded above.

Two decisions are the owner's to overturn cheaply if they read wrong later, and are
flagged where they are made rather than left here as questions: **decision 16** (the
bulk describe run is `ADMIN` while everything else is `ASSETS` — chosen on consequence
rather than symmetry) and **decision 4**'s eight-tag filter cap, which is a bind budget
and can be raised by narrowing something else in the same statement.

## Implementation notes

Built in phases, and this section grows one entry per phase as they land. The
migration number stopped being a claim with phase 1: **`0008_asset_organisation.sql`
is on disk**, so the header's "a claim, not a landing" note is history now.

### Phase 1 — the migration and the core vocabulary (2026-09-05, `f1e52a3`)

Landed as planned: `migrations/0008_asset_organisation.sql`, `src/core/assets.ts`
(with `AssetSort` / `DEFAULT_ASSET_SORT` moved in from `core/story.ts`), the six
columns on `AssetRow` and `COLS`, and the edits to `test/workers/migrations.test.ts`.
One thing the plan did not name: `smoke.test.ts` asserts the **exact table list**, so
three new tables broke it and had to be told about them.

### Phase 2 — folders, server side (2026-09-06)

`src/server/asset-folders.ts` is new; `assetFilterSql` is new in `server/assets.ts`
and both readers go through it; four routes in `routes/assets.ts`; two body schemas
and `folderQuery` in `validate.ts`. `test/workers/asset-folders.test.ts` is new (25)
and `test/unit/server/pure.test.ts` gained the pure SQL emitters (9).

**The two destructive failure modes were verified by breaking them**, which is the
only way to know a test is actually holding a decision rather than agreeing with it:

- Swapping the range for a prefix `like` in `subtreeWhere` turns three workers tests
  and four unit tests red, and the failure output is the damage itself: renaming
  `Shoots` to `Archive` rewrites the *sibling* `Shoots 2024` to `archive-2024` and
  `Shootsx` to `archivex`. Two folders nobody touched, silently, with no undo.
- Neutering the cycle guard turns four workers tests red, and a self-move then
  *succeeds*, committing a row whose `parent_id` is its own `id` — a subtree detached
  from the tree with no recursive query anywhere in this design to find it again.

**Six things the plan did not settle, decided here:**

- **`renameFolder` and `moveFolder` are wrappers over one `updateFolder`.** The plan
  names five functions; a rename and a move are the *same* operation on a materialised
  path — recompute my path, rewrite my subtree — and two copies of that statement is
  how the two come to disagree about the range. Both names exist because the plan uses
  them; there is one implementation of the dangerous statement.
- **The cycle check is one comparison, not two.** `parent.path === mine ||
  parent.path.startsWith(mine + '/')` catches a self-move for free, because a
  self-move makes the destination's path equal to mine. A separate `parentId === id`
  guard would be a second thing to keep in step, and the `+ '/'` in the second
  disjunct is load-bearing on its own: without it, moving `Shoots` into the unrelated
  sibling `Shoots 2024` would be refused as a cycle. A test pins that it is allowed.
- **`substr(path, length(?) + 1)` takes the length from SQLite, not from JavaScript.**
  `String.length` counts UTF-16 code units and SQLite's `length()` counts characters,
  so a folder named with an astral character would cut one short and corrupt every
  descendant. Costs one extra bind (five, not four) and removes the encoding question
  entirely.
- **Deleting a folder lifts its whole subtree in one statement**, not one move per
  child: descendants' paths shift up a segment through the same `? || substr(path,
  length(?) + 2)` form. It also **pre-checks the one collision it can cause** — delete
  `a/x` where `a/x/y` and `a/y` both exist — and refuses with a message naming the
  child, because the alternative is a raw D1 `UNIQUE constraint failed` that
  `errors.ts` translates into a message about *stories*.
- **`folder` and `unfiled` are refused together at the route** (400), rather than one
  quietly winning. `assetFilterSql` composes both clauses honestly, which yields an
  empty list — truthful, and indistinguishable on screen from an empty folder.
- **`assetFilterSql` composes `q`, `kind`, `folder` and `unfiled` only.** `tags` and
  `untagged` are phase 3's and `undescribed` is phase 7's; they are `AssetFilter`
  members no route parses yet, and the composer says so where the clauses are, so the
  next phase adds a clause *there* rather than at a call site.

**Bind budget, checked rather than assumed** (`db.ts`'s `D1_BIND_CAP`): every
statement added by this phase binds a **fixed** number of parameters — five for the
subtree rewrite, four for the delete's lift, three for the collision pre-check and for
a folder filter, nine for the widest possible `assetFilterSql` — and **not one of them
binds a caller-sized list**, so `bindChunks` is not needed anywhere here. That is the
materialised path earning its keep rather than a happy accident: the alternative
design, resolving a folder to a list of descendant ids, is exactly the caller-sized
bind list `db.ts` warns about. A unit test asserts the nine.

**Left for a later phase, named rather than glossed:** `listAssetsByPage` now takes an
optional `filter` and runs it through the shared composer (decision 13), but the
**`{base}/api/v1/assets` route does not parse `folder` or `q` yet** — that route lives
in `routes/api/index.ts`, which was outside this phase's file set. It is a two-line
change and the reader behind it is already built and tested.

### Phase 4 — the admin, single-asset (2026-09-06)

Landed as planned: `assets-model.ts` gained `folder`, `unfiled`, `tags` and
`untagged` on `AssetsUrl`, with `parseAssetsUrl`, `assetsQuery`, `assetsParams`,
`withFilter` and `isNarrowed` following; `useFolders.ts` and `useTags.ts` are new;
`AssetBrowser.tsx` grew a sidebar (a folder tree, a *New folder* dialog, and tag
chips) that both mounts get for free; `AssetDetail.tsx` gained a description, a
folder and a tags editor beside the alt editor.

**The one-parameter-per-key address bar is why the two URLs disagree about tags.**
`route.ts`'s `parseQuery` keeps only the last of two repeated `?tags=` — a fact the
plan did not name — so `AssetsUrl.tags` rides the screen's own address bar
comma-joined (`assetsQuery`), the way `useEditor.ts`'s `wanted` already does, and is
sent to the route **repeated** (`assetsParams`, one `params.append('tags', …)` per
slug), which is what `c.req.queries('tags')` on the other end actually parses. Two
representations of one array, on either side of one function boundary, and
`assetsParams`'s own doc comment says why they may not be unified.

**`withFilter` enforces the two mutual exclusions the route refuses with a 400**,
so this screen can never build the request that triggers one: turning `folder` or
`tags` on clears `unfiled`/`untagged` and vice versa. `parseAssetsUrl` carries the
same defensive rule for a hand-edited URL naming both — folder wins over `unfiled`,
tags win over `untagged` — which is the one case `withFilter` cannot reach because
nothing in this screen wrote that URL.

**`AssetRow` (this file's own, not `server/assets.ts`'s) now carries `tags`.** Every
unversioned route this admin calls attaches it (`routes/assets.ts`'s `withTags`),
so the type says so rather than leaving every caller to declare the extension for
itself. The one response that does not carry it — `POST /assets`'s upload
response — is never read for its `tags`, only its `id`, so this is sound in
practice; a comment on the interface says why rather than leaving it to be
rediscovered.

**Two independent `useFolders`/`useTags` instances exist whenever the detail panel
is open beside the sidebar** — `AssetBrowser`'s sidebar and `AssetDetail`'s editors
each call the hook rather than sharing a fetch. A folder or tag created from one
does not appear in the other until it next mounts or reloads. Decided rather than
discovered late: a shared cache across two components is a bigger investment than
a single-asset phase owes, and named here so phase 5 (bulk, which will want its own
folder/tag data for the same reasons) does not have to rediscover the trade-off.

**Folder creation lives only in the sidebar; tag creation lives only in the detail
panel.** The plan named neither, and both were decided for the same reason: one
creation surface per kind of thing, rather than two places that can disagree about
what just got created. `FolderEditor`'s select therefore offers only folders that
already exist — a folder created while the panel is open does not appear there
until its own `useFolders` reloads, which is the same gap the paragraph above
already names.

**Deferred, and worth naming rather than gone quiet about:** folder rename, move
and delete have no admin surface yet — `asset-folders.ts`'s `updateFolder` and
`deleteFolder` are only reachable through the raw API today. Tag rename and delete
are the same. Nothing in phases 1–3 needed either for the tree and the vocabulary
to be usable, and phase 5's bulk actions are a more natural home for "move/delete a
folder" than a single-asset phase, so this is left rather than built twice.

**One mounted `Dialog` at a time, not just one implementation — verified by
breaking it.** The plan did not anticipate this: `NewFolderDialog` opened from the
sidebar while `AssetBrowser` sits inside `AssetPicker.tsx`'s own `wide` `Dialog`
mounts two `useFocusTrap` instances at once, and the outer one's "is focus inside
my panel?" check reads false for anything focused in the inner one — a portal
detaches DOM containment, so `outerPanel.contains(activeElement)` is false the
whole time the inner dialog has focus. Every Tab press was yanked back into the
picker's own Cancel/Use buttons instead of cycling the New Folder form, which is
not a corner case, it is what happened on the very first Tab. `CLAUDE.md`'s "one
focus trap" turns out to bind harder than "one implementation, do not hand-roll a
second": nesting two mounted instances of the *same* one has the identical
failure mode. The fix is `Sidebar`'s new `compact` prop, threaded from
`AssetBrowser`'s own — folder creation is offered only on the screen, where
nothing else is layered on top; the picker keeps the read-only tree and chips.
`AssetDetail`'s editors never had this risk, because that panel is screen-only by
`AssetPicker.tsx`'s own design ("drops the detail panel").

Ten new tests in `test/unit/admin/assets-screen.test.ts`, beyond extending the
existing URL round-trip and `isNarrowed` cases with the four new fields:
`withFilter`'s two mutual exclusions, `assetsParams`'s folder/unfiled and
repeated-`tags` shapes, `toggleTagFilter`'s cap, `tagChipLabel`, `folderDepth` and
`indentedFolderName` — the last two pinned with an explicit `\u00A0` escape
rather than a literal character, so the assertion does not depend on an invisible
non-breaking space surviving a copy-paste. `MAX_TAG_FILTER` here is asserted equal
to `server/asset-tags.ts`'s own, the same insurance `assetValue`'s test buys against
`toAssetValue`.
