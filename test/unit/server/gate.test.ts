import { describe, expect, it } from 'vitest'
import { asset, blocks, boolean, number, richtext, select, text } from '../../../src/core/fields'
import type { DocumentType, SchemaIndex } from '../../../src/core/schema'
import { validateGate } from '../../../src/server/gate'
import type { FolioConfig, FolioGate } from '../../../src/server/types'

/**
 * Construction-time validation for `gate` (`visitor-access.md` decision 8).
 * Same shape as `validateHooks`' tests in `pure.test.ts`: every throw is checked
 * for the three things a reader needs from it — the type, the field, and the
 * rule that was broken — because the fix is always in a schema file and the
 * message is the only thing that says which one.
 */

interface Env {
  MEMBERSHIP_KEY: string
}

const ACCESS = {
  options: [
    { label: 'Everyone', value: 'public' },
    { label: 'Members', value: 'members' },
  ],
} as const

function schemaWith(access: SchemaIndex[string]['fields'][string]): SchemaIndex {
  return {
    pageRoot: {
      name: 'pageRoot',
      label: 'Page',
      fields: { title: text({ indexed: true }), access, body: blocks({ allow: ['prose'] }) },
    },
    // A `page` root that declares no gate field at all. Public by design, and
    // never a reason to throw (checkpoint 3).
    insightRoot: { name: 'insightRoot', label: 'Insight', fields: { title: text() } },
    // A record's root, declaring the field. Inert: unrouted documents never
    // reach `page()`.
    authorRoot: { name: 'authorRoot', label: 'Author', fields: { access } },
  }
}

const schema = schemaWith(select({ ...ACCESS, indexed: true }))

