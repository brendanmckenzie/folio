import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Doc } from '../../core/doc'
import {
  type AdminToPreviewMsg,
  isPreviewMsg,
  PROTOCOL_VERSION,
  type PreviewFrame,
} from '../../core/protocol'
import type { Resolution } from '../../core/resolve'
import type { StoryStore } from '../store'
import type { Blocks } from './useBlocks'
import type { PreviewSource } from './useVersions'

interface Options {
  store: StoryStore
  /** Story and asset links, so the preview resolves them without a server render. */
  resolution: Resolution
  /** What the iframe must be showing. Owned by useVersions. */
  source: PreviewSource
  selection: string | null
  /** The document's root blok uid, which is never outlined in the preview. */
  root: string | undefined
  blocks: Blocks
  /** Brings the Blocks rail forward when a block is picked in the preview. */
  onPick: () => void
}

/** The one method this seam needs from `HTMLIFrameElement['contentWindow']`. */
export interface PostableWindow {
  postMessage(message: unknown, targetOrigin: string): void
}

function post(win: PostableWindow | null | undefined, origin: string, msg: AdminToPreviewMsg) {
  win?.postMessage({ source: 'folio-admin', v: PROTOCOL_VERSION, ...msg }, origin)
}

/** What a preview must be told the instant it completes (or repeats) its `ready` handshake. */
export interface ReadyFrames {
  resolve: Extract<AdminToPreviewMsg, { type: 'resolve' }>
  /** Null when there is no document to show yet — e.g. the store has not bootstrapped. */
  replace: Extract<AdminToPreviewMsg, { type: 'replace' }> | null
  select: Extract<AdminToPreviewMsg, { type: 'select' }>
}

/**
 * The full re-seed a `ready` handshake sends, computed fresh from the seam's
 * current state rather than from anything sent earlier. `doc` is the caller's
 * job to pick (live snapshot vs. the version being viewed): this function only
 * shapes it into a frame.
 */
export function readyFrames(opts: {
  doc: Doc | null
  resolution: Resolution
  selection: string | null
  root: string | undefined
}): ReadyFrames {
  const { doc, resolution, selection, root } = opts
  return {
    resolve: { type: 'resolve', resolution },
    replace: doc ? { type: 'replace', doc } : null,
    // The root block wraps the whole page, so outlining it in the preview
    // would just frame everything. Select it in the inspector without
    // highlighting it there.
    select: { type: 'select', uid: selection === root ? null : selection },
  }
}

/**
 * The admin's half of the postMessage handshake: a readiness gate and
 * posting. Framework-free on purpose, the same shape as `StoryStore` is to
 * the WebSocket, so the handshake can be driven directly by a test with a
 * fake `contentWindow` rather than only through a mounted React tree.
 *
 * Carries no buffer of its own. An earlier version buffered the latest
 * `resolve`/`replace`/`select` sent before `ready` and replayed that buffer at
 * the handshake — but a buffer of what was *sent* goes stale the moment
 * something changes after the last send and before `ready` arrives, and it is
 * simply gone for a *second* `ready` from the same frame (an in-frame reload,
 * or a navigation because `previewUrl` changed) with nothing freshly sent in
 * between. `onReady` now takes the seam's current, freshly-derived state
 * directly (`readyFrames`, computed by the caller at handshake time) instead
 * of trusting history to still be true.
 */
export class PreviewBridge {
  private ready = false

  /**
   * A new iframe node is a preview that remembers nothing: the previous one's
   * handshake does not carry over, so nothing is sent to it until its own
   * `ready` arrives. Called from the ref callback whenever the DOM node
   * changes, which is what a story switch does (the iframe is keyed on the
   * story id in Editor).
   */
  reset(): void {
    this.ready = false
  }

  /**
   * Sends `msg` to `win` once the preview has completed its handshake; a
   * no-op before it. Nothing is buffered for later: whatever the preview
   * needs on arrival is re-derived wholesale in `onReady`, not replayed from
   * what was sent here.
   */
  send(win: PostableWindow | null | undefined, origin: string, msg: AdminToPreviewMsg): void {
    if (!this.ready) return
    post(win, origin, msg)
  }

  /**
   * The preview's `ready` handshake, including a repeat one from the same
   * frame. Always posts resolve, then replace (if there is a document yet),
   * then select — in that order, so a selection never highlights into a
   * document that has not been resolved or replaced yet — computed by the
   * caller from current state rather than replayed from history. This is what
   * makes a repeat `ready` (frame reload, or a navigation from a changed
   * `previewUrl`) self-healing instead of a no-op: it gets exactly the same
   * re-seed a brand new frame would.
   */
  onReady(win: PostableWindow | null | undefined, origin: string, frames: ReadyFrames): void {
    this.ready = true
    post(win, origin, frames.resolve)
    if (frames.replace) post(win, origin, frames.replace)
    post(win, origin, frames.select)
  }
}

