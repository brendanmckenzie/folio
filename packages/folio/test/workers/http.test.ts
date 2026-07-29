import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { diff } from '../../src/core/diff'
import type { Doc } from '../../src/core/doc'
import type { Mutation } from '../../src/core/mutations'
import {
  type ActivityEntry,
  type ClientMsg,
  PROTOCOL_VERSION,
  type ServerMsg,
} from '../../src/core/protocol'
import type { StoryMeta, StoryNode } from '../../src/core/story'
import type { AssetRow } from '../../src/server/assets'
import type { Redirect } from '../../src/server/redirects'
import type { VersionMeta } from '../../src/server/versions'
import { applySeedFixture } from './seed-fixture'

/**
 * Integration tests over the real HTTP surface, dispatched through
 * test/workers/worker.ts (extended there with a tiny block registry just for
 * this file — see its comments). `SELF.fetch` calls straight into that
 * Worker's own `fetch`, including the story sync WebSocket: a 101 upgrade
 * response comes back with a genuine `webSocket`, the same as it would for a
 * browser, with no real network involved.
 *
 * Ported from scripts/history-test.mjs (versions) and scripts/fields-test.mjs
 * (stories, publish, rename-follows-link), which exercise the same surface
 * against a live `wrangler dev`. Only the load-bearing assertions are kept
 * here; see those scripts for the fuller picture, including field types this
 * suite does not touch.
 */

