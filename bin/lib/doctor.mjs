/**
 * `folio doctor`: is this host set up right, and if not, what fixes it.
 *
 * Read-only (spec 41 decision 4). The only programs it runs are the host's own
 * wrangler with a `select`, and only against a local database whose state
 * directory already exists, because wrangler creates an empty database on first
 * touch. Offline unless `--remote` (Cloudflare) or `--url` (a server the caller
 * started). Every `warn` and `fail` carries a `fix` (decision 5).
 *
 * The checks run in table order. Each is a function of a shared context whose
 * readers (wrangler config, Vite config) are memoised, and a check reads another's
 * result through `need`, so `--check d1.local` still computes `wrangler.d1` without
 * reporting it, and a check whose prerequisite failed answers `skip` naming it.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { appliedMigrations, pending, unknown } from "./d1.mjs";
import { rpc } from "./mcp.mjs";
import { classifyPin } from "./pin.mjs";
import { isFile, REPO_URL, realOrResolved, SPEC } from "./project.mjs";
import { compare, parse as parseVersion, satisfies } from "./semver.mjs";
import { slug } from "./upgrading.mjs";

export const DOCTOR_SCHEMA = "folio.doctor/1";

/** Every check id, in run order. */
export const CHECK_IDS = [
  "node.version",
  "package.pin",
  "package.installed",
  "wrangler.config",
  "wrangler.d1",
  "wrangler.story",
  "wrangler.space",
  "wrangler.do-backend",
  "wrangler.crons",
  "vite.plugin",
  "blocks.module",
  "d1.local",
  "d1.remote",
  "server.mounted",
  "server.schema",
];

const DOCS = {
  ledger: "node_modules/folio/UPGRADING.md#the-schema-ledger",
  trap: "node_modules/folio/UPGRADING.md#the-trap-that-catches-everybody",
  tags: "node_modules/folio/UPGRADING.md#tags-ranges-and-the-lockfile",
  doTags: "node_modules/folio/UPGRADING.md#durable-object-migration-tags",
  wrangler: "node_modules/folio/docs/configuration.md#wranglerjsonc",
  vite: "node_modules/folio/docs/configuration.md#the-vite-plugin",
  refused: "node_modules/folio/docs/configuration.md#refused-at-construction",
  api: "node_modules/folio/docs/api.md",
};

/**
 * @param {ReturnType<import("./project.mjs").readProject>} project
 * @param {{ cliVersion: string, ledger?: any, env?: string | null, remote?: boolean,
 *   url?: string | null, base?: string | null, site?: string | null, token?: string | null,
 *   only?: string[] | null, run: import("./run.mjs").Runner, fetch?: typeof fetch,
 *   nodeVersion?: string, config?: string | null }} opts
 */
export async function doctor(project, opts) {
  const ctx = makeContext(project, opts);
  const results = new Map();
  const need = (id) => {
    if (!results.has(id))
      results.set(
        id,
        CHECKS[id](ctx, need).then((r) => ({ id, ...r })),
      );
    return results.get(id);
  };
  const ids = opts.only?.length ? CHECK_IDS.filter((id) => opts.only.includes(id)) : CHECK_IDS;
  const checks = [];
  for (const id of ids) checks.push(normalise(await need(id), project.folioDir));
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return {
    schema: DOCTOR_SCHEMA,
    cli: opts.cliVersion,
    installed: project.installed?.version ?? null,
    project: project.root,
    env: opts.env ?? null,
    ok: summary.fail === 0,
    summary,
    checks,
  };
}

/** A `warn` or `fail` with no fix is a bug in this file, so it is caught here rather than shipped. */
function normalise(check, folioDir = "node_modules/folio") {
  // Docs anchors name the shipped files where this project has them installed.
  const at = (d) => (d?.startsWith("node_modules/folio/") ? `${folioDir}/${d.slice(19)}` : d);
  if (check.docs) check.docs = at(check.docs);
  for (const f of check.fix ?? []) if (f.docs) f.docs = at(f.docs);
  if ((check.status === "warn" || check.status === "fail") && !check.fix?.length) {
    throw new Error(`doctor: check ${check.id} answered ${check.status} with no fix`);
  }
  if (check.status === "pass") delete check.fix;
  return check;
}

function makeContext(project, opts) {
  const memo = (fn) => {
    let p;
    return () => {
      p ??= fn();
      return p;
    };
  };
  const ctx = {
    project,
    opts,
    run: (step) => ({ kind: "run", local: true, cwd: project.root, ...step }),
    wrangler: memo(() => readWrangler(project, opts)),
    vite: memo(() => readVite(project)),
  };
  return ctx;
}

const skip = (title, detail) => ({ status: "skip", title, ...(detail ? { detail } : {}), fix: [] });
const skipFor = (prereq, why = "did not pass") =>
  skip(`Skipped: needs ${prereq}`, `${prereq} ${why}`);

function installCommand(project) {
  return [project.packageManager, "install"];
}

function addCommand(project, spec, dev = false) {
  const pm = project.packageManager;
  if (pm === "npm") return ["npm", "install", ...(dev ? ["--save-dev"] : []), spec];
  return [pm, "add", ...(dev ? ["-D"] : []), spec];
}

