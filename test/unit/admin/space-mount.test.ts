import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { spaceEventEffect } from '../../../src/admin/hooks/useSpace'
import type { SpaceAvatar } from '../../../src/admin/spaceStore'
import {
  applySpaceEffect,
  avatarLabel,
  initialsOf,
  type SpaceHandlers,
  spaceIdentity,
  spaceWhere,
} from '../../../src/admin/ui/space-mount'
import { SpaceAvatars } from '../../../src/admin/ui/SpaceAvatars'
import { fallbackColour } from '../../../src/core/protocol'
import type { StoryMeta } from '../../../src/core/story'

/**
 * The space channel's **mount** (`live-collaboration.md`, issue #4).
 *
 * `space-store.test.ts` covers the channel itself: the socket, the peer list, the
 * throttle, and `spaceEventEffect`'s five branches. All 34 of those tests passed
 * for five weeks while the admin never called any of it — the server broadcast
 * every structural event to a channel no client listened on. So this file is
 * about the half that was missing, and it exists because of a specific gap:
 *
 * **`scripts/space-test.mjs` cannot see this feature.** It drives the server over
 * a real socket and asserts the peer list and presence, and it passes identically
 * with the mount removed from `Admin.tsx` — verified by removing it. The e2e
 * tier proves the channel works; nothing there proves anybody is listening.
 */

const AVATAR: SpaceAvatar = {
  actor: 'usr_ann',
  name: 'Ann Example',
  colour: '#0090ff',
  storyId: 'sty_about',
  storyTitle: 'About',
  locale: null,
  selection: null,
  tabs: 1,
}

const story = (id: string, title: string): StoryMeta =>
  ({ id, title, type: 'page', path: title.toLowerCase(), state: 'draft' }) as StoryMeta

/** Counts what each field dispatched, which is the only thing `applySpaceEffect` does. */
function handlers(): SpaceHandlers & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    reload: () => calls.push('reload'),
    globals: () => calls.push('globals'),
    notice: (message) => calls.push(`notice:${message}`),
  }
}

describe('spaceIdentity', () => {
  it('derives the colour from the actor, so a person is one colour in every tab', () => {
    // Not `store.ts`'s random palette pick: `SpaceDO` already applies exactly
    // this derivation to an identity that arrives without a usable colour
    // (`server/space-do.ts`), so deriving it here agrees with the server rather
    // than handing it a value it may overwrite.
    expect(spaceIdentity('abc12345').colour).toBe(fallbackColour('abc12345'))
    expect(spaceIdentity('abc12345')).toEqual(spaceIdentity('abc12345'))
  })

  it('names the actor without claiming to know who they are', () => {
    // Under `auth: 'open'` there is nobody to name, and this identity is ignored
    // outright on a deployment with accounts.
    expect(spaceIdentity('abc12345').name).toBe('Editor abc')
  })

  it('generates an actor when given none', () => {
    const a = spaceIdentity()
    const b = spaceIdentity()
    expect(a.actor).not.toBe(b.actor)
    expect(a.actor.length).toBeGreaterThan(0)
  })
})

describe('spaceWhere', () => {
  it('reports the open story off the route, not off the fetched row', () => {
    // So navigating announces the new story immediately rather than one round
    // trip later.
    expect(spaceWhere({ name: 'edit', id: 'sty_about' }, undefined)).toEqual({
      storyId: 'sty_about',
      storyTitle: null,
    })
  })

  it('adds the title once the row for that story lands', () => {
    expect(spaceWhere({ name: 'edit', id: 'sty_about' }, story('sty_about', 'About'))).toEqual({
      storyId: 'sty_about',
      storyTitle: 'About',
    })
  })

  it('never pairs a new id with the previous story’s title', () => {
    // `open` lags a navigation by one fetch. Without the id guard this announces
    // `sty_team` as "About", which every other editor then shows in an avatar.
    expect(spaceWhere({ name: 'edit', id: 'sty_team' }, story('sty_about', 'About'))).toEqual({
      storyId: 'sty_team',
      storyTitle: null,
    })
  })

  it('reports a null story on a list screen, which is a real place', () => {
    // `SpacePresence.storyId` is nullable for exactly this, and `avatarsOf`
    // prefers the tab that is in a document — so "somewhere in the CMS" is a
    // fact worth sending, not a gap.
    for (const screen of [{ name: 'content' }, { name: 'assets' }, { name: 'home' }] as const) {
      expect(spaceWhere(screen, story('sty_about', 'About'))).toEqual({
        storyId: null,
        storyTitle: null,
      })
    }
  })
})

