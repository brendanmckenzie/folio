/**
 * Host pages in the admin shell (`platform/admin-extensions.md`, feature 2): the
 * vocabulary shared by the server's config validation, `GET {base}/api/me` and the
 * admin's sidebar. Pure: no D1, no Hono, no React.
 */

/** The icons a host page may name. The admin draws each from its own icon set. */
export const HOST_PAGE_ICONS = [
  "window",
  "receipt",
  "box",
  "tag",
  "stack",
  "percent",
  "people",
  "chart",
] as const;
export type HostPageIcon = (typeof HOST_PAGE_ICONS)[number];

/** `HostPage.id`: the admin route segment, `{mount}/host/<id>`. */
export const HOST_PAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** At most this many pages per deployment. */
export const MAX_HOST_PAGES = 20;

/* ------------------------------------------------------------- the protocol --- */

/**
 * The whole message protocol between a host page and the admin that frames it, version 1
 * (`platform/admin-extensions.md` decision 9).
 *
 * **Not `PROTOCOL_VERSION`.** That number is a private stale-tab guard, cheap to bump
 * because both ends ship in one deploy. A host page is the other end of this protocol and
 * does not ship with Folio, so this is a public contract with its own version: it changes
 * only by adding a `v: 2` the admin accepts beside `v: 1`.
 */
export const HOST_PAGE_PROTOCOL = 1;

export interface HostCrumb {
  text: string;
  href?: string;
}

export type HostPageFrame =
  | {
      folio: "host-page";
      v: 1;
      type: "announce";
      /** The last crumb and the tab title. At most 120 characters. */
      title?: string;
      /**
       * Crumbs after the page's own label, last one current. At most 4, each at most 60
       * characters; `href` a same-origin path under a declared page path, else dropped.
       */
      crumbs?: readonly HostCrumb[];
      /** The frame's path and query after an in-page (`pushState`) navigation. */
      path?: string;
    }
  | {
      folio: "host-page";
      v: 1;
      type: "notice";
      /** Shown in the admin's toast. At most 200 characters. */
      message: string;
      tone?: "info" | "error";
    };

export const HOST_TITLE_MAX = 120;
export const HOST_CRUMBS_MAX = 4;
export const HOST_CRUMB_MAX = 60;
export const HOST_NOTICE_MAX = 200;
const HOST_PATH_MAX = 2000;

/** A frame after screening: every string capped and printable, nothing else carried. */
export type ScreenedHostFrame =
  | { type: "announce"; title?: string; crumbs?: HostCrumb[]; path?: string }
  | { type: "notice"; message: string; tone: "info" | "error" };

export type HostFrameResult =
  | { ok: true; frame: ScreenedHostFrame }
  /** `foreign`: not a host-page frame at all. `version`: one this admin does not speak. */
  | { ok: false; reason: "foreign" | "version" | "malformed"; v?: unknown };

const CONTROL = /[\p{Cc}\u2028\u2029]/u;

/**
 * Trimmed, printable, cut at `max` characters with a trailing `…`; null for anything that
 * is not a usable string (the printable rule `screenOptionLabel` applies to option labels).
 */
export function screenHostText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || CONTROL.test(trimmed)) return null;
  const chars = [...trimmed];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : trimmed;
}

/** Whether `path` is `page` or beneath it, on a segment boundary (`/admin` of `/admin/orders`). */
export function underPagePath(path: string, page: string): boolean {
  if (!path.startsWith(page)) return false;
  const next = path.charAt(page.length);
  return next === "" || next === "/" || next === "?" || next === "#";
}

/** A same-origin path as a browser reads it: one leading `/`, no backslash, no control. */
function sameOriginPath(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length <= HOST_PATH_MAX &&
    raw.startsWith("/") &&
    !raw.startsWith("//") &&
    !raw.includes("\\") &&
    !CONTROL.test(raw)
  );
}

/**
 * Screens one `postMessage` payload. **The origin and source checks are the caller's**
 * (`event.origin === location.origin`, `event.source === iframe.contentWindow`); this pins
 * the shape, the caps, the printable rule and the crumb `href` rule, given the declared
 * `pagePaths`. A crumb whose `href` is not under one of them keeps its text and loses the
 * link.
 */
export function screenHostFrame(data: unknown, pagePaths: readonly string[]): HostFrameResult {
  if (typeof data !== "object" || data === null) return { ok: false, reason: "foreign" };
  const raw = data as Record<string, unknown>;
  if (raw.folio !== "host-page") return { ok: false, reason: "foreign" };
  if (raw.v !== HOST_PAGE_PROTOCOL) return { ok: false, reason: "version", v: raw.v };
  if (raw.type === "notice") {
    const message = screenHostText(raw.message, HOST_NOTICE_MAX);
    if (message === null) return { ok: false, reason: "malformed" };
    return {
      ok: true,
      frame: { type: "notice", message, tone: raw.tone === "error" ? "error" : "info" },
    };
  }
  if (raw.type !== "announce") return { ok: false, reason: "malformed" };
  const frame: Extract<ScreenedHostFrame, { type: "announce" }> = { type: "announce" };
  const title = screenHostText(raw.title, HOST_TITLE_MAX);
  if (title !== null) frame.title = title;
  if (Array.isArray(raw.crumbs)) {
    const crumbs: HostCrumb[] = [];
    for (const item of raw.crumbs.slice(0, HOST_CRUMBS_MAX)) {
      if (typeof item !== "object" || item === null) continue;
      const text = screenHostText((item as Record<string, unknown>).text, HOST_CRUMB_MAX);
      if (text === null) continue;
      const href = (item as Record<string, unknown>).href;
      const linked =
        sameOriginPath(href) && pagePaths.some((p) => underPagePath(href.split(/[?#]/)[0]!, p));
      crumbs.push(linked ? { text, href } : { text });
    }
    if (crumbs.length > 0) frame.crumbs = crumbs;
  }
  if (sameOriginPath(raw.path)) frame.path = raw.path;
  return { ok: true, frame };
}

/* ----------------------------------------------------- top-level redirect --- */

/**
 * Where a host page opened top level goes to land inside the admin's chrome (decision 8's
 * table), for `connectHostPage({ frame: true })`. `pagePath` is the page's declared path,
 * which turns the location into the `rest` the admin route carries.
 *
 * | Page | Scope known | Target |
 * | --- | --- | --- |
 * | no `sites` | n/a | `{base}/host/<id>/<rest>?<query>` |
 * | `deployment` | ignored | the same, at the bare mount |
 * | `site` | yes | `{base}/~<scope>/host/<id>/<rest>?<query>` |
 * | `site` | no | `{base}/host/<id>/<rest>?<query>` (the site chooser) |
 *
 * `folio_scope` is dropped from the query: the admin mount carries it.
 */
export function frameRedirectTarget(input: {
  base: string;
  page: { id: string; scope?: "deployment" | "site" };
  /** The page's declared path (`HostPage.path`). */
  pagePath?: string;
  pathname: string;
  search: string;
  /** `folio_scope` from the URL, else the tab's `sessionStorage`. */
  scope: string | null;
}): string {
  const { base, page, pathname, search } = input;
  let rest = "";
  if (input.pagePath && underPagePath(pathname, input.pagePath)) {
    rest = pathname.slice(input.pagePath.length).replace(/^\//, "");
  }
  const query = new URLSearchParams(search);
  query.delete("folio_scope");
  const qs = query.toString();
  const mount = page.scope === "site" && input.scope ? `${base}/~${input.scope}` : base;
  return `${mount}/host/${page.id}${rest ? `/${rest}` : ""}${qs ? `?${qs}` : ""}`;
}
