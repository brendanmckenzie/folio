/**
 * Building a `like` pattern from a term somebody typed.
 *
 * D1 refuses a `like` pattern longer than **50 bytes** (`LIKE or GLOB pattern too
 * complex`), counted on the whole bound string: the wildcards, any escape characters
 * and the UTF-8 encoding all count, so a 30-character title in Cyrillic is 60 bytes
 * and a term full of `%` doubles. An unbounded term is therefore a 500 on every search
 * box, from a term a person could type by accident.
 *
 * The term is **truncated, not refused**, matching `clampSearch` in `core/query.ts`: a
 * search for the first few words of a long term finds what it was looking for, and a
 * 400 on a search box finds nothing. Truncation is by whole code points, so it never
 * splits a character, and the escape pair for `%`, `_` and `\` is kept or dropped as
 * one so the pattern never ends on a dangling escape.
 *
 * Every pattern built here must be used with {@link LIKE_ESCAPE}.
 */

/** D1's ceiling on a `like` pattern, in bytes. */
export const MAX_LIKE_PATTERN_BYTES = 50;

/** The clause every pattern from {@link likePattern} is matched with. */
export const LIKE_ESCAPE = "escape '\\'";

const encoder = new TextEncoder();

/**
 * `%term%` (or `term%` with `leading: false`), with `%`, `_` and `\` in the term
 * escaped so they match themselves, and the whole pattern within D1's byte limit.
 */
export function likePattern(term: string, opts: { leading?: boolean } = {}): string {
  const lead = opts.leading === false ? "" : "%";
  let budget = MAX_LIKE_PATTERN_BYTES - lead.length - 1;
  let body = "";
  for (const ch of term) {
    const piece = ch === "%" || ch === "_" || ch === "\\" ? `\\${ch}` : ch;
    const bytes = encoder.encode(piece).length;
    if (bytes > budget) break;
    body += piece;
    budget -= bytes;
  }
  return `${lead}${body}%`;
}
