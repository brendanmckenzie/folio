# The design system

> **Status:** plan, with a working spike (`packages/folio/src/admin/ui/`)
> **Written:** 2026-07-30
> **Follows:** `docs/ui-review.md` — the audit this is answerable to
> **Precedes:** `docs/ui-architecture.md`, which turns this language into eleven
> screens, then the screen ports
> **Decided before this:** a router is in scope and everything is linkable;
> `admin.css` is deleted rather than refactored; the state layer is rebuilt too,
> wire format included — this project has no users and compatibility is not a
> constraint (see `CLAUDE.md`, *This is greenfield*).

## Summary

`docs/ui-review.md` found seven design tokens holding up 51 hardcoded hex
literals, thirteen font sizes, 56 distinct padding declarations, no dark mode, no
primitives, and four independent implementations of "a list row". This document
decides the layer that replaces all of it: a small semantic token set, roughly
eleven primitives, one visual language for the ten content states the admin
already distinguishes, and a keyboard model that starts with a command palette.

It is written to be *finishable*. The reason `docs/feedback.md:85-88` asks for a
design system before the sweep is that a redesign with no system has no
stopping condition. So every decision here is expressed as a fixed set — five
type sizes, not "a type scale"; eleven primitives, named; ten states, enumerated
— and a screen port is done when it uses only those.

## The brief: what "a bit of uniqueness" means, positively

`docs/feedback.md:87-88` is explicit that this has to be written as a brief and
not as a caveat, or the result converges on a Linear clone. Three positive
commitments, each of which excludes something a competitor does.

**1. Colour is reserved for state. The chrome is achromatic.** Panels, rails,
rows, headers, tables and menus are neutral greys and hairlines. Colour appears
only where it carries meaning: a document's publish state, a peer's presence hue,
a selection, a focus ring, a refusal. This excludes what Storyblok, Contentful
and Strapi all do — a branded blue running through the furniture — and it
excludes Linear's own coloured chrome. The payoff is that the ten states become
legible *because* nothing else competes with them, and it is the one rule that
makes the interface look like nobody else's while being cheap to hold.

**2. The rendered page is the hero.** In Linear the list is the subject and the
chrome frames it. Here the subject is a real page rendered by the host's own
Worker — not a simulation, because the CMS and the site are the same process,
which is Folio's actual technical distinction. So the editor gives the preview
more room and less frame than any competitor: hairline edges, no card, no drop
shadow, no rounded corners on the viewport, chrome that recedes to the borders.
The frame earns pixels only when it has something true to say (previewing an old
version, behind the content model).

**3. Identifiers are typographic citizens.** Paths, slugs, ids, block uids,
migration names and scopes are set in mono and treated as content rather than
debug output. A CMS whose whole routing model is derived from a tree should show
you the URL it derived, proudly. This is already latent in the code — `.topbar__slug`
and `.migrations__id` are mono today — and it becomes a rule rather than an
accident.

Held over from the current admin because it is right: **system fonts, no
webfont.** The public page ships zero JavaScript and zero webfonts; the admin
loading a 40kB font to look like a startup would contradict the product. The UI
face is the platform's, and the distinctiveness comes from the three commitments
above rather than from a licence fee.

## Principles, each with a consequence

- **The URL is the state.** If a person can see it, they can link to it. The
  consequence is that panels do not own `useState` for anything navigational, and
  the parse/build pair is pure so it is testable without a browser.
- **Keyboard first means the palette first.** Every action reachable by mouse is
  reachable from one keystroke. The consequence is that actions are declared as
  data (id, label, group, when, run) rather than as JSX handlers, because the
  palette and the menus both read that list.
- **Density is the default, not a setting.** This is a tool people sit in all
  day. The consequence is a 13px base, a 28px row, and no configurable density —
  one well-chosen density beats two mediocre ones.
- **Refusals explain themselves; impossible controls disappear.** Already the
  admin's own rule (`TopBar.tsx:80-87`, `StoryTree`'s `dropRefusal`) and worth
  promoting: if an action cannot apply, hide it; if it can apply but will be
  refused, say why before the click.
- **Nothing is tested by mounting.** The existing suite has 357 admin tests and
  not one of them renders a component (`vitest.config.ts:37`, `environment:
  'node'`). That is a deliberate convention and the rebuild keeps it, which
  constrains the architecture productively: URL parsing, palette ranking,
  keyboard dispatch, state derivation and label wording are all pure functions
  over plain data.
