import { describe, expect, it } from 'vitest'
import { roleFromClaim } from '../../../src/server/auth/roles-from'

/**
 * `roleFromClaim` on a deployment with `sites` (`docs/specs/foundation/multi-site.md`
 * decision 17): a claim value may place a role on one scope, and the highest match
 * is taken **per scope**. A map that names no scope is the mapper it always was,
 * answering a bare role — `test/unit/server/auth.test.ts` holds those cases.
 */

const who = (groups: unknown) => ({ email: 'x@example.com', claims: { groups } })

const mapper = roleFromClaim({
  claim: 'groups',
  map: {
    'g-alpha': { scope: 'alpha', role: 'editor' },
    'g-alpha-lead': { scope: 'alpha', role: 'publisher' },
    'g-bravo': { scope: 'bravo', role: 'viewer' },
    'g-bravo-lead': { scope: 'bravo', role: 'publisher' },
    'g-both': [
      { scope: 'alpha', role: 'viewer' },
      { scope: 'bravo', role: 'editor' },
    ],
    'g-central': 'admin',
  },
})

describe('roleFromClaim, per scope', () => {
  it('takes the highest match within a scope', () => {
    expect(mapper(who(['g-alpha', 'g-alpha-lead']))).toEqual({ alpha: 'publisher' })
    expect(mapper(who(['g-alpha-lead', 'g-alpha']))).toEqual({ alpha: 'publisher' })
  })

  it('keeps every scope its own highest, never one role across them', () => {
    expect(mapper(who(['g-alpha-lead', 'g-bravo']))).toEqual({
      alpha: 'publisher',
      bravo: 'viewer',
    })
    expect(mapper(who(['g-alpha', 'g-bravo-lead']))).toEqual({
      alpha: 'editor',
      bravo: 'publisher',
    })
  })

  it('reads a list of targets on one value, and a bare role as *', () => {
    expect(mapper(who(['g-both', 'g-alpha']))).toEqual({ alpha: 'editor', bravo: 'editor' })
    expect(mapper(who(['g-central', 'g-bravo']))).toEqual({ '*': 'admin', bravo: 'viewer' })
  })

  it('answers null for nothing matched, and the default on * when one is named', () => {
    expect(mapper(who(['elsewhere']))).toBeNull()
    const withDefault = roleFromClaim({
      claim: 'groups',
      map: { 'g-alpha': { scope: 'alpha', role: 'editor' } },
      default: 'viewer',
    })
    expect(withDefault(who([]))).toEqual({ '*': 'viewer' })
  })

  it('stays a bare-role mapper when the map names no scope', () => {
    const flat = roleFromClaim({ claim: 'groups', map: { a: 'editor', b: 'admin' } })
    expect(flat(who(['a', 'b']))).toBe('admin')
    expect(flat(who(['nothing']))).toBeNull()
  })

  it('refuses a target that is not a role, or names no scope, at construction', () => {
    expect(() =>
      roleFromClaim({
        claim: 'groups',
        map: { g: { scope: 'alpha', role: 'owner' as 'admin' } },
      }),
    ).toThrow(/not a role/)
    expect(() =>
      roleFromClaim({ claim: 'groups', map: { g: { scope: '', role: 'editor' } } }),
    ).toThrow(/no scope/)
  })

  it('ignores a claim value that names an inherited property', () => {
    expect(mapper(who(['constructor', 'toString', 'g-alpha']))).toEqual({ alpha: 'editor' })
  })
})
