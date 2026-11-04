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
import {
  ADD_BLOCK_SCHEMA,
  AddBlockRefusal,
  applyEdits,
  planAddBlock,
  unifiedDiff,
} from "./blocks.mjs";
import {
  blocksModules,
  CHECK_IDS,
  databasesByEnvironment,
  doctor,
  readVite,
  resolveModuleFile,
} from "./doctor.mjs";
import { readLedger } from "./ledger.mjs";
import { classifyPin } from "./pin.mjs";
import { PlanRefusal, planUpgrade, UPGRADE_SCHEMA } from "./plan.mjs";
import { PREVIEW_SCHEMA, PreviewError, parseViewport, previewBlock } from "./preview.mjs";
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

const PREVIEW_FLAGS = {
  url: { type: "string" },
  site: { type: "string" },
  base: { type: "string" },
  fields: { type: "string" },
  viewport: { type: "string" },
  keep: { type: "boolean" },
};

/** `folio add block <name>` */
export async function addBlockCommand(argv, rt) {
  const { values, positionals } = parse(
    argv,
    {
      json: { type: "boolean" },
      brand: { type: "string" },
      blocks: { type: "string" },
      into: { type: "string" },
      label: { type: "string" },
      "dry-run": { type: "boolean" },
      preview: { type: "boolean" },
      ...PREVIEW_FLAGS,
    },
    { positionals: 2 },
  );
  const [what, name] = positionals;
  if (what !== "block") throw new UsageError(`add takes "block", as in \`folio add block <name>\``);
  if (!name) throw new UsageError("add block needs a name, as in `folio add block quote`");
  if (values.preview && !values.url) throw new UsageError("--preview needs --url <origin>");
  const previewOpts = values.preview ? previewOptions(values) : null;
  const project = projectAt(".", rt, {});
  const out = rt.stdout ?? process.stdout;
  const notes = noteStream(values.json);
  const located = await locateModule(project, values);

  const answer = {
    schema: ADD_BLOCK_SCHEMA,
    name,
    module: located.module,
    files: [],
    written: false,
    preview: null,
  };
  let planned;
  try {
    planned = planAddBlock({
      module: located.module,
      name,
      label: values.label,
      into: values.into,
    });
  } catch (err) {
    if (!(err instanceof AddBlockRefusal)) throw err;
    return finish({ ...answer, ok: false, error: { message: err.message, fix: err.fix } }, 1);
  }
  answer.files = planned.files.map((f) => ({
    path: f.path,
    action: f.action,
    ...(f.before !== null ? { diff: unifiedDiff(f.before, f.after) } : {}),
  }));
  if (!values["dry-run"]) {
    applyEdits(planned.files);
    answer.written = true;
  }
  if (previewOpts && answer.written) {
    try {
      answer.preview = await previewBlock({
        ...previewOpts,
        base: previewOpts.base ?? located.basePath,
        name,
        into: values.into ?? null,
        token: (rt.env ?? process.env).FOLIO_TOKEN || null,
        fetch: rt.fetch,
        note: (line) => notes.write(`${line}\n`),
      });
    } catch (err) {
      if (!(err instanceof PreviewError)) throw err;
      return finish({ ...answer, ok: false, error: { message: err.message, fix: err.fix } }, 1);
    }
  }
  return finish({ ...answer, ok: true }, 0);

  function finish(result, code) {
    if (values.json) writeJson(result, out);
    else {
      if (result.error) {
        out.write(`folio add block: ${result.error.message}\n`);
        for (const step of result.error.fix ?? []) out.write(`  → ${describeFix(step)}\n`);
      }
      for (const f of result.files) {
        out.write(
          `${result.written ? (f.action === "create" ? "created" : "edited ") : `would ${f.action}`} ${f.path}\n`,
        );
        if (f.diff && !result.written) out.write(`${f.diff.replace(/^/gm, "    ")}\n`);
      }
      if (result.preview) out.write(`preview: ${result.preview.image ?? result.preview.html}\n`);
    }
    return code;
  }
}

