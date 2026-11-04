import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, groupWebWrangler, host } from "./fixtures";
import { lib, REPO_ROOT } from "./load";

type Step = {
  id: string;
  phase: "local" | "deploy" | "post-deploy";
  kind: string;
  local?: boolean;
  argv?: string[];
  status?: string;
  drafts?: boolean;
  before?: string;
  text?: string;
};
type Hop = {
  to: string;
  releases: string[];
  rollForwardOnly: boolean;
  migrations: { file: string; release: string; apply: string }[];
  read: { release: string; heading: string; url: string }[];
  steps: Step[];
};
type Plan = {
  schema: string;
  from: string;
  to: string;
  mode: string;
  pin: { before: string | null; after: string };
  hops: Hop[];
  claimed: { file: string; rule: string }[];
  stop?: { before: string; requiresDeployed: string; deployed: string | null; text: string };
};
type Ledger = {
  releases: { version: string; requiresDeployed?: string; [k: string]: unknown }[];
  [k: string]: unknown;
};
type Db = {
  env: string | null;
  envs?: (string | null)[];
  database_name: string;
  database_id?: string | null;
  binding: string;
};

const { planUpgrade, PlanRefusal } = await lib<{
  planUpgrade: (input: Record<string, unknown>) => Plan;
  PlanRefusal: new (...a: unknown[]) => Error & { fix: { kind: string; argv?: string[] }[] };
}>("plan");
const { readLedger } = await lib<{ readLedger: (root: string) => Ledger }>("ledger");
const { databasesByEnvironment } = await lib<{
  databasesByEnvironment: (
    project: unknown,
  ) => Promise<{ databases: Db[]; missing: (string | null)[] }>;
}>("doctor");
const { readProject } = await lib<{ readProject: (dir: string) => unknown }>("project");
const { releaseHeadings } = await lib<{
  releaseHeadings: (md: string, v: string) => string[];
}>("upgrading");

afterAll(cleanup);

const ledger = readLedger(REPO_ROOT);
const upgrading = readFileSync(path.join(REPO_ROOT, "UPGRADING.md"), "utf8");
/** What databasesByEnvironment answers for groupWebWrangler(): staging first, production last. */
const db = (env: string | null, name: string, id = `id-${name}`, envs = [env]): Db => ({
  env,
  envs,
  database_name: name,
  database_id: id,
  binding: "FOLIO_DB",
});
const threeEnvs: Db[] = [
  db("staging", "group-web-folio-staging"),
  db(null, "group-web-folio"),
  db("production", "group-web-folio-production"),
];

function plan(over: Record<string, unknown> = {}): Plan {
  return planUpgrade({
    ledger,
    cliVersion: "1.4.0",
    from: "1.2.3",
    pin: "github:brendanmckenzie/folio#v1.2.3",
    packageManager: "pnpm",
    wranglerBin: "node_modules/.bin/wrangler",
    root: "/host",
    typecheck: true,
    agentsFile: null,
    databases: threeEnvs,
    ...over,
  });
}

function refusal(over: Record<string, unknown>) {
  try {
    plan(over);
  } catch (err) {
    expect(err).toBeInstanceOf(PlanRefusal);
    return err as InstanceType<typeof PlanRefusal>;
  }
  throw new Error("planUpgrade did not refuse");
}

