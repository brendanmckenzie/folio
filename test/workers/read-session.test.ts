import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { defineBlock, reference, text } from '../../src/core'
import type { Doc } from '../../src/core/doc'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'

/**
 * Read replication (`src/server/db.ts`): every read this library makes has to
 * run on a D1 *session*, or it is served by the primary wherever in the world
 * that is, and none of it is observable from a test that only watches the
 * binding.
 *
 * These are latency properties, and none of them can be measured here —
 * miniflare has one database, in-process, with no replicas and no network. So
 * each one is pinned as the *shape* that produces it: which object the query was
 * issued on, how many sessions a render opened, and whether two independent
 * queries were sent together or one after the other. Every one of them is
 * invisible in a passing test suite and trivially undone by an `await` in the
 * wrong place, which is the whole reason they are written down.
 */

const ORIGIN = 'https://example.com'

const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true }),
    // Something for `resolve` to pull in, so its second pass has work to do.
    related: reference({ label: 'Related', types: ['page'] }),
  },
  render: () => null,
})

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

function makeFolio(db?: D1Database) {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    types: [{ name: 'page', label: 'Page', kind: 'page', root: 'page' }],
    bindings: (e) => ({ ...bindings(e), ...(db ? { db } : {}) }),
    basePath: '/folio',
    assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
    auth: 'open',
    route: (p) => (p ? `/${p}` : '/'),
  })
}

/** What a spy saw, in the order it saw it. */
interface Spy {
  db: D1Database
  /** One entry per `withSession()`. */
  sessions: number
  /** One entry per `prepare()`, wherever it was issued. */
  prepares: number
  /** One entry per `batch()`. */
  batches: number
  /** `prepare` issued straight on the binding rather than on a session. */
  unsessioned: number
  /** `'send'` when a query left, `'recv'` when its answer came back. */
  order: string[]
}

/**
 * Wraps the binding so a test can see which object each query was issued on and
 * whether two of them overlapped.
 *
 * `withSession` has to be followed — a proxy that wraps only `prepare` on the
 * binding observes nothing at all once the reads move onto a session, and every
 * count silently reads zero.
 */
function spyOn(real: D1Database): Spy {
  const spy: Spy = { db: real, sessions: 0, prepares: 0, batches: 0, unsessioned: 0, order: [] }

  const watchStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver)
        // `bind` answers a *new* statement, so a proxy that does not follow it
        // watches an object nobody ever executes and records nothing.
        if (prop === 'bind') {
          return (...args: unknown[]) =>
            watchStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(t, args))
        }
        if (prop !== 'first' && prop !== 'all' && prop !== 'run') return value
        return async (...args: unknown[]) => {
          spy.order.push('send')
          const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(t, args)
          spy.order.push('recv')
          return out
        }
      },
    })

  const watch = <T extends object>(target: T, sessioned: boolean): T =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver)
        if (prop === 'prepare') {
          return (...args: unknown[]) => {
            spy.prepares++
            if (!sessioned) spy.unsessioned++
            return watchStatement(
              (value as (...a: unknown[]) => D1PreparedStatement).apply(t, args),
            )
          }
        }
        if (prop === 'batch') {
          return async (...args: unknown[]) => {
            spy.batches++
            spy.order.push('send')
            const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(t, args)
            spy.order.push('recv')
            return out
          }
        }
        if (prop === 'withSession') {
          return (...args: unknown[]) => {
            spy.sessions++
            return watch((value as (...a: unknown[]) => object).apply(t, args), true)
          }
        }
        return value
      },
    })

  spy.db = watch(real, false)
  return spy
}

async function insertPage(id: string, path: string, title: string, doc?: Doc) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at)
     values (?, 'page', null, ?, ?, 'a0', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      path,
      path,
      title,
      Date.now(),
      doc ? JSON.stringify(doc) : null,
      doc ? Date.now() : null,
    )
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

