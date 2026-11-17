import { describe, expect, expectTypeOf, it } from "vitest";
import { defineBlock, select, text, toManifest, toRegistry } from "../../../src/core";
import { defaultValue, type Field, type PropsOf } from "../../../src/core/fields";
import { fieldShapeError } from "../../../src/core/nested";

/**
 * `select({ optionsFrom })` (`platform/admin-extensions.md` decision 14): the choices come
 * from a host option source, the stored value is the source's `value`, and a static
 * select is unchanged.
 */

const sourced = select({ label: "Product", optionsFrom: { source: "products" }, indexed: true });
const withExtras = select({
  optionsFrom: { source: "products", settings: { collection: "tees" } },
  options: [{ value: "none", label: "No product" }],
});
const fixed = select({
  options: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ],
});

describe("the builder", () => {
  it("compiles with no options and fills []", () => {
    expect(sourced).toMatchObject({
      kind: "select",
      options: [],
      optionsFrom: { source: "products" },
      indexed: true,
    });
  });

  it("keeps typed extras and the settings", () => {
    expect(withExtras.options).toEqual([{ value: "none", label: "No product" }]);
    expect(withExtras.optionsFrom).toEqual({
      source: "products",
      settings: { collection: "tees" },
    });
  });

  it("refuses translatable beside optionsFrom, and a static select with no options", () => {
    // @ts-expect-error the stored id is the same in every locale
    select({ optionsFrom: { source: "products" }, translatable: true });
    // @ts-expect-error a static select needs its options
    select({ label: "x" });
  });

  it("leaves a static select exactly as it was, with no optionsFrom key", () => {
    expect(Object.keys(fixed)).toEqual(["kind", "options"]);
    expect("optionsFrom" in fixed).toBe(false);
  });
});

describe("the value type", () => {
  it("is string for a sourced select and the literal union for a static one", () => {
    expectTypeOf<PropsOf<{ p: typeof sourced }>["p"]>().toEqualTypeOf<string>();
    expectTypeOf<PropsOf<{ p: typeof withExtras }>["p"]>().toEqualTypeOf<string>();
    expectTypeOf<PropsOf<{ p: typeof fixed }>["p"]>().toEqualTypeOf<"a" | "b">();
  });
});

describe("defaultValue", () => {
  it("is empty for a sourced select, with and without typed extras", () => {
    expect(defaultValue(sourced as Field)).toBe("");
    expect(defaultValue(withExtras as Field)).toBe("");
  });

  it("is still the first option for a static select", () => {
    expect(defaultValue(fixed as Field)).toBe("a");
  });
});

describe("fieldShapeError for a sourced select", () => {
  const field = sourced as Field;
  const extras = withExtras as Field;

  it("accepts an id, the empty string and null", () => {
    expect(fieldShapeError(field, "prod_8812")).toBeNull();
    expect(fieldShapeError(field, "")).toBeNull();
    expect(fieldShapeError(field, null)).toBeNull();
  });

  it("accepts a typed extra", () => {
    expect(fieldShapeError(extras, "none")).toBeNull();
  });

  it("refuses a non-string, and a value no source could offer", () => {
    expect(fieldShapeError(field, 3)).toBe("must be a string");
    expect(fieldShapeError(field, " padded ")).toMatch(/printable/);
    expect(fieldShapeError(field, "x".repeat(121))).toMatch(/printable/);
    expect(fieldShapeError(field, "bad\u0000value")).toMatch(/printable/);
    expect(fieldShapeError(field, "x".repeat(120))).toBeNull();
  });

  it("leaves a static select's check alone", () => {
    expect(fieldShapeError(fixed as Field, "c")).toBe("must be one of: a, b");
    expect(fieldShapeError(fixed as Field, "a")).toBeNull();
  });
});

describe("the manifest", () => {
  it("carries optionsFrom through unchanged", () => {
    const block = defineBlock({
      name: "productPage",
      label: "Product page",
      fields: { title: text(), product: sourced },
      render: () => null,
    });
    const manifest = toManifest(toRegistry([block]), [
      {
        name: "productPage",
        label: "Product page",
        kind: "page",
        root: "productPage",
        default: true,
      },
    ]) as unknown as {
      blocks: { name: string; fields: Record<string, Field> }[];
    };
    const field = manifest.blocks.find((b) => b.name === "productPage")?.fields.product;
    expect(field).toMatchObject({ kind: "select", optionsFrom: { source: "products" } });
  });
});
