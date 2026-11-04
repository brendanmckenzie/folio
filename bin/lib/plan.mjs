/**
 * `folio upgrade`'s plan: the releases between the installed Folio and a target,
 * turned into ordered steps. Pure: everything it needs is passed in, so
 * `plan.test.ts` drives it with fixture ledgers and environments.
 *
 * The target is this CLI's own version unless `--to` names an earlier release in
 * its ledger (spec 41 decision 6): the plan for vX.Y.Z comes from vX.Y.Z's ledger,
 * so the instruction is `npx github:brendanmckenzie/folio#vX.Y.Z upgrade`.
 *
 * Steps come in three phases. `local` steps touch only this machine and are what
 * `--apply` runs. `deploy` and `post-deploy` steps reach Cloudflare or a deployed
 * Worker, carry no `status`, and are never run by this command under any flag
 * (decision 7).
 */
import { releasesBetween } from "./ledger.mjs";
import { REPO_URL, SPEC } from "./project.mjs";
import { compare, parse as parseVersion } from "./semver.mjs";
import { slug } from "./upgrading.mjs";

export const UPGRADE_SCHEMA = "folio.upgrade/1";

/** The doctor checks `--apply` ends with: the package and the local database. */
export const APPLY_CHECKS = ["node.version", "package.pin", "package.installed", "d1.local"];

/** A plan this command will not make, with what to do instead. Exit 1. */
export class PlanRefusal extends Error {
  constructor(message, fix = []) {
    super(message);
    this.name = "PlanRefusal";
    this.fix = fix;
  }
}

/**
 * @param {{
 *   ledger: any, cliVersion: string, from: string | null, to?: string | null,
 *   pin: string | null, packageManager: string, wranglerBin: string, root: string,
 *   typecheck: boolean, agentsFile: string | null, base?: string,
 *   databases: { env: string | null, envs?: (string | null)[], database_name: string,
 *     database_id?: string | null, binding: string }[],
 *   missing?: (string | null)[], env?: string | null, config?: string | null,
 *   deployed?: string | null,
 * }} input
 */
export function planUpgrade(input) {
  const { ledger, cliVersion } = input;
  const to = input.to ?? cliVersion;
  const from = input.from;
  const run = (argv) => ({ kind: "run", local: true, cwd: input.root, argv });

  if (!from) {
    throw new PlanRefusal(
      "Folio is not installed in this project, so there is nothing to upgrade from.",
      [run([input.packageManager, "install"])],
    );
  }
  if (!parseVersion(from) || compare(from, "1.0.0") < 0) {
    throw new PlanRefusal(
      `The installed Folio is ${from}, which predates 1.0.0 and the upgrade ledger.`,
      [
        {
          kind: "manual",
          text: "Follow UPGRADING.md by hand to v1.0.0, then run upgrade.",
          docs: "node_modules/folio/UPGRADING.md#the-procedure",
        },
      ],
    );
  }
  if (compare(to, cliVersion) > 0) {
    throw new PlanRefusal(
      `v${to} is newer than this CLI (v${cliVersion}). The plan for a release comes from that release's own ledger.`,
      [run(["npx", `${SPEC}#v${to}`, "upgrade"])],
    );
  }
  if (!ledger.releases.some((r) => r.version === to)) {
    throw new PlanRefusal(
      `v${to} is not a release in this CLI's ledger. Releases: ${ledger.releases.map((r) => `v${r.version}`).join(", ")}.`,
    );
  }
  if (compare(to, from) < 0) {
    throw new PlanRefusal(
      `v${to} is below the installed v${from}. A downgrade is a rollback, which this command does not do.`,
      [
        {
          kind: "manual",
          text: "Read Rolling back: whether an older pin can run over this database depends on the releases in between.",
          docs: "node_modules/folio/UPGRADING.md#rolling-back",
        },
      ],
    );
  }

  const base = {
    schema: UPGRADE_SCHEMA,
    cli: cliVersion,
    from,
    to,
    mode: "plan",
    pin: { before: input.pin, after: `${SPEC}#v${to}` },
    hops: [],
    claimed: (ledger.claimed ?? []).map((c) => ({ file: c.file, rule: c.rule })),
  };
  if (compare(to, from) === 0) return base;

  const releases = releasesBetween(ledger, from, to);
  const gate = releases.findIndex(
    (r) => r.requiresDeployed && !provenDeployed(input.deployed, r.requiresDeployed),
  );
  const reach = gate === -1 ? releases : releases.slice(0, gate);
  if (gate !== -1) {
    const r = releases[gate];
    base.stop = {
      before: r.version,
      requiresDeployed: r.requiresDeployed,
      deployed: input.deployed ?? null,
      text: `v${r.version} must not be crossed into until v${r.requiresDeployed} or later is deployed and verified on every deployment. ${reach.length ? `This plan stops at v${reach.at(-1).version}. ` : ""}Deploy, verify, then run \`npx ${SPEC}#v${to} upgrade --url <a deployment>\` again: the server's own answer is the only proof this command accepts.`,
    };
  }
  if (reach.length) base.hops = [hopPlan(input, reach, { stop: base.stop ?? null })];
  return base;
}