function reinstall(ctx) {
  return [
    ctx.run({ argv: ["rm", "-rf", ctx.project.folioDir] }),
    ctx.run({ argv: installCommand(ctx.project) }),
  ];
}

/** The version a pin should name: what is installed, if that is a release, else this CLI's. */
function pinTarget(ctx) {
  const v = ctx.project.installed?.version;
  return v && parseVersion(v) && compare(v, "1.0.0") >= 0 ? v : ctx.opts.cliVersion;
}

/* ------------------------------------------------------------- readers --- */

async function readWrangler(project, opts) {
  let tool;
  try {
    tool = await project.loadWrangler();
  } catch (err) {
    return { ok: false, reason: "unresolvable", message: String(err?.message ?? err) };
  }
  if (!project.wranglerConfig || !existsSync(project.wranglerConfig)) {
    return { ok: false, reason: "no-config", version: tool.version, module: tool.module };
  }
  const read = (env) =>
    tool.module.unstable_readConfig({ config: project.wranglerConfig, env: env ?? undefined }, {});
  try {
    const config = read(opts.env);
    return {
      ok: true,
      module: tool.module,
      version: tool.version,
      configPath: project.wranglerConfig,
      configDir: path.dirname(project.wranglerConfig),
      config,
      read,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "throws",
      version: tool.version,
      message: String(err?.message ?? err).split("\n")[0],
    };
  }
}

/**
 * The Folio D1 entries of a resolved wrangler config: those whose
 * `migrations_dir`, resolved against the config file's directory, is the same
 * directory as the installed package's migrations (decision 3). Never by name.
 */
export function folioDatabases(config, configDir, project) {
  const target =
    project.installed?.migrationsDir ??
    realOrResolved(path.join(project.root, project.folioDir, "migrations"));
  return (config.d1_databases ?? []).filter(
    (d) => d.migrations_dir && realOrResolved(path.resolve(configDir, d.migrations_dir)) === target,
  );
}

/** The host's Vite config, loaded by its own vite, and the folio plugin in it. */
export async function readVite(project) {
  if (!project.viteConfig) return { ok: false, reason: "none" };
  let tool;
  try {
    tool = await project.loadVite();
  } catch (err) {
    return { ok: false, reason: "unresolvable", message: String(err?.message ?? err) };
  }
  try {
    const loaded = await tool.module.loadConfigFromFile(
      { command: "serve", mode: "development" },
      project.viteConfig,
      path.dirname(project.viteConfig),
      "silent",
    );
    const plugins = await flatten(loaded?.config?.plugins ?? []);
    const plugin = plugins.find((p) => p?.name === "folio");
    const root = path.resolve(path.dirname(project.viteConfig), loaded?.config?.root ?? ".");
    return { ok: true, plugin, api: plugin?.api?.folio ?? null, root, count: plugins.length };
  } catch (err) {
    return { ok: false, reason: "throws", message: String(err?.message ?? err).split("\n")[0] };
  }
}

async function flatten(list) {
  const out = [];
  for (const item of await Promise.all([].concat(list))) {
    if (Array.isArray(item)) out.push(...(await flatten(item)));
    else if (item) out.push(item);
  }
  return out;
}

/** The blocks modules the plugin names, as `[brand | null, specifier]`. */
export function blocksModules(api) {
  if (!api) return [];
  return typeof api.blocks === "string"
    ? [[null, api.blocks]]
    : Object.entries(api.blocks ?? {}).map(([brand, m]) => [brand, m]);
}

/** A module specifier resolved the way a bundler would find it, or `null`. */
export function resolveModuleFile(root, specifier) {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return undefined;
  const base = path.resolve(root, specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"].map((e) => base + e),
    ...["index.ts", "index.tsx", "index.js"].map((f) => path.join(base, f)),
  ];
  return candidates.find(isFile) ?? null;
}

/* -------------------------------------------------------------- checks --- */

