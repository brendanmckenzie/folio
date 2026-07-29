import { blocks, defineBlock, text } from 'folio/core'

/**
 * Root block for the `header` **singleton**
 * (`docs/specs/content-model/globals.md`). Every page's shell renders this —
 * see `folio.renderGlobal(resolution, 'header')` in `src/index.tsx` — so
 * changing the nav here changes it on every page at once, with no per-page
 * wiring to forget.
 *
 * `previewPath: ''` on its `DocumentType` (the root story, the homepage) is
 * what lets the admin preview a header edit sitting on top of a real page
 * instead of a blank background: opening this document points the iframe at
 * `/?_folio=preview&as=header`.
 */
export const headerRoot = defineBlock({
  name: 'headerRoot',
  label: 'Header',
  fields: {
    logoText: text({ label: 'Logo text', default: 'Folio demo' }),
    nav: blocks({ label: 'Navigation', allow: ['button'], max: 6 }),
  },
  render: ({ logoText, nav }) => (
    <header className="site-header">
      <span className="site-header__logo">{logoText || 'Folio demo'}</span>
      <nav className="site-header__nav">{nav}</nav>
    </header>
  ),
})
