# The admin as it stands: a UI review

> **Status:** done (this document is the review, not a plan)
> **Reviewed:** 2026-07-30, at commit `aefdf99`
> **Covers:** everything under `packages/folio/src/admin/` plus the two
> server-rendered pages in `packages/folio/src/server/pages.tsx`
> **Next:** a design system plan, then a spec for the sweep. `docs/feedback.md`
> asks for the review first and this is it.

## Summary

The admin is **one screen**. `main.tsx` mounts `Editor` and nothing else; there is
no router and no second destination. Seven surfaces — the content tree, data
documents, the block tree, history, redirects, content migrations and access
control — are tabs in a **fixed 280px rail** designed around a block tree, while
the widest region on screen is permanently a page preview.

That is the finding the sweep turns on, and it is an information-architecture
problem before it is a visual one. Four of those seven tabs are *site*-level
surfaces that do not belong beside a document's block list at all. One of them,
Access, is a user table rendered in a column so narrow that every email address
is truncated to `demo@example.…`. Two of them cannot be clicked, because the tab
strip needs 464px of the 280px it has.

The visual layer has a related but separable problem: seven design tokens exist
and 51 distinct hex literals are hardcoded around them. There is no spacing
scale, no type scale, no dark mode, and no component primitives — five dialogs
duplicate one overlay, five menus duplicate one popover, four list views
duplicate one row.

The keyboard story is the smallest and most surprising gap. Folio already has the
half of "Linear-esque" that is hard: local-first optimistic state, so every edit
lands instantly. What it does not have is any of the half that is cheap. The
entire admin binds four shortcuts (undo, redo, copy, paste). There is no command
palette, no navigation shortcut, no keyboard tree traversal, and the content
tree's rows are `<div onClick>` with no role and no `tabIndex`.

## Scope, and what this is not

This is an audit of what exists. It deliberately does not propose a design, name
a token scale, or lay out a new IA — those belong to the design system plan,
which this document is written to constrain. Where it is obvious what the answer
has to be, it says so and moves on.

It also separates two things that are easy to conflate: **the sweep** (a
redesign, XL, wants a design system first) and **defects** (nine of them, listed
below, all fixable now and independently). Several of the defects will be
invisible after a redesign, which is an argument for fixing them now rather than
folding them in — a redesign that quietly repairs a date bug teaches nobody where
the date bug was.

## Method

Both halves, because neither alone is enough.

**Read:** every file under `admin/` (13k lines including a 2,544-line stylesheet),
plus `server/pages.tsx`, plus `ROADMAP.md`'s outstanding a11y and UI bullets.

**Ran:** the demo, reset and reseeded (`examples/demo/seed.sql` then
`scripts/seed-demo.mjs`), plus five `person` records created through
`POST /folio/api/v1/documents` so the Data table had rows. Signed in as
`demo@example.com` and drove every rail, the block picker, the media library, a
confirmation dialog, form mode and the login page in Chrome at two window widths
(1600 and 2100 CSS px). Layout numbers below were measured in the page, not
inferred from CSS. Screenshots are in the session scratchpad; they are not
committed, since nothing else in `docs/` carries images.

The demo config is the right fixture for this: three page types, two record
types, two singletons, two locales, two globals and two declared migrations
(`examples/demo/src/index.tsx:37-143`), so every conditional surface in the admin
is present at once. A pages-only site hides four of the seven tabs and hides the
tab overflow with them.

## Ground truth

### Shell and layout (`admin/`)

- **`main.tsx:135-143`** renders `<App>` → `<Editor>`. No router, no routes, no
  second screen. The only URL that varies is `/folio/edit/:storyId`, and the rail
  a user was on is not in it, so nothing about the admin's state is linkable or
  restorable.
- **`Editor.tsx:75`** — `type Rail = 'content' | 'data' | 'blocks' | 'history' |
  'redirects' | 'model' | 'access'`. One `useState` decides which of seven
  panels the left column shows (`Editor.tsx:93`, panels at `:664-753`).
- **`admin.css:66-71`** — `.editor__body` is
  `grid-template-columns: 280px minmax(0, 1fr) 300px`. Both rails are fixed; only
  the stage flexes. There is **no media query anywhere in the stylesheet** (zero
  occurrences of `@media`), so the layout is identical at 1280px and 2560px and
  the two rails are the same width in both.
