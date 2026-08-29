import { describe, expect, it } from 'vitest'
import { boundValue, fieldMode } from '../../../src/admin/ui/screens/inspector-model'
import type { Blok } from '../../../src/core/doc'
import { asset, blocks, richtext, select, text } from '../../../src/core/fields'

/**
 * The admin half of `localisation.md`: which of the three states a field's input is
 * in, and what it is bound to.
 *
 * All pure, so none of it needs the panel mounted — the same discipline
 * `visibleEntries` and `publishStatus` already follow.
 *
 * **Four things this file used to cover went with port phase 8** rather than moving,
 * and they are worth naming because each is a coverage loss rather than a tidy-up:
 *
 *   - `StoryTree.tsx`'s `localeTitle` and `translationPercent` — the Content tree's
 *     translations column, which `ui-architecture.md`'s open question 7 records as
 *     still owed. The rebuilt tree has no such column yet, so there was nowhere for
 *     either to go; whatever answers that question wants both back.
 *   - `PublishDialog.tsx`'s `missingSummary` and `percentDone`. The rebuilt publish
 *     confirmation lists one line per incomplete locale with a field *count*, which
 *     is bounded by the number of declared locales — so the truncate-at-five rule
 *     `missingSummary` existed for has nothing left to truncate, and the arithmetic
 *     `percentDone` did is not displayed at all.
 *
 * `localeLabel` is not in that list: `EditorShell.tsx` has its own private copy with
 * the same fallback, exercised through the dialog rather than directly.
 */

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
