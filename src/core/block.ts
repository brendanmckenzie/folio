import type { ReactNode } from 'react'
import type { Field, PropsOf } from './fields'
import type { LocaleConfig } from './locales'
import {
  type BlockSchema,
  defaultType,
  type DocumentType,
  type Manifest,
  type SchemaIndex,
} from './schema'

/**
 * Schema and renderer in one place. The admin form, the TypeScript prop types
 * and the rendered HTML all derive from `fields`, so they cannot drift.
 */
export interface BlockDef<F extends Record<string, Field> = Record<string, Field>>
  extends BlockSchema {
  fields: F
  /** Field name used to label this block in the editor's tree. */
  summary?: Extract<keyof F, string>
  /**
   * **Optional** (`../../../docs/specs/content-model/data-documents.md`
   * checkpoint 1). A record root — a person, an office, a partner logo — has no
   * layout of its own and should not have to return `null` from a mandatory
   * function to say so. `defineRecord` below is the sugar that omits it.
   *
   * Absent renders **nothing at all** on a published page and a
   * `folio-unrendered` placeholder in edit mode, naming the type: the same
   * posture as an unknown block type, and for the same reason — an editor must
   * be able to see that something is there and not renderable, and a published
   * page must never show scaffolding.
   *
   * Optional on *every* block, not only record roots, deliberately: the type
   * system cannot tell a record root from any other block (both are `BlockDef`),
   * and inventing a marker to enforce it would buy nothing. A content block with
   * no renderer is a mistake, and it is a visible one.
   */
  render?: (props: PropsOf<F> & { uid: string }) => ReactNode
}

export function defineBlock<const F extends Record<string, Field>>(def: BlockDef<F>): BlockDef<F> {
  return def
}

/**
 * A document type's root block for content with nothing to render — the usable
 * half of `kind: 'record'` (`data-documents.md` checkpoint 1).
 *
 * Sugar, and nothing more: `render` is optional on every `BlockDef` now, so this
 * is `defineBlock` under a name that says what the definition is *for*. The
 * return type is the same `BlockDef<F>`, so a record root still flows through
 * `toSchemaIndex`, `blankBlok`, the manifest and the inspector unchanged — no
 * second definition kind, no fork in the schema pipeline.
 *
 * A record **may** still carry a renderer, and it is used for
 * `reference.content` (checkpoint 2): a "Person card" block can drop
 * `{person.content}` and get a consistent card wherever a person is referenced.
 * Records without one give `content: null`, and blocks read `person.data`.
 */
export function defineRecord<const F extends Record<string, Field>>(def: BlockDef<F>): BlockDef<F> {
  return def
}

/**
 * A block of unknown field shape. `any` is deliberate: `render` is
 * contravariant in its props, so a concretely-typed BlockDef is not assignable
 * to `BlockDef<Record<string, Field>>`. Authors keep full inference at the
 * `defineBlock` call site; only the collection type is loose.
 */
// biome-ignore lint/suspicious/noExplicitAny: see doc comment above
export type AnyBlockDef = BlockDef<any>

export type Registry = Record<string, AnyBlockDef>

/** Accepts the array form authors naturally write, or a pre-keyed object. */
export function toRegistry(blocks: readonly AnyBlockDef[] | Registry): Registry {
  if (!Array.isArray(blocks)) return blocks as Registry
  return Object.fromEntries((blocks as readonly AnyBlockDef[]).map((b) => [b.name, b]))
}

export function toSchemaIndex(registry: Registry): SchemaIndex {
  return Object.fromEntries(
    Object.entries(registry).map(([name, def]) => [
      name,
      {
        name: def.name,
        label: def.label,
        summary: def.summary,
        fields: def.fields,
        presets: def.presets,
        presetsOnly: def.presetsOnly,
      } satisfies BlockSchema,
    ]),
  )
}

/**
 * What `/api/folio/schema` returns. Contains no functions, so it is cacheable.
 *
 * Takes the whole set of document types rather than the single root block name
 * it took before `document-types.md`: `root` is still emitted, as the *default*
 * page type's root block, so a consumer written against the old manifest keeps
 * reading the same value. The `root: 'page'` config sugar is expanded into a
 * one-element `types` array server-side (`server/runtime.ts`), so this function
 * never sees the string form.
 */
export function toManifest(
  registry: Registry,
  types: readonly DocumentType[],
  globals: readonly string[] = [],
  /** `FolioConfig.locales` (`localisation.md`), so the admin can draw a locale
   * switcher without a second request. Omitted for a single-locale site, which
   * is what makes the admin's own locale state default to "no locales at all". */
  locales?: LocaleConfig,
): Manifest {
  return {
    types: [...types],
    blocks: Object.values(toSchemaIndex(registry)),
    root: defaultType(types).root,
    globals: [...globals],
    ...(locales ? { locales } : {}),
  }
}
