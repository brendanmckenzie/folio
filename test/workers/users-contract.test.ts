import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { AuthConfig, MagicLinkMail, Role } from '../../src/server'
import { createFolio, magicLink, trusted } from '../../src/server'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import type { UserActor } from '../../src/server/auth/roles'
import { readSession } from '../../src/server/auth/session'
import { createToken, readToken } from '../../src/server/auth/tokens'
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  userByEmail,
  userById,
} from '../../src/server/auth/users'
import { splitSqlStatements } from './sql-split'

/**
 * The contract `0012_users_role_contract.sql` will hold Folio to: nothing reads or
 * writes `users.role` or `users.role_from` (`docs/specs/foundation/multi-site.md`
 * decision 18, phase 1 item 8).
 *
 * **The proof is the real code against a database without the columns**, not a
 * grep. The column is read today as `u.role` and inside a `COLUMNS` string, and
 * neither is what a pattern like `users.role` matches, while a comment is. So this
 * file applies 0012's two statements to its own database — storage is per test
 * file, so no other file sees it — and runs every path that touches a role: both
 * sign-in shapes, a session read, the user list, create, patch and delete, a
 * token, and the seed shape. A statement that still names either column fails
 * here with `no such column`, whatever the SQL spells it.
 *
 * **Before that, the same seed on the fresh database the pool built**, to show
 * the seed shape works on both sides of 0012: `0001`…`0010`, `0011` in filename
 * order (apply-schema.ts), then examples/demo/seed.sql, then its admin signing in
 * with a `*` admin grant.
 *
 * Deleted by phase 10, when 0012 lands and its premise is the schema.
 */

const ORIGIN = 'https://folio.test'

const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title', required: true }) },
  render: () => null,
})

let outbox: MagicLinkMail[] = []

/** What the directory says, per address, for the trusted provider's mapper. */
const directory = new Map<string, Role>()

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [
    magicLink<Cloudflare.Env>({
      send: (_env, mail) => {
        outbox.push(mail)
      },
    }),
    // A header, verified by nothing: a test double, not something to copy. It
    // provisions, and its mapper places the role, so a sign-in through it writes
    // the grant on both paths `completeSignIn` has: a created user and a moved one.
    trusted<Cloudflare.Env>({
      id: 'proxy',
      label: 'Continue with proxy',
      provision: { create: true },
      roleFrom: (identity) => directory.get(identity.email) ?? null,
      resolve: (_env, req) => {
        const email = req.headers.get('x-identity')
        return email ? { email, name: 'Proxied' } : null
      },
    }),
  ],
}

const folio = createFolio<Cloudflare.Env>({
  blocks: [page],
  root: 'page',
  bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  auth,
  route: (p) => (p ? `/${p}` : '/'),
})

function call(path: string, init?: RequestInit): Promise<Response> {
  return folio.handle(
    new Request(`${ORIGIN}${path}`, init),
    env,
    createExecutionContext(),
  ) as Promise<Response>
}

function cookieFrom(res: Response): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    if (pair?.startsWith(`${SECURE_COOKIE}=`)) return pair.slice(SECURE_COOKIE.length + 1) || null
  }
  return null
}

/** Signs `email` in by magic link, end to end, and answers the session cookie. */
async function signInByLink(email: string): Promise<string> {
  outbox = []
  const sent = await call('/folio/login/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email }),
  })
  expect(sent.status).toBe(200)
  const mail = outbox[0]
  expect(mail?.email).toBe(email)
  const token = new URL(mail?.url ?? ORIGIN).searchParams.get('t') ?? ''
  const res = await call(`/folio/login/verify?t=${token}`)
  expect(res.status).toBe(302)
  const cookie = cookieFrom(res)
  expect(cookie).toMatch(/^[0-9a-f]{64}$/)
  return cookie ?? ''
}

async function signInByProxy(email: string): Promise<string> {
  const res = await call('/folio/login?next=%2Ffolio%2Fedit', { headers: { 'x-identity': email } })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/folio/edit')
  const cookie = cookieFrom(res)
  expect(cookie).toMatch(/^[0-9a-f]{64}$/)
  return cookie ?? ''
}

const grantsOf = (userId: string) =>
  env.DB.prepare('select scope_id, role, role_from from site_roles where user_id = ?')
    .bind(userId)
    .all<{ scope_id: string; role: string; role_from: string | null }>()
    .then((r) => r.results)

const userColumns = () =>
  env.DB.prepare('select name from pragma_table_info(?)')
    .bind('users')
    .all<{ name: string }>()
    .then((r) => r.results.map((c) => c.name))

