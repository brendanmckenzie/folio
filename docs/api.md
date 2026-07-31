# Folio Content API — `v1`

The reference for `/folio/api/v1`. If you are looking for *why* it is shaped this
way, `README.md`'s "Content API" section has the reasoning and
`docs/specs/platform/content-api.md` has the decisions; this file is the contract.

Everything below assumes the library is mounted at `/folio` (`basePath`). Adjust
the prefix if your host mounted it elsewhere.

---

## Authentication

```
Authorization: Bearer folio_<64 hex>
```

Create a token from the **Access** rail in the editor, or `POST /folio/tokens` as
an `admin`. The raw value is shown once, on creation, and never again: the database
holds only its SHA-256.

A **session cookie also works** on every route here, at the equivalent role — so
the admin can use these routes and there is one enforcement point rather than two.

Two things a token cannot do:

- **open the sync socket** (`GET /folio/story/:id/socket` closes 4004). A script is
  not a person with a cursor.
- **exceed its scopes**, which are fixed at creation. Widening means a new token.

### Scopes

| Scope | Grants |
| --- | --- |
| `content:read` | Read published content, the manifest, the media library, version lists |
| `content:read:draft` | Everything `content:read` does, plus `?status=draft` |
| `content:write` | Everything both reads do, plus create, write, patch, delete |
| `publish` | Both reads, plus publish and checkpoint. **Not** write |
| `assets:write` | Upload. Implies nothing about content |
| `admin` | Everything |

The implications are one-directional and deliberate: `publish` implies reading the
draft it is about to publish and says nothing about writing one; `assets:write`
implies nothing at all beyond itself.

---

## Routes

| Method | Path | Scope | Answers |
| --- | --- | --- | --- |
| `GET` | `/api/v1/schema` | `content:read` | `Manifest` — types, blocks, locales |
| `GET` | `/api/v1/documents` | `content:read` | `ContentPage` — a query over published content |
| `GET` | `/api/v1/documents/:id` | `content:read` (+`:draft`) | `Document` |
| `GET` | `/api/v1/documents/by-path/*` | `content:read` (+`:draft`) | `Document` |
| `POST` | `/api/v1/documents` | `content:write` | `Document`, `201` |
| `PUT` | `/api/v1/documents/:id/content` | `content:write` | `WriteResult` |
| `PATCH` | `/api/v1/documents/:id/fields` | `content:write` | `WriteResult` |
| `PATCH` | `/api/v1/documents/:id` | `content:write` | `DocumentMeta` |
| `DELETE` | `/api/v1/documents/:id` | `content:write` | `{ deleted: string[] }` |
| `POST` | `/api/v1/documents/:id/publish` | `publish` | `{ publishedAt, publishedSyncId, version }` |
| `POST` | `/api/v1/documents/:id/versions` | `publish` | `VersionMeta`, `201` |
| `GET` | `/api/v1/documents/:id/versions` | `content:read` | `{ versions: VersionMeta[] }` |
| `GET` | `/api/v1/assets` | `content:read` | `{ assets: AssetRow[] }` |
| `POST` | `/api/v1/assets?filename=…` | `assets:write` | `{ asset, value }`, `201` |

Two notes on that table:

