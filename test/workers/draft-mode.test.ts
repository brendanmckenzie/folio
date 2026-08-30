import { createExecutionContext, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { blocks, defineBlock, text } from '../../src/core'
import type { AuthConfig, Role } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import {
  SECURE_COOKIE,
  SECURE_DRAFT_COOKIE,
  SECURE_SHARE_COOKIE,
} from '../../src/server/auth/cookie'
import { createSession } from '../../src/server/auth/session'
import { createUser } from '../../src/server/auth/users'

/**
 * Draft mode (`../../docs/specs/platform/draft-mode.md`): the host renders a draft
 * at the page's own URL, and Folio answers only "may this request see it".
 *
 * The negative assertions carry the weight, as they do for shares. `draftAt` is
 * called on **every published page render** a wired host performs, so two of its
 * properties are load-bearing in a way an ordinary route's are not: it must cost a
 * visitor with no cookies nothing at all, and it must never widen a share grant
 * from one story to the site.
 */

const ORIGIN = 'https://folio.test'

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

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
}

function build(opts: { auth?: AuthConfig<Cloudflare.Env> | 'open'; draftMode?: boolean } = {}) {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    types: [{ name: 'page', label: 'Page', kind: 'page', root: 'page' }],
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
    auth: opts.auth ?? auth,
    ...(opts.draftMode === undefined ? {} : { draftMode: opts.draftMode }),
    route: (p) => (p ? `/${p}` : '/'),
  })
}

const folio = build()

let counter = 0

async function seedPage(slug: string, title = 'Home'): Promise<{ id: string; path: string }> {
  const id = `sty_drf${(counter++).toString().padStart(4, '0')}`
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
     values (?, 'page', null, ?, ?, 'a0', ?, ?, ?)`,
  )
    .bind(id, slug, slug, title, Date.now(), Date.now())
    .run()
  return { id, path: slug }
}

async function signIn(role: Role, email = `${role}-draft@example.com`) {
  const user = await createUser(env.DB, { email, name: role, role })
  const session = await createSession(env.DB, user.id)
  return { cookie: `${SECURE_COOKIE}=${session.token}` }
}

const DRAFT = `${SECURE_DRAFT_COOKIE}=1`

function req(cookie?: string): Request {
  return new Request(`${ORIGIN}/`, cookie ? { headers: { cookie } } : undefined)
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('delete from shares'),
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from users'),
    env.DB.prepare('delete from stories'),
  ])
})

/* --------------------------------------------------- the cost of a stranger --- */

describe('a request with no credential', () => {
  /**
   * The one assertion this whole feature's performance rests on. `draftAt` runs
   * ahead of `published` on every page a wired host serves, so if it read D1 to
   * decide "no" it would double the query count of the entire site to serve a
   * feature almost nobody is using on almost every request.
   *
   * Counted at the binding rather than asserted through a public answer, because
   * "returned null" and "returned null without asking" are the same observation
   * from outside and only the second one is the property.
   */
  it('answers null and never touches the database', async () => {
    await seedPage('about')
    let prepares = 0
    const counting = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            prepares++
            return (...args: [string]) => target.prepare(...args)
          }
          return Reflect.get(target, prop, receiver)
        },
      }),
    } as Cloudflare.Env

    expect(await folio.draftAt(counting, req(), 'about')).toBeNull()
    expect(prepares).toBe(0)
  })

  it('answers null for a path that has no story either', async () => {
    expect(await folio.draftAt(env, req(), 'nothing-here')).toBeNull()
  })
})

/* ------------------------------------------------------------- as an editor --- */

describe('an editor in draft mode', () => {
  it('reads the draft of any page', async () => {
    const { path } = await seedPage('about')
    const { cookie } = await signIn('editor')
    const doc = await folio.draftAt(env, req(`${cookie}; ${DRAFT}`), path)
    expect(doc).not.toBeNull()
    expect(doc?.root).toBeTruthy()
  })

  /**
   * The flag and the authority are separate, and this is the direction that
   * matters: an editor is signed in all day and must not be shown drafts of every
   * page they visit until they ask.
   */
  it('reads nothing without the draft cookie', async () => {
    const { path } = await seedPage('about')
    const { cookie } = await signIn('editor')
    expect(await folio.draftAt(env, req(cookie), path)).toBeNull()
  })

  it('reads nothing with the draft cookie and no session', async () => {
    const { path } = await seedPage('about')
    expect(await folio.draftAt(env, req(DRAFT), path)).toBeNull()
  })

  /**
   * **Every signed-in role reaches this, including `viewer`**, and that is
   * deliberate rather than an oversight: `READ_DRAFT` is
   * `{ role: 'viewer', scope: 'content:read:draft' }`, the same gate `/edit/:id`
   * and `handle()`'s preview branch already use. A viewer can see any draft in the
   * admin's own preview, so refusing them the identical bytes at the page's real
   * URL would be a distinction with nothing behind it.
   *
   * Pinned because the reflex when reading `draftAt` is that browsing the live
   * site in draft feels more privileged than opening the editor, and it is not.
   */
  it('is open to every role that can already preview, viewer included', async () => {
    const { path } = await seedPage('about')
    const { cookie } = await signIn('viewer')
    expect(await folio.draftAt(env, req(`${cookie}; ${DRAFT}`), path)).not.toBeNull()
  })
})

/* ----------------------------------------------------------- as a reviewer --- */

describe('a reviewer holding a share cookie', () => {
  async function grantFor(storyId: string): Promise<string> {
    const { cookie } = await signIn('publisher', `pub${counter++}@example.com`)
    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/api/story/${storyId}/share`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
      }),
      env,
      createExecutionContext(),
    )
    const answer = await res!.json<{ url: string }>()
    return `${SECURE_SHARE_COOKIE}=${new URL(answer.url).searchParams.get('t')}`
  }

  it('reads the draft of the granted story', async () => {
    const granted = await seedPage('pricing')
    const cookie = await grantFor(granted.id)
    expect(await folio.draftAt(env, req(cookie), granted.path)).not.toBeNull()
  })

  /**
   * The grant names one story, and draft mode must not be the thing that widens
   * it to the site. Same cookie, different page, nothing.
   */
  it('reads nothing on any other page', async () => {
    const granted = await seedPage('pricing')
    const other = await seedPage('about')
    const cookie = await grantFor(granted.id)
    expect(await folio.draftAt(env, req(cookie), other.path)).toBeNull()
  })
})

