# Feature: Conditional fields — a form that only shows what applies

> **Group:** editing
> **Build order:** 4
> **Size:** S
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-07-29

## Summary

The inspector draws every field a block declares, always. A `hero` with a `layout`
select and four fields that only apply when `layout === 'split'` shows all five to
everyone, all the time, and the editor has to know which ones matter. At the 87-block
scale `PARITY.md` describes, that is the difference between a form and a
questionnaire.

Payload has `admin.condition`, Sanity has `hidden`, Strapi added conditional fields
in v5. In Folio it is the cheapest real authoring win available: field metadata, one
pure predicate in core, and one filter in `Inspector.tsx`. No storage, no protocol, no
migration, and the renderer is untouched.

The one architectural constraint — and it decides the whole design — is that
conditions cannot be functions. The admin ships prebuilt and learns a project's
schema over HTTP, so anything in `fields` has to survive `JSON.stringify`.

## Ground truth

**core (`packages/folio/src/core/`):**
- `toSchemaIndex(registry)` (`block.ts`) copies `{ name, label, summary, fields }`
  and drops `render`. `toManifest` returns that, and `app.ts` answers
  `GET /folio/schema` with `c.json(rt.manifest)`. The manifest's own comment says it
  *"Contains no functions, so it is cacheable."*
  **So a `showIf` predicate function would be silently dropped by JSON serialisation
  and the field would simply always show.** This is not a preference; it is the
  reason for decision 1.
- `Field` is a discriminated union with a shared `Common` interface (`label`, `help`,
  `required`), which is exactly where a shared `showIf` belongs.
- `defaultValue(field)` and `blankBlok(schema, type, …)` fill every non-`blocks`
  field at insert time, including ones that start hidden. A hidden field therefore
  has a value from birth, which is why decision 3 is about what happens to it rather
  than whether it exists.

**admin (`packages/folio/src/admin/Inspector.tsx`):**
- Line 44: `const entries = Object.entries(def.fields).filter(([, f]) => f.kind !== 'blocks')`
  — the flat list, in declaration order. One more `.filter` is the entire UI change.
- Lines 66–76: one `<fieldset disabled={readOnly}>` mapping `entries` to `FieldInput`
  with `key={`${blok.uid}:${name}`}`.
- `FieldInput` receives `value={blok.data[name] ?? null}` and **not** the rest of the
  blok's data, so evaluating a condition needs `blok.data` passed one level further
  down (or the filter done in the parent, which is what decision 2 does).
- `blocks`-kind fields never reach the inspector at all — they are rendered as tree
  slots by `BlockTree.tsx`'s `slotsOf`. That is why conditional *slots* are out of
  scope.

**preview (`packages/folio/src/preview/Render.tsx`):**
- `RenderBlok` iterates `def.fields` and resolves `blok.data[name]` with no knowledge
  of anything in `Common`. A hidden field's value renders exactly as a visible one's
  does, and decision 3 keeps it that way deliberately.

## Owner decision checkpoints

1. **Conditions are declarative data, never functions (forced).** See the manifest
   constraint above. A small expression object, evaluated by a pure function in core.
2. **Sibling fields only — the same blok's data (recommended).** A condition cannot
   read a parent block's field or another document. The alternative makes a block's
   form depend on where it sits, so moving a block changes its form, and evaluating a
   condition needs the whole document rather than one blok.
3. **Hiding a field hides the input, not the value (recommended).** The value persists
   and still renders. The alternatives are worse: clearing on hide loses work the
   moment someone toggles a select twice, and teaching the *renderer* to skip hidden
   fields makes page output depend on form metadata, which is a surprising action at a
   distance. Payload draws the same line by putting `condition` under `admin`. Cost: a
   block author who wants conditional output writes the condition in `render` too.
4. **`hidden: true` ships in the same change (recommended).** It is `showIf: false`
   and it covers legacy fields kept for compatibility after a schema migration. One
   extra line, and the alternative is people writing `showIf: { field: 'x', eq:
   '__never__' }`.

## User stories

### Block author writes one block instead of three
**As** a block author **I want** a `hero` whose split-layout fields only appear when
split is chosen **so that** I do not ship `heroSplit`, `heroFull` and `heroVideo` just
to keep the forms honest.

### Editor sees a form they can answer
**As** an editor **I want** the inspector to show only the fields that apply to my
choices **so that** I am not guessing which of eleven fields this layout reads.

