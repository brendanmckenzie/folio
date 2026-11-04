/**
 * A brand's writing guide (`../../docs/specs/content-model/authoring-guidance.md`
 * decisions 6 and 7): its construction-time check, and the one part of it a check
 * can judge, the `avoid` terms.
 *
 * **Never on the open manifest.** The guide is held on `BrandRuntime.writing` and
 * read by `GET {base}/api/v1/schema` alone, which is gated at `content:read`;
 * `toManifest` never sees it, so neither `{base}/api/schema` nor the MCP
 * `server/discover` answer (both unauthenticated) can carry it.
 */
import type { WritingGuide } from "./types";

/** Ceiling on `writing.voice`: a style guide, not a book. */
export const MAX_WRITING_VOICE = 16_000;
/** Ceiling on `writing.avoid`. Each is one regular expression per prose value per check. */
export const MAX_WRITING_AVOID = 200;
/** Ceiling on one avoided term. */
const MAX_TERM = 100;
/** Ceiling on a term's `use` and `reason`. */
const MAX_TERM_NOTE = 500;

const GUIDE_KEYS = ["voice", "avoid"];
const TERM_KEYS = ["term", "use", "reason"];

/**
 * `writing`, checked at construction beside `validateDescribe`, each refusal a throw
 * naming the key. Null when the brand declares none, which is every brand that
 * existed before this spec. `prepareBrand` prefixes a branded refusal with the brand.
 */
export function validateWriting(writing: unknown): WritingGuide | null {
  if (writing === undefined) return null;
  if (typeof writing !== "object" || writing === null || Array.isArray(writing)) {
    throw new Error("folio: 'writing' must be an object of { voice, avoid? }");
  }
  const w = writing as Record<string, unknown>;
  for (const key of Object.keys(w)) {
    if (!GUIDE_KEYS.includes(key)) {
      throw new Error(`folio: unknown 'writing.${key}' (valid: ${GUIDE_KEYS.join(", ")})`);
    }
  }
  if (typeof w.voice !== "string" || !w.voice.trim() || w.voice.length > MAX_WRITING_VOICE) {
    throw new Error(
      `folio: 'writing.voice' must be a non-empty string of at most ${MAX_WRITING_VOICE.toLocaleString("en")} characters`,
    );
  }
  if (w.avoid !== undefined) {
    if (!Array.isArray(w.avoid) || w.avoid.length > MAX_WRITING_AVOID) {
      throw new Error(
        `folio: 'writing.avoid' must be an array of at most ${MAX_WRITING_AVOID} terms`,
      );
    }
    const seen = new Set<string>();
    for (const [i, entry] of w.avoid.entries()) {
      const at = `writing.avoid[${i}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`folio: '${at}' must be an object of { term, use?, reason? }`);
      }
      const e = entry as Record<string, unknown>;
      for (const key of Object.keys(e)) {
        if (!TERM_KEYS.includes(key)) {
          throw new Error(`folio: unknown '${at}.${key}' (valid: ${TERM_KEYS.join(", ")})`);
        }
      }
      if (typeof e.term !== "string" || !e.term.trim() || e.term.length > MAX_TERM) {
        throw new Error(
          `folio: '${at}.term' must be a non-empty string of at most ${MAX_TERM} characters`,
        );
      }
      for (const key of ["use", "reason"] as const) {
        const v = e[key];
        if (v !== undefined && (typeof v !== "string" || v.length > MAX_TERM_NOTE)) {
          throw new Error(
            `folio: '${at}.${key}' must be a string of at most ${MAX_TERM_NOTE} characters`,
          );
        }
      }
      const folded = e.term.trim().toLowerCase();
      if (seen.has(folded)) {
        throw new Error(
          `folio: '${at}.term' repeats '${e.term}': avoid terms must be distinct ignoring case`,
        );
      }
      seen.add(folded);
    }
  }
  return writing as WritingGuide;
}

/** A term's literal text as a pattern: every syntax character escaped (the set `u` mode allows). */
const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * One matcher per avoided term (decision 7): case-insensitive, the term as a
 * literal, on Unicode word boundaries (not preceded or followed by a letter or a
 * digit), so "cheap" does not match "cheapest". Built once per brand, because the
 * guide is fixed at construction. **Never a host-supplied regular expression**: a
 * catastrophic one would be a denial of service the host wrote into its own CPU
 * budget, and a model cannot tell from one what to write instead.
 */
export function avoidMatchers(
  writing: WritingGuide | null,
): readonly { term: string; use?: string; test: (text: string) => boolean }[] {
  return (writing?.avoid ?? []).map(({ term, use }) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${literal(term.trim())}(?![\\p{L}\\p{N}])`, "iu");
    return { term, ...(use !== undefined ? { use } : {}), test: (text: string) => re.test(text) };
  });
}
