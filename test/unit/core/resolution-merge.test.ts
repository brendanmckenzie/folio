import { describe, expect, it } from "vitest";
import type { Doc } from "../../../src/core/doc";
import { recordResolution } from "../../../src/core/resolution-merge";
import type { Resolution, StoryRef } from "../../../src/core/resolve";

const ref = (id: string, title: string, type = "page"): StoryRef => ({
  id,
  path: "",
  url: "",
  title,
  type,
  routable: false,
});

const doc = (title: string): Doc => ({
  root: "r0000001",
  bloks: {
    r0000001: {
      uid: "r0000001",
      type: "person",
      parent: null,
      slot: null,
      order: "a0",
      data: { title },
    },
  },
});

const page: Resolution = {
  assetBase: "/folio/asset",
  stories: { home: ref("home", "Home"), pal: ref("pal", "Page's view of pal") },
  docs: { pal: doc("page copy") },
  globals: { header: doc("header") },
  collections: { q1: { items: [], total: 0, page: 1, perPage: 10 } as never },
  locale: { code: "fr" } as never,
};

describe("recordResolution", () => {
  it("sets the record and puts the live draft at docs[id]", () => {
    const out = recordResolution(page, undefined, "rec", doc("draft"));
    expect(out.record).toBe("rec");
    expect(out.docs?.rec?.bloks.r0000001?.data.title).toBe("draft");
  });

  it("keeps the page's own content: nothing the record brings replaces it", () => {
    const overlay: Resolution = {
      assetBase: "/other",
      stories: { home: ref("home", "Overlay home"), extra: ref("extra", "Extra") },
      docs: { pal: doc("overlay copy") },
      globals: { header: doc("overlay header") },
      locale: { code: "de" } as never,
    };
    const out = recordResolution(page, overlay, "rec", doc("draft"));
    expect(out.stories.home?.title).toBe("Home");
    expect(out.docs?.pal?.bloks.r0000001?.data.title).toBe("page copy");
    expect(out.globals).toBe(page.globals);
    expect(out.collections).toEqual(page.collections);
    expect(out.assetBase).toBe("/folio/asset");
    expect(out.locale).toEqual({ code: "fr" });
    // What only the record's own content points at is added, so a link the editor
    // has just picked in the record resolves.
    expect(out.stories.extra?.title).toBe("Extra");
  });

  it("takes the record's own story ref from the overlay, so a rename shows", () => {
    const withOld: Resolution = { ...page, stories: { ...page.stories, rec: ref("rec", "Old") } };
    const out = recordResolution(
      withOld,
      { assetBase: "/x", stories: { rec: ref("rec", "New", "person") } },
      "rec",
      doc("d"),
    );
    expect(out.stories.rec?.title).toBe("New");
  });

  it("does not mutate either input", () => {
    const before = JSON.stringify(page);
    const overlay: Resolution = { assetBase: "/x", stories: { extra: ref("extra", "E") } };
    const overlayBefore = JSON.stringify(overlay);
    recordResolution(page, overlay, "rec", doc("d"));
    expect(JSON.stringify(page)).toBe(before);
    expect(JSON.stringify(overlay)).toBe(overlayBefore);
  });

  /** The client re-applies it to what the server already merged, and must land on the same value. */
  it("is idempotent over its own output", () => {
    const overlay: Resolution = { assetBase: "/x", stories: { rec: ref("rec", "R", "person") } };
    const once = recordResolution(page, overlay, "rec", doc("d"));
    expect(recordResolution(once, undefined, "rec", doc("d"))).toEqual(once);
  });
});
