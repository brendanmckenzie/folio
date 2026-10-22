import { describe, expect, it } from "vitest";
import {
  controlFor,
  dateInputValue,
  dateStoredValue,
  groupRuns,
  visibleEntries,
} from "../../../src/admin/ui/screens/inspector-model";
import type { Field } from "../../../src/core/fields";
import { text } from "../../../src/core/fields";
import { dateError } from "../../../src/core/nested";

/**
 * `date`'s input conversion (local wall clock in, UTC out) and `group`'s runs.
 * Pure helpers, since no admin test mounts a component.
 */

describe("date input conversion", () => {
  it("is a native date input for a date-only field, with no conversion", () => {
    expect(controlFor("date")).toBe("date");
    expect(dateInputValue("2026-10-22", false)).toBe("2026-10-22");
    expect(dateStoredValue("2026-10-22", false)).toBe("2026-10-22");
    expect(dateInputValue("garbage", false)).toBe("");
    expect(dateStoredValue("", false)).toBe("");
  });

  it("stores a datetime-local value as a UTC instant the API accepts", () => {
    const stored = dateStoredValue("2026-10-22T09:30", true);
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(dateError(true, stored)).toBeNull();
    // Whatever the machine's zone, it is the same instant as the local reading.
    expect(Date.parse(stored)).toBe(new Date("2026-10-22T09:30").getTime());
  });

  it("round trips through the local zone", () => {
    for (const local of ["2026-10-22T09:30", "2026-01-05T00:00", "2026-12-31T23:59"]) {
      expect(dateInputValue(dateStoredValue(local, true), true)).toBe(local);
    }
  });

  it("shows a stored instant as the editor's wall clock", () => {
    const stored = "2026-10-22T09:30:00Z";
    const at = new Date(stored);
    const p = (n: number) => String(n).padStart(2, "0");
    expect(dateInputValue(stored, true)).toBe(
      `2026-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`,
    );
  });

  it("never produces a value the API would refuse", () => {
    expect(dateStoredValue("2026-10-22T", true)).toBe("");
    expect(dateStoredValue("not a date", true)).toBe("");
    expect(dateInputValue(null, true)).toBe("");
    expect(dateInputValue("nope", true)).toBe("");
  });
});

describe("groupRuns", () => {
  const f = (group?: string, extra: Partial<Field> = {}): Field =>
    ({ ...text(), ...(group ? { group } : {}), ...extra }) as Field;

  const fields: Record<string, Field> = {
    title: f(),
    metaTitle: f("SEO"),
    metaDesc: f("SEO"),
    body: f(),
    ogImage: f("SEO"),
  };

  it("makes consecutive same-group fields one run and splits on an interruption", () => {
    const runs = groupRuns(visibleEntries(fields, {}), {});
    expect(runs.map((r) => [r.group, r.entries.map(([n]) => n)])).toEqual([
      [null, ["title"]],
      ["SEO", ["metaTitle", "metaDesc"]],
      [null, ["body"]],
      ["SEO", ["ogImage"]],
    ]);
  });

  it("is empty only when every field in a grouped run is blank", () => {
    const data = { metaDesc: "x" };
    const runs = groupRuns(visibleEntries(fields, data), data);
    expect(runs.find((r) => r.entries[0]![0] === "metaTitle")!.empty).toBe(false);
    expect(runs.find((r) => r.entries[0]![0] === "ogImage")!.empty).toBe(true);
    expect(runs[0]!.empty).toBe(false);
  });

  it("draws no heading for a group whose fields are all hidden or showIf-false", () => {
    const hiddenFields: Record<string, Field> = {
      a: f("G", { hidden: true }),
      b: f("G", { showIf: { field: "a", eq: "yes" } }),
      c: f(),
    };
    const runs = groupRuns(visibleEntries(hiddenFields, { a: "no" }), { a: "no" });
    expect(runs.map((r) => r.group)).toEqual([null]);
  });
});
