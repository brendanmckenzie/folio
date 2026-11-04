import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lib, REPO_ROOT } from "./load";

type Args = {
  parse: (
    argv: string[],
    options: Record<string, { type: "string" | "boolean"; multiple?: boolean }>,
    limits?: { positionals?: number },
  ) => { values: Record<string, unknown>; positionals: string[] };
  UsageError: new (message: string) => Error & { exitCode: number };
};
const { parse, UsageError } = await lib<Args>("args");

const cli = (args: string[], cwd = REPO_ROOT) =>
  spawnSync("node", [path.join(REPO_ROOT, "bin/folio.mjs"), ...args], { cwd, encoding: "utf8" });

describe("per-command flags (spec 41 decision 11)", () => {
  it("answers the declared flags and positionals", () => {
    const got = parse(["app", "--email", "a@b.c", "--force"], {
      email: { type: "string" },
      force: { type: "boolean" },
    });
    expect(got.values).toEqual({ email: "a@b.c", force: true });
    expect(got.positionals).toEqual(["app"]);
  });

  it("refuses an undeclared flag, a missing value and a stray positional as usage errors", () => {
    const spec = { email: { type: "string" as const } };
    for (const argv of [["--remote"], ["--email"], ["--email", "--force"], ["a", "b"]]) {
      expect(() => parse(argv, spec)).toThrow(UsageError);
    }
  });

  it("exits 2 for a usage error and keeps init's flags", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "folio-cli-"));
    try {
      expect(cli(["init", path.join(dir, "a"), "--remote"]).status).toBe(2);
      expect(cli(["doctor", "--email", "x"]).status).toBe(2);
      expect(cli(["frobnicate"]).status).toBe(2);
      const made = cli(["init", path.join(dir, "b"), "--email", "a@b.c"]);
      expect(made.status).toBe(0);
      // A non-empty target is a refusal the command reached, not a usage error.
      expect(cli(["init", path.join(dir, "b")]).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
