/**
 * `resolution.params` (issue #76) reaches every block's `render`, including one drawn
 * as a `reference.content` inside another document: `referenceContent` passes the
 * resolution whole, and this pins that it keeps doing so.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defineBlock, defineRecord, reference, text, toRegistry } from "../../../src/core";
import type { Blok, Doc, Json } from "../../../src/core/doc";
import { buildResolution, type Resolution } from "../../../src/core/resolve";
import { FolioDoc } from "../../../src/preview/Render";

const card = defineRecord({
  name: "rpCard",
  label: "Card",
  fields: { name: text() },
  render: ({ name }, resolution) => (
    <i className="card">{`${name}:${String(resolution.params?.tag ?? "none")}`}</i>
  ),
});
const page = defineBlock({
  name: "rpPage",
  label: "Page",
  fields: { card: reference({ types: ["rpCard"] }) },
  render: ({ card: target }, resolution) => (
    <main>
      <b className="own">{String(resolution.params?.tag ?? "none")}</b>
      {target?.content}
    </main>
  ),
});

const registry = toRegistry([card, page]);

const doc = (uid: string, type: string, data: Record<string, Json>): Doc => {
  const blok: Blok = { uid, type, parent: null, slot: null, order: "a0", data };
  return { root: uid, bloks: { [uid]: blok } };
};

describe("resolution.params in a render", () => {
  const base: Resolution = {
    ...buildResolution([
      {
        id: "c1",
        type: "rpCard",
        parentId: null,
        slug: "c1",
        path: null,
        ord: "a0",
        title: "C",
        publishedAt: null,
        unpublishedAt: null,
        draftSyncId: 0,
        draftUpdatedAt: null,
        publishedSyncId: 0,
        updatedAt: 0,
        state: "draft",
        hasUnpublishedChanges: false,
      },
    ]),
    docs: { c1: doc("cc", "rpCard", { name: "Ada" }) },
  };
  const root = doc("pp", "rpPage", { card: "c1" });
  const render = (resolution: Resolution) =>
    renderToStaticMarkup(<FolioDoc doc={root} registry={registry} resolution={resolution} />);

  it("reaches the page's block and a reference's nested content", () => {
    const html = render({ ...base, params: { tag: "jazz" } });
    expect(html).toContain('<b class="own">jazz</b>');
    expect(html).toContain("Ada:jazz");
  });

  it("is absent, and blocks cope, when nobody passed any", () => {
    const html = render(base);
    expect(html).toContain('<b class="own">none</b>');
    expect(html).toContain("Ada:none");
  });
});