const ORIGIN = 'https://example.com'
const API = `${ORIGIN}/folio`

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json<T>()
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await SELF.fetch(`${ORIGIN}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json<T>()
}

async function getJson<T>(path: string): Promise<T> {
  return (await SELF.fetch(`${ORIGIN}${path}`)).json<T>()
}

async function htmlOf(path: string): Promise<string> {
  return (await SELF.fetch(`${ORIGIN}${path}`)).text()
}

function createStory(title: string, parentId?: string): Promise<StoryMeta> {
  return postJson<StoryMeta>('/folio/stories', { title, parentId })
}

interface ErrorEnvelope {
  error: { code: string; message: string }
}

/** Status, the parsed envelope, and the raw text a client would actually see. */
async function failureOf(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; text: string; body: ErrorEnvelope }> {
  const res = await SELF.fetch(`${ORIGIN}${path}`, init)
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as ErrorEnvelope }
}

const jsonPost = (body: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
})

function flatten(nodes: readonly StoryNode[]): StoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)])
}

interface PublishResult {
  ok: boolean
  publishedAt: number
  version: VersionMeta
}

async function publish(storyId: string): Promise<PublishResult> {
  const res = await SELF.fetch(`${API}/story/${storyId}/publish`, { method: 'POST' })
  return res.json<PublishResult>()
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Socket {
  ws: WebSocket
  hello(actor: string): Promise<Doc>
  tx(txId: string, mutations: Mutation[]): Promise<void>
  close(): void
}

/**
 * Opens a real WebSocket to a story's sync endpoint, the same upgrade a
 * browser performs against `/folio/story/:id/socket`. `SELF.fetch` dispatches
 * straight into this pool's Worker, so the 101 response carries a live
 * `webSocket`; `.accept()` starts it flowing, exactly as it would for any
 * Worker-to-Worker upgrade.
 *
 * This is the only way to mutate a story's draft: `StoryDO` exposes nothing
 * over RPC that applies a transaction, by design (see story-do.ts) — the
 * socket is the one path a mutation can arrive by.
 */
async function connect(storyId: string): Promise<Socket> {
  const res = await SELF.fetch(`${API}/story/${storyId}/socket`, {
    headers: { Upgrade: 'websocket' },
  })
  if (!res.webSocket) throw new Error(`Expected a websocket upgrade, got ${res.status}`)
  const ws = res.webSocket
  ws.accept()

  const inbox: ServerMsg[] = []
  const waiters: { match: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []
  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data as string) as ServerMsg
    inbox.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiting = waiters[i]!
      if (waiting.match(msg)) {
        waiters.splice(i, 1)
        waiting.resolve(msg)
      }
    }
  })

  function expectMsg<M extends ServerMsg>(match: (m: ServerMsg) => m is M, ms = 5000): Promise<M> {
    const hit = inbox.find(match)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      waiters.push({
        match: match as (m: ServerMsg) => boolean,
        resolve: resolve as (m: ServerMsg) => void,
      })
      setTimeout(() => reject(new Error('timed out waiting for a socket message')), ms)
    })
  }

  return {
    ws,
    async hello(actor) {
      const msg: ClientMsg = { type: 'hello', actor, name: actor, colour: '#000', lastSyncId: 0 }
      // The object refuses a handshake that does not name the wire version.
      ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION }))
      const reply = await expectMsg(
        (m): m is Extract<ServerMsg, { type: 'bootstrap' }> => m.type === 'bootstrap',
      )
      return reply.doc
    },
    async tx(txId, mutations) {
      const msg: ClientMsg = { type: 'tx', txId, mutations }
      // The object refuses any frame that omits the wire version, not only `hello`.
      ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION }))
      await expectMsg(
        (m): m is Extract<ServerMsg, { type: 'delta' }> => m.type === 'delta' && m.txId === txId,
      )
    },
    close() {
      ws.close()
    },
  }
}

/**
 * Migrations (packages/folio/migrations/**) are structure only — no seed
 * rows, unlike the old drop-and-reseed schema.sql — so this suite seeds its
 * own fixture once, up front, by running the actual examples/demo/seed.sql
 * (see seed-fixture.ts) rather than a hand-typed insert that could drift from
 * it. Every test below assumes this exact tree: the root story ('sty_home',
 * path '') and a top-level sibling at 'about', so a story created under the
 * root that also derives the slug 'about' collides with a *different* branch
 * than `uniqueSlug` checks (see the path-collision test), the same scenario
 * schema.sql used to set up.
 */
beforeAll(async () => {
  await applySeedFixture(env.DB)
})

describe('stories: CRUD over /folio/stories', () => {
  it('creates a story with a slug derived from the title and resolved urls', async () => {
    const story = await createStory('CRUD Parent')

    expect(story.slug).toBe('crud-parent')
    expect(story.path).toBe('crud-parent')
    expect(story.url).toBe('/crud-parent')
    expect(story.previewUrl).toBe('/crud-parent?_folio=preview')
  })

  it('rejects a story with no title', async () => {
    const res = await SELF.fetch(`${API}/stories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })

  it('lists every story in the tree, seeded and created', async () => {
    const tree = await getJson<StoryNode[]>('/folio/stories')
    const flat = flatten(tree)

    expect(flat.some((n) => n.id === 'sty_home')).toBe(true)
    expect(flat.some((n) => n.slug === 'crud-parent')).toBe(true)
  })

  it('renames a story: title, slug and path move together', async () => {
    const created = await createStory('Rename Before')

    const renamed = await patchJson<StoryMeta>(`/folio/stories/${created.id}`, {
      title: 'Rename After',
      slug: 'rename-after',
    })

    expect(renamed.title).toBe('Rename After')
    expect(renamed.slug).toBe('rename-after')
    expect(renamed.path).toBe('rename-after')
  })

  it('deletes a story and every descendant beneath it', async () => {
    const parent = await createStory('Delete Parent')
    const child = await createStory('Delete Child', parent.id)

    const res = await SELF.fetch(`${API}/stories/${parent.id}`, { method: 'DELETE' })
    const body = await res.json<{ deleted: string[] }>()

    expect(new Set(body.deleted)).toEqual(new Set([parent.id, child.id]))

    const tree = await getJson<StoryNode[]>('/folio/stories')
    expect(flatten(tree).some((n) => n.id === parent.id)).toBe(false)
  })

  it('purges the Durable Object on delete, so a reused id reseeds blank instead of resurrecting the old draft', async () => {
    const story = await createStory('Delete And Resurrect')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('resurrect1', [
      { t: 'set', uid: doc.root, field: 'title', value: 'About to be deleted' },
    ])
    conn.close()

    const res = await SELF.fetch(`${API}/stories/${story.id}`, { method: 'DELETE' })
    expect((await res.json<{ deleted: string[] }>()).deleted).toContain(story.id)

    // Bypasses the route (which now 404s: D1 no longer knows this id) to reach
    // the object directly, exactly as a stale or reused id eventually would.
    // Without the purge, this finds the row `getOrInit` wrote before the
    // delete and returns the edited title instead of the fresh seed.
    const freshSeed: Doc = {
      root: 'reseeded0',
      bloks: {
        reseeded0: {
          uid: 'reseeded0',
          type: 'page',
          parent: null,
          slot: null,
          order: 'a0',
          data: { title: 'Fresh Seed' },
        },
      },
    }
    const stub = env.STORY.get(env.STORY.idFromName(story.id))
    const blank = await runInDurableObject(stub, (instance) => instance.getOrInit(freshSeed))
    expect(blank).toEqual(freshSeed)
  })
})

