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

/** One form, for the builder and the responses screen. */
const FORM = {
  id: 'frm_one',
  name: 'contact',
  label: 'Contact',
  fields: [],
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
