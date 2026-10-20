#!/usr/bin/env node
/**
 * The LLM eval harness (Operate O39/O40).
 *
 *   node scripts/llm/eval.mjs --task media.describe --models a,b [--max-usd 2.00] [--issue N --comment]
 *   node scripts/llm/eval.mjs --gate --tasks media.describe [--max-usd 2.00]
 *
 * Dispatch mode runs a task's suite against each named model and prints (and,
 * with `--comment`, posts to the issue) one table. Gate mode runs each task with
 * the model the registry names and compares with the suite's `baseline.json`.
 * Both write their raw results to `eval-out/`, which CI uploads as an artifact.
 *
 * The suite is `<task.eval>/{suite.json,run.mjs,score.mjs,cases/*}`; see
 * `evals/media.describe`. Spend is summed from the usage each call reports,
 * priced from the registry's `prices` file, and the run stops before the next
 * call once the cap is reached. A model with no price entry is "unpriced",
 * never guessed.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "eval-out");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const { values: args } = parseArgs({
  options: {
    task: { type: "string" },
    models: { type: "string" },
    tasks: { type: "string" },
    gate: { type: "boolean", default: false },
    "max-usd": { type: "string", default: "2.00" },
    issue: { type: "string" },
    comment: { type: "boolean", default: false },
  },
});
const maxUsd = Number(args["max-usd"]);
if (!Number.isFinite(maxUsd) || maxUsd <= 0) fail("--max-usd must be a positive number");

const registry = readJson(join(ROOT, "src/server/llm-tasks.json"));
const prices = readJson(join(ROOT, registry.prices));

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** USD for one call's reported usage, or null when the model has no price entry. */
function costOf(model, usage) {
  const p = prices.models[model];
  if (!p || !usage) return p ? 0 : null;
  const micro =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheCreationInputTokens * p.cacheWrite5m +
    usage.cacheReadInputTokens * p.cacheRead;
  return micro / 1e12;
}

