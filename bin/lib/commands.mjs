/**
 * The new commands' entry points: flags in, an exit code out (spec 41 decision 14).
 *
 *   0  success (doctor: no `fail`; warnings allowed)
 *   1  the command ran and found, or hit, a failure
 *   2  usage error: an unknown flag, a bad name, an unreadable project root
 *
 * Under `--json` the one JSON value is the whole of stdout.
 */
import path from "node:path";
import { parse, UsageError } from "./args.mjs";
import { CHECK_IDS, doctor } from "./doctor.mjs";
import { readLedger } from "./ledger.mjs";
import { readProject } from "./project.mjs";
import { renderChecks, writeJson } from "./report.mjs";
import { run as realRun } from "./run.mjs";

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
