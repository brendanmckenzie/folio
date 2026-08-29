import { describe, expect, it } from 'vitest'
import { isTabbable } from '../../../src/admin/hooks/useFocusTrap'

/**
 * `useFocusTrap` cycles Tab through the controls inside a dialog panel. Which
 * controls those *are* is the only part of it that can be got wrong quietly:
 * counting one that cannot take focus makes Tab appear to do nothing, which
 * reads as the trap being broken rather than as a skipped button.
 *
 * The admin's unit tests run in Node with no jsdom, so the cycle itself — focus
 * movement, the wrap at either end, the restore to the opener — is not testable
 * here and is deliberately not faked. `isTabbable` is duck-typed precisely so
 * this rule can be pinned without a DOM, the same way `isPlainFocus` is.
 *
 * Each case below is a control that really exists in one of the six dialogs.
 */

describe('isTabbable', () => {
  it('takes an ordinary button, like Cancel', () => {
    expect(isTabbable({ tabIndex: 0 })).toBe(true)
  })

  it('takes a text input, like the title box in the duplicate dialog', () => {
    expect(isTabbable({ tabIndex: 0, disabled: false })).toBe(true)
  })

  it('skips a disabled control — Upload, for the length of an upload', () => {
    expect(isTabbable({ tabIndex: 0, disabled: true })).toBe(false)
  })

  it('skips a hidden control — the file input behind Upload', () => {
    expect(isTabbable({ tabIndex: 0, hidden: true })).toBe(false)
  })

  it('skips anything held out of the order — the scrim, and the panel itself', () => {
    expect(isTabbable({ tabIndex: -1 })).toBe(false)
  })

  it('takes an element made tabbable on purpose', () => {
    expect(isTabbable({ tabIndex: 2 })).toBe(true)
  })

  it('treats a missing tabIndex as in the order: a link carries no tabindex', () => {
    expect(isTabbable({})).toBe(true)
  })

  it('skips a disabled control even when it is otherwise in the order', () => {
    expect(isTabbable({ tabIndex: 0, hidden: false, disabled: true })).toBe(false)
  })
})
