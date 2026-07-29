import { describe, expect, it } from 'vitest'
import type { summariseDiff } from '../../../src/core/diff'
import { followLabel, publishStatus } from '../../../src/admin/TopBar'
import type { SpaceAvatar } from '../../../src/admin/spaceStore'

type Delta = ReturnType<typeof summariseDiff>

const delta = (total: number, over: Partial<Delta> = {}): Delta => ({
  added: 0,
  removed: 0,
  moved: 0,
  retyped: 0,
  edited: total,
  translated: 0,
  locales: [],
  total,
  ...over,
})

// unpublished-changes.md's phase 1, step 3: the top bar's state machine,
// replacing the bare "Synced" label.
describe('publishStatus', () => {
  it('reads "Connecting…" before the socket connects, whatever else is true', () => {
    expect(publishStatus(false, 0, true, true, delta(3)).label).toBe('Connecting…')
    expect(publishStatus(false, 1, false, false, null).label).toBe('Connecting…')
  })

  it('reads "Saving…" while a transaction is in flight, once connected', () => {
    expect(publishStatus(true, 1, true, true, null).label).toBe('Saving…')
  })

  it('reads "Not published yet" for a story with no publish version at all', () => {
    const status = publishStatus(true, 0, false, false, null)
    expect(status.label).toBe('Not published yet')
    expect(status.clickable).toBe(false)
    expect(status.nothingToPublish).toBe(false)
  })

  it('reads "Up to date" and disables Publish for a live story identical to what was published', () => {
    const status = publishStatus(true, 0, true, true, delta(0))
    expect(status.label).toBe('Up to date')
    expect(status.clickable).toBe(false)
    expect(status.nothingToPublish).toBe(true)
  })

  it('reads "N unpublished changes", clickable, with Publish enabled, once the draft has diverged', () => {
    const status = publishStatus(true, 0, true, true, delta(3))
    expect(status.label).toBe('3 unpublished changes')
    expect(status.clickable).toBe(true)
    expect(status.nothingToPublish).toBe(false)
  })

  it('singularises the count for exactly one change', () => {
    expect(publishStatus(true, 0, true, true, delta(1)).label).toBe('1 unpublished change')
  })

  // A story taken down (unpublish.md's 'unpublished' state) can be byte-identical
  // to its last publish and still have something worth publishing: bringing it
  // back live. "Nothing to publish" only applies while the page is actually live.
  it('does not disable Publish for an unpublished (taken down) story even if unchanged since its last publish', () => {
    const status = publishStatus(true, 0, true, false, delta(0))
    expect(status.nothingToPublish).toBe(false)
  })
})

/*
 * editing/live-collaboration.md: what a peer's avatar says. "on a list screen" is
 * a real answer rather than a missing one — an editor browsing the tree is
 * present, and an avatar with no explanation reads as broken.
 */
describe('followLabel', () => {
  const avatar = (over: Partial<SpaceAvatar> = {}): SpaceAvatar => ({
    actor: 'usr_ann',
    name: 'Ann',
    colour: '#e5484d',
    storyId: 'sty_about',
    storyTitle: 'About',
    locale: null,
    selection: null,
    tabs: 1,
    ...over,
  })

  it('names the document somebody is in', () => {
    expect(followLabel(avatar())).toBe('Ann — About')
  })

  it('names the locale when there is one', () => {
    expect(followLabel(avatar({ locale: 'fr' }))).toBe('Ann — About (fr)')
  })

  it('says so when somebody is on a list screen rather than in a document', () => {
    expect(followLabel(avatar({ storyId: null, storyTitle: null }))).toBe('Ann — on a list screen')
  })

  it('counts tabs only when there is more than one', () => {
    expect(followLabel(avatar({ tabs: 2 }))).toBe('Ann — About · 2 tabs')
  })

  /** A story whose title never reached this client (an event about a page it has
   * not loaded) still gets a legible label. */
  it('falls back when the title is unknown', () => {
    expect(followLabel(avatar({ storyTitle: null }))).toBe('Ann — a document')
  })
})
