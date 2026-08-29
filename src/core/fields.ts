import type { ReactNode } from 'react'
import type { FieldCondition } from './conditions'
import type { Json } from './doc'
import type { ResolvedCollection } from './query'
import type { ResolvedAsset, ResolvedLink, ResolvedReference } from './resolve'
import type { RichtextMarkName, RichtextNodeName } from './richtext'
import type { LinkKind } from './values'

interface Common {
  label?: string
  help?: string
  required?: boolean
  /**
   * Admin-only: hides the input when it does not match the same blok's own
   * data. The value is untouched — hiding a field hides the input, not the
   * value (`conditional-fields.md`, checkpoint 3).
   */
  showIf?: FieldCondition
  /** Admin-only. Never draw this input; its stored value is untouched. */
  hidden?: boolean
  /**
   * Written into a blok's data at creation (`blankSubtree`/`blankBlok`) only.
   * Never consulted at render (`resolveValue`): a schema edit must not change
   * what an already-published page says (`field-defaults-and-presets.md`,
   * decision 4). The retroactive case is a content migration
   * (`field.default(blok, name, value)`), not this key.
   */
  default?: Json
  /**
   * This field may hold a different value per locale
   * (`../../docs/specs/content-model/localisation.md` checkpoint 2).
   *
   * Opt-in, deliberately: most `select`, `boolean`, `number` and `asset` fields
   * should not diverge per language, and a default of "everything is
   * translatable" turns every schema into a translation surface nobody asked
   * for. `/folio/audit` reports the text-ish fields that are *not* marked, so
   * the omissions are findable rather than invisible.
   *
   * Enforced in the editor and **ignored by the renderer** (decision 4): the
   * inspector refuses to write a locale-scoped value to a field without this,
   * but if a value is in `i18n` — from an importer, the content API, or a flag
   * that has since been removed — it wins. Un-marking a field must not silently
   * hide content somebody already translated; the audit reports that case too.
   *
   * Not available on `blocks`: children are separate bloks, not a value, and
   * per-locale structure is exactly what decision 1 trades away.
   */
  translatable?: boolean
}

/**
 * Projected into `content_index` on publish, so a `collection` field (and
 * `folio.query`) can filter and sort on it
 * (`../../docs/specs/content-model/collections.md` architecture decision 2).
 *
 * Declared on the field, colocated with every other constraint in Folio, so the
 * admin can show that a field is filterable and the audit can report an
 * `indexed` flag that can never take effect.
 *
 * **Deliberately not on `Common`.** Only the five scalar kinds below carry it, so
 * `richtext({ indexed: true })` does not compile: the table exists to filter and
 * sort, and an asset, a link or a prose document has no scalar to sort by. The
 * escape hatch for "sort by publication date" is a root `text` field holding an
 * ISO 8601 string, which is what a publish-date field is anyway.
 *
 * **Root block only.** A field on a nested block would make the index depend on
 * which blocks exist inside a document, so a block insert would change the index
 * and the publish-time write would no longer be a fixed projection. An `indexed`
 * flag on a block that is no document type's root is reported by `/folio/audit`
 * rather than silently doing nothing.
 */
interface Indexable {
  indexed?: boolean
}

export interface SelectOption {
  label: string
  value: string
}

