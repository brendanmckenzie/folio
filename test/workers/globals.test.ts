import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { Doc } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'

/**
 * Globals (`../../../docs/specs/content-model/globals.md`): a singleton
 * loaded into every page's `Resolution`, rendered by the host's own shell and
 * previewable in the context of a real page.
 *
 * Each test builds its own `createFolio` with a document type name of its own
 * (`gq*`), the same reason `app.test.ts` does — the config boundary is what
 * is under test — and because Durable Object and D1 state in this project is
 * isolated per *file*, not per test: two tests sharing a singleton's type name
 * would share its row and its object too.
 */

const ORIGIN = 'https://example.com'

const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title', required: true }) },
  render: () => null,
})

const headerRoot = defineBlock({
  name: 'headerRoot',
  label: 'Header',
  fields: { tagline: text({ label: 'Tagline' }) },
  render: () => null,
})

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

function makeFolio(types: DocumentType[], globals: string[]) {
  return createFolio<Cloudflare.Env>({
    blocks: [page, headerRoot],
    types,
    globals,
    bindings,
    basePath: '/folio',
    auth: 'open',
    route: (p) => (p ? `/${p}` : '/'),
  })
}

function get(folio: ReturnType<typeof makeFolio>, path: string) {
  return folio.handle(new Request(`${ORIGIN}${path}`), env, createExecutionContext())
}

