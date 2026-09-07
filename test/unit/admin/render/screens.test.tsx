/**
 * **Every screen mounts.** The smoke layer issue #14 asks for, and the layer that
 * would have caught the `.folio-ui` omission — which shipped on every inspector
 * input and every record field for the whole eight-phase port, and was reported
 * three components away from its cause as "the right panel has no padding".
 *
 * No behavioural assertions, deliberately. What each screen *does* with its data
 * is covered by its `*-model.ts` and `use*.ts` neighbours, with far better inputs
 * than a fixture gives; duplicating that here would be a second, worse copy. What
 * is asserted is only what those tests cannot reach: that the component tree
 * assembles, in a DOM, with the props `screenFor` really hands it.
 *
 * The strictness lives in `setup.ts`, not here: `console.error` and an unhandled
 * rejection both fail the test, so "mounted" means React logged nothing and no
 * effect's promise died. Without that a smoke test is close to worthless, because
 * React reports most of what goes wrong in a mounted tree by logging rather than
 * throwing.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { API, mountAt } from './fixture'

/**
 * Every route in `route.ts`'s `Screen` union, by the URL that reaches it.
 *
 * Kept as URLs rather than `Screen` objects so the table is what a person could
 * type, and so a route that stops parsing shows up here as a screen that renders
 * "Not found" rather than as a type error. `missing` is in the list because it is
 * a screen with a component like any other.
 *
 * The fourth column is the expected `h1` text — issue #8's invariant is "exactly
 * one `h1` per screen, and it is the top bar's last crumb" — and it is **hard-coded
 * here, not derived from `crumbs()`**: a test that computed its expectation from the
 * same function the component reads asserts only that the code agrees with itself,
 * which passes even if both sides are wrong about what the crumb should say.
 */
const ROUTES: [name: string, path: string, title: string, h1: string][] = [
  ['home', '/folio', 'Folio', 'Home'],
  ['content', '/folio/content', 'Content', 'Content'],
  ['content, flat mode', '/folio/content?view=flat', 'Content', 'Content'],
  ['documents', '/folio/documents/person', 'Person', 'Person'],
  ['documents, an undeclared type', '/folio/documents/nosuchtype', 'nosuchtype', 'nosuchtype'],
  ['assets', '/folio/assets', 'Assets', 'Assets'],
  ['assets, table view', '/folio/assets?view=table', 'Assets', 'Assets'],
  ['edit', '/folio/edit/sty_home', 'Home', 'Home'],
  ['edit, a global', '/folio/edit/sng_header', 'Header', 'Header'],
  ['access', '/folio/access', 'Access', 'Access'],
  ['model', '/folio/model', 'Model', 'Model'],
  ['redirects', '/folio/redirects', 'Redirects', 'Redirects'],
  ['schedules', '/folio/schedules', 'Schedules', 'Schedules'],
  ['settings', '/folio/settings', 'Settings', 'Settings'],
  ['forms', '/folio/forms', 'Forms', 'Forms'],
  ['form', '/folio/form/frm_one', 'Contact', 'Contact'],
  // 'Responses', not the form's label: `documentTitle` takes the *last* crumb and
  // this screen's trail is Forms / <the form> / Responses. Asserting 'Contact'
  // here failed, which is the assertion working — the middle crumb is where the
  // label lands, and `form` above is the route that proves it arrives.
  ['responses', '/folio/responses/frm_one', 'Responses', 'Responses'],
  ['account', '/folio/account', 'Your account', 'Your account'],
  ['missing', '/folio/nosuchscreen', 'Not found', 'Not found'],
]

describe('every screen mounts', () => {
  for (const [name, path, title] of ROUTES) {
    it(`${name} — ${path}`, async () => {
      const { container } = await mountAt(path)
      // Something rendered, and the shell is around it. An empty container would
      // pass every "did not throw" check while rendering nothing at all.
      expect(container.querySelector('main')).not.toBeNull()
      // And it is the *right* screen. Without this the whole table would pass
      // against a router that answered `missing` for everything — the shell would
      // mount, `main` would exist, and nineteen tests would be asserting one
      // screen. The title is read rather than a per-screen marker because
      // `route.ts` already owns the mapping (`TITLES`), so this couples the test
      // to the router rather than to nineteen components' markup.
      expect(document.title).toContain(title)
    })
  }
})

/**
 * Issue #8: the screen dropped its own heading, and the breadcrumb's last crumb
 * became the page's `h1`. Two ways for that to be silently false, and each needs
 * its own assertion:
 *
 * - A screen could still render a second `h1` of its own (`Home.tsx` rolled one
 *   before this issue, and `Stub.tsx` did too) — undetectable by counting the top
 *   bar's heading in isolation, since a second one elsewhere in the tree would
 *   simply coexist with it.
 * - The top bar could stop rendering an `h1` at all (a regression back to a
 *   `<span>`) — undetectable by asking only "is there an `h1` with this text",
 *   since `getByRole('heading', { level: 1 })` matches the *first* of however many
 *   there are and says nothing about the rest.
 *
 * `document.querySelectorAll` rather than `container` — a portal renders outside
 * the container `render()` returns, and a stray heading anywhere in the document
 * is exactly the failure being ruled out — and the exact-array form
 * (`toEqual([expected])`) rather than a single `getByRole` lookup, because the
 * array form is the only one that fails when there are *two* `h1`s instead of one.
 */
describe('exactly one h1 per screen, and it is the breadcrumb', () => {
  for (const [name, path, , h1] of ROUTES) {
    it(`${name} — ${path}`, async () => {
      await mountAt(path)
      const h1s = Array.from(document.querySelectorAll('h1'))
      expect(h1s.map((el) => el.textContent)).toEqual([h1])
      // Not just "an h1 with this text somewhere" — the one h1 has to be the top
      // bar's last crumb, or a screen that kept its own heading while the top bar
      // lost one would pass the line above by coincidence.
      expect(h1s[0]?.closest('nav[aria-label="Breadcrumb"]')).not.toBeNull()
    })
  }
})

/**
 * The shell's own furniture, which is on every one of the routes above and so is
 * asserted once rather than nineteen times.
 */
describe('the shell', () => {
  it('carries the scope class on its root, which is what turns tokens.css on', async () => {
    const { container } = await mountAt('/folio')
    expect(container.firstElementChild?.classList.contains('folio-ui')).toBe(true)
  })

  it('renders the toast as a permanently mounted live region', async () => {
    // `CLAUDE.md`: the toast is a permanently mounted `role="status"` region, and
    // making it conditional again breaks announcement — a region that appears at
    // the same moment as its text is not announced by a screen reader.
    await mountAt('/folio')
    expect(screen.getByRole('status')).not.toBeNull()
  })

  it('actually asked for the three things the boot needs', async () => {
    // A screen that mounts because its fetch never happened is a green test
    // proving nothing. This is the guard on the fixture rather than on the admin.
    const { asked } = await mountAt('/folio')
    expect(asked.some((u) => u.includes(`${API}/schema`))).toBe(true)
    expect(asked.some((u) => u.includes(`${API}/me`))).toBe(true)
    expect(asked.some((u) => u.includes(`${API}/documents?kind=singleton`))).toBe(true)
  })
})
