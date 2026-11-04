import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLI_VERSION,
  cleanup,
  executeAnswer,
  groupWebWrangler,
  host,
  recorder,
  SHIPPED,
  snapshot,
  starterWrangler,
  viteWithApi,
} from "./fixtures";
import { lib, REPO_ROOT } from "./load";

type Fix =
  | { kind: "run"; argv: string[]; cwd: string; local: boolean }
  | { kind: "edit"; file: string; snippet: string }
  | { kind: "manual"; text: string; docs?: string };
type Id =
  | "node.version"
  | "package.pin"
  | "package.installed"
  | "wrangler.config"
  | "wrangler.d1"
  | "wrangler.story"
  | "wrangler.space"
  | "wrangler.do-backend"
  | "wrangler.crons"
  | "vite.plugin"
  | "blocks.module"
  | "d1.local"
  | "d1.remote"
  | "server.mounted"
  | "server.schema";
type Check = {
  id: Id;
  status: "pass" | "warn" | "fail" | "skip";
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
  fix?: Fix[];
  docs?: string;
};
type Result = {
  schema: string;
  ok: boolean;
  installed: string | null;
  summary: Record<string, number>;
  checks: Check[];
};
type Opts = {
  env?: string;
  remote?: boolean;
  url?: string;
  site?: string;
  token?: string;
  only?: Id[];
  run?: ReturnType<typeof recorder>["run"];
  fetch?: typeof fetch;
  nodeVersion?: string;
};

const { doctor } = await lib<{
  doctor: (project: unknown, opts: Record<string, unknown>) => Promise<Result>;
}>("doctor");
const { readProject } = await lib<{
  readProject: (dir: string, opts?: Record<string, unknown>) => unknown;
}>("project");
const { readLedger } = await lib<{ readLedger: (root: string) => unknown }>("ledger");

afterAll(cleanup);

async function check(root: string, opts: Opts = {}, project: Record<string, unknown> = {}) {
  const rec = recorder();
  const result = await doctor(readProject(root, project), {
    cliVersion: CLI_VERSION,
    ledger: readLedger(REPO_ROOT),
    nodeVersion: "26.13.0",
    run: rec.run,
    ...opts,
  });
  const by = Object.fromEntries(result.checks.map((c) => [c.id, c])) as Record<Id, Check>;
  return { result, by, calls: rec.calls };
}

function everyFailHasAFix(result: Result) {
  for (const c of result.checks) {
    if (c.status === "fail" || c.status === "warn") expect(c.fix?.length, c.id).toBeGreaterThan(0);
  }
}

describe("doctor on a fresh scaffold", () => {
  it("fails only d1.local, with the local apply command, runs nothing and writes nothing", async () => {
    const root = host({ files: { "src/blocks/index.ts": "export const blocks = [];\n" } });
    const before = snapshot(root);
    const { result, by, calls } = await check(root);
    expect(result.schema).toBe("folio.doctor/1");
    expect(result.ok).toBe(false);
    expect(by["d1.local"].status).toBe("fail");
    const fix = by["d1.local"].fix?.[0] as Extract<Fix, { kind: "run" }>;
    expect(fix.kind).toBe("run");
    expect(fix.local).toBe(true);
    expect(fix.argv.slice(-5)).toEqual(["d1", "migrations", "apply", "folio", "--local"]);
    for (const id of ["server.mounted", "server.schema", "d1.remote"] as const)
      expect(by[id].status).toBe("skip");
    const others = result.checks.filter(
      (c) => !["d1.local", "server.mounted", "server.schema", "d1.remote"].includes(c.id),
    );
    for (const c of others) expect(c.status, `${c.id}: ${c.title}`).toBe("pass");
    // No local state: wrangler would create a database on first touch.
    expect(calls).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    everyFailHasAFix(result);
  });

  it("passes once the local database has every shipped migration", async () => {
    const root = host({ localState: true, files: { "src/blocks/index.ts": "" } });
    const rec = recorder((argv) => (argv.includes("execute") ? executeAnswer(SHIPPED) : undefined));
    const { result, by } = await check(root, { run: rec.run });
    expect(by["d1.local"].status).toBe("pass");
    expect(by["d1.local"].data?.pending).toEqual([]);
    expect(result.ok).toBe(true);
    const select = rec.calls.find((c) => c.argv.includes("execute"));
    expect(select?.argv).toEqual([
      "node_modules/.bin/wrangler",
      "d1",
      "execute",
      "folio",
      "--local",
      "--json",
      "--command",
      "select name from d1_migrations order by id",
    ]);
    expect(select?.cwd).toBe(root);
  });

  it("names pending migrations and the headings of the release that brings them", async () => {
    const root = host({ localState: true, installed: { ledger: true } });
    const applied = SHIPPED.filter((f) => f < "0016");
    const rec = recorder((argv) => (argv.includes("execute") ? executeAnswer(applied) : undefined));
    const { by } = await check(root, { run: rec.run, only: ["d1.local"] });
    expect(by["d1.local"].status).toBe("fail");
    expect(by["d1.local"].data?.pending).toEqual([
      "0016_option_sources.sql",
      "0017_form_actions.sql",
    ]);
    expect(by["d1.local"].detail).toContain("v130-is-roll-forward-only");
  });
});

