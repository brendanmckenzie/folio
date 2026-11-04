/**
 * The new commands' entry points: flags in, an exit code out (spec 41 decision 14).
 *
 *   0  success (doctor: no `fail`; warnings allowed)
 *   1  the command ran and found, or hit, a failure
 *   2  usage error: an unknown flag, a bad name, an unreadable project root
 *
 * Under `--json` the one JSON value is the whole of stdout.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyPlan } from "./apply.mjs";
import { parse, UsageError } from "./args.mjs";
import { CHECK_IDS, databasesByEnvironment, doctor, readVite } from "./doctor.mjs";
import { readLedger } from "./ledger.mjs";
import { classifyPin } from "./pin.mjs";
import { PlanRefusal, planUpgrade, UPGRADE_SCHEMA } from "./plan.mjs";
import { readProject } from "./project.mjs";
import { describeFix, noteStream, renderChecks, shellQuote, writeJson } from "./report.mjs";
import { run as realRun } from "./run.mjs";
import { parse as parseVersion } from "./semver.mjs";

/**
 * @typedef {{ cliVersion: string, pkgRoot: string, cwd?: string,
 *   run?: import("./run.mjs").Runner, fetch?: typeof fetch,
 *   readers?: import("./project.mjs").Readers, env?: Record<string, string | undefined>,
 *   stdout?: { write(s: string): unknown } }} Runtime
 */

function projectAt(dir, rt, opts) {
  const root = path.resolve(rt.cwd ?? process.cwd(), dir ?? ".");
  const project = readProject(root, { ...opts, readers: rt.readers });
  if (!project) throw new UsageError(`${root} has no readable package.json`);
  return project;
}

/** `folio doctor [dir]` */
export async function doctorCommand(argv, rt) {
  const { values, positionals } = parse(argv, {
    json: { type: "boolean" },
    env: { type: "string" },
    config: { type: "string" },
    "persist-to": { type: "string" },
    remote: { type: "boolean" },
    url: { type: "string" },
    base: { type: "string" },
    site: { type: "string" },
    check: { type: "string", multiple: true },
  });
  for (const id of values.check ?? []) {
    if (!CHECK_IDS.includes(id)) {
      throw new UsageError(`unknown check "${id}". Checks: ${CHECK_IDS.join(", ")}`);
    }
  }
  if (values.url && !/^https?:\/\//.test(values.url)) {
    throw new UsageError(`--url must be an http(s) origin, not "${values.url}"`);
  }
  const project = projectAt(positionals[0], rt, {
    config: values.config,
    persistTo: values["persist-to"],
  });
  const result = await doctor(project, {
    cliVersion: rt.cliVersion,
    ledger: readLedger(rt.pkgRoot),
    env: values.env ?? null,
    remote: Boolean(values.remote),
    url: values.url ?? null,
    base: values.base ?? null,
    site: values.site ?? null,
    token: (rt.env ?? process.env).FOLIO_TOKEN || null,
    only: values.check ?? null,
    config: values.config ?? null,
    run: rt.run ?? realRun,
    fetch: rt.fetch,
  });
  const out = rt.stdout ?? process.stdout;
  if (values.json) writeJson(result, out);
  else {
    out.write(
      `folio doctor ${result.cli}: ${result.installed ? `folio ${result.installed} installed` : "folio not installed"} in ${result.project}${result.env ? `, env ${result.env}` : ""}\n\n`,
    );
    out.write(`${renderChecks(result.checks)}\n\n`);
    const s = result.summary;
    out.write(`${s.pass} pass, ${s.warn} warn, ${s.fail} fail, ${s.skip} skip\n`);
  }
  return result.ok ? 0 : 1;
}

