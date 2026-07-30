# The UI, screen by screen

> **Status:** plan
> **Written:** 2026-07-30
> **Reads with:** `docs/ui-review.md` (what exists), `docs/design-system.md` (the
> language and the primitives). This document is the product: what the screens
> are, what is on them, and what the editor becomes.
> **Precedes:** the screen ports. The sweep is done when every screen here exists
> and `admin/admin.css` is deleted.

## Summary

`docs/design-system.md` settled the language and listed nine URLs in a code
block. Nine URLs is a sketch. This is the design: eleven screens, what each one
is for, what is on it, how it is navigated, and — the part that matters most — how
the document editor is reshaped, since it is the surface an editor spends the day
in and the one the current three-pane layout serves worst.

Two things drive nearly every decision below.

**The admin is a work queue, not a report.** Folio has no analytics and should not
pretend to. Every screen either shows work that needs doing or shows a thing being
edited. That is what kills the usual CMS dashboard and what makes the home screen
worth having.

**The rendered page is the hero** (`design-system.md`, commitment 2). In the
editor, chrome recedes to hairlines and can be collapsed to nothing. Every other
screen may be as dense as it likes, because the subject there *is* the list.

## The shell

Constant on every screen, including the editor.

**A left sidebar with labels, collapsible to a 48px icon rail**, with the state
remembered. Expanded by default on platform screens; collapsed by default in the
editor, where the preview wants the width.

Rejected: an icon-only rail always. It is 48px cheaper and it reintroduces exactly
the fault the review found in the two bare `↻` buttons — an unlabelled glyph that
a user has to hover to identify. A tool people live in can afford 200px of
orientation.

Rejected: no persistent nav at all, with the palette as the only way between
screens. Tempting, keyboard-pure, and wrong for the same reason a terminal is not
a platform: a person who has just arrived needs to see what the thing contains.
The palette is the fast path, not the only path.

```
┌────────────┬──────────────────────────────────────────────────────┐
│ Folio      │  breadcrumb · state              presence  ⌘K  user  │  40px top bar
├────────────┼──────────────────────────────────────────────────────┤
│ ⌂ Home     │                                                      │
│ ☰ Content  │                                                      │
│ ▤ People   │                  the screen                          │
│ ▤ Offices  │                                                      │
│ ⬚ Assets   │                                                      │
│            │                                                      │
│ GLOBALS    │                                                      │
│ · Header   │                                                      │
│ · Settings │                                                      │
│            │                                                      │
│ ⚙ Model    │                                                      │
│ ↪ Redirects│                                                      │
│ ⚿ Access   │                                                      │
│ ⚙ Settings  │                                                     │
└────────────┴──────────────────────────────────────────────────────┘
```

Three things about that sidebar.

