/**
 * How big a page should be, measured from the layout rather than declared.
 *
 * A constant page size is wrong on every screen except the one it was chosen at. 48
 * tiles is two and a half screenfuls on a laptop and most of one on a 27" monitor, so
 * the same *Next* button means "scroll three times, then page" in one place and
 * "page immediately" in the other. **A page is one screenful** (owner, 2026-09-07):
 * it fills the region and does not scroll, so *Next* is the way to see the next
 * thing rather than a second way to do what the scroll wheel was already doing.
 * That makes the page size a function of the viewport, and the viewport something
 * only the browser can answer.
 *
 * The unit of measurement is a rendered cell: a tile, a table row, or the skeleton
 * standing in for either. Cells carry `data-fit` and the caller names the selector,
 * because the skeleton and the thing that replaces it are different elements and both
 * have to be measurable — the first page's size is decided while the skeletons are on
 * screen, which is what keeps this to *one* request rather than a default-sized fetch
 * followed by a corrected one.
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react'

export interface Fit {
  /** Selects one measurable cell inside the box. */
  cells: string
  /** The page size when nothing can be measured — an empty result, a box that never
   * mounted, a browser mid-layout. Pick the number that was hard-coded before. */
  fallback: number
  /** The route's own clamp. Asking past it is not an error, it is silently ignored,
   * which would make the pager's arithmetic disagree with the server's. */
  max: number
}

/**
 * The page size that fits `box`, remeasured when the layout changes.
 *
 * `null` until the first measurement, and that is the useful half of the contract: a
 * caller that skips its fetch while this is null gets exactly one request at the
 * right size, instead of one at a guess and another at the answer. It resolves in
 * the same commit — `useLayoutEffect` runs after the children that own the box have
 * mounted — so nothing is waiting on a round trip.
 */
