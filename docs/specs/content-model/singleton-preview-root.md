# Feature: Singleton preview without a host page (`previewRoot` on globals)

> **Group:** content model
> **Build order:** 46
> **Size:** S
> **Status:** done (built 2026-11-18, v1.8.1)
> **Wire version:** none. `PROTOCOL_VERSION` stays at 5 (decision 7)
> **Migration:** none
> **Release:** v1.8.1 (decision 7)
> **Last updated:** 2026-11-18

## Summary

A global (a `singleton` named in `globals`) is previewed in the editor on a **real
routed page**: its type names a `previewPath`, the admin loads that page's preview with
`&as=<name>`, and the global's draft is the one editable document on it
(`globals.md` decision 4, `src/admin/ui/useStory.ts:183`). For a header or a footer
the page is the wrong context: its hero dominates the frame, and the footer sits a
screen below anything an editor is looking at.

Spec 45 gave `record` types `previewRoot`, a block Folio builds blank per request and
draws in place of a stored page. This spec lets a global declare it too. The page in
the `&as=` render becomes a blank instance of that block; everything else is the
existing `&as=` path unchanged: the same shell, every configured global drawn above
the page, the edited global hydrated into its own wrapper and updated on every
keystroke. The URL is `/?_folio=preview&as=<name>` and the path is never read.

This amends spec 45 decision 4, which refused `previewRoot` on a singleton.

## Ground truth

Verified 2026-11-18 against `origin/main` at `0fbc560` (v1.8.0).

**core:**
- `validateTypes` (`src/core/schema.ts`) refused `previewRoot` on any kind but
  `record`, and checked the block is in the brand's `SchemaIndex`. `prepareBrand`
  (`src/server/runtime.ts`, after `validateTypes`) refuses a block with no `render`
  for any type, so it already covers a singleton once `validateTypes` lets one through.
- `validateGlobals(brand.globals, types)` (`runtime.ts:911`) refuses a `globals` entry
  that is unknown or not a singleton. It does not require a singleton to be a global.

**server:**
- `previewBranch` (`src/server/index.tsx`) answers `as` only after the page at the
  path is found and its share claim is made (`:954`), and only for a singleton of this
  brand that is in `brand.globals`. Anything else is handed back.
- `previewPage(rt, bindings, null, { root, record })` (`src/server/pages.tsx:266`)
  is spec 45's synthetic-host overload. `story` is used for the page's draft, the
  page's `resolve` and the `<title>`; with `null` the page is `syntheticHost(...)`
  (`:143`) and resolves with no story.
- With `opts.as`, `previewPage` reads the edited global from
  `resolution.globals[as]` (`:330`), renders the page in `off` mode (`:362`), draws
  every configured global above it (`:372`), and bootstraps
  `{ doc: <global's draft>, resolution, editing: { global, mount } }`. **The page's
  document is not in the bootstrap.**

**preview:**
- `mount.tsx` hydrates only `editing.mount`, the global's own
  `[data-folio-global]` wrapper, for an `as` preview (`:263`), and merges posted
  resolutions with `globalResolution` (`:127`). The page around it is static markup
  that the client never re-renders.

**admin:**
- `previewFor` (`src/admin/ui/Admin.tsx:1339`) answers a singleton through
  `globalPreviewUrl`, and on a deployment with `sites` answers nothing when no host
  page was found, because the bare `{base}/preview/global/:name` fallback is an
  admin-origin page a cross-origin pane cannot load.
- `usePreviewHost` fetches the `previewPath` row for a singleton, and for a record
  with no `previewRoot`.
- `previewClause` (`screens/settings-model.ts:218`) says `Block “…”` only for a
  record's `previewRoot`.

## User stories

### An editor sees the header as a header
**As** an editor **I want** the header or footer I am editing shown without a page's
hero around it **so that** I am judging the global and not the homepage.

### A host keeps no page for it
**As** a host developer **I want to** name a small layout block for a global's preview
**so that** I need no routed page whose only job is to host a header preview.

## Architecture decisions

### 1. A global names a root block, and the `&as=` path draws it in place of the page

`previewRoot: '<block>'` on a `singleton` type. At preview time Folio builds the same
one-blok document spec 45 does (`syntheticHost`) and hands it to `previewPage` as the
page, with `as` set. Nothing else changes.

**Rejected: a new render path for a global "on its own"** (a frame-only shell without
`as`). It would duplicate the shell, bootstrap and hydration that `as` already gets
right, the hazard spec 45 decision 9 names.

### 2. The branch answers it before the page lookup, and refuses before any read

`previewBranch` checks, after the record branch and before `storyByPath`: `as` names a
singleton of this brand, in `brand.globals`, whose type declares `previewRoot`. Then it
hands back for a share cookie, `mode=draft` or `_folio_id`, and otherwise renders. The
path is never read, so `/`, a stale tab's `/home`, and a host whose root route is not
`/` all render the same thing. `record` beside `as` is already refused by the record
branch above it.

The refusals depend only on configuration (the type and `globals`), never on D1, so a
share cookie never reaches `claimShare` on this path.

