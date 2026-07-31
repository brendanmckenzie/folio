// Exercises the space channel end to end
// (docs/specs/editing/live-collaboration.md).
//
// Three clients, which is the minimum that can show what this feature is for:
// two *story* sockets on two different documents, plus a *space* socket. The
// workers suite drives `SpaceDO` through a stub; everything between that and a
// browser — the mount path, the upgrade route, the session cookie on a WebSocket,
// the internal hook firing on a real HTTP write and reaching a real Durable
// Object over RPC — exists only here.
//
// The load-bearing checks:
//   - cross-story presence: an editor in one document is visible to an editor in
//     another, which no story object can know;
//   - a rename through the HTTP API reaches the space socket as `story.updated`,
//     naming every path that moved (the subtree, not just the row);
//   - the renaming client and a peer both converge on the new tree from
//     `GET /folio/api/stories`, which is what the client reloads on the event;
//   - **per-block presence on a story socket is unchanged by any of it** — the
//     regression that would matter most, since the space channel duplicates the
//     selection deliberately (decision 2) and must not have replaced anything.

import './lib/ts-resolve.mjs'

// The demo configures a real sign-in provider (identity-and-access.md), so every
// route here needs a session. `signInGlobally` makes this process's `fetch` and
// `WebSocket` carry the admin's cookie; `signIn` gets a second, different editor,
// because identity on a socket is server-supplied and two sockets held by one
// account are one person in presence.
import { DEMO_EDITOR, signIn, signInGlobally } from './lib/auth.mjs'

await signInGlobally()
const EDITOR_COOKIE = await signIn(undefined, DEMO_EDITOR)
const EDITOR_ID = 'usr_demoeditor'
const ADMIN_ID = 'usr_demoadmin1'

const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const API = `${BASE}/api`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())

/** A socket with an inbox and a bounded `expect`, as every other script has. */
function socket(name, url, cookie) {
  const ws = cookie ? new WebSocket(url, { headers: { cookie } }) : new WebSocket(url)
  const inbox = []
  const waiters = []
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    inbox.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) waiters.splice(i, 1)[0].resolve(msg)
    }
  })
  return {
    name,
    ws,
    inbox,
    open: () => new Promise((r) => ws.addEventListener('open', r, { once: true })),
    // Every frame carries the wire version — the object refuses one that omits it,
    // and a refused frame looks like a hang rather than an error.
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    expect(match, ms = 4000) {
      const hit = inbox.find(match)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error(`${name}: timeout waiting for message`)), ms)
      })
    },
  }
}

const storySocket = (name, storyId, cookie) =>
  socket(name, `ws://localhost:5199/folio/api/story/${storyId}/socket`, cookie)

const spaceSocket = (name, cookie) =>
  socket(name, 'ws://localhost:5199/folio/api/space/socket', cookie)

/* ------------------------------------------------------------------ setup --- */

// Two documents. The home page is seeded; the second is created here so the
// rename below cannot disturb anything another script depends on.
const home = 'sty_home'
const made = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Space Test Page', parentId: null }),
})
check('a second page exists to be in', typeof made.id === 'string', made.id)
const child = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Space Test Child', parentId: made.id }),
})
check('with a child, so a rename has a subtree to move', child.parentId === made.id)

// Both drafts have to exist before a socket can bootstrap from them.
await fetch(`${HTTP}/?_folio=preview`)
await fetch(`${API}/story/${made.id}/document`)

/* ---------------------------------------------------- cross-story presence --- */

// Ann (the admin) is on the home page. Ben (the editor) is on the new one. On the
// story channel they cannot see each other at all — different documents, and that
// is correct. The space channel is the only thing that can.
const annStory = storySocket('ann/story', home)
const benStory = storySocket('ben/story', made.id, EDITOR_COOKIE)
const annSpace = spaceSocket('ann/space')
const benSpace = spaceSocket('ben/space', EDITOR_COOKIE)
await Promise.all([annStory.open(), benStory.open(), annSpace.open(), benSpace.open()])