const seedModules = import.meta.glob('../../examples/demo/seed.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>
const demoSeed = splitSqlStatements(Object.values(seedModules)[0] ?? '')

/** Everything the demo seed and the tests below write, children first, and
 * grants explicitly rather than by cascade. */
async function clear() {
  await env.DB.batch(
    [
      'shares',
      'api_tokens',
      'sessions',
      'login_challenges',
      'auth_events',
      'passkeys',
      'site_roles',
      'users',
      'stories',
    ].map((t) => env.DB.prepare(`delete from ${t}`)),
  )
}

describe('the demo seed, on a fresh database at 0011', () => {
  beforeAll(clear)

  it('runs every statement, and its admin signs in holding a `*` admin grant', async () => {
    expect(demoSeed.length).toBeGreaterThan(0)
    // One at a time rather than batched, so a failure names the statement.
    for (const sql of demoSeed) await env.DB.prepare(sql).run()

    const admin = await userByEmail(env.DB, 'demo@example.com')
    expect(admin?.id).toBe('usr_demoadmin1')
    expect(await grantsOf('usr_demoadmin1')).toEqual([
      { scope_id: '*', role: 'admin', role_from: null },
    ])

    const cookie = await signInByLink('demo@example.com')
    const actor = (await readSession(env.DB, cookie)) as UserActor
    expect(actor).toMatchObject({ kind: 'user', id: 'usr_demoadmin1', role: 'admin' })
    // And the admin surface agrees, which is the check a person would make.
    const me = await call('/folio/api/users', { headers: { cookie: `${SECURE_COOKIE}=${cookie}` } })
    expect(me.status).toBe(200)
  })
})

describe('with 0012 applied: nothing reads or writes `users.role`', () => {
  beforeAll(async () => {
    await clear()
    // 0012_users_role_contract.sql, verbatim from the spec. Applied here only.
    await env.DB.prepare('alter table users drop column role_from').run()
    await env.DB.prepare('alter table users drop column role').run()
    const columns = await userColumns()
    expect(columns).not.toContain('role')
    expect(columns).not.toContain('role_from')
  })

  beforeEach(async () => {
    outbox = []
    directory.clear()
    await clear()
  })

  it('runs the seed shape, and the demo seed', async () => {
    await env.DB.batch([
      env.DB.prepare(
        "insert into users (id, email, name, created_at) values ('usr_admin', 'admin@example.com', 'Admin', 0)",
      ),
      env.DB.prepare(
        "insert into site_roles (user_id, scope_id, role, created_at) values ('usr_admin', '*', 'admin', 0)",
      ),
    ])
    expect((await userById(env.DB, 'usr_admin'))?.role).toBe('admin')

    for (const sql of demoSeed) await env.DB.prepare(sql).run()
    expect((await userByEmail(env.DB, 'editor@example.com'))?.role).toBe('editor')
    expect((await userByEmail(env.DB, 'viewer@example.com'))?.role).toBe('viewer')
  })

  it('signs in by magic link and reads the session with its role', async () => {
    const user = await createUser(env.DB, {
      email: 'ann@example.com',
      name: 'Ann',
      role: 'publisher',
    })
    const cookie = await signInByLink('ann@example.com')
    expect((await readSession(env.DB, cookie)) as UserActor).toMatchObject({
      kind: 'user',
      id: user.id,
      role: 'publisher',
      roleFrom: null,
      email: 'ann@example.com',
    })
  })

  it('signs in by a trusted provider: provisions with a grant, then moves it', async () => {
    directory.set('bo@example.com', 'editor')
    const first = await signInByProxy('bo@example.com')
    const bo = await userByEmail(env.DB, 'bo@example.com')
    expect(bo).toMatchObject({ role: 'editor', roleFrom: 'proxy', provider: 'proxy' })
    expect(await grantsOf(bo?.id ?? '')).toEqual([
      { scope_id: '*', role: 'editor', role_from: 'proxy' },
    ])
    expect(((await readSession(env.DB, first)) as UserActor).role).toBe('editor')

    // The directory promotes them: the next sign-in rewrites the grant.
    directory.set('bo@example.com', 'publisher')
    const second = await signInByProxy('bo@example.com')
    expect(await grantsOf(bo?.id ?? '')).toEqual([
      { scope_id: '*', role: 'publisher', role_from: 'proxy' },
    ])
    expect(((await readSession(env.DB, second)) as UserActor).role).toBe('publisher')
  })

  it('lists, creates, patches and deletes users, in the library and over HTTP', async () => {
    const admin = await createUser(env.DB, { email: 'root@example.com', role: 'admin' })
    const cookie = `${SECURE_COOKIE}=${await signInByLink('root@example.com')}`
    const json = { cookie, 'content-type': 'application/json', origin: ORIGIN }

    const created = await call('/folio/api/users', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'cy@example.com', role: 'viewer' }),
    })
    expect(created.status).toBe(201)
    const cy = ((await created.json()) as { user: { id: string; role: string } }).user
    expect(cy.role).toBe('viewer')

    const patched = await call(`/folio/api/users/${cy.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ role: 'editor', name: 'Cy' }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ user: { name: 'Cy', role: 'editor' } })

    const listed = await call('/folio/api/users?count=1', { headers: { cookie } })
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { users: { email: string; role: string }[] }
    expect(body.users.map((u) => [u.email, u.role])).toEqual([
      ['root@example.com', 'admin'],
      ['cy@example.com', 'editor'],
    ])

    // The library directly, for the paths the routes do not reach.
    expect((await updateUser(env.DB, admin.id, { name: 'Root' }))?.role).toBe('admin')
    expect((await listUsers(env.DB, { count: true })).total).toBe(2)
    const removed = await call(`/folio/api/users/${cy.id}`, { method: 'DELETE', headers: json })
    expect(removed.status).toBe(200)
    expect(await grantsOf(cy.id)).toEqual([])
    expect(await deleteUser(env.DB, admin.id)).toBe(true)
    expect(await grantsOf(admin.id)).toEqual([])
  })

  it('resolves a token', async () => {
    const admin = await createUser(env.DB, { email: 'root@example.com', role: 'admin' })
    const minted = await createToken(env.DB, {
      name: 'ci',
      scopes: ['content:read'],
      createdBy: admin.id,
    })
    expect(await readToken(env.DB, minted.token)).toMatchObject({ kind: 'token', name: 'ci' })
  })
})
