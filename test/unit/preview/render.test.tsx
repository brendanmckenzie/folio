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
})
