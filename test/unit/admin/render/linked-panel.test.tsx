import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelAnswer } from "../../../../src/core/panels";
import { LinkedPanel } from "../../../../src/admin/ui/screens/LinkedPanel";
import { PANEL_DEBOUNCE_MS } from "../../../../src/admin/ui/screens/linked-panel-model";

/**
 * The linked-data card, mounted (`platform/admin-extensions.md` decision 21): the summary, a
 * link into a host page, nothing for `none`, a one-line error with Retry, and the debounced
 * refetch on a root scalar change.
 */

const pages = [{ id: "products", path: "/admin/products", scope: "deployment" as const }];
const asked: string[] = [];

function answers(...list: PanelAnswer[]) {
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(list[Math.min(n++, list.length - 1)]), { status: 200 });
    }),
  );
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const mount = async (refetchKey = "{}") => {
  const view = render(
    <LinkedPanel
      apiBase="/folio/api"
      storyId="sty_1"
      label="Shop"
      refetchKey={refetchKey}
      pages={pages}
      mount="/folio"
    />,
  );
  await settle();
  return view;
};

const ok: PanelAnswer = {
  status: "ok",
  at: 1,
  summary: {
    items: [
      { label: "Variants", value: "6" },
      { label: "Editions left", value: "3", tone: "warn" },
    ],
    note: "Back in stock Friday.",
    link: { label: "Open in Products", href: "/admin/products/prod_8812" },
  },
};

beforeEach(() => {
  asked.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LinkedPanel", () => {
  it("draws the heading, the items as a definition list, the note and a link into the chrome", async () => {
    answers(ok);
    const { container } = await mount();
    expect(asked).toEqual(["/folio/api/stories/sty_1/panel"]);
    expect(screen.getByRole("heading", { name: "Shop" })).not.toBeNull();
    const terms = [...container.querySelectorAll("dt")].map((n) => n.textContent);
    const values = [...container.querySelectorAll("dd")].map((n) => n.textContent);
    expect(terms).toEqual(["Variants", "Editions left"]);
    expect(values).toEqual(["6", "3"]);
    expect(screen.getByText("Back in stock Friday.")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open in Products" }).getAttribute("href")).toBe(
      "/folio/host/products/prod_8812",
    );
  });

  it("opens an https link in a new tab without leaking the opener", async () => {
    answers({
      status: "ok",
      at: 1,
      summary: {
        items: [],
        note: "n",
        link: { label: "Shop admin", href: "https://shop.example/1" },
      },
    });
    await mount();
    const link = screen.getByRole("link", { name: "Shop admin" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("draws nothing at all when the host has nothing linked", async () => {
    answers({ status: "none" });
    const { container } = await mount();
    expect(container.textContent).toBe("");
  });

  it("says one line with the category on an error, and Retry asks again", async () => {
    answers({ status: "error", reason: "timeout" }, ok);
    await mount();
    expect(screen.getByText(/Couldn't load Shop \(timed out\)/)).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await settle();
    expect(screen.getByText("Back in stock Friday.")).not.toBeNull();
    expect(asked).toHaveLength(2);
  });

  it("refreshes on the button, and shows a failed request as an error rather than nothing", async () => {
    answers(ok);
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    await settle();
    expect(asked).toHaveLength(2);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 500 })),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    await settle();
    expect(screen.getByText(/Couldn't load Shop/)).not.toBeNull();
  });

  it("refetches three seconds after a root scalar changes, once, and never on its own", async () => {
    answers(ok);
    const view = await mount("a");
    vi.useFakeTimers();
    view.rerender(
      <LinkedPanel
        apiBase="/folio/api"
        storyId="sty_1"
        label="Shop"
        refetchKey="b"
        pages={pages}
        mount="/folio"
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PANEL_DEBOUNCE_MS - 1);
    });
    expect(asked).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(asked).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(asked).toHaveLength(2);
  });
});
