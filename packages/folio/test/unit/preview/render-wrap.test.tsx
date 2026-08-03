import { renderToStaticMarkup } from 'react-dom/server'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { wrapPreview } from '../../../src/core/render-wrap'

/**
 * The host's preview wrapper is a **component**, and this is the test that says
 * so.
 *
 * `wrapPreview` used to call it: `wrap({ children: tree })`. React never saw a
 * component, so there was no fibre and no dispatcher, and the first hook inside
 * threw `Cannot read properties of null (reading 'useState')` — from the server
 * render of the preview page, which means the whole preview became a stack trace
 * rather than one broken section.
 *
 * It shipped because the first wrapper written against the seam had no hooks:
 * it returned `<MemoryRouter>{children}</MemoryRouter>`, an element, so the
 * router's own hooks were fine and a plain call looked correct. The bug appeared
 * the moment a wrapper needed state of its own — which is the ordinary case,
 * because a data router must be built once and held rather than rebuilt on every
 * keystroke.
 */
describe('wrapPreview', () => {
  it('renders the tree unwrapped when there is no wrapper', () => {
    expect(renderToStaticMarkup(<>{wrapPreview(undefined, <p>hi</p>)}</>)).toBe('<p>hi</p>')
  })

  it('wraps the tree', () => {
    const wrap = ({ children }: { children: React.ReactNode }) => <main>{children}</main>
    expect(renderToStaticMarkup(<>{wrapPreview(wrap, <p>hi</p>)}</>)).toBe('<main><p>hi</p></main>')
  })

  /** The whole point. A wrapper holding a router, a theme or a store has state. */
  it('lets the wrapper use hooks', () => {
    function Wrap({ children }: { children: React.ReactNode }) {
      const [id] = useState('held')
      return <div data-wrap={id}>{children}</div>
    }
    expect(renderToStaticMarkup(<>{wrapPreview(Wrap, <p>hi</p>)}</>)).toBe(
      '<div data-wrap="held"><p>hi</p></div>',
    )
  })
})
