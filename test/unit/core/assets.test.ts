import { describe, expect, it } from 'vitest'
import { tagSlug } from '../../../src/core/assets'

/**
 * The media library's pure vocabulary
 * (`docs/specs/content-model/media-library.md`), phase 1. `tagSlug` is the only
 * function here; `AssetFolder`, `AssetTag`, `AssetFilter` and `AssetBulkAction`
 * are shapes with nothing to unit test until a later phase parses or produces
 * one.
 *
 * **`tagSlug` removes inner whitespace rather than collapsing it to a single
 * space.** The acceptance criterion (decision 4) is that `Headshot` and
 * `  head shot  ` collide on one row in `asset_tags` — a `unique` constraint,
 * so the two have to produce the *identical* string, and `head shot` with a
 * space preserved would not equal `headshot`.
 */
describe('tagSlug', () => {
  it('lowercases', () => {
    expect(tagSlug('Headshot')).toBe('headshot')
  })

  it('trims leading and trailing whitespace', () => {
    expect(tagSlug('  headshot  ')).toBe('headshot')
  })

  it('removes inner whitespace rather than collapsing it to one space', () => {
    expect(tagSlug('head shot')).toBe('headshot')
    expect(tagSlug('head   shot')).toBe('headshot')
  })

  it('collides `Headshot`, `headshot` and `  head shot  ` onto one slug', () => {
    const slugs = new Set([tagSlug('Headshot'), tagSlug('headshot'), tagSlug('  head shot  ')])
    expect(slugs.size).toBe(1)
    expect([...slugs][0]).toBe('headshot')
  })

  it('preserves unicode letters rather than stripping them', () => {
    expect(tagSlug('Café Noir')).toBe('cafénoir')
  })

  it('treats a run of tabs and newlines as whitespace too', () => {
    expect(tagSlug('head\tshot\n')).toBe('headshot')
    expect(tagSlug('head\t\nshot')).toBe('headshot')
  })

  it('answers empty for empty or all-whitespace input', () => {
    expect(tagSlug('')).toBe('')
    expect(tagSlug('   ')).toBe('')
  })
})