### Block author retires a field safely
**As** a block author **I want** to mark a superseded field hidden **so that** it stops
confusing editors while its stored values stay intact until I write the migration.

## Architecture decisions

### 1. A small declarative condition, evaluated by one pure function

```ts
export type FieldCondition =
  | { field: string; eq: Json }
  | { field: string; ne: Json }
  | { field: string; in: readonly Json[] }
  | { field: string; isSet: boolean }
  | { all: readonly FieldCondition[] }
  | { any: readonly FieldCondition[] }
  | { not: FieldCondition }
```

```ts
// core/conditions.ts
export function matches(condition: FieldCondition, data: Record<string, Json>): boolean
```

Usage:

```ts
fields: {
  layout:   select({ options: [{ label: 'Full', value: 'full' }, { label: 'Split', value: 'split' }] }),
  image:    asset({ showIf: { field: 'layout', eq: 'split' } }),
  imageAlt: text({ showIf: { all: [{ field: 'layout', eq: 'split' }, { field: 'image', isSet: true }] } }),
  legacyId: text({ hidden: true }),
}
```

Deliberately small. `eq`/`ne`/`in`/`isSet` plus three combinators covers every case in
the reference project's 87 schemas that motivated this, and each one is a line of
`deepEqual` or a truthiness test — `deepEqual` already exists in `core/diff.ts` and is
already property-tested, so `eq` against an object or array value is free and correct.

`isSet` is defined precisely because "empty" is ambiguous across kinds: `false` for
`null`, `undefined`, `''` and `[]`; `true` for everything else including `0` and
`false`. A `boolean` field's condition should be written `{ eq: true }`, and the
docs say so.

`matches` is exported from `folio/core` so a block author can reuse the identical
condition in `render` rather than restating it in JavaScript and letting the two drift
— which is the cost decision 3 accepts, made as small as it can be.

### 2. The filter happens once, in the parent

`Inspector.tsx` line 44 becomes:

```ts
const entries = Object.entries(def.fields).filter(
  ([, f]) => f.kind !== 'blocks' && !f.hidden && (!f.showIf || matches(f.showIf, blok.data)),
)
```

`FieldInput` keeps its current props and learns nothing. Because the inspector
re-renders on every store change (it is driven by `useStoreState`), a field appears or
disappears the moment its controlling value changes, with no effect, no subscription
and no local state.

React keys are already `${blok.uid}:${name}`, so a field appearing does not remount
its neighbours and an in-flight upload in a sibling field is unaffected — worth
checking in a test, because the alternative (index keys) is the bug
`MultiAssetInput` already has and `ROADMAP.md` already records.

### 3. Interactions to get right now, not later

- **`summary`** (`core/schema.ts`) may name a hidden or conditionally-hidden field, and
  the block tree would then label a block with something the editor cannot see. Left
  as-is: the label is still the truth about the data. Flagged by the audit rather than
  refused, because refusing it would mean `defineBlock` failing over a display
  choice.
- **`required`** is currently declared and ignored (`PARITY.md` Phase 5).
  When validation lands it must evaluate `required` **only for visible fields**, or a
  hidden field will block publishing with an error the editor cannot act on. Written
  here because that spec will otherwise discover it the hard way.
- **Localisation** (`../content-model/localisation.md`): conditions evaluate against
  the **source locale's** `data`, never against `i18n[locale]`. A field must be
  visible in every locale or none — a translator seeing a different form from the
  author is a support call nobody can diagnose. `matches` therefore keeps taking
  `Record<string, Json>` and the caller passes `blok.data`.
- **Version preview / read-only mode**: the fieldset is already `disabled`, and the
  filter runs on the previewed document's data, so an old version shows the fields
  that version's values imply. Correct and free.

## Wire & schema changes

None. No D1 change, no protocol change, no change to any stored document.

`Field`'s shared `Common` gains two optional keys:

```ts
interface Common {
  label?: string
  help?: string
  required?: boolean
  /** Admin-only. Hides the input when it does not match; the value is untouched. */
  showIf?: FieldCondition
  /** Admin-only. Never draw this input. */
  hidden?: boolean
}
```

Additive on a JSON-serialisable type, so `GET /folio/schema` carries it with no
version and an older admin bundle simply ignores it.

## Acceptance criteria

### A field appears and disappears with its controller
```
GIVEN a hero whose image field has showIf { field: 'layout', eq: 'split' }
WHEN the editor selects layout 'full'
THEN the image field is not drawn
AND WHEN they select 'split'
    THEN it is drawn, showing the value it already had
```

