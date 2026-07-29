import { describe, expect, it } from 'vitest'
import {
  globalOwning,
  type PostableWindow,
  PreviewBridge,
  readyFrames,
} from '../../../src/admin/hooks/usePreviewBridge'
import type { Doc } from '../../../src/core/doc'
import { PROTOCOL_VERSION } from '../../../src/core/protocol'

/**
 * `PreviewBridge` is the framework-free half of the admin's side of the
 * postMessage seam — no iframe, no React tree, no window — so the ready
 * handshake can be driven directly with a fake `contentWindow`, the same way
 * `test/unit/admin/store.test.ts` drives `StoryStore` with a fake socket
 * instead of a real one. `readyFrames`, the pure function that shapes
 * `onReady`'s argument, is exercised the same way: it is what the hook calls
 * with the seam's live props at handshake time, and it needs no DOM either.
 *
 * What is deliberately *not* covered here: the hook's own `message` listener
 * (`window.addEventListener`, `MessageEvent`, `e.source`) needs a DOM, and
 * `test/unit` runs in Node (see vitest.config.ts) — there is no jsdom project
 * to render it in. The re-derivation this revision adds lives entirely in
 * `readyFrames` and `PreviewBridge.onReady`, both reachable without one; only
 * the hook's plumbing that reads `latest.current` and calls them is not
 * separately exercised.
 */

const ORIGIN = 'https://example.test'

/** Stands in for `iframe.contentWindow`. Records every frame actually posted. */
class FakeWindow implements PostableWindow {
  readonly posted: unknown[] = []
  postMessage(message: unknown) {
    this.posted.push(message)
  }
}

const doc = (root = 'root0000') => ({ root, bloks: {} })
const resolution = { stories: {}, assetBase: '/folio/asset' }

describe('readyFrames', () => {
  it('shapes resolve and select unconditionally, replace only when there is a document', () => {
    expect(readyFrames({ doc: null, resolution, selection: 'blk_1', root: 'root0000' })).toEqual({
      resolve: { type: 'resolve', resolution },
      replace: null,
      select: { type: 'select', uid: 'blk_1' },
    })
  })

  it('includes replace once there is a document to show', () => {
    const frames = readyFrames({
      doc: doc(),
      resolution,
      selection: null,
      root: 'root0000',
    })
    expect(frames.replace).toEqual({ type: 'replace', doc: doc() })
  })

  it('clears the selection when it names the root block, so the preview does not outline the whole page', () => {
    const frames = readyFrames({
      doc: doc('root0000'),
      resolution,
      selection: 'root0000',
      root: 'root0000',
    })
    expect(frames.select).toEqual({ type: 'select', uid: null })
  })
})

describe('PreviewBridge: before ready', () => {
  it('drops every message type, not just apply — nothing is buffered for later', () => {
    const bridge = new PreviewBridge()
    const win = new FakeWindow()
    bridge.send(win, ORIGIN, { type: 'apply', mutations: [] })
    bridge.send(win, ORIGIN, { type: 'replace', doc: doc() })
    bridge.send(win, ORIGIN, { type: 'resolve', resolution })
    bridge.send(win, ORIGIN, { type: 'select', uid: 'blk_1' })
    expect(win.posted).toEqual([])
  })
})

