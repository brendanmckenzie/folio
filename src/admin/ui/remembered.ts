import { useCallback, useEffect, useState } from 'react'

/**
 * A boolean the browser remembers, keyed by a string that may change.
 *
 * Two properties earn it a module of its own. It **re-reads when the key
 * changes**, because `useState`'s initialiser runs once per mount and the shell
 * does not remount between screens — the sidebar's collapse is remembered *per
 * surface* (`platform` and `editor` have different defaults, per
 * `docs/ui-architecture.md`), so without the re-read, walking from a list into
 * the editor would keep the list's width and "collapsed by default in the editor"
 * would silently never happen.
 *
 * And every access is guarded: a private window that refuses `localStorage` should
 * cost a remembered preference, not the admin.
 */
export function useRemembered(key: string, fallback: boolean) {
  const [value, set] = useState(() => read(key, fallback))

  useEffect(() => {
    set(read(key, fallback))
  }, [key, fallback])

  const write = useCallback(
    (next: boolean) => {
      set(next)
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // Nothing to do, and nothing worth telling the user: it still toggled, it
        // just will not be that way next time.
      }
    },
    [key],
  )

  // Closes over the current value rather than re-reading storage: a write that
  // threw would leave the two disagreeing, and the one the user can see is the
  // one a toggle has to invert. Safe against a stale closure because the only
  // long-lived holder is `useShortcuts`, which keeps its bindings in a ref it
  // refreshes every render.
  const toggle = useCallback(() => write(!value), [value, write])

  return { value, set: write, toggle }
}

function read(key: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key)
    return saved === null ? fallback : saved === '1'
  } catch {
    return fallback
  }
}

/**
 * The same, for a value from a fixed set — Content's `[ Tree | Flat ]` and its
 * three sorts, and Assets' grid/table toggle next.
 *
 * `valid` is required rather than optional, and it is the whole reason this is not
 * a bare `useState` over `localStorage`. What comes out of storage is whatever was
 * in there: a value from a build two versions ago, or one somebody typed into
 * devtools. Without the screen, `?sort=` would be assembled from it and the route
 * would answer a 400 that no amount of clicking could clear — a remembered
 * preference must never be able to break the screen that remembers it.
 */
export function useRememberedString<T extends string>(
  key: string,
  fallback: T,
  valid: (raw: string) => raw is T,
) {
  const [value, set] = useState<T>(() => readString(key, fallback, valid))

  useEffect(() => {
    set(readString(key, fallback, valid))
  }, [key, fallback, valid])

  const write = useCallback(
    (next: T) => {
      set(next)
      try {
        localStorage.setItem(key, next)
      } catch {
        // As above: it still changed, it just will not be that way next time.
      }
    },
    [key],
  )

  return { value, set: write }
}

function readString<T extends string>(
  key: string,
  fallback: T,
  valid: (raw: string) => raw is T,
): T {
  try {
    const saved = localStorage.getItem(key)
    return saved !== null && valid(saved) ? saved : fallback
  } catch {
    return fallback
  }
}
