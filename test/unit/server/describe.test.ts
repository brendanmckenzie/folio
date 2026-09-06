import { describe, expect, it } from 'vitest'
import { MAX_DESCRIBE_ALT, MAX_DESCRIBE_DESCRIPTION } from '../../../src/server/describe'
import { clampText } from '../../../src/server/validate'

/**
 * `clampText` — the screen everything a model answers passes through
 * (`docs/specs/content-model/media-library.md` decision 8), and the one half of
 * the describe seam that needs no database at all.
 *
 * It is `bounded()`'s twin with the opposite failure. `bounded()` refuses,
 * because a person is holding the form and can be told which field is wrong;
 * there is nobody to tell here, and refusing a 2,010-character description would
 * throw away the whole paid-for call — including the alt text that came back
 * perfect — over ten characters. So this clamps, and the interesting cases are
 * all about *how*:
 *
 *  - a non-string is `undefined`, which `describeAsset` reads as "the model said
 *    nothing about this field" and leaves the stored column alone;
 *  - the characters a stored string may not hold are stripped rather than fatal;
 *  - and truncation counts **code points**, because cutting a UTF-16 string at a
 *    fixed index lands between the halves of a surrogate pair and stores a lone
 *    `\uD83D` — exactly the `\p{Cs}` the screen above it exists to keep out, put
 *    back by the thing enforcing the cap.
 */
describe('clampText', () => {
  it('is undefined for anything that is not a string', () => {
    for (const raw of [undefined, null, 42, true, {}, ['a'], () => 'a']) {
      expect(clampText(raw, 100)).toBeUndefined()
    }
  })

  it('trims, and keeps an empty answer as an empty string', () => {
    expect(clampText('  a caption  ', 100)).toBe('a caption')
    expect(clampText('   ', 100)).toBe('')
  })

  it('strips what a stored string may not hold rather than refusing it', () => {
    // A C0 control, a bidi override, and a lone surrogate.
    expect(clampText('\u0000a\u202eb\ud800c', 100)).toBe('abc')
    // A well-formed pair and a zero-width joiner survive: `\p{C}` as a whole
    // would take U+200D and break every multi-codepoint emoji.
    expect(clampText('\u{1f468}\u200d\u{1f4bb} at work', 100)).toBe(
      '\u{1f468}\u200d\u{1f4bb} at work',
    )
  })

  it('truncates by code point, so a cap cannot mint a lone surrogate', () => {
    const clamped = clampText('\u{1f44d}'.repeat(10), 4)
    expect(clamped).toBe('\u{1f44d}\u{1f44d}\u{1f44d}\u{1f44d}')
    // The cap counts what a person counts, and the result is still well formed:
    // a `.slice(0, 4)` here would answer two emoji plus half of a third.
    expect([...(clamped ?? '')]).toHaveLength(4)
    // `/u` is what makes this the right question: under it `\p{Cs}` matches
    // only an *unpaired* half, because a well-formed pair is one code point.
    expect(clamped).toMatch(/^[^\p{Cs}]*$/u)
  })

  it('caps at the lengths a person\u2019s own input is capped at', () => {
    expect(clampText('a'.repeat(4000), MAX_DESCRIBE_ALT)).toHaveLength(500)
    expect(clampText('a'.repeat(4000), MAX_DESCRIBE_DESCRIPTION)).toHaveLength(2000)
  })

  it('trims again after truncating, so a cut mid-sentence has no trailing space', () => {
    expect(clampText('one two three', 8)).toBe('one two')
  })
})
