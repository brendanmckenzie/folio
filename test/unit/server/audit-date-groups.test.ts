import { describe, expect, it } from "vitest";
import type { Blok, Doc, Json } from "../../../src/core/doc";
import type { Field } from "../../../src/core/fields";
import { date, text } from "../../../src/core/fields";
import type { SchemaIndex } from "../../../src/core/schema";
import { auditDocuments, auditSchema } from "../../../src/server/audit";

const grouped = (group: string | undefined): Field =>
  ({ ...text(), ...(group ? { group } : {}) }) as Field;

describe("audit: date-invalid", () => {
  const schema: SchemaIndex = {
    page: { name: "page", label: "Page", fields: {} },
    post: {
      name: "post",
      label: "Post",
      fields: { on: date(), at: date({ time: true }), plain: text() },
    },
  };
  const doc = (data: Record<string, Json>): { id: string; doc: Doc } => {
    const post: Blok = {
      uid: "p",
      type: "post",
      parent: "root",
      slot: "body",
      order: "a0",
      data,
    };
    return {
      id: "sty_1",
      doc: {
        root: "root",
        bloks: {
          root: { uid: "root", type: "page", parent: null, slot: null, order: "a0", data: {} },
          p: post,
        },
      },
    };
  };
  const invalid = (data: Record<string, Json>) =>
    auditDocuments([doc(data)], schema)
      .filter((f) => f.check === "date-invalid")
      .map((f) => f.field);

  it("reports values that are not the field's form or not a real date", () => {
    expect(invalid({ on: "2026-02-30", at: "2026-10-22", plain: "x" }).sort()).toEqual([
      "at",
      "on",
    ]);
    expect(invalid({ on: "22 Oct 2026" })).toEqual(["on"]);
  });

  it("is silent for valid, empty, null and absent values", () => {
    expect(invalid({ on: "2026-10-22", at: "2026-10-22T09:30:00Z" })).toEqual([]);
    expect(invalid({ on: "", at: null })).toEqual([]);
    expect(invalid({})).toEqual([]);
  });
});

describe("audit: group-split", () => {
  const run = (fields: Record<string, Field>) =>
    auditSchema({ blk: { name: "blk", label: "Blk", fields } }).filter(
      (f) => f.check === "group-split",
    );

  it("is silent for contiguous groups", () => {
    expect(run({ a: grouped(undefined), b: grouped("SEO"), c: grouped("SEO") })).toEqual([]);
  });

  it("reports a group resumed after another field, once per group", () => {
    const found = run({
      a: grouped("SEO"),
      b: grouped(undefined),
      c: grouped("SEO"),
      d: grouped("X"),
      e: grouped("SEO"),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ block: "blk", field: "c", note: "SEO" });
  });

  it("counts two adjacent groups as separate, not as a split", () => {
    expect(run({ a: grouped("A"), b: grouped("B") })).toEqual([]);
  });
});
