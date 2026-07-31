import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { defineBlock, text } from '../../src/core'
import { diff } from '../../src/core/diff'
import type { Doc } from '../../src/core/doc'
import type { Mutation } from '../../src/core/mutations'
import {
  type ActivityEntry,
  type ClientMsg,
  PROTOCOL_VERSION,
  type ServerMsg,
} from '../../src/core/protocol'
import type { StoryMeta } from '../../src/core/story'
import type { AssetRow } from '../../src/server/assets'
import type {
  CheckpointedHookPayload,
  CreatedHookPayload,
  DeletedHookPayload,
  FolioHooks,
  PathsChangedHookPayload,
  PublishedHookPayload,
  RedirectsChangedHookPayload,
  ReindexedHookPayload,
  UnpublishedHookPayload,
  UpdatedHookPayload,
} from '../../src/server/hooks'
import type { Redirect } from '../../src/server/redirects'
import { createFolio } from '../../src/server'
import type { Page } from '../../src/core/pagination'
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
const BASE = `${ORIGIN}/folio`
const API = `${BASE}/api`

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
  return postJson<StoryMeta>('/folio/api/stories', { title, parentId })
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

/**
 * Every routed page, flat.
 *
 * `GET /folio/api/stories` used to answer the whole tree as one nested array, and
 * this was `flatten(tree)`. It now answers **one level at a time**
 * (`../../../docs/specs/foundation/pagination.md` decision 2), so a test that wants
 * "every story" asks flat mode instead. `limit=200` is the route's own ceiling and
 * comfortably past what anything here creates; `pagination.test.ts` is where the
 * boundary itself is pinned.
 */
async function allStories(): Promise<StoryMeta[]> {
  return (await getJson<Page<StoryMeta>>('/folio/api/stories?flat=1&limit=200')).rows
}

