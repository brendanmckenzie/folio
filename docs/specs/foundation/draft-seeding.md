# Feature: A draft seeds from what is published

> **Group:** foundation
> **Build order:** 27, per docs/specs/README.md
> **Size:** M
> **Status:** draft
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-08-30

## Summary

A story whose D1 row arrives without its Durable Object — which is what copying a
database between environments does, every time — gets a **blank draft with a fresh
root uid** on first editor open. From there every supported write is closed:
`diff` refuses documents with different roots, so `POST /documents/:id/restore` and
`PUT /documents/:id/content` both fail, and the admin's Restore button reports
`Cannot diff documents with different roots`, which names the mechanism and not the
cause. The document is unrecoverable through the product.

Found on a live staging environment 2026-08-30, where all twelve documents were in
this state: `published_doc` and `versions` intact, every draft blank.

This makes `getOrInit` seed from the story's published document when it has one, so
the case heals itself on first open, and adds a repair path for documents already
in the broken state.

## Ground truth

Verified against the tree at `3876cbd`.

**the seed (`src/server/runtime.ts`):**
- `seed(type, title)` (`:487`–`:496`) builds a blank subtree with `blankSubtree` and
  returns `{ root: root.uid, bloks: … }`. **The root uid is minted, not derived from
  the story id**, so purging an object and reopening it produces a *third* uid rather
  than recovering the first.
- Three call sites build that seed and hand it straight to the object:
  `draftFor` (`:506`), `draftForWithSyncId` (`:509`), `draft` (`:513`).

**the object (`src/server/story-do.ts`):**
- `getOrInitWithSyncId(seed: Doc)` (`:303`) is
  `const row = this.read(); if (row) return row;` then an insert. **The seed is used
  only when the object has no doc**, so today it is constructed on every draft read
  and discarded on all but the first.
- `getOrInit(seed)` (`:289`) delegates to it and exists for every other caller.
- `head()` (`:316`) is `this.read()?.syncId ?? 0`. **It cannot distinguish "no
  document" from "a document nobody has edited"** — a freshly seeded doc also reads
  0 — so it is not a usable "has this been initialised" probe.
- `purge()` (`:328`) drops the object's state; its own comment notes a following
  `getOrInit` re-seeds.
- `StoryStub`'s method union is `types.ts:127`, so any new method is declared there.

**seeding from a real document already exists, in two places:**
- `documents.ts:85` — `getOrInit(cloneDoc(draft))`, duplicating a document.
- `routes/api/documents.ts:367` — `getOrInit(seeded)`, creating one with content in a
  single call rather than seeding blank and committing after (`runtime.ts:196`
  records that as the reason).

  So "the seed is not always blank" is established. This spec adds a third source,
  it does not introduce the idea.

**the guard that closes every write (`src/core/diff.ts`):**
- `:29`–`:30`: `if (from.root !== to.root) throw new Error('Cannot diff documents
  with different roots')`, under a comment stating the assumption that breaks here:
  *"Both documents must share a root uid. They always do for a given story, since the
  root block is created once and never replaced."* True for a document created
  through Folio; false for one whose row was imported.
- `writeDocument` (`server/write.ts:175`) is `read the draft, diff, commit`, so both
  `restore` (`routes/api/documents.ts:625`) and `PUT /content` (`:395`) inherit it.
- **No mutation can change a root uid.** `root` is a field on `Doc`, not a blok, and
  the `Mutation` union addresses bloks — so a repair cannot be expressed as a
  transaction and must be a re-seed.

**the escape that exists but nobody finds (`src/core/nested.ts`):**
- `:313`: `const rootUid = base ? base.root : (uidOf(node, '') ?? newUid())` — a
  nested payload is rebuilt under the *base* document's root, and `:307`–`:312` only
  refuses a payload that explicitly names a different one. So `PUT /content` with the
  root's `uid` omitted already works today. It requires reading core to discover.

**what a caller knows cheaply:**
- `StoryMeta.publishedAt: number | null` (`core/story.ts:30`) is on the row every
  `draftFor` caller already holds, so "might this story have a published document"
  costs nothing.
- `publishedById`-shaped batch reads exist (`server/stories.ts:1063`); a single-row
  read by id does not yet and is trivial.

**scale of the change:** ~19 `draftFor` / `rt.draft` call sites across
`index.tsx`, `pages.tsx`, `runtime.ts`, `mcp/shot.ts`, `routes/stories.ts`,
`routes/editor.ts`, `routes/migrations.ts` and `routes/api/documents.ts`. **None of
them changes**, which is the point of putting the decision inside `draftFor`.

## Owner decision checkpoints

1. **A repaired document's draft equals its published copy, not its pre-break
   draft.** There is nothing else it could equal — the pre-break draft never arrived
   — but it means "unpublished changes" made in the source environment are gone, and
   the tree's `changed` badge clears. Recommended, and it is the honest answer: what
   crossed the wire is what can be restored.