**Rejected: moving the existing `as` refusals ahead of the page lookup for every
global.** It would stop a refused share-cookie `as` request on a `previewPath` page
from stamping a view first, which is better, but it changes the behaviour of
singletons that do not opt in, which this release promises not to do.

### 3. The frame is told nothing about the global

The frame block receives its field defaults and the ordinary preview `Resolution`
(globals, site, locale, `previewParams`). It is rendered in `off` mode, never
hydrated, and never re-rendered on a keystroke: only the edited global's wrapper is.
So it is written as a neutral stand-in for a page body.

This is what makes the extension small. A record's frame has to draw the record,
which is why `resolution.record` exists; a global is drawn by Folio itself, in its own
wrapper, so the frame has nothing to draw.

**Rejected: a `resolution.global` key naming the edited global** (spec 45 decision 4's
objection). Nothing would read it: the frame is static, so a frame that drew the
global would draw a copy that does not update while the real one, above it, does.

### 4. Only a configured global; refused at construction otherwise

A singleton that is not in the brand's `globals` cannot be previewed with `&as=` (the
branch hands it back, and its draft is not in `resolution.globals`), so `previewRoot`
on one would be a key that does nothing. `prepareBrand` throws after
`validateGlobals`: `folio: document type '<t>' names previewRoot '<b>', but is not one
of 'globals' …`. `validateTypes` now refuses `previewRoot` on a `page` only; the
unknown-block and no-`render` refusals apply to singletons as they do to records.

**Rejected: accepting it silently**, the silent-misconfiguration class
`validateTypes` exists to refuse.

### 5. The admin builds the root URL, and it wins over `previewPath`

`globalPreviewUrl` answers `/?_folio=preview&as=<name>` when the type declares
`previewRoot`, before it looks at `previewPath` or a host row; `usePreviewHost` does
not fetch a host row for it; and `previewFor` answers it on a deployment with `sites`
too, where `paneSource` sends it through the site's preview origin, as it does a
`previewRoot` record. The Settings screen says `Block “<label>”`.

Both keys set is the ordinary state while a host migrates, so it is accepted and the
root wins, as for records (spec 45 decision 2).

### 6. Globals stay above the frame, in declared order

The frame is the page, so the shell draws every configured global above it, as it
does on any preview in Folio's own shell (`pages.tsx`'s comment on context globals:
"a simplification, not a claim of visual fidelity"). A header and a footer therefore
both appear above the frame. The point of the frame is the absence of a hero, not a
layout.

**Rejected: placing globals around the frame** (header above, footer below). The
shell has no notion of where a global goes; adding one is a new config key for every
global, and the host's real layout is what a live page shows.

### 7. No migration, no wire change, a patch

Nothing is stored. The bootstrap for an `as` preview carries no page document, so it
is byte-identical in shape. A host that declares no `previewRoot` on a singleton gets
identical schema answers. Released as a patch, v1.8.1: it widens a key v1.8.0
introduced, and nothing changes for a host that does not use it.

## Wire and schema changes

None. `DocumentType.previewRoot`'s doc comment names both kinds.
`previewPage`'s no-story overload takes `{ root } & ({ record } | { as })`.

## Acceptance criteria

```
GIVEN a global with previewRoot naming a rendering block, and a draft of it
WHEN an editor's browser requests /?_folio=preview&as=<name> (any path)
THEN the response is 200, no-store, with every configured global, the frame, and the
     global's draft, and no page content
AND the bootstrap is { doc: <global's draft>, resolution, editing: { global, mount } }
AND no stories row is created for a host

GIVEN the same type also declares previewPath
THEN the frame renders and the page at previewPath does not

GIVEN a global with only previewPath
THEN its preview is exactly as before

GIVEN a share cookie, mode=draft, _folio_id, or record beside as
THEN the request is handed back, and a share's view count is unchanged

GIVEN previewRoot on a page, an unknown block, a block with no render, or a singleton
      that is not one of globals
WHEN createFolio runs
THEN it throws, naming the type
```

## Implementation notes

Built 2026-11-18 on `feat/singleton-preview-root`.

- Server: `index.tsx`'s preview branch (the `framed` block after the record branch),
  `pages.tsx`'s overload and title (`Preview · <type label>`). Construction:
  `schema.ts` and `runtime.ts`.
- Admin: `globalPreviewUrl`, `previewFor`, the `usePreviewHost` condition and
  `previewClause`.
- The demo's `header` global moved from `previewPath: ''` to
  `previewRoot: 'chromeFrame'`, a block in `examples/demo/src/blocks/header.tsx`.
- Tests: `test/workers/preview-singleton-root.test.ts` (render, root wins, params,
  a `previewPath` global unchanged, refusals, share view count, construction),
  `preview-singleton-root-sites.test.ts` (per-brand frame and layer on preview
  origins), `multi-brand.test.ts`, and unit cases in `document-types`, `globals`,
  `multi-site-admin` and `settings-screen`. The three refusals were each removed
  to confirm their tests go red.
- No e2e script: spec 45 added none for records, and the `as` client path is
  unchanged.
