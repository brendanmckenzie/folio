/**
 * Construction-time validation for `FolioConfig.gate`
 * (`../../docs/specs/platform/visitor-access.md` architecture decision 8).
 *
 * Same timing and the same reason as `validatePresets`, `validateTypes` and
 * `validateHooks`: a configuration mistake in a CMS should throw once, before a
 * request is served, rather than becoming a runtime surprise on whichever code
 * path reaches it first. Here the surprise would be worse than a 500 — a page
 * everyone can read while the editor who ticked "Members" believes it is gated.
 *
 * Every throw names the type, the field and the rule, because the fix is always
 * in the schema and the message is the only thing that says which schema.
 */
import { type IndexableField, isIndexableKind } from '../core/index-projection'
import type { DocumentType, SchemaIndex } from '../core/schema'
import type { FolioGate } from './types'

/**
 * `FolioConfig.gate`, validated, plus the two sets that fall out of validating
 * it. Mirrors `ResolvedAuth`: the host's config nested rather than spread, so
 * there is one place the gate's own keys live and no chance of a precomputed set
 * shadowing one of them.
 *
 * The sets are **not interchangeable**, and building both here is the whole
 * reason `validateGate` returns anything at all:
 *
 *   - `roots` holds the **root block** names that declare the field. This is what
 *     `reader.page()` tests, because what it has in hand is a document, and a
 *     document knows its root block's type and not its document type.
 *   - `types` holds the **document type** names whose root is one of those. This
 *     is what `../content-model/full-text-search.md` decision 11 compiles its
 *     predicate from, because SQL can see `stories.type` and cannot see a root
 *     block's name.
 *
 * Two document types may share one root block, so neither set is derivable from
 * the other without walking `types` again — which is exactly the second walk
 * building both here avoids.
 */
export interface ResolvedGate {
  /** The host's `gate`, unchanged. Widened to `unknown` for the same reason
   * `FolioRuntime.auth` is: the only thing an `Env` parameter is ever handed is
   * the same `env` the host's own `bindings` accessor gets. */
  config: FolioGate<unknown>
  /** Root block names declaring the gate field, on a `page`-kind type. */
  roots: ReadonlySet<string>
  /** Document type names whose root is one of `roots`. */
  types: ReadonlySet<string>
}

/** The five scalar kinds a gate field may be, for the message that refuses the
 * rest. Kept as prose beside `isIndexableKind` rather than derived from it: this
 * string is read by a human at 3am, not by the compiler. */
const KINDS = 'text, textarea, number, boolean or select'

export function validateGate<Env>(
  gate: FolioGate<Env> | undefined,
  types: readonly DocumentType[],
  schema: SchemaIndex,
): ResolvedGate | null {
  if (!gate) return null

  const field = gate.field
  const roots = new Set<string>()
  const typeNames = new Set<string>()

  for (const type of types) {
    // A `record` or `singleton` root declaring the field is ignored, not an
    // error: unrouted documents never reach `page()`, so the field is inert
    // there rather than misconfigured. Refusing it would make a shared root
    // block unusable by the one type that genuinely wants the gate.
    if (type.kind !== 'page') continue
    const declared = schema[type.root]?.fields[field]
    if (!declared) continue

    // A `page` root that does not declare the field is fine — that type is
    // public and `visitor` is never called for it (checkpoint 3, confirmed
    // twice). This design fails open there, deliberately: a root without the
    // input cannot mislead an editor into thinking a page is gated, and a site
    // with one members-only type and five public ones should not have to carry a
    // dead field on five roots.
    const where = `document type '${type.name}' declares gate field '${field}' on root block '${type.root}'`

    if (!isIndexableKind(declared)) {
      throw new Error(`folio: ${where} as kind '${declared.kind}'; a gate field must be ${KINDS}`)
    }
    // Decision 2: a gate that differs by language is a hole — a French
    // translation of "members" that reads "public" would open the English page
    // to anyone who asked in French. The read side ignores `i18n`; this is the
    // half that stops the value being written there in the first place.
    if (declared.translatable) {
      throw new Error(
        `folio: ${where} as translatable; a gate must not vary by locale, so the field cannot be translatable`,
      )
    }
    // Checkpoint 4. Lists are untouched by decision, so a host's ability to
    // filter them on this field is the whole remedy for a gated title showing up
    // in a public archive — and `full-text-search.md` decision 11 can only keep
    // gated rows out of a search because the value is in `content_index`.
    if (declared.indexed !== true) {
      throw new Error(
        `folio: ${where} without \`indexed: true\`; a gate field must be indexed so lists and search can filter on it`,
      )
    }

    const wrong = wrongPublicValue(declared.kind, gate.public)
    if (wrong) throw new Error(`folio: ${where}, and \`gate.public\` ${wrong}`)
    if (declared.kind === 'select' && !declared.options.some((o) => o.value === gate.public)) {
      const options = declared.options.map((o) => o.value).join(', ')
      throw new Error(
        `folio: ${where}, and \`gate.public\` is ${JSON.stringify(gate.public)}, which is not one of its options (${options})`,
      )
    }

    roots.add(type.root)
    typeNames.add(type.name)
  }

  if (roots.size === 0) {
    throw new Error(
      `folio: \`gate.field\` is '${field}', which no 'page' document type's root block declares — a gate that gates nothing`,
    )
  }

  return { config: gate, roots, types: typeNames }
}

/**
 * Why `public` cannot be this field's value, or null when it can.
 *
 * Strict about the primitive because the comparison at render time is strict
 * (`isUngated`): a `boolean` field with `public: 'false'` would match nothing at
 * all and gate every page on the site, which is the failure that looks like a
 * membership provider outage rather than like a typo.
 */
function wrongPublicValue(
  kind: IndexableField['kind'],
  value: string | number | boolean,
): string | null {
  let want: 'string' | 'number' | 'boolean' = 'string'
  if (kind === 'number') want = 'number'
  if (kind === 'boolean') want = 'boolean'
  if (typeof value === want) return null
  return `is a ${typeof value} (${JSON.stringify(value)}); a '${kind}' field needs a ${want}`
}
