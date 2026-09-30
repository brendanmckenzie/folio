import { describe, expect, it } from 'vitest'
import { boolean, defineBlock, text, toRegistry, toSchemaIndex } from '../../../src/core'
import { computeBlocksDigest, diffBlocksDigest } from '../../../src/core/registry-digest'

/** The digest the server writes into the preview bootstrap and the bundle recomputes. */

const block = (name: string, fields: Parameters<typeof defineBlock>[0]['fields'] = { t: text() }) =>
  defineBlock({ name, label: name, fields, render: () => null })

const digestOf = (...blocks: ReturnType<typeof block>[]) =>
  computeBlocksDigest(toSchemaIndex(toRegistry(blocks)))

describe('computeBlocksDigest', () => {
  it('does not depend on declaration order, of blocks or of fields', () => {
    const a = digestOf(block('a', { x: text(), y: boolean() }), block('b'))
    const b = digestOf(block('b'), block('a', { y: boolean(), x: text() }))
    expect(a).toBe(b)
  })

  it('ignores labels', () => {
    const relabelled = defineBlock({
      name: 'a',
      label: 'Something else',
      fields: { t: text() },
      render: () => null,
    })
    expect(computeBlocksDigest(toSchemaIndex(toRegistry([relabelled])))).toBe(digestOf(block('a')))
  })

  it('changes with a block', () => {
    expect(digestOf(block('a'))).not.toBe(digestOf(block('a'), block('b')))
  })

  it('changes with a field', () => {
    expect(digestOf(block('a', { t: text() }))).not.toBe(
      digestOf(block('a', { t: text(), u: text() })),
    )
  })

  it('changes with a field kind', () => {
    expect(digestOf(block('a', { t: text() }))).not.toBe(digestOf(block('a', { t: boolean() })))
  })
})

describe('diffBlocksDigest', () => {
  it('is empty for equal digests', () => {
    const d = digestOf(block('a'), block('b'))
    expect(diffBlocksDigest(d, d)).toEqual({ missing: [], extra: [], changed: [] })
  })

  it('names what the bundle lacks, what it adds, and what it defines differently', () => {
    const server = digestOf(block('a'), block('b'), block('c', { t: text() }))
    const client = digestOf(block('b'), block('c', { t: boolean() }), block('z'))
    expect(diffBlocksDigest(server, client)).toEqual({
      missing: ['a'],
      extra: ['z'],
      changed: ['c'],
    })
  })

  it('reads an empty registry', () => {
    expect(diffBlocksDigest('', digestOf(block('a')))).toEqual({
      missing: [],
      extra: ['a'],
      changed: [],
    })
  })
})
