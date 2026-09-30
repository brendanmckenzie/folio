import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { collection, defineBlock, multilink, reference, richtext, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio, magicLink } from '../../src/server'
import type { FolioBindings } from '../../src/server'

/**
 * **A single-brand multi-site host changes nothing** (`docs/specs/foundation/multi-brand.md`,
 * "Nothing changes for a single-brand host"): on a deployment with `sites` and no
 * `brands`, the manifest, a published page's `Cache-Tag` and its whole `Resolution`
 * are byte-identical to what they were before brands existed.
 *
 * Written at the spec 34 phase 2 head (`b27eee6`), before any of phase 3 was built,
 * and never edited since — the multi-site sibling of `single-site-pin.test.ts`. The
 * expected values below are that head's output, not a description of it: a later
 * phase that drops `shared` from a chain it should not, adds a key to the manifest
 * or the resolution, or moves a tag turns this red, and the fix is in the change,
 * not here.
 *
 * Two sites and a group: `alpha` (in `north`, live, `alpha.example`) and `bravo`
 * (live, `bravo.example`). The page rendered is alpha's, and reads up its whole
 * chain — alpha, north and shared — through a reference, a link, a richtext link
 * mark, a collection, a breadcrumb ancestor and a layered global and settings type,
 * while bravo's rows sit beside it and must not appear.
 */

const pinPage = defineBlock({
  name: 'mspPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title' }),
    next: multilink({ label: 'Next' }),
    featured: reference({ label: 'Featured', types: ['mspPost'] }),
    posts: collection({ type: 'mspPost', defaultOrder: { field: 'title', dir: 'asc' } }),
    body: richtext({ label: 'Body' }),
  },
  render: () => null,
})

const pinPost = defineBlock({
  name: 'mspPost',
  label: 'Post',
  summary: 'title',
  fields: { title: text({ label: 'Title' }) },
  render: () => null,
})

const pinHeader = defineBlock({
  name: 'mspHeader',
  label: 'Header',
  fields: { tagline: text({ label: 'Tagline' }), strap: text({ label: 'Strap' }) },
  render: () => null,
})

const pinSettings = defineBlock({
  name: 'mspSettings',
  label: 'Settings',
  fields: { brandColour: text({ label: 'Colour' }) },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'mspPage', label: 'Page', kind: 'page', root: 'mspPage', default: true },
  { name: 'mspPost', label: 'Post', kind: 'page', root: 'mspPost' },
  { name: 'mspHeader', label: 'Header', kind: 'singleton', root: 'mspHeader' },
  { name: 'mspSettings', label: 'Settings', kind: 'singleton', root: 'mspSettings' },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const ADMIN = 'https://cms.example'

const folio = createFolio<Cloudflare.Env>({
  blocks: [pinPage, pinPost, pinHeader, pinSettings],
  types,
  globals: ['mspHeader'],
  bindings,
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
  sites: { admin: ADMIN, settings: 'mspSettings' },
})

function rootDoc(type: string, data: Record<string, Json>): Doc {
  return {
    root: 'r0',
    bloks: { r0: { uid: 'r0', type, parent: null, slot: null, order: 'a0', data } },
  }
}

async function publishRow(
  id: string,
  site: string,
  type: string,
  parentId: string | null,
  slug: string,
  path: string | null,
  ord: string,
  title: string,
  doc: Doc,
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, ?, ?, ?, ?, ?, ?, 1000, ?, ?, 2000)`,
  )
    .bind(id, type, parentId, slug, path, ord, title, site, JSON.stringify(doc))
    .run()
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', 'https://preview.alpha.example', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', null, 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('alpha.example', 'alpha'), ('bravo.example', 'bravo')`,
    ),
  ])
  // The breadcrumb ancestor, owned by the group.
  await publishRow(
    'sty_msp_about',
    'north',
    'mspPage',
    null,
    'about',
    'about',
    'a0',
    'About',
    rootDoc('mspPage', { title: 'About' }),
  )
  // Posts at three scopes: alpha's own, the shared catalogue's, and bravo's, which
  // alpha's collection must not list.
  await publishRow(
    'sty_msp_post_b',
    'alpha',
    'mspPost',
    null,
    'post-b',
    'post-b',
    'a1',
    'Bravo post',
    rootDoc('mspPost', { title: 'Bravo post' }),
  )
  await publishRow(
    'sty_msp_post_a',
    'shared',
    'mspPost',
    null,
    'post-a',
    'post-a',
    'a2',
    'Alpha post',
    rootDoc('mspPost', { title: 'Alpha post' }),
  )
  await publishRow(
    'sty_msp_post_x',
    'bravo',
    'mspPost',
    null,
    'post-x',
    'post-x',
    'a3',
    'Another site',
    rootDoc('mspPost', { title: 'Another site' }),
  )
  // The global, layered: shared holds both fields, alpha overrides one.
  await publishRow(
    'sng_mspHeader:shared',
    'shared',
    'mspHeader',
    null,
    'mspHeader',
    null,
    'a0',
    'Header',
    rootDoc('mspHeader', { tagline: 'Hello', strap: 'Everywhere' }),
  )
  await publishRow(
    'sng_mspHeader:alpha',
    'alpha',
    'mspHeader',
    null,
    'mspHeader',
    null,
    'a0',
    'Header',
    rootDoc('mspHeader', { tagline: 'Hello alpha' }),
  )
  await publishRow(
    'sng_mspSettings:north',
    'north',
    'mspSettings',
    null,
    'mspSettings',
    null,
    'a0',
    'Settings',
    rootDoc('mspSettings', { brandColour: 'teal' }),
  )
  await publishRow(
    'sty_msp_team',
    'alpha',
    'mspPage',
    'sty_msp_about',
    'team',
    'about/team',
    'a0',
    'Team',
    rootDoc('mspPage', {
      title: 'Team',
      next: { kind: 'story', id: 'sty_msp_post_a' },
      featured: 'sty_msp_post_b',
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'about us',
                marks: [{ type: 'link', attrs: { link: { kind: 'story', id: 'sty_msp_about' } } }],
              },
            ],
          },
        ],
      },
    }),
  )
})

