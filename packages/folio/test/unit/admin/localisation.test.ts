import { describe, expect, it } from 'vitest'
import { boundValue, fieldMode } from '../../../src/admin/Inspector'
import { localeLabel, missingSummary, percentDone } from '../../../src/admin/PublishDialog'
import { localeTitle, translationPercent } from '../../../src/admin/StoryTree'
import type { Blok } from '../../../src/core/doc'
import { asset, blocks, richtext, select, text } from '../../../src/core/fields'
import type { LocaleConfig, TranslationStatus } from '../../../src/core/locales'
import type { StoryNode } from '../../../src/core/story'

/**
 * The admin half of `localisation.md`: which of the three states a field's input
 * is in, what it is bound to, and how the tree and the publish confirmation put
 * a number and a name on an incomplete translation.
 *
 * All pure, so none of it needs the panel mounted — the same discipline
 * `visibleEntries` and `publishStatus` already follow.
 */

const LOCALES: LocaleConfig = {
  default: 'en',
  available: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
  ],
}

const blok = (
  data: Record<string, string>,
  i18n?: Record<string, Record<string, string | null>>,
): Blok => ({
  uid: 'hero0001',
  type: 'hero',
  parent: 'root0000',
  slot: 'body',
  order: 'a0',
  data,
  ...(i18n ? { i18n } : {}),
})

/* ------------------------------------------------------------ fieldMode --- */

describe('fieldMode', () => {
  it("is 'source' on the source locale, whatever the field says", () => {
    expect(fieldMode(text({ translatable: true }), true)).toBe('source')
    expect(fieldMode(text(), true)).toBe('source')
    expect(fieldMode(blocks({ allow: [] }), true)).toBe('source')
  })

  it("is 'translate' for a marked field in another locale", () => {
    expect(fieldMode(text({ translatable: true }), false)).toBe('translate')
    expect(fieldMode(richtext({ translatable: true }), false)).toBe('translate')
  })

  /**
   * Decision 4's editor half. The *renderer* honours a locale value on an
   * unmarked field; the editor refuses to write one, so `'shared'` is what makes
   * "shared across all languages" a state rather than a hope.
   */
  it("is 'shared' for an unmarked field in another locale", () => {
    expect(fieldMode(text(), false)).toBe('shared')
    expect(fieldMode(asset(), false)).toBe('shared')
    expect(fieldMode(select({ options: [{ label: 'A', value: 'a' }] }), false)).toBe('shared')
  })
})

/* ----------------------------------------------------------- boundValue --- */

describe('boundValue', () => {
  it('reads the source in source mode', () => {
    expect(boundValue(blok({ heading: 'Hello' }), 'heading', 'source', 'en')).toBe('Hello')
  })

  /**
   * The load-bearing one. An input pre-filled with the *fallback* would copy the
   * English into the French the moment somebody typed a character, and
   * "untranslated" would stop being reachable at all.
   */
  it('reads the raw locale value in translate mode — never the fallback', () => {
    const b = blok({ heading: 'Hello' })
    expect(boundValue(b, 'heading', 'translate', 'fr')).toBeNull()
  })

  it('reads a translation when there is one', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: 'Bonjour' } })
    expect(boundValue(b, 'heading', 'translate', 'fr')).toBe('Bonjour')
  })

  it('reads an empty translation as empty, not as untranslated', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: '' } })
    expect(boundValue(b, 'heading', 'translate', 'fr')).toBe('')
  })

  it('reads a null translation as untranslated', () => {
    const b = blok({ heading: 'Hello' }, { fr: { heading: null } })
    expect(boundValue(b, 'heading', 'translate', 'fr')).toBeNull()
  })

  it('reads another locale nothing, not this one', () => {
    const b = blok({ heading: 'Hello' }, { de: { heading: 'Hallo' } })
    expect(boundValue(b, 'heading', 'translate', 'fr')).toBeNull()
  })

  /** A shared field shows the source so it is legible, and is disabled so it
   * cannot be typed into — the value on screen is the one every language uses. */
  it('shows the source in shared mode', () => {
    const b = blok({ align: 'left' }, { fr: { align: 'droite' } })
    expect(boundValue(b, 'align', 'shared', 'fr')).toBe('left')
  })
})

