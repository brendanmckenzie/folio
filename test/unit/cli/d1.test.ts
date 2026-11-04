import { describe, expect, it } from "vitest";
import { lib } from "./load";

type Parsed =
  | { ok: true; applied: string[] }
  | { ok: false; reason: "auth" | "locked" | "other"; message: string };
const { parseExecute, pending, unknown } = await lib<{
  parseExecute: (r: { status: number; stdout: string; stderr: string }, table?: string) => Parsed;
  pending: (shipped: string[], applied: string[]) => string[];
  unknown: (shipped: string[], applied: string[]) => string[];
}>("d1");

describe("reading wrangler d1 execute --json", () => {
  it("parses the verified success shape", () => {
    const stdout = JSON.stringify([
      {
        results: [{ name: "0001_init.sql" }, { name: "0015_draft_data.sql" }],
        success: true,
        meta: {},
      },
    ]);
    expect(parseExecute({ status: 0, stdout, stderr: "" })).toEqual({
      ok: true,
      applied: ["0001_init.sql", "0015_draft_data.sql"],
    });
  });

  it("reads the verified missing-table error as nothing applied", () => {
    const stdout = JSON.stringify({
      error: { text: "no such table: d1_migrations: SQLITE_ERROR" },
    });
    expect(parseExecute({ status: 1, stdout, stderr: "" })).toEqual({ ok: true, applied: [] });
    // A custom migrations_table is the one that has to be missing.
    expect(
      parseExecute(
        {
          status: 1,
          stdout: JSON.stringify({ error: { text: "no such table: other" } }),
          stderr: "",
        },
        "d1_migrations",
      ).ok,
    ).toBe(false);
  });

  it("tells an authentication error and a lock from anything else", () => {
    const auth = parseExecute({
      status: 1,
      stdout: "",
      stderr: "✘ [ERROR] You are not logged in. Run `wrangler login`.",
    });
    expect(auth).toMatchObject({ ok: false, reason: "auth" });
    const locked = parseExecute({
      status: 1,
      stdout: "",
      stderr: "SQLITE_BUSY: database is locked",
    });
    expect(locked).toMatchObject({ ok: false, reason: "locked" });
    expect(parseExecute({ status: 1, stdout: "", stderr: "boom" })).toMatchObject({
      reason: "other",
    });
  });
});

describe("pending and unknown", () => {
  const shipped = ["0001_init.sql", "0008_x.sql", "0010_forms.sql", "0013_site_brands.sql"];

  it("never counts a gap in the numbers as pending", () => {
    // 0009 and 0012 have no file, so they cannot be pending.
    expect(pending(shipped, ["0001_init.sql", "0008_x.sql", "0010_forms.sql"])).toEqual([
      "0013_site_brands.sql",
    ]);
  });

  it("reports Folio-shaped files the package does not ship, and ignores others", () => {
    expect(unknown(shipped, [...shipped, "0016_option_sources.sql", "seed"])).toEqual([
      "0016_option_sources.sql",
    ]);
  });
});
