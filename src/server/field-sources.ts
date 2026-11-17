/**
 * Option sources for document fields (`platform/admin-extensions.md` decisions 16 and 17).
 *
 * A host registers sources for fields under `optionSources`, per brand, **separately from
 * `forms.sources`**: `forms.sources` is listed to every `READ` caller by `/forms/registry`,
 * previewed with caller-chosen settings by the builder and rendered to anonymous visitors on a
 * published form, and a source a host registers for an admin-only picker must reach none of
 * those. A field may name either registry: `BrandRuntime.fieldSources` is their union, read by
 * field code only.
 */
import type { Field } from "../core/fields";
import { CONTENT_SOURCE, isSourceId } from "../core/option-sources";
import type { SchemaIndex } from "../core/schema";
import type { ResolvedOptionSource } from "./form-responses";

/**
 * The sources a field may name: `optionSources` and `forms.sources` together. **An id in both
 * throws**, because `option_lists` is keyed by `(brand, source, key)` and two sources under one
 * id would overwrite each other's rows.
 */
export function mergeFieldSources(
  optionSources: ReadonlyMap<string, ResolvedOptionSource>,
  formSources: ReadonlyMap<string, ResolvedOptionSource> | undefined,
): ReadonlyMap<string, ResolvedOptionSource> {
  const out = new Map(formSources ?? []);
  for (const [id, source] of optionSources) {
    if (out.has(id)) {
      throw new Error(
        `folio: option source '${id}' is registered under both \`optionSources\` and \`forms.sources\`: option_lists is keyed by source id, so the two would overwrite each other's rows. Keep it in one`,
      );
    }
    out.set(id, source);
  }
  return out;
}

/**
 * Every `optionsFrom` on a select in `schema`, refused at construction for the mistakes that
 * would otherwise be found by an editor opening the inspector or an agent writing a page.
 * The list key's settings are code, so no route takes settings from a caller.
 */
export function validateFieldSources(
  schema: SchemaIndex,
  sources: ReadonlyMap<string, ResolvedOptionSource>,
): void {
  for (const [block, def] of Object.entries(schema)) {
    for (const [name, field] of Object.entries(def.fields)) {
      const where = `block '${block}' field '${name}'`;
      const from = (field as { optionsFrom?: unknown }).optionsFrom;
      if (from === undefined) continue;
      if (field.kind !== "select") {
        throw new Error(
          `folio: ${where} is a ${field.kind} and has \`optionsFrom\`; only a select does`,
        );
      }
      validateOne(where, field, from, sources);
    }
  }
}

function validateOne(
  where: string,
  field: Extract<Field, { kind: "select" }>,
  from: unknown,
  sources: ReadonlyMap<string, ResolvedOptionSource>,
): void {
  if (!from || typeof from !== "object" || Array.isArray(from)) {
    throw new Error(`folio: ${where} has a malformed \`optionsFrom\``);
  }
  const { source: id, settings } = from as { source?: unknown; settings?: unknown };
  if (id === CONTENT_SOURCE) {
    throw new Error(
      `folio: ${where} names the 'content' source, which a field cannot use: use \`reference({ types })\` to pick a Folio document`,
    );
  }
  if (!isSourceId(id))
    throw new Error(`folio: ${where} has an \`optionsFrom\` with an invalid source`);
  const source = sources.get(id);
  if (!source) {
    throw new Error(
      `folio: ${where} names option source '${id}', which is in neither \`optionSources\` nor \`forms.sources\` (registered: ${[...sources.keys()].join(", ") || "none"})`,
    );
  }
  if (field.translatable) {
    throw new Error(
      `folio: ${where} is translatable and sourced: the stored id is the same in every locale, so it cannot be`,
    );
  }
  if (field.default !== undefined && !field.options.some((o) => o.value === field.default)) {
    throw new Error(
      `folio: ${where} has a default that is not one of its typed options: a sourced select's default must be a typed extra`,
    );
  }
  if (settings === undefined) return;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`folio: ${where} has \`optionsFrom.settings\` that are not an object`);
  }
  for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
    const declared = source.settings?.[key];
    if (!declared) {
      throw new Error(`folio: ${where} sets '${key}', which source '${id}' does not declare`);
    }
    const bad = (expected: string) =>
      new Error(
        `folio: ${where} sets '${key}' to ${JSON.stringify(value)}; source '${id}' wants ${expected}`,
      );
    if (declared.kind === "text" && typeof value !== "string") throw bad("a string");
    if (declared.kind === "number" && typeof value !== "number") throw bad("a number");
    if (declared.kind === "boolean" && typeof value !== "boolean") throw bad("a boolean");
    if (declared.kind === "select") {
      const allowed = declared.options.map((o) => o.value);
      if (typeof value !== "string" || !allowed.includes(value)) {
        throw bad(`one of: ${allowed.join(", ")}`);
      }
    }
  }
}
