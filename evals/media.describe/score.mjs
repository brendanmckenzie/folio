const ABBREVIATIONS = new Set(["st", "dr", "mt", "ave", "rd", "mr", "mrs", "ms", "no", "vs", "e.g", "i.e", "etc"]);

/**
 * Splits text into sentences. `!` and `?` always end one; a full stop ends one
 * only when the next word is capitalised and the token before it is not a
 * short abbreviation ("St.", "e.g.").
 *
 * @param {string} text
 */
export function sentencesOf(text) {
  const out = [];
  let start = 0;
  for (const m of text.matchAll(/([.!?]+)(\s+|$)/g)) {
    const end = m.index + m[0].length;
    if (/[!?]/.test(m[1])) {
      out.push(text.slice(start, end));
      start = end;
      continue;
    }
    const token = (text.slice(start, m.index).match(/[\p{L}.]+$/u)?.[0] ?? "").toLowerCase();
    const atEnd = end === text.length;
    if (!atEnd && (!/^\p{Lu}/u.test(text.slice(end)) || ABBREVIATIONS.has(token))) continue;
    out.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((s) => s.trim() !== "");
}

/**
 * Scores one `media.describe` answer against its gold. Pure: no I/O, so the
 * unit tests and the harness call the same function.
 *
 * `expected` is `expected.json`; `input` (optional) is `input.json`, used to
 * know the vocabulary. Metrics: `tagF1` (names compared case-insensitively;
 * an invented tag is a false positive), `factRecall` (share of `mustMention`
 * groups matched in alt or description), `altOk`. Pass needs all three.
 *
 * @param {{ alt?: unknown, description?: unknown, tags?: unknown } | null} output
 * @param {{ tags: string[], mustMention: string[][], decorative: boolean }} expected
 * @param {{ tags: { id: string, name: string }[] }} [input]
 */
export function score(output, expected, input) {
  if (!output) {
    return { pass: false, metrics: { tagF1: 0, factRecall: 0, altOk: 0, inventedTags: 0 } };
  }
  const norm = (s) => String(s).trim().toLowerCase();
  const gold = new Set(expected.tags.map(norm));
  const predicted = new Set((Array.isArray(output.tags) ? output.tags : []).map(norm));

  let tagF1;
  if (gold.size === 0 && predicted.size === 0) tagF1 = 1;
  else {
    const hits = [...predicted].filter((t) => gold.has(t)).length;
    const precision = predicted.size === 0 ? 0 : hits / predicted.size;
    const recall = gold.size === 0 ? 0 : hits / gold.size;
    tagF1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  }
  const vocabulary = new Set((input?.tags ?? []).map((t) => norm(t.name)));
  const inventedTags = input ? [...predicted].filter((t) => !vocabulary.has(t)).length : 0;

  const alt = typeof output.alt === "string" ? output.alt.trim() : "";
  const description = typeof output.description === "string" ? output.description : "";
  const text = norm(`${alt} ${description}`);
  const groups = expected.mustMention;
  const factRecall =
    groups.length === 0 ? 1 : groups.filter((g) => g.some((w) => text.includes(norm(w)))).length / groups.length;

  const sentences = sentencesOf(alt);
  const wellFormed = sentences.length <= 1 && !/^(image|photo|picture) of\b/i.test(alt);
  const altOk = expected.decorative ? (alt === "" || wellFormed) : alt !== "" && wellFormed;

  return {
    pass: tagF1 >= 0.6 && factRecall === 1 && altOk,
    metrics: { tagF1, factRecall, altOk: altOk ? 1 : 0, inventedTags },
  };
}