/**
 * The whole conversation with the preview iframe, in both directions, plus the
 * store's connection to it.
 *
 * Returns a ref callback for the iframe. Nothing else in the editor talks to
 * the frame: this is the one seam where a document reaches the preview, which
 * is why it is also the one place that has to know whether the live draft or
 * a version is on screen.
 */
export function usePreviewBridge({
  store,
  resolution,
  source,
  selection,
  root,
  blocks,
  onPick,
}: Options): (node: HTMLIFrameElement | null) => void {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const bridge = useMemo(() => new PreviewBridge(), [])

  /**
   * The seam's copy of what is on screen.
   *
   * A ref rather than an effect dependency because the store's callbacks and
   * the window's message handler fire outside React's render, and because the
   * connect effect below closes the socket on cleanup — re-running it every
   * time someone opens a version preview would drop and reopen the WebSocket.
   */
  const showing = useRef(source)
  showing.current = source

  /**
   * The seam's copy of the props `readyFrames` re-derives from at handshake
   * time. Also a ref rather than a `message`-listener dependency: resolution
   * and selection change on effectively every keystroke, and re-subscribing
   * the listener that often is pure churn when only the values it reads need
   * to be current, not the closure itself.
   */
  const latest = useRef({ resolution, selection, root })
  latest.current = { resolution, selection, root }

  const toFrame = useCallback(
    (msg: AdminToPreviewMsg) => {
      bridge.send(frame.current?.contentWindow, window.location.origin, msg)
    },
    [bridge],
  )

  /**
   * The ref callback React attaches the iframe through. A story switch
   * remounts the iframe wholesale (Editor keys it on the story id), so the new
   * node's handshake is genuinely a new one: the bridge is reset here, on the
   * node changing, rather than only reacting to the next `ready` — a message
   * sent between the swap and that handshake would otherwise go straight to a
   * frame with no listener attached yet and be lost, same as the bug this
   * whole seam exists to fix.
   */
  const setFrame = useCallback(
    (node: HTMLIFrameElement | null) => {
      frame.current = node
      bridge.reset()
    },
    [bridge],
  )

  useEffect(() => {
    store.onMutations = (mutations) => {
      // While previewing a version the iframe is showing something other than
      // the live document, so live edits must not be applied to it.
      if (showing.current.mode === 'viewing') return
      toFrame({ type: 'apply', mutations })
    }
    store.onReset = (doc) => {
      if (showing.current.mode === 'viewing') return
      toFrame({ type: 'replace', doc })
    }
    store.connect()
    return () => store.disconnect()
  }, [store, toFrame])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      // Not just same-origin: the frame this bridge actually owns. Same-origin
      // alone would also admit a second preview instance, or a stale one still
      // finishing its own teardown mid-swap.
      if (e.source !== frame.current?.contentWindow) return
      const data = e.data as Partial<PreviewFrame> | null
      if (data?.source !== 'folio-preview') return
      if (!isPreviewMsg(data)) return
      const msg = data

      if (msg.type === 'ready') {
        // Re-derived fresh, not replayed: covers first load (nothing to
        // replay yet, but the live values are already real), a story switch,
        // and a repeat `ready` from the same frame (reload, or a navigation
        // from a changed `previewUrl`) alike. See `PreviewBridge` doc.
        const { resolution, selection, root } = latest.current
        bridge.onReady(
          frame.current?.contentWindow,
          window.location.origin,
          readyFrames({
            doc: showing.current.doc ?? store.getSnapshot().doc,
            resolution,
            selection,
            root,
          }),
        )
      } else if (msg.type === 'select') {
        store.select(msg.uid)
        if (showing.current.mode === 'live') onPick()
      } else if (msg.type === 'add') {
        if (showing.current.mode === 'viewing') return
        blocks.addFirst(msg.parent, msg.slot)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [blocks, bridge, onPick, store])

  /**
   * Entering or leaving a version preview swaps the document wholesale: no
   * mutation stream describes that jump, so the frame is re-seeded. The live
   * document is read from the store rather than taken as a dependency — a
   * dependency would re-seed the whole frame on every keystroke, which is
   * exactly what the incremental `apply` path above exists to avoid.
   */
  useEffect(() => {
    const doc = source.doc ?? store.getSnapshot().doc
    if (doc) toFrame({ type: 'replace', doc })
  }, [source, store, toFrame])

  useEffect(() => {
    // The root block wraps the whole page, so outlining it in the preview would
    // just frame everything. Select it in the inspector without highlighting.
    toFrame({ type: 'select', uid: selection === root ? null : selection })
  }, [root, selection, toFrame])

  // Renaming or moving a page changes what a story link resolves to, so the
  // preview needs the new mapping without re-rendering from the server.
  useEffect(() => {
    toFrame({ type: 'resolve', resolution })
  }, [resolution, toFrame])

  return setFrame
}