/** The adapter under test: the TypeScript source, bundled in memory (it imports JSON). */
async function loadDescriber() {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [join(ROOT, "src/server/describe-anthropic.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return mod.anthropicDescriber;
}

const median = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Runs every case for one model. `budget.spent` is shared across models in a
 * dispatch run so the cap is per run, not per model.
 */
async function runModel(suite, taskDef, model, client, budget) {
  const casesDir = join(ROOT, taskDef.eval, "cases");
  const { runCase } = await import(pathToFileURL(join(ROOT, taskDef.eval, "run.mjs")).href);
  const { score } = await import(pathToFileURL(join(ROOT, taskDef.eval, "score.mjs")).href);
  const names = readdirSync(casesDir).sort();
  const results = [];
  let capped = null;
  let unpriced = false;

  for (const name of names) {
    if (budget.spent >= maxUsd) {
      capped = `capped at USD ${maxUsd.toFixed(2)} after ${results.length} of ${names.length} cases`;
      break;
    }
    const dir = join(casesDir, name);
    const input = { ...readJson(join(dir, "input.json")), dir };
    const expected = readJson(join(dir, "expected.json"));
    let run;
    for (let attempt = 0; attempt < 3; attempt++) {
      run = await runCase(model, input, client);
      const cost = costOf(model, run.usage);
      if (cost === null) unpriced = true;
      else budget.spent += cost;
      if (!run.contractErrors.some((e) => e.transient)) break;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
    const scored = score(run.output, expected, input);
    results.push({
      case: name,
      pass: scored.pass,
      metrics: scored.metrics,
      costUsd: costOf(model, run.usage),
      latencyMs: run.latencyMs,
      contractErrors: run.contractErrors,
      usage: run.usage,
      output: run.output,
    });
    console.log(
      `  ${model} ${name}: ${scored.pass ? "pass" : "FAIL"}` +
        (run.contractErrors.length ? ` [${run.contractErrors.map((e) => e.kind).join(",")}]` : ""),
    );
  }

  const costs = results.map((r) => r.costUsd).filter((c) => c !== null);
  const errors = results.flatMap((r) => r.contractErrors);
  const kindCounts = {};
  for (const e of errors) kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
  const toolCall = errors.filter((e) => e.kind === "tool-call").length;
  const summary = {
    model,
    cases: results.length,
    of: names.length,
    metrics: {
      passRate: results.length ? results.filter((r) => r.pass).length / results.length : 0,
      tagF1: mean(results.map((r) => r.metrics.tagF1)),
      factRecall: mean(results.map((r) => r.metrics.factRecall)),
    },
    passRate: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    contractFailures: errors.length,
    contractFailureSplit: { toolCall, schema: errors.length - toolCall },
    contractFailureKinds: kindCounts,
    meanUsd: unpriced ? null : mean(costs),
    totalUsd: unpriced ? null : costs.reduce((a, b) => a + b, 0),
    latencyP50: median(
      results.map((r) => r.latencyMs),
      0.5,
    ),
    latencyP95: median(
      results.map((r) => r.latencyMs),
      0.95,
    ),
    capped,
    results,
  };
  return summary;
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const usd = (n) => (n === null ? "unpriced" : `$${n.toFixed(4)}`);

function renderTable(task, summaries, spent) {
  const first = summaries[0];
  const rows = [
    ["Metric", ...summaries.map((s) => `\`${s.model}\``)],
    [
      "Pass rate",
      ...summaries.map(
        (s, i) =>
          `${pct(s.passRate)} (${s.cases}/${s.of} cases)${i ? ` ${delta(s.passRate - first.passRate)}` : ""}`,
      ),
    ],
    [
      "Tag F1 (mean)",
      ...summaries.map(
        (s, i) =>
          `${s.metrics.tagF1.toFixed(2)}${i ? ` ${delta(s.metrics.tagF1 - first.metrics.tagF1)}` : ""}`,
      ),
    ],
    [
      "Fact recall (mean)",
      ...summaries.map(
        (s, i) =>
          `${s.metrics.factRecall.toFixed(2)}${i ? ` ${delta(s.metrics.factRecall - first.metrics.factRecall)}` : ""}`,
      ),
    ],
    [
      "Cost per case (mean / total)",
      ...summaries.map((s) => `${usd(s.meanUsd)} / ${usd(s.totalUsd)}`),
    ],
    [
      "Latency p50 / p95",
      ...summaries.map((s) => `${s.latencyP50 ?? "n/a"} ms / ${s.latencyP95 ?? "n/a"} ms`),
    ],
    [
      "Contract failures: tool-call",
      ...summaries.map((s) => String(s.contractFailureSplit.toolCall)),
    ],
    [
      "Contract failures: schema",
      ...summaries.map((s) => `${s.contractFailureSplit.schema}${kinds(s)}`),
    ],
  ];
  const table = rows
    .map((r, i) => `| ${r.join(" | ")} |${i === 0 ? `\n|${r.map(() => "---|").join("")}` : ""}`)
    .join("\n");
  const notes = summaries
    .filter((s) => s.capped)
    .map((s) => `\n${s.model}: ${s.capped}`)
    .join("");
  return `### llm-eval: ${task}\n\n${table}\n\nTotal spend: ${usd(spent)} (cap $${maxUsd.toFixed(2)}).${notes}\n`;
}
const delta = (d) => `(${d >= 0 ? "+" : ""}${(d * 100).toFixed(0)} pts)`;
const kinds = (s) => {
  const entries = Object.entries(s.contractFailureKinds);
  return entries.length ? ` (${entries.map(([k, v]) => `${k} ${v}`).join(", ")})` : "";
};

function writeOut(name, data) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
}

function taskOf(id) {
  const found = registry.tasks.find((t) => t.id === id);
  if (!found) fail(`llm-tasks.json has no task "${id}"`);
  return found;
}

function stepSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function runUrl() {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = process.env;
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : null;
}

function needKey() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) fail("ANTHROPIC_API_KEY is empty: the eval key is missing, so this is not a pass");
  return apiKey;
}

async function dispatch() {
  if (!args.task || !args.models) fail("dispatch mode needs --task and --models");
  const taskDef = taskOf(args.task);
  if (!taskDef.eval) {
    console.log("No eval suite: this candidate cannot be judged");
    return;
  }
  const suite = readJson(join(ROOT, taskDef.eval, "suite.json"));
  const client = { apiKey: needKey(), anthropicDescriber: await loadDescriber() };
  const budget = { spent: 0 };
  const summaries = [];
  for (const model of args.models
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)) {
    console.log(`${taskDef.id}: ${model}`);
    summaries.push(await runModel(suite, taskDef, model, client, budget));
  }
  writeOut(`${taskDef.id}.dispatch.json`, { task: taskDef.id, spent: budget.spent, summaries });
  const table = renderTable(taskDef.id, summaries, budget.spent);
  console.log(`\n${table}`);
  stepSummary(table);
  if (args.comment) {
    const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
    if (!token || !repo || !args.issue)
      fail("--comment needs --issue, GITHUB_TOKEN and GITHUB_REPOSITORY");
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${args.issue}/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: table }),
    });
    if (!res.ok) fail(`posting the comment failed: ${res.status}`);
    console.log(`commented on #${args.issue}`);
  }
}

