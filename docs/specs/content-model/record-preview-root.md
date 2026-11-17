# Feature: Record preview without a host page (`previewRoot`)

> **Group:** content model
> **Build order:** 45
> **Size:** S
> **Status:** done (built 2026-11-17, v1.8.0)
> **Wire version:** none. `PROTOCOL_VERSION` stays at 5 (decision 12)
> **Migration:** none
> **Release:** v1.8.0 (minor; every change is additive, decision 12)
> **Last updated:** 2026-11-17

## Summary

A `record` type can be previewed in the editor only through a **stored host page**:
its type names a `previewPath`, the admin finds the routed story at that path
(`src/admin/ui/useStory.ts:135-161`), and the iframe loads that page's preview URL
with `&record=<id>` (`useStory.ts:203-211`). With no story at the path the record
falls back to form mode. Issue #182 records what that costs a host: the host page is
an ordinary `page` type, so it sits in the new-document menu, in the content list, can
be published (so the host adds a router guard to 404 it), and has to exist on every
deployment (so importers, seeds and content checks keep it alive). On one consumer site
that is one unpublished page, shared by two record types, plus a router guard, importer
steps and verification scripts that exist only to keep the page alive.

This spec adds `previewRoot: '<blockName>'` to a `record` type. Folio synthesises the
host document in memory, a blank instance of that block from the record's brand, and
runs the existing record-preview path around it: the same `previewPage` shell
(`src/server/pages.tsx:177`), the same globals stacked above, the same
`recordResolution` merge (`src/core/resolution-merge.ts`), the same per-keystroke
`postMessage` updates. No page type, no stored document, no router guard. The URL is
`/?_folio=preview&record=<id>` at the site root, which the existing `?_folio=` branch
answers. `previewPath` stays, and `previewRoot` wins when both are set.

This also amends spec 14 (`data-documents.md`) decision 3, "Records are edited
full-width with no preview", which has been stale since #74 (v1.2.0) gave records
`previewPath`.

## Ground truth

Verified 2026-11-17 against `origin/main` at `75b0d57` (v1.7.0).

**core (`src/core/`):**
- `DocumentType` (`schema.ts:76-127`) has `name`, `label`, `kind`, `root`,
  `titleField?`, `under?`, `default?`, `group?` and `previewPath?` (`:126`). The
  `previewPath` doc comment (`:108-125`) already describes the record case: "A
  `record` may declare one too, and is then previewed in the context of the host page
  at that path … A record with none is edited as a form, with no preview."
- `validateTypes(types, schema)` (`schema.ts:361-459`) is the construction-time check
  for `types`. It checks the root block exists (`:381-386`), `titleField` (`:387-399`),
  and refuses `under` on a non-page kind with the reasoning "Silently ignoring it on a
  record would leave a config key that reads as a constraint and enforces nothing"
  (`:400-406`). **It never reads `previewPath`**: an unknown path is not checkable at
  construction (it is content), and nothing refuses it on a `page`.
- `validateTypes` takes a `SchemaIndex` (field metadata only). Whether a block has a
  `render` is known only from the `Registry` (`block.ts:81`,
  `Record<string, AnyBlockDef>`); `defineRecord` (`block.ts:68`) is the sugar that
  omits `render`, and `preview/Render.tsx:93` draws a `folio-unrendered` placeholder
  for such a block in `edit` mode only, and nothing in `off` mode.
- `blankSubtree(schema, type, parent, slot, order, preset?)` (`schema.ts:662-676`) and
  `blankBlok` (`:678-686`, `blankSubtree` with no preset) are the single creation point
  for a block: each non-`blocks` field gets `field.default ?? defaultValue(field)`
  (`subtreeRecipe`, `:622-655`), uids come from `newUid()`. The runtime's `seed`
  (`server/runtime.ts:1238-1246`) builds a starting `Doc` from it as
  `{ root: root.uid, bloks: { [uid]: blok } }`, applying the root's `default` preset
  when it has one.
- `toManifest` (`block.ts:135-151`) copies `types` whole (`types: [...types]`), so any
  key on `DocumentType` reaches the admin's manifest and `{base}/api/v1/schema` with no
  further change.
- `Resolution.record` (`resolve.ts:180-186`) is "set only by the editor's preview of a
  record whose type declares a `previewPath`". `buildResolution` (`resolve.ts:204-221`)
  makes a ref for an unrouted story with `url: ''` and `routable: false`.
- `recordResolution(page, overlay, id, doc)` (`resolution-merge.ts`) is the one merge,
  shared by the server render and the preview client. The page's resolution is the
  base; the record's `stories`, `docs`, `forms` and `collections` are unioned under it;
  `docs[id]` is always the live draft and `record: id` is set.

**server (`src/server/`):**
- `previewBranch(req, url, env, mode, on)` (`index.tsx:727-922`) answers
  `?_folio=preview|draft`. In order: the brand (`brandAt`, `:747-748`); the actor and
  the draft gate, falling back to share cookies (`:784-801`); `?locale=` (`:807-808`);
  the path (`rt.pathForLocale`, `:809`) and **the story at it** (`storyByPath`, `:811`;
  `_folio_id` on multi-site, `:819-821`), handing back when there is none (`:827`); the
  share claim, which stamps a view (`claimShare`, `:838-843`); `as` (`:860-884`); then
  `record` (`:877`, `:886-919`).
- The record branch (`index.tsx:902-919`) refuses a share cookie and `mode === 'draft'`
  before looking the record up, refuses `as` + `record` (`:880`), and hands back an id
  that is not a `record` of the gated site's brand (`brand.typeOf(target.type)?.kind`)
  or not in the render's chain. **It does not check that the record's type declares
  `previewPath`**: any record of the brand renders in the context of whatever page the
  path names.
