import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { blocks, defineBlock, text } from '../../src/core'
import type { ClientMsg, ServerFrame, ServerMsg } from '../../src/core/protocol'
import { PROTOCOL_VERSION } from '../../src/core/protocol'
import type { AuthConfig, MagicLinkMail, Role } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import { createSession } from '../../src/server/auth/session'
import { createToken } from '../../src/server/auth/tokens'
import { createUser } from '../../src/server/auth/users'
import type { StoryDO } from '../../src/server'
import type { VersionMeta } from '../../src/server/versions'
import type { Page } from '../../src/core/pagination'

/**
 * Enforcement: every route's gate, the socket's terminal refusals, and the two
 * structural properties this change could have broken without anybody noticing —
 * the pre-hello quarantine now that every socket has an attachment, and the fact
 * that a revocation costs one D1 read a minute rather than one per keystroke.
 *
 * Its own `createFolio` with providers configured, for the reason auth-login's
 * header comment gives.
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

let outbox: MagicLinkMail[] = []

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [
    magicLink<Cloudflare.Env>({
      send: (_env, mail) => {
        outbox.push(mail)
      },
    }),
  ],
}

function build(mode: AuthConfig<Cloudflare.Env> | 'open' = auth) {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    root: 'page',
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    auth: mode,
    route: (p) => (p ? `/${p}` : '/'),
  })
}

const folio = build()

function call(path: string, init?: RequestInit): Promise<Response> {
  return folio.handle(
    new Request(`${ORIGIN}${path}`, init),
    env,
    createExecutionContext(),
  ) as Promise<Response>
}

/** `handle()` may legitimately answer null (the host's routes win), so the
 * preview tests need the raw answer rather than a coerced Response. */
function raw(path: string, init?: RequestInit): Promise<Response | null> {
  return build().handle(new Request(`${ORIGIN}${path}`, init), env, createExecutionContext())
}

interface ErrorEnvelope {
  error: { code: string; message: string }
}

let storyCounter = 0

