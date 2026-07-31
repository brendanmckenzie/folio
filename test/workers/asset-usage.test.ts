import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  asset,
  defineBlock,
  defineRecord,
  multiasset,
  multilink,
  richtext,
  text,
} from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'

/**
 * Asset usage: `docs/ui-architecture.md` dependency 4, against real D1 and the
 * real migrations.
 *
 * What is being pinned is the whole reason `content_refs` was widened rather than
 * twinned by an `asset_refs` table (`migrations/0002_asset_refs.sql`): asset edges
 * ride the machine that already exists, so they are written inside the publish
 * batch, dropped on an unpublish, and dropped in both directions on a delete —
 * without a second implementation of any of the three.
 *
 * Own `createFolio` rather than the shared `worker.ts` fixture, whose schema has no
 * asset field, and per the trap `publish-hooks.md` recorded about carrying arrays
 * back over the pool's RPC boundary. Ids are prefixed `au_` because D1 state is
 * isolated per *file*, not per test.
 */

/* --------------------------------------------------------------- schema --- */

/**
 * All four shapes that can reach an asset, on one root block: the two asset field
 * kinds, plus a `multilink` and a `richtext` — either of which can hold
 * `{ kind: 'asset', asset }`, which is how a download button and a PDF link inside
 * prose are stored.
 */
const pageRoot = defineBlock({
  name: 'auPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text(),
    hero: asset({ translatable: true }),
    gallery: multiasset(),
    download: multilink(),
    body: richtext(),
  },
  render: () => null,
})

/** A record using an asset, so the usage list has an unrouted row to sort last. */
const personRecord = defineRecord({
  name: 'auPerson',
  label: 'Person',
  summary: 'fullName',
  fields: { fullName: text({ indexed: true }), portrait: asset() },
})

const types: DocumentType[] = [
  { name: 'auPageType', label: 'Page', kind: 'page', root: 'auPage', default: true },
  {
    name: 'auPersonType',
    label: 'Person',
    kind: 'record',
    root: 'auPerson',
    titleField: 'fullName',
  },
]

const folio = createFolio<Cloudflare.Env>({
  blocks: [pageRoot, personRecord],
  types,
  bindings: (e: Cloudflare.Env): FolioBindings => ({
    db: e.DB,
    story: e.STORY,
    media: e.MEDIA,
    images: e.IMAGES,
  }),
  basePath: '/folio',
  auth: 'open',
  route: (p) => (p ? `/${p}` : '/'),
})

const ORIGIN = 'https://example.com'
const get = (path: string) =>
  folio.handle(new Request(`${ORIGIN}${path}`), env, createExecutionContext())
const send = (path: string, method: string) =>
  folio.handle(new Request(`${ORIGIN}${path}`, { method }), env, createExecutionContext())

/* ------------------------------------------------------------- fixtures --- */

/** The three assets, by id and by key. The **key** is what a document stores and
 * therefore what an edge holds; the id is what a URL names. */
const HERO = { id: 'ast_au0000000001', key: 'ast_au0000000001-hero.png' }
const DECK = { id: 'ast_au0000000002', key: 'ast_au0000000002-deck.pdf' }
const UNUSED = { id: 'ast_au0000000003', key: 'ast_au0000000003-spare.png' }

const insertAsset = (row: { id: string; key: string }) =>
  env.DB.prepare(
    `insert into assets (id, key, filename, content_type, size, alt, created_at)
     values (?, ?, ?, 'image/png', 9, '', ?)`,
  )
    .bind(row.id, row.key, row.key.split('-').slice(1).join('-'), Date.now())
    .run()

/** An `AssetValue` as a field stores one. */
const value = (row: { key: string }): Json =>
  ({
    key: row.key,
    filename: row.key.split('-').slice(1).join('-'),
    contentType: 'image/png',
    size: 9,
    alt: '',
  }) as Json

function one(uid: string, type: string, data: Record<string, Json>): Doc {
  return { root: uid, bloks: { [uid]: { uid, type, parent: null, slot: null, order: 'a0', data } } }
}

/**
 * A published row inserted directly, then reindexed — which is exactly how an
 * existing site's `content_refs` comes to exist at all, and the shortest path to a
 * published document with a chosen shape.
 */
async function insertRow(
  id: string,
  opts: { type: string; path: string | null; title: string; doc: Doc },
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at)
     values (?, ?, null, ?, ?, 'a0', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.type,
      opts.path === null ? id : (opts.path.split('/').pop() ?? ''),
      opts.path,
      opts.title,
      Date.now(),
      JSON.stringify(opts.doc),
      Date.now(),
    )
    .run()
}

const refsOf = async (target: string): Promise<{ from: string; kind: string }[]> =>
  (
    await env.DB.prepare(
      'select from_story as "from", kind from content_refs where to_id = ? order by "from"',
    )
      .bind(target)
      .all<{ from: string; kind: string }>()
  ).results

interface UsagePayload {
  published: { id: string; title: string; path: string | null; url: string }[]
  total: number
}

const usageOf = async (id: string) =>
  (await (await get(`/folio/api/assets/${id}/usage`))!.json()) as UsagePayload

