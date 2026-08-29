import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { blocks, defineBlock, text } from '../../src/core'
import { NO_STORE } from '../../src/core/cache-tags'
import type { Doc } from '../../src/core/doc'
import { singletonId } from '../../src/core/schema'
import type { DocumentType } from '../../src/core/schema'
import type { AuthConfig, FolioBindings } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import type { Scope } from '../../src/server/auth/roles'
import { createToken } from '../../src/server/auth/tokens'

/**
 * The two modes of `?_folio=` (`../../docs/specs/platform/mcp-server.md`
 * decision 5), asserted on the HTML rather than described — which is cheap,
 * because both are server-rendered strings out of the same `previewPage`.
 *
 * **This is the file that stops the split regressing.** There was one draft render
 * and it was the *editing* one: a `folio-editing` body, an extra
 * `<div class="folio-marker">` around any block whose `render` returns a component,
 * and a bridge that killed every link. Two things followed — a screenshot of it
 * verified layout against a DOM production does not serve, and a client sent a
 * share link got the editor's chrome. Both are fixed by there being a second mode,
 * and both regress silently, so the difference is pinned here attribute by
 * attribute.
 *
 * The fixture is built to make one assertion possible: **no block here renders a
 * `<div>`**, so the inner HTML of `#folio-root` can be extracted with a
 * non-greedy match and compared, node for node, against what the published page
 * would render.
 *
 * Its own `createFolio` with providers configured, for the reason
 * `auth-http.test.ts`'s header gives: every scope gate short-circuits under
 * `auth: 'open'`, and the gate on this branch is part of the subject.
 */

const ORIGIN = 'https://folio.test'

/** A host element: the uid goes straight onto it in both marked modes. */
const hero = defineBlock({
  name: 'pmHero',
  label: 'Hero',
  fields: { heading: text() },
  render: ({ heading }) => createElement('section', { className: 'hero' }, heading),
})

const Card = ({ label }: { label: string }) => createElement('article', null, label)

/**
 * A block whose `render` returns a **component**, which is the shape the whole
 * decision turns on: `cloneElement` cannot reach the DOM through it, so `edit`
 * wraps it in a marker `<div>` and `mark` deliberately leaves it unaddressable.
 */
const card = defineBlock({
  name: 'pmCard',
  label: 'Card',
  fields: { label: text() },
  render: ({ label }) => createElement(Card, { label }),
})

const pageRoot = defineBlock({
  name: 'pmPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ required: true }),
    body: blocks({ allow: ['pmHero', 'pmCard'] }),
  },
  render: ({ title, body }) => createElement('main', null, createElement('h1', null, title), body),
})

const Tagline = ({ tagline }: { tagline: string }) => createElement('p', null, tagline)

/** A global that also returns a component, so the context globals are covered too. */
const settingsRoot = defineBlock({
  name: 'pmSettings',
  label: 'Settings',
  fields: { tagline: text() },
  render: ({ tagline }) => createElement(Tagline, { tagline }),
})

const pageType: DocumentType = {
  name: 'pmPageType',
  label: 'Page',
  kind: 'page',
  root: 'pmPage',
  default: true,
}
const settingsType: DocumentType = {
  name: 'pmSettingsType',
  label: 'Settings',
  kind: 'singleton',
  root: 'pmSettings',
}

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
}

function build(mode: AuthConfig<Cloudflare.Env> | 'open' = auth) {
  return createFolio<Cloudflare.Env>({
    blocks: [pageRoot, hero, card, settingsRoot],
    types: [pageType, settingsType],
    globals: ['pmSettingsType'],
    bindings,
    basePath: '/folio',
    // `previewCss` is where a *host's own* CSS for its blocks lands, which is why
    // the stylesheet assertions below matter: a draft page ships no script, and
    // dropping the stylesheets alongside it would make every screenshot unstyled.
    assets: {
      admin: '/folio-admin.js',
      preview: '/folio-preview.js',
      previewCss: ['/site.css'],
    },
    auth: mode,
    route: (p) => (p ? `/${p}` : '/'),
  })
}

const folio = build()
const open = build('open')

function raw(path: string, init?: RequestInit, which = folio): Promise<Response | null> {
  return which.handle(new Request(`${ORIGIN}${path}`, init), env, createExecutionContext())
}

