/**
 * The representative payload every render test in this directory mounts against:
 * one manifest, one signed-in actor, and a `fetch` that answers every route the
 * admin asks for on mount.
 *
 * **It is one fixture rather than one per screen, deliberately.** These are smoke
 * tests — the question is "does this tree mount", and the logic each screen
 * applies to its data is already covered by its `*-model.ts` neighbour with far
 * better inputs than a fixture would give it. A per-screen payload would be a
 * second, worse copy of those tests, and the thing it would actually catch — a
 * screen that throws on an empty list — is caught by this one.
 *
 * The manifest deliberately declares one of each `kind`, plus a type with `under`
 * and a type with a `group`, because those are the branches the sidebar and the
 * create dialogs take. It is the same shape `settings-screen.test.ts` builds, and
 * kept separate from it on purpose: that file's manifest is an *input to
 * assertions about rows*, so tightening it for a smoke test would change what
 * those tests prove.
 */
import { render } from '@testing-library/react'
import { act } from 'react'
import type { Manifest } from '../../../../src/core/schema'
import { type Me, OPEN } from '../../../../src/admin/me'
import { Prototype } from '../../../../src/admin/ui/Prototype'

export const MOUNT = '/folio'
export const API = '/folio/api'

export const BOOT = { base: MOUNT, apiBase: API }

