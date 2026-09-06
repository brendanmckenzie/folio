# Feature: Forms and responses

> **Group:** content model
> **Build order:** 33
> **Size:** L
> **Status:** draft
> **Wire version:** none — nothing here crosses the socket or the admin↔preview bridge
> **Migration:** `0010_forms.sql` (a claim, not a landing — see below)
> **Build sequence:** after 32, before 23 (owner, 2026-09-05)
> **Last updated:** 2026-09-05

> **Migration number is a claim.** `0006_auth.sql` (28) has landed on this branch;
> `0007` (29), `0008` (32) and `0009` (23) are claimed and not landed. This takes
> `0010`, the next free number. Whichever builds first takes the next free number
> and the others restamp — the standing rule in `docs/specs/README.md`.

> **Written while other work was in flight** on `specs-31-30-28-29`. Ground truth below
> was read at `8122473`, with seven files dirty in the tree at the time:
> `src/core/fields.ts`, `src/core/resolve.ts`, `src/core/query.ts`,
> `src/core/index.ts`, `src/server/runtime.ts`, `src/server/types.ts` and
> `src/admin/ui/screens/fields/CollectionField.tsx`. **Line numbers cited in those
> seven may have moved**, and three of them are this spec's most-cited files — check
> `Field`, `Resolution`, `resolveValue` and `resolve()`'s passes before building on the
> positions rather than the facts. The facts themselves are structural (an exhaustive
> switch, a map on the resolution, two concurrent passes) and none is reversed by the
> work in flight. Everything cited in `src/server/assets.ts`, `src/server/hooks.ts`,
> `src/server/app.ts`, `src/server/cache-request.ts`, `src/server/auth/`,
> `src/admin/ui/route.ts`, `migrations/` and `test/` was clean and is exact.

