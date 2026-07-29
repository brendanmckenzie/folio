# Feature: Content API — programmable read and write

> **Group:** platform
> **Build order:** 15
> **Size:** M
> **Status:** draft
> **Wire version:** none
> **Migration:** none — `api_tokens` comes from `0007`
> **Last updated:** 2026-07-29

## Summary

Everything Folio can do is reachable from a browser session and nothing else. There
is no way for a script to read content, and no way at all for anything other than
the editor to write it: the only mutating door into a document is the WebSocket
`tx` frame inside the Durable Object.

This spec adds a documented, token-authenticated HTTP surface for both. The
important decision is on the write side: **an API write is translated into mutations
and applied through the mutation log**, not written into storage. So a script's edit
appears live in every open editor, lands in the activity trail with the token's name
on it, is undoable with Cmd+Z, and cannot leave the draft and the Durable Object
disagreeing. A CMS API that bypassed the log would silently break every one of those
properties.

It also gives the Storyblok importer (`PARITY.md` Phase 6) the two functions
it needs — `toNested` and `fromNested` — as part of the public surface rather than as
a script's private code.

## Ground truth

**server (`packages/folio/src/server/`):**
- Existing routes under `/folio`: `GET /schema`, `GET/POST/PATCH/DELETE /stories`,
  `POST /story/:id/publish`, `GET/POST /story/:id/versions`,
  `GET /versions/:versionId`, `GET /story/:id/activity`,
  `GET/POST/PATCH/DELETE /assets`, `GET /asset/:key`, `GET /edit/:id`,
  `GET /story/:id/socket`. Every one of them is currently open to anyone
  (`../foundation/identity-and-access.md` closes them).
- `app.ts` mounts one error envelope for everything below it, and
  `errors.ts` is the only place a client-visible message is produced. An API that
  invented its own error shape would fork that.
- `validate.ts` is valibot schemas per input with deliberate messages; `parseBody`,
  `parseOptionalBody`, `idParam`, `limitParam` are the existing conventions.
- There is **no** route that reads a document: `folio.published(env, path)` and
  `folio.draft(env, id)` are library functions for the host, not HTTP.
- `StoryDO`'s only mutating path is `webSocketMessage`'s `tx` case.
  `../foundation/schema-migrations.md` adds `commit(mutations, actor)` over the same
  private `applyTransaction`, which is exactly what this spec needs.

**core (`packages/folio/src/core/`):**
- A document is normalised: `{ root, bloks: { uid: { type, parent, slot, order, data } } }`
  with fractional `order` strings and 16-hex-char uids. Legible, but not something
  to ask an API consumer to construct — `keyAtIndex`/`generateKeyBetween` and uid
  allocation are engine concerns.
- `diff(from, to)` produces a minimal mutation set and is property-tested;
  `MAX_TX_MUTATIONS = 200` and `MAX_FRAME_BYTES = 256 KB` bound one transaction.
- `core/engine.ts` exists precisely for this: *"for HOST-SIDE TOOLING that
  legitimately needs to manipulate documents — bulk-import scripts, content
  migrations"*, with the warning that *"calling `apply` outside a transaction
  bypasses the mutation log, which means no sync, no undo and no multiplayer"*.
- The Durable Object dedupes by `tx_id` with a unique index and answers a resend
  with the delta that txId already produced (`story-do.ts`) — an idempotency
  mechanism already built and tested.

## Owner decision checkpoints

1. **Writes go through the log via `commit` (recommended).** The alternative — write
   `published_doc` or the DO's `doc` row directly — is faster to build and breaks
   sync, undo, presence and the activity trail. Cost: a write is a read-diff-commit
   round trip rather than an overwrite, and a very large write is several
   transactions.
2. **A versioned `/folio/api/*` surface, separate from the admin's routes
   (recommended).** The admin ships inside the library, so its routes are internal
   and free to change; an API is a contract with somebody's script. Two surfaces
   over one set of services, with the API's shapes documented and stable. The
   alternative — declaring the existing routes public — freezes them and makes every
   admin refactor a breaking change.
3. **A nested document shape for the API, uids preserved when supplied
   (recommended).** Consumers send and receive
   `{ type: 'hero', heading: 'Hi', actions: [ … ] }` trees; the engine converts.
   Round-tripping preserves uids so a read-modify-write does not replace every block
   (which would destroy version diffs, presence and undo granularity). The
   alternative — exposing the normalised graph — makes every consumer implement
   fractional indexing.
