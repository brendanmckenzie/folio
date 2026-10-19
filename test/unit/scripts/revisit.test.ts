import { describe, expect, it } from "vitest";

type Decision = { action: "revisit" | "no-date" | "wait"; date: string | null };
type Mod = {
  decide: (body: string | null, today: string) => Decision;
  melbourneToday: (now?: Date) => string;
  parseRevisit: (body: string | null) => string | null;
};
// A computed specifier keeps the untyped .mjs out of the typechecker's way.
const path = "../../../scripts/github/revisit.mjs";
const { decide, melbourneToday, parseRevisit } = (await import(/* @vite-ignore */ path)) as Mod;

describe("parseRevisit", () => {
  it("reads the line anywhere in the body", () => {
    expect(parseRevisit("Why\n\nRevisit: 2027-01-04\n\nmore")).toBe("2027-01-04");
    expect(parseRevisit("Revisit: 2027-01-04")).toBe("2027-01-04");
    expect(parseRevisit("a\r\nRevisit: 2027-01-04\r\nb")).toBe("2027-01-04");
  });
  it("returns null with no line, a null body or a loose form", () => {
    expect(parseRevisit("nothing here")).toBeNull();
    expect(parseRevisit(null)).toBeNull();
    expect(parseRevisit("revisit: 2027-01-04")).toBeNull();
    expect(parseRevisit("see Revisit: 2027-01-04")).toBeNull();
    expect(parseRevisit("Revisit: 2027-01-04 or so")).toBeNull();
  });
  it("rejects malformed and impossible dates", () => {
    expect(parseRevisit("Revisit: 2027-1-4")).toBeNull();
    expect(parseRevisit("Revisit: 2027-13-01")).toBeNull();
    expect(parseRevisit("Revisit: 2027-02-30")).toBeNull();
  });
});

describe("decide", () => {
  const body = "Revisit: 2027-01-04";
  it("waits for a future date", () => {
    expect(decide(body, "2027-01-03")).toEqual({ action: "wait", date: "2027-01-04" });
  });
  it("revisits on the day", () => {
    expect(decide(body, "2027-01-04").action).toBe("revisit");
  });
  it("revisits a past date", () => {
    expect(decide(body, "2027-01-05").action).toBe("revisit");
    expect(decide(body, "2028-01-01").action).toBe("revisit");
  });
  it("flags a missing or malformed date", () => {
    expect(decide("nope", "2027-01-04")).toEqual({ action: "no-date", date: null });
    expect(decide("Revisit: soon", "2027-01-04").action).toBe("no-date");
  });
});

describe("melbourneToday", () => {
  it("is already the next day in Melbourne at 20:00 UTC (AEDT)", () => {
    expect(melbourneToday(new Date("2027-01-03T20:00:00Z"))).toBe("2027-01-04");
  });
  it("uses AEST in winter", () => {
    expect(melbourneToday(new Date("2027-07-01T13:59:00Z"))).toBe("2027-07-01");
    expect(melbourneToday(new Date("2027-07-01T14:00:00Z"))).toBe("2027-07-02");
  });
});
