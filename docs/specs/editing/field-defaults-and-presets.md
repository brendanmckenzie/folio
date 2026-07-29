# Feature: Defaults, presets and starting documents

> **Group:** editing
> **Build order:** 5
> **Size:** S
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-07-29

## Summary

A new block arrives empty. Every field is its kind's zero value — `''`, `0`, `false`,
the first select option — so an editor adding a `button` gets a blank label and an
editor adding a `hero` gets a blank everything. There is no way for a block author to
say "this starts as *Read more*", no way to offer "Hero — dark" as a variant, and no
way for a new page to start as anything other than a bare root block.

Payload has `defaultValue`, Sanity has `initialValue` and initial-value templates,
Strapi has default values, Storyblok has block presets. All four are the same idea at
three scales, and in Folio all three scales land in one function: `blankBlok` is the
only place a block is ever created.

## Ground truth

**core (`packages/folio/src/core/`):**
- `blankBlok(schema, type, parent, slot, order)` (`schema.ts`) is the **single**
  creation point. It loops `def.fields` and writes `defaultValue(field)` for every
  non-`blocks` kind. Its two callers are `useBlocks.add` (the editor's "+ Add block")
  and `createRuntime`'s `seed` (a document's root block on first touch).
- `defaultValue(field)` (`fields.ts`) is per *kind*, not per field: `0`, `false`,
  `options[0].value`, `[]` for `multiasset`, `null` for the object-valued kinds, `''`
  otherwise. There is nowhere for an author to put a value.
- `defaultValue` is **also** used at render time by `resolveValue` (`resolve.ts`) for
  a `number` whose stored value is absent. That dual use is what forces decision 3.
- `toSchemaIndex` copies `fields` into the manifest and `GET /folio/schema` answers it
  as JSON, so — exactly as with `showIf` in `conditional-fields.md` — anything an
  author declares here **must survive `JSON.stringify`**. No functions.
- `seed(title)` (`runtime.ts:77-81`) builds one root blok and writes `title` into it
  if the root block has that field. A document therefore cannot start with children.

**admin (`packages/folio/src/admin/`):**
- `useBlocks.add(parent, slot, type, index)` builds one blok and sends
  `store.tx([{ t: 'insert', blok }])`, then selects it.
- `BlockTree.tsx:143-169` — `AddMenu` renders `allow.map(type => <button>)` with the
  type's label. Flat, unsorted, no search. `ROADMAP.md` already records that this
  *"stops working somewhere around 15"* block types, so anything that adds entries to
  this menu has to face that.
- `core/diff.ts`'s insert ordering rule (parents before children, so a child never
  lands on a missing parent) is the rule a multi-blok insert has to follow.

## Owner decision checkpoints

1. **One mechanism at three scales (recommended):** a per-field `default`, a named
   `preset` (field values, optionally with children), and a document's starting
   content — which is just the root block's default preset. The alternative is three
   features with three vocabularies; this is one concept applied at three places, and
   the third falls out of the first two for free.
2. **Defaults apply at creation only, never at render (recommended).** Adding
   `default: 'Read more'` to a field must not change what already-published pages say.
   The retroactive case is a content migration, and
   `../foundation/schema-migrations.md` already ships `field.default(blok, name, value)`
   for exactly it. See decision 3 for why this needs stating rather than assuming.
3. **Presets are declarative data, not functions (forced).** Same manifest constraint
   as conditional fields.
4. **A block may declare itself preset-only (recommended).** A `card` that must always
   be one of three variants hides the bare version from the picker. Cheap, and the
   alternative is three near-identical block types.

## User stories

### Block author ships sensible starting values
**As** a block author **I want** a button to start as "Read more" and a hero to start
left-aligned **so that** a newly added block looks like something rather than like a
bug.

### Editor picks a variant, not a blank
**As** an editor **I want** "Hero — dark" and "Hero — with video" in the add menu
**so that** I get a configured block instead of assembling one from a blank every
time.

### Editor starts a page that is already shaped
**As** an editor creating an insight **I want** it to start with a hero and a body
**so that** every insight has the same bones without me copying an old one.

