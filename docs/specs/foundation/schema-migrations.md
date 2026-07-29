# Feature: Schema migrations — moving stored documents when the model changes

> **Group:** foundation
> **Build order:** 11
> **Size:** M
> **Status:** draft
> **Wire version:** bumps `PROTOCOL_VERSION` to 2 (`Mutation` gains `retype`)
> **Migration:** `0008_schema_migrations.sql`
> **Last updated:** 2026-07-29

## Summary

Block schemas are code and documents are data, and nothing reconciles the two.
Rename `heading` to `title` in a block's `fields` and every stored document keeps
writing to `heading`, which no longer renders; the old value is still in
`blok.data`, invisible, and the field the admin now draws is empty. Rename a block
type and every existing instance renders "Unknown block type" in the editor and
nothing at all on the live page. Split one field into two, tighten a `select`'s
options, move a field from a parent to a child: same class of silent breakage.

There is currently no way to fix any of that, because there is no way to reach the
stored documents. They live in three places — the Durable Object's draft, the
`stories.published_doc` snapshot, and every `versions.doc` row — and one of those
is behind a WebSocket protocol.

This spec adds content migrations: a migration is a **pure function from a document
to a list of mutations**, which is what lets the same migration drive a live draft
(as an ordinary transaction, so it syncs, appears in the activity trail and is
undoable), a published snapshot (as a plain `applyAll`), and a version document
(migrated on read, so history is never rewritten).

It also adds the one mutation the vocabulary is missing: there is no way to change a
blok's type.

## Ground truth

**core (`packages/folio/src/core/`):**
- `Blok.data: Record<string, Json>` (`doc.ts:13-21`) is untyped at rest. Nothing
  validates a document against a schema, at any point, ever.
- `RenderBlok` (`preview/Render.tsx`) iterates `def.fields` and reads
  `blok.data[name]`. So a key the schema no longer declares is **never read** — it
  persists indefinitely and is invisible — and a key the schema declares but the
  data lacks resolves through `resolveValue` to its kind's empty value. Both
  failures are quiet by construction.
- An unknown *type* renders `<div class="folio-unknown">Unknown block type “x”</div>`
  in edit mode and `null` on a published page (`Render.tsx`).
- `blankBlok(schema, type, …)` (`schema.ts`) fills field defaults **only at insert
  time**, so a field added to a schema never appears in documents written before it.
- `Mutation` is `set | insert | move | remove` (`mutations.ts:7-12`). **There is no
  way to change `blok.type`.** `insert` refuses a duplicate uid
  (`mutationError`: `duplicate uid`), and `remove` cascades over the subtree
  (`apply`), so "remove and re-insert with the same uid" cannot be expressed as a
  transaction either.
- `diff(from, to)` (`diff.ts`) emits inserts → moves → sets → removes and is
  property-tested for the rescued-children case; `invertAll` inverts each mutation
  against the state it saw.
- `MAX_TX_MUTATIONS = 200` and `MAX_FRAME_BYTES = 256 KB` (`protocol.ts:94-102`)
  cap one transaction. `MAX_DOC_BLOKS`/`MAX_DOC_BYTES` cap the document.
- `core/engine.ts`'s own doc comment already names this feature as the reason that
  entry point exists: *"This entry exists for HOST-SIDE TOOLING that legitimately
  needs to manipulate documents — bulk-import scripts, content migrations."*

**server (`packages/folio/src/server/`):**
- `StoryDO` has exactly one mutating door: `webSocketMessage`'s `tx` case. Every
  guarantee (atomic validation, txId dedupe, log append, broadcast, watermark)
  lives inside it. There is no RPC that writes a transaction.
- `getOrInit(seed)` creates a document from the *current* schema on first touch, so
  documents are born up to date; only existing ones drift.
- `publishStoryStatement` writes the whole document as JSON;
  `publishedDocsByIds` reads several at once.
- `versions.doc` is a full document per row, never rewritten, and
  `getVersion` parses it back. Restore is `diff(live, target)` applied as one
  transaction (`admin/hooks/useVersions.ts`), which already refuses over
  `MAX_TX_MUTATIONS` with a readable message.

**tests:**
- `test/unit/core/mutations.test.ts` (503 lines) and `diff.test.ts` (551) are the
  contract for anything added to the vocabulary.