async function call(path: string, init?: RequestInit, which = folio): Promise<Response> {
  const res = await raw(path, init, which)
  if (!res) throw new Error(`handle() returned null for ${path}`)
  return res
}

async function tokenFor(...scopes: Scope[]) {
  const { token } = await createToken(env.DB, { name: 'shooter', scopes })
  return { authorization: `Bearer ${token}` }
}

let counter = 0

function docFor(title: string): Doc {
  return {
    root: 'r0',
    bloks: {
      r0: {
        uid: 'r0',
        type: 'pmPage',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title },
      },
      h0: {
        uid: 'h0',
        type: 'pmHero',
        parent: 'r0',
        slot: 'body',
        order: 'a0',
        data: { heading: 'Hero heading' },
      },
      c0: {
        uid: 'c0',
        type: 'pmCard',
        parent: 'r0',
        slot: 'body',
        order: 'a1',
        data: { label: 'Card label' },
      },
    },
  }
}

/** A routed page whose Durable Object already holds the fixture document. */
async function seedPage(title: string): Promise<{ id: string; path: string; doc: Doc }> {
  const slug = `pm${(counter++).toString().padStart(4, '0')}`
  const id = `sty_${slug}`
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
     values (?, 'pmPageType', null, ?, ?, 'a0', ?, ?, ?)`,
  )
    .bind(id, slug, slug, title, Date.now(), Date.now())
    .run()
  const doc = docFor(title)
  const stub = env.STORY.get(env.STORY.idFromName(id))
  await runInDurableObject(stub, (instance) => instance.getOrInit(doc))
  return { id, path: `/${slug}`, doc }
}

/**
 * The declared global's draft, so the context globals render something.
 *
 * Written with a mutation rather than seeded with a document of its own: every
 * test in this file resolves the same singleton, and the first one to do it wins
 * `getOrInit` — Durable Object state persists from test to test inside a file, so a
 * seeded document would silently lose to whichever page render ran first. Answers
 * the root's uid, which is minted rather than chosen for the same reason.
 */
async function seedGlobal(tagline: string): Promise<string> {
  const id = singletonId(settingsType)
  const stub = env.STORY.get(env.STORY.idFromName(id))
  return await runInDurableObject(stub, async (instance) => {
    const doc = await instance.getOrInit({
      root: 'g0',
      bloks: {
        g0: { uid: 'g0', type: 'pmSettings', parent: null, slot: null, order: 'a0', data: {} },
      },
    })
    await instance.commit([{ t: 'set', uid: doc.root, field: 'tagline', value: tagline }], {
      id: 'test',
      name: 'Test',
    })
    return doc.root
  })
}

/**
 * What `previewPage` put inside `#folio-root`. Non-greedy to the first `</div>`,
 * which is exact for this fixture because none of its blocks renders one.
 */
function rootHtml(html: string): string {
  const match = html.match(/<div id="folio-root">([\s\S]*?)<\/div>/)
  expect(match, 'no #folio-root in the response').not.toBeNull()
  return match![1]!
}

const bodyClassOf = (html: string) => html.match(/<body class="([^"]*)"/)?.[1] ?? null

/* ------------------------------------------------------------ the split --- */

describe('?_folio=preview — the editing render', () => {
  it('carries the editing body class and a marker div around a component block', async () => {
    const { path } = await seedPage('Editing title')
    const html = await (await call(`${path}?_folio=preview`, {}, open)).text()

    expect(bodyClassOf(html)).toBe('folio-editing')
    expect(html).toContain('<div class="folio-marker" data-folio-uid="c0"')
    // The host element takes its attributes directly, in this mode too.
    expect(html).toContain('data-folio-uid="h0"')
    // And it hydrates: the entry the bridge lives in, and the state it reads.
    expect(html).toContain('/folio-preview.js')
    expect(html).toContain('__FOLIO__')
  })
})

