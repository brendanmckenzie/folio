import { describe, expect, it } from "vitest";
import { defineBlock, text } from "../../../src/core";
import type { FolioBindings, FolioConfig } from "../../../src/server/types";
import { magicLink } from "../../../src/server/auth/magic-link";
import { meHostPages, validateAdmin } from "../../../src/server/admin-config";
import { createRuntime } from "../../../src/server/runtime";

/**
 * `admin.pages` at construction (`platform/admin-extensions.md` decision 12): one test
 * per refusal in the decision's list, each naming the key.
 */

const ctx = {
  base: "/folio",
  sites: true,
  brandIds: ["a", "b"] as readonly string[] | null,
  mode: "session" as const,
};
const page = (over: Record<string, unknown> = {}) => ({
  id: "orders",
  label: "Orders",
  path: "/admin/orders",
  ...over,
});
const run = (pages: unknown[], c: Partial<typeof ctx> = {}) =>
  validateAdmin({ pages }, { ...ctx, ...c });

describe("validateAdmin", () => {
  it("answers no pages for no admin, and for an empty list", () => {
    expect(validateAdmin(undefined, ctx)).toEqual([]);
    expect(validateAdmin({}, ctx)).toEqual([]);
    expect(validateAdmin({ pages: [] }, { ...ctx, mode: "open" })).toEqual([]);
  });

  it("applies the defaults", () => {
    expect(run([page()])).toEqual([
      {
        id: "orders",
        label: "Orders",
        path: "/admin/orders",
        icon: "window",
        role: "viewer",
        scope: "deployment",
      },
    ]);
  });

  it("keeps every declared key", () => {
    const [got] = run([
      page({ icon: "receipt", role: "editor", group: "Shop", scope: "site", brands: ["a"] }),
    ]);
    expect(got).toMatchObject({
      icon: "receipt",
      role: "editor",
      group: "Shop",
      scope: "site",
      brands: ["a"],
    });
  });

  it.each([
    [{ pages: [], extra: 1 }, /unknown key 'admin.extra'/],
    [{ pages: "x" }, /'admin.pages' must be an array/],
    ["x", /'admin' must be an object/],
  ])("refuses a malformed admin", (admin, message) => {
    expect(() => validateAdmin(admin, ctx)).toThrow(message);
  });

  it("refuses an unknown key on a page", () => {
    expect(() => run([page({ colour: "red" })])).toThrow(/unknown key 'admin.pages\[0\].colour'/);
  });

  it.each(["Orders", "1orders", "or ders", "", "a".repeat(33), "or_ders"])(
    "refuses the id %j",
    (id) => {
      expect(() => run([page({ id })])).toThrow(/admin.pages\[0\].id/);
    },
  );

  it("refuses a duplicate id", () => {
    expect(() => run([page(), page({ path: "/admin/other" })])).toThrow(/declared twice/);
  });

  it.each([
    ["label", ""],
    ["label", "x".repeat(41)],
    ["group", ""],
    ["group", "x".repeat(41)],
  ])("refuses %s %j", (key, value) => {
    expect(() => run([page({ [key]: value })])).toThrow(new RegExp(`admin.pages\\[0\\].${key}`));
  });

  it.each([
    "admin/orders",
    "//evil.example/x",
    "/admin/orders?x=1",
    "/admin/orders#top",
    "/admin/orders/",
    "/",
    "/admin/../orders",
    "/admin/./orders",
    "/admin\\orders",
    "/folio",
    "/folio/orders",
  ])("refuses the path %j", (path) => {
    expect(() => run([page({ path })])).toThrow(/admin.pages\[0\].path/);
  });

  it("allows a path that only shares a prefix with the basePath", () => {
    expect(() => run([page({ path: "/folios" })])).not.toThrow();
  });

  it("refuses nested paths in either order, and the same path twice", () => {
    expect(() => run([page({ id: "all", path: "/admin" }), page({ id: "orders" })])).toThrow(
      /must map to exactly one page/,
    );
    expect(() => run([page({ id: "orders" }), page({ id: "all", path: "/admin" })])).toThrow(
      /must map to exactly one page/,
    );
    expect(() => run([page(), page({ id: "two" })])).toThrow(/must map to exactly one page/);
  });

  it("allows paths that share a name prefix but not a segment", () => {
    expect(() =>
      run([page({ id: "a", path: "/admin/ord" }), page({ id: "b", path: "/admin/orders" })]),
    ).not.toThrow();
  });

  it("refuses an unknown icon and role", () => {
    expect(() => run([page({ icon: "rocket" })])).toThrow(/admin.pages\[0\].icon/);
    expect(() => run([page({ role: "owner" })])).toThrow(/admin.pages\[0\].role/);
  });

  it("refuses scope 'site' without sites, and an unknown scope", () => {
    expect(() => run([page({ scope: "site" })], { sites: false, brandIds: null })).toThrow(
      /scope' is 'site', which needs 'sites'/,
    );
    expect(() => run([page({ scope: "region" })])).toThrow(/admin.pages\[0\].scope/);
  });

  it("refuses brands without brands, on a deployment page, empty, or unconfigured", () => {
    expect(() => run([page({ scope: "site", brands: ["a"] })], { brandIds: null })).toThrow(
      /admin.pages\[0\].brands' needs 'brands'/,
    );
    expect(() => run([page({ brands: ["a"] })])).toThrow(
      /admin.pages\[0\].brands' is set on a 'deployment' page/,
    );
    expect(() => run([page({ scope: "site", brands: [] })])).toThrow(/non-empty/);
    expect(() => run([page({ scope: "site", brands: ["zzz"] })])).toThrow(/'zzz'/);
  });

  it("refuses more than twenty pages", () => {
    const many = Array.from({ length: 21 }, (_, i) => page({ id: `p${i}`, path: `/admin/p${i}` }));
    expect(() => run(many)).toThrow(/at most 20/);
    expect(() => run(many.slice(0, 20))).not.toThrow();
  });

  it("refuses any page under auth: 'open'", () => {
    expect(() => run([page()], { mode: "open" as never })).toThrow(/auth: 'open'/);
  });
});

