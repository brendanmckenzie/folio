import { describe, expect, it } from "vitest";
import { lib } from "./load";

const { satisfies, compare, parse } = await lib<{
  satisfies: (v: string, range: string) => boolean | "unknown";
  compare: (a: string, b: string) => number;
  parse: (v: string) => number[] | null;
}>("semver");

describe("semver, the subset doctor needs", () => {
  it("evaluates the package's own engines range", () => {
    const range = ">=26.12.0 <27";
    expect(satisfies("26.11.9", range)).toBe(false);
    expect(satisfies("26.12.0", range)).toBe(true);
    expect(satisfies("26.13.0", range)).toBe(true);
    expect(satisfies("27.0.0", range)).toBe(false);
  });

  it("evaluates || and bare versions", () => {
    expect(satisfies("18.4.0", ">=20 || 18")).toBe(true);
    expect(satisfies("19.0.0", ">=20 || 18")).toBe(false);
    expect(satisfies("22.1.0", ">= 20")).toBe(true);
    expect(satisfies("26.1.0", ">26")).toBe(false);
    expect(satisfies("27.0.0", ">26")).toBe(true);
  });

  it("answers unknown for syntax outside the subset", () => {
    expect(satisfies("26.12.0", "^26")).toBe("unknown");
    expect(satisfies("26.12.0", "26.x")).toBe("unknown");
    expect(satisfies("26.12.0", "26.0.0 - 27.0.0")).toBe("unknown");
  });

  it("orders versions numerically, not as text", () => {
    expect(compare("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compare("v1.3.0", "1.3.0")).toBe(0);
    expect(parse("1.3")).toBeNull();
  });
});