- `scripts/fields-test.mjs` already covers "tolerance of values written before these
  fields existed", which is the *read-side* half of this problem.

## Owner decision checkpoints

1. **A migration produces mutations, it does not rewrite documents (recommended).**
   Every alternative (rewrite the DO's `doc` row, rewrite `published_doc` and hope
   the draft catches up) bypasses the mutation log, which means no sync, no
   activity trail, no undo, and an open editor whose document silently diverges
   from the object's. Cost: a migration over a huge document is several
   transactions rather than one write.
2. **Migrations must be idempotent, and that is the correctness mechanism
   (recommended).** A migration applied to an already-migrated document must
   produce zero mutations. That makes the whole runner re-runnable after a partial
   failure, makes the ledger an optimisation rather than a guarantee, and makes
   "did this actually work" answerable by running it again and seeing nothing
   happen. The alternative — exactly-once bookkeeping per document — is a
   distributed-systems problem nobody needs to have.
3. **Version documents are migrated on read, never rewritten (recommended).**
   History stays byte-true, and a restore applies the pending migrations to the old
   document before diffing it against the live one. The alternative — rewriting
   every version row — is a large write amplification and it destroys the record of
   what was actually published.
4. **A drifted database shows a banner, it does not lock the editor
   (recommended).** Refusing to serve the admin until a migration runs would turn a
   schema drift into an outage. Overriding this means picking which is worse:
   editing against a stale model, or not editing at all.
5. **The runner is explicit, not automatic on boot (recommended).** `folio.migrate
   (env)` from a script, a route, or a deploy step. A migration that runs itself on
   the first request after a deploy runs inside a request whose CPU limit it can
   exceed, on a cold Worker, with no operator watching.

## User stories

### Developer renames a field without losing content
**As** a developer **I want to** rename `heading` to `title` and have every existing
document follow **so that** a rename is a refactor rather than a data loss event.

### Developer renames or replaces a block type
**As** a developer **I want to** turn every `bigQuote` into a `quote` with a
`size: 'large'` field **so that** consolidating two blocks does not mean an editor
re-creating them by hand.

### Developer sees what a migration would do first
**As** a developer **I want** a dry run that reports "142 documents, 388 mutations,
3 documents unchanged, 1 document would exceed the transaction cap" **so that** I
find out before production does.

### Editor is told the model moved
**As** an editor **I want** the editor to tell me when the site's content model has
changed and this page has not been updated yet **so that** an empty field is
explained rather than mysterious.

### Developer audits drift
**As** a developer inheriting a site **I want** a report of orphaned keys and
unknown block types across published documents **so that** I know what state the
content is actually in.

## Architecture decisions

### 1. A migration is `(doc, ctx) => Mutation[]`

```ts
// host: src/content-migrations/0001-hero-heading-to-title.ts
import { defineMigration, field } from 'folio/engine'

export default defineMigration({
  id: '0001-hero-heading-to-title',
  description: 'hero.heading → hero.title',
  up: (doc, ctx) => ctx.each('hero', (blok) => field.rename(blok, 'heading', 'title')),
})
```

Pure, synchronous, no I/O, no `env`. That is what lets one function serve three
call sites:

| Target | How the mutations are applied |
| --- | --- |
| A story's live draft | `StoryDO.commit(mutations, actor)` — the real log path, so it syncs to open editors, lands in the activity trail, and is undoable |
| `stories.published_doc` | `applyAll(doc, mutations)` and one D1 write, batched with the ledger |
| `versions.doc` | `applyAll` **at read time**, never written back (checkpoint 3) |

`ctx` gives the schema index, the document type, and the helpers below. It gives no
network and no clock: a migration that depends on either is not re-runnable, and
re-runnability is the correctness mechanism (checkpoint 2).

### 2. Helpers cover the ordinary cases; `each` is the escape hatch

```ts
field.rename(blok, 'heading', 'title')          // set new, clear old — skips if already done
field.remove(blok, 'legacyFlag')
field.default(blok, 'align', 'left')            // only when absent
field.map(blok, 'topic', (v) => String(v).toLowerCase())
field.split(blok, 'name', { firstName, lastName })
block.retype(blok, 'quote', { size: 'large' })  // retype + seed the new fields
block.wrap(doc, blok, 'container', 'body')      // insert a parent, move the blok into it
```

