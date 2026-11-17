/**
 * The signed-in editor, for a host's own routes (`platform/admin-extensions.md`
 * decisions 1 to 6): `folio.editor()` answers who is asking and `folio.requireEditor()`
 * turns that into the one-line gate a host route writes.
 *
 * **A plain projection, never the `Actor`.** `Actor` carries the session hash, is a
 * three-way union that includes the preview grant (which must never reach a host route),
 * and its `role` means "effective on the request's scope" only after `scopedActor` has
 * run, which a host route never gets. `editorOf` is the one place a host-facing value is
 * built, and it omits `session.id`, `colour` and `roleFrom` the way `/me` does.
 *
 * **One credential read per request, on a D1 session, none without a credential.** The
 * raw resolution is memoised per `Request` in a `WeakMap` created by `createEditorGate`,
 * which `createFolio` calls once per instance: module scope would let two Folio instances
 * in one isolate answer each other's resolution.
 */
import type { Registry } from "../core/sites";
import { ALL_SCOPES, chain } from "../core/sites";
import { type Credential, credentialOf, originAllowed, resolveActor } from "./auth/resolve";
import {
  type Actor,
  atLeast,
  effectiveRole,
  type Grants,
  type Role,
  type Scope,
  tokenScopesOn,
} from "./auth/roles";
import { readBookmark, sessionFor } from "./db";
import type { FolioRuntime } from "./runtime";
import type { BrandRef, FolioConfig } from "./types";

export interface FolioEditorOptions {
  /**
   * The scope the role is computed on, on a deployment with `sites`: a site, a
   * group or `shared` id. Absent is the `*` grant (the deployment-wide role).
   * Ignored with no `sites`, where every grant is on `*`.
   */
  scope?: string;
  /** Accept an API token (`Authorization: Bearer folio_…`) as well as a session. Default false. */
  tokens?: boolean;
}

export interface FolioEditorUser {
  kind: "user";
  user: { id: string; name: string; email: string | null };
  /** The effective role on `scope` (or the `*` grant without one). Null: no grant reaches it. */
  role: Role | null;
  /** Every grant the person holds, by scope id, `*` included. `{ "*": role }` with no `sites`. */
  grants: Readonly<Record<string, Role>>;
  /** The scope `role` was computed on; null for the `*` grant. */
  scope: string | null;
  /** The scope's brand on a deployment with `brands`; null otherwise. */
  brand: BrandRef | null;
  /** Which provider minted this browser's session, and when it expires (epoch ms). */
  session: { provider: string | null; expiresAt: number };
}

export interface FolioEditorToken {
  kind: "token";
  token: { id: string; name: string };
  /** What the token's scopes are worth on `scope` (`tokenScopesOn`). Empty when its binding does not reach it. */
  scopes: readonly Scope[];
  /** The scope the token is bound to, or null for an unbound token. */
  site: string | null;
  role: null;
  scope: string | null;
  brand: BrandRef | null;
}

export type FolioEditor = FolioEditorUser | FolioEditorToken;

/**
 * Sent with every `requireEditor` admission (decision 12a). `frame-ancestors 'self'`
 * matters beyond the cross-site case: `SameSite=Lax` sends the session cookie to a frame
 * embedded by a same-site sibling, so without it a sibling page could clickjack a host
 * page. A host that sets its own CSP merges the directive.
 */
export const HOST_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": "frame-ancestors 'self'",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
});

type RuntimeFor = Pick<FolioRuntime, "brands" | "forScope">;

/**
 * The projection (decision 3). `registry` is read by the caller only when `scope` names
 * one on a deployment with `sites`; with `scope` null the `*` grant is the answer.
 *
 * **A scope is checked against the registry before any role is computed**, because
 * `effectiveRole` cannot be asked about an unknown scope: `writersOf` always appends `*`,
 * so it would answer the `*` grant for any id at all, and `tokenScopesOn` answers an
 * unbound token's every scope whatever the id. A scope Folio does not serve (a typo, a
 * deleted site, `shared` with no shared scope, a row of no configured brand) answers
 * `role: null`, `scopes: []`, `brand: null`, and does not throw: the value usually comes
 * from a URL parameter, and a throw would turn a typo into a 500.
 */
export function editorOf(
  actor: Actor,
  registry: Registry | null,
  scope: string | null,
  rt: RuntimeFor,
): FolioEditor | null {
  if (actor.kind === "grant") return null;
  const served = scope !== null && registry !== null && chain(registry, scope).length > 0;
  const forScope = served ? rt.forScope(registry, scope) : null;
  // A scope the registry holds but no brand claims serves nothing (`CLAUDE.md`, "A null
  // brand serves nothing"). With no `brands`, `forScope` answers the one brand.
  const usable = served && forScope !== null;
  const brand = usable ? forScope.brand : null;

  if (actor.kind === "user") {
    const grants: Grants = actor.grants ?? { [ALL_SCOPES]: actor.role };
    let role: Role | null;
    if (scope === null) role = grants[ALL_SCOPES] ?? null;
    else role = usable ? effectiveRole(grants, registry, scope) : null;
    return {
      kind: "user",
      user: { id: actor.id, name: actor.name, email: actor.email ?? null },
      role,
      grants: { ...grants },
      scope,
      brand,
      session: { provider: actor.provider ?? null, expiresAt: actor.expiresAt },
    };
  }

  const bound = actor.site ?? null;
  let scopes: readonly Scope[];
  if (scope === null) scopes = bound === null ? [...actor.scopes] : [];
  else scopes = usable ? (tokenScopesOn(actor.scopes, bound, registry, scope) ?? []) : [];
  return {
    kind: "token",
    token: { id: actor.id, name: actor.name },
    scopes,
    site: bound,
    role: null,
    scope,
    brand,
  };
}

