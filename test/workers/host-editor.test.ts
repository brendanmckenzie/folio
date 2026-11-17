import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { FolioConfig } from "../../src/server";
import { createFolio, HOST_PAGE_HEADERS, magicLink } from "../../src/server";
import { PLAIN_COOKIE, SECURE_COOKIE } from "../../src/server/auth/cookie";
import type { Grants } from "../../src/server/auth/roles";
import { createSession, revokeSession } from "../../src/server/auth/session";
import { createToken } from "../../src/server/auth/tokens";
import { createUser } from "../../src/server/auth/users";

/**
 * `folio.editor()` and `folio.requireEditor()` (`platform/admin-extensions.md`
 * decisions 1 to 6): a host's own route asking Folio who is signed in. Each case is a
 * way the answer could be too generous, or cost a read it should not.
 */

const ORIGIN = "https://folio.test";
const ADMIN = "https://cms.example";

const page = defineBlock({
  name: "hePage",
  label: "Page",
  summary: "title",
  fields: { title: text({ label: "Title" }) },
  render: () => null,
});

type Bindings = NonNullable<FolioConfig<Cloudflare.Env>["bindings"]>;
const plain: Bindings = (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES });

function folioWith(extra: Partial<FolioConfig<Cloudflare.Env>> = {}, bindings: Bindings = plain) {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    root: "hePage",
    bindings,
    basePath: "/folio",
    auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
    ...extra,
  } as FolioConfig<Cloudflare.Env>);
}

const throwing: Bindings = () => {
  throw new Error("bindings must not be read");
};

async function sessionFor(email: string, grants: Grants | { role: "editor" | "viewer" | "admin" }) {
  const user = await createUser(env.DB, { email, ...("role" in grants ? grants : { grants }) });
  const session = await createSession(env.DB, user.id, { provider: "magic-link" });
  return { user, session, cookie: `${SECURE_COOKIE}=${session.token}` };
}

