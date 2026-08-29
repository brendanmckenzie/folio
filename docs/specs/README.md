# Specs

One spec per feature, each written so it can be implemented from without
re-discovering the codebase first. Origins: the raw wants in `docs/feedback.md`, one
prerequisite (`foundation/document-types.md`) that three of them silently assumed, one
companion (`foundation/identity-and-access.md`) that two of them are blocked on, and
six quick wins from a scan of Payload, Strapi, Contentful, EmDash, Storyblok and Sanity.

Format is `_TEMPLATE.md`. The load-bearing sections are **Ground truth** (verified
facts about the code, so a plan is not built on a guess) and **Architecture
decisions** (each naming the alternative it beat).

These are *product* phases. They are not the phases in `PARITY.md`, which is a
parity plan for one specific site and overlaps this set in several places, noted per
spec.

## Quick wins (1–7)

Cheap, independently valuable, and none of them blocked on anything. Two carry a
migration and therefore have to precede `document-types`, which rebuilds `stories`;
the rest can land in any order.

| # | Spec | Group | Size | Wire | Migration | From |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [Unpublish](editing/unpublish.md) | editing | S | — | `0003` | competitor scan |
| 2 | [Redirects](platform/redirects.md) | platform | S | — | `0004` | competitor scan |
| 3 | [Unpublished changes](editing/unpublished-changes.md) | editing | S | — | `0005` | feedback #2 |
| 4 | [Conditional fields](editing/conditional-fields.md) | editing | S | — | — | competitor scan |
| 5 | [Defaults and presets](editing/field-defaults-and-presets.md) | editing | S | — | — | competitor scan |
| 6 | [Duplicate and paste](editing/duplicate-and-paste.md) | editing | S–M | — | — | competitor scan |
| 7 | [Lifecycle hooks](platform/publish-hooks.md) | platform | S | — | — | competitor scan |

## The main line (8–16)

| # | Spec | Group | Size | Wire | Migration | From |
| --- | --- | --- | --- | --- | --- | --- |
| 8 | [Document types](foundation/document-types.md) | foundation | M | — | `0006` | prerequisite |
| 9 | [Globals](content-model/globals.md) | content model | S | — | — | feedback #5 |
| 10 | [Identity and access](foundation/identity-and-access.md) | foundation | L | — | `0007` | companion |
| 11 | [Schema migrations](foundation/schema-migrations.md) | foundation | M | v2 | `0008` | feedback #3 |
| 12 | [Localisation](content-model/localisation.md) | content model | L | v3 | `0009` | feedback #1 |
| 13 | [Collections and query](content-model/collections.md) | content model | L | — | `0010` | feedback #4 |
| 14 | [Data documents](content-model/data-documents.md) | content model | M | — | — | feedback #6 |
| 15 | [Content API](platform/content-api.md) | platform | M | — | — | feedback #7 |
| 16 | [Live collaboration](editing/live-collaboration.md) | editing | M | v4 | — | feedback #8 |

## After the main line (17–)

Specs written once 1–16 were done, from `ROADMAP.md` and then from
`../completion-plan.md` rather than from the original wants. Numbered in the same
sequence because the dependency graph is the same one.

| # | Spec | Group | Size | Wire | Migration | From |
| --- | --- | --- | --- | --- | --- | --- |
| 17 | [Caching and purge](platform/caching.md) | platform | M | — | — | roadmap: uncovered |
| 18 | [Pagination, everywhere](foundation/pagination.md) | foundation | L | — | `0001_init` | roadmap: next 1 + 1a |
| 19 | [Scheduled publishing](platform/scheduled-publishing.md) | platform | M | — | `0003` | completion plan: gap 1 |
| 20 | [Bulk write endpoints](platform/bulk-writes.md) | platform | M | — | — | completion plan: gap 2 |
| 21 | [Draft preview sharing](platform/draft-sharing.md) | platform | M | — | `0004` | completion plan: gap 4 |
| 22 | [Build artifacts and `.d.ts`](foundation/package-build.md) | foundation | S | — | — | completion plan: gap 5 |
| 23 | [Many sites in one deployment](foundation/multi-site.md) | foundation | XL | 5 | `0005` | owner, 2026-08-01 |
| 24 | [An MCP server](platform/mcp-server.md) | platform | M–L | — | — | feedback: ai-friendliness |
| 25 | [Draft mode](platform/draft-mode.md) | platform | M | — | — | roadmap, twice: host-layout draft + cookie draft mode |
| 26 | [Documentation that ships](foundation/documentation.md) | foundation | M | — | — | owner, 2026-08-29 |