describe("doctor finds Folio's bindings under any name", () => {
  it("passes the group-web shape, and notes SpaceDO is KV-backed", async () => {
    const root = host({ wrangler: groupWebWrangler(), localState: true });
    const rec = recorder((argv) => (argv.includes("execute") ? executeAnswer(SHIPPED) : undefined));
    const { by } = await check(root, { run: rec.run });
    expect(by["wrangler.d1"].status).toBe("pass");
    expect(by["wrangler.d1"].data?.databases).toEqual([
      { binding: "FOLIO_DB", database_name: "group-web-folio", migrations_table: null },
    ]);
    expect(by["wrangler.story"].data).toEqual({ binding: "FOLIO_STORY" });
    expect(by["wrangler.space"].data).toEqual({ binding: "FOLIO_SPACE" });
    expect(by["wrangler.do-backend"].status).toBe("pass");
    expect(by["wrangler.do-backend"].detail).toMatch(/SpaceDO is KV-backed and must stay so/);
    expect(by["d1.local"].status).toBe("pass");
  });

  it("queries the named environment's database under --env", async () => {
    const root = host({ wrangler: groupWebWrangler(), localState: true });
    const rec = recorder((argv) => (argv.includes("execute") ? executeAnswer(SHIPPED) : undefined));
    const { by } = await check(root, { run: rec.run, env: "staging" });
    expect(by["wrangler.d1"].data?.databases).toEqual([
      { binding: "FOLIO_DB", database_name: "group-web-folio-staging", migrations_table: null },
    ]);
    const select = rec.calls.find((c) => c.argv.includes("execute"))?.argv ?? [];
    expect(select[3]).toBe("group-web-folio-staging");
    expect(select.slice(-2)).toEqual(["--env", "staging"]);
  });
});

