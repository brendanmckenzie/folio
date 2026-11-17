import { describe, expect, it } from "vitest";
import type { DocumentType } from "../../../src/core/schema";
import type { Me } from "../../../src/admin/me";
import { activeItem, GROUP_AT, nav } from "../../../src/admin/ui/nav";

/**
 * The sidebar, which is generated from the manifest rather than written — so the
 * grouping threshold, the ordering and the role gate are all logic, and all
 * testable in Node without a component.
 */

const OPEN: Me = { mode: "open", actor: null, loginUrl: "" };
const ADMIN: Me = {
  mode: "session",
  actor: { kind: "user", id: "u1", name: "Ada", colour: "#f00", role: "admin" },
  loginUrl: "/folio/login",
};
const EDITOR: Me = {
  mode: "session",
  actor: { kind: "user", id: "u2", name: "Bo", colour: "#0f0", role: "editor" },
  loginUrl: "/folio/login",
};

const type = (name: string, kind: DocumentType["kind"], extra: Partial<DocumentType> = {}) =>
  ({
    name,
    label: name[0]?.toUpperCase() + name.slice(1),
    kind,
    root: `${name}_root`,
    ...extra,
  }) as DocumentType;

const PAGE = type("page", "page");
const labels = (groups: ReturnType<typeof nav>) => groups.map((g) => g.items.map((i) => i.label));