interface PublishResult {
  ok: boolean
  publishedAt: number
  publishedSyncId: number
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
 * browser performs against `/folio/api/story/:id/socket`. `SELF.fetch` dispatches
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
      const msg: ClientMsg = {
        type: 'hello',
        lastSyncId: 0,
        identity: { actor, name: actor, colour: '#000' },
      }
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
 * Migrations (packages/folio/api/migrations/**) are structure only — no seed
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

describe('stories: CRUD over /folio/api/stories', () => {
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
    const flat = await allStories()

    expect(flat.some((n) => n.id === 'sty_home')).toBe(true)
    expect(flat.some((n) => n.slug === 'crud-parent')).toBe(true)
  })

  it('renames a story: title, slug and path move together', async () => {
    const created = await createStory('Rename Before')

    const renamed = await patchJson<StoryMeta>(`/folio/api/stories/${created.id}`, {
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

    expect((await allStories()).some((n) => n.id === parent.id)).toBe(false)
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

// duplicate-and-paste.md: architecture decision 2 (create, then seed —
// getOrInit needs no new Durable Object entry point), decision 4 (the
// *draft* is cloned, not the published snapshot), checkpoint 3 (uids always
// re-allocated), checkpoint 4 (no version history of its own).
describe('duplicate: POST /folio/api/stories/:id/duplicate', () => {
  it('seeds the new story with the source draft, uids re-allocated, versions empty', async () => {
    const source = await createStory('Duplicate Source')
    const conn = await connect(source.id)
    const sourceDoc = await conn.hello('alice')
    await conn.tx('dup-edit', [
      { t: 'set', uid: sourceDoc.root, field: 'title', value: 'Edited Draft Title' },
      {
        t: 'insert',
        blok: {
          uid: 'dup-lnk1',
          type: 'link',
          parent: sourceDoc.root,
          slot: 'body',
          order: 'a0',
          data: { label: 'Original Link', href: null },
        },
      },
    ])
    conn.close()

    const res = await SELF.fetch(`${API}/stories/${source.id}/duplicate`, jsonPost('{}'))
    expect(res.status).toBe(201)
    const { story: created } = await res.json<{ story: StoryMeta }>()

    // Decision 5: the source's own slug collides with the still-live source,
    // so the copy is bumped to '-2' with no special case anywhere.
    expect(created.path).toBe('duplicate-source-2')
    expect(created.publishedAt).toBeNull()
    expect(created.title).toBe('Duplicate Source (copy)')

    const { doc: cloned } = await getJson<{ doc: Doc }>(`/folio/api/story/${created.id}/document`)
    expect(cloned.bloks[cloned.root]?.data.title).toBe('Edited Draft Title')

    // Checkpoint 3: every uid re-allocated, including the root.
    expect(cloned.root).not.toBe(sourceDoc.root)
    const clonedLink = Object.values(cloned.bloks).find((b) => b.type === 'link')
    expect(clonedLink?.uid).not.toBe('dup-lnk1')
    expect(clonedLink?.data).toEqual({ label: 'Original Link', href: null })

    // Checkpoint 4: no version history of its own.
    const versions = await getJson<Page<VersionMeta>>(`/folio/api/story/${created.id}/versions`)
    expect(versions.rows).toEqual([])
    expect(versions.cursor).toBeNull()

    // The source is untouched by its own duplication.
    const { doc: stillSource } = await getJson<{ doc: Doc }>(
      `/folio/api/story/${source.id}/document`,
    )
    expect(stillSource.root).toBe(sourceDoc.root)
    expect(stillSource.bloks['dup-lnk1']).toBeDefined()
  })

  it('accepts an explicit title and parentId', async () => {
    const source = await createStory('Custom Duplicate Source')
    const dest = await createStory('Duplicate Destination')

    const res = await SELF.fetch(
      `${API}/stories/${source.id}/duplicate`,
      jsonPost(JSON.stringify({ title: 'A Brand New Name', parentId: dest.id })),
    )
    const { story: created } = await res.json<{ story: StoryMeta }>()

    expect(created.title).toBe('A Brand New Name')
    expect(created.parentId).toBe(dest.id)
    expect(created.path).toBe(`${dest.slug}/custom-duplicate-source`)
  })

  it('the copy publishes independently of the source', async () => {
    const source = await createStory('Publish Independently Source')
    const dupRes = await SELF.fetch(`${API}/stories/${source.id}/duplicate`, jsonPost('{}'))
    const { story: created } = await dupRes.json<{ story: StoryMeta }>()

    const pub = await publish(created.id)
    expect(pub.ok).toBe(true)

    const rows = await allStories()
    const row = rows.find((n) => n.id === created.id)
    expect(row?.publishedAt).not.toBeNull()

    // The source was never published by any of this.
    const sourceTree = rows.find((n) => n.id === source.id)
    expect(sourceTree?.publishedAt).toBeNull()
  })

  it('404s duplicating an unknown story', async () => {
    const { status } = await failureOf(`/folio/api/stories/sty_nope/duplicate`, jsonPost('{}'))
    expect(status).toBe(404)
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

  // unpublished-changes.md: published_sync_id lands in the same batch as
  // published_doc, so a reader can never see one without the other, and the
  // tree's derived state agrees with the open story's own diff.
  it('writes published_sync_id atomically, so the tree reads "changed" only once a later transaction lands', async () => {
    const story = await createStory('Watermark Race')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('w1', [{ t: 'set', uid: doc.root, field: 'title', value: 'First' }])

    const pub = await publish(story.id)
    expect(pub.publishedSyncId).toBe(1)

    // Nothing has been mirrored into D1 yet (the alarm has not fired), but the
    // watermark this publish just wrote already agrees the story is clean.
    const stub = env.STORY.get(env.STORY.idFromName(story.id))
    expect(await stateOf(story.id)).toBe('live')

    // A transaction lands after the snapshot: the object's log position moves
    // past what was published, and — once the debounced mirror runs — the
    // tree must say so.
    await conn.tx('w2', [{ t: 'set', uid: doc.root, field: 'title', value: 'Second' }])
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    const row = (await allStories()).find((n) => n.id === story.id)
    expect(row?.state).toBe('changed')
    expect(row?.hasUnpublishedChanges).toBe(true)
    expect(row?.draftSyncId).toBe(2)
    expect(row?.publishedSyncId).toBe(1)

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
  return (await allStories()).find((n) => n.id === storyId)?.state
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
    const stored = await getJson<{ doc: Doc }>(`/folio/api/story/${story.id}/document`)
    expect(stored.doc.bloks[doc.root]?.data.title).toBe('The Offer')
    const preview = await htmlOf(story.previewUrl!)
    expect(preview).toContain('The Offer')

    // Version history survives.
    const versions = await getJson<Page<VersionMeta>>(`/folio/api/story/${story.id}/versions`)
    expect(versions.rows.some((v) => v.id === pub.version.id)).toBe(true)

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
    const { status, body } = await failureOf(`/folio/api/story/sty_nope/unpublish`, {
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

    const versions = await getJson<Page<VersionMeta>>(`/folio/api/story/${story.id}/versions`)
    expect(versions.rows.length).toBeGreaterThanOrEqual(2)

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
    const stored = await getJson<{ doc: Doc }>(`/folio/api/story/sty_home/document`)
    expect(stored.doc.bloks[doc.root]?.data.title).toBe('Root Home')

    // Delete is still refused, as today — unpublish is not delete.
    const del = await failureOf('/folio/api/stories/sty_home', { method: 'DELETE' })
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

    const list = await getJson<Page<VersionMeta & { doc?: unknown }>>(
      `/folio/api/story/${story.id}/versions`,
    )

    expect(list.rows[0]?.id).toBe(pub2.version.id)
    expect(list.rows.some((v) => v.id === pub1.version.id)).toBe(true)
    expect(list.rows.every((v) => v.doc === undefined)).toBe(true)

    conn.close()
  })

  it('restoring an old version replays it as mutations, and the activity trail reflects it', async () => {
    const story = await createStory('Restorable Story')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    const root = doc.root

    await conn.tx('r1', [{ t: 'set', uid: root, field: 'title', value: 'First' }])
    const checkpoint = await postJson<VersionMeta>(`/folio/api/story/${story.id}/versions`, {
      label: 'first',
      actor: 'alice',
    })

    await conn.tx('r2', [{ t: 'set', uid: root, field: 'title', value: 'Second' }])

    const { doc: target } = await getJson<{ doc: Doc }>(`/folio/api/versions/${checkpoint.id}`)
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

    const activity = await getJson<ActivityEntry[]>(`/folio/api/story/${story.id}/activity`)
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

    const renamed = await patchJson<StoryMeta>(`/folio/api/stories/${target.id}`, {
      slug: 'renamed-target',
    })

    const after = await htmlOf(source.previewUrl!)
    expect(after).toContain(`href="${renamed.url}"`)
    expect(after).not.toContain(`href="${target.url}"`)

    // The document itself is untouched by the rename: it still stores an id,
    // never a path.
    const stored = await getJson<{ doc: Doc }>(`/folio/api/story/${source.id}/document`)
    expect(stored.doc.bloks.linkblok1?.data.href).toEqual({ kind: 'story', id: target.id })

    conn.close()
  })
})

describe('DELETE /folio/api/stories/:id and the redirect option (redirects.md)', () => {
  it('defaults to redirecting the deleted page to its parent', async () => {
    const parent = await createStory('Delete-Redirect Parent')
    const child = await createStory('Delete-Redirect Child', parent.id)

    const res = await SELF.fetch(`${API}/stories/${child.id}`, { method: 'DELETE' })
    expect(res.ok).toBe(true)

    const list = await getJson<{ rows: Redirect[] }>('/folio/api/redirects')
    expect(list.rows.find((r) => r.from === child.path)?.to).toBe(parent.path)
  })

  it('writes no redirect when redirect=false, the escape hatch', async () => {
    const parent = await createStory('Delete-No-Redirect Parent')
    const child = await createStory('Delete-No-Redirect Child', parent.id)

    await SELF.fetch(`${API}/stories/${child.id}?redirect=false`, { method: 'DELETE' })

    const list = await getJson<{ rows: Redirect[] }>('/folio/api/redirects')
    expect(list.rows.some((r) => r.from === child.path)).toBe(false)
  })
})

/**
 * Every event at its real call site (`publish-hooks.md`). `SELF.fetch` always
 * dispatches into `test/workers/worker.ts`'s own `folio`, which configures no
 * hooks at all — so every test here builds its *own* `createFolio` instance
 * (same pattern as `app.test.ts`'s `folioWith`), with only the hook it cares
 * about, and calls `.handle()` on it directly rather than going through `SELF`.
 * That instance shares the same D1 database and the same Durable Object
 * namespace as the rest of the suite (both come off the ambient `env`), so a
 * story created or edited through the ordinary `SELF.fetch` helpers above is
 * exactly what a hook fired through this second instance sees.
 *
 * `waitOnExecutionContext` drains whatever a non-awaited hook handed to
 * `waitUntil` before a test inspects its recorded calls — the timing mechanics
 * themselves (waitUntil by default, `await` opt-in) are proven in isolation by
 * `test/unit/server/pure.test.ts`; this suite only has to prove that the real
 * routes fire the right event, once, with the right payload, after the write.
 */
const hookPage = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title', required: true }) },
  render: () => null,
})

function folioWithHooks(hooks: FolioHooks<Cloudflare.Env>) {
  return createFolio<Cloudflare.Env>({
    blocks: [hookPage],
    root: 'page',
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    auth: 'open',
    hooks,
  })
}

