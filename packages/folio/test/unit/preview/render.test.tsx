import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defineBlock, text, toRegistry } from '../../../src/core'
import type { Doc } from '../../../src/core/doc'
import type { Resolution } from '../../../src/core/resolve'
import { type RenderMode, renderGlobalNode } from '../../../src/preview/Render'

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
      renderGlobalNode(registry, resolution, 'header', { mode: 'edit' }),
    )
    expect(html).toContain('data-folio-uid="hdr00001"')
  })

  /**
   * A global is part of the page a `?_folio=draft` reviewer or a screenshot is
   * looking at, so it is addressable there too — by the same attribute, with no
   * marker `<div>` (`../../../docs/specs/platform/mcp-server.md` decision 5a).
   */
  it('marks a global in mark mode too, with no editing scaffolding around it', () => {
    const resolution: Resolution = { ...baseResolution, globals: { header: headerDoc('x') } }
    const html = renderToStaticMarkup(
      renderGlobalNode(registry, resolution, 'header', { mode: 'mark' }),
    )
    expect(html).toContain('data-folio-uid="hdr00001"')
    expect(html).not.toContain('folio-marker')
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

// ---------------------------------------------------------------------------
// The edit marker, and what a block's `render` returns
// ---------------------------------------------------------------------------

/**
 * `RenderBlok` derives the edit marker so a block cannot forget to be editable
 * — which only holds if the marker actually reaches the DOM for every shape a
 * `render` can return.
 *
 * `cloneElement` puts an attribute on the DOM only for a *host* element. Give
 * those props to a custom component and it drops them, give them to a Fragment
 * and React discards them: no marker, and the block silently cannot be hovered,
 * selected or clicked in the preview. Wrapping a host's existing component —
 * `render: (p) => <SectionHead {...p} />` — is the most natural thing to write
 * when adopting Folio into a site that already has a design system, and it was
 * exactly the shape that opted out.
 */
describe('the edit marker survives every shape of render', () => {
  const Heading = ({ title }: { title: string }) => <h2>{title}</h2>

  const blocks = [
    defineBlock({
      name: 'hostEl',
      label: 'Host element',
      fields: { title: text() },
      render: ({ title }) => <section>{title}</section>,
    }),
    defineBlock({
      name: 'component',
      label: 'Component',
      fields: { title: text() },
      render: ({ title }) => <Heading title={title} />,
    }),
    defineBlock({
      name: 'fragment',
      label: 'Fragment',
      fields: { title: text() },
      render: ({ title }) => (
        <>
          <h2>{title}</h2>
          <p>and more</p>
        </>
      ),
    }),
    defineBlock({
      name: 'bareString',
      label: 'String',
      fields: { title: text() },
      render: ({ title }) => title,
    }),
  ]
  const reg = toRegistry(blocks)

  const docOf = (type: string): Doc => ({
    root: 'r0000001',
    bloks: {
      r0000001: {
        uid: 'r0000001',
        type,
        parent: null,
        slot: null,
        order: 'a0',
        data: { title: 'Hello' },
      },
    },
  })

  const markupIn = (mode: RenderMode) => (type: string) =>
    renderToStaticMarkup(
      renderGlobalNode(reg, { ...baseResolution, globals: { g: docOf(type) } }, 'g', { mode }),
    )
  const markup = markupIn('edit')

  it.each(['hostEl', 'component', 'fragment', 'bareString'])('marks a %s render', (type) => {
    expect(markup(type)).toContain('data-folio-uid="r0000001"')
  })

  /** A host element takes the attributes directly — no wrapper, no layout change. */
  it('does not wrap a host element', () => {
    const html = markup('hostEl')
    expect(html).toContain('<section data-folio-uid="r0000001"')
    expect(html).not.toContain('folio-marker')
  })

  /**
   * Everything else gets a real box, because the selection outline is an
   * `::after` inset on the marked element and `display: contents` would take it
   * away. `folio-marker` is the handle a host needs to opt out of that trade.
   */
  it.each(['component', 'fragment', 'bareString'])('wraps a %s render in a marker', (type) => {
    expect(markup(type)).toContain('<div class="folio-marker" data-folio-uid="r0000001"')
  })

  it('still leaks no marker at all when edit is off', () => {
    for (const type of ['hostEl', 'component', 'fragment', 'bareString']) {
      const html = renderToStaticMarkup(
        renderGlobalNode(reg, { ...baseResolution, globals: { g: docOf(type) } }, 'g'),
      )
      expect(html).not.toContain('data-folio-uid')
      expect(html).not.toContain('folio-marker')
    }
  })

  /**
   * `mark` is the third state, and this describe block is where the trade it makes
   * is visible in one place (`../../../docs/specs/platform/mcp-server.md` decision
   * 5a): the attribute where it costs nothing, no wrapper anywhere, and therefore
   * **no attribute at all** for the three shapes that have nowhere to put one.
   *
   * That asymmetry is the decision, not an oversight. Keeping the wrapper here
   * would buy addressing for those blocks by reintroducing, for exactly those
   * blocks, the extra grid child that is the most likely visual defect on the page
   * — into the render whose job is to show whether the page looks right.
   */
  const marked = markupIn('mark')

  it('puts the uid straight on a host element in mark mode, with no wrapper', () => {
    expect(marked('hostEl')).toContain('<section data-folio-uid="r0000001"')
    expect(marked('hostEl')).not.toContain('folio-marker')
  })

  it.each(['component', 'fragment', 'bareString'])(
    'leaves a %s render un-marked in mark mode rather than wrapping it',
    (type) => {
      expect(marked(type)).not.toContain('folio-marker')
      expect(marked(type)).not.toContain('data-folio-uid')
    },
  )

  /**
   * The property a screenshot depends on, asserted directly: `mark` adds
   * attributes to the published tree and never a node. Compared against `off`'s
   * own markup with the attributes stripped, so it cannot pass by both being empty.
   */
  it.each(['hostEl', 'component', 'fragment', 'bareString'])(
    'renders node-for-node what a published page renders, for a %s',
    (type) => {
      const published = markupIn('off')(type)
      const stripped = marked(type).replace(/ data-folio-(uid|type)="[^"]*"/g, '')
      expect(stripped).toBe(published)
      expect(published).not.toBe('')
    },
  )
})
