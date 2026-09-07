/**
 * **A control a role cannot use is not drawn.** Issue #7's proof, and the one
 * assertion `docs/ui-architecture.md`'s `## Cross-cutting` has always asked for
 * and nothing checked: *"impossible controls are absent; refusable ones explain
 * themselves before the click."*
 *
 * Three roles per screen, and all three are load-bearing:
 *
 *  - **`VIEWER`** — the control is absent. `queryAllByRole(...)` finds a disabled
 *    button perfectly well (`disabled` removes nothing from the accessibility
 *    tree), so an empty result here means *absent*, not "absent or greyed out".
 *    That is what makes this file able to tell the rejected design from the
 *    chosen one.
 *  - **`ADMIN`** — the same controls are present. Without it every assertion
 *    below would pass against a screen that renders no controls for anybody,
 *    which is the failure mode a negative-only test cannot see: a typo in a
 *    button's name, a screen that stopped mounting its header, a fixture that
 *    stopped answering rows.
 *  - **`OPEN`** — present. A deployment with no accounts has no roles, every
 *    predicate in `admin/me.ts` returns true for it, and *this* is the assertion
 *    that catches a gate written as `me.actor?.role === 'admin'` instead of
 *    through `me.ts`: such a gate is correct for a viewer and wrong for the one
 *    deployment shape where permissions do not exist.
 *
 * **The per-row half needs a row**, so four of the fixture's list routes answer
 * one — see the block comment on `RECORD` in `fixture.tsx` for why those four and
 * why an empty table would make the assertion vacuous. The bulk bar's five
 * actions are the exception and are asserted in
 * `../ui-content-model.test.ts` (`the bulk bar against a role`) instead: they
 * need a *selection* as well as a row, `actionsFor` is the seam the whole rule
 * lives in, and a pure function over four roles is a better test of a filter than
 * a mounted bar over one. What is asserted here that the pure test cannot reach
 * is that the screen passes `me` to it at all — `New page` is on the same screen
 * and comes from the same `me`.
 */
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Me } from '../../../../src/admin/me'
import { ADMIN, mountAt, OPEN, VIEWER } from './fixture'

/**
 * An `editor`, which the fixture does not export because only this file needs it.
 *
 * It is the role that separates the four predicates from each other: `canEdit`
 * and `canManageAssets` say yes, `canManageContent`, `canPublish` and
 * `canReadResponses` say no, and `canAdmin` says no. A file that only ever asked
 * about a viewer would pass with all six collapsed into one.
 */
const EDITOR: Me = { ...ADMIN, actor: { ...ADMIN.actor, role: 'editor' } as Me['actor'] }

/** Whether a button with this accessible name is on screen at all. `queryAll`
 * rather than `queryBy` because two of these names are legitimately rendered
 * twice — Assets' `Upload` is in the controls row *and* in the empty state — and
 * `queryBy` throws on a second match rather than answering the question. */
const drawn = (name: string) => screen.queryAllByRole('button', { name }).length > 0

/** Presence keyed by name, so a failure names the control that was wrong rather
 * than reporting `true !== false` about an anonymous boolean. */
const presence = (names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, drawn(name)]))

const every = (names: readonly string[], value: boolean) =>
  Object.fromEntries(names.map((name) => [name, value]))

/**
 * Every role-gated control on the six screens where `auth: 'open'` sees all of
 * them, by the accessible name a person reads — and each one's server `Access`,
 * because the predicate has to mirror the route rather than a guess about it.
 *
 * Access is not in the table: it is the one screen where `OPEN` is *also* refused,
 * and it has its own block at the bottom.
 */
