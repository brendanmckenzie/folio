/**
 * Ranking and list navigation, as pure functions over plain data.
 *
 * Both live here rather than inside the components that use them because of the
 * admin's testing convention: 357 admin tests exist and **not one mounts a
 * component** (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`). Keeping the palette's ranking and the list's keyboard
 * arithmetic pure is what lets the rebuilt shell stay inside that convention
 * instead of dragging a DOM into the test suite.
 */

/** A scored match, with the spans of `text` that matched, for highlighting. */
export interface Match {
  score: number
  spans: readonly [number, number][]
}

/** Characters after which a position counts as the start of a word. Includes
 * `/`, `.`, `_` and `-` because the things being searched here are paths, slugs
 * and block ids as often as they are prose. */
const BOUNDARY = /[\s/._\-:]/

/**
 * Scores `query` against `text`, or returns null when it does not match at all.
 *
 * Three tiers, highest first: the query appears as a substring at a word start,
 * as a substring anywhere, or as a subsequence. The subsequence tier is what
 * makes `ct` find `Content` and `apn` find `A page name`; the contiguity bonus is
 * what stops it preferring a scattered match in a long label over a tight one in
 * a short label.
 *
 * An empty query matches everything with score 0, so a freshly opened palette
 * shows its whole action list in declaration order rather than nothing.
 */
export function matchText(text: string, query: string): Match | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return { score: 0, spans: [] }

  const hay = text.toLowerCase()
  const at = hay.indexOf(needle)
  if (at >= 0) {
    const boundary = at === 0 || BOUNDARY.test(hay[at - 1] ?? '')
    // Earliness breaks ties between two substring hits; the word-start bonus
    // outweighs it, so "settings" beats "Site settings" for the query "set"
    // only when neither is at a boundary.
    const score = 1000 + (boundary ? 400 : 0) + (at === 0 ? 200 : 0) - Math.min(at, 100)
    return { score, spans: [[at, at + needle.length]] }
  }

  const spans: [number, number][] = []
  let cursor = 0
  let score = 0
  let run = 0
  for (const ch of needle) {
    const found = hay.indexOf(ch, cursor)
    if (found < 0) return null
    const boundary = found === 0 || BOUNDARY.test(hay[found - 1] ?? '')
    if (found === cursor && spans.length > 0) {
      run += 1
      score += 8 + run * 4
      // Extend the previous span rather than opening a new one, so a contiguous
      // run highlights as one range.
      const last = spans[spans.length - 1]
      if (last) last[1] = found + 1
    } else {
      run = 0
      score += boundary ? 10 : 3
      // A gap costs, but a bounded amount: a late match in a long path should
      // still beat no match.
      score -= Math.min(found - cursor, 20) * 0.25
      spans.push([found, found + 1])
    }
    cursor = found + 1
  }
  // Shorter labels win at equal evidence: matching 3 of 7 characters is a
  // stronger signal than matching 3 of 70.
  return { score: score + 40 / Math.max(text.length, 1), spans }
}

/** Anything the palette can rank: a label, plus optional hidden search terms. */
export interface Rankable {
  label: string
  /** Searched but never highlighted — a path, a type name, an alias. */
  keywords?: string
}

export interface Ranked<T> {
  item: T
  match: Match
}

/**
 * Ranks `items` against `query`, dropping non-matches.
 *
 * Sorted by score descending, then by the original order — a stable tail rather
 * than an alphabetical one, so an action list stays in the order it was
 * declared while the query is empty and while scores tie.
 */
export function rank<T extends Rankable>(query: string, items: readonly T[]): Ranked<T>[] {
  const scored: (Ranked<T> & { index: number })[] = []
  for (const [index, item] of items.entries()) {
    const label = matchText(item.label, query)
    // Keywords are scored at a discount so a label match always outranks a
    // keyword match, which is what keeps "Assets" above a page that happens to
    // live at /assets.
    const keyword = item.keywords ? matchText(item.keywords, query) : null
    const best =
      label && keyword
        ? label.score >= keyword.score * 0.6
          ? label
          : { score: keyword.score * 0.6, spans: [] }
        : label
          ? label
          : keyword
            ? { score: keyword.score * 0.6, spans: [] }
            : null
    if (best) scored.push({ item, match: best, index })
  }
  scored.sort((a, b) => b.match.score - a.match.score || a.index - b.index)
  return scored.map(({ item, match }) => ({ item, match }))
}

/**
 * Splits `text` into alternating unmatched/matched runs for rendering.
 * Returns `[{ text, hit }]` so a component maps it straight to spans.
 */
export function highlight(text: string, spans: readonly [number, number][]) {
  const parts: { text: string; hit: boolean }[] = []
  let at = 0
  for (const [from, to] of spans) {
    if (from > at) parts.push({ text: text.slice(at, from), hit: false })
    parts.push({ text: text.slice(from, to), hit: true })
    at = to
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}

/**
 * Where a keypress moves the active index in a list of `count` items, or null
 * when the key is not ours to handle.
 *
 * Wraps, deliberately: a palette whose selection sticks at the bottom edge feels
 * broken, and every list in this system is short enough (or paged) that wrapping
 * cannot be disorienting. `current` of -1 means nothing is active yet, so
 * ArrowDown lands on the first row rather than the second.
 */
export function nextIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1
    case 'Home':
      return 0
    case 'End':
      return count - 1
    case 'PageDown':
      return Math.min(count - 1, (current < 0 ? 0 : current) + 10)
    case 'PageUp':
      return Math.max(0, (current < 0 ? 0 : current) - 10)
    default:
      return null
  }
}
