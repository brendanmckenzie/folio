import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NARROW_QUERY, railShown } from "../../../src/admin/ui/narrow";

describe("railShown", () => {
  it("is the rail at a narrow width whatever was remembered", () => {
    expect(railShown(true, false)).toBe(true);
    expect(railShown(true, true)).toBe(true);
  });

  it("follows the remembered value when wide", () => {
    expect(railShown(false, false)).toBe(false);
    expect(railShown(false, true)).toBe(true);
  });
});

describe("the breakpoint", () => {
  it("is the same width in the stylesheet as in the hook", () => {
    const css = readFileSync("src/admin/ui/Shell.module.css", "utf8");
    expect(css).toContain(`@media ${NARROW_QUERY}`);
  });
});
