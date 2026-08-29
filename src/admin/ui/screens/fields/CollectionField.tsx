import type { Json } from '../../../../core/doc'
import type { Field as FieldDef } from '../../../../core/fields'
import {
  asCollectionValue,
  BUILT_IN_ORDERS,
  type CollectionField as CollectionFieldDef,
  type CollectionValue,
  type ContentWhere,
  maxPerPageOf,
  type ResolvedCollection,
} from '../../../../core/query'
import type { DocumentType, SchemaIndex } from '../../../../core/schema'
import { Input, Select } from '../../Field'
import css from './fields.module.css'

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
    const field = def.fields[name]
    if (field && (field as { indexed?: unknown }).indexed === true) return field
  }
  return undefined
}

/** The stored value with one filter replaced, or removed when the choice is "any". */
export function withFilter(value: CollectionValue, field: string, chosen: string): CollectionValue {
  const rest = (value.where ?? []).filter((w) => w.field !== field)
  const next: ContentWhere[] = chosen === '' ? rest : [...rest, { field, op: 'eq', value: chosen }]
  return { ...value, where: next }
}

/** The current choice for one filter, or `''` for "any". */
export function filterValue(value: CollectionValue, field: string): string {
  const hit = (value.where ?? []).find((w) => w.field === field && w.op === 'eq')
  if (!hit) return ''
  return Array.isArray(hit.value) ? (hit.value[0] ?? '') : String(hit.value)
}

/** A sort key's label: a built-in's own name, or the field's declared label. */
export function sortLabel(schema: SchemaIndex, name: string): string {
  if (name === 'publishedAt') return 'Publish date'
  if (name === 'title') return 'Title'
  if (name === 'ord') return 'Manual order'
  return filterField(schema, name)?.label ?? name
}

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
  id: string
  field: CollectionFieldDef
  value: Json
  /**
   * What the query currently returns, for the "N of M" line. Absent while the fetch
   * is in flight, which is the honest state — a count of zero would read as "nothing
   * matches" rather than "not asked yet".
   */
  answer?: ResolvedCollection
  schema: SchemaIndex
  types: readonly DocumentType[]
  editable: boolean
  onChange: (v: Json) => void
}) {
  const stored = asCollectionValue(value)
  const max = maxPerPageOf(field)
  const perPage = Math.min(stored.perPage ?? field.maxPerPage ?? 20, max)
  const order = stored.order ?? field.defaultOrder ?? { field: 'publishedAt', dir: 'desc' }
  const filterable = field.filterable ?? []

  const wanted =
    field.type === undefined ? [] : typeof field.type === 'string' ? [field.type] : [...field.type]
  const unknown = wanted.filter((name) => !types.some((t) => t.name === name))

  const patch = (next: CollectionValue) => onChange(next as unknown as Json)
  const orderable = [...new Set([...Object.keys(BUILT_IN_ORDERS), ...filterable])]
  const labelOf = (name: string) => types.find((t) => t.name === name)?.label ?? name
  /*
   * One id per control inside this field, derived from the one the row's `Field`
   * already minted, so two collection fields in one block cannot collide.
   *
   * The **first** control gets `id` itself, unsuffixed, and that is not a nicety: the
   * row's label is a `<label htmlFor={id}>`, a `<fieldset>` is not a labelable
   * element, and a `for` pointing at one is a label associated with nothing. Handing
   * it to the first control means clicking the field's name focuses the first thing
   * you would type into, which is what a label is for.
   */
  const first = filterable[0] ?? 'perPage'
  const idFor = (suffix: string) => (suffix === first ? id : `${id}-${suffix}`)

  return (
    <fieldset className={`${css.group} ${css.stack}`} disabled={!editable}>
      {/* The group's own accessible name, which is what assistive technology
          announces on entering a set of related controls. Visually hidden because the
          row above already shows the field's label. */}
      <legend className={css.srOnly}>What this list shows</legend>

      <p className={css.what}>
        {wanted.length === 0 ? 'Every kind of document' : wanted.map(labelOf).join(', ')}
        {/* The same posture an unknown block type gets: say so, do not pretend. */}
        {unknown.length > 0 ? (
          <span className={css.unknown}> — unknown type “{unknown.join(', ')}”</span>
        ) : null}
      </p>

      {filterable.map((name) => {
        const def = filterField(schema, name)
        const current = filterValue(stored, name)
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
            {def?.kind === 'select' ? (
              <Select
                id={idFor(name)}
                value={current}
                onChange={(e) => patch(withFilter(stored, name, e.target.value))}
              >
                <option value="">Any</option>
                {def.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : def?.kind === 'boolean' ? (
              <Select
                id={idFor(name)}
                value={current}
                onChange={(e) => patch(withFilter(stored, name, e.target.value))}
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
                onChange={(e) => patch(withFilter(stored, name, e.target.value))}
              />
            )}
          </label>
        )
      })}

      <label className={css.filter} htmlFor={idFor('perPage')}>
        <span>How many</span>
        <Input
          id={idFor('perPage')}
          type="number"
          min={1}
          max={max}
          value={perPage}
          onChange={(e) => {
            const n = e.target.valueAsNumber
            patch({
              ...stored,
              perPage: Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : 1,
            })
          }}
        />
      </label>

      <label className={css.filter} htmlFor={idFor('order')}>
        <span>Sort by</span>
        <Select
          id={idFor('order')}
          value={`${order.field}:${order.dir}`}
          onChange={(e) => {
            const [f, dir] = e.target.value.split(':')
            patch({ ...stored, order: { field: f!, dir: dir === 'asc' ? 'asc' : 'desc' } })
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

      {/* Why the count can differ from what the live page shows, said once, where it
          is relevant: a draft insight is not in the index (decision 3). */}
      <p className={css.note}>
        {answer
          ? answer.total === 0
            ? 'Nothing published matches yet.'
            : `Showing ${answer.items.length} of ${answer.total} published — page ${answer.page} of ${answer.pages}.`
          : 'Counting…'}
      </p>
    </fieldset>
  )
}