describe("upgrade plans, 1.2.3 to 1.4.0", () => {
  const p = plan();
  const hop = p.hops[0] as Hop;

  it("is one hop through every later release, roll-forward only", () => {
    expect(p.schema).toBe("folio.upgrade/1");
    expect(p.mode).toBe("plan");
    expect(p.hops).toHaveLength(1);
    expect(hop.to).toBe("1.4.0");
    expect(hop.releases).toEqual(["1.2.4", "1.3.0", "1.3.1", "1.3.2", "1.4.0"]);
    expect(hop.rollForwardOnly).toBe(true);
    expect(p.pin).toEqual({
      before: "github:brendanmckenzie/folio#v1.2.3",
      after: "github:brendanmckenzie/folio#v1.4.0",
    });
  });

  it("brings 0016 and 0017, both before the deploy", () => {
    expect(hop.migrations).toEqual([
      { file: "0016_option_sources.sql", release: "1.3.0", apply: "before-deploy" },
      { file: "0017_form_actions.sql", release: "1.3.0", apply: "before-deploy" },
    ]);
  });

  it("lists every heading naming one of the releases, with its tag's URL", () => {
    const want = ["1.2.4", "1.3.0", "1.3.1", "1.3.2", "1.4.0"].flatMap((v) =>
      releaseHeadings(upgrading, v),
    );
    expect(hop.read.map((r) => r.heading)).toEqual(want);
    expect(hop.read.find((r) => r.heading === "v1.3.0 is roll-forward only")?.url).toBe(
      "https://github.com/brendanmckenzie/folio/blob/v1.3.0/UPGRADING.md#v130-is-roll-forward-only",
    );
  });

  it("orders the local steps, and every local run step is local: true and pending", () => {
    const local = hop.steps.filter((s) => s.phase === "local");
    expect(local.map((s) => s.id)).toEqual([
      "pin",
      "remove-installed",
      "install",
      "d1-local",
      "typecheck",
      "doctor",
    ]);
    for (const s of local) {
      expect(s.status).toBe("pending");
      if (s.kind === "run") expect(s.local).toBe(true);
    }
    expect(local.find((s) => s.id === "install")?.argv).toEqual(["pnpm", "install"]);
    expect(local.find((s) => s.id === "d1-local")?.argv).toEqual([
      "node_modules/.bin/wrangler",
      "d1",
      "migrations",
      "apply",
      "group-web-folio",
      "--local",
    ]);
  });

  it("prints three remote applies, local: false, staging first, before the deploy", () => {
    const deploy = hop.steps.filter((s) => s.phase === "deploy");
    expect(deploy.map((s) => s.id)).toEqual([
      "d1-remote:staging",
      "d1-remote:top-level",
      "d1-remote:production",
      "deploy",
    ]);
    for (const s of deploy.slice(0, 3)) {
      expect(s.local).toBe(false);
      expect(s.status).toBeUndefined();
      expect(s.argv).toContain("--remote");
    }
    expect(deploy[0]?.argv?.slice(-3)).toEqual(["--remote", "--env", "staging"]);
  });

  it("names the claimed 0012 and its rule", () => {
    expect(p.claimed).toEqual([
      {
        file: "0012_users_role_contract.sql",
        rule: expect.stringContaining("never applied in the same step as 0011"),
      },
    ]);
  });

  it("restricts the remote steps to one environment under --env", () => {
    const steps = (plan({ env: "staging" }).hops[0] as Hop).steps;
    expect(steps.filter((s) => s.id.startsWith("d1-remote")).map((s) => s.id)).toEqual([
      "d1-remote:staging",
    ]);
    expect(steps.find((s) => s.id === "d1-local")?.argv?.slice(-3)).toEqual([
      "--local",
      "--env",
      "staging",
    ]);
  });

  it("removes and runs the hoisted copy a workspace actually installed (review M4)", () => {
    const steps = (
      plan({ folioDir: "../../node_modules/folio", agentsFile: "AGENTS.md" }).hops[0] as Hop
    ).steps;
    expect(steps.find((s) => s.id === "remove-installed")?.argv).toEqual([
      "rm",
      "-rf",
      "../../node_modules/folio",
    ]);
    expect(steps.find((s) => s.id === "agents")?.argv?.[1]).toBe(
      "../../node_modules/folio/bin/folio.mjs",
    );
  });

  it("adds the agents step when the host carries the markers", () => {
    const steps = (plan({ agentsFile: "CLAUDE.md" }).hops[0] as Hop).steps;
    expect(steps.find((s) => s.id === "agents")?.argv).toEqual([
      "node",
      "node_modules/folio/bin/folio.mjs",
      "agents",
      "CLAUDE.md",
    ]);
  });
});

