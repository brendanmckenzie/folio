import { describe, expect, it } from "vitest";
import {
  announcedFor,
  canonicalPath,
  chooserScopes,
  classifyUnreadable,
  framedSrc,
  hostScreenOf,
  loadedAnnounce,
  mirror,
  needsScopeHeal,
  sameFrameLocation,
  shouldReplaceFrame,
} from "../../../src/admin/ui/screens/host-page-model";
import type { MeScope } from "../../../src/server/auth/me-sites";

/**
 * Every branch the framed host page takes (`platform/admin-extensions.md` decision 8),
 * as a function, because an iframe's joint history cannot be mounted in a test.
 */

const orders = { id: "orders", path: "/admin/orders", scope: "deployment" as const };
const shop = { id: "shop", path: "/admin/shop", scope: "site" as const };
const pages = [orders, shop];
const ctx = {
  adminOrigin: "https://cms.example",
  base: "/folio",
  adminUrl: "/folio/host/orders/1",
};
const at = (path: string) => `https://cms.example${path}`;

describe("framedSrc", () => {
  it("is the page's path, the rest and the query", () => {
    expect(framedSrc(orders, "", {}, null)).toBe("/admin/orders");
    expect(framedSrc(orders, "1042/lines", { tab: "items" }, null)).toBe(
      "/admin/orders/1042/lines?tab=items",
    );
  });

  it("adds folio_scope for a site page under a scoped mount only", () => {
    expect(framedSrc(shop, "1", {}, "alpha")).toBe("/admin/shop/1?folio_scope=alpha");
    expect(framedSrc(shop, "1", {}, null)).toBe("/admin/shop/1");
    expect(framedSrc(orders, "1", {}, "alpha")).toBe("/admin/orders/1");
  });

  it("never carries a folio_scope of the query's own", () => {
    expect(framedSrc(shop, "", { folio_scope: "evil" }, "alpha")).toBe(
      "/admin/shop?folio_scope=alpha",
    );
    expect(framedSrc(orders, "", { folio_scope: "evil" }, null)).toBe("/admin/orders");
  });

  it("refuses a rest that climbs out of the page", () => {
    expect(framedSrc(orders, "../stock", {}, null)).toBeNull();
    expect(framedSrc(orders, "%2e%2e/stock", {}, null)).toBeNull();
    expect(framedSrc(orders, "a/../../b", {}, null)).toBeNull();
    expect(framedSrc(orders, "a/../b", {}, null)).toBe("/admin/orders/a/../b");
  });

  it.each(["a%2Fb", "a%3Fb", "a%23b"])("round-trips an encoded %s as one segment", (segment) => {
    const src = framedSrc(orders, `x/${segment}`, {}, null) as string;
    expect(src).toBe(`/admin/orders/x/${segment}`);
    // The frame's own location parses back to the same screen.
    expect(hostScreenOf(src, pages)).toEqual({ id: "orders", rest: `x/${segment}`, query: {} });
  });
});

describe("hostScreenOf", () => {
  it("finds the page by path prefix on a segment boundary, and keeps the query", () => {
    expect(hostScreenOf("/admin/orders/1042?state=open", pages)).toEqual({
      id: "orders",
      rest: "1042",
      query: { state: "open" },
    });
    expect(hostScreenOf("/admin/orders", pages)).toEqual({ id: "orders", rest: "", query: {} });
    expect(hostScreenOf("/admin/orders-archive", pages)).toBeNull();
    expect(hostScreenOf("/elsewhere", pages)).toBeNull();
  });

  it("drops folio_scope and keeps the last of a repeated key", () => {
    expect(hostScreenOf("/admin/shop?folio_scope=alpha&a=1&a=2", pages)?.query).toEqual({ a: "2" });
  });

  it("refuses a URL that is not a path", () => {
    expect(hostScreenOf("https://evil.example/admin/orders", pages)).toBeNull();
    expect(hostScreenOf("//evil.example/admin/orders", pages)).toBeNull();
  });
});

