# Feature: Globals — content that is not a page but is on every page

> **Group:** content model
> **Build order:** 9
> **Size:** S
> **Status:** done
> **Wire version:** none (the preview *bootstrap* shape changes; the postMessage protocol does not)
> **Migration:** none — uses `type` from `../foundation/document-types.md`
> **Last updated:** 2026-07-29

## Summary

A header, a footer, and a bag of site-wide settings are content: an editor needs to
change the footer's phone number without a deploy. They are also not pages: they
have no URL, they are not in the tree, and there is exactly one of each.

Today the only way to express one is a story with a `reference` field pointed at it
from every page, which puts the site's structure in the hands of whoever remembers
to wire it up, and lets two pages point at different headers by accident.

A global is therefore a **singleton document** — the third `kind` in
`../foundation/document-types.md` — plus two things that spec deliberately left
out: a way for a host's shell to render one, and a way to edit one in the editor
when it has no page of its own to be previewed in.

## Ground truth

**server (`packages/folio/src/server/`):**
- `createRuntime`'s `resolve(bindings, doc, { draft })` (`runtime.ts:104-127`) does
  exactly two D1 reads: `listStories` for the story map, and — only when the
  document actually has `reference` fields pointing somewhere —
  `publishedDocsByIds(db, ids)` (or per-id `draft()` in preview mode). Globals can
  ride on that second query for free by adding their ids to it.
- `publishedDocsByIds(db, ids)` (`stories.ts`) is one `where id in (…)`, returns
  `Record<storyId, Doc>`, and silently omits ids with nothing published.
- `Resolution` (`core/resolve.ts`) already carries `docs?: Record<string, Doc>` for
  references, and is passed to the renderer alongside the document precisely
  because the preview re-renders per keystroke with no network in the loop.
- `previewPage(rt, bindings, story)` (`pages.tsx`) renders the story's draft,
  bootstraps `__FOLIO__ = { doc, resolution }`, and answers the story's *own*
  public URL with `?_folio=preview` on it. **An unrouted document has no such
  URL**, so a singleton cannot be previewed by this route at all.
- `folio.handle()` returns `null` for a preview request whose path has no story, so
  the host's routes win (`index.tsx`).

**preview (`packages/folio/src/preview/`):**
- `mountPreview(blocks)` (`mount.tsx`) hydrates exactly one element,
  `#folio-root`, with `window.__FOLIO__.doc`, and holds one document in React
  state. `apply` / `replace` / `resolve` / `select` frames all act on that one
  document.
- `attachBridge()` installs delegated `click` and `mouseover` listeners on
  `document`, keyed off `[data-folio-uid]` — so anything rendered anywhere in the
  page, including outside `#folio-root`, is already clickable and hoverable if it
  carries the marker attributes `RenderBlok` injects in edit mode.

**demo (`examples/demo/src/index.tsx`):**
- The host owns its `<Shell>` and places `folio.render(doc, { resolution })` inside
  its own `<div id="folio-root">`. Page metadata is read off the root block by the
  host. This is the integration surface globals have to fit into.

## Owner decision checkpoints

1. **A global is a singleton document, not a new primitive (recommended).** It gets
   drafts, multiplayer, versions, activity, publish and undo for free, and an
   editor edits a footer with the same inspector they edit a page with. The
   alternative — a key/value table — would need every one of those built again, and
   would not let a footer contain blocks.
2. **The host places globals in its own shell (recommended).** `folio.renderGlobal
   (resolution, 'header')` returns a node; where it goes is the host's business,
   because the host owns its markup, its CSS and its `<Shell>`. The alternative —
   Folio wrapping the page in a layout — would mean Folio owning the document
   outline, which it deliberately does not.
3. **One editable document at a time (recommended).** In the page preview, globals
   render read-only from their drafts; clicking one offers "Edit header →" and
   switches the editor to the header. The alternative — editing the header inline
   from a page — needs the admin to hold several sockets and stores at once and the
   preview to route mutations per document, which is a much bigger change than this
   feature is worth. Cost: two clicks to fix a footer typo while looking at a page.