### Block author consolidates three blocks into one
**As** a block author **I want** presets instead of `heroDark`, `heroLight` and
`heroVideo` **so that** the schema stays small and a design change is one edit.

## Architecture decisions

### 1. `default` on the field, typed where it is cheap to type

```ts
fields: {
  label:  text({ default: 'Read more' }),
  align:  select({ options: ALIGNS, default: 'center' }),   // constrained to the option values
  gap:    number({ default: 24 }),
  boxed:  boolean({ default: true }),
  href:   multilink({ default: { kind: 'url', url: 'https://example.com' } }),
}
```

`select`'s builder already captures its options with `const T`, so `default` is typed
as `T[number]['value']` and a typo fails to compile. `text`, `number` and `boolean`
type theirs the obvious way. The object-valued kinds (`asset`, `multilink`,
`richtext`, `reference`) take their own value type — rarely used, occasionally exactly
what is wanted (a default external link, a default piece of boilerplate prose).

`blankBlok` becomes `data[name] = field.default ?? defaultValue(field)`. That is the
whole of it.

`blocks` fields cannot carry a `default` — children are not a value — and the type
says so. Their equivalent is a preset's `children` (decision 2).

### 2. A preset is a named bundle of field values, and may carry children

```ts
export const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  fields: { heading: text(), theme: select({ options: THEMES, default: 'light' }),
            actions: blocks({ allow: ['button'], max: 2 }) },
  presets: [
    { name: 'dark', label: 'Hero — dark', data: { theme: 'dark' } },
    {
      name: 'cta',
      label: 'Hero — with button',
      data: { theme: 'light' },
      children: [{ slot: 'actions', type: 'button', preset: 'primary' }],
    },
  ],
  render: …,
})
```

- `data` is a partial override, layered over the field defaults, which are layered over
  the kind defaults. Three layers, evaluated in that order, in one function.
- `children` are recursive: each names a `slot`, a `type`, and optionally another
  block's `preset`. Fractional orders are allocated in array order.
- A preset naming an unknown type, an unknown slot, a type the slot's `allow` forbids,
  or a field the block does not declare is a **construction-time throw**, not a
  runtime surprise. `createFolio` already validates its config before serving a
  request and this joins that check.

So `blankBlok` grows into:

```ts
export function blankSubtree(
  schema: SchemaIndex, type: string, parent: string | null, slot: string | null,
  order: string, preset?: string,
): Blok[]                     // parents before children, per diff.ts's insert rule
```

`blankBlok` stays as a one-blok wrapper so nothing that does not need children has to
change. The editor sends the array as one transaction —
`store.tx(bloks.map((blok) => ({ t: 'insert', blok })))` — so adding a preset with
three children is one undo step, one delta, one activity entry.

Uid allocation and the fractional-order walk are shared with
`duplicate-and-paste.md`, which needs exactly the same primitive for a copied subtree.
Whichever lands first builds `allocateSubtree(bloks, parent, slot, order)`; the other
uses it.

### 3. A document's starting content is the root block's default preset

```ts
export const insightRoot = defineBlock({
  name: 'insightRoot',
  fields: { title: text(), body: blocks({ allow: ['hero', 'prose', 'quote'] }) },
  presets: [{
    name: 'default',
    label: 'Insight',
    children: [{ slot: 'body', type: 'hero', preset: 'dark' }, { slot: 'body', type: 'prose' }],
  }],
  render: …,
})
```

`runtime.seed(title)` calls `blankSubtree(schema, config.root, …, 'default')` and
builds the whole document from it. A root block with no `default` preset behaves
exactly as today.

This is why the mechanism is worth unifying: **a starting document needs no new
concept and no new config key**, and when `../foundation/document-types.md` lands, a
per-type template is automatic — each type already names its own root block, so each
type already has its own `default` preset. No rework, no dependency, and this spec can
ship at position 5 rather than waiting for position 8.

### 4. Defaults are a creation-time concern, and the render path must not learn about them

`defaultValue(field)` is called from two places with two different meanings: from
`blankBlok`, meaning *"what does a new blok start with"*, and from `resolveValue`,
meaning *"what does a block author receive when the stored value is absent"*. Only the
first gains `field.default`.