### Hiding does not touch data
```
GIVEN an image value set while layout was 'split'
WHEN layout is changed to 'full' and back to 'split'
THEN the image value is unchanged throughout
AND no mutation was sent by the visibility change itself
AND the published page renders whatever the block's own render decided to do
```

### Combinators
```
GIVEN showIf { all: [{ field: 'layout', eq: 'split' }, { field: 'image', isSet: true }] }
THEN the field shows only when layout is split AND image is set
AND { any: [...] }, { not: ... }, { in: [...] } and { ne: ... } behave as stated
AND eq against an object value compares deeply
```

### isSet semantics
```
GIVEN isSet: true
THEN null, undefined, '' and [] are not set
AND 0 and false ARE set
```

### hidden
```
GIVEN a field with hidden: true
THEN it is never drawn, whatever its value or any condition
AND its stored value is untouched, so a later migration can still read it
```

### A condition naming an unknown field
```
GIVEN showIf { field: 'nope', eq: 'x' } on a block whose data has no 'nope'
THEN the condition evaluates false (the field is hidden) rather than throwing
AND /folio/audit reports the unknown field name so it is findable
```

### The root block
```
GIVEN a page root with noindex and a conditional 'canonicalUrl' field
WHEN Page settings is selected
THEN the same filtering applies in the Address panel's inspector
```

### Sibling inputs are not remounted
```
GIVEN an upload in flight in field A and a condition that reveals field B
WHEN B appears
THEN A's upload completes and writes to the correct block and field
```

### The manifest stays JSON
```
GIVEN a schema using showIf
WHEN GET /folio/schema is fetched
THEN the condition is present in the JSON, structurally identical to what was declared
```

## Implementation plan

### Phase 1 — core

1. `core/conditions.ts`: `FieldCondition`, `matches`, reusing `deepEqual` from
   `core/diff.ts`. Total over unknown shapes: an unrecognised condition object
   evaluates `false` and is reported, never thrown, because a schema can be newer than
   the admin bundle reading it.
2. `core/fields.ts`: `showIf` and `hidden` on `Common`.
3. `core/index.ts`: export `matches` and `FieldCondition` from `folio/core`, so a block
   author can reuse a condition in `render`.
4. Tests: `test/unit/core/conditions.test.ts` — every operator, every combinator,
   deep equality, `isSet`'s full matrix, unknown field, unknown operator, nesting.

### Phase 2 — admin

1. `Inspector.tsx`: the filter at line 44.
2. `admin.css`: nothing — a field that is not rendered needs no styling. (Resisting
   the temptation to grey it out instead: a form with eleven greyed fields is the
   problem, not the solution.)
3. Tests: `test/unit/admin/` — visibility toggling, no mutation on toggle, sibling
   input identity across a reveal.

### Phase 3 — docs

1. `README.md`: a short subsection under the block definition example, with the
   `matches` re-use pattern for `render` spelled out.
2. `PARITY.md`: note it against Phase 5's editor-scale items.
3. `docs/specs/foundation/schema-migrations.md`'s audit: add unknown-`showIf`-field and
   `summary`-names-hidden-field to the drift report.

## Edge cases

- **A condition on a `blocks` field** → refused by the types (`blocks` is excluded from
  the inspector anyway). Conditional slots are out of scope; see below.
- **Circular conditions** (A shows if B is set, B shows if A is set) → both stay
  hidden, which is stable and requires no cycle detection: `matches` reads *data*, not
  other conditions.
- **A condition whose controller is itself hidden** → allowed. The controller's value
  still exists, so the dependent field can be visible while its controller is not.
  Odd, occasionally deliberate (a `hidden` legacy flag driving visibility during a
  migration), and not worth forbidding.
- **A hidden field that is `required`** → today nothing enforces `required`, so nothing
  happens. Recorded in decision 3 as a constraint on the validation work.
- **An importer or API write setting a hidden field** → allowed and rendered. Same
  posture as `localisation.md` takes for a translated value in a non-translatable
  field: the editor constrains, the renderer honours, the audit reports.
- **A host on an older admin bundle** → `showIf` is ignored and every field shows,
  which is exactly today's behaviour. No version needed.

## Testing requirements

**Unit:** `matches` exhaustively (it is a pure function with a small surface, so this
should be near-total); the inspector's filter and remount behaviour.

