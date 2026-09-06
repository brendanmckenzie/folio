import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Where the admin scrolls, and where it must not.
 *
 * Three defects in one week, all the same shape — a box that was allowed to grow
 * past the viewport, so the thing at the bottom of it could not be reached:
 *
 *  1. **The dialog.** `.wrap` centred its panel in an `auto` grid row, and an auto
 *     track is sized by its content, so `.panel`'s `max-height: 100%` was measured
 *     against a track the panel had itself just sized. The asset picker rendered at
 *     ~2300px and took *Use this file* off the bottom of the screen.
 *  2. **The picker's furniture.** With the panel clamped, the dialog body scrolled as
 *     one block — so the search box, the folder list and the pager left the screen
 *     along with the tiles.
 *  3. **The Assets detail panel.** `position: sticky` on a box 1071px tall against an
 *     822px scrollport pins the head and hangs the rest below the fold, and a sticky
 *     element does not unstick until its containing block runs out: the bottom of the
 *     panel was unreachable until the whole library had been scrolled past.
 *
 * Source-text assertions because the admin's suite mounts nothing (`vitest.config.ts`)
 * — there is no layout here to measure, and each fix was checked in a browser once.
 * What this catches is the tidy-up: every declaration below reads as redundant, and
 * three of them are the only reason the layouts are not circular.
 */

const read = (path: string) =>
  // Comments first. These two stylesheets argue at length and a `}` inside a comment
  // would end a rule early.
  readFileSync(new URL(`../../../src/admin/${path}`, import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )

const dialogCss = read('ui/Dialog.module.css')
const assetsCss = read('ui/screens/Assets.module.css')

const rule = (css: string, selector: string) => {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/\./g, '\\.')} \\{`))
  expect(at, `${selector} is gone`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe('the dialog fits the viewport', () => {
  it('gives the wrapper row a definite height, so the panel has something to be 100% of', () => {
    // `minmax(0, 1fr)` and not `1fr`: a bare `1fr` is `minmax(auto, 1fr)`, whose
    // automatic minimum floors the track at the panel's content — the same bug.
    expect(rule(dialogCss, '.wrap')).toContain('grid-template-rows: minmax(0, 1fr)')
  })

  it('still caps the panel, which is the half that does the clamping', () => {
    expect(rule(dialogCss, '.panel')).toContain('max-height: 100%')
  })

  it('lets the body take the overflow, so a long dialog scrolls inside itself', () => {
    // Both halves: `overflow: auto` alone does nothing in a flex column whose
    // automatic minimum size is its content.
    const body = rule(dialogCss, '.body')
    expect(body).toContain('min-height: 0')
    expect(body).toContain('overflow: auto')
  })
})

describe("the picker's furniture holds still", () => {
  it('frames the body instead of scrolling it, when a dialog asks to fill', () => {
    const fill = rule(dialogCss, '.fill')
    expect(fill).toContain('flex-direction: column')
    // `hidden`, not `auto`: a broken chain must look broken rather than answer with a
    // second scrollbar inside the first.
    expect(fill).toContain('overflow: hidden')
  })

  it('is asked for by the one dialog that holds a browser', () => {
    const picker = readFileSync(
      new URL('../../../src/admin/ui/screens/AssetPicker.tsx', import.meta.url),
      'utf8',
    )
    expect(picker).toMatch(/\n\s+fill\n/)
  })

  /**
   * The chain, link by link. `Dialog`'s `.fill` hands its height to `.dropZone`, which
   * hands it to `.browserFill`, `.layout`, `.main` and finally `.results` — and
   * `min-height: 0` at each link is what lets the shrink through, because a flex
   * item's automatic minimum size is its content. One omission anywhere and the grid
   * is back at its natural height inside a body that clips.
   */
  it('carries min-height: 0 down every link, or the shrink stops there', () => {
    for (const selector of [
      '.dropZone',
      '.browserFill',
      '.browserFill .layout',
      '.browserFill .main',
      '.browserFill .results',
    ]) {
      expect(rule(assetsCss, selector), `${selector} breaks the chain`).toContain('min-height: 0')
    }
  })

  it('ends at the results region, which is the only part that scrolls', () => {
    expect(rule(assetsCss, '.browserFill .results')).toContain('overflow-y: auto')
    // The sidebar is its own scroller beside it, not part of the same one.
    expect(rule(assetsCss, '.browserFill .sidebar')).toContain('overflow-y: auto')
  })

  it('pins the controls and the pager against the default shrink', () => {
    expect(assetsCss).toContain('.browserFill .controls,\n.browserFill .footer {\n  flex: none;')
  })
})

describe('the Assets detail panel', () => {
  it('is capped to the scrollport and scrolls itself', () => {
    // A sticky box taller than the scrollport is worse than a static one.
    expect(assetsCss).toContain('max-height: calc(100dvh - 40px - var(--space-4) * 2)')
    expect(assetsCss).toContain('overflow-y: auto')
  })

  it('leaves the stacked layout alone, where the panel is below the grid', () => {
    // Scoped to the wide layout, the complement of `.body[data-open]`'s own
    // breakpoint. Capping a stacked panel would put a nested scroller in a page that
    // already scrolls.
    expect(assetsCss).toContain('@media (min-width: 1101px)')
    expect(assetsCss).toContain('@media (max-width: 1100px)')
  })
})