async function callHooked(
  folio: ReturnType<typeof folioWithHooks>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await folio.handle(new Request(`${ORIGIN}${path}`, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res!
}

describe('lifecycle hooks (publish-hooks.md)', () => {
  it('published fires after the commit, with the story, doc, version, publishedAt and actor', async () => {
    const story = await createStory('Hook Publish Target')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('hookpub1', [{ t: 'set', uid: doc.root, field: 'title', value: 'Hooked Title' }])
    conn.close()

    const calls: PublishedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({
      published: (e) => {
        calls.push(e)
      },
    })

    const res = await callHooked(folio2, `/folio/api/story/${story.id}/publish`, { method: 'POST' })
    const pub = await res.json<{ publishedAt: number; version: VersionMeta }>()

    expect(calls).toHaveLength(1)
    const e = calls[0]!
    expect(e.story.id).toBe(story.id)
    expect(e.story.publishedAt).toBe(pub.publishedAt)
    expect(e.doc.bloks[e.doc.root]?.data.title).toBe('Hooked Title')
    expect(e.version.id).toBe(pub.version.id)
    expect(e.publishedAt).toBe(pub.publishedAt)
    // Null, and correctly so: this fixture is `auth: 'open'`, where there are no
    // accounts and therefore genuinely nobody to attribute a publish to. The
    // `x-folio-actor` header that used to supply a name here is gone
    // (identity-and-access.md) — a history a client can write is worse than one
    // that admits it does not know. test/workers/auth-http.test.ts pins the
    // other half: a session's own user id lands here on a real deployment.
    expect(e.actor).toBeNull()
  })

  it('a throwing hook does not fail the publish: the response is normal and the event is logged once', async () => {
    const story = await createStory('Hook Publish Throws')
    const conn = await connect(story.id)
    await conn.hello('alice')
    conn.close()

    const folio2 = folioWithHooks({
      published: () => {
        throw new Error('boom from a published hook')
      },
    })

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callHooked(folio2, `/folio/api/story/${story.id}/publish`, { method: 'POST' })
    const body = await res.json<{ ok: boolean }>()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(logged.mock.calls.some((c) => c[0] === 'folio: hook published failed')).toBe(true)
    logged.mockRestore()
  })

  it('a failed publish (an unknown story) fires nothing', async () => {
    const calls: unknown[] = []
    const folio2 = folioWithHooks({ published: (e) => calls.push(e) })

    const res = await callHooked(folio2, '/folio/api/story/sty_hook_nope/publish', {
      method: 'POST',
    })

    expect(res.status).toBe(404)
    expect(calls).toEqual([])
  })

  it('checkpointed fires after the version row is written', async () => {
    const story = await createStory('Hook Checkpoint Target')
    const conn = await connect(story.id)
    const doc = await conn.hello('alice')
    await conn.tx('hookcp1', [
      { t: 'set', uid: doc.root, field: 'title', value: 'Checkpoint Title' },
    ])
    conn.close()

    const calls: CheckpointedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({ checkpointed: (e) => calls.push(e) })

    const res = await callHooked(
      folio2,
      `/folio/api/story/${story.id}/versions`,
      jsonPost(JSON.stringify({ label: 'hook checkpoint' })),
    )
    const version = await res.json<VersionMeta>()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.story.id).toBe(story.id)
    expect(calls[0]!.version.id).toBe(version.id)
    // See the `published` hook above: no accounts, so no actor.
    expect(calls[0]!.actor).toBeNull()
  })

  it('unpublished fires with the story, and deleted fires with the removed ids and paths, after the objects are purged', async () => {
    const parent = await createStory('Hook Lifecycle Parent')
    const child = await createStory('Hook Lifecycle Child', parent.id)
    const conn = await connect(parent.id)
    await conn.hello('alice')
    const pubRes = await SELF.fetch(`${API}/story/${parent.id}/publish`, { method: 'POST' })
    expect(pubRes.ok).toBe(true)
    conn.close()

    const unpublishedCalls: UnpublishedHookPayload<Cloudflare.Env>[] = []
    const deletedCalls: DeletedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({
      unpublished: (e) => unpublishedCalls.push(e),
      deleted: (e) => deletedCalls.push(e),
    })

    const unpubRes = await callHooked(folio2, `/folio/api/story/${parent.id}/unpublish`, {
      method: 'POST',
    })
    const unpub = await unpubRes.json<{ unpublishedAt: number }>()

    expect(unpublishedCalls).toHaveLength(1)
    expect(unpublishedCalls[0]!.story.id).toBe(parent.id)
    expect(unpublishedCalls[0]!.story.unpublishedAt).toBe(unpub.unpublishedAt)
    expect(unpublishedCalls[0]!.actor).toBeNull()

    const delRes = await callHooked(folio2, `/folio/api/stories/${parent.id}?redirect=false`, {
      method: 'DELETE',
    })
    const del = await delRes.json<{ deleted: string[] }>()

    expect(deletedCalls).toHaveLength(1)
    expect(new Set(deletedCalls[0]!.ids)).toEqual(new Set(del.deleted))
    expect(new Set(deletedCalls[0]!.ids)).toEqual(new Set([parent.id, child.id]))
    expect(deletedCalls[0]!.paths).toContain(parent.path)
    expect(deletedCalls[0]!.paths).toContain(child.path)
    expect(deletedCalls[0]!.actor).toBeNull()
  })

  it('unpublishing an already-unpublished story is a no-op and fires nothing', async () => {
    const story = await createStory('Hook Unpublish Idempotent')
    const conn = await connect(story.id)
    await conn.hello('alice')
    const pubRes = await SELF.fetch(`${API}/story/${story.id}/publish`, { method: 'POST' })
    expect(pubRes.ok).toBe(true)
    conn.close()
    await SELF.fetch(`${API}/story/${story.id}/unpublish`, { method: 'POST' })

    const calls: unknown[] = []
    const folio2 = folioWithHooks({ unpublished: (e) => calls.push(e) })
    await callHooked(folio2, `/folio/api/story/${story.id}/unpublish`, { method: 'POST' })

    expect(calls).toEqual([])
  })

  it('pathsChanged carries every affected id with its old and new path, after the rename batch commits', async () => {
    const section = await createStory('Hook Section')
    const descendant = await createStory('Hook Descendant', section.id)

    const calls: PathsChangedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({ pathsChanged: (e) => calls.push(e) })

    const res = await callHooked(folio2, `/folio/api/stories/${section.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'hook-section-renamed' }),
    })
    const renamed = await res.json<StoryMeta>()

    expect(calls).toHaveLength(1)
    const changes = calls[0]!.changes
    expect(changes).toHaveLength(2)
    expect(changes.find((c) => c.id === section.id)).toEqual({
      id: section.id,
      from: section.path,
      to: renamed.path,
    })
    expect(changes.find((c) => c.id === descendant.id)?.to).toBe(`${renamed.path}/hook-descendant`)
  })

  it('does not fire pathsChanged for an update with no path change', async () => {
    const story = await createStory('Hook No Rename')

    const calls: unknown[] = []
    const folio2 = folioWithHooks({ pathsChanged: (e) => calls.push(e) })
    // `slug` pinned to its current value: leaving it out would fall back to
    // the new title (`updateStoryStatement`'s own rule) and move the path
    // anyway, which is not the "nothing moved" case this test wants.
    await callHooked(folio2, `/folio/api/stories/${story.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Hook No Rename Retitled', slug: story.slug }),
    })

    expect(calls).toEqual([])
  })

  it('created fires after the insert, for a plain create and for a duplicate', async () => {
    const calls: CreatedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({ created: (e) => calls.push(e) })

    const res = await callHooked(
      folio2,
      '/folio/api/stories',
      jsonPost(JSON.stringify({ title: 'Hook Created Target' })),
    )
    const story = await res.json<StoryMeta>()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.story.id).toBe(story.id)

    const dupRes = await callHooked(
      folio2,
      `/folio/api/stories/${story.id}/duplicate`,
      jsonPost('{}'),
    )
    const { story: dup } = await dupRes.json<{ story: StoryMeta }>()

    expect(calls).toHaveLength(2)
    expect(calls[1]!.story.id).toBe(dup.id)
  })

  it('a failed create never fires the hook', async () => {
    const calls: unknown[] = []
    const folio2 = folioWithHooks({ created: (e) => calls.push(e) })

    const res = await callHooked(folio2, '/folio/api/stories', jsonPost(JSON.stringify({})))

    expect(res.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('deleted carries each removed id with its path and its type', async () => {
    const story = await createStory('Hook Deleted Types')

    const calls: DeletedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({ deleted: (e) => calls.push(e) })
    await callHooked(folio2, `/folio/api/stories/${story.id}?redirect=false`, { method: 'DELETE' })

    expect(calls).toHaveLength(1)
    const i = calls[0]!.ids.indexOf(story.id)
    expect(calls[0]!.paths[i]).toBe(story.path)
    // The third fact that is gone the moment the delete runs, and the one a
    // collection over this type has to be invalidated by (`caching.md`).
    expect(calls[0]!.types[i]).toBe('page')
  })
})

/**
 * The four events `../../../docs/specs/platform/caching.md` added, at their real
 * call sites. Each exists because a write path that changes published bytes used
 * to fire nothing at all, and the same fixture rules as the block above apply:
 * a second `createFolio` over the same `env`, and `waitOnExecutionContext` to
 * drain anything that rode `waitUntil`.
 */
describe('the caching lifecycle hooks (caching.md)', () => {
  it('updated fires with changed: ["title"] for the title-only patch pathsChanged skips', async () => {
    const story = await createStory('Hook Updated Title')

    const updated: UpdatedHookPayload<Cloudflare.Env>[] = []
    const paths: unknown[] = []
    const folio2 = folioWithHooks({
      updated: (e) => updated.push(e),
      pathsChanged: (e) => paths.push(e),
    })

    // `slug` pinned, so nothing moves: this is exactly the write that alters
    // `StoryRef.title` on every page linking here and used to be silent.
    await callHooked(folio2, `/folio/api/stories/${story.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Hook Updated Retitled', slug: story.slug }),
    })

    expect(updated).toHaveLength(1)
    expect(updated[0]!.changed).toEqual(['title'])
    expect(updated[0]!.story.id).toBe(story.id)
    expect(updated[0]!.story.title).toBe('Hook Updated Retitled')
    expect(paths).toEqual([])
  })

  it('does not fire updated for a patch that changed nothing', async () => {
    const story = await createStory('Hook Updated Noop')

    const calls: unknown[] = []
    const folio2 = folioWithHooks({ updated: (e) => calls.push(e) })
    await callHooked(folio2, `/folio/api/stories/${story.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: story.title, slug: story.slug }),
    })

    expect(calls).toEqual([])
  })

  it('fires both updated and pathsChanged for a rename, which are different facts', async () => {
    const story = await createStory('Hook Updated Rename')

    const updated: UpdatedHookPayload<Cloudflare.Env>[] = []
    const paths: PathsChangedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({
      updated: (e) => updated.push(e),
      pathsChanged: (e) => paths.push(e),
    })

    await callHooked(folio2, `/folio/api/stories/${story.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'hook-updated-renamed' }),
    })

    expect(updated).toHaveLength(1)
    expect(updated[0]!.changed).toEqual(['slug'])
    expect(paths).toHaveLength(1)
  })

  it('fires updated from the API surface too, not only the admin route', async () => {
    const story = await createStory('Hook Updated Api')

    const calls: UpdatedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({ updated: (e) => calls.push(e) })
    await callHooked(folio2, `/folio/api/v1/documents/${story.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Hook Updated Api Retitled', slug: story.slug }),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.changed).toEqual(['title'])
  })

  it('reindexed fires with the number of documents the batch swept', async () => {
    const story = await createStory('Hook Reindexed Target')
    const conn = await connect(story.id)
    await conn.hello('alice')
    conn.close()
    expect((await SELF.fetch(`${API}/story/${story.id}/publish`, { method: 'POST' })).ok).toBe(true)

    const calls: ReindexedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({ reindexed: (e) => calls.push(e) })
    const res = await callHooked(folio2, '/folio/api/reindex', jsonPost('{}'))
    const report = await res.json<{ documents: number }>()

    expect(report.documents).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.count).toBe(report.documents)
  })

  it('does not fire reindexed for a dry run, which writes nothing', async () => {
    const calls: unknown[] = []
    const folio2 = folioWithHooks({ reindexed: (e) => calls.push(e) })
    await callHooked(folio2, '/folio/api/reindex', jsonPost(JSON.stringify({ dryRun: true })))

    expect(calls).toEqual([])
  })

  it('redirectsChanged fires when a manual redirect is added and when it is removed', async () => {
    const calls: RedirectsChangedHookPayload<Cloudflare.Env>[] = []
    const folio2 = folioWithHooks({ redirectsChanged: (e) => calls.push(e) })

    const created = await callHooked(
      folio2,
      '/folio/api/redirects',
      jsonPost(JSON.stringify({ from: '/hook-redirect-source', to: '/hook-redirect-target' })),
    )
    expect(created.status).toBe(201)
    expect(calls).toHaveLength(1)
    // Normalised: no leading slash, matching what `lookupRedirect` matches on.
    expect(calls[0]!.from).toEqual(['hook-redirect-source'])

    const removed = await callHooked(folio2, '/folio/api/redirects/hook-redirect-source', {
      method: 'DELETE',
    })
    expect(await removed.json<{ deleted: boolean }>()).toEqual({ deleted: true })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.from).toEqual(['hook-redirect-source'])
  })

  it('does not fire redirectsChanged for a delete that removed nothing', async () => {
    const calls: unknown[] = []
    const folio2 = folioWithHooks({ redirectsChanged: (e) => calls.push(e) })
    await callHooked(folio2, '/folio/api/redirects/hook-redirect-never-existed', {
      method: 'DELETE',
    })

    expect(calls).toEqual([])
  })
})

/**
 * The one thing about the purge hook a local test *can* prove, and the reason
 * it is worth proving here rather than in the unit suite: miniflare simulates
 * no part of Workers Cache, so this runs against the real
 * `import('cloudflare:workers')` under real workerd, with the capability
 * genuinely absent. The mapping from event to tag set is covered exhaustively
 * by `test/unit/server/cache-purge.test.ts` against an injected capability;
 * faking the platform call here and asserting against the fake would prove
 * nothing at all (`caching.md`'s Testing requirements).
 */
describe('the cache purge hook under a runtime with no Workers Cache (caching.md)', () => {
  it('is a silent no-op: a publish succeeds, nothing throws, nothing is logged', async () => {
    const story = await createStory('Cache Purge Absent')
    const conn = await connect(story.id)
    await conn.hello('alice')
    conn.close()

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // No hooks of its own: the purge is an *internal* hook, registered by
    // `createRuntime` on every instance, so this exercises the real one.
    const folio2 = folioWithHooks({})
    const res = await callHooked(folio2, `/folio/api/story/${story.id}/publish`, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json<{ ok: boolean }>()).toMatchObject({ ok: true })
    expect(logged).not.toHaveBeenCalled()
    expect(warned).not.toHaveBeenCalled()
    logged.mockRestore()
    warned.mockRestore()
  })

  it('leaves a reindex — the one trigger that always flushes — equally silent', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const folio2 = folioWithHooks({})

    const res = await callHooked(folio2, '/folio/api/reindex', jsonPost('{}'))

    expect(res.status).toBe(200)
    expect(logged).not.toHaveBeenCalled()
    expect(warned).not.toHaveBeenCalled()
    logged.mockRestore()
    warned.mockRestore()
  })
})