describe("doctor reports a database migrated by a newer Folio", () => {
  it("fails d1.local with data.unknown, naming v1.3.0 as roll-forward only", async () => {
    const old = SHIPPED.filter((f) => f < "0016");
    const root = host({ localState: true, installed: { version: "1.2.3", migrations: old } });
    const rec = recorder((argv) => (argv.includes("execute") ? executeAnswer(SHIPPED) : undefined));
    const { by } = await check(root, { run: rec.run, only: ["d1.local"] });
    const d1 = by["d1.local"];
    expect(d1.status).toBe("fail");
    expect(d1.data?.unknown).toEqual(["0016_option_sources.sql", "0017_form_actions.sql"]);
    expect(d1.data?.pending).toEqual([]);
    expect(d1.detail).toMatch(/migrated by a newer release \(v1\.3\.0\)/);
    expect(d1.detail).toContain(
      "v1.3.0 is roll-forward only: https://github.com/brendanmckenzie/folio/blob/v1.3.0/UPGRADING.md#v130-is-roll-forward-only",
    );
    expect(d1.fix?.[0]).toMatchObject({
      kind: "run",
      argv: ["npx", "github:brendanmckenzie/folio#v1.3.0", "upgrade"],
    });
  });

  it("reads 'no such table' as nothing applied, and a lock or an auth error as neither", async () => {
    const root = host({ localState: true });
    const noTable = recorder(() => ({
      status: 1,
      stdout: JSON.stringify({ error: { text: "no such table: d1_migrations: SQLITE_ERROR" } }),
      stderr: "",
    }));
    const a = await check(root, { run: noTable.run, only: ["d1.local"] });
    expect(a.by["d1.local"].data?.pending).toEqual(SHIPPED);

    const locked = recorder(() => ({
      status: 1,
      stdout: "",
      stderr: "SQLITE_BUSY: database is locked",
    }));
    const b = await check(root, { run: locked.run, only: ["d1.local"] });
    expect(b.by["d1.local"].status).toBe("fail");
    expect(b.by["d1.local"].title).toMatch(/locked; retry/);
    expect(b.by["d1.local"].data?.pending).toBeUndefined();

    const auth = recorder(() => ({
      status: 1,
      stdout: "",
      stderr: "You are not logged in. Run `wrangler login`.",
    }));
    const c = await check(root, { run: auth.run, only: ["d1.remote"], remote: true });
    expect(c.by["d1.remote"].status).toBe("fail");
    expect(c.by["d1.remote"].data?.reason).toBe("auth");
    expect(auth.calls[0]?.argv).toContain("--remote");
  });

  it("gives a remote pending migration a fix marked local: false", async () => {
    const root = host();
    const rec = recorder(() => executeAnswer(SHIPPED.slice(0, -1)));
    const { by } = await check(root, { run: rec.run, only: ["d1.remote"], remote: true });
    expect(by["d1.remote"].fix?.[0]).toMatchObject({ kind: "run", local: false });
    expect(JSON.stringify(by["d1.remote"].fix)).toContain('"--remote"');
  });
});

