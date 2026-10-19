/**
 * The condition editor's arithmetic (`docs/specs/content-model/form-logic.md`
 * phase 4): the editable subset of `FieldCondition`, the operators each kind of
 * question offers, which questions a rule may name, and a condition as a sentence
 * in the editor's own words (labels, not slugs).
 *
 * Pure, like `form-model.ts`: a Node test reaches all of it. The server's rules are
 * `checkFormLogic`'s; this is the half that offers only what that would accept.
 */
import type { FieldCondition } from "../../../core/conditions";
import type { Json } from "../../../core/doc";
import type { FormField, FormFieldKind } from "../../../core/forms";

/** What the editor offers, as the words it shows. `notSet` and `set` are both
 *  `isSet`, which carries its own boolean. */
export type ClauseOp = "eq" | "ne" | "in" | "set" | "unset" | "includes";

export const OPERATOR_LABELS: Record<ClauseOp, string> = {
  eq: "is",
  ne: "is not",
  in: "is one of",
  set: "has an answer",
  unset: "has no answer",
  includes: "includes",
};

/** One row of the editor: a question, an operator and what it is compared with. */
export interface Clause {
  field: string;
  op: ClauseOp;
  /** `in` takes a list, `eq`/`ne`/`includes` one value; `set`/`unset` ignore it. */
  value: Json | Json[];
}

/** One clause, or `all` / `any` over clauses. */
export interface EditableCondition {
  mode: "all" | "any";
  clauses: Clause[];
}

const isLeaf = (c: FieldCondition): c is Extract<FieldCondition, { field: string }> => "field" in c;

function clauseOf(leaf: Extract<FieldCondition, { field: string }>): Clause {
  if ("eq" in leaf) return { field: leaf.field, op: "eq", value: leaf.eq };
  if ("ne" in leaf) return { field: leaf.field, op: "ne", value: leaf.ne };
  if ("in" in leaf) return { field: leaf.field, op: "in", value: [...leaf.in] };
  if ("includes" in leaf) return { field: leaf.field, op: "includes", value: leaf.includes };
  return { field: leaf.field, op: leaf.isSet ? "set" : "unset", value: null };
}

function leafOf(clause: Clause): FieldCondition {
  const { field, value } = clause;
  switch (clause.op) {
    case "eq":
      return { field, eq: value as Json };
    case "ne":
      return { field, ne: value as Json };
    case "in":
      return { field, in: Array.isArray(value) ? value : [value] };
    case "includes":
      return { field, includes: value as Json };
    case "set":
      return { field, isSet: true };
    case "unset":
      return { field, isSet: false };
  }
}

/**
 * The editable form of a stored condition, or `null` for anything outside the
 * editable subset (`not`, nesting deeper than one level, an empty list): the
 * builder then shows it read-only with a **Replace** button instead of mangling it.
 */
export function toEditable(condition: FieldCondition | undefined): EditableCondition | null {
  if (!condition) return null;
  if (isLeaf(condition)) return { mode: "all", clauses: [clauseOf(condition)] };
  const list = "all" in condition ? condition.all : "any" in condition ? condition.any : null;
  if (!list || list.length === 0 || !list.every(isLeaf)) return null;
  return {
    mode: "all" in condition ? "all" : "any",
    clauses: list.filter(isLeaf).map(clauseOf),
  };
}

/** The inverse. A single clause is a bare leaf, so a round trip of the common case
 *  is byte-stable. */
export function fromEditable(editable: EditableCondition): FieldCondition {
  const leaves = editable.clauses.map(leafOf);
  if (leaves.length === 1 && leaves[0]) return leaves[0];
  return editable.mode === "all" ? { all: leaves } : { any: leaves };
}

/** Kinds a rule can be written about: `file` and `statement` have no answer to
 *  compare. */
export const isValueBearing = (kind: FormFieldKind): boolean =>
  kind !== "file" && kind !== "statement";

/**
 * The questions a rule may name. A `showIf` may name only earlier questions
 * (decision 2); a `requireIf` any other question. Either way, value-bearing only.
 */
export function sourcesFor(
  fields: readonly FormField[],
  index: number,
  verb: "show" | "require",
): FormField[] {
  return fields.filter(
    (f, i) => isValueBearing(f.kind) && (verb === "show" ? i < index : i !== index),
  );
}

/** The operators `checkFormLogic` accepts for a source of `kind`, in the order the
 *  editor offers them. */
