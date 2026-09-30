import { describe, expect, it } from 'vitest'
import { defineBlock, text, toRegistry } from '../../../src/core'

/** `toRegistry` refuses a registry it would have to guess about (spec 34, phase 1). */

const block = (name: string) =>
  defineBlock({ name, label: name, fields: { t: text() }, render: () => null })

describe('toRegistry', () => {
  it('keys the array form by block name', () => {
    const a = block('a')
    const b = block('b')
    expect(toRegistry([a, b])).toEqual({ a, b })
  })

  it('passes a matching object form through', () => {
    const reg = { a: block('a'), b: block('b') }
    expect(toRegistry(reg)).toBe(reg)
  })

  it('throws on a repeated name in the array form', () => {
    expect(() => toRegistry([block('prose'), block('hero'), block('prose')])).toThrow(
      "folio: duplicate block 'prose'",
    )
  })

  it('throws when an object key is not its block name', () => {
    expect(() => toRegistry({ hero: block('banner') })).toThrow(
      "folio: registry key 'hero' names block 'banner'",
    )
  })
})