Spec 26 is **done**, and its own `## Implementation notes` records that it shipped a
different answer from the one it planned: the package moved to the repository root and
the subtree split was deleted, rather than the docs moving inside the split prefix.

Sizing matches `PARITY.md`: **S** ≈ a day, **M** ≈ a few days, **L** ≈ a week
or two. Relative weight, not a quote.

## Why this order

```
1  unpublish ─────────── a missing primitive; publish has no pair
2  redirects ─────────── the rename footgun; updateStory already knows the paths
3  unpublished-changes ─ the diff and restore paths already exist, aimed elsewhere
4  conditional-fields ┐
5  defaults+presets   ├─ pure Field metadata + inspector; no storage, no wire
6  duplicate+paste    ┘  (5 and 6 share allocateSubtree)
7  hooks ────────────── unblocks host-side caching, indexing, notifications

8  document-types ──┬── 9  globals
                    ├── 13 collections ──┬── 14 data-documents
                    │                    └── 15 content-api
                    └── 12 localisation ─┘

10 identity-and-access ──┬── 15 content-api
                         └── 16 live-collaboration

11 schema-migrations ──── everything after it churns block schemas

17 caching ───────────── needs 7's seam, 9's globals and 13's collections to
                         know what a rendered page actually depends on

19 scheduled publishing ─ needed 1's unpublish() and 7's alarmHookCtx before it
                         could be a cron rather than a request

20 bulk writes ───────── 18's StoryFilter is what a selection captures, and 18's
                         opt-in count is what guards it

21 draft sharing ─────── 10 built the credential discipline it reuses and the actor
                         model it deliberately stays outside of
```

- **1–2 first** because both are near-bug-fixes, and because both add `stories`
  columns that `0006`'s table rebuild has to carry forward. Doing them after
  `document-types` would work (an `alter table` is trivial) but means rewriting that
  migration.
- **3** because the diff, the read-only preview and the restore-as-a-transaction path
  it needs all exist already, pointed at versions instead of at the published document.
  It also wants `unpublish` to exist first so the tree's state machine is designed once
  with "not live" in it.
- **4–6** are the authoring-quality tier: field metadata and one filter in
  `Inspector.tsx`, plus a clone primitive. No storage, no protocol, no migration.
- **7** before the caching and search work anyone will want next, because it is the
  seam all of it hangs off.
- **8** before collections, data documents and globals, which are all "a document that
  is not a page", and `createFolio` currently takes exactly one root block type
  (`src/server/types.ts:44`).
- **10** before anything programmatic or collaborative. It is also the standing biggest
  gap in `ROADMAP.md`, and the seams are already cut (validated inputs, one error
  envelope, versioned wire, `publish()` with no `Request` dependency).
- **11** before the content model churns further: every spec after it changes what a
  stored document looks like, and nothing today can move stored documents from one
  schema to the next. It also builds `StoryDO.commit`, which **15** needs.
- **16** last: the only item whose value is entirely additive, and it wants verified
  identity underneath it.
- **17** could not have been written before **9** and **13** landed. Its central
  decision is that a page's cache tags are computed from what a render loaded, and
  globals and collections are the two things that make that set larger than "this
  page" — neither existed to be discovered when **7** predicted this work.
- **19** is the first of `../completion-plan.md`'s delivery gaps rather than a spec from
  the original set, and two earlier specs are what made it small. **1** wrote
  `unpublish()` against D1 alone so a scheduled unpublish could reach it, and **7**
  built `alarmHookCtx` so a caller with no `ExecutionContext` fires the same
  after-commit hooks — which is what lets a cron-driven publish purge the cache and
  broadcast to open editors without restating either.
- **20** could only be written after **18**, and the dependency is exact rather than
  thematic: a select-all captures `StoryFilter` and is guarded by the *same*
  `count(*)` the list header opts into, so **18** had to settle both shapes first.
  Building it is also what proved decision 5's warning about drift — the guard could
  not reproduce the header's number until the routed/unrouted axis moved onto the
  filter, because a list route states that scope positionally and a captured filter
  has no positions.