describe('redirects: GET/POST/DELETE /folio/api/redirects', () => {
  it('a rename recorded automatically shows up in the list, newest first', async () => {
    const story = await createStory('List-Redirect Source')
    const oldPath = story.path
    const renamed = await patchJson<StoryMeta>(`/folio/api/stories/${story.id}`, {
      slug: 'list-redirect-target',
    })
    expect(renamed.path).toBe('list-redirect-target')

    const page = await getJson<{ rows: Redirect[]; cursor: string | null }>('/folio/api/redirects')
    const row = page.rows.find((r) => r.from === oldPath)
    expect(row).toMatchObject({
      to: 'list-redirect-target',
      status: 301,
      source: 'auto',
      storyId: story.id,
    })
  })

  it('POST adds a manual redirect', async () => {
    const created = await postJson<Redirect>('/folio/api/redirects', {
      from: 'manual-redirect-source',
      to: 'manual-redirect-target',
    })
    expect(created).toMatchObject({
      from: 'manual-redirect-source',
      to: 'manual-redirect-target',
      status: 301,
      source: 'manual',
    })

    const filtered = await getJson<{ rows: Redirect[] }>('/folio/api/redirects?source=manual')
    expect(filtered.rows.some((r) => r.from === 'manual-redirect-source')).toBe(true)
  })

  it('POST refuses a `from` a story currently occupies, naming the story', async () => {
    const story = await createStory('Occupied Redirect Target')

    const { status, body } = await failureOf(
      '/folio/api/redirects',
      jsonPost(JSON.stringify({ from: story.path, to: 'somewhere-else' })),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toContain(story.title)
  })

  it('POST refuses a manual redirect whose target already redirects back to its source', async () => {
    await postJson('/folio/api/redirects', { from: 'loop-a', to: 'loop-b' })

    const { status, body } = await failureOf(
      '/folio/api/redirects',
      jsonPost(JSON.stringify({ from: 'loop-b', to: 'loop-a' })),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('conflict')
  })

  it('DELETE removes a redirect and reports whether one was actually there', async () => {
    await postJson('/folio/api/redirects', { from: 'delete-redirect-me', to: 'elsewhere' })

    const removed = await SELF.fetch(`${API}/redirects/delete-redirect-me`, { method: 'DELETE' })
    expect((await removed.json<{ deleted: boolean }>()).deleted).toBe(true)

    const again = await SELF.fetch(`${API}/redirects/delete-redirect-me`, { method: 'DELETE' })
    expect((await again.json<{ deleted: boolean }>()).deleted).toBe(false)

    const list = await getJson<{ rows: Redirect[] }>('/folio/api/redirects')
    expect(list.rows.some((r) => r.from === 'delete-redirect-me')).toBe(false)
  })

  it('DELETE accepts a multi-segment path', async () => {
    await postJson('/folio/api/redirects', { from: 'a/b/c', to: 'somewhere' })

    const res = await SELF.fetch(`${API}/redirects/a/b/c`, { method: 'DELETE' })
    expect((await res.json<{ deleted: boolean }>()).deleted).toBe(true)
  })

  /**
   * The cursor walk itself, which nothing covered before: every other test here
   * reads the first page and stops. This route is the **only** paged one in the
   * codebase and the pattern the other eight are being built to copy
   * (`docs/specs/foundation/pagination.md` phase 4), so the walk is worth pinning
   * once, here, rather than eight times later.
   */
  it('pages to exhaustion over the cursor, every row exactly once', async () => {
    // Enough to need three pages at limit=2, all created in one test so they share
    // a millisecond as often as not — which is precisely the tie the cursor's
    // second component exists for.
    const froms = ['pagewalk-a', 'pagewalk-b', 'pagewalk-c', 'pagewalk-d', 'pagewalk-e']
    for (const from of froms)
      await postJson('/folio/api/redirects', { from, to: 'pagewalk-target' })

    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const query: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2'
      const page = await getJson<{ rows: Redirect[]; cursor: string | null }>(
        `/folio/api/redirects${query}`,
      )
      expect(page.rows.length).toBeLessThanOrEqual(2)
      seen.push(...page.rows.map((r) => r.from))
      cursor = page.cursor
      if (!cursor) break
    }

    // The property that matters, and the one offset paging cannot give: no row
    // repeated, none skipped.
    const ours = seen.filter((from) => from.startsWith('pagewalk-'))
    expect(ours.sort()).toEqual([...froms].sort())
    expect(new Set(seen).size).toBe(seen.length)
    expect(cursor).toBeNull()
  })

  it('clamps an out-of-range limit rather than refusing it', async () => {
    // The asymmetry with the cursor below is deliberate: a stale bookmark carrying
    // `limit=5000` has an obvious right answer, and "resume after ???" does not.
    const page = await getJson<{ rows: Redirect[] }>('/folio/api/redirects?limit=5000')
    expect(page.rows.length).toBeLessThanOrEqual(200)
  })

  it('refuses a malformed cursor rather than silently starting over', async () => {
    // Silently restarting reads as a list that jumped, which is unactionable. The
    // cursor is opaque, so a client sending a bad one has a bug.
    const res = await SELF.fetch(`${API}/redirects?cursor=not-a-cursor`)
    expect(res.status).toBe(400)
    const body = await res.json<{ error: { code: string } }>()
    expect(body.error.code).toBe('bad_request')
  })
})

describe('redirects: the host 404 branch (test/workers/worker.ts)', () => {
  it('a renamed page 301s from its old path to the new one', async () => {
    const story = await createStory('Host-Redirect Rename')
    const oldPath = story.path
    await patchJson<StoryMeta>(`/folio/api/stories/${story.id}`, { slug: 'host-redirect-renamed' })

    const res = await SELF.fetch(`${ORIGIN}/${oldPath}`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/host-redirect-renamed`)
  })

  it('preserves the query string across the redirect', async () => {
    const story = await createStory('Host-Redirect Query')
    const oldPath = story.path
    await patchJson<StoryMeta>(`/folio/api/stories/${story.id}`, {
      slug: 'host-redirect-query-new',
    })

    const res = await SELF.fetch(`${ORIGIN}/${oldPath}?utm_source=x`, { redirect: 'manual' })
    expect(res.headers.get('location')).toBe(`${ORIGIN}/host-redirect-query-new?utm_source=x`)
  })

  it('a live story at the path always wins over a redirect, and creating one deletes the trap', async () => {
    const story = await createStory('Host-Redirect Reoccupy Source')
    const oldPath = story.path
    await patchJson<StoryMeta>(`/folio/api/stories/${story.id}`, {
      slug: 'host-redirect-reoccupy-new',
    })
    expect(
      (await getJson<{ rows: Redirect[] }>('/folio/api/redirects')).rows.some(
        (r) => r.from === oldPath,
      ),
    ).toBe(true)

    // A fresh story created at exactly the vacated path makes it live again —
    // reoccupying the trap rather than merely shadowing it.
    const reoccupied = await postJson<StoryMeta>('/folio/api/stories', {
      title: 'Reoccupier',
      slug: oldPath,
    })
    expect(reoccupied.path).toBe(oldPath)
    await publish(reoccupied.id)

    const res = await SELF.fetch(`${ORIGIN}/${oldPath}`, { redirect: 'manual' })
    expect(res.status).not.toBe(301)

    const list = await getJson<{ rows: Redirect[] }>('/folio/api/redirects')
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
      '/folio/api/stories',
      jsonPost(JSON.stringify({ title: 7 })),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('title')
  })

  it('rejects a body that is not JSON at all, rather than letting it become a 500', async () => {
    const { status, body } = await failureOf('/folio/api/stories', jsonPost('{"title": '))

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
  })

  it('rejects a title past the cap, and writes no row', async () => {
    const title = 'x'.repeat(301)
    const { status, body } = await failureOf(
      '/folio/api/stories',
      jsonPost(JSON.stringify({ title })),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('300')

    // The cap exists to stop the write, not to describe it after the fact.
    expect((await allStories()).every((n) => n.title.length <= 300)).toBe(true)
  })

  it('rejects an id that could not name a row', async () => {
    const { status, body } = await failureOf('/folio/api/story/not%20an%20id/document')

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
  })

  it('ignores an `x-folio-actor` header entirely, rather than bounding it', async () => {
    // The header is gone (identity-and-access.md phase 5): it was self-reported,
    // so bounding and screening it was only ever making a lie tidy. A client that
    // still sends one is not refused — an old tab should keep working — it simply
    // has no effect on what history records.
    const story = await createStory('Actor Header Ignored')
    const res = await SELF.fetch(`${API}/story/${story.id}/publish`, {
      method: 'POST',
      headers: { 'x-folio-actor': 'a'.repeat(65) },
    })

    expect(res.status).toBe(200)
    const versions = await getJson<Page<VersionMeta>>(`/folio/api/story/${story.id}/versions`)
    expect(versions.rows[0]?.actor).toBeNull()
  })

  it('refuses a body that is valid JSON but not an object, without echoing it back', async () => {
    // valibot's default object message stringifies what it received, which would
    // make this route a reflection channel for whatever a client sent. Every
    // body schema passes its own message for that reason.
    const marker = 'LEAK-ME-BACK'
    const { status, text, body } = await failureOf(
      '/folio/api/stories',
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
        '/folio/api/stories',
        jsonPost(JSON.stringify({ title })),
      )
      expect(status).toBe(400)
      expect(body.error.message).toContain('unsupported characters')
    }
  })

  it('404s a story that does not exist, as an envelope rather than a bare status', async () => {
    const { status, body } = await failureOf('/folio/api/story/sty_nothing/document')

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
      '/folio/api/story/sty_abcdefgh/versions',
      jsonPost(JSON.stringify({ label: 12345 })),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe('Unknown story')
  })

  it('404s an unknown version the same way', async () => {
    const { status, body } = await failureOf('/folio/api/versions/ver_nothing')

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
      '/folio/api/stories',
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
    const { status, body } = await failureOf('/folio/api/stories/sty_home', { method: 'DELETE' })

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
      const { status, text, body } = await failureOf(`/folio/api/versions/${id}`)

      expect(status).toBe(500)
      expect(body.error.code).toBe('internal')
      // Nothing about the parse, the table or the row travels.
      expect(text).not.toMatch(/JSON|SyntaxError|versions|token/i)
      // The route is the context the log line owes whoever reads it.
      expect(String(logged.mock.calls[0]?.[0])).toContain(`GET /folio/api/versions/${id}`)
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
 * `POST /folio/api/assets` takes a raw body from a client that (until auth lands) is
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

    const served = await SELF.fetch(`${BASE}/asset/${asset.key}`)
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

    const served = await SELF.fetch(`${BASE}/asset/${asset.key}`)
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
    const served = await SELF.fetch(`${BASE}/asset/${asset.key}`)
    expect(served.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('ignores a charset parameter on an otherwise served type', async () => {
    const { asset } = await (await upload('shot.png', 'IMAGE/PNG; charset=binary', PNG_1X1)).json<{
      asset: AssetRow
    }>()

    expect(asset.contentType).toBe('image/png')
  })

  it('refuses an oversized upload on the declared length, before reading the body', async () => {
    const { status, body } = await failureOf('/folio/api/assets?filename=huge.png', {
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
    const { status, body } = await failureOf(`/folio/api/assets?filename=${'a'.repeat(201)}.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: PNG_1X1,
    })

    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('filename')
  })
})

