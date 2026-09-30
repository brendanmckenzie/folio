/**
 * A stable digest of a brand's blocks, computed identically by the server (into the
 * preview bootstrap) and by the preview bundle (`preview/mount.tsx`)
 * (`../../docs/specs/foundation/multi-brand.md` decision 11).
 *
 * **One module, so the two ends cannot compute it two ways.** It catches the one
 * mistake per-brand bundles make likely: a Vite plugin key pointing at the wrong
 * brand's blocks module, which hydrates a page whose blocks the server never heard
 * of. The digest is a readable string rather than a hash because the mismatch
 * notice has to name the blocks that differ, and a hash cannot be diffed.
 *
 * Each block contributes its name and its fields' names and kinds, all sorted, so
 * declaration order never matters. Labels, presets and every other property are left
 * out on purpose: a relabelled block is not a wrong bundle.
 */
import type { SchemaIndex } from './schema'

/** The blocks of `schema` as `name(field:kind,…)`, sorted, joined with `;`. */
export function computeBlocksDigest(schema: SchemaIndex): string {
  return Object.values(schema)
    .map((block) => {
      const fields = Object.entries(block.fields)
        .map(([name, field]) => `${name}:${field.kind}`)
        .sort()
      return `${block.name}(${fields.join(',')})`
    })
    .sort()
    .join(';')
}

/** How two digests differ, by block name. All three empty means the digests agree. */
export interface BlocksDigestDiff {
  /** Blocks the server has and the bundle lacks. */
  missing: string[]
  /** Blocks the bundle has and the server lacks. */
  extra: string[]
  /** Blocks both have, with a different set of fields or kinds. */
  changed: string[]
}

function parse(digest: string): Map<string, string> {
  const blocks = new Map<string, string>()
  for (const entry of digest.split(';')) {
    if (entry === '') continue
    const open = entry.indexOf('(')
    blocks.set(entry.slice(0, open), entry.slice(open))
  }
  return blocks
}

/** `server` is the digest the bootstrap carried; `client` is the bundle's own. */
export function diffBlocksDigest(server: string, client: string): BlocksDigestDiff {
  const a = parse(server)
  const b = parse(client)
  const diff: BlocksDigestDiff = { missing: [], extra: [], changed: [] }
  for (const [name, shape] of a) {
    const other = b.get(name)
    if (other === undefined) diff.missing.push(name)
    else if (other !== shape) diff.changed.push(name)
  }
  for (const name of b.keys()) if (!a.has(name)) diff.extra.push(name)
  diff.missing.sort()
  diff.extra.sort()
  diff.changed.sort()
  return diff
}
