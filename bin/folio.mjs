#!/usr/bin/env node
/**
 * Folio's CLI. Five commands, no dependencies.
 *
 *   folio init [dir]            scaffold a new host project
 *   folio agents [file]         write (or refresh) the agent instruction block
 *   folio doctor [dir]          check a host project, writing nothing
 *   folio upgrade [dir]         plan (or --apply the local half of) an upgrade
 *   folio add block <name>      scaffold a block and register it
 *     (and `folio preview block <name>`, which renders one through a running server)
 *
 * Reachable without an npm registry, because Folio has no npm package:
 *
 *   npx github:brendanmckenzie/folio init my-site
 *
 * `init` copies `examples/starter` — a real workspace package that
 * `pnpm typecheck` gates on every commit, which is the only reason to believe
 * the thing it writes compiles — and rewrites four things: the project name,
 * the `folio` dependency (a workspace link becomes this release's tag), the seeded
 * admin's address, and the migrations path.
 *
 * The other commands live in `bin/lib/`, plain ESM a unit test can import. Their
 * argument is in `docs/specs/foundation/agent-cli.md`: they inspect the host's
 * installed Folio and read its config through its own wrangler and vite, and
 * `upgrade` plans from this copy's `upgrade-ledger.json`, which is why
 * `npx github:…#vX.Y.Z upgrade` is how you upgrade to vX.Y.Z.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parse, UsageError } from "./lib/args.mjs";
import {
  addBlockCommand,
  doctorCommand,
  previewBlockCommand,
  upgradeCommand,
} from "./lib/commands.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/brendanmckenzie/folio";
const SPEC = "github:brendanmckenzie/folio";
/** The release this copy of the CLI belongs to. `npx github:...#v1.0.0` runs
 *  the CLI from that tag's checkout, so its own version is the tag to scaffold. */
const VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
const TAG = `v${VERSION}`;
const DEFAULT_EMAIL = "you@example.com";

/** Copied verbatim into the new project; the starter has no .gitignore of its
 *  own because this repository's root one already covers it. */
const GITIGNORE = `node_modules
dist
.wrangler
.dev.vars
worker-configuration.d.ts
.DS_Store
`;

const HELP = `
folio — a Cloudflare-native block CMS

  folio init [dir]        Scaffold a new project into dir (default: the current
                          directory, which must be empty)
  folio agents [file]     Write the Folio instruction block into your AGENTS.md
                          or CLAUDE.md, replacing an existing one in place
  folio doctor [dir]      Check a project: Node, the pin, the installed package,
                          the wrangler bindings, local (and --remote) D1
                          migrations, and a running server (--url). Writes nothing
  folio upgrade [dir]     Plan the upgrade from the installed Folio to this CLI's
                          release. A dry run unless --apply, which runs only the
                          local steps; remote migrations and deploys are printed,
                          never run
  folio add block <name>  Scaffold <name>.tsx beside your blocks module and list
                          it there; --into <block>.<field> also makes it
                          insertable
  folio preview block <name>
                          Render one block through a running server (--url) and
                          save the PNG or HTML; needs FOLIO_TOKEN

Options for init:
  --email <address>       Address seeded as the first admin (default ${DEFAULT_EMAIL})
  --force                 Write into a directory that is not empty

Options for doctor:
  --json                  One JSON value (schema folio.doctor/1) on stdout
  --env <name>            Read this wrangler environment
  --config <path>         The wrangler config, if not wrangler.jsonc/json/toml
  --persist-to <dir>      Where local D1 state lives, if not .wrangler/state
  --remote                Also read the deployed database (needs Cloudflare credentials)
  --url <origin>          Also check a running server at this origin
  --base <path>           Folio's base path, if the Vite plugin cannot say
  --site <id>             The site to read the schema of, on a multi-site deployment
  --check <id>            Run only this check (repeatable)
  FOLIO_TOKEN             A token with content:read, for the schema check

Options for upgrade:
  --json                  One JSON value (schema folio.upgrade/1) on stdout
  --to <vX.Y.Z>           Stop at an earlier release in this CLI's ledger
  --apply                 Run the local steps (pin, reinstall, local D1, typecheck)
  --allow-dirty           Apply over uncommitted package.json or lockfile changes
  --env <name>            Restrict the printed remote steps to one environment
  --config <path>         The wrangler config, if not wrangler.jsonc/json/toml

Options for add block:
  --json                  One JSON value (schema folio.add-block/1) on stdout
  --into <block>.<field>  Add it to that root's blocks({ allow: [...] })
  --label <text>          The editor's label (default: from the name)
  --brand <id>            The brand's blocks module, when there are several
  --blocks <path>         The blocks module, if the Vite plugin cannot say
  --dry-run               Print the diffs and write nothing
  --preview               Then preview it (takes the preview flags below)

Options for preview block:
  --json                  One JSON value (schema folio.preview-block/1) on stdout
  --url <origin>          The running server (required)
  --site <id>             The site, on a multi-site deployment
  --base <path>           Folio's base path, if the Vite plugin cannot say
  --into <block>.<field>  The root field to place it in
  --fields <json>         The block's field values (default: each text field's label)
  --viewport <w>x<h>      The browser size, where a screenshot is taken
  --keep                  Keep the scratch draft afterwards
  FOLIO_TOKEN             A token with content:read, content:read:draft, content:write

Exit codes: 0 success, 1 a failure found or hit, 2 a usage error.

  ${REPO}
`;

