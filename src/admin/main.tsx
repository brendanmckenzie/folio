import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

/**
 * The bundle's entry, and nothing else — the editor itself moved to `App.tsx`,
 * which also owns the `admin.css` import now. This file is the seed of the router
 * `docs/specs/admin/url-and-shell.md` will specify: one place that reads the URL
 * and decides what to mount.
 *
 * `App` is imported statically and the design-system screen dynamically, not the
 * other way round, and the asymmetry is deliberate: the Vite plugin tells the
 * server to link `/folio-admin.css` in production (`src/vite/index.ts`), and that
 * file only exists while `admin.css` is reachable from this entry's static graph.
 * Splitting `App` out renames it to a hashed chunk asset and the editor ships
 * unstyled.
 *
 * The cost is that the design-system screen loads `admin.css` too, whose
 * bare-element rules (`button`, `body`) leak into it. Every primitive sets those
 * properties on its own hashed class, which out-specifies an element selector, so
 * the leak is survivable — and it disappears entirely when `admin.css` does.
 */

const el = document.getElementById('folio-admin')

if (el) {
  /**
   * Scaffolding, deliberately ugly so it is not mistaken for a feature: the
   * design-system screen has no route of its own until the router lands, so it
   * rides on a query flag over the editor's URL. Reach it in dev at
   * `{base}/edit/<any id>?_ui`. Delete this branch when `{base}/ui` exists.
   */
  if (new URLSearchParams(window.location.search).has('_ui')) {
    void import('./ui/Kitchen').then(({ Kitchen }) => {
      createRoot(el).render(
        <StrictMode>
          <Kitchen />
        </StrictMode>,
      )
    })
  } else {
    const boot = window.__FOLIO_ADMIN__
    if (boot) {
      createRoot(el).render(
        <StrictMode>
          <App boot={boot} />
        </StrictMode>,
      )
    }
  }
}
