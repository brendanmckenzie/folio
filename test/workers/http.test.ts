import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { diff } from '../../src/core/diff'
import type { Doc } from '../../src/core/doc'
import type { Mutation } from '../../src/core/mutations'
import type { ActivityEntry, ClientMsg, ServerMsg } from '../../src/core/protocol'
import type { StoryMeta, StoryNode } from '../../src/core/story'
import type { VersionMeta } from '../../src/server/versions'

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
      ws.send(JSON.stringify(msg))
      const reply = await expectMsg(
        (m): m is Extract<ServerMsg, { type: 'bootstrap' }> => m.type === 'bootstrap',
      )
      return reply.doc
    },
    async tx(txId, mutations) {
      const msg: ClientMsg = { type: 'tx', txId, mutations }
      ws.send(JSON.stringify(msg))
      await expectMsg(
        (m): m is Extract<ServerMsg, { type: 'delta' }> => m.type === 'delta' && m.txId === txId,
      )
    },
    close() {
      ws.close()
    },
  }
}

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
