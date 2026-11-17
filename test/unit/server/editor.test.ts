import { describe, expect, it } from "vitest";
import type { Registry } from "../../../src/core/sites";
import type { Actor, UserActor } from "../../../src/server/auth/roles";
import { editorOf, signInUrlFor } from "../../../src/server/editor";

/**
 * `editorOf` is the projection and the served-scope rule of
 * `platform/admin-extensions.md` decision 3. The registry has a brand split so
 * the "no configured brand serves nothing" rule is exercised without a database.
 */

const registry: Registry = {
  shared: false,
  groups: [{ id: "harbour", name: "Harbour", brand: "a" }],
  sites: [
    {
      id: "alpha",
      name: "Alpha",
      group: "harbour",
      status: "live",
      hosts: [],
      preview: null,
      brand: "a",
    },
    {
      id: "bravo",
      name: "Bravo",
      group: null,
      status: "live",
      hosts: [],
      preview: null,
      brand: "b",
    },
    {
      id: "orphan",
      name: "Orphan",
      group: null,
      status: "live",
      hosts: [],
      preview: null,
      brand: null,
    },
  ],
};

const rt = {
  brands: new Map(),
  forScope: (reg: Registry, scope: string | null) => {
    if (scope === null) return null;
    const row = [...reg.sites, ...reg.groups].find((r) => r.id === scope);
    if (!row?.brand) return null;
    return { brand: { id: row.brand, label: `Brand ${row.brand}` } };
  },
} as unknown as Parameters<typeof editorOf>[3];

const user = (grants: UserActor["grants"], extra: Partial<UserActor> = {}): UserActor => ({
  kind: "user",
  id: "u1",
  name: "Ann",
  colour: "#123456",
  role: "viewer",
  session: "hash-of-the-cookie",
  expiresAt: 99,
  email: "ann@example.com",
  roleFrom: "oidc",
  grants,
  ...extra,
});

describe("editorOf, a user", () => {
  it("projects id, name, email, grants and the session's provider and expiry only", () => {
    const got = editorOf(user({ "*": "editor" }, { provider: "oidc" }), null, null, rt);
    expect(got).toEqual({
      kind: "user",
      user: { id: "u1", name: "Ann", email: "ann@example.com" },
      role: "editor",
      grants: { "*": "editor" },
      scope: null,
      brand: null,
      session: { provider: "oidc", expiresAt: 99 },
    });
    const json = JSON.stringify(got);
    expect(json).not.toContain("hash-of-the-cookie");
    expect(json).not.toContain("#123456");
    expect(json).not.toContain("roleFrom");
  });

  it("reads grants['*'] with no scope, never UserActor.role", () => {
    const got = editorOf(user({ harbour: "editor" }, { role: "viewer" }), null, null, rt);
    expect(got).toMatchObject({ role: null, grants: { harbour: "editor" } });
  });

  it("falls back to the actor's role as the * grant when it holds no grants", () => {
    const got = editorOf(user(undefined, { role: "publisher" }), null, null, rt);
    expect(got).toMatchObject({ role: "publisher", grants: { "*": "publisher" } });
  });

  it("computes the role on a served scope through effectiveRole, and the scope's brand", () => {
    const got = editorOf(user({ harbour: "editor" }), registry, "alpha", rt);
    expect(got).toMatchObject({
      role: "editor",
      scope: "alpha",
      brand: { id: "a", label: "Brand a" },
    });
  });

  it("gives role null, brand null for a scope Folio does not serve, even to a * admin", () => {
    for (const scope of ["ghost", "orphan", "shared", "BAD ID!", ""]) {
      const got = editorOf(user({ "*": "admin" }), registry, scope, rt);
      expect(got).toMatchObject({ kind: "user", role: null, brand: null, scope });
    }
  });

  it("is not fooled by a missing registry on a named scope", () => {
    expect(editorOf(user({ "*": "admin" }), null, "alpha", rt)).toMatchObject({ role: null });
  });

  it("refuses the reach of another brand's group grant", () => {
    const got = editorOf(user({ harbour: "editor" }), registry, "bravo", rt);
    expect(got).toMatchObject({ role: null, brand: { id: "b" } });
  });
});

describe("editorOf, a token", () => {
  const token = (site: string | null): Actor => ({
    kind: "token",
    id: "t1",
    name: "ci",
    scopes: ["content:read", "content:write"],
    site,
  });

  it("projects the token and keeps an unbound token's scopes", () => {
    expect(editorOf(token(null), null, null, rt)).toEqual({
      kind: "token",
      token: { id: "t1", name: "ci" },
      scopes: ["content:read", "content:write"],
      site: null,
      role: null,
      scope: null,
      brand: null,
    });
  });

  it("gives a bound token no scopes with no scope named", () => {
    expect(editorOf(token("alpha"), registry, null, rt)).toMatchObject({
      scopes: [],
      site: "alpha",
    });
  });

  it("gives an unbound token no scopes on an unserved scope", () => {
    for (const scope of ["ghost", "orphan"]) {
      expect(editorOf(token(null), registry, scope, rt)).toMatchObject({ scopes: [], brand: null });
    }
  });

  it("keeps a bound token to its binding, and to reads up the chain", () => {
    expect(editorOf(token("alpha"), registry, "alpha", rt)).toMatchObject({
      scopes: ["content:read", "content:write"],
    });
    // `content:write` implies the draft read, so a read up the chain keeps both reads.
    expect(editorOf(token("alpha"), registry, "harbour", rt)).toMatchObject({
      scopes: ["content:read", "content:read:draft"],
    });
    expect(editorOf(token("alpha"), registry, "bravo", rt)).toMatchObject({ scopes: [] });
  });
});

describe("editorOf, a preview grant", () => {
  it("is never an editor", () => {
    const grant: Actor = {
      kind: "grant",
      id: "g",
      userId: "u",
      tokenId: null,
      name: "x",
      site: "alpha",
      expiresAt: 1,
    };
    expect(editorOf(grant, registry, "alpha", rt)).toBeNull();
  });
});

describe("signInUrlFor", () => {
  const req = new Request("https://cms.example/admin/orders?tab=1");
  it("is relative with no sites", () => {
    expect(signInUrlFor({ base: "/folio", sites: null }, req)).toBe(
      "/folio/login?next=%2Fadmin%2Forders%3Ftab%3D1",
    );
  });
  it("is on the admin origin with sites", () => {
    const sites = { admin: "https://cms.example" } as never;
    expect(signInUrlFor({ base: "/folio", sites }, req, "/x")).toBe(
      "https://cms.example/folio/login?next=%2Fx",
    );
  });
});
