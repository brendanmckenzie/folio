import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Admin, type AdminBoot } from './ui/Admin'

/**
 * The bundle's entry, and nothing else. **One application, since port phase 8.**
 *
 * `__FOLIO_SHELL__` (`server/routes/shell.ts`) is the only bootstrap there is now:
 * the rebuilt admin's own router owns every path under its mount, including
 * `{base}/edit/:id`. The `__FOLIO_ADMIN__` branch beside it was the old
 * single-screen editor, which lost its URL in phase 7 and its files in phase 8.
 *
 * `Admin` is a **static** import, and that still matters for the reason the
 * two-application version of this comment gave: the Vite plugin tells the server to
 * link `/folio-admin.css` in production (`src/vite/index.ts`), and that file only
 * exists while some stylesheet is reachable from this entry's *static* graph. What
 * reaches it is no longer `admin.css` — it is `ui/tokens.css`, imported at the top
 * of `Admin.tsx`, plus every `*.module.css` under `ui/`, which Vite concatenates
 * into the entry's one CSS asset. A dynamic import here would rename that asset to a
 * hashed chunk and the whole admin would ship unstyled — and dev serves the CSS
 * through the module graph either way, so nothing local shows it.
 *
 * This used to end "a failure only `pnpm build` catches", which understated it:
 * `pnpm build:demo` **exits 0** on the broken version and emits the wrong artifact,
 * so it is caught only by somebody reading the file list. `admin-entry.test.ts`
 * asserts the static import as source text, which is the version of that gate that
 * runs.
 *
 * The cost the old comment named — `admin.css`'s bare-element rules leaking into the
 * rebuilt shell — is gone with the file. `ui/tokens.css` is the only stylesheet that
 * reaches past a hashed class, and it does so deliberately.
 */

declare global {
  interface Window {
    __FOLIO_SHELL__?: AdminBoot
  }
}

const el = document.getElementById('folio-admin')
const shell = window.__FOLIO_SHELL__

if (el && shell) {
  createRoot(el).render(
    <StrictMode>
      <Admin boot={shell} />
    </StrictMode>,
  )
}
