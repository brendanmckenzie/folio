import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defineBlock, text, toRegistry } from '../../../src/core'
import type { Doc } from '../../../src/core/doc'
import type { Resolution } from '../../../src/core/resolve'
import { renderGlobalNode } from '../../../src/preview/Render'

/**
 * `renderGlobalNode` is the one function behind both `Folio.renderGlobal` (a
 * host's own shell) and Folio's internal preview page
 * (`../../../docs/specs/content-model/globals.md` decision 3): the same
 * wrapper markup wherever a global appears, so a hydration mismatch is never
 * a question of which caller rendered it.
 */

const headerRoot = defineBlock({
  name: 'headerRoot',
  label: 'Header',
  fields: { tagline: text({ label: 'Tagline' }) },
  render: ({ tagline }) => <header>{tagline}</header>,
})

const registry = toRegistry([headerRoot])

function headerDoc(tagline: string): Doc {
  return {
    root: 'hdr00001',
    bloks: {
      hdr00001: {
        uid: 'hdr00001',
        type: 'headerRoot',
        parent: null,
        slot: null,
        order: 'a0',
        data: { tagline },
      },
    },
  }
}

const baseResolution: Resolution = { stories: {}, assetBase: '/folio/asset' }

describe('renderGlobalNode', () => {
  it('renders nothing — no wrapper at all — for a global absent from the resolution', () => {
    expect(renderGlobalNode(registry, baseResolution, 'header')).toBeNull()
  })

  it('renders nothing for a resolution with globals, but not this one', () => {
    const resolution: Resolution = { ...baseResolution, globals: { footer: headerDoc('x') } }
    expect(renderGlobalNode(registry, resolution, 'header')).toBeNull()
  })

  it('wraps a populated global in a stable data-folio-global marker', () => {
    const resolution: Resolution = { ...baseResolution, globals: { header: headerDoc('Call us') } }
    const html = renderToStaticMarkup(renderGlobalNode(registry, resolution, 'header'))
    expect(html).toContain('data-folio-global="header"')
    expect(html).toContain('Call us')
  })

  it('adds no data-folio-uid marker by default — a host publishing live must not leak one', () => {
    const resolution: Resolution = { ...baseResolution, globals: { header: headerDoc('x') } }
    const html = renderToStaticMarkup(renderGlobalNode(registry, resolution, 'header'))
    expect(html).not.toContain('data-folio-uid')
  })

  it('adds the data-folio-uid marker when edit is requested, exactly like any other block', () => {
    const resolution: Resolution = { ...baseResolution, globals: { header: headerDoc('x') } }
    const html = renderToStaticMarkup(
      renderGlobalNode(registry, resolution, 'header', { edit: true }),
    )
    expect(html).toContain('data-folio-uid="hdr00001"')
  })

  /**
   * Both Folio's preview shell and a host laying out its own chrome map over
   * several globals, and a caller cannot add a key to a node it did not create —
   * so the node carries its own. Without it React warns "Each child in a list
   * should have a unique key" against whatever component holds the array, which
   * is a real report about library markup pointing at host code.
   */
  it('carries its own React key, so mapping over several globals is warning-free', () => {
    const resolution: Resolution = {
      ...baseResolution,
      globals: { header: headerDoc('Top'), footer: headerDoc('Bottom') },
    }
    const nodes = ['header', 'footer'].map((name) => renderGlobalNode(registry, resolution, name))
    expect(nodes.map((n) => (n as { key: string | null }).key)).toEqual(['header', 'footer'])

    // And the array renders as a list without React complaining.
    const warnings: unknown[][] = []
    const error = console.error
    console.error = (...args: unknown[]) => warnings.push(args)
    try {
      renderToStaticMarkup(<>{nodes}</>)
    } finally {
      console.error = error
    }
    expect(warnings.filter((w) => String(w[0]).includes('unique "key"'))).toEqual([])
  })
})
