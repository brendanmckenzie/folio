/**
 * The space channel's mount, as the parts of it that are decidable
 * (`../../../docs/specs/editing/live-collaboration.md`).
 *
 * `hooks/useSpace.ts` has been complete and tested since 2026-07-30 and was
 * never called: the server broadcast all five structural events to a channel no
 * client listened on. What was missing was this — where the editor *is*, what an
 * event means for the shell, and what the avatar row says — and it lived nowhere
 * because it had never been written.
 *
 * Everything here is pure, for the admin's testing convention: no test mounts a
 * component, so logic that matters lives next door in Node-testable functions
 * (`screens/content-model.ts` and `screens/useContent.ts` are the pattern). That
 * convention is load-bearing for this feature in particular. The e2e script
 * `scripts/space-test.mjs` drives the *server* side over a real socket and
 * passes identically whether or not the admin mounts the channel at all, so
 * without these functions the whole mount would be unobservable to every tier of
 * the test suite.
 */
import { fallbackColour } from '../../core/protocol'
import type { StoryMeta } from '../../core/story'
import type { SpaceEffect } from '../hooks/useSpace'
import type { SpaceAvatar } from '../spaceStore'
import type { Screen } from './route'

/**
 * The advisory identity this client asserts, and the reason it is not
 * `StoryStore`'s.
 *
 * `store.ts` generates a random pick from a module-private six-colour palette.
 * This uses `fallbackColour(actor)` from `core/protocol.ts` instead, which is
 * **deterministic in the actor** — so the same person is the same colour in every
 * tab and across reconnects, rather than a fresh colour per socket. That is not a
 * preference: `SpaceDO` already applies exactly this derivation to any identity
 * that arrives without a usable colour (`server/space-do.ts:95`,
 * `colour: a.colour || fallbackColour(actor)`), so deriving it here agrees with
 * the server instead of racing it, and needs no new export out of `store.ts`.
 *
 * Advisory is the whole of what this is. On a deployment with accounts the Worker
 * attaches a verified identity at upgrade time and the object ignores every field
 * below (`identity-and-access.md` architecture decision 3). It matters only under
 * `auth: 'open'`, where this random pair is all that tells two anonymous tabs
 * apart.
 *
 * `actor` is a parameter with a generated default so a test can assert the two
 * derivations without stubbing `crypto`.
 *
 * **Call this once and hold it.** `useSpace` keeps the identity in a ref
 * precisely because a new object every render would rebuild the socket, so
 * calling this in a component body is a bug that no test would show.
 */
export function spaceIdentity(actor: string = crypto.randomUUID().slice(0, 8)): {
  actor: string
  name: string
  colour: string
} {
  return {
    actor,
    // `Editor abc`, matching `StoryStore`'s convention: under `auth: 'open'` there
    // is nobody to name, and a label that looks like a name would be a claim.
    name: `Editor ${actor.slice(0, 3)}`,
    colour: fallbackColour(actor),
  }
}

/**
 * Where this editor is, for the presence frame.
 *
 * A **null `storyId` is a list screen, and that is a real place** rather than a
 * gap — `SpacePresence.storyId` is `string | null` for this exact case, and
 * `avatarsOf` prefers the tab that is in a document because "Ann is on About" is
 * more use than "Ann is somewhere". So every screen but the editor reports null,
 * deliberately, and none of them reports nothing.
 *
 * The id comes off the **route**, not off the fetched row, so navigating
 * announces the new story immediately rather than one round trip later. The title
 * comes off the row and is therefore null until it lands — and is null unless the
 * row is *this* story, which is the guard that matters: `open` lags a navigation
 * by one fetch, so without it a fresh id would be announced carrying the previous
 * story's title.
 */
export interface SpaceWhere {
  storyId: string | null
  storyTitle: string | null
}

export function spaceWhere(screen: Screen, open: StoryMeta | undefined): SpaceWhere {
  if (screen.name !== 'edit') return { storyId: null, storyTitle: null }
  return {
    storyId: screen.id,
    storyTitle: open?.id === screen.id ? open.title : null,
  }
}

/**
 * The three things the shell can do about somebody else's write, and the one
 * place they are dispatched.
 *
 * `spaceEventEffect` (`hooks/useSpace.ts`) decides *what* an event means and is
 * already covered by 34 tests. This decides nothing; it exists so that "the
 * shell acts on all three fields" is a claim a Node test can check, rather than
 * three `if`s inside a component nothing can mount.
 */
export interface SpaceHandlers {
  /** Re-read the list on screen: the page tree, or one type's records. */
  reload: () => void
  /** Re-read the configured globals' rows. */
  globals: () => void
  /** Tell the person looking at the open story. */
  notice: (message: string) => void
}

export function applySpaceEffect(effect: SpaceEffect, handlers: SpaceHandlers): void {
  if (effect.reload) handlers.reload()
  if (effect.globals) handlers.globals()
  if (effect.notice !== null) handlers.notice(effect.notice)
}

/**
 * What one avatar says, spelled out rather than left to a colour.
 *
 * A coloured circle with a `title` is not an accessible name, so this is the
 * `aria-label` too. Three cases, and the middle one is why a list screen reports
 * its presence at all: somebody with the CMS open but no document open is still
 * somebody who might publish the page you are editing.
 */
export function avatarLabel(avatar: SpaceAvatar): string {
  const tabs = avatar.tabs > 1 ? ` (${avatar.tabs} tabs)` : ''
  if (avatar.storyId === null) return `${avatar.name} is elsewhere in the CMS${tabs}`
  const where = avatar.storyTitle ?? 'a document'
  const locale = avatar.locale ? ` in ${avatar.locale}` : ''
  return `${avatar.name} is editing ${where}${locale}${tabs}`
}

/**
 * One or two letters for the circle.
 *
 * Word initials where there are words to take them from — `Editor abc` gives
 * `EA`, which is right, since that generated name *is* two words. Falls back to
 * the first two characters so an unbroken name is not one letter, and to `?` for
 * a name that normalised to nothing, which `normalizeIdentity` already prevents
 * on the wire but which this must not throw on.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase()
}
