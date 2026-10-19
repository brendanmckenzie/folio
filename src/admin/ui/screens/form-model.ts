/**
 * The form builder's arithmetic (`docs/specs/content-model/forms.md` phase 6):
 * the add-field menu, the pure reducers over a field list (add, remove,
 * reorder, rename — with the split warning), field-name normalisation and its
 * refusals (including the honeypot collision decision 9 asks for), the
 * per-locale text a translating editor reads and writes, and the
 * `closesAt` ⇄ `<input type="datetime-local">` conversion.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component. `inspector-model.ts` and `redirects-model.ts` are
 * the pattern: everything a person can get wrong without a request lives here,
 * so a Node test can reach it.
 *
 * **Every save still goes through `validateFormFields`** (`core/forms.ts`) on
 * the server, which is the one validator (decision 2). Nothing here is a
 * second implementation of that — it is the client-side half that goes exactly
 * as far as being useful, `redirects-model.ts`'s `draftRefusal` posture: a
 * refusal the server does not need a round trip to give.
 */
import {
  checkFormLogic,
  type FormField,
  type FormFieldI18n,
  type FormFieldKind,
  type FormFieldOption,
  type FormLayout,
  type FormSection,
  honeypotName,
  MAX_ROW_CELLS,
  RESERVED_PREFIX,
} from "../../../core/forms";
import type { LocaleConfig } from "../../../core/locales";
import { comparesValue, referencedNames, renameInCondition } from "./condition-model";

/* -------------------------------------------------------------- locales --- */

/**
 * Whether the builder shows a locale switcher at all (decision 12: "shown
 * only when `config.locales` is set").
 *
 * `> 1`, not merely "declared", matching `EditorShell.tsx`'s own check for the
 * same reason: a `locales` config naming exactly one available locale (the
 * source, and nothing else) has nothing to switch *to*, so the control would
 * offer one option that is already showing.
 */
export function showLocaleSwitcher(locales: LocaleConfig | undefined): boolean {
  return (locales?.available.length ?? 0) > 1;
}

/* --------------------------------------------------------------- the menu --- */

export interface FieldKindMeta {
  kind: FormFieldKind;
  label: string;
  /** One line for the add menu — what this kind is for, not how it validates. */
  hint: string;
}

/** The thirteen kinds, in the order the add menu offers them — the order a
 *  contact form's questions actually arrive in: identity, then the message,
 *  then the choices, then the exceptional ones. */
export const FIELD_KINDS: readonly FieldKindMeta[] = [
  { kind: "text", label: "Text", hint: "A single line — a name, a subject." },
  { kind: "email", label: "Email", hint: "Checked for shape, both here and on submit." },
  { kind: "tel", label: "Phone", hint: "A single line, no format enforced." },
  { kind: "url", label: "Website", hint: "Checked for shape, both here and on submit." },
  { kind: "textarea", label: "Paragraph", hint: "A multi-line message." },
  { kind: "number", label: "Number", hint: "Coerced and range-checked on submit." },
  { kind: "date", label: "Date", hint: "A single date, no time." },
  { kind: "select", label: "Dropdown", hint: "One choice from a list." },
  { kind: "radio", label: "Radio buttons", hint: "One choice, every option visible." },
  { kind: "checkbox", label: "Single checkbox", hint: 'A yes/no — "I agree to…".' },
  { kind: "checkboxes", label: "Checkbox group", hint: "Any number of choices from a list." },
  {
    kind: "file",
    label: "File upload",
    hint: "Gated: only a signed-in publisher can read it back.",
  },
  {
    kind: "hidden",
    label: "Hidden value",
    hint: "The host's own markup supplies this, not a visitor.",
  },
  {
    kind: "statement",
    label: "Statement",
    hint: "Prose between questions. No input, stores nothing.",
  },
];

const KIND_LABELS: Record<FormFieldKind, string> = Object.fromEntries(
  FIELD_KINDS.map((k) => [k.kind, k.label]),
) as Record<FormFieldKind, string>;

export function fieldKindLabel(kind: FormFieldKind): string {
  return KIND_LABELS[kind];
}

/** The kinds `validateFormFields` requires at least one option for. */
const OPTION_KINDS: ReadonlySet<FormFieldKind> = new Set(["select", "radio", "checkboxes"]);

export function needsOptions(kind: FormFieldKind): boolean {
  return OPTION_KINDS.has(kind);
}

/* ---------------------------------------------------------------- naming --- */

