import type { Doc } from "../core/doc";
import { dataOf } from "../core/locales";
import type { DocumentType } from "../core/schema";
import { isLive, type StoryMeta } from "../core/story";
import type { FolioLiveUrl } from "./types";

/**
 * A record's public URL, from the host's `liveUrls` entry for its type
 * (`../../docs/specs/content-model/record-live-url.md`).
 *
 * **A same-site path or nothing.** The function is the host's code, but what it builds
 * contains published field values, and the answer ends up in an `href` an editor opens,
 * so it is checked rather than trusted: a string that starts with a single `/`, resolves
 * to the same origin, and is already in the form a browser would navigate to. That refuses
 * `javascript:`, `https://elsewhere`, `//elsewhere`, `/\elsewhere`, whitespace and
 * control characters, and any `.` or `..` segment (also percent-encoded, as `%2e`) or
 * empty segment, which is how a slug of `../../folio/api/me` would walk "View live" out of
 * the host's path. An encoded slash, backslash or tab (`%2f`, `%5c`, `%09`) is refused for
 * the same reason `safeNext` refuses them. It is returned as written, so the host's own
 * trailing-slash and case choices stand.
 */
export function safeLiveUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  const path = value.split(/[?#]/, 1)[0] as string;
  if (/%(2f|5c|09|0a|0d|00)/i.test(path)) return null;
  const segments = path.slice(1).split("/");
  // The last segment may be empty (a trailing slash); a middle one never.
  for (const [i, segment] of segments.entries()) {
    if (segment === "" && i < segments.length - 1) return null;
    const plain = segment.replace(/%2e/gi, ".");
    if (plain === "." || plain === "..") return null;
  }
  try {
    const probe = "https://live-url.invalid";
    const parsed = new URL(value, probe);
    return parsed.origin === probe && parsed.pathname === path ? value : null;
  } catch {
    return null;
  }
}

/**
 * `liveUrls`, checked at construction like `panels`: an object keyed by the name of a
 * declared `record` type, each a function. A mistake here would otherwise be a link that
 * never appears.
 */
export function validateLiveUrls(
  liveUrls: Readonly<Record<string, FolioLiveUrl>> | undefined,
  types: readonly DocumentType[],
): ReadonlyMap<string, FolioLiveUrl> {
  const out = new Map<string, FolioLiveUrl>();
  if (liveUrls === undefined) return out;
  if (!liveUrls || typeof liveUrls !== "object" || Array.isArray(liveUrls)) {
    throw new Error("folio: `liveUrls` must be an object keyed by record type name");
  }
  for (const [name, fn] of Object.entries(liveUrls)) {
    const type = types.find((t) => t.name === name);
    if (!type) {
      throw new Error(
        `folio: \`liveUrls.${name}\` names a document type that is not declared (declared: ${types.map((t) => t.name).join(", ")})`,
      );
    }
    if (type.kind !== "record") {
      throw new Error(
        `folio: \`liveUrls.${name}\` is for a record, and '${name}' is kind '${type.kind}' (a page has its own URL)`,
      );
    }
    if (typeof fn !== "function") {
      throw new Error(`folio: \`liveUrls.${name}\` must be a function`);
    }
    out.set(name, fn);
  }
  return out;
}

/**
 * The link for one record, or null. Null for: no function for the type; a record that is
 * not live (never published, or unpublished); no published document; a function that
 * throws or answers something `safeLiveUrl` refuses.
 *
 * `doc` must be the **published** document. `data` is the source locale's, which is what
 * a host builds a path from; a host with `locales` that decorates its paths does so in its
 * own function.
 */
export function liveUrlFor(
  liveUrl: FolioLiveUrl | undefined,
  story: Pick<StoryMeta, "state">,
  doc: Doc | undefined,
): string | null {
  if (!liveUrl || !doc || !isLive(story.state)) return null;
  const root = doc.bloks[doc.root];
  if (!root) return null;
  try {
    return safeLiveUrl(liveUrl(dataOf(root)));
  } catch {
    return null;
  }
}