const CHECKS = {
  async "node.version"(ctx) {
    const range = ctx.project.installed?.engines;
    if (!ctx.project.installed) return skip("Skipped: Folio is not installed");
    if (!range) return { status: "pass", title: "The installed Folio declares no Node range" };
    const version = (ctx.opts.nodeVersion ?? process.version).replace(/^v/, "");
    const ok = satisfies(version, range);
    const data = { node: version, range };
    if (ok === true) return { status: "pass", title: `Node ${version} satisfies ${range}`, data };
    const fix = [
      {
        kind: "manual",
        text: `Use a Node that satisfies ${range}, the installed Folio's engines.node.`,
      },
    ];
    if (ok === "unknown") {
      return {
        status: "warn",
        title: `Cannot evaluate engines.node "${range}"`,
        detail: "The range uses syntax outside >=, >, <=, <, =, bare versions and ||.",
        data,
        fix,
      };
    }
    return { status: "fail", title: `Node ${version} does not satisfy ${range}`, data, fix };
  },

  async "package.pin"(ctx) {
    const { project } = ctx;
    const target = pinTarget(ctx);
    const want = `${SPEC}#v${target}`;
    if (!project.dep) {
      return {
        status: "fail",
        title: "package.json has no folio dependency",
        fix: [ctx.run({ argv: addCommand(project, want) })],
        docs: DOCS.tags,
      };
    }
    const pin = classifyPin(project.dep.spec);
    const data = { spec: project.dep.spec, kind: pin.kind, field: project.dep.field };
    if (pin.kind === "tag") return { status: "pass", title: `folio is pinned to ${pin.ref}`, data };
    const edit = {
      kind: "edit",
      file: project.pkgPath,
      text: `in ${project.dep.field}`,
      snippet: `"folio": "${want}"`,
    };
    const why = {
      sha: "A full SHA is reproducible, but UPGRADING.md asks for a tag, which names the release.",
      "local-git": "A git+file: install is a local test of an unpushed commit.",
      workspace: "A workspace link is Folio's own monorepo, not an installed release.",
      "short-sha": "A short SHA is not a stable ref: it can become ambiguous.",
      branch: "A branch moves under you: two installs get different code.",
      "semver-range": "#semver: ranges are unsupported; pin an exact tag.",
      "default-branch": "No ref installs whatever the default branch holds today.",
      path: "A path install resolves vite and react from Folio's tree, not yours.",
      registry: "The npm registry's folio is an unrelated package; Folio installs from git only.",
    }[pin.kind];
    const warn = pin.kind === "sha" || pin.kind === "local-git" || pin.kind === "workspace";
    return {
      status: warn ? "warn" : "fail",
      title: `folio is pinned to a ${pin.kind.replace("-", " ")} (${project.dep.spec})`,
      detail: why,
      data,
      fix: warn ? [edit] : [edit, ...reinstall(ctx)],
      docs: DOCS.tags,
    };
  },

  async "package.installed"(ctx) {
    const { project } = ctx;
    const inst = project.installed;
    if (!inst) {
      return {
        status: "fail",
        title: "node_modules/folio is not installed",
        fix: [ctx.run({ argv: installCommand(project) })],
      };
    }
    const data = { version: inst.version, dir: inst.dir };
    if (!inst.hasDist) {
      return {
        status: "fail",
        title: "node_modules/folio has no dist/server.js",
        detail:
          "The package builds itself in `prepare` on install, and a reinstall over an existing copy skips it. Delete the installed copy first.",
        data,
        fix: reinstall(ctx),
        docs: DOCS.trap,
      };
    }
    const pin = project.dep ? classifyPin(project.dep.spec) : null;
    if (pin?.kind === "tag" && pin.version !== inst.version) {
      return {
        status: "fail",
        title: `Installed folio ${inst.version} is not the pinned ${pin.ref}`,
        detail: "The lockfile or node_modules resolved something other than the tag names.",
        data,
        fix: reinstall(ctx),
        docs: DOCS.trap,
      };
    }
    if (!parseVersion(inst.version ?? "") || compare(inst.version, "1.0.0") < 0) {
      return {
        status: "warn",
        title: `Installed folio ${inst.version} predates 1.0.0`,
        detail: "Pre-1.0 builds carried version 0.0.0 and are outside the upgrade ledger.",
        data,
        fix: [
          {
            kind: "manual",
            text: "Follow UPGRADING.md by hand to v1.0.0, then run `folio upgrade`.",
            docs: "node_modules/folio/UPGRADING.md#the-procedure",
          },
        ],
      };
    }
    return { status: "pass", title: `folio ${inst.version} is installed and built`, data };
  },

  async "wrangler.config"(ctx) {
    const w = await ctx.wrangler();
    if (w.ok) {
      return {
        status: "pass",
        title: `Read ${path.relative(ctx.project.root, w.configPath) || w.configPath}${ctx.opts.env ? ` (env ${ctx.opts.env})` : ""}`,
        data: { path: w.configPath, wrangler: w.version, env: ctx.opts.env ?? null },
      };
    }
    if (w.reason === "unresolvable") {
      const declared =
        ctx.project.pkg.devDependencies?.wrangler ?? ctx.project.pkg.dependencies?.wrangler;
      return {
        status: "fail",
        title: "This project's wrangler cannot be resolved",
        detail: w.message,
        fix: [
          ctx.run({
            argv: declared
              ? installCommand(ctx.project)
              : addCommand(ctx.project, "wrangler", true),
          }),
        ],
      };
    }
    if (w.reason === "no-config") {
      return {
        status: "fail",
        title: "No wrangler.jsonc, wrangler.json or wrangler.toml in the project root",
        fix: [
          {
            kind: "manual",
            text: "Create one (node_modules/folio/examples/starter/wrangler.jsonc is the shape), or pass --config.",
            docs: DOCS.wrangler,
          },
        ],
      };
    }
    return {
      status: "fail",
      title: `wrangler ${w.version ?? "(unknown version)"} could not read the config`,
      detail: w.message,
      fix: [
        {
          kind: "manual",
          text: `Fix the error wrangler reports: ${w.message}`,
          docs: DOCS.wrangler,
        },
      ],
    };
  },

  async "wrangler.d1"(ctx, need) {
    if ((await need("wrangler.config")).status !== "pass") return skipFor("wrangler.config");
    const w = await ctx.wrangler();
    const dbs = folioDatabases(w.config, w.configDir, ctx.project);
    const data = {
      databases: dbs.map((d) => ({
        binding: d.binding,
        database_name: d.database_name,
        migrations_table: d.migrations_table ?? null,
      })),
    };
    if (dbs.length === 1) {
      return {
        status: "pass",
        title: `Folio's database is ${dbs[0].database_name} (binding ${dbs[0].binding})`,
        data,
      };
    }
    if (dbs.length > 1) {
      return {
        status: "warn",
        title: `${dbs.length} D1 entries point at Folio's migrations`,
        detail: `${dbs.map((d) => d.binding).join(", ")}. The d1 checks read the first.`,
        data,
        fix: [
          {
            kind: "manual",
            text: "Point migrations_dir at node_modules/folio/migrations on the one database Folio uses, and nowhere else.",
            docs: DOCS.wrangler,
          },
        ],
      };
    }
    const rel = path.relative(
      w.configDir,
      path.join(ctx.project.root, ctx.project.folioDir, "migrations"),
    );
    const copied = (w.config.d1_databases ?? []).find((d) => {
      if (!d.migrations_dir) return false;
      try {
        return readdirSync(path.resolve(w.configDir, d.migrations_dir)).includes("0001_init.sql");
      } catch {
        return false;
      }
    });
    return {
      status: "fail",
      title: copied
        ? `D1 ${copied.binding} uses a copy of Folio's migrations`
        : "No D1 database points migrations_dir at the installed Folio's migrations",
      detail: copied
        ? "A copy drifts from the package on every upgrade. Point it at the package's own directory."
        : "Folio's database is the d1_databases entry whose migrations_dir is node_modules/folio/migrations.",
      data,
      fix: [
        {
          kind: "edit",
          file: w.configPath,
          text: copied ? `on the d1_databases entry for ${copied.binding}` : "in d1_databases",
          snippet: copied
            ? `"migrations_dir": "./${rel}"`
            : `{ "binding": "DB", "database_name": "folio", "database_id": "<from wrangler d1 create folio>", "migrations_dir": "./${rel}" }`,
        },
      ],
      docs: DOCS.wrangler,
    };
  },

  async "wrangler.story"(ctx, need) {
    if ((await need("wrangler.config")).status !== "pass") return skipFor("wrangler.config");
    const w = await ctx.wrangler();
    const b = doBinding(w.config, "StoryDO");
    if (b)
      return { status: "pass", title: `StoryDO is bound as ${b.name}`, data: { binding: b.name } };
    return {
      status: "fail",
      title: "No Durable Object binding for StoryDO",
      detail: "Every document lives in a StoryDO; without the binding nothing can be edited.",
      fix: [
        {
          kind: "edit",
          file: w.configPath,
          text: "in durable_objects.bindings, with a migrations tag creating it under new_sqlite_classes",
          snippet: `{ "name": "STORY", "class_name": "StoryDO" }`,
        },
      ],
      docs: DOCS.wrangler,
    };
  },

  async "wrangler.space"(ctx, need) {
    if ((await need("wrangler.config")).status !== "pass") return skipFor("wrangler.config");
    const w = await ctx.wrangler();
    const b = doBinding(w.config, "SpaceDO");
    if (b)
      return { status: "pass", title: `SpaceDO is bound as ${b.name}`, data: { binding: b.name } };
    return {
      status: "warn",
      title: "No Durable Object binding for SpaceDO",
      detail: "Folio degrades to per-story presence and a page tree that needs a refresh.",
      fix: [
        {
          kind: "edit",
          file: w.configPath,
          text: "in durable_objects.bindings, with a new migrations tag creating it under new_sqlite_classes",
          snippet: `{ "name": "SPACE", "class_name": "SpaceDO" }`,
        },
      ],
      docs: DOCS.wrangler,
    };
  },

  async "wrangler.do-backend"(ctx, need) {
    if ((await need("wrangler.config")).status !== "pass") return skipFor("wrangler.config");
    const w = await ctx.wrangler();
    const backends = classBackends(w.module, w.config.migrations ?? []);
    const story = backends.get("StoryDO");
    const space = backends.get("SpaceDO");
    const spaceBound = Boolean(doBinding(w.config, "SpaceDO"));
    const data = {
      StoryDO: story === undefined ? null : story ? "sqlite" : "kv",
      SpaceDO: space === undefined ? null : space ? "sqlite" : "kv",
    };
    const problems = [];
    const fix = [];
    if (story === undefined) {
      problems.push("StoryDO is created by no migrations tag");
      fix.push({
        kind: "edit",
        file: w.configPath,
        text: "in migrations, a new tag",
        snippet: `{ "tag": "v1", "new_sqlite_classes": ["StoryDO"] }`,
      });
    } else if (story === false) {
      problems.push("StoryDO is KV-backed, and it needs SQLite storage");
      fix.push({
        kind: "manual",
        text: "A deployed class cannot change backend. Create StoryDO under new_sqlite_classes on a Worker that has never deployed it as KV.",
        docs: DOCS.doTags,
      });
    }
    if (spaceBound && space === undefined) {
      problems.push("SpaceDO is bound but created by no migrations tag");
      fix.push({
        kind: "edit",
        file: w.configPath,
        text: "in migrations, a new tag",
        snippet: `{ "tag": "v2", "new_sqlite_classes": ["SpaceDO"] }`,
      });
    }
    if (problems.length) {
      return { status: "fail", title: problems.join("; "), data, fix, docs: DOCS.doTags };
    }
    const notes = ["StoryDO is SQLite-backed"];
    if (data.SpaceDO === "kv")
      notes.push("SpaceDO is KV-backed and must stay so: a deployed class cannot change backend");
    if (data.SpaceDO === "sqlite") notes.push("SpaceDO is SQLite-backed");
    return {
      status: "pass",
      title: "Durable Object backends are right",
      detail: `${notes.join("; ")}.`,
      data,
    };
  },

  async "wrangler.crons"(ctx, need) {
    if ((await need("wrangler.config")).status !== "pass") return skipFor("wrangler.config");
    const w = await ctx.wrangler();
    const crons = w.config.triggers?.crons ?? [];
    if (crons.length)
      return { status: "pass", title: `Cron: ${crons.join(", ")}`, data: { crons } };
    return {
      status: "warn",
      title: `No triggers.crons${ctx.opts.env ? ` in env ${ctx.opts.env}` : ""}`,
      detail:
        "Scheduled publishes never fire and form deliveries never retry. A named environment does not inherit triggers.",
      data: { crons },
      fix: [
        {
          kind: "edit",
          file: w.configPath,
          text: ctx.opts.env
            ? `under env.${ctx.opts.env}, plus a scheduled() handler`
            : "plus a scheduled() handler",
          snippet: `"triggers": { "crons": ["* * * * *"] }`,
        },
      ],
      docs: DOCS.wrangler,
    };
  },

  async "vite.plugin"(ctx) {
    const v = await ctx.vite();
    if (v.reason === "none") return skip("Skipped: no vite.config in the project root");
    if (!v.ok) {
      return {
        status: "fail",
        title: "The Vite config does not load",
        detail: v.message,
        fix: [
          { kind: "manual", text: `Fix the error Vite reports: ${v.message}`, docs: DOCS.vite },
        ],
      };
    }
    if (!v.plugin) {
      return {
        status: "fail",
        title: "The Vite config has no plugin named folio",
        detail: `${v.count} plugins loaded; none is Folio's.`,
        fix: [
          {
            kind: "edit",
            file: ctx.project.viteConfig,
            text: 'in plugins, with `import { folio } from "folio/vite";`',
            snippet: `folio({ blocks: "./src/blocks/index.ts" }),`,
          },
        ],
        docs: DOCS.vite,
      };
    }
    if (!v.api) {
      return {
        status: "warn",
        title: "The installed Folio's Vite plugin predates its api property",
        detail:
          "add block and preview block cannot find the blocks module or base path on their own.",
        fix: [
          {
            kind: "manual",
            text: "Upgrade Folio to v1.4.0 or later, or pass --blocks and --base to add block and preview block.",
          },
        ],
        docs: DOCS.vite,
      };
    }
    return {
      status: "pass",
      title: `The folio plugin is configured (base ${v.api.basePath})`,
      data: { config: ctx.project.viteConfig, blocks: v.api.blocks, basePath: v.api.basePath },
    };
  },

  async "blocks.module"(ctx, need) {
    const plugin = await need("vite.plugin");
    const v = await ctx.vite();
    if (plugin.status === "skip" || !v.ok || !v.api)
      return skipFor("vite.plugin", "gave no options");
    const modules = blocksModules(v.api).map(([brand, spec]) => ({
      brand,
      spec,
      file: resolveModuleFile(v.root, spec),
    }));
    const missing = modules.filter((m) => m.file === null);
    const aliased = modules.filter((m) => m.file === undefined);
    const data = {
      modules: modules.map((m) => ({ brand: m.brand, spec: m.spec, file: m.file ?? null })),
    };
    const label = (m) => (m.brand ? `${m.brand}: ${m.spec}` : m.spec);
    if (missing.length) {
      return {
        status: "fail",
        title: `Blocks module not found: ${missing.map(label).join(", ")}`,
        detail: `Resolved against ${v.root}.`,
        data,
        fix: [
          {
            kind: "edit",
            file: ctx.project.viteConfig,
            text: "point blocks at the module that exports `blocks`",
            snippet: `folio({ blocks: "./src/blocks/index.ts" })`,
          },
        ],
        docs: DOCS.vite,
      };
    }
    if (aliased.length) {
      return {
        status: "warn",
        title: `Cannot resolve an aliased blocks module: ${aliased.map(label).join(", ")}`,
        data,
        fix: [
          {
            kind: "manual",
            text: "Pass --blocks <path> to add block, which cannot follow an alias.",
          },
        ],
      };
    }
    return {
      status: "pass",
      title:
        modules.length === 1
          ? `Blocks module: ${modules[0].spec}`
          : `${modules.length} brand blocks modules`,
      data,
    };
  },

  async "d1.local"(ctx, need) {
    return d1Check(ctx, need, false);
  },

  async "d1.remote"(ctx, need) {
    if (!ctx.opts.remote) return skip("Skipped: pass --remote to read the deployed database");
    return d1Check(ctx, need, true);
  },

  async "server.mounted"(ctx, need) {
    const { url } = ctx.opts;
    if (!url) {
      return skip(
        "Skipped: pass --url to check a running server",
        "Start your dev server and pass its origin as --url to check that createFolio constructed.",
      );
    }
    const base = await baseOf(ctx, need);
    const origin = url.replace(/\/+$/, "");
    const scope = ctx.opts.site ? `/~${ctx.opts.site}` : "";
    const discover = await rpc({
      endpoint: `${origin}${base}${scope}/mcp`,
      method: "server/discover",
      fetch: ctx.opts.fetch,
    });
    const login = await httpGet(ctx, `${origin}${base}/login`);
    const discoverOk = discover.status === 200 && discover.json?.result !== undefined;
    const loginOk = login.status > 0 && login.status < 500;
    const data = { base, discover: discover.status, login: login.status };
    if (discoverOk && loginOk)
      return { status: "pass", title: `Folio answers at ${origin}${base}`, data };
    if (!discoverOk && !loginOk) {
      const quoted = folioLine(discover.text) ?? folioLine(login.text);
      const nothing = discover.status === 0 && login.status === 0;
      return {
        status: "fail",
        title: nothing
          ? `Nothing answers at ${origin}`
          : `Folio is not mounted at ${origin}${base}`,
        detail:
          quoted ??
          (nothing ? login.text : `discover answered ${discover.status}, login ${login.status}`),
        data,
        fix: [
          nothing
            ? { kind: "manual", text: "Start your dev server, then pass its origin as --url." }
            : {
                kind: "manual",
                text: quoted
                  ? "createFolio refused its configuration: fix what the message names, then restart the dev server."
                  : `Check that the Worker calls folio.handle() and that basePath is ${base}.`,
                docs: DOCS.refused,
              },
        ],
        docs: DOCS.refused,
      };
    }
    return {
      status: "warn",
      title: discoverOk
        ? `${base}/login does not answer`
        : `MCP does not answer at ${base}${scope}/mcp`,
      detail: discoverOk
        ? `GET ${base}/login answered ${login.status}.`
        : `server/discover answered ${discover.status}; the login page answers, so the Worker constructed. This is expected with mcp: false.`,
      data,
      fix: [
        {
          kind: "manual",
          text: discoverOk
            ? "Check the auth configuration; the login route should answer."
            : "If MCP is meant to be on, check createFolio's mcp key.",
          docs: DOCS.refused,
        },
      ],
    };
  },

  async "server.schema"(ctx, need) {
    const { url, token, site } = ctx.opts;
    if (!url) return skip("Skipped: pass --url to check a running server");
    if (!token) return skip("Skipped: set FOLIO_TOKEN to a token with content:read");
    const base = await baseOf(ctx, need);
    const origin = url.replace(/\/+$/, "");
    const at = `${origin}${base}${site ? `/~${site}` : ""}/api/v1/schema`;
    const res = await httpGet(ctx, at, token);
    const data = { url: at, status: res.status };
    if (res.status === 200 && res.json) {
      return {
        status: "pass",
        title: `Schema served: ${res.json.types?.length ?? 0} types, ${res.json.blocks?.length ?? 0} blocks`,
        data: { ...data, types: res.json.types?.length ?? 0, blocks: res.json.blocks?.length ?? 0 },
      };
    }
    const code = res.json?.error?.code;
    const fix =
      code === "site_required"
        ? { kind: "manual", text: "This deployment has many sites: pass --site <id>." }
        : res.status === 401 || res.status === 403
          ? {
              kind: "manual",
              text: "FOLIO_TOKEN must be a token with content:read on this deployment.",
              docs: DOCS.api,
            }
          : {
              kind: "manual",
              text: `GET ${at} answered ${res.status}; check the server's log.`,
              docs: DOCS.api,
            };
    return {
      status: "fail",
      title: `GET ${base}${site ? `/~${site}` : ""}/api/v1/schema answered ${res.status}`,
      detail: res.json?.error?.message ?? (res.text || undefined)?.slice(0, 300),
      data: { ...data, code: code ?? null },
      fix: [fix],
    };
  },
};