If the second did too, adding `default: 'Read more'` would retroactively change every
existing document whose key happens to be absent — a schema edit silently changing
published pages, discovered weeks later. The retroactive case is a real want and it
has a real tool: `field.default(blok, 'label', 'Read more')` in a content migration,
which is explicit, recorded in the ledger, visible in the activity trail and
undoable.

Worth being blunt about in the code: the two call sites get a comment each, because
"just pass `field.default` through here too" is a five-second change that looks like
an improvement.

### 5. Presets group under their block in the picker, and do not make it worse

`AddMenu` currently lists one flat button per type. With presets it lists one group per
type: the block's label, then its presets indented beneath, with the bare block first
unless `presetsOnly` is set.

`ROADMAP.md` already flags the flat menu as breaking around 15 types, and presets
multiply entries — so this spec commits to the minimum that keeps it honest: stable
grouping, the type's label as a heading, and presets nested. Search, icons and
categories stay where they are, on the roadmap, as their own work. Naming the
interaction is the point; quietly tripling the menu's length is not acceptable.

## Wire & schema changes

None. No D1, no protocol, no change to any stored document. New blocks simply start
with different values.

### Core types

```ts
export interface BlockPreset {
  /** Unique within the block. 'default' is used for a document's starting content. */
  name: string
  label: string
  /** Partial field values, layered over field defaults. */
  data?: Record<string, Json>
  children?: readonly { slot: string; type: string; preset?: string }[]
}
```

`BlockSchema` gains `presets?: readonly BlockPreset[]` and `presetsOnly?: boolean`
(both serialisable, both reaching the admin through the manifest). `Common` gains
`default?: Json`, refined per kind by the builders.

`blankSubtree` and `allocateSubtree` in `core/schema.ts`, exported from
`folio/engine` (they allocate uids and orders, which is engine work) as well as being
used internally.

## Acceptance criteria

### Field defaults on creation
```
GIVEN button.label declared with default 'Read more'
WHEN an editor adds a button
THEN its label is 'Read more' in the document, the preview and the inspector
AND the value arrived as part of the insert mutation, not as a second write
```

### Existing documents are untouched
```
GIVEN a published page with a button whose label key is absent
WHEN default 'Read more' is added to the schema and deployed
THEN that page renders exactly as before
AND a content migration is the documented way to backfill it
```

### Layering
```
GIVEN a select with options [left, center] and default 'center', and a preset
      setting it to 'left'
WHEN the preset is used
THEN the value is 'left'
AND with no preset it is 'center'
AND with neither it is 'left' (the first option, as today)
```

### A preset with children lands as one transaction
```
GIVEN a hero preset 'cta' with one button child
WHEN an editor picks it
THEN one transaction inserts the hero and the button, parents first
AND Cmd+Z removes both in one step
AND the button sits in the hero's actions slot with a valid fractional order
AND the hero is selected afterwards, as an added block is today
```

### Nested presets
```
GIVEN the 'cta' preset's child names the button preset 'primary'
THEN the button is created with the primary preset's values layered over the
     button's own field defaults
```

### Starting documents
```
GIVEN a root block with a 'default' preset of hero + prose
WHEN a new story is created and first opened
THEN its document contains the root block, a hero and a prose block
AND a root block without that preset produces a bare root, exactly as today
```

### Invalid presets fail at construction
```
GIVEN a preset naming an unknown block type, an unknown slot, a type a slot's
      allow forbids, or a field the block does not declare
WHEN createFolio is called
THEN it throws, naming the block, the preset and the offending entry, before any
     request is served
```

### Preset-only blocks
```
GIVEN a card block with presetsOnly and three presets
WHEN the add menu opens
THEN the three presets are offered and the bare card is not
```

### The picker stays legible
```
GIVEN a slot allowing three types, one with two presets
WHEN the add menu opens
THEN entries are grouped by type in declaration order, presets nested under theirs
```

### The manifest stays JSON
```
GIVEN a schema with defaults and presets
WHEN GET /folio/schema is fetched
THEN both are present in the JSON, structurally identical to what was declared
```

## Implementation plan

### Phase 1 — core

1. `core/fields.ts`: `default` on `Common`, refined in the `text`/`number`/`boolean`/
   `select` builders; excluded from `blocks` by type.