async function seedStory(title = 'Home'): Promise<string> {
  const id = `sty_auth${(storyCounter++).toString().padStart(4, '0')}`
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
     values (?, 'page', null, ?, ?, 'a0', ?, ?, ?)`,
  )
    .bind(id, id, id, title, Date.now(), Date.now())
    .run()
  return id
}

/** A signed-in browser: the user row, and the cookie header to send. */
async function signIn(role: Role, email = `${role}@example.com`) {
  // Name derived from the address, so a test that cares about the display name
  // (`ann@example.com` → "Ann") reads without a fourth argument everywhere else.
  const local = email.split('@')[0] ?? role
  const user = await createUser(env.DB, {
    email,
    name: `${local[0]!.toUpperCase()}${local.slice(1)}`,
    role,
  })
  const session = await createSession(env.DB, user.id)
  return { user, session, cookie: `${SECURE_COOKIE}=${session.token}` }
}

beforeEach(async () => {
  outbox = []
  await env.DB.batch([
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from users'),
    env.DB.prepare('delete from versions'),
    env.DB.prepare('delete from stories'),
  ])
})

/* --------------------------------------------------------- the closed door --- */

describe('the editor is closed', () => {
  it('redirects the admin HTML route to the login page, serving no bundle', async () => {
    const id = await seedStory()
    const res = await call(`/folio/edit/${id}`)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `/folio/login?next=${encodeURIComponent(`/folio/edit/${id}`)}`,
    )
    // Nothing was rendered, so nothing about the site leaked either.
    expect(await res.text()).toBe('')
  })

  it('401s the JSON API with the one error envelope', async () => {
    const res = await call('/folio/api/stories')
    expect(res.status).toBe(401)
    expect(await res.json<ErrorEnvelope>()).toEqual({
      error: { code: 'unauthorized', message: 'Sign in to continue.' },
    })
  })

  it('leaves /schema and the public asset route open', async () => {
    // The manifest describes the code, not the content, and the admin bundle
    // needs it before it can render a sign-in prompt of its own.
    expect((await call('/folio/api/schema')).status).toBe(200)
    // A published page's <img> points here: exactly as public as the page.
    const asset = await call('/folio/asset/ast_000000000000-none.png')
    expect(asset.status).not.toBe(401)
    expect(asset.status).not.toBe(403)
  })

  it('hands a preview request back to the host instead of serving a draft', async () => {
    await seedStory()
    await env.DB.prepare("update stories set path = '', slug = ''").run()
    // Returning null rather than 401: to a visitor the flag then means nothing,
    // and the host serves its ordinary published page. This surface lives outside
    // basePath, so the app's own middleware never sees it.
    expect(await raw('/?_folio=preview')).toBeNull()

    const { cookie } = await signIn('viewer')
    const allowed = await raw('/?_folio=preview', { headers: { cookie } })
    expect(allowed?.status).toBe(200)
  })

  it('is entirely open under auth: open, exactly as before this spec', async () => {
    const id = await seedStory()
    const open = build('open')
    const ctx = createExecutionContext()
    const res = await open.handle(new Request(`${API}/stories`), env, ctx)
    expect(res?.status).toBe(200)
    const edit = await open.handle(new Request(`${BASE}/edit/${id}`), env, createExecutionContext())
    expect(edit?.status).toBe(200)
  })
})

/* -------------------------------------------------------------- role gates --- */

describe('role gates', () => {
  it('lets a viewer read and refuses every write', async () => {
    const id = await seedStory()
    const { cookie } = await signIn('viewer')

    expect((await call('/folio/api/stories', { headers: { cookie } })).status).toBe(200)
    expect((await call(`/folio/api/story/${id}/document`, { headers: { cookie } })).status).toBe(
      200,
    )
    expect((await call(`/folio/api/story/${id}/versions`, { headers: { cookie } })).status).toBe(
      200,
    )

    const publish = await call(`/folio/api/story/${id}/publish`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(publish.status).toBe(403)
    const body = await publish.json<ErrorEnvelope>()
    expect(body.error.code).toBe('forbidden')
    // Names the role that would have worked: not guessable from the other end.
    expect(body.error.message).toContain('publisher')
  })

  it('lets an editor edit but not publish, and writes nothing when it refuses', async () => {
    const id = await seedStory()
    const { cookie } = await signIn('editor')

    const res = await call(`/folio/api/story/${id}/publish`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(res.status).toBe(403)

    // No version row and no published snapshot: the refusal is at the door.
    const versions = await call(`/folio/api/story/${id}/versions`, { headers: { cookie } })
    expect((await versions.json<Page<VersionMeta>>()).rows).toEqual([])
    const row = await env.DB.prepare('select published_doc, published_at from stories where id = ?')
      .bind(id)
      .first<{ published_doc: string | null; published_at: number | null }>()
    expect(row?.published_doc).toBeNull()
    expect(row?.published_at).toBeNull()
  })

  // Create split away from the rest at the owner's direction: a new document is
  // an unpublished draft at a path nothing links to yet, so starting one
  // withdraws nothing. Renaming, moving and deleting act on a URL that may
  // already be live, so those stay with the publisher.
  it('lets an editor create a document, since a new draft serves nothing yet', async () => {
    const editor = await signIn('editor')
    const viewer = await signIn('viewer')

    const post = (cookie: string, title: string) =>
      call('/folio/api/stories', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      })
    expect((await post(editor.cookie, 'Editor made this')).status).toBe(200)
    // Still closed to a viewer: `CREATE` is `editor`, not `viewer`.
    expect((await post(viewer.cookie, 'Viewer made this')).status).toBe(403)
  })

  it('reserves delete, move and manual redirects for a publisher', async () => {
    const id = await seedStory()
    const editor = await signIn('editor')
    const publisher = await signIn('publisher')

    const patch = (cookie: string) =>
      call(`/folio/api/stories/${id}`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed' }),
      })
    expect((await patch(editor.cookie)).status).toBe(403)
    expect((await patch(publisher.cookie)).status).toBe(200)

    expect(
      (
        await call(`/folio/api/stories/${id}`, {
          method: 'DELETE',
          headers: { cookie: editor.cookie },
        })
      ).status,
    ).toBe(403)
  })

  it('publishes as a publisher and records their own user id, not a header', async () => {
    const id = await seedStory()
    const { user, cookie } = await signIn('publisher')

    const res = await call(`/folio/api/story/${id}/publish`, {
      method: 'POST',
      // Ignored: the header is gone, and this is what "cannot be spoofed" means.
      headers: { cookie, 'x-folio-actor': 'somebody-else' },
    })
    expect(res.status).toBe(200)

    const versions = await (
      await call(`/folio/api/story/${id}/versions`, { headers: { cookie } })
    ).json<Page<VersionMeta>>()
    expect(versions.rows[0]?.actor).toBe(user.id)
  })

  it('reserves the access surface for an admin, and 404s it when auth is open', async () => {
    const publisher = await signIn('publisher')
    const admin = await signIn('admin')

    expect((await call('/folio/api/users', { headers: { cookie: publisher.cookie } })).status).toBe(
      403,
    )
    expect((await call('/folio/api/users', { headers: { cookie: admin.cookie } })).status).toBe(200)
    expect((await call('/folio/api/tokens', { headers: { cookie: admin.cookie } })).status).toBe(
      200,
    )

    // Under `auth: 'open'` there is no admin and no way to become one, so the
    // surface does not exist rather than standing wide open.
    const open = await build('open').handle(
      new Request(`${API}/users`),
      env,
      createExecutionContext(),
    )
    expect(open?.status).toBe(404)
  })

  it('refuses an admin removing their own account', async () => {
    const admin = await signIn('admin')
    const res = await call(`/folio/api/users/${admin.user.id}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie },
    })
    // The one delete that can leave a site with no way to manage access at all.
    expect(res.status).toBe(409)
  })

  it('signs a user out of every browser when their role changes', async () => {
    const admin = await signIn('admin')
    const target = await signIn('editor')

    const res = await call(`/folio/api/users/${target.user.id}`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(res.status).toBe(200)
    // A downgrade an admin just made deliberately must not sit in an open
    // socket's attachment for the bounded window a revocation may.
    expect((await call('/folio/api/stories', { headers: { cookie: target.cookie } })).status).toBe(
      401,
    )
  })
})