export const MANIFEST: Manifest = {
  root: 'pageRoot',
  globals: ['header'],
  types: [
    { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot', default: true },
    { name: 'insight', label: 'Insight', kind: 'page', root: 'insightRoot', under: ['page'] },
    {
      name: 'person',
      label: 'Person',
      kind: 'record',
      root: 'personRoot',
      titleField: 'fullName',
      group: 'Directory',
    },
    { name: 'header', label: 'Header', kind: 'singleton', root: 'headerRoot', previewPath: '' },
  ],
  blocks: [
    {
      name: 'pageRoot',
      label: 'Page',
      summary: 'title',
      // A slot is a `blocks` field, not a `slots` key beside `fields` — `slotsOf`
      // is the only reader and it filters `fields` by kind. Worth one line of
      // fixture, because the editor's block rail is empty without one.
      fields: {
        title: { kind: 'text', label: 'Title' },
        body: { kind: 'richtext', label: 'Body' },
        main: { kind: 'blocks', label: 'Main', allow: ['prose'] },
      },
    },
    { name: 'insightRoot', label: 'Insight', fields: { title: { kind: 'text', label: 'Title' } } },
    {
      name: 'personRoot',
      label: 'Person',
      fields: { fullName: { kind: 'text', label: 'Full name', indexed: true } },
    },
    {
      name: 'headerRoot',
      label: 'Header',
      fields: { tagline: { kind: 'text', label: 'Tagline' } },
    },
    { name: 'prose', label: 'Prose', fields: { text: { kind: 'richtext', label: 'Text' } } },
  ],
}

/** An `admin`, so nothing is hidden by a role gate. #7 varies this. */
export const ADMIN: Me = {
  mode: 'session',
  loginUrl: `${MOUNT}/login`,
  space: false,
  actor: {
    kind: 'user',
    id: 'usr_admin',
    name: 'Ada',
    colour: '#0090ff',
    role: 'admin',
    email: 'ada@example.com',
    roleFrom: null,
  },
}

export const VIEWER: Me = {
  ...ADMIN,
  actor: { ...ADMIN.actor, role: 'viewer' } as Me['actor'],
}

const STORY = {
  id: 'sty_home',
  type: 'page',
  title: 'Home',
  path: '',
  slug: '',
  state: 'published',
  parentId: null,
  ord: 'a0',
  url: '/',
  previewUrl: '/?_folio=preview',
  createdAt: 1,
  updatedAt: 1,
}

/**
 * The one global, so `{base}/edit/sng_header` opens a document rather than
 * "no such document".
 *
 * It comes back from `?kind=singleton`, which is the boot's third request and
 * also what *creates* a singleton on first access — so a fixture that answered
 * an empty list would put the editor in its not-found state on every global, and
 * the route table would be asserting the error screen nine times over.
 */
const GLOBAL = {
  ...STORY,
  id: 'sng_header',
  type: 'header',
  title: 'Header',
  path: null,
  url: null,
  previewUrl: null,
}

/**
 * One row each for the four list routes that have a **role-gated per-row
 * control** — and every other list stays empty (issue #7).
 *
 * The argument above for answering everything empty still holds for the smoke
 * layer, and these do not weaken it: a screen that throws on an empty list is
 * still what the other fifteen routes catch. What an empty list cannot do is prove
 * a *row's* control is absent. Documents' `Delete`, Redirects' `Delete`,
 * Schedules' `Cancel` and Forms' `Responses` are all rendered per row, so "the
 * control is absent for a viewer" over a table with no rows is true of every role
 * and proves nothing — which is precisely the vacuous assertion
 * `docs/1.0-plan.md` records this project finding in three of its own tests.
 *
 * Asserting the *actions column header* instead was the alternative, and it is
 * weaker in exactly the way that matters: two of those four rows hold two buttons
 * at two different roles, so removing the gate from one of them leaves the column
 * where it was and the check stays green with the defect back.
 */
const RECORD = {
  ...STORY,
  id: 'sty_ada',
  type: 'person',
  title: 'Ada',
  // A record has no URL of its own (`document-types.md` checkpoint 2), which is
  // what makes it a *record* rather than a page with an empty path.
  path: null,
  slug: 'ada',
  url: null,
  previewUrl: null,
  state: 'draft',
  // The type's `indexed` fields, and empty is the honest shape: a cell with no
  // published value renders the deliberate `—`, which is a state the screen has
  // to handle anyway.
  indexed: {},
}

/**
 * One asset, for the media library's **detail panel**. The grid stays empty; see
 * the by-id branch in `bodyFor` for why the two are different answers.
 *
 * `tags` is why this is a literal rather than a spread of something else:
 * `AssetRow` widens the server's row with the tags the list route joins in, and
 * `AssetDetail`'s read-only register reads `row.tags.length` directly. A row
 * without it renders as a crash, not as an empty tag list.
 *
 * `alt` empty with `altAuto` set is the interesting pair rather than an arbitrary
 * one: `toAssetValue` reads `alt || altAuto`, so it is the case where a panel that
 * rendered only `alt` would tell a viewer this file has no alt text while a
 * document renders some.
 */
const ASSET = {
  id: 'ast_one',
  key: 'assets/ast_one/hero.png',
  filename: 'hero.png',
  contentType: 'image/png',
  size: 12_345,
  width: 1200,
  height: 630,
  alt: '',
  altAuto: 'A harbour at dusk',
  description: 'The hero image on the home page',
  descriptionAuto: '',
  createdAt: 1,
  // **Filed, not unfiled**, and that is the point of the value. `Unfiled` is a
  // real state rather than an absence, so a panel that fell back to it while
  // `GET {base}/api/assets/folders` was in flight would be indistinguishable from
  // a correct one for every asset whose `folderId` is null. Answering a folder id
  // — and a folder row below — is what lets the assertion tell the fact from the
  // fallback.
  folderId: 'afl_brand',
  describedAt: null,
  describeError: null,
  tags: [],
}

/** The one folder, so `ASSET`'s `folderId` resolves to a name. */
const FOLDER = { id: 'afl_brand', name: 'Brand', path: 'Brand', parentId: null, createdAt: 1 }

const REDIRECT = {
  from: '/old-services',
  to: '/services',
  status: 301,
  source: 'auto',
  storyId: STORY.id,
  createdAt: 1,
}

const SCHEDULE = {
  id: 'sch_one',
  storyId: STORY.id,
  action: 'publish',
  // Far enough ahead that `health` reports nothing: an overdue row would put a
  // banner on the screen, which is a state worth a test of its own and not this
  // one's subject.
  at: 4_000_000_000_000,
  status: 'pending',
  actor: 'usr_admin',
  createdAt: 1,
  attempts: 0,
  lastError: null,
}

/**
 * A page of nothing, in every envelope shape the admin's list routes use.
 *
 * One object rather than a per-route table, because the alternative is a fixture
 * that has to be edited every time a route grows a field — and a route whose
 * envelope this does not satisfy shows up immediately as a screen that will not
 * mount, which is the failure these tests exist to produce.
 */
const EMPTY_PAGE = {
  rows: [],
  nodes: [],
  items: [],
  assets: [],
  folders: [],
  tags: [],
  users: [],
  tokens: [],
  redirects: [],
  schedules: [],
  forms: [],
  responses: [],
  versions: [],
  events: [],
  migrations: [],
  results: [],
  counts: {},
  total: 0,
  cursor: null,
  next: null,
  hasMore: false,
}

/** One form, for the list, the builder and the responses screen. */
const FORM = {
  id: 'frm_one',
  name: 'contact',
  label: 'Contact',
  fields: [],
  // The two aggregates the list route only computes when asked, and `useForms`
  // always asks (`?count=1&counts=1`). Without them the row reads "undefined
  // questions", which is the fixture lying rather than the screen being wrong.
  questions: 0,
  responses: 0,
  version: 1,
  open: true,
  closesAt: null,
  closedMessage: '',
  successMessage: 'Thanks',
  submitLabel: 'Send',
  redirectTo: null,
  createdAt: 1,
  updatedAt: 1,
}

/**
 * Every route the admin fetches on mount, answered 200.
 *
 * **The named routes are the ones whose body has a *shape*, not merely an
 * envelope**, and each earns its line by having thrown without it: `driftBanner`
 * reads `status.pending.length`, `attention` reads `status.migrations.find`, and
 * `FormBuilder` reads `draft.fields.find`. None of those three is defensive about
 * a malformed body and none of them should be — the body comes from Folio's own
 * route, so a missing field is a bug in the route or in this fixture, and a `??`
 * at the call site would hide both. That is the shape of finding a smoke layer
 * produces, and it is why the fixture is typed against the server's own
 * interfaces rather than being a bag of empty arrays.
 *
 * **`space: false` on `/me` is load-bearing**, not incidental: it is what stops
 * `useSpace` building a store and opening a socket (`hooks/useSpace.ts` —
 * "`enabled: false` builds no store and opens no socket"). A render test that
 * opened a real WebSocket would be asserting the environment's socket stub, and
 * would hang or reject depending on which one it got.
 */
function bodyFor(url: string): unknown {
  const withoutOrigin = url.replace(/^https?:\/\/[^/]+/, '')
  const path = withoutOrigin.split('?')[0] ?? ''
  const query = withoutOrigin.slice(path.length)

  // `/stories?ids=` is `useStory`'s by-id read, not the tree's page, and the two
  // share a path. Answering the row is what puts the editor in its *loaded*
  // state — without it every `edit` route mounts "no such document", which passes
  // a smoke test while covering none of the editor.
  if (path === `${API}/stories` && query.includes('ids=')) {
    return { ...EMPTY_PAGE, rows: [query.includes('sng_') ? GLOBAL : STORY] }
  }
  // The boot's third request, and the only source of a global's row.
  if (path === `${API}/documents` && query.includes('kind=singleton')) {
    return { ...EMPTY_PAGE, rows: [GLOBAL] }
  }
  // The four routes that answer a row rather than an empty page — see the block
  // comment on `RECORD` for why these four and no others. All four read `rows`,
  // which is why they are branches here rather than keys on `EMPTY_PAGE`.
  if (path === `${API}/documents`) return { ...EMPTY_PAGE, rows: [RECORD] }
  if (path === `${API}/redirects`) return { ...EMPTY_PAGE, rows: [REDIRECT] }
  if (path === `${API}/schedules`) return { ...EMPTY_PAGE, rows: [SCHEDULE] }
  if (path === `${API}/forms`) return { ...EMPTY_PAGE, rows: [FORM] }
  /*
   * The asset **lookup**, not the list — and that distinction is load-bearing.
   *
   * The detail panel holds five role-gated controls of its own and only renders
   * for a resolved row, so something has to answer one. `panelSubject` takes it
   * from either the loaded page (`inHand`) or `GET {base}/api/assets/:id`
   * (`lookup`), and answering the *list* was the first attempt: it also made the
   * media library non-empty, which broke the two assertions about the empty
   * state's prose. Answering only the by-id route gives the panel a row and
   * leaves the grid empty, so both hold at once — the same reason `/stories?ids=`
   * is a branch of its own above.
   */
  if (path === `${API}/assets/${ASSET.id}`) return ASSET
  // The folder vocabulary, so the panel can name the folder the asset is in
  // rather than falling back. `EMPTY_PAGE`'s `folders: []` answered this before,
  // which made *every* asset read as unfiled.
  if (path === `${API}/assets/folders`) return { ...EMPTY_PAGE, rows: [FOLDER] }
  /*
   * A deployment that *does* describe images.
   *
   * `useDescribe` draws no control at all when this answers nothing, which is the
   * same "absent" pattern arriving from a different direction — and it would make
   * the bulk *Describe* button invisible to every role, so the assertion that an
   * admin can see it would pass against a button nobody can ever see. Answering
   * `configured` is what puts the one `ADMIN` control in this feature on screen.
   */
  if (path === `${API}/assets/describe`) {
    return { configured: true, onUpload: false, images: false, batch: 10 }
  }

  if (path === `${API}/schema`) return MANIFEST
  if (path === `${API}/me`) return currentMe
  if (path === `${API}/counts`) return { pages: 0, types: {} }
  if (path === `${API}/migrations`) return { migrations: [], pending: [], behind: 0 }
  if (path === `${API}/audit`) {
    return {
      documents: 0,
      content: [],
      stories: [],
      schema: [],
      orphanKeys: [],
      unknownTypes: [],
      missingFields: [],
      continueFrom: null,
    }
  }
  // The three sub-routes before `/forms/:id` itself, and all of them only when
  // there *is* an id — the bare `/forms` is the list route and wants the page
  // envelope like every other list.
  if (path.startsWith(`${API}/forms/`)) {
    if (path.endsWith('/usage')) return { published: [], total: 0, responses: 0, files: 0 }
    if (path.endsWith('/responses')) return EMPTY_PAGE
    return { form: FORM, ...FORM }
  }
  // `/story/:id` and its sub-routes (`/versions`, `/activity`) share a prefix, and
  // the envelope is merged in rather than branched per sub-route: `useTrail` reads
  // `page.rows` and a body without it sets `rows` to `undefined`, which surfaces
  // three components later as `versions.find is not a function`.
  if (path.startsWith(`${API}/story/`)) return { ...EMPTY_PAGE, story: STORY, doc: null }
  if (path.startsWith(`${API}/documents/`) || path.startsWith(`${API}/assets/`)) {
    return { ...EMPTY_PAGE, ...STORY }
  }
  return EMPTY_PAGE
}

let currentMe: Me = ADMIN

/**
 * Installs the stub and returns the URLs it was asked for, which is worth having
 * even in a smoke test: a screen that mounts *because* its fetch never happened
 * is a green test proving nothing, and the list says which is which.
 */
export function stubFetch(me: Me = ADMIN): string[] {
  currentMe = me
  const asked: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    asked.push(`${init?.method ?? 'GET'} ${url}`)
    return Promise.resolve(
      new Response(JSON.stringify(bodyFor(url)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch
  return asked
}

/**
 * Mounts the whole shell at `path`, then lets the boot's three requests settle.
 *
 * **The shell rather than the screen**, and that is the point of the file: the
 * props every screen actually receives are assembled by `screenFor` in
 * `Prototype.tsx`, so a test that hand-rolls them is testing its own idea of the
 * wiring. Mounting at a URL exercises the real thing — which is also how a screen
 * that renders only when the manifest has landed gets covered in both states.
 */
export async function mountAt(path: string, me: Me = ADMIN) {
  const asked = stubFetch(me)
  window.history.replaceState(null, '', path)
  const result = render(<Prototype boot={BOOT} />)
  // Four flushes, not one: the boot's `Promise.all` resolves, which renders the
  // screen, whose own effect fetches, whose answer sets state that a *third*
  // effect reads — the editor's row and the form builder's label are both three
  // deep. Microtask flushes rather than timers, so this stays deterministic;
  // a screen that needed a fifth would show up as a title that never arrives
  // rather than as a flake.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  // `asked` comes back with the result rather than being read off a module
  // global: two tests mounting in the same file would otherwise share one array,
  // and the second would assert against the first one's requests.
  return { ...result, asked }
}

/** `OPEN` re-exported so a test can mount the no-accounts deployment shape. */
export { OPEN }
