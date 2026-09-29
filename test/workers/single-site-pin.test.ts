import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { collection, defineBlock, multilink, reference, richtext, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'

/**
 * **A single-site host changes nothing** (`docs/specs/foundation/multi-site.md`,
 * "Nothing changes for a single-site host"): a published page's `Cache-Tag` and
 * its whole `Resolution` are byte-identical to what they were before multi-site
 * existed.
 *
 * Written at the Phase 1 head (`cb51211`), before any of spec 23's phase 2 was
 * built, and never edited since. The expected values below are that head's
 * output, not a description of it: a later phase that adds a key to the
 * resolution, a tag to the header, a bind that reorders a query's rows or a
 * chain filter that drops a row turns this red, and the fix is in the change,
 * not here.
 *
 * Demo-shaped: a page type, a second routed type listed by a collection, a
 * record-free reference and link, a richtext link mark, a breadcrumb ancestor and
 * a global — every read `resolve()` makes on a published render.
 */

const pinPage = defineBlock({
  name: 'pinPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title' }),
    next: multilink({ label: 'Next' }),
    featured: reference({ label: 'Featured', types: ['pinPost'] }),
    posts: collection({ type: 'pinPost', defaultOrder: { field: 'title', dir: 'asc' } }),
    body: richtext({ label: 'Body' }),
  },
  render: () => null,
})

const pinPost = defineBlock({
  name: 'pinPost',
  label: 'Post',
  summary: 'title',
  fields: { title: text({ label: 'Title' }) },
  render: () => null,
})

