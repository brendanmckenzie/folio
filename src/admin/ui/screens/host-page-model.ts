/**
 * What a framed host page's admin screen decides, as pure functions
 * (`platform/admin-extensions.md` decisions 8 and 9). `HostPage.tsx` is the iframe, the
 * listeners and the timers; every branch it takes is one of these, because the joint
 * history of an iframe cannot be mounted in a test and a function can.
 *
 * **The admin mirrors the frame, it never pushes for it.** A navigation inside the frame
 * has already added an entry to the browser's joint session history, so a second `pushState`
 * from the admin would make Back need two presses. `mirror` turns the frame's location into
 * the admin URL to `replaceState` to, and everything else here keeps that loop from
 * reloading the frame it is mirroring.
 */
import type { MeHostPage } from "../../../server/admin-config";
import { underPagePath } from "../../../core/host-page";
import type { MeScope } from "../../../server/auth/me-sites";
import { atLeast } from "../../../server/auth/roles";

export type HostPageRef = Pick<MeHostPage, "id" | "path" | "scope">;

const SCOPE_PARAM = "folio_scope";
/** Only used to resolve a path: the origin plays no part in any decision here. */
const PLACEHOLDER = "http://folio.invalid";

const safeDecode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * A path with every segment decoded and re-encoded with `encodeURIComponent`, which is
 * the one spelling the admin route uses (`route.ts`'s `rest`). A browser's `pathname`
 * keeps `a@b` where the admin writes `a%40b`; the two name one resource, and comparing them
 * as text would reload a frame that is already where it should be.
 */
export function canonicalPath(pathname: string): string {
  const lead = pathname.startsWith("/") ? "/" : "";
  return (
    lead +
    pathname
      .split("/")
      .filter(Boolean)
      .map((s) => encodeURIComponent(safeDecode(s)))
      .join("/")
  );
}

/** A query as a record, last value winning (the router's own rule), without `folio_scope`. */
function queryOf(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (key !== SCOPE_PARAM) out[key] = value;
  }
  return out;
}

const searchOf = (query: Readonly<Record<string, string>>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== "") params.append(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
};

/**
 * The frame's first URL, or null when it would leave the page (`..` in `rest` resolves
 * to a path that no longer starts with the page's own, and the screen is then `missing`).
 *
 * `rest` is the route's: encoded segments, joined. A `site` page under a scoped mount
 * gets `folio_scope`, which is how its host route learns the scope (decision 8, layer 1).
 */
export function framedSrc(
  page: HostPageRef & { path: string },
  rest: string,
  query: Readonly<Record<string, string>>,
  scope: string | null,
): string | null {
  const q: Record<string, string> = { ...query };
  delete q[SCOPE_PARAM];
  if (page.scope === "site" && scope !== null) q[SCOPE_PARAM] = scope;
  const src = `${page.path}${rest ? `/${rest}` : ""}${searchOf(q)}`;
  let url: URL;
  try {
    url = new URL(src, PLACEHOLDER);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER || !underPagePath(url.pathname, page.path)) return null;
  return src;
}