/* ------------------------------------------------------------ tree label --- */

const node = (over: Partial<StoryNode> = {}): StoryNode =>
  ({
    id: 'sty_1',
    type: 'page',
    parentId: null,
    slug: 'about',
    path: 'about',
    ord: 'a0',
    title: 'About',
    publishedAt: null,
    unpublishedAt: null,
    updatedAt: 0,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    state: 'draft',
    hasUnpublishedChanges: false,
    children: [],
    ...over,
  }) as StoryNode

describe('localeTitle', () => {
  it('is the source title on the source locale, even with a cache present', () => {
    expect(localeTitle(node({ titleI18n: { fr: 'À propos' } }), 'en', true)).toBe('About')
  })

  it('is the cached translated title in another locale', () => {
    expect(localeTitle(node({ titleI18n: { fr: 'À propos' } }), 'fr', false)).toBe('À propos')
  })

  /** The cache is written by publish, so a page whose French title exists only in
   * the draft reads in the source language until it goes live. Best-effort by
   * design (decision 7): a wrong label in a tree, never wrong content on a page. */
  it('falls back to the source title with no cache entry', () => {
    expect(localeTitle(node(), 'fr', false)).toBe('About')
    expect(localeTitle(node({ titleI18n: { de: 'Über' } }), 'fr', false)).toBe('About')
  })

  it('falls back for an empty cached title rather than showing a blank row', () => {
    expect(localeTitle(node({ titleI18n: { fr: '' } }), 'fr', false)).toBe('About')
  })
})

/* ---------------------------------------------------------- percentages --- */

const status = (over: Partial<TranslationStatus> = {}): TranslationStatus => ({
  locale: 'fr',
  total: 10,
  translated: 8,
  missing: [],
  ...over,
})

describe('translationPercent / percentDone', () => {
  it('rounds to a whole percentage', () => {
    expect(translationPercent(status())).toBe(80)
    expect(percentDone(status({ total: 3, translated: 1 }))).toBe(33)
  })

  /** A page with nothing translatable owes no work, so a permanent 0% warning on
   * it would be wrong rather than merely noisy. */
  it('reads a page with nothing translatable as complete', () => {
    expect(translationPercent(status({ total: 0, translated: 0 }))).toBe(100)
    expect(percentDone(status({ total: 0, translated: 0 }))).toBe(100)
  })

  it('agrees with itself: the tree and the dialog use the same arithmetic', () => {
    for (const [total, translated] of [
      [10, 0],
      [10, 5],
      [3, 2],
      [7, 7],
      [0, 0],
    ] as const) {
      const s = status({ total, translated })
      expect(translationPercent(s)).toBe(percentDone(s))
    }
  })
})

/* -------------------------------------------------- the publish warning --- */

describe('missingSummary', () => {
  const gaps = (n: number): TranslationStatus =>
    status({
      total: n,
      translated: 0,
      missing: Array.from({ length: n }, (_, i) => ({
        uid: `u${i}`,
        type: 'hero',
        field: `f${i}`,
        label: `Field ${i}`,
      })),
    })

  it('names every missing field when there are few', () => {
    expect(missingSummary(gaps(2))).toBe('Field 0, Field 1')
  })

  /** A warning nobody reads is the same as no warning: five names and a count is
   * legible, forty names is a wall. */
  it('truncates to five and counts the rest', () => {
    expect(missingSummary(gaps(9))).toBe('Field 0, Field 1, Field 2, Field 3, Field 4 and 4 more')
  })

  it('is empty when nothing is missing', () => {
    expect(missingSummary(status({ missing: [] }))).toBe('')
  })
})

describe('localeLabel', () => {
  it('is the declared label', () => {
    expect(localeLabel(LOCALES, 'fr')).toBe('Français')
  })

  it('falls back to the bare code for an undeclared one, or no config', () => {
    expect(localeLabel(LOCALES, 'kl')).toBe('kl')
    expect(localeLabel(undefined, 'fr')).toBe('fr')
  })
})