const call = (url: string) =>
  folio.handle(new Request(url), env, createExecutionContext()) as Promise<Response>

describe('a single-brand multi-site deployment', () => {
  it('answers the same manifest, bare and scoped, as before brands', async () => {
    const bare = await call(`${ADMIN}/folio/api/schema`)
    const scoped = await call(`${ADMIN}/folio/~alpha/api/schema`)
    expect(bare.status).toBe(200)
    expect(scoped.status).toBe(200)
    const text = await bare.text()
    expect(await scoped.text()).toBe(text)
    expect(text).toMatchInlineSnapshot(
      `"{"types":[{"name":"mspPage","label":"Page","kind":"page","root":"mspPage","default":true},{"name":"mspPost","label":"Post","kind":"page","root":"mspPost"},{"name":"mspHeader","label":"Header","kind":"singleton","root":"mspHeader"},{"name":"mspSettings","label":"Settings","kind":"singleton","root":"mspSettings"}],"blocks":[{"name":"mspPage","label":"Page","summary":"title","fields":{"title":{"kind":"text","label":"Title"},"next":{"kind":"multilink","label":"Next"},"featured":{"kind":"reference","label":"Featured","types":["mspPost"]},"posts":{"kind":"collection","type":"mspPost","defaultOrder":{"field":"title","dir":"asc"}},"body":{"kind":"richtext","label":"Body"}}},{"name":"mspPost","label":"Post","summary":"title","fields":{"title":{"kind":"text","label":"Title"}}},{"name":"mspHeader","label":"Header","fields":{"tagline":{"kind":"text","label":"Tagline"},"strap":{"kind":"text","label":"Strap"}}},{"name":"mspSettings","label":"Settings","fields":{"brandColour":{"kind":"text","label":"Colour"}}}],"root":"mspPage","globals":["mspHeader"]}"`,
    )
  })

  it('answers the same Cache-Tag and the same Resolution for a published page', async () => {
    const page = await folio
      .reader(env, new Request('https://alpha.example/about/team'))
      .page('about/team')

    expect(page?.headers).toMatchInlineSnapshot(`
      {
        "cache-control": "public, max-age=0, s-maxage=604800, must-revalidate",
        "cache-tag": "global:mspHeader,global:mspHeader@alpha,global:mspHeader@north,global:mspSettings,global:mspSettings@alpha,global:mspSettings@north,path:alpha:about%2Fteam,site:alpha,story:sng_mspHeader%3Aalpha,story:sng_mspHeader%3Ashared,story:sng_mspSettings%3Anorth,story:sty_msp_about,story:sty_msp_post_a,story:sty_msp_post_b,story:sty_msp_team,type:mspPost@alpha,type:mspPost@north,type:mspPost@shared",
      }
    `)
    // Key order too: a byte is a byte.
    expect(JSON.stringify(page?.resolution)).toMatchInlineSnapshot(
      `"{"stories":{"sty_msp_about":{"id":"sty_msp_about","path":"about","url":"https://alpha.example/about","title":"About","type":"mspPage","routable":true},"sty_msp_post_b":{"id":"sty_msp_post_b","path":"post-b","url":"https://alpha.example/post-b","title":"Bravo post","type":"mspPost","routable":true},"sty_msp_post_a":{"id":"sty_msp_post_a","path":"post-a","url":"https://alpha.example/post-a","title":"Alpha post","type":"mspPost","routable":true},"sng_mspHeader:shared":{"id":"sng_mspHeader:shared","path":"","url":"","title":"Header","type":"mspHeader","routable":false},"sng_mspHeader:alpha":{"id":"sng_mspHeader:alpha","path":"","url":"","title":"Header","type":"mspHeader","routable":false},"sng_mspSettings:north":{"id":"sng_mspSettings:north","path":"","url":"","title":"Settings","type":"mspSettings","routable":false}},"assetBase":"/folio/asset","docs":{"sty_msp_post_b":{"root":"r0","bloks":{"r0":{"uid":"r0","type":"mspPost","parent":null,"slot":null,"order":"a0","data":{"title":"Bravo post"}}}}},"globals":{"mspHeader":{"root":"r0","bloks":{"r0":{"uid":"r0","type":"mspHeader","parent":null,"slot":null,"order":"a0","data":{"tagline":"Hello alpha","strap":"Everywhere"}}}},"mspSettings":{"root":"r0","bloks":{"r0":{"uid":"r0","type":"mspSettings","parent":null,"slot":null,"order":"a0","data":{"brandColour":"teal"}}}}},"site":{"id":"alpha","name":"Alpha","group":"north","status":"live","surface":"live","chain":["alpha","north","shared"],"layered":["mspHeader","mspSettings"]},"path":"about/team","collections":{"[[\\"mspPost\\"],null,\\"\\",[],[\\"title\\",\\"asc\\"],1,20,\\"\\"]":{"items":[{"id":"sty_msp_post_a","title":"Alpha post","path":"post-a","url":"https://alpha.example/post-a","data":{"title":"Alpha post"}},{"id":"sty_msp_post_b","title":"Bravo post","path":"post-b","url":"https://alpha.example/post-b","data":{"title":"Bravo post"}}],"total":2,"page":1,"perPage":20,"pages":1}}}"`,
    )
  })
})
