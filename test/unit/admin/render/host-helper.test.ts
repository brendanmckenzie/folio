import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, connectHostPage, framed, notice, scope, scoped } from "../../../../src/host";

/**
 * `folio/host` in a DOM (`platform/admin-extensions.md` decisions 8 and 9): the scope a
 * `site` page carries on every link, form and `fetch`, and the no-op outside the frame.
 */

let disconnect: (() => void) | null = null;

function at(url: string) {
  window.history.replaceState({}, "", url);
}

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  at("/admin/orders");
});

afterEach(() => {
  disconnect?.();
  disconnect = null;
  vi.restoreAllMocks();
});

const connect = (opts: Parameters<typeof connectHostPage>[0]) => {
  disconnect = connectHostPage(opts);
};

/** Runs a capture-phase listener the way a click does, without navigating. */
function click(a: HTMLAnchorElement) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  a.addEventListener("click", (e) => e.preventDefault());
  a.dispatchEvent(event);
}

describe("scope seeding", () => {
  it("seeds sessionStorage per page id from folio_scope", () => {
    at("/admin/orders?folio_scope=alpha");
    connect({ page: { id: "orders", scope: "site" }, track: false });
    expect(scope()).toBe("alpha");
    expect(sessionStorage.getItem("folio:scope:orders")).toBe("alpha");
    expect(sessionStorage.getItem("folio:scope:stock")).toBeNull();
  });

  it("falls back to the tab's stored scope when the URL has none", () => {
    sessionStorage.setItem("folio:scope:orders", "bravo");
    connect({ page: { id: "orders", scope: "site" }, track: false });
    expect(scope()).toBe("bravo");
  });

  it("holds nothing for a deployment page", () => {
    at("/admin/orders?folio_scope=alpha");
    connect({ page: { id: "orders" }, track: false });
    expect(scope()).toBeNull();
  });

  it("lets go on disconnect", () => {
    at("/admin/orders?folio_scope=alpha");
    connect({ page: { id: "orders", scope: "site" }, track: false });
    disconnect?.();
    disconnect = null;
    expect(scope()).toBeNull();
  });
});

describe("carrying the scope", () => {
  beforeEach(() => {
    at("/admin/orders?folio_scope=alpha");
  });

  it("adds folio_scope to a clicked same-origin link that lacks it", () => {
    connect({ page: { id: "orders", scope: "site" }, track: false });
    document.body.innerHTML = `<a id="a" href="/admin/orders/1042?tab=items">x</a>`;
    const a = document.getElementById("a") as HTMLAnchorElement;
    click(a);
    expect(a.getAttribute("href")).toBe("/admin/orders/1042?tab=items&folio_scope=alpha");
  });

  it("leaves cross-origin links, hash links, downloads and already-scoped links alone", () => {
    connect({ page: { id: "orders", scope: "site" }, track: false });
    document.body.innerHTML = `
      <a id="x" href="https://other.example/admin/orders">x</a>
      <a id="h" href="#top">h</a>
      <a id="d" href="/file.csv" download>d</a>
      <a id="s" href="/admin/orders?folio_scope=bravo">s</a>
      <a id="m" href="mailto:a@b.c">m</a>`;
    for (const id of ["x", "h", "d", "s", "m"])
      click(document.getElementById(id) as HTMLAnchorElement);
    expect(document.getElementById("x")?.getAttribute("href")).toBe(
      "https://other.example/admin/orders",
    );
    expect(document.getElementById("h")?.getAttribute("href")).toBe("#top");
    expect(document.getElementById("d")?.getAttribute("href")).toBe("/file.csv");
    expect(document.getElementById("s")?.getAttribute("href")).toBe(
      "/admin/orders?folio_scope=bravo",
    );
    expect(document.getElementById("m")?.getAttribute("href")).toBe("mailto:a@b.c");
  });

  it("adds it to a submitted POST form's action, and a hidden field to a GET form", () => {
    connect({ page: { id: "orders", scope: "site" }, track: false });
    document.body.innerHTML = `
      <form id="p" method="post" action="/admin/orders/1042"></form>
      <form id="g" method="get" action="/admin/orders"></form>
      <form id="x" method="post" action="https://other.example/x"></form>`;
    for (const id of ["p", "g", "x"]) {
      const form = document.getElementById(id) as HTMLFormElement;
      form.addEventListener("submit", (e) => e.preventDefault());
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    expect(document.getElementById("p")?.getAttribute("action")).toBe(
      "/admin/orders/1042?folio_scope=alpha",
    );
    const field = document.querySelector<HTMLInputElement>("#g input[name=folio_scope]");
    expect(field?.value).toBe("alpha");
    expect(document.getElementById("x")?.getAttribute("action")).toBe("https://other.example/x");
    expect(document.querySelector("#x input")).toBeNull();
  });

  it("does nothing for a page that holds no scope", () => {
    at("/admin/orders");
    connect({ page: { id: "orders", scope: "site" }, track: false });
    document.body.innerHTML = `<a id="a" href="/admin/orders/1">x</a>`;
    click(document.getElementById("a") as HTMLAnchorElement);
    expect(document.getElementById("a")?.getAttribute("href")).toBe("/admin/orders/1");
  });

  it("sets x-folio-scope through scoped(), and leaves init alone with no scope", () => {
    connect({ page: { id: "orders", scope: "site" }, track: false });
    const init = scoped({ method: "POST", headers: { accept: "application/json" } });
    const headers = new Headers(init.headers);
    expect(headers.get("x-folio-scope")).toBe("alpha");
    expect(headers.get("accept")).toBe("application/json");
    expect(init.method).toBe("POST");
    disconnect?.();
    disconnect = null;
    const plain = { method: "GET" };
    expect(scoped(plain)).toBe(plain);
  });
});

describe("outside the frame", () => {
  it("is not framed at top level, and announce and notice post nothing", () => {
    expect(framed()).toBe(false);
    const post = vi.spyOn(window.parent, "postMessage");
    announce({ title: "x" });
    notice("hello");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("inside the frame", () => {
  it("posts versioned frames to the page's own origin only", () => {
    const parent = { postMessage: vi.fn() };
    vi.spyOn(window, "parent", "get").mockReturnValue(parent as unknown as Window);
    expect(framed()).toBe(true);
    announce({ title: "Order #1042", crumbs: [{ text: "Open", href: "/admin/orders" }] });
    notice("Saved", "info");
    expect(parent.postMessage).toHaveBeenNthCalledWith(
      1,
      {
        folio: "host-page",
        v: 1,
        type: "announce",
        title: "Order #1042",
        crumbs: [{ text: "Open", href: "/admin/orders" }],
      },
      location.origin,
    );
    expect(parent.postMessage).toHaveBeenNthCalledWith(
      2,
      { folio: "host-page", v: 1, type: "notice", message: "Saved", tone: "info" },
      location.origin,
    );
  });

  it("announces the title and location on connect and on popstate", () => {
    const parent = { postMessage: vi.fn() };
    vi.spyOn(window, "parent", "get").mockReturnValue(parent as unknown as Window);
    document.title = "Orders";
    at("/admin/orders?tab=1");
    connect({ page: { id: "orders" } });
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    expect(parent.postMessage.mock.calls[0]![0]).toMatchObject({
      type: "announce",
      title: "Orders",
      path: "/admin/orders?tab=1",
    });
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
  });
});
