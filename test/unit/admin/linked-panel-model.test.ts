import { describe, expect, it } from "vitest";
import {
  cardState,
  errorLine,
  PANEL_DEBOUNCE_MS,
  panelKey,
  panelLink,
  panelUrl,
  toneOf,
} from "../../../src/admin/ui/screens/linked-panel-model";

/**
 * The linked-data card's decisions (`platform/admin-extensions.md` decision 21): what a refetch
 * is keyed on, the debounce, and where the link goes.
 */

const pages = [
  { id: "products", path: "/admin/products", scope: "deployment" as const },
  { id: "orders", path: "/admin/orders", scope: "site" as const },
];

describe("panelKey", () => {
  it("is the root's scalars, sorted, so a scalar change refetches and order does not", () => {
    expect(panelKey({ title: "A", sku: "x", price: 5, live: true, none: null })).toBe(
      panelKey({ live: true, none: null, price: 5, sku: "x", title: "A" }),
    );
    expect(panelKey({ title: "A" })).not.toBe(panelKey({ title: "B" }));
    expect(panelKey({ live: true })).not.toBe(panelKey({ live: false }));
  });

  it("ignores objects and arrays, which a rich edit changes constantly", () => {
    expect(panelKey({ title: "A", body: { type: "doc" } })).toBe(panelKey({ title: "A" }));
    expect(panelKey({ title: "A", body: { type: "doc", content: [] } })).toBe(
      panelKey({ title: "A", body: [1, 2] }),
    );
  });
});

describe("debounce and url", () => {
  it("waits three seconds, and never polls", () => {
    expect(PANEL_DEBOUNCE_MS).toBe(3000);
  });

  it("asks the story's panel route, with the locale when there is one", () => {
    expect(panelUrl("/folio/api", "sty_1")).toBe("/folio/api/stories/sty_1/panel");
    expect(panelUrl("/folio/~a/api", "sty 1", "fr")).toBe(
      "/folio/~a/api/stories/sty%201/panel?locale=fr",
    );
    expect(panelUrl("/api", "sty_1", null)).toBe("/api/stories/sty_1/panel");
  });
});

describe("cardState", () => {
  it("is idle before the first answer, none for nothing linked, ok with the summary", () => {
    expect(cardState(null)).toEqual({ kind: "idle" });
    expect(cardState({ status: "none" })).toEqual({ kind: "none" });
    const summary = { items: [{ label: "Variants", value: "6" }] };
    expect(cardState({ status: "ok", summary, at: 1 })).toEqual({ kind: "ok", summary });
    expect(cardState({ status: "error", reason: "timeout" })).toEqual({
      kind: "error",
      reason: "timeout",
    });
  });

  it("names the category of an error and never a message", () => {
    expect(errorLine("Shop", "timeout")).toBe("Couldn't load Shop (timed out)");
    expect(errorLine("Shop", "threw")).toBe("Couldn't load Shop (failed)");
    expect(errorLine("Shop", "malformed")).toBe("Couldn't load Shop (answered something unusable)");
  });

  it("maps a missing tone to neutral", () => {
    expect(toneOf(undefined)).toBe("neutral");
    expect(toneOf("warn")).toBe("warn");
  });
});

describe("panelLink", () => {
  it("rewrites a path under a declared page to its admin URL, keeping the rest and the query", () => {
    expect(panelLink({ href: "/admin/products/prod_8812?tab=variants" }, pages, "/folio")).toEqual({
      kind: "host",
      href: "/folio/host/products/prod_8812?tab=variants",
      screen: { name: "host", id: "products", rest: "prod_8812" },
    });
  });

  it("keeps the scope of the mount it is shown under", () => {
    expect(panelLink({ href: "/admin/orders/1042" }, pages, "/folio/~alpha")).toMatchObject({
      kind: "host",
      href: "/folio/~alpha/host/orders/1042",
    });
  });

  it("keeps an encoded slash in one segment", () => {
    expect(panelLink({ href: "/admin/products/a%2Fb" }, pages, "/folio")).toMatchObject({
      href: "/folio/host/products/a%2Fb",
    });
  });

  it("leaves another same-origin path alone, to navigate the top window", () => {
    expect(panelLink({ href: "/pricing" }, pages, "/folio")).toEqual({
      kind: "path",
      href: "/pricing",
    });
    expect(panelLink({ href: "/admin/products-archive" }, pages, "/folio")).toMatchObject({
      kind: "path",
    });
  });

  it("opens an https URL as external", () => {
    expect(panelLink({ href: "https://shop.example/p/1" }, pages, "/folio")).toEqual({
      kind: "external",
      href: "https://shop.example/p/1",
    });
  });
});