4. **No template interpolation (recommended).** `{{ settings.phone }}` inside a
   text field is not part of this. See *Out of scope* for why.

## User stories

### Editor changes the footer once
**As** an editor **I want to** edit the footer in one place **so that** the change
appears on every page without me opening thirty of them.

### Editor sees the header they are editing in context
**As** an editor **I want** the header editor to show the header sitting on top of a
real page **so that** I am not editing a floating fragment on a white background.

### Editor previews a global before it goes out
**As** an editor **I want** an unpublished footer change to appear in the preview
of any page but on no live page **so that** I can check it in context and publish
it deliberately.

### Developer reads settings on the server
**As** a developer **I want** `folio.global(env, 'settings')` **so that** my
Worker can read the site's analytics id or its contact email without inventing a
config file.

## Architecture decisions

### 1. Globals are declared in the config, and loaded with the same query references use

```ts
const folio = createFolio<Env>({
  blocks,
  types: [
    { name: 'page',     label: 'Page',     kind: 'page',      root: 'page' },
    { name: 'header',   label: 'Header',   kind: 'singleton', root: 'headerRoot' },
    { name: 'footer',   label: 'Footer',   kind: 'singleton', root: 'footerRoot' },
    { name: 'settings', label: 'Settings', kind: 'singleton', root: 'settingsRoot' },
  ],
  // Loaded into every Resolution, so any page render can place them.
  globals: ['header', 'footer', 'settings'],
})
```

`globals` is a subset of the `singleton` types — a singleton not listed is still a
document, it is just not fetched on every page render (a "SEO defaults" singleton
read once by the host at boot has no business in a per-request resolution).

`resolve()` adds `sng_<type>` for each listed global to the id set it already
passes to `publishedDocsByIds`, so **a site with globals costs no extra D1 query**.
The docs land in `Resolution.globals`, keyed by type name rather than by story id,
because a caller says `'header'` and should not have to know the id convention.

### 2. `Resolution.globals` is separate from `Resolution.docs`

They are populated by the same query and they are still two fields:

```ts
export interface Resolution {
  stories: Record<string, StoryRef>
  assetBase: string
  docs?: Record<string, Doc>                  // reference targets, by story id
  globals?: Record<string, Doc>               // globals, by type name
}
```

Merging them would make `RenderBlok`'s reference-bounding rule wrong. That rule
empties `docs` on the way down so a story referencing itself renders once
(`Render.tsx`); a global must survive that emptying, because a header rendered
inside a referenced document still needs its own content. Two fields, one query,
different lifetimes.

### 3. `renderGlobal` emits a stable wrapper, in both modes

```tsx
<Shell …>
  {folio.renderGlobal(resolution, 'header')}
  <div id="folio-root">{folio.render(doc, { resolution })}</div>
  {folio.renderGlobal(resolution, 'footer')}
</Shell>
```

It returns `<div data-folio-global="header">…</div>` — the same wrapper on a
published page and in a preview. Identical markup in both modes is not tidiness:
the preview client hydrates, and a wrapper that exists in one mode and not the
other is a hydration mismatch waiting for the first person to notice their header
flickering.

A missing global (nothing published yet) renders nothing, in both modes. A block
inside a global gets its `data-folio-uid` marker in edit mode exactly as it does
anywhere else, which is why the delegated listeners in `attachBridge` already make
it clickable with no change.

### 4. A singleton is previewed inside a host page

A singleton has no URL, so it cannot be previewed by the route that answers
`/<path>?_folio=preview`. Each singleton therefore declares where to be seen:

```ts
{ name: 'header', label: 'Header', kind: 'singleton', root: 'headerRoot',
  previewPath: '' }     // '' is the root story: the homepage
```

The admin loads `/<previewPath>?_folio=preview&as=header`. That request resolves
the host page as normal, renders the header from **its own draft**, and bootstraps

```ts
window.__FOLIO__ = { doc, resolution, editing: { global: 'header', mount: '[data-folio-global="header"]' } }
```