describe('PreviewBridge: onReady', () => {
  it('posts resolve, replace and select, in that order', () => {
    const bridge = new PreviewBridge()
    const win = new FakeWindow()
    bridge.onReady(
      win,
      ORIGIN,
      readyFrames({ doc: doc('root0000'), resolution, selection: 'blk_1', root: 'root0000' }),
    )
    expect(win.posted).toEqual([
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'resolve', resolution },
      {
        source: 'folio-admin',
        v: PROTOCOL_VERSION,
        type: 'replace',
        doc: doc('root0000'),
      },
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'select', uid: 'blk_1' },
    ])
  })

  it('skips replace when there is no document yet, still posts resolve and select', () => {
    const bridge = new PreviewBridge()
    const win = new FakeWindow()
    bridge.onReady(
      win,
      ORIGIN,
      readyFrames({ doc: null, resolution, selection: null, root: undefined }),
    )
    expect(win.posted).toEqual([
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'resolve', resolution },
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'select', uid: null },
    ])
  })

  it('sends live, unbuffered, once ready', () => {
    const bridge = new PreviewBridge()
    const win = new FakeWindow()
    bridge.onReady(
      win,
      ORIGIN,
      readyFrames({ doc: null, resolution, selection: null, root: undefined }),
    )
    win.posted.length = 0
    bridge.send(win, ORIGIN, { type: 'select', uid: 'blk_9' })
    expect(win.posted).toEqual([
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'select', uid: 'blk_9' },
    ])
  })

  it('forwards apply once ready, unlike before the handshake', () => {
    const bridge = new PreviewBridge()
    const win = new FakeWindow()
    bridge.onReady(
      win,
      ORIGIN,
      readyFrames({ doc: null, resolution, selection: null, root: undefined }),
    )
    win.posted.length = 0
    bridge.send(win, ORIGIN, { type: 'apply', mutations: [] })
    expect(win.posted).toEqual([
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'apply', mutations: [] },
    ])
  })

  /**
   * The first blocker this revision fixes: a mutation that lands between the
   * store's bootstrap and the frame's `ready` used to be lost, because the
   * old `onReady` replayed a `replace` buffered *before* the mutation
   * happened. Nothing is buffered now — the caller passes `readyFrames`
   * whatever `store.getSnapshot().doc` says *at the moment `ready` arrives*,
   * so a later document reaches the preview even though nothing describing
   * that change was ever `send`-ed while it was not yet ready.
   */
  it('is handed the document as it stands at handshake time, not as it stood whenever send last ran', () => {
    const bridge = new PreviewBridge()
    const win = new FakeWindow()
    // Nothing sent before ready reaches the preview regardless (see the
    // 'before ready' block above) — the point is that onReady is not limited
    // to replaying it even if it had.
    bridge.send(win, ORIGIN, { type: 'replace', doc: doc('root0000') })
    bridge.onReady(
      win,
      ORIGIN,
      readyFrames({ doc: doc('root_v2'), resolution, selection: null, root: undefined }),
    )
    const replace = win.posted.find((m) => (m as { type: string }).type === 'replace')
    expect(replace).toEqual({
      source: 'folio-admin',
      v: PROTOCOL_VERSION,
      type: 'replace',
      doc: doc('root_v2'),
    })
  })

  /**
   * The second blocker: a repeat `ready` from the same frame (an in-frame
   * reload, or a navigation because `previewUrl` changed under an unchanged
   * iframe key) used to post nothing, because the buffer it would have
   * replayed from was already drained by the first `ready`. `onReady` takes
   * no state from the last time it ran, so a second call re-seeds exactly as
   * fully as the first.
   */
  it('re-seeds fully on a second ready from the same frame, with no reset in between', () => {
    const bridge = new PreviewBridge()
    const win = new FakeWindow()
    bridge.onReady(
      win,
      ORIGIN,
      readyFrames({ doc: doc('root0000'), resolution, selection: 'blk_1', root: 'root0000' }),
    )
    win.posted.length = 0

    // The frame reloaded or navigated in place: the iframe node and the
    // bridge's `ready` flag are unchanged, but the preview app is starting
    // from scratch and says `ready` again.
    bridge.onReady(
      win,
      ORIGIN,
      readyFrames({ doc: doc('root0000'), resolution, selection: 'blk_2', root: 'root0000' }),
    )
    expect(win.posted).toEqual([
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'resolve', resolution },
      {
        source: 'folio-admin',
        v: PROTOCOL_VERSION,
        type: 'replace',
        doc: doc('root0000'),
      },
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'select', uid: 'blk_2' },
    ])
  })
})

// content-model/globals.md checkpoint 3: clicking a block inside a global
// while previewing something else offers "Edit `<name>` →" rather than
// selecting it. `globalOwning` is the whole decision, pure so it needs
// neither a DOM nor a mounted bridge.
describe('globalOwning', () => {
  const blok = (uid: string, type = 'x') => ({
    uid,
    type,
    parent: null,
    slot: null,
    order: 'a0',
    data: {},
  })
  const header: Doc = { root: 'hdr1', bloks: { hdr1: blok('hdr1') } }
  const footer: Doc = { root: 'ftr1', bloks: { ftr1: blok('ftr1') } }
  const openDoc: Doc = { root: 'pg1', bloks: { pg1: blok('pg1') } }

  it('is null for a uid that belongs to the document currently open', () => {
    expect(globalOwning('pg1', openDoc, { header, footer })).toBeNull()
  })

  it('names the global a uid belongs to when it is not in the open document', () => {
    expect(globalOwning('hdr1', openDoc, { header, footer })).toBe('header')
    expect(globalOwning('ftr1', openDoc, { header, footer })).toBe('footer')
  })

  it('is null when the uid belongs to neither the open document nor any global', () => {
    expect(globalOwning('nope', openDoc, { header, footer })).toBeNull()
  })

  it('is null with no globals at all, and with no uid', () => {
    expect(globalOwning('hdr1', openDoc, undefined)).toBeNull()
    expect(globalOwning(null, openDoc, { header })).toBeNull()
  })

  it('prefers the open document over a global, if a uid somehow existed in both', () => {
    const clash: Doc = { root: 'hdr1', bloks: { hdr1: blok('hdr1') } }
    expect(globalOwning('hdr1', clash, { header })).toBeNull()
  })
})

describe('PreviewBridge: reset', () => {
  /**
   * The scenario the whole seam exists for: a story switch remounts the
   * iframe (it is keyed on the story id in Editor), so the bridge is reset
   * when the new node attaches. Nothing sent in the gap before the new
   * frame's `ready` reaches it — same as before any `ready` at all — and the
   * next `ready` re-seeds fully regardless, exactly as the first one would.
   */
  it('drops back into gating sends on the new frame until its own ready', () => {
    const bridge = new PreviewBridge()
    const oldWin = new FakeWindow()
    bridge.onReady(
      oldWin,
      ORIGIN,
      readyFrames({ doc: null, resolution, selection: null, root: undefined }),
    )

    bridge.reset()

    const newWin = new FakeWindow()
    bridge.send(newWin, ORIGIN, { type: 'select', uid: 'blk_2' })
    expect(newWin.posted).toEqual([])

    bridge.onReady(
      newWin,
      ORIGIN,
      readyFrames({ doc: doc(), resolution, selection: 'blk_after_switch', root: undefined }),
    )
    expect(newWin.posted).toEqual([
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'resolve', resolution },
      { source: 'folio-admin', v: PROTOCOL_VERSION, type: 'replace', doc: doc() },
      {
        source: 'folio-admin',
        v: PROTOCOL_VERSION,
        type: 'select',
        uid: 'blk_after_switch',
      },
    ])
  })
})
