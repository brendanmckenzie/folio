import type { Json } from './doc'
import { deepEqual } from './diff'

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
  | { all: readonly FieldCondition[] }
  | { any: readonly FieldCondition[] }
  | { not: FieldCondition }

/**
 * "Empty" is ambiguous across kinds, so `isSet` is explicit about it: `false`
 * for `null`, `undefined`, `''` and `[]`; `true` for everything else,
 * including `0` and `false`. A boolean field's condition should be written
 * `{ eq: true }`, not `{ isSet: true }`.
 */
function isSet(value: Json | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
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
  if ('all' in condition) return condition.all.every((c) => matches(c, data))
  if ('any' in condition) return condition.any.some((c) => matches(c, data))
  if ('not' in condition) return !matches(condition.not, data)

  if ('field' in condition) {
    const value = data[condition.field] ?? null
    if ('eq' in condition) return deepEqual(value, condition.eq)
    if ('ne' in condition) return !deepEqual(value, condition.ne)
    if ('in' in condition) return condition.in.some((v) => deepEqual(value, v))
    if ('isSet' in condition) return isSet(value) === condition.isSet
  }

  return false
}