describe('?_folio=draft — the page', () => {
  it('carries neither the editing body class nor any marker div', async () => {
    const { path } = await seedPage('Draft title')
    const res = await call(`${path}?_folio=draft`, {}, open)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    // Same posture as the editing mode: it is still a draft at a public URL.
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    expect(res.headers.get('cache-tag')).toBeNull()

    const html = await res.text()
    expect(html).toContain('Draft title')
    expect(bodyClassOf(html)).toBeNull()
    expect(html).not.toContain('folio-marker')
    expect(html).not.toContain('folio-editing')
  })

  /**
   * The bridge is what kills every link and outlines whatever the cursor touches,
   * and `mountPreview` calls `attachBridge()` unconditionally — so the only way a
   * draft page does not get it is for the module holding it never to load. Both
   * halves are asserted: no entry to load it, and no `__FOLIO__` for it to act on
   * if a host loaded it anyway.
   */
  it('ships no client entry and no bootstrap, so no bridge can attach', async () => {
    const { path } = await seedPage('Unbridged')
    const html = await (await call(`${path}?_folio=draft`, {}, open)).text()

    expect(html).not.toContain('/folio-preview.js')
    expect(html).not.toContain('__FOLIO__')
    expect(html).not.toContain('<script')
  })

  /**
   * **The script goes and the stylesheets stay**, and that asymmetry is the whole
   * point rather than an oversight: the script is the bridge, while `previewCss`
   * is where the host's own CSS for its blocks lands. A later tidy-up reasoning
   * "a draft page needs none of the preview bundle" would drop both, go green on
   * every other assertion here, and make every screenshot phase 5 takes unstyled
   * — a defect that looks exactly like the CSS bug an agent was asked to check.
   */
  it('keeps the host stylesheets in both modes, though only one ships a script', async () => {
    const { path } = await seedPage('Styled')
    for (const mode of ['preview', 'draft'] as const) {
      const html = await (await call(`${path}?_folio=${mode}`, {}, open)).text()
      expect([mode, html.includes('/site.css')]).toEqual([mode, true])
    }
  })

  it('carries data-folio-uid on every block that renders a host element', async () => {
    const { path } = await seedPage('Addressable')
    const html = await (await call(`${path}?_folio=draft`, {}, open)).text()

    // The root and the hero both return host elements, so both are clippable.
    expect(html).toContain('<main data-folio-uid="r0"')
    expect(html).toContain('data-folio-uid="h0"')
    expect(html).toContain('data-folio-type="pmHero"')
  })

  /**
   * The deliberate half of decision 5a, and the one most likely to be "fixed" by
   * somebody who reads it as a gap: a component-returning block has nowhere to put
   * the attribute, and the marker `<div>` that would carry it is the extra grid
   * child this whole mode exists to avoid. So it has no uid, and `preview_document`
   * falls back to the viewport shot and says so.
   */
  it('leaves a component-returning block with no uid at all, which is the trade', async () => {
    const { path } = await seedPage('Untouched')
    const html = await (await call(`${path}?_folio=draft`, {}, open)).text()

    expect(html).toContain('Card label')
    expect(html).not.toContain('data-folio-uid="c0"')
  })

  /**
   * The acceptance criterion the two above are in tension with, and the one that
   * wins: `mark` adds attributes to the published tree and never a node. Compared
   * against the host's own render of the same document with the attributes
   * stripped, so it cannot pass by both sides being empty.
   */
  it('renders node-for-node what the published page would render', async () => {
    const { path, doc } = await seedPage('Identical')
    const html = await (await call(`${path}?_folio=draft`, {}, open)).text()

    const resolution = await open.resolve(env, doc)
    const published = renderToString(open.render(doc, { resolution }) as never)
    const stripped = rootHtml(html).replace(/ data-folio-(uid|type)="[^"]*"/g, '')

    expect(published).toContain('<main>')
    expect(stripped).toBe(published)
  })

  /**
   * A global is part of the page a reviewer sees, so it follows the page's mode
   * rather than being permanently `edit`. It was permanently `edit`, which would
   * have put a marker `<div>` around the site header of every draft render.
   */
  it('renders the context globals in the same mode as the page', async () => {
    const uid = await seedGlobal('Draft tagline')
    const { path } = await seedPage('With globals')

    const editing = await (await call(`${path}?_folio=preview`, {}, open)).text()
    expect(editing).toContain('data-folio-global="pmSettingsType"')
    expect(editing).toContain('Draft tagline')
    expect(editing).toContain(`<div class="folio-marker" data-folio-uid="${uid}"`)

    const drafted = await (await call(`${path}?_folio=draft`, {}, open)).text()
    expect(drafted).toContain('data-folio-global="pmSettingsType"')
    expect(drafted).toContain('Draft tagline')
    expect(drafted).not.toContain('folio-marker')
    // The wrapper stays — it is the same markup in both modes, by design — and the
    // global's own block goes unaddressed, exactly like any other component block.
    expect(drafted).not.toContain(`data-folio-uid="${uid}"`)
  })
})

