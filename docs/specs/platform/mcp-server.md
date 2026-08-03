# Feature: An MCP server, and the three verbs it needs

> **Group:** platform
> **Build order:** 24, per docs/specs/README.md
> **Size:** M–L — the endpoint is a few days; the render split and the screenshot are the rest
> **Status:** done
> **Wire version:** none — no socket frame changes shape, and MCP negotiates its own
> **Migration:** none — `api_tokens` already models a non-human caller
> **Last updated:** 2026-08-03

## Summary

`docs/feedback.md:76` asks for MCP servers "where claude/codex/etc. can help author
content and manipulate the content — basically all the same functions a person can do",
down to previewing a page before publishing. Nothing in the library speaks MCP today:
`grep -il "mcp\|anthropic\|openai"` over `packages/` returns nothing but a generated
`worker-configuration.d.ts`.

What *does* exist is almost all of the substrate. `{base}/api/v1` is fourteen
token-scoped routes over the same services the admin uses; every write goes through the
mutation log (`server/write.ts:5`), so an agent's edit already appears live in an open
editor, lands in the activity trail as `token:<name>` and comes back under Cmd+Z; and
`?_folio=preview` already renders a draft server-side behind a gate a bearer token
satisfies (`server/index.tsx:226`, `auth/resolve.ts:59`). The Harbour import
proved the whole path end to end: 23 documents and ~300 blocks authored by an agent
through a bare `fetch` against `{BASE}/api/v1{path}` with a token and nothing else.

So this spec is small in the middle and specific at the edges. It adds one endpoint,
`{base}/mcp`, whose every tool is an existing v1 route dispatched internally — and
because that rule is absolute, it first has to close the three places where v1 is *not*
yet parity with a person (unpublish, duplicate, restore), plus the one read an agent
needs before it can do anything at all: finding a document that has never been
published.

**The preview is the part that turned out not to be nearly done.** The bar is not "read the
content back", it is *see whether the page looks right* — which means an image, and means
photographing the right DOM. There is exactly one draft render today and it is the editing
one: `folio-editing` on the body, `position: relative` on every block, an extra
`<div class="folio-marker">` around any block whose `render` returns a component, and a
bridge that kills every link and outlines whatever the cursor touches. Verified on a live
render. Screenshotting that would verify layout against a DOM production does not serve,
with the difference concentrated in the one construct most likely to be the bug. So the
spec adds a second mode, `?_folio=draft` — which also fixes a shipped bug in spec 21, where
a client sent a draft to review gets the editor's outlines and dead links.

## Ground truth

**core (`packages/folio/src/core/`):**

- `protocol.ts:39` — `PROTOCOL_VERSION = 4`. **Nothing here touches it.** MCP is a
  request/response surface with no socket and no postMessage frame.
- `story.ts:231` — `StoryFilter`: `parentId`, `type`, `state`, `q` (substring over
  title, slug and path), `locale`, `routed`. One flat serialisable object, already read
  by three callers (`pagination.md` decision 9). This is the shape a search tool wants
  and it exists.
- `nested.ts:186,287` — `toNested` / `fromNested`. The document shape v1 speaks, with
  `fromNested`'s `mode: 'merge' | 'replace'` and `fieldShapeError` for the message a
  caller gets back when a payload does not fit the schema. **This is the validation loop
  an agent learns from**, so nothing new needs writing to teach it.
- `diff.ts:28` — `diff(from, to): Mutation[]`. In `core`, not in `server`, which is why
  a server-side restore is possible at all (see server, below).

**server (`packages/folio/src/server/`):**

- `app.ts:87` — `app.route` mounts `apiRoutes<Env>(rt)` at `/api/${API_VERSION}`, first
  and **after `withActor`**, so a token and a session cookie are resolved by the same
  middleware for every route under it.
- `routes/api/index.ts:33` — `API_VERSION = 'v1'`. `:47` `/schema` at `READ`. `:76,:83`
  `/assets` at `READ` / `ASSETS`.
- `routes/api/documents.ts` — the surface, in full:

  | Method | Path | Access |
  | --- | --- | --- |
  | GET | `/documents` | `READ` (`:221`) |
  | GET | `/documents/:id` | `READ` (`:238`) |
  | GET | `/documents/by-path[/:path]` | `READ` (`:274`,`:275`) |
  | GET | `/documents/:id/versions` | `READ` (`:289`) |
  | POST | `/documents` | `CREATE` (`:319`) |
  | PUT | `/documents/:id/content` | `EDIT` (`:379`) |
  | PATCH | `/documents/:id/fields` | `EDIT` (`:417`) |
  | PATCH | `/documents/:id` | `MANAGE` (`:475`) — title, slug, parent, position |
  | DELETE | `/documents/:id` | `MANAGE` (`:498`) |
  | POST | `/documents/:id/publish` | `PUBLISH` (`:517`) |
  | POST | `/documents/:id/versions` | `PUBLISH` (`:538`) — checkpoint |

- `routes/api/documents.ts:69-81` — `ApiDocumentMeta` carries `url` and **not
  `previewUrl`**, although `meta()` at `:137` computes `rt.withUrls(story)` — which
  produces both (`runtime.ts:422-428`) — one line above. A one-field omission, and it is
  the only thing standing between an agent and an addressable draft.
- `routes/api/documents.ts:227` — the route's own words: *"This route queries published
  content only. A draft lives in its own Durable Object, so it is read one document at a
  time: GET /documents/:id?status=draft."*
- `routes/content.ts:116` — `queryFromParams` ends `status: 'published'`, hardcoded.
  Shared verbatim by the admin's `/api/content` and by v1's `/documents`
  (`content.ts:130`). **So no v1 read can enumerate a document that has never been
  published**, which is the first thing an agent asked to "update the pricing page" needs
  to do.
- `routes/stories.ts:304` — `GET {base}/api/search`: `searchStories` + `storyFilterQuery`
  + `searchKindQuery`, keyset-paged, answering `Page<StoryMeta>` over D1 rows regardless
  of publication state. Internal, so not a contract. The machinery a v1 twin needs is
  `stories.ts:824` (`searchStories`), `validate.ts:893` (`storyFilterQuery`) and
  `stories.ts:730` (`countStories`).
- `write.ts:89` — `commitAll(stub, mutations, actor, key?)`: chunks at
  `MAX_TX_MUTATIONS`, and **an empty mutation list writes nothing at all** — no
  transaction, no broadcast, no watermark bump.
- `write.ts:175` — `writeDocument(deps, target, actor, key?)`: read the draft, diff a
  target against it, commit. `PUT /content` in three lines, and **exactly what a restore
  route is**: `writeDocument(deps, () => versionDoc, actor)`.
- `write.ts:52-71` — `txIdFromKey`. `Idempotency-Key` rides the log's own `tx_id` dedupe;
  the key is opaque to Folio and scoped per document, because the log is.
- `versions.ts:93` — `getVersion(db, id, migrate?)` answers `{ meta, doc, migrated }`,
  **migrated on read**, precisely so a `diff(live, target)` across a schema change does
  not reintroduce pre-migration keys.
- `publish.ts:192` — `unpublish(...)`, written against D1 alone (spec 1) so a caller with
  no `Request` can reach it.
- `documents.ts:72` — `duplicateDocument<Env>(...)`, the one place that batches
  `deleteStoryStatement`'s five arrays' counterpart for a copy.
- `auth/roles.ts:43` — `SCOPES`: `content:read`, `content:read:draft`, `content:write`,
  `publish`, `assets:write`, `admin`. `:64` `IMPLIES`, spelled out rather than derived
  because the relationships are not a chain. `:73` `hasScope(granted, need)`.
- `auth/roles.ts:122-125` — `actorString`: a user's id, or `` `token:${actor.name}` ``.
  This is what lands in `versions.actor` and the DO's log.
- `auth/resolve.ts:33-38,52-61` — `credentialOf` reads **both** the session cookie and
  `Authorization: Bearer`; `resolveActor` tries the cookie first, then `readToken`.
  Cookie-first is a cost decision, not a precedence puzzle.
- `index.tsx:226-319` — the `?_folio=preview` branch. It resolves an actor from
  `credentialOf(req)` and requires `READ_DRAFT` (`:259-265`), refusing by handing the
  request **back** to the host rather than by answering 401. Then `storyByPath`,
  optionally a share-cookie grant, optionally `?as=<global>`, and `previewPage(...)`.
  **A bearer token with `content:read:draft` can already GET rendered draft HTML at any
  page's URL.**