/** Where `requireEditor` sends a visitor with no editor: `{base}/login?next=<path+query>`. */
export function signInUrlFor(
  rt: Pick<FolioRuntime, "base" | "sites">,
  req: Request,
  next?: string,
): string {
  const url = new URL(req.url);
  const back = next ?? `${url.pathname}${url.search}`;
  const path = `${rt.base}/login?next=${encodeURIComponent(back)}`;
  return rt.sites ? `${rt.sites.admin}${path}` : path;
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
      ...headers,
    },
  });
}

export interface RequireEditorOptions extends FolioEditorOptions {
  /** The minimum effective role. Absent admits any role, including none on a token. */
  role?: Role;
}

export interface EditorGate<Env> {
  editor: (req: Request, env: Env, opts?: FolioEditorOptions) => Promise<FolioEditor | null>;
  requireEditor: (
    req: Request,
    env: Env,
    opts?: RequireEditorOptions,
  ) => Promise<{ editor: FolioEditor; headers: Record<string, string> } | Response>;
  signInUrl: (req: Request, next?: string) => string;
  originAllowed: (req: Request) => boolean;
}

/**
 * Builds the four host-facing methods over one runtime. Called once per `createFolio`,
 * so the memo below belongs to the instance.
 */
export function createEditorGate<Env>(
  config: Pick<FolioConfig<Env>, "bindings">,
  rt: FolioRuntime,
): EditorGate<Env> {
  // Two maps, not one: the same Request asked with and without `tokens` is two answers.
  const sessions = new WeakMap<Request, Promise<Actor | null>>();
  const withTokens = new WeakMap<Request, Promise<Actor | null>>();

  const credentialFor = (req: Request, tokens: boolean): Credential | null => {
    const credential = credentialOf(req);
    const usable = credential.cookie !== null || (tokens && credential.bearer !== null);
    return usable ? { ...credential, bearer: tokens ? credential.bearer : null } : null;
  };

  const actorFor = (req: Request, env: Env, credential: Credential, tokens: boolean) => {
    const memo = tokens ? withTokens : sessions;
    let pending = memo.get(req);
    if (!pending) {
      pending = resolveActor(
        () =>
          sessionFor(config.bindings(env).db, {
            bookmark: readBookmark(req.headers.get("cookie")),
          }),
        rt.auth,
        credential,
      );
      memo.set(req, pending);
    }
    return pending;
  };

  const editor: EditorGate<Env>["editor"] = async (req, env, opts = {}) => {
    // Under `auth: 'open'` there are no users to resolve, and a synthetic admin would
    // make a host's screens public on a deployment that forgot `auth` (decision 6).
    if (rt.auth.mode !== "session") return null;
    // Cookies ignore ports, so a session cookie leaks from the admin port to a live
    // host's port in development (decision 4): only the admin origin answers.
    if (rt.sites && new URL(req.url).origin !== rt.sites.admin) return null;
    const tokens = opts.tokens === true;
    const credential = credentialFor(req, tokens);
    if (!credential) return null;
    if (!originAllowed(req, credential)) return null;
    const actor = await actorFor(req, env, credential, tokens);
    if (!actor) return null;
    const scope = rt.sites && opts.scope !== undefined ? opts.scope : null;
    const registry = scope !== null && rt.sites ? await rt.sites.registry(env) : null;
    return editorOf(actor, registry, scope, rt);
  };

  const signInUrl: EditorGate<Env>["signInUrl"] = (req, next) => signInUrlFor(rt, req, next);

  const requireEditor: EditorGate<Env>["requireEditor"] = async (req, env, opts = {}) => {
    const found = await editor(req, env, opts);
    if (!found) {
      const method = req.method.toUpperCase();
      if (method === "GET" || method === "HEAD") {
        return new Response(null, {
          status: 302,
          headers: { location: signInUrl(req), "cache-control": "private, no-store" },
        });
      }
      return text(401, "Sign in to Folio first.");
    }
    if (opts.role !== undefined && (found.role === null || !atLeast(found.role, opts.role))) {
      return text(
        403,
        `Your role (${found.role ?? "none"}) may not do that; ${opts.role} is required.`,
      );
    }
    return { editor: found, headers: { ...HOST_PAGE_HEADERS } };
  };

  return {
    editor,
    requireEditor,
    signInUrl,
    originAllowed: (req) => originAllowed(req, credentialOf(req)),
  };
}
