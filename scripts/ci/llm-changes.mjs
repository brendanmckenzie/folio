#!/usr/bin/env node
/**
 * Which LLM tasks does this PR touch (Operate O39/O40)? Prints `llm=true|false`
 * and `llm_tasks=a,b` for $GITHUB_OUTPUT.
 *
 * A task is marked when its `llm-tasks.json` entry differs between base and
 * head, when a changed path is its `prompt` or `tools` file or sits under its
 * `eval` directory, or when its model's entry in the price table changed. A
 * root file (package.json, a lockfile) marks nothing, so a dependency bump does
 * not spend eval money.
 *
 *   node scripts/ci/llm-changes.mjs <base-sha> [head-ref]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const REGISTRY = "src/server/llm-tasks.json";
const [base, head = "HEAD"] = process.argv.slice(2);
if (!base) {
  console.error("usage: llm-changes.mjs <base-sha> [head-ref]");
  process.exit(2);
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const show = (ref, path) => {
  try {
    return JSON.parse(git("show", `${ref}:${path}`));
  } catch {
    return null;
  }
};

const changed = git("diff", "--name-only", `${base}...${head}`).split("\n").filter(Boolean);
const before = show(base, REGISTRY);
const after = show(head, REGISTRY);
const pricesPath = after?.prices ?? before?.prices;
const pricesBefore = pricesPath ? show(base, pricesPath) : null;
const pricesAfter = pricesPath ? show(head, pricesPath) : null;

const marked = [];
for (const task of after?.tasks ?? []) {
  const old = before?.tasks.find((t) => t.id === task.id);
  const hit =
    !old ||
    JSON.stringify(old) !== JSON.stringify(task) ||
    changed.some(
      (p) => p === task.prompt || p === task.tools || (task.eval && p.startsWith(`${task.eval}/`)),
    ) ||
    JSON.stringify(pricesBefore?.models?.[task.model]) !==
      JSON.stringify(pricesAfter?.models?.[task.model]);
  if (hit) marked.push(task.id);
}

const lines = [`llm=${marked.length > 0}`, `llm_tasks=${marked.join(",")}`];
console.log(lines.join("\n"));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
