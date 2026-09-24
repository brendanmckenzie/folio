# Form layout — an approach for discussion

*Proposal, 2026-09-24. Not a spec and not an execution plan — there is no
numbered spec for this feature (`docs/specs` is one file per tracked feature,
and no issue on the 1.0 tracker names this one). Engages with the design brief
at `ROADMAP.md`, section 4 ("A form has no logic…").*

**Decided and partly built, 2026-09-24.** Candidate C was chosen, and its
"smallest first slice" — rows only, section 4 below — has shipped: `beside`/
`grow` on `FormField`, `row`/`grow` always present on `ResolvedFormField`, and
`formLayout()` exported from `folio/core`. See `ROADMAP.md`, section 4's own
note, for what landed and what is still next (sections, `showIf`/`hold`,
steps). Section 5 below records all six decisions this design needed,
including the one — moving a question past a row boundary — this file
originally left unruled; none is an open question any more.

## 1. The problem, and what "layout" has to mean

A form is `forms.fields`: one flat, ordered JSON array of questions
(`src/core/forms.ts:101-127`, `migrations/0010_forms.sql`), compiled key by key
into `ResolvedForm.fields` (`src/server/forms.ts:349-442`). Nothing in the stored
model, the descriptor, the server or the builder expresses a row, a group or a
page. Take Off Go's `/contact` lost its first/last-name pair to this on 2026-09-07.

Two facts about the live consumers constrain every design below, and both were
checked in their source:

- **Both hosts render `form.fields.map(Question)` and nothing else**
  (`takeoffgo-website/app/components/forms/EnquiryForm.tsx:87`,
  `allaboutafrica-website/app/components/FolioForm.tsx:348`). A design in which a
  host that ignores layout no longer renders a correct form is a breaking change
  in practice, whatever the types say.
- **Both render an unknown `kind` as a text input.** Take Off Go's `Question`
  switch falls to `default: <input type="text">` (`Question.tsx:124`); the demo's
  last branch is `<input type={field.kind}>` (`examples/demo/src/blocks/contact.tsx`).
  So **no new kind may appear in `ResolvedForm.fields`**: a "row" or "section"
  item there becomes a stray text box named after it on both sites.

(All About Africa already guesses layout from kind — a `WIDE` set of kinds "that
would read as half a thought in half a column", `FolioForm.tsx:74-75`. That is the
host doing, badly, what the descriptor should tell it.)

