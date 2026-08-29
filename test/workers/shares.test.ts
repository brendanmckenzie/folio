import { createExecutionContext, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { NO_STORE } from '../../src/core/cache-tags'
import { blocks, defineBlock, text } from '../../src/core'
import type { AuthConfig, Role, ShareRow } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { SECURE_COOKIE, SECURE_SHARE_COOKIE } from '../../src/server/auth/cookie'
import { createSession } from '../../src/server/auth/session'
import { createToken } from '../../src/server/auth/tokens'
import { createUser } from '../../src/server/auth/users'
import type { Scope } from '../../src/server/auth/roles'

/**
 * Draft preview sharing (`../../docs/specs/platform/draft-sharing.md`): the
 * link works, and it reaches nothing else.
 *
 * The second half is worth more than the first. A tokenised link is a credential
 * handed to somebody with no account, so the interesting assertions are all
 * negative — the enumeration in *"and nothing else"* below is the reason this file
 * exists, and it is written as one loop over every route family rather than as
 * prose, so a route added later that forgets its gate fails here.
 *
 * Its own `createFolio` with providers configured, for the reason
 * `auth-http.test.ts`'s header gives: `auth: 'open'` short-circuits every gate, and
 * gates are the subject.
 */

const ORIGIN = 'https://folio.test'
const BASE = `${ORIGIN}/folio`
const API = `${BASE}/api`

const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true }),
    body: blocks({ label: 'Body', allow: [] }),
  },
  render: () => null,
})

const record = defineBlock({
  name: 'personRecord',
  label: 'Person',
  fields: { fullName: text({ label: 'Name', required: true }) },
  render: () => null,
})

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
}

function build(mode: AuthConfig<Cloudflare.Env> | 'open' = auth) {
  return createFolio<Cloudflare.Env>({
    blocks: [page, record],
    types: [
      { name: 'page', label: 'Page', kind: 'page', root: 'page' },
      {
        name: 'person',
        label: 'Person',
        kind: 'record',
        root: 'personRecord',
        titleField: 'fullName',
      },
    ],
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
    auth: mode,
    route: (p) => (p ? `/${p}` : '/'),
  })
}

const folio = build()

/** `handle()` may legitimately answer null — the host's own routes win — so every
 * helper here keeps the raw answer rather than coercing it. */
function raw(path: string, init?: RequestInit, which = folio): Promise<Response | null> {
  return which.handle(new Request(`${ORIGIN}${path}`, init), env, createExecutionContext())
}

async function call(path: string, init?: RequestInit, which = folio): Promise<Response> {
  const res = await raw(path, init, which)
  if (!res) throw new Error(`handle() returned null for ${path}`)
  return res
}

let counter = 0

/** A routed page at its own path, so `?_folio=preview` on that path resolves to it. */
async function seedPage(slug: string, title = 'Home'): Promise<{ id: string; path: string }> {
  const id = `sty_shr${(counter++).toString().padStart(4, '0')}`
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
     values (?, 'page', null, ?, ?, 'a0', ?, ?, ?)`,
  )
    .bind(id, slug, slug, title, Date.now(), Date.now())
    .run()
  return { id, path: `/${slug}` }
}

/** An unrouted document: `path is null`, so there is no page to share. */
async function seedRecord(title = 'Ada'): Promise<string> {
  const id = `sty_rec${(counter++).toString().padStart(4, '0')}`
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
     values (?, 'person', null, ?, null, 'a0', ?, ?, ?)`,
  )
    .bind(id, id, title, Date.now(), Date.now())
    .run()
  return id
}

async function signIn(role: Role, email = `${role}-share@example.com`) {
  const user = await createUser(env.DB, { email, name: role, role })
  const session = await createSession(env.DB, user.id)
  return { user, cookie: `${SECURE_COOKIE}=${session.token}` }
}

async function tokenFor(scopes: Scope[]) {
  const minted = await createToken(env.DB, { name: `t${counter++}`, scopes })
  return { authorization: `Bearer ${minted.token}` }
}