/* ------------------------------------------------------------------ tokens --- */

describe('api tokens', () => {
  it('reads with a read scope and is refused a write, by name', async () => {
    await seedStory()
    const { token } = await createToken(env.DB, { name: 'importer', scopes: ['content:read'] })
    const headers = { authorization: `Bearer ${token}` }

    expect((await call('/folio/api/stories', { headers })).status).toBe(200)

    const res = await call('/folio/api/stories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'From a script' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json<ErrorEnvelope>()).error.message).toContain("'content:write'")
  })

  it('stamps last_used_at even on the request it refuses', async () => {
    const { row, token } = await createToken(env.DB, { name: 'importer', scopes: ['content:read'] })
    await call('/folio/api/stories', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    const after = await env.DB.prepare('select last_used_at from api_tokens where id = ?')
      .bind(row.id)
      .first<{ last_used_at: number | null }>()
    // The column answers "is this credential in use", not "did it succeed".
    expect(after?.last_used_at).toBeTypeOf('number')
  })

  it('401s a revoked token: a credential that no longer exists, not a missing scope', async () => {
    const { row, token } = await createToken(env.DB, { name: 'importer', scopes: ['admin'] })
    await env.DB.prepare('update api_tokens set revoked_at = ? where id = ?')
      .bind(Date.now(), row.id)
      .run()

    const res = await call('/folio/api/stories', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('mints a token exactly once, and never hands the value back afterwards', async () => {
    const admin = await signIn('admin')
    const created = await call('/folio/api/tokens', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'import-script', scopes: ['content:read', 'content:write'] }),
    })
    expect(created.status).toBe(201)
    const body = await created.json<{ token: string; row: { id: string; scopes: string[] } }>()
    expect(body.token).toMatch(/^folio_[0-9a-f]{64}$/)
    expect(body.row.scopes).toEqual(['content:read', 'content:write'])

    const listed = await (
      await call('/folio/api/tokens', { headers: { cookie: admin.cookie } })
    ).text()
    // Only the hash exists after this point; there is nothing to leak.
    expect(listed).not.toContain(body.token)
  })

  it('refuses a scope that does not exist rather than quietly dropping it', async () => {
    const admin = await signIn('admin')
    const res = await call('/folio/api/tokens', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', scopes: ['content:destroy'] }),
    })
    expect(res.status).toBe(400)
  })
})

/* ------------------------------------------------------------------ origin --- */

describe('the origin check', () => {
  it('refuses a cookie-authenticated mutation from another origin', async () => {
    const id = await seedStory()
    const { cookie } = await signIn('publisher')

    const res = await call(`/folio/api/story/${id}/publish`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    expect((await res.json<ErrorEnvelope>()).error.message).toContain('another site')
  })

  it('allows the worker’s own origin, and any request with no Origin at all', async () => {
    const id = await seedStory()
    const { cookie } = await signIn('publisher')

    expect(
      (
        await call(`/folio/api/story/${id}/publish`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN },
        })
      ).status,
    ).toBe(200)
    // No Origin means curl, a script or a server: none of which can be tricked
    // into replaying somebody's cookie.
    expect(
      (await call(`/folio/api/story/${id}/publish`, { method: 'POST', headers: { cookie } }))
        .status,
    ).toBe(200)
  })

  it('leaves a bearer-token mutation alone: a token is not an ambient credential', async () => {
    const { token } = await createToken(env.DB, { name: 'importer', scopes: ['content:write'] })
    const res = await call('/folio/api/stories', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        origin: 'https://someone-elses-tool.example',
      },
      body: JSON.stringify({ title: 'From a browser tool' }),
    })
    expect(res.status).toBe(200)
  })
})

