# Feature: The command palette, and one vocabulary of verbs

> **Group:** editing
> **Build order:** 42
> **Size:** M
> **Status:** draft
> **Wire version:** none. Nothing here crosses the socket or the admin↔preview frame; `add_block` commits through the editor's existing `tx`
> **Migration:** none. Recents live in the browser; the one server change is a `q` parameter on an internal list route (decision 9)
> **Build sequence:** after spec 39 (v1.5) and the Chrome review of core flows, per the agent-native sequence. Additive minor release: no `exports` subpath, no `createFolio` key and no v1 route changes
> **Last updated:** 2026-11-04

## Summary

`⌘K` already opens a palette, and it is a navigator, not a command palette. It
offers every nav screen and the documents `GET {base}/api/search` returns
(`src/admin/ui/Admin.tsx:1160-1201`) and **no command at all**, even though
`design-system.md:491` promises "the palette (`⌘K`, then 'Publish') is a
two-keystroke route" and `Menu.tsx:32-34` says actions are data so they can appear
"in a menu, in the palette and behind a shortcut". It is also the one modal surface
that does not use the shared focus trap (`Palette.tsx` never calls `useFocusTrap`),
it has no combobox or listbox semantics, and it drops server results that matched on
an indexed field, because it re-ranks them by label (`Palette.tsx:50`, `rank.ts:117`).

This spec turns it into a command palette backed by **one named command registry**:
each command carries a verb, the `Access` it needs and, where one exists, the MCP
tool that is the same act for an agent. The verb *is* the MCP tool name wherever a
tool exists, and a unit test holds the two tables together, so a person pressing
`⌘K → Publish` and an agent calling `publish_document` are using one word for one
act behind one gate. The palette finds documents, assets and forms in the current
scope, runs the editor's actions (publish, unpublish, duplicate, schedule, add a
block, switch locale) and the shell's (new document, switch site), hides what the
person may not do, and follows the WAI-ARIA combobox pattern.

## Ground truth

**admin, the palette as it stands (`src/admin/ui/`):**

- `Palette.tsx:45-160` is the whole component: a portal to `document.body`
  (`:81`, `:158`) whose root carries `scoped(css.wrap)` (`:83`), so the portal rule
  in `scope.ts:33-37` already holds. The panel is `role="dialog" aria-modal="true"`
  (`:91`).
- **It does not use `useFocusTrap`.** Focus is taken by a ref callback on the input
  (`:97`), Escape is handled in the input's own `onKeyDown` (`:109-112`), and the
  rows are `<button>`s (`:133-150`), each a tab stop. Tab therefore walks from the
  input through every row and out of the panel into the page behind the scrim.
  CLAUDE.md's invariant says all admin dialogs share the one trap; this surface is
  the exception.
- No ARIA beyond the dialog: the input is not a `combobox`, the results are not a
  `listbox`, there is no `aria-activedescendant`, and nothing announces a result
  count. The admin's only live region is `Toast` (`role="status"`), rendered as a
  sibling of `Shell` (`Admin.tsx:723`), i.e. outside the `aria-modal` panel.
- `PaletteAction` (`Palette.tsx:7-15`) is `{ id, label, keywords?, group, hint?,
  run }`. There is no `disabled`, `reason`, `danger` or permission field.
- Every item is ranked by one `rank(query, actions)` call (`Palette.tsx:50`), and
  `rank` **drops non-matches** (`rank.ts:99-121`, the `if (best)` at `:117`). The
  documents come from `GET {base}/api/search`, which matches `content_index` values
  as well as title, slug and path (`useSearch.ts:16-18`). A record found by an
  indexed field whose label and path do not contain the query is returned by the
  server and then discarded by the client. `design-system.md` Resolved 2 had
  already said remote groups "render in the order the server returns" and are not
  scored against commands; the implementation diverged from it.
- `useSearch.ts:47-90` debounces at 150ms (`:28`) and guards stale answers with a
  `live` flag, not an `AbortController`, so a superseded request still runs to
  completion. It asks `/search` only: assets and forms are not searched at all.
- `Admin.tsx:150` holds `palette` as a boolean; `:564` binds `"mod+k": () =>
  setPalette(true)`; `:592-593` builds the actions; `:719-721` mounts the palette.
  `useShortcuts` (`shortcuts.ts:103-152`) fires a modified chord even while focus is
  in a field or another dialog is open (`:134-139`), so `⌘K` over an open `Dialog`
  stacks a second modal with a second Escape handler.
- `usePaletteActions` (`Admin.tsx:1160-1201`) emits `nav:<href>` screen items from
  `nav()` and `doc:<id>` items from the search rows. `nav()` (`nav.ts:72-96`)
  already role-gates screens and returns only Sites (or nothing) on a multi-site
  page with no scope (`:76-78`).
- `TopBar.tsx:68-75` renders a "Search ⌘K" button that calls `onSearch`
  (`Admin.tsx:673`).

**admin, the actions the palette should reach:**

- The editor's actions live inside `EditorBody` (`screens/EditorShell.tsx:260`),
  two components below the shell that owns `⌘K`. Publish is `requestPublish`
  (`:410-413`), which opens the incomplete-locales confirmation when
  `editor.gaps.length > 0`; the Publish button's disabled rule is inline at
  `:668-681` (publishing in flight, no live doc, viewing a version, nothing to
  publish, no role). Unpublish is a `MenuItem` in the `▾` menu (`:697-714`) that
  opens `setConfirm("unpublish")`. Share is a button gated by `shareRefusal`
  (`share-model.ts:29-34`). The role is read on the **owning** scope:
  `const owner = story.site ? atScope(props.me, story.site) : props.me` (`:333`).
- `⌘⇧A` is listed in the shortcut sheet (`screens/Keys.tsx:74`, "Add a block") and
  in `ui-architecture.md`'s keyboard map, and **is bound nowhere**: no `mod+shift+a`
  key exists in any binding map under `src/admin`. Its placement rule is written and
  tested but unused: `addTarget(doc, schema, selection)`
  (`screens/block-picker-model.ts:344`), exercised only by
  `test/unit/admin/block-picker.test.ts:292-299`. The picker opens from
  `setAdding(target)` (`EditorShell.tsx:270`, `:491-499`).
- **No admin surface creates a schedule.** `POST {base}/api/story/:id/schedule`
  exists (`server/routes/schedules.ts:116-118`, `PUBLISH`, body `ScheduleBody` =
  `{ action, at }` at `server/validate.ts:420-430`, future-only and at most ten
  years ahead per `checkScheduleTime`, `server/schedules.ts:69-79`), and installing
  one replaces the pending row for that story and action
  (`server/schedules.ts:89-99`). The Schedules screen lists and cancels only.