interface CreateAnswer {
  url: string
  share: ShareRow
}

interface ErrorEnvelope {
  error: { code: string; message: string }
}

/** Mints a link as a publisher and returns everything a reviewer needs. */
async function share(
  storyId: string,
  body?: Record<string, unknown>,
): Promise<{ url: string; token: string; row: ShareRow; cookie: string }> {
  const { cookie } = await signIn('publisher', `pub${counter++}@example.com`)
  const res = await call(`/folio/api/story/${storyId}/share`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  expect(res.status).toBe(201)
  const answer = await res.json<CreateAnswer>()
  const token = new URL(answer.url).searchParams.get('t')!
  return {
    url: answer.url,
    token,
    row: answer.share,
    cookie: `${SECURE_SHARE_COOKIE}=${token}`,
  }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('delete from shares'),
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from users'),
    env.DB.prepare('delete from stories'),
  ])
})

/* ---------------------------------------------------------- minting a link --- */

describe('minting a link', () => {
  it('answers the token exactly once, and stores only its hash', async () => {
    const { id } = await seedPage('one')
    const { token, row } = await share(id)

    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(row.storyId).toBe(id)
    expect(row.views).toBe(0)
    // The row a screen draws carries neither the token nor its hash.
    expect(JSON.stringify(row)).not.toContain(token)
    expect(Object.keys(row)).not.toContain('tokenHash')

    // What the database holds is the SHA-256 and nothing else — the seed's comment
    // in examples/demo/seed.sql spells out why this matters.
    const stored = await env.DB.prepare('select token_hash from shares where id = ?')
      .bind(row.id)
      .first<{ token_hash: string }>()
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.token_hash).not.toBe(token)
  })

  it('defaults to seven days and refuses more than ninety', async () => {
    const { id } = await seedPage('two')
    const { row } = await share(id)
    const days = (row.expiresAt - row.createdAt) / (24 * 60 * 60 * 1000)
    expect(Math.round(days)).toBe(7)

    const { cookie } = await signIn('publisher', 'pub-bounds@example.com')
    const tooLong = await call(`/folio/api/story/${id}/share`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 400 }),
    })
    expect(tooLong.status).toBe(400)
    // The schema's bound, not `shareExpiry`'s: both exist and neither is redundant.
    expect((await tooLong.json<ErrorEnvelope>()).error.message).toMatch(/90 or fewer/)
  })

  it('refuses an unrouted document, because there is no page to preview', async () => {
    const id = await seedRecord()
    const { cookie } = await signIn('publisher', 'pub-record@example.com')
    const res = await call(`/folio/api/story/${id}/share`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
    })
    expect(res.status).toBe(400)
    expect((await res.json<ErrorEnvelope>()).error.message).toMatch(/no URL to preview/)
  })

  it('404s an unknown document before minting anything', async () => {
    const { cookie } = await signIn('publisher', 'pub-unknown@example.com')
    const res = await call('/folio/api/story/sty_nope/share', {
      method: 'POST',
      headers: { cookie },
    })
    expect(res.status).toBe(404)
    const count = await env.DB.prepare('select count(*) as n from shares').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })
})

/* ------------------------------------------------------------------- gates --- */

