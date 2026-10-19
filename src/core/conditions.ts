import type { Json } from "./doc";
import { deepEqual } from "./diff";

/**
 * A field's visibility rule. Declarative data, never a function: the admin
 * ships prebuilt and learns a project's schema over HTTP
 * (`toManifest` → `GET /folio/schema`), so anything living in `fields` has to
 * survive `JSON.stringify`. A function would be silently dropped and the
 * field would simply always show.
 *
 * Deliberately small: `eq`/`ne`/`in`/`isSet` plus three combinators covers
 * every case that motivated this feature, and each one is a line of
 * `deepEqual` or a truthiness test.
 */
export type FieldCondition =
  | { field: string; eq: Json }
  | { field: string; ne: Json }
  | { field: string; in: readonly Json[] }
  | { field: string; isSet: boolean }
  | { field: string; includes: Json }
  | { all: readonly FieldCondition[] }
  | { any: readonly FieldCondition[] }
  | { not: FieldCondition };

/**
 * "Empty" is ambiguous across kinds, so `isSet` is explicit about it: `false`
 * for `null`, `undefined`, `''` and `[]`; `true` for everything else,
 * including `0` and `false`. A boolean field's condition should be written
 * `{ eq: true }`, not `{ isSet: true }`.
 */
function isSet(value: Json | undefined): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * Evaluates a condition against one blok's own field data. Sibling fields
 * only, deliberately: a condition never reaches a parent block or another
 * document (`conditional-fields.md`, checkpoint 2). Callers pass the *source
 * locale's* data, never a translation, so a field's visibility never differs
 * between locales.
 *
 * Total over unknown shapes: a schema can be newer than the admin bundle
 * reading it, so a condition object this function does not recognise (an
 * unknown operator, a name typo'd by a hand-authored schema) evaluates to
 * `false` rather than throwing. Hiding the field is the safe wrong answer;
 * throwing would take down the whole inspector.
 */
export function matches(condition: FieldCondition, data: Record<string, Json>): boolean {
  if ("all" in condition) return condition.all.every((c) => matches(c, data));
  if ("any" in condition) return condition.any.some((c) => matches(c, data));
  if ("not" in condition) return !matches(condition.not, data);

  if ("field" in condition) {
    const value = data[condition.field] ?? null;
    if ("eq" in condition) return deepEqual(value, condition.eq);
    if ("ne" in condition) return !deepEqual(value, condition.ne);
    if ("in" in condition) return condition.in.some((v) => deepEqual(value, v));
    if ("isSet" in condition) return isSet(value) === condition.isSet;
    // The only question to ask of a multi-value answer (`checkboxes` is a
    // `string[]`): `eq` and `in` compare the whole value, so neither can say
    // "this box is among the ticked ones". A non-array is simply false.
    if ("includes" in condition) {
      return Array.isArray(value) && value.some((v) => deepEqual(v, condition.includes));
    }
  }

  return false;
}

/* --------------------------------------------------- untrusted conditions --- */

/** Depth, node count and `in` list length for a condition that arrived over HTTP
 *  or out of a stored row (`docs/specs/content-model/form-logic.md`, Core types). */
const MAX_CONDITION_DEPTH = 4;
const MAX_CONDITION_NODES = 32;
const MAX_IN_VALUES = 100;
const MAX_FIELD_REF = 64;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

const isScalar = (x: unknown): x is string | number | boolean | null =>
  x === null ||
  typeof x === "string" ||
  typeof x === "boolean" ||
  (typeof x === "number" && Number.isFinite(x));

const LEAF_OPERATORS = ["eq", "ne", "in", "isSet", "includes"] as const;

/**
 * Why a condition is malformed, or `null` when it is well formed. The strict half
 * of the pair: known shapes only, scalar values only, and the bounds above. Used
 * by the valibot gate on write so the shape rule lives once; `readCondition` is
 * the total half for the read path.
 */
export function conditionRefusal(raw: unknown): string | null {
  let nodes = 0;
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > MAX_CONDITION_DEPTH) return `conditions nest at most ${MAX_CONDITION_DEPTH} deep`;
    if (++nodes > MAX_CONDITION_NODES)
      return `conditions have at most ${MAX_CONDITION_NODES} parts`;
    if (!isRecord(node)) return "a condition must be an object";
    const keys = Object.keys(node);
    if (keys.length !== 1 && !("field" in node && keys.length === 2)) {
      return "a condition has one operator";
    }
    if ("all" in node || "any" in node) {
      const list = "all" in node ? node.all : node.any;
      if (keys.length !== 1 || !Array.isArray(list)) return "all and any take a list";
      for (const child of list) {
        const reason = walk(child, depth + 1);
        if (reason) return reason;
      }
      return null;
    }
    if ("not" in node) {
      return keys.length === 1 ? walk(node.not, depth + 1) : "a condition has one operator";
    }
    if (typeof node.field !== "string" || node.field === "" || node.field.length > MAX_FIELD_REF) {
      return "a condition needs a question name";
    }
    const op = LEAF_OPERATORS.find((o) => o in node);
    if (!op) return "a condition needs an operator";
    const value = node[op];
    if (op === "isSet") return typeof value === "boolean" ? null : "isSet takes true or false";
    if (op === "in") {
      if (!Array.isArray(value) || value.length > MAX_IN_VALUES || !value.every(isScalar)) {
        return `in takes a list of at most ${MAX_IN_VALUES} plain values`;
      }
      return null;
    }
    return isScalar(value) ? null : `${op} takes a plain value`;
  };
  return walk(raw, 1);
}

/** A node `matches` answers `false` for, whatever it is wrapped in. */
const NEVER: FieldCondition = { any: [] };

/**
 * Total: rebuilds a stored or posted condition key by key and never throws, for
 * `readFields`' sake (a throw there is a live form with no questions). A leaf this
 * build does not recognise, or anything past the depth or size bound, becomes
 * `{ any: [] }`, which is what `matches` answers `false` for anyway. Anything that
 * is not an object at all answers `undefined`; the caller decides what absence
 * means (a `showIf` becomes never-asked, a `requireIf` is dropped).
 */
export function readCondition(raw: unknown): FieldCondition | undefined {
  if (!isRecord(raw)) return undefined;
  let nodes = 0;
  const walk = (node: unknown, depth: number): FieldCondition => {
    if (depth > MAX_CONDITION_DEPTH || ++nodes > MAX_CONDITION_NODES || !isRecord(node)) {
      return NEVER;
    }
    if (Array.isArray(node.all)) return { all: node.all.map((c) => walk(c, depth + 1)) };
    if (Array.isArray(node.any)) return { any: node.any.map((c) => walk(c, depth + 1)) };
    if ("not" in node) return { not: walk(node.not, depth + 1) };
    if (typeof node.field !== "string" || node.field === "") return NEVER;
    const field = node.field;
    if ("eq" in node && isScalar(node.eq)) return { field, eq: node.eq };
    if ("ne" in node && isScalar(node.ne)) return { field, ne: node.ne };
    if (Array.isArray(node.in) && node.in.length <= MAX_IN_VALUES && node.in.every(isScalar)) {
      return { field, in: node.in };
    }
    if (typeof node.isSet === "boolean") return { field, isSet: node.isSet };
    if ("includes" in node && isScalar(node.includes)) return { field, includes: node.includes };
    return NEVER;
  };
  return walk(raw, 1);
}