describe("upgrade plans, other ranges", () => {
  it("reindexes drafts after the deploy when 0015 is crossed (1.1.0 to 1.4.0)", () => {
    const hop = plan({ from: "1.1.0" }).hops[0] as Hop;
    const reindex = hop.steps.find((s) => s.id === "reindex");
    expect(reindex).toMatchObject({ phase: "post-deploy", kind: "reindex", drafts: true });
    expect(reindex?.status).toBeUndefined();
  });

  it("answers no hops when the installed version is the target", () => {
    const p = plan({ from: "1.4.0" });
    expect(p.hops).toEqual([]);
  });

  it("stops at an intermediate --to", () => {
    const hop = plan({ from: "1.1.0", to: "1.2.0" }).hops[0] as Hop;
    expect(hop.releases).toEqual(["1.2.0"]);
    expect(hop.rollForwardOnly).toBe(false);
    expect(hop.migrations.map((m) => m.file)).toEqual(["0015_draft_data.sql"]);
  });

  it("stops at a requiresDeployed release unless a deployment proves the version (review M1)", () => {
    // The newest real release, so a patch release does not move the goalposts.
    const newest = ledger.releases.at(-1)?.version as string;
    const fixture = {
      ...ledger,
      releases: [
        ...ledger.releases,
        {
          version: "1.5.0",
          rollback: "safe",
          migrations: [],
          headings: [],
          requiresDeployed: newest,
        },
      ],
    };
    const p = plan({ ledger: fixture, cliVersion: "1.5.0", from: "1.3.1" });
    expect(p.hops.map((h) => h.to)).toEqual([newest]);
    expect(p.stop).toMatchObject({ before: "1.5.0", requiresDeployed: newest, deployed: null });
    expect(p.hops[0]?.steps.at(-1)).toMatchObject({ id: "next-hop", phase: "post-deploy" });
    expect(p.hops[0]?.steps.find((s) => s.id === "pin")).toMatchObject({
      after: `github:brendanmckenzie/folio#v${newest}`,
    });
    // Installed at or past the gate proves nothing about what is deployed.
    const installed = plan({ ledger: fixture, cliVersion: "1.5.0", from: newest });
    expect(installed.hops).toEqual([]);
    expect(installed.stop?.before).toBe("1.5.0");
    // A deployment that reports the newest release or later is the proof.
    const proven = plan({ ledger: fixture, cliVersion: "1.5.0", from: newest, deployed: newest });
    expect(proven.stop).toBeUndefined();
    expect(proven.hops.map((h) => h.to)).toEqual(["1.5.0"]);
    // An older deployment does not count.
    expect(
      plan({ ledger: fixture, cliVersion: "1.5.0", from: "1.3.1", deployed: "1.3.9" }).stop,
    ).toBeDefined();
  });

  it("pairs a with-deploy migration's apply with an immediate deploy, per environment", () => {
    const fixture = {
      ...ledger,
      migrations: {
        ...(ledger.migrations as object),
        "0018_x.sql": { release: "1.5.0", apply: "with-deploy" },
      },
      releases: [
        ...ledger.releases,
        { version: "1.5.0", rollback: "none", migrations: ["0018_x.sql"], headings: [] },
      ],
    };
    const hop = plan({ ledger: fixture, cliVersion: "1.5.0", from: "1.4.0" }).hops[0] as Hop;
    expect(hop.steps.filter((s) => s.phase === "deploy").map((s) => s.id)).toEqual([
      "d1-remote:staging",
      "deploy:staging",
      "d1-remote:top-level",
      "deploy:top-level",
      "d1-remote:production",
      "deploy:production",
    ]);
  });
});

describe("upgrade refusals", () => {
  it("refuses a --to newer than the CLI with the npx command that would plan it", () => {
    const err = refusal({ to: "1.5.0" });
    expect(err.fix[0]?.argv).toEqual(["npx", "github:brendanmckenzie/folio#v1.5.0", "upgrade"]);
  });

  it("refuses a pre-1.0 install, a release the ledger lacks, a downgrade and nothing installed", () => {
    expect(refusal({ from: "0.0.0" }).message).toMatch(/predates 1\.0\.0/);
    expect(refusal({ to: "1.2.9" }).message).toMatch(/not a release/);
    expect(refusal({ from: "1.4.0", to: "1.3.0" }).message).toMatch(/downgrade/);
    expect(refusal({ from: null }).message).toMatch(/not installed/);
  });
});