const req = (url: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request(url, { ...init, headers });

describe("folio.editor() on a single-site deployment", () => {
  it("answers null for a request with no credential and never reads bindings", async () => {
    const folio = folioWith({}, throwing);
    expect(await folio.editor(req(`${ORIGIN}/admin/orders`), env)).toBeNull();
  });

  it("answers the projected user for a valid session", async () => {
    const { user, cookie } = await sessionFor("he-ann@example.com", { role: "editor" });
    const got = await folioWith().editor(req(`${ORIGIN}/admin/orders`, { cookie }), env);
    expect(got).toMatchObject({
      kind: "user",
      user: { id: user.id, email: "he-ann@example.com" },
      role: "editor",
      grants: { "*": "editor" },
      scope: null,
      brand: null,
      session: { provider: "magic-link" },
    });
    expect(JSON.stringify(got)).not.toContain("colour");
    expect(JSON.stringify(got)).not.toContain("roleFrom");
  });

  it("carries no session hash", async () => {
    const { session, cookie } = await sessionFor("he-hash@example.com", { role: "editor" });
    const got = await folioWith().editor(req(`${ORIGIN}/x`, { cookie }), env);
    const json = JSON.stringify(got);
    expect(json).not.toContain(session.token);
    expect(json).not.toContain(session.id);
  });

  it("answers null for a revoked session", async () => {
    const { session, cookie } = await sessionFor("he-rev@example.com", { role: "editor" });
    await revokeSession(env.DB, session.token);
    expect(await folioWith().editor(req(`${ORIGIN}/x`, { cookie }), env)).toBeNull();
  });

  it("answers null for a token unless tokens is set, and then the token's scopes", async () => {
    const { token } = await createToken(env.DB, { name: "he-tok", scopes: ["content:read"] });
    const authorization = `Bearer ${token}`;
    const folio = folioWith();
    expect(await folio.editor(req(`${ORIGIN}/x`, { authorization }), env)).toBeNull();
    const got = await folio.editor(req(`${ORIGIN}/x`, { authorization }), env, { tokens: true });
    expect(got).toMatchObject({
      kind: "token",
      token: { name: "he-tok" },
      scopes: ["content:read"],
      site: null,
      role: null,
    });
  });

  it("refuses an unsafe method from another origin and admits the admin's own", async () => {
    const { cookie } = await sessionFor("he-csrf@example.com", { role: "editor" });
    const folio = folioWith();
    const evil = req(
      `${ORIGIN}/admin/orders`,
      { cookie, origin: "https://evil.example" },
      { method: "POST" },
    );
    expect(await folio.editor(evil, env)).toBeNull();
    const own = req(`${ORIGIN}/admin/orders`, { cookie, origin: ORIGIN }, { method: "POST" });
    expect(await folio.editor(own, env)).toMatchObject({ kind: "user" });
  });

  it("answers null under auth: 'open'", async () => {
    const { cookie } = await sessionFor("he-open@example.com", { role: "admin" });
    const folio = folioWith({ auth: "open" });
    expect(await folio.editor(req(`${ORIGIN}/x`, { cookie }), env)).toBeNull();
  });

  it("reads once for two calls on the same Request, on a D1 session", async () => {
    const { cookie } = await sessionFor("he-memo@example.com", { role: "editor" });
    let prepares = 0;
    let sessions = 0;
    const watched = (real: D1Database): D1Database => {
      const watch = <T extends object>(target: T): T =>
        new Proxy(target, {
          get(t, prop, receiver) {
            const value = Reflect.get(t, prop, receiver);
            if (prop === "prepare") {
              return (...a: unknown[]) => {
                prepares++;
                return (value as (...x: unknown[]) => unknown).apply(t, a);
              };
            }
            if (prop === "withSession") {
              return (...a: unknown[]) => {
                sessions++;
                return watch((value as (...x: unknown[]) => object).apply(t, a));
              };
            }
            return value;
          },
        });
      return watch(real);
    };
    const folio = folioWith({}, (e) => ({ ...plain(e), db: watched(e.DB) }));
    const one = req(`${ORIGIN}/admin/orders`, { cookie });
    const first = await folio.editor(one, env);
    const after = prepares;
    expect(first).not.toBeNull();
    expect(after).toBeGreaterThan(0);
    expect(sessions).toBe(1);
    expect(await folio.editor(one, env)).toEqual(first);
    expect(prepares).toBe(after);
    // A second Request is a second read.
    await folio.editor(req(`${ORIGIN}/admin/orders`, { cookie }), env);
    expect(prepares).toBeGreaterThan(after);
  });

  it("never shares a memoised answer between two instances", async () => {
    const { cookie } = await sessionFor("he-two@example.com", { role: "editor" });
    const a = folioWith();
    const b = folioWith({ auth: "open" });
    const one = req(`${ORIGIN}/x`, { cookie });
    expect(await a.editor(one, env)).not.toBeNull();
    expect(await b.editor(one, env)).toBeNull();
  });
});

describe("folio.requireEditor()", () => {
  it("redirects a GET with no editor to sign-in with next", async () => {
    const folio = folioWith();
    const res = (await folio.requireEditor(
      req(`${ORIGIN}/admin/orders?tab=1`),
      env,
      {},
    )) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/folio/login?next=%2Fadmin%2Forders%3Ftab%3D1");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 401 for any other method", async () => {
    const res = (await folioWith().requireEditor(
      req(`${ORIGIN}/admin/orders`, {}, { method: "POST" }),
      env,
      {},
    )) as Response;
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Sign in to Folio first.");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 403 below the role, naming it", async () => {
    const { cookie } = await sessionFor("he-view@example.com", { role: "viewer" });
    const res = (await folioWith().requireEditor(req(`${ORIGIN}/x`, { cookie }), env, {
      role: "publisher",
    })) as Response;
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Your role (viewer) may not do that; publisher is required.");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("admits at or above the role, with the host page headers", async () => {
    const { cookie } = await sessionFor("he-pub@example.com", { role: "admin" });
    const got = await folioWith().requireEditor(req(`${ORIGIN}/x`, { cookie }), env, {
      role: "publisher",
    });
    expect(got).not.toBeInstanceOf(Response);
    const { editor, headers } = got as Exclude<typeof got, Response>;
    expect(editor.kind).toBe("user");
    expect(headers).toEqual({ ...HOST_PAGE_HEADERS });
    expect(headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(headers["cache-control"]).toBe("private, no-store");
  });

  it("refuses a token when a role is required, because a role has no token equivalent", async () => {
    const { token } = await createToken(env.DB, { name: "he-role-tok", scopes: ["content:read"] });
    const res = (await folioWith().requireEditor(
      req(`${ORIGIN}/x`, { authorization: `Bearer ${token}` }),
      env,
      { tokens: true, role: "viewer" },
    )) as Response;
    expect(res.status).toBe(403);
  });
});

describe("folio.signInUrl()", () => {
  it("is {base}/login with the path and query as next, or the one given", () => {
    const folio = folioWith();
    expect(folio.signInUrl(req(`${ORIGIN}/a/b?c=d`))).toBe("/folio/login?next=%2Fa%2Fb%3Fc%3Dd");
    expect(folio.signInUrl(req(`${ORIGIN}/a`), "/z")).toBe("/folio/login?next=%2Fz");
  });
});

describe("folio.originAllowed()", () => {
  it("is the CSRF Origin check", async () => {
    const { cookie } = await sessionFor("he-oa@example.com", { role: "editor" });
    const folio = folioWith();
    const post = (origin: string) =>
      folio.originAllowed(req(`${ORIGIN}/x`, { cookie, origin }, { method: "POST" }));
    expect(post(ORIGIN)).toBe(true);
    expect(post("https://evil.example")).toBe(false);
    expect(folio.originAllowed(req(`${ORIGIN}/x`, { cookie }, { method: "POST" }))).toBe(true);
  });
});

describe("folio.editor() on a deployment with sites", () => {
  const folio = folioWith({
    sites: { admin: ADMIN },
    route: (p, _locale, site) =>
      site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : `/${p}`,
  });
  const on = (cookie: string, path = "/admin/orders") => req(`${ADMIN}${path}`, { cookie });

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
           ('harbour', 'group', 'Harbour', null, null, null, 0, 0),
           ('alpha', 'site', 'Alpha', 'harbour', 'live', 'https://preview.alpha.example', 0, 0)`,
      ),
      env.DB.prepare(`insert into site_hosts (host, site_id) values ('alpha.example', 'alpha')`),
    ]);
  });

  it("computes the role on the scope and refuses the * grant for a person with none", async () => {
    const { cookie } = await sessionFor("he-grp@example.com", { harbour: "editor" });
    const scoped = await folio.editor(on(cookie), env, { scope: "alpha" });
    expect(scoped).toMatchObject({ role: "editor", scope: "alpha", brand: null });
    const bare = await folio.editor(on(cookie), env);
    expect(bare).toMatchObject({ role: null, scope: null, grants: { harbour: "editor" } });
  });

  it("answers null off the admin origin", async () => {
    const { cookie } = await sessionFor("he-live@example.com", { "*": "admin" });
    const live = req("https://alpha.example/admin/orders", { cookie });
    expect(await folio.editor(live, env, { scope: "alpha" })).toBeNull();
  });

  it("gives a * admin no role on a scope the registry does not serve", async () => {
    const { cookie } = await sessionFor("he-ghost@example.com", { "*": "admin" });
    for (const scope of ["ghost", "Not A Site!"]) {
      const got = await folio.editor(on(cookie), env, { scope });
      expect(got).toMatchObject({ kind: "user", role: null, brand: null, scope });
    }
    const gate = (await folio.requireEditor(on(cookie), env, {
      scope: "ghost",
      role: "viewer",
    })) as Response;
    expect(gate.status).toBe(403);
  });

  it("gives an unbound token no scopes on an unserved scope, and its scopes on a served one", async () => {
    const { token } = await createToken(env.DB, { name: "he-unbound", scopes: ["content:read"] });
    const authorization = `Bearer ${token}`;
    const bad = await folio.editor(req(`${ADMIN}/x`, { authorization }), env, {
      tokens: true,
      scope: "ghost",
    });
    expect(bad).toMatchObject({ kind: "token", scopes: [] });
    const ok = await folio.editor(req(`${ADMIN}/x`, { authorization }), env, {
      tokens: true,
      scope: "alpha",
    });
    expect(ok).toMatchObject({ kind: "token", scopes: ["content:read"] });
  });

  it("gives a token bound to a site no scopes with no scope named", async () => {
    const { token } = await createToken(env.DB, {
      name: "he-bound",
      scopes: ["content:read", "content:write"],
      site: "alpha",
    });
    const got = await folio.editor(req(`${ADMIN}/x`, { authorization: `Bearer ${token}` }), env, {
      tokens: true,
    });
    expect(got).toMatchObject({ kind: "token", site: "alpha", scopes: [] });
  });

  it("redirects to sign-in on the admin origin", async () => {
    const res = (await folio.requireEditor(req(`${ADMIN}/admin/orders`), env, {})) as Response;
    expect(res.headers.get("location")).toBe(`${ADMIN}/folio/login?next=%2Fadmin%2Forders`);
  });
});

describe("the plain cookie name", () => {
  it("is read over http too", async () => {
    const user = await createUser(env.DB, { email: "he-plain@example.com", role: "editor" });
    const session = await createSession(env.DB, user.id);
    const got = await folioWith().editor(
      req("http://localhost:5199/x", { cookie: `${PLAIN_COOKIE}=${session.token}` }),
      env,
    );
    expect(got).toMatchObject({ kind: "user" });
  });
});
