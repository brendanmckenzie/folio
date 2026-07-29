import type { ReactNode } from 'react'
import type { Field, PropsOf } from './fields'
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
  render: (props: PropsOf<F> & { uid: string }) => ReactNode
}

export function defineBlock<const F extends Record<string, Field>>(def: BlockDef<F>): BlockDef<F> {
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
export function toManifest(registry: Registry, types: readonly DocumentType[]): Manifest {
  return {
    types: [...types],
    blocks: Object.values(toSchemaIndex(registry)),
    root: defaultType(types).root,
  }
}