- `handle()` reaches `previewBranch` for any path outside `{base}` carrying
  `_folio=preview|draft` (`index.tsx:961-962`); on a deployment with `sites` only on a
  site's preview origin, after `routeGranted(…, null, env)` with **no path** (`:996-1013`),
  and every response is `framedBy` the admin.
- `previewPage(rt, bindings, story, opts)` (`pages.tsx:177-394`) uses `story` in exactly
  three places: `brand.draftFor(bindings, story, opts.registry)` for the page's
  document (`:235`), `story` passed to the page's `brand.resolve` (`:241-246`), and the
  `<title>` (`:321`). With `opts.record` it reads the record's draft through `draftFor`
  (`:250`), resolves it with `story: opts.record` (`:252-257`), merges with
  `recordResolution` (`:261-266`), renders the page in `off` mode (`:303`), stacks every
  configured global above it unless `opts.bare` (`:313-318`), and bootstraps
  `{ doc: recordDoc, resolution, editing: { record, page: doc } }` (`:342-346`).
  `previewParamsOf([doc, recordDoc, editingDoc], brand.schema)` (`:282`) collects the
  blocks' `previewParams` from all three documents.
- Server `resolve(bindings, doc, opts)` (`runtime.ts:1407` onwards) treats `opts.story`
  as optional (`ResolveOptions.story?`, `runtime.ts:180-187`). It uses it for: breadcrumb
  ancestors (`ancestorPaths(opts?.story?.path ?? null)`, `:1459`); excluding the page
  from second-hop documents (`:1646-1648`); a form's `_folio_page` URL (`formPage`,
  `:1741-1742`); `Resolution.path` (`:1850`); and in draft mode **patching the open
  story's draft over its row in any collection that lists it** (`:1862-1889`), using
  `doc`'s root data and `titleOf(doc, …)`.
- `previewUrlFor(path, locale, mode, site)` (`runtime.ts:1068-1083`) builds a page's
  preview URL from the host's `route`, moved onto `site.preview` on multi-site.
  `urlsFor` returns an unrouted story untouched (`:1100`): **a record row carries no
  `previewUrl`**, which is why the admin builds a record's URL from its host page's.
- The bare singleton preview `GET {base}/preview/global/:name`
  (`routes/editor.ts:192-252`) is an admin-origin route gated on `READ_DRAFT`. On
  multi-site the admin does not use it, because a cross-origin pane cannot load an
  admin-origin page (`Admin.tsx:1342-1353`).
- `cacheVerdictFor` answers `bypass` for any `?_folio=preview|draft` whatever the path
  (`cache-request.ts:121-122`), and `previewPage` answers `no-store` (`pages.tsx:901`).
- MCP `preview_document`'s `chooseTarget` (`mcp/shot.ts:123-136`) answers `none` for a
  record: it renders only `draftUrl` (a routed page) or the bare global route in
  `?mode=draft`, and never concatenates caller input onto a path.
- `POST {base}/api/story/:id/share` refuses an unrouted story (`routes/preview.ts:159-164`).
- `prepareBrand` (`runtime.ts:~840-880`) builds each brand's registry and schema and
  calls `validateTypes(types, schema)` per brand (`:864`), so a type is always checked
  against **its own brand's** blocks.

**admin (`src/admin/`):**
- `Admin.tsx:679-686` fetches the host page row for a singleton or a record whose type
  declares `previewPath` (`usePreviewHost`, a `GET {base}/api/stories?paths=` read).
- `previewFor(story, type, host, base, multi)` (`Admin.tsx:1334-1355`): a routed story's
  own `previewUrl`; for a record, `recordPreviewUrl(type, host, story.id)` (before the
  multi-site check); for a singleton, the host page with `&as=` or the bare route.
- `recordPreviewUrl(type, host, id)` (`useStory.ts:203-211`) answers the host page's
  `previewUrl` + `&record=<id>`, or undefined (form mode) with no `previewPath`, no host
  row, or a host row at another path. "There is no bare fallback."
- `previewFrame` (`screens/editor-model.ts:439-448`) switches locale only through
  `story.previewUrls`, which a record does not have, so **a record preview stays on the
  source-locale URL** today.
- `paneSource` (`editor-model.ts:536-547`) on multi-site keeps only the URL's path and
  query and wraps it in `paneSrc` (`hooks/usePreviewBridge.ts:62-69`):
  `{base}/~<site>/site/start?next=<path+query>`, which mints a grant and lands on the
  pane site's preview origin. The frame URL's own origin is discarded. `_folio_id` is
  added only for a story with a path (`:545`).
- `editorLayout` (`editor-model.ts:674-688`): an unrouted document with a preview is not
  form mode; the rail follows `nested`.
- `previewClause` (`screens/settings-model.ts:217-221`) describes `previewPath` for
  singletons only; a record's preview column is `''`.

**preview (`src/preview/`):**
- `mount.tsx` reads `editing: { record, page }` from the bootstrap (`:32`, `:283-285`),
  holds the record's draft as the editable document, re-merges with `recordResolution`
  on every frame (`:87-101`), and draws `record.page` in `off` mode (`:153-160`). It
  never builds the page document itself; the server's bootstrap is the only source.

**tests:**
- `test/unit/admin/record-preview.test.ts` (5 cases on `recordPreviewUrl`).
- `test/unit/preview/record-mode.test.tsx` (hydration, keystrokes, posted-resolution
  merge, rename).
- `test/workers/preview-record.test.ts` (render, unchanged without `record`, refusals in
  draft / with `as` / for a non-record / for a share grant).
