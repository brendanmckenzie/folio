import { describe, expect, it } from "vitest";
import type { FormField } from "../../../src/core/forms";
import {
  CONTENT_SOURCE,
  contentOptionQuery,
  contentOptionSettings,
  hasUnavailableOptions,
  MAX_OPTION_LABEL,
  materialiseOptions,
  optionListKey,
  readOptionsFrom,
  screenOptionLabel,
} from "../../../src/core/option-sources";
import type { Resolution } from "../../../src/core/resolve";

/**
 * Spec 37's pure vocabulary (`docs/specs/content-model/form-option-sources.md`
 * decisions 2, 4, 10, 12, 18).
 */

const sourced = (over: Partial<FormField> = {}): FormField => ({
  name: "trip",
  kind: "select",
  label: "Trip",
  optionsFrom: { source: CONTENT_SOURCE, settings: { type: "trip" } },
  ...over,
});
const opt = (value: string, label = value) => ({ value, label });

describe("readOptionsFrom", () => {
  const bad = (raw: unknown) => () => readOptionsFrom(raw, "trip");

  it("throws on each structural fault", () => {
    expect(bad(null)).toThrow(/malformed optionsFrom/);
    expect(bad("content")).toThrow(/malformed optionsFrom/);
    expect(bad([])).toThrow(/malformed optionsFrom/);
    expect(bad({})).toThrow(/invalid source/);
    expect(bad({ source: "Countries" })).toThrow(/invalid source/);
    expect(bad({ source: "1x" })).toThrow(/invalid source/);
    expect(bad({ source: `a${"b".repeat(48)}` })).toThrow(/invalid source/);
    expect(bad({ source: "countries", settings: [] })).toThrow(/not an object/);
    expect(bad({ source: "countries", settings: null })).toThrow(/not an object/);
    expect(bad({ source: "countries", settings: { blob: "x".repeat(5000) } })).toThrow(/bytes/);
  });

  it("returns the descriptor with settings keys sorted", () => {
    const read = readOptionsFrom(
      { source: "countries", settings: { b: 1, a: { d: 1, c: 2 } } },
      "q",
    );
    expect(JSON.stringify(read)).toBe(
      '{"source":"countries","settings":{"a":{"c":2,"d":1},"b":1}}',
    );
    expect(readOptionsFrom({ source: "countries" }, "q")).toEqual({ source: "countries" });
  });
});

describe("contentOptionSettings", () => {
  it("accepts a type alone, and normalises a full set", () => {
    expect(contentOptionSettings({ type: "trip" })).toEqual({ type: "trip" });
    const full = contentOptionSettings({
      type: "trip",
      parent: null,
      where: [{ field: "region", op: "eq", value: "east" }],
      order: { field: "title", dir: "desc" },
    });
    expect(full).toEqual({
      type: "trip",
      parent: null,
      where: [{ field: "region", op: "eq", value: "east" }],
      order: { dir: "desc", field: "title" },
    });
  });

  it("refuses what asCollectionValue would silently drop", () => {
    expect(contentOptionSettings(undefined)).toBeNull();
    expect(contentOptionSettings({})).toBeNull();
    expect(contentOptionSettings({ type: "" })).toBeNull();
    expect(contentOptionSettings({ type: 3 })).toBeNull();
    expect(contentOptionSettings({ type: "t", parent: 3 })).toBeNull();
    expect(contentOptionSettings({ type: "t", where: "x" })).toBeNull();
    expect(
      contentOptionSettings({ type: "t", where: [{ field: "a", op: "nope", value: "x" }] }),
    ).toBeNull();
    expect(contentOptionSettings({ type: "t", order: { field: "", dir: "asc" } })).toBeNull();
    expect(contentOptionSettings({ type: "t", order: { field: "a", dir: "sideways" } })).toBeNull();
  });
});

describe("contentOptionQuery", () => {
  const indexed = new Set(["region"]);

  it("defaults to published, title ascending, a hundred a page", () => {
    expect(contentOptionQuery({ type: "trip" }, indexed)).toEqual({
      type: "trip",
      where: [],
      order: { field: "title", dir: "asc" },
      page: 1,
      perPage: 100,
      status: "published",
    });
    expect(contentOptionQuery({ type: "trip" }, indexed, 3).page).toBe(3);
  });

  it("drops a filter that is not indexed on the root block", () => {
    const q = contentOptionQuery(
      {
        type: "trip",
        where: [
          { field: "region", op: "eq", value: "east" },
          { field: "gone", op: "eq", value: "x" },
        ],
      },
      indexed,
    );
    expect(q.where).toEqual([{ field: "region", op: "eq", value: "east" }]);
  });

  it("drops a relevance order and an unindexed one, keeps an indexed or built-in one", () => {
    const order = (field: string) =>
      contentOptionQuery({ type: "t", order: { field, dir: "desc" } }, indexed).order;
    expect(order("relevance")).toEqual({ field: "title", dir: "asc" });
    expect(order("gone")).toEqual({ field: "title", dir: "asc" });
    expect(order("region")).toEqual({ field: "region", dir: "desc" });
    expect(order("publishedAt")).toEqual({ field: "publishedAt", dir: "desc" });
  });

  it("carries parent only when set", () => {
    expect("parent" in contentOptionQuery({ type: "t" }, indexed)).toBe(false);
    expect(contentOptionQuery({ type: "t", parent: null }, indexed).parent).toBeNull();
  });
});