describe("doctor, each fail row", () => {
  const cases: [string, Parameters<typeof host>[0], Id, Check["status"], Opts?][] = [
    ["node.version", {}, "node.version", "fail", { nodeVersion: "25.2.1" }],
    ["an unknown engines range", { installed: { engines: "^26" } }, "node.version", "warn"],
    ["no folio dependency", { pkg: { name: "h", dependencies: {} } }, "package.pin", "fail"],
    [
      "a registry range",
      { pkg: { name: "h", dependencies: { folio: "^1.3.0" } } },
      "package.pin",
      "fail",
    ],
    [
      "a branch",
      { pkg: { name: "h", dependencies: { folio: "github:brendanmckenzie/folio#main" } } },
      "package.pin",
      "fail",
    ],
    [
      "a full SHA",
      {
        pkg: {
          name: "h",
          dependencies: { folio: `github:brendanmckenzie/folio#${"a".repeat(40)}` },
        },
      },
      "package.pin",
      "warn",
    ],
    ["nothing installed", { installed: null }, "package.installed", "fail"],
    ["no dist", { installed: { dist: false } }, "package.installed", "fail"],
    [
      "installed differs from the tag",
      { installed: { version: "1.2.0" } },
      "package.installed",
      "fail",
    ],
    [
      "installed below 1.0.0",
      {
        installed: { version: "0.0.0" },
        pkg: {
          name: "h",
          dependencies: { folio: `github:brendanmckenzie/folio#${"b".repeat(40)}` },
        },
      },
      "package.installed",
      "warn",
    ],
    ["no wrangler config", { wrangler: null }, "wrangler.config", "fail"],
    ["a config wrangler refuses", { wrangler: '{ "name": ' }, "wrangler.config", "fail"],
    [
      "copied migrations",
      {
        wrangler: {
          ...starterWrangler(),
          d1_databases: [
            {
              binding: "DB",
              database_name: "folio",
              database_id: "x",
              migrations_dir: "./migrations",
            },
          ],
        },
        files: { "migrations/0001_init.sql": "" },
      },
      "wrangler.d1",
      "fail",
    ],
    [
      "two Folio databases",
      {
        wrangler: {
          ...starterWrangler(),
          d1_databases: [
            {
              binding: "A",
              database_name: "a",
              database_id: "x",
              migrations_dir: "./node_modules/folio/migrations",
            },
            {
              binding: "B",
              database_name: "b",
              database_id: "y",
              migrations_dir: "node_modules/folio/migrations",
            },
          ],
        },
      },
      "wrangler.d1",
      "warn",
    ],
    [
      "no StoryDO",
      {
        wrangler: {
          ...starterWrangler(),
          durable_objects: { bindings: [{ name: "SPACE", class_name: "SpaceDO" }] },
        },
      },
      "wrangler.story",
      "fail",
    ],
    [
      "no SpaceDO",
      {
        wrangler: {
          ...starterWrangler(),
          durable_objects: { bindings: [{ name: "STORY", class_name: "StoryDO" }] },
        },
      },
      "wrangler.space",
      "warn",
    ],
    [
      "a KV-backed StoryDO",
      {
        wrangler: {
          ...starterWrangler(),
          migrations: [{ tag: "v1", new_classes: ["StoryDO", "SpaceDO"] }],
        },
      },
      "wrangler.do-backend",
      "fail",
    ],
    [
      "a SpaceDO no tag creates",
      {
        wrangler: {
          ...starterWrangler(),
          migrations: [{ tag: "v1", new_sqlite_classes: ["StoryDO"] }],
        },
      },
      "wrangler.do-backend",
      "fail",
    ],
    [
      "no crons",
      { wrangler: { ...starterWrangler(), triggers: { crons: [] } } },
      "wrangler.crons",
      "warn",
    ],
    ["a Vite config that throws", { vite: "throw new Error('nope');\n" }, "vite.plugin", "fail"],
    ["no folio plugin", { vite: "export default { plugins: [] };\n" }, "vite.plugin", "fail"],
    [
      "a plugin with no api",
      { vite: 'export default { plugins: [{ name: "folio" }] };\n' },
      "vite.plugin",
      "warn",
    ],
    ["a missing blocks module", { vite: viteWithApi("./src/nope.ts") }, "blocks.module", "fail"],
  ];

  for (const [label, opts, id, status, extra] of cases) {
    it(`${label}: ${id} is ${status}, with a fix`, async () => {
      const { by, result } = await check(
        host({ files: { "src/blocks/index.ts": "" }, ...opts }),
        extra,
      );
      expect(by[id].status, by[id].title).toBe(status);
      expect(by[id].fix?.length).toBeGreaterThan(0);
      everyFailHasAFix(result);
    });
  }

  it("no wrangler: wrangler.config is fail, with a fix", async () => {
    // Injected rather than unlinked: under vitest, createRequire resolves from the
    // workspace as well as the host, so an absent symlink still finds one.
    const missing = () => Promise.reject(new Error("Cannot find module 'wrangler'"));
    const { by } = await check(host(), {}, { readers: { wrangler: missing } });
    expect(by["wrangler.config"].status).toBe("fail");
    expect(by["wrangler.config"].fix?.[0]).toMatchObject({ kind: "run", argv: ["npm", "install"] });
  });

  it("skips a check whose prerequisite failed, naming it", async () => {
    const { by } = await check(host({ wrangler: null }));
    for (const id of ["wrangler.d1", "wrangler.story", "d1.local"] as const) {
      expect(by[id].status, id).toBe("skip");
    }
    expect(by["wrangler.d1"].title).toMatch(/needs wrangler\.config/);
    expect(by["d1.local"].title).toMatch(/needs wrangler\.d1/);
  });

  it("finds a brand record's every module", async () => {
    const root = host({
      vite: viteWithApi({ a: "./a/blocks.ts", b: "./b/blocks.ts" }),
      files: { "a/blocks.ts": "" },
    });
    const { by } = await check(root, { only: ["blocks.module"] });
    expect(by["blocks.module"].status).toBe("fail");
    expect(by["blocks.module"].title).toContain("b: ./b/blocks.ts");
  });
});

