import { describe, expect, it } from 'vitest'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import { richtext, text, textarea } from '../../../src/core/fields'
import {
  dataOf,
  isKnownLocale,
  isTranslatable,
  type LocaleConfig,
  localeChain,
  localeContext,
  translatableFields,
  translationGaps,
  translationStatus,
  validateLocales,
  fieldValue,
} from '../../../src/core/locales'
import { fromPlainText } from '../../../src/core/richtext'
import type { SchemaIndex } from '../../../src/core/schema'

/** A richtext document as it is *stored*: plain JSON in `Blok.data`. */
const rich = (body: string): Json => fromPlainText(body) as unknown as Json

/**
 * `localisation.md`'s architecture decisions 1, 2 and 5, and checkpoint 2 —
 * every one of them is a property of these functions rather than of the UI.
 *
 * The rule the whole file is really about: an **absent** key is untranslated and
 * falls back, an **empty string** is deliberately empty and does not, and `null`
 * reads as untranslated because that is the only way the mutation vocabulary can
 * express "untranslate this" at all.
 */

const blok = (data: Record<string, Json>, i18n?: Record<string, Record<string, Json>>): Blok => ({
  uid: 'hero0001',
  type: 'hero',
  parent: 'root0000',
  slot: 'body',
  order: 'a0',
  data,
  ...(i18n ? { i18n } : {}),
})

const EN_FR_DE: LocaleConfig = {
  default: 'en',
  available: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch', fallback: 'fr' },
  ],
}

const fr = { code: 'fr', fallbacks: [] as string[] }
const de = { code: 'de', fallbacks: ['fr'] }

// ---------------------------------------------------------------------------
// fieldValue
// ---------------------------------------------------------------------------

describe('fieldValue', () => {
  it('reads the source locale when no locale is asked for', () => {
    expect(fieldValue(blok({ heading: 'Hello' }), 'heading')).toBe('Hello')
  })

  it('reads the source locale for a blok with no translations at all', () => {
    expect(fieldValue(blok({ heading: 'Hello' }), 'heading', fr)).toBe('Hello')
  })

  it('prefers the active locale over the source', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: 'Bonjour' } })
    expect(fieldValue(b, 'heading', fr)).toBe('Bonjour')
    expect(fieldValue(b, 'heading')).toBe('Hello')
  })

  /** Decision 5, the half that makes "clear this heading in French" expressible. */
  it('keeps an empty translated string rather than falling back', () => {
    expect(fieldValue(blok({ heading: 'Hello' }, { fr: { heading: '' } }), 'heading', fr)).toBe('')
  })

  it('treats a null translation as untranslated and falls back', () => {
    expect(fieldValue(blok({ heading: 'Hello' }, { fr: { heading: null } }), 'heading', fr)).toBe(
      'Hello',
    )
  })

  it('falls back through the chain before reaching the source', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: 'Bonjour' } })
    expect(fieldValue(b, 'heading', de)).toBe('Bonjour')
  })

  it('prefers the active locale over its own fallback', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: 'Bonjour' }, de: { heading: 'Hallo' } })
    expect(fieldValue(b, 'heading', de)).toBe('Hallo')
  })

  it('reaches the source when neither the locale nor its chain has anything', () => {
    expect(fieldValue(blok({ heading: 'Hello' }, { fr: {} }), 'heading', de)).toBe('Hello')
  })

  it('skips a null link in the chain', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: null }, de: { heading: null } })
    expect(fieldValue(b, 'heading', de)).toBe('Hello')
  })

  it('passes undefined through for a field with no key anywhere', () => {
    expect(fieldValue(blok({}), 'heading', fr)).toBeUndefined()
  })

  it('translates values that are not strings', () => {
    const b = blok({ items: ['a'] }, { fr: { items: ['b', 'c'] } })
    expect(fieldValue(b, 'items', fr)).toEqual(['b', 'c'])
  })

  // Decision 4's deliberate asymmetry: the renderer does not check the flag, so
  // un-marking a field cannot silently hide content somebody already translated.
  it('honours a translation on a field the schema does not mark translatable', () => {
    expect(fieldValue(blok({ align: 'left' }, { fr: { align: 'droite' } }), 'align', fr)).toBe(
      'droite',
    )
  })
})