main().then(
  (code) => {
    if (typeof code === "number") process.exitCode = code;
  },
  (err) => {
    console.error(`\nfolio: ${err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  },
);

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    console.log(`folio ${VERSION}`);
    return;
  }
  if (command === "init") return init(argv.slice(1));
  if (command === "agents") return agents(argv.slice(1));
  if (command === "doctor") return doctorCommand(argv.slice(1), runtime());
  if (command === "upgrade") return upgradeCommand(argv.slice(1), runtime());
  if (command === "add") return addBlockCommand(argv.slice(1), runtime());
  if (command === "preview") return previewBlockCommand(argv.slice(1), runtime());

  throw new UsageError(`unknown command "${command}". Try \`folio --help\`.`);
}

/** What the library commands need from this copy of the CLI. */
function runtime() {
  return { cliVersion: VERSION, pkgRoot: PKG_ROOT };
}

// --- init -----------------------------------------------------------------

async function init(argv) {
  const { values: flags, positionals: positional } = parse(argv, {
    email: { type: "string" },
    force: { type: "boolean" },
  });
  const target = path.resolve(process.cwd(), positional[0] ?? ".");
  const name = sanitiseName(path.basename(target));

  if (existsSync(target) && !flags.force) {
    const entries = readdirSync(target).filter((e) => e !== ".git" && e !== ".DS_Store");
    if (entries.length > 0) {
      throw new Error(
        `${target} is not empty (${entries.length} entries). Pass --force to write into it anyway.`,
      );
    }
  }

  const template = path.join(PKG_ROOT, "examples", "starter");
  if (!existsSync(template)) {
    throw new Error(
      `the starter template is missing from this copy of the package (looked in ${template}).\n` +
        `  If you installed from npm, the template is not published yet — clone ${REPO} instead.`,
    );
  }

  const email = flags.email ?? (await askEmail());

  console.log(`\n  Scaffolding ${name} into ${target}`);

  await mkdir(target, { recursive: true });
  await cp(template, target, {
    recursive: true,
    // The workspace symlinks a `folio` into examples/*/node_modules. Copying
    // that would be a directory path install, which resolves `vite` from
    // Folio's own tree and lands you with two incompatible `Plugin` types.
    filter: (src) => {
      const rel = path.relative(template, src);
      const top = rel.split(path.sep)[0];
      return !["node_modules", ".wrangler", "dist", ".DS_Store"].includes(top);
    },
  });

  await rewrite(path.join(target, "package.json"), (s) =>
    s
      .replace('"name": "folio-starter"', `"name": ${JSON.stringify(name)}`)
      .replace('"folio": "workspace:*"', `"folio": "${SPEC}#${TAG}"`),
  );
  await rewrite(path.join(target, "wrangler.jsonc"), (s) =>
    s.replace('"name": "folio-starter"', `"name": ${JSON.stringify(name)}`),
  );
  await rewrite(path.join(target, "seed.sql"), (s) => s.split(DEFAULT_EMAIL).join(email));
  await rewrite(path.join(target, "README.md"), (s) =>
    s.replace(/^# folio-starter$/m, `# ${name}`),
  );

  await writeFile(path.join(target, ".gitignore"), GITIGNORE);
  await writeFile(path.join(target, "AGENTS.md"), await agentsFile(name));

  const rel = path.relative(process.cwd(), target);
  const where = !rel ? "." : rel.startsWith("..") ? target : rel;
  console.log(`
  Pinned folio at ${TAG}
  Seeded ${email} as the first admin

  Next:

    ${where === "." ? "" : `cd ${where}\n    `}npm install
    npm run db:local && npm run db:seed
    npm run dev

  Then open http://localhost:5173/folio/login and sign in as ${email}.
  There is no mail binding, so the link is logged to your terminal.
`);
}

/** Prompt only where there is a terminal to prompt at; npx usually has one. */
async function askEmail() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return DEFAULT_EMAIL;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\n  Email for the first admin [${DEFAULT_EMAIL}]: `)).trim();
    return answer || DEFAULT_EMAIL;
  } finally {
    rl.close();
  }
}

// --- agents ---------------------------------------------------------------

const BEGIN = "<!-- folio:begin -->";
const END = "<!-- folio:end -->";

async function agents(argv) {
  const { positionals: positional } = parse(argv, {});
  const explicit = positional[0];
  const target = explicit
    ? path.resolve(process.cwd(), explicit)
    : (firstExisting(["AGENTS.md", "CLAUDE.md"]) ?? path.resolve(process.cwd(), "AGENTS.md"));

  const block = await pasteBlock();
  const existing = existsSync(target) ? await readFile(target, "utf8") : null;

  if (existing === null) {
    await writeFile(target, `${block}\n`);
    console.log(`folio: wrote ${path.relative(process.cwd(), target)}`);
    return;
  }

  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    const next = existing.slice(0, start) + block + existing.slice(end + END.length);
    await writeFile(target, next);
    console.log(`folio: refreshed the block in ${path.relative(process.cwd(), target)}`);
    return;
  }

  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(target, `${existing}${sep}${block}\n`);
  console.log(`folio: appended the block to ${path.relative(process.cwd(), target)}`);
}

/**
 * The block, read out of AGENTS.md rather than duplicated here.
 *
 * AGENTS.md is the file a maintainer edits when the integration rules change,
 * so a second copy in this script would go stale without anything noticing —
 * which is the exact failure the markers exist to prevent.
 */
async function pasteBlock() {
  const source = await readFile(path.join(PKG_ROOT, "AGENTS.md"), "utf8");
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`AGENTS.md has no ${BEGIN} … ${END} block to copy`);
  }
  return source.slice(start, end + END.length);
}

async function agentsFile(name) {
  return `# ${name}

${await pasteBlock()}
`;
}

// --- helpers --------------------------------------------------------------

/** npm package names: lowercase, no spaces, no leading dot or underscore. */
function sanitiseName(raw) {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  return name || "folio-site";
}

async function rewrite(file, fn) {
  const before = await readFile(file, "utf8");
  const after = fn(before);
  if (after !== before) await writeFile(file, after);
}

function firstExisting(names) {
  for (const name of names) {
    const full = path.resolve(process.cwd(), name);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}