describe('purge races a live editor', () => {
  it('closes an already-open editing session on delete, and a fresh connection afterwards gets the same terminal close instead of a 404 that would loop forever', async () => {
    const story = await createStory('Purged While Editing')
    const conn = await connect(story.id)
    await conn.hello('alice')

    const closes: number[] = []
    conn.ws.addEventListener('close', (event) => {
      closes.push(event.code)
    })

    const res = await SELF.fetch(`${API}/stories/${story.id}`, { method: 'DELETE' })
    expect((await res.json<{ deleted: string[] }>()).deleted).toContain(story.id)

    await wait(50)
    // 4002: the same application close code story-do.ts's purge() uses.
    expect(closes).toEqual([4002])

    // The socket route upgrades even for a story D1 no longer has, closing
    // with that same code rather than 404ing the upgrade: a plain 404 is
    // indistinguishable on the wire from a dropped connection, and a client
    // would reconnect on a backoff against an id that can never come back.
    const retry = await SELF.fetch(`${API}/story/${story.id}/socket`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(retry.status).toBe(101)
    const retryWs = retry.webSocket!
    retryWs.accept()
    const retryCloses: number[] = []
    retryWs.addEventListener('close', (event) => {
      retryCloses.push(event.code)
    })

    await wait(50)
    expect(retryCloses).toEqual([4002])
  })
})

describe('publish', () => {
  it('writes a version and published_doc; the live page renders it and ships no script', async () => {
    const story = await createStory('Publish Target')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('t1', [{ t: 'set', uid: doc.root, field: 'title', value: 'Published Title' }])

    const pub = await publish(story.id)
    expect(pub.ok).toBe(true)
    expect(pub.version.kind).toBe('publish')
    expect(pub.version.title).toBe('Published Title')

    const html = await htmlOf(`/${story.path}`)
    expect(html).toContain('Published Title')
    expect(html).not.toContain('<script')

    conn.close()
  })
})

interface UnpublishResult {
  ok: boolean
  unpublishedAt: number
}

async function unpublish(storyId: string): Promise<UnpublishResult> {
  const res = await SELF.fetch(`${API}/story/${storyId}/unpublish`, { method: 'POST' })
  return res.json<UnpublishResult>()
}

async function stateOf(storyId: string): Promise<string | undefined> {
  const tree = await getJson<StoryNode[]>('/folio/stories')
  return flatten(tree).find((n) => n.id === storyId)?.state
}

describe('unpublish', () => {
  it('takes a page down and keeps the draft, its history and its edits intact', async () => {
    const story = await createStory('Offer')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('u1', [{ t: 'set', uid: doc.root, field: 'title', value: 'The Offer' }])
    const pub = await publish(story.id)
    expect((await SELF.fetch(`${ORIGIN}/${story.path}`)).status).not.toBe(404)
    expect(await stateOf(story.id)).toBe('live')

    const res = await unpublish(story.id)
    expect(res.ok).toBe(true)
    expect(res.unpublishedAt).toBeGreaterThan(0)

    const gone = await SELF.fetch(`${ORIGIN}/${story.path}`)
    expect(gone.status).toBe(404)
    expect(await stateOf(story.id)).toBe('unpublished')

    // The draft is byte-unchanged and still editable/previewable.
    const stored = await getJson<{ doc: Doc }>(`/folio/story/${story.id}/document`)
    expect(stored.doc.bloks[doc.root]?.data.title).toBe('The Offer')
    const preview = await htmlOf(story.previewUrl!)
    expect(preview).toContain('The Offer')

    // Version history survives.
    const versions = await getJson<VersionMeta[]>(`/folio/story/${story.id}/versions`)
    expect(versions.some((v) => v.id === pub.version.id)).toBe(true)

    conn.close()
  })

  it('is idempotent: a second call answers 200 with the original timestamp', async () => {
    const story = await createStory('Double Unpublish')
    await publish(story.id)

    const first = await unpublish(story.id)
    const second = await unpublish(story.id)

    expect(second.ok).toBe(true)
    expect(second.unpublishedAt).toBe(first.unpublishedAt)
  })

  it('404s for an unknown story', async () => {
    const { status, body } = await failureOf(`/folio/story/sty_nope/unpublish`, {
      method: 'POST',
    })
    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })

  it('republishing afterwards is an ordinary publish: history gains a second version and the page serves again', async () => {
    const story = await createStory('Republish Target')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('r1', [{ t: 'set', uid: doc.root, field: 'title', value: 'First' }])
    await publish(story.id)
    await unpublish(story.id)
    expect(await stateOf(story.id)).toBe('unpublished')

    await conn.tx('r2', [{ t: 'set', uid: doc.root, field: 'title', value: 'Second' }])
    const pub2 = await publish(story.id)
    expect(pub2.ok).toBe(true)

    expect(await stateOf(story.id)).toBe('live')
    const html = await htmlOf(`/${story.path}`)
    expect(html).toContain('Second')

    const versions = await getJson<VersionMeta[]>(`/folio/story/${story.id}/versions`)
    expect(versions.length).toBeGreaterThanOrEqual(2)

    conn.close()
  })

  it('names descendants without cascading: unpublishing a parent leaves its published children live', async () => {
    const parent = await createStory('Section')
    const childA = await createStory('Section Child A', parent.id)
    const childB = await createStory('Section Child B', parent.id)
    await publish(parent.id)
    await publish(childA.id)
    await publish(childB.id)

    await unpublish(parent.id)

    expect((await SELF.fetch(`${ORIGIN}/${parent.path}`)).status).toBe(404)
    expect((await SELF.fetch(`${ORIGIN}/${childA.path}`)).status).not.toBe(404)
    expect((await SELF.fetch(`${ORIGIN}/${childB.path}`)).status).not.toBe(404)
  })

  it('the root story can be unpublished: "/" 404s, but it stays editable and delete is still refused', async () => {
    const conn = await connect('sty_home')
    const doc = await conn.hello('alice')
    await conn.tx('root1', [{ t: 'set', uid: doc.root, field: 'title', value: 'Root Home' }])
    await publish('sty_home')
    expect((await SELF.fetch(`${ORIGIN}/`)).status).not.toBe(404)

    await unpublish('sty_home')
    expect((await SELF.fetch(`${ORIGIN}/`)).status).toBe(404)

    // Still editable.
    const stored = await getJson<{ doc: Doc }>(`/folio/story/sty_home/document`)
    expect(stored.doc.bloks[doc.root]?.data.title).toBe('Root Home')

    // Delete is still refused, as today — unpublish is not delete.
    const del = await failureOf('/folio/stories/sty_home', { method: 'DELETE' })
    expect(del.status).toBe(409)

    conn.close()
  })
})

describe('versions and restore', () => {
  it('publishing twice keeps both versions, newest first, with no doc payload in the list', async () => {
    const story = await createStory('Versioned Story')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')

    await conn.tx('v1', [{ t: 'set', uid: doc.root, field: 'title', value: 'Version One' }])
    const pub1 = await publish(story.id)

    // created_at is millisecond resolution and ties fall back to sorting by a
    // random version id (see versions.ts), so give the two publishes a real
    // gap: otherwise "newest first" would be asserting a coin flip.
    await wait(5)

    await conn.tx('v2', [{ t: 'set', uid: doc.root, field: 'title', value: 'Version Two' }])
    const pub2 = await publish(story.id)

    const list = await getJson<Array<VersionMeta & { doc?: unknown }>>(
      `/folio/story/${story.id}/versions`,
    )

    expect(list[0]?.id).toBe(pub2.version.id)
    expect(list.some((v) => v.id === pub1.version.id)).toBe(true)
    expect(list.every((v) => v.doc === undefined)).toBe(true)

    conn.close()
  })

  it('restoring an old version replays it as mutations, and the activity trail reflects it', async () => {
    const story = await createStory('Restorable Story')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    const root = doc.root

    await conn.tx('r1', [{ t: 'set', uid: root, field: 'title', value: 'First' }])
    const checkpoint = await postJson<VersionMeta>(`/folio/story/${story.id}/versions`, {
      label: 'first',
      actor: 'alice',
    })

    await conn.tx('r2', [{ t: 'set', uid: root, field: 'title', value: 'Second' }])

    const { doc: target } = await getJson<{ doc: Doc }>(`/folio/versions/${checkpoint.id}`)
    const probe = await connect(story.id)
    const current = await probe.hello('bob')
    probe.close()

    // Restoring is diffed against the live draft rather than overwriting it,
    // so a restore is itself an ordinary, undoable transaction — the same
    // thing admin/store.ts does when a user clicks "restore".
    const mutations = diff(current, target)
    expect(mutations).toEqual([{ t: 'set', uid: root, field: 'title', value: 'First' }])

    await conn.tx('r3', mutations)

    const after = await connect(story.id)
    const restored = await after.hello('probe')
    after.close()
    expect(restored.bloks[root]?.data.title).toBe('First')

    const activity = await getJson<ActivityEntry[]>(`/folio/story/${story.id}/activity`)
    expect(activity[0]!.syncId).toBeGreaterThan(activity.at(-1)!.syncId)
    expect(
      activity.some((e) =>
        e.mutations.some((m) => m.t === 'set' && m.field === 'title' && m.value === 'First'),
      ),
    ).toBe(true)

    conn.close()
  })
})

describe('activity', () => {
  it('clamps a non-numeric limit to the default instead of binding NaN', async () => {
    const story = await createStory('Activity Limit')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('act1', [{ t: 'set', uid: doc.root, field: 'title', value: 'Active' }])
    conn.close()

    const res = await SELF.fetch(`${API}/story/${story.id}/activity?limit=not-a-number`)
    expect(res.status).toBe(200)

    const activity = await res.json<ActivityEntry[]>()
    expect(activity.length).toBeGreaterThan(0)
  })
})

describe('rename updates links', () => {
  it('renaming a story updates the href of every link that points at it by id', async () => {
    const target = await createStory('Link Target')
    const source = await createStory('Link Source')

    const conn = await connect(source.id)
    const doc = await conn.hello('alice')
    await conn.tx('link1', [
      {
        t: 'insert',
        blok: {
          uid: 'linkblok1',
          type: 'link',
          parent: doc.root,
          slot: 'body',
          order: 'a0',
          data: { label: 'Go', href: { kind: 'story', id: target.id } },
        },
      },
    ])

    const before = await htmlOf(source.previewUrl!)
    expect(before).toContain(`href="${target.url}"`)

    const renamed = await patchJson<StoryMeta>(`/folio/stories/${target.id}`, {
      slug: 'renamed-target',
    })

    const after = await htmlOf(source.previewUrl!)
    expect(after).toContain(`href="${renamed.url}"`)
    expect(after).not.toContain(`href="${target.url}"`)

    // The document itself is untouched by the rename: it still stores an id,
    // never a path.
    const stored = await getJson<{ doc: Doc }>(`/folio/story/${source.id}/document`)
    expect(stored.doc.bloks.linkblok1?.data.href).toEqual({ kind: 'story', id: target.id })

    conn.close()
  })
})

describe('DELETE /folio/stories/:id and the redirect option (redirects.md)', () => {
  it('defaults to redirecting the deleted page to its parent', async () => {
    const parent = await createStory('Delete-Redirect Parent')
    const child = await createStory('Delete-Redirect Child', parent.id)

    const res = await SELF.fetch(`${API}/stories/${child.id}`, { method: 'DELETE' })
    expect(res.ok).toBe(true)

    const list = await getJson<{ rows: Redirect[] }>('/folio/redirects')
    expect(list.rows.find((r) => r.from === child.path)?.to).toBe(parent.path)
  })

  it('writes no redirect when redirect=false, the escape hatch', async () => {
    const parent = await createStory('Delete-No-Redirect Parent')
    const child = await createStory('Delete-No-Redirect Child', parent.id)

    await SELF.fetch(`${API}/stories/${child.id}?redirect=false`, { method: 'DELETE' })

    const list = await getJson<{ rows: Redirect[] }>('/folio/redirects')
    expect(list.rows.some((r) => r.from === child.path)).toBe(false)
  })
})

describe('redirects: GET/POST/DELETE /folio/redirects', () => {
  it('a rename recorded automatically shows up in the list, newest first', async () => {
    const story = await createStory('List-Redirect Source')
    const oldPath = story.path
    const renamed = await patchJson<StoryMeta>(`/folio/stories/${story.id}`, {
      slug: 'list-redirect-target',
    })
    expect(renamed.path).toBe('list-redirect-target')

    const page = await getJson<{ rows: Redirect[]; cursor: string | null }>('/folio/redirects')
    const row = page.rows.find((r) => r.from === oldPath)
    expect(row).toMatchObject({
      to: 'list-redirect-target',
      status: 301,
      source: 'auto',
      storyId: story.id,
    })
  })

  it('POST adds a manual redirect', async () => {
    const created = await postJson<Redirect>('/folio/redirects', {
      from: 'manual-redirect-source',
      to: 'manual-redirect-target',
    })
    expect(created).toMatchObject({
      from: 'manual-redirect-source',
      to: 'manual-redirect-target',
      status: 301,
      source: 'manual',
    })

    const filtered = await getJson<{ rows: Redirect[] }>('/folio/redirects?source=manual')
    expect(filtered.rows.some((r) => r.from === 'manual-redirect-source')).toBe(true)
  })

  it('POST refuses a `from` a story currently occupies, naming the story', async () => {
    const story = await createStory('Occupied Redirect Target')

    const { status, body } = await failureOf(
      '/folio/redirects',
      jsonPost(JSON.stringify({ from: story.path, to: 'somewhere-else' })),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toContain(story.title)
  })

  it('POST refuses a manual redirect whose target already redirects back to its source', async () => {
    await postJson('/folio/redirects', { from: 'loop-a', to: 'loop-b' })

    const { status, body } = await failureOf(
      '/folio/redirects',
      jsonPost(JSON.stringify({ from: 'loop-b', to: 'loop-a' })),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('conflict')
  })

  it('DELETE removes a redirect and reports whether one was actually there', async () => {
    await postJson('/folio/redirects', { from: 'delete-redirect-me', to: 'elsewhere' })

    const removed = await SELF.fetch(`${API}/redirects/delete-redirect-me`, { method: 'DELETE' })
    expect((await removed.json<{ deleted: boolean }>()).deleted).toBe(true)

    const again = await SELF.fetch(`${API}/redirects/delete-redirect-me`, { method: 'DELETE' })
    expect((await again.json<{ deleted: boolean }>()).deleted).toBe(false)

    const list = await getJson<{ rows: Redirect[] }>('/folio/redirects')
    expect(list.rows.some((r) => r.from === 'delete-redirect-me')).toBe(false)
  })

  it('DELETE accepts a multi-segment path', async () => {
    await postJson('/folio/redirects', { from: 'a/b/c', to: 'somewhere' })

    const res = await SELF.fetch(`${API}/redirects/a/b/c`, { method: 'DELETE' })
    expect((await res.json<{ deleted: boolean }>()).deleted).toBe(true)
  })
})

describe('redirects: the host 404 branch (test/workers/worker.ts)', () => {
  it('a renamed page 301s from its old path to the new one', async () => {
    const story = await createStory('Host-Redirect Rename')
    const oldPath = story.path
    await patchJson<StoryMeta>(`/folio/stories/${story.id}`, { slug: 'host-redirect-renamed' })

    const res = await SELF.fetch(`${ORIGIN}/${oldPath}`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/host-redirect-renamed`)
  })

  it('preserves the query string across the redirect', async () => {
    const story = await createStory('Host-Redirect Query')
    const oldPath = story.path
    await patchJson<StoryMeta>(`/folio/stories/${story.id}`, { slug: 'host-redirect-query-new' })

    const res = await SELF.fetch(`${ORIGIN}/${oldPath}?utm_source=x`, { redirect: 'manual' })
    expect(res.headers.get('location')).toBe(`${ORIGIN}/host-redirect-query-new?utm_source=x`)
  })

  it('a live story at the path always wins over a redirect, and creating one deletes the trap', async () => {
    const story = await createStory('Host-Redirect Reoccupy Source')
    const oldPath = story.path
    await patchJson<StoryMeta>(`/folio/stories/${story.id}`, { slug: 'host-redirect-reoccupy-new' })
    expect(
      (await getJson<{ rows: Redirect[] }>('/folio/redirects')).rows.some(
        (r) => r.from === oldPath,
      ),
    ).toBe(true)

    // A fresh story created at exactly the vacated path makes it live again —
    // reoccupying the trap rather than merely shadowing it.
    const reoccupied = await postJson<StoryMeta>('/folio/stories', {
      title: 'Reoccupier',
      slug: oldPath,
    })
    expect(reoccupied.path).toBe(oldPath)
    await publish(reoccupied.id)

    const res = await SELF.fetch(`${ORIGIN}/${oldPath}`, { redirect: 'manual' })
    expect(res.status).not.toBe(301)

    const list = await getJson<{ rows: Redirect[] }>('/folio/redirects')
    expect(list.rows.some((r) => r.from === oldPath)).toBe(false)
  })

  it('an unsafe stored target never reaches a Location header', async () => {
    await env.DB.prepare(
      `insert into redirects (from_path, to_path, status, source, story_id, created_at)
       values (?, ?, ?, 'manual', null, ?)`,
    )
      .bind('host-redirect-unsafe', 'javascript:alert(1)', 301, Date.now())
      .run()

    const res = await SELF.fetch(`${ORIGIN}/host-redirect-unsafe`, { redirect: 'manual' })
    expect(res.status).toBe(404)
  })
})

describe('preview and host fallthrough', () => {
  it('?_folio=preview renders the current draft, before anything is published', async () => {
    const story = await createStory('Preview Draft')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('p1', [{ t: 'set', uid: doc.root, field: 'title', value: 'Draft Title' }])

    const preview = await htmlOf(story.previewUrl!)
    expect(preview).toContain('Draft Title')

    conn.close()
  })

  it('a story with nothing published 404s at the host, not inside Folio', async () => {
    const story = await createStory('Never Published')

    const res = await SELF.fetch(`${ORIGIN}/${story.path}`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('host: not found')
  })

  it('a path with no story behind it falls through, via a null from folio.handle', async () => {
    const res = await SELF.fetch(`${ORIGIN}/nothing-lives-here`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('host: not found')
  })

  it('a preview request for a path with no story falls through the same way', async () => {
    const res = await SELF.fetch(`${ORIGIN}/nothing-lives-here?_folio=preview`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('host: not found')
  })
})

/**
 * Every failure answers `{ error: { code, message } }`. The codes are the
 * contract (a client switches on them); the messages are only ever ones the
 * server wrote on purpose — raw D1 text and internal `Error` messages stop at
 * `app.onError`.
 */
describe('validation and the error envelope', () => {
  it('rejects a body with the wrong type for a field, naming the field it refused', async () => {
    const { status, body } = await failureOf(
      '/folio/stories',
      jsonPost(JSON.stringify({ title: 7 })),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('title')
  })

  it('rejects a body that is not JSON at all, rather than letting it become a 500', async () => {
    const { status, body } = await failureOf('/folio/stories', jsonPost('{"title": '))

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
  })

  it('rejects a title past the cap, and writes no row', async () => {
    const title = 'x'.repeat(301)
    const { status, body } = await failureOf('/folio/stories', jsonPost(JSON.stringify({ title })))

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('300')

    // The cap exists to stop the write, not to describe it after the fact.
    const tree = await getJson<StoryNode[]>('/folio/stories')
    expect(flatten(tree).every((n) => n.title.length <= 300)).toBe(true)
  })

  it('rejects an id that could not name a row', async () => {
    const { status, body } = await failureOf('/folio/story/not%20an%20id/document')

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
  })

  it('rejects an actor header past the cap on publish', async () => {
    const story = await createStory('Actor Header Cap')
    const { status, body } = await failureOf(`/folio/story/${story.id}/publish`, {
      method: 'POST',
      headers: { 'x-folio-actor': 'a'.repeat(65) },
    })

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('x-folio-actor')
  })

  it('refuses a body that is valid JSON but not an object, without echoing it back', async () => {
    // valibot's default object message stringifies what it received, which would
    // make this route a reflection channel for whatever a client sent. Every
    // body schema passes its own message for that reason.
    const marker = 'LEAK-ME-BACK'
    const { status, text, body } = await failureOf(
      '/folio/stories',
      jsonPost(JSON.stringify(`<img src=x onerror=alert(1)>${marker}`)),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toBe('body must be a JSON object')
    expect(text).not.toContain(marker)
  })

  it('accepts a title containing a multi-codepoint emoji', async () => {
    // ZWJ (U+200D) is `\p{Cf}`, so screening all of `\p{C}` would 400 every
    // emoji a person can type: a flag, a family, a job title.
    for (const title of ['Meet the team 👨‍💻', 'Pride 🏳️‍🌈', 'Family 👨‍👩‍👧‍👦']) {
      const story = await createStory(title)
      expect(story.title).toBe(title)
    }
  })

  it('still refuses a lone surrogate and a bidi override in a title', async () => {
    // A well-formed pair is a single non-`Cs` code point under `/u` (the emoji
    // above prove it passes); half of one is not, and cannot round-trip through
    // a D1 column. U+202E reorders a rendered title away from what was stored.
    for (const title of ['broken \ud800 half', 'invoice\u202egnp.exe']) {
      const { status, body } = await failureOf(
        '/folio/stories',
        jsonPost(JSON.stringify({ title })),
      )
      expect(status).toBe(400)
      expect(body.error.message).toContain('unsupported characters')
    }
  })

  it('404s a story that does not exist, as an envelope rather than a bare status', async () => {
    const { status, body } = await failureOf('/folio/story/sty_nothing/document')

    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe('Unknown story')
  })

  it('404s an unknown story before it judges the body, not after', async () => {
    // Precedence, pinned: a checkpoint on a story that does not exist is a 404
    // whether or not the body is also wrong, because the id is the first thing
    // wrong with the request. Validating first would answer this exact request
    // with a 400 about `label` instead — a different answer to an unchanged
    // request, and the reason `loadStory` runs ahead of the body parse in
    // routes/history.ts rather than letting the workflow do the lookup.
    const { status, body } = await failureOf(
      '/folio/story/sty_abcdefgh/versions',
      jsonPost(JSON.stringify({ label: 12345 })),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe('Unknown story')
  })

  it('404s an unknown version the same way', async () => {
    const { status, body } = await failureOf('/folio/versions/ver_nothing')

    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })

  it('reports a path collision as a conflict, without D1s constraint text', async () => {
    // `uniqueSlug` only dedupes against siblings, so a child of the root story
    // (whose path is '') can still derive a path a top-level story already
    // owns — 'about', seeded in this file's fixture, above. D1's `path`
    // unique index is what refuses it, and its message names the table and
    // the column.
    const { status, text, body } = await failureOf(
      '/folio/stories',
      jsonPost(JSON.stringify({ title: 'About', parentId: 'sty_home' })),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('conflict')
    expect(text).not.toMatch(/UNIQUE|constraint|SQLITE|stories\.path/i)
  })

  it('rejects moving a story into its own subtree with the reason, not a 500', async () => {
    const parent = await createStory('Cycle Parent')
    const child = await createStory('Cycle Child', parent.id)

    const res = await SELF.fetch(`${API}/stories/${parent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: child.id }),
    })
    const body = await res.json<ErrorEnvelope>()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toBe('Cannot move a story into its own subtree')
  })

  it('reports refusing to delete the root story as a conflict', async () => {
    const { status, body } = await failureOf('/folio/stories/sty_home', { method: 'DELETE' })

    expect(status).toBe(409)
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toBe('Cannot delete the root story')
  })

  it('answers a corrupted persisted row with a generic 500, logging the route and nothing else', async () => {
    // A row that cannot have come from `writeVersion`: the closest reachable
    // stand-in for the class of failure onError exists for — a bug or a
    // platform fault mid-request, where the only honest thing to tell a client
    // is that it failed.
    const id = 'ver_corrupt1'
    await env.DB.prepare(
      `insert into versions (id, story_id, kind, label, title, actor, doc, created_at)
       values (?, 'sty_home', 'checkpoint', null, 'Corrupt', null, 'not json', ?)`,
    )
      .bind(id, Date.now())
      .run()

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { status, text, body } = await failureOf(`/folio/versions/${id}`)

      expect(status).toBe(500)
      expect(body.error.code).toBe('internal')
      // Nothing about the parse, the table or the row travels.
      expect(text).not.toMatch(/JSON|SyntaxError|versions|token/i)
      // The route is the context the log line owes whoever reads it.
      expect(String(logged.mock.calls[0]?.[0])).toContain(`GET /folio/versions/${id}`)
    } finally {
      logged.mockRestore()
    }
  })
})