// ---------------------------------------------------------------------------
// dataOf
// ---------------------------------------------------------------------------

describe('dataOf', () => {
  it('returns the source map itself when there is no locale', () => {
    const b = blok({ heading: 'Hello' })
    expect(dataOf(b)).toBe(b.data)
  })

  it('returns the source map itself for a blok with no translations', () => {
    const b = blok({ heading: 'Hello' })
    expect(dataOf(b, fr)).toBe(b.data)
  })

  it('layers the active locale over the source', () => {
    const b = blok({ heading: 'Hello', sub: 'World' }, { fr: { heading: 'Bonjour' } })
    expect(dataOf(b, fr)).toEqual({ heading: 'Bonjour', sub: 'World' })
  })

  it('layers fallbacks under the active locale, weakest first', () => {
    const b = blok({ a: 'en', b: 'en', c: 'en' }, { fr: { a: 'fr', b: 'fr' }, de: { a: 'de' } })
    expect(dataOf(b, de)).toEqual({ a: 'de', b: 'fr', c: 'en' })
  })

  it('skips nulls so an untranslation reveals the source', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: null } })
    expect(dataOf(b, fr)).toEqual({ heading: 'Hello' })
  })

  it('keeps an empty string, like fieldValue', () => {
    expect(dataOf(blok({ heading: 'Hello' }, { fr: { heading: '' } }), fr)).toEqual({ heading: '' })
  })

  it('never mutates the source map', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: 'Bonjour' } })
    dataOf(b, fr)
    expect(b.data).toEqual({ heading: 'Hello' })
  })
})

// ---------------------------------------------------------------------------
// localeChain / localeContext
// ---------------------------------------------------------------------------

describe('localeChain', () => {
  it('is empty for a locale with no fallback', () => {
    expect(localeChain(EN_FR_DE, 'fr')).toEqual([])
  })

  it('names the declared fallback', () => {
    expect(localeChain(EN_FR_DE, 'de')).toEqual(['fr'])
  })

  it('follows a chain to its end', () => {
    const config: LocaleConfig = {
      default: 'en',
      available: [
        { code: 'en', label: 'English' },
        { code: 'fr', label: 'Français' },
        { code: 'de', label: 'Deutsch', fallback: 'fr' },
        { code: 'ch', label: 'Schweizerdeutsch', fallback: 'de' },
      ],
    }
    expect(localeChain(config, 'ch')).toEqual(['de', 'fr'])
  })

  it('stops at the default, which has no fallback of its own', () => {
    const config: LocaleConfig = {
      default: 'en',
      available: [
        { code: 'en', label: 'English' },
        { code: 'fr', label: 'Français', fallback: 'en' },
        { code: 'de', label: 'Deutsch', fallback: 'fr' },
      ],
    }
    expect(localeChain(config, 'de')).toEqual(['fr', 'en'])
  })

  // Refused at construction, but a hand-built config in a test must not hang.
  it('terminates on a cycle', () => {
    const config: LocaleConfig = {
      default: 'en',
      available: [
        { code: 'en', label: 'English' },
        { code: 'a', label: 'A', fallback: 'b' },
        { code: 'b', label: 'B', fallback: 'a' },
      ],
    }
    expect(localeChain(config, 'a')).toEqual(['b'])
  })

  it('is empty with no config and for an unknown code', () => {
    expect(localeChain(undefined, 'fr')).toEqual([])
    expect(localeChain(EN_FR_DE, 'kl')).toEqual([])
  })
})

describe('localeContext', () => {
  /**
   * The load-bearing undefined: a default-locale render must take exactly the
   * pre-localisation code path, not a fallback chain that lands in the same
   * place.
   */
  it('is undefined for the source locale', () => {
    expect(localeContext(EN_FR_DE, 'en')).toBeUndefined()
  })

  it('is undefined with no config, no code, or an undeclared code', () => {
    expect(localeContext(undefined, 'fr')).toBeUndefined()
    expect(localeContext(EN_FR_DE, undefined)).toBeUndefined()
    expect(localeContext(EN_FR_DE, 'kl')).toBeUndefined()
  })

  it('carries the code and its chain for a declared non-default locale', () => {
    expect(localeContext(EN_FR_DE, 'de')).toEqual({ code: 'de', fallbacks: ['fr'] })
  })
})