const SCREENS: [name: string, path: string, controls: readonly string[]][] = [
  // `New page` is `CREATE`. The bulk bar is `actionsFor`'s, next door.
  ['Content', '/folio/content', ['New page']],
  // `New person` and `Duplicate` are `CREATE`; `Delete` is `MANAGE`. The two
  // per-row buttons are the defect the issue names by name.
  ['Documents', '/folio/documents/person', ['New person', 'Duplicate', 'Delete']],
  // Every one of these is `ASSETS` except `Describe`, which is `ADMIN` — see the
  // editor block below, which is the only place that difference is visible.
  [
    'Assets',
    '/folio/assets',
    ['Upload', 'New folder', 'Tag', 'Untag', 'Move', 'Delete', 'Describe'],
  ],
  // Both `MANAGE`: a redirect changes what URL the site serves.
  ['Redirects', '/folio/redirects', ['New redirect', 'Delete']],
  // `PUBLISH`: cancelling a schedule is calling off a publish.
  ['Schedules', '/folio/schedules', ['Cancel']],
  // `New form` is `EDIT`, `Responses` is `FORMS` (publisher) and `Delete` is
  // `ADMIN` — three roles on one screen, and `Responses` was the one gate that
  // was missing.
  ['Forms', '/folio/forms', ['New form', 'Responses', 'Delete']],
]

describe('a viewer is offered no control that cannot work', () => {
  for (const [name, path, controls] of SCREENS) {
    it(`${name} — ${path}`, async () => {
      await mountAt(path, VIEWER)
      expect(presence(controls)).toEqual(every(controls, false))
    })
  }
})

describe('an admin is offered all of them', () => {
  for (const [name, path, controls] of SCREENS) {
    it(`${name} — ${path}`, async () => {
      await mountAt(path, ADMIN)
      expect(presence(controls)).toEqual(every(controls, true))
    })
  }
})

describe('a deployment with no accounts is offered all of them', () => {
  for (const [name, path, controls] of SCREENS) {
    it(`${name} — ${path}`, async () => {
      // `OPEN` is also the admin's pre-boot guess, which is why `mountAt` flushes
      // four times: before `/api/me` lands, every screen here is rendering this
      // exact value. A gate that reads a role rather than a predicate is green
      // for a viewer, green for an admin, and wrong here.
      await mountAt(path, OPEN)
      expect(presence(controls)).toEqual(every(controls, true))
    })
  }
})

/**
 * The two controls whose gate is **stronger than `editor`**, on the one role that
 * can see the difference.
 *
 * Both viewer assertions above pass with `canReadResponses` written as `canEdit`
 * and `canAdmin` written as `canManageAssets` — a viewer is refused either way.
 * An editor is not, so this is where a predicate that mirrors the wrong `Access`
 * constant shows up.
 */
describe('an editor sees the editor-level controls and not the ones above them', () => {
  it('may build a form and may not read what people typed into it', async () => {
    await mountAt('/folio/forms', EDITOR)
    // `EDIT` — building a form is an editor's job (forms.md checkpoint 8).
    expect(drawn('New form')).toBe(true)
    // `FORMS` is publisher: these rows are what strangers typed about
    // themselves, and this button used to reach a 403.
    expect(drawn('Responses')).toBe(false)
    // `ADMIN`: the delete takes every response with it.
    expect(drawn('Delete')).toBe(false)
  })

  it('may file and delete files and may not spend money describing them', async () => {
    await mountAt('/folio/assets', EDITOR)
    // `ASSETS` is editor: an asset has no URL of its own to withdraw.
    expect(presence(['Upload', 'New folder', 'Tag', 'Move', 'Delete'])).toEqual(
      every(['Upload', 'New folder', 'Tag', 'Move', 'Delete'], true),
    )
    // `ADMIN`, the one route in the media library that is: a run is one model
    // call per file, on the host's account.
    expect(drawn('Describe')).toBe(false)
  })
})

/**
 * The actions **column**, which goes with the buttons in it.
 *
 * `Table`'s `actions` is optional and it draws neither the header cell nor the
 * per-row `<td>` without one (`ui/Table.tsx`), so a screen where the actor may
 * take none of a row's actions passes no `actions` at all. The alternative —
 * passing a function that returns an empty span — leaves a column of empty cells
 * under a header called "Actions", which reads as a rendering bug rather than as
 * a permission.
 */
