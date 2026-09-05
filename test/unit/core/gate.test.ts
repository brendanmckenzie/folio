import { describe, expect, it } from 'vitest'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import {
  asset,
  blocks,
  boolean,
  number,
  reference,
  richtext,
  select,
  text,
  textarea,
} from '../../../src/core/fields'
import { gateValue, isUngated, redactDoc } from '../../../src/core/gate'
import type { SchemaIndex } from '../../../src/core/schema'

/**
 * The pure half of visitor access (`visitor-access.md`). Every rule that decides
 * what a stranger is handed is pinned here without a request, a binding or a
 * membership provider — which is the point of putting it in core.
 */

const pageRoot = {
  name: 'pageRoot',
  label: 'Page',
  fields: {
    title: text({ indexed: true }),
    description: textarea(),
    access: select({
      options: [
        { label: 'Everyone', value: 'public' },
        { label: 'Members', value: 'members' },
      ],
      indexed: true,
    }),
    readingTime: number(),
    featured: boolean(),
    hero: asset(),
    author: reference(),
    standfirst: richtext(),
    body: blocks({ allow: ['prose'] }),
    notes: richtext(),
  },
}

const prose = { name: 'prose', label: 'Prose', fields: { copy: richtext() } }

const schema: SchemaIndex = { pageRoot, prose }

function blok(over: Partial<Blok> & Pick<Blok, 'uid' | 'type'>): Blok {
  return { parent: null, slot: null, order: 'a0', data: {}, ...over }
}

const ROOT_DATA: Record<string, Json> = {
  title: 'About us',
  description: 'The standfirst',
  access: 'members',
  readingTime: 0,
  featured: false,
  hero: { key: 'k1', mime: 'image/png' },
  author: 'st_author',
  standfirst: { type: 'doc', content: [{ type: 'paragraph' }] },
  notes: { type: 'doc', content: [] },
}

function doc(over?: { i18n?: Blok['i18n']; data?: Record<string, Json> }): Doc {
  return {
    root: 'r0',
    bloks: {
      r0: blok({
        uid: 'r0',
        type: 'pageRoot',
        data: over?.data ?? ROOT_DATA,
        ...(over?.i18n ? { i18n: over.i18n } : {}),
      }),
      // Two children, in two different slots, so "drops all children" is not
      // accidentally "drops the `body` slot".
      k1: blok({ uid: 'k1', type: 'prose', parent: 'r0', slot: 'body', data: { copy: 'one' } }),
      k2: blok({ uid: 'k2', type: 'prose', parent: 'r0', slot: 'aside', data: { copy: 'two' } }),
      // A grandchild, so the drop is not one level deep.
      k3: blok({ uid: 'k3', type: 'prose', parent: 'k1', slot: 'body', data: { copy: 'three' } }),
    },
  }
}

// ---------------------------------------------------------------------------
// gateValue
// ---------------------------------------------------------------------------