describe('applySpaceEffect', () => {
  it('reloads the list', () => {
    const h = handlers()
    applySpaceEffect({ reload: true, globals: false, notice: null }, h)
    expect(h.calls).toEqual(['reload'])
  })

  it('refetches the globals', () => {
    const h = handlers()
    applySpaceEffect({ reload: false, globals: true, notice: null }, h)
    expect(h.calls).toEqual(['globals'])
  })

  it('sends the notice to the toast', () => {
    const h = handlers()
    applySpaceEffect({ reload: false, globals: false, notice: 'Ann published this page' }, h)
    expect(h.calls).toEqual(['notice:Ann published this page'])
  })

  it('does nothing at all for an event this client caused', () => {
    const h = handlers()
    applySpaceEffect({ reload: false, globals: false, notice: null }, h)
    expect(h.calls).toEqual([])
  })

  it('acts on every field of a real event, end to end from `spaceEventEffect`', () => {
    // The two halves joined: the hook decides what an event means, this decides
    // what the shell does about it. A published page somebody else published,
    // which is the case `docs/handbook.md` promises is "explained" rather than
    // discovered through a socket close.
    const h = handlers()
    applySpaceEffect(
      spaceEventEffect(
        {
          kind: 'story.published',
          id: 'sty_about',
          title: 'About',
          at: 1,
          versionId: 'ver_1',
          actor: 'usr_ann',
        },
        { openStoryId: 'sty_about', myActor: 'usr_me', nameOf: () => 'Ann' },
      ),
      h,
    )
    expect(h.calls).toEqual(['reload', 'notice:Ann published this page'])
  })

  it('reloads without a notice when the published page is not the open one', () => {
    const h = handlers()
    applySpaceEffect(
      spaceEventEffect(
        {
          kind: 'story.published',
          id: 'sty_other',
          title: 'Other',
          at: 1,
          versionId: 'ver_1',
          actor: 'usr_ann',
        },
        { openStoryId: 'sty_about', myActor: 'usr_me', nameOf: () => 'Ann' },
      ),
      h,
    )
    expect(h.calls).toEqual(['reload'])
  })

  it('refetches only the globals for a global change, leaving the list alone', () => {
    const h = handlers()
    applySpaceEffect(
      spaceEventEffect(
        { kind: 'global.changed', name: 'header', storyId: 'sng_header', actor: 'usr_ann' },
        { openStoryId: 'sty_about', myActor: 'usr_me', nameOf: () => 'Ann' },
      ),
      h,
    )
    expect(h.calls).toEqual(['globals'])
  })
})

describe('avatarLabel', () => {
  it('says which document, because a coloured circle says nothing', () => {
    expect(avatarLabel(AVATAR)).toBe('Ann Example is editing About')
  })

  it('names the locale when there is one', () => {
    expect(avatarLabel({ ...AVATAR, locale: 'fr' })).toBe('Ann Example is editing About in fr')
  })

  it('falls back for a story whose title has not arrived', () => {
    expect(avatarLabel({ ...AVATAR, storyTitle: null })).toBe('Ann Example is editing a document')
  })

  it('says "elsewhere" for somebody on a list screen', () => {
    // Which is worth showing: somebody with the CMS open and no document open is
    // still somebody who might publish the page you are editing.
    expect(avatarLabel({ ...AVATAR, storyId: null, storyTitle: null })).toBe(
      'Ann Example is elsewhere in the CMS',
    )
  })

  it('counts tabs, in the label rather than on a badge', () => {
    expect(avatarLabel({ ...AVATAR, tabs: 3 })).toBe('Ann Example is editing About (3 tabs)')
  })
})

describe('initialsOf', () => {
  it('takes word initials', () => {
    expect(initialsOf('Ann Example')).toBe('AE')
    // The generated name is two words, and reads correctly as two.
    expect(initialsOf('Editor abc')).toBe('EA')
  })

  it('takes two characters from an unbroken name', () => {
    expect(initialsOf('Ann')).toBe('AN')
  })

  it('does not throw on a name that normalised to nothing', () => {
    // `normalizeIdentity` prevents this on the wire; a renderer must not depend
    // on that being true.
    expect(initialsOf('   ')).toBe('?')
  })
})