- `index.tsx:354-370` — `folio.write(env, id, mutations, opts)`, the in-process write, so
  a nightly job, a deploy step and the HTTP route reach identical code.
- `routes/editor.ts:167` — `GET {base}/preview/global/:name` at `READ_DRAFT` via
  `requireHtmlAccess` (`middleware.ts:128`), which reads `c.var.actor` — so a token
  reaches this too. The bare preview for a singleton, which has no page URL of its own.
- `routes/bulk.ts:113,128,144` — `/bulk/publish|unpublish|duplicate` (`:113`, from a
  table), `/bulk/move` (`:128`), `/bulk/delete` (`:144`). All under `{base}/api/`, all
  explicitly *not* a contract.
- `errors.ts:12-37` — `FolioErrorCode`: `bad_request`, `unauthorized`, `forbidden`,
  `not_found`, `conflict`, `too_large`, `unsupported`, `incomplete`. `:40` the eight
  statuses. One envelope, and the only place a message becomes client-visible.
- `package.json` — nine runtime dependencies: five tiptap, `fractional-indexing`, `hono`,
  `valibot`, and that is the list.

**migrations:**

- `0001_init.sql:124` — `create unique index stories_parent_slug`; `:129`
  `stories_type_slug` for unrouted documents; `:112` records that **any UNIQUE violation
  maps to `conflict`**. A double create at the same parent and slug is already a 409, so
  the one non-idempotent write an agent is likely to repeat is already guarded by the
  schema.
- `0001_init.sql:312` — `api_tokens`, with `scopes` as a JSON array (`parseScopes`,
  `roles.ts:80`).

**admin (`packages/folio/src/admin/`):**

- `hooks/useVersions.ts:367-422` — `restore`. Fetches the version, `diff(live, target)`,
  refuses over `MAX_TX_MUTATIONS`, `store.tx(mutations)` over the socket. **There is no
  restore endpoint anywhere**: the diff is computed in the browser. An agent would have to
  reimplement it, which is the fork this library avoids everywhere else.

**preview (`packages/folio/src/preview/`, `server/pages.tsx`):**

- `server/pages.tsx:182` — `previewPage` sets `bodyClass="folio-editing"`. `:218` renders
  `<FolioDoc … edit={!editing} …>`. **There is exactly one draft render and it is the
  editing one.**
- `preview/preview.css:3` — `.folio-editing [data-folio-uid] { position: relative }`, on
  every marked block. `:8-25` the hover and selected outlines, drawn as an `::after`.
- `preview/Render.tsx:143-144` — `data-folio-uid` and `data-folio-type`, cloned onto the
  block's own host element when there is one. `:161` — the fallback: a block whose `render`
  returns a component gets an extra `<div class="folio-marker">`, and the comment states
  the cost: *"in edit mode only … as a direct child of a grid or flex container it can
  shift."*
- `preview/Render.tsx:121` — `if (!edit) return el`. **One flag gates both**: the uid
  attributes and the marker wrapper arrive together or not at all. So there is no existing
  render that is addressable *and* geometrically identical to production, which is exactly
  what a screenshot wants. Decision 5a says what to do about the two-block remainder.
- `preview/mount.tsx:180` — `attachBridge()`, called **unconditionally** by
  `mountPreview`. `:129-135` `e.preventDefault()` on any click inside a marked block, so
  no link navigates; `:142-147` a `mouseover` handler that sets `data-folio-hover`, so a
  dashed outline follows the cursor. Neither is gated on being inside the admin's iframe.
- `preview/mount.tsx:104` — the editor finds a block with a `[data-folio-uid="…"]`
  `querySelector`, which is how it
  editor selects a block. **The same selector is what makes a per-block screenshot
  possible**, and it exists only because the visual editor needs it.
- **Verified on a live render** (AAA dev server, bearer token,
  `/guides/east-africa?_folio=preview`): 200, 345KB, `<body class="folio-editing">`, 82
  `data-folio-uid` attributes, 2 `folio-marker` wrappers. So both halves are real — a
  token does reach a rendered draft, and what it reaches is not the published DOM.
- `routes/preview.ts:248` — a share link's response redirects to
  `rt.withUrls(story).previewUrl`, i.e. into the `preview` mode above. **So spec 21's
  client-review links carry the editing chrome today**, which is a bug rather than a
  decision.

**tests:**

- `test/workers/api-partition.test.ts:96` — `V1_SEGMENTS = ['schema', 'documents',
  'assets']`, and `:98` asserts **the v1 surface is exactly that list**: any internal
  segment must 404 under both `v1` and `v2`. `:118-128` does the same for POST-only
  internal routes, naming all five `/bulk/*` paths explicitly. Adding a v1 route means
  adding it here, deliberately.
- `test/workers/api.test.ts` (39K) — the v1 surface's own coverage, the file a new route's
  tests belong in.

## Owner decision checkpoints

1. **Browser Rendering is a paid Cloudflare add-on and a binding the owner has to
   provision.** Everything in this spec works without it except the screenshot, which is
   the one thing the owner actually asked `preview_document` for. **Recommendation: build
   it as an optional binding and provision it.** The alternative — no image, ever — makes
   the tool a slower `get_document`, and the alternative to *that* is trusting the agent's
   own browser, which claude.ai and any headless client do not have. The cost is per
   screenshot rather than standing, and a screenshot is taken deliberately.

   *Resolved 2026-08-03:* agreed.
2. **Should `{base}/mcp` be opt-in per host?** It is one more authenticated endpoint on
   every deployment that upgrades. **Recommendation: on by default, off via
   `createFolio({ mcp: false })`.** It is gated by the same token table as `/api/v1`, so
   "on" adds no reachable surface that a token could not already reach — but a host with
   no tokens minted should be able to say so in config rather than by inference.

   *Resolved 2026-08-03:* agreed — on by default, `mcp: false` to opt out.
3. **Do the write tools require a confirmation argument?** An MCP client shows a
   permission prompt before a tool call, so a second in-band confirmation is redundant in
   Claude Code and absent in a headless client. **Recommendation: no.** The tool list is
   the boundary (decision 6), and `delete_document` is the one case where the argument
   would be for something real — a mistaken delete leaves redirects but not content.
   Named rather than decided because it is a product judgement about blast radius.

   *Resolved 2026-08-03:* agreed — no confirmation argument; `delete_document` stays
   behind `admin` instead.

## User stories

### Editing a page by asking

**As** an editor **I want to** tell an assistant "change the East Africa visa fee to
US$120 and add a sentence about the Irembo portal" **so that** a copy change does not
need me to find the page, find the block and find the field.

### Finding the page first

**As** an assistant **I want to** search documents by title, path and state — including
pages that have never been published — **so that** "the pricing page" resolves to an id
without the person having to paste a URL.

### Seeing whether the draft looks right

**As** an editor **I want to** ask "does that section look right?" and have the assistant
*look* **so that** a block it just wrote is checked for a broken layout, a missing image
or text that overflows — not merely confirmed to contain the words I asked for.

### Reviewing a draft as a client

**As** a publisher **I want to** send a share link that renders the draft as the site will
serve it **so that** the person reviewing it is not distracted by editor outlines and can
click the links on the page.

### A trail that names the agent

**As** a publisher **I want to** see `token:claude` in a page's activity **so that** an
edit I did not make is attributable to the thing that made it, and revertible.

### Refusing what the token cannot do

**As** an administrator **I want to** mint a `content:read` token for an assistant that
only summarises **so that** the write tools are not merely refused but never offered.

## Architecture decisions

### 1. The MCP server is a route in the Worker, not a package on a laptop

`{base}/mcp`, served by the host Worker that already serves `{base}/api/v1`, speaking
Streamable HTTP.

**Rejected: `packages/folio-mcp`, a stdio server.** It needs Node, an install step, its
own build (spec 22 settled what ships and this would reopen it), and its own copy of the
token handling. It is unreachable from claude.ai and from any hosted client. Worst, it
versions independently of the deployment it talks to, so a site that upgrades Folio has a
local server that is subtly behind — the exact class of problem the library avoids by
shipping the admin *with* the server.

A route means every Folio deployment has an MCP endpoint the moment it upgrades,
authenticated by the token table it already has, with no second artifact to distribute.

**Rejected as the whole answer, kept as Phase 0: a documented skill that teaches an agent
to curl the API.** This works *today* — it is what the AAA import did — and it costs
nothing, so it should exist regardless. What it cannot do: filter what the agent may
attempt by scope, present structured errors a client can act on, or survive a session
boundary without re-deriving the API from prose. A skill is a good stopgap and a bad
contract.

