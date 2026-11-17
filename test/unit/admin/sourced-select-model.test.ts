import { describe, expect, it } from "vitest";
import { select, text } from "../../../src/core/fields";
import {
  COMBOBOX_AT,
  type FieldOptionsAnswer,
  fieldOptionsUrl,
  filterChoices,
  filterOptions,
  needsFilter,
  retiredLine,
  sourceDetail,
  sourcedView,
  unavailableLine,
} from "../../../src/admin/ui/screens/fields/sourced-select-model";
import { filterBlock } from "../../../src/admin/ui/screens/fields/QueryControls";
import { fieldOptions } from "../../../src/core/option-sources";
import type { SchemaIndex } from "../../../src/core/schema";

/**
 * The sourced select's decisions (`platform/admin-extensions.md` decision 19): the merge with
 * typed extras, the retired-value row, the combobox threshold, the filter options and the Model
 * screen's "from <source>".
 */

const answer = (over: Partial<FieldOptionsAnswer> = {}): FieldOptionsAnswer => ({
  source: "products",
  label: "Products",
  status: "fresh",
  loadedAt: 1,
  options: [
    { value: "prod_1", label: "Classic tee" },
    { value: "prod_2", label: "Hoodie" },
  ],
  ...over,
});

describe("fieldOptions, the merge with typed extras", () => {
  const extras = [{ value: "none", label: "No product" }];

  it("lists the sourced entries first and the extras after", () => {
    expect(fieldOptions([{ value: "a", label: "A" }], extras).map((o) => o.value)).toEqual([
      "a",
      "none",
    ]);
  });

  it("lets an extra win a value collision, so the editor's label stands", () => {
    expect(
      fieldOptions(
        [
          { value: "none", label: "Sourced" },
          { value: "a", label: "A" },
        ],
        extras,
      ),
    ).toEqual([
      { value: "a", label: "A" },
      { value: "none", label: "No product" },
    ]);
  });

  it("gives the extras alone when the list is unavailable", () => {
    expect(fieldOptions(null, extras)).toEqual(extras);
  });

  it("screens a sourced label, the value standing in for one that fails", () => {
    expect(fieldOptions([{ value: "a", label: "bad\u0000label" }], [])).toEqual([
      { value: "a", label: "a" },
    ]);
  });
});

describe("sourcedView", () => {
  it("is the options as they stand for a listed value or none", () => {
    expect(sourcedView(answer(), "prod_1")).toEqual({
      options: answer().options,
      retired: false,
      unavailable: false,
    });
    expect(sourcedView(answer(), "").retired).toBe(false);
  });

  it("keeps a retired value first, as its lookup label", () => {
    const view = sourcedView(
      answer({ missing: [{ value: "prod_9", label: "Archived tee" }] }),
      "prod_9",
    );
    expect(view.retired).toBe(true);
    expect(view.options[0]).toEqual({ value: "prod_9", label: "Archived tee", retired: true });
    expect(view.options).toHaveLength(3);
  });

  it("draws the raw value when there is no label for it", () => {
    expect(sourcedView(answer(), "prod_9").options[0]).toMatchObject({ label: "prod_9" });
    expect(
      sourcedView(answer({ missing: [{ value: "prod_9", label: null }] }), "prod_9").options[0],
    ).toMatchObject({ label: "prod_9" });
  });

  it("marks a never-loaded list unavailable, and a stale one usable as it is", () => {
    expect(sourcedView(answer({ status: "never-loaded", options: [] }), "").unavailable).toBe(true);
    expect(sourcedView(answer({ status: "stale" }), "prod_1").unavailable).toBe(false);
  });
});

describe("the combobox threshold", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));

  it("is more than twenty options", () => {
    expect(COMBOBOX_AT).toBe(20);
    expect(needsFilter(many(20))).toBe(false);
    expect(needsFilter(many(21))).toBe(true);
  });

  it("filters by label or value, ignoring case and padding", () => {
    const options = [
      { value: "prod_1", label: "Classic tee" },
      { value: "prod_2", label: "Hoodie" },
    ];
    expect(filterOptions(options, " TEE ").map((o) => o.value)).toEqual(["prod_1"]);
    expect(filterOptions(options, "prod_2").map((o) => o.value)).toEqual(["prod_2"]);
    expect(filterOptions(options, "").length).toBe(2);
    expect(filterOptions(options, "zzz")).toEqual([]);
  });
});

describe("the sentences", () => {
  it("names the category of a failure and never the host's message", () => {
    expect(unavailableLine(answer({ failure: "timeout" }))).toBe(
      "Products could not be loaded (timed out)",
    );
    expect(unavailableLine(answer({ failure: "threw" }))).toBe(
      "Products could not be loaded (failed)",
    );
    expect(unavailableLine({ source: "products" })).toBe("products has not loaded yet");
  });

  it("says who no longer offers a retired value", () => {
    expect(retiredLine(answer())).toBe("No longer offered by Products");
    expect(retiredLine({ source: "products" })).toBe("No longer offered by products");
  });
});

describe("fieldOptionsUrl", () => {
  it("carries block and field, the locale and the story only when given", () => {
    expect(fieldOptionsUrl("/folio/api", { block: "page", field: "product" })).toBe(
      "/folio/api/field-options?block=page&field=product",
    );
    expect(
      fieldOptionsUrl("/folio/~a/api", { block: "page", field: "p", locale: "fr", story: "sty_1" }),
    ).toBe("/folio/~a/api/field-options?block=page&field=p&locale=fr&story=sty_1");
    expect(fieldOptionsUrl("/api", { block: "b", field: "f", locale: null })).toBe(
      "/api/field-options?block=b&field=f",
    );
  });
});

describe("a collection filter on a sourced select", () => {
  const extras = [{ value: "none", label: "No product" }];
  const schema: SchemaIndex = {
    productPage: {
      name: "productPage",
      label: "Product page",
      fields: {
        title: text({ label: "Title" }),
        product: select({ label: "Product", optionsFrom: { source: "products" }, indexed: true }),
      },
    },
  };

  it("offers the sourced options, which already end in the extras", () => {
    const merged = fieldOptions(answer().options, extras);
    expect(filterChoices({ ...answer(), options: merged }, extras).map((o) => o.value)).toEqual([
      "prod_1",
      "prod_2",
      "none",
    ]);
  });

  it("falls back to the typed extras before the list has answered", () => {
    expect(filterChoices(null, extras)).toEqual(extras);
  });

  it("finds the block that declares an indexed filter field", () => {
    expect(filterBlock(schema, "product")).toBe("productPage");
    expect(filterBlock(schema, "title")).toBeUndefined();
    expect(filterBlock(schema, "nope")).toBeUndefined();
  });
});

describe("the Model screen's detail", () => {
  it("is the source, not a value list", () => {
    expect(sourceDetail({ optionsFrom: { source: "products" } })).toBe("from products");
    expect(sourceDetail({})).toBe("");
  });
});
