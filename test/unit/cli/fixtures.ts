/**
 * Host projects for the CLI's tests, built in a temporary directory per test.
 *
 * Built in code rather than checked in under `test/fixtures/cli/`, because a host's
 * blocks module in single quotes with no semicolons is exactly the case
 * `add block` has to handle, and biome reformats everything under `test/`. The
 * host's own wrangler and vite are symlinks to the ones `examples/starter`
 * resolves, so the CLI reaches them the way it reaches a real host's: through
 * `createRequire` from the host's `package.json`.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./load";

export const STARTER = path.join(REPO_ROOT, "examples/starter");
const PKG = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
export const CLI_VERSION: string = PKG.version;
export const SHIPPED = readdirSync(path.join(REPO_ROOT, "migrations"))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

export interface Installed {
  version?: string;
  engines?: string;
  /** Migration files to create; default every one the repository ships. */
  migrations?: string[];
  dist?: boolean;
  ledger?: boolean;
}

export interface HostOptions {
  pkg?: Record<string, unknown>;
  /** Written verbatim to wrangler.jsonc. */
  wrangler?: string | Record<string, unknown> | null;
  /** Written verbatim to vite.config.mjs; null for none. */
  vite?: string | null;
  installed?: Installed | null;
  files?: Record<string, string>;
  /** Create `.wrangler/state/v3/d1`, as a first local apply would. */
  localState?: boolean;
  /** Link the starter's wrangler and vite into node_modules (default true). */
  tools?: boolean;
}

const dirs: string[] = [];

/** Removes every directory `host()` made. Call from `afterAll`. */
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const starterWrangler = () => ({
  name: "app",
  main: "./src/index.tsx",
  compatibility_date: "2026-07-27",
  triggers: { crons: ["* * * * *"] },
  d1_databases: [
    {
      binding: "DB",
      database_name: "folio",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: "./node_modules/folio/migrations",
    },
  ],
  durable_objects: {
    bindings: [
      { name: "STORY", class_name: "StoryDO" },
      { name: "SPACE", class_name: "SpaceDO" },
    ],
  },
  migrations: [
    { tag: "v1", new_sqlite_classes: ["StoryDO"] },
    { tag: "v2", new_sqlite_classes: ["SpaceDO"] },
  ],
});

/** group-web's shape: FOLIO_* names, SpaceDO under new_classes, a database per environment. */
export const groupWebWrangler = () => {
  const db = (name: string) => ({
    binding: "FOLIO_DB",
    database_name: name,
    database_id: "11111111-1111-1111-1111-111111111111",
    migrations_dir: "node_modules/folio/migrations",
  });
  const dos = {
    bindings: [
      { name: "FOLIO_STORY", class_name: "StoryDO" },
      { name: "FOLIO_SPACE", class_name: "SpaceDO" },
    ],
  };
  return {
    name: "group-web",
    main: "./workers/app.ts",
    compatibility_date: "2026-07-27",
    triggers: { crons: ["* * * * *"] },
    d1_databases: [db("group-web-folio")],
    durable_objects: dos,
    migrations: [
      { tag: "v1", new_sqlite_classes: ["StoryDO"] },
      { tag: "v2", new_classes: ["SpaceDO"] },
    ],
    env: {
      staging: {
        triggers: { crons: ["* * * * *"] },
        d1_databases: [db("group-web-folio-staging")],
        durable_objects: dos,
      },
      production: {
        triggers: { crons: ["* * * * *"] },
        d1_databases: [db("group-web-folio-production")],
        durable_objects: dos,
      },
    },
  };
};

export const viteWithApi = (blocks: unknown = "./src/blocks/index.ts", basePath = "/folio") =>
  `export default { plugins: [{ name: "folio", api: { folio: ${JSON.stringify({ version: 1, blocks, basePath })} } }] };\n`;

/** A host project on disk. Answers its root. */
export function host(opts: HostOptions = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "folio-cli-host-"));
  dirs.push(root);
  const pkg = opts.pkg ?? {
    name: "host",
    private: true,
    type: "module",
    scripts: { typecheck: "tsc --noEmit" },
    dependencies: { folio: `github:brendanmckenzie/folio#v${CLI_VERSION}` },
    devDependencies: { wrangler: "^4.114.0", vite: "^8.1.5" },
  };
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  if (opts.wrangler !== null) {
    const w = opts.wrangler ?? starterWrangler();
    writeFileSync(
      path.join(root, "wrangler.jsonc"),
      typeof w === "string" ? w : JSON.stringify(w, null, 2),
    );
  }
  if (opts.vite !== null) {
    writeFileSync(path.join(root, "vite.config.mjs"), opts.vite ?? viteWithApi());
  }
  const nm = path.join(root, "node_modules");
  mkdirSync(nm, { recursive: true });
  if (opts.tools !== false) {
    symlinkSync(path.join(STARTER, "node_modules/wrangler"), path.join(nm, "wrangler"));
    symlinkSync(path.join(STARTER, "node_modules/vite"), path.join(nm, "vite"));
  }
  if (opts.installed !== null) installFolio(root, opts.installed ?? {});
  for (const [file, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  if (opts.localState) mkdirSync(path.join(root, ".wrangler/state/v3/d1"), { recursive: true });
  return root;
}

/** A fake installed Folio: package.json, migrations, dist/server.js, the ledger. */
export function installFolio(root: string, inst: Installed): void {
  const dir = path.join(root, "node_modules/folio");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "migrations"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "folio",
      version: inst.version ?? CLI_VERSION,
      engines: { node: inst.engines ?? ">=26.12.0 <27" },
    }),
  );
  for (const f of inst.migrations ?? SHIPPED) writeFileSync(path.join(dir, "migrations", f), "");
  if (inst.dist !== false) {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist/server.js"), "");
  }
  if (inst.ledger)
    cpSync(path.join(REPO_ROOT, "upgrade-ledger.json"), path.join(dir, "upgrade-ledger.json"));
}

/** Every file under `root` outside node_modules, with its size and mtime: "did anything change". */
export function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules") continue;
      const p = path.join(d, e);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(`${path.relative(root, p)} ${s.size} ${s.mtimeMs}`);
    }
  };
  walk(root);
  return out.sort();
}

export interface Call {
  argv: string[];
  cwd?: string;
}

/**
 * A runner that records every call and answers `wrangler d1 execute` with the
 * given applied migrations (or a canned result), and anything else with success.
 */
export function recorder(
  answer: (argv: string[]) => { status: number; stdout: string; stderr: string } | undefined = () =>
    undefined,
) {
  const calls: Call[] = [];
  const run = (argv: string[], opts: { cwd?: string } = {}) => {
    calls.push({ argv, cwd: opts.cwd });
    return answer(argv) ?? { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

/** The verified shape of `wrangler d1 execute --json` for a select over d1_migrations. */
export function executeAnswer(names: string[]) {
  return {
    status: 0,
    stdout: JSON.stringify([
      { results: names.map((name) => ({ name })), success: true, meta: { duration: 0.1 } },
    ]),
    stderr: "",
  };
}