/**
 * A typed name, screened to the charset `core/forms.ts`'s `NAME` regex
 * requires (`^[a-z][a-z0-9_]{0,63}$`) — ASCII only, deliberately narrower than
 * `formSlug`'s unicode-aware `\p{Letter}`: this is a CSV column header and an
 * HTML input `name`, an identifier rather than a human-facing path segment, so
 * a non-Latin label is dropped rather than carried through as a name nobody
 * downstream (a spreadsheet, a `<input name>`) can round-trip.
 *
 * Guaranteed to satisfy `NAME` for any input, including the empty string —
 * every caller can hand this straight to the server without a second check.
 */
export function normaliseFieldName(raw: string): string {
  const stripped = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (stripped === "") return "field";
  return /^[a-z]/.test(stripped) ? stripped : `f_${stripped}`.slice(0, 64);
}

/**
 * Disambiguates `base` against `existing`, `_2`, `_3`, … — never touching
 * `base` itself when it is not already taken.
 *
 * Named for its first use (a field's own name against its siblings') but
 * generic over any slug-like set: `addOption` reuses it verbatim for an
 * option's `value` against its siblings' — the same "make this one thing
 * unique in this list" question, asked of a different list.
 */
export function uniqueFieldName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * What is wrong with a typed field name, or null. Three refusals, and all
 * three are things the server would otherwise 400 on:
 *
 * - the charset (unreachable once a name has gone through
 *   `normaliseFieldName`, but a direct caller — a test, a future paste-in
 *   flow — should still hear about it rather than send a name the server
 *   refuses);
 * - a duplicate within the same form (`validateFormFields`'s `seenNames`);
 * - a collision with this form's honeypot (decision 9: "the builder refuses a
 *   field whose slug collides with it" — the one refusal that is entirely
 *   this screen's to make, since the server never sees a name that never
 *   reaches it).
 *
 * The reserved-prefix refusal (`RESERVED_PREFIX`) is folded into the charset
 * one: `normaliseFieldName` never produces a leading underscore, so this only
 * fires for a name a caller constructed by hand.
 */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function fieldNameRefusal(
  name: string,
  ctx: { formId: string; otherNames: readonly string[] },
): string | null {
  if (!NAME_PATTERN.test(name)) {
    return "Use lowercase letters, numbers and underscores, starting with a letter.";
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    return `Names starting with "${RESERVED_PREFIX}" are reserved by Folio.`;
  }
  if (ctx.otherNames.includes(name)) {
    return "Another question already uses this name.";
  }
  if (name === honeypotName(ctx.formId, ctx.otherNames)) {
    return "This name is reserved as this form's spam trap. Pick another.";
  }
  return null;
}

/**
 * What renaming an already-answered question costs, named at rename time
 * rather than discovered in the export (edge case: "A field is renamed after
 * 400 responses"). `hasResponses` is the caller's to know — this screen does
 * not hold the responses count itself, `GET {base}/api/forms/:id/usage` does,
 * the same read the delete dialog already makes.
 */
export function renameWarning(hasResponses: boolean): string | null {
  if (!hasResponses) return null;
  return 'This form already has responses. Renaming keeps old answers under the old name — the table will show "—" for older rows under the new one, and the CSV export will carry both columns.';
}

/* ------------------------------------------------------------ blank field --- */

/** A fresh question of `kind`, named uniquely and pre-filled with whatever
 *  that kind cannot save without (`validateFormFields` throws on an option
 *  kind with none, and on `statement` with no text). */
export function blankField(
  kind: FormFieldKind,
  ctx: { formId: string; existing: readonly FormField[] },
): FormField {
  const names = ctx.existing.map((f) => f.name);
  const name = uniqueFieldName(normaliseFieldName(kind), names);
  const label = fieldKindLabel(kind);
  const field: FormField = { name, kind, label };
  if (needsOptions(kind)) {
    field.options = [{ value: "option_1", label: "Option 1" }];
  }
  if (kind === "file") field.accept = "documents";
  if (kind === "statement") field.text = label;
  return field;
}

/* ------------------------------------------------------------- reducers --- */

export const MAX_FIELDS_REACHED = (limit: number) => `A form may hold at most ${limit} questions.`;

export function addField(
  fields: readonly FormField[],
  kind: FormFieldKind,
  formId: string,
): FormField[] {
  return [...fields, blankField(kind, { formId, existing: fields })];
}

