import type { KeyboardEvent, ReactNode } from "react";
import type { Field as FieldDef } from "../../../../core/fields";
import type { CollectionValue, ContentOrderSpec, ContentWhere } from "../../../../core/query";
import type { SchemaIndex } from "../../../../core/schema";
import { Input, Select } from "../../Field";
import css from "./fields.module.css";

/**
 * The filter and sort controls of a content query, extracted from `CollectionField`
 * so the form builder's "Published content" option source composes the same ones
 * (`form-option-sources.md` decision 14). A `collection` field and a sourced form
 * question both store a `where` list and an `order`; neither the controls nor the
 * helpers behind them know which they are drawing.
 *
 * The field declaration behind a name is found in the **schema**, not on a block:
 * a `filterable` entry names a field on the *target type's* root block, which is
 * some other block entirely.
 */

/**
 * The field declaration behind one filterable name, found by walking the schema.
 *
 * A `filterable` entry names a field on the **target type's root block**, which is
 * some other block entirely — so this looks for the first block declaring that name
 * with `indexed: true`. Two blocks declaring the same indexed name is exactly the
 * case the index itself treats as one queryable field (it is keyed on the name), so
 * taking the first is consistent rather than arbitrary.
 */
export function filterField(schema: SchemaIndex, name: string): FieldDef | undefined {
  for (const def of Object.values(schema)) {
    const field = def.fields[name];
    if (field && (field as { indexed?: unknown }).indexed === true) return field;
  }
  return undefined;
}

/** The stored value with one filter replaced, or removed when the choice is "any". */
export function withFilter(value: CollectionValue, field: string, chosen: string): CollectionValue {
  const rest = (value.where ?? []).filter((w) => w.field !== field);
  const next: ContentWhere[] = chosen === "" ? rest : [...rest, { field, op: "eq", value: chosen }];
  return { ...value, where: next };
}

/** The current choice for one filter, or `''` for "any". */
export function filterValue(value: CollectionValue, field: string): string {
  const hit = (value.where ?? []).find((w) => w.field === field && w.op === "eq");
  if (!hit) return "";
  return Array.isArray(hit.value) ? (hit.value[0] ?? "") : String(hit.value);
}

/** A sort key's label: a built-in's own name, or the field's declared label. */
export function sortLabel(schema: SchemaIndex, name: string): string {
  if (name === "publishedAt") return "Publish date";
  if (name === "title") return "Title";
  if (name === "ord") return "Manual order";
  if (name === "relevance") return "Best match";
  return filterField(schema, name)?.label ?? name;
}

/**
 * One grid row per filter, then (after `between`) the sort.
 *
 * Renders a fragment of `css.filter` rows for the caller's `<fieldset>` to lay out,
 * so `CollectionField`'s output is the DOM it always was. `before` and `between` are
 * what that field draws around the controls (its search box, its count) and a form
 * question draws nothing for.
 *
 * `idFor` is the caller's, so the first control can carry the id the row's label
 * points at (`CollectionField` explains why).
 */
export function QueryControls({
  schema,
  value,
  order,
  filterable,
  orderable,
  idFor,
  before,
  between,
  onChange,
  onCommit,
}: {
  schema: SchemaIndex;
  value: CollectionValue;
  /** The sort in effect, which is the stored one or the caller's default. */
  order: ContentOrderSpec;
  filterable: readonly string[];
  orderable: readonly string[];
  idFor: (suffix: string) => string;
  before?: ReactNode;
  between?: ReactNode;
  onChange: (next: CollectionValue) => void;
  /**
   * Given, the caller wants to know when an edit is *finished*, not only made: a
   * select, a boolean and the sort commit on change, a text filter on blur or Enter.
   * The form builder previews a list on commit rather than per keystroke
   * (`form-option-sources.md` decision 14). `CollectionField` passes nothing, and
   * nothing here then differs from before.
   */
  onCommit?: (next: CollectionValue) => void;
}) {
  const choose = (next: CollectionValue) => {
    onChange(next);
    onCommit?.(next);
  };
  return (
    <>
      {before}

      {filterable.map((name) => {
        const def = filterField(schema, name);
        const current = filterValue(value, name);
        return (
          /*
           * `htmlFor` and a minted id, rather than a label wrapping its control.
           * Implicit association is valid HTML and Biome's `noLabelWithoutControl`
           * still rejects it here, because the control is a `<Select>` component and
           * the rule can only see literal elements — so the explicit id is what makes
           * the association reviewable as well as real.
           */
          <label key={name} className={css.filter} htmlFor={idFor(name)}>
            <span>{def?.label ?? name}</span>
            {def?.kind === "select" ? (
              <Select
                id={idFor(name)}
                value={current}
                onChange={(e) => choose(withFilter(value, name, e.target.value))}
              >
                <option value="">Any</option>
                {def.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : def?.kind === "boolean" ? (
              <Select
                id={idFor(name)}
                value={current}
                onChange={(e) => choose(withFilter(value, name, e.target.value))}
              >
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : (
              <Input
                id={idFor(name)}
                type="text"
                value={current}
                placeholder="Any"
                onChange={(e) => onChange(withFilter(value, name, e.target.value))}
                {...(onCommit
                  ? {
                      onBlur: () => onCommit(value),
                      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter") onCommit(value);
                      },
                    }
                  : {})}
              />
            )}
          </label>
        );
      })}

      {between}

      <label className={css.filter} htmlFor={idFor("order")}>
        <span>Sort by</span>
        <Select
          id={idFor("order")}
          value={`${order.field}:${order.dir}`}
          onChange={(e) => {
            const [f, dir] = e.target.value.split(":");
            choose({ ...value, order: { field: f!, dir: dir === "asc" ? "asc" : "desc" } });
          }}
        >
          {orderable.flatMap((name) => [
            <option key={`${name}:desc`} value={`${name}:desc`}>
              {sortLabel(schema, name)} — newest / Z to A
            </option>,
            <option key={`${name}:asc`} value={`${name}:asc`}>
              {sortLabel(schema, name)} — oldest / A to Z
            </option>,
          ])}
        </Select>
      </label>
    </>
  );
}