annStory.send({ type: 'hello', lastSyncId: 0 })
benStory.send({ type: 'hello', lastSyncId: 0 })
const annBoot = await annStory.expect((m) => m.type === 'bootstrap')
const benBoot = await benStory.expect((m) => m.type === 'bootstrap')
check('both story sockets bootstrap', !!annBoot.doc?.root && !!benBoot.doc?.root)

annSpace.send({ type: 'hello' })
const annPeers = await annSpace.expect((m) => m.type === 'peers')
check('the space channel answers hello with a peer list', Array.isArray(annPeers.peers))

benSpace.send({ type: 'hello' })
await benSpace.expect((m) => m.type === 'peers')

// Ann learns Ben arrived, and as the account the Worker vouched for — not as
// anything his client asserted.
const benArrived = await annSpace.expect(
  (m) => m.type === 'presence' && m.peer?.actor === EDITOR_ID,
)
check('Ann sees Ben in the site as his signed-in identity', !!benArrived, benArrived.peer?.name)
check('presence carries a role, and never a session id', benArrived.peer.role !== undefined)
check(
  'no session id or expiry rides a presence frame',
  !('session' in benArrived.peer) && !('expiresAt' in benArrived.peer),
)

// Now each says where they are. This is what makes the avatar say "Ben — Space
// Test Page" rather than just "Ben".
annSpace.send({ type: 'where', storyId: home, storyTitle: 'Home', locale: null })
benSpace.send({ type: 'where', storyId: made.id, storyTitle: 'Space Test Page', locale: null })

const benWhere = await annSpace.expect(
  (m) => m.type === 'presence' && m.peer?.actor === EDITOR_ID && m.peer?.storyId === made.id,
)
check(
  'Ann sees which document Ben is in',
  benWhere.peer.storyTitle === 'Space Test Page',
  benWhere.peer.storyTitle,
)
const annWhere = await benSpace.expect(
  (m) => m.type === 'presence' && m.peer?.actor === ADMIN_ID && m.peer?.storyId === home,
)
check('and Ben sees Ann on a different one', annWhere.peer.storyId === home)

// Neither appears in the other's *per-block* presence: they are in different
// documents, so the story channel is right to say nothing.
await wait(200)
const annStoryPeers = annStory.inbox.filter((m) => m.type === 'presence')
check(
  'neither editor appears in the other’s per-block presence',
  !annStoryPeers.some((m) => m.peer?.actor === EDITOR_ID),
  `${annStoryPeers.length} story presence frames`,
)

/* ------------------------------------------- selection on both channels --- */

// Deliberate duplication (decision 2): a selection rides the story channel for
// the per-block dots and the space channel for the tree and follow-mode.
const annRoot = annBoot.doc.root
annStory.send({ type: 'presence', selection: { uid: annRoot, field: 'title' } })
annSpace.send({ type: 'selection', selection: { uid: annRoot, field: 'title' } })

const followable = await benSpace.expect(
  (m) => m.type === 'presence' && m.peer?.actor === ADMIN_ID && m.peer?.selection !== null,
)
check(
  'the space channel carries the selection follow-mode needs',
  followable.peer.selection.uid === annRoot && followable.peer.selection.field === 'title',
  JSON.stringify(followable.peer.selection),
)

// A second editor on the *same* document still gets the per-block dot, which is
// the property the space channel must not have replaced.
const annStory2 = storySocket('ann/story-2', made.id)
await annStory2.open()
annStory2.send({ type: 'hello', lastSyncId: 0 })
const boot2 = await annStory2.expect((m) => m.type === 'bootstrap')
annStory2.send({ type: 'presence', selection: { uid: boot2.doc.root, field: 'title' } })
const perBlock = await benStory.expect(
  (m) => m.type === 'presence' && m.peer?.selection?.uid === boot2.doc.root,
)
check(
  'per-block presence on a story socket is unchanged, and now names a field',
  perBlock.peer.selection.field === 'title',
  JSON.stringify(perBlock.peer.selection),
)

/* -------------------------------------------------- a rename broadcasts --- */

