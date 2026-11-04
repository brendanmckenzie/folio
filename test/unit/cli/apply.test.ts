import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, host } from "./fixtures";
import { lib, REPO_ROOT } from "./load";

type Step = { id: string; phase: string; status?: string; exitCode?: number; output?: string };
type Plan = { mode: string; hops: { to: string; steps: Step[] }[]; next?: string };
type RunResult = { status: number; stdout: string; stderr: string };

const { applyPlan, rewritePin } = await lib<{
  applyPlan: (
    plan: Plan,
    project: unknown,
    opts: {
      run: (argv: string[], o?: { cwd?: string }) => RunResult;
      allowDirty?: boolean;
      doctor: (checks: string[]) => Promise<{ ok: boolean }>;
    },
  ) => Promise<boolean>;
  rewritePin: (text: string, dep: { spec: string }, after: string) => string;
}>("apply");
const { planUpgrade, PlanRefusal } = await lib<{
  planUpgrade: (input: Record<string, unknown>) => Plan;
  PlanRefusal: new (...a: unknown[]) => Error;
}>("plan");
const { readLedger } = await lib<{ readLedger: (root: string) => unknown }>("ledger");
const { readProject } = await lib<{
  readProject: (dir: string) => { root: string; dep: { spec: string }; lockfile: string | null };
}>("project");
const { run: realRun } = await lib<{
  run: (argv: string[], o?: { cwd?: string }) => RunResult;
}>("run");

afterAll(cleanup);

const OLD = "github:brendanmckenzie/folio#v1.2.3";

/** A committed v1.2.3 host whose package.json is indented with tabs, to prove the edit keeps it. */
function committedHost() {
  const root = host({
    pkg: {},
    installed: { version: "1.2.3" },
  });
  const pkg = {
    name: "host",
    scripts: { typecheck: "tsc --noEmit" },
    dependencies: { react: "^19.0.0", folio: OLD },
  };
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg, null, "\t")}\n`);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return root;
}

/** Records everything; really runs git, which the dirty check reads. */
function recordingRunner(failOn?: string) {
  const calls: string[][] = [];
  const run = (argv: string[], opts: { cwd?: string } = {}): RunResult => {
    if (argv[0] === "git") return realRun(argv, opts);
    calls.push(argv);
    if (failOn && argv.includes(failOn)) return { status: 3, stdout: "boom\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function planFor(root: string) {
  const project = readProject(root);
  return {
    project,
    plan: planUpgrade({
      ledger: readLedger(REPO_ROOT),
      cliVersion: "1.4.0",
      from: "1.2.3",
      pin: project.dep.spec,
      packageManager: "npm",
      wranglerBin: "node_modules/.bin/wrangler",
      root,
      typecheck: true,
      agentsFile: null,
      databases: [
        { env: null, database_name: "folio", binding: "DB" },
        { env: "staging", database_name: "folio-staging", binding: "DB" },
      ],
    }),
  };
}

describe("upgrade --apply", () => {
  it("runs the local steps in order, edits only the pin, and never a remote step", async () => {
    const root = committedHost();
    const { project, plan } = planFor(root);
    const rec = recordingRunner();
    const checks: string[][] = [];
    const ok = await applyPlan(plan, project, {
      run: rec.run,
      doctor: async (c) => {
        checks.push(c);
        return { ok: true };
      },
    });
    expect(ok).toBe(true);
    expect(plan.mode).toBe("apply");
    expect(rec.calls).toEqual([
      ["rm", "-rf", "node_modules/folio"],
      ["npm", "install"],
      ["node_modules/.bin/wrangler", "d1", "migrations", "apply", "folio", "--local"],
      ["npm", "run", "typecheck"],
    ]);
    expect(rec.calls.flat()).not.toContain("--remote");
    expect(checks).toEqual([["node.version", "package.pin", "package.installed", "d1.local"]]);
    const steps = plan.hops[0]?.steps ?? [];
    for (const s of steps) {
      if (s.phase === "local") expect(s.status, s.id).toBe("done");
      else expect(s.status, s.id).toBeUndefined();
    }
    const text = readFileSync(path.join(root, "package.json"), "utf8");
    expect(text).toBe(
      `${JSON.stringify(
        {
          name: "host",
          scripts: { typecheck: "tsc --noEmit" },
          dependencies: { react: "^19.0.0", folio: "github:brendanmckenzie/folio#v1.4.0" },
        },
        null,
        "\t",
      )}\n`,
    );
  });

  it("stops at the first failure, recording its exit code and output", async () => {
    const root = committedHost();
    const { project, plan } = planFor(root);
    const rec = recordingRunner("install");
    const ok = await applyPlan(plan, project, { run: rec.run, doctor: async () => ({ ok: true }) });
    expect(ok).toBe(false);
    const steps = plan.hops[0]?.steps ?? [];
    expect(steps.find((s) => s.id === "install")).toMatchObject({
      status: "failed",
      exitCode: 3,
      output: "boom",
    });
    expect(steps.find((s) => s.id === "d1-local")?.status).toBe("pending");
    expect(rec.calls).toHaveLength(2);
  });

  it("refuses before any step when package.json has uncommitted changes", async () => {
    const root = committedHost();
    const { project, plan } = planFor(root);
    writeFileSync(
      path.join(root, "package.json"),
      `${readFileSync(path.join(root, "package.json"), "utf8")} `,
    );
    const rec = recordingRunner();
    await expect(
      applyPlan(plan, project, { run: rec.run, doctor: async () => ({ ok: true }) }),
    ).rejects.toThrow(/Uncommitted changes in package\.json/);
    expect(rec.calls).toEqual([]);
    // --allow-dirty is the explicit way past it.
    const ok = await applyPlan(plan, project, {
      run: rec.run,
      allowDirty: true,
      doctor: async () => ({ ok: true }),
    });
    expect(ok).toBe(true);
  });

  it("refuses outside a git repository", async () => {
    const root = host({ installed: { version: "1.2.3" } });
    const { project, plan } = planFor(root);
    const rec = recordingRunner();
    const err = await applyPlan(plan, project, {
      run: rec.run,
      doctor: async () => ({ ok: true }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanRefusal);
    expect(String(err.message)).toMatch(/not a git repository/);
    expect(rec.calls).toEqual([]);
  });

  it("marks the run failed when the closing doctor fails", async () => {
    const root = committedHost();
    const { project, plan } = planFor(root);
    const ok = await applyPlan(plan, project, {
      run: recordingRunner().run,
      doctor: async () => ({ ok: false }),
    });
    expect(ok).toBe(false);
    expect(plan.hops[0]?.steps.find((s) => s.id === "doctor")?.status).toBe("failed");
  });
});

describe("the pin edit", () => {
  it("rewrites only the folio string and is a no-op at the target", () => {
    const text =
      '{\n  "dependencies": {\n    "folio": "github:brendanmckenzie/folio#v1.2.3"\n  }\n}\n';
    const next = rewritePin(text, { spec: OLD }, "github:brendanmckenzie/folio#v1.4.0");
    expect(next).toBe(text.replace("v1.2.3", "v1.4.0"));
    expect(
      rewritePin(
        next,
        { spec: "github:brendanmckenzie/folio#v1.4.0" },
        "github:brendanmckenzie/folio#v1.4.0",
      ),
    ).toBe(next);
  });

  it("refuses to guess when the string is not there exactly once", () => {
    expect(() => rewritePin("{}", { spec: OLD }, "x")).toThrow(/found 0/);
  });
});