`mountPreview` reads `editing`: with it, the document it holds in state and applies
mutations to is the *global's* document, hydrated into the named wrapper, and the
host page around it stays server-rendered static markup. Without it, behaviour is
exactly as today.

`__FOLIO__` is a bootstrap between two halves of one deploy (`Bootstrap` in
`server/Document.tsx` writes it, `mount.tsx` reads it), not a wire between a
client and a persisted log, so this needs no `PROTOCOL_VERSION` bump. The
postMessage protocol is untouched: there is still exactly one editable document on
screen, and every `apply`/`replace` frame means it.

A singleton with no `previewPath` gets a bare preview: the global rendered on its
own, on the host's stylesheet, with a note that no host page was configured. Not
pretty, but never broken.

### 5. Publishing a global is publishing a document

No special case. `publish()` snapshots the singleton's draft into its own
`published_doc` and writes a version, so a footer has history, restore and an
activity trail like everything else. Every page picks it up on its next render,
because pages read globals per request from `published_doc`.

That last sentence is only true while there is no cache in front of D1. When one
lands (`ROADMAP.md` → *Cache invalidation on publish*), publishing a global has to
purge **every** page rather than one, and that is the one place globals cost more
than a page. Recorded here so it is not discovered later: the purge key for a page
must include the globals it rendered.

**Since built:** `platform/caching.md` (spec 17) closes this, but not with a purge-key
scheme — a render tags its page `global:<name>` and a publish purges by tag, so no
reverse index is needed.

### 6. "Variables" are a settings singleton with ordinary fields

The want in `docs/feedback.md` reads *global "variables" — i.e. for
headers/footers*, and the parenthetical is the whole of it: the need is content
shared across pages, which is decisions 1–5. A `settings` singleton whose root
block has `phone`, `email`, `abn` and a `multilink` to the privacy policy covers
the rest, and blocks read them the way anything reads a global.

What is *not* here is string interpolation — a text field containing
`{{ settings.phone }}` that the renderer substitutes. See *Out of scope*.

## Wire & schema changes

### D1

None. A global is a `singleton` row created by `ensureSingleton`
(`../foundation/document-types.md`).

### Core types

- `Resolution.globals?: Record<string, Doc>` (decision 2).
- `DocumentType.previewPath?: string` for singletons.

### Server API

```ts
interface Folio<Env> {
  // …existing…
  /** Published document for a global, or null. */
  global: (env: Env, name: string) => Promise<Doc | null>
  /** A global, rendered. Null when nothing is published for it. */
  renderGlobal: (resolution: Resolution, name: string, opts?: { edit?: boolean }) => ReactNode
}
```

`FolioConfig.globals?: readonly string[]`, validated at construction: every name
must be a declared `singleton` type.

### Routes

- `GET /<previewPath>?_folio=preview&as=<singleton>` — handled by the existing
  `handle()` preview branch, which gains the `as` parameter. An `as` naming
  something that is not a global returns `null` (host routes win), the same
  refusal shape the branch already uses for an unknown path.
- `GET /folio/edit/:id` already serves the admin for any story id, so a singleton's
  editor screen needs no new route.

## Acceptance criteria

### A global renders on every published page
```
GIVEN a published header singleton and two published pages
WHEN either page is requested
THEN the header's blocks appear in the response
AND the response still contains no <script> (globals do not change the zero-JS rule)
AND the page cost one D1 read for the story map and one for documents, not three
```

### Preview shows a global's draft, the live site does not
```
GIVEN a header whose draft differs from its published document
WHEN an editor previews any page
THEN the draft header renders
AND WHEN the same page is requested publicly
    THEN the published header renders
```

### Editing a global in context
```
GIVEN a header singleton with previewPath ''
WHEN an editor opens it in the admin
THEN the iframe loads the root story's page with ?_folio=preview&as=header
AND the header on that page is the editable document: clicking a block in it
    selects that block in the inspector, and typing updates it per keystroke
AND the rest of the page around it is static and not clickable
```