async function gate() {
  if (!args.tasks) fail("--gate needs --tasks");
  const client = { apiKey: needKey(), anthropicDescriber: await loadDescriber() };
  const budget = { spent: 0 };
  let failed = false;
  for (const id of args.tasks
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)) {
    const taskDef = taskOf(id);
    if (!taskDef.eval) {
      console.log(`${id}: no eval suite, nothing to gate`);
      continue;
    }
    const suite = readJson(join(ROOT, taskDef.eval, "suite.json"));
    console.log(`${id}: ${taskDef.model}`);
    const s = await runModel(suite, taskDef, taskDef.model, client, budget);
    writeOut(`${id}.${taskDef.model}.json`, s);
    const table = renderTable(id, [s], budget.spent);
    console.log(`\n${table}`);
    stepSummary(table);

    if (s.capped) {
      console.error(`::error::${id}: ${s.capped}; the result is incomplete`);
      failed = true;
      continue;
    }
    const baselinePath = join(ROOT, taskDef.eval, "baseline.json");
    if (!existsSync(baselinePath)) {
      writeOut("baseline.candidate.json", {
        model: s.model,
        metrics: s.metrics,
        passRate: s.passRate,
        contractFailures: s.contractFailures,
        measured: new Date().toISOString().slice(0, 10),
        runUrl: runUrl(),
      });
      console.error(
        `::error::${id}: no baseline.json. The measured numbers are in eval-out/baseline.candidate.json`,
      );
      failed = true;
      continue;
    }
    const baseline = readJson(baselinePath);
    console.log(
      `${id}: baseline passRate ${pct(baseline.passRate)}, contract failures ${baseline.contractFailures} (${baseline.model}); this run passRate ${pct(s.passRate)}, contract failures ${s.contractFailures}`,
    );
    if (baseline.model !== s.model) {
      console.error(
        `::error::${id}: baseline.json is for ${baseline.model} but the registry says ${s.model}`,
      );
      failed = true;
    }
    if (s.passRate < baseline.passRate - suite.tolerance - 1e-9) {
      console.error(
        `::error::${id}: pass rate ${pct(s.passRate)} fell below the baseline ${pct(baseline.passRate)} minus ${pct(suite.tolerance)}`,
      );
      failed = true;
    }
    if (s.contractFailures > 0 && baseline.contractFailures === 0) {
      console.error(
        `::error::${id}: ${s.contractFailures} contract failure(s) where the baseline had none`,
      );
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

if (args.gate) await gate();
else await dispatch();