export type Field =
  | ({ kind: 'text'; placeholder?: string } & Common & Indexable)
  | ({ kind: 'textarea'; rows?: number; placeholder?: string } & Common & Indexable)
  | ({ kind: 'number'; min?: number; max?: number } & Common & Indexable)
  | ({ kind: 'boolean' } & Common & Indexable)
  | ({ kind: 'select'; options: readonly SelectOption[] } & Common & Indexable)
  /** `accept` is passed to the file picker, e.g. `'image/*'` or `'.pdf'`. */
  | ({ kind: 'asset'; accept?: string } & Common)
  | ({ kind: 'multiasset'; accept?: string; max?: number } & Common)
  /**
   * `allow` narrows which kinds of target the editor offers, so a "Read more"
   * button can be restricted to internal pages while a footer link is not.
   * `types` narrows a story target further, to particular document types.
   * Omitting it permits every type — but never an unrouted document, which has
   * no URL to link to and always resolves `broken`.
   */
  | ({ kind: 'multilink'; allow?: readonly LinkKind[]; types?: readonly string[] } & Common)
  /**
   * `marks` and `nodes` constrain what the editor offers *and* what the renderer
   * will emit, so a caption can permit bold and links and nothing else. Omitting
   * either permits everything.
   */
  | ({
      kind: 'richtext'
      marks?: readonly RichtextMarkName[]
      nodes?: readonly RichtextNodeName[]
      headingLevels?: readonly number[]
    } & Common)
  /**
   * Points at another document and resolves its content at render time.
   * `types` narrows the candidates to particular document types, so a
   * form-embed block cannot be wired to the homepage; omitting it offers every
   * document. Enforced twice, like `richtext`'s `marks`/`nodes`: the admin's
   * picker only offers matching documents, and `resolveReference` re-checks,
   * because content can also arrive from an importer or over the API
   * (`document-types.md` architecture decision 5).
   */
  | ({ kind: 'reference'; types?: readonly string[] } & Common)
  /**
   * A hand-picked, **ordered** list of documents
   * (`../../docs/specs/content-model/data-documents.md` architecture
   * decision 3): "these three people, in this order".
   *
   * The plural of `reference`, and deliberately not a `collection` with a manual
   * filter — a query cannot express an order somebody chose by dragging, and
   * `ord` on the records themselves is one global order rather than a per-usage
   * one.
   *
   * Stored as an array of story ids. `types` narrows the picker and is
   * re-checked by `resolveReferences`, exactly as `reference`'s is. `min` is
   * surfaced in the admin as a warning and **not** enforced on write, because
   * `required` is declared-and-ignored across the whole field system and this
   * field should not invent its own enforcement ahead of the rest; `max` *is*
   * enforced by the input, which is the only place a pick can be refused.
   */
  | ({
      kind: 'references'
      types?: readonly string[]
      min?: number
      max?: number
    } & Common)
  // Children are separate bloks, not a value on the parent, so `blocks` is the
  // one kind that cannot carry a `default` — a preset's `children` is the
  // equivalent (`field-defaults-and-presets.md`, decision 1) — and, for the same
  // reason, cannot be `translatable`: per-locale structure is the trade
  // `localisation.md`'s decision 1 makes, so `blocks({ translatable: true })`
  // must not compile.
  | ({ kind: 'blocks'; allow: readonly string[]; max?: number } & Omit<
      Common,
      'default' | 'translatable'
    >)
  /**
   * A list of published documents, described as a query the editor narrows
   * (`../../docs/specs/content-model/collections.md` architecture decision 5).
   *
   * The field declares the shape of the query — which type, which fields the
   * editor may filter by, how many per page, how it sorts by default — and the
   * stored value is only the editor's choices within it. Both are enforced on the
   * way in *and* on the way out, the same double enforcement `richtext`'s `marks`
   * has, because a value can also arrive from an importer or over the API.
   *
   * Not `translatable`, and the type says so: the locale belongs on the *query*
   * (which locale's index rows to filter and sort against, taken from the
   * resolution), never on the configuration. A French index page and an English
   * one are the same collection read in two languages.
   *
   * Items arrive as `ReferenceTarget`s — the shape `reference` already resolves to
   * — so a block author who can render a reference can render a collection item
   * with no new knowledge.
   */
  | ({
      kind: 'collection'
      /** Document type(s) to list. Absent lists every type. */
      type?: string | readonly string[]
      /** Fields the editor may narrow by. Each must be `indexed` on a root block. */
      filterable?: readonly string[]
      /** Ceiling on the editor's count, itself capped at 100. */
      maxPerPage?: number
      defaultOrder?: { field: string; dir: 'asc' | 'desc' }
    } & Omit<Common, 'translatable'>)

type Opts<K extends Field['kind']> = Omit<Extract<Field, { kind: K }>, 'kind'>

/** `default`, when given, is typed to the field's own value, not just `Json`. */
type Defaulted<K extends Field['kind'], V> = Omit<Opts<K>, 'default'> & { default?: V }