/** `folio upgrade [dir]` */
export async function upgradeCommand(argv, rt) {
  const { values, positionals } = parse(argv, {
    json: { type: "boolean" },
    to: { type: "string" },
    apply: { type: "boolean" },
    "allow-dirty": { type: "boolean" },
    env: { type: "string" },
    config: { type: "string" },
  });
  const to = values.to?.replace(/^v/, "");
  if (to !== undefined && !parseVersion(to)) {
    throw new UsageError(`--to takes a release such as v1.4.0, not "${values.to}"`);
  }
  const project = projectAt(positionals[0], rt, { config: values.config });
  const run = rt.run ?? realRun;
  const out = rt.stdout ?? process.stdout;
  const notes = noteStream(values.json);
  const ledger = readLedger(rt.pkgRoot);

  const pin = project.dep?.spec ?? null;
  const pinned = pin ? classifyPin(pin) : null;
  const from = project.installed?.version ?? (pinned?.kind === "tag" ? pinned.version : null);
  const agentsFile =
    ["AGENTS.md", "CLAUDE.md"].find((f) => {
      const file = path.join(project.root, f);
      return existsSync(file) && readFileSync(file, "utf8").includes("<!-- folio:begin -->");
    }) ?? null;

  let plan;
  try {
    plan = planUpgrade({
      ledger,
      cliVersion: rt.cliVersion,
      from,
      to,
      pin,
      packageManager: project.packageManager,
      wranglerBin: project.wranglerBin,
      root: project.root,
      typecheck: Boolean(project.pkg.scripts?.typecheck),
      agentsFile,
      base: await basePathOf(project),
      databases: await databasesByEnvironment(project),
      env: values.env ?? null,
      config: values.config ?? null,
    });
  } catch (err) {
    if (!(err instanceof PlanRefusal)) throw err;
    return refuse(err, {
      cli: rt.cliVersion,
      from,
      to: to ?? rt.cliVersion,
      mode: values.apply ? "apply" : "plan",
    });
  }

  let ok = true;
  if (values.apply) {
    try {
      ok = await applyPlan(plan, project, {
        run,
        allowDirty: Boolean(values["allow-dirty"]),
        note: (line) => notes.write(`${line}\n`),
        doctor: (checks) =>
          doctor(readProject(project.root, { config: values.config, readers: rt.readers }), {
            cliVersion: rt.cliVersion,
            ledger,
            env: values.env ?? null,
            only: checks,
            config: values.config ?? null,
            run,
            fetch: rt.fetch,
          }),
      });
    } catch (err) {
      if (!(err instanceof PlanRefusal)) throw err;
      return refuse(err, { cli: rt.cliVersion, from, to: plan.to, mode: "apply" });
    }
  }
  plan.ok = ok;
  if (values.json) writeJson(plan, out);
  else out.write(renderPlan(plan));
  return ok ? 0 : 1;

  function refuse(err, head) {
    const answer = {
      schema: UPGRADE_SCHEMA,
      ...head,
      ok: false,
      error: { message: err.message, fix: err.fix },
    };
    if (values.json) writeJson(answer, out);
    else {
      out.write(`folio upgrade: ${err.message}\n`);
      for (const step of err.fix) out.write(`  → ${describeFix(step)}\n`);
    }
    return 1;
  }
}

/** The base path the host's Vite plugin reports, for printed reindex steps. */
async function basePathOf(project) {
  const v = await readVite(project);
  return (v.ok && v.api?.basePath) || "/folio";
}

function renderPlan(plan) {
  const lines = [`folio upgrade ${plan.cli}: v${plan.from} → v${plan.to} (${plan.mode})`, ""];
  if (!plan.hops.length) {
    lines.push("Already at the target. Nothing to do.");
    return `${lines.join("\n")}\n`;
  }
  plan.hops.forEach((hop, i) => {
    lines.push(
      `Hop ${i + 1}${plan.hops.length > 1 ? ` of ${plan.hops.length}` : ""}: to v${hop.to} (${hop.releases.map((r) => `v${r}`).join(", ")})`,
    );
    if (hop.rollForwardOnly)
      lines.push(
        "  Roll-forward only: an older pin cannot be redeployed over the migrated database.",
      );
    if (hop.migrations.length) {
      lines.push("  Migrations:");
      for (const m of hop.migrations) lines.push(`    ${m.file}  (v${m.release}, ${m.apply})`);
    }
    if (hop.read.length) {
      lines.push("  Read first:");
      for (const r of hop.read) lines.push(`    ${r.heading}\n      ${r.url}`);
    }
    for (const phase of ["local", "deploy", "post-deploy"]) {
      const steps = hop.steps.filter((s) => s.phase === phase);
      if (!steps.length) continue;
      lines.push(
        phase === "local"
          ? `  Local steps${plan.mode === "plan" ? " (what --apply runs)" : ""}:`
          : `  ${phase === "deploy" ? "Deploy" : "After the deploy"} (never run by this command):`,
      );
      for (const s of steps) {
        const status = s.status && s.status !== "pending" ? ` [${s.status}]` : "";
        const what =
          s.kind === "run"
            ? shellQuote(s.argv)
            : s.kind === "edit"
              ? `set "folio" to "${s.after}" in ${s.file}`
              : s.kind === "doctor"
                ? `folio doctor --check ${s.checks.join(" --check ")}`
                : s.text;
        lines.push(`    ${s.id}${status}: ${what}`);
        if (s.status === "failed" && s.output) lines.push(s.output.replace(/^/gm, "      | "));
      }
    }
    lines.push("");
  });
  if (plan.claimed.length) {
    lines.push("Claimed, not yet shipped:");
    for (const c of plan.claimed) lines.push(`  ${c.file}: ${c.rule}`);
    lines.push("");
  }
  if (plan.next) lines.push(plan.next, "");
  if (plan.mode === "plan")
    lines.push("Dry run: nothing was changed. Pass --apply to run the local steps.");
  return `${lines.join("\n")}\n`;
}
