import { blocks, defineBlock, text } from "folio/core";

/**
 * Root block for the `header` **singleton**
 * (`docs/specs/content-model/globals.md`). Every page's shell renders this —
 * see `folio.renderGlobal(resolution, 'header')` in `src/index.tsx` — so
 * changing the nav here changes it on every page at once, with no per-page
 * wiring to forget.
 *
 * `previewRoot: 'chromeFrame'` on its `DocumentType` is what lets the admin
 * preview a header edit above a short neutral frame instead of a blank
 * background or a real page's hero: opening this document points the iframe at
 * `/?_folio=preview&as=header`, and Folio builds the frame per request
 * (`docs/specs/content-model/singleton-preview-root.md`). `previewPath: ''`
 * would preview it on the homepage instead.
 */
/**
 * The frame a global is previewed above (`previewRoot: 'chromeFrame'` on the
 * `header` type). Folio builds a blank instance per request and never stores
 * it. It reads nothing about the global being edited: Folio draws every
 * configured global itself, and this only stands in for a page's body, so the
 * header is not crowded by a hero.
 */
export const chromeFrame = defineBlock({
  name: "chromeFrame",
  label: "Global preview frame",
  fields: { note: text({ label: "Note", default: "Page content appears here." }) },
  render: ({ note }) => (
    <main className="chrome-frame" style={{ padding: "4rem 1.5rem", color: "#888" }}>
      <p>{note}</p>
    </main>
  ),
});

export const headerRoot = defineBlock({
  name: "headerRoot",
  label: "Header",
  fields: {
    logoText: text({ label: "Logo text", default: "Folio demo", translatable: true }),
    nav: blocks({ label: "Navigation", allow: ["button"], max: 6 }),
  },
  render: ({ logoText, nav }) => (
    <header className="site-header">
      <span className="site-header__logo">{logoText || "Folio demo"}</span>
      <nav className="site-header__nav">{nav}</nav>
    </header>
  ),
});
