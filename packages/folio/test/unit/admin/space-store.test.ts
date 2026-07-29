import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spaceEventEffect } from '../../../src/admin/hooks/useSpace'
import { avatarsOf, peersIn, SpaceStore } from '../../../src/admin/spaceStore'
import { PRESENCE_THROTTLE_MS, type WebSocketLike } from '../../../src/admin/store'
import {
  PROTOCOL_VERSION,
  type SpaceClientMsg,
  type SpaceEvent,
  type SpacePresence,
  type SpaceServerMsg,
} from '../../../src/core/protocol'

/**
 * The space channel's client half (`live-collaboration.md` phase 2).
 *
 * Everything on this channel is advisory, so there is nothing here about
 * ordering, watermarks or replay — the properties worth pinning are the ones a
 * person would notice: the peer list, the reconnect, the terminal codes, and the
 * throttle that keeps presence from being chatty.
 */

/** `WebSocket.readyState` values, spelled out as `store.test.ts` does. */
const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

class FakeSocket implements WebSocketLike {
  readyState = CONNECTING
  readonly frames: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(readonly path: string) {}

  send(data: string) {
    this.frames.push(data)
  }
  close() {
    this.readyState = CLOSED
  }
  open() {
    this.readyState = OPEN
    this.onopen?.({})
  }
  emit(msg: SpaceServerMsg) {
    this.onmessage?.({ data: JSON.stringify({ ...msg, v: PROTOCOL_VERSION }) })
  }
  deliver(data: string) {
    this.onmessage?.({ data })
  }
  drop(code?: number, reason?: string) {
    this.readyState = CLOSED
    this.onclose?.(code === undefined ? {} : { code, reason })
  }
  client(): SpaceClientMsg[] {
    return this.frames.map((f) => JSON.parse(f) as SpaceClientMsg)
  }
}

const IDENTITY = { actor: 'anon-1', name: 'Editor abc', colour: '#0090ff' }

function setup() {
  const sockets: FakeSocket[] = []
  const events: SpaceEvent[] = []
  const store = new SpaceStore('/folio', IDENTITY, {
    createSocket: (path) => {
      const socket = new FakeSocket(path)
      sockets.push(socket)
      return socket
    },
    onEvent: (e) => events.push(e),
  })
  return { store, sockets, events, last: () => sockets[sockets.length - 1]! }
}

const peer = (over: Partial<SpacePresence> = {}): SpacePresence => ({
  actor: 'usr_ann',
  name: 'Ann',
  colour: '#e5484d',
  role: 'editor',
  storyId: null,
  storyTitle: null,
  locale: null,
  selection: null,
  ...over,
})

type Where = Extract<SpaceClientMsg, { type: 'where' }>
type Selection = Extract<SpaceClientMsg, { type: 'selection' }>

const wheres = (s: FakeSocket) => s.client().filter((m): m is Where => m.type === 'where')
const selections = (s: FakeSocket) =>
  s.client().filter((m): m is Selection => m.type === 'selection')