export function operatorsFor(kind: FormFieldKind): ClauseOp[] {
  switch (kind) {
    case "file":
    case "statement":
      return [];
    case "checkboxes":
      return ["includes", "set", "unset"];
    case "checkbox":
      return ["eq"];
    default:
      return ["eq", "ne", "in", "set", "unset"];
  }
}

/** A starting clause for `source`: the first operator it offers and a value that
 *  `checkFormLogic` would accept. */
export function blankClause(source: FormField): Clause {
  const op = operatorsFor(source.kind)[0] ?? "set";
  const first = source.options?.[0]?.value ?? "";
  switch (source.kind) {
    case "checkbox":
      return { field: source.name, op: "eq", value: true };
    case "number":
      return { field: source.name, op, value: 0 };
    case "select":
    case "radio":
    case "checkboxes":
      return { field: source.name, op, value: first };
    default:
      return { field: source.name, op: "set", value: null };
  }
}

/** The editable condition a **Replace** or "Only when…" starts from. */
export function blankCondition(source: FormField): FieldCondition {
  return fromEditable({ mode: "all", clauses: [blankClause(source)] });
}

/** Every question name a condition mentions, in order. */
export function referencedNames(condition: FieldCondition | undefined): string[] {
  if (!condition) return [];
  if ("all" in condition) return condition.all.flatMap(referencedNames);
  if ("any" in condition) return condition.any.flatMap(referencedNames);
  if ("not" in condition) return referencedNames(condition.not);
  return "field" in condition ? [condition.field] : [];
}

/** A copy of `condition` with every reference to `from` pointing at `to`. */
export function renameInCondition(
  condition: FieldCondition,
  from: string,
  to: string,
): FieldCondition {
  if ("all" in condition) return { all: condition.all.map((c) => renameInCondition(c, from, to)) };
  if ("any" in condition) return { any: condition.any.map((c) => renameInCondition(c, from, to)) };
  if ("not" in condition) return { not: renameInCondition(condition.not, from, to) };
  if ("field" in condition && condition.field === from) return { ...condition, field: to };
  return condition;
}

/** Whether `condition` compares question `name` against the option `value`. */
export function comparesValue(
  condition: FieldCondition | undefined,
  name: string,
  value: string,
): boolean {
  if (!condition) return false;
  if ("all" in condition) return condition.all.some((c) => comparesValue(c, name, value));
  if ("any" in condition) return condition.any.some((c) => comparesValue(c, name, value));
  if ("not" in condition) return comparesValue(condition.not, name, value);
  if (!("field" in condition) || condition.field !== name) return false;
  if ("eq" in condition) return condition.eq === value;
  if ("ne" in condition) return condition.ne === value;
  if ("in" in condition) return condition.in.includes(value);
  if ("includes" in condition) return condition.includes === value;
  return false;
}

/* ------------------------------------------------------------------ text --- */

function valueText(source: FormField | undefined, value: Json): string {
  if (typeof value === "boolean") return value ? "ticked" : "not ticked";
  const option = source?.options?.find((o) => o.value === value);
  const text = option ? option.label || option.value : String(value);
  return `"${text}"`;
}

/**
 * A condition as a sentence, with question labels and option labels rather than
 * slugs. Total over shapes it does not recognise, the discipline `conditionText`
 * keeps: it describes what it cannot edit.
 */
export function formConditionText(condition: FieldCondition, fields: readonly FormField[]): string {
  const text = (c: FieldCondition): string => {
    if ("all" in c) return c.all.map(text).join(" and ");
    if ("any" in c) return c.any.map(text).join(" or ");
    if ("not" in c) return `not (${text(c.not)})`;
    if (!("field" in c)) return "an unrecognised condition";
    const source = fields.find((f) => f.name === c.field);
    const label = `"${source?.label || c.field}"`;
    if ("eq" in c) return `${label} is ${valueText(source, c.eq)}`;
    if ("ne" in c) return `${label} is not ${valueText(source, c.ne)}`;
    if ("in" in c) return `${label} is one of ${c.in.map((v) => valueText(source, v)).join(", ")}`;
    if ("includes" in c) return `${label} includes ${valueText(source, c.includes)}`;
    if ("isSet" in c) return c.isSet ? `${label} has an answer` : `${label} has no answer`;
    return "an unrecognised condition";
  };
  return text(condition);
}