describe("nav", () => {
  it("leads with Home, Content, Assets and Forms and needs no heading over them", () => {
    const groups = nav({ types: [PAGE], globals: [], me: OPEN });
    expect(groups[0]?.label).toBeUndefined();
    expect(groups[0]?.items.map((i) => i.label)).toEqual(["Home", "Content", "Assets", "Forms"]);
  });

  it("names each record type in the primary group, between Content and Assets", () => {
    const groups = nav({
      types: [PAGE, type("person", "record"), type("office", "record")],
      globals: [],
      me: OPEN,
    });
    expect(groups[0]?.items.map((i) => i.label)).toEqual([
      "Home",
      "Content",
      "Person",
      "Office",
      "Assets",
      "Forms",
    ]);
  });

  it("lists Forms right after Assets, and links it to the list screen", () => {
    const groups = nav({ types: [PAGE], globals: [], me: OPEN });
    const items = groups[0]?.items ?? [];
    expect(items.at(-1)).toEqual({ label: "Forms", icon: "forms", screen: { name: "forms" } });
  });

  it("links a record type at its own list screen", () => {
    const groups = nav({ types: [PAGE, type("person", "record")], globals: [], me: OPEN });
    expect(groups[0]?.items[2]?.screen).toEqual({ name: "documents", type: "person" });
  });

  it("keeps pages out of the sidebar: they live in the tree under Content", () => {
    const groups = nav({ types: [PAGE, type("article", "page")], globals: [], me: OPEN });
    expect(labels(groups).flat()).not.toContain("Article");
  });

  it(`stays flat at ${GROUP_AT} record types and groups past it`, () => {
    const records = Array.from({ length: GROUP_AT }, (_, i) => type(`r${i}`, "record"));
    const flat = nav({ types: [PAGE, ...records], globals: [], me: OPEN });
    expect(flat[0]?.items).toHaveLength(GROUP_AT + 4);

    const grouped = nav({
      types: [PAGE, ...records, type("r8", "record")],
      globals: [],
      me: OPEN,
    });
    // The primary group is back to four, and the overflow is a headed,
    // collapsible group rather than a longer list.
    expect(grouped[0]?.items.map((i) => i.label)).toEqual(["Home", "Content", "Assets", "Forms"]);
    const documents = grouped.find((g) => g.label === "Documents");
    expect(documents?.items).toHaveLength(GROUP_AT + 1);
    expect(documents?.collapsible).toBe(true);
  });

  it("groups on a declared group even when there are only two types", () => {
    const groups = nav({
      types: [
        PAGE,
        type("person", "record", { group: "Directory" }),
        type("office", "record", { group: "Directory" }),
      ],
      globals: [],
      me: OPEN,
    });
    expect(groups[0]?.items.map((i) => i.label)).toEqual(["Home", "Content", "Assets", "Forms"]);
    expect(groups.find((g) => g.label === "Directory")?.items.map((i) => i.label)).toEqual([
      "Person",
      "Office",
    ]);
  });

  it("orders groups by first appearance, like the palette, not alphabetically", () => {
    const groups = nav({
      types: [
        PAGE,
        type("zebra", "record", { group: "Zoo" }),
        type("apple", "record", { group: "Market" }),
        type("lion", "record", { group: "Zoo" }),
      ],
      globals: [],
      me: OPEN,
    });
    expect(groups.filter((g) => g.collapsible).map((g) => g.label)).toEqual(["Zoo", "Market"]);
    expect(groups.find((g) => g.label === "Zoo")?.items.map((i) => i.label)).toEqual([
      "Zebra",
      "Lion",
    ]);
  });

  it("puts ungrouped types under Documents, last, when others are grouped", () => {
    const groups = nav({
      types: [PAGE, type("person", "record", { group: "Directory" }), type("note", "record")],
      globals: [],
      me: OPEN,
    });
    expect(groups.filter((g) => g.collapsible).map((g) => g.label)).toEqual([
      "Directory",
      "Documents",
    ]);
    expect(groups.find((g) => g.label === "Documents")?.items.map((i) => i.label)).toEqual([
      "Note",
    ]);
  });

  it("links a singleton straight at its document, since its id is derived", () => {
    const groups = nav({
      types: [PAGE, type("header", "singleton")],
      globals: ["header"],
      me: OPEN,
    });
    const item = groups.find((g) => g.label === "Globals")?.items[0];
    expect(item?.label).toBe("Header");
    expect(item?.screen).toEqual({ name: "edit", id: "sng_header" });
  });

  it("lists declared globals first, then any singleton that is not one", () => {
    const groups = nav({
      types: [PAGE, type("footer", "singleton"), type("header", "singleton")],
      globals: ["header"],
      me: OPEN,
    });
    expect(groups.find((g) => g.label === "Globals")?.items.map((i) => i.label)).toEqual([
      "Header",
      "Footer",
    ]);
  });

  it("has no Globals group at all when nothing declares a singleton", () => {
    expect(nav({ types: [PAGE], globals: [], me: OPEN }).map((g) => g.label)).not.toContain(
      "Globals",
    );
  });

  it("ignores a global naming a type that is not a singleton", () => {
    const groups = nav({ types: [PAGE, type("header", "singleton")], globals: ["page"], me: OPEN });
    expect(groups.find((g) => g.label === "Globals")?.items.map((i) => i.label)).toEqual([
      "Header",
    ]);
  });

  it("offers Access only to an admin — absent, not disabled", () => {
    const admin = nav({ types: [PAGE], globals: [], me: ADMIN });
    const editor = nav({ types: [PAGE], globals: [], me: EDITOR });
    const open = nav({ types: [PAGE], globals: [], me: OPEN });
    expect(labels(admin).flat()).toContain("Access");
    expect(labels(editor).flat()).not.toContain("Access");
    // `auth: 'open'` has no accounts, and the server 404s the surface too.
    expect(labels(open).flat()).not.toContain("Access");
  });

  it("keeps Model, Redirects, Schedules and Settings for everyone", () => {
    const editor = labels(nav({ types: [PAGE], globals: [], me: EDITOR })).flat();
    expect(editor).toContain("Model");
    expect(editor).toContain("Redirects");
    // Ungated on purpose: `GET {base}/api/schedules` is `READ`, so a viewer may see
    // what is coming. Cancelling is `PUBLISH` and the route enforces it.
    expect(editor).toContain("Schedules");
    expect(editor).toContain("Settings");
  });

  it("never lists Your account: it is reached from the user menu, not the sidebar", () => {
    // `docs/specs/foundation/passkeys.md` decision 6 is explicit that `account`
    // joins `Screen`, `FLAT` and `TITLES` but not `nav()` — a sidebar entry would
    // be a second, redundant way to a screen with no content of its own to list.
    for (const me of [OPEN, ADMIN, EDITOR]) {
      expect(labels(nav({ types: [PAGE], globals: [], me })).flat()).not.toContain("Your account");
    }
  });

  /**
   * The icons are names now, resolved to inline SVG by `ui/icons.tsx` — which
   * this file deliberately does not import, because it is a `.tsx` and these
   * tests run in Node and mount nothing. So the assertion is on the names, and
   * `ICONS` being a `Record<IconName, …>` is what makes a name that has no
   * drawing a type error rather than something a test has to catch.
   */
  it("names an icon for every item, since the collapsed rail draws nothing else", () => {
    const groups = nav({
      types: [PAGE, type("person", "record"), type("header", "singleton")],
      globals: ["header"],
      me: ADMIN,
    });
    expect(groups.flatMap((g) => g.items).map((i) => [i.label, i.icon])).toEqual([
      ["Home", "home"],
      ["Content", "content"],
      ["Person", "records"],
      ["Assets", "assets"],
      ["Forms", "forms"],
      ["Header", "global"],
      ["Model", "model"],
      ["Redirects", "redirects"],
      ["Schedules", "schedules"],
      ["Access", "access"],
      ["Settings", "settings"],
    ]);
  });

  it("draws Model and Settings differently: they were the same ⚙ until the set existed", () => {
    const items = nav({ types: [PAGE], globals: [], me: ADMIN }).flatMap((g) => g.items);
    const iconOf = (label: string) => items.find((i) => i.label === label)?.icon;
    expect(iconOf("Model")).not.toBe(iconOf("Settings"));
  });

  it("gives every record type the same icon, since the label is what tells them apart", () => {
    const groups = nav({
      types: [PAGE, type("person", "record"), type("office", "record")],
      globals: [],
      me: OPEN,
    });
    const records = groups[0]?.items.filter((i) => i.screen.name === "documents");
    expect(records?.map((i) => i.icon)).toEqual(["records", "records"]);
  });
});

