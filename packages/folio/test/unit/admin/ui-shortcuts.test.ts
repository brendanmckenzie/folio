import { describe, expect, it } from 'vitest'
import { chord, SAVE_NOTICE } from '../../../src/admin/ui/shortcuts'

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
