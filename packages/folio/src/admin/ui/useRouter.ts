import { useCallback, useEffect, useState } from 'react'
import { href, parse, type Route, same, type Screen } from './route'

/**
 * The one place that talks to `history`, and the only part of the router that
 * cannot be a pure function.
 *
 * Deliberately thin: `route.ts` knows what a URL means and this knows how to
 * change one. Everything a test would want to assert about navigation is over
 * there.
 *
 * **Links are real `<a href>` elements**, intercepted here in one delegated
 * handler rather than replaced by `onClick` buttons. That is what keeps
 * cmd-click, middle-click, right-click → copy link, and the browser's own status
 * bar working — all four of which a `<div onClick>` silently breaks, and three of
 * which an editor uses daily to open a page in a second tab. It is also the
 * cheapest possible answer to "everything must be linkable": the markup *is* the
 * link, and the interception is an optimisation over it.
 */
export interface Router {
  route: Route
  /** Navigate, adding a history entry. A no-op when it would land where we are. */
  go: (screen: Screen, query?: Readonly<Record<string, string | undefined>>) => void
  /**
   * Navigate without adding an entry — for a filter chip or a search box, where
   * one entry per keystroke would make Back useless. The distinction is the whole
   * reason "the URL is the state" does not make the Back button hostile.
   */
  replace: (screen: Screen, query?: Readonly<Record<string, string | undefined>>) => void
}

const here = (mount: string): Route =>
  parse(window.location.pathname + window.location.search, mount)

export function useRouter(mount: string): Router {
  const [route, setRoute] = useState<Route>(() => here(mount))

  useEffect(() => {
    const onPop = () => setRoute(here(mount))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [mount])

  const navigate = useCallback(
    (
      kind: 'push' | 'replace',
      screen: Screen,
      query?: Readonly<Record<string, string | undefined>>,
    ) => {
      const url = href(screen, mount, query)
      const next = parse(url, mount)
      if (kind === 'push' && same(next, here(mount))) return
      window.history[kind === 'push' ? 'pushState' : 'replaceState'](null, '', url)
      setRoute(next)
    },
    [mount],
  )

  const go = useCallback<Router['go']>(
    (screen, query) => navigate('push', screen, query),
    [navigate],
  )
  const replace = useCallback<Router['replace']>(
    (screen, query) => navigate('replace', screen, query),
    [navigate],
  )

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Every one of these is a gesture that means "not here": a modified click
      // is the user asking the browser for a new tab or window, and taking it
      // over would be the router breaking a browser feature to look clever.
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return
      }
      const anchor = (e.target as Element | null)?.closest?.('a')
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank') return
      if (anchor.origin !== window.location.origin) return
      // Outside the mount is a real navigation — a preview URL, the login page,
      // the host's own site. The shell does not own those and must not swallow
      // them.
      const inside = anchor.pathname === mount || anchor.pathname.startsWith(`${mount}/`)
      if (!inside) return
      e.preventDefault()
      const next = parse(anchor.pathname + anchor.search, mount)
      if (same(next, here(mount))) return
      window.history.pushState(null, '', anchor.pathname + anchor.search)
      setRoute(next)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [mount])

  return { route, go, replace }
}