- **Comments survive.** `admin.css` explains why nearly every odd rule exists,
  usually naming the spec that decided it. Those explanations move with the rules
  into the component modules. A token pass that loses them costs more than it
  saves.

## The token layer

Two tiers, deliberately. A **scale** tier that names raw values and is never used
by a component, and a **semantic** tier that components consume exclusively. A
component referencing `--n-300` instead of `--border` is a review comment.

Dark mode is not a later theme, it is the second column of the semantic table —
which is the whole reason for the two tiers, and the reason the current
stylesheet cannot have it. It follows the system by default and `data-theme`
overrides it, on **any element rather than only `:root`**, so a subtree can be
themed: an editor previewing a light-only site inside a dark admin is the case
that will want it.

### Scale

```css
/* Neutrals. The chrome is built entirely from these. */
--n-0:   #ffffff;  --n-25:  #fcfcfd;  --n-50:  #f7f8f9;  --n-100: #f0f1f3;
--n-200: #e5e7ea;  --n-300: #d3d7dc;  --n-400: #a8afb8;  --n-500: #7c848f;
--n-600: #5c646f;  --n-700: #3f4650;  --n-800: #282d35;  --n-900: #15181d;
--n-950: #0d0f12;

/* Accent. Selection and focus only — never a surface, never a brand stripe. */
--blue-50: #eef4ff; --blue-100: #dce7fe; --blue-200: #c0d3fc;
--blue-500: #3b6ff5; --blue-600: #2b57d0; --blue-700: #1f419e;

/* State hues. Each is a bg / border / fg triple and nothing else. */
--green-50: #e9f7ef; --green-200: #b6e2c8; --green-700: #1c6b42;
--amber-50: #fdf6e3; --amber-200: #ecd9a4; --amber-700: #7a5a12;
--red-50:   #fdeeee; --red-200:   #f3c4c4; --red-700:   #a3282c;
```

### Semantic

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--bg-app` | `--n-50` | `--n-950` | the page behind everything |
| `--bg-panel` | `--n-0` | `--n-900` | rails, headers, tables, dialogs |
| `--bg-inset` | `--n-50` | `--n-800` | cards inside a panel, code, source columns |
| `--bg-hover` | `--n-100` | `--n-800` | row and menu-item hover |
| `--bg-active` | `--n-200` | `--n-700` | pressed, and an open menu's trigger |
| `--bg-selected` | `--blue-50` | `#182746` | the selected row, the current document |
| `--fg` | `--n-900` | `--n-50` | body text |
| `--fg-muted` | `--n-600` | `--n-400` | secondary text, most labels |
| `--fg-subtle` | `--n-500` | `--n-500` | placeholders, disabled, micro-headers |
| `--fg-accent` | `--blue-600` | `--blue-200` | links, the one clickable status |
| `--fg-inverse` | `--n-0` | `--n-900` | text on a filled button |
| `--border` | `--n-200` | `--n-800` | every hairline |
| `--border-strong` | `--n-300` | `--n-700` | inputs, hover on a bordered control |
| `--ring` | `--blue-500` | `--blue-500` | focus, at 2px offset 1px |

Five type sizes, and no sixth:

```css
--text-xs:   11px;  /* micro-headers, badges, meta. Uppercase 0.06em only here. */
--text-sm:   12px;  /* labels, help text, table cells */
--text-base: 13px;  /* the default. Rows, inputs, buttons, menus. */
--text-lg:   15px;  /* panel and dialog titles */
--text-xl:   20px;  /* the one screen title per screen */
```

Spacing on a 4px grid, seven steps: `--space-0` through `--space-6` =
`0 / 4 / 8 / 12 / 16 / 24 / 32`. Two exceptions are allowed and named:
`--row-h: 28px` (the list row) and `--rail-w: 15rem` (see Layout).

Radius: `--radius-sm: 4px`, `--radius-md: 6px`, `--radius-lg: 10px`,
`--radius-full: 999px`. Four, down from ten.

Elevation: `--shadow-menu` and `--shadow-dialog`. Two, because there are exactly
two things that float.

Motion: `--dur-fast: 90ms`, `--dur-base: 160ms`, `--ease: cubic-bezier(.2,0,.2,1)`,
all inside a `prefers-reduced-motion` guard once and never again.