/* ------------------------------------------------------------- helpers --- */

function doBinding(config, className) {
  return (config.durable_objects?.bindings ?? []).find(
    (b) => b.class_name === className && !b.script_name,
  );
}

/**
 * Class name to "is SQLite-backed", from the migrations' tags. Wrangler's own
 * reading where it exports one, else the same rules: a `new_sqlite_classes` entry
 * is SQLite, a `new_classes` entry is KV, a rename carries its backend across.
 */
function classBackends(module, migrations) {
  if (typeof module.unstable_getDurableObjectClassNameToUseSQLiteMap === "function") {
    return module.unstable_getDurableObjectClassNameToUseSQLiteMap(migrations);
  }
  const map = new Map();
  for (const m of migrations) {
    for (const c of m.new_classes ?? []) map.set(c, false);
    for (const c of m.new_sqlite_classes ?? []) map.set(c, true);
    for (const r of m.renamed_classes ?? []) {
      if (map.has(r.from)) map.set(r.to, map.get(r.from));
      map.delete(r.from);
    }
    for (const c of m.deleted_classes ?? []) map.delete(c);
  }
  return map;
}

async function baseOf(ctx, need) {
  if (ctx.opts.base) return ctx.opts.base;
  await need("vite.plugin");
  const v = await ctx.vite();
  return v.ok && v.api?.basePath ? v.api.basePath : "/folio";
}

