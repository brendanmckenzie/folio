import { describe, expect, it } from "vitest";
import type { Doc, Json } from "../../../src/core/doc";
import {
  DRAFT_STRING_MAX,
  draftDataOf,
  draftIndexedValues,
} from "../../../src/core/index-projection";

/**
 * `stories.draft_data` (migration 0015, issue #82): what the schema-blind Durable
 * Object keeps of a draft, and how the list read turns it back into cell values.
 */

function doc(data: Record<string, Json>, i18n?: Record<string, Record<string, Json>>): Doc {
  return {
    root: "r",
    bloks: {
      r: {
        uid: "r",
        type: "person",
        parent: null,
        slot: null,
        order: "a0",
        data,
        ...(i18n ? { i18n } : {}),
      },
    },
  };
}

describe("draftDataOf", () => {
  it("keeps strings, finite numbers and booleans, and nothing else", () => {
    const json = draftDataOf(
      doc({
        name: "Ada",
        years: 36,
        active: true,
        bio: { type: "doc" },
        tags: ["a"],
        gone: null,
        nan: Number.NaN,
      }),
    );
    expect(JSON.parse(json ?? "null")).toEqual({ data: { name: "Ada", years: 36, active: true } });
  });

  it("cuts a long string rather than dropping it", () => {
    const parsed = JSON.parse(draftDataOf(doc({ note: "x".repeat(2000) })) ?? "null");
    expect(parsed.data.note).toHaveLength(DRAFT_STRING_MAX);
  });

  it("carries a locale's scalars beside the source ones", () => {
    const parsed = JSON.parse(
      draftDataOf(doc({ name: "Ada" }, { fr: { name: "Adèle", rich: {} } })) ?? "null",
    );
    expect(parsed).toEqual({ data: { name: "Ada" }, i18n: { fr: { name: "Adèle" } } });
  });

  it("is null when there is nothing scalar to mirror, and for a document with no root", () => {
    expect(draftDataOf(doc({ bio: { type: "doc" } }))).toBeNull();
    expect(draftDataOf({ root: "missing", bloks: {} })).toBeNull();
  });

  it("stays under its ceiling for an enormous block", () => {
    const data: Record<string, Json> = {};
    for (let i = 0; i < 400; i++) data[`f${i}`] = "y".repeat(500);
    expect((draftDataOf(doc(data)) ?? "").length).toBeLessThan(40_000);
  });
});

describe("draftIndexedValues", () => {
  const mirror = draftDataOf(doc({ name: "Ada", years: 36, active: false, due: "2026-10-22" }));

  it("projects exactly as a publish would: text for all, num for number, boolean and date", () => {
    expect(draftIndexedValues(mirror, ["name", "years", "active", "due"])).toEqual({
      name: { text: "Ada", num: null },
      years: { text: "36", num: 36 },
      active: { text: "false", num: 0 },
      due: { text: "2026-10-22", num: Date.parse("2026-10-22") },
    });
  });

  it("leaves a field the draft has no scalar for absent, rather than borrowing", () => {
    expect(draftIndexedValues(mirror, ["name", "role"])).toEqual({
      name: { text: "Ada", num: null },
    });
  });

  it("reads a declared locale from i18n", () => {
    const fr = draftDataOf(doc({ name: "Ada" }, { fr: { name: "Adèle" } }));
    expect(draftIndexedValues(fr, ["name"], "fr")).toEqual({ name: { text: "Adèle", num: null } });
  });

  it("is null for no mirror and for a mirror that is not JSON", () => {
    expect(draftIndexedValues(null, ["name"])).toBeNull();
    expect(draftIndexedValues("{nope", ["name"])).toBeNull();
  });
});