describe('gates', () => {
  it('needs PUBLISH to mint, list or revoke', async () => {
    const { id } = await seedPage('gated')
    const { row } = await share(id)

    for (const role of ['viewer', 'editor'] as const) {
      const { cookie } = await signIn(role, `${role}-gate@example.com`)
      expect(
        (await call(`/folio/api/story/${id}/share`, { method: 'POST', headers: { cookie } }))
          .status,
      ).toBe(403)
      expect((await call('/folio/api/shares', { headers: { cookie } })).status).toBe(403)
      expect(
        (await call(`/folio/api/shares/${row.id}`, { method: 'DELETE', headers: { cookie } }))
          .status,
      ).toBe(403)
    }

    const { cookie } = await signIn('publisher', 'pub-gate@example.com')
    expect((await call('/folio/api/shares', { headers: { cookie } })).status).toBe(200)
  })

  it('answers 401, not 403, with no credential at all', async () => {
    const { id } = await seedPage('anon')
    expect((await call(`/folio/api/story/${id}/share`, { method: 'POST' })).status).toBe(401)
    expect((await call('/folio/api/shares')).status).toBe(401)
  })

  it('accepts a token holding `publish` and refuses one holding only reads', async () => {
    const { id } = await seedPage('tokened')
    // The same currency the gate is declared in: `PUBLISH` is
    // `{ role: 'publisher', scope: 'publish' }`, so a token with the scope may do it.
    const allowed = await tokenFor(['publish'])
    expect(
      (await call(`/folio/api/story/${id}/share`, { method: 'POST', headers: allowed })).status,
    ).toBe(201)

    const refused = await tokenFor(['content:read:draft'])
    const res = await call(`/folio/api/story/${id}/share`, { method: 'POST', headers: refused })
    expect(res.status).toBe(403)
    expect((await res.json<ErrorEnvelope>()).error.message).toMatch(/'publish' scope/)
  })

  it('404s the whole surface under auth: open, where it would be ceremony', async () => {
    const open = build('open')
    const { id } = await seedPage('openmode')
    // Following /users and /tokens: "there is no such thing here" rather than a role
    // check that always passes. On such a deployment `?_folio=preview` is open to
    // everyone already, so a sharing mechanism would guard nothing.
    for (const [path, init] of [
      [`/folio/api/story/${id}/share`, { method: 'POST' }],
      ['/folio/api/shares', undefined],
      ['/folio/api/shares/shr_x', { method: 'DELETE' }],
      [`/folio/share?t=${'a'.repeat(64)}`, undefined],
    ] as const) {
      const res = await call(path, init as RequestInit | undefined, open)
      expect([path, res.status]).toEqual([path, 404])
    }
  })
})

/* --------------------------------------------------------- using the link --- */

