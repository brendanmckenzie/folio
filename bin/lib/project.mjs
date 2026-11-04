/**
 * What the CLI knows about a host project, read once per command.
 *
 * Everything is the *host's*: its `package.json`, the Folio installed in its
 * `node_modules` (never the copy this CLI runs from, which differs whenever it runs
 * through `npx github:…#<tag>`), and its own `wrangler` and `vite`, resolved from
 * its `package.json` (spec 41 decision 2). The two tool readers are injectable so
 * a test can hand in the ones `examples/starter` resolves.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SPEC = "github:brendanmckenzie/folio";
export const REPO_URL = "https://github.com/brendanmckenzie/folio";

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];
const WRANGLER_CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
const VITE_CONFIGS = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
];

/**
 * @typedef {{ module: any, version: string | null }} Tool
 * @typedef {{ wrangler?: () => Promise<Tool>, vite?: () => Promise<Tool> }} Readers
 */

/**
 * @param {string} dir the project root
 * @param {{ config?: string, persistTo?: string, readers?: Readers }} [opts]
 * @returns the project record, or `null` when `dir` holds no readable `package.json`
 */
export function readProject(dir, { config, persistTo, readers = {} } = {}) {
  const root = path.resolve(dir);
  const pkgPath = path.join(root, "package.json");
  let pkgText;
  let pkg;
  try {
    pkgText = readFileSync(pkgPath, "utf8");
    pkg = JSON.parse(pkgText);
  } catch {
    return null;
  }

  const dep = pkg.dependencies?.folio
    ? { field: "dependencies", spec: pkg.dependencies.folio }
    : pkg.devDependencies?.folio
      ? { field: "devDependencies", spec: pkg.devDependencies.folio }
      : null;

  const lock = LOCKFILES.find(([f]) => existsSync(path.join(root, f)));
  const fromField = /^(pnpm|npm|yarn|bun)@/.exec(pkg.packageManager ?? "")?.[1];
  const packageManager = fromField ?? lock?.[1] ?? "npm";
  const lockfile = lock?.[0] ?? null;

  const wranglerConfig = config
    ? path.resolve(root, config)
    : (WRANGLER_CONFIGS.map((f) => path.join(root, f)).find((f) => existsSync(f)) ?? null);
  const viteConfig = VITE_CONFIGS.map((f) => path.join(root, f)).find((f) => existsSync(f)) ?? null;

  const require = createRequire(pkgPath);
  const memo = (fn) => {
    let p;
    return () => {
      p ??= fn();
      return p;
    };
  };

  return {
    root,
    pkgPath,
    pkgText,
    pkg,
    dep,
    packageManager,
    lockfile,
    installed: readInstalled(root),
    wranglerConfig,
    viteConfig,
    persistTo: persistTo ? path.resolve(root, persistTo) : null,
    /** As the spec's fix steps spell it: relative, run with `cwd: root`. */
    wranglerBin: "node_modules/.bin/wrangler",
    loadWrangler: memo(readers.wrangler ?? (() => hostTool(require, "wrangler"))),
    loadVite: memo(readers.vite ?? (() => hostTool(require, "vite"))),
  };
}

/** The Folio in `node_modules`, as installed, or `null` when there is none. */
export function readInstalled(root) {
  const dir = path.join(root, "node_modules", "folio");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const migrationsPath = path.join(dir, "migrations");
  let migrationsDir = null;
  let migrations = [];
  try {
    migrationsDir = realpathSync(migrationsPath);
    migrations = readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
  } catch {}
  let ledger = null;
  try {
    ledger = JSON.parse(readFileSync(path.join(dir, "upgrade-ledger.json"), "utf8"));
  } catch {}
  return {
    dir,
    pkg,
    version: pkg.version ?? null,
    engines: pkg.engines?.node ?? null,
    migrationsDir,
    migrations,
    hasDist: existsSync(path.join(dir, "dist", "server.js")),
    ledger,
  };
}

/** `realpath` where the path exists, else the resolved path, so a comparison still works. */
export function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The project's git state for `files` (relative to the root): `repo: false` when
 * it is not a repository, else the subset with uncommitted changes.
 */
export function gitDirty(project, files, run) {
  const inside = run(["git", "rev-parse", "--is-inside-work-tree"], { cwd: project.root });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return { repo: false, dirty: [] };
  const status = run(["git", "status", "--porcelain", "--", ...files], { cwd: project.root });
  const dirty = status.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).trim());
  return { repo: true, dirty };
}

/** A tool resolved from the host's own dependencies, with its version. */
async function hostTool(require, name) {
  const entry = require.resolve(name);
  const module = await import(pathToFileURL(entry).href);
  let version = null;
  for (let d = path.dirname(entry); d !== path.dirname(d); d = path.dirname(d)) {
    const file = path.join(d, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.name === name) {
      version = pkg.version ?? null;
      break;
    }
  }
  return { module, version };
}

/** A file as committed at `HEAD`, or `null` (not a repository, or not committed). */
export function committedFile(project, rel, run) {
  const r = run(["git", "show", `HEAD:./${rel}`], { cwd: project.root });
  return r.status === 0 ? r.stdout : null;
}