/**
 * Whether a deployment is known to run `version` or later. Only a version the
 * deployed server reported counts (review M1): the installed copy says what this
 * machine has, not what any deployment runs, so it is never used here.
 */
function provenDeployed(deployed, version) {
  return Boolean(deployed && parseVersion(deployed) && compare(deployed, version) >= 0);
}

function hopPlan(input, releases, { stop }) {
  const { ledger } = input;
  const to = releases.at(-1).version;
  const versions = new Set(releases.map((r) => r.version));
  const migrations = Object.entries(ledger.migrations)
    .filter(([, m]) => versions.has(m.release))
    .map(([file, m]) => ({ file, release: m.release, apply: m.apply, after: m.after ?? [] }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const read = releases.flatMap((r) =>
    r.headings.map((heading) => ({
      release: r.version,
      heading,
      url: `${REPO_URL}/blob/v${r.version}/UPGRADING.md#${slug(heading)}`,
    })),
  );

  const envFlags = (env) => [
    ...(env ? ["--env", env] : []),
    ...(input.config ? ["--config", input.config] : []),
  ];
  const run = (id, argv, extra = {}) => ({
    id,
    phase: "local",
    kind: "run",
    local: true,
    argv,
    status: "pending",
    ...extra,
  });

  const steps = [
    {
      id: "pin",
      phase: "local",
      kind: "edit",
      file: "package.json",
      before: input.pin,
      after: `${SPEC}#v${to}`,
      status: "pending",
    },
    run("remove-installed", ["rm", "-rf", "node_modules/folio"]),
    run("install", [input.packageManager, "install"]),
  ];

  // The local database: the named environment's under --env, else the top level's,
  // else the first environment's, always applied under the environment it came from
  // so wrangler resolves the same binding (review M5).
  const envsOf = (d) => d.envs ?? [d.env];
  const localEnv =
    input.env ??
    (input.databases.some((d) => envsOf(d).includes(null))
      ? null
      : (input.databases[0]?.env ?? null));
  const localDb = input.databases.find((d) => envsOf(d).includes(localEnv));
  if (localDb) {
    steps.push(
      run("d1-local", [
        input.wranglerBin,
        "d1",
        "migrations",
        "apply",
        localDb.database_name,
        "--local",
        ...envFlags(localEnv),
      ]),
    );
  }
  if (input.agentsFile) {
    steps.push(
      run("agents", ["node", "node_modules/folio/bin/folio.mjs", "agents", input.agentsFile]),
    );
  }
  if (input.typecheck) steps.push(run("typecheck", [input.packageManager, "run", "typecheck"]));
  steps.push({
    id: "doctor",
    phase: "local",
    kind: "doctor",
    checks: APPLY_CHECKS,
    status: "pending",
  });

  // The remote half, printed and never run. One step per database (by id), applied
  // under the first environment that binds it; with --env, only that environment's.
  const remotes = input.env
    ? input.databases
        .filter((d) => envsOf(d).includes(input.env))
        .map((d) => ({ ...d, env: input.env, envs: [input.env] }))
    : input.databases;
  const missing = input.env ? (remotes.length ? [] : [input.env]) : (input.missing ?? []);
  if (migrations.length && (remotes.length === 0 || missing.length)) {
    const named = missing.map((e) => e ?? "the top level").join(", ");
    throw new PlanRefusal(
      remotes.length === 0 && !missing.length
        ? `v${to} brings ${migrations.length} migration(s), and the wrangler config declares no Folio database to apply them to.`
        : `v${to} brings ${migrations.length} migration(s), and ${named} has no Folio database in the wrangler config, so the plan cannot say where to apply them.`,
      [
        {
          kind: "run",
          local: true,
          cwd: input.root,
          argv: [
            "npx",
            "folio",
            "doctor",
            ...(missing[0] ? ["--env", missing[0]] : []),
            "--check",
            "wrangler.d1",
          ],
        },
      ],
    );
  }
  const withDeploy = migrations.filter((m) => m.apply === "with-deploy");
  const remoteStep = (d) => ({
    id: `d1-remote:${d.env ?? "top-level"}`,
    phase: "deploy",
    kind: "run",
    local: false,
    env: d.env,
    argv: [
      input.wranglerBin,
      "d1",
      "migrations",
      "apply",
      d.database_name,
      "--remote",
      ...envFlags(d.env),
    ],
  });
  if (migrations.length && withDeploy.length) {
    // Apply, then deploy immediately, environment by environment (0011's rule).
    for (const d of remotes) {
      steps.push({ ...remoteStep(d), before: `deploy:${d.env ?? "top-level"}` });
      steps.push({
        id: `deploy:${d.env ?? "top-level"}`,
        phase: "deploy",
        kind: "manual",
        env: d.env,
        text: `Deploy the Worker${d.env ? ` to ${d.env}` : ""} immediately after the migration above, with nothing in between: ${withDeploy.map((m) => m.file).join(", ")} is applied with the deploy.`,
      });
    }
  } else {
    if (migrations.length) {
      for (const d of remotes) steps.push({ ...remoteStep(d), before: "deploy" });
    }
    const envs = [...new Set(remotes.flatMap((d) => envsOf(d).map((e) => e ?? "the top level")))];
    steps.push({
      id: "deploy",
      phase: "deploy",
      kind: "manual",
      text: migrations.length
        ? `Deploy the Worker${envs.length > 1 ? ` to each environment (${envs.join(", ")})` : ""}, after the remote migrations above.`
        : "Deploy the Worker. This hop brings no migrations.",
    });
  }

  // After the deploy: one reindex for every migration that asks for one.
  const reindexing = migrations.filter((m) => m.after.some((a) => a.kind === "reindex"));
  if (reindexing.length) {
    const drafts = reindexing.some((m) => m.after.some((a) => a.kind === "reindex" && a.drafts));
    const basePath = input.base ?? "/folio";
    steps.push({
      id: "reindex",
      phase: "post-deploy",
      kind: "reindex",
      drafts,
      method: "POST",
      path: `${basePath}/api/reindex${drafts ? "?drafts=1" : ""}`,
      migrations: reindexing.map((m) => m.file),
      text: `POST ${basePath}/api/reindex${drafts ? "?drafts=1" : ""} on each deployment, repeating with the previous answer's continueFrom until it is null, and once per site on a deployment with brands.`,
    });
  }
  for (const m of migrations) {
    for (const a of m.after.filter((x) => x.kind === "manual")) {
      steps.push({
        id: `after:${m.file}`,
        phase: "post-deploy",
        kind: "manual",
        text: a.text,
        url: `${REPO_URL}/blob/v${m.release}/UPGRADING.md#${slug(a.heading)}`,
      });
    }
  }
  if (stop) {
    steps.push({ id: "next-hop", phase: "post-deploy", kind: "manual", text: stop.text });
  }

  return {
    to,
    releases: releases.map((r) => r.version),
    rollForwardOnly: releases.some((r) => r.rollback === "none"),
    migrations: migrations.map(({ file, release, apply }) => ({ file, release, apply })),
    read,
    steps,
  };
}