export function useFittedPage(box: RefObject<HTMLElement | null>, fit: Fit): number | null {
  const [size, setSize] = useState<number | null>(null)
  const { cells, fallback, max } = fit

  const measure = useCallback(() => {
    const el = box.current
    setSize(el ? fittedPage(el, { cells, fallback, max }) : fallback)
  }, [box, cells, fallback, max])

  useLayoutEffect(measure, [measure])

  /**
   * Width comes from the box and height from the window, so both need watching.
   *
   * The observer is on the box rather than the window for width because the box is
   * narrowed by things the window knows nothing about — the folder sidebar, the
   * detail panel opening beside the grid — and each of those changes the column
   * count without the window moving at all.
   *
   * It cannot feed back on itself: `fittedPage` reads the box's *width* and its top,
   * never its height, so rows arriving and making the box taller changes nothing it
   * measures. That is deliberate — the obvious version, dividing the box's own
   * height by a row, grows the page, which grows the box, which grows the page.
   */
  useEffect(() => {
    const el = box.current
    window.addEventListener('resize', measure)
    const observer = el ? new ResizeObserver(measure) : null
    observer?.observe(el as Element)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [box, measure])

  return size
}

/** What a laid-out box comes to, in the three numbers the arithmetic needs. */
export interface Measured {
  columns: number
  /** Distance from one row's top to the next, gap included. */
  pitch: number
  /** The height a screenful is, from the top of the box down. */
  available: number
}

/**
 * The arithmetic, separated from the measuring so it can be tested — the admin's
 * unit tests run in Node with no jsdom, and this is the half that can be got wrong
 * quietly.
 *
 * **A page is one screenful, and it does not scroll** (owner, 2026-09-07). That is
 * what `Math.floor` is for: a page that rounded up would end in a row hanging below
 * the fold, so the pager would sit under a scrollbar and *Next* would stop being the
 * way to see the next thing. Rounding down leaves at most a row's worth of space at
 * the bottom, and that space is the honest cost of the page boundary lining up with
 * the screen.
 *
 * A whole number of **rows**, always, which is what the old constant was reaching
 * for: 48 was chosen because it divides by 2, 3, 4, 6 and 8, so no page ever ends in
 * a ragged half-row that reads as a failed load. Multiplying the measured column
 * count is the same property without having to pick a number that happens to have it.
 *
 * One row is the floor, and it is a real answer rather than a guard: on a window too
 * short for two, one row is what fits, and asking for two would put the page back
 * behind a scrollbar.
 */
export function pageSizeFor(measured: Measured, fit: Fit): number {
  const { columns, pitch, available } = measured
  if (columns < 1 || pitch <= 0 || available <= 0) return fit.fallback
  const rows = Math.max(1, Math.floor(available / pitch))
  return Math.min(fit.max, columns * rows)
}

/** The same, given a laid-out box to measure it from. */
export function fittedPage(box: HTMLElement, fit: Fit): number {
  const cells = [...box.querySelectorAll<HTMLElement>(fit.cells)]
  if (cells.length === 0) return fit.fallback
  const columns = columnsOf(cells)
  return pageSizeFor(
    { columns, pitch: rowPitch(cells, columns), available: availableHeight(box) },
    fit,
  )
}

/**
 * The height a screenful is: the space the results region has to fill.
 *
 * **The space, not the box** — and the difference is the whole reason this is more
 * than one line. The box's own height is the more precise answer *when the box is
 * bounded*, and it is bounded on the screen above 1100px. It is not bounded in the
 * picker dialog, whose panel used to size to its content: measuring the box there
 * made the region's height a function of the page size and the page size a function
 * of the region, and the picker walked itself down twenty tiles, sixteen, twelve.
 * (`Dialog.module.css`'s `.fill` now gives the panel a definite height, which fixes
 * that end of it; measuring the space rather than the box is what makes the
 * arithmetic immune to the next layout that does the same thing.)
 *
 * So: the window, less where the region starts, less the **furniture that has to fit
 * below it** — the pager, a dialog's footer, the padding under both. Every term is a
 * fixed-height thing measured off the DOM, so nothing here changes when the number of
 * rows does, which is what makes a re-measure return the same answer rather than a
 * smaller one.
 *
 * `Math.max(0, top)` for the scrolled-down case, where the region's top has gone
 * above the window and a raw subtraction would ask for more than a screen.
 */
function availableHeight(box: HTMLElement): number {
  const top = Math.max(0, box.getBoundingClientRect().top)
  return Math.max(0, window.innerHeight - top - furnitureBelow(box))
}

/**
 * Everything that must fit under the results region, summed up its ancestry.
 *
 * At each level: the siblings that stack **below** the box, plus the gap each one
 * brings with it, plus the parent's own bottom padding and border. Walked to the
 * body, because the furniture is not all in one place — the pager is two levels down
 * from the dialog footer, and the wrapper's padding is above them both.
 *
 * Two filters, and both matter:
 *
 * - **A row parent contributes nothing.** `.layout` puts the folder sidebar *beside*
 *   the grid, so it takes width and no height at all; counting it would subtract a
 *   full-height column from the space the grid has.
 * - **Below means starting below the box's top**, not below its bottom. The bottom
 *   moves with the content, which is exactly the dependency this function exists to
 *   avoid; the top does not.
 */
function furnitureBelow(box: HTMLElement): number {
  let total = 0
  let el: HTMLElement = box
  const from = box.getBoundingClientRect().top
  while (el.parentElement && el !== document.body) {
    const parent = el.parentElement
    const style = getComputedStyle(parent)
    const stacked = !style.display.includes('flex') || !style.flexDirection.startsWith('row')
    if (stacked) {
      const gap = px(style.rowGap)
      for (const sibling of parent.children) {
        if (sibling === el) continue
        const rect = sibling.getBoundingClientRect()
        if (rect.top >= from + 1) total += rect.height + gap
      }
    }
    total += px(style.paddingBottom) + px(style.borderBottomWidth)
    el = parent
  }
  return total
}

/** A computed length in pixels. `normal` (a `row-gap` nobody set) is zero. */
function px(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * How far apart two rows are, including the gap.
 *
 * The distance between the first cell and the one directly below it, when there is
 * one, because that is the only measurement that includes the grid's `gap` without
 * reading it out of a stylesheet. A single-row result has no cell below, and falls
 * back to the cell's own height — short by one gap, which costs at most one row on a
 * result that is one row long.
 */
function rowPitch(cells: readonly HTMLElement[], columns: number): number {
  const first = cells[0]
  if (!first) return 0
  const below = cells[columns]
  if (below) return below.offsetTop - first.offsetTop
  return first.getBoundingClientRect().height
}

/**
 * How many cells are in a row, measured rather than declared.
 *
 * `repeat(auto-fill, minmax(…))` decides the count from the available width, so the
 * only place the number exists is the rendered layout: a CSS custom property would
 * have to be kept in step with the grid template by hand, in a second file, and
 * would be wrong at every breakpoint nobody remembered to update. Counting the cells
 * that share the first one's `offsetTop` asks the browser what it did.
 *
 * A stacked list — a table's rows — answers 1, correctly and for the same reason.
 */
export function columnsOf(cells: readonly HTMLElement[]): number {
  const top = cells[0]?.offsetTop
  if (top === undefined) return 1
  let n = 0
  for (const cell of cells) {
    if (cell.offsetTop !== top) break
    n += 1
  }
  return Math.max(1, n)
}