### 2. Every tool is a v1 route, dispatched internally. There is no second implementation

The tool table names a `{method, path}` pair. The handler builds a `Request` for that
path, copies the caller's `Authorization` header onto it, and calls the mounted app's own
`fetch` with the live `ExecutionContext`. No network hop — it is a function call — and
the v1 handler runs with its own middleware, its own validator, its own gate and its own
error envelope.

**Rejected: each tool calls the service functions directly** (`createStory`, `publish`,
`writeDocument`). It reads cleaner and it forks three things at once: the access gate, the
input validation, and the nested-shape translation. The fork is invisible on the day it is
written and becomes wrong the first time a v1 route narrows a scope — `POST
/documents/:id/versions` is already a deliberate narrowing from the spec's own route table
(`documents.ts:532`), and a direct-call tool would have missed it.

The cost is one extra `readToken` per tool call, because `withActor` resolves the
credential again for the sub-request. That is one indexed D1 read against a table with a
unique index on the hash. Naming it rather than optimising it: a signed internal header
that skips the gate is how a gate stops being one.

**The consequence is the point.** A verb that is not a v1 route cannot be a tool, and a
tool cannot quietly reach further than the API does. That constraint is what forces
decision 3 instead of letting it be deferred.

### 3. Three verbs move onto v1 first, because the bar is parity with a person

`feedback.md:100` enumerates the list and says to hold the MCP to it: *create, edit, move,
duplicate, publish, unpublish, restore a version, upload an asset, read the schema.* Six
are on v1. Three are not:

| Verb | Today | Becomes |
| --- | --- | --- |
| unpublish | `POST {base}/api/bulk/unpublish` only | `POST /api/v1/documents/:id/unpublish` at `PUBLISH` |
| duplicate | `POST {base}/api/stories/:id/duplicate`, `/bulk/duplicate` | `POST /api/v1/documents/:id/duplicate` at `CREATE` |
| restore | nothing — computed in the browser | `POST /api/v1/documents/:id/restore` at `EDIT` |

Each is a service function away: `unpublish` (`publish.ts:192`), `duplicateDocument`
(`documents.ts:72`), and for restore, `getVersion` (`versions.ts:93`) piped into
`writeDocument` (`write.ts:175`) — which is the same read-diff-commit `PUT /content`
already is, with the version's document as the target instead of a payload's.

**Rejected: point the tools at `{base}/api/bulk/*` for the first two.** A version segment
is a promise and the absence of one is the absence of a promise —
`api-partition.test.ts:118-128` names all five bulk paths specifically so that
`{base}/api/v1/bulk/publish` fails CI. A tool built on an unversioned internal route
breaks on an admin refactor with no warning and no deprecation, which is precisely the
failure the two-surface split exists to prevent.

**Restore is the interesting one, and it is a genuine improvement to the library rather
than scaffolding for this spec.** Computing `diff(live, target)` in the browser means the
admin is the only client that can restore, and it means the `MAX_TX_MUTATIONS` refusal is
a client-side courtesy. Moving it server-side puts one implementation behind both callers.
The admin's hook should then call the route — but that is a follow-up, not a precondition,
because the hook works and rewriting it is a UI change with its own risk. Noted in the
plan as phase 5 and explicitly optional.

### 4. Discovery is a new keyset-paged `GET /api/v1/search`, and that does not contradict pagination decision 1

`queryFromParams` ends `status: 'published'` (`content.ts:116`), so every v1 read that
does not already know an id or a path can only see published content. An agent's first
move is "find the page about X", and on a site mid-build most pages have never been
published. Today that request cannot be answered at all.

**Rejected: relax `status` on `GET /api/v1/documents`.** That route is `collections.md`'s
published-content engine over `content_index`, and a draft has **no index rows** — the
projection is written at publish. "Include drafts" is not a flag on that query, it is a
different query against a different table. Overloading it would mean one route whose
`where` clauses silently stop working depending on another parameter.

So: a v1 twin of the admin's `/api/search` (`stories.ts:304`), over `searchStories` and
`StoryFilter`, answering `Page<ApiDocumentMeta>`.

**It pages by keyset cursor, and `pagination.md` decision 1 says `/api/v1` keeps page
numbers.** That decision's *reason* is the audience and the data: page numbers are correct
for "a listing over published content, which by definition does not move between requests
the way a draft tree does", and keyset is correct for a live list because "over live
content offset silently skips and repeats rows". A search across the draft tree is a live
list. Applying the rule's letter here would break the rule's reason, so this route follows
the reason and the spec says so out loud rather than leaving a future reader to think the
partition drifted. `Page<T>` and `ContentPage` are already different types on purpose;
this route answers the former.

### 5. There is one draft render and it is the editing render, which is the wrong thing to photograph

`feedback.md:105` calls preview "the one item on the note that the content API does not
already reach", and that was true when it was written. At the HTTP layer it is not true
now: `?_folio=preview` renders the draft server-side (`index.tsx:226`) and its gate
resolves an actor from `credentialOf(req)` (`:260`), which reads `Authorization: Bearer`
(`resolve.ts:36`). **Verified against a live render** — a bearer token fetching
`/guides/east-africa?_folio=preview` answers 200 and 345KB of the draft.

What that render *is*, however, is the editor's view of the page, not the page:

- `pages.tsx:182` sets `bodyClass="folio-editing"`, and `preview.css:3` turns that into
  `position: relative` on **every** marked block.
- `pages.tsx:218` renders `<FolioDoc edit={!editing}>`, so `Render.tsx:161` wraps any
  block whose `render` returns a *component* rather than a host element in an extra
  `<div class="folio-marker">`. The source comment states the cost exactly: *"in normal
  flow that is invisible; as a direct child of a grid or flex container it can shift."*
- `mount.tsx:180` calls `attachBridge()` **unconditionally**, which draws a dashed blue
  outline on whatever the cursor is over (`:142-147`) and calls `e.preventDefault()` on
  every click inside a marked block (`:129-135`), so no link navigates.

The same live render confirms it: `<body class="folio-editing">`, 82 `data-folio-uid`
attributes, and 2 `folio-marker` wrapper divs that the published page does not have.

**So a screenshot of `?_folio=preview` verifies layout against a DOM production does not
serve, and the difference is concentrated in exactly the construct most likely to cause
the bug an agent is being asked to catch** — an extra grid child. Answering "does this
look right" with that render would be worse than not answering it.

Therefore the preview branch gains a second mode: **`?_folio=draft`**, which resolves and
renders the identical document with `edit={false}`, no `folio-editing` body class and no
bridge. Same gate, same locale handling, same refusal-by-handing-back. It is the draft as
the site would serve it.

**Rejected: strip the chrome at screenshot time** by injecting CSS through the headless
browser. It can hide the outlines and it cannot remove the marker `<div>`, which is the
one that moves the layout. A screenshot that is right about colour and wrong about
geometry is the worst of the options.

**Rejected: `?_folio=preview&chrome=0`** as a parameter on the existing mode rather than a
second mode. The two differ in what they *are* for — one is an editing surface with a
postMessage bridge, one is a page — and `handle()`'s branch already reads `_folio` as a
mode name. A boolean modifier on a mode is how you end up with four combinations and two
of them meaningless.

**This fixes a shipped bug in spec 21, and that is a sanctioned behaviour change.** A
share link redirects to `rt.withUrls(story).previewUrl` (`preview.ts:248`), which is the
`preview` mode — so a client sent a draft to review today gets dashed blue rectangles
following their cursor and every link on the page dead. Nobody decided that; it is what
having one render costs. `shareUrl` points at `draft` instead, and the admin's iframe
keeps `preview`.

Also, smaller: `ApiDocumentMeta` does not carry `previewUrl` though `meta()` calls
`rt.withUrls(story)` (`documents.ts:137`), which computes it. Add the field, and a
`draftUrl` beside it for the new mode.

### 5a. The screenshot is a `browser` binding, scoped to a block by the editor's own selector

`preview_document` returns an **image**. MCP tool results carry
`{ type: 'image', data, mimeType }`, so a model can genuinely look at the page rather than
infer it from markup — which is the point of the tool, and the reason it is not just
`get_document` with extra steps.

The renderer is Cloudflare Browser Rendering, bound as `browser`, fetching the `draft`-mode
URL with the caller's credential as a header. **Optional, and its absence is a legible
refusal**, exactly as the media bucket already works (`routes/api/index.ts:85`: `if
(!media) throw new FolioError('unsupported', 'No media bucket is configured')`). With no
binding the tool answers the URL and the rendered HTML instead, and says which it gave —
an agent that has its own browser can then go and look, and one that does not can still
check that the content is present.