Every helper returns `Mutation[]` and every one returns `[]` when the document is
already in the target shape — that is where idempotence is actually implemented, so
it is implemented once rather than in every migration.

`ctx.each(type, fn)` walks the document's bloks of a type and flattens what `fn`
returns. Anything the helpers do not cover is written by hand against `Blok` and
`Mutation`, which is exactly what `folio/engine` is for.

### 3. `Mutation` gains `retype`, and the Durable Object stays schema-ignorant

```ts
| { t: 'retype'; uid: string; type: string }
```

- `mutationError`: a uid the document does not have is a **no-op, not a violation**
  (the existing rule for `set`/`move`/`remove`), and retyping the root is refused —
  a document's root type is its document type, and changing that is a
  `document-types.md` concern, not a block edit.
- `apply`: `{ ...blok, type }`. Field data is *not* touched; a retype that needs
  fields added or dropped emits `set` mutations alongside it, which is why
  `block.retype` returns several mutations.
- `invert`: `{ t: 'retype', uid, type: previous }`. So a retype is undoable like
  everything else.
- `diff`: a blok present in both documents with a different type emits a `retype`,
  ordered with the `set`s (after moves, before removes). Without this, `diff` would
  see the same uid with a different type and emit only field `set`s, quietly leaving
  the old type in place — which would make version restore across a migration
  wrong.

**The object does not check that the new type exists**, deliberately, and the
comment on `StoryDO` already states the principle: *"Deliberately knows nothing
about block schemas: the host application seeds it with an initial document and it
treats the contents as opaque."* An unknown type renders as "Unknown block type" and
is fixable by another migration; a Durable Object that had to know the schema would
need the registry pushed into it and kept in step, which is a far worse coupling
than a bad type name.

This is the whole of the wire change, and it bumps `PROTOCOL_VERSION` to 2. Old log
entries are unaffected: they contain no `retype`, and everything that reads them
still reads them.

### 4. `StoryDO.commit(mutations, actor)` — the second door, sharing the first door's guards

```ts
async commit(mutations: Mutation[], actor: { id: string; name: string }): Promise<
  { syncId: number; txId: string } | { rejected: string }
>
```

It is not a new write path. It runs the *same* body as the `tx` case: cap check →
atomic per-mutation validation against the accumulating document → document cap →
log append with a generated txId → doc row update → broadcast to every joined
socket. Refactored so the socket handler and the RPC call one private
`applyTransaction()`, because two copies of that logic would diverge and one of the
copies would be the one nobody tests.

Two consequences worth stating: a migration lands in open editors live, and
`../platform/content-api.md`'s write path needs exactly this and gets it for free.

### 5. The runner is a workflow over D1, resumable by construction

```ts
const report = await folio.migrate(env, { dryRun: true })
// { pending: ['0001-hero-heading-to-title'], stories: 142, mutations: 388,
//   unchanged: 3, oversized: [{ storyId, mutations: 240 }], failed: [] }
```

Per story, in `id` order, in batches: read the draft (`getOrInit`), compute
mutations for every pending migration in order, chunk them at `MAX_TX_MUTATIONS`,
`commit` each chunk, then `applyAll` over `published_doc` and write it with the
new `schema_id` in one batch. A failure on one story is recorded and the run
continues; re-running skips what the ledger records and no-ops on anything the
ledger missed (checkpoint 2).

Chunking splits a large migration into several transactions, which means it is
several undo steps rather than one. That is the honest trade: the alternative is
refusing to migrate documents over a size, and a CMS that cannot migrate its
biggest pages is not much use. The dry run names them (`oversized`) so it is never
a surprise.

Cold-start CPU limits are why this is a script, not a boot hook (checkpoint 5). It
runs from `wrangler dev`/`wrangler deploy` against the deployed worker via an
`admin`-scoped route (`POST /folio/migrate`, `admin` role or scope), so it is one
HTTP call with a JSON report and no separate credentials.

### 6. Two ledgers: which migrations have run, and how far each document is

`schema_migrations` records a run (id, applied_at, actor, counts) — the audit trail
and the "is anything pending" check. `stories.schema_id` records the last migration
applied to *that* story, which is what makes a partial run resumable and what tells
the admin whether the document it is about to open is behind.