### A page preview does not let you edit the header inline
```
GIVEN an editor previewing an ordinary page
WHEN they click a block inside the header
THEN the inspector offers "Edit header →" rather than selecting the block
AND nothing about the page's own document changes
```

### Globals have history like anything else
```
GIVEN a footer published twice and checkpointed once
WHEN the editor opens its History tab
THEN three versions are listed, the newest publish can be previewed read-only,
     and restoring it lands as one ordinary transaction
```

### Nothing published yet
```
GIVEN a header singleton whose document has never been published
WHEN a page is requested publicly
THEN renderGlobal returns nothing, the page renders without a header, and no
     error is thrown
```

### Configuration mistakes fail at construction
```
GIVEN globals: ['heder'] with no such type
WHEN createFolio is called
THEN it throws naming the unknown global, before any request is served
```

## Implementation plan

### Phase 1 — resolution and rendering

1. `core/resolve.ts`: `Resolution.globals`; leave `docs` and the one-level bound
   alone.
2. `server/runtime.ts`: `resolve()` adds `sng_<name>` for each configured global to
   the id set, then splits the result into `docs` and `globals`. Preview mode reads
   drafts for globals too, via the same `draft()` path references use.
3. `server/index.tsx`: `folio.global`, `folio.renderGlobal`.
4. `server/types.ts`: `FolioConfig.globals`, validated in `createRuntime`.
5. Tests: `test/unit/core/resolve.test.ts` (globals split, empty when absent);
   `test/workers/app.test.ts` (query count, published vs draft, missing global).

### Phase 2 — previewing a singleton

1. `server/pages.tsx`: `previewPage` takes an optional `as` global, bootstraps
   `editing`, and renders the host page for `previewPath`.
2. `server/index.tsx`'s `handle()`: read `as`, look up the singleton, refuse
   unknown names by returning `null`.
3. `preview/mount.tsx`: read `__FOLIO__.editing`; hydrate the named wrapper with
   the global's document; leave `#folio-root` static in that mode.
4. `admin`: opening a singleton points the iframe at its `previewPath` URL; the
   store connects to the singleton's own socket, unchanged.
5. Tests: `test/unit/admin/preview-bridge.test.ts` for the editing-target
   bootstrap; a workers test that `?_folio=preview&as=nope` yields null.

### Phase 3 — admin surface

1. A **Globals** section in the left rail, listing the configured globals, above or
   beside the page tree. Selecting one opens it like a story.