- **`PATCH /documents/:id` is the URL and the tree**, not content. A page's own
  title lives on its root block and is written through `PATCH /fields`; this route
  is `title` (the row's cached copy), `slug`, `parentId` and `index`.
- **Checkpointing requires `publish`**, not `content:write`. A checkpoint publishes
  nothing, but the editor gates the identical operation at `publisher`+, and the
  same act being cheaper over the API would be a hole rather than a feature.

`GET /folio/asset/:key` — the public URL a published page points its `<img>` tags
at — is deliberately **not** duplicated under `/api/v1`. It needs no token and has
no envelope; one narrow route is easier to keep narrow than two.

---

## The document shape

A stored document is normalised: a flat map of bloks keyed by uid, each holding its
own `parent`, `slot` and a fractional `order` string. The API speaks trees instead.

```jsonc
{
  "id": "sty_9f3c1a02",
  "type": "page",              // document type name, not the root block's name
  "title": "About us",         // the row's cached title
  "path": "about",             // null for a record or a singleton
  "url": "/about",             // null for the same
  "state": "live",             // draft | live | unpublished | changed
  "publishedAt": 1785300000000,
  "updatedAt": 1785300000000,
  "source": "published",       // which snapshot `content` is
  "locale": "fr",              // present only on a locale-resolved read
  "content": {
    "uid": "9f3c1a02bb47de10",
    "type": "page",
    "fields": {
      "title": "About us",
      "noindex": false,
      "body": [                                    // a `blocks` field is an array
        {
          "uid": "1a2b3c4d5e6f7081",
          "type": "hero",
          "fields": { "heading": "Hello", "actions": [] },
          "i18n": { "fr": { "heading": "Bonjour" } }
        }
      ]
    }
  }
}
```

- **`blocks` fields become arrays in `fields`.** The shape mirrors what a block
  author sees in `render`, not the storage graph, so nothing outside Folio needs to
  know that fractional indexing exists.
- **A declared slot with no children reads as `[]`**, so you can see the shape.
- **`i18n` is a sibling of `fields`**, matching how it is stored: source values in
  `fields`, per-locale overrides in `i18n`. Absent when a blok has no translations.
- A block whose type was removed from the code, or a slot whose field was, still
  reads — as stored. Refusing to read content because code changed is worse than
  reporting it.

### Reading

| Parameter | Effect |
| --- | --- |
| `?status=draft` | The live draft rather than the published snapshot. Needs `content:read:draft` |
| `?locale=fr` | Every field resolved through that locale's fallback chain, and `i18n` dropped |

`?locale=` produces a **read-only** payload: writing it back would put French into
the source locale. The `locale` field on the response is the flag that says so.
Omit it and you get the authoring shape, which round-trips.

`by-path` takes the story's public path with no leading slash; a bare
`/documents/by-path/` is the root story. An unrouted document (a record, a
singleton) is a `404` here by design — it has no path.

`GET /documents/:id` for a document with nothing published answers `404` with a
message naming `?status=draft`, rather than an empty document.

---

## Writing

### `PUT /documents/:id/content`

```jsonc
{
  "content": { /* a document tree, as above */ },
  "mode": "merge"       // or "replace". Default "merge"
}
```

Answers:

```json
{ "changed": 1, "transactions": 1, "syncId": 42 }
```

| Field | Meaning |
| --- | --- |
| `changed` | Mutations committed. `0` means the payload asked for nothing new |
| `transactions` | How many it took. More than one only past 200 mutations |
| `syncId` | The document's log position afterwards |
| `replayed` | Present and `true` only when an `Idempotency-Key` had already been used |

**A write is read-diff-commit through the same mutation log the editor writes
through.** So it reaches every open editor as a delta, lands in the activity trail
as `token:<name>`, and is undoable with Cmd+Z. An unchanged payload produces zero
mutations and writes nothing at all — a nightly sync of 400 products of which 3
changed is three writes.

#### `uid` is optional on the way in

Present: that blok is updated in place. Absent: a fresh uid, placed between its
neighbours. So a read-modify-write preserves identity — which is what keeps version
diffs minimal, presence attached to the right block, and undo granular.

Order is positional: send the array in the order you want. Existing sibling keys
are kept wherever they can be, so inserting at the front of a list of fifty is one
insert and zero moves rather than fifty.

#### `merge` (the default)

- a field absent from `fields` keeps its stored value
- an absent `i18n` keeps the stored translations
- an absent slot keeps that slot's children, subtrees and all
- a slot that **is** present is authoritative for that slot — which is how a block
  is removed through `PUT`

So the smallest useful write is:

```json
{ "content": { "uid": "9f3c1a02bb47de10", "fields": { "title": "About" } } }
```

`type` may be omitted on any node whose `uid` already exists; it is required for a
new one.

#### `replace`

`fields` is the whole content: an absent field is cleared, an absent slot's children
are removed. One refusal exists to stop it doing damage you did not ask for: a
replace that omits `i18n` on a blok holding translations answers `400` with the
locales named. Send them back, or `"i18n": {}` to clear them deliberately.

### `PATCH /documents/:id/fields`

Targeted field writes. Skips the diff, becomes one `set` per field, and touches no
structure.

```json
{ "fields": { "title": "New title" },
  "bloks": [ { "uid": "1a2b3c4d5e6f7081", "fields": { "heading": "Changed" } } ],
  "locale": "fr" }
```

- `fields` addresses the **root** blok, where a document's own metadata lives
- `bloks` addresses any other blok by uid
- `locale` scopes every write in the request to one language, writing `i18n` rather
  than `data`

Two things are dropped rather than refused, and reported as `changed: 0`:

- a **uid this document does not have** — a no-op by the mutation vocabulary's own
  rule, and a `404` here would turn a legitimate concurrent-delete race into an
  error
- a value that **already equals what is stored** — a write that changes nothing
  should log nothing

A `blocks`-kind field is refused: structure is `PUT /content`'s job.

### `POST /documents`

```jsonc
{
  "type": "insight",          // absent means the default page type
  "title": "Hello",
  "slug": "hello",            // absent derives one from the title
  "parentId": "sty_parent",   // page types only
  "content": { /* optional, merged over the type's starting document */ }
}
```

Answers the created `Document` with `201`.

The content is validated **before** the row is written, so a payload the schema
refuses writes nothing at all. Creating a document is then two writes across two
stores — a D1 row and a Durable Object — which cannot be atomic, because they share
no transaction. The order is chosen for its failure mode: if the second write fails
you get a story row with a blank document, which is exactly what a page an editor
created and never filled in looks like. The response in that case is **`502`
`incomplete`**, naming the created id so you can retry the content alone with
`PUT /documents/:id/content`.

A singleton cannot be created: there is exactly one, its id is derived, and `POST`
has no way to express "the" rather than "a". The refusal names the id to write to.

### `DELETE /documents/:id`

Deletes the document, its descendants, their versions and their index rows in one
batch, then purges their Durable Objects. `?redirect=false` skips the automatic
redirect from the vacated path.

A singleton is refused: it exists because the schema says so, and deleting it would
only mean it comes back empty.

---

## Idempotency

```
Idempotency-Key: nightly-2026-07-30
```

Accepted on `PUT /content` and `PATCH /fields`. The key is hashed to a transaction
id and handed to the log, whose unique index on it already answers a resend with
the delta it produced the first time.

- a retry answers `"replayed": true` with the **original** `syncId` and mutation
  count, and writes nothing
- the log holds exactly **one** transaction for the key
- **scoped per document**, because the log is. A batch across documents needs a key
  each; the per-document responses make a retry after a partial failure precise
- a write past 200 mutations is several transactions, each with its own derived id,
  so a partially-applied retry resumes rather than repeating

**Reusing a key with a different body is answered by the first write.** That is the
contract: the key is the identity of the write, and `replayed: true` is how you
notice. Use a new key for a new write.

---

## Querying

`GET /api/v1/documents` takes a `ContentQuery` as query parameters, over
**published content only**.

| Parameter | Form | Notes |
| --- | --- | --- |
| `type` | `type=insight` or `type=a,b` | Repeatable. Absent queries every type |
| `parent` | `parent=sty_x`, or `parent=` | Present-and-empty means the top level |
| `locale` | `locale=fr` | Filters and sorts against that locale's index rows |
| `where` | `where=topic:eq:policy` | `field:op:value`. Repeatable, at most 8 |
| `order` | `order=published:desc` | One field. Or a bare `publishedAt`, `ord`, `title` |
| `page` | `page=2` | 1-based |
| `perPage` | `perPage=10` | Default 20, maximum 100 |

Operators: `eq`, `ne`, `in` (comma-separated), `contains`, `startsWith`, `gt`,
`gte`, `lt`, `lte`. A `where` or `order` may only name a field a root block
declares `indexed: true`; anything else is a `400` naming the field, never a silent
empty result.

Answers:

```json
{ "items": [ { "id": "…", "title": "…", "url": "…", "data": { … }, "doc": { … } } ],
  "total": 25, "page": 2, "perPage": 10, "pages": 3 }
```

**`?status=draft` is refused with `501`.** A draft lives in its own Durable Object,
so a query over drafts means opening one object per candidate row. Read drafts one
document at a time: `GET /documents/:id?status=draft`.

---

## Errors

Every failure answers the same envelope, and the message is always written for you
rather than being a database error that escaped:

```json
{ "error": { "code": "bad_request", "message": "body[0].fields.headng is not a field of 'hero'" } }
```

| Code | Status | Means |
| --- | --- | --- |
| `bad_request` | 400 | The payload. Schema refusals name the failing path |
| `unauthorized` | 401 | No usable credential: absent, expired, or revoked |
| `forbidden` | 403 | A credential this server recognises, lacking the scope. Retrying will not help |
| `not_found` | 404 | No such document, path, or version |
| `conflict` | 409 | Legible and refused: a slug collision, a singleton, a structurally invalid transaction |
| `too_large` | 413 | Over a document or upload cap. The message carries the numbers |
| `unsupported` | 501 | Well-formed, but this server has no such type, locale, or capability |
| `incomplete` | 502 | Half of a two-store write landed. The message names what exists |
| `internal` | 500 | A bug or a platform failure. Deliberately says nothing else |

**Schema refusals name the path that failed** and never drop it silently:
`body[0].fields.headng`, `body[2].i18n.fr.heading`, `fields.noindex`. Refused
things: an unknown block type, a block a slot's `allow` forbids, a slot over its
`max`, an unknown field name, a value of the wrong JSON shape, a duplicate uid
inside one payload, and a replace that would destroy translations. Silently
dropping any of them is how an import appears to succeed and loses a third of its
content.

Two leniencies worth knowing, both because the strict version would make a real
document unwritable rather than safer:

- **`null` is valid for every field kind.** It is the mutation vocabulary's "no
  value", and in a locale map it means *untranslated* — the only way to express
  "untranslate this", since there is no delete-field mutation.
- **A block type the code no longer declares can still be written** when the
  document already holds it, and `allow` is enforced only on a block you actually
  put somewhere. Otherwise a document containing one could not be edited at all.

---

## Rate limiting

There is no bespoke counter in Folio, and that is deliberate: a per-token counter
in a Worker is either a Durable Object on the hot path of every request or a race.
What exists instead:

- **`api_tokens.last_used_at` is stamped on every presented token**, allowed or
  refused, because the question it answers is "is this credential in use" rather
  than "did it succeed". That makes an unexpectedly busy or long-dormant token
  visible in the Access rail.
- **The document caps bound a single request**: 200 mutations per transaction,
  20,000 bloks and 8 MB per document, 100 items per query page.
- **Anything volumetric belongs at the zone**, as a Cloudflare rate-limiting rule
  matched on `http.request.uri.path contains "/folio/api/"`. It runs before the
  Worker, costs the Worker nothing, and is configured where every other limit for
  the site already is.

Revocation is immediate: `DELETE /folio/tokens/:id` sets `revoked_at`, and the next
request answers `401` — a credential that no longer exists, not one lacking a
scope. The row is kept rather than deleted so "which token was that, and when did
we turn it off" stays answerable.

---

## Not in `v1`

- **GraphQL.** One shape over HTTP with a query object. A second query language is
  a product decision nobody has asked for.
- **Webhooks.** A host owns its Worker and can react inside its own publish call
  today (`FolioConfig.hooks`); a general webhook system with retries, secrets and
  delivery logs is its own thing. Folio does not need them for cache purging the
  way a hosted CMS does — it owns both sides.
- **Realtime subscriptions for API consumers.** The machinery exists; the auth
  model for a read-only external subscriber does not.
- **Bulk endpoints across documents.** Per-document idempotency makes a client-side
  loop correct and resumable, which is easier to reason about than a batch endpoint
  that is partially applied. The admin has them (`{base}/api/bulk/*`,
  `docs/specs/platform/bulk-writes.md`) and they are deliberately **not** here: what
  they exist for is "act on every document matching this filter" without materialising
  the ids, which is a UI problem. A script has the ids.
- **Draft queries.** See the query section: one document at a time, by design.
