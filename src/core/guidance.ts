/**
 * Authoring guidance: the advisory length measure, its one message, and the
 * construction-time check of every guidance key
 * (`../../docs/specs/content-model/authoring-guidance.md`).
 *
 * **Advisory throughout.** Nothing here refuses a write or a publish (decision 3):
 * an over-long heading is written, saved, synced and published like any other
 * value, and is *reported* by `check_document` and drawn as the inspector's
 * counter. Both of those read `measureText` and `lengthMessage` from this file,
 * which is what makes "the inspector and the check agree on the number" a property
 * one unit test can pin rather than a hope.
 *
 * Internal: only the `Guidance` and `TextLength` types reach `folio/core`.
 */
import type { Json } from "./doc";
import type { Field } from "./fields";
import { asRichtext, richtextToText } from "./richtext";
import type { SchemaIndex } from "./schema";

/** Ceiling on a block's `help`, `guidance.tone` and each of `guidance.examples`. */
export const MAX_GUIDANCE_TEXT = 500;
/** Ceiling on how many `guidance.examples` one block or field may give. */
export const MAX_GUIDANCE_EXAMPLES = 10;

type Measured = Extract<Field, { kind: "text" | "textarea" | "richtext" }>;

const MEASURED_KINDS: ReadonlySet<Field["kind"]> = new Set(["text", "textarea", "richtext"]);
const DECORATIVE_KINDS: ReadonlySet<Field["kind"]> = new Set(["asset", "multiasset"]);

const isMeasured = (field: Field): field is Measured => MEASURED_KINDS.has(field.kind);

/** The plain text one stored prose value reads as, or null when the kind has none. */
function plainText(field: Field, value: Json): string | null {
  if (field.kind === "richtext") return richtextToText(asRichtext(value));
  if (field.kind === "text" || field.kind === "textarea") {
    return typeof value === "string" ? value : null;
  }
  return null;
}

/**
 * The length of one stored value in the field's own unit (decision 4), or null:
 * not a measured kind, or nothing to measure. `characters` is Unicode code points
 * after trimming, so an emoji counts as however many code points it is and the
 * inspector and the check agree without segmentation data. `words` is runs of
 * non-whitespace. Richtext is measured over `richtextToText`, so marks, links and
 * node boundaries add nothing. Empty is null: emptiness is `required`'s business.
 */
export function measureText(field: Field, value: Json): number | null {
  if (value === null || value === undefined) return null;
  const text = plainText(field, value)?.trim();
  if (!text) return null;
  const unit = isMeasured(field) ? (field.length?.unit ?? "characters") : "characters";
  if (unit === "words") return text.split(/\s+/u).filter(Boolean).length;
  return [...text].length;
}

export interface LengthProblem {
  kind: "over" | "under";
  length: number;
  limit: number;
  unit: "characters" | "words";
}

/**
 * Whether one stored value breaks its field's `length`, and by how much. Null for
 * a field with no `length`, an empty value (so a `min` never fires on a blank
 * field, which `required-empty` already reports), or a value within bounds.
 */
export function lengthProblem(field: Field, value: Json): LengthProblem | null {
  if (!isMeasured(field) || !field.length) return null;
  const length = measureText(field, value);
  if (length === null) return null;
  const { min, max, unit = "characters" } = field.length;
  if (max !== undefined && length > max) return { kind: "over", length, limit: max, unit };
  if (min !== undefined && length < min) return { kind: "under", length, limit: min, unit };
  return null;
}