/* ------------------------------------------------- document types (HTTP) --- */

/**
 * document-types.md over the real HTTP surface. Builds its own `createFolio`
 * rather than going through `SELF`/worker.ts, following app.test.ts's pattern:
 * the thing under test is a multi-type *config*, and worker.ts declares exactly
 * one type (`root: 'page'`) on purpose, so that every other test in this file
 * keeps exercising the back-compatible single-type path.
 *
 * The same D1 and Durable Object `env` is shared, so rows created here are the
 * same rows `SELF` would have created.
 */
const dtPage = defineBlock({
  name: 'pageRoot',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title', required: true }) },
  render: () => null,
})

const dtPerson = defineBlock({
  name: 'personRoot',
  label: 'Person',
  summary: 'fullName',
  fields: { fullName: text({ label: 'Full name' }), role: text({ label: 'Role' }) },
  render: () => null,
})

const dtSettings = defineBlock({
  name: 'settingsRoot',
  label: 'Site settings',
  fields: { siteName: text({ label: 'Site name' }) },
  render: () => null,
})

const DT_TYPES = [
  { name: 'page', label: 'Page', kind: 'page' as const, root: 'pageRoot' },
  {
    name: 'insight',
    label: 'Insight',
    kind: 'page' as const,
    root: 'pageRoot',
    under: ['page'],
  },
  {
    name: 'person',
    label: 'Person',
    kind: 'record' as const,
    root: 'personRoot',
    titleField: 'fullName',
  },
  { name: 'settings', label: 'Site settings', kind: 'singleton' as const, root: 'settingsRoot' },
]