Fonts: `--font-ui` (system stack) and `--font-mono`. Mono is not decoration — see
commitment 3.

### One constraint the token file must satisfy

`server/pages.tsx:186-189` documents why the login and error pages carry their own
inline stylesheet: the admin CSS is a hashed Vite asset, and a page that has to
render when the build is broken cannot depend on it. Today that produces five
near-miss duplicates (`#111` against `--text: #1a1d23`, and a black primary
button against a blue one).

So the token file is **plain CSS custom properties with no build step**, small
enough to be read and inlined by the server into those pages. That is a
requirement on the token layer, not a nicety, and it is the main reason the
styling decision below went the way it did.

Note what it is *not*: a host-facing API. Host theming is decided against
(Resolved, 1), so these names are internal and free to change.

## The state palette

The admin distinguishes ten states today and expresses them in eight
hand-mixed amber tints. One language, fixed:

| State | Treatment | Note |
| --- | --- | --- |
| `draft` | **neutral** chip | Deliberately changed from amber. A draft is the normal state of new content, not a warning; today it wears the same colour as a schema drift. |
| `live` | no chip | An unadorned row already means "this is what the public sees". Kept from today, and it is correct. |
| `changed` (live, with unpublished edits) | accent chip | A "look here", not a problem. |
| `unpublished` (was live, taken down) | red chip | The one content state that is genuinely a warning. |
| behind the content model | amber banner, in flow | Amber is now *only* schema drift and version preview. |
| viewing a past version | amber frame on the stage + amber row | A frame rather than a badge, because it describes the whole stage. |
| shared across locales | neutral, control disabled, labelled | No colour: it is a fact about the field, not a state to act on. |
| translation completeness | neutral count chip, green when complete | |
| peer presence | the peer's own hue, as a ring or dot | Never semantic, never one of the above hues. |
| refused / error | red text, or a red-accented toast | |

The rule that makes this hold: **a hue means one thing.** Amber is drift and
history. Red is withdrawal and refusal. Green is "complete". Blue is selection
and attention. Everything else is grey.

## The primitives

Eleven. The count is the point: a screen port that needs a twelfth is a design
conversation, not a new file. Each retires named duplication from
`docs/ui-review.md`.

| Primitive | API sketch | Retires |
| --- | --- | --- |
| `Button` | `variant: 'primary' \| 'default' \| 'subtle' \| 'danger'`, `size: 'sm' \| 'md'`, `icon`, `disabled`, `reason` | `.btn-primary`, `.btn-danger`, and ~20 per-panel button overrides |
| `Badge` | `tone: 'neutral' \| 'accent' \| 'ok' \| 'warn' \| 'danger'`, `mono?` | `.stories__badge`, `.stories__chip`, `.redirects__badge`, `.migrations__badge`, `.stories__i18n` |
| `Field` | `label`, `help`, `required`, `error`, `hint`, children | `.field` plus the per-panel input rules |
| `Input` / `Select` / `Textarea` | thin, tokenised | includes the unstyled `.datatable__search` |
| `Row` | `selected`, `depth`, `handle`, `actions`, `meta`, `onOpen`; renders as a real focusable element with `role` | `.stories__row`, `.tree__row`, `.data__row`, `.datatable` row |
| `List` | keyboard container for `Row` (↑ ↓ Home End, typeahead), `virtualise?` | the 50-row cap and its "Show all N" |
| `Table` | `columns`, `rows`, `sort`, sticky head, dense | `.datatable__*` |
| `Dialog` | portal, `title`, `description`, `danger?`, footer actions, built on the existing `useFocusTrap` | five overlay namespaces and six dialogs, one of which currently renders as another's (`PublishDialog.tsx:73` → `.discard`) |
| `Menu` | portal popover, trigger, `items` as data, roving focus, Escape, outside-click | five hand-rolled popovers, each with its own scrim and z-index |
| `Palette` | `⌘K`. Actions as data; pure `rank(query, actions)` | nothing — new, and the centrepiece |
| `EmptyState` | `title`, `body`, `action` | six ad-hoc empty paragraphs |

Plus one non-visual carry-over: the **Toast** stays a permanently mounted
`role="status"` live region, because making it conditional breaks announcement.
That is already commented in `Editor.tsx:488` and it survives verbatim.

Two primitives deliberately **not** in the set:

- **No `Card`.** Commitment 2 says the chrome recedes; a card is chrome that
  advertises itself. `--bg-inset` plus a hairline does everything a card was for.