4. **Draft reads are per document, never per query (recommended).** A draft lives in
   a Durable Object, so a query over drafts means opening N objects. `GET
   /api/documents/:id?status=draft` opens one; there is no `?status=draft` on the
   query route.
5. **`Idempotency-Key` maps onto the log's `txId` (recommended).** A retried write
   with the same key gets the delta the first attempt produced, from machinery that
   already exists and is already tested. Cost: the key must be a valid txId shape
   (the client's key is hashed to one), and idempotency is scoped to a document.

## User stories

### Developer imports content
**As** a developer migrating a site **I want to** create documents and set their
content from a script **so that** an import is code rather than an editor's month.

### Developer syncs from another system
**As** a developer **I want** a nightly job to update 400 product records from an
ERP **so that** editors are not retyping prices.

### Developer reads content from another app
**As** a developer **I want** to fetch published content as JSON **so that** a
mobile app or a second site can consume it without a Worker binding.

### Editor sees a script's changes arrive
**As** an editor with a page open **I want** a script's edit to appear in front of me
and be attributed to the script **so that** content changing under me is explained
rather than mysterious.

### Developer publishes from CI
**As** a developer **I want** to publish a document from a deploy step **so that** a
content release can be part of a pipeline.

## Architecture decisions

### 1. `/folio/api/v1` — one surface, documented, scoped

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/schema` | `content:read` | Types, blocks, locales — the manifest |
| GET | `/api/v1/documents` | `content:read` | `ContentQuery` (`../content-model/collections.md`), published only |
| GET | `/api/v1/documents/:id` | `content:read` (+`:draft`) | One document, nested shape, `?status=draft`, `?locale=` |
| GET | `/api/v1/documents/by-path/*` | `content:read` | Same, addressed by public path |
| POST | `/api/v1/documents` | `content:write` | Create a document (row + seeded draft + content) |
| PUT | `/api/v1/documents/:id/content` | `content:write` | Replace content; diffed and committed |
| PATCH | `/api/v1/documents/:id/fields` | `content:write` | Targeted field writes |
| PATCH | `/api/v1/documents/:id` | `content:write` | Row metadata: slug, parent, order |
| DELETE | `/api/v1/documents/:id` | `content:write` | Delete document, versions, index rows, purge the DO |
| POST | `/api/v1/documents/:id/publish` | `publish` | Publish; returns the version |
| POST | `/api/v1/documents/:id/versions` | `content:write` | Named checkpoint |
| GET | `/api/v1/documents/:id/versions` | `content:read` | Version list (no payloads) |
| POST | `/api/v1/assets` | `assets:write` | Upload (the existing raw-body route, re-exposed) |
| GET | `/api/v1/assets` | `content:read` | Media library |

Auth is `Authorization: Bearer folio_…` or a session cookie, resolved by the same
middleware (`../foundation/identity-and-access.md`), so the admin can use these
routes too and there is one enforcement point rather than two.

The error envelope is the existing one. Nothing about `{ error: { code, message } }`
changes, including for the new `unauthorized` and `forbidden` codes.

### 2. The nested shape, and the two functions that produce it

```ts
// folio/engine
export function toNested(doc: Doc, schema: SchemaIndex): NestedDoc
export function fromNested(input: NestedDoc, schema: SchemaIndex, base?: Doc): Doc
```

```json
{
  "uid": "9f3c1a02bb47de10",
  "type": "page",
  "fields": {
    "title": "About us",
    "body": [
      { "uid": "1a2b…", "type": "hero", "fields": { "heading": "Hello" } },
      { "type": "quote", "fields": { "text": "New block, no uid supplied" } }
    ]
  }
}
```

- **`blocks` fields become arrays** in `fields`, so the shape mirrors what a block
  author sees in `render` rather than the storage graph.
- **`uid` is optional on the way in.** Present: that blok is updated in place.
  Absent: a fresh uid and a fractional order between its neighbours. So a
  read-modify-write preserves identity, and a hand-written payload does not have to
  invent uids.
- **Order is positional**, and `fromNested` assigns fractional keys via `keyAtIndex`
  against the base document's existing siblings, so a reorder of two items in a list
  of fifty writes two moves, not fifty.
- Translations round-trip as `fields.title` plus
  `i18n: { fr: { title: 'À propos' } }` per node (`../content-model/localisation.md`).
- `fromNested` **validates against the schema**: unknown block types, blocks not
  permitted by a slot's `allow`, unknown field names, and values of the wrong JSON
  shape are all `bad_request` with the path that failed (`body[0].fields.headng`).
  This is the one place API input meets the schema, and it must name what it refused
  rather than dropping it — silently dropping is how an import appears to succeed
  and loses a third of its content.

### 3. A write is read → diff → commit, in one transaction where it fits

```
PUT /api/v1/documents/sty_x/content
  → current = StoryDO.getOrInit()
  → target  = fromNested(body, schema, current)
  → mutations = diff(current, target)
  → chunk at MAX_TX_MUTATIONS
  → StoryDO.commit(chunk, actor) for each
  → 200 { changed: 12, transactions: 1, syncId }
```

Consequences, all of them free:

- Open editors receive the delta and re-render, per keystroke machinery unchanged.
- The activity trail attributes it to `token:import-script`.
- Cmd+Z undoes it, because it is an ordinary transaction.
- An unchanged payload produces zero mutations and writes nothing —
  `{ changed: 0 }` — so a nightly sync of 400 products that changed 3 is 3 writes.
- The document caps (`MAX_DOC_BLOKS`, `MAX_DOC_BYTES`) refuse an oversized write with
  the reason, at the door.

`PATCH /fields` skips the diff for the common case:

```json
{ "fields": { "title": "New title" },
  "bloks": [ { "uid": "1a2b…", "fields": { "heading": "Changed" } } ],
  "locale": "fr" }
```

`fields` addresses the root blok by name; `bloks` addresses others by uid. It becomes
a `set` per field and nothing else — which is what a bulk price update wants, and it
never touches structure.

### 4. Idempotency reuses the log's txId dedupe

`Idempotency-Key: <opaque>` is hashed to a 16-hex txId and passed to `commit`. A
retry gets `{ replayed: true }` and the original result, because the object already
answers a known txId with the delta it produced the first time and refuses to write a
second row (`log_tx_id` unique index). A write with no key gets a generated txId,
which is exactly what the socket path does.

Scoped per document, because the log is per document. A batch across documents
therefore needs a key per document, and the API returns per-document results so a
retry after a partial failure is precise.

### 5. Creating a document is two writes and one of them is a transaction

```
POST /api/v1/documents { type, title, slug?, parentId?, content? }
  → createStory(db, …)        // the row: type, slug, path, ord (existing code)
  → getOrInit(seed(type))     // the DO seeds a blank document from the type's root
  → if content: diff + commit // the content, as a transaction
```

Not atomic across the two stores, and it cannot be: D1 and a Durable Object have no
shared transaction. The failure mode is a story row whose document is blank, which is
identical to a story an editor created and never filled in — so it is a *recoverable*
state the system already understands, not corruption. The reverse order (document
first) would leave an orphan Durable Object nothing points at, which nothing cleans
up. Stated because it is the kind of thing that gets discovered in production.

### 6. In-process access for host code, without HTTP

A host's own Worker already has the bindings. It should not have to make an HTTP
request to itself:

```ts
const doc = await folio.draft(env, id)                       // exists today
await folio.write(env, id, mutations, { actor: 'sync-job' }) // new: commit, chunked
const page = await folio.query(env, { type: 'insight' })     // from collections
```

`folio.write` is the same `commit` path with the same chunking, so the HTTP route is a
thin translation over it — the pattern `publish()` already established by taking no
`Request`.

## Wire & schema changes

### D1

None. `api_tokens` (with scopes, expiry, `last_used_at`, `revoked_at`) comes from
`0007_identity.sql`.

### Core types

```ts
// folio/engine
export interface NestedBlok { uid?: string; type: string; fields: Record<string, unknown>
                              i18n?: Record<string, Record<string, unknown>> }
export type NestedDoc = NestedBlok
export function toNested(doc: Doc, schema: SchemaIndex): NestedDoc
export function fromNested(input: unknown, schema: SchemaIndex, base?: Doc): Doc   // throws FolioError
```

```ts
// folio/server
interface Folio<Env> {
  write: (env: Env, id: string, mutations: Mutation[], opts: { actor: string; txId?: string })
    => Promise<{ transactions: number; syncId: number }>
}
```

### Routes

The table in decision 1. All under `/folio/api/v1`, all behind
`withActor` + `requireScope`, all answering the existing error envelope.

## Acceptance criteria

### Read published content
```
GIVEN a published page with a hero and two buttons
WHEN GET /api/v1/documents/by-path/about with content:read
THEN the response is the nested shape with uids, the hero's fields, and the buttons
     nested inside the hero's actions array
AND a request with no token answers 401 and a token without the scope 403
```

### Read a draft
```
GIVEN a page whose draft differs from published
WHEN GET /api/v1/documents/:id?status=draft with content:read:draft
THEN the draft content comes back
AND the same request with only content:read answers 403
```

### Write reaches an open editor
```
GIVEN an editor with the page open and connected
WHEN PUT /api/v1/documents/:id/content changes the hero heading
THEN the response reports changed: 1, transactions: 1
AND the editor's document and preview update without a reload
AND the activity trail shows the change attributed to token:<name>
AND the editor's Cmd+Z reverts it
```

### A no-op write writes nothing
```
GIVEN a document
WHEN its current content is PUT back unchanged
THEN changed is 0, no transaction is logged, and no delta is broadcast
```

### uids are preserved on round trip
```
GIVEN a document read with GET, one field edited in the payload, and PUT back
THEN diff emits one set mutation
AND every blok keeps its uid, so version diffs stay minimal and presence is unaffected
```

### New blocks and reorders
```
GIVEN a body with three blocks
WHEN a PUT adds a fourth without a uid and swaps the first two
THEN one insert and two moves are emitted (not three inserts and three removes)
AND the new blok's order sits between its neighbours
```

### Schema validation names what it refused
```
GIVEN a payload with an unknown block type and a misspelled field
WHEN it is PUT
THEN 400 bad_request naming the first failing path, and nothing is written
AND no partially-applied transaction exists
```

### Idempotency
```
GIVEN a PUT with Idempotency-Key 'import-42' that succeeded
WHEN the identical request is retried
THEN the response reports replayed: true with the original syncId
AND the log holds exactly one transaction for it
```

### Oversized writes
```
GIVEN a payload producing 450 mutations
WHEN it is PUT
THEN it lands as three transactions and the response says so
AND a payload that would exceed MAX_DOC_BLOKS is refused with that reason and
    nothing is written
```

### Publish
```
GIVEN a token with the publish scope
WHEN POST /api/v1/documents/:id/publish is called
THEN a version row and published_doc are written in one batch, the index rows are
     rebuilt, and the response is the version metadata
AND a token without the scope answers 403
```

### Create
```
GIVEN POST /api/v1/documents { type: 'insight', title: 'Hi', parentId, content }
THEN a story row exists with a derived path, its Durable Object holds the content,
     and the response is the created document in nested shape
AND WHEN the content commit fails
    THEN the row exists with a blank document and the response says so with a 502-
         class envelope rather than reporting success
```

### Query
```
GIVEN 25 published insights
WHEN GET /api/v1/documents?type=insight&perPage=10&page=2 is called
THEN 10 items come back with total 25 and pages 3, published only
AND status=draft on this route is refused as unsupported (decision 4)
```

## Implementation plan

### Phase 1 — the nested shape

1. `core/nested.ts` (exported from `folio/engine`): `toNested`, `fromNested`,
   schema validation with path-naming errors, uid preservation, fractional order
   assignment against a base document, locale round-tripping.
2. Tests: `test/unit/core/nested.test.ts` — round-trip identity (`fromNested
   (toNested(doc)) === doc`, property-tested over generated documents, which
   `diff.test.ts` already has generators for), uid preservation, insert/reorder
   minimality, every validation refusal.

### Phase 2 — the write path

1. `server/write.ts`: `folio.write` — chunking, txId handling, per-chunk results.
2. `server/routes/api/documents.ts`: the read and write routes, valibot schemas in
   `validate.ts`, scopes per route.
3. `server/routes/api/index.ts`: the `/api/v1` sub-app, mounted in `app.ts` after
   `withActor`.
4. Tests: `test/workers/api.test.ts` — every acceptance criterion; a DO test that a
   `commit` from the API broadcasts to a connected socket.

### Phase 3 — the rest of the surface

1. Create/patch/delete over the existing `stories` services, with the two-store
   caveat handled explicitly (decision 5).
2. Publish, checkpoint, version list over the existing `publish()` / `versions.ts`.
3. Assets: the existing upload route re-exposed under `/api/v1` with
   `assets:write`.
4. Token management screens in the admin (from
   `../foundation/identity-and-access.md`) plus `last_used_at` writes.
5. Rate limiting: per-token request counts. Named honestly as a Cloudflare
   rate-limiting rule plus a `last_used_at`-based sanity check, not a bespoke
   counter.

### Phase 4 — docs and the importer seam

1. `README.md`: a Content API section with the nested shape and one worked example.
2. `docs/api.md`: the route table, the shapes, the scopes, the error codes, and the
   idempotency contract. This is the file a consumer reads; the spec is not it.
3. `PARITY.md`: note that Phase 6's importer now has `fromNested` and
   `folio.write` to build on rather than reaching into the graph.

## Edge cases

- **A write while an editor is typing in the same field** → last write wins, same as
  two editors. The API is a peer, not a privileged writer, and the editor sees it
  arrive.
- **A write to a story whose Durable Object was purged** (deleted concurrently) →
  `commit` finds no document, answers rejected, and the route returns 404 rather than
  resurrecting a deleted story. The DO's `purge()` and D1 delete ordering already
  guarantee this window is small and one-directional.
- **A token whose scopes were narrowed mid-batch** → each request is authorised
  independently; the batch fails from that point with per-document results so the
  caller knows where it stopped.
- **`Idempotency-Key` reused with a *different* body** → the log answers with the
  first transaction's delta, so the second body is silently ignored. Documented as
  the contract (the key is the identity of the write), and the response's
  `replayed: true` is how a caller notices.
- **A `PATCH /fields` naming a uid from another document** → no such blok, so the
  `set` is a no-op by the vocabulary's own rule; the response reports
  `changed: 0` rather than pretending. The alternative (404 on unknown uid) would
  make a legitimate concurrent-delete race into an error.
- **A nested payload nesting a block a slot does not `allow`** → refused with the
  path. The admin enforces the same rule on drag (`useBlocks.move`), so the API
  cannot do less.
- **A read of a document whose type was removed from the config** → returned as-is,
  with its stored type, because refusing to read content because code changed is
  worse than reporting it.
- **`by-path` for an unrouted document** → 404: records have no path, by design
  (`../foundation/document-types.md`).
- **A very large `GET` (a document with 20,000 bloks)** → allowed; the nested shape
  is the same bytes as the stored one plus indentation. Response size is bounded by
  the same document caps.
- **Locale on a write** → `PATCH /fields` with `locale: 'fr'` emits locale-scoped
  sets; `PUT /content` with `i18n` blocks replaces translations too. A `PUT` payload
  *without* `i18n` on a node whose stored blok has translations would diff them away
  — so `PUT` requires `i18n` to be present when the site has locales configured, or
  it refuses with an explanation. That refusal is the most likely real bug this whole
  spec would otherwise ship.

## Testing requirements

**Unit:** `toNested`/`fromNested` round-trip properties; validation refusals with
paths; order assignment; locale round-tripping.

**Workers:** every route's scope gate; the write path's diff-and-commit including
chunking and no-op; idempotent replay; the create failure mode; broadcast to a
connected socket; the locale-`PUT` refusal.

**End to end (`scripts/api-test.mjs`, new):** against the dev server with a seeded
token — create a document, set content, connect a socket and assert the delta arrives
while a second write is in flight, publish, read the published page's HTML and assert
it matches what was written, retry a write with the same idempotency key and assert
one log entry.

## Dependencies

- `../foundation/identity-and-access.md` — tokens, scopes, the middleware, and a real
  actor string. Without it this spec has no auth model and must not ship.
- `../foundation/schema-migrations.md` — `StoryDO.commit` and the shared
  `applyTransaction`. Both specs need it; whichever lands first builds it.
- `../content-model/collections.md` — the query route is its `query()`.
- `../content-model/localisation.md` — the locale parameters and the `PUT` rule.

## Out of scope

- **GraphQL.** One shape, over HTTP, with a query object. A second query language is
  a product decision nobody has asked for.
- **Webhooks / an `onPublish` hook.** A host owns its Worker and could react inside
  its own publish call today; a general hook (with retries, secrets and delivery
  logs) is its own spec. Worth noting that Folio does not need webhooks for cache
  purging the way Storyblok does — it owns both sides.
- **Realtime subscriptions for API consumers** (a socket that streams deltas to a
  non-editor client). The machinery exists; the auth model for a read-only external
  subscriber does not, and `../editing/live-collaboration.md` is about editors.
- **Bulk endpoints across documents** in one request. Per-document idempotency
  (decision 4) makes a client-side loop correct and resumable; a batch endpoint that
  is partially applied is harder to reason about than N requests.
- **The Storyblok importer itself.** `PARITY.md` Phase 6, built on this.
- **A published-content CDN cache.** `ROADMAP.md`; this API would be a beneficiary,
  not the owner.

## Open questions

- Should `PUT /content` support a `mode: 'merge'` that leaves absent fields alone?
  It would make the locale rule unnecessary and make partial payloads safe — at the
  cost of no longer being able to express "remove this block" through `PUT`, which
  is what `PATCH /fields` is for anyway. Leaning yes, as the *default*, with
  `mode: 'replace'` opt-in.