describe("activeItem", () => {
  const groups = nav({
    types: [PAGE, type("person", "record"), type("header", "singleton")],
    globals: ["header"],
    me: ADMIN,
  });

  it("is the screen itself for anything but the editor", () => {
    expect(activeItem(groups, { name: "assets" })).toEqual({ name: "assets" });
  });

  it("lights up Forms for the builder and the responses table, which have no nav item of their own", () => {
    expect(activeItem(groups, { name: "form", id: "frm_1" })).toEqual({ name: "forms" });
    expect(activeItem(groups, { name: "responses", id: "frm_1" })).toEqual({ name: "forms" });
  });

  it("lights up Access for one editor's page", () => {
    expect(activeItem(groups, { name: "accessUser", id: "usr_1" })).toEqual({ name: "access" });
  });

  it("lights up Content for an open page, so the sidebar never highlights nothing", () => {
    expect(activeItem(groups, { name: "edit", id: "sty_x" })).toEqual({ name: "content" });
  });

  it("lights up a record's own list", () => {
    expect(activeItem(groups, { name: "edit", id: "sty_ada" }, "person")).toEqual({
      name: "documents",
      type: "person",
    });
  });

  it("lights up the global itself when the open document is one", () => {
    expect(activeItem(groups, { name: "edit", id: "sng_header" }, "header")).toEqual({
      name: "edit",
      id: "sng_header",
    });
  });

  it("falls back to Content for a type with no list in the nav", () => {
    expect(activeItem(groups, { name: "edit", id: "sty_x" }, "ghost")).toEqual({ name: "content" });
  });
});

/* ------------------------------------------------------------- host pages --- */

