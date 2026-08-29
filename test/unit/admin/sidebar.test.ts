import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The collapsed rail's centring, pinned as source text.
 *
 * The rail is 48px of nothing but icons, and they sat 8px left of its middle
 * while the collapse toggle directly above them — which centres itself — sat on
 * it. The cause was `.collapsed .item { width: 32px }`: a 32px box in a 48px
 * column is only centred if something centres it, and nothing did.
 *
 * The obvious fix is `align-items: center` on `.group`, and it is wrong in a way
 * that is invisible until you expand the sidebar again: `.group` is the same
 * element in both states, so centring there also shrinks every *expanded* row to
 * the width of its own label — the hover background stops reaching the edges and
 * the active row stops being a band across the rail. That fix was attempted, so
 * this test exists to make the next attempt fail loudly instead.
 *
 * Source text rather than a rendered assertion because the admin's suite mounts
 * nothing (see `vitest.config.ts`) — the same trade `ui-scope.test.ts` makes and
 * for the same reason.
 */

const css = readFileSync(
  new URL('../../../src/admin/ui/Sidebar.module.css', import.meta.url),
  'utf8',
)

/** A rule's body by selector, comments stripped. */
function body(selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = clean.indexOf(`\n${selector} {`)
  expect(at, `no rule for \`${selector}\``).toBeGreaterThan(-1)
  return clean.slice(at + selector.length + 3, clean.indexOf('}', at))
}

describe('the collapsed sidebar', () => {
  it('sizes its rows in the collapsed state, not by centring the column', () => {
    // `.group` is shared by both states. Anything that centres its children
    // there lands on the expanded rail too.
    expect(body('.group')).not.toContain('align-items')
    // Nor on the sidebar itself, whose two children are full-width by their own
    // rules — it centred nothing and only made the declaration look like the
    // house style for "collapsed".
    expect(body('.collapsed')).not.toContain('align-items')
  })

  it('gives a collapsed row the width of the rail, less an inset', () => {
    const rule = body('.collapsed .item')
    // A fixed width is the defect: it cannot be centred without the parent's
    // help, and the parent cannot help without breaking the other state.
    expect(rule).not.toMatch(/width:\s*\d/)
    expect(rule).toContain('justify-content: center')
    expect(rule).toContain('margin-inline')
  })
})
