import { describe, expect, it, vi } from "vitest";
import {
  decodeAccess,
  encodeAccess,
  isPublicEffective,
  parseAccessQuery,
  validateAccessValue,
} from "../../../src/server/asset-access";
import type { AssetAccessDomain } from "../../../src/server/gate";

const select: AssetAccessDomain = {
  primitive: "string",
  public: "public",
  options: [
    { value: "public", label: "Everyone" },
    { value: "members", label: "Members" },
  ],
};
const num: AssetAccessDomain = { primitive: "number", public: 0 };
const bool: AssetAccessDomain = { primitive: "boolean", public: false };

describe("access values", () => {
  it("round-trips the primitive through JSON text", () => {
    expect(encodeAccess("members")).toBe('"members"');
    expect(encodeAccess(3)).toBe("3");
    expect(encodeAccess(true)).toBe("true");
    expect(decodeAccess('"members"')).toBe("members");
    expect(decodeAccess(null)).toBeNull();
  });

  it("decodes an unreadable value as undefined, logging once", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    expect(decodeAccess("{nope", logger as never)).toBeUndefined();
    expect(decodeAccess("{nope", logger as never)).toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("is public when null or the gate's public value, never when unreadable", () => {
    expect(isPublicEffective(null, "public")).toBe(true);
    expect(isPublicEffective('"public"', "public")).toBe(true);
    expect(isPublicEffective('"members"', "public")).toBe(false);
    expect(isPublicEffective("{nope", "public", { error() {} } as never)).toBe(false);
    // Strict: a string "0" is not the number 0.
    expect(isPublicEffective('"0"', 0)).toBe(false);
    expect(isPublicEffective("0", 0)).toBe(true);
  });
});

describe("validateAccessValue", () => {
  it("accepts an option and refuses another, naming the allowed ones", () => {
    expect(validateAccessValue(select, "members")).toBe("members");
    expect(() => validateAccessValue(select, "premium")).toThrow(/"public", "members"/);
  });
  it("refuses the wrong primitive", () => {
    expect(() => validateAccessValue(select, 3)).toThrow(/access must be/);
    expect(() => validateAccessValue(num, "3")).toThrow(/a number/);
    expect(() => validateAccessValue(num, Number.NaN)).toThrow(/a number/);
    expect(validateAccessValue(bool, true)).toBe(true);
  });
  it("caps free text at 200 characters", () => {
    const text: AssetAccessDomain = { primitive: "string", public: "" };
    expect(validateAccessValue(text, "x".repeat(200))).toHaveLength(200);
    expect(() => validateAccessValue(text, "x".repeat(201))).toThrow(/200/);
  });
});

describe("parseAccessQuery", () => {
  it("types the query string by the gate field's primitive", () => {
    expect(parseAccessQuery(select, "members")).toBe("members");
    expect(parseAccessQuery(num, "3")).toBe(3);
    expect(parseAccessQuery(bool, "true")).toBe(true);
    expect(parseAccessQuery(bool, "false")).toBe(false);
  });
  it("refuses what does not parse", () => {
    expect(() => parseAccessQuery(num, "x")).toThrow();
    expect(() => parseAccessQuery(num, "")).toThrow();
    expect(() => parseAccessQuery(bool, "yes")).toThrow();
    expect(() => parseAccessQuery(select, "premium")).toThrow();
  });
});