- **`admin.css:2121-2127`** — form mode (a record or singleton, which has no page
  to preview) drops to `280px minmax(0, 1fr)` and centres the inspector inside a
  46rem column. The rail stays, showing one row.
- **`admin.css:998-1021`** — the media library is `position: fixed` markup
  rendered **inside the asset field's own subtree** (verified in the page: the
  overlay's parent is `.asset`). It works today because nothing above it
  establishes a containing block, which is a property of the current CSS rather
  than a guarantee.

### Navigation

- **`Editor.tsx:598-662`, `admin.css:1330-1345`** — the tab strip. Measured in
  Chrome with all seven tabs present: `scrollWidth` **464px** inside a
  `clientWidth` of **279px**, `overflow: visible`. The last three tabs render
  outside the rail and are painted over by the stage. `Redirects` is cut
  mid-word; **`Model` and `Access` cannot be clicked at all** — a click at their
  coordinates lands in the preview iframe, which is how I first discovered this
  (it selected a block belonging to the Header global instead). Because the rail
  is a fixed 280px, this is unconditional: no window size fixes it. They remain
  in the tab order, so keyboard focus can move to a button nobody can see.
- **`GlobalsList.tsx`, `admin.css:1292-1319`** — configured globals are pills
  pinned *above* the tab strip, so the rail has two stacked navigation levels
  before its content, and the globals level is present on every tab including the
  ones where it is irrelevant.
- **Only one search input exists in the whole admin**: `DataTable.tsx:223-226`,
  client-side, over one document type at a time. There is no search over content,
  no search over blocks, no search over assets, and no way to find a page by name.
- Truncation without search: `StoryTree.tsx:556` caps a tree level at
  `LEVEL_LIMIT = 50` and offers "Show all N" (`admin.css:602`);
  `DataTable.tsx:28` pages at 20 rows; `listAssets` is capped server-side at 200
  with no filter (`ROADMAP.md`). Each is a reasonable cap and none of them has a
  way to *look for* the thing that is now hidden.
- **The block picker** (`BlockTree.tsx:208` says so in a comment) is a flat,
  unsorted, unsearchable list rendered inline at the insertion point. On the demo
  it is ~20 entries and already requires scrolling the rail to see the options
  after clicking "+ Add block". `ROADMAP.md` puts its ceiling at about 15 and the
  reference project at 87 block types.

### The visual system (`admin/admin.css`)

- **`:root` declares seven tokens** (`admin.css:1-10`): `--bg`, `--panel`,
  `--line`, `--text`, `--muted`, `--accent`, `--danger`, plus
  `color-scheme: light`.
- **51 distinct hex literals appear 105 times** past those tokens. The repeated
  ones are doing real work and want names: `#f0f2f5` (row hover, 6 places),
  `#e6f2ff` + `#b8dcff` (selected row, 5 places), `#fafbfc` (inset card),
  `#f2f4f6` (secondary button fill), and at least eight distinct amber pairs for
  warning states (`#fff8e1`, `#fff8e6`, `#fffaf0`, `#fff6e5`, `#fffbe6`,
  `#fdf3d7`, `#fdf3f3`, `#fff0f0`).
- **Three tokens are referenced but never declared** — `--bg-soft` (4 uses),
  `--ok` (1), `--fg` (1). Every reference carries a fallback, so the fallback
  *is* the value and the token is decoration. (`--peer` and `--depth` are
  legitimate: both are set inline from React, at `Inspector.tsx:332` and
  `BlockTree.tsx:86`.)
- **No type scale:** 13 distinct `font-size` values, mixing units —
  `0.625/0.6875/0.75/0.8125/0.875/0.9375/1rem`, then `11px`, `12px`, `13px`,
  `14px`, and one `0.9em`. The px values are all in the two newest panels
  (`.access`, `.user-menu`), which is drift in the direction you would predict.
- **No spacing scale:** 56 distinct `padding` declarations. Values are tuned per
  component (`0.15rem 0.4rem`, `0.25rem 0.4rem`, `0.3rem 0.4rem`,
  `0.35rem 0.45rem`, `0.4rem 0.5rem`, …), so no two panels are aligned by
  construction.