/** Clears a field's own `beside`, if it has one. The one place a reorder or a
 *  delete reaches for it, because a `beside` naming a predecessor the array no
 *  longer has silently re-forms a row with whichever question is now there
 *  instead — `docs/form-layout-approach.md`'s "the builder's one subtle reducer". */
function detached(field: FormField): FormField {
  if (!field.beside) return field;
  const next = { ...field };
  delete next.beside;
  return next;
}

/**
 * Detaches the first *real* (non-`hidden`) question at or after `at` — the
 * one whose predecessor just changed. **Must skip past `hidden` questions**,
 * not just the one that landed at `at`: `rowsOf` treats a `hidden` question as
 * transparent, so a stale `beside` on the real question *after* it joins
 * straight across the gap, the exact way `rowsOf` would read it. Detaching
 * only `fields[at]` — the previous version of this function — does nothing
 * when that slot is itself the `hidden` question, which is finding 1 of the
 * rows-slice review. Mutates `fields` in place; the caller already owns a
 * fresh array.
 */
function detachFirstRealAt(fields: FormField[], at: number): void {
  for (let i = at; i < fields.length; i++) {
    if (fields[i]!.kind !== "hidden") {
      fields[i] = detached(fields[i]!);
      return;
    }
  }
}

/**
 * Why `name` cannot be removed, or null. A question another question's rule (or a
 * section's) names is not removable: the rule would dangle, and `checkFormLogic`
 * would refuse the save. The builder disables the button with this as the reason.
 */
export function removeRefusal(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
): string | null {
  const label = fields.find((f) => f.name === name)?.label || name;
  for (const f of fields) {
    if (f.name === name) continue;
    if (referencedNames(f.showIf).includes(name) || referencedNames(f.requireIf).includes(name)) {
      return `"${f.label || f.name}" has a rule that depends on "${label}". Change that rule first.`;
    }
  }
  for (const s of layout.sections ?? []) {
    if (referencedNames(s.showIf).includes(name)) {
      return `Section "${s.label}" has a rule that depends on "${label}". Change that rule first.`;
    }
  }
  return null;
}

/** Removes `name`, **unless a rule depends on it** (`removeRefusal`): then the list
 *  comes back unchanged. `layout` is only read for that check; `pruneSections`
 *  drops a section the removal emptied. */
export function removeField(
  fields: readonly FormField[],
  name: string,
  layout: FormLayout = {},
): FormField[] {
  if (removeRefusal(fields, layout, name) !== null) return [...fields];
  const index = fields.findIndex((f) => f.name === name);
  if (index === -1) return [...fields];
  // A removed `hidden` question was never anyone's predecessor (`rowsOf`
  // skips it), so nothing downstream actually changed — only a *real*
  // removal can leave a stale `beside` behind.
  const removedWasHidden = fields[index]!.kind === "hidden";
  const next = fields.filter((f) => f.name !== name);
  if (!removedWasHidden) detachFirstRealAt(next, index);
  return next;
}

/** Moves the field at `from` to `to`, clamped — a no-op past either end,
 *  matching `ReferencesField.tsx`'s `move`. A general splice, not the
 *  builder's own ↑/↓ semantics — see `moveFieldStep` for those. */
export function moveField(fields: readonly FormField[], from: number, to: number): FormField[] {
  if (to < 0 || to >= fields.length || from === to) return [...fields];
  const next = [...fields];
  const [moved] = next.splice(from, 1);
  if (!moved) return next;
  if (moved.kind === "hidden") {
    // Transparent to `rowsOf` wherever it sits — moving it changes no real
    // question's predecessor, so nothing needs detaching either side.
    next.splice(to, 0, moved);
    return next;
  }
  // Two predecessors just changed: the first real question after the gap
  // this move left, and the first real question after where it landed —
  // both skipped past any `hidden` in between, the same way `rowsOf` does.
  detachFirstRealAt(next, from);
  next.splice(to, 0, detached(moved));
  detachFirstRealAt(next, to + 1);
  return next;
}

/* ----------------------------------------------------------- row-aware move --- */

interface RowBlock {
  start: number;
  end: number;
}

/**
 * Contiguous raw-array spans, one per row — `moveFieldStep`'s own foundation,
 * built directly rather than by reusing `fieldRows` above. `fieldRows` can
 * *list* a row after a `hidden` question that sits physically inside it (its
 * `lastReal` reference keeps extending an already-pushed block while `hidden`
 * pushes a separate one of its own), which is harmless for the list — render
 * order is array order, not `fieldRows`' own list order — and would be wrong
 * here, where list order **is** the thing a block-move reasons about. A
 * `hidden` question below only ever extends the block already open when it
 * is reached, and starts its own otherwise (a leading `hidden`, before any
 * real question, opens nothing to extend) — so blocks stay ordered and
 * gapless by construction, and a real question can only ever extend a block a
 * real question opened.
 */
