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
import type { Json } from "../../../core/doc";
import type { Field } from "../../../core/fields";
import {
  type ActionInputInfo,
  type ActionSettingValue,
  attachmentProblems,
  type FormActionAttachment,
  type FormActionInfo,
  INPUT_ACCEPTS,
  MAX_FORM_ACTIONS,
} from "../../../core/form-actions";
import {
  checkFormLogic,
  type FormField,
  type FormFieldI18n,
  type FormFieldKind,
  type FormFieldOption,
  type FormLayout,
  type FormSection,
  type FormStep,
  honeypotName,
  MAX_FORM_STEPS,
  MAX_ROW_CELLS,
  RESERVED_PREFIX,
} from "../../../core/forms";
import type { LocaleConfig } from "../../../core/locales";
import { CONTENT_SOURCE, materialiseOptions, type OptionsFrom } from "../../../core/option-sources";
import type { DocumentType } from "../../../core/schema";
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

/** The one option `blankField` seeds, so a question is valid the moment it is added. */
export const SEEDED_OPTION: Readonly<FormFieldOption> = { value: "option_1", label: "Option 1" };

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
    field.options = [{ ...SEEDED_OPTION }];
  }
  if (kind === "file") field.accept = "documents";
  if (kind === "statement") field.text = label;
  return field;
}

/* ------------------------------------------------------------- reducers --- */

export const MAX_FIELDS_REACHED = (limit: number) => `A form may hold at most ${limit} questions.`;

/** Appends a new question. On a stepped form it joins the last step
 *  (`form-steps.md` decision 14), so membership stays contiguous. */