**Full-page is not the default, and a viewport is an argument.** An AAA guide renders
about 12,000px tall; a full-page PNG of it downscales into something no model can read, so
`fullPage` is opt-in. `viewport` defaults to 1440×900 and takes a mobile size, because a
responsive break is the single most likely visual defect and the one that is invisible in
markup.

**The most useful scope is one block, and it is nearly free.** `blok: <uid>` clips the
screenshot to `[data-folio-uid="<uid>"]` — the selector the visual editor's own
`markSelected` already relies on (`mount.tsx:104`). So "screenshot the callout I just
edited" costs one small image instead of a page, and the addressing exists only because
the visual editor needed it.

"Nearly", because `Render.tsx:121` is `if (!edit) return el`: **the uid attribute and the
marker `<div>` are one flag today**, and the marker is the thing that shifts a grid. They
have to separate, and the split cannot be clean:

- A block whose `render` returns a **host element** carries its uid as an attribute on that
  element. No extra node, production geometry, clippable. This is 80 of AAA's 82.
- A block whose `render` returns a **component** has nowhere to put the attribute, which is
  why the marker exists. In `draft` mode it does not get one.

So `draft` mode emits **uids on host elements only, and no marker divs**. A `blok` naming
an unclippable block falls back to the viewport screenshot and says which it did.

**Rejected: keep the marker div in `draft` mode so every block is clippable.** It would
buy clipping for the 2 blocks in 82 by reintroducing, for those same blocks, the extra grid
child that is the most likely visual defect on the page. The tool exists to see that class
of bug, so it must not be the thing causing it.

**Rejected: `display: contents` on the marker.** No box, so no bounding rect, so no clip —
the same reason `Render.tsx:150` gives for not using it for the outline.

**Rejected: return the URL and let the client screenshot it.** The client would need the
token, and a client holding the raw token reaches every route the token allows — strictly
more than the tool list allows (decision 6). It also assumes a client with a browser,
which claude.ai and a CI agent are not.

**Named because it is a real limit, not a detail: this does not work against `pnpm dev`.**
Cloudflare's browser is remote and cannot reach `localhost:5199`, so in local development
the tool takes the no-binding path and returns the URL. Same shape as
`scripts/cache-probe.mjs`, which needs a deployment because Workers Cache does not exist
locally — a tool, not a test, and no CI can gate it.

**A record and a singleton have no page URL** (`document-types.md` decision 2;
`withUrls` leaves `url`/`previewUrl` absent rather than `''`). For a declared global the
tool uses `{base}/preview/global/:name` (`editor.ts:167`), which takes the same actor. For
a plain record there is nothing to render and the tool says so rather than erroring.

### 6. The tool list is filtered by the token's scopes. A tool you cannot call does not appear

`tools/list` is built per request from `hasScope(actor.scopes, need)` (`roles.ts:73`),
using the same `Access` declaration the route carries.

**Rejected: advertise every tool and let the call fail with 403.** Two reasons, and the
second is the real one. A model that can see `publish_document` will try it, and a 403
mid-task reads as a malfunction rather than as a boundary — it burns a turn and often
provokes a workaround. More importantly, **the tool list is the only place an agent learns
what it may do.** A list that overstates the grant is a lie told at the one moment the
agent is deciding what to attempt.

A token actor is the ordinary case; a session cookie also reaches here, and a `UserActor`
is filtered by role through the same `Access` pair (`roles.ts:139`) with no special case.

### 7. One `write_content` tool, not one tool per block type

`rt.manifest` holds every block schema and is already JSON, which tempts the obvious move:
generate `create_hero_block`, `create_callout_block`, forty of them, from the manifest.

**Rejected.** MCP clients discover a tool list once per session and cache it. A list
derived from a host's schema changes shape when the host deploys a block, so two sessions
against the same site disagree about what exists, and a client that reconnected mid-task
finds its tools renamed. It also scales wrongly: AAA alone would contribute more than
thirty tools whose only difference is a field list.

Instead: `get_schema` (the manifest, from `GET /api/v1/schema`), plus `write_content` and
`patch_fields` whose input is the nested shape `fromNested` already validates. When a
payload does not fit, `fieldShapeError` is the message that comes back, naming the block
and the field — a validation loop the library already has and already tests.

The tool *description* names the site's declared block and document type names — a bounded
list of strings, not their fields — because that is dynamic per session at zero cost and
saves the agent one round trip to learn what a document may contain. The fields come from
`get_schema`.

### 8. `{base}/mcp`, outside the `/api` partition, and deliberately unversioned

**Not under `/api`.** An unmatched path under `/api` terminates in Folio's JSON 404
envelope (`app.ts:144`), and every route under it answers `errors.ts`'s single shape. MCP
answers JSON-RPC: a 200 carrying an `error` object with its own code space. One prefix with
two error envelopes is exactly the sibling-confusion `api-partition.test.ts` exists to
prevent, and the partition test gains an assertion that `/api/mcp` and `/api/v1/mcp` both
404 so the rule stays whole rather than merely unviolated.

**Unversioned.** MCP negotiates its own version in `initialize`, and tools are *discovered*
per session rather than compiled against — so renaming a tool costs a client one
reconnect, not a deploy. A `{base}/mcp/v1` would be a second version ledger tracking a
protocol that already has one.

### 9. Hand-rolled JSON-RPC, no MCP SDK, no SSE

The subset is four messages: `initialize`, the `notifications/initialized` acknowledgement,
`tools/list`, `tools/call`. Streamable HTTP permits a plain JSON response to a POST, and
this server never initiates a message to the client — no sampling, no server-side
progress, no subscriptions — so there is no stream to hold open and no session state to
keep. Each POST is answered and forgotten, which also means no Durable Object.

**Rejected: `@modelcontextprotocol/sdk`.** Folio has nine runtime dependencies and an
argument for each. This one is Node-shaped, brings a transport layer built for a process
rather than for a request, and its failure mode is a runtime the library does not control —
which is the same class of problem as `react-dom/server.edge` being CJS
(`vite/index.ts:43`), a bug whose stack named neither Folio nor the package. The subset
above is a day's work and every line of it is testable in workerd.

**Consequence worth naming:** a stateless server cannot support `resources` or `prompts`
later without revisiting this. Both are out of scope with reasons, and neither needs state
if it comes.

### 10. Attribution stays the token, and that is the requirement rather than a shortcut

`actorString` already answers `` `token:${actor.name}` `` (`roles.ts:124`), so a token
named `claude` produces `token:claude` in `versions.actor`, in the DO's log and in the
activity trail. `feedback.md:111` asks for exactly this: *"attributable in the activity
trail as the agent, not as whoever minted the token."*

**Rejected: a third `Actor` kind for an agent.** It would need a role or a scope set of its
own, `allows()` would need a third branch, and it would buy nothing — a token already *is*
the model of a non-human caller, which is why `SCOPES` exists separately from `ROLES`
(`roles.ts:38`).

What this does not give is "Claude, on behalf of Sam". That needs the MCP session to carry
a user identity, and the honest version is a per-user credential rather than a shared
token. Out of scope, with the reason, below.

### 11. No `Idempotency-Key` plumbing, because the two writes that matter are already safe

An agent retries. The obvious move is to have the MCP layer mint an `Idempotency-Key` per
tool call, and it is unnecessary:

- **Content writes are idempotent by construction.** `PUT /content` and `PATCH /fields`
  are read-diff-commit, and `commitAll` writes nothing at all for an empty mutation list
  (`write.ts:83-87`). A replayed identical write is a no-op that reports `changed: 0`.
- **A double create is already a 409.** `stories_parent_slug` is a unique index
  (`0001_init.sql:124`), `stories_type_slug` covers unrouted documents (`:129`), and any
  UNIQUE violation maps to `conflict` (`:112`). An agent creating "Pricing" twice under the
  same parent gets a refusal it can read, not two pages.

That leaves `publish` and `checkpoint` genuinely repeatable, and both are harmless:
publishing an unchanged draft is idempotent in effect, and a duplicate checkpoint is one
extra row in a list, which is noise rather than damage.

**Rejected: expose `Idempotency-Key` as a tool argument.** A model that must remember to
pass a nonce will forget, and the failure mode of forgetting is the doubled write the
argument was there to prevent. The header stays available to scripts, where a caller
chooses it deliberately.