/* ------------------------------------------------------- enter, and get out --- */

describe('the enter and exit routes', () => {
  async function get(path: string, cookie?: string, which = folio) {
    return which.handle(
      new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : undefined),
      env,
      createExecutionContext(),
    )
  }

  it('sets the flag for an editor and redirects to next', async () => {
    const { cookie } = await signIn('editor')
    const res = await get('/folio/draft/enter?next=%2Fabout', cookie)
    expect(res?.status).toBe(302)
    expect(res?.headers.get('location')).toBe('/about')
    expect(res?.headers.get('set-cookie')).toContain(SECURE_DRAFT_COOKIE)
  })

  /**
   * An open redirect behind an authenticated, cookie-setting route is worse than
   * one in front of it. `//evil.example` is the case a naive `startsWith('/')`
   * misses — browsers read it as protocol-relative.
   */
  it('refuses an off-site next', async () => {
    const { cookie } = await signIn('editor')
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const res = await get(`/folio/draft/enter?next=${encodeURIComponent(next)}`, cookie)
      expect(res?.headers.get('location')).toBe('/')
    }
  })

  /**
   * Ungated on purpose: a reviewer whose grant expired, or an editor whose session
   * did, must still be able to get out. Gating the exit on the credential that got
   * you in leaves clearing cookies by hand as the only way out.
   */
  it('lets anybody out, with no session at all', async () => {
    const res = await get('/folio/draft/exit?next=%2F')
    expect(res?.status).toBe(302)
    expect(res?.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

/* ----------------------------------------------------- where a share lands --- */

describe('a share link’s destination', () => {
  async function destination(which: ReturnType<typeof build>): Promise<string> {
    const story = await seedPage(`p${counter++}`)
    const { cookie } = await signIn('publisher', `pub${counter++}@example.com`)
    const created = await which.handle(
      new Request(`${ORIGIN}/folio/api/story/${story.id}/share`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
      }),
      env,
      createExecutionContext(),
    )
    const { url } = await created!.json<{ url: string }>()
    const res = await which.handle(new Request(url), env, createExecutionContext())
    return res!.headers.get('location') ?? ''
  }

  /** Without the promise, Folio's own shell — which is what shipped before this. */
  it('is ?_folio=draft when the host has not opted in', async () => {
    expect(await destination(build())).toContain('_folio=draft')
  })

  /** With it, the page's real URL, so the host's own render runs. */
  it('is the page’s own URL when draftMode is set', async () => {
    const target = await destination(build({ draftMode: true }))
    expect(target).not.toContain('_folio')
  })
})

/* ------------------------------------------------------------- the banner --- */

describe('inDraftMode', () => {
  /**
   * It reads the cookie and nothing else, deliberately — it is for drawing a
   * banner, and a host must not reach for it to decide what to render. `draftAt`
   * is the only call that has consulted a role or a grant.
   */
  it('is true for the flag alone, with no session', () => {
    expect(folio.inDraftMode(req(DRAFT))).toBe(true)
    expect(folio.inDraftMode(req())).toBe(false)
  })
})
