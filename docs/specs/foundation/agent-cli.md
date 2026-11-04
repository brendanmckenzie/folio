# Feature: An agent-friendly CLI: `folio doctor`, `folio upgrade`, `folio add block`

> **Group:** foundation
> **Build order:** 41
> **Size:** M. Seven new modules under `bin/lib/`, one JSON ledger, one additive property on the Vite plugin, and the smoke-test and docs changes that keep them honest. No `src/server` change, no admin change.
> **Status:** review (built 2026-11-04 on `feat/agent-cli`; the consumer smoke test and `scripts/cli-test.mjs` are not yet run)
> **Wire version:** none. Nothing here crosses the socket or the admin↔preview frame; `PROTOCOL_VERSION` stays at 5
> **Migration:** none. The CLI reads `d1_migrations` and writes nothing to D1 except through `wrangler d1 migrations apply --local`, which is the command a host already runs
> **Build sequence:** v1.4.0, beside spec 40 (authoring guidance and content checks). The two share no source file; both edit `AGENTS.md` and `README.md`, so whichever merges second rebases its prose. Nothing here waits on spec 39.
> **Last updated:** 2026-11-04

## Summary

A host project's health and its upgrades are prose today. `bin/folio.mjs` has two
commands, `init` and `agents` (`bin/folio.mjs:76-77`), and everything after the
scaffold is a person, or an agent, reading `UPGRADING.md` (1,144 lines) and
`docs/configuration.md` and checking a `wrangler.jsonc` by eye. An agent asked
"is this project set up right" or "bump Folio to the latest" has no command to run
and no output it can parse, so it re-derives the answer from documents every time
and gets the order of migrations and deploy wrong exactly as often as a person does.

This spec adds three commands, each with a stable `--json` form and remediation an
agent can execute. **`folio doctor`** checks a host: Node, the pin, the installed
package, the Folio bindings and Durable Object backends in the wrangler config, the
D1 migrations applied locally (and remotely on request) against those the installed
package ships, and (given a running server) that `createFolio` constructed and the
schema is served. **`folio upgrade`** turns the ledger between the installed release
and a target into an ordered plan, dry by default, with `--apply` running only the
local, reversible half. It reads a new machine-readable ledger,
`upgrade-ledger.json`, shipped in the package and cross-checked against
`UPGRADING.md` and `migrations/` by a unit test. **`folio add block <name>`**
scaffolds a block file in the host's blocks module and registers it, and
**`folio preview block <name>`** (also reachable as `add block --preview`) renders
it through the MCP `preview_document` tool against a running server so an agent can
see what it made.

**One premise in the request is narrower than it sounds.** "Scaffold `defineBlock`
plus renderer plus preview registration" is one file and one array entry in Folio,
not three artefacts. A block is schema and renderer in one `defineBlock` call
(`src/core/block.ts:13-47`, `examples/starter/src/blocks/hero.tsx:3-6`), and the
preview bundle is *generated* from the same `blocks` module the Worker renders with
(`src/vite/index.ts:330-348`): listing the block in `blocks` is the preview
registration. What is genuinely a third edit is making the block *insertable*:
naming it in some root's `blocks({ allow: [...] })` slot
(`examples/starter/src/blocks/page.tsx:27`). `add block` does that with `--into`.

## Ground truth

Read at `704fbf9` (main, v1.3.1). Line numbers are from that commit.

**The CLI (`bin/folio.mjs`, 265 lines, no dependencies):**

- Dispatch is `main()` at `bin/folio.mjs:64-80`: `--help`, `--version`, `init`,
  `agents`, and `unknown command` otherwise.
- `VERSION` is the running copy's own `package.json` version (`:30`) and `TAG` is
  `v${VERSION}` (`:31`). The header comment states the design the new commands reuse:
  `npx github:brendanmckenzie/folio#v1.0.0 init` runs the CLI from that tag's
  checkout, so the CLI's own version is the release it speaks for (`:28-29`).
- `init` copies `examples/starter`, filtering `node_modules`, `.wrangler`, `dist`
  (`:111-121`), and rewrites the `folio` dependency from `workspace:*` to
  `github:brendanmckenzie/folio#${TAG}` (`:123-127`). It prompts for an email only on
  a TTY (`:157-166`), so it runs unattended under the smoke test.
- `agents` copies the `<!-- folio:begin -->` / `<!-- folio:end -->` block out of the
  package's own `AGENTS.md` (`:170-218`), replacing an existing block in place.
- `parseArgs` (`:229-241`) is one global parser that knows only `--force` and
  `--email` and throws on any other `--` option. Every new command needs its own
  flags, so it is replaced (decision 11).
- No test imports `bin/folio.mjs`. Its only coverage is the smoke test running
  `init` (`scripts/release.mjs:426`).

**The package (`package.json`):**

- `"version": "1.3.1"`, `"private": true` (`:3-4`); `engines.node` is
  `">=26.12.0 <27"` (`:9-11`); `.nvmrc` is `26.13.0`.
- `"bin": { "folio": "./bin/folio.mjs" }` (`:28`). `files` (`:29-46`) ships `bin`
  (the whole directory, so a `bin/lib/` ships with no change), `migrations`,
  `examples/starter`, `UPGRADING.md`, `CHANGELOG.md`, `AGENTS.md` and four docs.
  It does not ship `scripts/`.
- The npm name `folio` belongs to an unrelated package (the Playwright team's
  pre-Playwright runner, 0.3.x), so a registry range such as `"folio": "^1.3.0"`
  installs a stranger's code. Consumers install from git only.
- An installed git dependency's `node_modules/folio/package.json` carries the
  release's `version` (`1.3.1` at this commit). Pre-1.0 SHAs carried `0.0.0`.
- Tags `v1.0.0` through `v1.3.1` exist (nine). Migrations by tag, from
  `git ls-tree <tag> migrations/`:

  | Release | Migrations first shipped |
  | --- | --- |
  | v1.0.0 | `0001`–`0008`, `0010`, `0011`, `0013` |
  | v1.1.0 | `0014_form_logic.sql` |
  | v1.2.0 | `0015_draft_data.sql` |
  | v1.2.1–v1.2.4 | none |
  | v1.3.0 | `0016_option_sources.sql`, `0017_form_actions.sql` |
  | v1.3.1 | none |

**The ledger as it stands (`UPGRADING.md`):**

- The procedure (`:17-46`) is seven shell steps: find the tag, read, `rm -rf
  node_modules/folio` then install, `wrangler d1 migrations apply --local`,
  typecheck, run, then remote apply before deploy. "Apply migrations before the
  Worker that needs them goes live" (`:48-54`).
- The schema ledger table (`:94-111`) has one row per migration and a free-text
  "Anything else to do". The machine-relevant content buried in it: `0002` and
  `0005` need a reindex; `0015` needs `POST {base}/api/reindex?drafts=1` once;
  `0011` is "apply it, then deploy, within minutes, with no role changes or
  invitations in between, then run the post-deploy grant statement"; `0013`–`0017`
  are each "apply it before you deploy".
- `0012_users_role_contract.sql` is **claimed and not in the package** (`:113`):
  it drops `users.role` / `users.role_from` in the release after the one carrying
  `0011`, and must never be applied in the same step as `0011`. The same line states
  the fact the CLI relies on for gaps: "wrangler applies whatever is unapplied by
  filename, so a database that takes `0013` first takes `0012` later".
- `### v1.3.0 is roll-forward only` (`:889-932`): a v1.2.x build cannot be
  redeployed over a v1.3.0 database.
- `0011`'s rollback "needs one statement first and loses two writes, and is
  impossible once `sites` is on" (`:1090-1103`).
- Release-specific `###` headings name their tag, e.g. `### Form actions (v1.3.0)`,
  `### SpaceDO migration (v1.3.1)`; `### v1.3.0 is roll-forward only` names it
  without parentheses. One versioned-in-fact heading names no tag:
  `### A story with no Durable Object opens with its content (2026-10-19)`
  (`:211`), first contained in v1.1.0 (`git tag --contains cfac8c5`). Nothing links
  to its anchor.
- `scripts/release-notes.mjs` exports `upgradingEntries(markdown, tag)` (`:15-33`):
  every `###` section whose heading `includes(tag)`, fence-aware. `release.yml` feeds
  it to `gh release create`. `test/unit/scripts/release-notes.test.ts` covers it.

**Wrangler (as consumers have it):**

- The starter's Folio D1 entry is `"database_name": "folio"` with
  `"migrations_dir": "./node_modules/folio/migrations"`
  (`examples/starter/wrangler.jsonc:53-61`); `examples/demo` points at
  `../../migrations` instead. Bindings are named by the host:
  `takeoffgo/group-web/wrangler.jsonc` uses `FOLIO_DB`, `FOLIO_STORY`,
  `FOLIO_SPACE`, with per-environment `database_name`s under `env.staging` /
  `env.production` and a comment that `triggers` is not inherited by a named
  environment. **So Folio's bindings can be found only by `class_name` and by
  `migrations_dir`, never by binding name.**