async function httpGet(ctx, url, token) {
  const fetchFn = ctx.opts.fetch ?? globalThis.fetch;
  try {
    const res = await fetchFn(url, {
      headers: {
        accept: "application/json, text/html",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json };
  } catch (err) {
    return { status: 0, text: String(err?.cause?.message ?? err?.message ?? err), json: null };
  }
}

/** The first `folio: …` message in a body, with any markup stripped. */
export function folioLine(text) {
  if (!text) return null;
  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
  const m = /folio: [^\n]*/.exec(plain);
  return m ? m[0].trim() : null;
}

/** Where wrangler keeps local D1 state for this config. */
function localStateDir(ctx, configDir) {
  const root = ctx.project.persistTo ?? path.join(configDir, ".wrangler", "state");
  return path.join(root, "v3", "d1");
}

async function d1Check(ctx, need, remote) {
  const d1 = await need("wrangler.d1");
  if (d1.status === "skip" || d1.status === "fail") return skipFor("wrangler.d1");
  const inst = ctx.project.installed;
  if (!inst) return skipFor("package.installed");
  const w = await ctx.wrangler();
  const db = folioDatabases(w.config, w.configDir, ctx.project)[0];
  const env = ctx.opts.env ?? null;
  const common = [
    ...(env ? ["--env", env] : []),
    ...(ctx.opts.config ? ["--config", ctx.opts.config] : []),
  ];
  const persist = !remote && ctx.project.persistTo ? ["--persist-to", ctx.project.persistTo] : [];
  const apply = {
    kind: "run",
    local: !remote,
    cwd: ctx.project.root,
    argv: [
      ctx.project.wranglerBin,
      "d1",
      "migrations",
      "apply",
      db.database_name,
      remote ? "--remote" : "--local",
      ...common,
      ...persist,
    ],
  };
  const where = remote ? "Remote" : "Local";
  const label = `${db.database_name} (binding ${db.binding})`;
  const base = { database: db.database_name, binding: db.binding };

  if (!remote) {
    const dir = localStateDir(ctx, w.configDir);
    if (!existsSync(dir)) {
      return {
        status: "fail",
        title: "No local D1 state yet",
        detail: `Read ${dir}, which does not exist. Applying the migrations creates it.`,
        data: { ...base, stateDir: dir, pending: inst.migrations, unknown: [] },
        fix: [apply],
        docs: DOCS.ledger,
      };
    }
  }

  const read = appliedMigrations({
    cwd: ctx.project.root,
    wranglerBin: ctx.project.wranglerBin,
    database: db.database_name,
    table: db.migrations_table,
    remote,
    env,
    config: ctx.opts.config ?? null,
    persistTo: remote ? null : ctx.project.persistTo,
    run: ctx.opts.run,
  });
  if (!read.ok) {
    const fix =
      read.reason === "auth"
        ? [
            {
              kind: "manual",
              text: "Authenticate wrangler: `npx wrangler login`, or set CLOUDFLARE_API_TOKEN.",
            },
          ]
        : read.reason === "locked"
          ? [{ kind: "manual", text: "The database was locked by another process; retry." }]
          : [
              {
                kind: "manual",
                text: `wrangler could not read ${db.database_name}: ${read.message.split("\n")[0]}`,
              },
            ];
    return {
      status: "fail",
      title: `${where} D1 could not be read${read.reason === "locked" ? " (locked; retry)" : ""}`,
      detail: read.message.split("\n").slice(0, 3).join("\n"),
      data: { ...base, reason: read.reason },
      fix,
    };
  }

  const shipped = inst.migrations;
  const todo = pending(shipped, read.applied);
  const extra = unknown(shipped, read.applied);
  const data = { ...base, pending: todo, unknown: extra };
  if (!todo.length && !extra.length) {
    return {
      status: "pass",
      title: `${where} D1 has every migration the installed Folio ships`,
      data,
    };
  }
  const ledger = inst.ledger ?? ctx.opts.ledger ?? null;
  const lines = [];
  const fix = [];
  if (todo.length) {
    lines.push(`${label}: ${todo.join(", ")}`);
    lines.push(...pendingNotes(ledger, todo));
    if (remote) lines.push("Apply them before deploying the Worker that needs them.");
    fix.push(apply);
  }
  if (extra.length) {
    const newer = ctx.opts.ledger ?? ledger;
    const release = newestReleaseOf(newer, extra);
    lines.push(
      `${label} records ${extra.join(", ")}, which the installed Folio ${inst.version} does not ship: it was migrated by a newer release${release ? ` (v${release.version})` : ""}.`,
    );
    if (release?.rollback === "none") {
      const heading = release.headings.find((h) => /roll-forward/.test(h)) ?? release.headings[0];
      lines.push(
        `v${release.version} is roll-forward only: ${heading ? `${headingUrl(release.version, heading)}` : "an older build cannot run over this database."}`,
      );
    }
    fix.push(
      release
        ? {
            kind: "run",
            local: true,
            cwd: ctx.project.root,
            argv: ["npx", `${SPEC}#v${release.version}`, "upgrade"],
          }
        : {
            kind: "manual",
            text: "Upgrade Folio to the release that shipped these migrations.",
            docs: DOCS.ledger,
          },
    );
  }
  const parts = [];
  if (todo.length)
    parts.push(
      `missing ${todo.length} migration${todo.length === 1 ? "" : "s"} the installed Folio ships`,
    );
  if (extra.length) parts.push(`migrated by a newer Folio (${extra.length} unknown)`);
  return {
    status: "fail",
    title: `${where} D1 is ${parts.join(", and ")}`,
    detail: lines.join("\n"),
    data,
    fix,
    docs: DOCS.ledger,
  };
}

/** For pending files: any `with-deploy`, and each release's headings to read. */
function pendingNotes(ledger, files) {
  if (!ledger) return [];
  const notes = [];
  const releases = new Set();
  for (const f of files) {
    const m = ledger.migrations?.[f];
    if (!m) continue;
    releases.add(m.release);
    if (m.apply === "with-deploy") {
      notes.push(
        `${f} is applied with the deploy, not ahead of it: apply, then deploy immediately, nothing in between.`,
      );
    }
  }
  for (const v of [...releases].sort(compare)) {
    const r = ledger.releases?.find((x) => x.version === v);
    for (const h of r?.headings ?? []) notes.push(`Read: ${headingUrl(v, h)}`);
  }
  return notes;
}

function newestReleaseOf(ledger, files) {
  if (!ledger) return null;
  const versions = files.map((f) => ledger.migrations?.[f]?.release).filter(Boolean);
  if (!versions.length) return null;
  const v = versions.sort(compare).at(-1);
  return ledger.releases?.find((r) => r.version === v) ?? null;
}

export function headingUrl(version, heading) {
  return `${REPO_URL}/blob/v${version}/UPGRADING.md#${slug(heading)}`;
}

/**
 * Folio's database in every environment the wrangler config declares, for
 * `upgrade`'s local and remote steps. A database is identified by `database_id`
 * (its name only when no id is given): two environments that reuse a
 * `database_name` for different databases are two databases, and two that bind the
 * same id are one, listed under both (spec 41 review, H1).
 *
 * Ordered the way `UPGRADING.md` applies migrations, staging before production:
 * named environments first, then the top level (wrangler's default deploy target,
 * usually production), then environments named like production. `missing` names
 * every environment with no Folio database, which `upgrade` refuses to plan around.
 *
 * @returns {Promise<{ databases: { env: string | null, envs: (string | null)[],
 *   database_name: string, database_id: string | null, binding: string }[],
 *   missing: (string | null)[] }>}
 */
export async function databasesByEnvironment(project) {
  const none = { databases: [], missing: [] };
  let tool;
  try {
    tool = await project.loadWrangler();
  } catch {
    return none;
  }
  if (!project.wranglerConfig || !existsSync(project.wranglerConfig)) return none;
  const configDir = path.dirname(project.wranglerConfig);
  let names = [];
  try {
    const raw = tool.module.experimental_readRawConfig({ config: project.wranglerConfig });
    names = Object.keys(raw.rawConfig?.env ?? {});
  } catch {}
  const prod = (n) => /^prod/i.test(n);
  const order = [...names.filter((n) => !prod(n)), null, ...names.filter(prod)];
  const byKey = new Map();
  const missing = [];
  for (const env of order) {
    let config;
    try {
      config = tool.module.unstable_readConfig(
        { config: project.wranglerConfig, env: env ?? undefined },
        {},
      );
    } catch {
      missing.push(env);
      continue;
    }
    const d = folioDatabases(config, configDir, project)[0];
    if (!d) {
      // A top level with no Folio database beside named environments that have one
      // is a layout, not a gap: only a named environment can be missing.
      if (env !== null || names.length === 0) missing.push(env);
      continue;
    }
    const key = d.database_id ? `id:${d.database_id}` : `name:${d.database_name}`;
    const seen = byKey.get(key);
    if (seen) seen.envs.push(env);
    else {
      byKey.set(key, {
        env,
        envs: [env],
        database_name: d.database_name,
        database_id: d.database_id ?? null,
        binding: d.binding,
      });
    }
  }
  return { databases: [...byKey.values()], missing };
}
