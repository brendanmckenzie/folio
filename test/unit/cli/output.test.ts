import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, groupWebWrangler, host, STARTER } from "./fixtures";
import { REPO_ROOT } from "./load";

/**
 * Every command's `--json` answer is one JSON value on stdout and starts with its
 * `schema` string (spec 41 decision 14), including its refusals. Run through the
 * real binary, because the property is about the process's stdout: a warning
 * printed by the host's wrangler or vite would break it, and nothing in-process
 * would notice.
 */

afterAll(cleanup);

function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [path.join(REPO_ROOT, "bin/folio.mjs"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FOLIO_TOKEN: "", ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(stdout: string) {
  const value = JSON.parse(stdout);
  expect(Object.keys(value)[0]).toBe("schema");
  return value;
}

function blocksHost() {
  const root = host({ wrangler: groupWebWrangler() });
  mkdirSync(path.join(root, "src/blocks"), { recursive: true });
  for (const f of ["index.ts", "page.tsx", "hero.tsx", "prose.tsx"]) {
    writeFileSync(
      path.join(root, "src/blocks", f),
      readFileSync(path.join(STARTER, "src/blocks", f), "utf8"),
    );
  }
  return root;
}

describe("--json answers", () => {
  it("doctor: folio.doctor/1, under a named environment too", () => {
    const root = blocksHost();
    for (const args of [
      ["doctor", "--json"],
      ["doctor", "--json", "--env", "staging"],
    ]) {
      const r = cli(args, root);
      expect(json(r.stdout).schema).toBe("folio.doctor/1");
      expect(r.status).toBe(1);
    }
  });

  it("upgrade: folio.upgrade/1, for a plan and for a refusal", () => {
    const root = blocksHost();
    const plan = cli(["upgrade", "--json"], root);
    expect(json(plan.stdout)).toMatchObject({ schema: "folio.upgrade/1", hops: [] });
    expect(plan.status).toBe(0);
    const refused = cli(["upgrade", "--json", "--to", "v99.0.0"], root);
    expect(json(refused.stdout)).toMatchObject({ schema: "folio.upgrade/1", ok: false });
    expect(refused.status).toBe(1);
  });

  it("add block: folio.add-block/1, for a dry run and for a refusal", () => {
    const root = blocksHost();
    const dry = cli(["add", "block", "quote", "--json", "--dry-run", "--into", "page.body"], root);
    expect(json(dry.stdout)).toMatchObject({
      schema: "folio.add-block/1",
      written: false,
      ok: true,
    });
    expect(dry.status).toBe(0);
    writeFileSync(path.join(root, "src/blocks/index.ts"), "export const blocks = make();\n");
    const refused = cli(["add", "block", "quote", "--json"], root);
    expect(json(refused.stdout)).toMatchObject({ schema: "folio.add-block/1", ok: false });
    expect(refused.status).toBe(1);
  });

  it("preview block: folio.preview-block/1, when nothing answers", () => {
    const root = blocksHost();
    const r = cli(["preview", "block", "hero", "--json", "--url", "http://127.0.0.1:9"], root, {
      FOLIO_TOKEN: "t",
    });
    expect(json(r.stdout)).toMatchObject({ schema: "folio.preview-block/1", ok: false });
    expect(r.status).toBe(1);
  });

  it("usage errors exit 2 and leave stdout empty", () => {
    const root = blocksHost();
    for (const args of [
      ["doctor", "--json", "--check", "nope"],
      ["upgrade", "--json", "--to", "latest"],
      ["add", "block", "Quote", "--json"],
      ["add", "block", "quote", "--json", "--brand", "x", "--blocks", "nope.ts"],
      ["preview", "block", "hero", "--json"],
    ]) {
      const r = cli(args, root);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
    }
  });
});