describe('using the link', () => {
  it('exchanges the token for a cookie and redirects to the document’s own URL', async () => {
    const { id, path } = await seedPage('review')
    const { token } = await share(id)

    // No cookie, no session, no bearer: exactly what a client with no account has.
    const res = await call(`/folio/share?t=${token}`)
    expect(res.status).toBe(302)
    /**
     * The host's own `route()`, with the **draft** flag. Never assembled by this
     * route.
     *
     * `?_folio=draft`, not `?_folio=preview`, and the change is deliberate
     * (`../../docs/specs/platform/mcp-server.md` decision 5). This link had
     * always landed a reviewer on the *editor's* render of the page: a dashed
     * outline chasing their cursor and `preventDefault()` on every click inside a
     * marked block, so nothing on the page navigated. The next test asserts the
     * consequence rather than only the URL.
     */
    expect(res.headers.get('location')).toBe(`${path}?_folio=draft`)
    // The redirect carries a credential and a Set-Cookie; neither may be stored.
    expect(res.headers.get('cache-control')).toBe(NO_STORE)

    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${SECURE_SHARE_COOKIE}=${token}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toMatch(/Max-Age=\d+/)
    // Not the session cookie's name, which is the whole reason a share resolves to
    // no actor anywhere in the server.
    expect(setCookie).not.toContain(SECURE_COOKIE)
  })

  it('renders the draft at that URL to a browser holding only the share cookie', async () => {
    const { id, path } = await seedPage('drafted', 'Draft title')
    const { cookie } = await share(id)

    // The control: the same URL with nothing attached is handed back to the host.
    expect(await raw(`${path}?_folio=preview`)).toBeNull()

    const res = await call(`${path}?_folio=preview`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    // A draft must never be cached at a URL the public also uses.
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    const html = await res.text()
    expect(html).toContain('Draft title')
  })

  /**
   * The gate is the mode's, not the link's: a share cookie satisfies the branch,
   * and the branch then renders whichever mode was asked for. What changed is only
   * *which* one the link points at — so this asserts the reviewer's actual
   * experience at the URL they are now sent to, which is the half of the fix that
   * a `location` header cannot show.
   */
  it('answers the reviewer’s own draft URL with a page, not the editing chrome', async () => {
    const { id, path } = await seedPage('reviewed', 'Reviewable title')
    const { cookie } = await share(id)

    expect(await raw(`${path}?_folio=draft`)).toBeNull()

    const res = await call(`${path}?_folio=draft`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    const html = await res.text()
    expect(html).toContain('Reviewable title')
    // No editing body class, so `preview.css`'s outlines can match nothing…
    expect(html).not.toContain('folio-editing')
    // …and no preview bundle, so `attachBridge` never runs and links navigate.
    expect(html).not.toContain('/folio-preview.js')
    expect(html).not.toContain('__FOLIO__')
  })

  it('counts the views, so an editor can tell whether the client looked', async () => {
    const { id, path } = await seedPage('counted')
    const { cookie, row, token } = await share(id)

    // The entry hop deliberately does not count: it renders nothing, and counting it
    // would double every visit.
    await call(`/folio/share?t=${token}`)
    const before = await env.DB.prepare('select views from shares where id = ?')
      .bind(row.id)
      .first<{ views: number }>()
    expect(before?.views).toBe(0)

    await call(`${path}?_folio=preview`, { headers: { cookie } })
    await call(`${path}?_folio=preview`, { headers: { cookie } })
    const after = await env.DB.prepare('select views, last_viewed_at from shares where id = ?')
      .bind(row.id)
      .first<{ views: number; last_viewed_at: number | null }>()
    expect(after?.views).toBe(2)
    expect(after?.last_viewed_at).toBeGreaterThan(0)
  })

  it('holds several links at once, so a second one does not unseat the first', async () => {
    const a = await seedPage('page-a')
    const b = await seedPage('page-b')
    const first = await share(a.id)
    const second = await share(b.id)

    // What a reviewer's browser looks like after clicking both links: one cookie,
    // both tokens. See MAX_SHARE_COOKIE_TOKENS.
    const both = `${SECURE_SHARE_COOKIE}=${second.token}.${first.token}`
    expect((await call(`${a.path}?_folio=preview`, { headers: { cookie: both } })).status).toBe(200)
    expect((await call(`${b.path}?_folio=preview`, { headers: { cookie: both } })).status).toBe(200)

    // And that the cookie the *route* writes is that list rather than a replacement.
    const res = await call(`/folio/share?t=${first.token}`, {
      headers: { cookie: `${SECURE_SHARE_COOKIE}=${second.token}` },
    })
    const written = res.headers.get('set-cookie') ?? ''
    expect(written).toContain(`${first.token}.${second.token}`)
  })

  it('drops a malformed part rather than failing the whole cookie', async () => {
    const { id, path } = await seedPage('resilient')
    const { token } = await share(id)
    // A stale value from an older deploy must not lock a reviewer out of a good link.
    const messy = `${SECURE_SHARE_COOKIE}=not-a-token.${token}.${'Z'.repeat(64)}`
    expect((await call(`${path}?_folio=preview`, { headers: { cookie: messy } })).status).toBe(200)
  })
})

/* ------------------------------------------------------- a lapsed link --- */

describe('a link that no longer works', () => {
  const lapsedBody = async (res: Response) => {
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    const html = await res.text()
    expect(html).toContain('no longer works')
    // No JavaScript, and nothing about the site: a reviewer whose link has lapsed
    // has no standing to be told which document it was for.
    expect(html).not.toContain('<script')
    return html
  }

  it('answers the same explaining page for expired, revoked and never-issued', async () => {
    const { id } = await seedPage('lapsing')
    const live = await share(id)

    const revoked = await share(id)
    const { cookie } = await signIn('publisher', 'pub-revoke@example.com')
    const del = await call(`/folio/api/shares/${revoked.row.id}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(await del.json()).toEqual({ revoked: true })

    // Aged past its expiry in place, rather than by sleeping.
    await env.DB.prepare('update shares set expires_at = 1 where id = ?').bind(live.row.id).run()

    const bodies = [
      await lapsedBody(await call(`/folio/share?t=${live.token}`)),
      await lapsedBody(await call(`/folio/share?t=${revoked.token}`)),
      await lapsedBody(await call(`/folio/share?t=${'f'.repeat(64)}`)),
      await lapsedBody(await call('/folio/share?t=obviously-not-a-token')),
    ]
    // Byte-identical, which is the point: telling the four apart would make this an
    // oracle for "was this string ever one of our tokens", and the reader's next
    // action is the same in all four cases.
    expect(new Set(bodies).size).toBe(1)
  })

  it('stops working at the document URL too, not only at the entry route', async () => {
    const { id, path } = await seedPage('stops')
    const { cookie, row } = await share(id)
    expect((await call(`${path}?_folio=preview`, { headers: { cookie } })).status).toBe(200)

    await env.DB.prepare('update shares set revoked_at = 1 where id = ?').bind(row.id).run()
    // Handed back to the host, which serves its ordinary published answer. Never a
    // 401 at a URL the public also uses.
    expect(await raw(`${path}?_folio=preview`, { headers: { cookie } })).toBeNull()
  })

  it('answers the lapsed page for a link whose document has been deleted', async () => {
    const { id } = await seedPage('doomed')
    const { token } = await share(id)
    await env.DB.prepare('delete from stories where id = ?').bind(id).run()
    // Nothing prunes `shares` on a story delete (0004_shares.sql says why), so this
    // is where such a link lands — and the id can never be re-minted, so no future
    // document inherits the grant.
    await lapsedBody(await call(`/folio/share?t=${token}`))
  })

  it('404s the entry route with no token at all', async () => {
    // Not a link anybody was given, so not a link anybody needs explained.
    expect((await call('/folio/share')).status).toBe(404)
  })

  it('refuses a second revoke, so the answer is never a lie', async () => {
    const { id } = await seedPage('twice')
    const { row } = await share(id)
    const { cookie } = await signIn('publisher', 'pub-twice@example.com')
    const init = { method: 'DELETE', headers: { cookie } }
    expect((await call(`/folio/api/shares/${row.id}`, init)).status).toBe(200)
    expect((await call(`/folio/api/shares/${row.id}`, init)).status).toBe(404)
  })
})

/* -------------------------------------------------------------- the list --- */

describe('listing links', () => {
  it('is the receipt: newest first, filterable, never carrying a token', async () => {
    const a = await seedPage('list-a')
    const b = await seedPage('list-b')
    const first = await share(a.id, { note: 'for Rachel' })
    const second = await share(b.id)
    const { cookie } = await signIn('publisher', 'pub-list@example.com')

    const all = await (await call('/folio/api/shares?count=1', { headers: { cookie } })).json<{
      shares: ShareRow[]
      total?: number
    }>()
    expect(all.shares.map((s) => s.id)).toEqual([second.row.id, first.row.id])
    expect(all.total).toBe(2)
    expect(all.shares[0]?.createdBy).toMatch(/^usr_/)
    expect(all.shares.find((s) => s.id === first.row.id)?.note).toBe('for Rachel')
    expect(JSON.stringify(all)).not.toContain(first.token)
    expect(JSON.stringify(all)).not.toContain(second.token)

    const one = await (
      await call(`/folio/api/shares?story=${a.id}`, { headers: { cookie } })
    ).json<{ shares: ShareRow[] }>()
    expect(one.shares.map((s) => s.id)).toEqual([first.row.id])
  })

  it('splits live from lapsed, computed from the clock rather than a column', async () => {
    const { id } = await seedPage('states')
    const live = await share(id)
    const dead = await share(id)
    await env.DB.prepare('update shares set expires_at = 1 where id = ?').bind(dead.row.id).run()
    const { cookie } = await signIn('publisher', 'pub-states@example.com')

    const read = async (state: string) =>
      (
        await (
          await call(`/folio/api/shares?state=${state}`, { headers: { cookie } })
        ).json<{ shares: ShareRow[] }>()
      ).shares.map((s) => s.id)

    expect(await read('live')).toEqual([live.row.id])
    expect(await read('lapsed')).toEqual([dead.row.id])

    const bad = await call('/folio/api/shares?state=maybe', { headers: { cookie } })
    expect(bad.status).toBe(400)
  })

  it('pages, because nothing here is ever deleted', async () => {
    const { id } = await seedPage('paged')
    for (let i = 0; i < 3; i++) await share(id)
    const { cookie } = await signIn('publisher', 'pub-paged@example.com')

    type Listed = { shares: ShareRow[]; cursor: string | null }
    const first = await (
      await call('/folio/api/shares?limit=2', { headers: { cookie } })
    ).json<Listed>()
    expect(first.shares).toHaveLength(2)
    expect(first.cursor).toBeTruthy()

    const next = await (
      await call(`/folio/api/shares?limit=2&cursor=${encodeURIComponent(first.cursor!)}`, {
        headers: { cookie },
      })
    ).json<Listed>()
    expect(next.shares).toHaveLength(1)
    expect(next.cursor).toBeNull()

    const bogus = await call('/folio/api/shares?cursor=not-a-cursor', { headers: { cookie } })
    expect(bogus.status).toBe(400)
  })
})

/* ------------------------------------------------------ and nothing else --- */

/**
 * The enumeration. **A share cookie must reach the shared document and nothing
 * whatsoever besides**, and this is the list of everything it was checked against.
 *
 * Written as a table rather than as individual tests so that the *set* is the
 * assertion: a route family added later without a gate is a row somebody has to
 * deliberately not add here, which is a much louder omission than a missing `it`.
 */
describe('and nothing else', () => {
  it('is refused by every other route family in the server', async () => {
    const { id, path } = await seedPage('fenced')
    const other = await seedPage('sibling')
    const { cookie } = await share(id)

    // The positive control, so a blanket failure cannot pass this test.
    expect((await call(`${path}?_folio=preview`, { headers: { cookie } })).status).toBe(200)

    /** Each row: what it is, the request, and the answer that means "closed". */
    const closed: Array<[string, string, RequestInit | undefined, number]> = [
      // The admin shell, at its mount and at a deep link. 302 to sign in — which the
      // reviewer cannot complete, having no account.
      ['the admin shell', BASE, undefined, 302],
      ['a deep link into the shell', `${BASE}/content`, undefined, 302],
      ['the editor', `${BASE}/edit/${id}`, undefined, 302],
      // Every internal JSON route: 401, because the cookie resolves to no actor.
      ['the story list', `${API}/stories`, undefined, 401],
      ['this document', `${API}/story/${id}/document`, undefined, 401],
      ['the document list', `${API}/documents`, undefined, 401],
      ['the type counts', `${API}/counts`, undefined, 401],
      ['search across the site', `${API}/search?q=a`, undefined, 401],
      ['content_index over published content', `${API}/content?type=page`, undefined, 401],
      ['the media library', `${API}/assets`, undefined, 401],
      ['the version list', `${API}/story/${id}/versions`, undefined, 401],
      ['the activity trail', `${API}/story/${id}/activity`, undefined, 401],
      ['who am I', `${API}/me`, undefined, 401],
      ['the editor list', `${API}/users`, undefined, 401],
      ['the token list', `${API}/tokens`, undefined, 401],
      ['the share list itself', `${API}/shares`, undefined, 401],
      ['schedules', `${API}/schedules`, undefined, 401],
      ['redirects', `${API}/redirects`, undefined, 401],
      // The versioned Content API: a contract with somebody's script, not with this.
      ['the v1 document read', `${API}/v1/documents/${id}`, undefined, 401],
      ['the v1 draft read', `${API}/v1/documents/${id}?status=draft`, undefined, 401],
      ['the v1 by-path read', `${API}/v1/documents/by-path/fenced`, undefined, 401],
      // Writes, in every currency this server has.
      ['publishing', `${API}/story/${id}/publish`, { method: 'POST' }, 401],
      ['unpublishing', `${API}/story/${id}/unpublish`, { method: 'POST' }, 401],
      ['deleting', `${API}/stories/${id}`, { method: 'DELETE' }, 401],
      ['renaming or moving', `${API}/stories/${id}`, { method: 'PATCH' }, 401],
      ['creating', `${API}/stories`, { method: 'POST' }, 401],
      ['bulk publishing', `${API}/bulk/publish`, { method: 'POST' }, 401],
      ['minting another link', `${API}/story/${other.id}/share`, { method: 'POST' }, 401],
      ['revoking a link', `${API}/shares/shr_whatever`, { method: 'DELETE' }, 401],
      ['migrating', `${API}/migrate`, { method: 'POST' }, 401],
      ['reindexing', `${API}/reindex`, { method: 'POST' }, 401],
      ['running schedules', `${API}/schedules/run`, { method: 'POST' }, 401],
    ]

    for (const [what, url, init, expected] of closed) {
      const res = await folio.handle(
        new Request(url, { ...init, headers: { ...(init?.headers ?? {}), cookie } }),
        env,
        createExecutionContext(),
      )
      expect([what, res?.status ?? null]).toEqual([what, expected])
    }
  })

  it('cannot walk to another document, even one it links to', async () => {
    const { id, path } = await seedPage('shared-one')
    const other = await seedPage('secret-one')
    const { cookie } = await share(id)

    expect((await call(`${path}?_folio=preview`, { headers: { cookie } })).status).toBe(200)
    // A grant names one story id, checked against the story the requested path
    // resolves to. Another page is handed back to the host — the same refusal an
    // unauthenticated request gets, so the flag simply means nothing there.
    expect(await raw(`${other.path}?_folio=preview`, { headers: { cookie } })).toBeNull()
    // Including the site root, which is nobody's story here.
    expect(await raw('/?_folio=preview', { headers: { cookie } })).toBeNull()
  })

  it('cannot ask for a global in the page’s context with `?as=`', async () => {
    const { id, path } = await seedPage('no-as')
    const { cookie } = await share(id)
    // `?as=` swaps the editable document for a *singleton's* draft — the site header,
    // site settings — which the grant does not cover. Refused before the global is
    // even looked up, so the refusal cannot depend on which globals are configured.
    expect(await raw(`${path}?_folio=preview&as=header`, { headers: { cookie } })).toBeNull()
    expect(await raw(`${path}?_folio=preview&as=anything`, { headers: { cookie } })).toBeNull()
  })

  it('cannot upgrade the sync socket', async () => {
    const { id } = await seedPage('no-socket')
    const { cookie } = await share(id)
    const res = await call(`/folio/api/story/${id}/socket`, {
      headers: { cookie, Upgrade: 'websocket' },
    })
    // Upgrade-and-close-4003, the terminal refusal an unauthenticated socket gets: a
    // share cookie is not a session, so there is no identity to hand the object.
    expect(res.status).toBe(101)
    expect(res.webSocket).toBeTruthy()
  })

  it('is not a session cookie, which is why all of the above holds', async () => {
    const { id } = await seedPage('not-a-session')
    const { token } = await share(id)
    // The mechanism behind every refusal above, asserted directly: `credentialOf`
    // reads two cookie names and this is neither, so presenting the share token
    // *under the session name* is also worthless — it is not a session token.
    const asSession = `${SECURE_COOKIE}=${token}`
    expect((await call('/folio/api/stories', { headers: { cookie: asSession } })).status).toBe(401)
  })
})
