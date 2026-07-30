import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'

/**
 * The mounted app's composition, as opposed to any one route's behaviour: what
 * `handle()` claims, and what the bindings middleware costs.
 *
 * These build their own `createFolio` instead of going through `SELF` (see
 * worker.ts) because the thing under test is the *config* boundary — a host's
 * `bindings` accessor is its own function, and the only way to observe when
 * Folio calls it is to own it.
 */
const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title', required: true }) },
  render: () => null,
})

const ORIGIN = 'https://example.com'

function folioWith(bindings: (env: Cloudflare.Env) => FolioBindings) {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    root: 'page',
    bindings,
    basePath: '/folio',
    auth: 'open',
  })
}

const folio = () => folioWith(real)

const real = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

function get(folio: ReturnType<typeof folioWith>, path: string, init?: RequestInit) {
  return folio.handle(new Request(`${ORIGIN}${path}`, init), env, createExecutionContext())
}

beforeAll(async () => {
  await env.DB.prepare(
    `insert into stories (id, parent_id, slug, path, ord, title) values (?, ?, ?, ?, ?, ?)`,
  )
    .bind('sty_appmw01', null, '', '', 'a0', 'Home')
    .run()
})

describe('the bindings middleware', () => {
  /**
   * The routes that answer from the config alone must not acquire a dependency
   * on the host's environment just because a middleware runs ahead of them. A
   * `bindings` that throws is the sharpest way to say it: if Folio calls it, the
   * envelope turns into a 500 and the test fails on the status alone.
   */
  it('is never invoked by a route that answers from the config alone', async () => {
    let calls = 0
    const folio = folioWith(() => {
      calls++
      throw new Error('the host accessor must not run for this route')
    })

    // A pure derived manifest, with a shape worth confirming came back whole.
    const schema = await get(folio, '/folio/schema')
    expect(schema?.status).toBe(200)
    expect((await schema?.json<{ root: string }>())?.root).toBe('page')

    const cases: [string, RequestInit | undefined, number][] = [
      // Nothing is mounted at the bare base, or at an unknown path under it.
      ['/folio', undefined, 404],
      ['/folio/not-a-route', undefined, 404],
      // The socket route refuses a request that is not an upgrade before it
      // looks at anything else, and the editor page rejects an id that cannot
      // name a story without a lookup — see routes/editor.ts. 'bad id' is
      // malformed in the sense `isId` means: a space is not in the id charset,
      // where a hyphen is (so 'not-an-id' would be looked up, and 404 for the
      // ordinary reason).
      ['/folio/story/sty_appmw01/socket', undefined, 426],
      ['/folio/edit/bad%20id', undefined, 404],
    ]

    for (const [path, init, status] of cases) {
      const res = await get(folio, path, init)
      expect([path, res?.status]).toEqual([path, status])
    }

    expect(calls).toBe(0)
  })

  it('is invoked exactly once for a request that does need the bindings', async () => {
    let calls = 0
    const folio = folioWith((e) => {
      calls++
      return real(e)
    })

    expect((await get(folio, '/folio/stories'))?.status).toBe(200)
    expect(calls).toBe(1)

    // `loadStory` and the handler behind it both ask, and the runtime asks again
    // for the Durable Object stub: one memoised call for the request, not three.
    calls = 0
    expect((await get(folio, '/folio/story/sty_appmw01/document'))?.status).toBe(200)
    expect(calls).toBe(1)
  })
})

describe('handle() and host fallthrough', () => {
  it('returns null for a path Folio does not own, without touching the bindings', async () => {
    let calls = 0
    const folio = folioWith((e) => {
      calls++
      return real(e)
    })

    // Load-bearing: the host's own routes win, and a null is how they get the
    // chance. A path that merely starts with the base *string* is not under it.
    expect(await get(folio, '/')).toBeNull()
    expect(await get(folio, '/folio-ish/page')).toBeNull()
    expect(calls).toBe(0)

    // The preview flag is the one non-`basePath` path Folio answers, and it has
    // to read D1 to find out whether the path names a story at all.
    expect(await get(folio, '/nothing-here?_folio=preview')).toBeNull()
    expect(calls).toBe(1)
  })
})

/**
 * `../../../docs/specs/platform/caching.md` decision 7. The same URL returns
 * draft HTML to an editor and published HTML to a visitor, decided by the
 * session cookie — and a `Cookie` header neither bypasses Workers Cache nor
 * forms part of its key, so the two would collide on one entry, in the direction
 * that serves an unpublished draft to the public.
 */
describe('the pages Folio serves itself are never cached', () => {
  it('a preview response says no-store and carries no Cache-Tag', async () => {
    const res = await get(folio(), '/?_folio=preview')
    expect(res?.status).toBe(200)
    expect(res?.headers.get('cache-control')).toBe('private, no-store')
    expect(res?.headers.get('cache-tag')).toBeNull()
  })

  it('so does the editor shell', async () => {
    const res = await get(folio(), '/folio/edit/sty_appmw01')
    expect(res?.status).toBe(200)
    expect(res?.headers.get('cache-control')).toBe('private, no-store')
  })
})
