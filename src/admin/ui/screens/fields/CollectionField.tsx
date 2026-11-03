import type { Json } from "../../../../core/doc";
import {
  asCollectionValue,
  BUILT_IN_ORDERS,
  type CollectionField as CollectionFieldDef,
  type CollectionValue,
  maxPerPageOf,
  type ResolvedCollection,
} from "../../../../core/query";
import type { DocumentType, SchemaIndex } from "../../../../core/schema";
import { Input } from "../../Field";
import css from "./fields.module.css";
import { QueryControls } from "./QueryControls";

// The helpers moved to `QueryControls.tsx` with the controls that use them (the form
// builder composes the same ones). Re-exported so this file's importers are unchanged.
export { filterField, filterValue, sortLabel, withFilter } from "./QueryControls";

/**
 * The editor's half of a `collection` field (`collections.md` decision 5).
 *
 * The **type is fixed by the schema** and is not on screen: a block author decided
 * an "Insight list" lists insights, and offering to change that would make the
 * block's own render meaningless. What is on screen is what the field says the
 * editor may choose — a filter per `filterable` name, a count up to `maxPerPage`,
 * and a sort — so a schema that permits nothing renders a summary and no controls.
 *
 * Enforced here **and** in `collectionQuery` on the way out, the same double
 * enforcement `richtext`'s `marks` has, because a value can also arrive from an
 * importer or over the content API.
 *
 * Carried over from `admin/CollectionInput.tsx` unchanged except for two things:
 * the three pure helpers moved here from that file so this one does not import the
 * old admin, and the label/control pairs are a `<fieldset>` grid rather than bare
 * `<label>` wrappers. The grid is deliberately **not** the `Field` primitive: these
 * are seven-word labels beside 1fr controls inside an already-narrow column, and
 * `Field` puts the label *above* the control. A `collection` field with four filters
 * would then be eight rows tall inside a field that is itself one row of the form.
 */

export function CollectionField({
  id,
  field,
  value,
  answer,
  schema,
  types,
  editable,
  onChange,
}: {
  id: string;
  field: CollectionFieldDef;
  value: Json;
  /**
   * What the query currently returns, for the "N of M" line. Absent while the fetch
   * is in flight, which is the honest state — a count of zero would read as "nothing
   * matches" rather than "not asked yet".
   */
  answer?: ResolvedCollection;
  schema: SchemaIndex;
  types: readonly DocumentType[];
  editable: boolean;
  onChange: (v: Json) => void;
}) {
  const stored = asCollectionValue(value);
  const max = maxPerPageOf(field);
  const perPage = Math.min(stored.perPage ?? field.maxPerPage ?? 20, max);
  const order = stored.order ?? field.defaultOrder ?? { field: "publishedAt", dir: "desc" };
  const filterable = field.filterable ?? [];

  const wanted =
    field.type === undefined ? [] : typeof field.type === "string" ? [field.type] : [...field.type];
  const unknown = wanted.filter((name) => !types.some((t) => t.name === name));

  const patch = (next: CollectionValue) => onChange(next as unknown as Json);
  // `relevance` only ever belongs in this list when the field itself declares
  // `searchable: true` (`full-text-search.md` decision 10) — otherwise a
  // collection with no way to carry a search term offered a sort that could
  // never do anything, silently falling back to `defaultOrder` at render.
  const orderable = [
    ...new Set([
      ...Object.keys(BUILT_IN_ORDERS).filter((name) => name !== "relevance" || field.searchable),
      ...filterable,
    ]),
  ];
  const labelOf = (name: string) => types.find((t) => t.name === name)?.label ?? name;
  /*
   * One id per control inside this field, derived from the one the row's `Field`
   * already minted, so two collection fields in one block cannot collide.
   *
   * The **first** control gets `id` itself, unsuffixed, and that is not a nicety: the
   * row's label is a `<label htmlFor={id}>`, a `<fieldset>` is not a labelable
   * element, and a `for` pointing at one is a label associated with nothing. Handing
   * it to the first control means clicking the field's name focuses the first thing
   * you would type into, which is what a label is for. A searchable field puts
   * Search there: it is the control a visitor-facing search page is actually for.
   */
  const first = field.searchable ? "search" : (filterable[0] ?? "perPage");
  const idFor = (suffix: string) => (suffix === first ? id : `${id}-${suffix}`);

  return (
    <fieldset className={`${css.group} ${css.stack}`} disabled={!editable}>
      {/* The group's own accessible name, which is what assistive technology
          announces on entering a set of related controls. Visually hidden because the
          row above already shows the field's label. */}
      <legend className={css.srOnly}>What this list shows</legend>

      <p className={css.what}>
        {wanted.length === 0 ? "Every kind of document" : wanted.map(labelOf).join(", ")}
        {/* The same posture an unknown block type gets: say so, do not pretend. */}
        {unknown.length > 0 ? (
          <span className={css.unknown}> — unknown type “{unknown.join(", ")}”</span>
        ) : null}
      </p>

      <QueryControls
        schema={schema}
        value={stored}
        order={order}
        filterable={filterable}
        orderable={orderable}
        idFor={idFor}
        onChange={patch}
        // Only when the field declares it (`full-text-search.md` decision 10):
        // a `collection` with no `searchable: true` never sees this control at
        // all, because a render-time term would have nowhere to go — dropped by
        // `collectionQuery` exactly as an unfilterable `where` already is.
        before={
          field.searchable ? (
            <label className={css.filter} htmlFor={idFor("search")}>
              <span>Search</span>
              <Input
                id={idFor("search")}
                type="search"
                value={stored.search ?? ""}
                placeholder="Any"
                onChange={(e) => patch({ ...stored, search: e.target.value })}
              />
            </label>
          ) : null
        }
        between={
          <label className={css.filter} htmlFor={idFor("perPage")}>
            <span>How many</span>
            <Input
              id={idFor("perPage")}
              type="number"
              min={1}
              max={max}
              value={perPage}
              onChange={(e) => {
                const n = e.target.valueAsNumber;
                patch({
                  ...stored,
                  perPage: Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : 1,
                });
              }}
            />
          </label>
        }
      />

      {/* Why the count can differ from what the live page shows, said once, where it
          is relevant: a draft insight is not in the index (decision 3). */}
      <p className={css.note}>
        {answer
          ? answer.total === 0
            ? "Nothing published matches yet."
            : `Showing ${answer.items.length} of ${answer.total} published — page ${answer.page} of ${answer.pages}.`
          : "Counting…"}
      </p>
    </fieldset>
  );
}