const renamed = await json(`${API}/stories/${made.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ slug: 'space-test-renamed' }),
})
check('the rename landed', renamed.path === 'space-test-renamed', renamed.path)

// Both space sockets hear it — including Ann's, whose account made the request:
// the object broadcasts to every joined socket, and the *client* ignores its own
// echo by comparing `actor`.
const onBen = await benSpace.expect((m) => m.type === 'event' && m.event?.kind === 'story.updated')
check('the rename reaches a peer’s space socket', !!onBen)
check(
  'the event names every path that moved, not just the renamed row',
  onBen.event.changes.length === 2 &&
    onBen.event.changes.some((c) => c.id === made.id && c.to === 'space-test-renamed') &&
    onBen.event.changes.some((c) => c.id === child.id),
  `${onBen.event.changes.length} changes`,
)
check(
  'the event is attributed, so the client that caused it can ignore its own echo',
  onBen.event.actor === ADMIN_ID,
  onBen.event.actor,
)
const onAnn = await annSpace.expect((m) => m.type === 'event' && m.event?.kind === 'story.updated')
check('the renaming client hears it too, and filters by actor', onAnn.event.actor === ADMIN_ID)

// What the client does with it: reload the tree. Both editors converge, and the
// URL is the server's own — which is exactly why the event triggers a reload
// rather than a patch (the admin cannot compute a host's `route`).
// Flat mode, because the tree route answers one level at a time now
// (`foundation/pagination.md` decision 2) and this wants the whole reloaded set —
// including a descendant two levels down, which is the point of the second check.
const flat = (await json(`${API}/stories?flat=1&limit=200`)).rows
const renamedNode = flat.find((n) => n.id === made.id)
const childNode = flat.find((n) => n.id === child.id)
check('the reloaded tree carries the new path', renamedNode?.path === 'space-test-renamed')
check(
  'and the subtree moved with it, URL included',
  childNode?.path?.startsWith('space-test-renamed/') &&
    childNode?.url?.includes('space-test-renamed'),
  childNode?.url,
)

/* ------------------------------------------------- publish and delete --- */

const published = await json(`${API}/story/${made.id}/publish`, { method: 'POST' })
check('publish returns ok', published.ok === true)
const pubEvent = await benSpace.expect(
  (m) => m.type === 'event' && m.event?.kind === 'story.published' && m.event.id === made.id,
)
check(
  'a publish reaches every open admin, naming the version and who did it',
  pubEvent.event.versionId?.startsWith('ver_') && pubEvent.event.actor === ADMIN_ID,
  pubEvent.event.versionId,
)

// A delete is explained rather than discovered through an unexplained 4002.
const deleted = await json(`${API}/stories/${child.id}?redirect=false`, { method: 'DELETE' })
check('the delete landed', deleted.deleted?.includes(child.id))
const delEvent = await benSpace.expect(
  (m) => m.type === 'event' && m.event?.kind === 'story.deleted',
)
check('a delete reaches every open admin with the ids', delEvent.event.ids.includes(child.id))

/* --------------------------------------------------- protocol discipline --- */

// A frame with no version is refused and the socket closed 4001, exactly as on
// the story channel. Checked on a socket of its own so nothing above is disturbed.
const stale = spaceSocket('stale')
await stale.open()
const staleClosed = new Promise((r) =>
  stale.ws.addEventListener('close', (e) => r(e.code), { once: true }),
)
stale.ws.send(JSON.stringify({ type: 'hello' }))
const staleError = await stale.expect((m) => m.type === 'error')
check(
  'an unversioned space frame is refused',
  staleError.reason.includes('unset'),
  staleError.reason,
)
check('and the socket is closed 4001', (await staleClosed) === 4001)

// A departure is announced, so an avatar disappears rather than lingering.
benSpace.ws.close()
const gone = await annSpace.expect(
  (m) => m.type === 'presence' && m.peer?.actor === EDITOR_ID && m.gone === true,
)
check('a peer leaving the site is announced', !!gone)

annStory.ws.close()
annStory2.ws.close()
benStory.ws.close()
annSpace.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
