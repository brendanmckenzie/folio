/**
 * `FolioConfig.panels`, checked at construction (`platform/admin-extensions.md` decision 21):
 * a host function per document type that answers a small structured summary the inspector
 * draws, read-only, on the root block of a document of that type. Per brand, because a
 * document type is a brand's. Each refusal is a throw naming the key: the request that would
 * otherwise discover a `load` that is not a function is an editor opening a document.
 */
import type { FolioPanelSummary } from "../core/panels";
import type { FolioEditor } from "./editor";
import type { BrandRef } from "./types";
import { ROLES, type Role } from "./auth/roles";
import type { StoryMeta } from "../core/story";
import type { Json } from "../core/doc";

export interface FolioPanelContext {
  story: StoryMeta;
  /** The draft root block's data in the source locale (`dataOf`): what the editor sees. */
  data: Readonly<Record<string, Json>>;
  /** The inspector's locale, or null for the source locale. */
  locale: string | null;
  scope: string | null;
  brand: BrandRef | null;
  /**
   * Who is looking, projected with `editorOf` from the route's own scoped actor (no second
   * credential read). Null under `auth: 'open'`.
   */
  editor: FolioEditor | null;
  /** Aborts at `timeoutMs`. */
  signal: AbortSignal;
}

export interface FolioPanel<Env> {
  /** The card's heading in the inspector. 1 to 40 characters. */
  label: string;
  /** The minimum role on the document's scope to see it. Default `viewer`. */
  role?: Role;
  /** Milliseconds before the call is abandoned. 500 to 10000, default 3000. */
  timeoutMs?: number;
  /**
   * The summary, or null for "nothing linked" (the card is then not drawn). A method, for the
   * bivariance reason `FolioGate` gives.
   */
  load(
    ctx: FolioPanelContext,
    env: Env,
  ): FolioPanelSummary | null | Promise<FolioPanelSummary | null>;
}

/** A panel with its defaults applied. */
export interface ResolvedPanel {
  type: string;
  label: string;
  role: Role;
  timeoutMs: number;
  load: FolioPanel<unknown>["load"];
}

export const DEFAULT_PANEL_TIMEOUT_MS = 3000;
export const MIN_PANEL_TIMEOUT_MS = 500;
export const MAX_PANEL_TIMEOUT_MS = 10_000;
const PANEL_KEYS = ["label", "role", "timeoutMs", "load"];

export function validatePanels<Env>(
  panels: Readonly<Record<string, FolioPanel<Env>>> | undefined,
  typeNames: readonly string[],
): ReadonlyMap<string, ResolvedPanel> {
  const out = new Map<string, ResolvedPanel>();
  if (panels === undefined) return out;
  if (!panels || typeof panels !== "object" || Array.isArray(panels)) {
    throw new Error("folio: `panels` must be an object keyed by document type name");
  }
  for (const [type, panel] of Object.entries(panels)) {
    const where = `\`panels.${type}\``;
    if (!typeNames.includes(type)) {
      throw new Error(
        `folio: ${where} names a document type that is not declared (declared: ${typeNames.join(", ")})`,
      );
    }
    if (!panel || typeof panel !== "object" || Array.isArray(panel)) {
      throw new Error(`folio: ${where} must be an object`);
    }
    for (const key of Object.keys(panel)) {
      if (!PANEL_KEYS.includes(key)) {
        throw new Error(`folio: unknown key ${where}.${key} (valid: ${PANEL_KEYS.join(", ")})`);
      }
    }
    if (typeof panel.label !== "string" || panel.label.trim() === "" || panel.label.length > 40) {
      throw new Error(`folio: ${where}.label must be a string of 1 to 40 characters`);
    }
    if (typeof panel.load !== "function") {
      throw new Error(`folio: ${where}.load must be a function`);
    }
    if (panel.role !== undefined && !(ROLES as readonly unknown[]).includes(panel.role)) {
      throw new Error(`folio: ${where}.role must be one of ${ROLES.join(", ")}`);
    }
    const timeoutMs = panel.timeoutMs ?? DEFAULT_PANEL_TIMEOUT_MS;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_PANEL_TIMEOUT_MS ||
      timeoutMs > MAX_PANEL_TIMEOUT_MS
    ) {
      throw new Error(
        `folio: ${where}.timeoutMs is ${JSON.stringify(panel.timeoutMs)}; it must be a whole number of milliseconds from ${MIN_PANEL_TIMEOUT_MS} to ${MAX_PANEL_TIMEOUT_MS}`,
      );
    }
    out.set(type, {
      type,
      label: panel.label,
      role: panel.role ?? "viewer",
      timeoutMs,
      load: panel.load.bind(panel) as FolioPanel<unknown>["load"],
    });
  }
  return out;
}