export const text = (o: Defaulted<'text', string> = {}) => ({ kind: 'text' as const, ...o })
export const textarea = (o: Opts<'textarea'> = {}) => ({ kind: 'textarea' as const, ...o })
export const number = (o: Defaulted<'number', number> = {}) => ({ kind: 'number' as const, ...o })
export const boolean = (o: Defaulted<'boolean', boolean> = {}) => ({
  kind: 'boolean' as const,
  ...o,
})
export const asset = (o: Opts<'asset'> = {}) => ({ kind: 'asset' as const, ...o })
export const multiasset = (o: Opts<'multiasset'> = {}) => ({ kind: 'multiasset' as const, ...o })

export const multilink = <const T extends readonly LinkKind[]>(
  o: Omit<Opts<'multilink'>, 'allow'> & { allow?: T } = {},
) => ({ kind: 'multilink' as const, ...o })

export const richtext = (o: Opts<'richtext'> = {}) => ({ kind: 'richtext' as const, ...o })
export const reference = (o: Opts<'reference'> = {}) => ({ kind: 'reference' as const, ...o })
export const references = (o: Defaulted<'references', string[]> = {}) => ({
  kind: 'references' as const,
  ...o,
})

export const select = <const T extends readonly SelectOption[]>(
  o: Omit<Opts<'select'>, 'options' | 'default'> & { options: T; default?: T[number]['value'] },
) => ({ kind: 'select' as const, ...o })

export const blocks = <const T extends readonly string[]>(
  o: Omit<Opts<'blocks'>, 'allow'> & { allow: T },
) => ({ kind: 'blocks' as const, ...o })

export const collection = (o: Opts<'collection'> = {}) => ({ kind: 'collection' as const, ...o })

/**
 * What a field hands to `render`. A `blocks` field arrives already rendered, so
 * a block author just drops `{body}` into their JSX; a `multilink` arrives
 * already resolved, so they get an `href` and never see a story id.
 *
 * Fields whose value can be absent resolve to `null` rather than to an empty
 * object, so `{link ? … : null}` is the natural way to write a block.
 */
export type ValueOf<F extends Field> = F extends { kind: 'blocks' | 'richtext' }
  ? ReactNode
  : F extends { kind: 'number' }
    ? number
    : F extends { kind: 'boolean' }
      ? boolean
      : F extends { kind: 'multilink' }
        ? ResolvedLink | null
        : F extends { kind: 'asset' }
          ? ResolvedAsset | null
          : F extends { kind: 'multiasset' }
            ? ResolvedAsset[]
            : F extends { kind: 'reference' }
              ? ResolvedReference | null
              : // Never null, and never with a hole in it: an unresolvable entry
                // is dropped, so a block writes `team.map(…)` without guarding
                // each item (`data-documents.md` decision 3).
                F extends { kind: 'references' }
                ? ResolvedReference[]
                : // Never null: an empty page is a page, so a block writes
                  // `list.items.map(…)` without a guard and an empty collection
                  // renders its own empty state rather than crashing.
                  F extends { kind: 'collection' }
                  ? ResolvedCollection
                  : F extends { kind: 'select'; options: readonly (infer O)[] }
                    ? O extends SelectOption
                      ? O['value']
                      : string
                    : string

export type PropsOf<F extends Record<string, Field>> = { [K in keyof F]: ValueOf<F[K]> }

export function defaultValue(f: Field): Json {
  switch (f.kind) {
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'select':
      return f.options[0]?.value ?? ''
    case 'blocks':
      // Children are separate bloks, not a value on the parent.
      return null
    case 'collection':
      // An empty object, not null: the value is the editor's choices, and `{}`
      // means "the field's own defaults", which is what a fresh block wants.
      return {}
    case 'multilink':
    case 'asset':
    case 'richtext':
    case 'reference':
      return null
    // Both plural, both empty rather than null, so a fresh block's stored value
    // already has the shape its input and its renderer expect.
    case 'multiasset':
    case 'references':
      return []
    default:
      return ''
  }
}