/** Which declared page a path is under, and what is left of it. `null` under none. */
export function hostScreenOf(
  pathAndQuery: string,
  pages: readonly HostPageRef[],
): { id: string; rest: string; query: Record<string, string> } | null {
  let url: URL;
  try {
    url = new URL(pathAndQuery, PLACEHOLDER);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER) return null;
  const page = pages.find((p) => underPagePath(url.pathname, p.path));
  if (!page) return null;
  const rest = canonicalPath(url.pathname.slice(page.path.length)).replace(/^\//, "");
  return { id: page.id, rest, query: queryOf(url.search) };
}

export type Mirror =
  /** `about:blank`, `blob:`, `data:` or another origin: nothing to mirror, never promoted. */
  | { kind: "ignore" }
  /** The sign-in page: promote to it with `next` set to this screen's admin URL. */
  | { kind: "login"; url: string }
  /** Under no declared page (a Folio document, an undeclared page): the top window goes there. */
  | { kind: "promote"; url: string }
  /** Under a declared page: `replaceState` the admin to this screen. */
  | { kind: "replace"; id: string; rest: string; query: Record<string, string> };

/**
 * Decision 8, rules 3 and 5: what to do with the frame's location after a load or an
 * announced `path`. A location is promoted to the top window only when it is `http:` or
 * `https:` on the admin origin under no declared page path, so host content can never turn
 * the admin into an open redirect.
 *
 * `adminUrl` is the admin URL of the screen now showing, for `{base}/login`'s `next`.
 */
export function mirror(
  location: string,
  pages: readonly HostPageRef[],
  ctx: { adminOrigin: string; base: string; adminUrl: string },
): Mirror {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return { kind: "ignore" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "ignore" };
  if (url.origin !== ctx.adminOrigin) return { kind: "ignore" };
  const login = `${ctx.base}/login`;
  if (url.pathname === login || url.pathname.startsWith(`${login}/`)) {
    return { kind: "login", url: `${login}?next=${encodeURIComponent(ctx.adminUrl)}` };
  }
  const screen = hostScreenOf(`${url.pathname}${url.search}`, pages);
  if (screen) return { kind: "replace", ...screen };
  return { kind: "promote", url: `${url.pathname}${url.search}${url.hash}` };
}

/**
 * Decision 8, layer 3: a `site` page's location with no `folio_scope`, under a scoped
 * mount, is healed by replacing the frame's location with the scope appended (one extra
 * load, no history entry, and it replaces the `403` `requireEditor` answered). Null when
 * nothing needs healing.
 */
export function needsScopeHeal(
  page: HostPageRef,
  location: string,
  mountScope: string | null,
): string | null {
  if (page.scope !== "site" || mountScope === null) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (!underPagePath(url.pathname, page.path) || url.searchParams.has(SCOPE_PARAM)) return null;
  url.searchParams.set(SCOPE_PARAM, mountScope);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Whether two frame locations are the same place, **with `folio_scope` removed from both**
 * and paths compared as the admin spells them. A Back that traversed a frame entry has
 * already moved the frame, so the computed `src` equals its location and nothing reloads.
 */
export function sameFrameLocation(a: string, b: string): boolean {
  // A relative location (the admin's computed `src`) is resolved against the other's
  // origin; two absolute ones on different origins are different places.
  const origin = (value: string) => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const base = origin(a) ?? origin(b) ?? PLACEHOLDER;
  let x: URL;
  let y: URL;
  try {
    x = new URL(a, base);
    y = new URL(b, base);
  } catch {
    return false;
  }
  if (x.origin !== y.origin) return false;
  if (canonicalPath(x.pathname) !== canonicalPath(y.pathname)) return false;
  return searchOf(queryOf(x.search)) === searchOf(queryOf(y.search));
}

/**
 * The admin's own `popstate` landing on a host screen: replace the frame only when the
 * computed `src` differs from where the frame already is. `location.replace` adds no entry.
 */
export function shouldReplaceFrame(wanted: string, current: string): boolean {
  return !sameFrameLocation(wanted, current);
}

/**
 * Decision 8, rule 6: a frame whose location cannot be read. On the **first** load after the
 * admin set a same-origin `src` the browser refused it (`X-Frame-Options`, or a
 * `frame-ancestors` that excludes the admin; Chromium still fires `load`). On any later load
 * the frame navigated cross-origin, which is never promoted.
 */
export function classifyUnreadable(firstLoad: boolean): "refused" | "left" {
  return firstLoad ? "refused" : "left";
}

/**
 * The scopes the site chooser offers for a `site` page opened at the bare mount: the caller's
 * role on each reaches the page's `role`, and its brand the page's `brands`
 * (`{base}/host/<id>/…` with `sites`, decision 8).
 */
export function chooserScopes(
  scopes: readonly MeScope[],
  page: Pick<MeHostPage, "role" | "brands">,
): MeScope[] {
  return scopes.filter(
    (scope) =>
      // `shared` is a scope of content, not a site a shop can be per.
      scope.kind !== "shared" &&
      atLeast(scope.role, page.role) &&
      (!page.brands || (scope.brand !== null && page.brands.includes(scope.brand.id))),
  );
}

/** A frame whose first load is this late shows the overlay (decision 10). */
export const SLOW_FRAME_MS = 15_000;