function rowBlocks(fields: readonly FormField[]): RowBlock[] {
  const blocks: RowBlock[] = [];
  let current: RowBlock | null = null;
  let cellsInRow = 0;
  let breaksNext = true; // the start of the form breaks a row
  let prevSection: string | undefined;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.kind === "hidden") {
      if (current) current.end = i;
      else {
        current = { start: i, end: i };
        blocks.push(current);
      }
      continue;
    }
    const isStatement = field.kind === "statement";
    const joins =
      !isStatement &&
      !breaksNext &&
      field.beside &&
      cellsInRow < MAX_ROW_CELLS &&
      field.section === prevSection;
    if (joins && current) {
      current.end = i;
      cellsInRow += 1;
    } else {
      current = { start: i, end: i };
      blocks.push(current);
      cellsInRow = 1;
    }
    breaksNext = isStatement;
    prevSection = field.section;
  }
  return blocks;
}

/** The non-`hidden` indices in `[start, end]`, in order — a row-block's real
 *  questions, the ones a reorder or an edge-exit actually reasons about. */
function realIndices(fields: readonly FormField[], block: RowBlock): number[] {
  const out: number[] = [];
  for (let i = block.start; i <= block.end; i++) {
    if (fields[i]!.kind !== "hidden") out.push(i);
  }
  return out;
}

function swapped(fields: readonly FormField[], i: number, j: number): FormField[] {
  const next = [...fields];
  const tmp = next[i]!;
  next[i] = next[j]!;
  next[j] = tmp;
  return next;
}

function blockOf(blocks: readonly RowBlock[], index: number): number {
  return blocks.findIndex((b) => index >= b.start && index <= b.end);
}

/**
 * Whether `moveFieldStep` would do anything at all — the builder's ↑/↓
 * buttons enable on this rather than on raw position. Neither "is this the
 * first field" nor "is this the last field" is the right test any more: the
 * first member of a multi-question row can still detach from its row-mates
 * without leaving position 0, and a standalone question that is not first or
 * last overall can still have nowhere left to go if there is nothing beyond
 * it to swap with or jump over.
 */
export function canMoveField(
  fields: readonly FormField[],
  index: number,
  direction: -1 | 1,
  layout: FormLayout = {},
): boolean {
  if (!canStep(fields, index, direction)) return false;
  return !spoilsOrder(fields, stepFields(fields, index, direction), layout);
}

function canStep(fields: readonly FormField[], index: number, direction: -1 | 1): boolean {
  if (index < 0 || index >= fields.length) return false;
  if (fields[index]!.kind === "hidden") {
    const target = index + direction;
    return target >= 0 && target < fields.length;
  }
  const blocks = rowBlocks(fields);
  const blockIdx = blockOf(blocks, index);
  const real = realIndices(fields, blocks[blockIdx]!);
  if (real.length > 1) return true;
  const neighborIdx = blockIdx + direction;
  return neighborIdx >= 0 && neighborIdx < blocks.length;
}

/**
 * Moves the question at `index` one step up (`direction: -1`) or down (`+1`)
 * — the builder's ↑/↓ buttons. Row-aware rather than a raw array swap: the
 * owner has not ruled on what happens when a move would land a question
 * inside a row it was never asked to join, so this repo settled it with one
 * rule, the same shape as the delete/move risk `docs/form-layout-approach.md`
 * already names for a stale `beside`:
 *
 * - **Inside a multi-question row**, this reorders the question within it.
 *   The row's shape survives — `beside` is reassigned to match each slot's
 *   *new* position rather than trusting whichever flag travelled with which
 *   object, while each question's own `grow` moves with it, since that is
 *   content rather than position.
 * - **At a row's edge**, the question leaves the row and becomes its own
 *   standalone row, immediately next to the one it left — nothing else moves.
 * - **A standalone question moving past a multi-question row** jumps clean
 *   over the whole row rather than landing inside it, carrying any `hidden`
 *   question embedded in that row along for the ride.
 * - **A `hidden` question** is layout-transparent (`rowsOf`) and never joins
 *   a row, so moving one is always a plain single-step swap.
 *
 * A move here never splits a row and never pulls an unrelated question into
 * one. `canMoveField` is `false` exactly when this would be a no-op.
 */