2. "Edit header →" affordance when a block inside a global is clicked in an
   ordinary page preview (the bridge already delivers the uid; the admin looks it
   up in the resolution's globals to decide which global it belongs to).
3. `History.tsx`'s root-blok label reads the type's label, so a footer's root is
   "Footer settings", not "Page settings" (already in
   `../foundation/document-types.md` phase 3; verify it covers singletons).

### Phase 4 — docs

1. `README.md`: a Globals section, and the mount snippet showing `renderGlobal`.
2. `PARITY.md`: Phase 2's *Singletons* item.
3. `ROADMAP.md`: *Singleton / config documents* out of *Uncovered*; add the cache
   purge note from decision 5 to the cache item.

## Edge cases

- **A global's document contains a `reference`** → resolution is bounded to one
  level and `docs` is emptied on the way down, so a header referencing a story
  renders that story's content but no deeper. Same rule as anywhere else.
- **A global referencing another global** → allowed and free: `globals` is not
  emptied on the way down, so a footer can render the settings singleton's phone
  number. A cycle is impossible to render infinitely because a global's render is
  not recursive through `globals` — a block reads values, it does not re-enter
  `renderGlobal`. If a block *does* call `renderGlobal` on itself, that is a block
  bug, and it is the same bug shape a block calling itself already has.
- **`previewPath` pointing at a story that has since been deleted** → the preview
  request 404s at the host, so the admin shows the iframe's own error. Detectable
  and fixable in config; not worth a fallback that silently previews a different
  page.
- **Two editors, one editing the header, one editing a page that renders it** → the
  page editor sees the header as it was when their preview loaded. Live propagation
  across stories is `../editing/live-collaboration.md`; until then the page editor
  reloading the preview picks it up.
- **A singleton row deleted directly in D1** → `ensureSingleton` recreates it empty
  on the next access; the Durable Object still holds the old draft and
  `getOrInit` returns it, so the content comes back too. Deliberately forgiving:
  the row is a pointer, the document is the content.
- **A global listed in `globals` but of `kind: 'page'`** → refused at construction.
- **`renderGlobal` called with `edit: true` on a published page** → the caller's
  bug, and it would leak `data-folio-uid` markers. The demo's shell never passes
  it; `folio.render` has the same shape and the same exposure today.

## Testing requirements

**Unit:** the `docs`/`globals` split and its behaviour under `RenderBlok`'s
one-level bound; `renderGlobal` with a missing, empty and populated global.

**Workers:** page render query count with and without globals; published vs draft
resolution for globals; `as=` refusals; construction-time validation.

**End to end (`scripts/globals-test.mjs`, new):** publish a header, assert it
appears on two pages and in neither page's `<script>` (there is none); edit the
header draft, assert both page previews show the draft and both live pages do not;
publish it and assert both live pages update; restore an old header version and
assert it lands as one transaction.

## Dependencies

- `../foundation/document-types.md` for `kind: 'singleton'`, `ensureSingleton`, the
  `sng_<type>` id rule and the per-type root block. This spec is unimplementable
  without it and adds nothing to it.
- No new Cloudflare resources or bindings.

## Out of scope

- **Template interpolation** (`{{ settings.phone }}` inside a text or richtext
  field). It needs a template language, an escaping rule per field kind, a story
  for what happens when the variable is missing, and — in richtext — a node type
  and an editor affordance for inserting one. It also breaks the property that a
  stored value is the rendered value, which is what makes the preview, the diff,
  the activity trail and search over content all straightforward. A block that
  needs the phone number reads it from the settings global instead.
- **Datasources / key-value lists** (Storyblok's `datasource_id`, listed in
  `PARITY.md` Phase 2). A list of countries for a `select` is a schema
  concern, not content, until something proves otherwise.
- **Per-locale globals.** Covered by `localisation.md` for free: a global is a
  document, and field-level locales are a document feature.
- **Editing a global inline from a page preview** (checkpoint 3).
- **Cache purge on global publish.** Needs the cache layer that does not exist yet;
  the requirement is recorded in decision 5. **Since built:** `platform/caching.md`
  (spec 17) tags each render `global:<name>` and purges by tag instead — no
  purge-key scheme, no reverse index.

## Open questions

- ~~Should `globals` default to *every* declared singleton rather than an
  explicit list?~~ Resolved by the owner: explicit. `FolioConfig.globals` is a
  list of type names, validated at construction against the declared
  `singleton` types (`validateGlobals`, `core/schema.ts`). A singleton not
  listed is unaffected — it is still a document, browsable in the Data rail
  and readable via `folio.global(env, name)` — it is just not fetched on
  every page render. In practice the demo lists two of its own singletons
  (`header`, `settings`) and nothing suggests every singleton would end up
  listed, so the explicit list is not just cheaper here, it is doing real
  work: `settings`'s footer content and `header`'s nav are both globals, but
  a hypothetical "SEO defaults" singleton read once at boot would not be.

## Implementation notes

**Landed as specced**, across three phases matching the plan above, plus a
fourth for docs and the demo:

- `Resolution.globals?: Record<string, Doc>`, populated by `resolve()`
  alongside `docs` from the *same* `publishedDocsByIds` call (published mode)
  or per-id `draftFor` calls (preview mode) — one extra D1 read for a whole
  site's globals, not one per global, and zero extra reads for a live page
  with no references and no globals configured. Preview mode additionally
  calls `ensureSingleton` for each configured global before reading its
  draft; the published path deliberately does not, so a global nobody has
  ever opened in the admin costs nothing on a live page render.
- `renderGlobalNode` (`preview/Render.tsx`) is the one function behind both
  `Folio.renderGlobal` and Folio's own internal preview page, so the
  `data-folio-global="<name>"` wrapper is identical markup wherever a global
  appears. `folio.global(env, name)` is a plain by-name read, independent of
  `FolioConfig.globals` membership, for the "read once at boot" case the
  spec calls out.
- `DocumentType.previewPath` (`''` for the root story) plus
  `?_folio=preview&as=<name>` on that page's own preview URL is what lets a
  singleton preview in the context of a real page. `previewPage` gained an
  optional `as`/`bare` pair of options: `as` bootstraps
  `{ editing: { global, mount } }` and renders the host page's own document
  static (no edit markers); `bare` (the new `{base}/preview/global/:name`
  route, for a singleton with no `previewPath`) renders the singleton alone
  with a note. Every configured global still renders read-only alongside
  either mode, with the ordinary edit markers, which is what makes "Edit
  `<name>` →" reachable from an *ordinary* page preview too.
- The admin: a Globals section above the rail's tabs (`GlobalsList.tsx`,
  `globalTypes`/`globalPreviewUrl`, both pure and unit-tested); opening one
  points its iframe at the computed preview URL; `usePreviewBridge`'s
  `select` handler runs the new pure `globalOwning` first and calls
  `onGlobalClick` instead of `store.select` when a clicked uid belongs to a
  global rather than the open document; `Inspector` shows "Edit `<name>` →"
  in that case. `useGlobalDocs` fetches each configured global's own
  document once (never per keystroke) purely so `globalOwning` has a uid set
  to check against.