2. `core/schema.ts`: `BlockPreset`, `presets`, `presetsOnly`; `allocateSubtree`;
   `blankSubtree`; `blankBlok` as a wrapper. Layering order in one place.
3. `core/schema.ts` (or `runtime`): `validatePresets(schema)` — the construction-time
   checks of decision 2.
4. Comment both `defaultValue` call sites per decision 4.
5. Tests: `test/unit/core/schema.test.ts` — layering, children, nesting, order
   allocation, uid uniqueness, every validation throw; a test asserting
   `resolveValue` does **not** consult `field.default` (the guard against decision 4
   being "simplified" away).

### Phase 2 — server and admin

1. `server/runtime.ts`: `seed` uses the root block's `default` preset.
2. `core/block.ts`: carry `presets`/`presetsOnly` into the schema index and manifest.
3. `admin/hooks/useBlocks.ts`: `add(parent, slot, type, index, preset?)` sending the
   whole subtree as one transaction; select the top blok.
4. `admin/BlockTree.tsx`: `AddMenu` grouped per decision 5; `addFirst` (the preview's
   own add button) uses the first allowed type's `default` preset if it has one.
5. Tests: `test/unit/admin/` for the menu's grouping and the one-transaction insert;
   `test/workers/` for a seeded document containing the template's blocks.

### Phase 3 — docs

1. `README.md`: `default` in the `defineBlock` example, and a short presets section.
2. `PARITY.md`: presets are the honest answer to a chunk of the 87 block
   schemas, and worth saying so — several of those are likely variants rather than
   distinct blocks.

## Edge cases

- **A preset whose `data` names a `blocks` field** → construction throw; children go in
  `children`.
- **A preset child exceeding the slot's `max`** → construction throw, since the count is
  known statically.
- **A `default` on a `select` that is not one of the options** → does not compile;
  additionally checked at construction for schemas built dynamically.
- **A preset's `children` deep enough to be silly** (a preset chain 20 levels down) →
  bounded at construction (proposed: depth 5) with a named error, because the recursion
  is over *schema*, not data, and an accidental cycle (preset A's child uses a preset
  whose child is A) would otherwise not terminate. Cycle detection is over
  `(type, preset)` pairs and is the same shape as `ancestorsOf`'s visited set.
- **A subtree insert exceeding `MAX_TX_MUTATIONS`** → a preset producing 200 bloks is
  absurd but expressible; the store's existing `frameCapError` refuses it before it
  reaches `pending` and reports why, which is the correct existing behaviour and needs
  no new code.
- **`summary` naming a field the preset does not set** → the tree shows the field
  default, which is fine.
- **Localisation** (`../content-model/localisation.md`) → defaults and presets write
  the **source locale** only. A translated default would mean shipping copy in a
  schema, which is what a translation surface is for.
- **A preset removed from the schema** → nothing stored references a preset name (it is
  a creation-time recipe), so removing one affects nothing that exists. That is
  precisely why presets need no migration story, and it is worth stating in the docs.
- **`presetsOnly` with no presets** → construction throw; it would make a block
  unaddable.

## Testing requirements

**Unit:** layering across all three levels; subtree construction (uids, orders,
parents-first); every construction-time validation including the preset cycle; the
`resolveValue` guard.

**Workers:** a new story's seeded document containing the root preset's children; the
manifest round-trip.

**End to end:** none. Same reasoning as `conditional-fields.md` — this is core plus
admin, and the unit tests are the honest coverage.

## Dependencies

- None. `duplicate-and-paste.md` shares `allocateSubtree`; either order works.
- `../foundation/document-types.md` gets per-type templates for free afterwards
  (decision 3), and should not add a `template` config key of its own.

## Out of scope

- **Function or async defaults** (Payload allows a function, Sanity an async
  `initialValue`). The manifest is JSON and the admin is prebuilt; a computed default
  would have to be computed server-side at creation, which is a different feature —
  and "today's date" as a default belongs in a `date` field's own affordance, not in a
  general escape hatch.
- **Retroactive defaults.** A content migration (decision 4).
- **Editor-defined presets** ("save this block as a preset"), which Storyblok has. It
  means presets in the database rather than in the schema, an admin UI to manage them,
  and a story for what happens when the underlying block changes. Worth its own spec
  if editors ask.