describe("doctor against a running server", () => {
  const server =
    (routes: Record<string, { status: number; body: string }>): typeof fetch =>
    async (input) => {
      const url = String(input);
      const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(hit[1].body, { status: hit[1].status });
    };

  it("quotes createFolio's refusal and points at Refused at construction", async () => {
    const line = "folio: 'blocks' belongs to a brand beside 'brands'";
    const fetch = server({
      "/folio/mcp": { status: 500, body: `<pre>Error: ${line}\n    at createFolio</pre>` },
      "/folio/login": { status: 500, body: `Error: ${line}` },
    });
    const { by } = await check(host(), {
      url: "http://localhost:1",
      fetch,
      only: ["server.mounted"],
    });
    expect(by["server.mounted"].status).toBe("fail");
    expect(by["server.mounted"].detail).toBe(line);
    expect(by["server.mounted"].docs).toBe(
      "node_modules/folio/docs/configuration.md#refused-at-construction",
    );
  });

  it("warns when MCP is off but the Worker answers, and passes when both answer", async () => {
    const discover = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { supportedVersions: [] } });
    const off = server({ "/folio/login": { status: 200, body: "<form>" } });
    const a = await check(host(), {
      url: "http://localhost:1",
      fetch: off,
      only: ["server.mounted"],
    });
    expect(a.by["server.mounted"].status).toBe("warn");
    const on = server({
      "/cms/mcp": { status: 200, body: discover },
      "/cms/login": { status: 200, body: "<form>" },
    });
    const b = await check(host({ vite: viteWithApi("./src/blocks/index.ts", "/cms") }), {
      url: "http://localhost:1",
      fetch: on,
      only: ["server.mounted"],
    });
    expect(b.by["server.mounted"].status).toBe("pass");
  });

  it("reports a server that is not running as nothing answering", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const { by } = await check(host(), {
      url: "http://localhost:1",
      fetch: down,
      only: ["server.mounted"],
    });
    expect(by["server.mounted"].status).toBe("fail");
    expect(by["server.mounted"].title).toMatch(/Nothing answers/);
  });

  it("names --site when the schema read is site_required, and skips without a token", async () => {
    const fetch = server({
      "/folio/api/v1/schema": {
        status: 400,
        body: JSON.stringify({ error: { code: "site_required", message: "Name the site" } }),
      },
    });
    const a = await check(host(), {
      url: "http://localhost:1",
      fetch,
      token: "t",
      only: ["server.schema"],
    });
    expect(a.by["server.schema"].status).toBe("fail");
    expect(a.by["server.schema"].fix?.[0]).toMatchObject({ kind: "manual" });
    expect(JSON.stringify(a.by["server.schema"].fix)).toContain("--site");
    const b = await check(host(), { url: "http://localhost:1", fetch, only: ["server.schema"] });
    expect(b.by["server.schema"].status).toBe("skip");
  });

  it("passes a served schema under ~<site>", async () => {
    const fetch = server({
      "/folio/~acme/api/v1/schema": {
        status: 200,
        body: JSON.stringify({ types: [{}], blocks: [{}, {}] }),
      },
    });
    const { by } = await check(host(), {
      url: "http://localhost:1",
      fetch,
      token: "t",
      site: "acme",
      only: ["server.schema"],
    });
    expect(by["server.schema"].status).toBe("pass");
    expect(by["server.schema"].data).toMatchObject({ types: 1, blocks: 2 });
  });
});

describe("doctor's --persist-to", () => {
  it("reads the named state directory and passes --persist-to through", async () => {
    const root = host({ files: { "state/v3/d1/.keep": "" } });
    const rec = recorder(() => executeAnswer(SHIPPED));
    const { by } = await check(root, { run: rec.run, only: ["d1.local"] }, { persistTo: "state" });
    expect(by["d1.local"].status).toBe("pass");
    expect(rec.calls[0]?.argv.slice(-2)).toEqual(["--persist-to", path.join(root, "state")]);
  });
});