- `test/workers/preview-record-sites.test.ts` (scope and group chain, out-of-chain
  record, other brand's record).
- `test/unit/core/document-types.test.ts` holds `validateTypes` cases.
- `test/unit/admin/settings-screen.test.ts` holds `typeRows` cases.

**docs that describe the current behaviour:** `docs/handbook.md:1700-1749`,
`docs/configuration.md:142`, `AGENTS.md:187-205`, `UPGRADING.md:718-741`
("Previewing a record through a host page (v1.2.0)"), and
`docs/specs/content-model/data-documents.md` decision 3 (`:68-72`) and implementation
note 9 (`:549-551`).

## User stories

### A host previews records with no page to maintain
**As** a host developer **I want to** name a layout block for a record type's preview
**so that** I can delete the hidden host page, its router guard, its importer step and
the script that checks it still exists.

### An editor sees the record as it will look
**As** an editor **I want** a person or a news post to open beside a live preview that
updates as I type **so that** I can judge the record in a page-like frame without
knowing an internal page exists.

### An editor is never offered the tool as content
**As** an editor **I want** nothing in the new-document menu or the content list that is
only there to make previews work **so that** I do not create, publish or delete it by
mistake.

## Architecture decisions

### 1. A record type names a root block, and Folio synthesises the host document

`previewRoot: '<blockName>'` on a `record` type. At preview time Folio builds a
one-blok `Doc` from that block (decision 3) and hands it to `previewPage` as the page
being drawn, in place of a stored story's draft. Everything downstream is the existing
record path: `recordResolution`, `off` mode for the page, every configured global
above it, the bootstrap's `editing: { record, page }`, and the preview client's
re-merge per frame.

**Rejected: an `editorOnly` flag on a page type** (issue #182 option 1). It keeps the
stored document, so a host still has to create it on every deployment and check it is
there, and Folio would have to teach the new-document menu, the content list, publish,
`reader.page()` and the sitemap readers to skip it: five surfaces to keep consistent
for a document that exists only to be drawn around another one. **Rejected: documenting
the current pattern better** (option 3): it leaves every cost the issue lists in place.

### 2. `previewPath` stays on record types, and `previewRoot` wins when both are set

`previewPath` keeps working exactly as it does. A host that wants an editor-editable
preview page (a heading, a promo strip an editor can change) still has one. When a
record type declares both, `previewRoot` is used and the path is never fetched, in the
admin or the server. Both set is the ordinary state while a host migrates (declare
`previewRoot`, deploy, then delete the page and the key), so it is accepted silently
rather than refused.

**Rejected: removing `previewPath` from record types in a `2.0.0`.** It is a narrowing of
a `createFolio` key, so a major bump, and it takes away the one form that lets an editor
change the frame around the record. Nothing about `previewRoot` needs it gone.

### 3. A bare block name, built as a blank instance with field defaults and no preset

`previewRoot` is a string, never `{ block, data }`. The synthetic document is
`blankBlok(brand.schema, previewRoot, null, null, 'a0')` wrapped as
`{ root: blok.uid, bloks: { [blok.uid]: blok } }`: each field at its `default`, every
`blocks` slot empty. The block draws the record from `resolution.record`, which is the
only data it has a reason to read.

The block's **`default` preset is not applied**, unlike `seed` for a new document
(`runtime.ts:1238-1246`). A preset is the starting content an editor gets for a new
document; its `data` and `children` are exactly the static data this decision rules
out, and applying it would make a change to an editor's starting template silently
reshape every record preview.

**Rejected: static data on the key** (`{ block, data }`). It is a second content store,
in code, for text an editor cannot change; a host that wants editable framing has
`previewPath` (decision 2). **Rejected: applying the `default` preset**, above.

### 4. `record` kinds only; refused at construction on a `page` or a `singleton`

`validateTypes` throws for `previewRoot` on any kind other than `record`, in the same
shape as the `under` refusal (`schema.ts:400-406`): a key that reads as configuration
and does nothing is worse than an error.

- A `page` has a URL of its own and renders itself.
- A `singleton` already has two previews: in context on a real page through
  `previewPath` and `&as=`, and the bare `{base}/preview/global/:name`. A synthetic
  root would add a third, and it would have nothing to draw: `resolution.record` is set
  only for a record, and a global's own block already renders the global.

**Rejected: allowing it on singletons** as "the frame for the bare preview". The bare
preview already draws the global alone on the host's stylesheet, and the frame would
need a second key on `Resolution` (the global's name) for the block to read, which is
a new contract for a case nobody has asked for.

> **Amended (2026-11-18, v1.8.1).** Spec 46 (`singleton-preview-root.md`) allows
> `previewRoot` on a singleton that is one of `globals`, as the page of the in-context
> `&as=` preview rather than a frame for the bare one. The objection above does not
> apply to that form: the frame there is static context and draws nothing about the
> global (Folio draws the global in its own wrapper), so no key on `Resolution` is
> added. The case that was not asked for here was asked for, for headers and footers
> that a page hero crowds out. `previewRoot` on a `page` is still refused. The text
> above stays as the record of the first decision.

### 5. The block must be in the record's brand's registry and must render

Checked at construction, per brand:

- In `validateTypes` (`schema.ts`), against the brand's `SchemaIndex`: `previewRoot`
  names a block in it, or `folio: document type '<t>' names previewRoot '<b>', which is
  not in the registry`.
- In `prepareBrand` (`runtime.ts`, immediately after `validateTypes(types, schema)` at
  `:864`), against the brand's `Registry`: the block has a `render`, or `folio: document
  type '<t>' names previewRoot '<b>', which has no render (a defineRecord block draws
  nothing in a preview)`. This half lives in the runtime because `validateTypes` sees
  only the `SchemaIndex`, which carries no `render`.

Because both run inside `prepareBrand`, a branded deployment checks each record type
against its own brand's blocks, and at render the block comes from the gated site's
brand (`brand.schema`, `brand.registry`), never another brand's (decision 10 of
`multi-brand.md`).

Any rendering block in the brand is allowed: it does not have to be a page type's
root. A host may well write a slim layout block that exists only to frame previews.

**Rejected: accepting a block with no `render`.** It would render an empty frame in `off`
mode forever with nothing to say why, which is the silent-misconfiguration class the
rest of `validateTypes` exists to refuse. **Rejected: requiring a page type's root**,
which pushes the host back towards declaring a type for a preview.

### 6. The URL is `/?_folio=preview&record=<id>`, built by the admin, relative

`recordPreviewUrl` answers `/?_folio=preview&record=<encoded id>` when the type declares
`previewRoot`, before it looks at `previewPath` or the host row. The admin builds it;
the server adds nothing to the record's row.

- **Single site:** the admin and the host's pages are served by the same Worker on the
  same origin (the admin is mounted under `{base}` by the host's `handle()`), so a
  relative `/` lands on `handle()`, which answers `?_folio=` at any path outside
  `{base}` (`index.tsx:961-962`). This is the origin `previewUrlFor` produces for a
  host whose `route` returns paths, which is every documented host.
- **Multi-site:** `paneSource` keeps only the path and query and sends the pane through
  `{base}/~<site>/site/start?next=…` to the pane site's preview origin
  (`editor-model.ts:536-547`, `usePreviewBridge.ts:62-69`), exactly as a
  `previewPath` record's URL is today. So the request arrives on the site's preview
  origin, with a grant, which is the origin rule `previewUrlFor` applies
  (`runtime.ts:1077-1078`). A site with no preview origin gets the existing "cannot be
  previewed there" pane message.

The URL carries no `locale`: a record preview renders in the source locale, which is
what a `previewPath` record does today (`previewFrame` switches only through
`previewUrls`, which a record has none of). Localising record previews is a change to
both forms and is out of scope.

**Rejected: decorating a `previewRoot` record's row with a server-computed
`previewUrl`.** `previewUrl` on a `StoryMeta` currently means "this document is
routed"; giving it to a record would change that for every reader, including the
versioned `{base}/api/v1` payloads, and on multi-site the pane discards the URL's origin
anyway. **Rejected: an admin-origin `{base}/preview/record/:id` route** like the bare
singleton route: a cross-origin pane on a multi-site deployment cannot load an
admin-origin page (the reason `previewFor` already gives a global on multi-site no bare
preview, `Admin.tsx:1342-1353`), so records would preview on single-site deployments
only.

### 7. The `?_folio=` branch looks the record up first, and a `previewRoot` type skips the page lookup

`previewBranch` is reordered so that `record` is read and resolved **before**
`storyByPath`:

1. Brand, actor, draft gate and share-cookie fallback, `?locale=`: unchanged.
2. `record = url.searchParams.get('record')`, `as = url.searchParams.get('as')`.
3. If `record !== null`: hand back (`return null`) when `shared.length > 0`, when
   `mode === 'draft'`, or when `as !== null`. These are today's three refusals, still
   made before the record is read, so the refusal cannot depend on which records exist
   and a share cookie never reaches `claimShare` for a record request (today it stamps a
   view on the host page first and is then refused).
4. Read the record once (`storyById`). Hand back unless it exists, its type is a
   `record` of this brand (`brand.typeOf(target.type)`), and its site is in the chain.
   Today's checks, unchanged.
5. If that type declares `previewRoot`: hand back if `_folio_id` is present (it names a
   page to draw and there is none, so it is a request with two documents, which is no
   request); otherwise render `previewPage` with the synthetic host (decision 8) and
   return. **The path is never read**, so `/`, a stale tab's `/authors`, and a host
   whose root route is not `/` all render the same thing.
6. Otherwise fall through to today's path lookup, share claim and `as` handling, and the
   record branch renders with the `target` read in step 4 rather than reading it again.

Every refusal shape is the one this branch already uses: hand the request back, so the
host's own routing answers.

**Rejected: an early `previewRoot` branch that falls through to the unchanged code.**
A `previewPath` record would then be read twice per preview load, and the share-cookie
refusal would still happen after a view stamp. **Rejected: requiring the path to be
exactly `/`.** The path means nothing to a synthetic render, and refusing a stale tab's
`/authors` URL after a host migrates would show the editor the host's published page
instead of the record.

### 8. The synthetic host has no story: the page resolves with none

`previewPage` gains an overload that takes `null` for `story` and requires
`opts.root: string` and `opts.record: StoryMeta` with it:

```ts
export function previewPage(rt, bindings, story: StoryMeta, opts: PreviewOpts): Promise<Response>;
export function previewPage(
  rt, bindings, story: null,
  opts: PreviewOpts & { root: string; record: StoryMeta },
): Promise<Response>;
```

With `story === null`:

- `doc` is the synthetic document from decision 3, built from `brand.schema`. No
  `draftFor`, so **no Durable Object is touched or created for the host**, and no row
  is read; the record's own `draftFor` (`:250`) is the only draft read.
- The page's `brand.resolve` is called **without `story`**. Each use of `opts.story`
  in `resolve` is then correct to be absent: no ancestors (the synthetic page has no
  path and no breadcrumb); no second-hop exclusion (there is no page id to exclude);
  no `formPage` (a blank block embeds no form); no `Resolution.path`; and no
  collection patch.
- The `<title>` is `Preview · <record title>`.
- `editing: { record: record.id, page: doc }` is bootstrapped exactly as now, carrying
  the synthetic document to the client.

**Rejected: passing the record as `story` to the page's resolve.** In draft mode
`resolve` patches the open story's row in every collection that lists it with
`dataOf(doc's root)` and `titleOf(doc, …)` (`runtime.ts:1862-1889`), where `doc` is the
**page's** document. A previewRoot block that lists records of the same type would then
show the record's card carrying the blank layout block's data. **Rejected: a fabricated
`StoryMeta` for the host** (a sentinel id): it would leak into `hopTwo`'s filter, the
`<title>` and any future use of `story`, as an id that names nothing in D1.

### 9. One `previewPage`, not a second render function

The overload above changes no existing call site (`index.tsx`'s three,
`routes/editor.ts`'s two). The synthetic case differs from the stored one in where
`doc` comes from, whether `story` reaches `resolve`, and the title; everything else
(the bundle and stylesheets from `brand.page('preview')`, `previewWrap`, globals,
`previewParamsOf`, the bootstrap, the brand attribute, the `admin` origin) is shared.

**Rejected: a separate `recordRootPage`.** Two assemblies of the same shell drift; the
header of `resolution-merge.ts` names that exact hazard for the resolution, and the
shell, the bootstrap and the bundle selection are three more places for it.

### 10. The preview client does not change

`mount.tsx` already draws `editing.page` from the bootstrap and never builds it. The
synthetic document reaches it the same way a stored page's does, with the same uids,
so hydration matches.

**Rejected: rebuilding the synthetic document on the client from `previewRoot`.**
`blankBlok` mints fresh uids per call, so a client-built page would differ from the
server's markup in every uid, and the client would need the manifest's types in the
preview bundle, which it does not carry.

### 11. Share links and MCP `preview_document` stay as they are

**Share links:** still refused for records at mint (`routes/preview.ts:159-164`) and at
the branch (step 3 of decision 7). A share grant authorises one story at its path; a
synthetic root has no path to authorise, so sharing a record would need a new grant
shape, and nobody has asked for it.

**`preview_document`:** still answers `none` for a record. The tool photographs a
`?_folio=draft` render, and `record` is refused in draft mode for both preview forms
because it names an editing surface that a draft render does not have. Making records
photographable means a draft-mode record render (a new mode decision for the page and
the record) and a new `chooseTarget` branch, and it should cover `previewPath` records
too. That is its own change, not a by-product of this one.

### 12. No migration, no wire change, a minor release

Nothing is stored: the synthetic document lives for one request. The bootstrap is not
a frame (`pages.tsx`'s own comment on `blocks`) and its `editing.page` was already a
`Doc`; no `postMessage` frame changes shape. So `PROTOCOL_VERSION` stays at 5 and there
is no `0020`. `previewRoot` is an optional key on an exported type: a host that does not
declare it gets byte-identical `{base}/api/schema` and `{base}/api/v1/schema` answers.
Additive, so `v1.8.0`.

### 13. The Settings screen says how each record type previews

`previewClause` covers records: `Block “<label>”` for `previewRoot` (the block's label
from the schema, its name if it has none), `/<path>` (or `The site root`) for
`previewPath`, and `Form only` for neither. A host checking its config sees which form
is in force when both are set.

**Rejected: leaving the column blank for records.** Decision 2 makes "both set" a normal
transitional state, and the screen is where a host would look to see which one wins.

### 14. Spec 14's decision 3 is amended in place

`data-documents.md` decision 3 says records get no preview "because there is nothing to
preview". The build adds a dated note under it: superseded in v1.2.0 by `previewPath`
on records (#74) and extended in v1.8.0 by `previewRoot` (this spec); form mode remains
the answer for a record type that declares neither. Implementation note 9 gets the same
pointer. The original text stays, as the record of why.

## Wire and schema changes

### D1

None.

### Core types

`DocumentType` (`src/core/schema.ts`) gains one optional key, after `previewPath`:

```ts
/**
 * A `record` only: the block Folio draws a record's editor preview inside, with no
 * stored page. Folio builds a blank instance of it (field defaults, no preset) and
 * renders it in the record-preview path with `resolution.record` set, exactly as a
 * `previewPath` page is rendered. Must name a block with a `render` in this brand's
 * registry. Wins over `previewPath` when both are set.
 */
previewRoot?: string;
```

Backward compatible with every stored document and log: nothing stored changes.
`Resolution.record`'s doc comment (`resolve.ts:180-186`) and `previewPath`'s
(`schema.ts:108-125`) are updated to name both forms.

### New or changed routes

No new route. `?_folio=preview&record=<id>` on any path outside `{base}` (in practice
`/`) now renders the synthetic host when the record's type declares `previewRoot`.
Auth, refusals and response headers are today's: the draft gate or a preview grant;
handed back for a share cookie, `mode=draft`, `as`, `_folio_id` (previewRoot only), an
unknown id, a non-record, another brand's record, or a record outside the chain;
`Cache-Control: no-store`; `frame-ancestors <admin>` on a preview origin.

## Acceptance criteria

### Construction

```
GIVEN a record type with previewRoot naming a block with a render in its brand
WHEN createFolio runs
THEN it constructs without error
AND the type, with previewRoot, is in GET {base}/api/schema's types

GIVEN previewRoot on a page or a singleton type
WHEN createFolio runs
THEN it throws, naming the type and its kind

GIVEN previewRoot naming a block that is not in the brand's registry
     (including a block only another brand declares)
WHEN createFolio runs
THEN it throws, naming the type and the block

GIVEN previewRoot naming a defineRecord block (no render)
WHEN createFolio runs
THEN it throws, naming the type and the block
```

### The preview

```
GIVEN a record type with previewRoot: 'recordFrame' and a record with a draft edit
WHEN an editor's browser requests /?_folio=preview&record=<id>
THEN the response is 200, no-store, and contains every configured global
AND recordFrame's render output, drawing the record's draft through resolution.record
AND the bootstrap's doc is the record's draft and editing.page is a one-blok doc of type recordFrame
AND the markup carries no data-folio-uid for the frame
AND no row and no Durable Object exists for any host page

GIVEN the same type also declares previewPath: 'authors', and a story lives there
WHEN the same request is made, or /authors?_folio=preview&record=<id>
THEN both render recordFrame, not the authors page

GIVEN the preview is open
WHEN the editor types in the record's form
THEN the frame updates with no network request, as a previewPath record does
```

### Refusals

```
GIVEN a previewRoot record
WHEN the request is ?_folio=draft&record=…, or carries as=…, or _folio_id=…,
     or carries only a share cookie (even one valid for the site's root page)
THEN handle() answers null
AND no view is stamped on any share

GIVEN a record of another brand, an id outside the site's chain, a page id, or an unknown id
WHEN /?_folio=preview&record=<that id> is requested on a site's preview origin
THEN handle() answers null, and no Durable Object is created for the unknown id
```

### Admin

```
GIVEN a record type with previewRoot
WHEN an editor opens one of its records
THEN the editor is not in form mode, and the iframe src is /?_folio=preview&record=<id>
     (single site) or {base}/~<site>/site/start?next=%2F%3F_folio%3Dpreview%26record%3D<id> (multi-site)
AND no GET {base}/api/stories?paths= request is made for a host page

GIVEN the Settings screen's document types
THEN a previewRoot record reads "Block “<label>”", a previewPath record its path,
     and a record with neither "Form only"
```

### Unchanged

```
GIVEN a record type with only previewPath, or with neither
THEN every existing test in record-preview.test.ts, record-mode.test.tsx,
     preview-record.test.ts and preview-record-sites.test.ts passes unmodified
```

## Implementation plan

Phase 1 comes first; phases 2 and 3 depend only on it and touch disjoint files, so they
can run in parallel; phase 4 needs 2 and 3 merged. Every phase leaves the tree green on
`pnpm typecheck`, `./node_modules/.bin/biome ci .` and `pnpm test`.

### Phase 1: the key and its validation

1. `src/core/schema.ts`: add `previewRoot?: string` to `DocumentType` after
   `previewPath` (`:126`), with the doc comment above; rewrite the record paragraph of
   `previewPath`'s comment (`:119-124`) to say `previewRoot` wins when both are set.
2. `src/core/schema.ts` `validateTypes` (`:361`): inside the per-type loop, after the
   `under` check (`:400-406`), throw when `type.previewRoot !== undefined` and
   `type.kind !== 'record'`, then when `schema[type.previewRoot]` is absent. Messages as
   in decision 5.
3. `src/server/runtime.ts` `prepareBrand`: immediately after `validateTypes(types,
   schema)` (`:864`), loop `types` and throw when a `previewRoot` block has no `render`
   in `registry`.
4. Tests: `test/unit/core/document-types.test.ts` gains the four construction cases
   (accepted; refused on a page; refused on a singleton; unknown block). The no-render
   refusal and the per-brand case ("a block only the other brand declares") go in a
   `createFolio` construction test beside the existing brand construction tests (find
   them with `semble search "createFolio throws brand" /Users/brendan/work/personal/folio`).

Checkpoint: `pnpm typecheck` and `pnpm test` green; the manifest carries the key with no
admin change.

### Phase 2: the server render (parallel with phase 3)

1. `src/server/pages.tsx`: add the overload pair from decision 8 and widen the
   implementation's `story` to `StoryMeta | null`. When it is null: build the doc with a
   local helper `syntheticHost(schema, block): Doc` (`blankBlok(schema, block, null,
   null, 'a0')`, wrapped as `{ root, bloks }`); skip `draftFor`; call the page's
   `brand.resolve` without `story`; title from `opts.record.title`. Guard the
   implementation with a thrown `Error` if `story` is null without `root` and `record`
   (unreachable through the overloads; it documents the invariant). Update the
   `opts.record` and `opts.bare` comments (`:166-168`, `:184-191`) and the
   `No host page is configured` note (`:388`) to name `previewRoot` beside `previewPath`.
2. `src/server/index.tsx` `previewBranch` (`:727-922`): reorder per decision 7. Move the
   `record`/`as` parameter reads and the three record refusals above `rt.pathForLocale`
   (`:809`); read `target` once; on `brand.typeOf(target.type)?.previewRoot !== undefined`
   refuse `_folio_id`, then `return previewPage(rt, bindings, null, { root, record:
   target, locale, mode, ...site, ...branded })` where `site` is `{ site: on.render,
   admin: on.admin }` on multi-site (no `overriddenBy`: there is no shadowed page) and
   `{}` otherwise. The later record branch (`:902-919`) uses the held `target`. Rewrite
   the two doc comments (`:886-901`, and the record half of `:822-826`) to describe the
   new order.
3. `src/core/resolve.ts:180-186`: `Resolution.record`'s comment names both forms.
4. Tests, new file `test/workers/preview-record-root.test.ts`, modelled on
   `preview-record.test.ts` (same `bindings`, `fixture` and `call` shape; a `recordFrame`
   block whose render prints `record:<name>` through `resolveReference`; one global so
   "globals stacked" is observable):
   - renders `/?_folio=preview&record=<id>` around the record's draft, with the global,
     `editing.page.bloks[root].type === 'recordFrame'`, no `data-folio-uid` on the frame;
   - with `previewPath: 'authors'` also declared, both `/` and `/authors` render the frame;
   - no Durable Object storage and no `stories` row exist for any host after the render
     (count `stories` rows before and after);
   - refusals: `draft`, `as`, `_folio_id`, share cookie (session-gated twin, and assert
     the share's view count is unchanged), page id, unknown id (no DO created);
   - a `previewParams` declared on `recordFrame` reaches the bootstrap's
     `resolution.params`.
5. `test/workers/preview-record-sites.test.ts`: one case per existing scenario for a
   `previewRoot` type on the branded fixture: in scope and in a group renders; out of
   chain hands back; another brand's record hands back; and the frame block is the gated
   site's brand's.
6. `test/unit/preview/record-mode.test.tsx`: one hydration case where `editing.page` is a
   one-blok synthetic document, asserting no `console.error` and identical
   `#folio-root` markup.

Checkpoint: the four existing record-preview test files pass **unmodified** (they pin
decision 2 and the reordering in decision 7).

### Phase 3: the admin (parallel with phase 2)

1. `src/admin/ui/useStory.ts` `recordPreviewUrl` (`:203-211`): widen the `Pick` to
   `"previewPath" | "previewRoot"` and answer
   `` `/?_folio=preview&record=${encodeURIComponent(id)}` `` first when `previewRoot` is
   set. Update its doc comment ("There is no bare fallback" becomes "no fallback when the
   declared host page is missing").
2. `src/admin/ui/Admin.tsx:679-686`: pass `undefined` to `usePreviewHost` for a record
   type with `previewRoot`, so no host row is fetched. Update `previewFor`'s comment
   (`:1326-1328`).
3. `src/admin/ui/screens/settings-model.ts` `previewClause` (`:217-221`) and the
   `preview` field's comment (`:177-178`): decision 13. `typeRows` passes the schema the
   clause needs for the label.
4. `src/admin/ui/screens/editor-model.ts:662-665`: the `editorLayout` comment names
   `previewRoot` beside `previewPath`.
5. Tests: `test/unit/admin/record-preview.test.ts` gains: the root URL with
   `previewRoot`; `previewRoot` wins with `previewPath` and a host present; the id is
   encoded. `paneSource` with that URL on multi-site yields `site/start?next=` of
   `/?_folio=preview&record=…` and no `_folio_id` (in the existing pane test file;
   locate with `semble search "paneSource site/start" /Users/brendan/work/personal/folio`).
   `test/unit/admin/settings-screen.test.ts` gains the three record clauses.

Checkpoint: `pnpm typecheck`, `pnpm test`.

### Phase 4: demo, documents, ledger

1. `examples/demo/src/index.tsx` (`person` type, `:231-237`): add a `personFrame` block
   to the demo's blocks (a heading, then the person card drawn from
   `resolveReference(resolution.record, resolution, ['person'])`) and
   `previewRoot: 'personFrame'` on `person`. Update the comment above it that says
   records have "no preview — there is nothing to preview". `examples/starter` declares
   no record type and is not changed.
2. `docs/handbook.md:1700-1749`: the record section describes three ways in this order:
   `previewRoot` (with the block example), `previewPath`, neither. Say `previewRoot`
   wins, that `/?_folio=` must reach `folio.handle()` (it does in the documented
   integration), and that the refusals are unchanged.
3. `docs/configuration.md:142`: a `previewRoot` row after `previewPath`; the
   `previewPath` row says `previewRoot` wins on a record.
4. `AGENTS.md:187-205`: lead with `previewRoot`; keep `previewPath` as the form for an
   editable frame.
5. `docs/specs/content-model/data-documents.md`: decision 14's note under decision 3
   (`:68-72`) and implementation note 9 (`:549-551`).
6. `UPGRADING.md`: a new entry `### Record preview without a host page (v1.8.0)`,
   "No action; opt-in per type", with the migration recipe for a host on the
   `previewPath` workaround: declare `previewRoot` on each record type, deploy, then
   delete the hidden page, its type, the router guard and the importer and check steps.
   No migration, no `PROTOCOL_VERSION` bump.
7. `CHANGELOG.md`: a `## 1.8.0` section, "Added".
8. `upgrade-ledger.json`: a `1.8.0` release entry, `migrations: []`, `rollback: "safe"`,
   `headings: ["Record preview without a host page (v1.8.0)"]`, as #183 did for v1.7.0.
   The version bump itself (`package.json`, `FOLIO_VERSION` in `src/server/version.ts`,
   the entry's `date`) follows CLAUDE.md "Releasing" step 1.
9. `docs/specs/README.md`: row 45 in the "After the main line" table and a status line
   under it; this spec's header `Status` moves to `done` with an `## Implementation
   notes` section recording where the plan was wrong.
10. `ROADMAP.md`: nothing to remove (#182 is not listed there).

Checkpoint: `pnpm test` (the ledger test reads `UPGRADING.md` headings, the ledger and
`CHANGELOG.md`), `./node_modules/.bin/biome ci .`, `pnpm build`, and a browser pass on the
demo: open a person, type in its form, see the frame update with the header global above
it.

## Edge cases

- **Both keys set** → `previewRoot`, in the admin (no host fetch) and the server (path
  ignored). Decision 2.
- **A stale tab after a host switches a type to `previewRoot`** loads
  `/authors?_folio=preview&record=…` → the frame renders; the path is ignored (decision 7).
- **A stale tab after a host removes `previewRoot`** loads `/?_folio=preview&record=…` →
  the type now has no `previewRoot`, so the branch falls through to the path lookup and
  renders the record in the context of the root page if one exists, or hands back. This
  is today's behaviour for any record id on any page (Ground truth: the record branch
  does not check `previewPath`), it is editor-only, and the next reload builds the right
  URL.
- **`previewRoot` names the record type's own root block** → allowed, and renders a
  blank instance of it beside the form. Nothing is wrong with the configuration in a
  way construction can see; it is just not useful.
- **The frame block has a `blocks` slot or required fields** → the slot is empty and the
  fields are at their defaults. A required field is a publish-time rule and nothing is
  published.
- **The frame block holds a `collection` field** → the query runs as on any preview,
  marked `stale`, with no draft patch (decision 8).
- **The frame block declares `previewParams`** → they reach the resolution and the
  bootstrap, as for a page (`previewParamsOf` already reads `doc`).
- **The host's router does not pass `/` to `folio.handle()`** → the frame shows whatever
  the host serves at `/`. The documented integration calls `handle()` first
  (`examples/starter/src/index.tsx:151`); the handbook states the requirement.
- **Multi-site, the pane's site has no preview origin** → the existing pane message,
  unchanged.
- **Multi-site, a draft site previewed through a grant** → renders, like any preview on
  that origin; a share cookie alone is refused.
- **A locale other than the source is selected** → the frame stays on the source
  locale's render, as a `previewPath` record's does (decision 6).
- **Two record types share one frame block** → fine; the block reads
  `resolveReference(resolution.record, resolution, ['person', 'post'])` or branches on
  the ref's `type`.

## Testing requirements

**Unit (`test/unit/`):**
- `core/document-types.test.ts`: accepted on a record; refused on a page and a
  singleton; unknown block refused.
- `admin/record-preview.test.ts`: root URL, `previewRoot` wins, encoding.
- the existing `paneSource` tests: the root URL through `site/start`, no `_folio_id`.
- `admin/settings-screen.test.ts`: the three record clauses.
- `preview/record-mode.test.tsx`: hydration with a synthetic one-blok page.

**Workers (`test/workers/`, real workerd):**
- construction: a `defineRecord` frame block refused; a block only another brand
  declares refused.
- `preview-record-root.test.ts` (new): render, both-keys precedence, nothing stored,
  every refusal, `previewParams`.
- `preview-record-sites.test.ts`: chain, group, out-of-chain, other brand, brand's own
  frame block.

**End to end (`scripts/*-test.mjs`):** none. No script covers record preview today, and
the workers tests exercise the real `handle()` in workerd; the browser pass in phase 4
covers the keystroke loop end to end.

## Dependencies

- Spec 14 (data documents) and #74 (record `previewPath`, v1.2.0): the record-preview
  path this reuses.
- Spec 23 (multi-site) and spec 34 (multi-brand): the preview origin, the chain and the
  per-brand registry the branch already enforces.
- No Cloudflare resource, binding or host config change. A host opts in per type.

## Out of scope

- **Share links for records**, decision 11.
- **`preview_document` for records**, decision 11. It should cover both preview forms
  when it is done.
- **Localised record previews**, decision 6. Applies equally to `previewPath`.
- **Static data or a preset in the frame**, decision 3.
- **`previewRoot` on singletons**, decision 4.
- **Removing `previewPath` from records**, decision 2.

## Implementation notes

Built 2026-11-17 on `feat/record-preview-root`, in the four phases the plan lays out. The
decisions all held; what the plan got wrong or left open is small.

1. **`previewClause` had a second caller.** `globalRows` (the Settings screen's globals table)
   calls it with a type and no schema, so the new `schema` argument is optional and defaults to
   empty. Globals are singletons and never read it. The plan named only `typeRows`.
2. **Adding the two record fixtures to `settings-screen.test.ts` moved an existing count.** The
   `settingsView` totals test counted five types; it counts seven now. The plan's "existing
   record-preview tests pass unmodified" covers the four preview files and was kept, but this
   one is a fixture count, not a behaviour.
3. **`previewPage`'s option bag is now a named export, `PreviewPageOpts`.** Two overloads and an
   implementation signature would otherwise have repeated a forty-line inline type three times.
   No call site changes.
4. **`_folio_id` is refused on any presence for a `previewRoot` record, not only on a
   deployment with `sites`.** The plan says "if `_folio_id` is present". Today the parameter is
   read only on a site's preview origin, so on a single-site deployment it is otherwise
   ignored; refusing it there too keeps one rule for a request naming two documents.
5. **The configured global's singleton row is created by the render, and the "nothing stored"
   test says so.** A preview that draws a global creates its `sng_` row on first use (this is today's behaviour for every preview). The
   acceptance criterion "no row for any host page" is what is asserted: the test counts
   `stories` rows excluding that singleton type, and checks that no Durable Object storage
   exists for the synthetic root's uid.
6. **The demo's frame draws from `person.data`, not `person.content`.** `resolveReference`
   answers `{ id, title, path, url, data }` and has no `content` (only a `reference` field's
   resolved value carries it), so `personFrame` builds its own small card from `fullName` and
   `role`. The handbook example does the same.
7. **The frame block carries no marker.** The plan's acceptance criterion "no
   `data-folio-uid` for the frame" holds, but the markup does contain `data-folio-uid` for every
   configured global (they render in `edit` mode as today), so the test asserts on the frame's
   `data-folio-type` rather than the bare attribute.
8. **The browser pass the plan lists for phase 4 was not run.** The workers tests exercise the
   real `handle()` in workerd and the unit test hydrates a synthetic page, but nobody has opened
   a person on the demo and typed. That pass is the owner's before tagging, like 44's.
