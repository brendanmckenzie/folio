import { describe, expect, it } from 'vitest'
import { parseClipboard } from '../../../src/core/clipboard'
import type { Blok } from '../../../src/core/doc'
import { blocks, text } from '../../../src/core/fields'
import { MAX_FRAME_BYTES } from '../../../src/core/protocol'
import type { BlockSchema, SchemaIndex } from '../../../src/core/schema'

// duplicate-and-paste.md's architecture decision 3: validation, in order,
// before a single mutation is built. Every refusal names what was wrong —
// "paste did nothing" is the worst possible outcome.

const button: BlockSchema = {
  name: 'button',
  label: 'Button',
  fields: { label: text() },
}

const hero: BlockSchema = {
  name: 'hero',
  label: 'Hero',
  fields: { actions: blocks({ allow: ['button'], max: 2 }) },
}

const schema: SchemaIndex = { button, hero }

function blok(overrides: Partial<Blok> & { uid: string; type: string }): Blok {
  return { parent: null, slot: null, order: 'a0', data: {}, ...overrides }
}

function payload(body: unknown): string {
  return JSON.stringify(body)
}

describe('parseClipboard: the happy paths', () => {
  it('parses a single blok with no children', () => {
    const result = parseClipboard(
      payload({ folio: 1, bloks: [blok({ uid: 'u1', type: 'button' })] }),
      schema,
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.bloks).toHaveLength(1)
  })

  it('parses a blok plus a legally-slotted child', () => {
    const result = parseClipboard(
      payload({
        folio: 1,
        bloks: [
          blok({ uid: 'h1', type: 'hero' }),
          blok({ uid: 'b1', type: 'button', parent: 'h1', slot: 'actions' }),
        ],
      }),
      schema,
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.bloks).toHaveLength(2)
  })

  it('carries `from` through when present and well-shaped', () => {
    const result = parseClipboard(
      payload({
        folio: 1,
        bloks: [blok({ uid: 'u1', type: 'button' })],
        from: { storyId: 'sty_abc', path: 'about' },
      }),
      schema,
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.from).toEqual({ storyId: 'sty_abc', path: 'about' })
  })

  it('omits `from` when absent, without treating that as a failure', () => {
    const result = parseClipboard(
      payload({ folio: 1, bloks: [blok({ uid: 'u1', type: 'button' })] }),
      schema,
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.from).toBeUndefined()
  })

  it('omits `from` when malformed, rather than failing the whole paste over diagnostic-only data', () => {
    const result = parseClipboard(
      payload({
        folio: 1,
        bloks: [blok({ uid: 'u1', type: 'button' })],
        from: { storyId: 123 },
      }),
      schema,
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.from).toBeUndefined()
  })
})

describe('parseClipboard: every refusal path', () => {
  it('refuses a payload larger than the frame cap, before JSON.parse ever runs', () => {
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 1)
    const result = parseClipboard(huge, schema)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toMatch(/too large/)
  })

  it('refuses malformed JSON', () => {
    const result = parseClipboard('{not json', schema)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toMatch(/JSON/)
  })

  it('refuses non-Folio text (valid JSON, wrong shape)', () => {
    const result = parseClipboard(payload('just a string, not a Folio payload'), schema)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toMatch(/Folio block payload/)
  })

  it('refuses a payload whose folio version this build does not read', () => {
    const result = parseClipboard(payload({ folio: 2, bloks: [] }), schema)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toMatch(/not from Folio|does not read/)
  })

  it('refuses an empty bloks array', () => {
    const result = parseClipboard(payload({ folio: 1, bloks: [] }), schema)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toMatch(/no blocks/)
  })

  it('refuses when bloks is not an array at all', () => {
    const result = parseClipboard(payload({ folio: 1, bloks: 'nope' }), schema)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toMatch(/no blocks/)
  })

  it('refuses a malformed blok (missing required Blok fields)', () => {
    const result = parseClipboard(payload({ folio: 1, bloks: [{ uid: 'u1' }] }), schema)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toMatch(/valid set of blocks/)
  })

  it('refuses a block type this site does not define, naming it', () => {
    const result = parseClipboard(
      payload({ folio: 1, bloks: [blok({ uid: 'u1', type: 'nope' })] }),
      schema,
    )
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('nope')
  })

  it('names every unknown type when there is more than one', () => {
    const result = parseClipboard(
      payload({
        folio: 1,
        bloks: [blok({ uid: 'u1', type: 'nope' }), blok({ uid: 'u2', type: 'alsonope' })],
      }),
      schema,
    )
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('nope')
    expect(result.error).toContain('alsonope')
  })

  it('refuses a child whose type its parent’s declared slot does not allow (hand-edited clipboard)', () => {
    const result = parseClipboard(
      payload({
        folio: 1,
        bloks: [
          blok({ uid: 'h1', type: 'hero' }),
          // 'hero' is not a legal child of its own 'actions' slot.
          blok({ uid: 'h2', type: 'hero', parent: 'h1', slot: 'actions' }),
        ],
      }),
      schema,
    )
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('hero')
    expect(result.error).toContain('actions')
  })

  it('refuses a child whose parent uid is not present in the payload at all', () => {
    const result = parseClipboard(
      payload({
        folio: 1,
        bloks: [
          blok({ uid: 'h1', type: 'hero' }),
          blok({ uid: 'b1', type: 'button', parent: 'ghost', slot: 'actions' }),
        ],
      }),
      schema,
    )
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toMatch(/no valid parent/)
  })
})
