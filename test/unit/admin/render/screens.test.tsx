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
 */
const ROUTES: [name: string, path: string, title: string][] = [
  ['home', '/folio', 'Folio'],
  ['content', '/folio/content', 'Content'],
  ['content, flat mode', '/folio/content?view=flat', 'Content'],
  ['documents', '/folio/documents/person', 'Person'],
  ['documents, an undeclared type', '/folio/documents/nosuchtype', 'nosuchtype'],
  ['assets', '/folio/assets', 'Assets'],
  ['assets, table view', '/folio/assets?view=table', 'Assets'],
  ['edit', '/folio/edit/sty_home', 'Home'],
  ['edit, a global', '/folio/edit/sng_header', 'Header'],
  ['access', '/folio/access', 'Access'],
  ['model', '/folio/model', 'Model'],
  ['redirects', '/folio/redirects', 'Redirects'],
  ['schedules', '/folio/schedules', 'Schedules'],
  ['settings', '/folio/settings', 'Settings'],
  ['forms', '/folio/forms', 'Forms'],
  ['form', '/folio/form/frm_one', 'Contact'],
  // 'Responses', not the form's label: `documentTitle` takes the *last* crumb and
  // this screen's trail is Forms / <the form> / Responses. Asserting 'Contact'
  // here failed, which is the assertion working — the middle crumb is where the
  // label lands, and `form` above is the route that proves it arrives.
  ['responses', '/folio/responses/frm_one', 'Responses'],
  ['account', '/folio/account', 'Your account'],
  ['missing', '/folio/nosuchscreen', 'Not found'],
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