/** `folio preview block <name>` */
export async function previewBlockCommand(argv, rt) {
  const { values, positionals } = parse(
    argv,
    { json: { type: "boolean" }, into: { type: "string" }, ...PREVIEW_FLAGS },
    { positionals: 2 },
  );
  const [what, name] = positionals;
  if (what !== "block")
    throw new UsageError(`preview takes "block", as in \`folio preview block <name>\``);
  if (!name) throw new UsageError("preview block needs a name");
  if (!values.url)
    throw new UsageError("preview block needs --url <origin>; it is never defaulted");
  const opts = previewOptions(values);
  const out = rt.stdout ?? process.stdout;
  const notes = noteStream(values.json);
  let base = opts.base;
  if (!base) {
    const project = readProject(rt.cwd ?? process.cwd(), { readers: rt.readers });
    const v = project ? await readVite(project) : null;
    base = (v?.ok && v.api?.basePath) || "/folio";
  }
  const head = { schema: PREVIEW_SCHEMA, name };
  try {
    const preview = await previewBlock({
      ...opts,
      base,
      name,
      into: values.into ?? null,
      token: (rt.env ?? process.env).FOLIO_TOKEN || null,
      fetch: rt.fetch,
      note: (line) => notes.write(`${line}\n`),
    });
    if (values.json) writeJson({ ...head, ok: true, preview }, out);
    else
      out.write(
        `${preview.image ?? preview.html}\n${preview.kept ? `kept ${preview.documentId}\n` : ""}`,
      );
    return 0;
  } catch (err) {
    if (!(err instanceof PreviewError)) throw err;
    if (values.json) {
      writeJson(
        { ...head, ok: false, preview: null, error: { message: err.message, fix: err.fix } },
        out,
      );
    } else {
      out.write(`folio preview block: ${err.message}\n`);
      for (const step of err.fix) out.write(`  → ${describeFix(step)}\n`);
    }
    return 1;
  }
}

function previewOptions(values) {
  if (values.url && !/^https?:\/\//.test(values.url)) {
    throw new UsageError(`--url must be an http(s) origin, not "${values.url}"`);
  }
  let fields = null;
  if (values.fields !== undefined) {
    try {
      fields = JSON.parse(values.fields);
    } catch {
      throw new UsageError("--fields takes a JSON object of the block's field values");
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new UsageError("--fields takes a JSON object of the block's field values");
    }
  }
  const viewport = values.viewport === undefined ? null : parseViewport(values.viewport);
  if (values.viewport !== undefined && !viewport) {
    throw new UsageError(
      `--viewport takes <width>x<height>, such as 390x844, not "${values.viewport}"`,
    );
  }
  return {
    url: values.url,
    site: values.site ?? null,
    base: values.base ?? null,
    fields,
    viewport,
    keep: Boolean(values.keep),
  };
}

/** The blocks module to edit: --blocks, else the one the Vite plugin names. */
async function locateModule(project, values) {
  if (values.blocks) {
    const module = path.resolve(project.root, values.blocks);
    if (!existsSync(module)) throw new UsageError(`--blocks ${values.blocks}: no such file`);
    return { module, basePath: values.base ?? null };
  }
  const v = await readVite(project);
  if (!v.ok || !v.api) {
    throw new UsageError(
      v.ok
        ? "the installed Folio's Vite plugin does not say where the blocks module is (it predates its api property): pass --blocks <path>"
        : "no Vite config with the folio plugin was found here: pass --blocks <path>",
    );
  }
  const modules = blocksModules(v.api);
  let chosen;
  if (values.brand) {
    chosen = modules.find(([brand]) => brand === values.brand);
    if (!chosen) {
      throw new UsageError(
        `no brand "${values.brand}" in the plugin's blocks: ${modules.map(([b]) => b).join(", ")}`,
      );
    }
  } else if (modules.length === 1) {
    chosen = modules[0];
  } else {
    throw new UsageError(
      `the plugin's blocks names ${modules.length} brands; pass --brand <${modules.map(([b]) => b).join("|")}>`,
    );
  }
  const module = resolveModuleFile(v.root, chosen[1]);
  if (!module) {
    throw new UsageError(
      `cannot resolve the blocks module ${chosen[1]} from ${v.root}: pass --blocks <path>`,
    );
  }
  return { module, basePath: v.api.basePath ?? null };
}