/* ------------------------------------------------- the mode name is a name --- */

describe('what handle() does with the flag', () => {
  it('hands back an unrecognised value, at a path it would otherwise have answered', async () => {
    const { path } = await seedPage('Unrecognised')

    // The control: this exact path answers in both real modes.
    expect((await call(`${path}?_folio=preview`, {}, open)).status).toBe(200)
    expect((await call(`${path}?_folio=draft`, {}, open)).status).toBe(200)

    // Anything else is the host's, which is what keeps "a host's own routes win at
    // any path" true for a name Folio does not know.
    expect(await raw(`${path}?_folio=nope`, {}, open)).toBeNull()
    expect(await raw(`${path}?_folio=DRAFT`, {}, open)).toBeNull()
    expect(await raw(`${path}?_folio=`, {}, open)).toBeNull()
  })

  /**
   * `?as=` names the document being *edited* in the context of this page. A draft
   * render has no editor to swap anything into — no bootstrap to carry the name, no
   * bridge to select in — so accepting it would leave a parameter that parses, is
   * understood, and changes nothing. Refused the way everything in this branch is
   * refused: by handing the request back.
   */
  it('refuses ?as= in draft mode and still honours it in preview mode', async () => {
    await seedGlobal('Contextual tagline')
    const { path } = await seedPage('As host')

    const previewed = await call(`${path}?_folio=preview&as=pmSettingsType`, {}, open)
    expect(previewed.status).toBe(200)

    expect(await raw(`${path}?_folio=draft&as=pmSettingsType`, {}, open)).toBeNull()
  })

  it('keeps ?locale= handling identical in both modes', async () => {
    const { path } = await seedPage('Localeless')
    // No locales configured, so any `?locale=` is undeclared and handed back —
    // the same refusal in both modes, from the same line.
    expect(await raw(`${path}?_folio=preview&locale=fr`, {}, open)).toBeNull()
    expect(await raw(`${path}?_folio=draft&locale=fr`, {}, open)).toBeNull()
  })

  it('hands both modes back for a path with no story behind it', async () => {
    expect(await raw('/nothing-here?_folio=preview', {}, open)).toBeNull()
    expect(await raw('/nothing-here?_folio=draft', {}, open)).toBeNull()
  })
})

/* ------------------------------------------------------------- the gate --- */

/**
 * The acceptance criterion phase 1 could not reach: both URLs are answered to a
 * credential that may read drafts, and handed back to one that may not. The gate
 * is `READ_DRAFT` on the actor `credentialOf` resolves, so a bearer token works
 * here exactly as a session cookie does — which is what makes the URL on
 * `ApiDocumentMeta` worth anything to an agent.
 */
describe('the draft gate applies to both modes', () => {
  it('answers rendered draft HTML to a content:read:draft token', async () => {
    const { path } = await seedPage('Gated draft')
    const headers = await tokenFor('content:read:draft')

    for (const mode of ['preview', 'draft'] as const) {
      const res = await call(`${path}?_folio=${mode}`, { headers })
      expect([mode, res.status]).toEqual([mode, 200])
      // The *draft*: this document has never been published, so a published read
      // could not answer it at all.
      expect(await res.text()).toContain('Gated draft')
    }
  })

  it('hands the request back to the host for a content:read-only token', async () => {
    const { path } = await seedPage('Ungated')
    const headers = await tokenFor('content:read')

    // Null, not 401: the flag then means nothing to that caller and the host serves
    // its own published page, which is both the safe answer and the least
    // surprising one.
    expect(await raw(`${path}?_folio=preview`, { headers })).toBeNull()
    expect(await raw(`${path}?_folio=draft`, { headers })).toBeNull()
  })

  it('hands both modes back with no credential at all', async () => {
    const { path } = await seedPage('Anonymous')
    expect(await raw(`${path}?_folio=preview`)).toBeNull()
    expect(await raw(`${path}?_folio=draft`)).toBeNull()
  })
})
