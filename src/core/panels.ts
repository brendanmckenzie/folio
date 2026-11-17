/**
 * The linked-data panel's vocabulary and its screening
 * (`platform/admin-extensions.md` decision 21): what a host's `panels.<type>.load` may
 * answer, and the one pure function that turns whatever it did answer into something the
 * admin may draw. No D1, no Hono, no React.
 *
 * **JSON, not HTML.** Folio renders every string as React text in its own tokens, so a
 * host's summary needs no sanitiser and the inspector holds no second iframe.
 */
import { screenHostText } from "./host-page";

export type PanelTone = "neutral" | "ok" | "warn" | "danger";

export interface FolioPanelSummary {
  /** At most 8. `label` 1 to 40 characters, `value` 1 to 80. */
  items: readonly { label: string; value: string; tone?: PanelTone }[];
  /** At most 280 characters. */
  note?: string;
  /**
   * A same-origin path (rewritten to the admin's host-page URL when under a declared page
   * path) or an `https:` URL (opened in a new tab). `label` 1 to 40 characters.
   */
  link?: { label: string; href: string };
}

export const PANEL_MAX_ITEMS = 8;
export const PANEL_LABEL_MAX = 40;
export const PANEL_VALUE_MAX = 80;
export const PANEL_NOTE_MAX = 280;
export const PANEL_LINK_MAX = 40;

const TONES: readonly PanelTone[] = ["neutral", "ok", "warn", "danger"];

/**
 * Whether `href` is a link the card may draw: a path that can only mean this origin **as a
 * browser reads it** (one leading `/`, no `//`, no backslash or control character, and the
 * decoded form still a path: `safeNext`'s rule), or an `https:` URL. Anything else, a
 * `javascript:` or `data:` URL above all, is dropped.
 */
export function isPanelHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || href.length > 2000) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(href)) return false;
  if (href.startsWith("/")) {
    if (href.startsWith("//")) return false;
    try {
      if (new URL(href, "https://panel.invalid").origin !== "https://panel.invalid") return false;
      const decoded = decodeURIComponent(href);
      return (
        decoded.startsWith("/") &&
        !decoded.startsWith("//") &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: as above
        !/[\u0000-\u001f\u007f\\]/.test(decoded)
      );
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Screens a host's answer: at most `PANEL_MAX_ITEMS` items, each `label` and `value` trimmed,
 * printable and cut at its cap with a `…` (an item that fails is dropped, never the card),
 * `tone` kept only when it is one of four, a `note` cut at 280, and a `link` kept only when its
 * `label` is usable and its `href` passes `isPanelHref`. Answers `null` ("malformed") when no
 * item survives and there is no note: a card with nothing to say is a failure, not an answer.
 */
export function screenPanel(raw: unknown): FolioPanelSummary | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const items: { label: string; value: string; tone?: PanelTone }[] = [];
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (items.length >= PANEL_MAX_ITEMS) break;
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const label = screenHostText(entry.label, PANEL_LABEL_MAX);
      const value = screenHostText(entry.value, PANEL_VALUE_MAX);
      if (label === null || value === null) continue;
      const tone = TONES.find((t) => t === entry.tone);
      items.push({ label, value, ...(tone ? { tone } : {}) });
    }
  }
  const note = screenHostText(input.note, PANEL_NOTE_MAX);
  if (items.length === 0 && note === null) return null;

  let link: FolioPanelSummary["link"];
  if (typeof input.link === "object" && input.link !== null) {
    const candidate = input.link as Record<string, unknown>;
    const label = screenHostText(candidate.label, PANEL_LINK_MAX);
    if (label !== null && isPanelHref(candidate.href)) link = { label, href: candidate.href };
  }
  return { items, ...(note !== null ? { note } : {}), ...(link ? { link } : {}) };
}

/** What `GET {base}/api/stories/:id/panel` answers. */
export type PanelAnswer =
  | { status: "ok"; summary: FolioPanelSummary; at: number }
  /** `load` answered null: nothing is linked, and the card is not drawn. */
  | { status: "none" }
  | { status: "error"; reason: "timeout" | "threw" | "malformed" };