/* ------------------------------------------------------------- the sockets --- */

interface Peer {
  ws: WebSocket
  inbox: ServerMsg[]
  closes: { code: number; reason: string }[]
  send(msg: ClientMsg): void
}

async function openSocket(id: string, headers: Record<string, string> = {}) {
  const res = await call(`/folio/api/story/${id}/socket`, {
    headers: { Upgrade: 'websocket', ...headers },
  })
  expect(res.status).toBe(101)
  const ws = res.webSocket
  if (!ws) throw new Error('the upgrade returned no socket')
  ws.accept()
  const peer: Peer = {
    ws,
    inbox: [],
    closes: [],
    send: (msg) => ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION })),
  }
  ws.addEventListener('message', (event) => {
    const { v: _v, ...msg } = JSON.parse(event.data as string) as ServerFrame
    peer.inbox.push(msg as ServerMsg)
  })
  ws.addEventListener('close', (event) => {
    peer.closes.push({ code: event.code, reason: event.reason })
  })
  return peer
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

async function settle() {
  for (let i = 0; i < 30; i++) await tick()
}

async function frame<T extends ServerMsg['type']>(
  peer: Peer,
  type: T,
  nth = 1,
): Promise<Extract<ServerMsg, { type: T }>> {
  for (let i = 0; i < 300; i++) {
    const hits = peer.inbox.filter((f) => f.type === type)
    if (hits.length >= nth) return hits[nth - 1] as Extract<ServerMsg, { type: T }>
    await tick()
  }
  throw new Error(`no '${type}' frame arrived; saw: ${peer.inbox.map((f) => f.type).join(', ')}`)
}