- **No `Tabs`.** The tab strip is what broke (464px in a 280px rail). Screens
  replace it, so a `Tabs` primitive would preserve the shape that failed.

## Layout and density

- **`--rail-w: 15rem`** (240px) and every rail is *resizable* with the width
  persisted, because the review's single worst finding — user administration in
  280px with every email truncated — was caused by a fixed rail. Resizable is
  cheap insurance against the next surface that does not fit.
- **Row height 28px**, one line, `--text-base`. A second line is opt-in per row
  and costs 20px, so a dense list stays dense by default.
- **Indent 16px per tree level**, up from 10px, because at 10px a child and its
  parent are hard to tell apart (`admin.css:295`).
- **Two breakpoints, not zero.** Below 1100px the inspector becomes an overlay;
  below 800px the rail does too. Today there are no media queries at all, so a
  1280px laptop gets the same fixed 580px of rails as a 2560px display.
- **Truncation always has an escape.** A truncated path, name or email carries a
  title and is findable in the palette. The review's rule: a column truncated to
  `/ab…` is worse than a column that is absent.
- **In a tree, a row's secondary text is the slug, not the path.** Found while
  building the spike: the indent already carries the ancestry, so repeating it
  per row spends exactly the width that made `/showcase/reference-target`
  truncate to `/showc…`. The full path belongs to the tooltip and to the
  palette's hint column, where there is room for it. A container query hiding the
  path below a narrow rail was tried first and was worse — at the rail's own
  15rem it hid every path, short ones included.

## The keyboard model

- **`⌘K` opens the palette.** It searches documents, screens and actions in one
  list, which is what makes the tree's row cap, the flat block picker and the
  absent asset search stop mattering. Ranking is a pure function so it is unit
  tested without a DOM; documents come from the server (see Resolved, 2).
- **`g` then a letter** navigates screens (`g c` content, `g d` documents,
  `g a` assets, `g h` history, …). Mnemonic and declared in the same action list
  the palette reads. A sequence rather than a chord, so it needs a small pure
  state machine the chord matcher does not have yet.