/** 1×1 transparent PNG: the smallest upload `imageSize` can read dimensions from. */
const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
)

function upload(filename: string, contentType: string, body: BodyInit): Promise<Response> {
  return SELF.fetch(`${API}/assets?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  })
}

/**
 * `POST /folio/assets` takes a raw body from a client that (until auth lands) is
 * anyone, and `GET /folio/asset/:key` serves it back from the site's own origin
 * — the URL published pages carry in their `<img>` tags. What the first route
 * agrees to store is therefore what the second is willing to execute.
 */
describe('asset uploads and serving', () => {
  it('keeps a served image type, with nosniff', async () => {
    const res = await upload('photo.png', 'image/png', PNG_1X1)
    expect(res.status).toBe(201)
    const { asset } = await res.json<{ asset: AssetRow }>()
    expect(asset.contentType).toBe('image/png')
    expect(asset.width).toBe(1)

    const served = await SELF.fetch(`${API}/asset/${asset.key}`)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('stores a script-bearing upload as a download rather than as HTML on this origin', async () => {
    const script = '<script>alert(document.domain)</script>'
    const res = await upload('payload.html', 'text/html', script)

    // Kept, not refused: the file is the client's, only the type it claimed is
    // not honoured.
    expect(res.status).toBe(201)
    const { asset } = await res.json<{ asset: AssetRow }>()
    expect(asset.contentType).toBe('application/octet-stream')

    const served = await SELF.fetch(`${API}/asset/${asset.key}`)
    expect(served.headers.get('content-type')).toBe('application/octet-stream')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    // Decoded rather than `.text()`: the response is deliberately not text now.
    expect(new TextDecoder().decode(await served.arrayBuffer())).toBe(script)
  })

  it('does not serve an uploaded SVG as an image', async () => {
    // The transform path excludes SVG on purpose, so an allowed `image/svg+xml`
    // would be streamed back verbatim — a script with an image's content type.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const { asset } = await (await upload('logo.svg', 'image/svg+xml', svg)).json<{
      asset: AssetRow
    }>()

    expect(asset.contentType).toBe('application/octet-stream')
    const served = await SELF.fetch(`${API}/asset/${asset.key}`)
    expect(served.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('ignores a charset parameter on an otherwise served type', async () => {
    const { asset } = await (await upload('shot.png', 'IMAGE/PNG; charset=binary', PNG_1X1)).json<{
      asset: AssetRow
    }>()

    expect(asset.contentType).toBe('image/png')
  })

  it('refuses an oversized upload on the declared length, before reading the body', async () => {
    const { status, body } = await failureOf('/folio/assets?filename=huge.png', {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) },
      body: PNG_1X1,
    })

    expect(status).toBe(413)
    expect(body.error.code).toBe('too_large')
    // The same wording the post-read check in assets.ts produces.
    expect(body.error.message).toBe('File is larger than 20MB')
  })

  it('refuses a filename past the cap', async () => {
    const { status, body } = await failureOf(`/folio/assets?filename=${'a'.repeat(201)}.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: PNG_1X1,
    })

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('filename')
  })
})
