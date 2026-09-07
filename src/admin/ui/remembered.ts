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

/**
 * How many members survive a write.
 *
 * A bound on the *stored string*, not on the feature: the one caller is Content's
 * expanded nodes, and collapsing removes an id, so a set that grows without limit is
 * a browsing session nobody ever tidied rather than anything a person meant. The
 * most recent are kept, because `Set` iterates in insertion order and the node you
 * expanded last is the one you are most likely to come back to.
 *
 * It is deliberately not a bound on how much work restoring costs. That is
 * `Content.tsx`'s to make, and it makes it by fetching only the levels a *visible*
 * row asks for — an expanded node inside a collapsed ancestor is never drawn, so it
 * is never fetched, however many of them are remembered.
 */
const SET_LIMIT = 200

/**
 * The same again, for a set of ids — Content's expanded nodes, and nothing else yet.
 *
 * A set rather than a third `useRememberedString` over a joined value, because the
 * one operation this has is *toggle one member*, and every caller of the string
 * version would have to split, edit and rejoin to get it.
 *
 * `valid` is required for the reason it is required there, and here the argument is
 * sharper: what comes out of storage is a list of *identifiers*, and an id that no
 * longer exists — or never did — is a request per member. Screening on the way in is
 * what keeps a stale preference from being a burst of 404s.
 *
 * Comma-separated rather than JSON: the members are ids, whose alphabet excludes a
 * comma, so the encoding cannot be ambiguous and reading it back cannot throw.
 */
export function useRememberedSet(key: string, valid: (raw: string) => boolean) {
  const [value, setValue] = useState<ReadonlySet<string>>(() => readSet(key, valid))

  useEffect(() => {
    setValue(readSet(key, valid))
  }, [key, valid])

  const write = useCallback(
    (next: ReadonlySet<string>) => {
      // Trimmed once, so what is in memory and what is in storage cannot disagree
      // about which members survived.
      const kept = next.size > SET_LIMIT ? new Set([...next].slice(-SET_LIMIT)) : next
      setValue(kept)
      try {
        localStorage.setItem(key, [...kept].join(','))
      } catch {
        // As above: it still changed, it just will not be that way next time.
      }
    },
    [key],
  )

  // Closes over the current value for the same reason `useRemembered.toggle` does:
  // the one a caller can see is the one a toggle has to invert.
  const toggle = useCallback(
    (member: string) => {
      const next = new Set(value)
      if (!next.delete(member)) next.add(member)
      write(next)
    },
    [value, write],
  )

  return { value, set: write, toggle }
}

function readSet(key: string, valid: (raw: string) => boolean): ReadonlySet<string> {
  try {
    const saved = localStorage.getItem(key)
    if (!saved) return new Set()
    return new Set(saved.split(',').filter(valid).slice(-SET_LIMIT))
  } catch {
    return new Set()
  }
}