const pinHeader = defineBlock({
  name: 'pinHeader',
  label: 'Header',
  fields: { tagline: text({ label: 'Tagline' }) },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'pinPage', label: 'Page', kind: 'page', root: 'pinPage', default: true },
  { name: 'pinPost', label: 'Post', kind: 'page', root: 'pinPost' },
  { name: 'pinHeader', label: 'Header', kind: 'singleton', root: 'pinHeader' },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const folio = createFolio<Cloudflare.Env>({
  blocks: [pinPage, pinPost, pinHeader],
  types,
  globals: ['pinHeader'],
  bindings,
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  auth: 'open',
  route: (p) => (p ? `/${p}` : '/'),
})

function rootDoc(type: string, data: Record<string, Json>): Doc {
  return {
    root: 'r0',
    bloks: { r0: { uid: 'r0', type, parent: null, slot: null, order: 'a0', data } },
  }
}

async function publishRow(
  id: string,
  type: string,
  parentId: string | null,
  slug: string,
  path: string | null,
  ord: string,
  title: string,
  doc: Doc,
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at)
     values (?, ?, ?, ?, ?, ?, ?, 1000, ?, 2000)`,
  )
    .bind(id, type, parentId, slug, path, ord, title, JSON.stringify(doc))
    .run()
}

beforeAll(async () => {
  await publishRow(
    'sty_pin_about',
    'pinPage',
    null,
    'pin-about',
    'pin-about',
    'a0',
    'About',
    rootDoc('pinPage', { title: 'About' }),
  )
  await publishRow(
    'sty_pin_post_b',
    'pinPost',
    null,
    'pin-post-b',
    'pin-post-b',
    'a1',
    'Bravo post',
    rootDoc('pinPost', { title: 'Bravo post' }),
  )
  await publishRow(
    'sty_pin_post_a',
    'pinPost',
    null,
    'pin-post-a',
    'pin-post-a',
    'a2',
    'Alpha post',
    rootDoc('pinPost', { title: 'Alpha post' }),
  )
  await publishRow(
    'sng_pinHeader',
    'pinHeader',
    null,
    'pinHeader',
    null,
    'a0',
    'Header',
    rootDoc('pinHeader', { tagline: 'Hello' }),
  )
  await publishRow(
    'sty_pin_team',
    'pinPage',
    'sty_pin_about',
    'team',
    'pin-about/team',
    'a0',
    'Team',
    rootDoc('pinPage', {
      title: 'Team',
      next: { kind: 'story', id: 'sty_pin_post_a' },
      featured: 'sty_pin_post_b',
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'about us',
                marks: [{ type: 'link', attrs: { link: { kind: 'story', id: 'sty_pin_about' } } }],
              },
            ],
          },
        ],
      },
    }),
  )
})

describe('a published page on a single-site deployment', () => {
  it('answers the same Cache-Tag and the same Resolution as before multi-site', async () => {
    const page = await folio
      .reader(env, new Request('https://example.com/pin-about/team'))
      .page('pin-about/team')

    expect(page?.headers).toMatchInlineSnapshot(`
      {
        "cache-control": "public, max-age=0, s-maxage=604800, must-revalidate",
        "cache-tag": "global:pinHeader,site,story:sng_pinHeader,story:sty_pin_about,story:sty_pin_post_a,story:sty_pin_post_b,story:sty_pin_team,type:pinPost",
      }
    `)
    // Key order too, which the structural snapshot below sorts away: a byte is a byte.
    expect(JSON.stringify(page?.resolution)).toMatchInlineSnapshot(
      `"{"stories":{"sty_pin_about":{"id":"sty_pin_about","path":"pin-about","url":"/pin-about","title":"About","type":"pinPage","routable":true},"sty_pin_post_b":{"id":"sty_pin_post_b","path":"pin-post-b","url":"/pin-post-b","title":"Bravo post","type":"pinPost","routable":true},"sty_pin_post_a":{"id":"sty_pin_post_a","path":"pin-post-a","url":"/pin-post-a","title":"Alpha post","type":"pinPost","routable":true},"sng_pinHeader":{"id":"sng_pinHeader","path":"","url":"","title":"Header","type":"pinHeader","routable":false}},"assetBase":"/folio/asset","docs":{"sty_pin_post_b":{"root":"r0","bloks":{"r0":{"uid":"r0","type":"pinPost","parent":null,"slot":null,"order":"a0","data":{"title":"Bravo post"}}}}},"globals":{"pinHeader":{"root":"r0","bloks":{"r0":{"uid":"r0","type":"pinHeader","parent":null,"slot":null,"order":"a0","data":{"tagline":"Hello"}}}}},"collections":{"[[\\"pinPost\\"],null,\\"\\",[],[\\"title\\",\\"asc\\"],1,20,\\"\\"]":{"items":[{"id":"sty_pin_post_a","title":"Alpha post","path":"pin-post-a","url":"/pin-post-a","data":{"title":"Alpha post"}},{"id":"sty_pin_post_b","title":"Bravo post","path":"pin-post-b","url":"/pin-post-b","data":{"title":"Bravo post"}}],"total":2,"page":1,"perPage":20,"pages":1}}}"`,
    )
    expect(JSON.parse(JSON.stringify(page?.resolution))).toMatchInlineSnapshot(`
      {
        "assetBase": "/folio/asset",
        "collections": {
          "[["pinPost"],null,"",[],["title","asc"],1,20,""]": {
            "items": [
              {
                "data": {
                  "title": "Alpha post",
                },
                "id": "sty_pin_post_a",
                "path": "pin-post-a",
                "title": "Alpha post",
                "url": "/pin-post-a",
              },
              {
                "data": {
                  "title": "Bravo post",
                },
                "id": "sty_pin_post_b",
                "path": "pin-post-b",
                "title": "Bravo post",
                "url": "/pin-post-b",
              },
            ],
            "page": 1,
            "pages": 1,
            "perPage": 20,
            "total": 2,
          },
        },
        "docs": {
          "sty_pin_post_b": {
            "bloks": {
              "r0": {
                "data": {
                  "title": "Bravo post",
                },
                "order": "a0",
                "parent": null,
                "slot": null,
                "type": "pinPost",
                "uid": "r0",
              },
            },
            "root": "r0",
          },
        },
        "globals": {
          "pinHeader": {
            "bloks": {
              "r0": {
                "data": {
                  "tagline": "Hello",
                },
                "order": "a0",
                "parent": null,
                "slot": null,
                "type": "pinHeader",
                "uid": "r0",
              },
            },
            "root": "r0",
          },
        },
        "stories": {
          "sng_pinHeader": {
            "id": "sng_pinHeader",
            "path": "",
            "routable": false,
            "title": "Header",
            "type": "pinHeader",
            "url": "",
          },
          "sty_pin_about": {
            "id": "sty_pin_about",
            "path": "pin-about",
            "routable": true,
            "title": "About",
            "type": "pinPage",
            "url": "/pin-about",
          },
          "sty_pin_post_a": {
            "id": "sty_pin_post_a",
            "path": "pin-post-a",
            "routable": true,
            "title": "Alpha post",
            "type": "pinPost",
            "url": "/pin-post-a",
          },
          "sty_pin_post_b": {
            "id": "sty_pin_post_b",
            "path": "pin-post-b",
            "routable": true,
            "title": "Bravo post",
            "type": "pinPost",
            "url": "/pin-post-b",
          },
        },
      }
    `)
  })
})
