import { describe, expect, it } from "vitest";
import type { FieldCondition } from "../../../src/core/conditions";
import { conditionRefusal, matches, readCondition } from "../../../src/core/conditions";
import type { Json } from "../../../src/core/doc";

// conditional-fields.md's architecture decision 1: a condition is data, never
// a function, evaluated by this one pure predicate. Sibling fields only
// (checkpoint 2) — `matches` never reaches beyond the `data` it is handed.

describe("matches: eq", () => {
  it("is true when the field equals the given value", () => {
    expect(matches({ field: "layout", eq: "split" }, { layout: "split" })).toBe(true);
  });

  it("is false when the field differs", () => {
    expect(matches({ field: "layout", eq: "split" }, { layout: "full" })).toBe(false);
  });

  it("compares deeply against object and array values", () => {
    const data = { target: { kind: "story", id: "1" } };
    expect(matches({ field: "target", eq: { kind: "story", id: "1" } }, data)).toBe(true);
    expect(matches({ field: "target", eq: { kind: "story", id: "2" } }, data)).toBe(false);
    expect(matches({ field: "tags", eq: ["a", "b"] }, { tags: ["a", "b"] })).toBe(true);
    expect(matches({ field: "tags", eq: ["a", "b"] }, { tags: ["a", "c"] })).toBe(false);
  });

  it("treats a boolean field with eq: true correctly (the documented idiom)", () => {
    expect(matches({ field: "featured", eq: true }, { featured: true })).toBe(true);
    expect(matches({ field: "featured", eq: true }, { featured: false })).toBe(false);
  });
});

describe("matches: ne", () => {
  it("is true when the field differs from the given value", () => {
    expect(matches({ field: "layout", ne: "split" }, { layout: "full" })).toBe(true);
  });

  it("is false when the field equals the given value", () => {
    expect(matches({ field: "layout", ne: "split" }, { layout: "split" })).toBe(false);
  });
});

describe("matches: in", () => {
  it("is true when the field is one of the listed values", () => {
    const cond: FieldCondition = { field: "layout", in: ["split", "video"] };
    expect(matches(cond, { layout: "split" })).toBe(true);
    expect(matches(cond, { layout: "video" })).toBe(true);
  });

  it("is false when the field matches none of the listed values", () => {
    const cond: FieldCondition = { field: "layout", in: ["split", "video"] };
    expect(matches(cond, { layout: "full" })).toBe(false);
  });

  it("compares each candidate deeply", () => {
    const cond: FieldCondition = { field: "target", in: [{ id: "1" }, { id: "2" }] };
    expect(matches(cond, { target: { id: "2" } })).toBe(true);
    expect(matches(cond, { target: { id: "3" } })).toBe(false);
  });
});

describe("matches: isSet", () => {
  // The full matrix the spec calls out: "empty" is ambiguous across kinds, so
  // null/undefined/''/[] read as not-set, but 0 and false are set.
  const notSet: Json[] = [null, "", []];

  it("reads null, undefined, empty string and empty array as not set", () => {
    for (const value of notSet) {
      expect(matches({ field: "v", isSet: true }, { v: value })).toBe(false);
    }
    expect(matches({ field: "v", isSet: true }, {})).toBe(false); // missing entirely: undefined
  });

  it("reads 0 and false as set", () => {
    expect(matches({ field: "v", isSet: true }, { v: 0 })).toBe(true);
    expect(matches({ field: "v", isSet: true }, { v: false })).toBe(true);
  });

  it("reads a non-empty string, array or object as set", () => {
    expect(matches({ field: "v", isSet: true }, { v: "x" })).toBe(true);
    expect(matches({ field: "v", isSet: true }, { v: [1] })).toBe(true);
    expect(matches({ field: "v", isSet: true }, { v: { a: 1 } })).toBe(true);
  });

  it("isSet: false inverts every case", () => {
    expect(matches({ field: "v", isSet: false }, { v: null })).toBe(true);
    expect(matches({ field: "v", isSet: false }, { v: 0 })).toBe(false);
  });
});

describe("matches: combinators", () => {
  it("all requires every sub-condition to hold", () => {
    const cond: FieldCondition = {
      all: [
        { field: "layout", eq: "split" },
        { field: "image", isSet: true },
      ],
    };
    expect(matches(cond, { layout: "split", image: "x.png" })).toBe(true);
    expect(matches(cond, { layout: "split", image: "" })).toBe(false);
    expect(matches(cond, { layout: "full", image: "x.png" })).toBe(false);
  });

  it("any requires at least one sub-condition to hold", () => {
    const cond: FieldCondition = {
      any: [
        { field: "layout", eq: "split" },
        { field: "layout", eq: "video" },
      ],
    };
    expect(matches(cond, { layout: "video" })).toBe(true);
    expect(matches(cond, { layout: "full" })).toBe(false);
  });

  it("not inverts its sub-condition", () => {
    const cond: FieldCondition = { not: { field: "layout", eq: "split" } };
    expect(matches(cond, { layout: "full" })).toBe(true);
    expect(matches(cond, { layout: "split" })).toBe(false);
  });

  it("nests arbitrarily", () => {
    const cond: FieldCondition = {
      all: [
        {
          any: [
            { field: "layout", eq: "split" },
            { field: "layout", eq: "video" },
          ],
        },
        { not: { field: "archived", eq: true } },
      ],
    };
    expect(matches(cond, { layout: "split", archived: false })).toBe(true);
    expect(matches(cond, { layout: "video", archived: true })).toBe(false);
    expect(matches(cond, { layout: "full", archived: false })).toBe(false);
  });

  it("an empty all is vacuously true, an empty any is vacuously false", () => {
    expect(matches({ all: [] }, {})).toBe(true);
    expect(matches({ any: [] }, {})).toBe(false);
  });
});