describe('the actions column goes with the actions', () => {
  const TABLES: [name: string, path: string][] = [
    ['Documents', '/folio/documents/person'],
    ['Redirects', '/folio/redirects'],
    ['Schedules', '/folio/schedules'],
    ['Forms', '/folio/forms'],
  ]

  // One mount per test, not two: `cleanup()` runs in `afterEach`, so a second
  // `mountAt` in the same test asserts against both trees at once — which is how
  // the first version of this block failed, reporting the admin's column as the
  // viewer's.
  for (const [name, path] of TABLES) {
    it(`${name} draws one for an admin`, async () => {
      await mountAt(path, ADMIN)
      expect(screen.queryAllByText('Actions').length).toBe(1)
    })

    it(`${name} draws none for a viewer`, async () => {
      await mountAt(path, VIEWER)
      expect(screen.queryAllByText('Actions')).toEqual([])
    })
  }
})

/**
 * Assets' empty state, which a viewer can now reach with no action in it.
 *
 * `## Cross-cutting` says an empty state with no action is an error message, and
 * the escape is that the *body* becomes the next step — so the prose has to change
 * with the button. "Drop files anywhere here, or choose them" is an instruction a
 * viewer cannot follow, which is worse than no instruction at all.
 */
describe('an empty state with no action says something true instead', () => {
  it('does not tell a viewer to drop files they cannot upload', async () => {
    await mountAt('/folio/assets', VIEWER)
    expect(screen.queryByText(/Drop files anywhere here/)).toBeNull()
    expect(screen.queryByText(/Nothing has been added to this library/)).not.toBeNull()
  })

  it('still tells an editor how to fill it', async () => {
    await mountAt('/folio/assets', EDITOR)
    expect(screen.queryByText(/Drop files anywhere here/)).not.toBeNull()
  })
})

/**
 * The asset detail panel, which is a second screen behind a query parameter.
 *
 * Five of the media library's `ASSETS`-level writes are in there rather than in
 * the grid — alt text, description, folder, tags and the per-asset *Describe* —
 * plus its own *Delete*. Gating the grid and not the panel would have left
 * `{base}/assets?asset=<id>` as a complete set of controls a viewer could reach
 * by clicking a row, which is the same defect one URL deeper. It was missed by
 * the first pass at this issue precisely because no test mounted the panel.
 *
 * **The read-only half is the assertion worth having.** The rule is that
 * impossible *controls* are absent, and the values are not controls: a panel that
 * showed the alt text only to people who could change it would be using a
 * permission to hide content. So the editors go and the values stay, in the same
 * `Fact` register the panel already uses for type, size and key.
 */
