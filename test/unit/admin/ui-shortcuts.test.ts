import { describe, expect, it } from 'vitest'
import { KEYS } from '../../../src/admin/ui/screens/Keys'
import { chord, leadersOf, SAVE_NOTICE } from '../../../src/admin/ui/shortcuts'

/**
 * The shell's chord normaliser. Pure, and tested here rather than by pressing
 * keys at a mounted component, which is the convention every other admin test
 * follows.
 */

describe('chord', () => {
  it('collapses Meta and Control into one `mod`, so a map never names both', () => {
    expect(chord({ key: 's', metaKey: true })).toBe('mod+s')
    expect(chord({ key: 's', ctrlKey: true })).toBe('mod+s')
  })

  it('lowercases the key so caps lock cannot break a binding', () => {
    expect(chord({ key: 'K', metaKey: true })).toBe('mod+k')
  })

  it('keeps undo and redo apart, which is the whole reason shift is named', () => {
    // ⇧⌘Z arrives as `Z`, and lowercasing alone would collapse it onto ⌘Z.
    expect(chord({ key: 'z', metaKey: true })).toBe('mod+z')
    expect(chord({ key: 'Z', metaKey: true, shiftKey: true })).toBe('mod+shift+z')
  })

  it('does not name shift when the character already encodes it', () => {
    // Shift+/ arrives as `?`. Naming shift would make the binding unwriteable.
    expect(chord({ key: '?', shiftKey: true })).toBe('?')
  })

  it('does name shift for a key whose character cannot encode it', () => {
    expect(chord({ key: 'Tab', shiftKey: true })).toBe('shift+tab')
  })

  it('names alt, and orders modifiers canonically', () => {
    expect(chord({ key: 'ArrowUp', altKey: true })).toBe('alt+arrowup')
    expect(chord({ key: 'ArrowDown', altKey: true, metaKey: true, shiftKey: true })).toBe(
      'mod+alt+shift+arrowdown',
    )
  })

  it('handles a bare key and a punctuation chord', () => {
    expect(chord({ key: 'Escape' })).toBe('escape')
    expect(chord({ key: '\\', metaKey: true })).toBe('mod+\\')
    expect(chord({ key: '.', metaKey: true })).toBe('mod+.')
  })
})

describe('SAVE_NOTICE', () => {
  it('says both halves: that it saved, and that pressing it was unnecessary', () => {
    // Pinned because a silent no-op is the failure mode this exists to avoid —
    // a future tidy-up shortening it to "Saved" would lose the teaching.
    expect(SAVE_NOTICE).toMatch(/saved/i)
    expect(SAVE_NOTICE).toMatch(/need/i)
  })
})

/* ------------------------------------------------------------ sequences --- */

describe('leadersOf', () => {
  const noop = () => {}

  it('finds the leader of a two-key sequence', () => {
    expect([...leadersOf({ 'g c': noop, 'g h': noop })]).toEqual(['g'])
  })

  it('ignores a plain chord, however many parts it has', () => {
    expect(leadersOf({ 'mod+k': noop, '?': noop, 'mod+shift+a': noop }).size).toBe(0)
  })

  it('reads more than one leader, so a second sequence family costs nothing', () => {
    expect([...leadersOf({ 'g c': noop, 'y y': noop })].sort()).toEqual(['g', 'y'])
  })

  /** A leading space would make the leader the empty string, which would arm on a
   * keypress nothing produces and then swallow the next one. */
  it('does not treat a leading space as a leader', () => {
    expect(leadersOf({ ' x': noop }).size).toBe(0)
  })
})

describe('the keyboard map', () => {
  const rows = KEYS.flatMap((group) => group.rows)

  /**
   * The map is hand-written and the bindings are not derived from it (`Keys.tsx`
   * argues why), so the one thing a test can still guarantee is that it does not
   * document two meanings for one chord. That is the failure a reader cannot detect:
   * both entries look authoritative.
   */
  it('documents each chord exactly once', () => {
    const seen = rows.map((r) => r.keys)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('says where every binding lives, so a row cannot outlive its feature', () => {
    expect(rows.every((r) => r.where.length > 0)).toBe(true)
  })

  /** `design-system.md` Resolved 3: publish has no chord, deliberately. A row for it
   * would be the map promising something the admin refuses to offer. */
  it('offers no chord for publish', () => {
    expect(rows.some((r) => /publish/i.test(r.what))).toBe(false)
  })
})
