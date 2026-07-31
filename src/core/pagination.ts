/**
 * Keyset pagination, as one envelope and one cursor codec.
 *
 * `docs/specs/foundation/pagination.md` decisions 1 and 6: every **admin** list
 * route pages by cursor, because those lists are live — somebody else is editing
 * while you scroll, and offset paging silently skips and repeats rows when a row
 * is inserted above your position. `/api/v1` keeps page numbers, deliberately, and
 * its envelope is `ContentPage` in `server/query.ts` rather than this one.
 *
 * All of it is pure, so it is tested in Node without a database. What a route
 * still owns is its `where` clause and its `order by`; what it must not own is the
 * `limit + 1` dance, the tie-breaking, or the encoding — eight routes hand-rolling
 * those is eight chances to get the last page subtly wrong with no shared test.
 */

/**
 * A page of rows and the cursor that continues it.
 *
 * `total` is **absent unless asked for** (`?count=1`, decision 5). Keyset paging
 * does not need a count to work, and the same `count(*)` is the guard on a bulk
 * write, so it has to be one deliberate query rather than a number every page
 * drags along behind it.
 */
export interface Page<T> {
  rows: T[]
  /** Pass back as `?cursor=`. Null on the last page. */
  cursor: string | null
  /** Only present when the caller asked. Counts the whole filter, not the page. */
  total?: number
}

/**
 * One component of a sort key.
 *
 * Deliberately not nullable, and that is a design pressure rather than an
 * omission: a keyset cursor over a nullable column cannot express "resume after
 * null" in a way that agrees with SQL's own null ordering, so a route sorting by
 * one has to `coalesce` it in both the `order by` and the key. `stories_edited`
 * exists for exactly that reason — see `migrations/0001_init.sql`.
 */
export type CursorPart = string | number

/**
 * Packs a sort key into one opaque string.
 *
 * **Opaque means opaque.** The old hand-rolled version in `redirects.ts` was
 * `${createdAt}_${from}`, which is opaque by convention only — and the first
 * client to split on that underscore would have frozen both the column order and
 * the separator. Base64url of a JSON tuple has no separator to discover and no
 * shape to depend on, and it survives a component that itself contains `_`, `.`
 * or a non-ASCII character (a page titled "À propos" sorts by title in flat mode).
 *
 * Base64**url** rather than base64: this travels in a query string, where `+` is
 * a space and `/` and `=` need escaping. Encoding it wrong is the kind of bug that
 * only shows up on the one page whose cursor happens to contain the wrong byte.
 */
export function encodeCursor(parts: readonly CursorPart[]): string {
  const json = JSON.stringify(parts)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  // A loop rather than `String.fromCharCode(...bytes)`: spreading a large array
  // overflows the argument limit. Cursors are tiny, but the failure would be
  // data-dependent and therefore invisible until it was not.
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Unpacks a cursor, or null when it is not one.
 *
 * Null rather than a throw, so the route can answer the one error envelope with a
 * 400. A malformed cursor is never treated as "start from the beginning": the
 * cursor is opaque, so a client sending a bad one has a bug, and silently
 * restarting shows up as a list that jumped rather than as an error anybody can
 * act on.
 */
export function decodeCursor(raw: string): CursorPart[] | null {
  try {
    const padded = raw.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    // Every element checked, not just the array-ness: a cursor is attacker-supplied
    // input that goes straight into a bound parameter, and `{}` or `null` in a
    // comparison silently matches nothing rather than erroring.
    for (const part of parsed) {
      if (typeof part !== 'string' && typeof part !== 'number') return null
      if (typeof part === 'number' && !Number.isFinite(part)) return null
    }
    return parsed as CursorPart[]
  } catch {
    return null
  }
}

/**
 * Splits an over-fetch into a page and a "there is more" flag.
 *
 * Every keyset route asks for `limit + 1` rows: the extra row is how you know
 * there is a next page without a second query. It is dropped, never shown.
 */
export function windowOf<T>(fetched: readonly T[], limit: number): { rows: T[]; hasMore: boolean } {
  const hasMore = fetched.length > limit
  return { rows: hasMore ? fetched.slice(0, limit) : [...fetched], hasMore }
}

/**
 * `windowOf` plus the cursor, which is the whole of what a route does after its
 * query returns. `keyOf` names the sort key of the **last row on the page**, and
 * it has to match the query's own `order by` component for component — that
 * correspondence is the one thing no test in here can check for a caller, so it is
 * worth stating at every call site.
 *
 * The cursor is null on the last page even though a key could be computed for it:
 * "there is nothing after this" is the useful signal, and a non-null cursor on a
 * final page means a client makes one more request to discover an empty list.
 */
export function paginate<T>(
  fetched: readonly T[],
  limit: number,
  keyOf: (row: T) => readonly CursorPart[],
): Page<T> {
  const { rows, hasMore } = windowOf(fetched, limit)
  const last = rows.at(-1)
  return {
    rows,
    cursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
  }
}

/**
 * A `limit` clamped into range. Mirrors `server/validate.ts`'s `limitParam`, which
 * parses the same thing off a query string — this is the already-parsed form, for
 * a reader called directly (`folio.stories(env, …)`, a test, a script).
 */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback
  return Math.max(1, Math.min(Math.trunc(limit), max))
}