## Wire & schema changes

### D1 migration

**None.** `api_tokens` (`0001_init.sql:312`) already models a scoped non-human caller, and
nothing here stores anything new.

### Core types

**None.** No change to `Doc`, `Blok`, `Field`, `Mutation`, `Resolution`, or either wire.
`PROTOCOL_VERSION` stays at 4.

One additive change to a **server** type:

```ts
// server/routes/api/documents.ts
export interface ApiDocumentMeta {
  // …
  url: string | null
  /** The editing render: `folio-editing`, uid markers, the postMessage bridge. */
  previewUrl: string | null
  /** The same document rendered as the site would serve it (decision 5). */
  draftUrl: string | null
}
```

Additive to a response body, so a consumer reading `url` still reads `url` — which is what
`{base}/api/v1` promises.

The two URLs are named for what they *are* rather than for who asks: `previewUrl` is an
editing surface and `draftUrl` is a page. A caller wanting to look at the draft wants the
second one, and until now there was only the first.

### Host config

```ts
createFolio({
  // …
  /** `false` disables `{base}/mcp` entirely (checkpoint 2). Default true. */
  mcp?: boolean
})
```

And one optional binding, declared by the host in `wrangler.jsonc`:

```jsonc
{ "browser": { "binding": "BROWSER" } }
```

Reached through `FolioBindings` beside `media`, and absent is a legible refusal rather
than a crash (decision 5a).

### New or changed routes

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `{base}/api/v1/documents/:id/unpublish` | `PUBLISH` | — | `{ story: ApiDocumentMeta }` |
| POST | `{base}/api/v1/documents/:id/duplicate` | `CREATE` | `{ title?, parentId?, index? }` | `{ document: ApiDocumentMeta }`, 201 |
| POST | `{base}/api/v1/documents/:id/restore` | `EDIT` | `{ versionId }` | `WriteResult` |
| GET | `{base}/api/v1/search` | `READ` | `?q=&type=&state=&parentId=&routed=&limit=&cursor=&count=` | `Page<ApiDocumentMeta>` |
| POST | `{base}/mcp` | per tool | JSON-RPC | JSON-RPC |
| GET | `{base}/mcp` | — | — | 405 with `Allow: POST` |

And one new **mode** rather than a new route, on the branch `handle()` already owns
(`index.tsx:226`), outside `basePath` because a page's URL is the host's:

| URL | Access | Renders |
| --- | --- | --- |
| `<page>?_folio=preview` | `READ_DRAFT` or a share cookie | unchanged: the editing render |
| `<page>?_folio=draft` | `READ_DRAFT` or a share cookie | the draft in render mode `mark`, no `folio-editing`, no bridge |

**Corrected at implementation:** this row originally said `edit={false}`, which is the
`off` mode — **no uid attributes at all**, so nothing to clip a screenshot to. Decision 5a
and the acceptance criteria both require `mark`: uids on host elements, no marker div. The
build followed 5a; the row was wrong. See note 4 in *Implementation notes*.

`V1_SEGMENTS` in `api-partition.test.ts:96` becomes `['schema', 'documents', 'assets',
'search']`, and `mcp` joins the list of names asserted to 404 under a version segment.

**Errors.** Every tool call's failure is a v1 `FolioError` translated to JSON-RPC:
`unauthorized`/`forbidden` → `-32603` with the envelope's message, `bad_request` →
`-32602` (invalid params), everything else → `-32603`. The message is passed through
verbatim, because `errors.ts` is already the only place a message becomes client-visible
and its messages are written to be acted on (`documents.ts:359` names the id to retry
with).

### The tool table

Sixteen tools, each a v1 route. `need` is the scope `tools/list` filters on. Sixteen
rather than the nine `feedback.md:100` enumerates, and the difference is entirely reads:
a write tool is unusable without the read that finds the document and the read that
reports the schema it must satisfy.

| Tool | Route | need |
| --- | --- | --- |
| `get_schema` | `GET /schema` | `content:read` |
| `search_documents` | `GET /search` | `content:read` |
| `query_documents` | `GET /documents` | `content:read` |
| `get_document` | `GET /documents/:id` (`?status=draft`, `?locale=`) | `content:read` |
| `preview_document` | `?_folio=draft` + `browser` (decisions 5, 5a) | `content:read:draft` |
| `create_document` | `POST /documents` | `content:write` |
| `write_content` | `PUT /documents/:id/content` | `content:write` |
| `patch_fields` | `PATCH /documents/:id/fields` | `content:write` |
| `move_document` | `PATCH /documents/:id` | `content:write` |
| `duplicate_document` | `POST /documents/:id/duplicate` | `content:write` |
| `publish_document` | `POST /documents/:id/publish` | `publish` |
| `unpublish_document` | `POST /documents/:id/unpublish` | `publish` |
| `restore_version` | `POST /documents/:id/restore` | `content:write` |
| `list_versions` | `GET /documents/:id/versions` | `content:read` |
| `delete_document` | `DELETE /documents/:id` | `admin` |
| `upload_asset` | `POST /assets` | `assets:write` |

**`delete_document` needs `admin`, not `MANAGE`'s `content:write`.** A deliberate
narrowing of the same kind `POST /documents/:id/versions` already makes
(`documents.ts:532`): the route is reachable by a `content:write` token and the *tool* is
not, because a delete is the one action in the list whose mistake is not recoverable by
another tool call. A script that means to delete asks for `admin`; an assistant helping
with copy does not.

## Acceptance criteria

### The three new v1 routes

```
GIVEN a live document and a token with `publish`
WHEN POST {base}/api/v1/documents/:id/unpublish
THEN the response is 200 and `state` is the taken-down state
AND the same D1 writes a `POST {base}/api/stories/:id/unpublish` makes have happened
AND `content_refs`' outbound half is cleared and the inbound half is not
```

```
GIVEN a published document with two versions and a token with `content:write`
WHEN POST {base}/api/v1/documents/:id/restore with the older version's id
THEN the response is a `WriteResult` whose `changed` is the mutation count
AND an editor with the page open receives the delta over its socket
AND the activity trail's newest entry names `token:<name>`
AND Cmd+Z in that editor undoes the restore in one step
```

```
GIVEN a draft whose content is byte-identical to a version
WHEN that version is restored
THEN the response is `{ changed: 0, transactions: 0, syncId: <current> }`
AND no transaction is written and no socket frame is sent
```

```
GIVEN a version stored under an earlier `schemaId` and pending migrations
WHEN it is restored
THEN the document diffed against the draft is the *migrated* one
AND no pre-migration field key appears in the live draft afterwards
```

### Search reaches drafts

```
GIVEN a document created and never published, titled "Pricing"
WHEN GET {base}/api/v1/search?q=pricing with a `content:read` token
THEN it appears in `rows`
AND GET {base}/api/v1/documents?where=… does not return it
```

```
GIVEN more results than `limit`
WHEN the first page's `cursor` is passed back
THEN the second page repeats no row and skips no row
AND inserting a document above the cursor between the two requests changes neither
```

### The chrome-free draft render

```
GIVEN a routed document and a token with `content:read:draft`
WHEN GET {base}/api/v1/documents/:id
THEN `previewUrl` carries `_folio=preview` and `draftUrl` carries `_folio=draft`
AND fetching either with the same token answers rendered HTML of the *draft*
AND fetching either with a `content:read`-only token answers the host's published page
```

```
GIVEN a document with a block whose `render` returns a component, not a host element
WHEN the same document is fetched in both modes
THEN `_folio=preview` contains `class="folio-editing"` and a `folio-marker` wrapper
AND `_folio=draft` contains neither
AND `_folio=draft` carries `data-folio-uid` on every block that renders a host element
AND `_folio=draft`'s DOM is node-for-node what the published page would render
```

The last two lines are the ones to watch, and they are in tension: the attribute is
*addressing*, which `preview_document` clips on, but the marker div that carries it for a
component-returning block is a node production does not have. Decision 5a resolves it in
favour of the geometry.

```
GIVEN a share link created for a document
WHEN a reviewer follows it
THEN they land on the `draft` mode
AND hovering a block draws no outline
AND a link inside the page navigates
```

That third line is a fix, not a new feature: it fails today.

### The screenshot

```
GIVEN a `browser` binding and a routed document
WHEN `preview_document` is called with no arguments beyond the id
THEN the result is an image at 1440×900 of the top of the draft page
AND not the full 12,000px page
```

