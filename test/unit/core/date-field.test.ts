import { describe, expect, it } from "vitest";
import * as core from "../../../src/core";
import type { Blok, Doc } from "../../../src/core/doc";
import { date, text } from "../../../src/core/fields";
import { indexRowsFor, isIndexed, projectValue } from "../../../src/core/index-projection";
import { dateError, fieldShapeError } from "../../../src/core/nested";
import { EMPTY_RESOLUTION, resolveValue } from "../../../src/core/resolve";
import type { DocumentType, SchemaIndex } from "../../../src/core/schema";

/**
 * The `date` field: one stored form per mode, refused when it is not a real date,
 * projected so text and number sort the same way, and resolved as the stored string.
 */

describe("dateError", () => {
  it("accepts the empty string, and a real date-only value", () => {
    expect(dateError(false, "")).toBeNull();
    expect(dateError(undefined, "2026-10-22")).toBeNull();
    expect(dateError(false, "2028-02-29")).toBeNull();
  });

  it("refuses an impossible calendar date that Date.parse would roll over", () => {
    expect(dateError(false, "2026-02-30")).toBe("must be a real calendar date");
    expect(dateError(false, "2027-02-29")).toBe("must be a real calendar date");
    expect(dateError(false, "2026-13-01")).toBe("must be a real calendar date");
    expect(dateError(false, "2026-00-10")).toBe("must be a real calendar date");
  });

  it("refuses malformed strings and non-strings", () => {
    expect(dateError(false, "22/10/2026")).toMatch(/YYYY-MM-DD/);
    expect(dateError(false, "2026-10-22T09:30:00Z")).toMatch(/YYYY-MM-DD/);
    expect(dateError(false, " 2026-10-22")).toMatch(/YYYY-MM-DD/);
    expect(dateError(false, 20261022)).toMatch(/date string/);
  });

  it("with time, wants a UTC instant to the second", () => {
    expect(dateError(true, "2026-10-22T09:30:00Z")).toBeNull();
    expect(dateError(true, "2026-10-22")).toMatch(/YYYY-MM-DDTHH:mm:ssZ/);
    expect(dateError(true, "2026-10-22T09:30:00+10:00")).toMatch(/YYYY-MM-DDTHH:mm:ssZ/);
    expect(dateError(true, "2026-10-22T09:30:00.000Z")).toMatch(/YYYY-MM-DDTHH:mm:ssZ/);
    expect(dateError(true, "2026-10-22T24:00:00Z")).toBe("must be a real time of day");
    expect(dateError(true, "2026-10-22T09:60:00Z")).toBe("must be a real time of day");
    expect(dateError(true, "2026-02-30T09:30:00Z")).toBe("must be a real calendar date");
  });
});

describe("fieldShapeError on a date field", () => {
  it("is the API's refusal: null passes, a bad date does not", () => {
    expect(fieldShapeError(date(), null)).toBeNull();
    expect(fieldShapeError(date(), "2026-10-22")).toBeNull();
    expect(fieldShapeError(date(), "2026-02-30")).not.toBeNull();
    expect(fieldShapeError(date({ time: true }), "2026-10-22")).not.toBeNull();
  });
});

describe("the date builder", () => {
  it("is exported from folio/core and is indexable", () => {
    expect(core.date).toBe(date);
    expect(isIndexed(date({ indexed: true }))).toBe(true);
    expect(isIndexed(date())).toBe(false);
  });
});

describe("resolveValue", () => {
  it("passes the stored string through, empty when absent, so text to date is a builder change", () => {
    const f = date({ time: true });
    expect(resolveValue(f, "2026-10-22T09:30:00Z", EMPTY_RESOLUTION)).toBe("2026-10-22T09:30:00Z");
    expect(resolveValue(f, undefined, EMPTY_RESOLUTION)).toBe("");
    expect(resolveValue(text(), "2026-10-22", EMPTY_RESOLUTION)).toBe(
      resolveValue(date(), "2026-10-22", EMPTY_RESOLUTION),
    );
  });
});

describe("projection", () => {
  it("fills both columns for both forms, and text order agrees with number order", () => {
    const values = [
      "2026-01-05",
      "2026-02-28",
      "2026-10-22",
      "2027-01-01",
      "2026-10-22T09:30:00Z",
      "2026-10-22T09:30:01Z",
      "2026-10-23T00:00:00Z",
    ];
    const rows = values.map((v) => projectValue(v)!);
    for (const r of rows) expect(r.num).not.toBeNull();
    const byText = [...rows].sort((a, b) => (a.text < b.text ? -1 : 1)).map((r) => r.num);
    const byNum = [...rows].sort((a, b) => a.num! - b.num!).map((r) => r.num);
    expect(byText).toEqual(byNum);
    expect(projectValue("2026-10-22T09:30:00Z")).toEqual({
      text: "2026-10-22T09:30:00Z",
      num: Date.parse("2026-10-22T09:30:00Z"),
    });
  });

  it("indexes a date field on the root block", () => {
    const schema: SchemaIndex = {
      post: { name: "post", label: "Post", fields: { on: date({ indexed: true }) } },
    };
    const type: DocumentType = { name: "post", label: "Post", kind: "page", root: "post" };
    const root: Blok = {
      uid: "r",
      type: "post",
      parent: null,
      slot: null,
      order: "a0",
      data: { on: "2026-03-28" },
    };
    const doc: Doc = { root: "r", bloks: { r: root } };
    expect(indexRowsFor(doc, type, schema)).toEqual([
      expect.objectContaining({ field: "on", text: "2026-03-28", num: Date.parse("2026-03-28") }),
    ]);
  });
});