describe('isKnownLocale', () => {
  it('is true only for a declared code', () => {
    expect(isKnownLocale(EN_FR_DE, 'en')).toBe(true)
    expect(isKnownLocale(EN_FR_DE, 'de')).toBe(true)
    expect(isKnownLocale(EN_FR_DE, 'kl')).toBe(false)
    expect(isKnownLocale(EN_FR_DE, undefined)).toBe(false)
    expect(isKnownLocale(undefined, 'en')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateLocales
// ---------------------------------------------------------------------------

describe('validateLocales', () => {
  it('accepts no config at all: a single-locale site', () => {
    expect(() => validateLocales(undefined)).not.toThrow()
  })

  it('accepts a well-formed config', () => {
    expect(() => validateLocales(EN_FR_DE)).not.toThrow()
  })

  it('refuses an empty available list', () => {
    expect(() => validateLocales({ default: 'en', available: [] })).toThrow(/available.*empty/)
  })

  it('refuses a locale with no code', () => {
    expect(() =>
      validateLocales({ default: 'en', available: [{ code: '', label: 'Nothing' }] }),
    ).toThrow(/no `code`/)
  })

  it('refuses a duplicate code', () => {
    expect(() =>
      validateLocales({
        default: 'en',
        available: [
          { code: 'en', label: 'English' },
          { code: 'en', label: 'English again' },
        ],
      }),
    ).toThrow(/duplicate locale 'en'/)
  })

  it('refuses a default that is not available', () => {
    expect(() =>
      validateLocales({ default: 'fr', available: [{ code: 'en', label: 'English' }] }),
    ).toThrow(/locales.default 'fr'/)
  })

  it('refuses a fallback that does not exist', () => {
    expect(() =>
      validateLocales({
        default: 'en',
        available: [
          { code: 'en', label: 'English' },
          { code: 'fr', label: 'Français', fallback: 'kl' },
        ],
      }),
    ).toThrow(/falls back to 'kl'/)
  })

  it('refuses a locale that falls back to itself', () => {
    expect(() =>
      validateLocales({
        default: 'en',
        available: [
          { code: 'en', label: 'English' },
          { code: 'fr', label: 'Français', fallback: 'fr' },
        ],
      }),
    ).toThrow(/falls back to itself/)
  })

  it('refuses a fallback cycle', () => {
    expect(() =>
      validateLocales({
        default: 'en',
        available: [
          { code: 'en', label: 'English' },
          { code: 'a', label: 'A', fallback: 'b' },
          { code: 'b', label: 'B', fallback: 'a' },
        ],
      }),
    ).toThrow(/fallback cycle/)
  })
})

// ---------------------------------------------------------------------------
// translatable
// ---------------------------------------------------------------------------

describe('isTranslatable / translatableFields', () => {
  const def = {
    name: 'hero',
    label: 'Hero',
    fields: {
      heading: text({ translatable: true }),
      body: richtext({ translatable: true }),
      note: textarea(),
      align: text(),
    },
  }

  it('is opt-in per field (checkpoint 2)', () => {
    expect(isTranslatable(text({ translatable: true }))).toBe(true)
    expect(isTranslatable(text())).toBe(false)
    expect(isTranslatable(text({ translatable: false }))).toBe(false)
  })

  it('lists the marked fields in declaration order', () => {
    expect(translatableFields(def).map(([name]) => name)).toEqual(['heading', 'body'])
  })

  it('is empty for an unknown block', () => {
    expect(translatableFields(undefined)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// translationStatus / translationGaps
// ---------------------------------------------------------------------------

const SCHEMA: SchemaIndex = {
  page: {
    name: 'page',
    label: 'Page',
    fields: { title: text({ translatable: true }) },
  },
  hero: {
    name: 'hero',
    label: 'Hero',
    fields: {
      heading: text({ translatable: true, label: 'Heading' }),
      sub: text({ translatable: true }),
      align: text(),
      body: richtext({ translatable: true }),
    },
  },
}

function doc(bloks: Blok[]): Doc {
  return { root: bloks[0]!.uid, bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])) }
}

const root = (data: Record<string, Json>, i18n?: Record<string, Record<string, Json>>): Blok => ({
  uid: 'root0000',
  type: 'page',
  parent: null,
  slot: null,
  order: 'a0',
  data,
  ...(i18n ? { i18n } : {}),
})

describe('translationStatus', () => {
  it('counts only the translatable fields whose source has something in it', () => {
    const d = doc([root({ title: 'About' }), blok({ heading: 'Hello', sub: '', align: 'left' })])
    const status = translationStatus(d, SCHEMA, 'fr')
    // title + heading. `sub` is empty at source and `align` is not translatable.
    expect(status.total).toBe(2)
    expect(status.translated).toBe(0)
    expect(status.missing.map((m) => m.field).sort()).toEqual(['heading', 'title'])
  })

  it('counts a translated field as done, and an empty translation as done too', () => {
    const d = doc([
      root({ title: 'About' }, { fr: { title: 'À propos' } }),
      blok({ heading: 'Hello' }, { fr: { heading: '' } }),
    ])
    const status = translationStatus(d, SCHEMA, 'fr')
    expect(status).toEqual({ locale: 'fr', total: 2, translated: 2, missing: [] })
  })

  it('counts a null translation as missing', () => {
    const d = doc([root({ title: 'About' }, { fr: { title: null } })])
    expect(translationStatus(d, SCHEMA, 'fr').translated).toBe(0)
  })

  it('names the field label so a warning can be read by a person', () => {
    const d = doc([root({ title: 'About' }), blok({ heading: 'Hello' })])
    const gap = translationStatus(d, SCHEMA, 'fr').missing.find((m) => m.field === 'heading')
    expect(gap).toEqual({ uid: 'hero0001', type: 'hero', field: 'heading', label: 'Heading' })
  })

  it('falls back to the field name when it declares no label', () => {
    const d = doc([root({ title: 'About' })])
    expect(translationStatus(d, SCHEMA, 'fr').missing[0]?.label).toBe('title')
  })

  it('reads an empty richtext source as nothing to translate', () => {
    const empty = doc([root({ title: 'About' }), blok({ heading: 'Hi', body: rich('') })])
    expect(translationStatus(empty, SCHEMA, 'fr').total).toBe(2)
    const full = doc([root({ title: 'About' }), blok({ heading: 'Hi', body: rich('Prose') })])
    expect(translationStatus(full, SCHEMA, 'fr').total).toBe(3)
  })

  it('ignores bloks whose type the schema does not declare', () => {
    const d = doc([root({ title: 'About' }), { ...blok({ heading: 'Hi' }), type: 'gone' }])
    expect(translationStatus(d, SCHEMA, 'fr').total).toBe(1)
  })

  it('reads a page with nothing translatable as complete rather than as 0%', () => {
    const bare: SchemaIndex = { page: { name: 'page', label: 'Page', fields: { title: text() } } }
    expect(translationStatus(doc([root({ title: 'About' })]), bare, 'fr')).toEqual({
      locale: 'fr',
      total: 0,
      translated: 0,
      missing: [],
    })
  })
})

describe('translationGaps', () => {
  const d = doc([
    root({ title: 'About' }, { fr: { title: 'À propos' } }),
    blok({ heading: 'Hello', sub: 'World' }),
  ])

  it('names every incomplete non-source locale, worst first', () => {
    const gaps = translationGaps(d, SCHEMA, EN_FR_DE)
    expect(gaps.map((g) => g.locale)).toEqual(['de', 'fr'])
    expect(gaps[0]?.missing).toHaveLength(3)
    expect(gaps[1]?.missing).toHaveLength(2)
  })

  it('never reports the source locale, which is the source', () => {
    expect(translationGaps(d, SCHEMA, EN_FR_DE).some((g) => g.locale === 'en')).toBe(false)
  })

  it('is empty when every locale is finished — the ordinary publish', () => {
    const complete = doc([
      root({ title: 'About' }, { fr: { title: 'À propos' }, de: { title: 'Über' } }),
    ])
    expect(translationGaps(complete, SCHEMA, EN_FR_DE)).toEqual([])
  })

  it('is empty for a site with no locales at all', () => {
    expect(translationGaps(d, SCHEMA, undefined)).toEqual([])
  })
})