function typedFolio() {
  return createFolio<Cloudflare.Env>({
    blocks: [dtPage, dtPerson, dtSettings],
    types: DT_TYPES,
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    auth: 'open',
    route: (path) => (path ? `/${path}` : '/'),
  })
}

async function dtCall(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await typedFolio().handle(new Request(`${ORIGIN}${path}`, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res!
}

async function dtJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await dtCall(path, init)).json<T>()
}

async function dtFailure(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: ErrorEnvelope }> {
  const res = await dtCall(path, init)
  return { status: res.status, body: (await res.json()) as ErrorEnvelope }
}

function dtCreate(body: Record<string, unknown>): Promise<StoryMeta> {
  return dtJson<StoryMeta>('/folio/api/stories', jsonPost(JSON.stringify(body)))
}

describe('document types: GET /folio/api/schema', () => {
  it('carries every type through, and keeps `root` as the default page type’s root block', async () => {
    const manifest = await dtJson<{
      types: { name: string; kind: string; root: string; under?: string[] }[]
      root: string
    }>('/folio/api/schema')

    expect(manifest.types.map((t) => t.name)).toEqual(['page', 'insight', 'person', 'settings'])
    expect(manifest.types.find((t) => t.name === 'insight')).toEqual({
      name: 'insight',
      label: 'Insight',
      kind: 'page',
      root: 'pageRoot',
      under: ['page'],
    })
    // The deprecated key stays, so a consumer written before `types` existed
    // keeps reading the same value.
    expect(manifest.root).toBe('pageRoot')
  })
})