- **No radius scale:** ten values (`3/4/5/6/7/8/10px`, `50%`, `999px`, `0`).
- **No primitives.** Five overlay namespaces (`.library` `:998`, `.unpublish`
  `:1090`, `.delete-story` `:1146`, `.duplicate-story` `:1199`, `.discard`
  `:1248`) each carry their own copy of the same overlay/scrim/panel CSS — seven
  `place-items: center` containers and eight `__scrim` rules in the stylesheet.
  There are six dialogs for those five namespaces, because `PublishDialog.tsx:73`
  renders itself as `.discard`: the absence of a primitive has already produced a
  dialog wearing another dialog's name. Five popovers (publish menu, user menu, "who's here", block picker,
  type picker) each hand-roll a scrim, a z-index and an outside-click button.
  Four list views (`.stories__`, `.tree__`, `.data__`, `.datatable__`)
  independently implement hover, selected and actions-on-hover. Badges are
  reinvented five times (`.stories__badge`, `.stories__chip`,
  `.redirects__badge`, `.migrations__badge`, `.stories__i18n`).
  `ROADMAP.md` already names the dialog case and says a seventh dialog is the
  trigger for a `<Modal>`; the count is five plus the media library, so the
  trigger has effectively arrived.
- **Two design systems already exist.** `server/pages.tsx:151-168` gives the
  login and error pages their own inline stylesheet, for a good documented reason
  (`:186-189`: the admin CSS is a hashed Vite asset, and a page that must render
  when the build is broken cannot depend on it). The consequence is five tokens
  restated as near-misses: `#f6f6f7` vs `--bg: #f6f7f9`, `#e3e3e6` vs
  `--line: #e3e6ea`, `#111` vs `--text: #1a1d23`, `#666` vs `--muted: #6b7280`,
  and a **black** primary button against the admin's **blue** one. Whatever the
  token layer becomes, it has to be inlinable into a static page or these two
  surfaces will keep drifting.

### Keyboard and accessibility

- **Four global shortcuts, total.** `useUndoShortcut.ts` (Cmd+Z, Shift+Cmd+Z) and
  `useClipboardShortcuts.ts` (Cmd+C, Cmd+V). Nothing else. No command palette, no
  `g`-prefixed navigation, no pane or rail cycling, no shortcut for publish,
  preview or search.
- **`StoryTree.tsx:355-357`** — a content tree row is
  `<div className="stories__row" onClick={…}>`: no `role`, no `tabIndex`, no key
  handler. The tree is unreachable by keyboard and structureless to a screen
  reader. `ROADMAP.md:412-419` carries this as the last open a11y item and
  correctly calls keyboard reordering a UI question before an a11y one.
- **Two `:focus-visible` rules in 2,544 lines** (`admin.css:508`, `:924`), both
  on text inputs. Buttons inherit the UA ring, which is the only reason focus is
  visible at all; nothing in the admin's own styling expresses a focus state.
- What is *done* and should not be re-litigated: `hooks/useFocusTrap.ts` is the
  single focus trap and all six dialogs use it; the toast is a permanently
  mounted `role="status"` live region (`Editor.tsx:488`). Both carry comments
  explaining why. Biome's a11y rules are deliberately off in `biome.json` until
  the tree is fixed.
- No `prefers-reduced-motion` handling. There is exactly one transition
  (`admin.css:419`), so this is cheap to keep true rather than a real gap today.

## Screen by screen

### 1. The editor shell

The top bar packs the wordmark, the current path, a connection dot, publish state,
a locale select, three viewport buttons, presence avatars, undo/redo, "View live",
a split Publish button, a transient "Published" flash and the user menu into one
row with three flex groups. It works, and it is the densest thing in the product
with no visual grouping to help: brand, document identity, connection health and
publish state are four different kinds of information sharing one cluster.

One detail worth naming because it reads as a mistake rather than a choice: the
path uses `--muted` in a monospace face (`.topbar__slug`), and in form mode that
slot holds a *record's title* instead (`TopBar.tsx:160`), so "Ada Lovelace" is
rendered in the URL font.

### 2. Content tree

