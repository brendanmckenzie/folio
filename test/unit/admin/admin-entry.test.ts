import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The bundle entry's one contract: **`Admin` is imported statically.**
 *
 * `src/admin/main.tsx`'s own comment has explained the hazard since port phase 8,
 * and issue #2's decision comment repeats it as the thing to check while renaming:
 * the Vite plugin tells the server to link `/folio-admin.css` in production
 * (`src/vite/index.ts`), and that file exists only while a stylesheet is reachable
 * from this entry's *static* graph. What reaches it is `ui/tokens.css`, imported
 * at the top of `Admin.tsx`, plus every `*.module.css` under `ui/`. Make this
 * import dynamic and Vite moves all of it into a hashed chunk the server never
 * links, and **the entire admin ships unstyled.**
 *
 * The comment also says the failure is one "only `pnpm build` catches", and that
 * is half right in the way that matters. Measured on 2026-09-07 by doing it:
 * `pnpm build:demo` **exits 0**. It does not fail — it succeeds and emits the
 * wrong artifact. `folio-admin.css` disappears from `dist/client/` entirely and
 * `assets/Admin-DUuKy0oE.css` appears instead, so the only thing that catches it
 * is a person reading `ls`. Nothing in the repository was watching, which is why
 * this file exists: a gate that has to be read by eye is not a gate.
 *
 * Source text rather than a build, deliberately. Asserting on `dist/` would mean
 * running the real build inside a unit test — minutes, and a dependency on build
 * output that `pnpm test` does not otherwise have — to learn something the one
 * line of source already says.
 */
const entry = readFileSync(new URL('../../../src/admin/main.tsx', import.meta.url), 'utf8')

describe('the admin entry', () => {
  it('imports the application statically, or the admin ships unstyled', () => {
    expect(entry).toMatch(/^import \{ Admin, type AdminBoot \} from '\.\/ui\/Admin'$/m)
  })

  it('reaches the application through no dynamic import at all', () => {
    // The assertion above pins the line that is there; this pins the absence of the
    // one that must not be, because the two are not the same check. A `lazy(() =>
    // import('./ui/Admin'))` added *beside* a surviving static import — which is
    // exactly what a half-finished code-splitting change looks like — satisfies the
    // first and is still the bug, since Vite splits on the dynamic edge.
    expect(entry).not.toMatch(/import\(/)
    expect(entry).not.toMatch(/\blazy\(/)
  })

  it('renders the component the shell bootstrap is typed against', () => {
    // `__FOLIO_SHELL__` is written by `server/pages.tsx` as an untyped JSON blob, so
    // this declaration is the only thing tying the two ends together. The global's
    // name is the wire and does not follow a rename of the type.
    expect(entry).toContain('__FOLIO_SHELL__?: AdminBoot')
    expect(entry).toContain('<Admin boot={shell} />')
  })
})