- **`⌘\`** toggles the rail, **`⌘.`** the inspector, **`⌘Z` / `⇧⌘Z`** stay
  undo/redo, **`⌘C` / `⌘V`** stay block copy/paste. `?` shows the map.
- **`⌘S` is a deliberate no-op** that says so, and publish has no chord at all.
  See Resolved, 3.
- **One mechanism, declared as data.** `ui/shortcuts.ts` holds a pure
  `chord(event)` that normalises a keypress to a canonical string (`mod+s`,
  `mod+shift+z`) and a `useShortcuts({ 'mod+k': … })` hook that dispatches from a
  map. Two bespoke hooks for two shortcuts is how the old admin ended up with
  four bindings and no map.
- **Focus is visible everywhere**, from one `:focus-visible` rule on a shared
  class rather than the two input-only rules that exist today.
- **Lists are traversable**: ↑ ↓ Home End and typeahead in `List`, so the content
  tree stops being `<div onClick>` (`StoryTree.tsx:355-357`) and Biome's a11y
  rules can come back on.
- **Tree reordering by keyboard** is the one genuinely hard piece, and
  `ROADMAP.md:412-419` is right that it is a UI question first. The answer this
  system commits to: `⌥↑ / ⌥↓` moves a row among its siblings and `⌥← / ⌥→`
  changes its depth, each mapping to exactly the fractional-index write a drag
  already performs. "Between these two siblings" needs no expression because
  moving one place at a time never has to name a gap.

## The URL model

Designed screen by screen in `docs/ui-architecture.md`, and owned in detail by
`docs/specs/admin/url-and-shell.md`. The shape it has to take, because the
primitives assume it:

```
{base}/                          home
{base}/content                   the page tree
{base}/documents/:type           one type's table   ?q=&sort=&dir=&page=
{base}/assets                    the media library  ?q=&kind=
{base}/access                    editors and tokens
{base}/model                     migrations and the audit report
{base}/redirects
{base}/settings
{base}/edit/:id                  the document editor
{base}/edit/:id?blok=<uid>&locale=fr&version=<id>&panel=history
```

`{base}` is `config.basePath` (`runtime.ts:313`), so nothing may hardcode
`/folio`. Ephemeral by design and *not* in the URL: an open menu, an unsent
palette query, presence, and in-flight transactions.

One route rather than a screen, from Resolved, 2: `GET {base}/search?q=`.

## Architecture decisions

### 1. CSS custom properties plus per-component CSS Modules

Vite-native, so no new dependency in a library whose consumers compile it from
source, and the token file stays plain CSS that `server/pages.tsx` can inline
into the login page — the constraint that made this decision.

**Rejected: Tailwind.** It would enforce the scale by construction, which is
genuinely attractive after 56 distinct padding values. It loses on the thing this
codebase treats as an asset: the *reasons*. `admin.css` explains why hover-reveal
uses `visibility` rather than `display` (the tree jumps under the cursor), why the
version button is always visible (hover-only is unreachable by keyboard), why the
field ring is a ring and not a lock. A utility string in JSX has nowhere to put
that, and a year of decisions would be re-derived by the next person. It also
needs its own config kept in step with a token file the login page still requires,
so it adds a system rather than replacing one.

**Rejected: vanilla-extract or StyleX.** Typed, zero-runtime, compile-checked
tokens — the strongest guarantees on offer. Costs a build dependency and a new
authoring language for a payoff (typo-proof token names) that a two-tier CSS
variable set plus review gets most of.

### 2. The state layer is rebuilt around the URL, and the wire is fair game too

`Editor.tsx` holds twenty-odd `useState`s, several of which are navigational
(which rail, which locale, which version, which data type, which dialog). Those
become derived from the URL, which is the whole point of the router.

**This paragraph used to freeze the wire format** — socket frames, the transaction
envelope, `PROTOCOL_VERSION`, the dedupe key, the byte-level inverse
serialisation — on the grounds that the mutation log outlives every deploy and an
old entry must replay under its old meaning forever. **That is retracted.** The
project has zero users, no remote and nothing deployed; there is no old log to be
kind to, and `scripts/e2e.sh` already wipes local Durable Object state on every
run. `docs/sync-design.md` invariant 10 is struck through in place and `CLAUDE.md`
now says so at the top.

What that changes in practice: the frames may be redesigned rather than extended,
`PROTOCOL_VERSION` may be reset rather than incremented, and the two compatibility
shims in the mutation vocabulary — a locale-less `set` meaning a source-locale
write, and `invert` omitting the key so a fresh inverse serialises byte-identically
to a pre-v3 one — should go when that code is next touched. Neither buys anything.

What does *not* change is the engineering the old rule happened to protect, which
was good for its own reasons: atomic validated transactions, `tx_id` dedupe,
base+pending rebase, a contiguous watermark. Keep those because they are correct,
not because a log somewhere depends on them.

**Rejected: keeping `store.ts` as-is** and layering a router over it. Cheaper and
safer, and it would leave the store owning selection and locale — the two pieces
of state that most need to come from the URL — which reintroduces exactly the
two-sources-of-truth bug the router exists to remove.

### 3. Eleven primitives, fixed, and no `Card` or `Tabs`

A fixed set is what gives the sweep a stopping condition. The two exclusions are
load-bearing rather than tidy: a `Card` contradicts commitment 2, and a `Tabs`
primitive would rebuild the strip whose overflow made two screens unreachable.

**Rejected: porting screens and extracting primitives as they repeat.** It is how
`admin.css` happened. The fourth list row is where you notice, and by then there
are four.

### 4. The spike is the foundation, not a mockup

`packages/folio/src/admin/ui/` holds the real tokens and the real primitives from
the first commit, with a kitchen-sink screen that renders all of them in both
themes. Nothing is thrown away when screen ports begin.

**Rejected: a Figma-first or throwaway-HTML pass.** Faster to iterate visually,
and it produces a picture that then has to be re-derived in code against
constraints (the 46rem form column, the preview iframe, presence rings, the
locale source column) that a static mock does not feel.

## What this retires

The measure of done, from `docs/ui-review.md`'s counts:

- `admin/admin.css`, 2,544 lines → deleted. Acceptance criterion of the last
  screen port, not an aspiration.
- 7 declared tokens holding up 51 hardcoded hex literals → two-tier tokens, zero
  literals in component modules.
- 13 font sizes → 5. 56 padding declarations → a 7-step scale. 10 radii → 4.
- 3 referenced-but-undeclared custom properties (`--bg-soft`, `--ok`, `--fg`) →
  gone by construction.
- 5 overlay namespaces / 6 dialogs → one `Dialog`. 5 popovers → one `Menu`.
  4 row implementations → one `Row`.
- 0 media queries → 2 breakpoints. 2 input-only `:focus-visible` rules → one
  visible focus treatment everywhere.
- `color-scheme: light` → both themes, following the system and overridable.
- 2 drifting palettes (admin and login) → one token file, inlined by the server
  into the pages that cannot load a hashed asset.

## Resolved

The three questions this document was written with, answered by the owner on
2026-07-30. Each changed something above rather than merely confirming it.

### 1. A host does not get to theme the admin — decided, not inherited

The token layer makes host theming trivially possible, which is exactly why it
needed deciding rather than defaulting. The answer is no.

What that buys: the semantic tier is **internal**, so token names are not a
contract and can be renamed as the system learns. There is no `--folio-` public
prefix to maintain, no documentation surface, and no obligation to keep a
half-finished palette stable because somebody might be overriding it.

It also happens to be enforced rather than merely stated: `adminPage` in
`server/pages.tsx` is Folio's own HTML document, so a host has nowhere to inject a
stylesheet even if it wanted to. Consistent with the admin being a prebuilt,
project-agnostic bundle in the first place.

### 2. The palette searches on the server

The tempting answer was to rank client-side, because `GET /folio/stories` already
returns every story's id, path and title. Rejected, and the reason is that the
"free" client-side ranking is only free because something worse is already
happening: **the admin loads every story on every boot.** A palette built on that
fetch would make the fetch load-bearing and harder to remove, when a searchable
palette is precisely what makes a *paged* tree acceptable. The two go together.

That observation turned into a constraint of its own, and it now outranks this
document: **nothing may be unpaginated, in the UI or the API.** An audit of every
list route is in `ROADMAP.md` under *Next → 1*, and it is not pretty — two routes
page properly, three truncate silently, and five return whole tables. It is
sequenced before `url-and-shell.md`, because `?q=&sort=&page=` means nothing until
a page is defined. `GET {base}/search` is a paginated list route like any other
and inherits whatever that spec settles.

Shape, for `url-and-shell.md` to specify:

- `GET {base}/search?q=` behind the same `READ_DRAFT` gate the editor route uses.
  Roles are global, so one gate is the whole authorisation story — per-document
  access control is deferred in `ROADMAP.md` and does not apply here.
- Matching in SQL over `stories.title`, `stories.path` and `stories.slug`. Plain
  `like` with a limit to begin with; **FTS5 is the named upgrade**, not the
  starting point, because it costs a migration and index maintenance on every
  write. The trigger for taking it is body-text search being asked for, or a site
  passing a few thousand documents — named here so it is a decision later rather
  than a surprise.
- `content_index` is the second source, and it carries a caveat worth stating
  once: it is written at **publish** time, so searching an indexed field finds
  published values only. A draft-only person is findable by title and not by
  their role. The Data table already has this asymmetry and says so in its
  footer; the palette should be equally honest.
- **Groups are ranked separately, and that is the design.** Commands and screens
  are a small static list ranked locally by `rank.ts`, so they appear on the
  first keystroke with no request. Documents arrive from the server, debounced
  with the previous request aborted, and render in the order the server returns.
  No attempt is made to score a command against a document on one scale — the
  palette already renders groups, so nothing needs the comparison.
- The local half must never wait on the network half. A palette that stalls for
  120ms before showing "Publish" is worse than one with no server search at all.

### 3. `⌘S` is a no-op that says so

Publish gets no chord. `⌘S` is bound, calls `preventDefault()` and shows a toast
along the lines of **"Saved! (but you didn't need to do that)"** — the owner's own
wording, kept because it does the teaching that a silent no-op cannot.

The binding earns its place twice over. It stops the browser's own Save dialog
appearing over the editor, which is the real hazard, and it answers the question
the reflex is actually asking. Every keystroke is already a logged, synced,
undoable transaction; a person pressing `⌘S` wants reassurance, and the honest
reassurance is "already done, and you can stop worrying about it".

**Publish therefore has no keyboard shortcut at all**, which is deliberate: it is
a consequential act, and the palette (`⌘K`, then "Publish") is a two-keystroke
route that cannot be hit by muscle memory. This is also what the "actions are
data" rule buys — publish needs no bespoke binding to be reachable from the
keyboard.
