import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_IDS } from "../../src/server/llm-tasks";

/**
 * Operate O37: the registry is the only place a model id is written, and the
 * model watch reads it. Everything here is a property the watch relies on.
 */
const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const registry = JSON.parse(read("src/server/llm-tasks.json"));
const prices = JSON.parse(read(registry.prices));

const MODEL_ID = /\bclaude-(opus|sonnet|haiku|fable|mythos)-[0-9][0-9a-z-]*/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "docs",
  "evals",
  "migrations",
  ".wrangler",
  ".vite",
]);
const SKIP_FILES = new Set(["llm-tasks.json", "llm-prices.json", "pnpm-lock.yaml"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|mts|mjs|js|json|css|html|ya?ml)$/.test(name)) yield path;
  }
}

describe("llm-tasks.json", () => {
  it("has the fields the watch reads, with unique dotted ids", () => {
    expect(registry.ledger.kind).toBe("host");
    expect(typeof registry.watch).toBe("boolean");
    const ids = registry.tasks.map((t: { id: string }) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of registry.tasks) {
      expect(t.id).toMatch(/^[a-z]+(\.[a-z]+)+$/);
      for (const key of ["purpose", "vendor", "model", "line", "prompt"]) {
        expect(typeof t[key], `${t.id}.${key}`).toBe("string");
      }
      if (t.vendor === "anthropic") expect(t.candidateLines.length).toBeGreaterThan(0);
      expect(t.eval !== null || t.evalGapIssue !== null, `${t.id} needs eval or evalGapIssue`).toBe(
        true,
      );
      // Folio spends nothing itself, so a null budget is only valid with a host or none ledger.
      if (t.budget === null) expect(["host", "none"]).toContain(registry.ledger.kind);
      expect(existsSync(join(ROOT, t.prompt)), `${t.id}.prompt`).toBe(true);
      if (t.tools) expect(existsSync(join(ROOT, t.tools)), `${t.id}.tools`).toBe(true);
    }
  });

  it("agrees with the TaskId union in llm-tasks.ts", () => {
    expect(registry.tasks.map((t: { id: string }) => t.id).sort()).toEqual([...TASK_IDS].sort());
  });

  it("prices every task's model", () => {
    for (const t of registry.tasks) {
      expect(
        prices.models[t.model],
        `${t.id}: ${t.model} missing from llm-prices.json`,
      ).toBeDefined();
    }
  });

  it("is the only source that names a model", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel.startsWith("test/") || /\.test\.[a-z]+$/.test(rel)) continue;
      if (MODEL_ID.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("has every file that calls the Messages API read its model from the loader", () => {
    for (const file of walk(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      if (!/api\.anthropic\.com\/v1\/messages|messages\.(create|stream)\(/.test(text)) continue;
      expect(text, relative(ROOT, file)).toMatch(/from "\.\/llm-tasks"/);
    }
  });

  it("keeps baseline.json on the registry's model", () => {
    for (const t of registry.tasks) {
      if (!t.eval) continue;
      expect(existsSync(join(ROOT, t.eval, "suite.json")), `${t.id}: ${t.eval}/suite.json`).toBe(
        true,
      );
      const baseline = JSON.parse(read(`${t.eval}/baseline.json`));
      expect(baseline.model, `${t.id}: a model change must update the baseline`).toBe(t.model);
    }
  });
});