2. **`reseed` discards the current draft, and is guarded rather than confirmed.**
   Recommended: refuse unless the draft is structurally blank (root blok, no
   children), with `force: true` to override. A confirmation dialog would be the
   usual shape, but this route is reached by an operator repairing an import, not by
   an editor, and a guard that names what it found is better than a prompt that
   assumes the caller knows.

## User stories

### An operator copies production content into staging
**As** a developer refreshing a staging environment from a database export **I want**
the editor to show the content that is in the database **so that** staging is usable
without knowing that Durable Objects exist.

### An editor opens a page that has never been edited here
**As** an editor **I want to** open an imported page and see its published content in
the editor **so that** I can change one line rather than rebuild the page.

### An operator repairs an environment already in this state
**As** a developer holding twelve blank drafts **I want** one call per document that
puts them right **so that** the fix is not a hand-written script against internals.

## Architecture decisions

### 1. The seed is chosen by `draftFor`, from the published document when there is one

`draftFor(bindings, story)` becomes: if the object already holds a document, return
it; otherwise build a seed — the story's `published_doc` when `publishedAt` is set,
a blank subtree otherwise — and initialise with that.

**This changes behaviour in exactly one case.** A document created through Folio has
no published copy at seed time (`POST /documents` writes the row and seeds the object
in the same request), so the published branch is unreachable for it. The only story
that reaches it is one whose row exists, whose object does not, and which has been
published — which is precisely the imported case and otherwise impossible.

Rejected: **leaving it blank and documenting the workaround.** The workaround is a
`PUT /content` with an omitted root uid, discovered by reading `core/nested.ts`. A
recovery procedure nobody can find from the error message is not a recovery
procedure.

Rejected: **seeding from the newest `versions` row instead.** It is the same content
in the ordinary case and worse in two others: a story can be published without a
version row surviving an import, and a version is *history*, so restoring from it
silently reinterprets what "the current draft" means.

### 2. The object gains a read that does not seed, so the cold path pays and the warm path does not

Today the seed is a `Doc`, so it must be fully constructed before the RPC even
though `getOrInitWithSyncId` discards it whenever a row exists. Building it from D1
would therefore put a read on **every draft read** to serve a case that can happen
once per document, ever.

So `StoryStub` gains `peek(): Promise<{ doc: Doc; syncId: number } | null>` — the
existing `this.read()`, exposed — and `draftFor` becomes peek-then-maybe-init. The
warm path is one RPC exactly as now; the cold path is two RPCs and one indexed D1
read, once per document for the life of the site.

Rejected: **passing a lazy `() => Promise<Doc>` over RPC.** Workers RPC can carry a
function, but it becomes a stub the object calls *back* into the Worker mid-write —
a second hop, inside the one place in this system that must stay simple, to save an
RPC on a path taken once.

Rejected: **probing with `head()` first.** It answers 0 both for an object with no
document and for a seeded one nobody has edited (`story-do.ts:316`), so it cannot
answer the question being asked. Using it would re-seed an untouched document on
every open.

### 3. The race is already handled, and the losing seed is discarded

Two concurrent cold opens both `peek` null, both build a seed, both call
`getOrInit`. The second is a no-op: `getOrInitWithSyncId` is
`const row = this.read(); if (row) return row`, so whichever insert lands first wins
and the other caller receives the winner's document. No lock, no compare-and-set, and
the only cost of losing is one wasted D1 read.

Worth stating because the obvious reading of "check then write" is that it needs
one, and it does not.

### 4. Repairing an already-broken document is a re-seed, not a diff

`POST {base}/api/v1/documents/:id/reseed` purges the object and re-initialises it
through decision 1's path.

It cannot be a write, and that is structural rather than a limitation of the current
routes: **a root uid cannot be changed by any mutation.** `root` is a field on `Doc`
and the `Mutation` union addresses bloks, so there is no transaction that turns a
document with root A into one with root B. Every diff-based path — `restore`,
`PUT /content` naming the old root — is therefore permanently closed for these
documents, and the only move is to replace the object's state.

Guarded per checkpoint 2: refused unless the draft is structurally blank, `force`
to override. The refusal names what it found (`"draft has 14 bloks"`), because the
operator's next question is always whether they are about to lose work.

Rejected: **relaxing `diff`'s root guard.** It is not a guard that is wrong — two
documents with different roots genuinely have no mutation path between them, and
loosening it would produce a diff that cannot be applied.

### 5. `diff`'s error names the cause, not the mechanism

`Cannot diff documents with different roots` is accurate and tells its reader
nothing they can act on. It becomes a message that names the likely cause — a
document whose row was imported without its object — and the route to take.

The throw stays in `core/diff.ts` because that is where the condition is detected,
but the *routes* catch it and answer a `FolioError` naming `reseed`, since core
cannot know that a repair endpoint exists.

