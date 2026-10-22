import { describe, expect, it } from "vitest";
import { defineBlock, text } from "../../../src/core";
import { type AnyBlockDef, toSchemaIndex } from "../../../src/core/block";
import { cacheHeaders, cacheTags } from "../../../src/core/cache-tags";
import type { Blok, Doc, Json } from "../../../src/core/doc";
import { blocks } from "../../../src/core/fields";
import { globalResolution, recordResolution } from "../../../src/core/resolution-merge";
import { EMPTY_RESOLUTION, previewParamsOf, type Resolution } from "../../../src/core/resolve";
import { auditSchema } from "../../../src/server/audit";

const bl = (uid: string, type: string, parent: string | null, slot: string | null, order: string) =>
  ({ uid, type, parent, slot, order, data: {} }) satisfies Blok;

const page = defineBlock({
  name: "pp_page",
  label: "Page",
  fields: { body: blocks({ allow: ["pp_a", "pp_b", "pp_c"] }), aside: blocks({ allow: ["pp_a"] }) },
  previewParams: { who: "root" },
});
const a = defineBlock({
  name: "pp_a",
  label: "A",
  fields: { title: text(), kids: blocks({ allow: ["pp_c"] }) },
  previewParams: { tag: "from-a", only: 1 },
});
const b = defineBlock({
  name: "pp_b",
  label: "B",
  fields: { title: text() },
  previewParams: { tag: "from-b", bonly: true },
});
const c = defineBlock({
  name: "pp_c",
  label: "C",
  fields: { title: text() },
  previewParams: { deep: "c" },
});
const plain = defineBlock({ name: "pp_plain", label: "Plain", fields: {} });

const withParams = (def: AnyBlockDef, previewParams: Record<string, Json>): AnyBlockDef => ({
  ...def,
  previewParams,
});

const schema = toSchemaIndex(Object.fromEntries([page, a, b, c, plain].map((d) => [d.name, d])));

describe("previewParamsOf", () => {
  it("carries previewParams into the schema index (and so the manifest)", () => {
    expect(schema.pp_a?.previewParams).toEqual({ tag: "from-a", only: 1 });
  });

  it("answers undefined when no block declares any", () => {
    const doc: Doc = { root: "r", bloks: { r: bl("r", "pp_plain", null, null, "a0") } };
    expect(previewParamsOf(doc, schema)).toBeUndefined();
    expect(previewParamsOf(doc, toSchemaIndex({ pp_plain: plain }))).toBeUndefined();
  });

  it("is root first, then depth first in slot order, and the first declaration of a key wins", () => {
    // body: [y=b (a0), x=a (a1) > k=c], aside: [z=a]. `tag` is declared by b and a, and b
    // sits first in the body slot, so b wins even though a is keyed first in the object.
    const doc: Doc = {
      root: "r",
      bloks: {
        r: bl("r", "pp_page", null, null, "a0"),
        x: bl("x", "pp_a", "r", "body", "a1"),
        y: bl("y", "pp_b", "r", "body", "a0"),
        k: bl("k", "pp_c", "x", "kids", "a0"),
        z: bl("z", "pp_a", "r", "aside", "a0"),
      },
    };
    expect(previewParamsOf(doc, schema)).toEqual({
      who: "root",
      tag: "from-b",
      bonly: true,
      only: 1,
      deep: "c",
    });
  });

  it("lets the root's own declaration beat a descendant's", () => {
    const rooty = toSchemaIndex({
      pp_page: withParams(page, { tag: "root" }),
      pp_a: a,
    });
    const doc: Doc = {
      root: "r",
      bloks: { r: bl("r", "pp_page", null, null, "a0"), x: bl("x", "pp_a", "r", "body", "a0") },
    };
    expect(previewParamsOf(doc, rooty)?.tag).toBe("root");
  });

  it("depends on where a block sits, not on the order its object was built in", () => {
    const base = { r: bl("r", "pp_page", null, null, "a0") };
    const one: Doc = {
      root: "r",
      bloks: {
        ...base,
        a: bl("a", "pp_a", "r", "body", "a0"),
        b: bl("b", "pp_b", "r", "body", "a1"),
      },
    };
    const other: Doc = { root: "r", bloks: { ...base, b: one.bloks.b!, a: one.bloks.a! } };
    expect(previewParamsOf(other, schema)).toEqual(previewParamsOf(one, schema));
    expect(previewParamsOf(one, schema)?.tag).toBe("from-a");
  });

  it("walks several documents in order, the earlier one's keys winning", () => {
    const pageDoc: Doc = { root: "r", bloks: { r: bl("r", "pp_a", null, null, "a0") } };
    const recordDoc: Doc = { root: "q", bloks: { q: bl("q", "pp_b", null, null, "a0") } };
    expect(previewParamsOf([pageDoc, recordDoc], schema)).toEqual({
      tag: "from-a",
      only: 1,
      bonly: true,
    });
    expect(previewParamsOf([pageDoc, undefined], schema)).toEqual({ tag: "from-a", only: 1 });
  });

  it("walks a nested slot of the same type", () => {
    const doc: Doc = {
      root: "r",
      bloks: {
        r: { ...bl("r", "pp_page", null, null, "a0") },
        x: bl("x", "pp_a", "r", "body", "a0"),
        k: bl("k", "pp_a", "x", "kids", "a0"),
      },
    };
    expect(previewParamsOf(doc, schema)?.tag).toBe("from-a");
  });
});