`versions.schema_id` records where a version document sits, so `getVersion` can
apply the migrations it is missing on the way out (checkpoint 3). Version rows
written before this column read `null`, meaning "before the first migration", which
is the correct answer for them.

### 7. Drift detection is a separate, read-only report

```
GET /folio/audit   (admin)
{ orphanKeys:   [{ type: 'hero', field: 'heading', documents: 12 }],
  unknownTypes: [{ type: 'bigQuote', documents: 4 }],
  missingFields:[{ type: 'hero', field: 'align', documents: 31 }] }
```

Computed over published documents (one query, no Durable Objects) by walking each
blok against the schema index. It costs nothing to write once the schema index and
the documents are both in hand, and it is what turns "something looks empty" into a
migration somebody can write. It is deliberately not part of the migrate path: an
audit that runs as a side effect of a write is an audit nobody reads.

## Wire & schema changes

### D1 migration `0008_schema_migrations.sql`

```sql
-- One row per content migration that has been run. The audit trail, and the
-- source of "is anything pending" for the admin banner. Correctness does not
-- depend on it: migrations are idempotent, so a missing row costs a re-run that
-- does nothing.
create table if not exists schema_migrations (
  id            text primary key,        -- the migration's own id, e.g. '0001-hero-heading-to-title'
  applied_at    integer not null,
  actor         text,
  stories_seen  integer not null default 0,
  stories_changed integer not null default 0,
  mutations     integer not null default 0,
  failed        text                     -- JSON array of { storyId, reason }, null when clean
);

-- How far this story's draft and published snapshot have been migrated. Null
-- means "before the first migration", which is correct for every row written
-- before this column existed.
alter table stories add column schema_id text;

-- Same, for a version document. getVersion applies the migrations a version is
-- missing on the way out, so version rows are never rewritten.
alter table versions add column schema_id text;
```

### Core types

```ts
// folio/engine
export interface MigrationContext {
  schema: SchemaIndex
  type: DocumentType
  each: (blockType: string, fn: (blok: Blok) => Mutation[]) => Mutation[]
}

export interface Migration {
  id: string
  description: string
  up: (doc: Doc, ctx: MigrationContext) => Mutation[]
}

export function defineMigration(m: Migration): Migration
export const field: { rename; remove; default: …; map; split }
export const block: { retype; wrap }
```

`Mutation` gains the `retype` variant; `isMutation`, `apply`, `invert`,
`mutationError`, `diff` and `summariseDiff` all handle it. `PROTOCOL_VERSION` → 2.

`FolioConfig.migrations?: readonly Migration[]`, validated at construction: ids
unique, sorted lexicographically, no id shorter than its predecessor's prefix rule
(plain `sort()` order is the run order, so ids must be zero-padded — checked, not
assumed).

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/folio/migrations` | editor+ | Pending ids, and whether the open story is behind |
| POST | `/folio/migrate` | admin | Run pending migrations; `{ dryRun }` in the body; returns the report |
| GET | `/folio/audit` | admin | Drift report (decision 7) |

## Acceptance criteria

### A field rename reaches every copy of a document
```
GIVEN a hero blok with data.heading = 'Hi' in a draft, in published_doc, and in
      two version rows
WHEN migration 0001 (heading → title) is run
THEN the draft has title 'Hi' and no heading key, and the change arrived as a
     logged transaction attributed to the migration's actor
AND published_doc has title 'Hi' and no heading key
AND the version rows are byte-unchanged
AND opening either version in the admin shows title 'Hi' (migrated on read)
AND stories.schema_id and schema_migrations both record 0001
```

### A migration reaches a connected editor live
```
GIVEN an editor with the story open and a socket connected
WHEN the migration runs
THEN their document updates without a reload, the activity trail shows the
     transaction, and Cmd+Z inverts it
```

### Re-running does nothing
```
GIVEN migration 0001 already applied
WHEN it is run again (with the ledger row deleted, to prove idempotence rather
     than bookkeeping)
THEN it produces zero mutations, writes no transaction, and reports 0 changed
```

### Retype
```
GIVEN a bigQuote blok with three children in its `body` slot
WHEN a migration retypes it to quote and sets size 'large'
THEN the blok's type is quote, its uid is unchanged, its children are still its
     children in the same order, and size is 'large'
