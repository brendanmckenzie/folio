import { describe, expect, it } from 'vitest'
import { isPlainFocus } from '../../../src/admin/hooks/useClipboardShortcuts'

// duplicate-and-paste.md's phase 2 plan: "only handle the shortcut when the
// active element is not an input, textarea or contenteditable" — the same
// rule useUndoShortcut.ts already applies to Cmd+Z, so a copy or paste inside
// a text field (a richtext field's own copy, in particular) reaches that
// field's own clipboard handling instead of the document store's.

describe('isPlainFocus', () => {
  it('is true when nothing is focused', () => {
    expect(isPlainFocus(null)).toBe(true)
  })

  it('is true for an ordinary element, like a tree row', () => {
    expect(isPlainFocus({ tagName: 'DIV' })).toBe(true)
  })

  it('is false when focus is inside a text input', () => {
    expect(isPlainFocus({ tagName: 'INPUT' })).toBe(false)
  })

  it('is false when focus is inside a textarea', () => {
    expect(isPlainFocus({ tagName: 'TEXTAREA' })).toBe(false)
  })

  it('is false when focus is inside a contenteditable field (richtext)', () => {
    expect(isPlainFocus({ tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
})