**Document types are named individually, not behind a "Data" tab.** `People` and
`Offices` are what an editor is looking for; "Data" is what a developer called the
category. The manifest already carries every declared type with its label
(`core/schema.ts`'s `DocumentType`), so the nav is generated. Page types stay under
Content, because they live in the tree.

**Globals get their own group and link straight to the document.** There is exactly
one of each by construction — a singleton's id is derived from its type name — so
a list would be a list of one. `FolioConfig.globals` names them, so the nav can
too. This replaces the pill strip pinned above the old rail tabs, which was a third
navigation level competing with the two above it.

**The bottom group is administration** and is role-gated: `Access` for admins,
`Model` where migrations are declared, and both 404 under `auth: 'open'` anyway.
Controls that cannot act are absent, not disabled — the rule the current top bar
already follows for the viewport switcher.

**The top bar** carries a breadcrumb, not a title: `Content / About / Our team`,
each segment a link. That is the answer to the review's finding that a record in
form mode has no way back to the list it came from. To its right: presence
avatars, a search affordance showing `⌘K`, and the user menu. Nothing else — the
per-screen actions belong to the screen.

## The screens

| Screen | URL | What it is for |
| --- | --- | --- |
| Home | `/` | what needs doing, and what you were last doing |
| Content | `/content` | the page tree, full width |
| Documents | `/documents/:type` | one type's records, as a table |
| Assets | `/assets` | the media library, as a place |
| Editor | `/edit/:id` | one document, with its preview |
| Access | `/access` | editors and API tokens |
| Model | `/model` | migrations, and the audit report |
| Redirects | `/redirects` | the redirect table |
| Settings | `/settings` | what this site is configured as |
| Login | `/login` | sign in |
| Design system | `/ui` | the kitchen sink, dev only |

### Home

The screen the review found missing, and the one most likely to be filled with
rubbish. It is a work queue. Four blocks, each of which answers a question an
editor actually asks:

- **Unpublished changes** — every document whose draft differs from what is
  published, with who touched it last and when. This exists nowhere today. The
  data is already there: `unpublished-changes.md`'s watermark pair
  (`draft_sync_id` / `published_sync_id`) is what the tree's `changed` badge is
  computed from, so a site-wide list is the same comparison without the per-story
  filter. This is the single most useful thing the admin could show and it is
  nearly free.
- **Continue editing** — recently touched documents, from `draftUpdatedAt`
  (`core/story.ts:43`).
- **Needs attention** — pending migrations, audit findings, incomplete
  translations. One row each, linking to `Model` or the document. Absent entirely
  when there is nothing wrong, rather than showing a green tick.
- **Who's here** — the space channel's presence, with follow-mode on click.
  Absent when nobody else is.

Rejected: a "welcome to Folio" panel, publish-count charts, a getting-started
checklist. Folio has no analytics binding and a dashboard that reports on itself
is furniture.

### Content

The page tree, given the whole screen instead of 280px. That single change fixes
most of what the review found: the path stops truncating to `/ab…`, the state
badge, last-edited, who-is-editing and translation completeness all fit at once,
and the type chip can be a column rather than a repeated word on every row.

- **Rows are the tree**, indented 16px per level, with expand/collapse. Collapse
  matters now for two reasons rather than one: it is how a large site is navigated,
  and it is what makes lazy per-level loading honest (see *Dependencies*).
- **Columns**: title · slug · type · state · translations · last edited · editing
  now. Slug rather than full path, per `design-system.md` — the indent carries the
  ancestry.
- **Filters** as chips: state, type, locale completeness. Plus the screen's own
  search, which is the palette scoped to pages.
- **Selection and bulk actions**: publish, unpublish, delete across a selection.
  New capability, and worth stating what it is *not* — this is N sequential
  publishes, not an atomic release. "Publish these nine together" is
  `unpublished-changes.md`'s parallel-drafts machinery and stays out of scope.
- **Keyboard**: `↑ ↓` traverse, `→ ←` expand and collapse, `⏎` open, `⌥↑ ⌥↓`
  reorder among siblings, `⌥← ⌥→` change depth. The last two are the answer
  `ROADMAP.md:412-419` asks for: one place at a time, so "between these two
  siblings" never has to be expressed, and each maps to exactly the fractional
  index write a drag already performs.

### Documents

One type's records as a table, which the current `DataTable` already does well —
sticky header, sortable columns from the type's `indexed` fields, a search box.
Three changes:

- It is a **screen**, so the inspector no longer sits beside it describing an
  unrelated page and the migration banner no longer describes a document that is
  not on screen. That was the review's structural complaint about this surface.
- Columns show **published** values, and a row whose draft differs wears the
  `changed` badge. The current footer apologises for blank cells; a badge explains
  them instead. Reading draft values in a list is not cheap — each draft lives in
  its own Durable Object — so this is the honest version rather than the deferred
  one.
- **Row density and columns are per-type**, from `indexed`. Nothing hand-configured
  in the UI, because schema-as-code is the thing that keeps the form, the props and
  the HTML from drifting.

### Assets

New. Today assets are not a place: the library is a `position: fixed` modal
launched from a field, with no search, no filter, no sort, no metadata, no usage
information, and a red **Delete** link under every tile that fires immediately.

The screen: a grid or table (toggled, remembered), filename search, type and size
filters, sort by date or name or size. Selecting one opens a detail panel —
preview, dimensions, bytes, alt text, focal point, and **where it is used**.
Upload by dropping anywhere on the screen. Delete confirms, and the confirmation
names the documents that reference it.

The modal does not disappear: picking an asset for a field is still a modal, and it
is the same grid in a `Dialog` at `wide`. One implementation, two mounts.

### The editor

The important one. Today: a top bar, then `280px | preview | 300px`, with the
280px holding seven tabs that mix document concerns (blocks, history) with site
concerns (redirects, model, access), and two of which cannot be clicked.

```
┌──┬─────────────┬───────────────────────────────────┬──────────────┐
│⌂ │ BLOCKS      │                                   │ Hero         │
│☰ │  Hero       │                                   │ ─────────────│
│▤ │   Button    │                                   │ Heading      │
│▤ │   Button    │      the page, edge to edge       │ [          ] │
│⬚ │  Prose      │                                   │ Body         │
│  │  Pull quote │                                   │ [          ] │
│  │  Image      │                                   │ Image        │
│  │  + Add      │                                   │ [ ▣ ] alt    │
└──┴─────────────┴───────────────────────────────────┴──────────────┘
   48px  240px            flexible, hairline only        340px
```

**The rail holds the block tree and nothing else.** History becomes a slide-over,
and redirects, model and access are screens. Seven tabs become zero.

**The preview is edge to edge.** No card, no shadow, no rounded corners, a hairline
border only. At a narrowed viewport (Tablet, Phone) it centres with `--bg-app`
either side. The frame gains colour only when it has something true to say: an
amber edge while previewing a past version, which the current code already does
and is worth keeping.

**The inspector is 340px and resizable**, up from a fixed 300. Richtext at 300px is
the cramped case, and it gets a real answer rather than more pixels: **focus mode**.
`⌘⏎` in a richtext field, or its expand control, opens that field alone over the
stage at a readable measure. The field keeps its own toolbar, its peer ring and its
source-locale column; nothing about the write path changes. This is the smallest
possible fix for the one field type a 340px column genuinely cannot hold.

**The block picker is a palette, not a list.** `⌘⇧A`, or the `+` in a slot, opens
a searchable picker grouped by category, each entry with its label and its
description. This is the direct answer to the ceiling `ROADMAP.md` names — an
unsorted flat list "stops working somewhere around 15" and the reference project
has 87 — and it costs nothing new, because the manifest already carries labels and
`field-defaults-and-presets.md` already groups presets under their type.

**History is a slide-over** (`⌘H`) from the right, over the inspector, full height:
versions above, activity below, restore and checkpoint in place. A slide-over
rather than a tab because it is a reference surface you consult and dismiss, not
one you co-edit with. Choosing a version still puts the amber frame on the stage
and the comparison in the top bar, exactly as now.

**Presence stays where it works.** Peer rings on fields, avatars in the top bar,
follow-mode on avatar click. The review found nothing wrong with any of it; it
needs restyling, not redesigning.

**Records have no preview**, so the editor becomes a single centred form at a
readable measure with the rail collapsed — close to today's form mode, minus the
240px rail spent on one row. A singleton that is a global keeps its real preview,
via its type's `previewPath`.

**`⌘\` collapses the rail. `⌘.` collapses the inspector.** Both collapsed is the
preview alone, edge to edge, which is the closest this product gets to "look at the
page".

### Access, Model, Redirects, Settings

Each a full screen with room for a table, which is the whole point — the review's
sharpest illustration was user administration rendered in 280px with every email
truncated to `demo@example.…`.

- **Access**: an editors table (name, email, role, last seen, actions) and a tokens
  table (name, scopes, created, last used, revoke). Scope selection becomes a real
  control instead of six 11px checkboxes in two ragged columns.
- **Model**: migrations with their status and the dry-run report, plus **the audit
  panel**, which is where the review's fourth platform gap lands. `GET /folio/audit`
  answers in full across four families — orphan keys, unknown types, missing
  fields, document size — and nothing renders it. Each finding links to the
  document it is about.
- **Redirects**: the table it already is, and the one list route in the codebase
  that already pages properly.
- **Settings** is **a mirror of code, not a form**: locales, globals, document
  types, block types, auth providers, cache configuration — all read-only, each
  showing what the host declared and where. This is deliberate and it is the same
  position `docs/feedback.md` takes on Strapi's schema-in-UI: schema-as-code is what
  keeps the admin form, the prop types and the HTML from drifting, so a screen that
  edited it would be a second source of truth. A read-only mirror is still worth
  building, because "what is this site configured as" is currently only answerable
  by reading someone's Worker.

## Cross-cutting

**Loading.** Skeleton rows, not spinners, everywhere a row height is known — which
is everywhere, since `--row-h` is fixed. A spinner is for an action in flight, and
it belongs in the button that started it.

**Empty.** Every list gets an `EmptyState` with a next step. An empty state with no
action is an error message.

**Errors.** Transient failures are toasts. Persistent conditions are banners in
flow, never overlays — the migration banner is the model, and its comment explains
why: an explanation an editor reads once and carries on past is not an alert.

**Permissions.** Impossible controls are absent; refusable ones explain themselves
before the click. Both rules already exist in the code (`TopBar.tsx`'s `hasPreview`,
`StoryTree`'s `dropRefusal`) and become `Button`'s `reason` prop.

**Locale.** The switcher is in the top bar of the editor only — it is a property of
an editing session, not of the site. Translated fields keep their read-only source
column; shared fields keep their disabled control and label. Both are already right.

**Responsive.** Two breakpoints: below 1100px the inspector becomes an overlay,
below 800px the sidebar does too. There are zero media queries today, so a 1280px
laptop spends the same 580px on rails as a 2560px display.

**Motion.** Two durations, one easing, and a `prefers-reduced-motion` guard stated
once. Slide-overs and the palette animate; rows, badges and menus do not.

## The keyboard map

Complete, because a keyboard-first tool with an undocumented map is not
keyboard-first. `?` shows this.

| | |
| --- | --- |
| `⌘K` | palette: documents, screens, commands |
| `g` then `h c d a m r x s` | go to home, content, documents, assets, model, redirects, access, settings |
| `⌘\` / `⌘.` | collapse the rail / the inspector |
| `⌘H` | history slide-over |
| `⌘⇧A` | add a block |
| `⌘⏎` | focus mode for the field being edited |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| `⌘C` / `⌘V` | copy / paste a block |
| `⌘S` | nothing, and says so |
| `↑ ↓ → ←` | traverse, expand, collapse a list or tree |
| `⌥↑ ⌥↓` / `⌥← ⌥→` | reorder among siblings / change depth |
| `⏎` | open the focused row |
| `Esc` | dismiss the topmost overlay |

Publish has no chord, deliberately (`design-system.md`, Resolved 3).

## Architecture decisions

### 1. Eleven screens, and the editor is one of them

Platform-first, per the owner. The consequence worth stating: **the editor stops
being the application** and becomes a destination with a breadcrumb back out. That
is what lets Access be a table, Assets be a place, and the audit report exist at
all.

**Rejected: keeping the editor as the home and hanging screens off it.** Less
disruptive, and it preserves the thing that made four site-level surfaces into
280px tabs. The review's tab-overflow bug is what that approach looks like after
two years.

### 2. The sidebar is persistent, labelled, and collapsible

**Rejected: a mode switch** — sidebar on platform screens, gone in the editor.
Focus is better achieved by collapsing a persistent thing than by swapping shells,
because the collapse is reversible in one keystroke and does not cost the user
their orientation.

### 3. Document types are top-level nav; "Data" is not a word users need

**Rejected: a `Data` section** containing types, as today. It is the developer's
category name for "documents that are not pages", and an editor looking for the
people list is looking for `People`.

### 4. History is a slide-over; the block tree owns the rail

**Rejected: a segmented control in the inspector** (Fields / History). It is tabs
again, one pane over, and it makes a document-scoped reference surface compete
with the fields you are editing.

### 5. Richtext gets a focus mode rather than a wider inspector

**Rejected: a wider inspector for everyone.** 340px is right for the twenty other
field kinds and wrong for one. Widening for the outlier costs the preview width on
every screen where prose is not being edited.

### 6. Settings mirrors code and cannot edit it

**Rejected: making any of it editable.** Schema-as-code is the property that keeps
four representations of a block in step. A settings form would be a second source
of truth for the one thing that must have exactly one.

### 7. Every list is server-paged, and the UI stops promising page numbers

Consequence of the rule in `ROADMAP.md`, *Next → 1*, and the reason it is sequenced
before the ports: a screen built on an unpaged fetch gets built twice. Page numbers
become next/previous, which over live content was a lie anyway.

## Dependencies

What this needs that does not exist. Each is named in `ROADMAP.md` and none is UI
work:

1. **Pagination on every list route** — audited, and the prerequisite for Content,
   Documents, Assets, Access and Model. Also the thing that makes the tree load per
   level rather than whole.
2. **`GET {base}/search`** — the palette, and every screen's own search box.
3. **`GET {base}/stories?ids=`** — so the editor can resolve the link targets in the
   open document without fetching every story. `storiesFor(db, ids, paths)` already
   does the work server-side.
4. **Asset usage counts** — for the Assets detail panel and a safe delete. Wants
   asset keys in `content_refs`.
5. **A site-wide unpublished-changes query** — for the home screen. The watermark
   comparison already exists per story.
6. **The audit route rendered** — `GET /folio/audit` answers today and nothing draws
   it.

## The port plan

Each phase is committable, leaves the tree green, and deletes the components and
CSS it replaces. Order is least-coupled first, so the shell is proven before it
reaches the surface with sync, presence and preview in it.

1. **Shell** — sidebar, top bar, breadcrumb, router, palette, shortcut map. No
   screen content yet; every route renders a stub.
2. **Content** — the tree as a screen, with keyboard traversal and reorder. Retires
   `StoryTree.tsx` and turns Biome's a11y rules back on.
3. **Documents** — the table as a screen. Retires `DataList.tsx`, `DataTable.tsx`.
4. **Assets** — the new screen, and the picker as one `Dialog` mount of it. Retires
   the library half of `AssetInput.tsx`.
5. **Access, Model, Redirects, Settings** — four tables and the audit panel.
6. **Home** — last of the platform screens, because it links to all of them.
7. **The editor** — rail, inspector, preview, history slide-over, block picker,
   focus mode. The largest phase and the one that benefits most from primitives
   already proven five times over.
8. **Deletion** — `admin/admin.css` is gone, `admin/ui/` is the only styling, and
   `docs/ui-review.md`'s counts are all zero.

Acceptance for every phase: the screen is reachable by URL, linkable in the state
it is in, fully keyboard-operable, correct in both themes, and paged if it is a
list.

## Open questions

1. **Does the sidebar list every document type, or does it collapse past a
   threshold?** Fine at the demo's four. A site with twenty record types wants a
   grouped or scrolling section, and the honest answer is probably "list them until
   there are more than about eight, then group".
2. **Does Home earn its place?** It is the screen most likely to be built and then
   bypassed in favour of `⌘K`. My view is that the unpublished-changes list alone
   justifies it, since nothing else in the product answers "what is sitting
   unpublished across this site" — but it is the one screen I would cut if the
   answer is no.
3. **Bulk actions on Content: how far?** Publish, unpublish and delete are
   straightforward as N sequential writes. Bulk *move* is a tree operation with
   fractional indices and cycle checks, and probably wants its own thinking.