Rows are title + type chip + path + state badge, in 280px. At the demo's depth
the path column truncates to `/ab…` and `/sho…`, which is worse than absent — it
occupies the width without carrying the information. The type chip says "Page" on
every row of a mostly-pages site. Depth is 10px per level (`admin.css:295`), so a
child and its parent are nearly indistinguishable. There is no collapse, no
count, no filter and no search. The drag handle is deliberately the only
draggable part, with a good comment explaining why (`StoryTree.tsx:359-362`).

Badges are the strongest thing here: `draft`, `not live`, `unpublished changes`
each get their own colour and each is documented against the spec that introduced
it. They are also the clearest evidence for a shared token set — three states in
three hand-picked palettes.

### 3. Data (rail) and the document table

The rail lists types with counts and a `ONE` marker for singletons; picking one
opens a real table in the stage. The table is the best-designed surface in the
admin: sticky header, sortable columns from the type's `indexed` fields, a search
box, 20-row pages, a footer that explains why cells are blank.

Two problems, one shallow and one structural. The shallow one: the search input
is the browser default, square-cornered against every other rounded control,
because `.datatable__search` sets width and nothing else. The structural one: the
inspector on the right keeps showing **the previously open page's** Address and
page settings while the stage shows a table of people, and the migration banner
above it still describes that page. Three panes, two unrelated subjects. The
table is a site-level view living in a document-level layout.

### 4. Block tree and the picker

Fifteen rows of bold name + muted summary, no icons, no grouping, no collapse.
Summaries truncate at roughly twenty characters, which is where two `Button` rows
become indistinguishable from each other and two `Embedded page` rows likewise
(`Referenc…`, `Referenc…`). The nesting indent is the same 10px as the content
tree, so `Feature` inside `Feature grid` barely reads as inside it.

The picker is the flat list described above, rendered inline so it pushes the tree
and lands below the fold. It mixes structural blocks (`Section`, `Prose`) with
data-bound ones (`Person card`, `Insight list`) with nothing distinguishing them.

### 5. History

Versions above, activity below, both in the rail. Two things:
`History.tsx:80` renders `v.actor` — the raw id, `usr_demoadmin1` — while
`:114` renders `entry.actorName ?? entry.actor` for activity, so the same person
appears as an opaque id in one list and "Demo Admin" in the list immediately
beneath it. And an activity entry summarises to "Changed Page settings · Title
+18 more", which is honest but is also the whole of what happened to a page,
collapsed into one line with nothing to expand.

### 6. Redirects, Model, Access

These three are the argument for the sweep, so they deserve stating plainly.

**Access** (`Access.tsx`, screenshot at 280px) is user administration: three
editors with name, email, role select, last-seen and Remove, then an invite form,
then API tokens with a name, scopes as six 11px checkboxes in two ragged columns,
last-used and Revoke. Every email is truncated. Every "last seen" is truncated to
`— last seen 30/…`. It is a table's worth of data in a column built for a block
list, sitting beside 1,100px of preview iframe showing a page that has nothing to
do with who may edit the site.

**Model** (`Migrations.tsx`) fares better because a migration list is genuinely
narrow: two amber cards, "3 documents behind the latest model", Preview and Run.
Its refresh control is a bare `↻` glyph with no label, the same unlabelled glyph
History uses.

**Redirects** is the tab that is cut mid-word, which is a fitting summary.

### 7. The media library

A modal grid of tiles with filename beneath. No search, no type filter, no sort,
no dimensions or size, no usage information, no folders, and no indication that
the list is capped at 200. It is reachable only from an asset field, so assets are
not a place in this product; they are a picker.

Under every tile, permanently visible, is a red **Delete** link one pixel-hop from
the tile you click to select the image (`AssetInput.tsx:528-534`). See defect 2.

### 8. Form mode, dialogs, login

**Form mode** centres a 46rem form in the stage's place and keeps the rail, which
then shows a single row (`Person settings`). There is no breadcrumb and no way
back to the list you came from other than the Data tab again — a record does not
know it belongs to a collection of records.

**Dialogs** are small (420px), clear, and correctly focus-trapped. Their weakness
is action hierarchy: `Cancel` and `Delete` are both plain white buttons, the
destructive one distinguished only by red text, so the two read as equal weight.