describe("createRuntime wires admin", () => {
  const root = defineBlock({ name: "p", label: "P", fields: { t: text() }, render: () => null });
  const config = (over: Record<string, unknown>) =>
    ({
      blocks: [root],
      root: "p",
      bindings: () => ({}) as unknown as FolioBindings,
      auth: { providers: [magicLink({ send: () => {} })] },
      logger: { warn: () => {}, error: () => {} },
      ...over,
    }) as unknown as FolioConfig<Record<string, never>>;

  it("exposes the validated pages as rt.hostPages", () => {
    const rt = createRuntime(config({ admin: { pages: [page()] } }));
    expect(rt.hostPages.map((p) => p.id)).toEqual(["orders"]);
    expect(createRuntime(config({})).hostPages).toEqual([]);
  });

  it("throws under auth: 'open', and for a path under basePath", () => {
    expect(() => createRuntime(config({ auth: "open", admin: { pages: [page()] } }))).toThrow(
      /auth: 'open'/,
    );
    expect(() => createRuntime(config({ admin: { pages: [page({ path: "/folio/x" })] } }))).toThrow(
      /own mount/,
    );
  });
});

describe("meHostPages", () => {
  const pages = validateAdmin(
    {
      pages: [
        page({ role: "publisher" }),
        page({ id: "stock", path: "/admin/stock" }),
        page({ id: "shop", path: "/admin/shop", scope: "site", brands: ["a"] }),
      ],
    },
    ctx,
  );
  const user = (grants: Record<string, "viewer" | "editor" | "publisher" | "admin">) =>
    ({
      kind: "user",
      id: "u",
      name: "n",
      colour: "c",
      role: "viewer",
      session: "s",
      expiresAt: 1,
      grants,
    }) as never;

  it("is undefined with no pages", () => {
    expect(meHostPages([], null, true)).toBeUndefined();
  });

  it("computes allowed from the * grant on deployment pages, never from role", () => {
    const got = meHostPages(pages, user({ harbour: "admin" }), true)!;
    expect(got.map((p) => [p.id, p.allowed])).toEqual([
      ["orders", false],
      ["stock", false],
      ["shop", undefined],
    ]);
    const star = meHostPages(pages, user({ "*": "editor" }), true)!;
    expect(star.map((p) => p.allowed)).toEqual([false, true, undefined]);
  });

  it("sets allowed on every page with no sites", () => {
    const plain = validateAdmin({ pages: [page()] }, { ...ctx, sites: false, brandIds: null });
    expect(meHostPages(plain, user({ "*": "viewer" }), false)![0]!.allowed).toBe(true);
  });

  it("allows nothing to a token or nobody", () => {
    expect(meHostPages(pages, null, true)!.map((p) => p.allowed)).toEqual([
      false,
      false,
      undefined,
    ]);
  });

  it("carries brands as a plain array", () => {
    expect(meHostPages(pages, user({ "*": "admin" }), true)![2]!.brands).toEqual(["a"]);
  });
});
