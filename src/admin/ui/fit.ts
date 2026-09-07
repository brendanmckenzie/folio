/**
 * How big a page should be, measured from the layout rather than declared.
 *
 * A constant page size is wrong on every screen except the one it was chosen at. 48
 * tiles is two and a half screenfuls on a laptop and most of one on a 27" monitor, so
 * the same *Next* button means "scroll three times, then page" in one place and
 * "page immediately" in the other. The number that stays constant should be the
 * amount of scrolling a page costs, not the number of rows in it — which makes the
 * page size a function of the viewport, and the viewport something only the browser
 * can answer.
 *
 * The unit of measurement is a rendered cell: a tile, a table row, or the skeleton
 * standing in for either. Cells carry `data-fit` and the caller names the selector,
 * because the skeleton and the thing that replaces it are different elements and both
 * have to be measurable — the first page's size is decided while the skeletons are on
 * screen, which is what keeps this to *one* request rather than a default-sized fetch
 * followed by a corrected one.
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react'

/**
 * How many screenfuls a page holds.
 *
 * Not one. A pager whose page is exactly what fits means pressing *Next* as often as
 * you would otherwise scroll, which is a worse gesture than the scrolling it
 * replaces. Two is the smallest number that keeps paging feeling like paging: the
 * page opens full, one scroll reaches the end of it, and *Next* is the third gesture
 * rather than the first.
 */
const SCREENS = 2

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
 * Rounded to a whole number of **rows**, always, which is what the old constant was
 * reaching for: 48 was chosen because it divides by 2, 3, 4, 6 and 8, so no page ever
 * ends in a ragged half-row that reads as a failed load. Multiplying the measured
 * column count is the same property without having to pick a number that happens to
 * have it.
 *
 * Two rows is the floor. A page of one row makes *Next* the only way to see anything,
 * which is the pathological end of the same complaint this fixes; it can only arise
 * from a box measured mid-layout or a viewport shorter than a tile.
 */
export function pageSizeFor(measured: Measured, fit: Fit): number {
  const { columns, pitch, available } = measured
  if (columns < 1 || pitch <= 0 || available <= 0) return fit.fallback
  const rows = Math.max(2, Math.round((available * SCREENS) / pitch))
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
 * The height a screenful is, counted from the top of the results region to the
 * bottom of the window.
 *
 * **The window, not the box**, and the box's own height is deliberately not consulted
 * even though it is usually the more precise answer. It is only *sometimes* the right
 * one: the browser frames itself above 1100px and inside a dialog, where the box is a
 * bounded scroller, and below that it is a page scroll where the box's height is
 * whatever its content came to. A rule that used the box would therefore have to
 * decide which arrangement it was in, and the only signals for that are circular —
 * "does the content overflow" is a question about the page size being computed.
 *
 * So it measures the one thing that is true in both: the window is the screen, and
 * the region starts where it starts. It overshoots by whatever furniture sits below
 * the region — the pager, a dialog's footer — which is the safe direction: a page
 * slightly larger than the space is a page whose last row peeks below the fold, and
 * that is the cue that scrolling continues.
 *
 * `Math.max(0, top)` for the scrolled-down case, where the region's top has gone
 * above the window and a raw subtraction would ask for more than a screen.
 */
function availableHeight(box: HTMLElement): number {
  const top = box.getBoundingClientRect().top
  return Math.max(0, window.innerHeight - Math.max(0, top))
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