describe("optionListKey", () => {
  it("is the same for two key orders and differs by locale", () => {
    expect(optionListKey({ a: 1, b: { y: 1, x: 2 } }, "")).toBe(
      optionListKey({ b: { x: 2, y: 1 }, a: 1 }, ""),
    );
    expect(optionListKey({ a: 1 }, "fr")).not.toBe(optionListKey({ a: 1 }, ""));
    expect(optionListKey(undefined, "")).toBe('[{},""]');
  });
});

describe("screenOptionLabel", () => {
  it("trims, refuses the unprintable and the blank, truncates at 200 with an ellipsis", () => {
    expect(screenOptionLabel("  Serengeti ")).toBe("Serengeti");
    expect(screenOptionLabel("   ")).toBeNull();
    expect(screenOptionLabel(3)).toBeNull();
    expect(screenOptionLabel("a\u0007b")).toBeNull();
    expect(screenOptionLabel("a‮b")).toBeNull();
    const long = screenOptionLabel("x".repeat(600))!;
    expect([...long]).toHaveLength(MAX_OPTION_LABEL);
    expect(long.endsWith("…")).toBe(true);
    expect(screenOptionLabel("x".repeat(200))).toBe("x".repeat(200));
  });
});

describe("materialiseOptions", () => {
  it("sorts under a locale code V8 rejects instead of throwing", () => {
    for (const collate of ["en_AU", "x", "1"]) {
      const out = materialiseOptions(sourced(), [opt("b", "Beach"), opt("a", "Apple")], {
        collate,
      });
      expect(out.options?.map((o) => o.value)).toEqual(["a", "b"]);
    }
  });

  it("puts sourced entries first, then the extras", () => {
    const out = materialiseOptions(sourced({ options: [opt("any", "Any trip")] }), [
      opt("stry_1", "Safari"),
      opt("stry_2", "Beach"),
    ]);
    expect(out.options).toEqual([
      opt("stry_1", "Safari"),
      opt("stry_2", "Beach"),
      opt("any", "Any trip"),
    ]);
    expect(out.optionsFrom).toBeDefined();
  });

  it("lets an extra win a collision, so the editor's label stands", () => {
    const out = materialiseOptions(sourced({ options: [opt("stry_1", "Editor label")] }), [
      opt("stry_1", "Vendor label"),
      opt("stry_2", "Beach"),
    ]);
    expect(out.options).toEqual([opt("stry_2", "Beach"), opt("stry_1", "Editor label")]);
  });

  it("gives the extras only for an unavailable (null) list, and never not-asked", () => {
    const out = materialiseOptions(sourced({ options: [opt("any")] }), null, {
      emptyIsNotAsked: true,
    });
    expect(out.options).toEqual([opt("any")]);
    const bare = materialiseOptions(sourced(), null, { emptyIsNotAsked: true });
    expect(bare.options).toEqual([]);
    expect(bare.showIf).toBeUndefined();
  });

  it("with emptyIsNotAsked, an empty list and no extras is never asked; with extras it is", () => {
    expect(materialiseOptions(sourced(), [], { emptyIsNotAsked: true }).showIf).toEqual({
      any: [],
    });
    expect(
      materialiseOptions(sourced({ options: [opt("any")] }), [], { emptyIsNotAsked: true }).showIf,
    ).toBeUndefined();
    expect(materialiseOptions(sourced(), []).showIf).toBeUndefined();
    expect(
      materialiseOptions(sourced(), [opt("a")], { emptyIsNotAsked: true }).showIf,
    ).toBeUndefined();
  });

  it("collate re-sorts sourced entries by label and keeps membership; extras stay last", () => {
    const list = [opt("1", "Zèbre"), opt("2", "Éléphant"), opt("3", "Antilope")];
    const out = materialiseOptions(sourced({ options: [opt("x", "A-extra")] }), list, {
      collate: "fr",
    });
    expect(out.options?.map((o) => o.value)).toEqual(["3", "2", "1", "x"]);
    expect(materialiseOptions(sourced(), list).options?.map((o) => o.value)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("screens a sourced label: truncated at 200, the value standing in for a bad one", () => {
    const out = materialiseOptions(sourced(), [
      opt("a", "x".repeat(600)),
      opt("b", "bad\u0007"),
      opt("c", "   "),
    ]);
    expect([...out.options![0]!.label!]).toHaveLength(200);
    expect(out.options![1]!.label).toBe("b");
    expect(out.options![2]!.label).toBe("c");
  });

  it("does not mutate its input", () => {
    const field = sourced({ options: [opt("any")] });
    const before = JSON.stringify(field);
    materialiseOptions(field, [opt("a")], { emptyIsNotAsked: true });
    expect(JSON.stringify(field)).toBe(before);
  });
});

describe("hasUnavailableOptions", () => {
  const resolution = (optionsFrom?: object): Resolution =>
    ({
      stories: {},
      assetBase: "/a",
      forms: { f: { fields: [{ name: "q", optionsFrom }, { name: "r" }] } },
    }) as never;

  it("is true for one flagged question and false otherwise", () => {
    expect(hasUnavailableOptions(resolution({ source: "countries", unavailable: true }))).toBe(
      true,
    );
    expect(hasUnavailableOptions(resolution({ source: "countries" }))).toBe(false);
    expect(hasUnavailableOptions(resolution())).toBe(false);
    expect(hasUnavailableOptions({ stories: {}, assetBase: "/a" })).toBe(false);
  });
});