describe("matches: unknown shapes", () => {
  it("evaluates false, never throws, for a field the data does not have", () => {
    expect(() => matches({ field: "nope", eq: "x" }, { layout: "split" })).not.toThrow();
    expect(matches({ field: "nope", eq: "x" }, { layout: "split" })).toBe(false);
  });

  it("evaluates false, never throws, for a condition object it does not recognise", () => {
    // A schema can be newer than the admin bundle reading it: an operator this
    // build has never heard of must not crash the inspector.
    const unknown = { field: "layout", startsWith: "sp" } as unknown as FieldCondition;
    expect(() => matches(unknown, { layout: "split" })).not.toThrow();
    expect(matches(unknown, { layout: "split" })).toBe(false);

    const emptyObject = {} as unknown as FieldCondition;
    expect(matches(emptyObject, {})).toBe(false);
  });
});

describe("matches: includes", () => {
  it("is true when the answer is an array containing the value", () => {
    expect(matches({ field: "tags", includes: "b" }, { tags: ["a", "b"] })).toBe(true);
    expect(matches({ field: "tags", includes: "c" }, { tags: ["a", "b"] })).toBe(false);
  });

  it("is false for a non-array answer or a missing one", () => {
    expect(matches({ field: "tags", includes: "a" }, { tags: "a" })).toBe(false);
    expect(matches({ field: "tags", includes: "a" }, {})).toBe(false);
  });

  it("leaves eq and in alone: they still compare the whole value", () => {
    expect(matches({ field: "tags", eq: "a" }, { tags: ["a"] })).toBe(false);
    expect(matches({ field: "tags", in: ["a"] }, { tags: ["a"] })).toBe(false);
  });
});

describe("conditionRefusal", () => {
  it("accepts every well formed shape", () => {
    for (const c of [
      { field: "a", eq: "x" },
      { field: "a", ne: 3 },
      { field: "a", in: ["x", 1, true, null] },
      { field: "a", isSet: false },
      { field: "a", includes: "x" },
      { all: [{ field: "a", eq: 1 }, { any: [{ field: "b", isSet: true }] }] },
      { not: { field: "a", eq: 1 } },
    ]) {
      expect(conditionRefusal(c), JSON.stringify(c)).toBeNull();
    }
  });

  it("refuses each malformed shape", () => {
    for (const c of [
      null,
      "x",
      [],
      {},
      { field: "a" },
      { field: 3, eq: 1 },
      { field: "", eq: 1 },
      { field: "a", eq: 1, ne: 2 },
      { field: "a", eq: { nested: true } },
      { field: "a", in: "x" },
      { field: "a", in: [{}] },
      { field: "a", isSet: "yes" },
      { all: "x" },
      { all: [], any: [] },
      { not: 3 },
      { field: "a", bogus: 1 },
    ]) {
      expect(conditionRefusal(c), JSON.stringify(c)).not.toBeNull();
    }
  });

  it("bounds depth, size and the length of an in list", () => {
    let deep: unknown = { field: "a", eq: 1 };
    for (let i = 0; i < 3; i++) deep = { not: deep };
    expect(conditionRefusal(deep)).toBeNull();
    expect(conditionRefusal({ not: deep })).toMatch(/deep/);

    const wide = { all: Array.from({ length: 32 }, () => ({ field: "a", eq: 1 })) };
    expect(conditionRefusal(wide)).toMatch(/parts/);
    const ok = { all: Array.from({ length: 30 }, () => ({ field: "a", eq: 1 })) };
    expect(conditionRefusal(ok)).toBeNull();

    const upTo = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(conditionRefusal({ field: "a", in: upTo(100) })).toBeNull();
    expect(conditionRefusal({ field: "a", in: upTo(101) })).not.toBeNull();
  });
});

describe("readCondition", () => {
  it("rebuilds known nodes key by key", () => {
    expect(
      readCondition({
        all: [
          { field: "a", eq: "x", extra: 1 },
          { field: "b", includes: "y" },
        ],
        junk: 1,
      }),
    ).toEqual({
      all: [
        { field: "a", eq: "x" },
        { field: "b", includes: "y" },
      ],
    });
  });

  it("turns an unrecognised leaf into a node that is never true", () => {
    const never = readCondition({ field: "a", gt: 3 });
    expect(never).toEqual({ any: [] });
    expect(matches(never as FieldCondition, { a: 5 })).toBe(false);
  });

  it("answers undefined for anything that is not an object", () => {
    for (const raw of [undefined, null, "x", 3, [], true]) {
      expect(readCondition(raw)).toBeUndefined();
    }
  });

  it("bounds depth instead of recursing without limit", () => {
    let deep: unknown = { field: "a", eq: 1 };
    for (let i = 0; i < 50; i++) deep = { not: deep };
    expect(() => readCondition(deep)).not.toThrow();
  });

  it("never throws on arbitrary input", () => {
    const cyclic: Record<string, unknown> = { all: [] };
    (cyclic.all as unknown[]).push(cyclic);
    for (const raw of [
      cyclic,
      { all: [null, 1, "x"] },
      { not: undefined },
      { field: "a", in: [{}] },
    ]) {
      expect(() => readCondition(raw)).not.toThrow();
    }
  });
});
