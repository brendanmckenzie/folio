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

**The admin is for working, not for reporting.** Folio has no analytics binding and
should not pretend to have one. Every screen either gets you to a thing or shows a
thing being edited — which is what kills the metrics-and-charts dashboard, and
what the survey below confirms every comparable product concluded too.

**The rendered page is the hero** (`design-system.md`, commitment 2). In the
editor, chrome recedes to hairlines and can be collapsed to nothing. Every other
screen may be as dense as it likes, because the subject there *is* the list.

## What comparable products actually do

Checked 2026-07-30, because two decisions below were being made from first
principles when there was evidence available. Both changed as a result.

**Home screens.** Every one of them converges on the same three things — recency,
counts, and quick access — and **not one leads with a work queue.**

| Product | What its home shows by default |
| --- | --- |
| [Storyblok](https://www.storyblok.com/docs/editor-guides/dashboard) | Entity counts against plan limits; an Activity panel with team/content changes, *my last edits*, assigned-to-me and mentions; traffic and AI-credit consumption; a two-week content-activity timeline |
| [Strapi 5](https://docs.strapi.io/cms/admin-panel-customization/homepage) | Six widgets: *last edited entries*, *last published entries*, profile, draft/published counts, project statistics, deploy button |
| [Payload](https://payloadcms.com/docs/custom-components/dashboard) | Cards for every collection and global, and that is the only built-in widget |
| [Sanity](https://www.sanity.io/docs/studio/dashboard) | Dashboard is an opt-in plugin; its primary widget is a document list, typically ordered by `_updatedAt` — recently edited, or newest |
| [WordPress](https://wordpress.org/documentation/article/dashboard-screen/) | At a Glance (counts, each a link), Activity (scheduled, recently published, recent comments), Quick Draft, news |
| [Contentful](https://www.contentful.com/developers/docs/extensibility/app-framework/locations/) | The Home tab is an app *location* — largely something you replace rather than a rich default |

Two absences are as informative as the pattern. **Nobody surfaces "everything with
unpublished changes" on the home screen**, and the closest analogues — Storyblok's
assigned-to-me and mentions — are workflow features, which is a thing Folio does
not have. And **nobody shows recently uploaded media** either, which makes it a
cheap point of difference rather than an omission to copy.

**Bulk actions from a content list.** Table stakes, and more generous than I had
assumed:

| Product | Bulk actions offered |
| --- | --- |
| [Contentful](https://www.contentful.com/help/content-and-entries/managing-multiple-entries/) | Publish, Unpublish, Delete, Archive, Duplicate, Add to release, Add/remove tags, Export CSV. Header checkbox selects the page; the API batches up to 200 as one asynchronous job |
| [Storyblok](https://www.storyblok.com/docs/manuals/stories) | **Move** — select stories, choose Move, open the destination folder, confirm — plus Tag and Settings |
| [Strapi 5](https://docs.strapi.io/user-docs/content-manager/saving-and-publishing-content) | Publish, Unpublish, Delete. Locale-scoped when i18n is on |
| [Payload](https://payloadcms.com/posts/blog/launch-week-day-3-bulk-operations) | Edit (choosing which fields to set), Delete, Publish, Unpublish — with **select-all-matching-the-current-filter**, one request, and a count of how many succeeded and how many failed |
| [WordPress](https://wordpress.org/documentation/article/dashboard-screen/) | Edit (a panel setting status, author, categories, tags) and Move to Trash |

The finding that matters: **bulk move is an ordinary feature**, and Storyblok's flow
is exactly the one I had called out as needing its own thinking. It does not. Its
UI is "choose a destination, confirm"; fractional indices and cycle checks are our
implementation's problem and have no business shaping what the screen offers.

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

**Past about eight types the list groups rather than scrolls.** A flat list of
twenty is a wall, and the answer both Payload and Strapi reached is grouping:
Payload takes an optional `admin.group` per collection, Strapi separates collection
types from single types. Folio's version is schema-as-code like everything else — an
optional `group?: string` on `DocumentType`, so a host organises its own nav in the
same file it declares the type. With no groups declared and more than eight types,
they fall under one collapsible **Documents** heading whose state is remembered.
Under eight, flat, because a heading over four items is ceremony.

Grouping rather than hiding, deliberately: a type that is not on screen has to be
*findable*, and the palette is the fast path, not a substitute for knowing the site
has an Offices type at all.

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

**Recency and quick access, which is what every comparable product's home screen
actually is.** An earlier draft of this document made it a work queue led by
"everything with unpublished changes"; the survey above found that nobody does
that, and it was a wrong answer arrived at confidently. Five blocks:

- **Quick access** — one card per document type, plus globals and assets, each with
  a count and a create action. This is Payload's entire default dashboard and
  WordPress's At a Glance, and it does double duty: it is the fastest route to
  anything, and it is how somebody new learns what the site contains. The manifest
  already carries every type and its label, so it is generated rather than
  configured.
- **Latest changes** — recently edited documents across every type, with who and
  when. Storyblok's *my last edits*, Strapi's *last edited entries*, Sanity's
  document list ordered by `_updatedAt`. Reads `draftUpdatedAt`
  (`core/story.ts:43`), which exists.
- **Latest published** — recent publishes, with who and when. Strapi's *last
  published entries*, WordPress's Activity panel. Cheap and exact: the `versions`
  table already holds one row per publish with its actor and timestamp, so this is
  a site-wide query over data written for another purpose.
- **Latest media** — the newest uploads as thumbnails. The one block nobody else
  has by default, and nearly free: `listAssets` is already ordered by `created_at`
  descending. A CMS that treats assets as a first-class place should show them.
- **Needs attention** — pending migrations and audit findings, one row each,
  linking to `Model` or to the document. **Absent entirely when there is nothing
  wrong** — no green tick, no "all clear" panel.

**Unpublished changes are not gone, they moved to where you would act on them:** a
`state: changed` filter chip on Content. That is the KISS version — the capability
survives, the dedicated block does not, and filtering a list is how the rest of the
world does it.

Rejected, with reasons rather than taste. **Charts, traffic and consumption
metrics** (Storyblok): Folio has no analytics binding and inventing one to fill a
panel is the definition of furniture. **Assigned to me, mentions, workflow states**
(Storyblok): there is no workflow or assignment model in Folio, and this is the one
thing that would make a dashboard genuinely sticky if one ever appears — worth
remembering as the reason to revisit. **Profile and project-statistics widgets**
(Strapi): who you are belongs in the user menu, and a statistics panel about the
tool is not work. **A welcome panel or getting-started checklist**: this is a tool
for the person who built the site.

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
- **Selection and bulk actions**: **Publish · Unpublish · Duplicate · Move ·
  Delete.** See decision 7 — the set is what the survey found to be table stakes,
  including Move, which Storyblok treats as ordinary and I had wrongly called hard.
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

Past eight they group, via an optional `group?: string` on `DocumentType` —
Payload's `admin.group` by another name, and consistent with every other thing in
this product being declared in code. **Rejected: hiding the overflow behind "more"**,
which makes the existence of a type undiscoverable and leaves the palette as the
only route to it.

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

### 7. Bulk actions are Publish, Unpublish, Duplicate, Move and Delete

Five, and the set comes from what the survey found rather than from what is easy.
Publish, Unpublish and Delete are in every product checked. Duplicate is
Contentful's, and Folio already has single-document duplicate
(`duplicate-and-paste.md`), so the bulk case is the same call in a loop. Move is
Storyblok's, and it is the one I had this wrong about.

**Move was previously deferred here on the grounds that it is "a tree operation
with fractional indices and cycle checks".** That is an implementation concern
dressed up as a product decision. What a user needs is to pick a destination and
confirm; the existing `PATCH /stories/:id { parentId, index }` and
`StoryTree`'s `dropRefusal` already encode every rule that applies, so the bulk
version is per-item calls with refusals reported rather than a new mechanism.

Two mechanics adopted from Payload because they are what make bulk useful rather
than decorative:

- **Select-all-matching-the-filter**, not just select-all-on-this-page. With
  server-side paging, "select the 340 pages matching this filter" must not require
  loading 340 *rows*.
- **Report successes and failures with counts**, and name the failures. Nothing here
  is atomic and the UI should not imply it is: N sequential writes, each of which can
  be individually refused by role or by a tree rule. Contentful's API offers an
  all-or-nothing batch; Folio has no equivalent and pretending otherwise would be
  the lie.

### 7a. A selection is a set of ids, and it survives a filter change

**A selection persists across filtering, sorting and paging**, and there are **two
kinds of it**. The distinction is what makes both the persistence and the scale
work, and getting to it took two wrong turns — first a live filter expression, then
a materialised id list.

**Explicit selection** — somebody ticked rows. That is a set of ids, and it is small
by construction: you can only tick what you can see, a page at a time. Nothing
clever required.

**Select-all-matching** — a **flag**, the filter conditions **captured at the moment
it was clicked**, an **expected count**, and any rows ticked off afterwards as
exclusions. No ids are materialised at all, so "select all 51,420 matching" is the
same amount of data as "select all 12 matching", and the ceiling question disappears
rather than getting an arbitrary answer.

```
{ all: true, filter: { state: 'draft' }, expected: 51420, exclude: ['sty_x', 'sty_y'] }
```

**The count is the safety mechanism, checked server-side.** The backend re-runs the
captured filter, compares its count to `expected`, and only then executes. A
mismatch means the world moved between the number a person read and the button they
pressed — somebody else published, or a colleague deleted a draft — so the operation
is refused rather than silently applied to a different set than the one that was
agreed to. Optimistic concurrency, with the count as the version.

A refusal has to be a door, not a wall: it comes back with the *new* count and
re-confirming is one click. On a busy site with a `state: draft` filter this will
fire regularly, which is the point — the alternative is a bulk publish quietly
including nine pages nobody looked at.

**Both kinds capture rather than track.** That is what satisfies "a selection
survives a filter change": the filter in a select-all is a snapshot, not a live read
of whatever the UI's filter chips currently say. Change the visible filter and the
selection still means what it meant when it was made.

**Which forces the display to name the mode, not just a number.** "51,420 selected"
is meaningless without *matching what*, and this is where a selection stops being a
trap:

- **A selection bar** appears on first selection and stays put through filtering,
  sorting, paging and scrolling. Count, the five actions, Clear.
- **It states the mode and the split.** Explicit: *"12 selected · 3 shown here"*.
  Select-all: *"All 51,420 matching state is draft · 20 shown here"*, with the
  captured conditions written out rather than implied. And *"none match this
  filter"* when that is the truth, because a bar reading "12 selected" over a list
  showing nothing selected reads as broken software.
- **"Show only selected"** is a toggle in the bar — one click to see exactly what is
  selected regardless of the visible filter. For a select-all that means switching
  the view to the captured conditions. This is the recovery path, and it answers the
  question rather than warning about it.
- **Confirmations name the invisible part**: *"Publish 12 pages? 9 are not shown by
  the current filter."* Acting on more than you can see is the hazard, so that is
  where it gets said.

**Execution over 51,420 documents is a batched job, not a request.** A Worker has a
CPU limit and the codebase has already met this problem twice: `runMigrations` and
`reindex` are both explicit, batched, and resumable by a `continueFrom` cursor,
with comments saying why. Bulk actions take the same shape. The count is validated
**once, at the start of the job** — re-checking per batch would make a long job
un-completable on any site with live editors, and the guard's purpose is to confirm
intent, not to freeze the database.

**Selection is not in the URL**, and it is the one deliberate exception to "if a
person can see it, they can link to it". Three hundred ids in a query string is not a
link anybody wants, and a selection is a gesture rather than a place. It lives with
the screen and clears on leaving it — like an open menu or an unsent palette query.

**Rejected: bulk field editing** (Payload's Edit, WordPress's Bulk Edit panel).
Genuinely powerful, and the machinery exists — a field set across N documents is
what `schema-migrations.md`'s runner already does. Out of the first pass because it
is a second editing surface with its own validation and preview problems, not
because it is hard. Named so it is a decision.

**Rejected: archive, tags, releases, CSV export.** Folio has none of the underlying
concepts, and `docs/feedback.md` already parks archive and releases with reasons.

### 8. Every list is server-paged, and the UI stops promising page numbers

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
5. **Two site-wide recency queries** — most recently edited documents
   (`draftUpdatedAt`) and most recent publishes (`versions` rows of kind `publish`,
   which already carry actor and timestamp). Both for Home, both over data written
   for other reasons.
6. **The audit route rendered** — `GET /folio/audit` answers today and nothing draws
   it.
7. **Bulk write endpoints** taking `{ all, filter, expected, exclude }` or a plain
   id list, validating the count before executing, and batching with a `continueFrom`
   cursor the way `runMigrations` and `reindex` already do (decision 7a). Plus **a
   count for a filter**, which every list header wants anyway.

A note on ordering: 1 and 7 are the same conversation. The filter shape the
pagination spec settles is the shape a captured selection serialises, and the count
it needs for a header is the same count that guards a bulk write.

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

## Resolved

The three questions this document opened with, answered 2026-07-30. Two of them by
going and looking at what other products do, which is recorded above.

1. **The sidebar groups past about eight types**, via an optional `group?: string`
   on `DocumentType`. Grouped, not hidden — see decision 3.
2. **Home is recency and quick access**, not a work queue led by unpublished
   changes. The survey found nobody does the latter, and the block I had been
   most confident about became a filter chip on Content instead.
3. **Bulk actions are Publish, Unpublish, Duplicate, Move and Delete** — decision 7.
   Move is in, and the reasoning that had excluded it was our implementation's
   problem rather than the user's.

4. **A selection survives a filter change**, and says so loudly — decision 7a. The
   one question every product checked was silent on. Answering it "keep it" rather
   than "clear it" forced the shape: a selection *captures* its conditions instead of
   tracking them, and select-all is a flag plus a captured filter plus an expected
   count rather than a list of ids — which is what lets it be 51,420 items without
   the question of a ceiling arising at all.

## Open questions

1. **Does `group` on `DocumentType` want to also order the sidebar?** A declared
   group implies an order, and alphabetical-within-group is a guess. Probably wants
   declaration order, like the palette's groups.
2. **Does a refused bulk job report what it would have done?** A count mismatch
   says the set changed but not how. Showing the difference costs a second query and
   might be worth it for a destructive action; for publish it is probably noise.