> **Phase 1 landed 2026-09-06** (`migrations/0010_forms.sql`, `src/core/forms.ts`,
> the `form` field kind). Confirms the structural facts above held: the exhaustive
> `resolveValue` switch, `Resolution` as a bag of per-key maps, and `reference`'s
> string-id-and-lookup shape were all unchanged. One line in "Changes to existing
> core files" was stale rather than the structure: `defaultValue` does **not**
> answer `''` "as `reference` does" — the tree's actual `reference` case already
> answered `null`, so `form` was aligned with what `reference` does today (`null`),
> not with the sentence. Two more exhaustive switches outside this spec's own
> Ground truth also demand a `form` case the instant the union gains the member,
> and phase 1 had to touch both to stay green: `core/nested.ts`'s `fieldShapeError`
> (a write-time validator over every field kind, same shape as `reference`'s) and
> `admin/ui/screens/inspector-model.ts`'s `CONTROLS` map (`Field['kind'] →
> ControlKind`, mapped to `'text'` — there is no form picker yet, so this only has
> to agree with `Control.tsx`'s existing default-to-a-text-box fallback for an
> unbuilt control). Phases 3–8 are still outstanding.

> **Phase 2 landed 2026-09-06** (`src/server/forms.ts`, `src/server/routes/forms.ts`,
> the forms half of `validate.ts`, `formChanged` in `hooks.ts` and `cache-purge.ts`,
> the mount in `app.ts`, `test/workers/forms.test.ts`). Six divergences from the
> plan, each recorded under "Implementation notes — phase 2" at the end of this
> file; the load-bearing two are that `GET /forms/:id/usage` answers a **superset**
> of the asset usage shape, and that `validateFormFields`' refusals had to be
> translated into `bad_request` or every one of them was a 500.

> **Phase 3 landed 2026-09-06** (`compileForm` and `FormRenderContext` in
> `src/server/forms.ts`, the forms read and the descriptor map in `resolve()`,
> `test/unit/server/forms.test.ts`, and extensions to `test/workers/forms.test.ts`
> and `test/workers/read-session.test.ts`). The plan's step 3 turned out to need no
> code — `contentProjection` already emits `kind: 'form'` edges through
> `outboundRefs`, since phase 1 — and one limitation the spec does not cover came
> out of it: a form embedded in a **global** or in a referenced document resolves
> to `null`, because its id is not known until pass two. Both are under
> "Implementation notes — phase 3" at the end of this file, along with the
> `form()` field builder that still does not exist. Phases 4–8 are outstanding.

## Summary

Folio can publish a page that asks a question and has nowhere to put the answer. There
is no form anything, at any layer, and the absence is total rather than partial: no
`form` kind in the `Field` union (`core/fields.ts:105`), no table in `migrations/`, no
route file, and no `Screen` member (`admin/ui/route.ts:22`). The one unauthenticated
`POST` in the library is `{base}/login/email`, which answers 200 identically whether or
not it did anything — so there is not even a shape to copy. Every host that needs a
contact form either writes one by hand in its own Worker against its own table, or
posts to a third party and loses the data to somebody else's dashboard.

This adds forms as a first-class store an editor builds in the admin, a typed
descriptor a host renders with its own markup, a public submission endpoint that
validates server-side and works with JavaScript disabled, a responses table with a
streamed CSV export, gated file uploads, and one `submitted` hook so a host can forward
every response to whatever it already uses.

## Ground truth

**core (`src/core/`):**

- `fields.ts:105` — the `Field` union, thirteen kinds. `Common` at `:9` (`label`,
  `help`, `required`, `showIf`, `hidden`, `default`, `translatable`), `Indexable` at
  `:72`, `Searchable` at `:96`, `SelectOption` at `:100`. **`Indexable` and
  `Searchable` are deliberately not on `Common`** and carry the argument for
  per-kind membership, which is the precedent for a kind that carries neither.
- `fields.ts:251` `ValueOf<F>`, `:283` `defaultValue(f)` — the two places a new kind
  must be taught what it holds and what "empty" means for it.
- `resolve.ts:427` — `resolveValue`. **The dispatch is exhaustive on purpose**: the
  `default` branch assigns to `never`, so a new field kind fails to compile here
  rather than handing a block author the wrong type. `:407` `resolveCollection` is
  the one case that answers out of a **map on the resolution** rather than from the
  stored value — `resolution.collections?.[key] ?? empty` — because computing the
  answer needs more than the three arguments this function takes.
- `resolve.ts:61` — `Resolution`. `stories`, `assetBase`, `docs`, `globals`,
  `locale`, `collections`, `page`. `collections` (`:104`) carries the reasoning a
  fifth map would reuse verbatim: *collected from the document, run once each, and
  pushed alongside it — so a page with no such field costs no extra reads*.
- `refs.ts:43-45` — `OutboundRef` is `{ to, kind: 'link' | 'reference' | 'asset' }`,
  and its header states the rule: **`to` holds whatever `kind` says it holds** — a
  story id for two kinds, an R2 key for the third. `:71` is the single walk with a
  visitor; `:193` the `switch` that a new edge kind joins.
- `cache-tags.ts:62-64` — `storyTag`, `globalTag`, `typeTag`; `:162` `cacheTags`,
  which emits a tag per key of `resolution.globals`; `:225` `cacheHeaders`; `:47`
  `NO_STORE`; `:40-41` the 1000-tag / 16KB budget. The file's header is the whole
  argument: **the dependency set is computed at render, not looked up at purge**,
  because a reverse index over `content_refs` truncates at 400 rows and misses
  globals entirely.
- `locales.ts:81` `fieldValue`, `:103` `dataOf`, `:130` `localeChain` (the fallback
  chain, source locale last), `:235` `isTranslatable`. `LocaleContext` at `:62`.
- `pagination.ts:24` `Page<T>` — `rows`, `cursor`, **`total` absent unless
  `?count=1`**; `:120` `paginate`, `:138` `clampLimit`.
- `story.ts:283` `IdSelection`, `:299` `FilterSelection`, `:326` `BulkSelection`.
  **Not generic today.** Spec 32 moves all three to `src/core/bulk.ts` as
  `BulkSelection<F>` with no default type parameter, and 32 builds first — so this
  spec writes `BulkSelection<ResponseFilter>` against a file 32 creates.
- `schema.ts:29` `BlockSchema`, `:57` `DocumentType`. Nothing here changes: a form is
  not a document.

**server (`src/server/`):**

- `app.ts:28` `createApp`. Three mounts and the order is load-bearing in three marked
  places: `/api/v1` first, `/api` next, then **the bare mount for "pages and public
  bytes"** — `authRoutes`, `assetFileRoutes`, `sharePageRoutes`, `draftRoutes`,
  `editorPageRoutes`, `shellRoutes`' wildcard last. `app.all('/api/*')` throws a JSON
  404 so an unmatched API path is never answered with HTML.
- `app.ts:66-84` — **a version segment is a promise; its absence is the absence of
  one.** `{base}/api/v1/*` is a contract with somebody's script, `{base}/api/*` is
  internal to the admin and may change shape in any commit.
  `test/workers/api-partition.test.ts` pins the split.
- `cache-request.ts:131` `cacheVerdictFor`. **Rule 1 is `req.method !== 'GET' &&
  !== 'HEAD' → 'bypass'`**, so a form POST is never a cache concern; rule 6 bypasses
  everything under `{base}` that is not `{base}/asset/:key`. `cacheKeyFor` (`:93`)
  strips `utm_*` and a named click-id set and **nothing else** — "a query parameter
  is part of a URL's identity by default".
- `cache-purge.ts:44` `MAX_TAGS_PER_PURGE = 100`, `:56` `MAX_PURGE_CALLS = 5`, `:114`
  `purgePlan`, `:150` `cachePurgeHooks` — Folio's own purge registered as an
  *internal* hook, the seam a new event hangs off.
- `hooks.ts:19` `HookEvent`, ten names; `:38` `HOOK_EVENTS`, the same list at runtime
  — *"a name must appear in both or it is either a hook nobody can configure or one
  `createFolio` refuses at construction"*, pinned by `test/unit/server/pure.test.ts`.
  `:54` `HookBase` (`env`, `waitUntil`, **`actor: string | null`**), `:146`
  `HookPayloadMap`, `:165` `FolioHooks` with `await?`, `:196` `validateHooks`, `:231`
  `InternalHooks`, `:262` `createHookRunner`. `:139` `RedirectsChangedHookPayload` is
  the closest shape to what this spec adds: an event for a write that changes
  published bytes without publishing anything.
- `hooks.ts:1-13` — *"deliberately not a webhook system — no secret, no retry queue,
  no delivery log"*, and `runOne` (`:241`) swallows a throw with one `console.error`
  so a Slack outage cannot make publishing impossible.
- `runtime.ts:629-731` — `resolve()`'s four passes. **Pass one and pass two run
  concurrently on the published branch** (`:676-686`) because `publishedDocsByIds`
  returns nothing for an absent id, and the comment records what waiting cost:
  *"a whole network round trip per page render for a filter that changes nothing —
  ~280ms of it on a host whose primary is a continent away"*. `read-session.test.ts`
  pins the send/receive order because both orderings return identical rows.
  `:732` is pass four, the collection queries.
- `assets.ts:26` `MAX_UPLOAD_BYTES = 20 * 1024 * 1024`; `:253` `readCappedBody` —
  *"a declared length is only ever a claim"*, so it reads incrementally and cancels
  the moment the running total passes the cap; `:286` `uploadAsset`, which mints
  `ast_<12 hex>-<safeFilename>`, **sniffs the content type from the bytes rather
  than trusting the header** (`:307`), puts to R2 first and compensates with a
  `bucket.delete` if the insert throws; `:390` `deleteAsset`, D1 before R2 with the
  R2 failure swallowed because the row is already committed gone; `:551`
  `serveAsset`; `:717` `sniffContentType`; `:499-517` the response headers every
  served object carries — `nosniff`, a CSP, `content-disposition`.
- `validate.ts:691` — `ASSET_KEY` is `/^ast_[0-9a-f]{12}-[a-z0-9.-]{1,80}$/`, and its
  header says why the anchoring matters: a looser screen *"turns this public,
  unauthenticated route into a read primitive for any flat key in the same bucket"*.
  **This is the property a second key prefix leans on.** `:599` `safeNext` (a
  same-origin redirect target or a fallback), `:622` `parseOrThrow`, `:791`
  `contentLengthHeader`, `:813` `limitParam`, `:830` `requireCursor`. Valibot
  throughout; `bounded(n)` is the string helper every text body already uses.
- `auth/roles.ts:43` `SCOPES` (six), `:64` `IMPLIES`, `:150` `Access` (*"the same
  requirement expressed twice"* — a minimum role and a token scope, declared
  together), `:156` `READ`, `:162` `EDIT`, `:177` `CREATE`, `:185` `MANAGE`, `:188`
  `PUBLISH`, `:191` `ASSETS`, `:194` `ADMIN`.
- `auth/challenges.ts:26` `RATE_WINDOW_MS = 60 * 60 * 1000`, `:86`
  `recentChallengeCount` — the one rate limit in the codebase, a `count(*)` over a
  window, and its header names itself *"a partial answer"* because the IP dimension
  needs a counter Folio has no binding for.
- `db.ts:41` `FolioDb = Pick<D1Database, 'prepare' | 'batch'>` — **a new query helper
  takes this, never `D1Database`**; `:146` `D1_BIND_CAP = 100` per statement; `:161`
  `BIND_BUDGET`; `:181` `bindChunks`; `:116` the `withSession` split.
- `keyset.ts:21` `Keyset`, `:46` `orderBy`, and the header's list of the four ways a
  hand-rolled keyset goes subtly wrong.
- `errors.ts:13-37` — the code union. `bad_request`, `not_found`, `conflict`,
  `too_large`, `unsupported`, `forbidden` are all already here; nothing new is needed.
- `routes/assets.ts:138` the upload (`contentLengthHeader` then `readCappedBody`),
  `:158` patch, `:166` delete, `:193` `assetFileRoutes` — the public
  `GET {base}/asset/:key`, **on the bare mount and outside `{base}/api` because its
  URL is baked into published HTML** through `Resolution.assetBase`.
- `routes/redirects.ts:38/96/142` — the closest existing route trio to this one: a
  bespoke table, keyset-paged read at `READ`, writes at `MANAGE`.
- `types.ts:71` `FolioBindings` — `media?`, `images?` and `browser?` are each
  optional and **each absence is a legible refusal rather than a 500**; `:194`
  `FolioGate`, spec 31's *host function in config* precedent, with `visitor` and
  `allows` declared as methods for a stated `strictFunctionTypes` reason; `:354`
  `FolioConfig`; `:470` `hooks?`; `:482` `gate?`; `:544` `Folio<Env>`.
- `content-index.ts` — `indexStatements` writes `content_index` and `content_refs`
  inside publish's own batch; `clearInboundRefStatements` is what `deleteAsset` reuses
  unchanged.

**admin (`src/admin/`):**

- `ui/route.ts:22` — the `Screen` union, twelve members; `:38` `ScreenName`; `:55`
  `FLAT`, the eight single-segment screens. The header: **the URL is the state**, and
  the router is pure parse/format because *"the admin's whole suite runs in Node and
  mounts no components"*.
- `ui/nav.ts:93` — `{ label: 'Assets', icon: 'assets', screen: { name: 'assets' } }`,
  the last entry of `primary()`; `:60` `GROUP_AT = 8`.
- `ui/scope.ts:34` `UI_SCOPE = 'folio-ui'`, `:37` `scoped()`. Every subtree needs it
  and **a portal must re-declare it**; `test/unit/admin/ui-scope.test.ts` asserts both.
- `ui/screens/useRedirects.ts:26` `PAGE = 50`, `:36` `DEBOUNCE_MS = 150`, `:50`
  `useRedirects` — the model/hook/screen trio (`redirects-model.ts`, `useRedirects.ts`,
  `Redirects.tsx`) this feature copies twice.
- `ui/List.tsx`, `ui/Table.tsx`, `ui/Dialog.tsx`, `hooks/useFocusTrap.ts` — the six
  admin dialogs all use the one focus trap; a seventh must not be hand-rolled.

**migrations and tests:**

- `migrations/0001_init.sql:190` `assets`; `:382` `content_refs`, primary key
  `(from_story, to_id, kind)`; `:390` `content_refs_to on (to_id)`.
- `migrations/0002_asset_refs.sql:9-10` — **`kind` has no CHECK**, which is why a
  third edge kind cost one rename and no DDL. `:64` is the rename itself.
- `migrations/0004_shares.sql` — the `live`/`lapsed` precedent: **no enum column at
  all**, because `revoked_at is null and expires_at > now` is computed in the `where`
  clause and *"there is nothing stored that could disagree with the clock"*.
- `test/workers/migrations.test.ts:28` `columnsOf`, `:35` `indexesOf`, and the
  per-table pattern of an **exact-equality** assertion on both lists (`:344`, `:348`
  for `assets`) plus named absences. A new table adds one `describe` in the same
  shape.
- `test/workers/api-partition.test.ts` — pins that no internal route is named `v1`.

## Owner decision checkpoints

**All twenty answered by the owner on 2026-09-05, before drafting.** Eighteen went to
the recommendation; **two are overrides and are marked**, because the reasoning below
is built on them rather than around them.

1. **A form is its own table with its own builder — not a document.** *(Override: the
   recommendation was a `record`-kind document assembled from Folio-shipped question
   blocks, which would have inherited versioning, draft/publish, undo, i18n and the
   block-tree editor for free.)* Decision 1 records what that inheritance cost and
   what replaces each piece.
2. **The host renders from a descriptor.** A new `form` field kind resolving to a
   `ResolvedForm` — action, fields, hidden inputs, messages. Rejected: Folio shipping
   a `<FolioForm>` component or server-rendering the markup, both of which put Folio
   in the business of shipping HTML somebody has to override.
3. **A native POST is the primary transport, JSON the negotiated alternative.**
   Published pages in this repo ship zero JavaScript, so a JSON-only endpoint would be
   dead markup in the demo.
4. **Always store; a `submitted` hook is the sink.** Rejected: a sink-only mode, and a
   per-form "forward only" that would have made a hook throw into a 502.
5. **Fields are one validated JSON column** on `forms`. Rejected: a `form_fields` row
   per field, which buys nothing any query needs and makes every builder save a diff.
6. **Live edits, no draft, and a `version` integer stamped on every response.**
   Rejected: a draft/publish cycle for a thing with no page of its own; and no version
   stamp at all, under which a renamed field silently splits one column into two.
7. **Three spam controls: a honeypot, a host `verify` function, and a per-IP-hash rate
   limit.** Rejected: a signed nonce with a minimum fill time — decision 9 has the
   cache argument that rules it out.
8. **Responses read at `publisher`; export and delete at `admin`.** Building a form
   stays at `editor`.
9. **Retention is manual.** *(Chosen against a recommended `retentionDays` plus a
   `folio.pruneResponses(env)` the host calls from its existing `scheduled()`.)*
   Decision 17 states what that costs and what carries the weight instead.
10. **The IP hash carries the hour it was made in**, so it stops being a usable
    identifier by construction rather than by a sweep. This resolved a conflict
    between checkpoints 7 and 9 rather than deferring it.
11. **Stored beyond the answers: the hashed IP, the page it was submitted from, and
    the locale.** Rejected: the raw user-agent string.
12. **A `Forms` nav item and three screens** — list, builder, responses. Rejected:
    tabs on one screen, Settings, and reusing the Content table.
13. **Per-locale labels inside one form**, with the builder's locale switcher shown
    only when `config.locales` is set. Rejected: one form per language, which costs
    one word of code and drifts.
14. **An `open` switch plus an optional `closesAt`**, enforced at the route and
    advertised in the descriptor — both halves, because a cached page keeps serving
    the old markup for days after the switch flips.
15. **Unknown keys are dropped silently; `_` is Folio's reserved namespace.**
    Rejected: 422 on an undeclared key, which would fail the first time a
    `<button name=…>` or a password manager added one.
16. **Identical submissions collapse for 60 seconds**, in one statement with no
    read-then-write race. Rejected: an idempotency key in the descriptor — the same
    cache trap as the nonce.
17. **Deleting a form warns on both counts and then cascades**: the pages that render
    it, and the responses and files about to be destroyed. Rejected: refusing while
    either is non-zero.
18. **File uploads are in scope, gated hard.** *(Override: the recommendation was to
    defer them to their own spec.)* Decisions 14 and 15 carry the whole of it; it is
    the only public write path in Folio and is treated as one.
19. **Uploads live in the existing `media` bucket under a `sub_` prefix**, readable
    only through a gated route. Rejected: the media library (which would make every CV
    publicly readable by URL) and a second R2 binding.
20. **Nothing outside the admin reads responses**: no `/api/v1` route, no MCP tool, no
    in-process reader. The `submitted` hook is the entire programmatic surface.

## User stories

### Editor builds a contact form
**As** an editor **I want to** add name, email and message fields to a form and drop it
on a page **so that** the site can be contacted without a developer writing a route.

### Visitor with JavaScript disabled
**As** a visitor **I want** the form to work with a plain browser **so that** submitting
it is not conditional on a bundle loading.

### Marketer sees where leads come from
**As** a marketer **I want** each response to record which page it came from **so that**
I can tell the five landing pages apart.

### Developer forwards to their CRM
**As** a host developer **I want** one typed callback per submission **so that** every
response reaches HubSpot with my own key, my own retries and no webhook to secure.

### Publisher reads the week's submissions
**As** a publisher **I want** a table of responses with the newest first **so that**
"has anyone filled it in" is a glance and not a database query.

### Admin exports for the sales team
**As** an admin **I want** a CSV of a filtered set **so that** the data lands in the
spreadsheet everybody already uses.

### Recruiter collects CVs
**As** a recruiter **I want** applicants to attach a document **so that** an application
is one step, and **I want** that document to be unreachable to anyone without an
account.

### Editor closes applications
**As** an editor **I want to** set a closing date **so that** the form stops accepting
at midnight without me being awake.

### Owner deletes a campaign
**As** an owner **I want to** be told how many responses and files I am about to destroy
**so that** deleting a finished campaign is a decision and not an accident.

## Architecture decisions

### 1. A form is a row, not a document — and this is the expensive decision, taken deliberately

Everything else in Folio that an editor authors is a `stories` row with a Durable
Object behind it. That machinery is not decoration: it is versioning, draft-versus-live,
undo, the activity trail, multiplayer presence, `title_i18n`, `content_refs`, the block
tree, and one publish workflow. A `record`-kind document whose root block held question
bloks would have inherited **all** of it for the cost of two lines in a host's config.

The owner chose a bespoke table instead. That is a legitimate reading — a form is
closer to a redirect or a schedule than to a page, and both of those are bespoke tables
with bespoke screens (`0001_init.sql:211`, `0003_schedules.sql:27`) — but it is not
free, and pretending otherwise is how the cost gets discovered one screen at a time.
Four things do not come with it, and each has an explicit replacement here:

| Lost | Replacement | Where |
| --- | --- | --- |
| Draft vs live | Nothing. A save is live at once. | decision 7 |
| Version history | `forms.version`, stamped on each response | decision 7 |
| Concurrent editing | An `expectedUpdatedAt` guard and a 409 | decision 18 |
| Per-field translation | `FormField.i18n`, one level below `Blok.i18n`'s shape | decision 12 |

Two things it *gains*, and they are the reason the reading is defensible. A form is
**not published**, so there is no state in which the form an editor sees and the form a
visitor answers are different documents — a submission validates against exactly one
shape. And a form does not enter the URL namespace, the page tree, the sitemap, the
content index or the search index, none of which it has any business in.

**Rejected: both.** A `forms` table *and* a document wrapper would put one fact in two
places, which is the failure `content_index` exists to avoid at the other end.

### 2. Fields are one validated JSON column, and validation is a pure function shared three ways

`forms.fields` is a JSON array. Nothing filters or sorts by a form field; the whole
form is read together and written together; a form is bounded by what a person will
build, and `MAX_FORM_FIELDS = 60` says so out loud. So a builder save is one `update`
rather than a diff against existing rows — which is the place an off-by-one silently
drops a question.

`validateFormFields(input): FormField[]` lives in `src/core/forms.ts` and is called by
**three** callers: the PATCH route before it writes, the admin builder before it lets
you save, and the submit route when it compiles the descriptor. One implementation, one
test, and no way for the admin to permit a shape the server refuses.

The precedent is `api_tokens.scopes` and `stories.title_i18n`, both JSON columns, and
`parseScopes` (`roles.ts:83`) is the read-side rule this copies: **anything that is not
currently a declared kind is dropped on read**, so removing a field kind from the code
narrows every stored form instead of throwing on it.

**Rejected: a `form_fields` table with an `ord`.** Relational, queryable, and nothing
queries it. **Rejected: a blob plus a derived projection table.** Two write paths into
one fact, which is precisely what `full-text-search.md` decision 1 was careful not to
build.

### 3. The action URL names the form's **id**, and the id is anchored by a regex

A form's action is baked into published HTML that is cached for a week
(`DEFAULT_S_MAXAGE = 604_800`). So the thing it names has to be immutable: a slug in
the action would break every cached page for the whole TTL the moment somebody renamed
a form.

```
POST {base}/f/frm_<12 hex>
```

`FORM_ID` is `/^frm_[0-9a-f]{12}$/`, anchored the way `ASSET_KEY` is
(`validate.ts:691`) and for the same reason its header gives: a public unauthenticated
route whose parameter is a charset screen rather than a mint format is a primitive
somebody will find a use for. The route is on the **bare mount**, beside
`assetFileRoutes`, because a browser navigates to it — it is not `{base}/api`
anything.

`forms.name` still exists, and is a slug unique across the site. It is the admin's
stable handle and it is what rides back on the redirect as `folio_form=<name>`, so a
page carrying two forms can tell which one answered. It never appears in an action.

### 4. Rendering is a descriptor on the resolution, not markup — and the descriptor is compiled server-side

`resolveValue` takes `(field, value, resolution)` and has no access to the schema, the
database or the base path. Compiling a form needs all three. So the `form` field
resolves the way `collection` does (`resolve.ts:407`): the work happens in
`resolve()`, the answer lands in a map on the `Resolution`, and the field kind is a
lookup.

```ts
case 'form':
  return typeof value === 'string' ? (resolution.forms?.[value] ?? null) : null
```

`Resolution.forms?: Record<string, ResolvedForm>`, absent rather than `{}` when the
document embeds none — the same bootstrap-identical rule `docs` and `globals` follow.

**The read joins pass one's `Promise.all`, not a fifth serial round trip.** Form ids
come straight off the document walk and depend on nothing pass one returns, so waiting
would cost a full round trip for nothing — the identical mistake `runtime.ts:676-686`
records having already made once with `publishedDocsByIds`. `read-session.test.ts`'s
proxy is what makes the concurrency observable, and it must be extended here, because
both orderings return identical rows.

The descriptor is everything a host needs and nothing it has to derive:

```tsx
render({ form }) {
  if (!form) return null
  if (!form.open) return <p>{form.closedMessage}</p>
  return (
    <form method="post" action={form.action} encType={form.enctype}>
      {form.hidden.map((h) => <input key={h.name} type="hidden" name={h.name} value={h.value} />)}
      <input type="text" name={form.honeypot} tabIndex={-1} autoComplete="off" aria-hidden className="offscreen" />
      {form.fields.map((f) => <Input key={f.name} {...f} />)}
      <button>{form.submitLabel}</button>
    </form>
  )
}
```

`enctype` is on the descriptor rather than left to the host to work out, because
getting it wrong for a form with a file question produces a submission whose file is
the string `[object File]` and no error anywhere.

**Rejected: a `<FolioForm>` component.** Blocks are the host's components everywhere
else in this library; a form is the one place a design system has strong opinions, and
Folio shipping markup means shipping CSS somebody overrides. **Rejected: the host
walking the form's stored fields itself.** Every host would reimplement the action URL,
the i18n fallback, the hidden inputs and the honeypot, and four of the five would get
the fallback wrong.

### 5. A native POST is the transport; JSON is negotiated

`examples/demo/src/index.tsx:679` renders a page with `renderToReadableStream` and
attaches no client bundle. That is not an oversight in the demo, it is what a
Folio-rendered page *is* — so a form whose submission requires `fetch` would be a
feature that does not work on the only site in the repository.

One route, two answers, chosen by what the request says:

| Request | Success | Validation failure |
| --- | --- | --- |
| `content-type: application/json`, or `accept:` prefers it | `200 { ok: true, id }` | `422 { error: { code, message }, fields: { email: 'required' } }` |
| anything else | `303` to the target below | `303` with `folio_status=invalid` |

The 303 target is `redirectTo` when the form sets one and the submission succeeded;
otherwise the page it came from, taken from the `_folio_page` hidden input and, failing
that, `Referer` — both run through `safeNext` (`validate.ts:599`), which already exists
to stop a redirect parameter becoming an open redirect.

**303 rather than 302**, so the follow-up is a GET whatever the browser would otherwise
have done, and a refresh on the thank-you page does not re-post.

### 6. Nothing personal travels in the redirect, which is what lets the answer page cache

The redirect carries at most three parameters: `folio_status` (`ok` | `invalid` |
`closed` | `rate` | `verify` | `error`), `folio_form` (the form's slug) and
`folio_invalid` (a comma-separated list of field names).

That set is deliberate and the rule behind it is the load-bearing part: **no submitted
value, no response id, and no visitor identifier ever appears in a URL.** A URL is a
cache key, a `Referer` header, a browser history entry and a server log line, and a
thank-you page containing somebody's email address is all four.

The consequence is the good one. Because the parameters name nothing personal,
`?folio_status=ok` is an ordinary cacheable page: the host renders `successMessage`
from the descriptor, the edge caches it, and the next person to submit gets it as a
hit. `cacheKeyFor` (`cache-request.ts:93`) leaves them in the key, correctly — they
change the response, which is exactly the test that file applies.

### 7. Live edits, a version stamped on every response, and a purge that makes the cache window honest

There is no draft. Saving the builder changes the live form at once. `forms.version`
starts at 1 and increments when the **shape** changes — a field added, removed, renamed,
retyped, made required or not, or its option values changed. A label, help text,
placeholder or translation edit does not bump it. `shapeOf(fields): string` is a pure
function over the shape-bearing keys only, compared against what is stored, and it is
unit-tested in Node.

Every response stores the version it was validated against. That is what makes a
two-year-old response readable after the form has moved on, and what lets the detail
drawer say *"this field is no longer in this form"* rather than showing a key nobody
can explain.

**A structural save purges the pages that render the form.** This is the part that
matters, and it is why the version stamp does not have to do more work than it does. A
page cached for a week holds the old markup; if the form gained a required field, every
cached visitor would submit something the live form refuses, and they would see an
error they could not possibly fix. So a `formChanged` hook fires on any structural save
and Folio's own internal hook purges `formTag(id)` — decision 8. The window is then the
purge latency, not the TTL.

**Rejected: validating against the version the page claimed.** A hidden `_folio_v` is
client-asserted, so a bot claims v1 forever and every constraint added since is
optional. There is deliberately no such hidden input; the submission is validated
against the live form, full stop, and the purge is what keeps that fair.

### 8. Two dependency records, for two different questions

They look like duplicates and they answer different things:

- **`formTag(id)` = `form:<id>`**, emitted by `cacheTags` from `resolution.forms`
  exactly as `globalTag` is emitted from `resolution.globals` (`cache-tags.ts:168`).
  This answers *"which cache entries must go"*, and it is computed at render, which is
  that file's whole thesis. A structural form save purges one tag with **no lookup at
  all**.
- **A `content_refs` row of `kind: 'form'`**, written by the publish projection.
  This answers *"which published documents render this form"* — the delete dialog's
  first number, and a question a cache tag cannot answer because a tag is a string
  nothing joins on.

`content_refs.kind` has no CHECK (`0002_asset_refs.sql:9-10`), and `to_id` already
*"holds whatever `kind` says it holds"* (`refs.ts:38`), so a fourth kind is one entry
in a union and one case in the `refs.ts` walk. No DDL.

**Rejected: computing the purge set from `content_refs`.** `caching.md` decision 2
already refused it for the general case, and the refusal holds here too: that table
truncates at 400 rows per document, so a form on 500 pages would silently leave 100 of
them stale.

### 9. Three abuse controls, and the two a week-long cache rules out

A public endpoint that writes a row is a public endpoint that writes a million rows.
Three controls, and each is chosen for surviving a cached page:

1. **A honeypot.** The descriptor names one decoy field; a submission that fills it is
   answered `200`/`303 ok` and stored nowhere. Free, stateless, entirely
   cache-compatible, and it catches the bots that fill every input. The name is minted
   deterministically from the form id out of a fixed pool of plausible-looking names
   (`company_website`, `fax`, …) rather than being `_hp` — a reserved-looking name is a
   name a competent bot skips. It is stable per form, so a cached page and the live
   route always agree, and the builder refuses a field whose slug collides with it.
2. **`verify`, a host function in config.** `FolioGate`'s shape (`types.ts:194`): the
   host receives the request and the parsed body and answers a boolean. Turnstile and
   hCaptcha both issue their token **client-side at submit time**, which makes them the
   one mechanism a week-old cached page cannot invalidate. Folio holds no key, calls no
   third party, maintains no vendor list and needs no timeout policy anybody will
   disagree with. Absent is the whole of "this site does not verify".
3. **A per-IP-hash rate limit.** `count(*)` over a window, the shape
   `recentChallengeCount` (`challenges.ts:86`) already has, defaulting to 10 per hour
   and configurable 1–100. Like that one, it is *partial* and says so: it bounds a
   script, not a botnet.

**Rejected: a signed nonce with a minimum fill time.** It is the standard answer and it
is wrong here. A page cached for a week hands every visitor the same token with the
same issue time, so "was this filled in under two seconds" is a question about when the
page was *rendered* — meaningless — and any TTL on the token rejects genuine
submissions from the cache's own lifetime. **Rejected: an idempotency key in the
descriptor**, which fails identically.

### 10. The IP hash carries the hour it was made in, so it expires without a sweep

```
ip_hash = sha256(ip : form_id : floor(now / 3_600_000))
```

The raw address is never stored. Including the form id means the same visitor is
unlinkable across two forms on the same site; including the hour bucket means the value
**stops being computable from the visitor's IP as soon as that hour passes**. Nobody
holding the database can turn a stored hash back into "this person", not because a job
deleted it but because there is no longer a preimage anyone will look for.

The limiter holds the raw IP at check time, so it derives the current *and* previous
bucket and counts rows matching either within the window — a true rolling 1–2 hour
window, at the cost of one extra bind.

This is what makes checkpoint 9's "retention is manual" defensible. Without it, the one
quasi-identifier in the table would sit there until somebody remembered to remove it,
and spec 28's `sweepAuth` paragraph is a full page on exactly how reliably that gets
remembered. **Rejected: clearing the column on a schedule** — a second host obligation
with no signal when it is forgotten. **Rejected: sweeping opportunistically on write**,
which `auth-providers.md` rejects in terms this spec has no reason to relitigate: *"it
puts an unbounded write on the latency path of the one request a person is waiting
on"*.

### 11. `verify` fails closed, including when it throws

A `verify` that returns false refuses the submission. A `verify` that **throws** also
refuses it, logged with one line, the way `runOne` logs a failed hook
(`hooks.ts:241`).

This is the opposite posture to the hooks it sits beside, and the difference is the
point. A hook runs *after* a write has committed and its failure must never undo one —
so a Slack outage cannot break publishing. `verify` runs *before* a write and its whole
job is to refuse traffic nobody can vouch for. A captcha that opens on error is
decorative: the first thing an attacker does is make it error.

**Rejected: failing open on a throw.** It converts a vendor outage from "the form is
briefly unavailable" into "the form is briefly unprotected", and the second is the
state somebody is waiting for. The refusal answers `folio_status=verify` so a host can
say something more useful than "invalid".

### 12. Localisation is per field, inside the form, and the picker is not translatable

Each field carries an optional `i18n` map for its `label`, `help`, `placeholder` and
its options' labels — `Blok.i18n`'s shape one level down, resolved through
`localeChain` (`locales.ts:130`) so an untranslated label falls back to the source
rather than leaving a hole. The descriptor is compiled in the render's locale, so a
host writes no locale code at all. The response records which locale it was submitted
in.

**The `form` field kind is deliberately not `translatable`.** It could have been — a
French page pointing at a French form costs one word — and then there would be two
mechanisms for one job, with no rule for which wins when a site used both. One form,
one response bucket, one place to add a question.

The builder shows a locale switcher **only when `config.locales` is set**
(`manifest.locales`, which the admin already reads for the editor's switcher), so a
single-locale site never sees that this exists.

### 13. Unknown keys are dropped; `_` is Folio's namespace

A real browser POST carries more than the form's fields: the submit button's `name`,
the honeypot, whatever a password manager or an extension injected, and whatever a
Turnstile widget named its own input.

- **`_`-prefixed names are reserved for Folio** (`_folio_page` today) and are never
  stored as answers. The builder refuses a field slug starting with `_`.
- **Every other undeclared key is dropped**: not stored, not counted, not an error.
- **A host that wants to pass its own value declares a `hidden` field for it** — a
  campaign id, a source — and it is then validated, stored and exported like any other
  answer.

**Rejected: 422 on an undeclared key.** Strict, legible, and it would break the first
time a `<button name="submit">` appeared in somebody's markup. **Rejected: an `extra`
JSON column** holding whatever arrived — unvalidated, unbounded personal data nobody
asked for, in the one table where that matters most.

Note the ordering constraint this creates: `verify` receives the **raw** body, before
the drop, because the token it needs is under a name Folio does not know.

### 14. Identical submissions collapse for sixty seconds, in one statement

```sql
insert into form_responses (id, form_id, version, created_at, data, locale, page, ip_hash, body_hash, files)
select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
where not exists (
  select 1 from form_responses
  where form_id = ?2 and body_hash = ?9 and created_at > ?11
);
```

One statement, so there is no read-then-write pair for two clicks to race through —
the same property `consumeChallenge` (`challenges.ts:58`) gets from putting both rules
in one `where`. `changes = 0` means it was a duplicate, and the response is still
success, because from the visitor's side it worked.

`body_hash` is a SHA-256 over the canonicalised declared answers plus, for each file,
its field name, size and content hash. Hashing the file bytes matters: it is what lets
the duplicate check run **before** anything is put to R2, so a double-click uploads a
5MB CV twice and stores it once.

A genuine second submission a minute later is a new row. That is the right side to be
wrong on: a lost duplicate is invisible, and a lost genuine submission is somebody who
thinks they contacted you.

### 15. Uploads are `sub_` keys the public route cannot serve, and always an attachment

This is the only public write path in Folio, and the design leans on a property that is
already in the code rather than adding a new refusal to remember.

Keys are minted `sub_<12 hex>-<safeFilename>` into the **existing `media` bucket**. No
`assets` row is written, so strangers' uploads never appear in the media library. And
`{base}/asset/:key` **physically cannot serve them**: `ASSET_KEY` is anchored to
`^ast_[0-9a-f]{12}-…` (`validate.ts:691`), so a `sub_` key is a 400 from the parameter
validator before a handler runs. There is no new guard, so there is no new guard to
forget.

Reading one back is `GET {base}/api/forms/:id/responses/:rid/file/:name` behind the
`FORMS` gate, and the response headers are the same set `serveAsset` uses
(`assets.ts:499-517`) with two deliberate differences: the content type is **always**
`application/octet-stream` and the disposition is **always** `attachment`, however the
bytes sniffed. `serveAsset` serves an allowlisted type inline because a Folio asset is
a site's own image in its own markup; these bytes came from a stranger, and there is no
case for rendering them in a browser tab at all. `cache-control` is `NO_STORE`.

The write path mirrors `uploadAsset` (`assets.ts:286`) point for point:
`contentLengthHeader` refuses a declared length over the cap before a byte is read;
`readCappedBody` makes the cap real for a request that declared nothing;
`sniffContentType` decides what the file *is* from its bytes rather than trusting the
header; R2 first, then the row, with a compensating `bucket.delete` if the insert
throws or the duplicate guard fires.

Per-question limits: an `accept` chosen from a fixed menu (`documents` | `images` |
`both`), and a `maxBytes` clamped to `MAX_UPLOAD_BYTES` (20MB, `assets.ts:26`). One
file per question, so the field name identifies the object. **A form's total cap is the
sum of its questions' caps plus a fixed text allowance**, and that number is what the
route passes to `readCappedBody` — not `MAX_UPLOAD_BYTES`, which for a form with no
file question would let a stranger stream 20MB into a Worker for nothing.

**`media` is required only for a form that declares a file question.** Absent, the
builder refuses to add one and the submit route answers `unsupported` naming the
binding — the legible refusal `FolioBindings` (`types.ts:71`) already gives for
`media`, `images` and `browser`.

### 16. The export is streamed, its header is exact, and every cell is de-fanged

`GET {base}/api/forms/:id/responses.csv` at `ADMIN`, honouring the same filter the
table is showing, walking keyset pages into a `ReadableStream` so a 50,000-row form is
never one buffered string.

**The header is the exact union of keys ever submitted**, obtained with one query
before the first row is written:

```sql
select distinct j.key from form_responses, json_each(form_responses.data) j
where form_responses.form_id = ?
```

SQLite's JSON1 is built into D1, so this costs one scan of the form's responses and
removes the need to buffer the export to discover its own columns. Current fields come
first in the form's order, retired keys after, sorted. A current field missing from an
older response renders `—`, not empty, because "this did not exist yet" and "they left
it blank" are different facts.

**Every cell beginning `=`, `+`, `-` or `@` is prefixed with an apostrophe.** CSV
formula injection is a real attack — a cell reading `=cmd|'/c calc'!A1` executes when
the file is opened in Excel — and a form is precisely where hostile input arrives. This
is not a hypothetical for a feature whose entire input surface is strangers.

**The responses *table* does not use the union query**, and the asymmetry is
deliberate: a full scan per screen load is not a page render's budget. The table's
columns are the form's current fields; the detail drawer shows every key a response
holds, marking the ones no longer in the form. The export is where completeness is
worth a scan.

**Rejected: two passes, or buffering the export to compute its header.** **Rejected:
NDJSON alongside CSV** — two formats, two escaping stories, one of which gets tested.

### 17. Retention is manual, and here is what that costs

There is no sweep, no cron, no `retentionDays` and no host obligation. A response is
deleted when somebody deletes it: singly, in bulk over a selection, or with the form.

The owner chose this over a per-form window swept from the host's existing
`scheduled()`. It is a smaller feature and a real liability, and the spec states it
plainly rather than leaving it to be discovered: **personal data accumulates in
`form_responses` indefinitely and nothing will remind anyone.** Two things carry weight
instead of a sweep, and neither is a substitute for one:

- Decision 10 means the only quasi-identifier Folio adds itself — the IP hash — stops
  being usable after two hours regardless. What accumulates is what the visitor typed,
  which is what they meant to send.
- The responses screen shows the age of the oldest row, so the surface that would
  display the symptom displays it. That is spec 28's answer to the same problem
  (`auth-providers.md`: *"a route that answers 'the oldest event here is 400 days old'
  on a table with 90-day retention has said the thing no log line was going to say"*).

Adding `retentionDays` later is additive: one column, one statement, one call. This
decision is the cheapest of the twenty to reverse, and it is the only one whose cost is
paid by somebody who is not in the room.

### 18. Concurrency on a form is an `expectedUpdatedAt` guard, because forms are outside the mutation log

Every other authored thing in Folio is edited through `StoryDO`'s log, where two people
typing produce a merge and a presence dot. A form is a row, so two people editing one
produce last-write-wins, and the loser's deleted question comes back or the winner's new
one vanishes — silently, which is the part that matters.

So `PATCH {base}/api/forms/:id` carries `expectedUpdatedAt`, and answers `409 conflict`
when the stored value has moved. The builder reloads and says so. This is the whole of
the concurrency story, it is weaker than the document editor's, and it is the direct
cost of decision 1 — recorded here so that when somebody asks "why can two people not
edit a form together", the answer is a sentence and not an investigation.

**Rejected: no guard.** A CMS that loses an editor's work without saying so is worse
than one that refuses. **Rejected: a Durable Object per form**, which is decision 1 by
another route and at a higher price.

## Wire & schema changes

### D1 migration `0010_forms.sql`

```sql
-- Forms and their responses (docs/specs/content-model/forms.md).
--
-- Two tables and no foreign keys, following every migration since 0002: D1 has
-- foreign keys off by default, and the two delete paths that matter here are
-- explicit batches rather than cascades (decision 17 of the spec, and the
-- delete dialog that names both counts before either runs).
--
-- No CHECK constraint anywhere, following 0002/0003/0004: SQLite cannot widen
-- one without rebuilding the table, and `versions.kind` is the standing reminder
-- of what that costs. Every enum-shaped value here -- a field's `kind`, a file's
-- `accept` -- lives inside the JSON columns and is screened on read the way
-- `parseScopes` screens `api_tokens.scopes`.

create table forms (
  -- 'frm_<12 hex>'. Immutable, and it is what the action URL in published HTML
  -- names -- so renaming a form must never touch it (decision 3).
  id              text primary key,
  -- Slug. The admin's handle and what rides back on a redirect as
  -- `folio_form=<name>`, so a page with two forms can tell which one answered.
  -- Never part of an action URL.
  name            text not null,
  label           text not null,
  -- JSON array of FormField. Validated by core/forms.ts `validateFormFields` on
  -- every write, and screened on read: a kind this build does not know is
  -- dropped rather than thrown on. Bounded at MAX_FORM_FIELDS (60).
  fields          text not null default '[]',
  -- Bumped when the SHAPE changes -- a field added, removed, renamed, retyped,
  -- made required, or its option values changed. NOT bumped by a label, help,
  -- placeholder or translation edit. `shapeOf` is the pure function that decides
  -- (decision 7), and every response stores the version it answered.
  version         integer not null default 1,
  -- The editor's switch. `closes_at` is the clock's half: the EFFECTIVE state is
  -- `open = 1 and (closes_at is null or closes_at > now)`, computed in the where
  -- clause. There is deliberately no stored "closed" flag for a cron to flip and
  -- for the clock to disagree with -- 0004_shares.sql's live/lapsed rule.
  open            integer not null default 1,
  closes_at       integer,
  closed_message  text not null default '',
  success_message text not null default '',
  submit_label    text not null default 'Submit',
  -- Where a successful native POST lands. Null means "back to the page it came
  -- from", which is the ordinary case and needs no thank-you page to exist.
  redirect_to     text,
  created_at      integer not null,
  -- The optimistic-concurrency token. PATCH carries the value it read and gets a
  -- 409 if it has moved (decision 18) -- this table is outside the mutation log,
  -- so this is the whole of its concurrency story.
  updated_at      integer not null
);

-- The slug's uniqueness, and the lookup behind it.
create unique index forms_name on forms (name);
-- The list screen's only ordering: most recently changed first.
create index forms_updated on forms (updated_at desc, id);

create table form_responses (
  -- 'res_<12 hex>'.
  id         text primary key,
  form_id    text not null,
  -- The forms.version this was validated against -- server-authoritative, never
  -- what the page claimed (decision 7). A cached page showing an older shape
  -- submits against the live form; the formChanged purge is what keeps that fair.
  version    integer not null,
  created_at integer not null,
  -- JSON object keyed by field name. Declared fields only: everything else the
  -- browser sent is dropped (decision 13).
  data       text not null default '{}',
  -- Which language the page was rendered in. '' for a single-locale site, the
  -- same convention content_index uses for its source-locale rows.
  locale     text not null default '',
  -- The path the host's own hidden input said this came from, or '' when it set
  -- none. Host-supplied rather than sniffed from Referer, which is stripped or
  -- forged often enough to be a lie.
  page       text not null default '',
  -- sha256(ip : form_id : floor(now / 1h)). The raw address is NEVER stored, and
  -- the hour bucket means this stops being computable from an IP once that hour
  -- passes -- it expires by construction rather than by a sweep (decision 10).
  -- Null when the request carried no client IP (a local dev run).
  ip_hash    text,
  -- sha256 of the canonical answers plus each file's (name, size, content hash).
  -- Hashing the bytes is what lets the 60-second duplicate check run BEFORE
  -- anything is put to R2 (decision 14).
  body_hash  text not null,
  -- JSON array of { field, key, filename, size, contentType }. `key` is an R2
  -- key under the `sub_` prefix, which the public asset route cannot serve
  -- because ASSET_KEY is anchored to `ast_` (decision 15).
  files      text not null default '[]'
);

-- The responses table's keyset: newest first, per form.
create index form_responses_form on form_responses (form_id, created_at desc, id);
-- The duplicate collapse's reader, run once per submission.
create index form_responses_dupe on form_responses (form_id, body_hash, created_at desc);
-- The rate limit's reader. Partial, the shape 0003_schedules.sql established:
-- the index holds only the rows the query wants, and a row with no client IP is
-- not one of them.
create index form_responses_throttle
  on form_responses (ip_hash, created_at desc) where ip_hash is not null;

-- Deliberately absent, each asserted in test/workers/migrations.test.ts so
-- adding one is a deliberate act with a measurement behind it:
--
--   * a `form_fields` table -- fields are one JSON column (decision 2), and a
--     projection table would be a second write path into one fact;
--   * an index on forms.label -- nothing sorts by it, and forms_name already
--     serves lookup on a table bounded by what a person will build;
--   * an index on form_responses.data -- the responses search is a substring
--     scan by decision 16's sibling reasoning, and no index serves a leading
--     wildcard LIKE anyway;
--   * a "closed" or "status" column on forms -- the effective state is computed
--     from `open` and `closes_at` against the clock (0004_shares.sql's rule).
--
-- `content_refs` gains a fourth `kind` ('form') with NO DDL: 0002_asset_refs.sql
-- records that `kind` carries no CHECK and that `to_id` holds whatever `kind`
-- says it holds. A row is (from_story = the page, to_id = a form id).
```

### Core types

New file `src/core/forms.ts`.

```ts
export type FormFieldKind =
  | 'text' | 'textarea' | 'email' | 'tel' | 'url' | 'number' | 'date'
  | 'select' | 'radio' | 'checkbox' | 'checkboxes'
  | 'file' | 'hidden' | 'statement'

/** What a `file` question will take. A fixed menu, not a free content-type list:
 *  an editor should not be able to invite `application/x-msdownload`. */
export type FileAccept = 'documents' | 'images' | 'both'
export const FILE_ACCEPT: Record<FileAccept, readonly string[]>

export interface FormFieldOption { value: string; label: string }

/** Per-locale overrides. `Blok.i18n`'s shape one level down (decision 12). */
export interface FormFieldI18n {
  label?: string
  help?: string
  placeholder?: string
  /** Keyed by option `value`. */
  options?: Record<string, string>
}

export interface FormField {
  /** Slug, unique within the form. **This is the HTML input's `name`**, so it is
   *  what a submission's keys are and what a CSV column is headed. Renaming one
   *  splits a column; the builder says so. */
  name: string
  kind: FormFieldKind
  label: string
  help?: string
  placeholder?: string
  required?: boolean
  /** `maxlength` for text kinds; `max` for `number`. */
  max?: number
  min?: number
  /** An HTML `pattern` the host may put on the input, and which the server
   *  re-checks. Bounded, and compiled once at validation so a pathological
   *  expression is refused at save time rather than at submit time. */
  pattern?: string
  options?: readonly FormFieldOption[]
  accept?: FileAccept
  maxBytes?: number
  /** `hidden` only: the value the host's markup emits. */
  value?: string
  /** `statement` only: prose between questions. Renders no input and stores
   *  nothing. */
  text?: string
  i18n?: Record<string, FormFieldI18n>
}

export const MAX_FORM_FIELDS = 60
/** Names beginning with this are Folio's (decision 13). The builder refuses one. */
export const RESERVED_PREFIX = '_'

export function formSlug(raw: string): string
/** The one validator, called by the PATCH route, the builder and the compiler. */
export function validateFormFields(input: unknown): FormField[]
/** The shape-bearing projection `version` is bumped from (decision 7). Pure. */
export function shapeOf(fields: readonly FormField[]): string
/** Deterministic per form, from a fixed pool, avoiding the form's own slugs. */
export function honeypotName(formId: string, taken: readonly string[]): string
```

The descriptor, also in `core/forms.ts` because both the renderer and the compiler read
it:

```ts
export interface ResolvedFormField {
  name: string
  kind: FormFieldKind
  /** Already resolved through the locale chain. */
  label: string
  help?: string
  placeholder?: string
  required: boolean
  max?: number
  min?: number
  pattern?: string
  options?: readonly FormFieldOption[]
  accept?: readonly string[]
  maxBytes?: number
  value?: string
  text?: string
}

export interface ResolvedForm {
  id: string
  /** The slug, for a page carrying two forms. */
  name: string
  /** `{base}/f/<id>`. Computed at render, never stored — remounting Folio under a
   *  different base path must not invalidate anything, the rule `assetBase`
   *  already follows. */
  action: string
  method: 'post'
  enctype: 'application/x-www-form-urlencoded' | 'multipart/form-data'
  version: number
  /** `open` and the clock, together. */
  open: boolean
  fields: readonly ResolvedFormField[]
  /** `_folio_page` when the render knows its path; empty otherwise. */
  hidden: readonly { name: string; value: string }[]
  honeypot: string
  submitLabel: string
  successMessage: string
  closedMessage: string
  redirectTo: string | null
}
```

Changes to existing core files:

- `fields.ts:105` — the union gains `| ({ kind: 'form' } & Common)`. **Neither
  `Indexable` nor `Searchable`**: a form has no scalar to sort by and no prose to
  index. `ValueOf` (`:251`) maps it to `ResolvedForm | null`; `defaultValue` (`:283`)
  answers `''`, as `reference` does.
- `resolve.ts:61` — `Resolution` gains `forms?: Record<string, ResolvedForm>`.
  `resolveValue` (`:427`) gains the `case 'form'` the exhaustive switch demands.
- `refs.ts:43` — `OutboundRef.kind` gains `'form'`; the walk at `:193` gains a case;
  a new `formIds(doc, schema)` answers the ids `resolve()` must load, walking `i18n`
  as every other walk in that file does.
- `cache-tags.ts` — `formTag(id) = \`form:${encode(id)}\``, emitted by `cacheTags`
  (`:162`) from `resolution.forms`, one line beside the `globals` loop.

**Backwards compatibility:** not a consideration, per `CLAUDE.md`. Nothing stored
changes meaning, the mutation log is untouched, and no wire frame gains or loses a
field. **`PROTOCOL_VERSION` stays at 4.** The preview *bootstrap* (`window.__FOLIO__`)
carries a `Resolution`, so it gains a key — which is `globals.md`'s precedent
exactly: the bootstrap is not the postMessage protocol and needs no version.

### Server types

```ts
// FolioConfig
forms?: FolioForms<Env>

export interface FolioForms<Env> {
  /**
   * Human verification. Receives the **raw** body, before undeclared keys are
   * dropped, because the token's name belongs to the host's widget and Folio
   * does not know it. Returning false refuses; throwing also refuses
   * (decision 11).
   */
  verify?: (
    input: { req: Request; body: Readonly<Record<string, string>>; form: FormMeta },
    env: Env,
  ) => boolean | Promise<boolean>
  /** Submissions per IP-hash per hour. Default 10, clamped 1–100; 0 disables. */
  ratePerHour?: number
}
```

Validated at construction alongside `gate`, `hooks` and `migrations` — `verify` must be
a function, `ratePerHour` an integer in range, and no unknown keys — because *a
configuration mistake in a CMS should not become a runtime 500*.

Two new hook events, both added to `HookEvent` (`hooks.ts:19`) **and** to
`HOOK_EVENTS` (`:38`), which `test/unit/server/pure.test.ts` already pins as a pair:

```ts
export interface SubmittedHookPayload<Env> extends HookBase<Env> {
  form: FormMeta
  response: FormResponse
  files: readonly SubmittedFile[]
}

/** A structural save. Folio's own internal hook purges `form:<id>`; a host may
 *  hang its own work off it. `redirectsChanged`'s shape (`hooks.ts:139`). */
export interface FormChangedHookPayload<Env> extends HookBase<Env> {
  form: FormMeta
  /** Absent for a label-only save, which fires nothing. */
  version: number
}
```

`HookBase.actor` is `string | null` and a public submission is `null`, which is the
honest answer rather than an invented one — the same thing `actorString` already
answers under `auth: 'open'`.

`SCOPES` (`roles.ts:43`) gains `'forms:read'`; `IMPLIES` (`:64`) grants it under
`admin` and under itself, and nothing else — reading responses is not implied by
writing content, which is decision 8's point. A new `Access`:

```ts
/** Reading submitted responses. Publisher, not viewer: these rows are what
 *  strangers typed about themselves. */
export const FORMS: Access = { role: 'publisher', scope: 'forms:read' }
```

### New or changed routes

All under `{base}/api` — the admin's internal, unversioned surface — except the public
submit and the two noted.

**Forms**

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/forms` | `READ` | Keyset over `(updated_at desc, id)`. `?count=1` for the total, `?counts=1` for a response count per form — one grouped query, opt-in, `?count=1`'s own rule. |
| `POST` | `/forms` | `EDIT` | `{ label, name? }` → the row. 409 on a slug collision, naming the existing form. |
| `GET` | `/forms/:id` | `READ` | The form with its fields. |
| `PATCH` | `/forms/:id` | `EDIT` | `{ expectedUpdatedAt, label?, name?, fields?, open?, closesAt?, successMessage?, closedMessage?, submitLabel?, redirectTo? }`. 409 on a stale `expectedUpdatedAt` (decision 18). Bumps `version` and fires `formChanged` on a shape change only. |
| `DELETE` | `/forms/:id` | `ADMIN` | Cascades responses and their R2 objects. `{ deleted: true, responses: n, files: n }`. |
| `GET` | `/forms/:id/usage` | `EDIT` | The published documents that render it, from `content_refs`. `/assets/:id/usage`'s shape and its access. |

**Responses**

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/forms/:id/responses` | `FORMS` | Keyset over `(created_at desc, id)`. `?from=`, `?to=`, `?q=` (a substring scan over `data`), `?count=1`. Also answers `oldest`, the age of the oldest row for this form (decision 17). |
| `GET` | `/forms/:id/responses/:rid` | `FORMS` | One response, every key it holds, each marked whether the current form still declares it. |
| `GET` | `/forms/:id/responses/:rid/file/:name` | `FORMS` | Streams from R2. Always `application/octet-stream`, always `attachment`, `nosniff`, `NO_STORE`. |
| `DELETE` | `/forms/:id/responses/:rid` | `ADMIN` | D1 before R2, the R2 failure swallowed — `deleteAsset`'s rule. |
| `POST` | `/forms/:id/responses/delete` | `ADMIN` | `{ selection }` as `BulkSelection<ResponseFilter>`. Answers a `BulkReport`, or 409 with a `BulkRefusal` when the count guard fires. |
| `GET` | `/forms/:id/responses.csv` | `ADMIN` | Streamed, honouring the same filter. Not JSON, deliberately, and it carries `content-disposition: attachment`. |

**Public**

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `POST` | `{base}/f/:id` | none | On the **bare mount**, beside `assetFileRoutes`. Answers 303 or JSON by negotiation. Never cached: `cacheVerdictFor`'s rule 1 bypasses every non-GET. |

**No `{base}/api/v1/forms` and no MCP tool** (checkpoint 20). A version segment is a
promise, nobody has asked for this one, and the `submitted` hook already hands a host
every response the moment it arrives, in process, with no polling and no credential.
Adding either later is additive.

## Acceptance criteria

### A form works with JavaScript disabled

```
GIVEN a published page rendering a form, loaded with scripting off
WHEN the form is submitted
THEN a row exists in `form_responses` with the typed values
AND the browser lands on the same page with `?folio_status=ok&folio_form=contact`
AND the response was a 303, so a refresh does not re-post
```

### The action names an id, not a slug

```
GIVEN a form whose slug is `contact`, rendered into a page cached for a week
WHEN the form is renamed to `contact-us`
THEN the cached page's action still resolves to the same form
AND `folio_form` on the next redirect reads `contact-us`
```

### Nothing personal reaches a URL

```
GIVEN any submission, valid or not
WHEN the 303 is issued
THEN its query carries only `folio_status`, `folio_form` and `folio_invalid`
AND no submitted value, response id or visitor identifier appears in it
AND the redirect target is same-origin, having gone through `safeNext`
```

### A structural change purges the pages that render it

```
GIVEN a form rendered on three published pages
WHEN a required field is added
THEN `forms.version` increments
AND `formChanged` fires
AND a purge is issued for exactly `form:<id>`
AND a label-only edit does neither
```

### The count guard holds for responses

```
GIVEN a filter matching 400 responses, shown to a person as "400"
AND 3 more arrive before the bulk delete is posted
WHEN it is posted with `expected: 400`
THEN it is refused 409 with `refused: 'count'`, `expected: 400`, `actual: 403`
AND nothing was deleted from D1 or R2
```

### A closed form refuses at the route, not only in the markup

```
GIVEN a form whose `closesAt` has passed
AND a page cached before it closed, still serving the form's markup
WHEN that markup is submitted
THEN the route answers `folio_status=closed`
AND no row is written
```

### The honeypot looks like success

```
GIVEN a submission that fills the honeypot field
WHEN it is posted
THEN the answer is 200/303 `ok`
AND no row exists
AND no `submitted` hook fired
```

### `verify` fails closed

```
GIVEN a configured `verify` that throws
WHEN a submission arrives
THEN it is refused with `folio_status=verify`
AND nothing was written
AND one line was logged
```

### The rate limit spans the hour boundary

```
GIVEN a limit of 10 per hour and 10 submissions at 10:58 from one address
WHEN an eleventh arrives at 11:01
THEN it is refused, because the check counts the current AND previous bucket
AND a submission from the same address at 12:30 is accepted
AND no raw IP address exists anywhere in the database
```

### A double-click stores one row and one object

```
GIVEN a form with a file question
WHEN the identical submission is posted twice within 60 seconds
THEN exactly one row exists
AND exactly one object exists in R2
AND both requests answered success
```

### An uploaded file is not publicly readable

```
GIVEN a response carrying `sub_ab12cd34ef56-cv.pdf`
WHEN `GET {base}/asset/sub_ab12cd34ef56-cv.pdf` is requested with no credential
THEN it is a 400 from `assetKeyParam`, before any handler runs
AND the same object downloads through the gated route for a publisher
AND that response is `application/octet-stream`, `attachment` and `no-store`
```

### Undeclared keys are dropped, declared hidden ones are kept

```
GIVEN a form declaring `name`, `email` and a hidden `source`
WHEN a POST arrives carrying those three plus `submit`, `_folio_page`,
     the honeypot and `utm_medium`
THEN the stored `data` has exactly `name`, `email` and `source`
AND `page` holds `_folio_page`'s value
AND the request was not refused
```

### A retired field is still readable

```
GIVEN responses at version 3 holding `budget`, and a form now at version 4 without it
WHEN the responses table is read
THEN the table's columns are the current fields
AND a response's drawer shows `budget`, marked as no longer in this form
AND the CSV's header contains `budget`
AND a v3 response's `company` cell reads `—`
```

### The export cannot execute in a spreadsheet

```
GIVEN a response whose `message` is `=cmd|'/c calc'!A1`
WHEN the CSV is exported
THEN that cell is quoted and prefixed with an apostrophe
AND the export streamed, having buffered no more than one keyset page
```

### Deleting a form says what it will destroy

```
GIVEN a form rendered on 3 published pages, with 412 responses and 12 files
WHEN the delete dialog is opened
THEN it names all three numbers
AND confirming removes the form row, all 412 responses and all 12 R2 objects
AND the 3 pages render nothing where the form was
```

### A form embeds without a second round trip

```
GIVEN a page whose document embeds one form
WHEN it is rendered
THEN the form was read concurrently with the story map, not after it
AND a page embedding no form issued no forms query at all
AND the rendered response carries a `form:<id>` cache tag
```

## Implementation plan

Eight phases. 1–4 are a working form with no files and no admin; 5 adds uploads; 6–7
are the two screens; 8 is the demo and the prose. Each leaves the tree green.

### Phase 1 — the migration and the core vocabulary

1. `migrations/0010_forms.sql`, exactly as above.
2. `src/core/forms.ts` — `FormFieldKind`, `FormField`, `FormFieldI18n`,
   `ResolvedForm`, `ResolvedFormField`, `formSlug`, `validateFormFields`, `shapeOf`,
   `honeypotName`, `MAX_FORM_FIELDS`, `FILE_ACCEPT`.
3. The `form` field kind: `fields.ts` union, `ValueOf`, `defaultValue`;
   `resolve.ts`'s `Resolution.forms` and the `resolveValue` case; `refs.ts`'s
   `formIds` and the fourth `OutboundRef` kind; `cache-tags.ts`'s `formTag`.
4. `test/workers/migrations.test.ts` gains a `describe` per table in the existing
   shape, with exact column and index lists and the four named absences.

Leaves a field kind that always resolves to `null`, because nothing populates the map
yet.

### Phase 2 — the store, server side

1. `src/server/forms.ts` — `listForms` (keyset), `formById`, `formByName`,
   `createForm`, `updateForm` (the `expectedUpdatedAt` guard, the `shapeOf` comparison,
   the `version` bump), `deleteForm` (the cascade), `formsByIds` (the resolve read),
   `countResponsesByForm`. `FolioDb`, never `D1Database`.
2. Validators in `validate.ts`: `FormCreateBody`, `FormPatchBody`, `formIdParam`
   (`^frm_[0-9a-f]{12}$`), the response filter's query parsers.
3. `src/server/routes/forms.ts` — the six form routes.
4. `formChanged` in `hooks.ts` (both lists), and its entry in `cachePurgeHooks`.

### Phase 3 — resolution and the descriptor

1. `compileForm(row, opts): ResolvedForm` in `server/forms.ts` — the locale chain, the
   action from `rt.base`, the enctype, the honeypot, `_folio_page` when `opts.story`
   is present.
2. `resolve()` in `runtime.ts`: the forms read joins pass one's `Promise.all`, and
   `Resolution.forms` is spread on only when non-empty.
3. `content-index.ts`: the publish projection emits `kind: 'form'` edges.
4. `read-session.test.ts` gains the concurrency assertion, because both orderings
   return identical rows and nothing else can see the difference.

### Phase 4 — the public submit route

1. `src/server/form-responses.ts` — `validateSubmission` (pure: a body and a field
   list in, values and per-field errors out), `throttleHashes`, `recentSubmissionCount`,
   `insertResponse` (the one-statement duplicate collapse), `listResponses`,
   `responseById`, `deleteResponses`.
2. `formSubmitRoutes` on the bare mount in `app.ts`, beside `assetFileRoutes`: parse,
   closed check, honeypot, `verify`, throttle, validate, insert, hook, negotiate the
   answer.
3. `FolioForms` in `FolioConfig`, validated at construction.
4. `submitted` in `hooks.ts` (both lists).

### Phase 5 — files

1. The `file` kind end to end: `validateFormFields` accepts `accept`/`maxBytes`;
   `capFor(form)` sums the form's caps; the route reads multipart through
   `readCappedBody` and `Response#formData`; `sniffContentType` decides the type;
   `sub_` keys are minted and put after validation and after the duplicate check.
2. The gated download route, and the R2 half of every delete path.
3. The `unsupported` refusal when `media` is absent, at the builder and at the route.

### Phase 6 — the admin: forms and the builder

1. `route.ts` — `Screen` gains `{ name: 'forms' }`, `{ name: 'form'; id }` and
   `{ name: 'responses'; id }`; `'forms'` joins `FLAT`; the two-segment parse follows
   `documents`/`edit`. Pure, so it lands with its unit tests.
2. `nav.ts` — one entry after Assets.
3. `forms-model.ts` / `useForms.ts` / `Forms.tsx` — the list, the redirects trio's
   shape.
4. `form-model.ts` / `useForm.ts` / `FormBuilder.tsx` — the field list, the add menu,
   reordering, the per-field panel, the form-level settings, the locale switcher when
   `manifest.locales` is set, and the 409 reload. `scoped()` on every subtree and on
   every portal.

### Phase 7 — the admin: responses

1. `responses-model.ts` / `useResponses.ts` / `Responses.tsx` — the table, the filters,
   `?count=1`, the oldest-row age, the detail drawer, selection and bulk delete through
   `ConfirmBulkDialog`.
2. The CSV export: the `json_each` header query, the keyset walk, the escaping, the
   stream.
3. The delete dialogs — one form, one response, a selection — each naming its numbers.
   `useFocusTrap`, not a seventh hand-rolled trap.

### Phase 8 — the demo and the prose

1. `examples/demo` — a `Form` block rendering the descriptor, a seeded contact form, a
   `submitted` hook that logs, and `verify` left unconfigured so the absent path is the
   one the demo exercises.
2. `README.md` — the config key, the descriptor, the honeypot markup guidance, the
   `media` prerequisite for files, and the cross-entrypoint purge trap as it applies to
   `formChanged`.
3. `scripts/forms-test.mjs`, and `ROADMAP.md`.

## Edge cases

- **A page embeds a form that has since been deleted** → `resolution.forms` has no
  entry, `resolveValue` answers `null`, and the host's block renders nothing. The same
  posture a `reference` to a deleted document takes, and the delete dialog warned first.
- **A cached page submits to a form that gained a required field** → refused with
  `folio_status=invalid`, and the window is the purge latency rather than the TTL,
  because a structural save purges `form:<id>`. On a host whose admin and cached
  entrypoints differ, the purge reaches nothing — the trap the README already
  documents, and it applies here unchanged.
- **A cached page submits to a form that has closed** → 410 / `folio_status=closed`.
  The markup is stale by design; the route is the enforcement (decision 14).
- **Two editors save one form** → the second gets 409 and the builder reloads, naming
  who has it open only insofar as `updated_at` moved. This table has no presence and
  no merge; decision 18 is where that is argued.
- **A form is renamed while a page that embeds it is cached** → nothing breaks: the
  action names the id. Only `folio_form` on the redirect changes.
- **A submission with no `Referer` and no `_folio_page`** → `page` is `''` and the 303
  falls back to `/`. Not an error: a form can legitimately be posted from a client that
  sends neither.
- **`Referer` names another origin** → `safeNext` refuses it and the fallback is used.
  An open redirect out of a form endpoint would be the most-scanned URL on the site.
- **A field is renamed after 400 responses** → old responses keep the old key; the
  table shows the new column with `—` for them and the drawer shows the old one marked
  retired; the CSV carries both. The builder warns at rename time, because this is the
  one destructive-looking edit that is not reversible by renaming back — the data does
  not move.
- **A `statement` field in a submission** → it declares no input, so any key matching
  its name is dropped like any other undeclared key.
- **A `checkboxes` field with nothing ticked** → the browser sends no key at all.
  Stored as `[]`, and `required` on it means "at least one", which is the only
  meaning it can have.
- **A `number` field receiving `'12abc'`** → refused with a per-field error, not
  coerced. `Number('12abc')` is `NaN` and `parseInt` is `12`; neither is what the
  visitor meant.
- **A `pattern` that is a pathological regular expression** → refused at *save* time,
  when it is compiled once by `validateFormFields`. A regex that backtracks for a
  minute must not be reachable from a public POST.
- **A file question on a host with no `media` binding** → the builder refuses to add
  one and the route answers `unsupported` naming the binding. The legible-refusal rule
  `FolioBindings` already follows.
- **An upload whose extension lies** → the sniffed type decides, and it is served as an
  attachment regardless, so the lie changes nothing that matters.
- **An upload that passes validation and then the insert fails** → the compensating
  `bucket.delete` runs, exactly as `uploadAsset` does today.
- **A duplicate submission carrying a file** → the duplicate check runs before the R2
  put, because `body_hash` covers the bytes. No object is written and none is orphaned.
- **A request with no client IP (local `wrangler dev`)** → `ip_hash` is null, the row
  is outside the partial index, and the rate limit does not apply. Correct: there is
  nothing to limit, and the e2e script depends on it.
- **The rate limit refuses a genuine visitor behind a shared NAT** → possible, and the
  reason the default is 10 per hour rather than 3. `folio_status=rate` is distinct from
  `invalid` so a host can say something true about it.
- **A `verify` configured on a form with no widget in the host's markup** → every
  submission is refused. Fail-closed is the decision; the admin's form settings say
  that `verify` is configured site-wide so the omission is findable.
- **A response whose form was deleted mid-request** → `form_id` is not a foreign key,
  so the row can land pointing at nothing. The delete's own batch removes responses in
  the same call, so the window is a batch; an orphan is invisible to every reader,
  which is keyed by form.
- **A CSV export of a form with zero responses** → the header row alone, from the
  current fields. A file with a header is a better answer than an empty file.
- **A CSV cell containing a newline, a quote and a comma** → quoted and doubled per RFC
  4180, and the apostrophe prefix applies on top of that, not instead of it.
- **A response holding 60 fields of 2,000 characters** → one row of ~120KB. Bounded by
  the per-field `max` the builder sets and by `MAX_FORM_FIELDS`; D1's row limits are
  well clear of it.
- **A bulk delete over a selection spanning R2 objects** → the same `(lastId, seen)`
  cursor rule as every other bulk run, with the objects deleted per batch after the
  rows, and a batch in which every object delete failed still advances the cursor.

## Testing requirements

**Unit (`test/unit/`):**

- `core/forms.test.ts` — `formSlug`; `validateFormFields` (unknown kinds dropped,
  duplicate names refused, `_` prefix refused, over `MAX_FORM_FIELDS` refused, a bad
  `pattern` refused, options required for `select`/`radio`/`checkboxes`);
  `shapeOf` (bumps on the six structural edits, not on a label, help, placeholder or
  translation edit); `honeypotName` (deterministic, and it avoids the form's own slugs).
- `core/resolve.test.ts` (extend) — `case 'form'` answers from the map, `null` for an
  absent id, `null` for a non-string value.
- `core/cache-tags.test.ts` (extend) — `formTag` is emitted per key of
  `resolution.forms`, and a page with none emits none.
- `server/form-validate.test.ts` — the pure submission validator: required, each kind's
  coercion and refusal, `max`/`min`/`pattern`, option membership for select and
  checkboxes, undeclared keys dropped, `_`-prefixed keys never stored, a `hidden`
  field's declared value accepted.
- `server/form-csv.test.ts` — the escaping (`= + - @`, quotes, newlines, commas), and
  the header assembly from a key union plus the current fields.
- `admin/forms-model.test.ts` — the three screens parse and format; the builder's pure
  reducers (add, remove, reorder, rename with the split warning); the locale switcher's
  visibility follows `manifest.locales`.

**Workers (`test/workers/`, real workerd):**

- `migrations.test.ts` (edit) — the two new tables' exact column and index lists, and
  the four named absences.
- `forms.test.ts` — CRUD; the slug collision 409; `version` bumps on a shape change and
  not otherwise; `formChanged` fires only on the former; the `expectedUpdatedAt` 409;
  the delete cascade's three counts; `?counts=1`.
- `form-submit.test.ts` — the 303 and the JSON answer from one route; the honeypot's
  silent success; `verify` false and `verify` throwing both refusing; the throttle
  across an hour boundary; the duplicate collapse; a closed form; undeclared keys
  dropped and a declared `hidden` kept; no personal data in any redirect.
- `form-files.test.ts` — the per-question cap and the form-total cap; the sniffed type;
  `{base}/asset/sub_…` refused by `assetKeyParam` before a handler runs; the gated
  download's headers; the compensating delete; the cascade on both delete paths.
- `form-export.test.ts` — the `json_each` union header; retired keys present; `—` for a
  field outside a response's version; the escaping end to end; the filter honoured.
- `read-session.test.ts` (extend) — the forms read runs concurrently with pass one, and
  a document embedding no form issues no forms query.
- `cache-request.test.ts` (extend) — `POST {base}/f/:id` is `'bypass'`, and
  `{base}/f/:id` as a GET is too.

**End to end (`scripts/`, live dev server on port 5199):**

- `scripts/forms-test.mjs` — build a form through the API, render a page that embeds it,
  submit it as a browser would (`application/x-www-form-urlencoded`, following the
  303), submit invalid, submit the honeypot, submit twice inside a minute, close the
  form and submit again, upload a file and download it back through the gated route,
  export the CSV, then delete the form and assert the objects are gone. Follows both
  conventions: `signInGlobally()` from `scripts/lib/auth.mjs` for the admin half, and
  `import './lib/ts-resolve.mjs'` first. The public submits are deliberately made
  **without** the session cookie, since a form that only works for signed-in callers is
  the bug this script exists to catch.
- Run it as `./scripts/e2e.sh scripts/forms-test.mjs`, never against a stale database.

## Dependencies

- **Spec 32 (`content-model/media-library.md`)** — builds first, and this needs one
  thing from it: `src/core/bulk.ts` with `BulkSelection<F>` made generic, which the
  bulk response delete uses as `BulkSelection<ResponseFilter>`. Nothing else. If 32
  slips, this spec's phase 7 either waits or does the generification itself, which is
  32's decision 6 verbatim and should not be written twice.
- **Spec 20 (`platform/bulk-writes.md`)** — done. The selection contract, the count
  guard, the `(lastId, seen)` cursor rule and the report shapes.
- **Spec 18 (`foundation/pagination.md`)** — done. Every list route here is keyset-paged
  under its rule; `?count=1` is what the select-all guard compares against; and its
  decision 3 is why there are no `v1` routes here.
- **Spec 17 (`platform/caching.md`)** — done. `formTag` joins `cacheTags`' render-time
  computation, and `cachePurgeHooks` gains one event. The cross-entrypoint purge trap
  applies unchanged.
- **Spec 7 (`platform/publish-hooks.md`)** — done. Two events, both additive, both
  added to the type and the runtime list together.
- **Spec 12 (`content-model/localisation.md`)** — done. `localeChain` and the
  source-locale fallback; `LocaleContext` is what the descriptor is compiled against.
- **Spec 10 (`foundation/identity-and-access.md`)** — done. One new scope, one new
  `Access`, no new machinery.
- **Spec 23 (`foundation/multi-site.md`)** — *the reverse*: 23 will need to scope
  `forms` and `form_responses` with `site_id`, add `forms` to its list-route pass, and
  decide whether a form is shared across sites or owned by one. Landing this before 23
  is what makes that one pass rather than two.
- **Cloudflare:** no new binding. `media` (R2) is already required for uploads and is
  required here only by a form that declares a file question. The host supplies its own
  verification credentials to its own `verify` and Folio never sees them.

## Out of scope

- **`{base}/api/v1` routes and MCP tools for forms or responses** (checkpoint 20). A
  version segment is a promise; the `submitted` hook is the programmatic surface.
  Additive later.
- **A scheduled retention sweep** (checkpoint 9). Decision 17 states what its absence
  costs. One column, one statement and one call whenever it is wanted.
- **Email notification on submission.** Folio has no mail binding — the magic-link
  provider takes a host `send` for exactly this reason — so a notification is four
  lines in the `submitted` hook against whatever the host already uses.
- **Retries, a delivery log or a dead-letter queue for the sink.** `hooks.ts`'s header
  refuses all three by name for publish hooks and the argument is unchanged: the hook
  is a function in the host's own Worker, and a host that wants durable delivery has a
  Queue binding and a row in D1 that has already committed.
- **Conditional logic** — showing a question based on an earlier answer.
  `core/conditions.ts`'s `FieldCondition` is the shape it would reuse, and it is a
  second evaluation surface (the host's markup, with no JavaScript) rather than a
  schema addition. Its own spec.
- **Multi-step forms, progress saving and partial submissions.** Each needs state
  between requests, which is a cookie or a Durable Object, which is a different design.
- **Payments.** A payment is not a form field; it is a provider, a webhook, a
  reconciliation story and a compliance boundary.
- **Virus scanning uploads.** A host with an opinion about this has a scanner; the
  `submitted` hook receives the file list and can quarantine or delete. Folio shipping
  one would mean choosing a vendor.
- **Editing a response.** A response is a record of what somebody sent. Making it
  editable makes it evidence of nothing.
- **Cross-origin submissions and CORS.** Folio is mounted by the host Worker that
  serves the page, so a form posts same-origin. A separate front end is the host's
  routing problem and its own CORS decision.
- **A Folio-hosted standalone form page.** The host renders; that is decision 4 and it
  is the whole rendering story.
- **Analytics, conversion tracking and A/B testing.** `page` and `locale` are the two
  facts Folio is structurally placed to know. Everything else belongs to whatever the
  site already measures with.
- **Per-form permissions.** Roles are global (`auth/roles.ts`), and a per-form ACL is
  an access-control model rather than a forms feature — it would have to be enforced in
  the export, the bulk delete and the file download as well as the table.
- **More than one file per question.** One file, one field name, one object key: it is
  what makes the download route addressable by field name. A second file is a second
  question until somebody has a reason it cannot be.

## Open questions

None. All twenty checkpoints were answered by the owner on 2026-09-05 before drafting,
and are recorded above.

Two are worth naming as the ones most likely to be revisited, and both are flagged
where they are made rather than left here as questions: **checkpoint 1** (a bespoke
table rather than a document — decision 1 lists the four things it costs and their
replacements) and **checkpoint 9** (manual retention — decision 17 states the
liability, and reversing it is one column, one statement and one host call).

## Implementation notes — phase 2 (landed 2026-09-06)

What actually landed for "the store, server side", where the plan was wrong, and
what phases 3–5 inherit.

### Divergences from the plan

1. **`GET {base}/api/forms/:id/usage` answers a superset of the asset usage
   shape.** The route table says "`/assets/:id/usage`'s shape and its access". It
   keeps the access (`EDIT`) and the `{ published, total }` half verbatim, and it
   adds `responses` and `files`. The acceptance criterion "Deleting a form says
   what it will destroy" asks for **three** numbers in one dialog, and a dialog
   that has to make three calls to assemble them is a dialog that ships with one
   of them missing — which is checkpoint 17's whole failure mode. `formUsage`
   answers all three from two concurrent statements.

2. **`GET {base}/api/forms` answers a `FormSummary`, not a `Form`.** A list page
   is up to 200 rows and `forms.fields` is the widest column in the schema, so
   the list projects `json_array_length(fields) as questions` instead of the
   array. `?counts=1` adds `responses` per row. The builder reads one form and
   gets the array; nothing needed the two hundred it was not going to render.

3. **`validateFormFields`' refusals are translated into `bad_request`.** It
   throws a plain `Error` — correctly, since it is also called by the admin
   builder and by the submit route's compiler and knows nothing about HTTP — and
   an untranslated throw is a **500 for the client's own mistake**. `updateForm`
   funnels the write-side call through `fieldsFromInput`, which re-raises as a
   `FolioError`. The core messages already name the field and what is wrong with
   it, so they travel verbatim. Found by a test: `{ name: '_folio_page' }` was a
   500, not the 400 decision 13 describes.

4. **Per-field length caps live in `validate.ts`, not in `core/forms.ts`.** The
   plan has `validateFormFields` as the one validator, and it is — of the *form*:
   sixty fields, unique names, no reserved prefix, kinds screened, a `pattern`
   that compiles. It bounds no **bytes**: nothing in core caps a label, a help
   string or an option list, so a ten-megabyte label would have reached the D1
   column. `FORM_FIELD` and `FORM_FIELDS` in `validate.ts` are that bound, which
   is that file's stated charter, and `MAX_FORM_OPTIONS` (100) lives there for
   the same reason — it says how much JSON one PATCH may carry, not what a form
   may be. `kind` is `bounded`, deliberately **not** a picklist: screening kinds
   is core's job and its rule is to *drop* an unknown one, which a picklist would
   turn into a 400 and put the same list in two places.

   One consequence worth knowing before phase 6: `bounded()` screens `\p{Cc}`,
   so a newline is refused. A `statement`'s `text` and a field's `help` are
   single-line, the same latitude every other prose field in this codebase has.

5. **`updated_at` is forced forward: `max(Date.now(), current + 1)`.** Two saves
   inside one millisecond would otherwise share a concurrency token, and the
   second editor's stale value would validate against the first's write — the
   guard reading as passed on exactly the race it exists for.

6. **The guard is in the `update`'s own `where`, not in a read before it.** The
   pre-read computes the next row; `where id = ? and updated_at = ?` plus
   `changes === 0` is what refuses. A read-then-write pair has a window two
   editors clicking Save at once fit through.

### Decisions taken where the plan was silent

- **`FormMeta` is `{ id, name, label, version }`**, exported from
  `server/forms.ts`; `hooks.ts` imports the type from there the way it already
  imports `VersionMeta` from `server/versions.ts`.
- **`ResponseFilter` is declared in `server/forms.ts`**, because `validate.ts`
  parses it (`responseFilterQuery`) and `server/form-responses.ts` is phase 4's
  file. A filter is a shape and the shape belongs with the feature.
- **`deleteForm` clears inbound `content_refs` too**, the way `deleteAsset`
  clears its own: the rows mean "this published page renders this form", and
  nothing renders a form that no longer exists.
- **`isOpen(form, now)` is the one place the switch and the clock combine.**
  Phase 3's descriptor must compile `open` from it and not from `form.open`.
- **No `FORMS` access and no `forms:read` scope yet.** Nothing in this phase
  reads a response; adding an unused member of `SCOPES` is a security surface
  with no consumer to justify it. Phase 4 or 7 adds it with its first reader.

### Bind budget

Two readers take a caller-sized id list and **both chunk through `bindChunks`**:
`formsByIds` (one id per form a document embeds — phase 3's read) and
`countResponsesByForm` (one id per row of a list page, up to 200, against a
100-parameter ceiling). Verified by breaking: replacing `formsByIds`' chunking
with a single `in (…)` and reading 150 ids answers
`D1_ERROR: too many SQL variables at offset 573`. Nothing else here binds a list
somebody else sized — `formUsage`, `deleteForm` and `updateForm` bind two, three
and thirteen parameters respectively, whatever the form holds.

### Verified by breaking

Dropping `and updated_at = ?` from `updateForm`'s statement turns two tests red —
`refuses a save whose expectedUpdatedAt has moved` and `does not fire for a save
that was refused`. That is the invariant in this phase that is silent when wrong:
without it a form is last-write-wins, and the editor whose questions were
overwritten is told nothing. Restored in place.

### Tests changed rather than added

- `test/unit/server/pure.test.ts` — the `validateHooks` message test pins the
  **exact** sorted list of valid hook names, so `formChanged` had to be added to
  it and to the "accepts every real event" literal. Sanctioned by the spec's
  "Server types" section, which adds the event to both `HookEvent` and
  `HOOK_EVENTS`.
- `test/unit/server/cache-purge.test.ts` — one test added, not changed:
  `formChanged` purges exactly `form:<id>` and nothing else.

### What phase 3 inherits

`formsByIds` is the resolve read and is already chunked, so `compileForm` sits
beside it and pass one's `Promise.all` gains a call rather than a query. The
purge is fully wired: `formChanged` fires from the PATCH route and
`cachePurgeHooks` turns it into `purge('form change', [formTag(form.id)])` — all
phase 3 has to do is make `resolution.forms` non-empty so a rendered page carries
the tag in the first place.

### What phase 5 inherits

`deleteForm` deletes D1 only. The `files` count it answers is honest (a
`sum(json_array_length(files))`, so a form with fifty thousand responses does not
become fifty thousand rows in a Worker's memory), but the R2 objects behind it
are not removed. Phase 5 owns the R2 half of every delete path and has to walk
the `files` column in keyset pages **before** the batch runs. Until a `file`
question can be built there is nothing for it to find, which is why the order is
safe rather than merely convenient.

## Implementation notes — phase 3 (landed 2026-09-06)

Resolution and the descriptor. `resolution.forms` is populated, a rendered page
carries `form:<id>`, and the purge phase 2 wired now reaches something.

### Divergences from the plan

1. **Step 3 needed no code.** The plan has `content-index.ts` gaining a
   `kind: 'form'` edge in the publish projection; `contentProjection` delegates
   to `core/refs.ts`'s `outboundRefs`, which phase 1 already taught the fourth
   kind, so the projection has emitted form edges since phase 1. What was missing
   was a test that the kind the walk emits is the kind `formUsage` binds — two
   string literals in different files that have to agree — and that is now
   `walks the same edge the usage count reads` in `test/workers/forms.test.ts`.

2. **`compileForm` takes a context, not a runtime.** The plan says "the action
   from `rt.base`"; the function takes `FormRenderContext { base, locale?, page?,
   now? }` and knows nothing about the runtime, which keeps it pure over a row
   and therefore unit-testable in Node (`test/unit/server/forms.test.ts`) rather
   than only against workerd. `now` exists so the clock half of `isOpen` can be
   moved by a test; every caller omits it.

3. **`_folio_page` carries the page's URL, not its path.** `opts.story.path` is
   Folio's path (`about/contact`); what the browser is at is the host's own
   `route(path, locale)` (`/about/contact`), and that is what `safeNext` accepts
   and what the 303 has to be able to send a visitor back to. `resolve()` runs
   the story's path through `route` for the render's locale, so a French page's
   submission returns to the French page. `PAGE_INPUT` is exported from
   `server/forms.ts` so phase 4 reads the key from one place.

4. **The descriptor's key set is asserted, not just its contents.** Decision 4
   describes what is on it; nothing described what must *not* be. `updatedAt` is
   the concurrency token, `closesAt` is scheduling metadata and a field's `i18n`
   is every locale's strings at once — none of them belong on a page a stranger
   loads, and a later `{ ...form }` "tidy-up" would ship all three silently.
   `carries nothing a visitor should not see` pins the exact key set of both the
   form and a compiled field, the posture `presenceOf` takes toward a socket
   attachment.

### Known gap: a form inside a global or a referenced document

`resolve()` collects form ids from **the document being rendered only**
(`formIds(doc, schema)`). A `form` field inside a *global* — a newsletter signup
in a site footer is the obvious case — or inside a document pulled in by a
`reference` resolves to `null`, because its id is not known until pass two has
come back, and reading it then would cost exactly the round trip decision 4 exists
to avoid.

This is a real limitation rather than an oversight, and the spec does not cover
it. The cheap fix, when something needs it, is a second forms read in pass three
beside the nested story lookup — that pass already exists, already costs a round
trip when it runs at all, and is skipped in the ordinary case. Whoever builds
phase 8's demo should know a footer form will not work until then.

### Also missing, and not this phase's to add

There is **no `form()` field builder** in `core/fields.ts`. Phase 1 added the
union member, `ValueOf`, `defaultValue` and the exhaustive-switch cases, but no
constructor beside `collection()` and `reference()`, so a block author writes
`{ kind: 'form' as const, label: 'Enquiry' }` — which is what both new tests do.
Phase 6 or phase 8 should add it; it is one line and one export.

### Verified by breaking

Three, each restored in place:

- **`open: form.open` instead of `isOpen(form, now)`** — one test red,
  `answers open from the switch and the clock together`. Only the clock case
  moves: a switched-off form is closed either way, and a form whose `closesAt`
  has passed is the state where the page and the submit route come to disagree.
- **`formRows = pass1.then(() => formsByIds(…))`** — the sequential version,
  which returns byte-identical descriptors. `goes out with the story map, not
  after it` in `read-session.test.ts` reads `['send', 'send', 'recv']` where it
  wants three sends, which is the only evidence a round trip was spent.
- **A `...form` spread at the top of the descriptor** — `carries nothing a
  visitor should not see` red, naming `createdAt`, `updatedAt` and `closesAt`.

### Test counts

131 files / 3889 passing + 1 todo, from 130 / 3875 + 1. Fourteen added: eight
unit (`test/unit/server/forms.test.ts`, new), four in `test/workers/forms.test.ts`
and two in `test/workers/read-session.test.ts`. Nothing was changed or removed.
