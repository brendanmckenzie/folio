import type { Json } from '../core/doc'
import type { Field } from '../core/fields'
import {
  asCollectionValue,
  BUILT_IN_ORDERS,
  type CollectionField,
  type CollectionValue,
  type ContentWhere,
  MAX_PER_PAGE,
  maxPerPageOf,
  type ResolvedCollection,
} from '../core/query'
import type { SchemaIndex } from '../core/schema'
import { useFolio } from './FolioContext'

/**
 * The editor's half of a `collection` field
 * (`../../../docs/specs/content-model/collections.md` decision 5).
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
 */

/**
 * The field declaration behind one filterable name, found by walking the schema.
 *
 * A `filterable` entry names a field on the **target type's root block**, which is
 * some other block entirely — so this looks for the first block declaring that name
 * with `indexed: true`. Two blocks declaring the same indexed name is exactly the
 * case the index itself treats as one queryable field (it is keyed on the name), so
 * taking the first is consistent rather than arbitrary.
 *
 * Pure and exported so the lookup is tested without mounting the panel.
 */
export function filterField(schema: SchemaIndex, name: string): Field | undefined {
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

export function CollectionInput({
  id,
  field,
  value,
  answer,
  onChange,
}: {
  id: string
  field: CollectionField
  value: Json
  /**
   * What the query currently returns, for the "N of M" line. Absent while the
   * fetch is in flight, which is the honest state — a count of zero would read as
   * "nothing matches" rather than "not asked yet".
   */
  answer?: ResolvedCollection
  onChange: (v: Json) => void
}) {
  const { schema, types } = useFolio()
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

  return (
    <div className="collection" id={id}>
      <p className="collection__what">
        {wanted.length === 0 ? 'Every kind of document' : wanted.map(labelOf(types)).join(', ')}
        {/* The same posture an unknown block type gets: say so, do not pretend. */}
        {unknown.length > 0 ? (
          <span className="collection__unknown"> — unknown type “{unknown.join(', ')}”</span>
        ) : null}
      </p>

      {filterable.map((name) => {
        const def = filterField(schema, name)
        const current = filterValue(stored, name)
        const label = def?.label ?? name
        return (
          <label key={name} className="collection__filter">
            <span>{label}</span>
            {def?.kind === 'select' ? (
              <select
                value={current}
                onChange={(e) => patch(withFilter(stored, name, e.target.value))}
              >
                <option value="">Any</option>
                {def.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : def?.kind === 'boolean' ? (
              <select
                value={current}
                onChange={(e) => patch(withFilter(stored, name, e.target.value))}
              >
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input
                type="text"
                value={current}
                placeholder="Any"
                onChange={(e) => patch(withFilter(stored, name, e.target.value))}
              />
            )}
          </label>
        )
      })}

      <label className="collection__filter">
        <span>How many</span>
        <input
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

      <label className="collection__filter">
        <span>Sort by</span>
        <select
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
        </select>
      </label>

      {/* Why the count can differ from what the live page shows, said once, where
          it is relevant: a draft insight is not in the index (decision 3). */}
      <p className="collection__count">
        {answer
          ? answer.total === 0
            ? 'Nothing published matches yet.'
            : `Showing ${answer.items.length} of ${answer.total} published — page ${answer.page} of ${answer.pages}.`
          : 'Counting…'}
      </p>
    </div>
  )
}

const labelOf = (types: ReturnType<typeof useFolio>['types']) => (name: string) =>
  types.find((t) => t.name === name)?.label ?? name

/** A sort key's label: a built-in's own name, or the field's declared label. */
function sortLabel(schema: SchemaIndex, name: string): string {
  if (name === 'publishedAt') return 'Publish date'
  if (name === 'title') return 'Title'
  if (name === 'ord') return 'Manual order'
  return filterField(schema, name)?.label ?? name
}

/** Kept beside `MAX_PER_PAGE` so the input's ceiling and the engine's are one fact. */
export const INPUT_MAX_PER_PAGE = MAX_PER_PAGE
