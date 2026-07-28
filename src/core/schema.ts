import { type Blok, type Json, newUid } from './doc'
import { defaultValue, type Field } from './fields'
import { asRichtext, richtextToText } from './richtext'
import { asAsset } from './values'

/**
 * The serializable half of a block definition. This is everything the admin UI
 * needs, which is why the admin can ship prebuilt and learn about a project's
 * blocks over HTTP instead of at build time.
 */
export interface BlockSchema {
  name: string
  label: string
  /** Field name whose value labels this block in the tree. */
  summary?: string
  fields: Record<string, Field>
}

export type SchemaIndex = Record<string, BlockSchema>

export interface Manifest {
  /** Block type used as the document root. */
  root: string
  blocks: BlockSchema[]
}

export function indexManifest(manifest: Manifest): SchemaIndex {
  return Object.fromEntries(manifest.blocks.map((b) => [b.name, b]))
}

export function summarise(schema: BlockSchema | undefined, data: Record<string, Json>): string {
  if (!schema?.summary) return ''
  const value = data[schema.summary]
  if (value == null) return ''

  // Fields whose value is an object need unwrapping, or the block tree fills up
  // with "[object Object]".
  switch (schema.fields[schema.summary]?.kind) {
    case 'richtext':
      return richtextToText(asRichtext(value)).slice(0, 64)
    case 'asset':
      return asAsset(value)?.filename.slice(0, 64) ?? ''
    default:
      return typeof value === 'object' ? '' : String(value).slice(0, 64)
  }
}

export function blankBlok(
  schema: SchemaIndex,
  type: string,
  parent: string | null,
  slot: string | null,
  order: string,
): Blok {
  const def = schema[type]
  if (!def) throw new Error(`Unknown block type: ${type}`)
  const data: Record<string, Json> = {}
  for (const [name, field] of Object.entries(def.fields)) {
    if (field.kind !== 'blocks') data[name] = defaultValue(field)
  }
  return { uid: newUid(), type, parent, slot, order, data }
}

/** Slots (blocks-kind fields) declared by a block type. */
export function slotsOf(schema: BlockSchema | undefined): [string, Extract<Field, { kind: 'blocks' }>][] {
  if (!schema) return []
  return Object.entries(schema.fields).filter(
    (entry): entry is [string, Extract<Field, { kind: 'blocks' }>] => entry[1].kind === 'blocks',
  )
}