| Case | Verdict |
|---|---|
| **Rows** — `[First] [Last]`, `[City][State][Postcode]` | **Now.** The reported case. |
| **Sections** — a group with a legend and help, rendered as `<fieldset>` | **Next.** Cheap, and the only natural home for a condition over several questions. |
| **Conditional visibility** (`showIf`) on questions and sections | **With the logic spec** (ROADMAP item 1). Designed here so layout does not have to change when it lands. |
| **Steps/pages** | **Later.** A separate axis from layout; the design leaves a slot. |
| Nested groups, groups inside rows, a column spanning several rows ("three inputs left, a textarea right") | **Out.** Needs a real tree; GOV.UK's research argues against deep nesting anyway. |
| Per-breakpoint layout in the descriptor, offsets/spacers, alignment, label position | **Out.** Presentation the host owns. |
| CSS class tokens on a field | **Out, permanently.** Gravity Forms and WPForms both shipped and then migrated away from it. |
| Inline "Other: ____" inside a choice list | **Out of layout.** It is an option feature, not a row. |
| Repeating groups | **Out.** Breaks the flat key→value response (ROADMAP's own reason). |

## 2. What the market says, in one lesson per family

- **A — headless UI-schema tree (JSON Forms).** Layout is a parallel tree; a rule
  can hide any node, so hiding a whole row is one condition. *Lesson:* containers
  are the right unit for conditions; but a custom renderer has to reimplement
  every layout node, and JSON Forms never defines what a row does when *one*
  member hides. ([UI schema](https://jsonforms.io/docs/uischema/), [rules](https://jsonforms.io/docs/uischema/rules))
- **B — containers in the component tree (Form.io, Payload `Row`, WPForms Layout
  field, HubSpot, Tally, Formie).** Best builder UX; **the family with the
  documented failure.** WPForms: "conditionally shown fields will be aligned to
  the left"; its fix was to make the *row* the unit of conditional logic. HubSpot
  simply forbids dependent fields in multi-column rows. *Lesson:* per-field
  visibility and row layout must be defined together, or one of them gets
  forbidden. ([WPForms](https://wpforms.com/docs/how-to-create-multi-column-form-layouts-in-wpforms/), [HubSpot](https://community.hubspot.com/t5/Lead-Capture-Tools/creating-a-2-column-form/m-p/505248))
- **C — per-field hints, no container (SurveyJS `startWithNewLine`/`colSpan`,
  Payload form-builder `width` %).** Cheapest migration, cheapest builder.
  Payload's plugin is the closest analogue to Folio (headless, host renders).
  *Lesson:* the hint must be abstract (a number, never a class name) — and
  SurveyJS still needed an explicit "starts a new row" flag, because implicit
  rows are ambiguous. ([SurveyJS](https://surveyjs.io/form-library/examples/arrange-multiple-questions-in-single-line/documentation), [Payload](https://payloadcms.com/docs/plugins/form-builder))
- **D — reflow vs reserve as a named choice (Formily `display: none | hidden`).**
  The only system that answers the hidden-member question on purpose, and it had
  to fix a gap bug to do it. *Lesson:* decide it in the model before it arrives as
  a bug report. ([FormGrid](https://element.formilyjs.org/guide/form-grid.html))
- **E — no layout opinion (FormKit, Uniforms, Google Forms).** Google Forms spawned
  a bolt-on market for columns. *Lesson:* editors want *some* hint even in a
  headless system; they want it not to leak CSS.
- **F — flow first (Typeform, Tripetto, SurveyJS/Formie pages).** *Lesson:* steps
  and layout are different questions ("when" vs "where"); keep them on separate
  axes rather than one overloaded container.

Also carried in: **a hidden required field must stop being required** (Formie
does it automatically), and **"hidden fields still occupy space"** is a recurring
bug across unrelated products because the wrapper, not the input, carries the
width (HubSpot, AEM).

## 3. Three candidate designs

Three test forms are used throughout:

1. **Name** — `[First][Middle?][Last]`, middle shown only if "has a middle name".
2. **Hear** — `[How did you hear? ▾][Other: ____?]`, Other shown only for `other`,
   followed by a half-width `[Phone]`.
3. **Address** — `[Street]` then `[City][State][Postcode]`, the whole block shown
   only when "postal address differs".

### Candidate A — a span per field, CSS grid auto-flow (the ROADMAP brief)

```ts
// stored, on FormField
width?: 'full' | 'half' | 'third' | 'two-thirds' | 'quarter' | 'three-quarters'
// descriptor, on ResolvedFormField
span: 12 | 6 | 4 | 8 | 3 | 9          // always present; 12 when unset
```

```tsx
<div className="form__grid">
  {form.fields.map((f) => (
    <div key={f.name} style={{ '--span': f.span } as CSSProperties}><Question field={f} /></div>
  ))}
</div>
```
```css
.form__grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 1rem; }
.form__grid > * { grid-column: span var(--span); }
@container form (max-width: 36rem) { .form__grid > * { grid-column: 1 / -1; } }
```

- **Builder:** a width select in `FieldPanel`; the list stays a flat `<ol>`.
- **Conditions:** rows are emergent, so reflow is *across* rows. Name: middle
  hidden leaves First and Last at a third each with an empty third on the right —
  they cannot widen to halves, because no stored value means "share the row".
  Hear: with Other hidden, Phone **backfills beside the select**, then drops a line
  when Other appears — the WPForms bug, under the visitor's cursor. Address: fine
  visually, but there is no container, so "hide the block" means copying one
  condition onto four questions and keeping them in sync by hand. Reserve means
  the host rendering an empty cell of the same span. The engine can never say
  "this row is empty", because rows exist only in CSS.
- **No-JS:** fine; pure markup.
- **A11y/DOM order:** DOM order is field order unless a host reaches for
  `grid-auto-flow: dense`, which reorders visually and not for a screen reader.
  No `<fieldset>` anywhere.
- **Responsive:** the host's breakpoint, as the brief says.
- **Compat:** one optional key on `FormField`, `FORM_FIELD` (`validate.ts:1791`),
  `compileField`; `span` on `ResolvedFormField`. Additive, a minor. An old build
  re-saving strips `width` (`validateOneField` copies keys explicitly), losing
  layout only. `readFields` unaffected.
- **`shapeOf`/purge/CSV/cap:** none touched.

**Verdict:** the brief's instincts are right — an abstract token, the host owns CSS
and breakpoints, DOM order is field order — but "Folio ships no row objects and no
opinion about when a row stops being one" is exactly the property that fails when
`showIf` lands. It fixes today's complaint and fails two of the three test forms
tomorrow. Adding SurveyJS's `startWithNewLine` to rescue it turns it into C.

### Candidate B — an explicit container tree

```ts
// stored in a new column, forms.layout (migration 0011); fields stays flat data
type LayoutNode =
  | { type: 'field'; name: string }
  | { type: 'row'; children: LayoutNode[]; showIf?: FieldCondition }
  | { type: 'group'; name: string; label: string; help?: string;
      showIf?: FieldCondition; children: LayoutNode[] }
// descriptor: ResolvedForm.layout: readonly ResolvedLayoutNode[]  (same, localised)
```

The host walks a recursive tree, looking each name up in `fields`:

```tsx
function Node({ node, byName }: { node: ResolvedLayoutNode; byName: Map<string, ResolvedFormField> }) {
  switch (node.type) {
    case 'field': return <Question field={byName.get(node.name)!} />
    case 'row':   return <div className="form__row">{node.children.map((c, i) => <Node key={i} node={c} byName={byName} />)}</div>
    case 'group': return <fieldset><legend>{node.label}</legend>{node.children.map((c, i) => <Node key={i} node={c} byName={byName} />)}</fieldset>
  }
}
```

- **Builder:** a tree editor — indent/outdent or drag-and-drop. Today's builder is
  up/down buttons over a flat `<ol>` (`FormBuilder.tsx`, `form-model.ts`
  `moveField`), so this is the largest builder change of the three.
- **Conditions:** the best expressiveness — any node carries `showIf`, a member's
  effective condition is the AND of its ancestors', a hidden row or group is one
  node. Within-row reflow is still undefined unless specified (JSON Forms never
  did).
- **No-JS / a11y / responsive:** markup is fine; tree order is DOM order; groups
  are fieldsets; responsive is the host's.
- **Compat — the costs are the design.** Nesting it inside `fields` is not viable:
  an old build's `validateFormFields` skips an unknown kind (`core/forms.ts:305-308`, `continue`)
  *with its children*, so on a rollback grouped questions vanish from the page
  **and from `validateSubmission`**, which only reads declared names — answers
  silently discarded. A separate column avoids that but creates **two orders** (the
  array's, which drives CSV columns, `folio_invalid`, `validateSubmission`, and the
  tree's, which drives the page) plus dangling references on every rename and
  delete, all of which must be reconciled on every save. The descriptor gains a
  `layout` key (additive); a strict tree validator on the read path must never
  throw into `readFields`, whose failure mode is `[]` — every question gone from a
  live form, logged once (`server/forms.ts:182-189`).
- **`shapeOf`:** must fold ancestor conditions into each question and use tree
  order. **Cap:** containers need their own bound beside `MAX_FORM_FIELDS`.

**Verdict:** right semantics, wrong price. Arbitrary nesting buys cases this
document deliberately leaves out.

### Candidate C — explicit rows and sections, encoded over the flat list (recommended)

B's semantics at fixed depth — **section › row › cell** — expressed as contiguous
runs over the existing array, so the array stays the one order and the one list of
questions.

```ts
// stored, on FormField (all optional)
beside?: boolean        // sits in the same row as the previous question
grow?: 2 | 3 | 4        // share of its row, relative to neighbours; default 1
section?: string        // name of the FormSection this question belongs to
showIf?: FieldCondition // slice 3 — the logic spec
hold?: boolean          // slice 3 — keep this cell's space when hidden

// stored, forms.layout (migration 0011, a JSON object so steps need no 0012)
interface FormLayout { sections?: FormSection[] }
interface FormSection {
  name: string          // NAME regex, unique among sections
  label: string         // the legend
  help?: string
  showIf?: FieldCondition                    // slice 3
  i18n?: Record<string, { label?: string; help?: string }>
}
```

Rules, all of them **narrowing on read and refusing on write** — a layout mistake
can drop layout but can never make `readFields` answer `[]`:

- A row is the first question plus every following question with `beside`. A
  section boundary, the start of the form and a `statement` break a row.
  `hidden`-kind questions are layout-transparent: they neither join nor break one.
- At most **four** cells per row (Name with a title field is four; HubSpot caps at
  three).
- Section membership is contiguous; a question naming a section that has already
  closed loses its `section`. A section with no members is dropped.

**Descriptor** — `fields` stays flat and keeps its meaning, so a host that ignores
layout still renders every question, stacked, as today:

```ts
interface ResolvedFormField {
  /* …existing keys… */
  row: number            // always present; consecutive fields sharing it form a row
  grow: number           // always present; 1 when unset
  section?: string
  showIf?: FieldCondition  // slice 3
  hold?: true              // slice 3
}
interface ResolvedForm { /* …existing… */ sections: readonly ResolvedFormSection[] }
interface ResolvedFormSection { name: string; label: string; help?: string; showIf?: FieldCondition }
```

Plus one pure function in `folio/core` — the "engine" layer of the ROADMAP brief —
so no host rebuilds the grouping, and the server can call the visibility half of
it:

```ts
export function formLayout(form: ResolvedForm, answers?: Record<string, Json>): FormLayoutView

interface FormLayoutView {
  sections: readonly LayoutSection[]
  inputs: readonly ResolvedFormField[]   // `hidden` kind: position-free, render anywhere in the <form>
}
interface LayoutSection { section: ResolvedFormSection | null; rows: readonly LayoutRow[] }
interface LayoutRow { key: string; cells: readonly LayoutCell[] }
interface LayoutCell { field: ResolvedFormField; grow: number; shown: boolean }
```

With `answers` omitted — server render, no JS — every cell is `shown`. With
answers, a cell whose question is not asked is removed, unless it `hold`s, in
which case it stays with `shown: false`; a row with nothing shown is removed; a
section whose own `showIf` fails, or with no rows left, is removed. `shown` is
always `true` until slice 3, but it is in the type from day one so a renderer
written now is correct later.

```tsx
import { formLayout, type ResolvedForm } from 'folio/core'

function Questions({ form, answers, invalid }: Props) {
  const view = formLayout(form, answers)
  return (
    <>
      {view.inputs.map((f) => <input key={f.name} type="hidden" name={f.name} value={f.value ?? ''} />)}
      {view.sections.map(({ section, rows }) => {
        const body = rows.map((row) => (
          <div key={row.key} className="form__row"
               style={{ '--cols': row.cells.map((c) => `${c.grow}fr`).join(' ') } as CSSProperties}>
            {row.cells.map((c) =>
              c.shown
                ? <Question key={c.field.name} field={c.field} invalid={invalid.has(c.field.name)} />
                : <div key={c.field.name} aria-hidden="true" />   // a held slot: no input, nothing posts
            )}
          </div>
        ))
        return section ? (
          <fieldset key={section.name} className="form__section">
            <legend>{section.label}</legend>
            {section.help ? <p className="form__help">{section.help}</p> : null}
            {body}
          </fieldset>
        ) : <Fragment key="">{body}</Fragment>
      })}
    </>
  )
}
```
```css
.form { container: form / inline-size; }
.form__row { display: grid; grid-template-columns: var(--cols, 1fr); gap: 1rem; }
@container form (max-width: 36rem) { .form__row { grid-template-columns: 1fr; } }
```

- **Builder.** The list stays a flat `<ol>`, so up/down reordering keeps working.
  Each question gets a "beside previous" toggle, and joined questions draw as one
  bracketed line in the list; a "share of row" select appears only on a question
  in a row. Sections: "Group into section" on a contiguous selection, a section
  header line in the list, legend/help (and later `showIf`) in the side panel.
  `moveField` has to detach the moved question (clear its `beside`) and clear
  `beside` on the question that slides into its old place, or a move silently
  re-forms a neighbouring row — that is the builder's one subtle reducer.
- **Conditions — the three test forms.** Reflow is **within the row only, never
  across rows**, because rows are data. *Name:* middle hidden → First and Last
  become halves; nothing below moves. *Hear:* with `hold` on Other, the select
  stays half-width and the empty half waits; without it, the select is full-width
  until Other appears. Either way **Phone never jumps up**, because it is not in
  that row. *Address:* a section with one `showIf`; hidden, the whole fieldset
  disappears and the server treats all four questions as not asked. Rows carry no
  condition of their own: a row all of whose members are conditional on the same
  thing disappears by the rule above, and a condition over several questions is
  what a section is for — WPForms' fix, without HubSpot's ban.
- **Server-side re-evaluation (slice 3).** One core function decides "asked":
  the question's `showIf` AND its section's `showIf`, evaluated in array order
  with not-asked questions reading as `null`, and a condition may reference only
  *earlier* questions (no cycles; steps stay sane). `formLayout` and
  `validateSubmission` both call it, so a not-asked required question never
  blocks, and an answer to one is dropped rather than stored — a crafted POST
  cannot write a field the visitor was never shown.
- **No-JS.** Rows and sections are markup and need nothing. Without JS the host
  calls `formLayout(form)` with no answers, so every question renders and the
  server applies the conditions to what was posted. With JS, a hidden question
  should be unmounted or `disabled`, not just styled: a `display: none` input
  still posts natively (the server drops it regardless, but the visitor's browser
  validation would not).
- **Accessibility and DOM order.** DOM order is array order by construction —
  rows and sections are contiguous runs — so tab order, reading order and visual
  order agree without the host trying. Sections are `<fieldset>`/`<legend>`. A held
  slot is an empty `aria-hidden` div, never a `visibility: hidden` input — that
  is out of the tab order but still posts its value in a native submission. The
  GOV.UK finding (a reveal of one input tests fine; of several, poorly) goes in
  the handbook and the builder's copy, and argues for revealing a section rather
  than several loose questions.
- **Responsive collapse.** The host's, entirely. Folio stores proportions, never
  breakpoints; the handbook shows the container-query pattern above. This is the
  documented contract the research found almost nobody publishes: *a row is a
  suggestion for wide containers; stacking it is always correct.*
- **Compat.** Slice 1 (rows) is optional keys only: `FormField`, `validateOneField`,
  `FORM_FIELD`, `compileField`, `ResolvedFormField`, and the exact-key-set test
  (`test/unit/server/forms.test.ts:186-225`). No migration. Slice 2 adds
  `forms.layout` as `0011` — `alter table forms add column layout text not null
  default '{}'` — an additive migration, the only kind the licence allows on four
  live databases, and one line in `UPGRADING.md` for each host. `FormFieldKind`
  does not change, so no host's exhaustive switch breaks and nothing new appears
  in `fields`. Everything is additive: a minor after 1.0, and safe to land before
  it. **Rollback:** an old build ignores the column and strips the new keys on its
  next save — layout lost, every question intact, which is the right way round.
- **`shapeOf`, purge, CSV, cap.** Layout keys (`beside`, `grow`, `hold`, `section`
  membership, legends) are presentational and stay out of `shapeOf`, so they do
  not bump `version` — which is stamped on every response and drives the builder's
  "structural change" note, and must keep meaning "the server's rules changed".
  `showIf` (question and section, folded into each question's effective
  condition) goes **in**, per the brief's "`shapeOf` means anything the server
  enforces". `shapeOf` is recomputed on both sides of every save and never
  stored, so extending it causes no spurious bump on existing rows. Whether a
  layout-only save purges `form:<id>` is decision 2 below. CSV columns, the
  responses table, `folio_invalid` order and `validateSubmission` all keep walking
  the flat array: **untouched**. `MAX_FORM_FIELDS` keeps counting questions, and
  `SUMMARY_COLS`' `json_array_length(fields)` stays true; sections get their own
  cap (20) in the `FormLayout` validator.

**The trade accepted:** one level of grouping. No group inside a row, no group
inside a group, no column running beside several rows. Each is a real layout and
each would need B's tree; none has been asked for, and GOV.UK's research and
Typeform's whole product argue that forms deep enough to want them should be
steps instead.

## 4. Recommendation

**Candidate C.** It is the only one of the three that passes all three test forms
once conditions exist, and it gets there with A's storage cost: the flat array
remains the single source of order and of questions, so submission, CSV,
`folio_invalid`, the cap and the honeypot never learn that layout exists, and a
host that never reads a layout key keeps rendering a correct form. Against B it
gives up arbitrary nesting in exchange for no second order, no dangling
references, no tree editor and no rollback that eats questions. Against the brief
it keeps everything right about it — an abstract proportion, the host owns CSS and
breakpoints, DOM order is field order — and replaces "grid auto-flow is the row
algorithm" with explicit rows, because a row the engine cannot see is a row that
conditions cannot reason about.

**Smallest first slice — rows only.** `beside` and `grow` on `FormField`, `row` and
`grow` on `ResolvedFormField`, `formLayout()` in `folio/core` returning its full
shape (`sections` with a single `section: null`, `shown` always `true`), the
builder toggle and share select, the demo renderer and CSS, and the handbook
section with the container-query pattern. No migration, no `shapeOf` change, no
change to either live host until it chooses to adopt it — Take Off Go's
`/contact` is fixed by an editor toggling one question and a host swapping its
`fields.map` for `formLayout`.

**How it leaves room without a later break:**

- *Sections (slice 2)* populate `sections` and `ResolvedForm.sections`; hosts
  written against slice 1 already iterate sections and already handle
  `section: null`.
- *Conditions (slice 3, the ROADMAP logic spec)* add `showIf`/`hold` and the
  `answers` argument; `shown` and within-row reflow are already in the contract,
  and the server's "asked" function is the same one `formLayout` uses.
- *Steps (slice 4)* are a second list in the same `forms.layout` object
  (`steps?: FormStep[]`) with a `step` membership key on questions, contiguous
  like sections, and a `step` index on each `LayoutSection` — all additive. With
  no JS the form is one page, which is what `formLayout` without a step filter
  already returns.

**Risks named, and found for real.** The builder reducers were where this went
quietly wrong twice over, both caught by adversarial review rather than by the
reducer tests written alongside the first slice: `removeField`/`moveField`
detaching only the array element that lands at a vacated index did nothing
when that element was a `hidden` question (`rowsOf` treats it as transparent,
so the real question *after* it kept joining straight across the gap), and a
raw array move could insert a standalone question between two members of an
existing row, pairing it with a neighbour nobody chose (decision 6 above is
the fix for the second; the first is `detachFirstRealAt` in
`admin/ui/screens/form-model.ts`, which skips past `hidden` questions to find
the real predecessor whose `beside` actually needs clearing). Both now have
regression tests built to fail on the code before the fix, not just to pass
after it. The narrow-on-read rule remains worth watching: if anyone later
makes a layout check *throw* inside `validateFormFields`, `readFields` turns
it into a form with no questions on a live site. And `formLayout` in
`folio/core` is a new exported contract whose return shape is the thing hosts
build against — it was reviewed as an API, including the case a stored
descriptor predates it entirely (a cached `ResolvedFormField` with no `row` at
all falls back to one row per field, never one row for the whole form).

## 5. Decisions

All six taken. Each names the alternatives it beat and why, the same
"rejected, with the reason" convention `docs/specs/_TEMPLATE.md` asks of a
numbered spec's own architecture decisions, even though this file predates
having one.

1. **How a row divides its width: relative shares, 1–4, and 1 is the
   default.** Renormalises for free when a member is hidden by a later
   condition, maps straight to `fr` (the demo's own CSS) or `flex-grow`, and is
   one `<select>` in the builder. Rejected: spans out of twelve, as the
   ROADMAP brief first proposed — a hidden member leaves a hole that still has
   to be recomputed, so it buys nothing over shares, and "6 + 6 + 4" is a
   stored value that means nothing on its own. Rejected: equal split only —
   cheapest, and it fails Address's `[City][State][Postcode]`, which wants a
   postcode narrower than a city.

2. **A layout-only save purges `form:<id>` without bumping `version` — and so
   does a label-only save, which revisits decision 7's silence on purpose.**
   `version` stays `shapeOf`'s question alone, and `formChanged` (the host-
   facing hook) still fires only on a structural save, so a host relying on
   its payload — "the version this save bumped to. Always present" — never
   sees it called for a save that bumped nothing. The purge itself runs beside
   that event rather than through it: `updateForm` reports `descriptorChanged`
   (true for any save `compileForm` would render differently — a label, a
   layout share, `open`, a message, `submitLabel`, `redirectTo` — a strict
   superset of `structural`), and the route calls `purgeFormLayout` directly
   whenever that is true and `structural` is not. Edge TTL is a week
   (`s-maxage=604800`, `core/cache-tags.ts:218`), which is what made a label
   edit's old silence expensive enough to revisit. Rejected: parity with
   labels — no purge at all for either, layout and label edits alike waiting
   out the TTL or a republish. Rejected: treating layout as structural — it
   would bump `version` and fire `formChanged` for a change nothing enforces,
   muddying "which shape did this response answer" for every response
   recorded against the new number.

3. **What a section is to the host: one `section`, and the host chooses
   fieldset or heading.** The handbook's own render pattern recommends a
   `<fieldset>` — a section is a legend and a help string, not a layout
   instruction, so the descriptor stays semantic rather than presentational,
   the same posture `kind` already takes toward every other question. Rejected:
   an editor-chosen `as: 'fieldset' | 'heading'` — more control for an editor,
   at the cost of a branch every host's renderer has to carry whether or not
   it ever changes. Rejected: no sections at all, rows now and groups only
   when steps arrive — it would defer the one migration (`forms.layout`) this
   design needs exactly once, and leave "hide the whole address block" with no
   home the moment conditions land, which is the case slice 3 exists for.

4. **When a condition hides a member of a row: reflow within the row by
   default, per-question `hold` to keep the slot.** Formily's own choice, and
   the Hear form needs it — without `hold`, the "how did you hear" select
   would visibly widen the instant "other" appears, under the visitor's own
   cursor. Rejected: always reflow, no knob — simpler, but it is the same
   widening-under-the-cursor bug with no escape for the one form that
   triggered this whole design. Rejected: refusing a conditional question
   inside a row at all, HubSpot's own posture — no ambiguity, but it forbids
   both Name (`middle`, shown only with a checkbox) and Hear outright, two of
   the three forms this design is built to pass.

5. **Narrow screens are entirely the host's job.** Folio stores proportions,
   never breakpoints, and ships the container-query pattern in the handbook
   with one contract: stacking a row is always correct, so a host that does
   nothing at all still renders a working form. Rejected: a per-row
   `keepInline` hint for a row that must never stack (date parts, state plus
   postcode) — a real case, but the first breakpoint-shaped value the
   descriptor would carry, and the brief's own instinct was that Folio holds
   no opinion about a breakpoint. Rejected: Folio shipping an optional
   stylesheet — direct contradiction of "Folio ships no form markup or CSS"
   (`docs/handbook.md`'s own line on it).

6. **Moving a question past a row boundary (the builder's ↑/↓ buttons) is
   row-aware, and never lands a question inside a row it was not asked to
   join.** Unruled territory when this file was first written — the risk
   named under "Risks worth naming" was the delete/move reducers leaving a
   stale `beside` behind, and a plain array move turned out to have the same
   failure shape from the other direction: `moveField(from, to)`'s raw splice
   can insert a standalone question between two members of an existing row,
   pairing it with whichever one it lands next to. The rule adopted, applied
   uniformly by `moveFieldStep` (`admin/ui/screens/form-model.ts`):
   - Inside a multi-question row, moving a member reorders it within that
     row — the row's own shape survives, `beside` is reassigned to match each
     slot's new position, and each question's own `grow` moves with it.
   - At a row's edge, the question leaves the row and becomes its own
     standalone row, immediately next to the one it left — nothing else moves.
   - A standalone question moving past a multi-question row jumps clean over
     the whole row, carrying any `hidden` question embedded inside it along
     for the ride, rather than landing in the middle of it.
   - A `hidden` question is layout-transparent (`rowsOf`) and never joins a
     row, so moving one is always a plain single-step swap.
   Rejected: leaving the raw splice as the builder's own move, disabled only
   at the two literal ends of the whole list — the button's old `disabled`
   condition (`i === 0` / `i === length - 1`) undersells what it can safely do
   (the first member of a row can still detach without leaving position 0) and
   oversells what a raw splice can safely do (a standalone question landing
   inside a row it never asked to join). Rejected: refusing the move
   outright when it would cross a row boundary — the simplest rule to state,
   but it leaves an editor unable to reorder rows relative to each other at
   all, which is most of what the ↑/↓ buttons are for.