describe('space store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('connecting', () => {
    it('opens the space socket and says hello with its advisory identity', () => {
      const h = setup()
      h.store.connect()
      expect(h.last().path).toBe('/folio/space/socket')
      // Nothing before the socket is open.
      expect(h.last().frames).toEqual([])

      h.last().open()
      expect(h.last().client()[0]).toEqual({
        type: 'hello',
        v: PROTOCOL_VERSION,
        identity: IDENTITY,
      })
      expect(h.store.getSnapshot().connected).toBe(true)
    })

    it('reconnects with backoff after the transport drops', () => {
      const h = setup()
      h.store.connect()
      h.last().open()

      h.last().drop()
      expect(h.store.getSnapshot().connected).toBe(false)
      vi.advanceTimersByTime(499)
      expect(h.sockets).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(h.sockets).toHaveLength(2)
    })

    /**
     * The peer list is emptied on a drop rather than left standing. Presence is
     * only true while the socket is up; a frozen list of avatars is worse than no
     * avatars, because it claims somebody is somewhere they may have left.
     */
    it('empties the peer list when the socket goes away', () => {
      const h = setup()
      h.store.connect()
      h.last().open()
      h.last().emit({ type: 'peers', peers: [peer()] })
      expect(h.store.getSnapshot().peers).toHaveLength(1)

      h.last().drop()
      expect(h.store.getSnapshot().peers).toEqual([])
    })

    it.each([
      [4001, 'protocol'],
      [4003, 'session'],
      [4004, 'credential'],
    ])('treats close %i as terminal and does not retry', (code, word) => {
      const h = setup()
      h.store.connect()
      h.last().open()

      h.last().drop(code)
      vi.advanceTimersByTime(60_000)

      expect(h.sockets).toHaveLength(1)
      expect(h.store.getSnapshot().notice?.toLowerCase()).toContain(word)
    })

    /** Nothing a person typed is on this channel, so the wording must not imply
     * anything was lost — unlike the story socket's own 4003 message. */
    it('never claims work was lost', () => {
      const h = setup()
      h.store.connect()
      h.last().open()
      h.last().drop(4003)
      expect(h.store.getSnapshot().notice).not.toContain('typed')
    })

    it('goes terminal on a version mismatch from the server', () => {
      const h = setup()
      h.store.connect()
      h.last().open()
      h.last().deliver(JSON.stringify({ type: 'peers', peers: [], v: PROTOCOL_VERSION + 1 }))

      expect(h.store.getSnapshot().notice).toContain('protocol version')
      vi.advanceTimersByTime(60_000)
      expect(h.sockets).toHaveLength(1)
    })

    it('reports an unreadable frame without closing', () => {
      const h = setup()
      h.store.connect()
      h.last().open()
      h.last().deliver('not json at all {{{')
      expect(h.store.getSnapshot().notice).toContain('Unreadable')
      expect(h.store.getSnapshot().connected).toBe(true)
    })
  })

  describe('presence', () => {
    it('announces where it is, once, and dedupes a repeat', () => {
      const h = setup()
      h.store.connect()
      h.last().open()

      h.store.setWhere('sty_home', 'Home', null)
      h.store.setWhere('sty_home', 'Home', null)
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)

      expect(wheres(h.last())).toEqual([
        // The `where` sent on open: nowhere in particular, which is a real place.
        { type: 'where', v: PROTOCOL_VERSION, storyId: null, storyTitle: null, locale: null },
        {
          type: 'where',
          v: PROTOCOL_VERSION,
          storyId: 'sty_home',
          storyTitle: 'Home',
          locale: null,
        },
      ])
    })

    /**
     * The chattiness bound: a burst inside one throttle window collapses to one
     * pair of frames, carrying the position actually held rather than the first
     * one of the burst.
     */
    it('collapses a burst into one trailing pair of frames', () => {
      const h = setup()
      h.store.connect()
      h.last().open()
      const before = wheres(h.last()).length

      for (const id of ['sty_a', 'sty_b', 'sty_c']) h.store.setWhere(id, id, null)
      expect(wheres(h.last())).toHaveLength(before)

      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      const sent = wheres(h.last()).slice(before)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.storyId).toBe('sty_c')
    })

    /** A selection naming a blok in the story you just left would draw a dot on
     * whatever block happens to share the uid. */
    it('drops the selection when the story changes', () => {
      const h = setup()
      h.store.connect()
      h.last().open()
      h.store.setWhere('sty_a', 'A', null)
      h.store.setSelection({ uid: 'hero0000', field: 'heading' })
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      expect(selections(h.last()).at(-1)?.selection).toEqual({ uid: 'hero0000', field: 'heading' })

      h.store.setWhere('sty_b', 'B', null)
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      expect(selections(h.last()).at(-1)?.selection).toBeNull()
    })

    it('re-announces its position on a reconnect', () => {
      const h = setup()
      h.store.connect()
      h.last().open()
      h.store.setWhere('sty_home', 'Home', 'fr')
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)

      h.last().drop()
      vi.advanceTimersByTime(500)
      h.last().open()

      expect(wheres(h.last()).at(-1)).toEqual({
        type: 'where',
        v: PROTOCOL_VERSION,
        storyId: 'sty_home',
        storyTitle: 'Home',
        locale: 'fr',
      })
    })

    it('replaces a peer per story and removes one that has gone', () => {
      const h = setup()
      h.store.connect()
      h.last().open()

      h.last().emit({ type: 'presence', peer: peer({ storyId: 'sty_a', storyTitle: 'A' }) })
      h.last().emit({
        type: 'presence',
        peer: peer({ storyId: 'sty_a', storyTitle: 'A', selection: { uid: 'x', field: null } }),
      })
      expect(h.store.getSnapshot().peers).toHaveLength(1)
      expect(h.store.getSnapshot().peers[0]?.selection).toEqual({ uid: 'x', field: null })

      h.last().emit({
        type: 'presence',
        peer: peer({ storyId: 'sty_a', storyTitle: 'A' }),
        gone: true,
      })
      expect(h.store.getSnapshot().peers).toEqual([])
    })

    /**
     * Two tabs are two presences on the wire and must both survive the keying, or
     * the second tab's arrival would silently delete the first one's row.
     */
    it('keeps two tabs of one actor as two presences', () => {
      const h = setup()
      h.store.connect()
      h.last().open()

      h.last().emit({ type: 'presence', peer: peer({ storyId: 'sty_a', storyTitle: 'A' }) })
      h.last().emit({ type: 'presence', peer: peer({ storyId: 'sty_b', storyTitle: 'B' }) })

      expect(h.store.getSnapshot().peers.map((p) => p.storyId)).toEqual(['sty_a', 'sty_b'])
    })
  })

  describe('events', () => {
    it('hands a structural event to its caller', () => {
      const h = setup()
      h.store.connect()
      h.last().open()
      const ev: SpaceEvent = { kind: 'story.deleted', ids: ['sty_x'], actor: 'usr_ann' }
      h.last().emit({ type: 'event', event: ev })
      expect(h.events).toEqual([ev])
    })
  })
})

