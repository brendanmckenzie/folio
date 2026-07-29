import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { PresenceSelection, SpaceEvent, SpacePresence } from '../../core/protocol'
import { type SpaceAvatar, avatarsOf, SpaceStore } from '../spaceStore'

/**
 * What one structural event means for this editor
 * (`../../../docs/specs/editing/live-collaboration.md` decision 4).
 *
 * Every effect here is a **reload** rather than a patch, and that is a deliberate
 * departure from the spec's sketch. The reason is `StoryNode`: its `url` and
 * `previewUrl` are computed by the *host's* own `route` function on the server, so
 * the admin cannot derive them for a page whose path just moved, and a tree
 * patched with the right path and the old URL is worse than a tree that refetches
 * — every link in the open preview would keep pointing at the vacated URL, which
 * is the exact failure this feature exists to fix.
 *
 * A reload is still not a refresh: `GET /folio/stories` costs one request, the
 * open document is never refetched, the iframe never reloads, and the resolution
 * rebuilt from the new tree reaches the preview as a `resolve` frame. The
 * acceptance criteria are about those three things, and they hold.
 */
export interface SpaceEffect {
  /** Reload the story tree and the document list. */
  reload: boolean
  /** Re-fetch the configured globals' documents. */
  globals: boolean
  /** Something to tell the person looking at the open story, or null. */
  notice: string | null
}

const NOTHING: SpaceEffect = { reload: false, globals: false, notice: null }

export interface SpaceEffectContext {
  /** The story this editor has open. */
  openStoryId: string
  /** This client's own actor id, or null under `auth: 'open'`. */
  myActor: string | null
  /** A display name for an actor id, from the peer list this channel carries. */
  nameOf: (actor: string | null) => string
}

/**
 * Pure, and exported so every branch is tested without a socket or a tree.
 *
 * An event this client caused is ignored outright: the local write path already
 * reloaded, and telling somebody "you moved this page" is noise. Under
 * `auth: 'open'` there is no actor to compare, so the redundant reload happens —
 * harmless, and the alternative is a deployment shape with no identity inventing
 * one for the sake of a refetch.
 */
export function spaceEventEffect(event: SpaceEvent, ctx: SpaceEffectContext): SpaceEffect {
  if (event.actor !== null && event.actor === ctx.myActor) return NOTHING
  const who = ctx.nameOf(event.actor)

  switch (event.kind) {
    case 'story.created':
      // No notice: somebody else adding a page elsewhere in the tree is not an
      // interruption, it is just a row appearing.
      return { reload: true, globals: false, notice: null }

    case 'story.updated': {
      const mine = event.changes.find((c) => c.id === ctx.openStoryId)
      return {
        reload: true,
        globals: false,
        notice: mine ? `${who} moved this page to /${mine.to}` : null,
      }
    }

    case 'story.deleted':
      // Told, rather than discovered through a 4002 close with no explanation.
      return {
        reload: true,
        globals: false,
        notice: event.ids.includes(ctx.openStoryId) ? `${who} deleted this page` : null,
      }

    case 'story.published':
      return {
        reload: true,
        globals: false,
        notice: event.id === ctx.openStoryId ? `${who} published this page` : null,
      }

    case 'global.changed':
      // Content, not structure: only the globals need refetching, and the tree
      // and the open document are untouched.
      return { reload: false, globals: true, notice: null }
  }
}

export interface Space {
  connected: boolean
  /** Everybody else in the site, one entry per socket. */
  peers: SpacePresence[]
  /** The same list deduped by actor, for the avatar row. */
  avatars: SpaceAvatar[]
  /** Whether the channel exists at all on this deployment. */
  enabled: boolean
}

interface Options {
  apiBase: string
  /** `FolioBindings.space` was declared. False and nothing is attempted. */
  enabled: boolean
  /** The advisory identity, used only under `auth: 'open'`. */
  identity: { actor: string; name: string; colour: string }
  /** Where this editor is. Null `storyId` is a list screen, which is a real place. */
  storyId: string | null
  storyTitle: string | null
  locale: string | null
  selection: PresenceSelection | null
  onEvent: (event: SpaceEvent) => void
}

/**
 * The space channel's lifecycle, and the only place it is opened.
 *
 * `enabled: false` builds no store and opens no socket, which is the
 * "degrades without the binding" criterion: not a failed upgrade retried on a
 * backoff, not a console warning — nothing at all.
 */
export function useSpace(opts: Options): Space {
  const { apiBase, enabled, storyId, storyTitle, locale, selection, onEvent } = opts

  // Held in a ref so a new callback identity on every render — which is what
  // `onEvent` is, since it closes over the tree — never rebuilds the socket.
  const handler = useRef(onEvent)
  handler.current = onEvent

  // The advisory identity is generated once per store, so it must not be a
  // dependency: including it would rebuild the socket on every render.
  const identity = useRef(opts.identity)

  const store = useMemo(
    () =>
      enabled
        ? new SpaceStore(apiBase, identity.current, {
            onEvent: (event) => handler.current(event),
          })
        : null,
    [apiBase, enabled],
  )

  useEffect(() => {
    if (!store) return
    store.connect()
    return () => store.disconnect()
  }, [store])

  const state = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? emptySnapshot,
    store?.getSnapshot ?? emptySnapshot,
  )

  useEffect(() => {
    store?.setWhere(storyId, storyTitle, locale)
  }, [store, storyId, storyTitle, locale])

  useEffect(() => {
    store?.setSelection(selection)
  }, [store, selection])

  const avatars = useMemo(() => avatarsOf(state.peers), [state.peers])

  return { connected: state.connected, peers: state.peers, avatars, enabled }
}

/** The store-less case, as a stable pair `useSyncExternalStore` accepts. */
const EMPTY = { connected: false, peers: [] as SpacePresence[], notice: null }
const noopSubscribe = () => () => {}
const emptySnapshot = () => EMPTY