async function insertPage(id: string, path: string, title: string) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at)
     values (?, 'page', null, ?, ?, 'a0', ?, ?)`,
  )
    .bind(id, path, path, title, Date.now())
    .run()
}

function pageDoc(title = 'Hi'): Doc {
  return {
    root: 'root0000',
    bloks: {
      root0000: {
        uid: 'root0000',
        type: 'page',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title },
      },
    },
  }
}

/** Counts every `db.prepare()` call, so "one query for stories, one more only
 * when there is something to fetch" is pinned rather than assumed. */
function countedDb(real: D1Database): { db: D1Database; count: () => number } {
  let n = 0
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'prepare') {
        return (...args: unknown[]) => {
          n++
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return value
    },
  })
  return { db: proxy as D1Database, count: () => n }
}

const pageType: DocumentType = { name: 'page', label: 'Page', kind: 'page', root: 'page' }

describe('resolve(): query count', () => {
  it('costs one query for the story map, one more only when there is a global to fetch', async () => {
    const withGlobal = makeFolio(
      [pageType, { name: 'gqwith', label: 'Header', kind: 'singleton', root: 'headerRoot' }],
      ['gqwith'],
    )
    await insertPage('sty_gqwith', 'gqwith', 'Query Count With')

    const { db, count } = countedDb(env.DB)
    await withGlobal.resolve({ ...env, DB: db } as Cloudflare.Env, pageDoc())
    expect(count()).toBe(2)
  })

  it('stays at one query when nothing is configured as a global', async () => {
    const withoutGlobal = makeFolio(
      [pageType, { name: 'gqwithout', label: 'Header', kind: 'singleton', root: 'headerRoot' }],
      [],
    )
    await insertPage('sty_gqwithout', 'gqwithout', 'Query Count Without')

    const { db, count } = countedDb(env.DB)
    await withoutGlobal.resolve({ ...env, DB: db } as Cloudflare.Env, pageDoc())
    expect(count()).toBe(1)
  })
})

describe('resolve(): published vs draft', () => {
  it('preview reads the draft; a live resolve reads only what was published', async () => {
    const name = 'gqdraft'
    const folio = makeFolio(
      [pageType, { name, label: 'Header', kind: 'singleton', root: 'headerRoot' }],
      [name],
    )
    await insertPage('sty_gqdraftpage', 'gqdraftpage', 'Draft Vs Published')

    const stub = env.STORY.get(env.STORY.idFromName(`sng_${name}`))
    const draft: Doc = {
      root: 'hdr00001',
      bloks: {
        hdr00001: {
          uid: 'hdr00001',
          type: 'headerRoot',
          parent: null,
          slot: null,
          order: 'a0',
          data: { tagline: 'DRAFT TAGLINE' },
        },
      },
    }
    await runInDurableObject(stub, (instance) => instance.getOrInit(draft))

    const preview = await get(folio, '/gqdraftpage?_folio=preview')
    expect(await preview?.text()).toContain('DRAFT TAGLINE')

    // Nothing published yet: a live resolve has nothing to show for it.
    const beforePublish = await folio.resolve(env, pageDoc())
    expect(beforePublish.globals?.[name]).toBeUndefined()
    expect(folio.renderGlobal(beforePublish, name)).toBeNull()

    // Publish the header directly in D1 — the workflow itself is
    // publish.ts's concern, not this one.
    const published: Doc = {
      root: 'hdr00001',
      bloks: {
        hdr00001: {
          uid: 'hdr00001',
          type: 'headerRoot',
          parent: null,
          slot: null,
          order: 'a0',
          data: { tagline: 'PUBLISHED TAGLINE' },
        },
      },
    }
    await env.DB.prepare(`update stories set published_doc = ?, published_at = ? where id = ?`)
      .bind(JSON.stringify(published), Date.now(), `sng_${name}`)
      .run()

    const afterPublish = await folio.resolve(env, pageDoc())
    expect(afterPublish.globals?.[name]?.bloks.hdr00001?.data.tagline).toBe('PUBLISHED TAGLINE')

    // The draft the editor is mid-typing never leaks into a live resolve.
    expect(afterPublish.globals?.[name]?.bloks.hdr00001?.data.tagline).not.toBe('DRAFT TAGLINE')
  })
})

describe('?_folio=preview&as=', () => {
  it('refuses an unknown name, a non-global singleton and a non-singleton type, the same way as no story', async () => {
    const name = 'gqasHeader'
    const other = 'gqasOther'
    const folio = makeFolio(
      [
        pageType,
        { name, label: 'Header', kind: 'singleton', root: 'headerRoot', previewPath: '' },
        { name: other, label: 'Other', kind: 'singleton', root: 'headerRoot' },
      ],
      [name],
    )
    await insertPage('sty_gqasroot', '', 'Root')

    expect(await get(folio, '/?_folio=preview&as=nope')).toBeNull()
    expect(await get(folio, `/?_folio=preview&as=${other}`)).toBeNull()
    expect(await get(folio, '/?_folio=preview&as=page')).toBeNull()

    const ok = await get(folio, `/?_folio=preview&as=${name}`)
    expect(ok?.status).toBe(200)
    const html = await ok?.text()
    expect(html).toContain('"editing"')
    expect(html).toContain(`"global":"${name}"`)
    expect(html).toContain(`data-folio-global="${name}"`)
  })
})

describe('the bare preview route', () => {
  it('renders a singleton with no previewPath on its own, with a note', async () => {
    const name = 'gqbare'
    const folio = makeFolio(
      [pageType, { name, label: 'Header', kind: 'singleton', root: 'headerRoot' }],
      [name],
    )

    const res = await get(folio, `/folio/preview/global/${name}`)
    expect(res?.status).toBe(200)
    expect(await res?.text()).toContain('No host page is configured')
  })

  it('404s for an unknown name or a non-singleton type', async () => {
    const folio = makeFolio([pageType], [])
    expect((await get(folio, '/folio/preview/global/nope'))?.status).toBe(404)
    expect((await get(folio, '/folio/preview/global/page'))?.status).toBe(404)
  })
})

describe('folio.global', () => {
  it('reads a singleton by name whether or not it is a configured global', async () => {
    const configured = 'gqglobalA'
    const unconfigured = 'gqglobalB'
    const folio = makeFolio(
      [
        pageType,
        { name: configured, label: 'A', kind: 'singleton', root: 'headerRoot' },
        { name: unconfigured, label: 'B', kind: 'singleton', root: 'headerRoot' },
      ],
      [configured],
    )
    const doc: Doc = {
      root: 'hdr00002',
      bloks: {
        hdr00002: {
          uid: 'hdr00002',
          type: 'headerRoot',
          parent: null,
          slot: null,
          order: 'a0',
          data: { tagline: 'B content' },
        },
      },
    }
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, published_doc, published_at)
       values (?, ?, null, ?, null, 'a0', ?, ?, ?, ?)`,
    )
      .bind(
        `sng_${unconfigured}`,
        unconfigured,
        unconfigured,
        'B',
        Date.now(),
        JSON.stringify(doc),
        Date.now(),
      )
      .run()

    expect(await folio.global(env, unconfigured)).toEqual(doc)
    expect(await folio.global(env, configured)).toBeNull() // never published
    expect(await folio.global(env, 'nope')).toBeNull()
    expect(await folio.global(env, 'page')).toBeNull() // a page, not a singleton
  })
})

describe('construction: validateGlobals', () => {
  it('throws naming a global with no such document type', () => {
    expect(() => makeFolio([pageType], ['nope'])).toThrow(/unknown document type 'nope'/)
  })

  it('throws when a global names a type that is not a singleton', () => {
    expect(() => makeFolio([pageType], ['page'])).toThrow(/not 'singleton'/)
  })
})
