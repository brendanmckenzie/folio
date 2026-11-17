import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Me } from "../../../../src/admin/me";
import { ADMIN, mountAt } from "./fixture";

/**
 * A host page mounted in the shell (`platform/admin-extensions.md` decisions 7 to 9): the
 * sidebar item, the frame's `src`, and the frame's announcements reaching the top bar.
 * The joint-history behaviour (Back, the mirror) needs a real browser and is checked by
 * the owner's pass; its decisions are `host-page-model.test.ts`.
 */

const withPages = (extra: Partial<Me> = {}): Me => ({
  ...ADMIN,
  hostPages: [
    {
      id: "orders",
      label: "Orders",
      path: "/admin/orders",
      icon: "receipt",
      role: "viewer",
      group: "Shop",
      scope: "deployment",
      allowed: true,
    },
  ],
  ...extra,
});

const frameOf = (container: HTMLElement) => container.querySelector("iframe") as HTMLIFrameElement;

describe("a host page", () => {
  it("frames the host's route, with the item in the sidebar and the page in the top bar", async () => {
    const { container } = await mountAt("/folio/host/orders/1042?tab=items", withPages());
    const frame = frameOf(container);
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("src")).toBe("/admin/orders/1042?tab=items");
    expect(frame.getAttribute("title")).toBe("Orders");
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(screen.getByRole("link", { name: "Orders" }).getAttribute("href")).toBe(
      "/folio/host/orders",
    );
    expect(document.title).toContain("Orders");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("takes an announced title and crumbs from its own frame only", async () => {
    const { container } = await mountAt("/folio/host/orders/1042", withPages());
    const frame = frameOf(container);
    const send = async (data: unknown, source: unknown) => {
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data,
            origin: window.location.origin,
            source: source as Window,
          }),
        );
      });
    };
    const announce = {
      folio: "host-page",
      v: 1,
      type: "announce",
      title: "Order #1042",
      crumbs: [{ text: "Open orders", href: "/admin/orders?state=open" }],
    };

    // Another window, a wrong version and another origin change nothing.
    await send(announce, window);
    await send({ ...announce, v: 2 }, frame.contentWindow);
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: announce,
          origin: "https://evil.example",
          source: frame.contentWindow as Window,
        }),
      );
    });
    expect(document.title).not.toContain("Order #1042");

    await send(announce, frame.contentWindow);
    expect(document.title).toBe("Order #1042 · Folio");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Order #1042");
    expect(screen.getByRole("link", { name: "Open orders" }).getAttribute("href")).toBe(
      "/folio/host/orders?state=open",
    );
  });

  it("says so for a page that is not declared", async () => {
    const { container } = await mountAt("/folio/host/nope", withPages());
    expect(frameOf(container)).toBeNull();
    expect(container.textContent).toContain("Nothing is routed at");
  });

  it("draws no item and routes nothing for a page the server did not allow", async () => {
    const me = withPages();
    me.hostPages = [{ ...me.hostPages![0]!, allowed: false }];
    const { container } = await mountAt("/folio/host/orders", me);
    expect(frameOf(container)).toBeNull();
    expect(screen.queryByRole("link", { name: "Orders" })).toBeNull();
  });
});