/*
 * The avatar row's dedupe. Two tabs are the truth on the wire; two identical
 * avatars side by side is noise, so the display collapses them.
 */
describe('avatarsOf', () => {
  it('collapses an actor’s tabs into one entry with a count', () => {
    const list = avatarsOf([
      peer({ storyId: 'sty_a', storyTitle: 'A' }),
      peer({ storyId: 'sty_b', storyTitle: 'B' }),
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ actor: 'usr_ann', tabs: 2, storyId: 'sty_a' })
  })

  /** "Ann is on About" beats "Ann is somewhere" just because her other tab
   * happens to be on a list screen. */
  it('prefers the tab that is actually in a document', () => {
    const list = avatarsOf([
      peer({ storyId: null }),
      peer({ storyId: 'sty_b', storyTitle: 'B', locale: 'fr' }),
    ])
    expect(list[0]).toMatchObject({ storyId: 'sty_b', storyTitle: 'B', locale: 'fr', tabs: 2 })
  })

  it('keeps different actors apart', () => {
    const list = avatarsOf([peer(), peer({ actor: 'usr_ben', name: 'Ben' })])
    expect(list.map((a) => a.actor)).toEqual(['usr_ann', 'usr_ben'])
  })
})

describe('peersIn', () => {
  it('finds the people in one story, deduped by actor', () => {
    const peers = [
      peer({ storyId: 'sty_a' }),
      peer({ storyId: 'sty_a' }),
      peer({ actor: 'usr_ben', name: 'Ben', storyId: 'sty_b' }),
    ]
    expect(peersIn(peers, 'sty_a')).toEqual([expect.objectContaining({ tabs: 2 })])
    expect(peersIn(peers, 'sty_b').map((p) => p.name)).toEqual(['Ben'])
    expect(peersIn(peers, 'sty_c')).toEqual([])
  })
})