```
GIVEN a `browser` binding and a block uid from `get_document`
WHEN `preview_document` is called with that `blok`
THEN the image is clipped to that block's bounding box
AND a uid absent from the render answers a message naming it, not an empty image
```

```
GIVEN no `browser` binding configured
WHEN `preview_document` is called
THEN it answers the draft URL and the rendered HTML
AND says plainly that no screenshot was taken and why
AND does not fail
```

```
GIVEN a record (unrouted, not a declared global)
WHEN `preview_document` is called for it
THEN the tool answers a message saying the document has no URL to render
AND not an error the model must guess the meaning of
```

### The MCP endpoint

```
GIVEN a token whose only scope is `content:read`
WHEN tools/list
THEN the read tools are present
AND `write_content`, `publish_document` and `delete_document` are absent
```

```
GIVEN a token with `content:write`
WHEN tools/list
THEN `delete_document` is absent
AND `write_content` is present
```

```
GIVEN no Authorization header
WHEN POST {base}/mcp with an `initialize` request
THEN it answers `initialize` successfully
AND a subsequent tools/list returns no tools at all
```

```
GIVEN a `tools/call` for `write_content` with a payload the schema refuses
WHEN it is called
THEN the JSON-RPC error message is `fieldShapeError`'s text, naming the block and field
AND nothing was written
```

```
GIVEN a `tools/call` for a tool the token's scopes exclude
WHEN it is called by name anyway
THEN it is refused
AND the refusal is the v1 route's own `forbidden`, not a check the MCP layer invented
```

### The partition holds

```
GIVEN the mounted app
WHEN GET {base}/api/mcp and {base}/api/v1/mcp
THEN both 404
AND POST {base}/mcp answers
```

## Implementation plan

### Phase 0 — the skill that costs nothing (optional, ship whenever)

1. `docs/agent-api.md`: the v1 route table, the scope table, how to mint a token, and the
   three worked examples the AAA import needed. Prose, no code.
2. Nothing depends on this and it unblocks the owner immediately. It is listed first
   because it is the only phase with no build.

### Phase 1 — v1 reaches parity with a person

1. `server/routes/api/documents.ts`: `POST /documents/:id/unpublish` over
   `unpublish` (`publish.ts:192`), matching `routes/stories.ts:503`'s hook calls.
2. Same file: `POST /documents/:id/duplicate` over `duplicateDocument`
   (`documents.ts:72`).
3. Same file: `POST /documents/:id/restore`. `getVersion(db, versionId, migrations)` then
   `writeDocument(deps, () => version.doc, writeActor(c), key)`. Refuse a version whose
   `story_id` is not `:id` — a 400, because it is a caller error and not a missing thing.
4. Same file: `previewUrl` and `draftUrl` onto `ApiDocumentMeta` and `meta()`.
   `draftUrl` needs `runtime.ts`'s `previewUrlFor` to take the mode, which is one
   parameter with a default so the existing call sites are unchanged.
5. `test/workers/api.test.ts` for all four; `test/workers/api-partition.test.ts` untouched
   (these are new *methods* on an existing `documents` segment).

Committable. The tree is green and v1 is more complete whether or not the rest lands.

### Phase 2 — search

1. `server/routes/api/index.ts` or a new `routes/api/search.ts`: `GET /search` over
   `searchStories` + `storyFilterQuery`, answering `Page<ApiDocumentMeta>` — the v1
   projection, not the admin's `StoryMeta`.
2. `api-partition.test.ts:96`: `V1_SEGMENTS` gains `'search'`.
3. `test/workers/api.test.ts`: the draft-visibility criterion and the keyset criteria.

Committable, and independently useful to any script.

### Phase 3 — the MCP transport

1. `server/mcp/rpc.ts`: the JSON-RPC envelope. Parse, dispatch, error codes. Pure, no Hono.
2. `server/mcp/tools.ts`: the tool table — name, description, input schema, `{method,
   path}`, `need`. Declarative, and the file a new tool is added to.
3. `server/routes/mcp.ts`: one `POST`, one `GET` answering 405. `initialize` reports
   `serverInfo` and an empty `capabilities.tools`; `tools/list` filters by
   `hasScope`; `tools/call` dispatches.
4. `server/app.ts`: mount at `/mcp`, under `withActor` and outside `/api`.
5. `test/unit/mcp/rpc.test.ts` for the envelope; `test/workers/mcp.test.ts` for the
   scope-filtered list and the partition.

### Phase 4 — the chrome-free render, and the share-link fix

**Before the screenshot, because the screenshot is worthless without it.**

