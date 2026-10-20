#!/usr/bin/env node
// Converges the labels on brendanmckenzie/folio to exactly the set below.
// Idempotent: run it as often as you like. Labels not in the set are deleted,
// unless an open issue still uses them, in which case they are kept and reported.
//
//   node scripts/github/labels.mjs [--dry-run] [--repo owner/name]
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const repoIdx = args.indexOf("--repo");
const repo = repoIdx >= 0 ? args[repoIdx + 1] : "brendanmckenzie/folio";

const LABELS = [
  // Core
  ["type:bug", "d73a4a", "Something is broken"],
  ["type:change", "0e8a16", "A change or new capability"],
  ["type:question", "d876e3", "A question needing an answer"],
  ["type:chore", "c5def5", "Maintenance, tooling or docs"],
  [
    "p1",
    "b60205",
    "User blocked now, money or customer page wrong, or PII at risk: same working day",
  ],
  ["p2", "d93f0b", "Wrong but has a workaround: this week"],
  ["p3", "fbca04", "Backlog"],
  ["source:github", "c2e0c6", "Filed directly on GitHub"],
  ["status:triaged", "bfdadc", "Triaged and ready to work"],
  ["status:needs-info", "e4e669", "Waiting on more information"],
  ["deferred", "cccccc", "Parked until the Revisit date"],
  ["deps-major", "fbca04", "Major dependency update, needs a manual look"],
  ["incident", "b60205", "Incident record"],
  ["source:radar", "c2e0c6", "Filed by the quarterly radar"],
  // Library extras: the 1.0 punch list
  ["1.0", "d93f0b", "Wanted in the 1.0 release"],
  ["1.0-blocker", "b60205", "Must be resolved before a 1.0 can be tagged"],
  ["post-1.0", "0e8a16", "Deferred past 1.0"],
  // LLM task lifecycle (Operate O36 to O44)
  ["source:llm-watch", "5319e7", "Filed by the LLM model watch"],
  ["eval-gap", "fef2c0", "An LLM task with no eval suite yet"],
];

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8" });
const ghJson = (...a) => JSON.parse(gh(...a));
const enc = encodeURIComponent;

const existing = new Map(
  ghJson("api", "--paginate", "--slurp", `repos/${repo}/labels?per_page=100`)
    .flat()
    .map((l) => [l.name, l]),
);

for (const [name, color, description] of LABELS) {
  const cur = existing.get(name);
  if (cur && cur.color.toLowerCase() === color && (cur.description ?? "") === description) {
    console.log(`ok       ${name}`);
    continue;
  }
  console.log(`${cur ? "update  " : "create  "} ${name}`);
  if (dryRun) continue;
  if (cur) {
    gh(
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/labels/${enc(name)}`,
      "-f",
      `color=${color}`,
      "-f",
      `description=${description}`,
    );
  } else {
    gh(
      "api",
      "-X",
      "POST",
      `repos/${repo}/labels`,
      "-f",
      `name=${name}`,
      "-f",
      `color=${color}`,
      "-f",
      `description=${description}`,
    );
  }
}

const wanted = new Set(LABELS.map(([n]) => n));
const kept = [];
for (const name of existing.keys()) {
  if (wanted.has(name)) continue;
  const open = ghJson(
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--label",
    name,
    "--limit",
    "200",
    "--json",
    "number",
  );
  if (open.length > 0) {
    const nums = open.map((i) => `#${i.number}`).join(", ");
    console.log(`KEPT     ${name} (used by open issues: ${nums})`);
    kept.push(name);
    continue;
  }
  console.log(`delete   ${name}`);
  if (!dryRun) gh("api", "-X", "DELETE", `repos/${repo}/labels/${enc(name)}`);
}

if (kept.length > 0) {
  console.log(`\n${kept.length} label(s) not in the set were kept because open issues use them.`);
  process.exitCode = 1;
}
