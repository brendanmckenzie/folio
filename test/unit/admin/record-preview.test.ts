import { describe, expect, it } from "vitest";
import { recordPreviewUrl } from "../../../src/admin/ui/useStory";

/**
 * A record with a `previewPath` is previewed through its host page (`&record=<id>`);
 * a record without one, or whose host page is gone, stays the form it always was.
 */
describe("recordPreviewUrl", () => {
  const host = { path: "authors", previewUrl: "/authors?_folio=preview" };

  it("appends &record=<id> to the host page's own preview URL", () => {
    expect(recordPreviewUrl({ previewPath: "authors" }, host, "sty_1")).toBe(
      "/authors?_folio=preview&record=sty_1",
    );
  });

  it("encodes the id", () => {
    expect(recordPreviewUrl({ previewPath: "authors" }, host, "a b")).toBe(
      "/authors?_folio=preview&record=a%20b",
    );
  });

  it("is form mode with no previewPath, whatever host was found", () => {
    expect(recordPreviewUrl({ previewPath: undefined }, host, "sty_1")).toBeUndefined();
  });

  it("is form mode when no story lives at the previewPath, with no bare fallback", () => {
    expect(recordPreviewUrl({ previewPath: "authors" }, undefined, "sty_1")).toBeUndefined();
    expect(
      recordPreviewUrl({ previewPath: "authors" }, { path: "authors", previewUrl: undefined }, "x"),
    ).toBeUndefined();
  });

  it("will not preview through a different page than the one declared", () => {
    expect(
      recordPreviewUrl({ previewPath: "authors" }, { ...host, path: "elsewhere" }, "sty_1"),
    ).toBeUndefined();
  });
});
