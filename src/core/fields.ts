import type { ReactNode } from 'react'
import type { Json } from './doc'
import type { ResolvedAsset, ResolvedLink, ResolvedReference } from './resolve'
import type { RichtextMarkName, RichtextNodeName } from './richtext'
import type { LinkKind } from './values'

interface Common {
  label?: string
  help?: string
  required?: boolean
}

export interface SelectOption {
  label: string
  value: string
}

export type Field =
  | ({ kind: 'text'; placeholder?: string } & Common)
  | ({ kind: 'textarea'; rows?: number; placeholder?: string } & Common)
  | ({ kind: 'number'; min?: number; max?: number } & Common)
  | ({ kind: 'boolean' } & Common)
  | ({ kind: 'select'; options: readonly SelectOption[] } & Common)
  /** `accept` is passed to the file picker, e.g. `'image/*'` or `'.pdf'`. */
  | ({ kind: 'asset'; accept?: string } & Common)
  | ({ kind: 'multiasset'; accept?: string; max?: number } & Common)
  /**
   * `allow` narrows which kinds of target the editor offers, so a "Read more"
   * button can be restricted to internal pages while a footer link is not.
   */
  | ({ kind: 'multilink'; allow?: readonly LinkKind[] } & Common)
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
   * Points at another story and resolves its content at render time. Filtering
   * candidates by document type needs multiple document types, which Folio does
   * not have yet, so every story is offered.
   */
  | ({ kind: 'reference' } & Common)
  | ({ kind: 'blocks'; allow: readonly string[]; max?: number } & Common)

type Opts<K extends Field['kind']> = Omit<Extract<Field, { kind: K }>, 'kind'>

export const text = (o: Opts<'text'> = {}) => ({ kind: 'text' as const, ...o })
export const textarea = (o: Opts<'textarea'> = {}) => ({ kind: 'textarea' as const, ...o })
export const number = (o: Opts<'number'> = {}) => ({ kind: 'number' as const, ...o })
export const boolean = (o: Opts<'boolean'> = {}) => ({ kind: 'boolean' as const, ...o })
export const asset = (o: Opts<'asset'> = {}) => ({ kind: 'asset' as const, ...o })
export const multiasset = (o: Opts<'multiasset'> = {}) => ({ kind: 'multiasset' as const, ...o })

export const multilink = <const T extends readonly LinkKind[]>(
  o: Omit<Opts<'multilink'>, 'allow'> & { allow?: T } = {},
) => ({ kind: 'multilink' as const, ...o })

export const richtext = (o: Opts<'richtext'> = {}) => ({ kind: 'richtext' as const, ...o })
export const reference = (o: Opts<'reference'> = {}) => ({ kind: 'reference' as const, ...o })

export const select = <const T extends readonly SelectOption[]>(
  o: Omit<Opts<'select'>, 'options'> & { options: T },
) => ({ kind: 'select' as const, ...o })

export const blocks = <const T extends readonly string[]>(
  o: Omit<Opts<'blocks'>, 'allow'> & { allow: T },
) => ({ kind: 'blocks' as const, ...o })

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
    case 'multilink':
    case 'asset':
    case 'richtext':
    case 'reference':
      return null
    case 'multiasset':
      return []
    default:
      return ''
  }
}
