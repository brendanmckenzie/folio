import type { Blok } from './doc'
import { isBlok, MAX_FRAME_BYTES } from './protocol'
import type { SchemaIndex } from './schema'

/** What `Cmd+C` writes to the system clipboard, self-describing so a paste —
 * possibly on another page, another day, another Folio install — can be
 * validated before a single mutation is built. `folio: 1` is a format version
 * of its own, independent of the wire's `PROTOCOL_VERSION`: this is text a
 * user can carry between browser tabs or paste into a text editor and back,
 * not a socket frame, so it has no business tracking the sync protocol's
 * version at all. */
export interface ClipboardPayload {
  folio: 1
  bloks: Blok[]
  /** Diagnostic only, never trusted: lets the admin say "3 blocks copied from
   * /about" without the paste side re-deriving it. */
  from?: { storyId: string; path: string }
}

export type ParsedClipboard = { bloks: Blok[]; from?: { storyId: string; path: string } }

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const isString = (x: unknown): x is string => typeof x === 'string'

/**
 * Validates clipboard `text` against `schema`, in the order
 * `duplicate-and-paste.md`'s architecture decision 3 lists: too large to read
 * safely; not JSON; not a Folio payload of a version this build understands;
 * no blocks; a malformed blok; a type this site does not define; a child
 * whose type its parent's own declared slot does not `allow`.
 *
 * Deliberately does *not* check the top blok's placement against a
 * destination slot, nor that slot's `max` — both depend on where the paste
 * lands, which only the caller (holding the current selection) knows. Those
 * two live in `pasteInsert` (admin/hooks/useBlocks.ts).
 *
 * Returns a result rather than throwing, mirroring `parseClientFrame`'s
 * discipline: a paste event handler must be able to answer untrusted input,
 * never crash on it.
 */
export function parseClipboard(
  text: string,
  schema: SchemaIndex,
): ParsedClipboard | { error: string } {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes > MAX_FRAME_BYTES) {
    return { error: `too large to paste: ${bytes} bytes exceeds the ${MAX_FRAME_BYTES} byte cap` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'Clipboard does not contain valid JSON.' }
  }

  if (!isRecord(parsed)) {
    return { error: 'Clipboard does not contain a Folio block payload.' }
  }
  if (parsed.folio !== 1) {
    return {
      error: 'Clipboard content is not from Folio, or is from a version this editor does not read.',
    }
  }
  if (!Array.isArray(parsed.bloks) || parsed.bloks.length === 0) {
    return { error: 'Clipboard holds no blocks.' }
  }
  if (!parsed.bloks.every(isBlok)) {
    return { error: 'Clipboard does not contain a valid set of blocks.' }
  }
  const bloks = parsed.bloks as Blok[]

  const unknownTypes = [...new Set(bloks.map((b) => b.type).filter((t) => !schema[t]))]
  if (unknownTypes.length > 0) {
    return {
      error: `This site does not define: ${unknownTypes.join(', ')}.`,
    }
  }

  // Every child's type must be permitted by its actual parent's declared
  // slot — walking the whole payload, not only the top blok, is what a
  // hand-edited clipboard needs (edge case: "a child violates its parent's
  // allow"). The top blok is exempt: its placement is checked against the
  // *destination*, by `pasteInsert`, once the paste target is known.
  const byUid = new Map(bloks.map((b) => [b.uid, b]))
  const top = bloks[0]!
  for (const b of bloks) {
    if (b.uid === top.uid) continue
    const parent = b.parent ? byUid.get(b.parent) : undefined
    if (!parent || b.slot === null) {
      return { error: `'${b.type}' has no valid parent within the copied blocks.` }
    }
    const field = schema[parent.type]?.fields[b.slot]
    if (field?.kind !== 'blocks' || !field.allow.includes(b.type)) {
      const parentLabel = schema[parent.type]?.label ?? parent.type
      return { error: `'${b.type}' is not allowed in ${parentLabel}'s '${b.slot}'.` }
    }
  }

  const from =
    isRecord(parsed.from) && isString(parsed.from.storyId) && isString(parsed.from.path)
      ? { storyId: parsed.from.storyId, path: parsed.from.path }
      : undefined

  return from ? { bloks, from } : { bloks }
}
