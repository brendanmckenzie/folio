/**
 * `FolioConfig.admin`, checked at construction (`platform/admin-extensions.md`
 * decision 12): host-served pages listed in the admin's sidebar. Each refusal is a
 * throw naming the key, because a page the sidebar draws and the host cannot serve
 * is found by an editor, not by the developer.
 *
 * Deployment-wide, not per brand: the admin is one origin and one sidebar. A page
 * narrows itself to some brands with `brands`.
 */
import {
  HOST_PAGE_ICONS,
  HOST_PAGE_ID,
  type HostPageIcon,
  MAX_HOST_PAGES,
} from "../core/host-page";
import { ALL_SCOPES } from "../core/sites";
import { type Actor, atLeast, ROLES, type Role } from "./auth/roles";

export interface HostPage {
  /** `/^[a-z][a-z0-9-]{0,31}$/`, unique. The admin route segment: `{mount}/host/<id>`. */
  id: string;
  /** The sidebar label and first crumb. 1 to 40 characters. */
  label: string;
  /**
   * The host route, same origin: starts with `/`, not `//`, no `?` or `#`, no trailing
   * `/`, not `{basePath}` or under it, and no page's path a prefix of another's.
   */
  path: string;
  /** One of `HOST_PAGE_ICONS`. Default `"window"`. */
  icon?: HostPageIcon;
  /**
   * The minimum role. Default `"viewer"`. The admin hides the item below it; the host
   * route enforces it through `requireEditor({ page })`.
   */
  role?: Role;
  /** A sidebar heading, like `DocumentType.group`. 1 to 40 characters. */
  group?: string;
  /**
   * `"deployment"` (default): the data belongs to no site; the role is the `*` grant.
   * `"site"`: the data is per site; the frame gets `folio_scope` and the role is the
   * effective role on it. Meaningful only with `sites`.
   */
  scope?: "deployment" | "site";
  /**
   * With `brands` and `scope: "site"` only: shown and admitted only under a scope of
   * these brands. Every id configured.
   */
  brands?: readonly string[];
}

export interface FolioAdminConfig {
  pages?: readonly HostPage[];
}

/** A page with every default applied. */
export interface ResolvedHostPage {
  id: string;
  label: string;
  path: string;
  icon: HostPageIcon;
  role: Role;
  group?: string;
  scope: "deployment" | "site";
  brands?: readonly string[];
}

export interface AdminContext {
  /** Where the routes are mounted, `/folio`. */
  base: string;
  /** Whether the config has `sites`. */
  sites: boolean;
  /** The configured brand ids, or null with no `brands`. */
  brandIds: readonly string[] | null;
  /** `rt.auth.mode`. */
  mode: "session" | "open";
}

const PAGE_KEYS = ["id", "label", "path", "icon", "role", "group", "scope", "brands"];

const own = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, key: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`folio: ${key} must be a string of 1 to ${max} characters`);
  }
  return value;
}

/** Whether `a` is `b` or a segment-boundary prefix of it (`/admin` of `/admin/orders`). */
const nests = (a: string, b: string) => b === a || b.startsWith(`${a}/`);

/**
 * Validates `config.admin`. Returns the pages with defaults applied, in declaration
 * order; an empty list for a config with no `admin`, which is every config that
 * existed before them.
 */