**Login** is a clean card, and is styled by a different system (see Ground truth).

## Read as a platform, not an editor

What `docs/feedback.md:82-84` asks for. Absent today, in the order I would argue
for them:

1. **A place that is not a document.** Every site-level surface is currently a
   tab in a document editor. Access, Redirects, Model, the Data tables and the
   audit report are all "about the site", and the editor's three-column layout
   can only express "about this document".
2. **Search.** One client-side box over one type is the whole of it. A platform
   is navigated by search; a keyboard-first platform is navigated by a palette
   that also runs commands. This is the single highest-leverage addition, and it
   is what would make the tree's 50-row cap and the picker's flat list stop
   mattering.
3. **Assets as a destination**, with search, filter, dimensions, and usage counts.
   `ROADMAP.md` already notes usage counts want asset keys in `content_refs`.
4. **The audit panel.** `GET /folio/audit` answers in full across four families
   (orphan keys, unknown types, missing fields, document size) and nothing renders
   it. `ROADMAP.md` makes the case: the report shape is stable, which is the
   argument for building the panel.
5. **Linkable state.** No rail, no selected block, no locale and no version
   preview is in the URL, so nothing in the admin can be sent to a colleague and
   nothing survives a reload.
6. **Keyboard parity.** Enumerated above. The palette is the entry point; tree
   traversal and reorder are the hard remainder, and `ROADMAP.md` is right that
   "between these two siblings, with no pointer" is a design question.
7. **Dark mode.** Not vanity: this is a tool people sit in all day, and the
   current token set cannot express it (`color-scheme: light` plus 105 hardcoded
   literals). It is nearly free *if* the token pass happens first and nearly
   impossible after another year of literals.

## Defects found while looking

Independent of the sweep. Each is small, each is real, and each will be harder to
notice once the surface changes.

1. **Two tabs are unreachable.** `admin.css:1330-1345` — the strip needs 464px in
   a 280px rail, `overflow: visible`, so `Model` and `Access` render behind the
   stage and cannot be clicked at any window size, while staying in the tab order.
   On the demo config an admin cannot open Access at all. Severity: high, and it
   is the reason this went unnoticed — a pages-only site has four tabs and fits.
2. **An asset deletes with no confirmation.** `AssetInput.tsx:528-534` → `remove`
   at `:436` issues `DELETE /folio/assets/:id` on one click, from a permanently
   visible red link beneath every tile in the picker. No confirmation, no undo, no
   usage check, and the binary goes from R2 while documents still reference it.
   Every other destructive action in the admin confirms first. Severity: high.