describe("canonicalPath", () => {
  it("spells a path the way the admin route does", () => {
    expect(canonicalPath("/admin/orders/a@b")).toBe("/admin/orders/a%40b");
    expect(canonicalPath("/admin/orders/a%40b")).toBe("/admin/orders/a%40b");
    expect(canonicalPath("/admin/orders/a%2Fb")).toBe("/admin/orders/a%2Fb");
    expect(canonicalPath("/admin//orders/")).toBe("/admin/orders");
  });
});

describe("mirror", () => {
  it("replaces the admin URL for a location under a page, keeping raw encoded segments", () => {
    expect(mirror(at("/admin/orders/1042/a%2Fb?tab=items&folio_scope=alpha"), pages, ctx)).toEqual({
      kind: "replace",
      id: "orders",
      rest: "1042/a%2Fb",
      query: { tab: "items" },
    });
  });

  it("promotes a location under no declared page, on the admin origin", () => {
    expect(mirror(at("/folio/content?x=1"), pages, ctx)).toEqual({
      kind: "promote",
      url: "/folio/content?x=1",
    });
    expect(mirror(at("/"), pages, ctx)).toEqual({ kind: "promote", url: "/" });
    expect(mirror(at("/admin/other"), pages, ctx)).toMatchObject({ kind: "promote" });
  });

  it("ignores about:blank, blob:, data: and javascript: and never promotes them", () => {
    for (const location of [
      "about:blank",
      "blob:https://cms.example/6f1c",
      "data:text/html,<p>x</p>",
      "javascript:alert(1)",
      "chrome-error://chromewebdata/",
      "not a url",
    ]) {
      expect(mirror(location, pages, ctx)).toEqual({ kind: "ignore" });
    }
  });

  it("ignores another origin", () => {
    expect(mirror("https://evil.example/admin/orders", pages, ctx)).toEqual({ kind: "ignore" });
  });

  it("promotes the sign-in page with next set to this screen's admin URL", () => {
    expect(mirror(at("/folio/login?next=%2Fadmin%2Forders%2F1"), pages, ctx)).toEqual({
      kind: "login",
      url: `/folio/login?next=${encodeURIComponent("/folio/host/orders/1")}`,
    });
    expect(mirror(at("/folio/login/oidc"), pages, ctx)).toMatchObject({ kind: "login" });
  });

  it("does not take a page that merely starts with the login path for the login", () => {
    expect(mirror(at("/folio/loginx"), pages, ctx)).toMatchObject({ kind: "promote" });
  });
});

describe("needsScopeHeal", () => {
  it("appends the mount's scope to a site page's location that lacks one", () => {
    expect(needsScopeHeal(shop, at("/admin/shop/1?tab=a"), "alpha")).toBe(
      "/admin/shop/1?tab=a&folio_scope=alpha",
    );
  });

  it("leaves a location that has one, a deployment page, a bare mount and a foreign path", () => {
    expect(needsScopeHeal(shop, at("/admin/shop/1?folio_scope=alpha"), "alpha")).toBeNull();
    expect(needsScopeHeal(orders, at("/admin/orders"), "alpha")).toBeNull();
    expect(needsScopeHeal(shop, at("/admin/shop"), null)).toBeNull();
    expect(needsScopeHeal(shop, at("/folio/content"), "alpha")).toBeNull();
    expect(needsScopeHeal(shop, "about:blank", "alpha")).toBeNull();
  });
});

