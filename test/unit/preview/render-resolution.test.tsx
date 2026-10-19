/**
 * `render(props, resolution)`: the page's `Resolution` as a second argument, so a
 * block can `resolveAsset` an asset field of a referenced document (issue #30).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  defineBlock,
  defineRecord,
  reference,
  resolveAsset,
  text,
  toRegistry,
} from "../../../src/core";
import type { Blok, Doc, Json } from "../../../src/core/doc";
import { buildResolution, type Resolution } from "../../../src/core/resolve";
import type { StoryMeta } from "../../../src/core/story";
import { FolioDoc } from "../../../src/preview/Render";

const person = defineRecord({
  name: "personRecord",
  label: "Person",
  fields: { fullName: text() },
});

const card = defineBlock({
  name: "personCard",
  label: "Person card",
  fields: { person: reference({ types: ["person"] }) },
  render: ({ person }, resolution) => {
    const photo = person ? resolveAsset(person.data.photo as Json, resolution) : null;
    return <img src={photo?.src ?? ""} alt="" />;
  },
});

// An existing one-argument render must keep compiling.
const legacy = defineBlock({
  name: "legacy",
  label: "Legacy",
  fields: { title: text() },
  render: ({ title }) => <h1>{title}</h1>,
});

const registry = toRegistry([person, card, legacy]);

const ada: StoryMeta = {
  id: "sty_ada",
  type: "person",
  parentId: null,
  slug: "ada",
  path: null,
  ord: "a0",
  title: "Ada",
  publishedAt: null,
  unpublishedAt: null,
  draftSyncId: 0,
  draftUpdatedAt: null,
  publishedSyncId: 0,
  updatedAt: 0,
  state: "draft",
  hasUnpublishedChanges: false,
};

const one = (uid: string, type: string, data: Record<string, Json>): Doc => {
  const blok: Blok = { uid, type, parent: null, slot: null, order: "a0", data };
  return { root: uid, bloks: { [uid]: blok } };
};

const resolution: Resolution = {
  ...buildResolution([ada]),
  assetBase: "/folio/asset",
  docs: {
    sty_ada: one("a", "personRecord", {
      fullName: "Ada",
      photo: {
        key: "people/ada.jpg",
        filename: "ada.jpg",
        contentType: "image/jpeg",
        size: 1,
        alt: "",
      },
    }),
  },
};

const html = (doc: Doc) =>
  renderToStaticMarkup(<FolioDoc doc={doc} registry={registry} resolution={resolution} />);

describe("render's second argument", () => {
  it("lets a block resolve an asset field of a referenced document", () => {
    // toContain: React 19 may hoist a preload link ahead of the image.
    expect(html(one("c", "personCard", { person: "sty_ada" }))).toContain(
      '<img src="/folio/asset/people/ada.jpg" alt=""/>',
    );
  });

  it("leaves a one-argument render working", () => {
    expect(html(one("l", "legacy", { title: "Hi" }))).toBe("<h1>Hi</h1>");
  });
});
