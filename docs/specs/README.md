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

Specs written once 1–16 were done, from `ROADMAP.md` rather than from the original
wants. Numbered in the same sequence because the dependency graph is the same one.

| # | Spec | Group | Size | Wire | Migration | From |
| --- | --- | --- | --- | --- | --- | --- |
| 17 | [Caching and purge](platform/caching.md) | platform | M | — | — | roadmap: uncovered |
| 18 | [Pagination, everywhere](foundation/pagination.md) | foundation | L | — | `0001_init` | roadmap: next 1 + 1a |

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
`migrations_dir` at it). `0001` and `0002` exist. Numbers below are assigned in build
order and must be renumbered together if that order changes.

| Migration | Spec | Contents |
| --- | --- | --- |
| `0003_unpublish.sql` | unpublish | `stories.unpublished_at`, `unpublished_by` |
| `0004_redirects.sql` | redirects | `redirects` table |
| `0005_draft_watermark.sql` | unpublished-changes | `stories.draft_sync_id`, `draft_updated_at`, `published_sync_id` |
| `0006_document_types.sql` | document-types | `stories.type`; `path` becomes nullable (**table rebuild**); partial unique indexes |
| `0007_identity.sql` | identity-and-access | `users`, `sessions`, `login_challenges`, `api_tokens` |
| `0008_schema_migrations.sql` | schema-migrations | `schema_migrations` ledger; `stories.schema_id`, `versions.schema_id` |
| `0009_locales.sql` | localisation | `stories.title_i18n` |
| `0010_content_index.sql` | collections | `content_index`, `content_refs` |

**`0006` is the one to be careful with.** It rebuilds `stories` to make `path`
nullable, so it must carry every column added before it — `0003`'s two and `0005`'s
three — or the rebuild silently drops them. Columns added *after* it are ordinary
`alter table` statements. That is the whole reason the two `stories`-touching quick
wins are numbered ahead of it.

Six specs need no migration at all: conditional fields, defaults and presets,
duplicate and paste and lifecycle hooks are code-only; globals and data documents build
on `0006`'s `type` column; the content API builds on `0007`'s `api_tokens`.

## Status

Each spec carries its own `> **Status:**` stamp. All sixteen specs in the quick-wins and
main-line tables are **done**, restamped in place with an `## Implementation notes`
section recording what actually landed. Spec 17 (caching) is **ready**: written and
argued, not yet implemented. A spec that gets built is restamped the same way, the way
`../../PARITY.md` records what landed.