describe("upgrade's environments, identified by database id (review H1, M5, L4)", () => {
  const cfg = (dbs: Record<string, { name: string; id?: string } | null>) => {
    const entry = (d: { name: string; id?: string }) => ({
      binding: "FOLIO_DB",
      database_name: d.name,
      ...(d.id ? { database_id: d.id } : {}),
      migrations_dir: "node_modules/folio/migrations",
    });
    const base = groupWebWrangler();
    const top = dbs.top;
    const env = Object.fromEntries(
      Object.entries(dbs)
        .filter(([k]) => k !== "top")
        .map(([k, d]) => [k, { ...base.env.staging, d1_databases: d ? [entry(d)] : [] }]),
    );
    return { ...base, d1_databases: top ? [entry(top)] : [], env };
  };

  it("finds one Folio database per environment, staging first and production last", async () => {
    const root = host({ wrangler: groupWebWrangler() });
    expect(await databasesByEnvironment(readProject(root))).toEqual({
      databases: threeEnvs,
      missing: [],
    });
  });

  it("keeps two environments that reuse a database_name for different ids apart", async () => {
    const root = host({
      wrangler: cfg({
        top: { name: "site-db", id: "a" },
        staging: { name: "site-db", id: "b" },
        production: { name: "site-db", id: "a" },
      }),
    });
    const found = await databasesByEnvironment(readProject(root));
    expect(found.databases).toEqual([
      db("staging", "site-db", "b"),
      db(null, "site-db", "a", [null, "production"]),
    ]);
    // --env staging gets its own local and remote steps.
    const hop = plan({ ...found, env: "staging" }).hops[0] as Hop;
    expect(hop.steps.find((s) => s.id === "d1-local")?.argv?.slice(-3)).toEqual([
      "--local",
      "--env",
      "staging",
    ]);
    expect(
      hop.steps.filter((s) => s.id.startsWith("d1-remote")).map((s) => s.argv?.slice(-3)),
    ).toEqual([["--remote", "--env", "staging"]]);
    // Without --env: one apply per database, and the deploy names all three environments.
    const all = (plan(found).hops[0] as Hop).steps.filter((s) => s.phase === "deploy");
    expect(all.map((s) => s.id)).toEqual(["d1-remote:staging", "d1-remote:top-level", "deploy"]);
    expect(all.at(-1)?.text).toContain("staging, the top level, production");
  });

  it("applies the local database under the environment it came from when the top level has none", async () => {
    const root = host({
      wrangler: cfg({ staging: { name: "s", id: "s" }, production: { name: "p", id: "p" } }),
    });
    const found = await databasesByEnvironment(readProject(root));
    expect(found.missing).toEqual([]);
    const hop = plan(found).hops[0] as Hop;
    expect(hop.steps.find((s) => s.id === "d1-local")?.argv).toEqual([
      "node_modules/.bin/wrangler",
      "d1",
      "migrations",
      "apply",
      "s",
      "--local",
      "--env",
      "staging",
    ]);
  });

  it("refuses a hop with migrations when an environment has no Folio database", async () => {
    const root = host({ wrangler: cfg({ top: { name: "t", id: "t" }, staging: null }) });
    const found = await databasesByEnvironment(readProject(root));
    expect(found.missing).toEqual(["staging"]);
    expect(refusal(found).message).toMatch(/staging has no Folio database/);
    expect(refusal({ ...found, env: "staging" }).message).toMatch(/staging has no Folio database/);
    expect(refusal({ databases: [], missing: [] }).message).toMatch(/declares no Folio database/);
    // A hop with no migrations has nothing to apply anywhere, so it plans.
    expect(plan({ ...found, from: "1.3.1" }).hops).toHaveLength(1);
  });
});
