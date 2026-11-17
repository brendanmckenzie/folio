/**
 * `folio/host`: the browser-side helper for a host page shown inside the admin's frame
 * (`platform/admin-extensions.md` decisions 8 and 9). Browser only, no dependencies, no
 * React. A host page works without it; the helper adds the title and crumbs, a toast, and
 * keeping a `site` page's scope on every request it makes.
 */
import {
  frameRedirectTarget,
  HOST_PAGE_PROTOCOL,
  type HostCrumb,
  type HostPageFrame,
} from "../core/host-page";

export type { HostCrumb };

const SCOPE_PARAM = "folio_scope";
const SCOPE_HEADER = "x-folio-scope";
const storageKey = (id: string) => `folio:scope:${id}`;

/** The scope this tab's page holds, set by `connectHostPage`. */
let held: string | null = null;

/** True inside the admin's frame (or any frame: `announce` posts to same-origin parents only). */
export function framed(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window;
  } catch {
    return false;
  }
}

function post(frame: HostPageFrame): void {
  if (!framed()) return;
  window.parent.postMessage(frame, location.origin);
}

/** Tells the admin the page's title, extra breadcrumbs, or new path. A no-op outside the frame. */
export function announce(a: { title?: string; crumbs?: HostCrumb[]; path?: string }): void {
  post({ folio: "host-page", v: HOST_PAGE_PROTOCOL, type: "announce", ...a });
}

/** Shows `message` in the admin's toast. A no-op outside the frame. */
export function notice(message: string, tone?: "info" | "error"): void {
  post({
    folio: "host-page",
    v: HOST_PAGE_PROTOCOL,
    type: "notice",
    message,
    ...(tone ? { tone } : {}),
  });
}

/** The scope a `site` page holds, or null. */
export function scope(): string | null {
  return held;
}

/** `fetch` init with `x-folio-scope` set when a scope is held. */
export function scoped(init: RequestInit = {}): RequestInit {
  if (held === null) return init;
  const headers = new Headers(init.headers);
  headers.set(SCOPE_HEADER, held);
  return { ...init, headers };
}

export interface ConnectOptions {
  /** Which declared page this is, and its kind (`HostPage.id`, `HostPage.scope`). */
  page: {
    id: string;
    scope?: "deployment" | "site";
    /** `HostPage.path`: what `frame` needs to turn the location into the admin URL's rest. */
    path?: string;
  };
  /** Announce `document.title` and `location` now and on `popstate`. Default true. */
  track?: boolean;
  /** Redirect a top-level visit into the admin's frame. Default false. */
  frame?: boolean;
  /** Folio's basePath, for `frame`. Default `/folio`. */
  base?: string;
}

/** An absolute URL on this origin lacking `folio_scope`, or null for anything else. */
function unscopedSameOrigin(raw: string | null): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, location.href);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.searchParams.has(SCOPE_PARAM)) return null;
  return url;
}

/**
 * Connects this page to the admin. Seeds the held scope (from `folio_scope` in the URL,
 * else this tab's `sessionStorage`, per page id so two tabs on two sites never share it),
 * adds it to every same-origin link and form that lacks it while one is held, announces
 * the title, and, with `frame`, sends a top-level visit into the admin. Returns a
 * disconnect. The `sessionStorage` copy is a convenience for the page's own requests and
 * grants nothing: `requireEditor` re-checks every one.
 *
 * Folio does not patch `history`: a host router calls `announce({ path })` from its own
 * navigation hook, for example in React Router:
 *
 *     useEffect(() => announce({ path: location.pathname + location.search }), [location])
 */
export function connectHostPage(opts: ConnectOptions): () => void {
  const { page } = opts;
  const off: (() => void)[] = [];

  let seeded: string | null = null;
  if (page.scope === "site") {
    const fromUrl = new URLSearchParams(location.search).get(SCOPE_PARAM);
    try {
      if (fromUrl) sessionStorage.setItem(storageKey(page.id), fromUrl);
      seeded = fromUrl ?? sessionStorage.getItem(storageKey(page.id));
    } catch {
      seeded = fromUrl;
    }
  }
  held = seeded;

  if (opts.frame && !framed()) {
    location.replace(
      frameRedirectTarget({
        base: opts.base ?? "/folio",
        page,
        pagePath: page.path,
        pathname: location.pathname,
        search: location.search,
        scope: held,
      }),
    );
  }

  if (held !== null) {
    const onClick = (event: Event) => {
      const a = (event.target as Element | null)?.closest?.("a[href]");
      if (!a || held === null || a.hasAttribute("download")) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      const url = unscopedSameOrigin(href);
      if (!url) return;
      url.searchParams.set(SCOPE_PARAM, held);
      a.setAttribute("href", `${url.pathname}${url.search}${url.hash}`);
    };
    const onSubmit = (event: Event) => {
      const form = event.target as HTMLFormElement | null;
      if (!form || held === null || form.tagName !== "FORM") return;
      const url = unscopedSameOrigin(form.getAttribute("action") ?? location.href);
      if (!url) return;
      if ((form.method || "get").toLowerCase() === "get") {
        const field = document.createElement("input");
        field.type = "hidden";
        field.name = SCOPE_PARAM;
        field.value = held;
        form.appendChild(field);
      } else {
        url.searchParams.set(SCOPE_PARAM, held);
        form.setAttribute("action", `${url.pathname}${url.search}`);
      }
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    off.push(() => document.removeEventListener("click", onClick, true));
    off.push(() => document.removeEventListener("submit", onSubmit, true));
  }

  if (opts.track !== false) {
    const tell = () =>
      announce({ title: document.title, path: `${location.pathname}${location.search}` });
    tell();
    window.addEventListener("popstate", tell);
    off.push(() => window.removeEventListener("popstate", tell));
  }

  return () => {
    for (const fn of off) fn();
    held = null;
  };
}
