# Port phase 7: the editor

> **Status:** plan
> **Reads with:** `docs/ui-architecture.md`'s `### The editor` section, which is the
> design. This file is how it gets built without one agent having to hold all of it.
> **Written:** 2026-07-31, while phases 4 and 5 were in flight.

## Why this needs its own plan

Phase 7 is the largest phase and the only one where the new screen has to meet
machinery that already works and must not regress: the sync engine, presence, the
preview bridge, undo, publish, versions and the migration banner. Every other screen
in this port was a list over a paged route. This one is the surface an editor spends
the day in, and `ui-architecture.md` calls the current three-pane layout the thing it
serves worst.

The temptation is to split it four ways and merge. That is wrong: the rail, the
inspector and the preview share one store and one selection, so four agents would
produce four views of the same state that disagree at the seams. The split below is
by **what does not share state** instead.

## What already exists and must not be rebuilt

None of this is UI. All of it is reusable as-is, and the port is a *view* change:

- `admin/store.ts` — `StoryStore`, the socket, the mutation log, undo/redo.
- `admin/hooks/useBlocks.ts` — add, move, remove, duplicate, copy/paste.
- `admin/hooks/usePreviewBridge.ts` — the postMessage seam to the iframe.
- `admin/hooks/useSpace.ts` — cross-story presence and live tree events.
- `admin/hooks/useVersions.ts` / `useVersionsList.ts` — versions, activity, viewing
  a past version, restore. **Already reads `Page<T>` for both** as of port phase 3.
- `admin/hooks/usePublish.ts`, `usePublishedDoc.ts`, `useMigrations.ts`.
- `admin/Inspector.tsx` and every `*Input.tsx` — the field controls. These are the
  most valuable code in the old admin and the most expensive to rewrite. **Port
  their styling, not their logic.**

`admin/Editor.tsx` is the composition to replace. Read it as a *dependency graph*
rather than a layout: it is already hooks plus three sibling panes, which is why the
layout is a class and a conditional rather than a rewrite.

## The split

Three pieces, ordered, because each later one needs the earlier one's seam.

### 7a — the shell and the rail (one agent, then reviewed)

The layout, and the block tree in it.

```
┌──┬─────────────┬───────────────────────────────────┬──────────────┐
│⌂ │ BLOCKS      │                                   │ Hero         │
│☰ │  Hero       │      the page, edge to edge       │ Heading      │
│▤ │   Button    │                                   │ [          ] │
└──┴─────────────┴───────────────────────────────────┴──────────────┘
   48px  240px            flexible, hairline only        340px
```

- **The rail holds the block tree and nothing else.** Seven tabs become zero:
  History is a slide-over (7c), and Redirects, Model and Access are screens that
  already exist as of phase 5.
- **The preview is edge to edge** — no card, no shadow, no rounded corners, a
  hairline border only. At a narrowed viewport it centres with `--bg-app` either
  side. The amber frame while previewing a past version stays; it is the one time
  the frame has something true to say.
- **`⌘\` collapses the rail, `⌘.` the inspector.** Both already wired in the shell's
  `useShortcuts` — read `Prototype.tsx`.
- **The inspector is 340px and resizable**, up from a fixed 300.
- **A record has no preview**: a single centred form at a readable measure with the
  rail collapsed. A singleton that is a global keeps its real preview via its type's
  `previewPath`.

### 7b — the inspector, and richtext focus mode

- Port `Inspector.tsx` and the field inputs onto `admin/ui/` primitives and tokens.
  Their *logic* — validation, locale columns, peer rings, the disabled control on a
  shared field — is correct and stays.
- **Focus mode** is the answer to richtext at 340px, and it is the whole reason the
  inspector is not simply made wider (`ui-architecture.md` decision 5): `⌘⏎` in a
  richtext field, or its expand control, opens that field alone over the stage at a
  readable measure. It keeps its own toolbar, its peer ring and its source-locale
  column, and **nothing about the write path changes.**

### 7c — the history slide-over and the block picker

The two pieces that share no state with the panes around them, which is why they are
last and why they can be built against a seam rather than inside it.

- **History is a slide-over** (`⌘H`) from the right, over the inspector, full height:
  versions above, activity below, restore and checkpoint in place. A slide-over
  because it is a reference surface you consult and dismiss, not one you co-edit
  with. Choosing a version still puts the amber frame on the stage.
- **The block picker is a palette, not a list.** `⌘⇧A`, or the `+` in a slot, opens a
  searchable picker grouped by category, each entry with its label and description.
  This is the direct answer to the ceiling `ROADMAP.md` names — an unsorted flat list
  "stops working somewhere around 15" and the reference project has 87 — and it costs
  nothing new: the manifest already carries labels, and
  `field-defaults-and-presets.md` already groups presets under their type.
  `admin/ui/Palette.tsx` and `rank.ts` already exist and already rank; this is a
  second mount of them, not a second implementation.

## The keyboard map this owes

From `ui-architecture.md`, and `?` shows it:

| | |
| --- | --- |
| `⌘\` / `⌘.` | collapse the rail / the inspector |
| `⌘H` | history slide-over |
| `⌘⇧A` | add a block |
| `⌘⏎` | focus mode for the field being edited |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| `⌘C` / `⌘V` | copy / paste a block |
| `⌘S` | nothing, and says so |

Publish has no chord, deliberately.

## What "done" means

The acceptance every phase in this port shares: reachable by URL, linkable in the
state it is in, fully keyboard-operable, correct in both themes, and paged if it is a
list. Plus one this phase adds, because it is the phase that can break something
silently: **every `scripts/*-test.mjs` still runs green**, and `sync-test`,
`space-test`, `history-test`, `i18n-test` and `fields-test` in particular, because
they drive the socket, presence, versions, locales and every field type through the
routes this screen consumes.
