import { describe, expect, it } from 'vitest'
import { type Fit, columnsOf, pageSizeFor } from '../../../src/admin/ui/fit'

/**
 * The page size the pager asks for, which is now a function of the viewport rather
 * than a constant.
 *
 * The admin's unit tests run in Node with no jsdom, so the measuring itself is not
 * testable here — `fittedPage` reads `getBoundingClientRect` and `window.innerHeight`
 * and there is neither. What *is* testable is the half that can be wrong quietly: the
 * arithmetic over three measured numbers, and the row count, which reads only
 * `offsetTop` and so takes a fake shape the same way `isTabbable`'s tests do.
 */

const FIT: Fit = { cells: '[data-fit]', fallback: 48, max: 200 }

/** Only what `columnsOf` reads. */
const at = (offsetTop: number) => ({ offsetTop }) as HTMLElement

describe('columnsOf', () => {
  it('counts the cells sharing the first one’s top', () => {
    expect(columnsOf([0, 0, 0, 40, 40, 40].map(at))).toBe(3)
  })

  it('answers 1 for a stacked list, which is what a table’s rows are', () => {
    expect(columnsOf([0, 40, 80, 120].map(at))).toBe(1)
  })

  /** Not zero: the count is a divisor, and every caller would then ask for nothing. */
  it('answers 1 for an empty box', () => {
    expect(columnsOf([])).toBe(1)
  })
})

describe('pageSizeFor', () => {
  /**
   * The whole point. Two boxes with the same tiles and different heights get
   * different pages, and each is the same amount of scrolling.
   */
  it('grows with the height it is given', () => {
    const tiles = { columns: 6, pitch: 250 }
    const laptop = pageSizeFor({ ...tiles, available: 700 }, FIT)
    const monitor = pageSizeFor({ ...tiles, available: 1300 }, FIT)
    expect(laptop).toBe(36) // round(700 × 2 ÷ 250) = 6 rows
    expect(monitor).toBe(60) // round(1300 × 2 ÷ 250) = 10 rows
    expect(monitor).toBeGreaterThan(laptop)
  })

  /**
   * A whole number of rows, always — the property the old constant 48 was chosen to
   * have, now held by construction. A ragged final row reads as a load that failed
   * rather than as the end of a page.
   */
  it('is always a whole number of rows', () => {
    for (const columns of [2, 3, 4, 5, 6, 7, 8]) {
      const size = pageSizeFor({ columns, pitch: 210, available: 830 }, FIT)
      expect(size % columns).toBe(0)
    }
  })

  /** More than one screenful, so *Next* is not simply a worse scroll bar. */
  it('holds two screenfuls, not one', () => {
    expect(pageSizeFor({ columns: 1, pitch: 40, available: 800 }, FIT)).toBe(40)
  })

  /** The route silently reduces anything above its own clamp, which would leave the
   * pager and the server disagreeing about what a page holds. */
  it('never asks past the route’s clamp', () => {
    expect(pageSizeFor({ columns: 8, pitch: 30, available: 2000 }, FIT)).toBe(FIT.max)
  })

  /** A page of one row makes *Next* the only way to see anything — the pathological
   * end of the complaint this exists to fix. */
  it('never falls below two rows', () => {
    expect(pageSizeFor({ columns: 4, pitch: 400, available: 120 }, FIT)).toBe(8)
  })

  /**
   * Nothing measurable is the empty result, the box that never mounted and the
   * browser caught mid-layout. The fallback is the constant that was hard-coded
   * before, so the worst case is exactly the old behaviour rather than a page of
   * zero rows.
   */
  it('falls back rather than dividing by a measurement it did not get', () => {
    expect(pageSizeFor({ columns: 4, pitch: 0, available: 800 }, FIT)).toBe(FIT.fallback)
    expect(pageSizeFor({ columns: 0, pitch: 200, available: 800 }, FIT)).toBe(FIT.fallback)
    expect(pageSizeFor({ columns: 4, pitch: 200, available: 0 }, FIT)).toBe(FIT.fallback)
  })
})