export function moveFieldStep(
  fields: readonly FormField[],
  index: number,
  direction: -1 | 1,
  layout: FormLayout = {},
): FormField[] {
  const moved = stepFields(fields, index, direction);
  return spoilsOrder(fields, moved, layout) ? [...fields] : moved;
}

/** True when `after` has an ordering fault (a rule naming a later question, a
 *  section that is no longer contiguous) that `before` did not: a move that would
 *  introduce one is refused, while a form that is already faulty can still be
 *  rearranged towards health. */
function spoilsOrder(
  before: readonly FormField[],
  after: readonly FormField[],
  layout: FormLayout,
): boolean {
  return orderFaulty(after, layout) && !orderFaulty(before, layout);
}

function orderFaulty(fields: readonly FormField[], layout: FormLayout): boolean {
  const at = new Map(fields.map((f, i) => [f.name, i]));
  for (const [i, f] of fields.entries()) {
    for (const ref of referencedNames(f.showIf)) {
      const j = at.get(ref);
      if (j !== undefined && j >= i) return true;
    }
  }
  for (const s of layout.sections ?? []) {
    const members = fields.flatMap((f, i) => (f.section === s.name ? [i] : []));
    const first = members[0];
    const last = members[members.length - 1];
    if (first === undefined || last === undefined) continue;
    if (last - first + 1 !== members.length) return true;
    for (const ref of referencedNames(s.showIf)) {
      const j = at.get(ref);
      if (j !== undefined && j >= first) return true;
    }
  }
  return false;
}

function stepFields(fields: readonly FormField[], index: number, direction: -1 | 1): FormField[] {
  if (index < 0 || index >= fields.length) return [...fields];

  if (fields[index]!.kind === "hidden") {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return [...fields];
    return swapped(fields, index, target);
  }

  const blocks = rowBlocks(fields);
  const blockIdx = blockOf(blocks, index);
  const block = blocks[blockIdx]!;
  const real = realIndices(fields, block);

  if (real.length > 1) {
    const posInRow = real.indexOf(index);
    const withinRow = posInRow + direction;
    if (withinRow >= 0 && withinRow < real.length) {
      // Reorder within the row.
      const targetIndex = real[withinRow]!;
      const next = swapped(fields, index, targetIndex);
      const sorted = [...real].sort((a, b) => a - b);
      for (const [i, arrIndex] of sorted.entries()) {
        next[arrIndex] = i === 0 ? detached(next[arrIndex]!) : withBeside(next[arrIndex]!, true);
      }
      return next;
    }
    // The row's edge: the question leaves it. Moving up off the first slot,
    // it never had `beside` itself — the question after it does, and loses
    // it instead, becoming the row's new first. Moving down off the last
    // slot, it loses its own.
    const next = [...fields];
    if (direction === -1) {
      const newFirst = real[1]!;
      next[newFirst] = detached(next[newFirst]!);
    } else {
      next[index] = detached(next[index]!);
    }
    return next;
  }

  // A standalone question: the block next door — swapping with it if that is
  // one slot, jumping clean over it otherwise, so a multi-question row is
  // never landed inside.
  const neighborIdx = blockIdx + direction;
  if (neighborIdx < 0 || neighborIdx >= blocks.length) return [...fields];
  const { start: a, end: b } = blocks[neighborIdx]!;
  if (direction === -1) {
    return [
      ...fields.slice(0, a),
      fields[index]!,
      ...fields.slice(a, index),
      ...fields.slice(index + 1),
    ];
  }
  return [
    ...fields.slice(0, index),
    ...fields.slice(index + 1, b + 1),
    fields[index]!,
    ...fields.slice(b + 1),
  ];
}

/** Replaces the field currently named `name` with `next` — the one place a
 *  rename, a label edit, or an option change all funnel through, so there is
 *  one reducer to keep the array's order stable rather than three. */
export function updateField(
  fields: readonly FormField[],
  name: string,
  next: FormField,
): FormField[] {
  return fields.map((f) => (f.name === name ? next : f));
}

/* -------------------------------------------------------------- layout --- */

/** Sets or clears a question's `beside` — the "sit beside the previous
 *  question" toggle. Clearing rather than storing `false`, matching how a
 *  fresh question never carries the key at all (`blankField`). */