1. `preview/Render.tsx`: split `edit` into two. `:121`'s `if (!edit) return el` becomes a
   three-state mode — `off` (published: no attributes), `mark` (uids on host elements, no
   marker div), `edit` (today's behaviour). `:161`'s wrapper is reached only by `edit`.
   This is the load-bearing change in the phase and the one with a real trade-off behind it
   (decision 5a).
2. `server/pages.tsx`: `previewPage` takes the mode. `draft` passes `mark` and drops
   `bodyClass`; `preview` is unchanged.
3. `server/index.tsx:226`: the branch reads `_folio` as `preview | draft`, everything else
   handed back. Same gate, same `?locale=`, same share-cookie path, and `?as=` stays
   refused for a share grant.
4. `server/runtime.ts`: `previewUrlFor(path, locale, mode?)`; `withUrls` gains `draftUrl`
   and `draftUrls`.
5. `server/routes/preview.ts:248`: a share link redirects to the `draft` mode.
   **A sanctioned behaviour change** — say so in the commit body, per `CLAUDE.md`.
6. `test/workers/shares.test.ts` and a new preview-mode test: both modes render, only one
   carries `folio-editing`, and `locales.test.tsx`'s render assertions still hold for
   `preview`.

Committable on its own, and worth landing even if the MCP work stops here: it is the fix
for a bug that shipped in spec 21.

### Phase 5 — the screenshot

1. `FolioBindings` gains `browser?`, beside `media`. Absent is `unsupported` with a
   message, matching `routes/api/index.ts:85`.
2. `server/mcp/shot.ts`: viewport, optional `fullPage`, optional `blok` clipped to
   `[data-folio-uid="…"]`, credential forwarded as a header. Returns PNG bytes.
3. `preview_document`: resolve the document, choose `draftUrl` or
   `{base}/preview/global/:name`, screenshot it, answer MCP image content — or the
   no-binding path, which answers the URL and the HTML and says why.
4. Tool descriptions built from `rt.manifest` — block and document type names only.
5. `scripts/mcp-test.mjs`: sign in, mint a token, drive `initialize` → `tools/list` →
   `create_document` → `write_content` → `preview_document` → `publish_document` against
   port 5199, asserting the activity trail names the token. **It asserts the no-binding
   path**, because that is the only one localhost can reach (decision 5a).

### Phase 6 — the admin uses the restore route (optional)

1. `hooks/useVersions.ts:367`: `restore` posts to the route instead of computing
   `diff(live, target)` in the browser.
2. Only worth doing if phase 1's route proves out. The hook works; this removes a second
   implementation rather than fixing a bug, and it moves the `MAX_TX_MUTATIONS` message
   from a notice into an error envelope, which is a UI change with its own review.

## Edge cases

- **A tool call whose route needs an `ExecutionContext`** (publish, delete — both purge the
  cache after commit) → the internal dispatch passes the live `ctx` through. Without it
  `ctx.waitUntil` is absent and the purge silently does not happen, which
  `platform/caching.md` warns is unobservable in every test. Asserted by a test that spies
  on the hook rather than on the cache.
- **`initialize` with no credential** → succeeds, and `tools/list` is empty. An MCP client
  probes before it is configured, and a 401 at `initialize` presents as "the server is
  broken" rather than "the token is missing". The empty list is the honest, legible answer.
- **A token with only `assets:write`** → `tools/list` holds `upload_asset` and nothing
  else. `IMPLIES` (`roles.ts:64`) grants `assets:write` no content access at all, which is
  the whole reason it is a separate scope.
- **`auth: 'open'`** → `withActor` answers a null actor and every route gate
  short-circuits on the mode (`resolve.ts:57`). So `{base}/mcp` on an open deployment
  offers every tool, exactly as `/api/v1` already answers every request. Correct, and
  worth stating: an open deployment has no access control by choice, and MCP is not the
  place to invent some.
- **A document deleted between `search_documents` and `write_content`** → `commit` refuses
  an object holding no document and `refusal()` maps it to `not_found` with *"That document
  no longer exists"* (`write.ts:149`). The agent's next move is to search again, which the
  message supports.
- **A write larger than `MAX_TX_MUTATIONS`** → `commitAll` chunks it and reports
  `transactions: n`. Several undo steps rather than one, which the response says plainly so
  it is not a surprise.
- **A restore naming a version belonging to another document** → 400. The version id is
  globally unique so the lookup would succeed and the diff would be nonsense; refusing on
  the mismatch is cheaper than a document rewritten from a stranger's history.
- **`?as=<global>` in a preview** → not reachable through the tool. The tool builds the
  URL from `draftUrl` or from the global's own bare preview, never by concatenating caller
  input onto a path. A tool that let a model compose a preview URL would be a tool that
  could ask for `?as=` on a share-scoped request, which `index.tsx:311` refuses for a
  reason.
- **`preview_document` for a block whose render returns a component** → no uid to clip to
  in `draft` mode (decision 5a), so the viewport screenshot, and the result says which it
  gave. Silently returning a full-page image labelled as one block is the failure mode to
  avoid: the model would draw conclusions about geometry from the wrong picture.
- **A `blok` uid that is not in the document at all** → a message naming the uid, not an
  empty image. An empty image is indistinguishable from a block that renders nothing, and
  those two have opposite fixes.
- **A screenshot of a page whose fonts or images have not loaded** → the headless browser
  waits on the network being idle before it captures, because the most likely visual defect
  an agent is asked about *is* a missing image, and a screenshot taken too early
  manufactures one. Worth stating because it is the difference between a useful tool and a
  flaky one.
- **A draft page that throws during render** → the `draft` mode answers whatever the
  editing mode would, which is the host's error boundary or a 500. Not special-cased: the
  agent seeing what a visitor would see is the correct answer, and inventing a friendlier
  page here would hide a real break.
- **A `browser` binding against a `localhost` dev server** → cannot work, because
  Cloudflare's browser is remote (decision 5a). The tool detects neither the environment nor
  the hostname; it simply fails the fetch and reports the no-screenshot path, which is the
  same answer as no binding and needs no second code path.
- **Two agents editing one document** → the same answer two people get, because it is the
  same mechanism: both writes are diffs against the current draft, committed in order, and
  each broadcast to the other. Last write wins per field, which is what
  `live-collaboration.md` settled.

## Testing requirements

**Unit (`packages/folio/test/unit/`):**
- `mcp/rpc.test.ts` — the envelope: a malformed body, a batch (refused, with the reason),
  an unknown method, a notification (no response), the four error codes.
- `mcp/tools.test.ts` — **every tool's `{method, path}` resolves to a declared v1 route**,
  asserted against the table rather than by hand, so a tool cannot name a path that does
  not exist. And the reverse: every v1 route is either in the table or in a named
  exclusion list, so a new route is a deliberate decision about whether an agent gets it.
- `mcp/scopes.test.ts` — the filtered list for each of the six scopes.

**Workers (`packages/folio/test/workers/`, real workerd):**
- `api.test.ts` — the three new routes, `previewUrl`/`draftUrl`, and the four restore
  criteria including the migrated-version one.
- `api-partition.test.ts` — `V1_SEGMENTS` gains `search`; `mcp` asserted to 404 under
  both version segments.
- `mcp.test.ts` — `initialize` unauthenticated, `tools/list` per scope, a `tools/call`
  that writes and is visible in `versions.actor` as `token:<name>`, a `tools/call` refused
  by the route's own gate, and the `ExecutionContext` pass-through.
- `preview-modes.test.ts` — the render difference, asserted on the HTML rather than
  described: `preview` carries `folio-editing` and a `folio-marker`, `draft` carries
  neither, `draft` carries uids on host elements, and a block returning a component has no
  uid in `draft`. This is the test that stops phase 4 regressing, and it is cheap because
  both are server-rendered strings.
- `shares.test.ts` — a share link now lands on `draft`. An existing file whose expectation
  changes, which is the shape of a sanctioned behaviour change.
- `pagination.test.ts` — the v1 search route's keyset behaviour, beside the admin
  route's.

**Not testable here, and stated rather than implied:**
- **No test can observe a screenshot.** Browser Rendering is not simulated by miniflare, so
  workerd tests can cover the no-binding refusal, the URL chosen and the clip selector
  built — and nothing about the image. Same position `platform/caching.md` is in with
  Workers Cache, and the same answer: everything computable is a pure function, and the
  rest is a tool run against a deployment, never CI.

**End to end (`scripts/*.mjs` against a live dev server on port 5199):**
- `scripts/mcp-test.mjs` — phase 5 step 5. Follows both existing conventions:
  `signInGlobally()` from `scripts/lib/auth.mjs`, and `import './lib/ts-resolve.mjs'`
  first since it imports the tool table from source. It does **not** need
  `PROTOCOL_VERSION` stamping — there is no socket frame here, which is itself worth
  asserting once.

## Dependencies

- **Spec 15 (`platform/content-api.md`)** — done. This extends its surface and inherits
  every decision in it, particularly decision 4: writes go through the mutation log.
- **Spec 10 (`foundation/identity-and-access.md`)** — done. `api_tokens`, `SCOPES`,
  `hasScope`, `actorString`. Nothing new is needed from it.
- **Spec 18 (`foundation/pagination.md`)** — done. `StoryFilter`, `Page<T>`, the cursor
  module, and decision 1, which phase 2 deliberately reads by its reason rather than its
  letter.
- **Spec 20 (`platform/bulk-writes.md`)** — done. Not used: its routes are internal by
  design and decision 3 says why a tool must not reach them.
- **Spec 21 (`platform/draft-sharing.md`)** — done, and **this spec changes its
  behaviour.** Adjacent and deliberately unused as a *credential* — a share grant is not an
  actor and cannot satisfy a route gate — but phase 4 repoints its links at the `draft`
  mode, which is a fix to shipped behaviour rather than an extension. Its
  `## Implementation notes` should be restamped to say so.
- **Cloudflare Browser Rendering**, bound as `browser`. **The only paid add-on this spec
  needs, and the only optional one**: everything works without it except the image, which
  degrades to the URL and the HTML. Not available against a local dev server at all.
- **No other Cloudflare resources.** No Durable Object, no queue, no KV. The MCP endpoint
  is stateless (decision 9).
- **Host config:** one optional `mcp?: boolean` on `FolioConfig`, per owner checkpoint 2.

## Out of scope

- **"Claude, on behalf of Sam."** The trail names the token, which is what
  `feedback.md:111` asks for. Per-user attribution needs the MCP session to carry a user
  identity, which means a per-user credential rather than a shared token — a real feature
  with a real auth design, not a field to add. Excluded because doing it badly (a
  caller-supplied `actor` string) would put unverified names in the audit trail, which is
  worse than an honest `token:claude`.
- **MCP `resources` and `prompts`.** Tools cover every verb on the parity list. Resources
  would mostly duplicate `get_document`, and prompts are a client-side convenience that
  belongs in a skill. Both would also reopen decision 9's statelessness.
- **OAuth 2.1 for the MCP endpoint.** The spec's remote-auth story wants an authorization
  server, and Folio is an OIDC *client* (`auth/oidc.ts`), not a provider. A bearer token in
  a header is what Claude Code and the API both accept today, and it is exactly the
  credential `api_tokens` already models. Revisit if a client appears that cannot send a
  header.
- **Bulk tools.** `search_documents` plus a loop is what an agent does well, and it reports
  per-document failures naturally. The bulk routes exist for a UI that ticks 200 rows,
  which is not this caller.
- **Schema migrations and reindex over MCP.** `POST {base}/api/migrate` and `/reindex`
  rewrite every document or every index row on a site. They are `ADMIN`, they are internal,
  and an agent that can run one can lose a site's content in one tool call with no undo.
  Excluded on blast radius, not on difficulty.
- **A local stdio server.** Decision 1.
- **Streaming a tool's progress.** Decision 9. A publish of one document is fast; the slow
  operations are all excluded above.
- **Visual regression: a screenshot compared against a stored baseline.** A real feature and
  a different one. It needs somewhere to keep baselines, a decision about what counts as a
  difference, and an answer for "the design changed on purpose" — none of which this spec
  has an opinion about. `preview_document` shows the agent the page *now*; comparing two
  points in time is `unpublished-changes.md`'s territory, in pixels rather than in fields.
- **A screenshot of the published page.** Trivially available — it is a public URL, and any
  agent with a browser can fetch it. The tool exists because a *draft* needs a credential.

## Open questions

None. All three owner checkpoints were resolved on 2026-08-03 and are recorded in place.

One thing deliberately left to implementation rather than decided here: whether
`Render.tsx`'s three-state mode is spelled as a union (`'off' | 'mark' | 'edit'`) or as two
booleans. The union reads better and the booleans diff smaller against `edit?: boolean`'s
twelve call sites. Either satisfies decision 5a; neither changes anything observable.

*Resolved at implementation:* the union, `RenderMode = 'off' | 'mark' | 'edit'`, exported
from `preview/Render.tsx`. It names the states, where a boolean pair permits a fourth
combination that means nothing.

## Implementation notes

Built in the five phases named, each committed on its own and green at every step. Every
*Architecture decision* landed as argued; no rejected alternative was taken. Two phases
were reviewed by an independent agent against the decisions rather than the code, which is
where notes 2 and 6 come from.

Ten things are worth recording.

1. **Ground truth was accurate, unusually so.** A recon pass re-verified every `file:line`
   claim before phase 1 and found only line drift: `hasScope` is `roles.ts:74` not `:73`,
   `api_tokens` is `0001_init.sql:297` not `:312`, and `package.json` has six tiptap
   dependencies rather than five (nine total, so decision 9's argument is unaffected). The
   spec's own guess that five commits had landed after it was wrong — they are its
   ancestors. Contrast the July run, where Ground truth was badly stale by mid-sequence.
2. **The one real bug shipped in an `inputSchema`, and it is decision 2's own failure mode
   one layer in.** `search_documents` advertised `state` values `['draft', 'published',
   'unpublished', 'changed']`. `StoryState` has no `published`; the value meaning published
   is **`live`**, and it was not advertised at all — so the value a model was most likely to
   send was a guaranteed `bad_request`, and the correct one was invisible. **An `enum` in an
   input schema is a second copy of the route's validation**, exactly the fork decision 2
   exists to prevent, and nothing caught it because `tools.test.ts` pinned argument *names*
   and not their domains. `STORY_STATE` is now exported from `validate.ts` so the advertised
   list is pinned against the real picklist by value, and a workers test sends every
   advertised value at the live route. Two further domain tests followed for
   `preview_document`'s arguments. **If a later tool adds an `enum` or a nullable, pin it
   the same way.**
3. **`ping` makes the subset five messages, not decision 9's four.** That enumeration is of
   the *tool* surface — the things that would have needed a stream or session state. `ping`
   is a transport obligation of the base protocol, in the same category as the `GET`
   answering 405 rather than an empty stream, which the spec already required for the same
   reason. MCP requires a receiver to answer it promptly, and a client that keepalives reads
   `-32601` as a dead peer and drops the session. For an endpoint whose premise is
   reachability from a hosted client nobody here can patch, that is the most expensive kind
   of deviation and the hardest to observe. `ping: () => ({})` — no state, no stream, no
   declared capability.
4. **`?_folio=draft` renders `mark`, not `edit={false}`.** The route table said the latter,
   which is `off` — no uids, nothing to clip to, which would have made
   `preview_document`'s whole `blok` argument impossible. Decision 5a and the acceptance
   criteria are the contract and the build followed them; the table row is corrected in
   place above.
5. **`{base}/preview/global/:name` was still the editing render, and that would have
   undermined the tool.** Decision 5a names it as the fallback URL for a declared global —
   the documents an agent is most likely to be asked about, since they have no page URL —
   but phase 4 changed only `handle()`'s branch, so this route kept its hard-coded
   `preview`. Photographing it would have caught `folio-editing`'s `position: relative` on
   every marked block, which re-parents any absolutely-positioned descendant. Worse:
   **clipping to a uid *succeeds* there, via the marker div**, so the tool would have
   clipped the wrapper's box and reported success — the "labelled as one block,
   geometrically wrong" failure the edge cases exist to prevent. It now reads
   `?mode=draft`, defaulting to `preview` so the admin is unchanged. Found by review, not
   by a test.
6. **`draft` renders Folio's preview shell, not the host's page, and decision 5 overstated
   this.** *"It is the draft as the site would serve it"* is not what ships: globals stack
   above the document instead of sitting in the host's layout, the title is
   `Preview · <title>`, and `folio.handle()` answering means the host's own page render
   never runs — `pages.tsx` has said so in place all along (*"a simplification, not a claim
   of visual fidelity"*). The *document subtree* is node-for-node the published tree, which
   is what a block screenshot is about, but the chrome is not the host's. **Not a
   regression** — the share link already pointed at the same shell — but a model told "here
   is the page" would draw conclusions about the host's layout from it, so
   `preview_document` captions what it actually shows. The honest fix is a different
   feature: the mode split makes `folio.draft(env, id)` + `folio.render(doc, { mode:
   'mark' })` inside a host's *own* layout possible, which would be genuinely
   production-shaped and addressable. Recorded in `ROADMAP.md`; nothing uses it yet.
7. **Browser Rendering needed no new dependency, which the spec assumed it would.** Driving
   it used to mean `@cloudflare/puppeteer`, and decision 9's argument against the MCP SDK
   would have applied to that just as well. The binding now answers
   `quickAction('screenshot', …)` directly and returns a plain `Response` carrying PNG
   bytes, and `BrowserRun`'s type ships in `@cloudflare/workers-types`, already a
   devDependency for every other binding in `FolioBindings`. So the binding costs nothing
   to declare, not even an optional peer. Nine runtime dependencies, still nine.
8. **Three places the spec promised more than the code could do, each resolved to the
   spec's own leaning rather than by extending a shared function:**
   - `POST /documents/:id/duplicate` takes `{ title?, parentId? }` and **no `index?`**.
     `duplicateDocument` has no positioning argument and neither does the admin's own body
     schema; a caller wanting a position has `PATCH /documents/:id`, which is two calls and
     is also what dragging a duplicated row is.
   - `GET /api/v1/search` parses `parentId` and `routed` **itself**. `storyFilterQuery`
     excludes both deliberately — it is shared with the admin's screens, where each list
     states its scope positionally — so the route layers them on top of its output, exactly
     as the admin's `/api/search` already layers `types` for `?kind=`.
   - `getVersion`'s third argument is a `VersionMigrations` **object**, not the
     `Migration[]` the plan implied. The restore route reuses the assembly already in
     `routes/history.ts` rather than building a fourth.
9. **`need` on a tool row is an `Access`, not a bare `Scope`**, and this is what decision 6
   already required rather than a departure from it: its last paragraph asks for a
   `UserActor` to be filtered "by role through the same `Access` pair with no special
   case", which a bare scope cannot satisfy at all since `hasScope` has nothing to read off
   a user. Only the tool table's `need` *column* prints the scope half. `allows` handles
   both currencies, and a test pins every row's `need.scope` against that column.
10. **`StoryMeta` gained `draftUrl?`/`draftUrls?`, which "Core types: none" did not
    anticipate.** `withUrls` is generic over `T extends StoryMeta`, so it cannot return
    fields the type does not declare. Additive, no wire impact, `PROTOCOL_VERSION` still 4.

**Deferred, deliberately:**

- **Phase 6 — the admin calling the restore route** instead of computing
  `diff(live, target)` in the browser. Not started. The hook works; this removes a second
  implementation rather than fixing a bug, and it moves the `MAX_TX_MUTATIONS` message from
  a notice into an error envelope, which is a UI change with its own review.
- **Phase 0 — `docs/agent-api.md`**, the prose skill that teaches an agent to curl the API.
  Nothing depends on it and `{base}/mcp` now covers the same ground with a contract instead
  of prose.
- **A draft render inside the host's own layout** (note 6). The real answer to "screenshot
  the page as the site serves it", and a different feature.

**What no test can cover, stated rather than implied:** the screenshot itself, the clip
actually clipping, the `networkidle0` wait mattering, and the unclippable-block fallback
firing for real. Browser Rendering is not simulated by miniflare — the same position
`platform/caching.md` is in with Workers Cache, and the same answer: the URL chosen, the
clip selector built and the viewport resolved are pure functions with unit tests, and the
rest is `scripts/mcp-test.mjs` against a deployment, never CI. That script does assert the
no-binding path end to end, because it is the only one localhost can reach.

One thing the spec asked for that turned out impossible: `scripts/mcp-test.mjs` cannot
**import the tool table from source**. `mcp/tools.ts` reaches `server/pages.tsx` through
`shot.ts`, and Node's native TypeScript support strips types without transforming JSX, so
the import chain will not load. The script names its tools as literals, the way
`api-test.mjs` already names its routes.
