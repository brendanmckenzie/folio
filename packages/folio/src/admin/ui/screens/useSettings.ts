import { useCallback, useEffect, useMemo, useState } from 'react'
import { indexManifest, type Manifest } from '../../../core/schema'
import type { AuthPolicy } from '../../../server/auth/config'
import {
  openCards,
  type Section,
  type SettingsUrl,
  type SettingsView,
  settingsView,
  visibleSections,
} from './settings-model'

/**
 * The Settings screen's state, which is unusual for this admin in that **none of
 * it is data**: the manifest arrives as a prop (the shell already fetches it once
 * per load, and a second fetch of an immutable payload is a second thing to keep
 * in step), so there is no request here, no cursor and no reload.
 *
 * What is left is worth a hook anyway, and it is two things: the derived view,
 * memoised so eighty-seven block cards are not rebuilt on every keystroke of the
 * filter; and which block cards are open, which is the one piece of state on this
 * screen that is not in the URL.
 *
 * `useDocuments` is the sibling and the contrast is the point — that file is
 * `fetch` and the state it lands in, this one is `useMemo` and a `Set`, and both
 * leave every decision to a `*-model.ts` next door.
 */
export interface SettingsData {
  /** Null while the manifest is still loading. */
  view: SettingsView | null
  /** The sections to draw, in order, given the filter. */
  sections: Section[]
  /** Whether a block card is expanded, by name. */
  isOpen: (name: string) => boolean
  /** A `<details>` reporting its new state. */
  setOpen: (name: string, open: boolean) => void
}

/**
 * `policy` is `Me.policy` and arrives from a different route than the manifest —
 * `GET {base}/api/me`, because it describes a security decision rather than a
 * declaration. It may be undefined for three different reasons (`auth: 'open'`, no
 * answer yet, a refused caller) and the screen treats all three the same, so no
 * loading state of its own is needed here.
 */
export function useSettings(
  manifest: Manifest | null,
  policy: AuthPolicy | undefined,
  url: SettingsUrl,
): SettingsData {
  const view = useMemo(
    () => (manifest ? settingsView(manifest, indexManifest(manifest), policy, url.q) : null),
    [manifest, policy, url.q],
  )

  /**
   * Cards the reader opened or closed by hand, overriding what the filter decided.
   *
   * Cleared whenever the filter changes, and that is deliberate rather than
   * convenient: an override belongs to a result set. Carrying "I closed `hero`"
   * across a new query means the next query's answer arrives with one of its hits
   * already hidden, for a reason nothing on screen explains.
   */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  // biome-ignore lint/correctness/useExhaustiveDependencies: `url.q` is the trigger, not a value the body reads — it only clears. Naming it is the point
  useEffect(() => {
    setOverrides({})
  }, [url.q])

  const open = useMemo(() => openCards(view?.blocks ?? [], url.q), [view?.blocks, url.q])

  const isOpen = useCallback((name: string) => overrides[name] ?? open.has(name), [overrides, open])

  const setOpen = useCallback((name: string, open: boolean) => {
    setOverrides((prev) => ({ ...prev, [name]: open }))
  }, [])

  const sections = useMemo(() => (view ? visibleSections(view, url.q) : []), [view, url.q])

  return { view, sections, isOpen, setOpen }
}