beforeAll(async () => {
  for (const row of [HERO, DECK, UNUSED]) await insertAsset(row)

  // The hero image reached four different ways across three documents, plus a
  // second asset reached only through a richtext link mark.
  await insertRow('au_home', {
    type: 'auPageType',
    path: 'auhome',
    title: 'Home',
    doc: one('h', 'auPage', { title: 'Home', hero: value(HERO) }),
  })
  await insertRow('au_gallery', {
    type: 'auPageType',
    path: 'augallery',
    title: 'Gallery',
    doc: one('g', 'auPage', { title: 'Gallery', gallery: [value(HERO)] }),
  })
  await insertRow('au_ada', {
    type: 'auPersonType',
    path: null,
    title: 'Ada Lovelace',
    doc: one('a', 'auPerson', { fullName: 'Ada Lovelace', portrait: value(HERO) }),
  })
  await insertRow('au_prose', {
    type: 'auPageType',
    path: 'auprose',
    title: 'Prose',
    doc: one('p', 'auPage', {
      title: 'Prose',
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'the deck',
                marks: [{ type: 'link', attrs: { link: { kind: 'asset', asset: value(DECK) } } }],
              },
            ],
          },
        ],
      } as unknown as Json,
    }),
  })

  await folio.reindex(env, { batch: 200 })
})

describe('what a publish writes', () => {
  it('records an asset edge keyed on the R2 key, one row per document', async () => {
    expect(await refsOf(HERO.key)).toEqual([
      { from: 'au_ada', kind: 'asset' },
      { from: 'au_gallery', kind: 'asset' },
      { from: 'au_home', kind: 'asset' },
    ])
  })

  it('records an asset reachable only from a richtext link mark', async () => {
    // The same class of bug `linkedIds` exists for, one namespace over: a link mark
    // carries no href and no field of its own, so a walk over `asset()` and
    // `multiasset()` alone would report this PDF as unused while a live page links
    // to it.
    expect(await refsOf(DECK.key)).toEqual([{ from: 'au_prose', kind: 'asset' }])
  })

  it('writes nothing for an asset nobody uses', async () => {
    expect(await refsOf(UNUSED.key)).toEqual([])
  })

  it('does not put a key in `to_id` under a story kind', async () => {
    // The column is kind-neutral; the *kinds* are not. Nothing should be able to
    // read an asset key as a story link.
    const rows = await env.DB.prepare(
      "select count(*) as n from content_refs where kind in ('link', 'reference') and to_id like 'ast_%'",
    ).first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })
})

describe('GET /api/assets/:id/usage', () => {
  it('names every published document, routed first and then unrouted', async () => {
    const usage = await usageOf(HERO.id)
    expect(usage.total).toBe(3)
    expect(usage.published.map((r) => r.id)).toEqual(['au_gallery', 'au_home', 'au_ada'])
  })

  it('carries the host’s URL for a routed document and an empty one for a record', async () => {
    const usage = await usageOf(HERO.id)
    const byId = new Map(usage.published.map((r) => [r.id, r]))
    expect(byId.get('au_home')).toMatchObject({ title: 'Home', path: 'auhome', url: '/auhome' })
    // A record has no URL to offer, and `''` rather than a missing key is what the
    // document usage route answers too.
    expect(byId.get('au_ada')).toMatchObject({ title: 'Ada Lovelace', path: null, url: '' })
  })

  it('answers zero for an asset nobody uses, rather than 404ing', async () => {
    expect(await usageOf(UNUSED.id)).toEqual({ published: [], total: 0 })
  })

  it('404s an unknown asset id', async () => {
    const res = (await get('/folio/api/assets/ast_000000000000/usage'))!
    expect(res.status).toBe(404)
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('not_found')
  })

  it('counts published usage only: unpublishing a page stops it counting', async () => {
    // Free, and the reason the widening was worth it: asset edges are outbound rows,
    // so `clearIndexStatements` drops them on an unpublish with no code of their own.
    // "Used by N **published** documents" is the claim the panel makes.
    expect((await send('/folio/api/story/au_gallery/unpublish', 'POST'))!.status).toBe(200)

    const usage = await usageOf(HERO.id)
    expect(usage.total).toBe(2)
    expect(usage.published.map((r) => r.id)).toEqual(['au_home', 'au_ada'])
  })
})

describe('deleting an asset', () => {
  it('proceeds despite the usage, and prunes the edges naming it', async () => {
    // Warn and proceed, the same call the delete of a referenced record makes: the
    // usage route informs the confirmation and does not gate it.
    const before = await usageOf(DECK.id)
    expect(before.total).toBe(1)

    const res = (await send(`/folio/api/assets/${DECK.id}`, 'DELETE'))!
    expect(res.status).toBe(200)

    // The library row is gone...
    const row = await env.DB.prepare('select count(*) as n from assets where id = ?')
      .bind(DECK.id)
      .first<{ n: number }>()
    expect(row?.n).toBe(0)

    // ...and so is the edge that named it. Left behind it would only ever be
    // rewritten when `au_prose` was next published, so a site that never
    // republishes would accumulate usage rows for files that no longer exist.
    expect(await refsOf(DECK.key)).toEqual([])

    // The referring document is untouched, which is the deliberate half: rewriting
    // another story's draft from the media library would bypass the mutation log,
    // and a missing file is easier to spot and fix than a silent edit nobody saw.
    const story = await env.DB.prepare('select published_doc as doc from stories where id = ?')
      .bind('au_prose')
      .first<{ doc: string }>()
    expect(story?.doc).toContain(DECK.key)
  })

  it('leaves another asset’s edges alone', async () => {
    expect((await refsOf(HERO.key)).length).toBeGreaterThan(0)
  })
})
