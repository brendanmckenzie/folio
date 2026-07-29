# Feature: [Feature name]

> **Group:** [foundation | content model | editing | platform]
> **Build order:** [n, per docs/specs/README.md]
> **Size:** [S ≈ a day | M ≈ a few days | L ≈ a week or two]
> **Status:** [draft | ready | in-progress | review | done]
> **Wire version:** [none | bumps PROTOCOL_VERSION to n]
> **Migration:** [none | 000n_name.sql]
> **Last updated:** [date]

## Summary

[Two or three sentences: what this adds, and what is wrong or absent today that
makes it necessary. Name the file that proves the gap.]

## Ground truth

[Verified facts about the code as it stands, with paths and — where they are
load-bearing — line numbers. This section exists so implementation does not
re-discover the codebase, and so a reviewer can check the premises rather than
the conclusions. Group by area: core / server / admin / preview / tests.]

**core (`packages/folio/src/core/`):**
-

**server (`packages/folio/src/server/`):**
-

**admin (`packages/folio/src/admin/`):**
-

**tests:**
-

## Owner decision checkpoints

[Product or design decisions embedded in this plan, each with a recommendation.
Confirm or override before implementation. Omit the section if there are none.]

1.

## User stories

### [Story title]
**As** [role] **I want to** [action] **so that** [benefit].

## Architecture decisions

### 1. [Decision, stated as the conclusion]

[Why this and not the obvious alternative. Name the alternative and the reason it
loses. A decision with no rejected alternative is not a decision, it is a
description.]

## Wire & schema changes

### D1 migration `000n_name.sql`

```sql
```

### Core types

[Additive changes to `Doc`, `Blok`, `Field`, `Mutation`, `Resolution`, the
protocol. State whether each is backward compatible with documents and logs
already written.]

### New or changed routes

[Method, path, auth, request shape, response shape, error codes.]

## Acceptance criteria

### [Criterion group]

```
GIVEN [precondition]
WHEN [action]
THEN [observable outcome]
AND [observable outcome]
```

## Implementation plan

[Phased so each phase is committable and leaves the tree green. Name the files
that change. Deploy order matters where the wire or the schema moves.]

### Phase 1 — [name]

1.

## Edge cases

- **[Case]** → [expected behaviour, and why that is the right answer].

## Testing requirements

**Unit (`packages/folio/test/unit/`):**
-

**Workers (`packages/folio/test/workers/`, real workerd):**
-

**End to end (`scripts/*.mjs` against a live dev server on port 5199):**
-

## Dependencies

- [Other specs this needs, and what for.]
- [Cloudflare resources, bindings, or host config changes.]

## Out of scope

- [Named exclusions, each with the reason it is excluded rather than forgotten.]

## Open questions

- [Unresolved decisions. Empty is the goal.]