- **21** needed **10** twice over, and in opposite directions. It *reuses* the
  credential discipline — `auth/secrets.ts` is the only place a bearer secret is minted
  or hashed, so a share link cost no new crypto and no new secret to configure — and it
  deliberately stays *outside* the `Actor` model that file's spec built: a
  `ShareGrant` has no role and no scopes, so `allows()` cannot be called with one and
  no route gate in the server can be satisfied by it. It also needed **9**, for the
  opposite reason again: `?as=<global>` renders a singleton's draft in a page's
  context, which is the one thing a per-document grant had to be taught to refuse.
- **22** is last because it is the only one that is not a feature: it is the same
  library, packaged. It depends on nothing and nothing depends on it, which is exactly
  why it kept getting deferred. It is also the only spec whose central decision is
  about what *stays* source — `folio/preview` and `folio/admin-entry` are entry points
  of the host's bundle, not modules a host imports, and the 82KB `folio-admin.css`
  that `pnpm build` produces is the reason.
- **24** could not have been written before **15**, and what it mostly does is *notice*
  how much of itself already exists. Every write already goes through the mutation log,
  so an agent's edit is live, attributed and undoable without a line of new sync code;
  `api_tokens` already models a caller that is not a person; and `?_folio=preview`
  already renders a draft to a bearer token, which is the one item `docs/feedback.md`
  predicted the content API would not reach. So it is an endpoint plus the three verbs
  v1 was missing — unpublish, duplicate, restore — and its central decision is that a
  tool *is* a v1 route rather than a second path to the same service, which is what
  makes the missing three a precondition rather than a nice-to-have. The exception is
  preview, where the bar is not "read the content back" but *see whether the page looks
  right* — so it needs an image, and photographing the only draft render there is would
  photograph the editor's DOM rather than the page's. That is also why **24 changes 21's
  behaviour**: a share link points at the editing render today, so a client reviewing a
  draft gets hover outlines and dead links, and the chrome-free mode 24 adds is the fix.

## Wire version ledger

`PROTOCOL_VERSION` (`src/core/protocol.ts:10`) is carried by every socket frame and
every admin↔preview postMessage frame, and a mismatch is refused rather than guessed
at (`src/server/story-do.ts`, close code 4001).

| Version | Lands with | Change |
| --- | --- | --- |
| 1 | — | today |
| 2 | schema-migrations | `Mutation` gains `retype` |
| 3 | localisation | `set` gains an optional `locale`; `hello` sheds the identity fields auth has already made advisory |
| 4 | live-collaboration | `presence` carries a field, and a second space-level channel appears |

Nothing in the quick-wins tier touches either wire. Globals changes the preview
*bootstrap* (`window.__FOLIO__`) rather than the postMessage protocol, and
identity-and-access makes `hello`'s identity fields advisory without changing their
shape. Neither needs a version.

**Bumping is cheap and the specs lean on that.** Both ends of both wires ship in the
same deploy, so a version is a guard against a stale tab, not a compatibility
mechanism. The thing that must stay readable across versions is the **mutation log**,
which outlives every deploy — so every change above is additive to a logged mutation,
and an old log entry replays under its old meaning (a `set` with no `locale` is a
source-locale write, forever).

## D1 migration ledger

`packages/folio/migrations/` is shared by every consuming project (the demo points
`migrations_dir` at it).

**`0001_init.sql` holds the whole schema**, and it replaced the ten below as spec 18's
phase 1 (`foundation/pagination.md` decision 10). They were sequenced only because they
were written in sequence; nothing is deployed and there is no remote, so the history
they recorded had no audience. Two have landed since:

| # | Spec | Contents |
| --- | --- | --- |
| `0002_asset_refs.sql` | (asset usage, port phase 4) | `content_refs.to_story` → `to_id`, plus a third `kind` value |
| `0003_schedules.sql` | scheduled publishing | `schedules` table, two partial indexes |
| `0004_shares.sql` | draft preview sharing | `shares` table, one unique index and one ordinary one |

`0002` was a plain rename and `0003` and `0004` plain `create table`s, which is what
every one after them is expected to be.

The table is kept as a **record of what each spec added**, since each spec's own
*Wire & schema changes* section still names its migration and those sections are
history rather than instructions:

| Was | Spec | Contents |
| --- | --- | --- |
| `0001_initial.sql` | — | `stories`, `versions`, `assets` |
| `0002_slug_unique.sql` | — | `stories_parent_slug` |
| `0003_unpublish.sql` | unpublish | `stories.unpublished_at`, `unpublished_by` |
| `0004_redirects.sql` | redirects | `redirects` table |
| `0005_draft_watermark.sql` | unpublished-changes | `stories.draft_sync_id`, `draft_updated_at`, `published_sync_id` |
| `0006_document_types.sql` | document-types | `stories.type`; `path` becomes nullable (**table rebuild**); partial unique indexes |
| `0007_identity.sql` | identity-and-access | `users`, `sessions`, `login_challenges`, `api_tokens` |
| `0008_schema_migrations.sql` | schema-migrations | `schema_migrations` ledger; `stories.schema_id`, `versions.schema_id` |
| `0009_locales.sql` | localisation | `stories.title_i18n` |
| `0010_content_index.sql` | collections | `content_index`, `content_refs` |

**The rule `0006` established still applies.** A rebuild of `stories` has to carry
every column forward explicitly, because a positional copy is how a rebuild loses one
silently. `0001_init.sql` has no copy step, so the hazard is not live today — but the
next spec that needs to drop a `not null` will meet it again.

The collapse also **dropped one index rather than carrying it forward**:
`stories_draft_updated` was never read by anything, and
`test/workers/migrations.test.ts` now asserts its absence. See
`foundation/pagination.md` decision 2a. That absence is a pattern now rather than a
one-off — `0002` records the same refusal for `assets.filename`/`size`, `0003` for
`schedules(story_id)` and `0004` for `shares(story_id)`, each asserted, so adding one of
them later is a deliberate act with a measurement behind it.

**Two rules about a CHECK constraint, both learned the expensive way.**
`versions.kind` carries one, and it is the whole reason an unpublish has no version row
to this day: SQLite cannot widen a CHECK without rebuilding the table.
`content_refs.kind` (`0002`) and `schedules.action`/`status` (`0003`) therefore carry
none, so a new enum value in any of the three costs no DDL at all. `0004` answers the
lesson a third way — by having no enum column: `shares`' `live`/`lapsed` vocabulary is
`revoked_at is null and expires_at > now`, computed in the `where` clause, so there is
nothing stored that could disagree with the clock.

Six specs needed no migration at all: conditional fields, defaults and presets,
duplicate and paste and lifecycle hooks are code-only; globals and data documents
build on the `type` column; the content API builds on `api_tokens`.

## Status

Each spec carries its own `> **Status:**` stamp. All sixteen specs in the quick-wins and
main-line tables are **done**, restamped in place with an `## Implementation notes`
section recording what actually landed. Spec 17 (caching) is **done** too, and so are
specs 19 (scheduled publishing), 20 (bulk writes), 21 (draft preview sharing), 22
(build artifacts) and 24 (an MCP server). **Spec 18 (pagination) is done too**, and this
paragraph said "in-progress: its phase 1, the schema collapse, has landed" until
2026-08-05 — the spec's own stamp has read *"done — every phase landed"* since its last
route went with `ui-architecture.md`'s port phase 3, so the index was a revision behind
its own entry. Specs 23 (multi-site) and 25 (draft mode) are **draft** and unstarted;
23's three open questions were resolved in place on 2026-08-04 without starting it, and
25 was written the same day. Spec 26 (documentation that ships) is **done**, written and built on 2026-08-29 after
the owner observed that building a host meant pointing an assistant at *this*
workspace — which was the only channel there was, because the split published no prose
at all. It shipped a structural answer rather than the editorial one it planned.
A spec that gets built is restamped the same way, the way `../../PARITY.md`
records what landed.

**Spec 24 amended spec 21 in place.** A share link now lands on `?_folio=draft` rather
than `?_folio=preview`, because there was only one draft render and it was the editing
one — so a client sent a draft to review got the editor's outlines and dead links. Spec
21's `## Implementation notes` records the change and why it counts as a fix rather than
an extension. Spec 24 built out of order, before 23: it needs nothing 23 touches, and it
reshapes no list route, so the ordering constraint below does not reach it.

Spec 23 is the first one whose ordering is a real constraint rather than a preference:
it rebuilds four unique indexes and scopes every list route, and spec 18 reshapes those
same routes. Landing them in the wrong order means resolving two sets of conflicts
across the ~265 literal paths pagination already touches.

**Spec 26 had no ordering constraint** and was taken first for that reason. It moved
the package to the repository root and deleted the subtree split, so every path in the
specs above that reads `packages/folio/src/...` is now `src/...`. Ground truth written
before 2026-08-29 carries the old prefix; the file it names is otherwise unchanged.