describe('reads run on a D1 session', () => {
  it('never issues a query straight on the binding', async () => {
    await insertPage('sty_rs_a', 'rs-a', 'A', pageDoc())
    const spy = spyOn(env.DB)
    const folio = makeFolio(spy.db)

    await folio.published(env, 'rs-a')

    expect(spy.prepares).toBeGreaterThan(0)
    expect(spy.unsessioned).toBe(0)
  })

  it('a reader spends one session on a whole render, where the one-shot calls spend one each', async () => {
    await insertPage('sty_rs_b', 'rs-b', 'B', pageDoc())

    const shared = spyOn(env.DB)
    const reader = makeFolio(shared.db).reader(env, new Request(`${ORIGIN}/rs-b`))
    const doc = await reader.published('rs-b')
    await reader.resolve(doc ?? undefined, { stories: 'all' })
    expect(shared.sessions).toBe(1)

    // The same two reads through the top-level API, which is what a caller with
    // no request in hand gets and is why a page render should not use it.
    const separate = spyOn(env.DB)
    const folio = makeFolio(separate.db)
    const same = await folio.published(env, 'rs-b')
    await folio.resolve(env, same ?? undefined, { stories: 'all' })
    expect(separate.sessions).toBe(2)
  })

  it('carries an editor bookmark from the cookie into the session it opens', async () => {
    await insertPage('sty_rs_c', 'rs-c', 'C', pageDoc())
    const seen: unknown[] = []
    const real = env.DB
    const db = new Proxy(real, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver)
        if (prop !== 'withSession') return value
        return (...args: unknown[]) => {
          seen.push(args[0])
          return (value as (...a: unknown[]) => object).apply(t, args)
        }
      },
    }) as D1Database

    const folio = makeFolio(db)
    const req = new Request(`${ORIGIN}/rs-c`, { headers: { cookie: 'folio_bookmark=abc123' } })
    await folio.reader(env, req).published('rs-c')
    expect(seen).toEqual(['abc123'])

    // A cookie that could not be a bookmark is ignored rather than passed on,
    // and the session falls back to "nearest instance" instead of throwing.
    seen.length = 0
    const junk = new Request(`${ORIGIN}/rs-c`, { headers: { cookie: 'folio_bookmark=a b c' } })
    await folio.reader(env, junk).published('rs-c')
    expect(seen).toEqual(['first-unconstrained'])

    // No request at all: a sitemap build or a cron, reading published content.
    seen.length = 0
    await folio.reader(env).published('rs-c')
    expect(seen).toEqual(['first-unconstrained'])
  })
})

describe('resolve(): the published branch sends both passes at once', () => {
  /**
   * `send send recv recv`, not `send recv send recv`.
   *
   * The story map and the referenced documents are independent lookups, and
   * awaiting the first before issuing the second cost a whole network round trip
   * per page render for a filter that changes nothing. Ordering is the only way
   * to see that from here: both queries return the same rows either way.
   */
  it('overlaps the story map with the documents it pulls in', async () => {
    const target = 'sty_rs_ref'
    await insertPage(target, 'rs-ref', 'Referenced', pageDoc('Referenced'))

    const spy = spyOn(env.DB)
    const folio = makeFolio(spy.db)
    await folio.resolve(env, referencingDoc(target))

    expect(spy.prepares).toBe(2)
    expect(spy.order.slice(0, 4)).toEqual(['send', 'send', 'recv', 'recv'])
  })
})

/** A page that references `id`, so `resolve`'s second pass has a document to fetch. */
function referencingDoc(id: string): Doc {
  return {
    root: 'root0000',
    bloks: {
      root0000: {
        uid: 'root0000',
        type: 'page',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title: 'Linking', related: id },
      },
    },
  }
}

describe('folio.miss(): one round trip for a path with no live page', () => {
  it('asks about the redirect and the state together, in one batch', async () => {
    const spy = spyOn(env.DB)
    const folio = makeFolio(spy.db)

    await folio.miss(env, 'rs-nothing-here')

    expect(spy.batches).toBe(1)
    expect(spy.order).toEqual(['send', 'recv'])
  })

  it('answers not-found for a path that never existed', async () => {
    await expect(makeFolio().miss(env, 'rs-never')).resolves.toEqual({ kind: 'not-found' })
  })

  it('answers gone for a story that was live and was taken down', async () => {
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                            published_at, unpublished_at)
       values ('sty_rs_gone', 'page', null, 'rs-gone', 'rs-gone', 'a0', 'Gone', ?, null, ?)`,
    )
      .bind(Date.now(), Date.now())
      .run()

    await expect(makeFolio().miss(env, 'rs-gone')).resolves.toEqual({ kind: 'gone' })
  })

  it('prefers a redirect over the state, because a rename records both', async () => {
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                            published_at, unpublished_at)
       values ('sty_rs_moved', 'page', null, 'rs-moved', 'rs-moved', 'a0', 'Moved', ?, null, ?)`,
    )
      .bind(Date.now(), Date.now())
      .run()
    await env.DB.prepare(
      `insert into redirects (from_path, to_path, status, source, story_id, created_at)
       values ('rs-moved', '/rs-here-now', 301, 'auto', 'sty_rs_moved', ?)`,
    )
      .bind(Date.now())
      .run()

    await expect(makeFolio().miss(env, 'rs-moved')).resolves.toEqual({
      kind: 'redirect',
      to: '/rs-here-now',
      status: 301,
    })
  })

  it('refuses an unsafe stored target exactly as folio.redirect does', async () => {
    await env.DB.prepare(
      `insert into redirects (from_path, to_path, status, source, created_at)
       values ('rs-unsafe', 'javascript:alert(1)', 301, 'manual', ?)`,
    )
      .bind(Date.now())
      .run()

    await expect(makeFolio().miss(env, 'rs-unsafe')).resolves.toEqual({ kind: 'not-found' })
    await expect(makeFolio().redirect(env, 'rs-unsafe')).resolves.toBeNull()
  })
})

