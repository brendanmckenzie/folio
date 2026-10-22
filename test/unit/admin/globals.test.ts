import { describe, expect, it } from "vitest";
import { globalPreviewUrl } from "../../../src/admin/ui/useStory";
import type { DocumentType } from "../../../src/core/schema";
import type { StoryMeta } from "../../../src/core/story";

/**
 * The pure piece of `content-model/globals.md`'s admin surface: how a global gets
 * previewed in context. It lives in `ui/useStory.ts`, beside the `usePreviewHost` that
 * supplies its candidate. The candidate list is a `StoryMeta[]` rather than the old
 * `StoryNode[]` because the search is the server's now, so nothing here has children.
 * (`globalTypes` went with `useGlobalDocs`, once the server built the resolution.)
 */

const type = (overrides: Partial<DocumentType> = {}): DocumentType => ({
  name: "header",
  label: "Header",
  kind: "singleton",
  root: "headerRoot",
  ...overrides,
});

const row = (overrides: Partial<StoryMeta> = {}): StoryMeta => ({
  id: "sng_header",
  type: "header",
  parentId: null,
  slug: "header",
  path: null,
  ord: "a0",
  title: "Header",
  publishedAt: null,
  unpublishedAt: null,
  draftSyncId: 0,
  draftUpdatedAt: null,
  publishedSyncId: 0,
  updatedAt: 0,
  state: "draft",
  hasUnpublishedChanges: false,
  ...overrides,
});

describe("globalPreviewUrl", () => {
  const hosts = [row({ id: "sty_home", type: "page", path: "", previewUrl: "/?_folio=preview" })];

  it("appends &as=<name> to the previewPath story’s own preview URL", () => {
    expect(globalPreviewUrl(type({ previewPath: "" }), hosts, "/folio")).toBe(
      "/?_folio=preview&as=header",
    );
  });

  it("falls back to the bare preview route when no previewPath is declared", () => {
    expect(globalPreviewUrl(type({ previewPath: undefined }), hosts, "/folio")).toBe(
      "/folio/preview/global/header",
    );
  });

  it("falls back to the bare preview route when no story lives at previewPath any more", () => {
    expect(globalPreviewUrl(type({ previewPath: "gone" }), hosts, "/folio")).toBe(
      "/folio/preview/global/header",
    );
  });

  it("encodes the type name in both URL shapes", () => {
    expect(globalPreviewUrl(type({ name: "a b", previewPath: "" }), hosts, "/folio")).toBe(
      "/?_folio=preview&as=a%20b",
    );
    expect(globalPreviewUrl(type({ name: "a b", previewPath: undefined }), [], "/folio")).toBe(
      "/folio/preview/global/a%20b",
    );
  });
});