- **Picker search, icons and categories.** On `ROADMAP.md` already; decision 5 commits
  only to not making it worse.
- **Document duplication as a way to get a starting shape** — that is
  `duplicate-and-paste.md`, and the two are complementary: templates for "always start
  like this", duplication for "start like that one".

## Implementation notes

Built as planned, in the three phases above. No Open questions section existed
to resolve.

**Ground truth correction inherited from `conditional-fields.md`:** `blankBlok`,
`summarise`, `slotsOf`, `BlockSchema`, `Manifest` and `SchemaIndex` already lived
in `core/schema.ts`, not `core/block.ts`, before this spec started — this
document's own Ground truth section had already been corrected to say so, and
the code matched it.

**`allocateSubtree` — the primitive `duplicate-and-paste.md` shares:**

```ts
export interface SubtreeBlok {
  /** Local to one call; links a child's `parent` to another entry's `key` here. */
  key: string
  type: string
  data: Record<string, Json>
  parent: string | null   // another entry's `key`, or null for the recipe's one root
  slot: string | null
}

export function allocateSubtree(
  bloks: readonly SubtreeBlok[],
  parent: string | null,
  slot: string | null,
  order: string,
): Blok[]
```

In `packages/folio/src/core/schema.ts`, exported from `folio/engine`
(`packages/folio/src/core/engine.ts`) alongside `blankSubtree` and
`validatePresets`. It is schema-agnostic on purpose: given a flat recipe (one
entry per node, `parent: null` marking the single root, everything else
pointing at another entry's `key`), it assigns every node a fresh uid via
`newUid()` and, per `(parent, slot)` group, a fresh fractional order via
`keyAtIndex` walked in the recipe's own array order — every slot in a freshly
allocated subtree is new, so there is nothing existing to collide with.
Returns parents before children, matching `diff.ts`'s insert rule, so the
array is one `store.tx(...)` call.

`blankSubtree(schema, type, parent, slot, order, preset?)` is the schema-aware
caller: it resolves kind defaults, `field.default` and a preset's `data`/
`children` into exactly this recipe shape, then hands it to `allocateSubtree`.
`duplicate-and-paste.md` does not need schema at all for its own case — it
already has concrete field values from the document it is copying — so it
builds its own `SubtreeBlok[]` from an existing subtree (stripped of old uids,
old parents remapped to local `key`s) and calls `allocateSubtree` directly,
never `blankSubtree`.

**Preset data shape**, in `core/schema.ts`, reaching the admin unchanged
through the manifest (`BlockSchema.presets`/`presetsOnly`):

```ts
export interface BlockPreset {
  name: string
  label: string
  data?: Record<string, Json>
  children?: readonly { slot: string; type: string; preset?: string }[]
}
```

**Deliberate divergence from the spec's own sketch of `validatePresets`'s call
site:** the spec's Ground truth said "`createFolio` already validates its
config before serving a request" as the reason this joins that check — no such
pre-existing validation actually existed to join; `validatePresets(schema)` is
the first one, called from `createRuntime` immediately after the schema index
is built, which still satisfies the acceptance criterion (throws before any
request is served, since `createRuntime` runs synchronously during setup).

**Nothing deferred.** The cycle/depth bound uses `MAX_PRESET_DEPTH = 5` exactly
as the spec proposed, walking `(type, preset)` pairs. `resolveValue`'s guard
(decision 4) has a pinned test for `number`, `text` and `select`.

**Incidental fix, not caused by this spec:** `pnpm exec biome ci .` failed on
seven files at the start of this work (line-wrapping only, no logic) — fixed
in its own commit before phase 1, since "Biome clean" is part of every spec's
definition of done.

**Tests added:** 33 in `test/unit/core/schema.test.ts` (layering, subtree
construction, every validation throw, the `resolveValue` guard), 12 across two
new files in `test/unit/admin` (`menuGroups`, `subtreeInsert`), 4 in
`test/workers/schema.test.ts` (seeded document with a root preset's children,
the bare-root fallback, and the defaults/presets manifest round-trip). 716 ->
764 tests, 29 -> 32 files.