## Wire & schema changes

None. No migration, no `PROTOCOL_VERSION` bump.

### Core types

`StoryStub` (`server/types.ts:127`) gains `'peek'`. `FolioRuntime` is unchanged —
`draftFor` keeps its signature, which is what keeps all ~19 call sites untouched.

### New or changed routes

| Method | Path | Auth | Answers |
| --- | --- | --- | --- |
| `POST` | `{base}/api/v1/documents/:id/reseed` | `MANAGE` | `{ document }`, or 409 naming the draft it refused to discard |

`MANAGE` rather than `EDIT`: this discards content, and the operator repairing an
import is the person who already holds it.

## Acceptance criteria

### An imported story heals on first open

```
GIVEN a stories row with published_doc and no Durable Object state
WHEN the editor opens that document
THEN the draft equals the published document, root uid included
AND the tree stops reporting it as changed
AND a subsequent restore or PUT /content succeeds
```

### A document created through Folio is unaffected

```
GIVEN POST /documents creates a document
WHEN its object is seeded
THEN the seed is the blank subtree exactly as today
AND no published_doc read is made
```

### The warm path costs nothing extra

```
GIVEN a document whose object already holds a draft
WHEN draftFor is called
THEN exactly one RPC is made
AND no published_doc read is made
```

### Repair refuses to discard real work

```
GIVEN a document whose draft has content
WHEN POST /documents/:id/reseed is called without force
THEN it answers 409 naming how many bloks it found
WHEN it is called with force: true
THEN the draft is replaced by the published document
```

## Implementation plan

### Phase 1 — `peek`, and the seed decision

1. `peek()` on `StoryDO` (the existing `read()`, exposed) and on `StoryStub`.
2. `draftFor` / `draftForWithSyncId` / `draft` in `runtime.ts` become
   peek-then-maybe-init, with a `publishedDocById(db, id)` read behind
   `story.publishedAt !== null`.
3. No call site changes. That is the acceptance criterion for the phase.

### Phase 2 — repair

1. `POST /documents/:id/reseed`, `purge()` then the phase 1 path.
2. The blank-draft guard and `force`.

### Phase 3 — the error

1. `restore` and `putContent` translate the root mismatch into a `FolioError`
   naming `reseed`.
2. The admin surfaces it (`useVersions.ts` already renders the message).

### Phase 4 — the record

1. `ROADMAP.md`'s entry becomes a pointer to this spec's outcome.
2. `AGENTS.md` gains a symptom-table row: *"Editor is empty but the page renders" →
   the row was imported without its object.*

## Edge cases

- **A story with `publishedAt` set but `published_doc` null** (unpublished, which
  clears the doc and keeps the timestamp — check this against `unpublish`'s columns
  during phase 1) → falls back to blank, exactly as today.
- **A published document under an older `schemaId`** → seeded as stored. It is the
  same posture `getVersion` deliberately does *not* take (it migrates on read), and
  the difference is intentional: a draft is live content that the migration runner
  reaches on its next pass, while a version must stay byte-true.
- **`reseed` on a document whose object is healthy and whose draft matches
  published** → the guard sees a non-blank draft and refuses. Correct: the caller has
  the wrong document.
- **A record or singleton** (no path) → identical treatment; nothing here is routed.
- **Two cold opens at once** → decision 3.

## Testing requirements

**Unit (`test/unit/`):**
- The seed chooser as a pure function: published present → published, absent →
  blank, `publishedAt` null → blank with no read attempted.

**Workers (`test/workers/`, real workerd):**
- **The reproduction, which is the test that matters**: insert a `stories` row with
  `published_doc` and never touch its object, open the draft, assert it equals the
  published document *and shares its root uid*. Against today's code this fails.
- A restore succeeds on that document afterwards — the end-to-end proof that the
  closed path is open.
- The warm path makes no `published_doc` read (a binding spy, the shape
  `draft-mode.test.ts` established).
- `reseed` refuses a non-blank draft and accepts with `force`.
- `POST /documents` still seeds blank.

**End to end (`scripts/`):**
- Not needed. The condition is a database state rather than a request sequence, and
  a workers test can create it exactly.

## Dependencies

- None. No other spec touches the seed path.
- Sequenced independently of 23; it changes no list route.

## Out of scope

- **Recovering the pre-break draft.** It never crossed the wire. Checkpoint 1.
- **Copying Durable Object state between environments.** There is no API for it, and
  seeding from published makes it unnecessary for this case.
- **A deterministic root uid derived from the story id**, which would make the
  mismatch impossible. It would also make every imported document's root collide with
  a locally-created one of the same id, and it changes `blankSubtree` for every
  caller to fix a case decision 1 already fixes.

## Open questions

- Whether `unpublish` clears `published_doc` or only the timestamps decides the first
  edge case above. Answered by reading `0001_init.sql` and `unpublish` during phase 1;
  it changes a fallback, not a design.