describe('document types: POST /folio/api/stories', () => {
  it('defaults to the default page type when the body names none', async () => {
    const story = await dtCreate({ title: 'Untyped create' })
    expect(story.type).toBe('page')
    expect(story.path).toBe('untyped-create')
  })

  it('creates a record with no URL of its own', async () => {
    const person = await dtCreate({ title: 'Ada Lovelace', type: 'person' })
    expect(person.type).toBe('person')
    expect(person.path).toBeNull()
    expect(person.parentId).toBeNull()
    // No `url`/`previewUrl`: there is nothing to navigate to.
    expect(person.url).toBeUndefined()
    expect(person.previewUrl).toBeUndefined()
  })

  it('answers `unsupported` (501) for a type the config does not declare', async () => {
    const { status, body } = await dtFailure(
      '/folio/api/stories',
      jsonPost(JSON.stringify({ title: 'X', type: 'nosuchtype' })),
    )
    // Not 404: the request is well-formed, the server just has no such type.
    expect(status).toBe(501)
    expect(body.error.code).toBe('unsupported')
    expect(body.error.message).toBe('Unknown document type: nosuchtype')
  })

  it('refuses a record with a parentId', async () => {
    const parent = await dtCreate({ title: 'Somewhere' })
    const { status, body } = await dtFailure(
      '/folio/api/stories',
      jsonPost(JSON.stringify({ title: 'Ada', type: 'person', parentId: parent.id })),
    )
    expect(status).toBe(400)
    expect(body.error.message).toBe('An unrouted document cannot have a parent')
  })

  it('refuses creating a singleton: it exists because the schema says so', async () => {
    const { status, body } = await dtFailure(
      '/folio/api/stories',
      jsonPost(JSON.stringify({ title: 'Another one', type: 'settings' })),
    )
    expect(status).toBe(409)
    expect(body.error.message).toContain('is a singleton and already exists')
  })

  it('refuses an `under` violation with a notice naming the allowed parents', async () => {
    const { status, body } = await dtFailure(
      '/folio/api/stories',
      jsonPost(JSON.stringify({ title: 'Loose insight', type: 'insight' })),
    )
    expect(status).toBe(400)
    expect(body.error.message).toBe("A 'insight' document is only allowed under: page")
  })

  it('screens a malformed type name before it reaches the config lookup', async () => {
    const { status, body } = await dtFailure(
      '/folio/api/stories',
      jsonPost(JSON.stringify({ title: 'X', type: 'not a type' })),
    )
    expect(status).toBe(400)
    expect(body.error.message).toContain('type')
  })
})

describe('document types: GET /folio/api/stories vs GET /folio/api/documents', () => {
  it('keeps records out of the tree and lists them flat instead', async () => {
    const page = await dtCreate({ title: 'A visible page' })
    const ada = await dtCreate({ title: 'Ada In Tree Test', type: 'person' })

    const tree = await dtJson<Page<StoryMeta>>('/folio/api/stories?flat=1&limit=200')
    const ids = tree.rows.map((n) => n.id)
    expect(ids).toContain(page.id)
    expect(ids).not.toContain(ada.id)

    const { documents } = await dtJson<{ documents: StoryMeta[] }>(
      '/folio/api/documents?type=person',
    )
    expect(documents.map((d) => d.id)).toContain(ada.id)
    expect(documents.every((d) => d.type === 'person')).toBe(true)
  })

  it('answers `unsupported` for an undeclared type', async () => {
    const { status, body } = await dtFailure('/folio/api/documents?type=nope')
    expect(status).toBe(501)
    expect(body.error.code).toBe('unsupported')
  })

  it('creates every declared singleton on first access, and only once', async () => {
    const first = await dtJson<{ documents: StoryMeta[] }>('/folio/api/documents')
    const settings = first.documents.filter((d) => d.type === 'settings')
    expect(settings).toHaveLength(1)
    expect(settings[0]?.id).toBe('sng_settings')

    const second = await dtJson<{ documents: StoryMeta[] }>('/folio/api/documents')
    expect(second.documents.filter((d) => d.type === 'settings')).toHaveLength(1)
  })

  it('seeds a singleton’s document from its own root block', async () => {
    await dtJson<{ documents: StoryMeta[] }>('/folio/api/documents?type=settings')
    const { doc } = await dtJson<{ doc: Doc }>('/folio/api/story/sng_settings/document')
    expect(doc.bloks[doc.root]?.type).toBe('settingsRoot')
  })

  it('seeds a record’s document from its own root block, with the title in its own field', async () => {
    const person = await dtCreate({ title: 'Grace Hopper', type: 'person' })
    const { doc } = await dtJson<{ doc: Doc }>(`/folio/api/story/${person.id}/document`)
    const root = doc.bloks[doc.root]

    expect(root?.type).toBe('personRoot')
    // `titleField: 'fullName'`, so the title lands where the schema keeps it —
    // this root block has no `title` field at all.
    expect(root?.data.fullName).toBe('Grace Hopper')
    expect(root?.data.title).toBeUndefined()
  })
})