export function validateAdmin(admin: unknown, ctx: AdminContext): readonly ResolvedHostPage[] {
  if (admin === undefined) return [];
  if (!own(admin)) throw new Error("folio: 'admin' must be an object");
  for (const key of Object.keys(admin)) {
    if (key !== "pages") throw new Error(`folio: unknown key 'admin.${key}'`);
  }
  const pages = admin.pages;
  if (pages === undefined) return [];
  if (!Array.isArray(pages)) throw new Error("folio: 'admin.pages' must be an array");
  if (pages.length === 0) return [];
  if (ctx.mode !== "session") {
    throw new Error(
      "folio: 'admin.pages' needs sign-in: under auth: 'open' every host page would refuse everyone, because editor() answers null",
    );
  }
  if (pages.length > MAX_HOST_PAGES) {
    throw new Error(`folio: 'admin.pages' holds ${pages.length} pages; at most ${MAX_HOST_PAGES}`);
  }

  const seen = new Set<string>();
  const out: ResolvedHostPage[] = [];
  pages.forEach((raw: unknown, i) => {
    const at = `admin.pages[${i}]`;
    if (!own(raw)) throw new Error(`folio: '${at}' must be an object`);
    for (const key of Object.keys(raw)) {
      if (!PAGE_KEYS.includes(key)) throw new Error(`folio: unknown key '${at}.${key}'`);
    }
    const id = raw.id;
    if (typeof id !== "string" || !HOST_PAGE_ID.test(id)) {
      throw new Error(
        `folio: '${at}.id' must be 1 to 32 lowercase letters, digits or hyphens, starting with a letter`,
      );
    }
    if (seen.has(id)) throw new Error(`folio: '${at}.id' '${id}' is declared twice`);
    seen.add(id);
    const label = text(raw.label, `'${at}.label'`, 40);

    const path = raw.path;
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error(
        `folio: '${at}.path' must start with a single '/' (a path on the admin's origin)`,
      );
    }
    if (/[?#\\]/.test(path) || path.length > 200) {
      throw new Error(
        `folio: '${at}.path' must hold no '?', '#' or '\\' and be at most 200 characters`,
      );
    }
    if (path.endsWith("/")) throw new Error(`folio: '${at}.path' must have no trailing '/'`);
    // Normalisation moves `..` and `.` segments, which would let the frame leave the page.
    let normal: string;
    try {
      normal = new URL(path, "http://folio.invalid").pathname;
    } catch {
      normal = "";
    }
    if (normal !== path) {
      throw new Error(`folio: '${at}.path' must be a normalised path with no '.' or '..' segments`);
    }
    if (nests(ctx.base, path)) {
      throw new Error(`folio: '${at}.path' '${path}' is Folio's own mount, '${ctx.base}'`);
    }

    let icon: HostPageIcon = "window";
    if (raw.icon !== undefined) {
      if (!(HOST_PAGE_ICONS as readonly unknown[]).includes(raw.icon)) {
        throw new Error(`folio: '${at}.icon' must be one of ${HOST_PAGE_ICONS.join(", ")}`);
      }
      icon = raw.icon as HostPageIcon;
    }
    let role: Role = "viewer";
    if (raw.role !== undefined) {
      if (!(ROLES as readonly unknown[]).includes(raw.role)) {
        throw new Error(`folio: '${at}.role' must be one of ${ROLES.join(", ")}`);
      }
      role = raw.role as Role;
    }
    const group = raw.group === undefined ? undefined : text(raw.group, `'${at}.group'`, 40);

    let scope: "deployment" | "site" = "deployment";
    if (raw.scope !== undefined) {
      if (raw.scope !== "deployment" && raw.scope !== "site") {
        throw new Error(`folio: '${at}.scope' must be 'deployment' or 'site'`);
      }
      scope = raw.scope;
    }
    if (scope === "site" && !ctx.sites) {
      throw new Error(`folio: '${at}.scope' is 'site', which needs 'sites'`);
    }

    let brands: readonly string[] | undefined;
    if (raw.brands !== undefined) {
      if (!ctx.brandIds) throw new Error(`folio: '${at}.brands' needs 'brands'`);
      if (scope !== "site") {
        throw new Error(
          `folio: '${at}.brands' is set on a 'deployment' page, which has no scope to take a brand from, so the filter would be drawn in the sidebar and never enforced`,
        );
      }
      if (!Array.isArray(raw.brands) || raw.brands.length === 0) {
        throw new Error(`folio: '${at}.brands' must be a non-empty array of brand ids`);
      }
      for (const b of raw.brands) {
        if (typeof b !== "string" || !ctx.brandIds.includes(b)) {
          throw new Error(
            `folio: '${at}.brands' names '${String(b)}', which is not a configured brand`,
          );
        }
      }
      brands = [...raw.brands] as string[];
    }
    out.push({
      id,
      label,
      path,
      icon,
      role,
      ...(group ? { group } : {}),
      scope,
      ...(brands ? { brands } : {}),
    });
  });

  // The frame's location has to map to exactly one page.
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < out.length; j++) {
      if (i !== j && nests(out[i]!.path, out[j]!.path)) {
        throw new Error(
          `folio: 'admin.pages[${i}].path' '${out[i]!.path}' is a prefix of 'admin.pages[${j}].path' '${out[j]!.path}': a frame's location must map to exactly one page`,
        );
      }
    }
  }
  return out;
}

/** One entry of `GET {base}/api/me`'s `hostPages`. */
export interface MeHostPage extends Omit<ResolvedHostPage, "brands"> {
  brands?: string[];
  /**
   * For a `deployment` page, and for every page with no `sites`: whether the caller's
   * `*` grant reaches `role`, computed here because the client cannot read the grant
   * (`UserActor.role` is `viewer` for a person with no `*` row). Absent on a `site`
   * page, where `me.sites` carries the effective role per scope.
   */
  allowed?: boolean;
}

/**
 * `/me`'s `hostPages` (decision 13): undefined when none are declared, so a host
 * without `admin` answers a byte-identical `/me`.
 */
export function meHostPages(
  pages: readonly ResolvedHostPage[],
  actor: Actor | null,
  hasSites: boolean,
): MeHostPage[] | undefined {
  if (pages.length === 0) return undefined;
  const star =
    actor?.kind === "user"
      ? actor.grants
        ? (actor.grants[ALL_SCOPES] ?? null)
        : actor.role
      : null;
  return pages.map((page) => {
    const { brands, ...rest } = page;
    const allowed =
      hasSites && page.scope === "site" ? undefined : star !== null && atLeast(star, page.role);
    return {
      ...rest,
      ...(brands ? { brands: [...brands] } : {}),
      ...(allowed === undefined ? {} : { allowed }),
    };
  });
}