describe('gateValue', () => {
  it('reads the stored value on the root block', () => {
    expect(gateValue(doc(), 'access')).toBe('members')
  })

  it('answers undefined for a field the document has no key for', () => {
    expect(gateValue(doc(), 'missing')).toBeUndefined()
  })

  it('answers undefined for a document whose root blok is missing', () => {
    expect(gateValue({ root: 'r0', bloks: {} }, 'access')).toBeUndefined()
  })

  /**
   * Decision 2, and the whole reason this function exists rather than a
   * `fieldValue` call: the renderer's "an `i18n` value wins" rule would let a
   * French translation reading `public` open the English page to anyone who
   * asked in French.
   */
  it('reads data, never i18n', () => {
    const gated = doc({ i18n: { fr: { access: 'public' } } })
    expect(gateValue(gated, 'access')).toBe('members')
  })

  it('does not fall back into i18n when data has no key', () => {
    const gated = doc({ data: { title: 'About us' }, i18n: { fr: { access: 'public' } } })
    expect(gateValue(gated, 'access')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isUngated
// ---------------------------------------------------------------------------

describe('isUngated', () => {
  it('is true only for the one named value', () => {
    expect(isUngated('public', 'public')).toBe(true)
    expect(isUngated('members', 'public')).toBe(false)
  })

  /**
   * Checkpoint 2: an absent value is not public. The cost is stated in the spec
   * — `visitor` runs and the page is `no-store` until a `field.default` content
   * migration backfills it — and the alternative fails in the disclosure
   * direction.
   */
  it('is false for an absent value', () => {
    expect(isUngated(undefined, 'public')).toBe(false)
    expect(isUngated(undefined, '')).toBe(false)
    expect(isUngated(undefined, false)).toBe(false)
    expect(isUngated(undefined, 0)).toBe(false)
  })

  /** `0`, `false` and `''` are three different values, not one falsy one. */
  it('is strict equality: 0, false and the empty string are three values', () => {
    expect(isUngated(0, 0)).toBe(true)
    expect(isUngated(false, false)).toBe(true)
    expect(isUngated('', '')).toBe(true)

    expect(isUngated(0, false)).toBe(false)
    expect(isUngated(false, 0)).toBe(false)
    expect(isUngated('', 0)).toBe(false)
    expect(isUngated(0, '')).toBe(false)
    expect(isUngated('', false)).toBe(false)
    expect(isUngated(null, false)).toBe(false)
    expect(isUngated('0', 0)).toBe(false)
    expect(isUngated('true', true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// redactDoc
// ---------------------------------------------------------------------------

describe('redactDoc', () => {
  it('keeps scalars, asset, reference and the gate field itself on the root', () => {
    const redacted = redactDoc(doc(), schema)
    const root = redacted.bloks.r0!

    expect(redacted.root).toBe('r0')
    expect(root.data.title).toBe('About us')
    expect(root.data.description).toBe('The standfirst')
    expect(root.data.access).toBe('members')
    expect(root.data.readingTime).toBe(0)
    expect(root.data.featured).toBe(false)
    expect(root.data.hero).toEqual({ key: 'k1', mime: 'image/png' })
    expect(root.data.author).toBe('st_author')
    expect(root.type).toBe('pageRoot')
    expect(root.uid).toBe('r0')
  })

  it('nulls every richtext field the root declares', () => {
    const root = redactDoc(doc(), schema).bloks.r0!
    expect(root.data.standfirst).toBeNull()
    expect(root.data.notes).toBeNull()
  })

  it('drops every child, in every slot and at every depth', () => {
    const redacted = redactDoc(doc(), schema)
    expect(Object.keys(redacted.bloks)).toEqual(['r0'])
  })

  it('nulls each richtext in every i18n locale, leaving the other translations', () => {
    const gated = doc({
      i18n: {
        fr: { title: 'À propos', standfirst: { type: 'doc', content: [] } },
        de: { notes: { type: 'doc', content: [] } },
      },
    })
    const root = redactDoc(gated, schema).bloks.r0!

    expect(root.i18n?.fr?.title).toBe('À propos')
    expect(root.i18n?.fr?.standfirst).toBeNull()
    expect(root.i18n?.fr?.notes).toBeNull()
    expect(root.i18n?.de?.notes).toBeNull()
  })

  it('leaves a document with no i18n without one', () => {
    const root = redactDoc(doc(), schema).bloks.r0!
    expect('i18n' in root).toBe(false)
  })

  it('does not mutate the document it was handed', () => {
    const original = doc({ i18n: { fr: { standfirst: { type: 'doc', content: [] } } } })
    redactDoc(original, schema)

    expect(Object.keys(original.bloks).sort()).toEqual(['k1', 'k2', 'k3', 'r0'])
    expect(original.bloks.r0!.data.standfirst).not.toBeNull()
    expect(original.bloks.r0!.i18n?.fr?.standfirst).not.toBeNull()
  })

  /**
   * A root block the registry no longer knows: there is no field list to say
   * which values are prose, so nothing on the root can be nulled. Dropping the
   * children is still the whole of the body, which is why this degrades to a
   * teaser rather than to a leak.
   */
  it('drops the children of a root whose type is not in the schema', () => {
    const unknown: Doc = {
      root: 'r0',
      bloks: {
        r0: blok({ uid: 'r0', type: 'gone', data: { title: 'About us' } }),
        k1: blok({ uid: 'k1', type: 'prose', parent: 'r0', slot: 'body' }),
      },
    }
    const redacted = redactDoc(unknown, schema)
    expect(Object.keys(redacted.bloks)).toEqual(['r0'])
    expect(redacted.bloks.r0!.data.title).toBe('About us')
  })

  it('answers an empty document when the root blok is missing', () => {
    const orphan: Doc = {
      root: 'r0',
      bloks: { k1: blok({ uid: 'k1', type: 'prose', parent: 'r0', slot: 'body' }) },
    }
    expect(redactDoc(orphan, schema)).toEqual({ root: 'r0', bloks: {} })
  })
})