describe('the asset panel gates its editors and keeps its values', () => {
  const PANEL = '/folio/assets?asset=ast_one'

  /**
   * **Scoped to the panel, and that is the whole assertion.** The first version of
   * these two asked the document, with a comment claiming `Describe` and `Delete`
   * could only be the panel's "because the grid's needs a selection and nothing is
   * ticked here". That was false: `AssetBrowser` renders the bulk bar whenever
   * `bulk` is true, regardless of the row count, and its buttons are merely
   * `disabled={count === 0}` — which this file's own header points out
   * `queryAllByRole` finds perfectly well. So both names were already present
   * before `AssetDetail` rendered anything, and removing the panel's gate left the
   * admin half green.
   */
  const panel = () => within(screen.getByRole('complementary', { name: 'hero.png' }))

  it('offers an admin every editor in it', async () => {
    await mountAt(PANEL, ADMIN)
    const inPanel = panel()
    expect(inPanel.queryAllByRole('button', { name: 'Describe' })).toHaveLength(1)
    expect(inPanel.queryAllByRole('button', { name: 'Delete' })).toHaveLength(1)
    expect(inPanel.queryByLabelText('Alt text')).not.toBeNull()
    expect(inPanel.queryByLabelText('Folder')).not.toBeNull()
  })

  it('offers a viewer none of them', async () => {
    await mountAt(PANEL, VIEWER)
    const inPanel = panel()
    expect(inPanel.queryAllByRole('button', { name: 'Describe' })).toEqual([])
    expect(inPanel.queryAllByRole('button', { name: 'Delete' })).toEqual([])
    // No form control at all, as against a disabled one: `queryByLabelText` finds
    // a disabled input, so null here means the field is gone rather than greyed.
    expect(inPanel.queryByLabelText('Alt text')).toBeNull()
    expect(inPanel.queryByLabelText('Folder')).toBeNull()
    // `Where it is used` reads an `EDIT`-gated route, so the section goes too —
    // otherwise it renders the server's role refusal as an error string inside the
    // one panel this issue turned into a viewer-facing surface.
    expect(inPanel.queryByText('Where it is used')).toBeNull()
  })

  it('still tells a viewer what the file says it is', async () => {
    await mountAt(PANEL, VIEWER)
    // `alt` is empty and `altAuto` is not, which is the pair `toAssetValue` reads
    // in that order — so a panel rendering only `alt` would claim this file has no
    // alt text while every document that places it renders some.
    expect(screen.queryByText('A harbour at dusk')).not.toBeNull()
    expect(screen.queryByText('The hero image on the home page')).not.toBeNull()
    // The folder by **name**, which is the assertion that `Unfiled` is a claim
    // rather than a fallback: the fixture files this asset under `Brand`, so a
    // panel that answered `folders.find(…) ?? 'Unfiled'` would say *Unfiled* for
    // as long as `GET {base}/api/assets/folders` was in flight — and for ever if
    // it failed, since the error lands in `folders.error` and a fallback never
    // reads it. Scoped to the panel because the browser's sidebar lists the same
    // folder name and `queryByText` throws on two matches rather than answering.
    const inPanel = within(screen.getByRole('complementary', { name: 'hero.png' }))
    expect(inPanel.queryByText('Brand')).not.toBeNull()
    expect(inPanel.queryByText('Unfiled')).toBeNull()
    expect(inPanel.queryByText('Tags')).not.toBeNull()
  })
})

/**
 * Access, verified rather than changed.
 *
 * The whole screen is gated — `ui/nav.ts` hides the rail entry unless
 * `canManageAccess`, and `accessGate` answers the URL typed by hand with a banner
 * naming *which* refusal it is — so there was nothing to convert. Its per-control
 * `reason=` values are the other half of the cross-cutting rule and stay: "A write
 * is in flight", the self-removal refusal, the passkey refusal and the
 * provider-set role are all transient or row-specific, and every one of them can
 * come true for the admin reading it.
 *
 * **It is also the one screen where `OPEN` is refused too**, and deliberately: the
 * routes behind it 404 under `auth: 'open'` because there is no admin and no way
 * to become one, so offering the surface would be offering a broken screen
 * (`admin/me.ts`'s `canManageAccess`). That is why this screen is not in the table
 * above — its third case is absent, not present.
 */
describe('Access is gated as a whole screen, not control by control', () => {
  const controls = ['Give access', 'New token']

  it('offers an admin both of its create controls', async () => {
    await mountAt('/folio/access', ADMIN)
    expect(presence(controls)).toEqual(every(controls, true))
  })

  it('offers a viewer neither, and says which refusal it is', async () => {
    await mountAt('/folio/access', VIEWER)
    expect(presence(controls)).toEqual(every(controls, false))
    // The banner rather than two empty tables: an empty table reads as "there are
    // no editors" rather than "you are not being told".
    expect(screen.queryByText(/may not manage editors or tokens/)).not.toBeNull()
  })

  it('offers a deployment with no accounts neither, because the routes 404 there', async () => {
    await mountAt('/folio/access', OPEN)
    expect(presence(controls)).toEqual(every(controls, false))
  })
})