describe('document types: PATCH and DELETE refusals', () => {
  it('refuses moving a record into the page tree', async () => {
    const ada = await dtCreate({ title: 'Ada Patch Test', type: 'person' })
    const page = await dtCreate({ title: 'Patch Target' })

    const { status, body } = await dtFailure(`/folio/api/stories/${ada.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: page.id }),
    })
    expect(status).toBe(400)
    expect(body.error.message).toBe('Cannot move an unrouted document into the page tree')
  })

  it('refuses changing a document’s type', async () => {
    const page = await dtCreate({ title: 'Retype Me' })
    const { status, body } = await dtFailure(`/folio/api/stories/${page.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'insight' }),
    })
    expect(status).toBe(409)
    expect(body.error.message).toBe("Cannot change a document's type")
  })

  it('renames a record without giving it a path', async () => {
    const ada = await dtCreate({ title: 'Ada Rename Test', type: 'person' })
    const patched = await dtJson<StoryMeta>(`/folio/api/stories/${ada.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Grace Rename Test' }),
    })
    expect(patched.title).toBe('Grace Rename Test')
    expect(patched.path).toBeNull()
  })

  it('refuses deleting a singleton', async () => {
    await dtJson('/folio/api/documents?type=settings')
    const { status, body } = await dtFailure('/folio/api/stories/sng_settings', {
      method: 'DELETE',
    })
    expect(status).toBe(409)
    expect(body.error.message).toBe('Cannot delete a singleton document')
  })

  it('refuses duplicating a singleton — the debt duplicate-and-paste.md deferred here', async () => {
    await dtJson('/folio/api/documents?type=settings')
    const { status, body } = await dtFailure('/folio/api/stories/sng_settings/duplicate', {
      method: 'POST',
    })
    expect(status).toBe(409)
    expect(body.error.message).toBe('Cannot duplicate a singleton document')
  })

  it('duplicates a record as another record of the same type', async () => {
    const ada = await dtCreate({ title: 'Ada Dup Test', type: 'person' })
    const { story } = await dtJson<{ story: StoryMeta }>(`/folio/api/stories/${ada.id}/duplicate`, {
      method: 'POST',
    })
    expect(story.type).toBe('person')
    expect(story.path).toBeNull()
    expect(story.title).toBe('Ada Dup Test (copy)')
  })

  it('deletes a record, and reports no path for it', async () => {
    const ada = await dtCreate({ title: 'Ada Delete Test', type: 'person' })
    const { deleted } = await dtJson<{ deleted: string[] }>(`/folio/api/stories/${ada.id}`, {
      method: 'DELETE',
    })
    expect(deleted).toEqual([ada.id])
  })
})

describe('document types: a second page type serves from the tree', () => {
  it('routes an insight under the page it lives beneath, and never serves a record', async () => {
    const parent = await dtCreate({ title: 'Insights Landing' })
    const insight = await dtCreate({
      title: 'A Real Insight',
      type: 'insight',
      parentId: parent.id,
    })
    expect(insight.path).toBe('insights-landing/a-real-insight')

    const ada = await dtCreate({ title: 'Ada Route Test', type: 'person' })

    // Published, and still not servable: `folio.published` matches on `path`,
    // and an unrouted row stores NULL.
    await dtCall(`/folio/api/story/${insight.id}/publish`, { method: 'POST' })
    await dtCall(`/folio/api/story/${ada.id}/publish`, { method: 'POST' })

    expect(await typedFolio().published(env, 'insights-landing/a-real-insight')).not.toBeNull()
    expect(await typedFolio().published(env, 'ada-route-test')).toBeNull()

    // And a preview request for a record's own slug is handed back to the host.
    const ctx = createExecutionContext()
    const preview = await typedFolio().handle(
      new Request(`${ORIGIN}/ada-route-test?_folio=preview`),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(preview).toBeNull()
  })

  it('caches the type’s own title field into stories.title on publish', async () => {
    const person = await dtCreate({ title: 'Placeholder Name', type: 'person' })
    const conn = await connect(person.id)
    const doc = await conn.hello('alice')
    await conn.tx('dttitle1', [{ t: 'set', uid: doc.root, field: 'fullName', value: 'Ada Byron' }])
    conn.close()

    const res = await dtJson<PublishResult>(`/folio/api/story/${person.id}/publish`, {
      method: 'POST',
    })

    // Both the row and the retained version record the fullName, from a root
    // block that has no `title` field to have read instead.
    expect(res.version.title).toBe('Ada Byron')
    const { documents } = await dtJson<{ documents: StoryMeta[] }>(
      '/folio/api/documents?type=person',
    )
    expect(documents.find((d) => d.id === person.id)?.title).toBe('Ada Byron')
  })
})

describe('document types: createFolio validates its config at construction', () => {
  const bindings = (e: Cloudflare.Env) => ({
    db: e.DB,
    story: e.STORY,
    media: e.MEDIA,
    images: e.IMAGES,
  })

  it('refuses both `types` and `root`', () => {
    expect(() =>
      createFolio<Cloudflare.Env>({
        blocks: [dtPage],
        root: 'pageRoot',
        types: DT_TYPES,
        bindings,
        auth: 'open',
      }),
    ).toThrow(/either `types` or `root`, not both/)
  })

  it('refuses neither', () => {
    expect(() => createFolio<Cloudflare.Env>({ blocks: [dtPage], bindings, auth: 'open' })).toThrow(
      /no document types configured/,
    )
  })

  it('refuses a type whose root block is not in the registry', () => {
    expect(() =>
      createFolio<Cloudflare.Env>({
        blocks: [dtPage],
        types: [{ name: 'page', label: 'Page', kind: 'page', root: 'ghost' }],
        bindings,
        auth: 'open',
      }),
    ).toThrow(/names root block 'ghost'/)
  })

  it('accepts the `root` sugar, expanding it to a single page type named "page"', async () => {
    // The name matters: 0006 defaults every pre-existing row's `type` to
    // 'page', so the sugar has to resolve those rows whatever the root block is
    // called.
    const folio = createFolio<Cloudflare.Env>({
      blocks: [dtPage],
      root: 'pageRoot',
      bindings,
      basePath: '/folio',
      auth: 'open',
    })
    const ctx = createExecutionContext()
    const res = await folio.handle(new Request(`${ORIGIN}/folio/api/schema`), env, ctx)
    await waitOnExecutionContext(ctx)

    const manifest = await res?.json<{ types: { name: string; root: string }[]; root: string }>()
    expect(manifest?.types).toEqual([
      { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot' },
    ])
    expect(manifest?.root).toBe('pageRoot')
  })
})