describe("the popstate replace decision", () => {
  it("compares with folio_scope removed from both sides", () => {
    expect(sameFrameLocation("/admin/shop/1?folio_scope=alpha", "/admin/shop/1")).toBe(true);
    expect(sameFrameLocation("/admin/shop/1?a=1&folio_scope=alpha", "/admin/shop/1?a=1")).toBe(
      true,
    );
    expect(sameFrameLocation("/admin/shop/1", "/admin/shop/2")).toBe(false);
    expect(sameFrameLocation("/admin/shop/1?a=1", "/admin/shop/1?a=2")).toBe(false);
  });

  it("treats a browser's spelling of a path as the admin's", () => {
    expect(sameFrameLocation("/admin/orders/a%40b", at("/admin/orders/a@b"))).toBe(true);
  });

  it("does not reload after a Back that already moved the frame", () => {
    // The admin's computed src carries folio_scope; the frame's own location may not.
    expect(shouldReplaceFrame("/admin/shop?folio_scope=alpha", at("/admin/shop"))).toBe(false);
  });

  it("replaces when the destination differs", () => {
    expect(shouldReplaceFrame("/admin/shop/2?folio_scope=alpha", at("/admin/shop/1"))).toBe(true);
  });

  it("treats a different origin as different", () => {
    expect(
      sameFrameLocation("https://cms.example/admin/shop", "https://evil.example/admin/shop"),
    ).toBe(false);
  });
});

describe("classifyUnreadable", () => {
  it("is a refusal on the first load and a departure on any later one", () => {
    expect(classifyUnreadable(true)).toBe("refused");
    expect(classifyUnreadable(false)).toBe("left");
  });
});

describe("chooserScopes", () => {
  const scope = (id: string, role: MeScope["role"], brand: string | null, kind = "site") =>
    ({
      id,
      name: id,
      kind,
      group: null,
      role,
      chain: [id],
      status: "live",
      preview: null,
      brand: brand ? { id: brand, label: brand } : null,
    }) as MeScope;
  const scopes = [
    scope("alpha", "editor", "a"),
    scope("bravo", "viewer", "a"),
    scope("charlie", "editor", "b"),
    scope("shared", "admin", null, "shared"),
  ];

  it("lists the scopes whose role reaches the page's", () => {
    expect(chooserScopes(scopes, { role: "editor" }).map((s) => s.id)).toEqual([
      "alpha",
      "charlie",
    ]);
    expect(chooserScopes(scopes, { role: "viewer" }).map((s) => s.id)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("applies the page's brands", () => {
    expect(chooserScopes(scopes, { role: "viewer", brands: ["a"] }).map((s) => s.id)).toEqual([
      "alpha",
      "bravo",
    ]);
  });
});

describe("an announce and the load of the same document (found in the browser pass)", () => {
  const docA = {};
  const docB = {};
  const crumb = { text: "Open orders" };

  it("keeps crumbs and title announced BEFORE load, which is how an inline script posts", () => {
    // 1. the page's script announces during parse; 2. then the iframe fires `load`.
    const announced = { title: "Order #1042", crumbs: [crumb] };
    const after = loadedAnnounce(announced, docA, docA, "Order 1042 (document title)");
    expect(after).toEqual({ title: "Order #1042", crumbs: [crumb] });
  });

  it("falls back to the document title when the page announced crumbs but no title", () => {
    expect(loadedAnnounce({ crumbs: [crumb] }, docA, docA, "From <title>")).toEqual({
      title: "From <title>",
      crumbs: [crumb],
    });
  });

  it("an announce AFTER load keeps what load read, and replaces what it carries", () => {
    const loaded = loadedAnnounce({ crumbs: [] }, undefined, docA, "From <title>");
    expect(loaded).toEqual({ title: "From <title>", crumbs: [] });
    // The announce handler starts from the same document's state.
    expect(announcedFor(loaded, docA, docA)).toBe(loaded);
  });

  it("starts clean for a different document, so one page's crumbs never label the next", () => {
    const announced = { title: "Order #1042", crumbs: [crumb] };
    expect(loadedAnnounce(announced, docA, docB, "Orders")).toEqual({
      title: "Orders",
      crumbs: [],
    });
    expect(announcedFor(announced, docA, docB)).toEqual({ crumbs: [] });
    expect(announcedFor(announced, undefined, docA)).toEqual({ crumbs: [] });
  });

  it("is no title at all for a blank document title and nothing announced", () => {
    expect(loadedAnnounce({ crumbs: [] }, undefined, docA, "  ")).toEqual({ crumbs: [] });
  });
});