const TYPES: readonly DocumentType[] = [
  { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot' },
  // Shares `pageRoot` with `page`, which is the case that makes `roots` and
  // `types` two different sets rather than two spellings of one.
  { name: 'landing', label: 'Landing', kind: 'page', root: 'pageRoot' },
  { name: 'insight', label: 'Insight', kind: 'page', root: 'insightRoot' },
  { name: 'author', label: 'Author', kind: 'record', root: 'authorRoot' },
]

function gate(over: Partial<FolioGate<Env>> = {}): FolioGate<Env> {
  return {
    field: 'access',
    public: 'public',
    visitor: () => null,
    allows: () => false,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// A host's own member type stays its own
// ---------------------------------------------------------------------------

interface Member {
  id: string
  tier: 'free' | 'paid'
}

/**
 * Decision 1, checked by the compiler rather than at runtime: `visitor` and
 * `allows` are declared as **methods** so that a host's `FolioGate<Env, Member>`
 * is assignable to the `FolioGate<Env, unknown>` the config holds. Written as
 * property-typed arrows, `strictFunctionTypes` makes both of the assignments
 * below errors, and every host would have to type its member as `unknown` and
 * cast it back on the first line of `allows`.
 *
 * `pnpm typecheck` is what runs this. The `it` below exists so the values are
 * referenced and the file reports the intent.
 */
const memberGate: FolioGate<Env, Member> = {
  field: 'access',
  public: 'public',
  visitor: (req, env) =>
    req.headers.get('authorization') === env.MEMBERSHIP_KEY ? { id: 'm1', tier: 'paid' } : null,
  allows: (visitor, value) => value !== 'members' || visitor?.tier === 'paid',
}

const held: FolioGate<Env> = memberGate
const config: Pick<FolioConfig<Env>, 'gate'> = { gate: memberGate }

describe('FolioGate', () => {
  it('lets a host declare its own visitor type without casting', () => {
    expect(held.field).toBe('access')
    expect(config.gate?.public).toBe('public')
    expect(validateGate(memberGate, TYPES, schema)?.roots.has('pageRoot')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateGate
// ---------------------------------------------------------------------------

describe('validateGate', () => {
  it('answers null when no gate is configured', () => {
    expect(validateGate(undefined, TYPES, schema)).toBeNull()
  })

  it('accepts a good config and returns the declaring roots', () => {
    const resolved = validateGate(gate(), TYPES, schema)
    expect(resolved?.config.field).toBe('access')
    expect([...(resolved?.roots ?? [])]).toEqual(['pageRoot'])
  })

  /**
   * The two sets are what `full-text-search.md` decision 11 binds against, and
   * getting them the wrong way round would scope a search by a name
   * `stories.type` never holds — silently excluding nothing.
   */
  it('answers document type names in `types`, not root block names', () => {
    const resolved = validateGate(gate(), TYPES, schema)
    expect([...(resolved?.types ?? [])].sort()).toEqual(['landing', 'page'])
    expect(resolved?.types.has('pageRoot')).toBe(false)
    expect(resolved?.roots.has('page')).toBe(false)
  })

  it('holds both of two document types sharing one declaring root', () => {
    const resolved = validateGate(gate(), TYPES, schema)
    expect(resolved?.roots.size).toBe(1)
    expect(resolved?.types.size).toBe(2)
  })

  it('ignores a record root that declares the field', () => {
    const resolved = validateGate(gate(), TYPES, schema)
    expect(resolved?.roots.has('authorRoot')).toBe(false)
    expect(resolved?.types.has('author')).toBe(false)
  })

  /**
   * Checkpoint 3, confirmed twice: a `page` root that does not declare the field
   * is public and `visitor` is never called for it. This design fails open
   * there, deliberately — the alternative is a dead field on every genuinely
   * public type.
   */
  it('accepts a page root that declares nothing, as long as one page root does', () => {
    expect(() => validateGate(gate(), TYPES, schema)).not.toThrow()
  })

  it('throws when no page root declares the field, naming the field and the rule', () => {
    expect(() => validateGate(gate({ field: 'members' }), TYPES, schema)).toThrow(
      /`gate\.field` is 'members', which no 'page' document type's root block declares — a gate that gates nothing/,
    )
  })

  it('throws when every declaring root is a record', () => {
    const recordsOnly: readonly DocumentType[] = [
      { name: 'insight', label: 'Insight', kind: 'page', root: 'insightRoot' },
      { name: 'author', label: 'Author', kind: 'record', root: 'authorRoot' },
    ]
    expect(() => validateGate(gate(), recordsOnly, schema)).toThrow(/a gate that gates nothing/)
  })

  for (const [label, field] of [
    ['richtext', richtext()],
    ['asset', asset()],
    ['blocks', blocks({ allow: ['prose'] })],
  ] as const) {
    it(`throws for a ${label} field, naming the type, the field and the kinds it allows`, () => {
      expect(() => validateGate(gate(), TYPES, schemaWith(field))).toThrow(
        new RegExp(
          `document type 'page' declares gate field 'access' on root block 'pageRoot' as kind '${label}'; a gate field must be text, textarea, number, boolean or select`,
        ),
      )
    })
  }

  it('throws for a translatable field', () => {
    const translatable = schemaWith(select({ ...ACCESS, indexed: true, translatable: true }))
    expect(() => validateGate(gate(), TYPES, translatable)).toThrow(
      /document type 'page' declares gate field 'access' on root block 'pageRoot' as translatable; a gate must not vary by locale/,
    )
  })

  it('throws for a field that is not indexed', () => {
    expect(() => validateGate(gate(), TYPES, schemaWith(select(ACCESS)))).toThrow(
      /document type 'page' declares gate field 'access' on root block 'pageRoot' without `indexed: true`/,
    )
  })

  it('throws when `public` is not one of the select options, listing them', () => {
    expect(() => validateGate(gate({ public: 'everyone' }), TYPES, schema)).toThrow(
      /`gate\.public` is "everyone", which is not one of its options \(public, members\)/,
    )
  })

  it('throws for a boolean field with a string `public`', () => {
    const bool = schemaWith(boolean({ indexed: true }))
    expect(() => validateGate(gate({ public: 'false' }), TYPES, bool)).toThrow(
      /document type 'page' declares gate field 'access' on root block 'pageRoot', and `gate\.public` is a string \("false"\); a 'boolean' field needs a boolean/,
    )
  })

  it('accepts a boolean field with a boolean `public`', () => {
    const bool = schemaWith(boolean({ indexed: true }))
    expect(() => validateGate(gate({ public: false }), TYPES, bool)).not.toThrow()
  })

  it('throws for a number field with a string `public`', () => {
    const num = schemaWith(number({ indexed: true }))
    expect(() => validateGate(gate({ public: '0' }), TYPES, num)).toThrow(
      /`gate\.public` is a string \("0"\); a 'number' field needs a number/,
    )
  })

  it('throws for a text field with a number `public`', () => {
    const txt = schemaWith(text({ indexed: true }))
    expect(() => validateGate(gate({ public: 1 }), TYPES, txt)).toThrow(
      /`gate\.public` is a number \(1\); a 'text' field needs a string/,
    )
  })

  it('accepts a text field with an empty-string `public`', () => {
    const txt = schemaWith(text({ indexed: true }))
    const resolved = validateGate(gate({ public: '' }), TYPES, txt)
    expect(resolved?.config.public).toBe('')
  })
})
