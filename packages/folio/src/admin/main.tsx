import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Prototype, type PrototypeBoot } from './ui/Prototype'

/**
 * The bundle's entry, and nothing else. Two applications share it while the
 * rebuild is in flight, and the page decides which one by **which bootstrap it
 * shipped** rather than by sniffing the URL:
 *
 * - `__FOLIO_SHELL__` — the rebuilt admin (`server/routes/shell.ts`), whose own
 *   router owns every path under its mount. This replaced the `?_ui` query flag
 *   that carried the design-system screen: `{base}/ui` is a route now.
 * - `__FOLIO_ADMIN__` — the current single-screen editor, still at
 *   `{base}/edit/:id`, which it keeps by being registered ahead of the shell's
 *   wildcard (`server/app.ts`) until port phase 7 replaces it.
 *
 * Both are **static** imports, and that matters: the Vite plugin tells the server
 * to link `/folio-admin.css` in production (`src/vite/index.ts`), and that file
 * only exists while `admin.css` is reachable from this entry's static graph. A
 * dynamic import renames it to a hashed chunk asset and the editor ships unstyled —
 * a failure only `pnpm build` catches, since dev serves the CSS through the module
 * graph either way.
 *
 * The cost is that the rebuilt shell loads `admin.css` too, whose bare-element
 * rules (`button`, `body`) leak into it. Every primitive sets those properties on
 * its own hashed class, which out-specifies an element selector, so the leak is
 * survivable — and it disappears with `admin.css` in the last phase of the port
 * plan.
 */

declare global {
  interface Window {
    __FOLIO_SHELL__?: PrototypeBoot
  }
}

const el = document.getElementById('folio-admin')

if (el) {
  const shell = window.__FOLIO_SHELL__
  const boot = window.__FOLIO_ADMIN__

  if (shell) {
    createRoot(el).render(
      <StrictMode>
        <Prototype boot={shell} />
      </StrictMode>,
    )
  } else if (boot) {
    createRoot(el).render(
      <StrictMode>
        <App boot={boot} />
      </StrictMode>,
    )
  }
}