async function closeCode(peer: Peer): Promise<number> {
  for (let i = 0; i < 300; i++) {
    if (peer.closes.length > 0) return peer.closes[0]!.code
    await tick()
  }
  throw new Error('the socket never closed')
}

const setTitle = (uid: string, value: string): Extract<ClientMsg, { type: 'tx' }>['mutations'] => [
  { t: 'set', uid, field: 'title', value },
]

const stubFor = (id: string) =>
  env.STORY.get(env.STORY.idFromName(id)) as DurableObjectStub<StoryDO>

/** Reaches into one socket's attachment. The only way to exercise the bounded
 * re-check without a test that waits a minute. */
async function editAttachment(id: string, patch: Record<string, unknown>) {
  await runInDurableObject(stubFor(id), (_instance, state) => {
    for (const socket of state.getWebSockets()) {
      const current = socket.deserializeAttachment() as Record<string, unknown> | null
      if (current) socket.serializeAttachment({ ...current, ...patch })
    }
  })
}

describe('the sync socket', () => {
  it('upgrades and closes 4003 with no session, rather than failing the handshake', async () => {
    const id = await seedStory()
    const peer = await openSocket(id)
    // A failed upgrade is indistinguishable on the wire from a dropped
    // connection, so the client would reconnect on a backoff forever.
    expect(await closeCode(peer)).toBe(4003)
  })

  it('closes 4004 for an API token: a script is not an editing session', async () => {
    const id = await seedStory()
    const { token } = await createToken(env.DB, { name: 'importer', scopes: ['admin'] })
    const peer = await openSocket(id, { authorization: `Bearer ${token}` })
    expect(await closeCode(peer)).toBe(4004)
  })

  it('gives a viewer a socket, read-only', async () => {
    const id = await seedStory()
    const { cookie } = await signIn('viewer')
    const peer = await openSocket(id, { cookie })

    peer.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'x', name: 'x', colour: '#000000' },
    })
    const boot = await frame(peer, 'bootstrap')

    peer.send({ type: 'tx', txId: 'v1', mutations: setTitle(boot.doc.root, 'Nope') })
    const reject = await frame(peer, 'reject')
    expect(reject).toEqual({
      type: 'reject',
      txId: 'v1',
      reason: 'read-only: your role may not edit',
    })
    // Nothing logged: the refusal is at the door, exactly like an invalid
    // mutation, and the client's own `reject` handling drops the tx.
    expect((await runInDurableObject(stubFor(id), (o) => o.recent())).rows).toEqual([])
    peer.ws.close()
  })

  it('cannot have its identity asserted by the client', async () => {
    const id = await seedStory()
    const ann = await signIn('editor', 'ann@example.com')
    const bo = await signIn('publisher', 'bo@example.com')

    const annSocket = await openSocket(id, { cookie: ann.cookie })
    annSocket.send({
      type: 'hello',
      lastSyncId: 0,
      // A lie, in every field the frame still offers. At v3 that is one optional
      // nested object, and a vouched-for socket never reads it.
      identity: { actor: 'usr_bo_pretending', name: 'Bo', colour: '#000000' },
    })
    const boot = await frame(annSocket, 'bootstrap')

    const watcher = await openSocket(id, { cookie: bo.cookie })
    watcher.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'w', name: 'w', colour: '#ffffff' },
    })
    const watching = await frame(watcher, 'bootstrap')

    // Presence carries Ann's own row, not what her client claimed.
    expect(watching.peers).toEqual([
      {
        actor: ann.user.id,
        name: 'Ann',
        colour: expect.any(String),
        selection: null,
        locale: null,
      },
    ])

    annSocket.send({ type: 'tx', txId: 'a1', mutations: setTitle(boot.doc.root, 'Ann was here') })
    await frame(annSocket, 'delta')

    const trail = (await runInDurableObject(stubFor(id), (o) => o.recent())).rows
    expect(trail[0]).toMatchObject({ actor: ann.user.id, actorName: 'Ann' })
    annSocket.ws.close()
    watcher.ws.close()
  })

  it('keeps the pre-hello quarantine even though every socket now has an attachment', async () => {
    // The trap this spec calls out. `broadcast` used "has an attachment" as its
    // membership test; attaching a verified identity at upgrade time makes that
    // test true for every socket, so a `joined` flag is what still withholds a
    // delta from a socket with no watermark to place it against.
    const id = await seedStory()
    const ann = await signIn('editor', 'ann@example.com')
    const lurkerAuth = await signIn('editor', 'lurk@example.com')

    const writer = await openSocket(id, { cookie: ann.cookie })
    writer.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'a', name: 'a', colour: '#ff00ff' },
    })
    const boot = await frame(writer, 'bootstrap')

    // Upgraded with a perfectly good session — so it *has* an attachment — and
    // has deliberately not said hello.
    const lurker = await openSocket(id, { cookie: lurkerAuth.cookie })

    writer.send({ type: 'tx', txId: 'q1', mutations: setTitle(boot.doc.root, 'Quarantined') })
    await frame(writer, 'delta')
    await settle()

    expect(lurker.inbox).toEqual([])
    // And it is not in anybody's peer list either, for the same reason.
    const third = await openSocket(id, { cookie: ann.cookie })
    third.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'c', name: 'c', colour: '#00ffff' },
    })
    expect((await frame(third, 'bootstrap')).peers).toHaveLength(1)

    // Once it joins, it gets a bootstrap and every delta from then on.
    lurker.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'l', name: 'l', colour: '#00ff00' },
    })
    expect((await frame(lurker, 'bootstrap')).syncId).toBe(1)
    writer.send({ type: 'tx', txId: 'q2', mutations: setTitle(boot.doc.root, 'Now visible') })
    expect((await frame(lurker, 'delta')).txId).toBe('q2')

    writer.ws.close()
    lurker.ws.close()
    third.ws.close()
  })

  it('never leaks the role or the session onto a presence frame', async () => {
    const id = await seedStory()
    const ann = await signIn('admin', 'ann@example.com')
    const bo = await signIn('editor', 'bo@example.com')

    const first = await openSocket(id, { cookie: ann.cookie })
    first.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'a', name: 'a', colour: '#ff00ff' },
    })
    await frame(first, 'bootstrap')
    const second = await openSocket(id, { cookie: bo.cookie })
    second.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'b', name: 'b', colour: '#00ffff' },
    })
    await frame(second, 'bootstrap')

    const presence = await frame(first, 'presence')
    // The attachment now holds role, session id and expiry; presence used to be a
    // spread of it.
    expect(Object.keys(presence.peer).sort()).toEqual([
      'actor',
      'colour',
      'locale',
      'name',
      'selection',
    ])
    first.ws.close()
    second.ws.close()
  })

  it('closes 4003 when the session expiry in the attachment has passed', async () => {
    const id = await seedStory()
    const { cookie } = await signIn('editor')
    const peer = await openSocket(id, { cookie })
    peer.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'a', name: 'a', colour: '#ff00ff' },
    })
    const boot = await frame(peer, 'bootstrap')

    // The expiry rides in the attachment and is checked on every frame, which
    // costs nothing (checkpoint 5).
    await editAttachment(id, { expiresAt: Date.now() - 1000 })
    peer.send({ type: 'tx', txId: 'x1', mutations: setTitle(boot.doc.root, 'Too late') })

    expect(await closeCode(peer)).toBe(4003)
    expect((await runInDurableObject(stubFor(id), (o) => o.recent())).rows).toEqual([])
  })

  it('picks up an explicit revocation at the next re-check, and not before', async () => {
    const id = await seedStory()
    const { session, cookie } = await signIn('editor')
    const peer = await openSocket(id, { cookie })
    peer.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'a', name: 'a', colour: '#ff00ff' },
    })
    const boot = await frame(peer, 'bootstrap')

    await env.DB.prepare('delete from sessions where id = ?').bind(session.id).run()

    // Inside the window: the socket keeps working, because there is deliberately
    // no D1 read in the keystroke path. This is the cost checkpoint 5 accepts,
    // and asserting it is what stops the recheck from silently becoming
    // per-frame.
    peer.send({ type: 'tx', txId: 'r1', mutations: setTitle(boot.doc.root, 'Still typing') })
    expect((await frame(peer, 'delta')).txId).toBe('r1')

    // Past the window, simulated by ageing the attachment's own last-checked
    // stamp rather than by a test that waits a minute.
    await editAttachment(id, { checkedAt: 0 })
    peer.send({ type: 'tx', txId: 'r2', mutations: setTitle(boot.doc.root, 'And now not') })
    expect(await closeCode(peer)).toBe(4003)

    // What they had already logged stays, attributed to them.
    const trail = (await runInDurableObject(stubFor(id), (o) => o.recent())).rows
    expect(trail.map((e) => e.syncId)).toEqual([1])
  })

  it('re-checks a session that is still live and carries on, refreshing the stamp', async () => {
    // The other half of the test above: a due re-check that finds the session
    // healthy must be invisible. Getting this wrong the other way — closing on a
    // successful check — would log everyone out once a minute.
    const id = await seedStory()
    const { cookie } = await signIn('editor')
    const peer = await openSocket(id, { cookie })
    peer.send({
      type: 'hello',
      lastSyncId: 0,
      identity: { actor: 'a', name: 'a', colour: '#ff00ff' },
    })
    const boot = await frame(peer, 'bootstrap')

    await editAttachment(id, { checkedAt: 0 })
    peer.send({ type: 'tx', txId: 'k1', mutations: setTitle(boot.doc.root, 'Fine') })
    expect((await frame(peer, 'delta')).txId).toBe('k1')

    // Stamped forward, so the next keystroke does not read D1 again.
    const checked = await runInDurableObject(stubFor(id), (_o, state) => {
      const socket = state.getWebSockets()[0]!
      return (socket.deserializeAttachment() as { checkedAt: number }).checkedAt
    })
    expect(checked).toBeGreaterThan(0)
    peer.ws.close()
  })

  it('is wide open under auth: open, with hello still supplying the identity', async () => {
    const id = await seedStory()
    const open = build('open')
    const res = (await open.handle(
      new Request(`${API}/story/${id}/socket`, { headers: { Upgrade: 'websocket' } }),
      env,
      createExecutionContext(),
    )) as Response
    const ws = res.webSocket!
    ws.accept()
    const inbox: ServerMsg[] = []
    ws.addEventListener('message', (e) => {
      const { v: _v, ...msg } = JSON.parse(e.data as string) as ServerFrame
      inbox.push(msg as ServerMsg)
    })
    ws.send(
      JSON.stringify({
        type: 'hello',
        lastSyncId: 0,
        identity: { actor: 'self-reported', name: 'Anon', colour: '#123456' },
        v: PROTOCOL_VERSION,
      }),
    )
    for (let i = 0; i < 300 && inbox.length === 0; i++) await tick()
    expect(inbox[0]?.type).toBe('bootstrap')

    ws.send(
      JSON.stringify({
        type: 'tx',
        txId: 'o1',
        mutations: setTitle(
          (inbox[0] as Extract<ServerMsg, { type: 'bootstrap' }>).doc.root,
          'Open',
        ),
        v: PROTOCOL_VERSION,
      }),
    )
    for (let i = 0; i < 300 && !inbox.some((f) => f.type === 'delta'); i++) await tick()
    const trail = (await runInDurableObject(stubFor(id), (o) => o.recent())).rows
    // Advisory identity is still the only identity there is here.
    expect(trail[0]).toMatchObject({ actor: 'self-reported', actorName: 'Anon' })
    ws.close()
  })
})