AND invert of that transaction restores bigQuote
AND diff() between the before and after documents emits a retype, not just sets
```

### Dry run changes nothing
```
GIVEN two pending migrations
WHEN POST /folio/migrate { dryRun: true } is called
THEN the report names both, counts documents and mutations, lists documents whose
     mutation count exceeds MAX_TX_MUTATIONS
AND no transaction is logged, no published_doc changes, no ledger row is written
```

### Oversized migrations are chunked, not refused
```
GIVEN a document needing 450 mutations
WHEN the migration runs
THEN it lands as three transactions of at most 200, each valid on its own
AND the document is fully migrated
AND the report says the document took three transactions
```

### Partial failure is resumable
```
GIVEN 100 stories and a Durable Object that fails on story 43
WHEN the run completes
THEN 99 stories are migrated, the report names story 43 and why, and no ledger
     row claims the migration is complete
AND re-running migrates story 43 and no-ops on the other 99
```

### The admin explains a behind document
```
GIVEN a story whose schema_id is behind the configured migrations
WHEN an editor opens it
THEN a banner reads "This page has not been updated for the latest content model"
     with the pending migration descriptions
AND the editor still works normally (checkpoint 4)
```

### Drift audit
```
GIVEN 12 published documents with an orphaned hero.heading key and 4 with an
      unknown bigQuote block