/**
 * The bookmark cookie (`src/server/middleware.ts`).
 *
 * The rule is narrow on purpose, and each half of it is here because getting it
 * wrong is silent: too narrow and an editor's tree shows a story they just
 * published as still a draft; too wide and every `{base}/asset/:key` response
 * carries a `Set-Cookie`, which no cache will store.
 */
describe('the bookmark cookie', () => {
  const cookieOn = (res: Response) =>
    res.headers
      .getSetCookie()
      .filter((c) => c.startsWith('folio_bookmark=') || c.startsWith('__Host-folio_bookmark='))

  const call = (path: string, init?: RequestInit) =>
    makeFolio().handle(new Request(`${ORIGIN}${path}`, init), env, createExecutionContext())

  it('is written for a signed-in editor who wrote something', async () => {
    const res = await call('/folio/api/stories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'folio_session=whatever' },
      body: JSON.stringify({ title: 'Bookmarked', slug: 'rs-bookmarked' }),
    })
    expect(res?.ok).toBe(true)
    expect(cookieOn(res as Response)).toHaveLength(1)
  })

  it('is not written on a GET, so a media response stays cacheable', async () => {
    const res = await call('/folio/api/stories', {
      headers: { cookie: 'folio_session=whatever' },
    })
    expect(res?.ok).toBe(true)
    expect(cookieOn(res as Response)).toHaveLength(0)
  })

  it('is not written for a request carrying no session cookie', async () => {
    const res = await call('/folio/api/stories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Anonymous', slug: 'rs-anonymous' }),
    })
    expect(cookieOn(res as Response)).toHaveLength(0)
  })
})

/**
 * `reader.page()` — one row read plus one resolve, and headers that cannot be
 * half-configured (`FolioPage`).
 */
describe('reader.page()', () => {
  it('answers the document, its story, the resolution and both cache headers', async () => {
    await insertPage('sty_rs_p1', 'rs-p1', 'Page One', pageDoc('Page One'))
    const page = await makeFolio().reader(env).page('rs-p1')

    expect(page?.doc.root).toBe('root0000')
    expect(page?.story.id).toBe('sty_rs_p1')
    expect(page?.draft).toBe(false)
    // Both halves, always. `Cache-Control` without `Cache-Tag` is a page cached
    // for a week with no purge path.
    expect(page?.headers['cache-control']).toContain('s-maxage=')
    expect(page?.headers['cache-tag']).toContain('story:sty_rs_p1')
  })

  it('reads the row once, where published + storyAt read it twice', async () => {
    await insertPage('sty_rs_p2', 'rs-p2', 'Page Two', pageDoc('Page Two'))

    const combined = spyOn(env.DB)
    await makeFolio(combined.db).reader(env).page('rs-p2')

    const apart = spyOn(env.DB)
    const folio = makeFolio(apart.db)
    const reader = folio.reader(env)
    const doc = await reader.published('rs-p2')
    const story = await reader.storyAt('rs-p2')
    await reader.resolve(doc ?? undefined, { ...(story ? { story } : {}) })

    // The saved query is the second read of the same row by the same indexed
    // column — which a host only makes because `cacheHeaders` needs the id.
    expect(combined.prepares).toBe(apart.prepares - 1)
  })

  it('answers no-store and no cache tag for a draft, so it cannot reach a shared cache', async () => {
    await insertPage('sty_rs_p3', 'rs-p3', 'Page Three', pageDoc('Published Title'))
    const folio = makeFolio()
    // `auth: 'open'` makes the draft cookie the whole authority, which is the
    // same authority `handle()`'s preview branch grants there.
    const req = new Request(`${ORIGIN}/rs-p3`, { headers: { cookie: 'folio_draft=1' } })
    const page = await folio.reader(env, req).page('rs-p3')

    expect(page?.draft).toBe(true)
    expect(page?.headers['cache-control']).toBe('private, no-store')
    expect(page?.headers['cache-tag']).toBeUndefined()
  })

  it('answers null for a path with no story, and for a story with nothing to show', async () => {
    await expect(makeFolio().reader(env).page('rs-no-such-page')).resolves.toBeNull()

    // A row that exists but has never been published: `miss` is what tells a
    // host whether that is a 404 or a 410, and `page` simply has nothing.
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at)
       values ('sty_rs_p4', 'page', null, 'rs-p4', 'rs-p4', 'a0', 'Never Published', ?)`,
    )
      .bind(Date.now())
      .run()
    await expect(makeFolio().reader(env).page('rs-p4')).resolves.toBeNull()
  })

  it('refuses a locale the site never declared, exactly as published does', async () => {
    await insertPage('sty_rs_p5', 'rs-p5', 'Page Five', pageDoc('Five'))
    await expect(makeFolio().reader(env).page('rs-p5', { locale: 'xx' })).resolves.toBeNull()
  })
})