describe("params and the cache", () => {
  const withParams: Resolution = { ...EMPTY_RESOLUTION, params: { tag: "secret-value-42" } };

  it("never reach a cache tag", () => {
    const tags = cacheTags(withParams, { story: "sty_1" });
    expect(tags).toEqual(cacheTags(EMPTY_RESOLUTION, { story: "sty_1" }));
    expect(JSON.stringify(tags)).not.toContain("secret-value-42");
    expect(cacheHeaders(withParams, { story: "sty_1" })).toEqual(
      cacheHeaders(EMPTY_RESOLUTION, { story: "sty_1" }),
    );
  });
});

describe("params and the record preview merge", () => {
  it("survive recordResolution", () => {
    const base: Resolution = { ...EMPTY_RESOLUTION, params: { tag: "x" } };
    const doc: Doc = { root: "r", bloks: { r: bl("r", "pp_plain", null, null, "a0") } };
    expect(recordResolution(base, { ...EMPTY_RESOLUTION }, "rec", doc).params).toEqual({
      tag: "x",
    });
    expect(recordResolution(base, undefined, "rec", doc).params).toEqual({ tag: "x" });
  });
});

describe("params and a global's posted resolution", () => {
  const initial: Resolution = { ...EMPTY_RESOLUTION, params: { tag: "page", only: 1 } };

  it("keeps the page's params, which win a conflict, and adds the posted ones", () => {
    const posted: Resolution = { ...EMPTY_RESOLUTION, params: { tag: "global", extra: 2 } };
    expect(globalResolution(initial, posted).params).toEqual({ tag: "page", only: 1, extra: 2 });
  });

  it("keeps them when the posted resolution carries none", () => {
    expect(globalResolution(initial, { ...EMPTY_RESOLUTION }).params).toEqual({
      tag: "page",
      only: 1,
    });
  });

  it("is the posted resolution untouched when the page held none", () => {
    const posted: Resolution = { ...EMPTY_RESOLUTION, params: { a: 1 } };
    expect(globalResolution(EMPTY_RESOLUTION, posted)).toBe(posted);
  });
});

describe("audit: preview-params-conflict", () => {
  it("reports one finding per key two block types declare differently", () => {
    const found = auditSchema(schema).filter((f) => f.check === "preview-params-conflict");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ block: "pp_a", field: "tag" });
    expect(found[0]?.detail).toContain("pp_b");
  });

  it("is silent when two blocks agree, or declare different keys", () => {
    const agree = toSchemaIndex({
      pp_a: withParams(a, { tag: "same", n: [1, 2] }),
      pp_b: withParams(b, { tag: "same", n: [1, 2] }),
      pp_c: c,
    });
    expect(auditSchema(agree).filter((f) => f.check === "preview-params-conflict")).toEqual([]);
  });
});
