// @vitest-environment happy-dom
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineBlock, text, toRegistry, toSchemaIndex } from '../../../src/core'
import type { Doc } from '../../../src/core/doc'
import { computeBlocksDigest } from '../../../src/core/registry-digest'
import { FolioDoc } from '../../../src/preview/Render'
import { blocksNotice, mountPreview } from '../../../src/preview/mount'

/**
 * `mountPreview` compares the server's block digest with its own
 * (`multi-brand.md` decision 11): a bundle built from the wrong brand's blocks says so
 * in the page, and the page still renders.
 */

const page = defineBlock({
  name: 'page',
  label: 'Page',
  fields: { title: text() },
  render: ({ title }) => <h1>{title}</h1>,
})
const other = defineBlock({
  name: 'safari',
  label: 'Safari',
  fields: { title: text() },
  render: () => null,
})

const doc: Doc = {
  root: 'p0000001',
  bloks: {
    p0000001: {
      uid: 'p0000001',
      type: 'page',
      parent: null,
      slot: null,
      order: 'a0',
      data: { title: 'Hello' },
    },
  },
}

const digest = (...blocks: (typeof page)[]) =>
  computeBlocksDigest(toSchemaIndex(toRegistry(blocks)))

function mount(serverDigest: string | undefined) {
  const html = renderToString(<FolioDoc doc={doc} registry={toRegistry([page])} mode="edit" />)
  document.body.innerHTML = `<div id="folio-root">${html}</div>`
  window.__FOLIO__ = { doc, ...(serverDigest === undefined ? {} : { blocks: serverDigest }) }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mountPreview([page])
}

afterEach(() => {
  vi.restoreAllMocks()
  window.__FOLIO__ = undefined
  document.body.innerHTML = ''
})

describe('mountPreview digest check', () => {
  it('draws a notice naming the differing blocks and still renders the page', () => {
    mount(digest(page, other))
    const note = document.querySelector('[data-folio-blocks-notice]')
    expect(note?.textContent).toContain("This preview's blocks differ from the server's")
    expect(note?.textContent).toContain('missing safari')
    expect(document.getElementById('folio-root')?.textContent).toContain('Hello')
  })

  it('draws nothing when the digests agree', () => {
    mount(digest(page))
    expect(document.querySelector('[data-folio-blocks-notice]')).toBeNull()
  })

  it('draws nothing when the server sent no digest', () => {
    mount(undefined)
    expect(document.querySelector('[data-folio-blocks-notice]')).toBeNull()
  })
})

describe('blocksNotice', () => {
  it('names each kind of difference', () => {
    expect(blocksNotice({ missing: ['a', 'b'], extra: ['c'], changed: ['d'] })).toBe(
      "This preview's blocks differ from the server's: missing a, b; extra c; different fields in d. Rebuild the preview bundle from the same blocks module.",
    )
  })
})