3. **The Data table's Updated column is wrong by a factor of 1000.**
   `DataTable.tsx:83` does `new Date(row.updatedAt * 1000)`, but `updated_at` is
   `Date.now()` in ms (`server/stories.ts:589`) and every other consumer treats it
   as ms (`History.tsx:202`'s `formatWhen(ms)`). Rendered result: `15/10/58546`.
   Severity: medium, one character to fix.
4. **A version's author is an opaque id.** `History.tsx:80` renders `v.actor`
   where `:114` renders `entry.actorName ?? entry.actor` two lists below, so the
   same person is `usr_demoadmin1` and `Demo Admin` on one screen.
5. **The parent-page select offers documents that cannot be parents.**
   `PageAddress.tsx:26-27` filters only descendants, so records and singletons
   appear as candidate parents — the demo's dropdown lists `Header`,
   `Site settings` and all five `person` records, each with no indent because
   `path` is null. The server correctly refuses
   (`400 Cannot move a page under an unrouted document`, verified), so this is a
   control that offers a choice and then reports an error. Everywhere else the
   admin narrows instead: `StoryTree.tsx`'s `creatableUnder` and `dropRefusal`
   exist for exactly this.
6. **The "belongs to another document" hint does not clear on a repeat click.**
   `Editor.tsx:316-317` clears `globalHint` when `storyId` or `state.selection`
   changes; clicking the already-selected row changes neither, so the inspector
   keeps offering "Edit Header →" instead of the block's fields.
7. **The Data table's search input is unstyled.** `.datatable__search`
   (`admin.css:2160`) sets width only, so a square UA input sits among rounded
   controls.
8. **Two unlabelled `↻` glyph buttons** (History, Model) with no accessible name
   beyond the character.
9. **Three CSS custom properties are referenced and never declared** —
   `--bg-soft`, `--ok`, `--fg`. Harmless today because every use has a fallback,
   and misleading for exactly that reason.

## What must survive the sweep

Naming these because a redesign is where they get thrown away by accident.

- **The comments.** `admin.css` and the components explain *why* nearly every odd
  choice exists, usually naming the spec that decided it — hover-reveal versus
  `visibility` to stop the tree jumping (`admin.css:1481-1483`), the always-visible
  version button because hover-only is unreachable by keyboard (`:1898-1899`),
  the ring-not-lock decision for field presence (`:540-549`). A token pass that
  preserves these preserves the reasoning; one that rewrites the file loses a
  year of decisions.
- **The state vocabulary.** The admin distinguishes draft, changed, live, not
  live, viewing-a-version, behind-the-model, shared-across-locales, translated,
  incomplete-translation and watched-by-a-peer. That richness is the product. It
  currently speaks in eight amber tints, which is precisely the thing a design
  system is for.
- **`useFocusTrap`, and the always-mounted toast.** Both are correct, both are
  commented, and both are the kind of thing a rewrite re-breaks.
- **Controls that hide rather than disable** when they cannot act — the viewport
  switcher and "View live" in form mode (`TopBar.tsx:80-87`), the locale select
  on a single-locale site, the Data and Model tabs on a site with neither. The
  reasoning is written down and it is right.
- **Optimistic local state.** The reason a keyboard-first redesign is achievable
  at all: the store already applies every edit locally before the socket
  acknowledges it, so there is no request to wait on.

## What the design system plan has to decide

Handing over, not answering:

- **Where site-level surfaces live**, and therefore whether the admin gets a
  router and what the URL contains.
- **The token layer's form**, given that it must be inlinable into a static page
  that cannot load the admin's hashed CSS asset (`pages.tsx:186-189`), and that it
  must be able to express a dark theme.
- **The primitive set**, in the order the current duplication argues for: Dialog,
  Menu, Row/List, Badge, Button, Field, Table, Empty state.
- **The state palette** — one visual language for the ten states listed above.
- **Density and the type scale.** Thirteen sizes today; a keyboard-dense tool
  wants roughly five, and picking them decides how much the rails can hold.
- **What "a bit of uniqueness" means, positively.** `docs/feedback.md:87-88` is
  explicit that this has to be written as a brief rather than a caveat. It is the
  one item on this list that cannot be derived from the code, and it is the one
  that decides whether the result is a Linear clone.
- **Whether a host may theme the admin.** Today it cannot: the admin is a
  prebuilt project-agnostic bundle and its tokens are not exposed. That is
  defensible, and it should be a decision rather than a consequence.

## Resolved, 2026-07-30

The three questions this review closed with, answered by the owner on the day it
was written. Recorded here so the sections above are read in their light.

1. **The nine defects are deliberately not fixed.** All nine live in surfaces the
   rebuild replaces — the tab strip, the media library, the data table, the
   history rail, the address panel, and `admin.css` itself — so repairing them
   first is work thrown away twice. They stay listed because a defect nobody
   wrote down is a defect that gets rebuilt.
2. **A router is in scope and "one screen" is not a constraint to keep.**
   Everything must be linkable. This is the largest single consequence for the
   sweep and it promotes the URL model from a nice-to-have to the enabling piece
   the rest waits on.
3. **`admin.css` at 2,544 lines goes.** Not refactored, not split — replaced by a
   token layer plus per-component modules, with the file's deletion as an
   acceptance criterion rather than an aspiration.

Plus one scoping decision the review did not ask for: **the state layer is in
scope too**, not just the view. The one part held fixed is the wire format — the
frames on the socket, the transaction envelope, the dedupe key and the inverse
serialisation stay byte-identical to `docs/sync-design.md`, because the mutation
log outlives every deploy and an old entry has to replay under its old meaning
forever. The client that produces those frames is free to be rebuilt around
URL-driven state; the frames are not.

The plan those answers produce lives in `docs/design-system.md`.
