import { describe, expect, it } from 'vitest'
import { deepEqual } from '../../src/core/diff'

describe('test harness', () => {
  it('imports core modules directly from source', () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })
})