export function withBeside(field: FormField, beside: boolean): FormField {
  if (beside) return { ...field, beside: true };
  if (!field.beside) return field;
  const next = { ...field };
  delete next.beside;
  return next;
}

/** Sets or clears a question's `grow` — its share of the row. Anything other
 *  than 2, 3 or 4 clears the key, the same "1 is the default and is not a
 *  stored value" rule `core/forms.ts`'s `FormField.grow` documents. */
export function withGrow(field: FormField, grow: number): FormField {
  if (grow === 2 || grow === 3 || grow === 4) return { ...field, grow };
  if (field.grow === undefined) return field;
  const next = { ...field };
  delete next.grow;
  return next;
}

/**
 * Whether `beside` on the question named `name` could do anything at all —
 * the builder's own refusal, the write-time half of "narrow on read, refuse
 * on write" (`docs/form-layout-approach.md`, Candidate C's row rules). `false` for
 * a form's first real question and for the one right after a `statement`,
 * both of which `rowsOf` always starts a fresh row for regardless of
 * `beside` — so the toggle is disabled rather than silently doing nothing.
 */
export function canJoinPrevious(fields: readonly FormField[], name: string): boolean {
  let previous: FormField | null = null;
  for (const field of fields) {
    if (field.kind === "hidden") continue;
    if (field.name === name) return previous !== null && previous.kind !== "statement";
    previous = field;
  }
  return false;
}

/**
 * The rows the list draws, as indices into `fields` — `rowsOf`'s own
 * partitioning (`core/forms.ts`), but grouped for **display** rather than for
 * the descriptor: a `hidden` question is always its own row of one here,
 * where `rowsOf` instead borrows whichever row is open so every
 * `ResolvedFormField.row` stays a number. The two must keep agreeing on where
 * a *visible* row starts and ends; they are allowed to disagree about what a
 * `hidden` question's own number is, because nothing groups by it either way.
 */
export function fieldRows(fields: readonly FormField[]): number[][] {
  const rows: number[][] = [];
  let lastReal: number[] | null = null;
  let breaksNext = true; // the start of the form breaks a row
  let prevSection: string | undefined;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.kind === "hidden") {
      rows.push([i]);
      continue;
    }
    const isStatement = field.kind === "statement";
    if (
      !isStatement &&
      !breaksNext &&
      field.beside &&
      lastReal &&
      lastReal.length < MAX_ROW_CELLS &&
      field.section === prevSection
    ) {
      lastReal.push(i);
    } else {
      const row = [i];
      rows.push(row);
      lastReal = row;
    }
    breaksNext = isStatement;
    prevSection = field.section;
  }
  return rows;
}

/* ---------------------------------------------------- rename, sections, logic --- */

/**
 * Renames a question **and every rule that names it**: every `showIf` and
 * `requireIf`, and every section's `showIf`. The builder's name input goes through
 * this rather than `updateField`, because a plain rename would leave each
 * dependent rule pointing at nothing, which `checkFormLogic` then refuses.
 */
export function renameField(
  fields: readonly FormField[],
  layout: FormLayout,
  from: string,
  to: string,
): { fields: FormField[]; layout: FormLayout } {
  if (from === to) return { fields: [...fields], layout };
  const rewrite = (field: FormField): FormField => {
    const next: FormField = field.name === from ? { ...field, name: to } : { ...field };
    if (field.showIf) next.showIf = renameInCondition(field.showIf, from, to);
    if (field.requireIf) next.requireIf = renameInCondition(field.requireIf, from, to);
    return next;
  };
  const sections = layout.sections?.map((s) =>
    s.showIf ? { ...s, showIf: renameInCondition(s.showIf, from, to) } : s,
  );
  return {
    fields: fields.map(rewrite),
    layout: sections ? { ...layout, sections } : layout,
  };
}

/** Sections with no members dropped: what is left after a removal emptied one. */
export function pruneSections(fields: readonly FormField[], layout: FormLayout): FormLayout {
  const used = new Set(fields.flatMap((f) => (f.section === undefined ? [] : [f.section])));
  const sections = (layout.sections ?? []).filter((s) => used.has(s.name));
  return sections.length > 0 ? { sections } : {};
}

function withoutSection(field: FormField): FormField {
  const next = { ...field };
  delete next.section;
  return next;
}

/** The index range `[first, last]` of the run of questions sharing `fields[at]`'s
 *  section (or lack of one), extending both ways from `at`. */