WHEN GET /folio/audit is called
THEN both are reported with their counts, and no document is modified
```

## Implementation plan

Deploy order: phase 1 and 2 are a wire bump, so the worker and the admin ship
together (they always do — same build). Phase 3 can follow separately.

### Phase 1 — the mutation vocabulary

1. `core/mutations.ts`: `retype` in the union, in `mutationError` (root refused,
   missing uid is a no-op), `apply`, `invert`.
2. `core/protocol.ts`: `isMutation`'s `retype` case; `PROTOCOL_VERSION` → 2.
3. `core/diff.ts`: emit `retype` for a surviving uid whose type changed, ordered
   after moves and before/with sets; extend `summariseDiff` (`retyped` count).
4. Tests: `mutations.test.ts` (validate/apply/invert/round-trip),
   `protocol.test.ts` (guard), `diff.test.ts` (retype emission and its ordering,
   including the property test that `applyAll(from, diff(from, to))` equals `to`).

### Phase 2 — the transaction RPC

1. `story-do.ts`: extract `applyTransaction(mutations, actor, txId?)` from the `tx`
   case; add the `commit` RPC over it; add `commit` to the `StoryStub` pick in
   `server/types.ts`.
2. Tests: `test/workers/story-do.test.ts` — commit logs, broadcasts to joined
   sockets, dedupes a repeated txId, refuses over the caps with the same reasons the
   socket path gives, and (important) does **not** broadcast to unjoined sockets.

### Phase 3 — migrations

1. Migration `0008_schema_migrations.sql`.
2. `core/migrate.ts` (exported from `folio/engine`): `defineMigration`, the `field`
   and `block` helpers, `MigrationContext`, and `pendingFor(schemaId, migrations)`.
3. `server/migrate.ts`: the runner (batched, resumable, chunked), the report shape,
   and `folio.migrate(env, opts)` on the public interface.
4. `server/versions.ts`: `getVersion` applies pending migrations for the row's
   `schema_id`; `buildVersionWrite` stamps the current one.
5. `server/routes/migrations.ts`: the three routes, gated per
   `../foundation/identity-and-access.md`.
6. `server/audit.ts` + the `/folio/audit` route (decision 7).
7. Tests: unit tests per helper (each returning `[]` on an already-migrated
   document is the one that matters); workers tests for the runner over a seeded
   database, the chunking case, the failure case, and version-on-read migration.

### Phase 4 — admin and docs

1. The banner (pending migrations for the open story), read from
   `/folio/migrations`.
2. An admin screen showing pending migrations, the dry-run report, and a Run button
   (admin role only).
3. `README.md`: a Content migrations section; extend the `folio/engine` description,
   which already promises this use case.
4. `ROADMAP.md`: record that the mutation vocabulary can now express a type change.

## Edge cases

- **A migration that touches a document nobody has opened** → `getOrInit` seeds it
  from the *current* schema, so it is born correct and the migration is a no-op.
  The runner still stamps `schema_id`, so it is not re-read next time.
- **A story whose Durable Object is unreachable** (transient) → recorded in
  `failed`, ledger not completed, re-run picks it up.
- **A migration that produces mutations the object refuses** (e.g. a hand-written
  `move` creating a cycle) → the whole chunk is rejected with a reason, recorded
  per story, and nothing partial lands: the `tx` path is atomic and `commit` shares
  it.
- **Two runs at once** → both are idempotent, both compute from the document they
  read, and the log's txId dedupe stops a resent chunk landing twice. The second
  run's chunks are no-ops or ordinary transactions. No lock, deliberately: a lock
  that can be orphaned is worse than an idempotent operation done twice.
- **An editor typing during a migration** → last write wins per field, as it does
  for any two editors. The migration is a peer, not a privileged writer.
- **Undo of a migration transaction by an editor** → allowed. It re-drifts that one
  document, and the next run re-migrates it. Refusing to let an editor undo
  something they can see happen would need a class of un-undoable transaction,
  which the store does not have and should not gain for this.
- **A version restored across a migration** → `getVersion` migrates the old
  document on read, so `diff(live, migratedTarget)` is computed between two
  documents in the same shape. Without this the restore would reintroduce
  pre-migration keys, which is the subtle bug this whole decision exists to avoid.
- **A migration id inserted out of order** (`0001b` between `0001` and `0002` after
  `0002` has run) → refused at construction: ids must sort after every applied id.
  The alternative is a run order that depends on when you deployed.
- **Localisation** (`../content-model/localisation.md`, which lands after this) →
  a translated value lives in `blok.i18n[locale][field]`, and a locale-scoped `set`
  is how a migration moves it. The helpers gain a locale-aware form there rather
  than here; `each` covers it in the meantime.
- **`MAX_DOC_BYTES` exceeded by a migration** (a `split` that duplicates data) →
  the chunk is refused with the document-cap reason, recorded, and the migration
  needs rewriting. Correct: the cap exists to stop exactly this.

## Testing requirements

**Unit:** the full `retype` contract (validate/apply/invert/diff/guard); every
helper's idempotence; `pendingFor`; migration id ordering validation.

**Workers:** `commit` sharing the socket path's guards; the runner's resumability,
chunking and failure reporting; version-on-read migration; the audit report over a
seeded database.

**End to end (`scripts/migrate-test.mjs`, new):** against a live dev server — seed
two stories, publish one, run a rename migration with an editor socket connected,
assert the connected client received the delta, the published page renders the new
field, an old version previews correctly, and a second run reports zero changes.

## Dependencies

- `../foundation/document-types.md` — `MigrationContext.type`, and because a
  migration is scoped per document type.
- `../foundation/identity-and-access.md` — the `admin` gate on `/folio/migrate`,
  and a real actor to attribute migration transactions to (`migration:0001` when
  run by a token).
- Everything after this in the build order depends on it, which is why it sits
  here.

## Out of scope

- **Migrating a document from one *document type* to another** (a `page` becoming an
  `insight`). It needs a `retype` of the root plus a `stories.type` update in the
  same breath, which is a two-store change with no atomicity available. Expressible
  by hand once `retype` exists; not automated here.
- **Schema versioning per block** (`defineBlock({ version: 2 })`) with automatic
  up-conversion on read. Lazy per-read migration means a document's shape depends on
  when it was last read, which makes the diff, the audit and the query index all
  ambiguous. Explicit migrations, applied once, in a known order.
- **Rolling a migration back.** Every mutation is invertible and the log holds
  what happened, so a `down` is writable when something needs one — but a generated
  inverse over 142 documents applied hours later is a worse tool than a new forward
  migration, and offering it would imply a safety it does not have.
- **Importing from another CMS.** `PARITY.md` Phase 6. It uses the same
  `folio/engine` surface and the same `commit` RPC, and it is a separate spec.
- **Validating documents against schemas at write time.** `required` is still
  declared and ignored (`PARITY.md` Phase 5); making it enforced is a
  field-validation feature, and doing it here would mean every migration also has
  to satisfy it.

## Open questions

- Should `POST /folio/migrate` stream progress (a long run over hundreds of stories
  against Workers' CPU limits) or return one report? A batched loop with a
  `continueFrom` cursor in the response and the client re-calling is the boring
  answer, and probably the right one — decide when the first real dataset makes the
  limit measurable.