- The demo declares a second singleton, `header` (logo + nav), alongside the
  existing `settings` (which already rendered a `<footer>` but was never
  called from anywhere until now), lists both in `globals`, and wraps
  `#folio-root` with `folio.renderGlobal` calls in its own `<Page>` — header
  above, footer below, a decision the *host* makes, not Folio.

**What the spec's Ground truth got right, and where it was silent:** the
Ground truth section's read of `resolve()`, `publishedDocsByIds` and
`previewPage` was accurate as of build order 8 landing; nothing had moved.
The one thing the spec did not spell out and this build had to decide:
Folio's own internal preview shell has no knowledge of a host's real
layout, so it draws every configured global above `#folio-root`, in
declared order, rather than trying to infer header-above/footer-below —
documented as a known simplification of Folio's *generic* preview, not a
claim that it visually mirrors the host's own render.

**Deferred, on purpose:**

- Live propagation of a header edit into another open page's preview — spec
  16 (live collaboration) hydrates globals read-only and refreshes them on a
  space-channel event. Until then, `useGlobalDocs`'s fetch-once cache is
  correct for detecting *which* global a uid belongs to (a uid never changes
  when only a field's value does) but does not refresh a passively-rendered
  global's *content* live; reopening the preview picks it up, same as any
  other cross-story staleness today.
- Cache purge on global publish (decision 5) — there is no cache layer yet
  at all (`ROADMAP.md`); the requirement that a page's purge key include the
  globals it rendered is recorded there for when one lands. **Since built:**
  `platform/caching.md` (spec 17) tags each render `global:<name>` and purges
  by tag instead — no purge-key scheme, no reverse index.
- Template interpolation, datasources, per-locale globals — all out of scope
  as written.

**Test counts added:** 27 unit/workers tests (9 workers: query count,
published-vs-draft resolution, `as=` refusals, the bare preview route,
`folio.global`, construction-time validation; 5 for `renderGlobalNode`; 5 for
`globalOwning`; 8 for `globalTypes`/`globalPreviewUrl`; 1 pinning that
`Resolution.globals` survives the one-level reference bound) plus
`scripts/globals-test.mjs` (16 checks, run live against a fresh database):
publish a header onto two pages from one D1 read; a page's preview shows the
header's draft while its live render still shows the last publish;
publishing updates every live page at once; restoring an older version lands
as one minimal transaction. `fields-test.mjs` and `history-test.mjs` /
`redirects-test.mjs` / `sync-test.mjs` were re-run live and still pass
(107/41/8/16), `fields-test.mjs`'s manifest assertion updated for the demo's
fifth document type.