function runAround(fields: readonly FormField[], at: number): [number, number] {
  const section = fields[at]?.section;
  let first = at;
  let last = at;
  while (first > 0 && fields[first - 1]?.section === section) first -= 1;
  while (last < fields.length - 1 && fields[last + 1]?.section === section) last += 1;
  return [first, last];
}

/**
 * A new section starting at the question `name`, running to the end of whatever
 * run that question is in. Membership stays contiguous by construction: the earlier
 * part of the run keeps its section (or none), the rest joins the new one. A section
 * this empties is dropped.
 */
export function startSection(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
  label = "New section",
): { fields: FormField[]; layout: FormLayout; section: string } | null {
  const at = fields.findIndex((f) => f.name === name);
  if (at === -1) return null;
  const [, last] = runAround(fields, at);
  const taken = (layout.sections ?? []).map((s) => s.name);
  const section = uniqueFieldName("section", taken);
  const next = fields.map((f, i) => (i >= at && i <= last ? { ...f, section } : f));
  const created: FormSection = { name: section, label };
  return {
    fields: next,
    layout: pruneSections(next, { sections: [...(layout.sections ?? []), created] }),
    section,
  };
}

/** Ends the section the question `name` is in **after** it: the questions below it
 *  in the same run lose their membership. */
export function endSectionAfter(fields: readonly FormField[], name: string): FormField[] {
  const at = fields.findIndex((f) => f.name === name);
  const section = fields[at]?.section;
  if (at === -1 || section === undefined) return [...fields];
  const [, last] = runAround(fields, at);
  return fields.map((f, i) => (i > at && i <= last ? withoutSection(f) : f));
}

/** Removes a section; its questions keep their place and lose their membership. */
export function removeSection(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
): { fields: FormField[]; layout: FormLayout } {
  const next = fields.map((f) => (f.section === name ? withoutSection(f) : f));
  const sections = (layout.sections ?? []).filter((s) => s.name !== name);
  return { fields: next, layout: sections.length > 0 ? { sections } : {} };
}

/** Replaces the section named `name` with `next`. */
export function updateSection(layout: FormLayout, name: string, next: FormSection): FormLayout {
  return { sections: (layout.sections ?? []).map((s) => (s.name === name ? next : s)) };
}

/** The refusal `checkFormLogic` would give this form, as a string, or null. The
 *  builder shows exactly the message the server would send, and disables Save. */
export function logicRefusal(fields: readonly FormField[], layout: FormLayout): string | null {
  try {
    checkFormLogic(fields, layout);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "These rules cannot be saved.";
  }
}

/* ------------------------------------------------------------ options --- */

export function addOption(field: FormField): FormField {
  const options = field.options ?? [];
  const values = options.map((o) => o.value);
  const value = uniqueFieldName(`option_${options.length + 1}`, values);
  return { ...field, options: [...options, { value, label: `Option ${options.length + 1}` }] };
}

/**
 * Options are addressed by position, not by value: the value is what the
 * editor is changing, and mid-edit it can collide with a sibling's (typing
 * `b2` passes through `b`), at which point a value match edits both rows.
 */
export function removeOption(
  field: FormField,
  index: number,
  /** The form the option is in. Given, a rule that compares against this option's
   *  value refuses the removal (`optionRefusal`) and the field comes back as it was. */
  ctx?: { fields: readonly FormField[]; layout: FormLayout },
): FormField {
  const value = field.options?.[index]?.value;
  if (ctx && value !== undefined && optionRefusal(ctx.fields, ctx.layout, field.name, value)) {
    return field;
  }
  return { ...field, options: (field.options ?? []).filter((_, i) => i !== index) };
}

/** Why the option `value` of question `name` cannot be removed, or null: a rule
 *  somewhere compares against it. */
export function optionRefusal(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
  value: string,
): string | null {
  const holders = [
    ...fields.filter(
      (f) => comparesValue(f.showIf, name, value) || comparesValue(f.requireIf, name, value),
    ),
  ].map((f) => `"${f.label || f.name}"`);
  for (const s of layout.sections ?? []) {
    if (comparesValue(s.showIf, name, value)) holders.push(`section "${s.label}"`);
  }
  return holders.length === 0
    ? null
    : `A rule on ${holders.join(", ")} compares against this option. Change that rule first.`;
}

export function updateOption(field: FormField, index: number, next: FormFieldOption): FormField {
  return { ...field, options: (field.options ?? []).map((o, i) => (i === index ? next : o)) };
}

/* -------------------------------------------------------------- locale --- */

