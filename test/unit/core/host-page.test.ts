import { describe, expect, it } from "vitest";
import {
  frameRedirectTarget,
  screenHostFrame,
  screenHostText,
  underPagePath,
} from "../../../src/core/host-page";

/**
 * The host-page protocol's pure half (`platform/admin-extensions.md` decision 9). The
 * origin and source checks are the admin's; this pins shape, caps, the printable rule, the
 * crumb `href` rule and the version gate.
 */

const paths = ["/admin/orders", "/admin/stock"];
const frame = (extra: Record<string, unknown>) => ({ folio: "host-page", v: 1, ...extra });

describe("screenHostFrame", () => {
  it("passes over anything that is not a host-page frame", () => {
    for (const data of [null, undefined, "x", 3, {}, { folio: "other", v: 1 }, [frame({})]]) {
      expect(screenHostFrame(data, paths)).toEqual({ ok: false, reason: "foreign" });
    }
  });

  it("ignores an unknown version and reports it", () => {
    expect(screenHostFrame(frame({ v: 2, type: "announce" }), paths)).toEqual({
      ok: false,
      reason: "version",
      v: 2,
    });
    expect(screenHostFrame({ folio: "host-page", type: "announce" }, paths)).toMatchObject({
      reason: "version",
    });
  });

  it("refuses an unknown type", () => {
    expect(screenHostFrame(frame({ type: "navigate" }), paths)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("screens an announce: title cap, crumb caps and the crumb href rule", () => {
    const got = screenHostFrame(
      frame({
        type: "announce",
        title: "T".repeat(300),
        crumbs: [
          { text: "Open orders", href: "/admin/orders?state=open" },
          { text: "Elsewhere", href: "/admin/other" },
          { text: "Sibling", href: "/admin/orders-archive" },
          { text: "External", href: "https://evil.example/admin/orders" },
          { text: "Protocol relative", href: "//evil.example/admin/orders" },
          { text: "Backslash", href: "/admin/orders\\..\\x" },
          { text: "x".repeat(100) },
          { text: "ignored fifth" },
        ],
        path: "/admin/orders/1042?tab=items",
      }),
      paths,
    );
    expect(got.ok).toBe(true);
    if (!got.ok || got.frame.type !== "announce") throw new Error("not an announce");
    expect([...(got.frame.title ?? "")]).toHaveLength(120);
    expect(got.frame.title?.endsWith("…")).toBe(true);
    // At most four crumbs; the fifth is dropped before screening.
    expect(got.frame.crumbs).toHaveLength(4);
    expect(got.frame.crumbs).toEqual([
      { text: "Open orders", href: "/admin/orders?state=open" },
      { text: "Elsewhere" },
      { text: "Sibling" },
      { text: "External" },
    ]);
    expect(got.frame.path).toBe("/admin/orders/1042?tab=items");
  });

  it("caps a crumb at 60 characters", () => {
    const got = screenHostFrame(
      frame({ type: "announce", crumbs: [{ text: "c".repeat(80) }] }),
      paths,
    );
    if (!got.ok || got.frame.type !== "announce") throw new Error("not an announce");
    expect([...got.frame.crumbs![0]!.text]).toHaveLength(60);
  });

  it("drops what is not printable, not a string, or not a path", () => {
    const got = screenHostFrame(
      frame({
        type: "announce",
        title: "bad\u0000title",
        crumbs: [{ text: "ok", href: 4 }, { text: 3 }, { text: "\n" }, null, "x"],
        path: "https://evil.example/",
      }),
      paths,
    );
    expect(got).toEqual({ ok: true, frame: { type: "announce", crumbs: [{ text: "ok" }] } });
  });

  it("answers a bare announce as a bare announce", () => {
    expect(screenHostFrame(frame({ type: "announce" }), paths)).toEqual({
      ok: true,
      frame: { type: "announce" },
    });
  });

  it("screens a notice: cap, tone, printable", () => {
    expect(
      screenHostFrame(frame({ type: "notice", message: "Saved", tone: "error" }), paths),
    ).toEqual({
      ok: true,
      frame: { type: "notice", message: "Saved", tone: "error" },
    });
    const long = screenHostFrame(
      frame({ type: "notice", message: "m".repeat(500), tone: "weird" }),
      paths,
    );
    if (!long.ok || long.frame.type !== "notice") throw new Error("not a notice");
    expect([...long.frame.message]).toHaveLength(200);
    expect(long.frame.tone).toBe("info");
    expect(screenHostFrame(frame({ type: "notice", message: "" }), paths)).toMatchObject({
      reason: "malformed",
    });
    expect(screenHostFrame(frame({ type: "notice", message: "a\u0007b" }), paths)).toMatchObject({
      reason: "malformed",
    });
  });
});

describe("screenHostText", () => {
  it("trims, and refuses blank and control characters", () => {
    expect(screenHostText("  hi  ", 10)).toBe("hi");
    expect(screenHostText("   ", 10)).toBeNull();
    expect(screenHostText("a\u2028b", 10)).toBeNull();
    expect(screenHostText(5, 10)).toBeNull();
  });
});

describe("underPagePath", () => {
  it("matches on a segment boundary only", () => {
    expect(underPagePath("/admin/orders", "/admin/orders")).toBe(true);
    expect(underPagePath("/admin/orders/1", "/admin/orders")).toBe(true);
    expect(underPagePath("/admin/orders?x=1", "/admin/orders")).toBe(true);
    expect(underPagePath("/admin/orders-archive", "/admin/orders")).toBe(false);
    expect(underPagePath("/admin", "/admin/orders")).toBe(false);
  });
});

describe("frameRedirectTarget", () => {
  const input = {
    base: "/folio",
    pagePath: "/admin/orders",
    pathname: "/admin/orders/1042",
    search: "?tab=items&folio_scope=alpha",
  };

  it("has no sites: the bare mount", () => {
    expect(
      frameRedirectTarget({ ...input, page: { id: "orders" }, scope: null, search: "?tab=items" }),
    ).toBe("/folio/host/orders/1042?tab=items");
  });

  it("a deployment page ignores any scope", () => {
    expect(
      frameRedirectTarget({
        ...input,
        page: { id: "orders", scope: "deployment" },
        scope: "alpha",
      }),
    ).toBe("/folio/host/orders/1042?tab=items");
  });

  it("a site page with a scope goes to the scoped mount, less folio_scope", () => {
    expect(
      frameRedirectTarget({ ...input, page: { id: "orders", scope: "site" }, scope: "alpha" }),
    ).toBe("/folio/~alpha/host/orders/1042?tab=items");
  });

  it("a site page with no scope goes to the bare mount, the site chooser", () => {
    expect(
      frameRedirectTarget({ ...input, page: { id: "orders", scope: "site" }, scope: null }),
    ).toBe("/folio/host/orders/1042?tab=items");
  });

  it("the page root has no rest, and an unknown page path drops it", () => {
    expect(
      frameRedirectTarget({
        ...input,
        pathname: "/admin/orders",
        search: "",
        page: { id: "orders" },
        scope: null,
      }),
    ).toBe("/folio/host/orders");
    expect(
      frameRedirectTarget({ ...input, pagePath: undefined, page: { id: "orders" }, scope: null }),
    ).toBe("/folio/host/orders?tab=items");
  });

  it("keeps encoded segments as they are", () => {
    expect(
      frameRedirectTarget({
        ...input,
        pathname: "/admin/orders/a%2Fb",
        search: "",
        page: { id: "orders" },
        scope: null,
      }),
    ).toBe("/folio/host/orders/a%2Fb");
  });
});