const noun = (n: number, unit: "characters" | "words"): string =>
  `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;

/**
 * The one sentence a length problem reads as, named by the field's label. Both
 * `check_document`'s `length-over`/`length-under` message and the inspector's
 * `fieldWarning` are this function, so a person and an agent are told the same
 * thing about the same value.
 */
export function lengthMessage(label: string, problem: LengthProblem): string {
  return problem.kind === "over"
    ? `${label} is ${noun(problem.length, problem.unit)}; the limit is ${problem.limit}.`
    : `${label} is ${noun(problem.length, problem.unit)}; the minimum is ${problem.limit}.`;
}

/* ------------------------------------------------------------ construction --- */

const isWhole = (n: unknown, least: number): boolean =>
  typeof n === "number" && Number.isInteger(n) && n >= least;

function checkText(where: string, key: string, value: unknown, least = 0): void {
  if (typeof value !== "string" || value.length < least || value.length > MAX_GUIDANCE_TEXT) {
    throw new Error(
      `folio: ${where}: '${key}' must be a string of ${least > 0 ? `${least}-` : "at most "}${MAX_GUIDANCE_TEXT} characters`,
    );
  }
}

function checkGuidance(where: string, guidance: unknown): void {
  if (guidance === undefined) return;
  if (typeof guidance !== "object" || guidance === null || Array.isArray(guidance)) {
    throw new Error(`folio: ${where}: 'guidance' must be an object of { tone?, examples? }`);
  }
  const g = guidance as Record<string, unknown>;
  for (const key of Object.keys(g)) {
    if (key !== "tone" && key !== "examples") {
      throw new Error(
        `folio: ${where}: unknown 'guidance.${key}' (valid: tone, examples; a field's purpose is its 'help')`,
      );
    }
  }
  if (g.tone !== undefined) checkText(where, "guidance.tone", g.tone);
  if (g.examples !== undefined) {
    if (!Array.isArray(g.examples) || g.examples.length > MAX_GUIDANCE_EXAMPLES) {
      throw new Error(
        `folio: ${where}: 'guidance.examples' must be an array of at most ${MAX_GUIDANCE_EXAMPLES} strings`,
      );
    }
    for (const example of g.examples) checkText(where, "guidance.examples[]", example, 1);
  }
}

function checkLength(where: string, field: Field): void {
  const raw = (field as { length?: unknown }).length;
  if (raw === undefined) return;
  if (!MEASURED_KINDS.has(field.kind)) {
    throw new Error(
      `folio: ${where}: 'length' is for text, textarea and richtext, not ${field.kind}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`folio: ${where}: 'length' must be an object of { min?, max?, unit? }`);
  }
  const length = raw as Record<string, unknown>;
  for (const key of Object.keys(length)) {
    if (key !== "min" && key !== "max" && key !== "unit") {
      throw new Error(`folio: ${where}: unknown 'length.${key}' (valid: min, max, unit)`);
    }
  }
  if (length.min !== undefined && !isWhole(length.min, 0)) {
    throw new Error(`folio: ${where}: 'length.min' must be a whole number, 0 or more`);
  }
  if (length.max !== undefined && !isWhole(length.max, 1)) {
    throw new Error(`folio: ${where}: 'length.max' must be a whole number, 1 or more`);
  }
  if (typeof length.min === "number" && typeof length.max === "number" && length.max < length.min) {
    throw new Error(
      `folio: ${where}: 'length.max' (${length.max}) is below 'length.min' (${length.min})`,
    );
  }
  if (length.unit !== undefined && length.unit !== "characters" && length.unit !== "words") {
    throw new Error(
      `folio: ${where}: 'length.unit' must be "characters" or "words", not ${JSON.stringify(length.unit)}`,
    );
  }
}

/**
 * Every guidance key of every block and field, checked at construction
 * (`createFolio`, before any request is served). The types already refuse most of
 * this; a JS host, or a cast, reaches it anyway, and a `length` on a number field
 * is a limit the host believes in and nothing would ever report.
 *
 * **Only the keys this spec adds are capped.** An existing `help` on a field is
 * unbounded and stays so: capping it now would throw at construction for a host
 * whose help text is long, on an upgrade that is meant to be a version bump.
 * A block's `help` is new, so it is capped.
 */
export function validateGuidance(schema: SchemaIndex): void {
  for (const block of Object.values(schema)) {
    const at = `block '${block.name}'`;
    if (block.help !== undefined) checkText(at, "help", block.help);
    checkGuidance(at, block.guidance);
    for (const [name, field] of Object.entries(block.fields)) {
      const where = `block '${block.name}' field '${name}'`;
      checkGuidance(where, field.guidance);
      checkLength(where, field);
      const decorative = (field as { decorative?: unknown }).decorative;
      if (decorative !== undefined) {
        if (!DECORATIVE_KINDS.has(field.kind)) {
          throw new Error(
            `folio: ${where}: 'decorative' is for asset and multiasset, not ${field.kind}`,
          );
        }
        if (typeof decorative !== "boolean") {
          throw new Error(`folio: ${where}: 'decorative' must be true or false`);
        }
      }
    }
  }
}