/** The three keys a field's own prose can be translated under
 *  (`FormFieldI18n`; options are keyed separately, by value). */
export type TranslatableKey = "label" | "help" | "placeholder";

/**
 * One string, in whichever locale is active. `source` is the render's source
 * locale (`LocaleConfig.default`) — editing it writes the base field, exactly
 * as `inspector-model.ts`'s `'source'` field mode does for a document; editing
 * anything else writes `i18n[locale]`, unfilled where nothing has been typed
 * (`inspector-model.ts`'s `'translate'` mode: never pre-filled with the
 * fallback, or "untranslated" becomes unreachable).
 */
export function fieldText(
  field: FormField,
  key: TranslatableKey,
  locale: string,
  source: string,
): string {
  if (locale === source) return field[key] ?? "";
  return field.i18n?.[locale]?.[key] ?? "";
}

/** The inverse of `fieldText`. An empty translation clears the key (and the
 *  locale entry, once nothing is left in it) rather than storing `''` — the
 *  same "hole, not a stored emptiness" rule `validateFieldI18n` reads back
 *  under, so a cleared translation actually falls through to the source. */
export function withFieldText(
  field: FormField,
  key: TranslatableKey,
  value: string,
  locale: string,
  source: string,
): FormField {
  if (locale !== source) {
    return { ...field, i18n: setI18nKey(field.i18n, locale, key, value) };
  }
  // `label` is the one of the three that is required, never optional
  // (`validateFormFields` throws on an empty one) — so the source write for it
  // always sets the string, empty or not, rather than deleting the key the way
  // `help` and `placeholder` do.
  if (key === "label") return { ...field, label: value };
  if (key === "help") {
    const next = { ...field };
    if (value === "") {
      delete next.help;
      return next;
    }
    return { ...next, help: value };
  }
  const next = { ...field };
  if (value === "") {
    delete next.placeholder;
    return next;
  }
  return { ...next, placeholder: value };
}

export function optionLabel(
  field: FormField,
  value: string,
  locale: string,
  source: string,
): string {
  if (locale === source) return field.options?.find((o) => o.value === value)?.label ?? "";
  return field.i18n?.[locale]?.options?.[value] ?? "";
}

export function withOptionLabel(
  field: FormField,
  value: string,
  label: string,
  locale: string,
  source: string,
): FormField {
  if (locale === source) {
    const index = (field.options ?? []).findIndex((o) => o.value === value);
    return index === -1 ? field : updateOption(field, index, { value, label });
  }
  const current = field.i18n?.[locale]?.options ?? {};
  const options = { ...current };
  if (label === "") delete options[value];
  else options[value] = label;
  const entry: FormFieldI18n = { ...field.i18n?.[locale] };
  if (Object.keys(options).length > 0) entry.options = options;
  else delete entry.options;
  return { ...field, i18n: replaceI18nEntry(field.i18n, locale, entry) };
}

function setI18nKey(
  i18n: Record<string, FormFieldI18n> | undefined,
  locale: string,
  key: TranslatableKey,
  value: string,
): Record<string, FormFieldI18n> | undefined {
  const entry: FormFieldI18n = { ...i18n?.[locale] };
  if (value === "") delete entry[key];
  else entry[key] = value;
  return replaceI18nEntry(i18n, locale, entry);
}

/** Writes `entry` under `locale`, dropping the whole locale key once it holds
 *  nothing — an `i18n` map with an empty object under a locale is a hole a
 *  later reader (`translate()` in `server/forms.ts`) would have to learn to
 *  ignore twice. */
function replaceI18nEntry(
  i18n: Record<string, FormFieldI18n> | undefined,
  locale: string,
  entry: FormFieldI18n,
): Record<string, FormFieldI18n> | undefined {
  const next = { ...i18n };
  if (Object.keys(entry).length > 0) next[locale] = entry;
  else delete next[locale];
  return Object.keys(next).length > 0 ? next : undefined;
}

/* ---------------------------------------------------------- closesAt --- */

/** `closesAt` as `<input type="datetime-local">` wants it — local time, no
 *  timezone — or `''` for no closing date at all. */
export function closesAtInputValue(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The inverse. `''` is "no closing date", not "midnight of the epoch" — the
 *  distinction `FormPatchBody.closesAt`'s optional-and-nullable pair exists
 *  for (absent leaves it alone, `null` clears it; this screen always sends
 *  one or the other, never absent, since the field is always shown). */
export function closesAtFromInput(value: string): number | null {
  if (value.trim() === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