describe('SpaceAvatars', () => {
  /**
   * Called as a plain function rather than rendered: there is no DOM in this
   * project (`vitest.config.ts`), and a component with no hooks needs none to
   * answer what element it returns. #14 adds the DOM environment; this holds
   * until then and is the assertion that matters either way, since what is being
   * checked is *whether a row exists at all*.
   */
  it('renders nothing when nobody else is here', () => {
    // Which is also what a deployment with no `SPACE` binding gets: `useSpace`
    // opens no socket, so `avatars` is empty and the bar is unchanged. No empty
    // row holding layout.
    expect(SpaceAvatars({ avatars: [] })).toBeNull()
  })

  it('renders one node per actor, keyed and labelled', () => {
    const out = SpaceAvatars({ avatars: [AVATAR, { ...AVATAR, actor: 'usr_bo', name: 'Bo' }] })
    expect(out).not.toBeNull()
    const children = (out as { props: { children: unknown[] } }).props.children
    expect(children).toHaveLength(2)
    const first = children[0] as { key: string; props: Record<string, unknown> }
    expect(first.key).toBe('usr_ann')
    expect(first.props['aria-label']).toBe('Ann Example is editing About')
    // Both, and the same string: `title` for a pointer, `aria-label` because a
    // circle has no accessible name of its own.
    expect(first.props.title).toBe(first.props['aria-label'])
    expect(first.props.style).toEqual({ background: '#0090ff' })
    expect(first.props.children).toBe('AE')
  })
})

/**
 * That the shell actually mounts it.
 *
 * A source-text test, for `ui-scope.test.ts`'s reason and with its caveat: the
 * admin's suite mounts nothing, so there is no rendered tree to ask whether
 * `presence` reached the top bar. It is a weaker assertion than a rendered one —
 * it proves the wiring is *written*, not that it runs — and it is the only tier
 * that can fail at all if the mount is dropped, which is what makes it worth
 * having. The e2e script cannot: it passes with the mount removed.
 *
 * **#14's render tests have landed and do not replace these three.** That note
 * used to say "retire this when they do", so here is what is actually still owed.
 *
 * `render/screens.test.tsx` mounts the shell at nineteen URLs, but it does so with
 * `/me` answering `space: false` — which is deliberate, because `enabled: false`
 * is what stops `useSpace` opening a socket, and the render project stubs
 * `WebSocket` to a silent class for the same reason. So no peer ever arrives, the
 * avatar row correctly renders nothing, and a mounted assertion about the top bar
 * would be asserting the empty case. Replacing these three needs a fixture that
 * declares the binding *and* feeds the store a `presence` frame — worth having,
 * and more than a smoke layer.
 *
 * Also note `readFileSync` runs in the `describe` body, so a **rename of the file
 * below breaks all 27 tests in this file at collection**, not the three that read
 * it. The path is to `ui/Admin.tsx` and must move when the file is renamed.
 */
describe('the shell mounts the channel', () => {
  const shell = readFileSync(new URL('../../../src/admin/ui/Admin.tsx', import.meta.url), 'utf8')

  it('calls `useSpace`, which nothing did for five weeks', () => {
    expect(shell).toMatch(/useSpace\(\{/)
    expect(shell).toMatch(/enabled: me\.space/)
  })

  it('fills the top bar’s `presence` slot, which nothing had', () => {
    expect(shell).toMatch(/presence=\{<SpaceAvatars/)
  })

  it('hands all three effect fields a real handler', () => {
    // The three `spaceEventEffect` returns. A mount that dispatched two of them
    // would look like a working feature: the avatars would appear, the tree would
    // update, and a colleague's publish would go unmentioned.
    // Bounded to the call rather than sliced to end of file, so a later
    // `reload: setNotice` further down the shell cannot satisfy this.
    const from = shell.indexOf('applySpaceEffect(')
    const call = shell.slice(from, shell.indexOf('\n      )\n', from))
    expect(call).toMatch(/listReload\.current\?\.\(\)/)
    // The editor registers no list, so `reload` there is the open row — without
    // this line a colleague's publish toasts and leaves the badge stale.
    expect(call).toMatch(/if \(screen\.name === 'edit'\) onStoryChanged\(\)/)
    expect(call).toMatch(/globals: reloadGlobals/)
    expect(call).toMatch(/notice: setNotice/)
  })
})