- Single-document duplicate is `POST {base}/api/stories/:id/duplicate`
  (`server/routes/stories.ts:666-690`, `CREATE`, source read anywhere in the chain,
  copy written in the request's scope). The admin's only single-row caller is
  `Documents.tsx:160-185`.
- Creating a document collects its name first in `CreateDialog`
  (`screens/CreateDialog.tsx`), mounted by `Content.tsx:1097` and
  `Documents.tsx:511`, each posting `POST {base}/api/stories` itself
  (`Content.tsx:1049-1068`).
- The scope switcher navigates with a page load:
  `window.location.assign(switchScopeUrl(bare.base, next, route.screen))`
  (`Admin.tsx:456`, `route.ts:173-175`). The choices are `scopeChoices(me)`
  (`me.ts:203-205`), each a `MeScope` carrying `name`, `kind`, `role` and `brand`
  (`server/auth/me-sites.ts:20-39`).
- The locale switcher is a `<select>` in the editor's top bar calling
  `editor.setLocale` (`EditorShell.tsx:600-612`), shown only when
  `locales.available.length > 1`.
- The assets screen opens a file from `?asset=<id>` (`screens/assets-model.ts:195`);
  `go(screen, query)` takes a query (`useRouter.ts:31`).
- The shell already has a precedent for a screen handing the shell something it
  owns: `registerReload` (`Admin.tsx:324-327`), held in a ref, registered by
  `Content.tsx:180-184` and `Documents.tsx:135-139` in an effect with a cleanup.
  The admin uses no React context anywhere.

**admin, permissions (`src/admin/me.ts`):**

- The predicates are role checks on the scope being shown: `canEdit` (`:267`),
  `canPublish` (`:275`), `canCreateContent` (`:297`), `canManageAssets` (`:319`),
  `canReadResponses` (`:333`), `canAdmin` (`:368`), `canDeleteForms` (`:387`), all
  built on `atLeastRole` (`:173-176`), which reads the role on `me.scope` when
  `sites` is present. `whyNot` (`:403-426`) words a refusal.
- `me.ts:12` already imports `atLeast`, `Role` and `Scope` at runtime from
  `server/auth/roles.ts`, whose only import is `core/sites`. The `Access`
  constants (`READ`, `READ_DRAFT`, `EDIT`, `CREATE`, `MANAGE`, `PUBLISH`, `ASSETS`,
  `FORMS`, `ADMIN`, `SCOPE_ADMIN`, `roles.ts:324-404`) are therefore importable by
  the admin bundle at no cost.

**server, the agent's verbs (`src/server/mcp/tools.ts`):**

- `MCP_TOOLS` (`:124`) has sixteen rows: `get_schema`, `search_documents`,
  `query_documents`, `get_document`, `list_versions`, `preview_document`,
  `create_document`, `write_content`, `patch_fields`, `move_document`,
  `duplicate_document`, `restore_version`, `publish_document`,
  `unpublish_document`, `delete_document`, `upload_asset` (`:127-521`). Each names a
  v1 route and the same `Access` that route declares (`need`, `:91-96`);
  `delete_document` is the one `narrowed` row (`SCOPE_ADMIN` over the route's
  `MANAGE`, `:481-518`).
- `tools.ts` imports `./shot`, which imports `../pages`, `../runtime` and
  `../stories` (`shot.ts:35-45`). Importing `MCP_TOOLS` into the admin bundle would
  pull the server into the browser; a test may import it freely.
- The admin calls internal routes, not v1 routes, for the same acts, behind the same
  `Access`: `POST /story/:id/publish` and `/unpublish` (`server/routes/stories.ts:728-770`,
  `PUBLISH`) against v1's `POST /documents/:id/publish` and `/unpublish`
  (`server/routes/api/documents.ts:699`, `:743`, `PUBLISH`); `POST /stories`
  (`stories.ts:582`, `CREATE`) against `POST /documents` (`api/documents.ts:466`,
  `CREATE`); `POST /stories/:id/duplicate` against `POST /documents/:id/duplicate`
  (`api/documents.ts:760`, `CREATE`); `GET /story/:id/versions`
  (`server/routes/history.ts:44-45`, `READ`) against `GET /documents/:id/versions`
  (`READ`).
- There is **no v1 route and no tool for scheduling**, sharing a preview, switching
  locale or site, or adding a single block.
- `test/unit/mcp/tools.test.ts:139-161` already enforces a partition of the same
  shape this spec needs: every v1 route is a tool or a named exclusion, and no
  exclusion is stale.

**server, search per kind:**

- `GET {base}/api/search` (`server/routes/stories.ts:499-534`, `READ`) searches the
  whole chain (`chain: await requestChain(c, rt)`, `:530-533`); each hit carries
  its `site`. Brand is implicit: `?kind=` resolves against `brandOf(c).types`
  (`:510-516`).
- `GET {base}/api/assets` (`server/routes/assets.ts:198-215`, `READ`) takes `q`
  (`:208`, matched over filename, alt and description with `likePattern`,
  `server/assets.ts:158-162`) and lists the scope's own library unless `?chain=1`
  (`:205`).
- `GET {base}/api/forms` (`server/routes/forms.ts:231-252`, `READ`) takes **no**
  `q`. `listForms` (`server/forms.ts:863-905`) selects by chain and keyset only,
  over `forms_updated (site_id, updated_at desc, id)` (`migrations/0011_sites.sql:116`).
  A form has `name` and `label` (`migrations/0010_forms.sql`).
- `GET {base}/api/stories?ids=` (`stories.ts:282-292`) answers a batch by id within
  the request's chain; an id outside it is absent, exactly like a deleted one.
- `server/like.ts` builds every `like` pattern under D1's 50-byte limit; any new
  `like` must use `likePattern` and `LIKE_ESCAPE`.

**admin, storage (`src/admin/ui/remembered.ts`):**

- Three hooks over `localStorage`, every access guarded, every read screened by a
  required validator (`:67-104`, `:137-181`). `useRememberedSet` stores ids
  comma-separated, which is safe because ids match `^[A-Za-z0-9_.:-]+$`
  (`server/validate.ts:63-69`). Keys are dotted: `folio.content.expanded`
  (`Content.tsx:196-199`).

**tests:**

- The admin has two unit projects (`vitest.config.ts:61-81`): `unit` (Node, pure)
  and `render` (happy-dom, `test/unit/admin/render/**`). `render/ui-scope-render.test.tsx:61`
  mounts `<Palette actions={[]} onClose={() => {}} />`; its props change here.
- `test/unit/admin/ui-scope.test.ts:117-125` asserts every `createPortal` file
  re-declares the scope (at least four); `:137-157` asserts exactly five
  `position: fixed` surfaces (Dialog, Palette, FocusMode, HistoryPanel, Toast).
  The new schedule dialog uses `Dialog`, so neither count moves.
- `test/unit/admin/ui-rank.test.ts` covers `rank`, `highlight` and `nextIndex`;
  `ui-shortcuts.test.ts:92-106` asserts the sheet documents each chord once, names
  where each lives, and offers no chord for publish.

## User stories

### Editor publishes without reaching for the mouse
**As** a publisher with a page open **I want to** press `⌘K`, type `pub` and press
Enter **so that** the page publishes, with the same locale-gap warning the button
gives.

### Editor finds the thing they half remember
**As** an editor **I want to** type part of a page title, an asset's alt text or a
form's label into one box **so that** I can open it without knowing which screen
lists it.

### Editor sees only what they can do
**As** an editor without the publisher role **I want** the palette to offer no
Publish, Unpublish or Schedule at all **so that** it is not a list of refusals.

### Editor working across sites
**As** an editor on a fifty-site deployment **I want to** type a site's name and
switch to it **so that** I do not scroll a switcher, and **I want** search to stay
inside the site I am in **so that** I never open another site's page by accident.

### Agent and editor share words
**As** a developer pairing with an agent **I want** the palette's "Publish" and the
agent's `publish_document` to be the same named act **so that** "publish it" means
one thing whichever of us does it.

### Screen-reader user
**As** a screen-reader user **I want** the palette to announce the active option and
how many results there are **so that** I can use it without sight.

## Architecture decisions

### 1. The palette is rebuilt in place, not added beside the existing one

`Palette.tsx`, `rank.ts`, the `mod+k` binding, the TopBar button and the portal
stay. What changes is the item model, the accessibility, the search and the sources
of commands. Rejected: a second "command" surface (`⌘⇧P` style) beside a navigator.
Two palettes is the split `design-system.md` argued against ("documents, screens and
actions in one list"), and every command in this spec is something a person reaches
for while navigating.

### 2. One command type; the verb is the MCP tool name wherever a tool exists, and a test holds the two tables together

A command is data, declared in `src/admin/ui/commands.ts`:

```ts
import type { Access } from "../../server/auth/roles";

/** Every verb the admin knows. Snake case, verb first: MCP's own grammar. */
export type Verb =
  | "create_document" | "publish_document" | "unpublish_document"
  | "duplicate_document" | "list_versions" | "schedule_document"
  | "add_block" | "share_preview" | "switch_locale" | "switch_site"
  | "open_screen" | "open_responses" | "show_shortcuts"
  | "open_account" | "sign_out";

export interface Command {
  /** Unique per row: the verb plus whatever distinguishes two rows of it,
   *  e.g. `create_document:page`, `switch_site:alpha`. */
  id: string;
  verb: Verb;
  /** The MCP tool that is this act for an agent, or null. Non-null only when
   *  equal to `verb`; the verbs test enforces that. */
  tool: Verb | null;
  label: string;
  /** Searched, never highlighted. Always includes the verb, so typing
   *  `publish_document` finds Publish. */
  keywords?: string;
  group: CommandGroup;
  /** A chord to show in the hint column, in `Keys.tsx`'s notation. */
  shortcut?: string;
  /** What the act needs, as the route declares it. Null for a pure navigation
   *  or for sign-out, which nothing gates. */
  need: Access | null;
  /** Whose role `need` is read on. Absent is the scope being shown. */
  owner?: string;
  /** Shown but refused, with the sentence a disabled control would give. */
  blocked?: string;
  danger?: boolean;
  run: () => void;
}
```

`tool` is non-null for `create_document`, `publish_document`,
`unpublish_document`, `duplicate_document` and `list_versions`, and in each case
equals the verb. `test/unit/admin/commands-verbs.test.ts` imports `MCP_TOOLS` and
asserts: every non-null `tool` names a row; that row's `need` equals the command's
`need`, or the row is `narrowed`; every verb with no tool is on `HUMAN_ONLY`, a
`Record<Verb, string>` of reasons exported beside the type; every MCP tool is some
command's `tool` or on `AGENT_ONLY`, a `Record<string, string>` of reasons; and
neither list holds a stale entry. That is `tools.test.ts:139-161`'s partition,
applied to the second table.

A command's verb is searchable and never displayed: it sits in `keywords`, so an
editor who types `publish_document` finds Publish, and no row, hint column or tooltip
shows the snake-case name. Rejected: **showing the verb beside the label.** It is the
agent's vocabulary, and putting it on every row adds noise to the people the palette is
for in order to teach a few of them a name they can read in `AGENTS.md`.

Rejected: **one shared definition table driving both MCP and the palette.** The two
rows describe different things. A tool is a stateless v1 call with a JSON Schema
for a model, discovered once per session and deliberately not contextual
(`mcp-server.md` decision 7); a command is a UI flow that opens a confirmation,
reads the open document, the selection and the in-flight state, and calls an
internal route. A shared table would either put JSON Schema and v1 paths into the
admin bundle, or put React state into the server's tool list, and `tools.ts` cannot
be imported by the browser at all (`shot.ts:35-45`). Also rejected: **a mapping in
prose only** (an `AGENTS.md` table), which is how two vocabularies drift. The
tradeoff accepted: a new tool now fails a test until somebody decides whether
people get it too, which is the point.

### 3. Permission is the route's own `Access`, read by one new admin predicate

`me.ts` gains `permits(me: Me, need: Access): boolean`: under `auth: 'open'` true;
a token actor false (a token never drives the admin, `me.ts:270-272`); `tier:
'platform'` reads `me.sites.platform` when `sites` is present and
`atLeast(user.role, need.role)` otherwise; `tier: 'scope'` is
`atLeastRole(me, need.role)`. A command is evaluated as
`permits(owner ? atScope(me, owner) : me, need)`.

The named predicates stay, and a parity test pins each to its constant:
`canEdit ≡ permits(·, EDIT)`, `canPublish ≡ PUBLISH`, `canCreateContent ≡ CREATE`,
`canManageContent ≡ MANAGE`, `canManageAssets ≡ ASSETS`, `canReadResponses ≡ FORMS`,
`canAdmin ≡ ADMIN`, `canDeleteForms ≡ SCOPE_ADMIN`, over open, viewer, editor,
publisher, admin, token, and multi-site actors on a scope and on the platform.

Rejected: each command naming a `can*` predicate. That re-derives, per command, the
mapping from an act to a role that the route already declares, and it is the drift
decision 2 exists to stop; with `need: Access` the verbs test can compare the
command's gate to the tool's directly.

### 4. What the person cannot do is absent; what cannot happen *now* is shown with its reason

A command whose `need` the person lacks is not in the list. A command that does not
apply (Unpublish on a page that is not live, Duplicate on a singleton, Switch locale
on a single-locale site, any editor command off the editor) is not in the list.
A command the person may run and that applies but is refused at this moment
(publishing in flight, a version preview open, nothing to publish, a full slot) is
shown, dimmed, with `blocked` as its secondary text; Enter on it announces the
reason in the palette's live region and does nothing else. This is
`design-system.md`'s rule, "if an action cannot apply, hide it; if it can apply but
will be refused, say why before the click", and the palette's version of the
editor's disabled-with-reason Publish button.

Rejected: showing role-refused commands disabled. In a list ranked by typing, a
viewer typing `p` would get three refusals above the page they wanted.

### 5. Contextual commands are registered by the screen that owns them, through a callback the shell holds in a ref

`ScreenArgs` gains `registerCommands: (commands: readonly Command[] | null) => void`,
the exact shape of `registerReload` (`Admin.tsx:324-327`). `EditorBody` builds its
commands every render from the values it already holds (`editor`, `owner`, `story`,
`status`, `setConfirm`, `setAdding`) and registers them in an effect whose cleanup
registers `null`. The shell keeps them in a ref and reads it when it builds the
palette's list. The palette therefore reads the registry as of its own render; it
re-renders on every keystroke, which is often enough for a list that lives a few
seconds.

The editor's `▾` menu items and the Publish button's disabled state are derived
from the same objects (Phase 5), so one declaration feeds the menu, the palette and
`⌘⇧A`.

Rejected: lifting the editor's state into the shell so the shell can build the
commands. `EditorBody` owns `useEditor`, the confirmations and the picker target;
moving them up is a refactor of the editor to serve one surface. Rejected: a React
context. The admin has none, `screenFor`'s comment (`Admin.tsx:801-806`) argues for
explicit props, and the ref callback already exists.

### 6. Local commands are ranked; server results keep the server's order and are never filtered by the client

The palette takes **sections**, not one flat list:

```ts
export interface PaletteRow {
  id: string;
  label: string;
  keywords?: string;
  hint?: string;          // a path, a shortcut, a brand
  blocked?: string;
  danger?: boolean;
  run: () => void;
}
export interface PaletteSection {
  name: string;
  rows: readonly PaletteRow[];
  /** `local`: ranked by `rank()` and dropped when they do not match.
   *  `remote`: already matched by the server; shown in the server's order,
   *  highlighted where `matchText` finds the query, never dropped. */
  kind: "local" | "remote";
}
```

A pure `arrange(query, sections)` in `rank.ts` returns the visible sections and the
flat option order the keyboard walks. That fixes the dropped-record bug at its
cause and implements `design-system.md` Resolved 2 as written: commands appear on
the first keystroke with no request, and the remote half never re-sorts the local
half.

Rejected: keeping one `rank()` over everything and adding the indexed values as
`keywords`. The server does not return which field matched, and it would make the
client a second, worse search engine over a page of twenty rows.

### 7. Search is three existing list routes in parallel, each kind found where its own screen lists it

On a non-empty query, after the 150ms debounce, the palette issues up to three
requests with one `AbortController` per keystroke (the previous one aborted):

| Group | Request | Scope | Asked when |
| --- | --- | --- | --- |
| Documents | `GET {base}/api/search?q=&sort=edited&limit=20` | the chain (the route's own rule) | always |
| Assets | `GET {base}/api/assets?q=&limit=5` | the scope's own library | `nav()` offers Assets |
| Forms | `GET {base}/api/forms?q=&limit=5` | the scope's own forms | `nav()` offers Forms |

Each is the route the corresponding screen already uses, behind its own
`requireAccess`, under the scoped `apiBase`, so multi-site fencing and the brand's
manifest come for free. Documents reach up the chain because the search route does
(a page in `shared` is readable and openable from a site); assets and forms do not,
because their screens show the scope's own and the palette must not offer a row its
own screen cannot open. A failed request is an empty group, as `useSearch.ts:77-80`
already decides.

On a branded deployment no admin code learns the brand: the manifest is fetched at
the scope's base (`Admin.tsx:178-185`), so `create_document` and `add_block` offer
that brand's types and blocks, and every request above is answered for that scope.
On a multi-site page with no scope, the palette offers only Switch site, Sites (when
`nav()` does), Account and Sign out, and issues no search: every list route answers
`400 site_required` there.

Rejected: a new aggregate `GET {base}/api/palette?q=` running three queries in one
request. It would restate three gates and three scope rules in one handler, and an
aggregate list is the shape that drifts from the screens' own lists. Three parallel
requests from a browser on HTTP/2 cost no more wall-clock time than one.

### 8. Recent, not frecent: a most-recently-used list of eight, per scope and per person, revalidated on open

When the palette opens with an empty query its first section is **Recent**: up to
eight entries, newest first, of two kinds, documents opened through the palette or
the editor, and commands run from the palette. Stored by a new
`useRememberedList(key, valid, limit)` in `remembered.ts`, comma-separated like
`useRememberedSet`, each entry `doc.<id>` or `cmd.<verb>` (an id's alphabet has no
comma, `server/validate.ts:68`), under
`folio.palette.recent.<boot.base>.<actor id or "open">`, so each scope and each
person on a shared browser has their own.

Only ids and verbs are stored, never titles. On open, the document ids are resolved
with one `GET {base}/api/stories?ids=` (chain-fenced, so a document deleted, moved
out of scope or no longer readable simply does not come back) and a `cmd.` entry is
shown only if a command with that verb is currently in the list, with its current
label and its current `blocked`. The local commands render at once; recent documents
appear when the batch lands.

Rejected: **frecency** (count times decay). It reorders entries under a person's
muscle memory, its constants have no answer a test can check, and the empty state
is the only place it would show. Rejected: storing titles for an instant render,
which puts another person's document titles in a shared browser's storage and
shows stale names after a rename. Rejected: a recency boost inside `rank()`, which
makes the same query rank differently from one day to the next.

### 9. Forms gain a `q`, on the internal route only

`ListFormsOptions` gains `q?: string`; when present, `listForms` adds
`(label like ? escape '\' or name like ? escape '\')` with one `likePattern(q)`
bound twice, inside the same chain clause, so `forms_updated` still leads with
`site_id`. `GET {base}/api/forms` passes `c.req.query("q")` through. The count
(`opts.count`) applies the same filter.

Rejected: filtering forms client-side from an unpaged list (every list route is
paged, `design-system.md` Resolved 2's "nothing may be unpaginated"). Rejected:
adding `q` to a v1 route: no v1 forms route exists, and a version segment is a
promise this spec has no reason to make.

### 10. The palette uses the one focus trap and the combobox pattern

The panel gets a ref, `tabIndex={-1}`, and `useFocusTrap(panel, onClose)`. The
trap's mount effect focuses the first tabbable element, which is the input, so the
ref-callback focus at `Palette.tsx:97` and the input's own Escape branch
(`:109-112`) are deleted: two Escape handlers would close the palette and then
whatever was under it. Options are not tabbable, so the cycle is the input alone and
Tab stays put.

ARIA, following the WAI-ARIA 1.2 combobox with listbox popup:

- input: `role="combobox"`, `aria-expanded="true"`, `aria-controls=<listbox id>`,
  `aria-autocomplete="list"`, `aria-activedescendant=<active option id>` (absent
  when there are no options);
- the results container: `role="listbox"`, `aria-label="Results"`;
- each section: `role="group"` with `aria-labelledby` its visible heading;
- each row: a `div` with `role="option"`, a `useId`-based `id`,
  `aria-selected={active}`, `aria-disabled` when `blocked`, `tabIndex={-1}`,
  `onClick`, and the `onMouseMove` that exists today. A row is not a `<button>`:
  a button inside a listbox is a second interactive role and a tab stop;
- a visually hidden `<p role="status">` inside the panel, mounted
  unconditionally (the `Toast` lesson), saying `"<n> results"` once the remote
  groups settle, `"No results"`, or a blocked command's reason on Enter. It is
  inside the panel because `aria-modal` hides the shell's own `Toast` from a
  screen reader that honours it.

`⌘K` toggles: pressed while the palette is open it closes it. Pressed while another
modal is open (any `[aria-modal="true"]` in the document that is not the palette's
own) it does nothing, so modals never stack.

Rejected: rows as buttons with roving `tabIndex`, `List.tsx`'s model. That model
moves DOM focus to the row, which takes it out of the input; a palette has to keep
typing in the input while the selection moves.

### 11. Running a command closes the palette first, in the same event

`run(row)` calls `onClose()` then `row.run()`. Both are state updates in one
handler, so React commits them together, and React runs every passive unmount
cleanup before any passive mount effect: the palette's trap returns focus to its
opener, and then a dialog the command opened (`CreateDialog`, `ScheduleDialog`, the
unpublish confirmation, `BlockPicker`) records that same opener as its own. A
command that navigates needs nothing more.

Rejected: keeping the palette open after a command (Raycast-style). Every command
here either navigates or opens a modal of its own, and a palette left under a
dialog is two modals.

### 12. Scheduling gets a dialog, reached from the palette and the `▾` menu

`screens/ScheduleDialog.tsx`, built on `Dialog`: an action (publish or unpublish,
fixed by the command that opened it), a `datetime-local` input interpreted in the
browser's time zone with the zone named beside it (`Intl.DateTimeFormat().resolvedOptions().timeZone`),
and Schedule / Cancel. On open it asks `GET {base}/api/schedules?story=<id>&status=pending`
and, when a pending row for the same action exists, says
"Replaces the publish scheduled for <local time>". It posts `POST
{base}/api/story/:id/schedule` with `{ action, at }` and shows the route's own
refusal text on a 400 (past, or more than ten years ahead). `schedule-model.ts`
holds the pure parts: `scheduleAt(localValue, now)` returning `{ at }` or
`{ error }` with `checkScheduleTime`'s wording, and the replace sentence.

Scheduling stays human-only: this spec adds no v1 route and no MCP tool for it.
Rejected: **adding `POST {base}/api/v1/...schedule` and a `schedule_document` tool so
the palette and agents share the act.** A v1 route is a versioned promise to scripts,
and nothing here needs an agent to schedule; an agent that wants a page live later
asks its person. `schedule_document` has no tool (no v1 route exists) and is on `HUMAN_ONLY`. Its
`need` is `PUBLISH`, the internal route's gate.

Rejected: entering the time in the palette's own input ("publish tomorrow 9am").
Natural-language dates are a parser with a locale problem, and the palette has no
second step anywhere else.

### 13. No host-registered commands

Hosts cannot register palette commands. The admin is a prebuilt, schema-driven bundle (`handbook.md:297-307`): a host's code
never runs in it, so a host command could only be declarative (a label and a URL),
which is a bookmark list nobody has asked for, or a server action, which is a new
route family and a new `createFolio` key and therefore an `exports` change under
semver. Neither is in this spec. The registry is internal (`ui/index.ts` is not an
export subpath; `package.json` `exports` names `./admin-entry` only for the admin),
so adding a host source later is an additive minor that changes nothing here.

### 14. `⌘⇧A` becomes real, as the shortcut for the `add_block` command

The shell's map gains `"mod+shift+a": () => runVerb("add_block")`, where `runVerb`
finds the registered command with that verb and runs it if present and not
blocked, and shows `blocked` in the toast if blocked. Off the editor nothing is
registered and the chord does nothing. The command's target is
`addTarget(doc, schema, selection)`; its `{ error }` branch becomes `blocked`.

## Wire & schema changes

### D1 migration

None.

### Core types

None. `Command`, `Verb`, `PaletteRow` and `PaletteSection` are admin-internal.

### New or changed routes

| Method | Path | Auth | Change |
| --- | --- | --- | --- |
| GET | `{base}/api/forms` | `READ` (unchanged) | New optional `q`: substring of `label` or `name`, bounded by `likePattern`. Absent or empty means unfiltered, as today. Applies to `count`. Response shape unchanged. |

No v1 route changes; no MCP tool changes.

## The command table

The complete set this spec ships. "Where" is the surface that registers it.

| Verb | Label | Where | Applies when | `need` (on) | `tool` | Calls |
| --- | --- | --- | --- | --- | --- | --- |
| `open_screen` | Go to <nav label> | shell | `nav()` lists it | null | — | client route |
| `create_document` | New <type label>… | shell | each `page` and `record` type in the manifest | `CREATE` | `create_document` | `CreateDialog`, `POST /stories` |
| `create_document` | New <page type> under <title>… | editor | open doc is routed; per `page` type | `CREATE` | `create_document` | `CreateDialog` with `parentId` |
| `publish_document` | Publish | editor | `editor.liveDoc` present | `PUBLISH` (owner) | `publish_document` | `requestPublish` |
| `unpublish_document` | Unpublish… | editor | `isLive(story.state)` | `PUBLISH` (owner) | `unpublish_document` | `setConfirm("unpublish")` |
| `schedule_document` | Schedule publish… | editor | always on a document | `PUBLISH` (owner) | — | `ScheduleDialog` |
| `schedule_document` | Schedule unpublish… | editor | `isLive(story.state)` | `PUBLISH` (owner) | — | `ScheduleDialog` |
| `duplicate_document` | Duplicate | editor | type is not `singleton` | `CREATE` (shown scope) | `duplicate_document` | `POST /stories/:id/duplicate`, then open the copy |
| `share_preview` | Share a preview… | editor | doc is routed and `me.mode === "session"` | `PUBLISH` (owner) | — | `setSharing(true)` |
| `list_versions` | Show history | editor | always | `READ` | `list_versions` | `setHistoryOpen(true)` |
| `add_block` | Add a block… | editor | not `readOnly` | `EDIT` (owner) | — | `setAdding(addTarget(…))` |
| `switch_locale` | Edit in <locale label> | editor | per available locale other than the current | `READ_DRAFT` | — | `editor.setLocale` |
| `switch_site` | Switch to <scope name> | shell | `showsScopeSwitcher(me)`; per choice other than the current | null | — | `switchScopeUrl`, page load |
| `open_responses` | Responses: <form label> | shell | per form search hit | `FORMS` | — | client route `responses` |
| `show_shortcuts` | Keyboard shortcuts | shell | always | null | — | `setKeys(true)` |
| `open_account` | Your account | shell | an actor exists | null | — | the user menu's item |
| `sign_out` | Sign out | shell | `me.mode === "session"` | null | — | the user menu's item, `danger` |

`blocked` for `publish_document` is exactly the Publish button's rule today
(`EditorShell.tsx:668-681`), extracted into `publishBlock(...)` in
`editor-model.ts` and read by both; the role half is dropped from it because a
role-refused command is absent (decision 4). `unpublish_document` is blocked with
"Close the version preview first" when a version is being viewed.

`HUMAN_ONLY` reasons: `schedule_document` (no v1 route), `add_block` (an agent writes
the tree with `write_content` or `patch_fields`; one block is a keystroke-level
`tx`), `share_preview` (a share link is for a person without an account),
`switch_locale` (an agent passes `locale` per call), `switch_site` (an agent is
scoped by the endpoint it connects to), `open_screen`, `open_responses`,
`show_shortcuts`, `open_account`, `sign_out` (navigation and session, no act).

`AGENT_ONLY` reasons: `get_schema`, `get_document`, `query_documents`,
`preview_document` (reads an agent needs and the editor already renders),
`search_documents` (the palette's Documents group *is* this route, internally, but
a search is a section, not a command), `write_content`, `patch_fields` (the editor
is the human form of these), `move_document` (needs a destination; Content's
`MoveDialog` and drag are the human form), `restore_version` (the history panel's
Restore), `delete_document` (deliberately not reachable from a palette; delete stays
behind the list screens' usage-counting confirmations), `upload_asset` (needs a file
picker; the media library's Upload).

## Acceptance criteria

### Commands appear by context and role

```
GIVEN a publisher with a live page open in the editor
WHEN they press ⌘K
THEN "Publish", "Unpublish…", "Schedule publish…", "Schedule unpublish…", "Duplicate",
     "Share a preview…", "Show history" and "Add a block…" are listed under the page's title
AND typing "pub" ranks "Publish" first among the commands
```

```
GIVEN an editor (not publisher) with the same page open
WHEN they press ⌘K
THEN none of Publish, Unpublish, Schedule or Share is in the list
AND "Duplicate" and "Add a block…" are
```

```
GIVEN a multi-site deployment and a publisher on bravo opening a page owned by shared
WHEN they press ⌘K
THEN Publish is absent, because the role is read on the owning scope, where they are a viewer
```

```
GIVEN the Content screen (no document open)
WHEN ⌘K opens
THEN no editor command is listed and "New <type>…" is listed for each page and record type of this scope's brand
```

### Blocked commands explain themselves

```
GIVEN a publisher viewing an old version in the editor
WHEN they choose "Publish" in the palette and press Enter
THEN nothing is published
AND the palette stays open and its live region says "Close the version preview first"
```

### Publish goes through the same path as the button

```
GIVEN a page with a locale missing translations
WHEN Publish is run from the palette
THEN the incomplete-locales confirmation opens, as the button opens it
AND focus is in that confirmation, and returns to the original opener when it closes
```

### Search stays in the scope and keeps the server's answers

```
GIVEN a record whose title does not contain "lead" but whose indexed role field is "Lead guide"
WHEN "lead" is typed
THEN the record is listed in Documents
```

```
GIVEN sites alpha and bravo each with an asset whose filename contains "hero"
WHEN an editor in ~alpha types "hero"
THEN Assets lists alpha's asset only
AND Documents lists alpha's and shared's pages, never bravo's
```

```
GIVEN a viewer
WHEN they type a form's label
THEN the form is listed and opening it opens the builder read-only
AND "Responses: <label>" is absent
```

### Recent

```
GIVEN an editor who opened pages A then B through the palette, and B was since deleted
WHEN they press ⌘K
THEN Recent lists A and not B
AND no title was read from localStorage
```

### Accessibility

```
GIVEN the palette is open
WHEN Tab is pressed
THEN focus stays on the input
WHEN ArrowDown is pressed
THEN aria-activedescendant names the next option and that option has aria-selected="true"
WHEN Escape is pressed
THEN the palette closes once, and focus returns to the element that opened it
```

```
GIVEN a Dialog is open
WHEN ⌘K is pressed
THEN no palette opens
```

### ⌘⇧A

```
GIVEN the editor with a block selected
WHEN ⌘⇧A is pressed
THEN the block picker opens targeting the slot after the selected block
GIVEN any screen other than the editor
WHEN ⌘⇧A is pressed
THEN nothing happens
```

### Scheduling

```
GIVEN a publisher on a page with a publish already scheduled
WHEN they run "Schedule publish…"
THEN the dialog names the existing time and says it will be replaced
WHEN they choose a time in the past and press Schedule
THEN the dialog shows "A schedule must be in the future. Publish now instead of scheduling." and posts nothing
```

### The vocabularies cannot drift

```
GIVEN a new row is added to MCP_TOOLS
WHEN pnpm test runs
THEN commands-verbs.test.ts fails until the tool is a command's `tool` or is on AGENT_ONLY with a reason
```

## Implementation plan

Phases 1 and 2 can run in parallel (different files). Phase 3 needs 1. Phase 4
needs 2 and 3. Phase 5 needs 3 and 4. Phase 6 is last. Every phase leaves
`pnpm typecheck`, `./node_modules/.bin/biome ci .` and `pnpm test` green.

### Phase 1: the command model and the permission predicate (pure)

1. `src/admin/me.ts`: add `permits(me, need)` per decision 3. Do not change any
   existing predicate.
2. New `src/admin/ui/commands.ts`: `Verb`, `Command`, `CommandGroup`
   (`"This page" | "Create" | "Go to" | "Switch site" | "Language" | "Account"`),
   `HUMAN_ONLY`, `AGENT_ONLY`, and the pure builders:
   `shellCommands(input)` (screens from `nav()` groups, `create_document` per type,
   `switch_site` per scope choice, `show_shortcuts`, the user menu's two items,
   each taking callbacks rather than calling `go` itself) and
   `visibleCommands(commands, me)` (drops `need` failures, evaluating `owner`).
   Every command's `keywords` includes its verb.
3. `src/admin/ui/screens/editor-model.ts`: `publishBlock({ publishing, liveDoc,
   live, nothingToPublish })` returning the reason string or undefined, and
   `editorCommands(input)` returning the editor rows of the command table, taking
   every value and callback as arguments so it stays pure.
4. `src/admin/ui/remembered.ts`: `useRememberedList(key, valid, limit)` and the
   pure `pushRecent(list, entry, limit)` it uses (move to front, de-duplicate,
   truncate).
5. Tests: `test/unit/admin/commands.test.ts`, `test/unit/admin/commands-verbs.test.ts`,
   additions to `test/unit/admin/me.test.ts` (see Testing requirements).

### Phase 2: forms `q` (server)

1. `src/server/forms.ts`: `ListFormsOptions.q`, the `like` clause from decision 9
   in both the page query and the count, using `likePattern` and `LIKE_ESCAPE`
   from `server/like.ts`.
2. `src/server/routes/forms.ts:231-252`: pass `q: c.req.query("q")`.
3. Tests: `test/workers/forms.test.ts` additions.

### Phase 3: the palette component

1. `src/admin/ui/rank.ts`: `PaletteSection`-aware `arrange(query, sections)`
   returning `{ sections: { name, rows: { row, spans }[] }[], order: PaletteRow[] }`;
   `local` sections ranked and filtered by `rank`, `remote` sections in input order
   with spans from `matchText` where it matches and none where it does not.
2. `src/admin/ui/Palette.tsx`: props become `{ sections, onClose, onQuery,
   announce? }` where `announce` is the string the live region shows (the shell
   computes "n results"). Apply decision 10 in full: `useFocusTrap`, delete the ref
   focus and the inline Escape, combobox / listbox / group / option roles,
   `aria-activedescendant`, `aria-disabled` and the `blocked` line, the live region.
   Enter on a blocked row sets the live region to its reason and keeps the palette
   open. Keep the `nextIndex` keys, the hover-to-activate, the scroll-into-view and
   the group-by-first-appearance rule.
3. `src/admin/ui/Palette.module.css`: `.rowBlocked` (secondary text in
   `--fg-subtle`, label at reduced contrast), `.visuallyHidden` for the live region
   (or the existing utility if `tokens.css` has one), a `.blocked` line. No
   `position: fixed` rule is added anywhere, so `ui-scope.test.ts:150`'s count of
   five holds. The active row keeps `background: var(--bg-selected)`; no inset
   `box-shadow` edge (CLAUDE.md's hover-control invariant).
4. `src/admin/ui/index.ts`: export `PaletteRow`, `PaletteSection` in place of
   `PaletteAction`.
5. Update `test/unit/admin/render/ui-scope-render.test.tsx:61` to
   `<Palette sections={[]} onClose={() => {}} />`. Add
   `test/unit/admin/render/palette.test.tsx`.

### Phase 4: the shell: search, recents, shell commands, ⌘K rules

1. Replace `src/admin/ui/useSearch.ts` with `usePaletteSearch(apiBase, active,
   kinds)` returning `{ query, setQuery, documents, assets, forms, settled }`: one
   debounce, one `AbortController` per query, the three requests of decision 7,
   `kinds` saying which of assets and forms `nav()` offers, nothing issued for an
   empty query or on a multi-site page with no scope.
2. `src/admin/ui/Admin.tsx`:
   - delete `usePaletteActions` (`:1144-1201`); build sections in a new
     `usePaletteSections` from `visibleCommands(shellCommands(...) ++ registered, me)`,
     the three search groups (documents as today's rows plus the record-type label
     hint; assets as `go({ name: "assets" }, { asset: id })` with the filename;
     forms as `go({ name: "form", id })`, plus `open_responses` rows when
     `permits(me, FORMS)`), and Recent;
   - `registerCommands` beside `registerReload`, threaded through `ScreenArgs`;
   - mount a shell-owned `CreateDialog` for `create_document`, posting through a
     new `createStory(apiBase, body)` in `src/admin/api.ts` extracted from
     `Content.tsx:1049-1068`, which `Content.tsx` and `Documents.tsx` then call;
     on success navigate to `edit` and record `doc.<id>` in recents;
   - `"mod+k"` becomes the toggle with the other-modal guard (decision 10), via a
     pure `otherModalOpen(root: ParentNode, own: Element | null)` in a new
     `src/admin/ui/modal.ts`;
   - `"mod+shift+a": () => runVerb("add_block")` (decision 14), `runVerb` reading
     the registered ref;
   - record a `doc.<id>` recent whenever the route becomes `edit` (one effect on
     `route.screen`), and a `cmd.<verb>` recent when a command row runs from the
     palette.
3. `src/admin/ui/screens/Keys.tsx`: `⌘K`'s row reads "Search, and run commands";
   `⌘⇧A`'s row now has a binding behind it.

### Phase 5: the editor's commands

1. `src/admin/ui/screens/EditorShell.tsx`:
   - compute `editorCommands(...)` in `EditorBody` and register them through the new
     `registerCommands` prop (effect, cleanup to `null`);
   - the Publish button's `disabled`/`reason` read `publishBlock(...)` plus the role
     half (`!mayPublish`, `whyNot`) it keeps, since the button stays visible to a
     non-publisher;
   - the `▾` menu's items become `[unpublish, schedulePublish, scheduleUnpublish]`
     mapped from the same command objects through a `toMenuItem(command, me)` in
     `commands.ts` (role-refused commands map to a disabled item with `whyNot`'s
     reason, because a menu that is already open shows its whole shape);
   - `schedule` state (`"publish" | "unpublish" | null`) and the `ScheduleDialog`
     mount.
2. New `src/admin/ui/screens/ScheduleDialog.tsx` and
   `src/admin/ui/screens/schedule-model.ts` (decision 12).
3. `src/admin/ui/screens/Documents.tsx`: its single-row duplicate calls a new
   `duplicateStory(apiBase, id)` in `src/admin/api.ts`, which the editor's
   `duplicate_document` command also calls before `onOpenDocument(copy.id)` and a
   toast "Duplicated <title>".
4. Tests: `test/unit/admin/schedule-model.test.ts`, additions to
   `test/unit/admin/editor-shell.test.ts`, `ScheduleDialog` added to
   `test/unit/admin/render/dialogs.test.tsx`.

### Phase 6: documents

As listed under "Documentation this implies".

## Documentation this implies

- `AGENTS.md`: a "Shared verbs" subsection under "Folio (CMS)", one table of verb,
  palette label and MCP tool, generated by hand from `commands.ts` and pinned by a
  `commands-verbs.test.ts` case that reads the table and compares its verbs to
  `Verb`. It states the rule: where a tool exists the verb is its name, and both
  gates are the route's `Access`.
- `docs/handbook.md`, the admin's keyboard section (the one that cites `⌘K`): what
  the palette finds, per kind and per scope; Recent; that commands are hidden by
  role and shown with a reason when blocked.
- `docs/ui-architecture.md`: the keyboard map row for `⌘K` ("palette: documents,
  assets, forms, screens, commands"); no change to `⌘⇧A`'s row, which is now true.
- `docs/design-system.md`: Resolved 2 gains a sentence that remote groups are no
  longer re-ranked (pointing at this spec's decision 6); the component table's
  `Palette` row names `PaletteSection`.
- `src/admin/ui/scope.ts:36` and `test/unit/admin/ui-scope.test.ts:119`: comments
  unchanged in substance; no new portal.
- `UPGRADING.md`: a `### Command palette (<tag>)` entry, named for the release tag
  that carries it so `release.yml` includes it in the notes, saying nothing is
  required of a host and that `GET {base}/api/forms` takes `q`.
- `docs/specs/README.md`: row 42 and its status, written by whoever records the spec.

## Edge cases

- **The open document's owner differs from the shown scope** → `owner` is
  `story.site`, matching `EditorShell.tsx:333`; `duplicate_document` alone reads the
  shown scope, because the copy lands there (`stories.ts:669-671`).
- **The editor is read-only for this person** (`canEditIn` false) → `add_block` is
  absent; publish commands follow their own `need`, so a publisher reading a page
  they cannot edit is offered nothing they cannot do.
- **A singleton** → no Duplicate (the route refuses, and Documents hides it).
  Publish and Schedule apply.
- **A record with no `previewPath`** → no Share (unrouted, `shareRefusal`).
- **`auth: 'open'`** → `permits` is true for everything; Sign out and Your account
  are absent (no actor); Share is absent, because `POST {base}/api/story/:id/share`
  sits behind `requireAuthConfigured` (`server/routes/preview.ts:151-153`,
  `server/middleware.ts:495-500`) and answers 404 there. Recents key on `open`.
- **The palette is open when the editor unmounts** (a peer deletes the page, the
  route changes) → the registration cleanup sets the ref to `null`; the open
  palette keeps the rows it rendered with until the next keystroke, and a stale
  row's `run` calls a setter on an unmounted component, which React ignores. The
  next render drops them.
- **Typing faster than the network** → each keystroke aborts the previous
  controller; an aborted fetch's rejection is not an empty-group answer and must
  not overwrite a newer one (the hook checks `signal.aborted` before setting state).
- **A `q` longer than D1's pattern limit** → truncated by `likePattern` on all
  three routes, never a 500.
- **Recents storage refused (private window)** → `useRememberedList` returns an
  empty list and writes are no-ops, as every remembered hook does.
- **A recent document now in another scope** → `?ids=` is chain-fenced, so it is
  absent from this scope's Recent and present in the other's, which has its own key.
- **`⌘K` pressed while focus is in the rich-text editor** → modified chords always
  fire (`shortcuts.ts:134-139`); the palette opens and the trap returns focus to
  the editor on close, where the selection survives because focus, not the
  document, moved.
- **A command row and a search row with the same label** ("Publish" and a page
  titled "Publish") → different sections, different ids; the command is first
  because local sections precede remote ones.
- **Zero commands and zero results** → the listbox has no options,
  `aria-activedescendant` is absent, the live region says "No results", and Enter
  does nothing.

## Testing requirements

**Unit (`test/unit/admin/`, Node):**

- `me.test.ts`: `permits` against each `Access` constant for open, viewer, editor,
  publisher, admin, a token, a multi-site site admin on its scope and off it, and a
  platform admin; the parity cases of decision 3, each named predicate against its
  constant over the same actors.
- `commands.test.ts`: `visibleCommands` drops a role-refused command and keeps a
  blocked one; `owner` is honoured (publisher on bravo, page owned by shared, no
  Publish); `shellCommands` emits one `create_document` per page and record type and
  none for a singleton, one `switch_site` per choice except the current, nothing
  scoped on a multi-site page with no scope; every command's `keywords` contains its
  verb; ids are unique.
- `commands-verbs.test.ts`: the five assertions of decision 2 against `MCP_TOOLS`,
  plus the `AGENTS.md` table check. Verify by breaking: add a fake tool row in a
  local copy of the table and confirm the test names it.
- `editor-shell.test.ts` (or a new `editor-commands.test.ts`): `editorCommands`
  per the command table's "Applies when" column; `publishBlock`'s four reasons in
  the order the button gives them; `add_block` blocked with `addTarget`'s error on a
  full root.
- `ui-rank.test.ts`: `arrange` keeps a remote row that `matchText` does not match,
  in server order; drops a non-matching local row; local sections first; `order` is
  the visible rows in render order.
- `remembered` cases (extend the existing file or add `remembered-list.test.ts`):
  `pushRecent` moves to front, de-duplicates and truncates at the limit; a stored
  value with an invalid entry reads back without it.
- `schedule-model.test.ts`: `scheduleAt` refuses a past value and one beyond ten
  years with the server's wording; parses a `datetime-local` value in the
  environment's zone; the replace sentence.
- `ui-shortcuts.test.ts`: the sheet still documents each chord once and still has
  no publish chord.

**Render (`test/unit/admin/render/`, happy-dom):**

- `palette.test.tsx`: the input has `role="combobox"` and `aria-controls` naming
  the listbox; ArrowDown moves `aria-activedescendant` and `aria-selected`; Tab
  leaves focus on the input; Escape calls `onClose` once; Enter on a blocked row
  does not close and writes its reason into the `role="status"` region; the region
  exists before any query; group headings label their groups; the portal root
  carries the scope class.
- `palette.test.tsx`, opener: mount a button, focus it, open the palette, run a
  command whose `run` mounts a `Dialog`; after both commit, the dialog's opener
  restore sends focus back to the original button when it closes (decision 11).
- `palette.test.tsx`: `otherModalOpen` is true with a `Dialog` mounted and false
  with only the palette.
- `dialogs.test.tsx`: `ScheduleDialog` assembles with a stubbed
  `GET /schedules` returning one pending row, and shows the replace sentence.
- `ui-scope-render.test.tsx`: updated props, unchanged assertions.

**Workers (`test/workers/`, real workerd):**

- `forms.test.ts`: `GET {base}/api/forms?q=` matches on label and on name,
  case-insensitively; `%` and `_` in `q` match themselves; a 200-character `q`
  answers 200; `count=1` with `q` counts the filtered set; under `~alpha`, `q` never
  returns bravo's form and, without `chain=1`, never returns shared's.

**End to end (`scripts/*.mjs`):** none. The scripts drive `fetch` and `WebSocket`
without a browser, and the one server change is covered by the workers test.

**Manual, before release:** the owner's browser pass on staging, VoiceOver on
macOS: open, type, arrow, the announced count, a blocked command's announcement,
Escape, and focus landing back on the TopBar button.

## Dependencies

- Spec 39 lands first (it changes `EditorShell.tsx` and the editor's top bar);
  this spec's Phase 5 rebases onto it.
- `GET {base}/api/search`, `/assets`, `/stories?ids=` and `/schedules` as they
  stand; spec 17's `pagination.md` decision 8 for the search route.
- No Cloudflare resource, binding or host configuration change.

## Out of scope

- **Deleting from the palette.** Delete is the one act whose confirmation needs a
  usage count and a redirect choice, and the list screens own that dialog;
  `delete_document` stays agent-only by the same reasoning `tools.ts:481-498`
  gives for narrowing it.
- **Block types as palette rows.** `BlockPicker` is already a ranked palette with
  presets and slot rules; `add_block` opens it rather than duplicating it.
- **A v1 route and MCP tool for scheduling.** The verb is reserved as
  `schedule_document` so a later tool takes the same name; adding a v1 route is a
  versioned promise this spec does not need to make.
- **Bulk commands over a Content selection.** The bulk bar owns selection state;
  the palette acts on one document.
- **Host-registered commands** (decision 13).
- **Fuzzy server search.** `ui-architecture.md` decision 7 stands: substring, not
  full-text.