export function addField(
  fields: readonly FormField[],
  kind: FormFieldKind,
  formId: string,
  layout: FormLayout = {},
): FormField[] {
  const field = blankField(kind, { formId, existing: fields });
  const last = layout.steps?.[layout.steps.length - 1];
  if (last) field.step = last.name;
  return [...fields, field];
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
 * The attachments and registry a question edit is checked against
 * (`form-actions.md` decision 5). Absent means the form has none, which is every
 * call that predates spec 36.
 */
export interface ActionContext {
  attachments: readonly FormActionAttachment[];
  infos: ReadonlyMap<string, FormActionInfo>;
}

/** The inputs of every attachment that read the question `name`, with the action's
 *  label (its id when the registry no longer lists it). */
export function actionReaders(
  ctx: ActionContext | undefined,
  name: string,
): { action: string; label: string; input: string }[] {
  const out: { action: string; label: string; input: string }[] = [];
  for (const a of ctx?.attachments ?? []) {
    const info = ctx?.infos.get(a.action);
    for (const [input, question] of Object.entries(a.map ?? {})) {
      if (question !== name) continue;
      const declared = info?.inputs.find((i) => i.name === input);
      out.push({
        action: a.action,
        label: info?.label ?? a.action,
        input: (declared?.label ?? input).toLowerCase(),
      });
    }
  }
  return out;
}

/**
 * Why `name` cannot be removed, or null. A question another question's rule (or a
 * section's or step's) names is not removable: the rule would dangle, and `checkFormLogic`
 * would refuse the save. So is one an action reads (`form-actions.md` decision 5),
 * with the action named. The builder disables the button with this as the reason.
 */
export function removeRefusal(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
  actions?: ActionContext,
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
  for (const s of layout.steps ?? []) {
    if (referencedNames(s.showIf).includes(name)) {
      return `Step "${s.label}" has a rule that depends on "${label}". Change that rule first.`;
    }
  }
  const own = fields.find((f) => f.name === name);
  const step = own?.step === undefined ? undefined : layout.steps?.find((s) => s.name === own.step);
  if (step && own && own.kind !== "hidden") {
    const others = fields.filter((f) => f.step === step.name && f.name !== name);
    if (!others.some((f) => f.kind !== "hidden")) {
      return `"${label}" is the only question on step "${step.label}". Move another question onto the step, or merge the step into the one before it, first.`;
    }
  }
  const reader = actionReaders(actions, name)[0];
  if (reader) {
    return `${reader.label} reads its ${reader.input} from this question. Change the mapping first.`;
  }
  return null;
}

/**
 * Why `next` cannot replace the question `name`, or null: a retype to a kind the
 * input does not accept, or a required input's question made optional or
 * conditional, would leave an attachment with a problem it did not have
 * (decision 5). Only problems about this question count, and only new ones: a
 * question an already-broken attachment reads can still be edited.
 */
export function changeRefusal(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
  next: FormField,
  actions?: ActionContext,
): string | null {
  if (!actions || actions.attachments.length === 0) return null;
  const after = fields.map((f) => (f.name === name ? next : f));
  for (const a of actions.attachments) {
    const info = actions.infos.get(a.action);
    if (!info) continue;
    const reads = Object.values(a.map ?? {}).includes(name);
    if (!reads) continue;
    const before = new Set(attachmentProblems(a, info, fields, layout));
    for (const problem of attachmentProblems(a, info, after, layout)) {
      if (!before.has(problem)) {
        return `${info.label} reads this question: ${problem}. Change the mapping first.`;
      }
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
  actions?: ActionContext,
): FormField[] {
  if (removeRefusal(fields, layout, name, actions) !== null) return [...fields];
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
  let prevStep: string | undefined;
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
      field.section === prevSection &&
      field.step === prevStep;
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
    prevStep = field.step;
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
  actions?: ActionContext,
): boolean {
  return moveRefusal(fields, index, direction, layout, actions) === null;
}

/**
 * Why the question at `index` cannot move `direction`, or null. "Already first" and
 * "Already last" when there is nowhere to go. On a stepped form a move across a
 * boundary is refused when it would empty a step of visible questions, carry a
 * section member across, put a rule above what it names, or put a `requireIf` source
 * on a later step (`form-steps.md` decision 14), with `checkFormLogic`'s own sentence
 * for the reason. It also refuses what would make an action's attachment worse
 * (spec 36 decision 5): a mapped question moved onto a conditional step.
 */
export function moveRefusal(
  fields: readonly FormField[],
  index: number,
  direction: -1 | 1,
  layout: FormLayout = {},
  actions?: ActionContext,
): string | null {
  if (!canStep(fields, index, direction))
    return direction === -1 ? "Already first" : "Already last";
  const after = movedFields(fields, index, direction, layout);
  if (spoilsOrder(fields, after, layout)) {
    return (
      logicRefusal(after, layout) ??
      "That would put a rule above the question it depends on, or split a section."
    );
  }
  const moved = fields[index]!;
  const landed = after.find((f) => f.name === moved.name);
  if (landed && landed.step !== moved.step) {
    const step = layout.steps?.find((s) => s.name === landed.step);
    const reader = step?.showIf ? requiredReader(actions, landed.name) : null;
    if (step && reader) {
      return `${reader} reads "${landed.label || landed.name}" and needs it answered, and step "${step.label}" is conditional. Change the mapping first.`;
    }
  }
  return null;
}

/** The label of an action whose required input reads the question `name`, or null. */
function requiredReader(actions: ActionContext | undefined, name: string): string | null {
  for (const a of actions?.attachments ?? []) {
    const info = actions?.infos.get(a.action);
    if (!info) continue;
    for (const [input, question] of Object.entries(a.map ?? {})) {
      if (question === name && info.inputs.find((i) => i.name === input)?.required) {
        return info.label;
      }
    }
  }
  return null;
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
  actions?: ActionContext,
): FormField[] {
  return moveRefusal(fields, index, direction, layout, actions) === null
    ? movedFields(fields, index, direction, layout)
    : [...fields];
}

/** `stepFields`, and on a stepped form a question that jumped a step boundary joins
 *  the step of the question it jumped (decision 14): the first member moving up lands
 *  on the previous step, the last moving down on the next. Both neighbours of the
 *  seam lose a `beside` that would now join them across it. */
function movedFields(
  fields: readonly FormField[],
  index: number,
  direction: -1 | 1,
  layout: FormLayout,
): FormField[] {
  const after = stepFields(fields, index, direction);
  if (!layout.steps?.length) return after;
  const mover = fields[index];
  if (!mover) return after;
  const at = after.findIndex((f) => f.name === mover.name);
  if (at === -1 || at === index) return after;
  const near = after[direction === -1 ? at + 1 : at - 1];
  if (!near || near.step === mover.step) return after;
  const next = [...after];
  const joined = { ...after[at]! };
  if (near.step === undefined) delete joined.step;
  else joined.step = near.step;
  next[at] = detached(joined);
  detachFirstRealAt(next, at + 1);
  return next;
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
  if (orderFaulty(after, layout) && !orderFaulty(before, layout)) return true;
  // On a stepped form the whole of `checkFormLogic` is the test: contiguity, an
  // emptied step, a step rule above its source, a `requireIf` on a later step.
  return (
    layout.steps !== undefined &&
    layout.steps.length > 0 &&
    logicRefusal(after, layout) !== null &&
    logicRefusal(before, layout) === null
  );
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
    if (field.name === name) {
      // A step boundary starts a fresh row (`rowsOf`), as a statement does.
      return previous !== null && previous.kind !== "statement" && previous.step === field.step;
    }
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
  let prevStep: string | undefined;
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
      field.section === prevSection &&
      field.step === prevStep
    ) {
      lastReal.push(i);
    } else {
      const row = [i];
      rows.push(row);
      lastReal = row;
    }
    breaksNext = isStatement;
    prevSection = field.section;
    prevStep = field.step;
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
  actions: readonly FormActionAttachment[] = [],
): { fields: FormField[]; layout: FormLayout; actions: FormActionAttachment[] } {
  if (from === to) return { fields: [...fields], layout, actions: [...actions] };
  const rewrite = (field: FormField): FormField => {
    const next: FormField = field.name === from ? { ...field, name: to } : { ...field };
    if (field.showIf) next.showIf = renameInCondition(field.showIf, from, to);
    if (field.requireIf) next.requireIf = renameInCondition(field.requireIf, from, to);
    return next;
  };
  const sections = layout.sections?.map((s) =>
    s.showIf ? { ...s, showIf: renameInCondition(s.showIf, from, to) } : s,
  );
  const steps = layout.steps?.map((s) =>
    s.showIf ? { ...s, showIf: renameInCondition(s.showIf, from, to) } : s,
  );
  // An action's mapping follows the rename, in the same save (decision 5).
  const follow = (a: FormActionAttachment): FormActionAttachment => {
    if (!a.map || !Object.values(a.map).includes(from)) return a;
    return {
      ...a,
      map: Object.fromEntries(Object.entries(a.map).map(([k, v]) => [k, v === from ? to : v])),
    };
  };
  return {
    fields: fields.map(rewrite),
    layout: { ...layout, ...(sections ? { sections } : {}), ...(steps ? { steps } : {}) },
    actions: actions.map(follow),
  };
}

/** A layout of `sections` and `steps`, leaving out whichever is empty. */
function layoutOf(sections: readonly FormSection[], steps: readonly FormStep[]): FormLayout {
  return {
    ...(sections.length > 0 ? { sections } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

/** Sections and steps with no members dropped: what is left after a removal emptied one. */
export function pruneSections(fields: readonly FormField[], layout: FormLayout): FormLayout {
  const used = new Set(fields.flatMap((f) => (f.section === undefined ? [] : [f.section])));
  const usedSteps = new Set(fields.flatMap((f) => (f.step === undefined ? [] : [f.step])));
  return layoutOf(
    (layout.sections ?? []).filter((s) => used.has(s.name)),
    (layout.steps ?? []).filter((s) => usedSteps.has(s.name)),
  );
}

function withoutSection(field: FormField): FormField {
  const next = { ...field };
  delete next.section;
  return next;
}

/** The index range `[first, last]` of the run of questions sharing `fields[at]`'s
 *  section (or lack of one) **and step**, extending both ways from `at`: a section
 *  lies inside one step. */
function runAround(fields: readonly FormField[], at: number): [number, number] {
  const section = fields[at]?.section;
  const step = fields[at]?.step;
  const same = (f: FormField | undefined) => f?.section === section && f?.step === step;
  let first = at;
  let last = at;
  while (first > 0 && same(fields[first - 1])) first -= 1;
  while (last < fields.length - 1 && same(fields[last + 1])) last += 1;
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
    layout: pruneSections(next, { ...layout, sections: [...(layout.sections ?? []), created] }),
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
  return { fields: next, layout: layoutOf(sections, layout.steps ?? []) };
}

/** Replaces the section named `name` with `next`. */
export function updateSection(layout: FormLayout, name: string, next: FormSection): FormLayout {
  return { ...layout, sections: (layout.sections ?? []).map((s) => (s.name === name ? next : s)) };
}

/* ---------------------------------------------------------------- steps --- */

/** The first free `step_N`: `uniqueFieldName`'s pattern, counted from 1. */
function stepName(taken: readonly string[]): string {
  for (let i = 1; ; i++) {
    const candidate = `step_${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

function withStep(field: FormField, step: string | undefined): FormField {
  const next = { ...field };
  if (step === undefined) delete next.step;
  else next.step = step;
  return next;
}

/** The first and last index of the step `name`'s members, or null. */
function stepRange(fields: readonly FormField[], name: string): [number, number] | null {
  const first = fields.findIndex((f) => f.step === name);
  if (first === -1) return null;
  let last = first;
  while (last + 1 < fields.length && fields[last + 1]?.step === name) last += 1;
  return [first, last];
}

/**
 * Why a new step cannot start at index `at`, or null: the shared rules of
 * `splitStepsAt` and `startStepAt`. `lo..hi` is the run being cut. Every refusal is
 * a way the write path would otherwise refuse the form (a section cut in two, a step
 * with nothing visible), then `checkFormLogic` itself over the result, which is the
 * guarantee that a builder action never makes a form `logicRefusal` rejects: this
 * catches a `requireIf` whose source would land on a later step.
 */
function cutRefusal(
  fields: readonly FormField[],
  layout: FormLayout,
  after: { fields: FormField[]; layout: FormLayout },
  at: number,
  [lo, hi]: [number, number],
): string | null {
  const above = fields[at - 1];
  const here = fields[at]!;
  if (above && above.section !== undefined && above.section === here.section) {
    const section = layout.sections?.find((s) => s.name === here.section);
    return `This would cut the section "${section?.label ?? here.section}" in two. End the section first.`;
  }
  const visible = (from: number, to: number) =>
    fields.slice(from, to).some((f) => f.kind !== "hidden");
  if (!visible(lo, at)) return "The step above would have no question a visitor can see.";
  if (!visible(at, hi + 1)) return "The new step would have no question a visitor can see.";
  if (logicRefusal(fields, layout) === null) return logicRefusal(after.fields, after.layout);
  return null;
}

function splitCandidate(
  fields: readonly FormField[],
  layout: FormLayout,
  at: number,
): { fields: FormField[]; layout: FormLayout } {
  const steps: FormStep[] = [
    { name: "step_1", label: "Step 1" },
    { name: "step_2", label: "Step 2" },
  ];
  return {
    fields: fields.map((f, i) => withStep(f, i < at ? "step_1" : "step_2")),
    layout: layoutOf(layout.sections ?? [], steps),
  };
}

/** Why `name` cannot start a step on a form with none, or null. */
export function splitRefusal(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
): string | null {
  if (layout.steps?.length) return "This form already has steps. Start a new step instead.";
  const at = fields.findIndex((f) => f.name === name);
  if (at === -1) return "That question is not on the form.";
  if (at === 0) return "Nothing is above this question to split from.";
  return cutRefusal(fields, layout, splitCandidate(fields, layout, at), at, [0, fields.length - 1]);
}

/**
 * Splits an unstepped form at the question `name`: step 1 is everything above it
 * and step 2 everything from it down (`form-steps.md` decision 14). Membership is
 * contiguous by construction. `null` when `splitRefusal` refuses.
 */
export function splitStepsAt(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
): { fields: FormField[]; layout: FormLayout; step: string } | null {
  if (splitRefusal(fields, layout, name) !== null) return null;
  const at = fields.findIndex((f) => f.name === name);
  return { ...splitCandidate(fields, layout, at), step: "step_2" };
}

/** Why `name` cannot start a new step, or null: not first in its step, under the cap. */
export function startStepRefusal(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
): string | null {
  const steps = layout.steps ?? [];
  const at = fields.findIndex((f) => f.name === name);
  if (at === -1) return "That question is not on the form.";
  const own = fields[at]!.step;
  const range = own === undefined ? null : stepRange(fields, own);
  if (steps.length === 0 || !range) return "This form has no steps. Split it into steps instead.";
  if (range[0] === at) return "This question already starts its step.";
  if (steps.length >= MAX_FORM_STEPS) return `A form may hold at most ${MAX_FORM_STEPS} steps.`;
  return cutRefusal(fields, layout, startedStep(fields, layout, at, range), at, range);
}

function startedStep(
  fields: readonly FormField[],
  layout: FormLayout,
  at: number,
  [, hi]: [number, number],
): { fields: FormField[]; layout: FormLayout; step: string } {
  const steps = layout.steps ?? [];
  const step = stepName(steps.map((s) => s.name));
  const current = steps.findIndex((s) => s.name === fields[at]!.step);
  const created: FormStep = { name: step, label: "New step" };
  return {
    fields: fields.map((f, i) => (i >= at && i <= hi ? withStep(f, step) : f)),
    layout: layoutOf(layout.sections ?? [], [
      ...steps.slice(0, current + 1),
      created,
      ...steps.slice(current + 1),
    ]),
    step,
  };
}

/**
 * A new step starting at the question `name`, running to the end of its step. The
 * earlier part keeps the step (and its condition); the new one starts unconditional
 * and is listed right after it, so step order stays member order. `null` when
 * `startStepRefusal` refuses.
 */
export function startStepAt(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
): { fields: FormField[]; layout: FormLayout; step: string } | null {
  if (startStepRefusal(fields, layout, name) !== null) return null;
  const at = fields.findIndex((f) => f.name === name);
  const range = stepRange(fields, fields[at]!.step!)!;
  return startedStep(fields, layout, at, range);
}

/** Why step `name` cannot merge into the one before it, or null. */
export function mergeRefusal(
  layout: FormLayout,
  name: string,
  fields?: readonly FormField[],
  actions?: ActionContext,
): string | null {
  const steps = layout.steps ?? [];
  const at = steps.findIndex((s) => s.name === name);
  if (at === -1) return "That step is not on the form.";
  if (at === 0) return "The first step has nothing before it to merge into.";
  // Landing on a conditional step must not leave an action's required input
  // sometimes unanswered (decision 14), the same guard as a move.
  const into = steps[at - 1]!;
  if (fields && into.showIf) {
    const after = fields.map((f) => (f.step === name ? withStep(f, into.name) : f));
    return stepRuleRefusal(after, into.name, actions);
  }
  return null;
}

/**
 * Folds step `name` into the one before it: its questions join that step and its
 * heading and condition go. Contiguity cannot break: the two were already adjacent.
 */
export function mergeStepIntoPrevious(
  fields: readonly FormField[],
  layout: FormLayout,
  name: string,
  actions?: ActionContext,
): { fields: FormField[]; layout: FormLayout; step: string } | null {
  if (mergeRefusal(layout, name, fields, actions) !== null) return null;
  const steps = layout.steps ?? [];
  const at = steps.findIndex((s) => s.name === name);
  const into = steps[at - 1]!.name;
  return {
    fields: fields.map((f) => (f.step === name ? withStep(f, into) : f)),
    layout: layoutOf(
      layout.sections ?? [],
      steps.filter((s) => s.name !== name),
    ),
    step: into,
  };
}

/** Clears every step and every membership; sections and questions stay where they are. */
export function removeSteps(
  fields: readonly FormField[],
  layout: FormLayout,
): { fields: FormField[]; layout: FormLayout } {
  return {
    fields: fields.map((f) => (f.step === undefined ? f : withStep(f, undefined))),
    layout: layoutOf(layout.sections ?? [], []),
  };
}

/** Replaces the step named `name` with `next`. */
export function updateStep(layout: FormLayout, name: string, next: FormStep): FormLayout {
  return { ...layout, steps: (layout.steps ?? []).map((s) => (s.name === name ? next : s)) };
}

/**
 * Why step `name` cannot be made conditional, or null: an action's required input
 * reads a question on it, which would then sometimes have no answer (spec 36
 * decision 5 reaches steps the way it reaches a section's condition).
 */
export function stepRuleRefusal(
  fields: readonly FormField[],
  name: string,
  actions?: ActionContext,
): string | null {
  for (const f of fields) {
    if (f.step !== name) continue;
    const reader = requiredReader(actions, f.name);
    if (reader) {
      return `${reader} needs "${f.label || f.name}" answered, so this step cannot be conditional. Change the mapping first.`;
    }
  }
  return null;
}

/** A group's label or help in `locale` (the source's own, or its translation). */
export function groupText(
  group: FormSection | FormStep,
  key: "label" | "help",
  locale: string,
  source: string,
): string {
  return locale !== source ? (group.i18n?.[locale]?.[key] ?? "") : (group[key] ?? "");
}

/** `group` with its label or help set in `locale`: the source's own text, or a
 *  translation, cleared when emptied. One function for sections and steps. */
export function withGroupText<T extends FormSection | FormStep>(
  group: T,
  key: "label" | "help",
  value: string,
  locale: string,
  source: string,
): T {
  if (locale === source) {
    const next: T = { ...group, [key]: value };
    if (key === "help" && value === "") delete next.help;
    return next;
  }
  const entry: { label?: string; help?: string } = { ...group.i18n?.[locale] };
  if (value === "") delete entry[key];
  else entry[key] = value;
  const i18n: Record<string, { label?: string; help?: string }> = { ...group.i18n };
  if (Object.keys(entry).length > 0) i18n[locale] = entry;
  else delete i18n[locale];
  const next: T = { ...group };
  if (Object.keys(i18n).length > 0) next.i18n = i18n;
  else delete next.i18n;
  return next;
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

/* ------------------------------------------------------- option sources --- */

/**
 * What `GET {base}/api/forms/registry` answers for one host source
 * (`form-option-sources.md` decision 17). Metadata only; `content` is not listed
 * because it is built in.
 */
export interface FormSourceInfo {
  id: string;
  label: string;
  settings: Record<string, Field>;
  ttl: number;
  localised: boolean;
}

/** What `POST {base}/api/forms/:id/option-preview` answers (decision 14). */
export interface OptionPreview {
  options: FormFieldOption[];
  total: number;
  truncated: boolean;
  status: "fresh" | "stale" | "never-loaded" | "unknown-source";
  loadedAt: number | null;
  failure?: "timeout" | "threw" | "malformed" | "empty";
}

/** How many labels the preview names before "and N more". */
export const PREVIEW_LABELS = 10;

/** The four setting kinds a host source may declare (`OptionSourceSetting`). */
export type SettingKind = "text" | "number" | "boolean" | "select";

/**
 * The question with its source chosen, or removed when `next` is undefined.
 *
 * Choosing a source drops `blankField`'s seeded option **only when the typed list is
 * still exactly that**: an editor who has typed their own extras keeps them (they are
 * the "Also offer" list), and one who never touched the question gets a source with no
 * stray "Option 1" under it. Going back to typed options re-seeds, because an option
 * question with nothing to offer does not validate.
 */
export function withOptionsFrom(field: FormField, next: OptionsFrom | undefined): FormField {
  const out: FormField = { ...field };
  if (next === undefined) {
    delete out.optionsFrom;
    if ((out.options ?? []).length === 0) out.options = [{ ...SEEDED_OPTION }];
    return out;
  }
  out.optionsFrom = next;
  if (isSeededOptions(out.options)) delete out.options;
  return out;
}

/** Whether a typed list is exactly the untouched seed. */
export function isSeededOptions(options: readonly FormFieldOption[] | undefined): boolean {
  return (
    options !== undefined &&
    options.length === 1 &&
    options[0]?.value === SEEDED_OPTION.value &&
    options[0]?.label === SEEDED_OPTION.label
  );
}

/** The fewest typed options a question may keep: none when a source supplies the rest. */
export function minTypedOptions(field: FormField): number {
  return field.optionsFrom ? 0 : 1;
}

/** A source's descriptor as first chosen: a host source starts from its settings'
 *  declared defaults, `content` from the first page or record type (the one thing it
 *  cannot be saved without). */
export function blankOptionsFrom(
  source: string,
  info: FormSourceInfo | undefined,
  types: readonly DocumentType[],
): OptionsFrom {
  if (source === CONTENT_SOURCE) {
    const first = contentTypes(types)[0];
    return { source, settings: first ? { type: first.name } : {} };
  }
  const settings: Record<string, Json> = {};
  for (const [name, def] of Object.entries(info?.settings ?? {})) {
    const fallback = (def as { default?: unknown }).default;
    if (fallback !== undefined) settings[name] = fallback as Json;
  }
  return { source, settings };
}

/** The types a `content` source may list: pages and records, never a singleton. */
export function contentTypes(types: readonly DocumentType[]): DocumentType[] {
  return types.filter((t) => t.kind === "page" || t.kind === "record");
}

/** `optionsFrom` with one setting changed; an empty value removes the key. */
export function withSetting(from: OptionsFrom, name: string, value: Json | undefined): OptionsFrom {
  const settings: Record<string, Json> = { ...from.settings };
  if (value === undefined || value === "") delete settings[name];
  else settings[name] = value;
  return { ...from, settings };
}

/** The key an `optionsFrom` and a locale preview under, so a repeated commit of the
 *  same thing does not ask the server again. */
export function previewKeyOf(from: OptionsFrom, locale: string): string {
  return JSON.stringify([from, locale]);
}

/**
 * Whether a preview has anything to ask. A `content` source with no type is not a
 * query yet, and asking would only answer a `400` the editor can already see.
 */
export function previewable(from: OptionsFrom | undefined): from is OptionsFrom {
  if (!from) return false;
  if (from.source !== CONTENT_SOURCE) return true;
  const type = from.settings?.type;
  return typeof type === "string" && type !== "";
}

/**
 * The preview's one-line status for a host source (decision 14): `fresh`,
 * `stale since <time>`, or `never loaded: <category>`. Nothing for `content`, whose
 * list is read live and has no freshness to report.
 */
export function previewStatusText(
  preview: OptionPreview,
  format: (at: number) => string = (at) => new Date(at).toLocaleString(),
): string | null {
  if (preview.status === "fresh") return preview.loadedAt === null ? null : "Fresh";
  if (preview.status === "stale") {
    return preview.loadedAt === null ? "Stale" : `Stale since ${format(preview.loadedAt)}`;
  }
  if (preview.status === "never-loaded") {
    return preview.failure ? `Never loaded: ${preview.failure}` : "Never loaded";
  }
  return "Unknown source";
}

/** The "N options" line, and what was cut. */
export function previewSummary(preview: OptionPreview): string {
  const n = preview.options.length;
  const noun = n === 1 ? "option" : "options";
  return preview.truncated
    ? `${preview.total} ${preview.total === 1 ? "option" : "options"} match, first ${n} shown`
    : `${n} ${noun}`;
}

/**
 * Decision 18's warning: a required content-sourced question whose list is empty and
 * which has no typed extras is not asked at all, so the form quietly stops collecting
 * it. Only a list that was actually read and was empty warns: an outage or an unknown
 * source is a different problem with its own line.
 */
export function emptyRequiredWarning(
  field: FormField,
  preview: OptionPreview | null,
): string | null {
  if (field.optionsFrom?.source !== CONTENT_SOURCE || field.required !== true) return null;
  if ((field.options ?? []).length > 0) return null;
  if (!preview || preview.options.length > 0 || preview.total > 0) return null;
  return "No published documents match. Until one does, this question is not asked";
}

/**
 * The list a rule on a sourced question can compare against: the previewed list
 * merged with the typed extras, exactly as the page will offer it
 * (`materialiseOptions`, decision 11). A sourced question whose list is not known yet
 * loses its `options` altogether, so the rule editor offers a free-text value rather
 * than a menu of only the extras, which would read as the complete set.
 */
export function withListedOptions(
  sources: readonly FormField[],
  lists: Readonly<Record<string, readonly FormFieldOption[]>>,
): FormField[] {
  return sources.map((field) => {
    if (!field.optionsFrom) return field;
    const list = lists[field.name];
    if (list) return materialiseOptions(field, list);
    const { options: _typed, ...rest } = field;
    return rest;
  });
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

/* --------------------------------------------------------------- actions --- */

/**
 * The reducers behind the Actions section (`form-actions.md` phase 5). Pure, and
 * each returns a new array: the builder holds the draft, the server is the one
 * validator (`validateFormActions`, `attachmentProblems`), and nothing here is a
 * second copy of it beyond what saves a round trip.
 */

/** The registered actions an editor may still attach: one attachment per action
 *  (decision 7), and none at all once the form is full. */
export function offerableActions(
  infos: readonly FormActionInfo[],
  attachments: readonly FormActionAttachment[],
): FormActionInfo[] {
  if (attachments.length >= MAX_FORM_ACTIONS) return [];
  const used = new Set(attachments.map((a) => a.action));
  return infos.filter((info) => !used.has(info.id));
}

/** A fresh attachment: each setting's declared `default` written in, which is all
 *  `default` ever means (`fields.ts`), and nothing else. Already attached is a no-op. */
export function attachAction(
  attachments: readonly FormActionAttachment[],
  info: FormActionInfo,
): FormActionAttachment[] {
  if (attachments.some((a) => a.action === info.id)) return [...attachments];
  if (attachments.length >= MAX_FORM_ACTIONS) return [...attachments];
  const settings: Record<string, ActionSettingValue> = {};
  for (const [name, def] of Object.entries(info.settings)) {
    const fallback = (def as { default?: unknown }).default;
    if (
      typeof fallback === "string" ||
      typeof fallback === "number" ||
      typeof fallback === "boolean"
    ) {
      settings[name] = fallback;
    }
  }
  return [
    ...attachments,
    { action: info.id, ...(Object.keys(settings).length > 0 ? { settings } : {}) },
  ];
}

export function detachAction(
  attachments: readonly FormActionAttachment[],
  action: string,
): FormActionAttachment[] {
  return attachments.filter((a) => a.action !== action);
}

/** Moves an attachment one step; a no-op past either end. Order is run order. */
export function moveAction(
  attachments: readonly FormActionAttachment[],
  action: string,
  direction: -1 | 1,
): FormActionAttachment[] {
  const from = attachments.findIndex((a) => a.action === action);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= attachments.length) return [...attachments];
  const next = [...attachments];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as FormActionAttachment);
  return next;
}

function replaceAttachment(
  attachments: readonly FormActionAttachment[],
  action: string,
  change: (a: FormActionAttachment) => FormActionAttachment,
): FormActionAttachment[] {
  return attachments.map((a) => (a.action === action ? change(a) : a));
}

/** The attachment with `key` set to `value`, or without the key when `value` is empty. */
function tidy(
  a: FormActionAttachment,
  key: "map" | "settings" | "messages" | "i18n",
  value: object,
): FormActionAttachment {
  const rest: FormActionAttachment = { ...a };
  delete rest[key];
  return Object.keys(value).length > 0 ? ({ ...rest, [key]: value } as FormActionAttachment) : rest;
}

/** Maps `input` onto `question`; an empty question unmaps it. */
export function withMapping(
  attachments: readonly FormActionAttachment[],
  action: string,
  input: string,
  question: string,
): FormActionAttachment[] {
  return replaceAttachment(attachments, action, (a) => {
    const map = { ...a.map };
    if (question === "") delete map[input];
    else map[input] = question;
    return tidy(a, "map", map);
  });
}

/** Sets one setting; undefined or empty text clears it (unset, not the empty string). */
export function withActionSetting(
  attachments: readonly FormActionAttachment[],
  action: string,
  name: string,
  value: Json | undefined,
): FormActionAttachment[] {
  return replaceAttachment(attachments, action, (a) => {
    const settings = { ...a.settings };
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      typeof value === "object" ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      delete settings[name];
    } else {
      settings[name] = value;
    }
    return tidy(a, "settings", settings);
  });
}

/**
 * The editor's text for one refusal code, in the source locale or (when `locale`
 * differs from `source`) as that locale's translation. Empty text clears it, so the
 * code falls back to the next in `refusalsOf`'s chain.
 */
export function withMessage(
  attachments: readonly FormActionAttachment[],
  action: string,
  code: string,
  text: string,
  locale: string,
  source: string,
): FormActionAttachment[] {
  return replaceAttachment(attachments, action, (a) => {
    if (locale === "" || locale === source) {
      const messages = { ...a.messages };
      if (text === "") delete messages[code];
      else messages[code] = text;
      return tidy(a, "messages", messages);
    }
    const i18n = { ...a.i18n };
    const messages = { ...i18n[locale]?.messages };
    if (text === "") delete messages[code];
    else messages[code] = text;
    if (Object.keys(messages).length > 0) i18n[locale] = { messages };
    else delete i18n[locale];
    return tidy(a, "i18n", i18n);
  });
}

/** The editor's text for a code in `locale` ("" when unwritten). */
export function messageText(
  a: FormActionAttachment,
  code: string,
  locale: string,
  source: string,
): string {
  if (locale === "" || locale === source) return a.messages?.[code] ?? "";
  return a.i18n?.[locale]?.messages?.[code] ?? "";
}

/** The questions an input may be fed from (decision 5's table), in form order. */
export function compatibleQuestions(
  input: Pick<ActionInputInfo, "kind">,
  fields: readonly FormField[],
): FormField[] {
  const accepts = INPUT_ACCEPTS[input.kind] ?? [];
  return fields.filter((f) => accepts.includes(f.kind));
}

/**
 * Problems the draft has that the saved form did not, per attachment, as sentences
 * naming the action. This is decision 13's rule restated for the Save button: a form
 * that already had a problem can still be saved (closed, renamed), and only a change
 * that makes an attachment worse is held back. The server says the same on PATCH.
 */
export function addedActionProblems(
  saved: {
    fields: readonly FormField[];
    layout: FormLayout;
    actions: readonly FormActionAttachment[];
  } | null,
  draft: {
    fields: readonly FormField[];
    layout: FormLayout;
    actions: readonly FormActionAttachment[];
  },
  infos: ReadonlyMap<string, FormActionInfo>,
): string[] {
  const out: string[] = [];
  for (const a of draft.actions) {
    const info = infos.get(a.action);
    if (!info) continue;
    const was = saved?.actions.find((s) => s.action === a.action);
    const before = new Set(
      was && saved ? attachmentProblems(was, info, saved.fields, saved.layout) : [],
    );
    for (const problem of attachmentProblems(a, info, draft.fields, draft.layout)) {
      if (!before.has(problem)) out.push(`${info.label}: ${problem}`);
    }
  }
  return out;
}

/** Every problem an attachment has now, for showing in place. Unregistered: none to compute. */
export function problemsOf(
  a: FormActionAttachment,
  info: FormActionInfo | undefined,
  fields: readonly FormField[],
  layout: FormLayout,
): string[] {
  return info ? attachmentProblems(a, info, fields, layout) : [];
}