**Workers:** one assertion that the manifest round-trips a condition through
`GET /folio/schema` unchanged — cheap, and it is the guard against someone
"simplifying" `showIf` into a function later.

**End to end:** none needed. Nothing crosses the network, nothing is stored, and the
unit tests cover the behaviour. Adding a browser test here would be ceremony.

## Dependencies

None. Core plus one admin file.

## Out of scope

- **Conditional `blocks` slots** (hide a whole slot). Hiding a slot hides *content*,
  not a form control — an editor would lose sight of blocks that still render on the
  page. If a layout genuinely has no room for a slot, the block should render nothing
  for it, which it can already decide.
- **Conditions across bloks or documents** (checkpoint 2).
- **`readOnly` fields.** A separate want with a separate question (who may edit it?),
  which belongs with roles in `../foundation/identity-and-access.md`.
- **Field groups, tabs and collapsible sections.** The other half of the same problem
  and genuinely separate work: `showIf` reduces the number of fields, grouping
  organises the ones that remain. Worth doing next, and sized with the block-picker
  item already on `ROADMAP.md`.
- **Renderer-side condition evaluation** (checkpoint 3).

## Implementation notes

Landed exactly as designed, in the three phases above. All four owner decision
checkpoints were built as recommended/forced; there was no Open questions section
to resolve.

**Ground truth was accurate**, with one filename correction: `summarise`,
`blankBlok` and `slotsOf` (and `BlockSchema`/`Manifest`/`SchemaIndex`) live in
`core/schema.ts`, not `core/block.ts` as the Ground truth section says — `block.ts`
holds `defineBlock`, `toRegistry`, `toSchemaIndex` and `toManifest`, and imports
`BlockSchema`/`Manifest`/`SchemaIndex` from `schema.ts`. Everything the spec says
about their behaviour (the manifest drops `render`, `toManifest`'s own "contains no
functions" comment, `defaultValue`/`blankBlok` filling hidden fields at insert time)
was correct; only the file split was stale. `Inspector.tsx`'s line 44 and
`FieldInput`'s props matched the spec exactly.

**What shipped:**
- `core/conditions.ts` — `FieldCondition` (the seven-shape union exactly as
  specified) and `matches`, reusing `deepEqual` from `core/diff.ts`. Total over
  unknown shapes: an unrecognised operator or an unknown field name evaluates
  `false`, never throws.
- `core/fields.ts` — `Common` gained `showIf?: FieldCondition` and
  `hidden?: boolean`, both optional and additive.
- `core/index.ts` — exports `matches` and `FieldCondition` from `folio/core`.
- `admin/Inspector.tsx` — the line-44 filter became `visibleEntries(fields, data)`,
  an exported pure function (not inlined), specifically so it is unit-testable
  without mounting React — this codebase's existing convention for admin components
  (`badgeLabel`, `publishStatus`, `deleteConfirmation` are all tested the same way,
  and there is no `@testing-library/react` dependency or jsdom environment in the
  `unit` vitest project to mount a component in the first place).
- Docs: a "Conditional fields" subsection in `README.md` under the block-definition
  example, and a done-item note in `PARITY.md`'s Phase 5 recording the
  `required`-must-skip-hidden-fields interaction for whoever builds validation next.

**Deliberately deferred:** the plan's Phase 3 item 3 ("`schema-migrations.md`'s
audit: add unknown-`showIf`-field and `summary`-names-hidden-field to the drift
report") was **not done**. `schema-migrations.md` is another spec's file, still
`draft`, and this run's brief reserves cross-spec bookkeeping for the orchestrator —
editing another spec's document was explicitly out of bounds for this pass. The
two checks are still correctly motivated and worth adding when that spec is
implemented; noting it here so it is not lost.

**Test counts:** 685 → 716 (26 → 29 files). 20 unit tests in
`test/unit/core/conditions.test.ts` (every operator, the full `isSet` matrix,
nesting, deep equality, unknown field/shape). 10 in the new
`test/unit/admin/inspector.test.ts` (visibility toggling in both directions,
`hidden` overriding any condition, `blocks`-kind exclusion, declaration-order/key
stability across a reveal, purity — no mutation from the filter itself). 1 workers
test in `test/workers/schema.test.ts` confirming a schema using `showIf`/`hidden`
round-trips through `GET /folio/schema` structurally unchanged.

No e2e script was written — the spec's own Testing requirements section says none
is needed, since nothing here crosses the network or touches storage.
