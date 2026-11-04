/**
 * Reading `UPGRADING.md` the two ways a machine needs to: the `###` entries a
 * release names (for release notes, and for the plan's reading list) and the
 * anchor GitHub gives a heading (for the links `folio upgrade` prints).
 *
 * `upgradingEntries` moved here from `scripts/release-notes.mjs`, which re-exports
 * it, so the release notes and `upgrade-ledger.json`'s cross-check select headings
 * by one rule rather than two that could drift.
 */

/** The `###` sections of `markdown` whose heading contains `tag`, joined by a blank line. */
export function upgradingEntries(markdown, tag) {
  const lines = markdown.split("\n");
  const entries = [];
  let current = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const heading = !inFence && /^(#{1,6}) /.exec(line);
    if (heading) {
      if (current) entries.push(current);
      current = heading[1] === "###" && line.includes(tag) ? [line] : null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) entries.push(current);
  return entries.map((e) => e.join("\n").trim()).join("\n\n");
}

/**
 * Every heading in `markdown` as `{ level, text }`, outside fenced code, in
 * document order. `text` is the heading without its hashes.
 */
export function headings(markdown) {
  const found = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6}) (.*)$/.exec(line);
    if (m) found.push({ level: m[1].length, text: m[2].trim() });
  }
  return found;
}

/** The `###` headings that name `v<version>`: the set `upgradingEntries` selects. */
export function releaseHeadings(markdown, version) {
  const tag = `v${version}`;
  return headings(markdown)
    .filter((h) => h.level === 3 && h.text.includes(tag))
    .map((h) => h.text);
}

/**
 * GitHub's anchor for a heading: lowercase, every character other than a letter,
 * a digit, a space, `-` or `_` dropped, then each space a `-`. Pinned against
 * every `](#…)` link `UPGRADING.md` makes to itself by `ledger.test.ts`.
 */
export function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}
