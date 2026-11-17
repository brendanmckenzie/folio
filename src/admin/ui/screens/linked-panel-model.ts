/**
 * What the inspector's linked-data panel decides, as pure functions
 * (`platform/admin-extensions.md` decision 21). `LinkedPanel.tsx` is the request and the
 * markup; every branch it takes is one of these.
 */
import type { Json } from "../../../core/doc";
import type { FolioPanelSummary, PanelAnswer } from "../../../core/panels";
import { href as adminHref, type Screen } from "../route";
import { hostScreenOf, type HostPageRef } from "./host-page-model";
import type { BadgeTone } from "../Badge";

/** A root scalar changing refetches the summary, at most once per this long. */
export const PANEL_DEBOUNCE_MS = 3000;

/**
 * What a refetch is keyed on: the draft root's scalars (string, number, boolean, null), sorted,
 * so editing a title that the host's summary may depend on refetches and moving a block does
 * not. Objects and arrays (richtext, links, assets) are left out: they are not what a
 * `load` is told about the document that it could not read for itself.
 */
export function panelKey(data: Readonly<Record<string, Json>>): string {
  const scalars: Record<string, Json> = {};
  for (const name of Object.keys(data).sort()) {
    const value = data[name];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      scalars[name] = value;
    }
  }
  return JSON.stringify(scalars);
}

export function panelUrl(apiBase: string, storyId: string, locale?: string | null): string {
  const base = `${apiBase}/stories/${encodeURIComponent(storyId)}/panel`;
  return locale ? `${base}?locale=${encodeURIComponent(locale)}` : base;
}

/** The summary's tone as a `Badge`'s: the two vocabularies are the same four names. */
export const toneOf = (tone: "neutral" | "ok" | "warn" | "danger" | undefined): BadgeTone =>
  tone ?? "neutral";

const REASON = { timeout: "timed out", threw: "failed", malformed: "answered something unusable" };

/** "Couldn't load Shop (timed out)": the category, never the host's message. */
export const errorLine = (label: string, reason: keyof typeof REASON): string =>
  `Couldn't load ${label} (${REASON[reason]})`;

/** What the card draws. `none` is not drawn at all; `idle` is the first request in flight. */
export type CardState =
  | { kind: "idle" }
  | { kind: "ok"; summary: FolioPanelSummary }
  | { kind: "none" }
  | { kind: "error"; reason: keyof typeof REASON };

export function cardState(answer: PanelAnswer | null): CardState {
  if (answer === null) return { kind: "idle" };
  if (answer.status === "ok") return { kind: "ok", summary: answer.summary };
  if (answer.status === "none") return { kind: "none" };
  return { kind: "error", reason: answer.reason };
}

/** Where the card's link goes. */
export type PanelLink =
  /** An `https:` URL: a new tab, `rel="noopener noreferrer"`. */
  | { kind: "external"; href: string }
  /** A path under a declared host page: the admin's own URL for it, so it opens inside the chrome. */
  | { kind: "host"; href: string; screen: Screen }
  /** Any other same-origin path: the top window navigates to it. */
  | { kind: "path"; href: string };

/**
 * Decision 21's link rule. `mount` is the **scoped** mount the admin is showing, so a link
 * into a `site` page keeps its scope. A host link keeps its query.
 */
export function panelLink(
  link: { href: string },
  pages: readonly HostPageRef[],
  mount: string,
): PanelLink {
  if (link.href.startsWith("https:")) return { kind: "external", href: link.href };
  const target = hostScreenOf(link.href, pages);
  if (target) {
    const screen: Screen = { name: "host", id: target.id, rest: target.rest };
    return { kind: "host", href: adminHref(screen, mount, target.query), screen };
  }
  return { kind: "path", href: link.href };
}