describe("host pages in the nav (platform/admin-extensions.md decision 13)", () => {
  type HostPages = NonNullable<Me["hostPages"]>;
  const page = (id: string, extra: Partial<HostPages[number]> = {}): HostPages[number] => ({
    id,
    label: id[0]?.toUpperCase() + id.slice(1),
    path: `/admin/${id}`,
    icon: "window",
    role: "viewer",
    scope: "deployment",
    allowed: true,
    ...extra,
  });
  const withPages = (pages: HostPages): Me => ({ ...ADMIN, hostPages: pages });

  it("adds nothing when none are declared", () => {
    const before = nav({ types: [PAGE], globals: [], me: ADMIN });
    expect(nav({ types: [PAGE], globals: [], me: { ...ADMIN, hostPages: undefined } })).toEqual(
      before,
    );
  });

  it("draws one group per declared group, in first-appearance order, then the ungrouped", () => {
    const groups = nav({
      types: [PAGE],
      globals: [],
      me: withPages([
        page("orders", { group: "Shop", icon: "receipt" }),
        page("reports"),
        page("stock", { group: "Stock" }),
        page("products", { group: "Shop", icon: "tag" }),
      ]),
    });
    expect(labels(groups)).toEqual([
      ["Home", "Content", "Assets", "Forms"],
      ["Orders", "Products"],
      ["Stock"],
      ["Reports"],
      ["Model", "Redirects", "Schedules", "Access", "Settings"],
    ]);
    expect(groups[1]?.label).toBe("Shop");
    expect(groups[1]?.collapsible).toBe(true);
    expect(groups[1]?.items[0]).toEqual({
      label: "Orders",
      icon: "receipt",
      screen: { name: "host", id: "orders", rest: "" },
    });
    expect(groups[3]?.label).toBeUndefined();
  });

  it("omits a deployment page the server did not allow", () => {
    const groups = nav({
      types: [PAGE],
      globals: [],
      me: withPages([page("orders", { allowed: false }), page("stock")]),
    });
    expect(labels(groups).flat()).not.toContain("Orders");
    expect(labels(groups).flat()).toContain("Stock");
  });

  describe("on a deployment with sites", () => {
    const sites = (scopes: { id: string; role: "viewer" | "editor" | "admin"; brand?: string }[]) =>
      ({
        settings: null,
        platform: true,
        brands: [],
        scopes: scopes.map((s) => ({
          id: s.id,
          name: s.id,
          kind: "site" as const,
          group: null,
          role: s.role,
          chain: [s.id],
          status: "live" as const,
          preview: null,
          brand: s.brand ? { id: s.brand, label: s.brand.toUpperCase() } : null,
        })),
        previewable: [],
      }) as unknown as NonNullable<Me["sites"]>;

    const multi = (
      pages: HostPages,
      scopes: { id: string; role: "viewer" | "editor" | "admin"; brand?: string }[] = [
        { id: "alpha", role: "editor" },
      ],
    ): Me => ({
      ...ADMIN,
      sites: sites(scopes),
      hostPages: pages,
    });

    it("gates a site page by the role on the shown scope", () => {
      const me = multi([
        page("orders", { scope: "site", role: "editor", allowed: undefined }),
        page("discounts", { scope: "site", role: "admin", allowed: undefined }),
      ]);
      const shown = nav({ types: [PAGE], globals: [], me, scope: "alpha" });
      expect(labels(shown).flat()).toContain("Orders");
      expect(labels(shown).flat()).not.toContain("Discounts");
    });

    it("gates a site page by the scope's brand", () => {
      const me = multi(
        [page("orders", { scope: "site", brands: ["a"], allowed: undefined })],
        [
          { id: "alpha", role: "editor", brand: "a" },
          { id: "bravo", role: "editor", brand: "b" },
        ],
      );
      expect(labels(nav({ types: [PAGE], globals: [], me, scope: "alpha" })).flat()).toContain(
        "Orders",
      );
      expect(labels(nav({ types: [PAGE], globals: [], me, scope: "bravo" })).flat()).not.toContain(
        "Orders",
      );
    });

    it("draws Sites and the allowed deployment pages, and no site pages, at the bare mount", () => {
      const me = multi([
        page("stock"),
        page("hidden", { allowed: false }),
        page("orders", { scope: "site", allowed: undefined }),
      ]);
      const groups = nav({ types: [PAGE], globals: [], me, scope: null });
      expect(labels(groups)).toEqual([["Sites"], ["Stock"]]);
    });

    it("draws just the deployment pages at the bare mount for someone who may not manage sites", () => {
      const me: Me = { ...multi([page("stock")]), actor: EDITOR.actor };
      me.sites = { ...me.sites!, platform: false };
      expect(labels(nav({ types: [PAGE], globals: [], me, scope: null }))).toEqual([["Stock"]]);
    });
  });

  it("lights the page's item for any path under it", () => {
    const groups = nav({ types: [PAGE], globals: [], me: withPages([page("orders")]) });
    expect(activeItem(groups, { name: "host", id: "orders", rest: "1042/lines" })).toEqual({
      name: "host",
      id: "orders",
      rest: "",
    });
  });
});