/*
 * What one event means for this editor. Pure, so every branch is covered without
 * a socket or a tree.
 */
describe('spaceEventEffect', () => {
  const ctx = {
    openStoryId: 'sty_open',
    myActor: 'usr_me',
    nameOf: (actor: string | null) => (actor === 'usr_ann' ? 'Ann' : 'Someone'),
  }

  /** The client that made the change already reloaded; telling somebody "you
   * moved this page" is noise. */
  it('ignores an event this client caused', () => {
    const effect = spaceEventEffect(
      { kind: 'story.deleted', ids: ['sty_open'], actor: 'usr_me' },
      ctx,
    )
    expect(effect).toEqual({ reload: false, globals: false, notice: null })
  })

  /** Under `auth: 'open'` there is no actor to compare, so the redundant reload
   * happens rather than a deployment with no identity inventing one. */
  it('does not suppress an event with no actor at all', () => {
    const effect = spaceEventEffect({ kind: 'story.deleted', ids: ['sty_x'], actor: null }, ctx)
    expect(effect.reload).toBe(true)
  })

  it('reloads for a create, and says nothing about it', () => {
    const effect = spaceEventEffect(
      {
        kind: 'story.created',
        id: 'sty_new',
        parentId: null,
        title: 'New',
        type: 'page',
        actor: 'usr_ann',
      },
      ctx,
    )
    expect(effect).toEqual({ reload: true, globals: false, notice: null })
  })

  it('names who moved the open page, and where to', () => {
    const effect = spaceEventEffect(
      {
        kind: 'story.updated',
        changes: [{ id: 'sty_open', from: 'old', to: 'new' }],
        actor: 'usr_ann',
      },
      ctx,
    )
    expect(effect).toEqual({ reload: true, globals: false, notice: 'Ann moved this page to /new' })
  })

  it('reloads but stays quiet when the move was somewhere else', () => {
    const effect = spaceEventEffect(
      {
        kind: 'story.updated',
        changes: [{ id: 'sty_other', from: 'a', to: 'b' }],
        actor: 'usr_ann',
      },
      ctx,
    )
    expect(effect).toEqual({ reload: true, globals: false, notice: null })
  })

  /** Told, rather than discovered through a 4002 close with no explanation. */
  it('explains a delete of the open page', () => {
    const effect = spaceEventEffect(
      { kind: 'story.deleted', ids: ['sty_a', 'sty_open'], actor: 'usr_ann' },
      ctx,
    )
    expect(effect.notice).toBe('Ann deleted this page')
  })

  it('names who published the open page', () => {
    const effect = spaceEventEffect(
      {
        kind: 'story.published',
        id: 'sty_open',
        title: 'Open',
        at: 1,
        versionId: 'ver_1',
        actor: 'usr_ann',
      },
      ctx,
    )
    expect(effect.notice).toBe('Ann published this page')
  })

  it('falls back to “Someone” for an actor who has already left', () => {
    const effect = spaceEventEffect(
      { kind: 'story.deleted', ids: ['sty_open'], actor: 'usr_gone' },
      ctx,
    )
    expect(effect.notice).toBe('Someone deleted this page')
  })

  /** Content, not structure: the tree and the open document are untouched. */
  it('refreshes only the globals for a global.changed', () => {
    const effect = spaceEventEffect(
      { kind: 'global.changed', name: 'header', storyId: 'sng_header', actor: 'usr_ann' },
      ctx,
    )
    expect(effect).toEqual({ reload: false, globals: true, notice: null })
  })
})