- `wrangler` (4.114.0 in the workspace and in the starter's range) exports
  `unstable_readConfig(args, options)` (`wrangler-dist/cli.d.ts:1084`), which reads
  `wrangler.json`/`.jsonc`/`.toml`, resolves a named `env`, and returns `main`,
  `d1_databases`, `durable_objects.bindings`, `triggers`, `migrations`,
  `configPath`. Verified against `group-web` for the top level and `env: "staging"`:
  each returned its own `database_name`, both Folio DO bindings, and the crons. It
  also exports `unstable_getDurableObjectClassNameToUseSQLiteMap(migrations)`
  (`:1092`), which for `group-web` answers `StoryDO → true`, `SpaceDO → false`
  (SpaceDO deployed under `new_classes`, which `UPGRADING.md` "SpaceDO migration
  (v1.3.1)" says to leave alone).
- `StoryDO` is SQLite-backed by necessity: `src/server/story-do.ts` has 15
  `storage.sql` uses. `SpaceDO` has none (`src/server/space-do.ts:5`).
- The applied-migrations ledger is the table `d1_migrations` (wrangler's
  `DEFAULT_MIGRATION_TABLE`, overridable per database by `migrations_table`), and
  `name` is the file name. Verified on the demo's local database: rows
  `0001_init.sql` … `0015_draft_data.sql` (a stale local database missing `0016`
  and `0017`, which is the exact case `doctor` exists to report).
- `wrangler d1 execute folio --local --json --command "select name from
  d1_migrations order by id"` prints `[{ "results": [{ "name": "0001_init.sql" },
  …], "success": true, … }]` and exits 0. Against a missing table it prints
  `{ "error": { "text": "no such table: …: SQLITE_ERROR" } }` and exits 1. Both
  verified in `examples/demo`.
- `wrangler d1 migrations apply` runs unprompted without a TTY: the smoke test
  already runs `npm run db:local` with piped stdio (`scripts/release.mjs:434`).

**The Vite plugin (`src/vite/index.ts`):**

- `FolioPluginOptions` is `{ blocks: string | Record<brand, string>; basePath?: string }`
  (`:48-62`). The plugin returns `[main]`, one plugin named `"folio"` (`:94-95`).
- The preview entry is generated: `import * as m from <blocks module>;
  mountPreview(m.blocks, { wrap: m.wrap })` (`:330-348`). There is no separate
  preview registration to scaffold.
- The plugin exposes nothing of its options. `vite`'s exported
  `loadConfigFromFile({ command: "serve", mode: "development" }, undefined, root)`
  loads a host's config and its flattened `plugins` include the `"folio"` plugin:
  verified against `group-web`'s `vite.config.ts` (39 plugins, one named `folio`,
  brand record form `{ allaboutafrica: "./app/brands/allaboutafrica/folio/blocks/index.ts", takeoffgo: … }`).
  It left that working tree clean.

**Block modules as hosts write them:**

- Starter: `src/blocks/index.ts:16-25`, `export const blocks = [ page, hero, prose,
  button ]` with comments inside the array, named imports one per line, double
  quotes, semicolons. Each block is `export const <name> = defineBlock({ name:
  "<name>", … })` in its own file.
- Demo: `examples/demo/src/blocks/index.ts:21` onward, the same shape with longer
  comments inside the array.
- `group-web`: `app/brands/takeoffgo/folio/blocks/index.ts`, a leading
  `export { PreviewWrap as wrap } from "../render/PreviewWrap";`, a side-effect
  `import "../../styles/global.scss";`, then named imports and
  `export const blocks = [ pageRoot, hero, … ]`. Block names are camelCase
  (`ctaLink`, `travelCardContainer`).
- `defineBlock` does not validate a block name (`src/core/block.ts:49-51`);
  `toRegistry` refuses a duplicate (`:98`). `blocks()` requires `allow`
  (`src/core/fields.ts:203`, `:311`).

**Server surfaces the CLI calls (all existing; none changes):**

- `{base}/mcp` speaks MCP revision `2026-07-28` (`src/server/mcp/rpc.ts:52`):
  every POST carries `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` for a
  `tools/call`, and `_meta["io.modelcontextprotocol/protocolVersion"]` in the body.
  `server/discover` answers with no credential (`scripts/mcp-test.mjs:91-145` is
  the working client, 40 lines).
- `preview_document` (`src/server/mcp/tools.ts:266-304`) needs
  `content:read:draft` (`READ_DRAFT`, `src/server/auth/roles.ts:341`). Without a
  `browser` binding, which is always the case against a local dev server, it
  answers the draft URL and the rendered HTML as text and says so
  (`src/server/mcp/shot.ts:409-420`); with one it answers a PNG. A record type with
  no page answers "nothing to render" (`shot.ts:349-357`).
- v1 routes (`docs/api.md:54-72`): `GET /api/v1/schema` (`content:read`,
  `400 site_required` unscoped on a branded deployment), `GET /api/v1/search`
  (reaches drafts, `?q=` matches title, slug and path), `POST /api/v1/documents`
  and `DELETE /api/v1/documents/:id` (both `content:write`; delete takes
  `?redirect=`, `tools.ts:513-515`). Under `~<site>` on a multi-site deployment.
- The manifest is `{ types: DocumentType[], blocks: BlockSchema[], … }`
  (`src/core/schema.ts:136-150`); a `BlockSchema` has `name`, `label`, `fields`
  (`:29-34`).
- `createFolio` refuses a bad configuration at construction
  (`docs/configuration.md:1028-1058`); the messages are `folio: …`-prefixed
  (`src/server/runtime.ts`, 11 such throws). A construction failure is therefore a
  Worker that cannot evaluate its module, which a dev server answers with a 5xx.
- The Node-side TypeScript closure of `src/server/mcp/` is not importable from a
  script: `mcp/tools.ts` reaches `server/pages.tsx`, and Node does not transform
  JSX (`scripts/mcp-test.mjs:26-35`). Node also refuses to strip types from a `.ts`
  file under `node_modules`. **So nothing in `bin/` may import from `src/`**; shared
  constants are literals, pinned to source by a unit test.

**The release gates (`scripts/release.mjs`):**

- `smokeTest` (`:240-368`) installs over `git+file://<repo>#<sha>`, checks every
  `exports` leaf, the anchor names (`:291-306`), and a `shipped` file list
  (`:340-351`) that includes `bin/folio.mjs` and `UPGRADING.md`.
- `consumerBoots` (`:414-501`) runs `folio init app` (`:426`), rewrites the pin to
  the `git+file:` spec (`:429-432`), `npm install` (`:433`), `npm run db:local`
  (`:434`), boots `vite dev` on a free port in its own process group, probes `/` and
  `/folio/login` (`:484-489`), and `npm run build` (`:499`). That sequence is the
  only place the new commands can run against a real installed package.
- `release.yml` runs `release.mjs --tag --ci` and then `release-notes.mjs`.
- `scripts/e2e-all.sh:30` globs `scripts/*-test.mjs`, so a new `cli-test.mjs` joins
  the tagged sweep with no wiring.

**tests:**

- `vitest.config.ts` runs `test/unit/**` in Node, so `.mjs` modules under `bin/`
  are importable from a unit test (`release-notes.test.ts` already imports an
  `.mjs` with a computed specifier to keep it out of `tsc`).
- The repository root has no `wrangler` or `vite` of its own resolvable from a
  fixture directory: both resolve from `examples/starter/node_modules`.

## User stories

### An agent checks a project before touching it
**As** a coding agent in a host repository **I want to** run one command and get a
list of what is wrong, each with the command that fixes it, **so that** I fix the
project instead of rediscovering its setup from documentation.

### An agent upgrades Folio without getting the order wrong
**As** a coding agent asked to "bump Folio" **I want to** see the releases between
the installed one and the target, the migrations they bring, which have to land
before the deploy, and which releases cannot be rolled back, **so that** the commit
I prepare and the deploy instructions I hand back are right.

### A developer adds a block and sees it
**As** a developer (or their agent) **I want to** scaffold a block, make it
insertable, and get a rendered preview from my running dev server, **so that** I
start from a correct file and know the registration worked before I open the editor.

### A maintainer cannot ship a ledger that disagrees with the prose
**As** the Folio maintainer **I want** the machine ledger, the migrations directory
and `UPGRADING.md`'s release headings checked against each other on every PR **so
that** the plan `upgrade` prints is never older than the document it summarises.

## Architecture decisions

### 1. Three commands in the existing zero-dependency `bin/folio.mjs`, split into `bin/lib/*.mjs` modules

The commands live in the CLI that already ships, as plain ESM with no dependencies,
and the logic moves into importable modules (`bin/lib/`) so it can be unit-tested
without spawning a process.

**Rejected: a separate `@folio/cli` package, or a TypeScript CLI built into
`dist/`.** There is no registry to publish a second package to, and `npx
github:brendanmckenzie/folio#vX.Y.Z <command>` already resolves *this* package's
`bin` at a tag, which is the property `upgrade` depends on (decision 6). A built
CLI would make the CLI depend on `prepare` succeeding, which is the failure
`doctor` has to diagnose (`package.installed`): a doctor that cannot start when
`dist/` is missing cannot report that `dist/` is missing.

### 2. The CLI inspects the host's *installed* Folio, and reads the host's tools through the host's own copies of them

`doctor` and `add block` read `node_modules/folio` (its `package.json`, its
`migrations/`, its `engines`), not the copy of the package the CLI is running
from. The two differ whenever the CLI runs through `npx github:…#<tag>`, and the
question is always about what the host has. The wrangler config is read with the
host's own `wrangler` (`unstable_readConfig`, resolved with `createRequire` from the
host's `package.json`), and the Vite config with the host's own `vite`
(`loadConfigFromFile`).

**Rejected: parsing `wrangler.jsonc` and `vite.config.ts` in the CLI.** JSONC is
easy; TOML, named-environment inheritance rules (which keys a named `env` inherits
and which, like `triggers`, it does not) and a Vite config that is a function of the
mode are not, and a reimplementation would be wrong in exactly the places hosts
differ (`group-web` uses all three). The cost accepted: `unstable_readConfig` is
named unstable. It is pinned by a unit test run against the starter's wrangler, and
a throw from it is reported as `wrangler.config` failing with the wrangler version
named, never as a crash.

### 3. Folio's bindings are identified by what they are, not what they are called

The Folio D1 database is the `d1_databases` entry whose `migrations_dir`, resolved
against the config file's directory, has the same real path as
`node_modules/folio/migrations`. The story object is the `durable_objects.bindings`
entry with `class_name: "StoryDO"` and no `script_name`; the space channel is
`class_name: "SpaceDO"`.

**Rejected: checking for `DB`, `STORY`, `SPACE`.** Those are the starter's names;
`group-web` uses `FOLIO_DB`, `FOLIO_STORY`, `FOLIO_SPACE`, and `bindings: (env) =>
…` lets a host call them anything. A name check would fail every real consumer.
Real-path comparison also covers the demo's `../../migrations`, which is the same
directory as its `node_modules/folio/migrations` through the workspace link.

### 4. `doctor` is read-only, offline by default, and never starts a server

`doctor` runs no command that writes. Local D1 is read with `wrangler d1 execute
--local --json` (a `select`), and only when the local state directory exists
(`.wrangler/state/v3/d1` under the project root, or `--persist-to <dir>`), because
wrangler creates an empty local database on first touch and a doctor that leaves
files behind is not read-only. `--remote` adds the same query against the real
database and needs Cloudflare credentials. `--url <origin>` adds the two server
checks against a server the caller already started.

**Rejected: `doctor --boot`, starting the dev server itself as the smoke test
does.** The starter's dev server is `vite`, but `group-web`'s is `react-router dev`,
so there is no command a doctor could start that is right for every host. Asking for
a URL also makes the same checks work against staging. The cost accepted: config
sanity (createFolio's construction-time refusals) is checked only when a server is
running, and is skipped, with the remediation "start your dev server and pass
`--url`", when one is not.

**Rejected: analysing the host's TypeScript for `createFolio` keys or a `StoryDO`
re-export.** The server entry cannot be imported under Node (`folio/server` needs
`cloudflare:workers`), and a textual check is wrong for every host that re-exports
through a second module. A construction failure is observed where it happens: in
the Worker, through `--url`.

### 5. Every check result carries remediation as data, and says whether it is safe to run unasked

A `fail` or `warn` carries `fix`, an ordered list of steps, each one of three kinds:
`run` (an `argv` and a `cwd`, executed as written, no shell), `edit` (a file and a
literal snippet), or `manual` (prose plus a docs anchor). A `run` step carries
`local: true` when it touches only this machine and is undone by a reset (`rm -rf
.wrangler/state`, `git checkout`), and `local: false` when it reaches Cloudflare.

**Rejected: a human sentence per failure.** An agent would have to parse prose into a
command, which is the step that goes wrong. `local` exists because the line an agent
must not cross on its own is exactly local-versus-remote: applying a migration to
`--local` is free, applying it `--remote` before the right deploy can make a
roll-forward-only release irreversible.

### 6. `upgrade` targets the version of the CLI that runs it; `--to` may name only a release the running CLI's ledger contains

The plan for "upgrade to vX.Y.Z" comes from vX.Y.Z's own ledger, so the instruction is
`npx github:brendanmckenzie/folio#vX.Y.Z upgrade`: npx fetches that tag, and the
CLI's ledger *is* the target's ledger. `--to` accepts any release in the running
ledger between the installed version and the CLI's own (to stop at an intermediate
hop); a `--to` newer than the CLI is refused with the exact `npx` command that would
plan it.

**Rejected: fetching the target's ledger from `raw.githubusercontent.com`.** It works
(the repository is public) but it is a second, network-dependent code path that no
gate can exercise before a tag exists, and it would run an old CLI's logic over a new
ledger. Running the target's CLI is one path and is the one `init` already uses.

### 7. `upgrade` is a dry run by default; `--apply` runs only the local, reversible steps, and never the remote half

With no flag, `upgrade` prints (or `--json` returns) the plan and exits 0. With
`--apply` it executes, in order: rewrite the pin in `package.json` to
`github:brendanmckenzie/folio#vX.Y.Z`, `rm -rf node_modules/folio` (the trap at
`UPGRADING.md:70-80`), the package manager's install, `wrangler d1 migrations apply
<db> --local` (per environment's local database when `--env` is given), `folio
agents` when the host's `AGENTS.md` or `CLAUDE.md` carries the markers, the host's
`typecheck` script if it has one, and finally `doctor` restricted to the package and
local-D1 checks. It refuses to start when `package.json` or the lockfile has
uncommitted changes (or the project is not a git repository) unless
`--allow-dirty`, because the rollback of an applied plan is `git checkout` of those
two files plus a reinstall, and that rollback has to exist before anything runs.

Remote migration and deploy steps are always printed and never run, under any flag
(`--apply`, `--allow-dirty` and every later flag included), in the order the
ledger demands, with one `wrangler d1 migrations apply <db> --remote [--env <e>]`
per Folio database the config declares.

**Rejected: `--apply` by default.** An agent runs a command to find out what it
does; a default that edits `package.json` and reinstalls turns "what would this
do" into a change. **Rejected: an `--apply --remote` mode.** Remote apply is
coupled to a deploy the CLI does not own (`group-web` deploys from CI on a branch
push, All About Africa from a laptop), `0011`'s "apply then deploy within minutes"
cannot be honoured by a tool that does not do the deploy, and a remote apply ahead of
a roll-forward-only release is the irreversible step. The cost accepted: the remote
half of every upgrade stays a person's (or an explicitly instructed agent's) act.

### 8. A machine-readable companion ledger, `upgrade-ledger.json`, shipped at the package root and cross-checked against the prose

`UPGRADING.md` stays the document people read. `upgrade-ledger.json` carries only
what a plan is computed from: per migration, the release that first shipped it, when
to apply it relative to the deploy, and its post-deploy steps; per release, its
migrations, its `UPGRADING.md` headings, its rollback class, and any hop it forces;
and the claimed-but-unwritten migrations. A unit test fails when any of the three
sources disagree (Testing requirements).

**Rejected: parsing `UPGRADING.md`.** Its ledger table's "Anything else to do" column
is prose ("Apply it, then deploy, within minutes, with no role changes or
invitations in between"), its release headings name their tag in three different
spellings, and the fact a plan most needs (`0012` must never be applied with `0011`)
is a sentence under the table. A parser would be a second, silent interpretation of
the document. **Rejected: YAML front matter in `UPGRADING.md`.** It puts 150 lines
of data above the procedure people open the file for, GitHub renders it as a table
at the top, and the CLI would still need a YAML parser it does not have. **Rejected:
`migrations/ledger.json`.** `migrations/` is a host's `migrations_dir`; a file that
is not SQL has no business in a directory wrangler owns.

### 9. A hop is forced only by a release that declares it

A release may declare `requiresDeployed: "X.Y.Z"`: a host whose installed version is
below X.Y.Z cannot cross into this release in one step, and the plan splits into two
hops, the first ending at the newest release before it. `--apply` runs only the first
hop and the plan says to deploy before running `upgrade` again. No current release
declares one. **This is how `0012` will be expressed** when it ships: its release
declares `requiresDeployed` on the release carrying `0011` (v1.0.0), so an upgrade
from below it can never apply both in one step, which is the rule at
`UPGRADING.md:113` made executable.

**Rejected: inferring hops from migration contents.** "Not purely additive" is a
judgement made once, by the person writing the migration, and recorded in prose
today; the ledger records it as a field instead of asking the CLI to rediscover it.

### 10. `add block` edits text, under strict patterns, and refuses rather than guesses

The blocks module is found from the Vite plugin's options (decision 13), or
`--blocks <path>`. `add block <name>` writes `<dir>/<name>.tsx` from a template
modelled on `examples/starter/src/blocks/prose.tsx`, adds `import { <name> } from
"./<name>";` after the module's last top-level import, and appends `<name>,` as the
last element of the `export const blocks = [ … ]` array literal. `--into
<block>.<field>` also appends `"<name>"` to that field's `allow: [ … ]` in the file
that declares `name: "<block>"`. Quote style, semicolons and element indentation are
taken from the file being edited. Every edit is computed first; if any pattern does
not match exactly once, nothing is written and the command exits 1 with the edit the
caller must make by hand as an `edit` fix.

**Rejected: the TypeScript compiler API.** The workspace is on TypeScript 7
(`typescript@7.0.2`), whose programmatic API is exported only under `./unstable/*`,
and a host may have either major. Depending on it would make `add block` fail on
whichever one a host does not have. **Rejected: regenerating the blocks module.**
Hosts keep comments, a `wrap` export and side-effect imports in it (`group-web`); a
rewrite loses them. A small scanner that knows strings, template literals and both
comment forms is enough to find one array literal's closing bracket, and refusing on
anything unusual costs a manual two-line edit, which the output spells out.

### 11. Flags are parsed per command with `node:util` `parseArgs`, strictly

Each command declares its options; an unknown option is a usage error with exit 2.
`init` and `agents` keep their flags and behaviour exactly.

**Rejected: extending the one global `parseArgs` (`bin/folio.mjs:229-241`).** It would
accept `--email` on `doctor` and `--remote` on `init`. `node:util` `parseArgs` is in
every supported Node and costs no dependency.

### 12. Preview writes one scratch draft per block, through the token's own routes, and deletes it

`preview block <name>` (and `add block --preview`) needs `--url` and `FOLIO_TOKEN`
(a token with `content:read`, `content:read:draft` and `content:write`). It waits for
the block to appear in `GET {base}/api/v1/schema` (up to 60 seconds, polling every
second, because the dev server reloads the Worker after the file changes), finds a
`kind: "page"` type whose root block has a `blocks` field allowing the block (the
`--into` field when given), creates an unpublished top-level draft with slug
`folio-scratch-<name>` containing one instance of the block (or replaces the
content of the existing one, found through `GET /api/v1/search`), calls MCP
`preview_document` on it, saves the PNG or the HTML under the OS temp directory, and
deletes the draft with `?redirect=false` unless `--keep`.

**Rejected: rendering the block in Node.** The renderer is the host's TSX, bundled
by the host's Vite with the host's plugins; reproducing that pipeline outside the dev
server is the job the dev server already does. **Rejected: deleting through MCP
`delete_document`.** It needs `admin` (`SCOPE_ADMIN`, `tools.ts:517`); the v1 route
needs `content:write`, which the token already has to create the draft. MCP is used
for the one call that has no v1 route. The cost accepted: a scratch draft briefly
appears in any open editor's tree (the space channel broadcasts structure) and in
the activity trail under the token's name. It is never published, so it never
reaches a live page, a cache or the search index.

### 13. The Vite plugin exposes its resolved options on its `api` property

`folio()`'s plugin object gains `api: { folio: { version: 1, blocks, basePath } }`,
with `basePath` defaulted to `/folio`. Vite documents `api` as the channel for
plugin-to-plugin and tool-to-plugin data. `doctor` reports the blocks modules and
base path from it, and `add block` and `preview block` read it instead of asking.

**Rejected: a regex over `vite.config.ts`.** `group-web` builds its options inside a
function. Loading the config is what Vite itself does, so the answer is the one the
build uses. A host whose installed plugin predates `api` gets a `warn` naming
`--blocks` and `--base` as the explicit forms; nothing fails because of it.

### 14. Output is versioned by a `schema` string, and exit codes are fixed

Each `--json` answer starts with `"schema": "folio.doctor/1"` (or
`folio.upgrade/1`, `folio.add-block/1`, `folio.preview-block/1`). Adding a check id,
a fix kind or an optional field keeps the number. Removing or renaming a field, or
changing its meaning, bumps `/N`. A bump may ship in a minor release, and it is listed
under Breaking changes in `CHANGELOG.md`, because the `schema` string is the
contract an agent branches on and the package version is not. Exit codes: **0** success (doctor:
no `fail`; warnings allowed), **1** the command ran and found or hit a failure,
**2** usage error (unknown flag, bad name, unreadable project root). Human output and
JSON carry the same facts; JSON goes to stdout and nothing else does under `--json`.

**Rejected: tying output shapes to the package's semver, so that a bump of `/N` waits
for a major.** The CLI's JSON is read by agents that check `schema` first and refuse
what they do not know; a major release for every reshaped answer would make the
number a hurdle rather than a signal.

**Rejected: inferring success from output.** This repository's own CLAUDE.md records
two gates that printed success while failing; an agent gates on the exit code, so the
exit code has to be the whole verdict.

## Wire & schema changes

### D1 migration

None.

### Core types

None. `src/core` is not touched.

### The Vite plugin

`src/vite/index.ts`: the `main` plugin object (`:94`) gains

```ts
api: { folio: { version: 1, blocks: options.blocks, basePath: base } },
```

Additive; `FolioPluginOptions` is unchanged.

### `upgrade-ledger.json` (new, package root, shipped)

```json
{
  "schema": "folio.ledger/1",
  "migrations": {
    "0001_init.sql":            { "release": "1.0.0", "apply": "before-deploy" },
    "0002_asset_refs.sql":      { "release": "1.0.0", "apply": "before-deploy",
                                  "after": [{ "kind": "reindex" }] },
    "0003_schedules.sql":       { "release": "1.0.0", "apply": "before-deploy" },
    "0004_shares.sql":          { "release": "1.0.0", "apply": "before-deploy" },
    "0005_content_fts.sql":     { "release": "1.0.0", "apply": "before-deploy",
                                  "after": [{ "kind": "reindex" }] },
    "0006_auth.sql":            { "release": "1.0.0", "apply": "before-deploy" },
    "0007_passkeys.sql":        { "release": "1.0.0", "apply": "before-deploy" },
    "0008_asset_organisation.sql": { "release": "1.0.0", "apply": "before-deploy" },
    "0010_forms.sql":           { "release": "1.0.0", "apply": "before-deploy" },
    "0011_sites.sql":           { "release": "1.0.0", "apply": "with-deploy",
                                  "after": [{ "kind": "manual",
                                              "text": "Run the post-deploy grant statement.",
                                              "heading": "0011: roles move to `site_roles` (2026-09-29) (v1.0.0)" }] },
    "0013_site_brands.sql":     { "release": "1.0.0", "apply": "before-deploy" },
    "0014_form_logic.sql":      { "release": "1.1.0", "apply": "before-deploy" },
    "0015_draft_data.sql":      { "release": "1.2.0", "apply": "before-deploy",
                                  "after": [{ "kind": "reindex", "drafts": true }] },
    "0016_option_sources.sql":  { "release": "1.3.0", "apply": "before-deploy" },
    "0017_form_actions.sql":    { "release": "1.3.0", "apply": "before-deploy" }
  },
  "claimed": [
    { "file": "0012_users_role_contract.sql",
      "rule": "Drops users.role and users.role_from. Ships in a release after every deployment runs the release carrying 0011, and is never applied in the same step as 0011.",
      "heading": "0011: roles move to `site_roles` (2026-09-29) (v1.0.0)" }
  ],
  "releases": [
    { "version": "1.3.0", "date": "2026-11-04", "rollback": "none",
      "migrations": ["0016_option_sources.sql", "0017_form_actions.sql"],
      "headings": ["Form option sources (v1.3.0)", "Form actions (v1.3.0)",
                   "Form steps and the `folio/form` hook (v1.3.0)",
                   "v1.3.0 is roll-forward only"] },
    { "version": "1.3.1", "date": "2026-11-04", "rollback": "safe",
      "migrations": [],
      "headings": ["SpaceDO migration (v1.3.1)"] }
  ]
}
```

The example shows two of the releases. The file lists every release from 1.0.0 to
1.4.0 the same way, with migrations from the table in Ground truth and headings as
they stand after phase 2.

Field rules:

- `apply`: `"before-deploy"` (additive; apply ahead of the Worker that reads it) or
  `"with-deploy"` (apply, then deploy immediately, nothing in between; `0011` only).
- `after[]`: post-deploy steps. `{ "kind": "reindex", "drafts"?: true }` becomes
  `POST {base}/api/reindex` (with `?drafts=1`), repeated on `continueFrom`, per scope
  on a branded deployment. `{ "kind": "manual", "text", "heading" }` is printed with
  its heading's anchor and never executed.
- `rollback`: `"safe"` (an older pin redeploys over this schema), `"conditional"`
  (it can, after the steps its headings describe), or `"none"` (roll forward only).
- `requiresDeployed` (optional, absent on every current release): decision 9.
- `headings`: the exact text of every `UPGRADING.md` `###` heading that contains
  `v<version>`, which is the set `upgradingEntries` already selects for release
  notes.
- A release with a version above `package.json`'s is the one in progress; at most one
  may exist, and a tag requires none (Testing requirements).

### `folio doctor` output

```json
{
  "schema": "folio.doctor/1",
  "cli": "1.4.0",
  "installed": "1.4.0",
  "project": "/abs/path/to/host",
  "env": null,
  "ok": false,
  "summary": { "pass": 9, "warn": 1, "fail": 1, "skip": 3 },
  "checks": [
    {
      "id": "d1.local",
      "status": "fail",
      "title": "Local D1 is missing 2 migrations the installed Folio ships",
      "detail": "folio (binding FOLIO_DB): 0016_option_sources.sql, 0017_form_actions.sql",
      "data": { "database": "folio", "pending": ["0016_option_sources.sql", "0017_form_actions.sql"], "unknown": [] },
      "fix": [
        { "kind": "run", "local": true, "cwd": "/abs/path/to/host",
          "argv": ["node_modules/.bin/wrangler", "d1", "migrations", "apply", "folio", "--local"] }
      ],
      "docs": "node_modules/folio/UPGRADING.md#the-schema-ledger"
    }
  ]
}
```

`status` is `pass | warn | fail | skip`; `fix` is present on `warn` and `fail` and
may be empty only on `skip`; `data` is per-check and documented with the check.
Flags: `[dir]` (default cwd), `--json`, `--env <name>`, `--config <path>` (wrangler),
`--persist-to <dir>`, `--remote`, `--url <origin>`, `--site <id>`, `--check <id>`
(repeatable; runs only those). `FOLIO_TOKEN` is read from the environment, never
from a flag, so it does not land in shell history or a process list.

The checks, in run order:

| id | fail when | warn when | skip when |
| --- | --- | --- | --- |
| `node.version` | `process.version` does not satisfy the installed `engines.node` | the range uses syntax outside `>= > <= < =`, bare versions and `\|\|` | Folio is not installed |
| `package.pin` | the spec is a branch, a short SHA, `#semver:`, no `#`, `file:`, `link:`, or a registry range (the npm `folio` is another package) | a full 40-character SHA (reproducible, but `UPGRADING.md` asks for a tag), `git+file:`, `workspace:` | no `folio` dependency at all (fail instead, with `npm install github:…#v<cli>`) |
| `package.installed` | `node_modules/folio` absent; `dist/server.js` absent (the `prepare` trap); installed version differs from a tag pin | installed below 1.0.0 | never |
| `wrangler.config` | the host's wrangler is unresolvable or `unstable_readConfig` throws | | never |
| `wrangler.d1` | no D1 entry's `migrations_dir` resolves to the installed migrations | more than one does | `wrangler.config` failed |
| `wrangler.story` | no `StoryDO` binding | | `wrangler.config` failed |
| `wrangler.space` | | no `SpaceDO` binding (Folio degrades) | `wrangler.config` failed |
| `wrangler.do-backend` | `StoryDO` is not created by any migration tag, or is KV-backed; `SpaceDO` is bound but created by no tag | | `wrangler.config` failed |
| `wrangler.crons` | | no `triggers.crons` in the resolved environment (schedules never fire, deliveries never retry) | `wrangler.config` failed |
| `vite.plugin` | the config does not load, or has no plugin named `folio` | the plugin predates `api` | no Vite config file |
| `blocks.module` | a blocks module the plugin names does not exist | | `vite.plugin` gave no options |
| `d1.local` | migrations pending; or the database records a `NNNN_*.sql` the package does not ship (it was migrated by a newer Folio) | | no local state directory (fail instead, with the apply command) |
| `d1.remote` | as `d1.local`; or wrangler cannot authenticate | | without `--remote` |
| `server.mounted` | `POST {base}/mcp` `server/discover` and then `GET {base}/login` both answer 5xx or nothing; the first `folio: …` line in the body is quoted in `detail` | discover fails but login answers (MCP disabled with `mcp: false`) | without `--url` |
| `server.schema` | `GET {base}[/~<site>]/api/v1/schema` is not 200 (`site_required` names `--site` in its fix) | | without `--url`, or without `FOLIO_TOKEN` |

`d1.local` with pending files includes in `detail` whether the installed release's
ledger marks any of them `with-deploy`, and links the release's headings.

### `folio upgrade` output

```json
{
  "schema": "folio.upgrade/1",
  "cli": "1.4.0",
  "from": "1.2.3",
  "to": "1.4.0",
  "mode": "plan",
  "pin": { "before": "github:brendanmckenzie/folio#v1.2.3", "after": "github:brendanmckenzie/folio#v1.4.0" },
  "hops": [
    {
      "to": "1.4.0",
      "releases": ["1.2.4", "1.3.0", "1.3.1", "1.4.0"],
      "rollForwardOnly": true,
      "migrations": [
        { "file": "0016_option_sources.sql", "release": "1.3.0", "apply": "before-deploy" },
        { "file": "0017_form_actions.sql", "release": "1.3.0", "apply": "before-deploy" }
      ],
      "read": [
        { "release": "1.3.0", "heading": "v1.3.0 is roll-forward only",
          "url": "https://github.com/brendanmckenzie/folio/blob/v1.3.0/UPGRADING.md#v130-is-roll-forward-only" }
      ],
      "steps": [
        { "id": "pin", "phase": "local", "kind": "edit", "file": "package.json", "status": "pending" },
        { "id": "remove-installed", "phase": "local", "kind": "run", "local": true, "argv": ["rm", "-rf", "node_modules/folio"], "status": "pending" },
        { "id": "install", "phase": "local", "kind": "run", "local": true, "argv": ["pnpm", "install"], "status": "pending" },
        { "id": "d1-local", "phase": "local", "kind": "run", "local": true, "argv": ["node_modules/.bin/wrangler", "d1", "migrations", "apply", "folio", "--local"], "status": "pending" },
        { "id": "typecheck", "phase": "local", "kind": "run", "local": true, "argv": ["pnpm", "run", "typecheck"], "status": "pending" },
        { "id": "d1-remote:staging", "phase": "deploy", "kind": "run", "local": false, "argv": ["node_modules/.bin/wrangler", "d1", "migrations", "apply", "group-web-folio-staging", "--remote", "--env", "staging"], "before": "deploy:staging" },
        { "id": "deploy", "phase": "deploy", "kind": "manual", "text": "Deploy the Worker, after the remote migrations above." }
      ]
    }
  ],
  "claimed": [ { "file": "0012_users_role_contract.sql", "rule": "Drops users.role and users.role_from. Ships in a release after every deployment runs the release carrying 0011, and is never applied in the same step as 0011." } ]
}
```

`mode` is `plan` or `apply`; under `apply` each executed step's `status` becomes
`done` or `failed` (with `exitCode` and the last 40 lines of output), and execution
stops at the first failure. Steps in the `deploy` and `post-deploy` phases never
carry a `status`. Flags: `[dir]`, `--to vX.Y.Z`, `--apply`, `--allow-dirty`,
`--env <name>` (restrict remote steps to one environment), `--config <path>`,
`--json`. `from === to` answers `hops: []` and exits 0.

### `folio add block` / `folio preview block` output

```json
{
  "schema": "folio.add-block/1",
  "name": "quote",
  "module": "/abs/src/blocks/index.ts",
  "files": [
    { "path": "/abs/src/blocks/quote.tsx", "action": "create" },
    { "path": "/abs/src/blocks/index.ts", "action": "edit", "diff": "@@ -2,2 +2,3 @@\n import { page } from \"./page\";\n import { prose } from \"./prose\";\n+import { quote } from \"./quote\";\n@@ -24,2 +25,3 @@\n   button,\n+  quote,\n ];" },
    { "path": "/abs/src/blocks/page.tsx", "action": "edit", "diff": "@@ -27 +27 @@\n-    body: blocks({ label: \"Body\", allow: [\"hero\", \"prose\"] }),\n+    body: blocks({ label: \"Body\", allow: [\"hero\", \"prose\", \"quote\"] })," }
  ],
  "written": true,
  "preview": null
}
```

`add block <name>` flags: `--brand <id>` (required when the plugin's `blocks` is a
brand record with more than one key), `--blocks <path>`, `--into <block>.<field>`,
`--label <text>`, `--dry-run` (`written: false`, diffs only), `--preview` (with the
preview flags below), `--json`. `preview block <name>` flags: `--url <origin>`
(required, never defaulted), `--site <id>`, `--base <path>` (default from the
plugin, else `/folio`), `--into <block>.<field>`, `--fields <json>`, `--viewport
<w>x<h>`, `--keep`, `--json`. Its `preview` object is `{ "documentId", "url",
"image": "/tmp/…png" | null, "html": "/tmp/…html" | null, "kept": false }`.

### New or changed routes

None. The CLI calls `{base}/mcp` (`server/discover`, `tools/call
preview_document`), `GET {base}/login`, and the v1 routes listed in Ground truth,
all unchanged.

## Acceptance criteria

### doctor on a fresh scaffold

```
GIVEN a project created by `folio init app`, installed, with no local database
WHEN `npx folio doctor --json` runs in it
THEN it exits 1
AND `d1.local` is `fail` with a `run` fix whose argv ends `d1 migrations apply folio --local` and `local: true`
AND `server.mounted`, `server.schema` and `d1.remote` are `skip`
AND every other check is `pass`, except `package.pin` which is `warn` only when the pin is not a tag
AND no file under the project changed
```

```
GIVEN the same project after `npm run db:local`
WHEN `npx folio doctor --json` runs
THEN it exits 0 and `d1.local` is `pass` with `data.pending` empty
```

### doctor finds Folio's bindings under any name

```
GIVEN a wrangler config binding FOLIO_DB (migrations_dir node_modules/folio/migrations), FOLIO_STORY → StoryDO, FOLIO_SPACE → SpaceDO under `new_classes`
WHEN doctor runs, with and without `--env staging`
THEN `wrangler.d1`, `wrangler.story` and `wrangler.space` pass, naming the bindings in `data`
AND `wrangler.do-backend` passes, noting SpaceDO is KV-backed and must stay so
AND with `--env staging` the `d1.*` checks query that environment's `database_name`
```

### doctor reports a database migrated by a newer Folio

```
GIVEN a local database that recorded 0016 and 0017, and node_modules/folio at v1.2.3
WHEN doctor runs
THEN `d1.local` fails with `data.unknown` = both files
AND its detail says the database was migrated by a newer release and v1.3.0 is roll-forward only, linking that heading
```

### doctor observes a construction failure

```
GIVEN a dev server whose `createFolio` throws "folio: 'blocks' belongs to a brand beside 'brands'"
WHEN `doctor --url http://localhost:<port> --check server.mounted --json` runs
THEN `server.mounted` fails, its detail quotes that line, and `docs` points at configuration.md's "Refused at construction"
```

### upgrade plans without changing anything

```
GIVEN a host at v1.2.3 with one Folio database per environment (top level, staging, production)
WHEN `npx github:brendanmckenzie/folio#v1.4.0 upgrade --json` runs
THEN it exits 0 with mode `plan`, one hop to 1.4.0, migrations 0016 and 0017 both `before-deploy`, and `rollForwardOnly: true`
AND `read` lists every heading naming v1.2.4, v1.3.0, v1.3.1 or v1.4.0
AND there are three `d1-remote:*` steps, each `local: false`, ordered before the deploy step
AND `claimed` names 0012 and its rule
AND package.json, the lockfile and node_modules are unchanged
```

```
GIVEN a host at v1.1.0
WHEN it plans an upgrade to v1.4.0
THEN the post-deploy phase contains a reindex step with `drafts: true` (from 0015)
```

### upgrade applies only the local half

```
GIVEN the v1.2.3 host with a clean git tree
WHEN `upgrade --apply --json` runs
THEN the pin reads `github:brendanmckenzie/folio#v1.4.0`, node_modules/folio was removed and reinstalled, the local database has 0016 and 0017, and the typecheck script ran
AND every `local` step has status `done`, and no `local: false` step ran
AND the final doctor result for the package and local-D1 checks is embedded and passing
```

```
GIVEN package.json has uncommitted changes
WHEN `upgrade --apply` runs without `--allow-dirty`
THEN it exits 1 before running any step, naming the dirty files
```

```
GIVEN the running CLI is v1.4.0
WHEN `upgrade --to v1.5.0` runs
THEN it exits 1 with a `run` fix of `npx github:brendanmckenzie/folio#v1.5.0 upgrade`
```

### A declared hop splits the plan

```
GIVEN a fixture ledger in which release 1.5.0 declares `requiresDeployed: "1.4.0"`, and a host at 1.3.1
WHEN it plans an upgrade to 1.5.0
THEN there are two hops, to 1.4.0 and to 1.5.0
AND `--apply` executes only the first and ends by saying to deploy, then run upgrade again
```

### add block scaffolds and registers

```
GIVEN the starter
WHEN `folio add block quote --into page.body --json` runs
THEN src/blocks/quote.tsx exists and exports `quote = defineBlock({ name: "quote", … })`
AND src/blocks/index.ts imports it and lists it last in `blocks`, its comments intact
AND page.tsx's body allow is ["hero", "prose", "quote"]
AND `npm run typecheck` and `npm run build` succeed
```

```
GIVEN a blocks module whose `blocks` is built with a spread or is not an array literal
WHEN add block runs
THEN nothing is written, exit code is 1, and an `edit` fix carries the import line and the array entry to add by hand
```

```
GIVEN an existing quote.tsx, or a name such as `Quote`, `quote-box` or `default`
WHEN add block runs
THEN it exits 2 naming the collision or the rule (`^[a-z][A-Za-z0-9]*$`, not a reserved word)
```

### preview renders through MCP

```
GIVEN a running dev server, a token with content:read, content:read:draft and content:write, and a block `hero` allowed in page.body
WHEN `FOLIO_TOKEN=… folio preview block hero --url http://localhost:5199 --json` runs
THEN `preview.html` is a file containing the hero's rendered markup (no browser binding locally)
AND the scratch draft `folio-scratch-hero` no longer exists afterwards
AND with `--keep` it does, unpublished
```

## Implementation plan

Phases 0 and 1 are independent and can run in parallel. Phase 2 needs phase 0.
Phases 3, 4 and 5 need phase 0; 4 also needs 2; 5 benefits from 1 but does not
require it. 3 and 5 can run in parallel; 4 starts once 2 has merged. Each command
phase adds its own one-line dispatch case and help text to `bin/folio.mjs`; those
are the only overlapping lines and merge trivially. Phase 6 is last.

### Phase 0: restructure the CLI (no behaviour change)

1. Create `bin/lib/` with:
   - `args.mjs`: a wrapper over `node:util` `parseArgs` (`strict: true`) that turns
     its errors into a usage error (exit 2).
   - `report.mjs`: the check/step record types (JSDoc), the human renderer
     (`PASS|WARN|FAIL|SKIP  <id>  <title>`, fixes indented beneath), and the JSON
     writer. Under `--json`, all diagnostics go to stderr.
   - `run.mjs`: `run(argv, { cwd })` via `spawnSync` with no shell, capturing
     output; injectable so tests record calls instead of executing them.
   - `project.mjs`: `readProject(dir, { env, config, persistTo })` answering the
     host `package.json`, the package manager (from `packageManager`, else the
     lockfile: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`), the
     installed Folio (`node_modules/folio/package.json`, real path of its
     `migrations/`, presence of `dist/server.js`), the host's `wrangler` and `vite`
     resolved with `createRequire`, and the git cleanliness of a named file list.
     Wrangler and Vite readers are injectable functions so tests can supply ones
     resolved from `examples/starter`.
   - `upgrading.mjs`: `upgradingEntries` moved verbatim from
     `scripts/release-notes.mjs:15-33`, plus `slug(heading)` (GitHub's: lowercase,
     drop characters other than letters, digits, spaces, `-` and `_`, spaces to
     `-`).
2. `scripts/release-notes.mjs` imports `upgradingEntries` from
   `../bin/lib/upgrading.mjs` and re-exports it; `release-notes.test.ts` passes
   unchanged.
3. `bin/folio.mjs`: replace `parseArgs` (`:229-241`) with per-command specs through
   `args.mjs`; `init` keeps `--email` and `--force`, `agents` takes none. Keep the
   header comment's argument, updated to "five commands".
4. Gates: `pnpm test`, `./node_modules/.bin/biome ci .`, `pnpm typecheck`, and
   `node scripts/release.mjs --smoke-only` (init still works from an install).

### Phase 1: the plugin's `api` (parallel with 0)

1. `src/vite/index.ts:94`: add `api: { folio: { version: 1, blocks: options.blocks,
   basePath: base } }` to `main`, with a comment saying the CLI reads it and why
   (decision 13).
2. `test/unit/vite/plugin.test.ts`: assert the shape for a string `blocks`, a brand
   record, and a custom `basePath`.

### Phase 2: the ledger (after 0)

1. Write `upgrade-ledger.json` at the root per "Wire & schema changes": every
   migration in `migrations/`, the claimed `0012`, releases 1.0.0 through 1.3.1 from
   the Ground truth table, and an in-progress 1.4.0 with no migrations and
   `rollback: "safe"`. `rollback` is `"conditional"` for 1.0.0, `"none"` for 1.3.0,
   `"safe"` for every other release.
2. `UPGRADING.md:211`: retitle to `### A story with no Durable Object opens with its
   content (2026-10-19) (v1.1.0)` so the release-notes selection and the ledger
   both see it (no link targets the old anchor).
3. Add `### The \`folio\` command line (v1.4.0)` to `UPGRADING.md` "Things that need
   an eye on upgrade" (what the three commands do, that `upgrade` is dry by
   default), and a `## The machine-readable ledger` section after "The schema
   ledger" stating that `upgrade-ledger.json` is derived from this document, which
   wins, and that a PR adding a migration or a release heading updates both or
   fails `pnpm test`.
4. `package.json` `files`: add `"upgrade-ledger.json"`.
5. `scripts/release.mjs`: add `upgrade-ledger.json` to `shipped` (`:340-351`). In
   the `--tag` and `--ci` paths, refuse unless the ledger's newest release equals
   `package.json`'s version, with the message "the ledger has no entry for vX.Y.Z:
   add it in the version-bump PR".
6. `test/unit/cli/ledger.test.ts` (Testing requirements).

### Phase 3: `folio doctor` (after 0; parallel with 5)

1. `bin/lib/semver.mjs`: parse `X.Y.Z`, compare, and evaluate a range built from
   `>= > <= < =`, bare versions and `||`; anything else answers "unknown" (the
   `warn` in `node.version`).
2. `bin/lib/pin.mjs`: `classifyPin(spec)` →
   `{ kind: "tag" | "sha" | "short-sha" | "branch" | "semver-range" | "default-branch" | "local-git" | "path" | "workspace" | "registry", ref }`
   for `github:`, `git+https://github.com/…`, `git+ssh://…`, `git+file:`, `file:`,
   `link:`, `workspace:` and bare ranges.
3. `bin/lib/d1.mjs`: `appliedMigrations({ database, env, remote, persistTo, run })`
   running `wrangler d1 execute <db> (--local|--remote) --json --command "select name
   from <migrations_table or d1_migrations> order by id"`, parsing both the success
   and the `{ error: { text } }` shapes; `no such table` means none applied.
   `pending(shipped, applied)` and `unknown(shipped, applied)` are set differences
   (gaps such as the absent `0009` and `0012` are not pending, because no file
   exists).
4. `bin/lib/mcp.mjs`: `rpc(url, method, params, token)` as in
   `scripts/mcp-test.mjs:110-136`, with `MCP_VERSION = "2026-07-28"` as a literal.
5. `bin/lib/doctor.mjs`: the fifteen checks in the table, each a function of the
   project record and the injected runner, run in table order; a check whose
   prerequisite failed answers `skip` naming it.
6. `bin/folio.mjs`: dispatch `doctor`; help text.

### Phase 4: `folio upgrade` (after 0 and 2)

1. `bin/lib/plan.mjs`: `planUpgrade({ ledger, upgradingMd, from, to, project })` →
   the `folio.upgrade/1` object. Pure: releases in `(from, to]`; hop splitting on
   `requiresDeployed`; migrations in file order with their `apply`; `read` from each
   release's `headings` with the tag URL from `slug()`; local steps; one remote step
   per Folio database across the top level and every named environment
   (`experimental_readRawConfig` lists the environment names; `unstable_readConfig`
   per name gives each `database_name`), de-duplicated by `database_name`; a
   `with-deploy` migration yields the apply-then-deploy-immediately pair; `after`
   steps in the post-deploy phase.
2. Refusals in `plan.mjs`: installed below 1.0.0 (exit 1, fix "follow UPGRADING.md
   by hand to v1.0.0, then run upgrade"); `--to` not in the ledger; `--to` above the
   CLI (decision 6); `--to` below the installed version (exit 1: a downgrade is
   "Rolling back" in `UPGRADING.md`, which this command does not do).
3. `bin/lib/apply.mjs`: the dirty check, then the local steps through `run.mjs`,
   stopping at the first failure. The pin edit rewrites only the `dependencies.folio`
   (or `devDependencies.folio`) string and preserves the file's indentation and
   trailing newline.
4. `bin/folio.mjs`: dispatch `upgrade`; help text.

### Phase 5: `folio add block` and `folio preview block` (after 0; parallel with 3)

1. `bin/lib/scan.mjs`: a tokenizer over TS/TSX source that skips strings, template
   literals (with `${}` nesting) and both comment forms, and answers bracket matches
   and top-level statement ranges.
2. `bin/lib/blocks.mjs`: `locateModule(project, { brand, blocks })`;
   `validateName(name, moduleDir)`; `planAddBlock(...)` → the list of file
   creations and edits, or an `edit` fix describing the manual change; `applyEdits`
   writes everything or nothing (originals held in memory and restored on a write
   error). The template, with the file's quote and semicolon style:

   ```tsx
   import { defineBlock, text } from "folio/core";

   export const quote = defineBlock({
     name: "quote",
     label: "Quote",
     summary: "heading",
     fields: {
       heading: text({ label: "Heading", required: true }),
     },
     render: ({ heading }) => (
       <section className="quote">
         <h2 className="quote__heading">{heading}</h2>
       </section>
     ),
   });
   ```

   `label` is `--label`, else the name split at capitals and title-cased
   (`travelCard` → "Travel card"). The class name is the name in kebab case.
3. `bin/lib/preview.mjs`: `previewBlock({ url, base, site, token, name, into, fields,
   viewport, keep, fetch })` implementing decision 12. Without `--fields`, sample
   data fills each `text` and `textarea` field of the block with its label and
   leaves other kinds absent.
4. `bin/folio.mjs`: dispatch `add block` and `preview block`; help text.

### Phase 6: gates and docs (last)

1. `scripts/release.mjs` `consumerBoots` (`:414-501`), using the CLI from the
   installed package (`node node_modules/folio/bin/folio.mjs …` inside `app`):
   - after the starter's `npm install` (`:433`), before `db:local`: `doctor --json`
     must exit 1 with `d1.local` failing and its fix argv ending `d1 migrations apply
     folio --local`, and no other check failing;
   - after `db:local` (`:434`): `doctor --json` must exit 0;
   - then `add block quote --into page.body --json` must exit 0, followed by `npm run
     typecheck` in `app`;
   - while the dev server is up (after the probes at `:484-489`): `doctor --url
     http://localhost:<port> --check server.mounted --json` must exit 0;
   - `upgrade --json` must exit 0 with `hops: []` (installed equals the CLI);
   - the existing `npm run build` (`:499`) now builds the scaffolded block too.
   Gate each by exit code and the parsed JSON, never by reading human output.
2. `scripts/cli-test.mjs` (new e2e script, picked up by `e2e-all.sh`): sign in, mint
   a token with `content:read`, `content:read:draft` and `content:write` as
   `mcp-test.mjs` does; run `doctor --url http://localhost:5199 --check
   server.mounted --check server.schema --check d1.local --json` in
   `examples/demo` (expect exit 0); run `preview block hero --url
   http://localhost:5199 --json` (expect an `html` file containing the hero's
   markup, and `GET /api/v1/search?q=folio-scratch-hero` empty afterwards); run it
   again with `--keep` and assert the draft exists and is unpublished.
3. Docs (next section).

## Documentation this implies

- `README.md`: one short "Keeping a project healthy" paragraph after the quick start
  naming `npx folio doctor`, `npx github:brendanmckenzie/folio#<tag> upgrade` and
  `npx folio add block`, linking the handbook section.
- `AGENTS.md`: the Install section gains the three commands; the paste block
  (`<!-- folio:begin -->`) gains two lines: run `npx folio doctor --json` after
  bumping the pin or editing the wrangler config and fix what it reports; and
  upgrade with `npx github:brendanmckenzie/folio#<tag> upgrade` (dry run first, then
  `--apply`), never running a `local: false` step without being asked. "When
  something breaks" points at `doctor` as the first move.
- `UPGRADING.md`: the procedure opens with "or let the CLI do the local half" and
  the two commands; plus the phase 2 sections and heading fix.
- `docs/handbook.md`: a "The command line" section (every command, flag, exit code,
  the JSON schemas, the check table, and the `local` rule), and the file map at
  `:1747` updated.
- `docs/configuration.md` "The Vite plugin": the plugin's `api` property, as
  read-only data for tools.
- `examples/starter/README.md`: "Adding a block" gains `npx folio add block <name>
  --into page.body`; "Before you deploy" gains `npx folio doctor --remote`.
- `bin/folio.mjs` `init`'s closing message (`:141-153`) gains `npx folio doctor`.
- `CHANGELOG.md` 1.4.0: under Added; Breaking changes: none.
- `CLAUDE.md` "The two ledgers": `upgrade-ledger.json` is the third artefact a new
  migration touches, and "Releasing" step 1 says the version-bump PR adds the
  release to it.
- `docs/specs/README.md`: list this spec as 41.

## Edge cases

- **`npx github:…#v1.4.0 doctor` against a host still on v1.3.0** → checks run
  against the installed v1.3.0 (`installed` in the output says so), and
  `vite.plugin` warns that the plugin predates `api`. Diagnosing what the host has is
  the point; the CLI's own version is reported as `cli`.
- **No local state directory** → `d1.local` fails with the apply command, without
  running wrangler, so doctor creates nothing.
- **A dev server holding the local database while doctor reads it** → the `select`
  goes through wrangler's own SQLite access, as `db:local` does next to a running
  server in the smoke test; a lock error is reported in `detail` as a `fail` with
  "retry", never as pending migrations.
- **Vite persisting local state elsewhere** (`persistState` in the Cloudflare
  plugin) → pass `--persist-to`; without it doctor reads wrangler's default and its
  `detail` names the directory it read, so a mismatch is visible.
- **A gap in the migration numbers** (`0009`, and `0012` until it ships) → not
  pending, because no file exists; a database that later receives `0012` applies it
  after `0013` by filename, as `UPGRADING.md:113` says.
- **A host that copies Folio's migrations into its own `migrations_dir`** →
  `wrangler.d1` fails, because the copy drifts from the package on every upgrade;
  the fix is the snippet pointing `migrations_dir` at `node_modules/folio/migrations`.
- **A pre-1.0 host (installed `0.0.0`)** → `upgrade` refuses with the manual route;
  `doctor` still runs and warns in `package.installed`.
- **Installed version above the pin** (a lockfile resolved to a later commit than
  the tag names, which a protected tag makes impossible, or a hand-edited
  `node_modules`) → `package.installed` fails with the reinstall fix.
- **`upgrade --apply` interrupted after `rm -rf node_modules/folio`** → the plan's
  `status` fields show where it stopped; rerunning `--apply` restarts from the pin
  edit, every step being idempotent (the pin edit is a no-op when already at the
  target, install and local apply are idempotent).
- **A roll-forward-only release in the hop with no remote environments in the
  config** → still flagged; `rollForwardOnly` is a property of the release, not of
  where the host deploys.
- **`add block` on a brand record with one key** → that brand is used; with more
  than one and no `--brand`, exit 2 listing them.
- **`--into` naming a root whose field is not `blocks()`** → exit 1 with an `edit`
  fix; nothing written.
- **`preview block` on a multi-site deployment without `--site`** → the schema read
  answers `site_required`; exit 1 naming `--site`.
- **`preview block` against a deployment rather than localhost** → allowed, because
  `--url` is explicit and the token is the caller's; with a `browser` binding the
  answer is a PNG. The scratch draft lands in that deployment's activity trail under
  the token's name and is deleted.
- **The block never appears in the schema within 60 seconds** → exit 1 saying the
  server has not reloaded the blocks module, with "restart the dev server" as the fix.

## Testing requirements

**Unit (`test/unit/cli/`, Node; each imports `bin/lib/*.mjs` with a computed
specifier like `release-notes.test.ts`):**

- `pin.test.ts`: a table of specs to kinds, including `github:…#v1.3.0`, a full and a
  short SHA, `#main`, `#semver:^1.0.0`, `git+ssh://git@github.com/…#v1.3.0`,
  `git+file:///x#abc…`, `file:../folio`, `workspace:*`, `^1.3.0`.
- `semver.test.ts`: `>=26.12.0 <27` against 26.11.9, 26.12.0, 26.13.0, 27.0.0; an
  `||` range; an unknown syntax answering "unknown".
- `ledger.test.ts`, the cross-check that decision 8 depends on:
  - every `migrations/*.sql` has exactly one `migrations` entry, and every entry
    names an existing file; no `claimed` file exists in `migrations/`;
  - every migration's `release` is a listed release, and each release's
    `migrations` equals the set of entries naming it;
  - for each release, `headings` equals the `###` headings of `UPGRADING.md` that
    contain `v<version>` (the `upgradingEntries` rule), so a release heading without
    a ledger entry, or the reverse, fails;
  - every `after` and `claimed` `heading` exists in `UPGRADING.md`;
  - releases are in ascending order; at most one is above `package.json`'s version;
  - `slug()` reproduces every `](#…)` anchor `UPGRADING.md` links to itself (which
    pins the slugger to GitHub's behaviour on this document's own headings).
- `plan.test.ts`: 1.2.3 → 1.4.0 (the AC shape); 1.1.0 → 1.4.0 (the `drafts` reindex);
  a fixture ledger with `requiresDeployed` (two hops); `from === to`; each refusal;
  a three-environment wrangler fixture producing three remote steps in config order.
- `apply.test.ts`: with a recording runner and a temp project: the step order, stop at
  first failure, the pin edit preserving formatting, and the dirty refusal.
- `d1.test.ts`: parsing the verified success and `no such table` outputs, an
  authentication error, set differences with gaps.
- `doctor.test.ts`: fixture projects under `test/fixtures/cli/` (starter-shaped,
  group-web-shaped with `FOLIO_*` names and named environments, broken variants for
  each `fail` row), read with the real wrangler and vite from `examples/starter`'s
  `node_modules` and a recording runner for `wrangler d1 execute`. Asserts each
  check's status and that a `fail` always carries a non-empty `fix`.
- `blocks.test.ts`: add-block against copies of the starter's, the demo's and a
  group-web-shaped `index.ts` (wrap export, side-effect import, comments in the
  array); single-quote and no-semicolon styles; `--into`; every refusal; the
  write-all-or-nothing path (a failing write restores the first file).
- `mcp.test.ts`: `MCP_VERSION` in `bin/lib/mcp.mjs` equals `MCP_PROTOCOL_VERSION`
  from `src/server/mcp/rpc.ts`, which is importable in Node.
- `output.test.ts`: every command's `--json` answer starts with its `schema` string
  and that, under `--json`, stdout parses as one JSON value.

**Unit (`test/unit/vite/plugin.test.ts`):** the `api` shape (phase 1).

**Workers (`test/workers/`):** none. Nothing in `src/server` changes, and the server
behaviour the CLI depends on (`server/discover` with no credential,
`preview_document`'s no-binding answer, the v1 routes) is already pinned by
`mcp.test.ts`, `api` tests and `scripts/mcp-test.mjs`.

**End to end (`scripts/cli-test.mjs` against port 5199):** phase 6 step 2. It is the
only test of `preview block` and of the server checks against a real Worker.

**Release smoke (`scripts/release.mjs`):** phase 6 step 1. It is the only test of
the three commands against a package installed the way a consumer installs it,
including `add block`'s output passing the host's own `tsc` and `vite build`.

## Dependencies

- None on other specs. Spec 40 (same release) touches `AGENTS.md` and `README.md`;
  rebase prose on whichever lands first.
- The host's own `wrangler` (for `unstable_readConfig`,
  `experimental_readRawConfig`, `d1 execute`, `d1 migrations apply`) and `vite`
  (`loadConfigFromFile`). Both are already in every host's devDependencies.
- `--remote` and the printed remote steps need Cloudflare credentials on the machine
  that runs them (`wrangler login` or `CLOUDFLARE_API_TOKEN`).
- `preview block` needs a token minted in the target deployment's admin.

## Out of scope

- **Running remote migrations or deploying.** Decision 7: the remote half is coupled
  to a deploy the CLI does not own.
- **Rolling back.** `UPGRADING.md` "Rolling back" is a judgement per release
  (`rollback` in the ledger tells you which judgement applies); `upgrade` refuses a
  target below the installed version.
- **Upgrades from below v1.0.0.** No consumer is there, and the ledger starts at the
  first release that honours semver.
- **Content migrations** (`folio.migrate`, `POST /api/migrate`) and the drift audit.
  They are about a host's own block schemas, not Folio's release ledger; `doctor`
  could report the audit through `--url` later without changing anything here.
- **Checking Workers Caching's per-entrypoint configuration.** Whether
  `cache.enabled` is safe depends on how the host gates the entrypoint in code
  (`folio.cacheVerdict`), which a config read cannot see.
- **Windows.** The CLI runs `node_modules/.bin/wrangler` directly and uses POSIX
  `rm -rf` in printed steps; both consumers and CI run on macOS and Linux.
- **Scaffolding anything but a block** (a document type, a form action, a brand).
  Each touches `createFolio`'s config in the host's Worker entry, which decision 4
  keeps the CLI from parsing.

## Implementation notes

Built 2026-11-04 on `feat/agent-cli` in the plan's order, one commit per phase:
`9ae4504` (phase 0, the `bin/lib/` split), `63b57f7` (1, the plugin's `api`),
`1cddce0` (2, the ledger), `687b4cf` (3, `doctor`), `61ca7cc` (4, `upgrade`),
`12e7c85` (5, `add block` and `preview block`), `0f04aee` (6, the smoke-test stages
and `scripts/cli-test.mjs`), then the documentation. No `src/server` or admin file
changed. The unit suite under `test/unit/cli/` is twelve test files and two helpers.

**Verified beyond the unit tests**, against a copy of the starter in a scratch
directory with a real local D1 and a real `vite dev` on a free port: `doctor`'s
`d1.local` against a real `wrangler d1 execute` (pass, then a deleted
`d1_migrations` row reported as pending), `server.mounted` and `server.schema`
against the running Worker, `add block quote --into page.body` followed by the
host's `tsc` and `vite build` (the block reached both bundles), and `preview block`
end to end: the HTML held `<section class="quote" …>`, the scratch draft was gone
afterwards, `--keep` left it in state `draft`, a second run reused it, and `add block
banner --preview` waited out the reload and rendered. The consumer smoke test stages
and `scripts/cli-test.mjs` were written and syntax-checked but not run on the branch.

**Where the spec was wrong or ambiguous, and what was done.**

- **"Seven new modules" is seventeen.** `args`, `report`, `run`, `project`,
  `upgrading` (phase 0), `ledger`, `semver`, `pin`, `d1`, `mcp`, `doctor`, `plan`,
  `apply`, `scan`, `blocks`, `preview`, and `commands` (the four commands' flag
  handling and output, so `bin/folio.mjs` stays dispatch, `init` and `agents`).
- **Fixtures are built in code, not checked in under `test/fixtures/cli/`.**
  `test/unit/cli/fixtures.ts` writes each host into a temporary directory. A
  single-quoted, semicolon-free blocks module is one of the cases `add block` must
  handle, and biome reformats everything under `test/`. The host's `wrangler` and
  `vite` are symlinks to `examples/starter`'s, so the CLI reaches them through
  `createRequire` exactly as it reaches a real host's.
- **Under vitest, `createRequire` from a temporary directory still resolves the
  workspace's `wrangler`**, so "the host's wrangler is unresolvable" is tested by
  injecting a reader that throws (the readers are injectable for this reason), not
  by leaving the symlink out.
- **Every answer carries `ok`, and a refusal is `{ schema, …, ok: false, error: {
  message, fix } }`** in all four schemas. The output examples above had no shape
  for a refusal; this is additive.
- **A hoisted workspace resolves like Node does** (review M4). With npm or yarn
  workspaces `node_modules` sits at the workspace root, and the CLI looked only in
  the package's own. The installed Folio and `node_modules/.bin/wrangler` are now
  found by walking up from the package, the lockfile likewise (no higher than the
  directory holding `.git`), and every fix step, `rm -rf`, docs link and the dirty
  check name the paths actually found. pnpm links per package, so it was unaffected.
- **`--json` stdout is guarded for the whole run** (review M3, L5). Loading the
  host's Vite config runs it in-process, and a `console.log` there (dotenv's banner)
  landed in front of the JSON. Under `--json`, `bin/folio.mjs` points
  `process.stdout.write` at stderr and writes only the answer to the real stdout;
  child processes are always captured. Usage errors and unexpected failures answer
  `{ schema, ok: false, error: { kind, message, fix: [] } }` too.
- **`doctor` takes `--base`.** Decision 13 names `--base` as the explicit form for a
  plugin that predates `api`, and the server checks need a base path when the plugin
  cannot supply one.
- **`server.mounted` warns when exactly one of discover and login fails**, either
  way round. The table specified only the discover-fails case.
- **The local-state guard is per directory, not per database.** `d1.local` runs the
  `select` only when `.wrangler/state/v3/d1` (or `--persist-to`'s) exists; if it
  exists but this database has never been touched, wrangler creates its file. A
  per-database check would need wrangler's hashing of the local file name, which is
  internal.
- **A copied `migrations_dir` is detected** as a D1 entry whose directory holds
  `0001_init.sql` but is not the package's; the fix is the `migrations_dir` snippet.
- **A rerun after an interrupted `--apply` resumes** (review M2). `from` used to
  fall back to the already-rewritten pin, so a run stopped after `pin` and
  `remove-installed` read as "Already at the target. Nothing to do." `resolveFrom`
  now trusts the installed copy only when it is present, built and the pinned
  version; otherwise the committed pin (`git show HEAD:./package.json`) names the
  start, and when that already names the target the plan is a `repair` hop of the
  local steps. `--apply` accepts its own pin edit as the only uncommitted change.
- **Databases are identified by `database_id`, not `database_name`** (review H1).
  Phase 4.1's de-duplication by name dropped an environment that reused another's
  name for a different database, and then told the operator to deploy over an
  unmigrated database. The name is used only when no id is given. Environments are
  ordered named first, top level, then `prod*`, matching "staging, then production";
  the local apply runs under the environment its database came from; and a hop with
  migrations is refused when an environment has no Folio database.
- **`requiresDeployed` is a fact about deployments, so the installed version never
  satisfies it** (review M1). Decision 9 compared the gate against the installed
  version, which made 0012's `requiresDeployed: "1.0.0"` vacuous: every plan already
  starts at 1.0.0 or later. A plan that reaches a gated release now stops before it,
  with a `stop` object and a step saying to deploy, verify and rerun. `upgrade --url
  <a deployment>` clears the gate only when that server's MCP `server/discover`
  serverInfo reports a version at or above the one required. Today the server
  reports a constant `0.0.0`, which proves nothing, so until a release wires the
  package version into serverInfo the gate always stops; no new route was added. A
  plan stopped before reaching any release answers `ok: false`, exit 1.
- **Remote step ids are `d1-remote:<env>`, with the top level as `top-level`**, each
  `before: "deploy"`, followed by one `deploy` step naming every environment. The
  example's `before: "deploy:staging"` named a step that did not exist. A hop with a
  `with-deploy` migration interleaves `d1-remote:<env>` and `deploy:<env>` instead.
- **`upgrade --env` restricts the local database step as well as the remote ones**
  (decision 7's "per environment's local database when `--env` is given").
- **`upgrade` reads `from` from `node_modules/folio`, falling back to a tag pin's
  version** when nothing is installed, and refuses when neither exists.
- **The preview's scratch draft is found by `path`**, because `ApiDocumentMeta`
  carries no `slug`; a top-level page's path is its slug. Only a page at exactly
  that path, never published and titled `Scratch: …`, is reused: the review (L1)
  found any nested `…/folio-scratch-<name>` would have been overwritten and then
  deleted with its descendants. Cleanup now also runs on a failure and on SIGINT or
  SIGTERM, and a failed delete reports `kept: true` with a `cleanup` object.
- **The ledger's in-progress 1.4.0 has no `date` and no headings yet.** The ledger
  test requires a date on every release at or below `package.json`'s version and
  requires each release's `headings` to equal the `###` headings naming its tag, so
  the version-bump PR must add both, and adding the release's `UPGRADING.md` heading
  without the ledger entry fails `pnpm test`.
- **`slug()`'s pin found a broken link.** `UPGRADING.md`'s `0014` row linked
  `#conditional-questions-sections-and-prefill-2026-10-19`, an anchor that stopped
  existing when the heading gained `(v1.1.0)`; it is fixed.
- **A usage error from `init` or `agents` now exits 2**, where it exited 1, under
  decision 14's codes. Their flags and every other behaviour are unchanged.
- **`npx folio` runs the installed copy only.** In a directory without Folio
  installed, npx resolves the npm registry's unrelated `folio`. The handbook says so
  and spells the uninstalled form `npx github:brendanmckenzie/folio#vX.Y.Z`.
- **The smoke test's fresh-install `doctor` stage requires Node to satisfy
  `engines.node`**, or `node.version` fails beside `d1.local`. CI runs `.nvmrc`'s
  26.13.0; a local `release.mjs` run under another Node fails at that stage, which is
  the check doing its job.
- **The workspace's own `dist/` predates `api` until `pnpm build` runs**, so `doctor`
  in `examples/starter` warns on `vite.plugin` until then; a consumer install builds
  `dist/` in `prepare` and never sees it.
- **`CLAUDE.md` is not edited on this branch.** Its "The two ledgers" and
  "Releasing" step 1 changes are left to the orchestrator.
