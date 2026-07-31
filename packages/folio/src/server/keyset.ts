/**
 * The SQL half of keyset pagination: the `where` fragment that resumes after a
 * cursor, and the `order by` that has to agree with it.
 *
 * `core/pagination.ts` owns the cursor's encoding and the over-fetch arithmetic;
 * this owns the comparison. They are split because that file is pure and shared
 * with the client, and this one emits SQL.
 *
 * **Why a helper for three lines.** The fragment is
 * `(a < ? or (a = ? and b < ?))`, and every part of it is easy to get subtly
 * wrong: `<=` instead of `<` repeats a row on every page boundary, a missing
 * second clause skips rows that tie on the first column, and a direction that
 * disagrees with the `order by` pages backwards through the middle of the table.
 * None of those fail loudly — they produce a list that is quietly missing
 * something. Eight routes writing it eight times is eight chances at that.
 */
import type { CursorPart } from '../core/pagination'

export type Direction = 'asc' | 'desc'

export interface Keyset {
  /** `(primary, tiebreak)` column expressions, in the order they are sorted. The
   * tiebreak must be unique — in practice always a primary key — or a page
   * boundary landing on a tie can still repeat or skip. */
  columns: [string, string]
  direction: Direction
}

/**
 * The `order by` clause for a keyset. Both columns, same direction, always —
 * which is the property that makes the cursor a total order.
 */
export function orderBy(keyset: Keyset): string {
  const [primary, tiebreak] = keyset.columns
  const dir = keyset.direction === 'desc' ? 'desc' : 'asc'
  return `order by ${primary} ${dir}, ${tiebreak} ${dir}`
}

/**
 * The `where` fragment that resumes strictly after `cursor`, and its binds.
 *
 * Returns empty for a null cursor, so a caller can always concatenate: the first
 * page and a later one differ by a clause, not by a code path.
 *
 * `<` and `>` rather than `<=`/`>=`: the cursor names the **last row already
 * shown**, so resuming must exclude it. That is also why `paginate` keys on the
 * last row of the page rather than the over-fetched one.
 */
export function keysetWhere(
  keyset: Keyset,
  cursor: readonly CursorPart[] | null,
): { sql: string; binds: CursorPart[] } {
  if (!cursor || cursor.length !== 2) return { sql: '', binds: [] }
  const [primary, tiebreak] = keyset.columns
  const [at, after] = cursor as [CursorPart, CursorPart]
  const cmp = keyset.direction === 'desc' ? '<' : '>'
  return {
    sql: `(${primary} ${cmp} ? or (${primary} = ? and ${tiebreak} ${cmp} ?))`,
    binds: [at, at, after],
  }
}

/**
 * Assembles a `where` clause from fragments, dropping the empty ones.
 *
 * Trivial, and it exists so a route never writes
 * `clauses.length ? \`where ${clauses.join(' and ')}\` : ''` again — the version
 * that forgets the ternary produces `where ` and a syntax error, and the version
 * that forgets to filter empties produces `where  and x = ?`.
 */
export function whereOf(...fragments: (string | undefined | null | false)[]): string {
  const kept = fragments.filter((f): f is string => typeof f === 'string' && f.length > 0)
  return kept.length > 0 ? `where ${kept.join(' and ')}` : ''
}

/** The `(created_at, id)` keyset, newest first — assets, versions and tokens all
 * page this way, and all three have a text primary key to break the tie. */
export const NEWEST_FIRST: Keyset = { columns: ['created_at', 'id'], direction: 'desc' }

/** The same pair, oldest first: `users` is listed in the order people joined. */
export const OLDEST_FIRST: Keyset = { columns: ['created_at', 'id'], direction: 'asc' }

/** Sibling order within a parent, or within a type for an unrouted document.
 * `(ord, id)` is exactly what `core/doc.ts`'s `compareSiblings` compares, and
 * exactly what the `stories_parent_ord` and `stories_type` indexes cover. */
export const SIBLING_ORDER: Keyset = { columns: ['ord', 'id'], direction: 'asc' }
