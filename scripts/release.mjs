/**
 * Publishes this repository to GitHub, which is how consumers install Folio.
 *
 * There is no second repository and no split. `package.json` sits at the root,
 * so `github:brendanmckenzie/folio#<sha>` finds it where npm expects it and
 * `git push` is the whole of publishing. This used to be a
 * `git subtree split --prefix=packages/folio` into a parallel repository with an
 * unrelated history that had to be re-derived byte-identically on every release
 * or every pinned SHA was orphaned. That machinery existed only because the
 * package lived in a subdirectory and npm cannot install from one.
 *
 *   node scripts/release.mjs           # gate, smoke-test, print the push command
 *   node scripts/release.mjs --push    # …and push it
 *   node scripts/release.mjs --no-gate # skip the gates (they were just run)
 *   node scripts/release.mjs --tag     # …and add the end-to-end sweep
 *   node scripts/release.mjs --tag --ci  # the release.yml run: verify a pushed tag, publish nothing
 *   node scripts/release.mjs --smoke-only  # just the consumer smoke test, on the working tree
 *   node scripts/release.mjs --tag --ci --stage=e2e  # one stage of the --ci run (see `stage`)
 *
 * Tags are created by hand (CLAUDE.md "Releasing"), never by this script. What it
 * does about them is refuse to bless a tag that has moved: see `assertTagNotMoved`.
 *
 * What it does NOT do is push by default. Publishing is an explicit act, and the
 * printed command is one paste.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestRelease, readLedger } from "../bin/lib/ledger.mjs";

const REMOTE = "origin";
const REMOTE_BRANCH = "main";

const args = new Set(process.argv.slice(2));
const push = args.has("--push");
const gate = !args.has("--no-gate");
const force = args.has("--force");
/**
 * A tagged release gets a slower gate than a push, because a tag is rarer and
 * more consequential: it is the thing a consumer pins by name. The end-to-end
 * sweep is minutes of real dev servers and real databases — the only coverage
 * this repository has of the sync and WebSocket paths — which is affordable
 * once per tag and not once per push.
 *
 * It runs with the other three, before anything is stamped, committed or
 * tagged, so a failure costs time and nothing else.
 */
const tag = args.has("--tag");
/**
 * `release.yml` runs this on a runner that has just checked out a pushed `vX.Y.Z`
 * tag (named by `RELEASE_TAG`, else `GITHUB_REF_NAME`). The tag *is* the publication (main already holds the commits), so this mode
 * publishes nothing: it checks the tag names this commit and this `package.json`,
 * runs every gate and the consumer smoke test, and stops.
 *
 * With `--tag` and no `--ci` it is the pre-flight: if `v<package.json version>` is
 * already on the remote it must name this commit, or nothing is printed.
 */
const ci = args.has("--ci");
/**
 * Runs the consumer smoke test and nothing else: no branch or clean-tree
 * precondition, no gates, no compare, no push. It exists so the one stage that
 * installs the package can be exercised on a feature branch, against uncommitted
 * work. It cannot publish, which is why it may skip the refusals that protect a
 * publish; every path that can publish still takes them. The working tree is
 * snapshotted into a throwaway commit (see `snapshotWorkingTree`) because the
 * install is of a commit, and the snapshot never moves a branch.
 */
const smokeOnly = args.has("--smoke-only");
/**
 * One stage of a `--ci` run, so `release.yml` can run the independent ones on
 * separate runners at once instead of one after another on one machine. Without
 * `--stage` every stage runs in order, which is what a local pre-flight wants.
 *
 *   verify  the tag, `package.json`, ledger and remote-tag checks (no dependencies)
 *   tests   `pnpm test`: the Node project and the workers project in real workerd
 *   static  biome and typecheck
 *   e2e     the end-to-end sweep (only with `--tag`)
 *   smoke   the consumer smoke test
 *
 * They are separate *runners* and not parallel processes on one because the
 * workers project starves under load (`Timeout starting cloudflare-pool runner`,
 * which reads as a regression) and the sweep is exactly that load. The release is
 * only created by a job that needs every stage, so one failing stage still means
 * no Release. Only `--ci` takes a stage: a local run that skipped one would read
 * as having passed the gate.
 */
const STAGES = ["verify", "tests", "static", "e2e", "smoke"];
const stageArg = [...args].find((a) => a.startsWith("--stage="));
const stage = stageArg ? stageArg.slice("--stage=".length) : null;
const runs = (name) => stage === null || stage === name;

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

/**
 * Refuses a tag whose remote copy points at a different commit than `sha`.
 *
 * A moved tag is the one way a tag-pinned scheme can hand two machines different
 * code from the same version, and by the time `release.yml` runs the tag has
 * already been pushed, so this cannot stop the push. The repository's tag ruleset
 * (no update or delete of `v*`) does that. What this adds is the check at the
 * point of trust: it reads the remote's *current* answer, so a tag force-moved after
 * a run was triggered (the workflow checks out the SHA the event named) fails here
 * and no Release is created for it. An annotated tag is peeled to its commit.
 *
 * `required` is true on the runner, where the tag must exist; locally a tag that is
 * not pushed yet is the normal case and passes.
 */
function assertTagNotMoved(tagName, sha, { required }) {
  const ref = `refs/tags/${tagName}`;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  // The runner's checkout does not persist credentials, so authenticate this one
  // read the way actions/checkout does.
  const auth = token
    ? [
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      ]
    : [];
  const result = spawnSync("git", [...auth, "ls-remote", REMOTE, ref, `${ref}^{}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (required) die(`could not read ${tagName} from ${REMOTE}: ${result.stderr.trim()}`);
    console.log(`· could not reach ${REMOTE}; the remote ${tagName} was not checked.`);
    return;
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const peeled = lines.find((l) => l.endsWith(`${ref}^{}`));
  const direct = lines.find((l) => l.endsWith(ref));
  const remote = (peeled ?? direct)?.split(/\s+/)[0];
  if (!remote) {
    if (required) die(`${tagName} does not exist on ${REMOTE}.`);
    console.log(`· ${tagName} is not on ${REMOTE} yet.`);
    return;
  }
  if (remote !== sha) {
    die(
      `${tagName} on ${REMOTE} points at ${remote.slice(0, 7)}, not ${sha.slice(0, 7)}.\n` +
        "  A tag is never moved: a consumer who pinned it would get different code with\n" +
        "  nothing to say so. Bump the version and tag a new release instead.",
    );
  }
  console.log(`· ${tagName} on ${REMOTE} is ${sha.slice(0, 7)}`);
}

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/**
 * Gates are run by exit code, never by reading output. `biome ci` prints a
 * reassuring `Lint: No issues found` even when its *format* check failed further
 * up, and a shell hook can rewrite `pnpm exec biome` into something that prints a
 * plausible summary and never runs biome at all — so the direct binary, and the
 * status, are the only things trusted here. See CLAUDE.md.
 */
function runGate(label, command, commandArgs, { stream = false } = {}) {
  process.stdout.write(`· ${label} … ${stream ? "\n" : ""}`);
  const result = spawnSync(command, commandArgs, { stdio: stream ? "inherit" : "pipe" });
  if (result.status !== 0) {
    console.log("FAILED");
    process.stdout.write(result.stdout?.toString() ?? "");
    process.stderr.write(result.stderr?.toString() ?? "");
    die(`${label} failed (exit ${result.status}). Nothing has been pushed.`);
  }
  console.log(`${stream ? "· " : ""}${label} ok`);
}

// ── preconditions ────────────────────────────────────────────────────────────

if (smokeOnly) {
  if (push || ci || tag || force) {
    die("--smoke-only cannot be combined with --push, --tag, --ci or --force.");
  }
  smokeTest(snapshotWorkingTree());
  console.log("\n✓ smoke test passed.");
  process.exit(0);
}

if (stageArg && !(ci && STAGES.includes(stage))) {
  die(`--stage=<${STAGES.join("|")}> needs --ci (got ${stageArg}).`);
}

// A stage other than `verify` trusts the job that runs `verify`, and needs no history.
const verify = runs("verify");

if (ci) {
  if (verify) {
    const refName = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? "";
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    if (!/^v\d+\.\d+\.\d+$/.test(refName)) die(`"${refName}" is not a vX.Y.Z tag.`);
    if (refName !== `v${version}`) {
      die(
        `tag ${refName} does not match package.json version ${version}. Bump it in a PR, then tag.`,
      );
    }
    if (
      spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", `${REMOTE}/${REMOTE_BRANCH}`])
        .status !== 0
    ) {
      die(`${refName} is not on ${REMOTE_BRANCH}. Tag a commit that has merged.`);
    }
  }
} else {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== REMOTE_BRANCH) {
    die(`on "${branch}", not ${REMOTE_BRANCH}. Release from there.`);
  }
}
if (verify && git("status", "--porcelain")) {
  die("working tree is dirty. A push ships commits, so uncommitted work would ship as nothing.");
}

const head = git("rev-parse", "HEAD");

if (ci && verify) {
  assertTagNotMoved(process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME, head, {
    // A workflow_dispatch rehearsal names a tag that is deliberately not pushed.
    required: process.env.GITHUB_REF_TYPE === "tag",
  });
} else if (tag && !ci) {
  assertTagNotMoved(`v${JSON.parse(readFileSync("package.json", "utf8")).version}`, head, {
    required: false,
  });
}

/**
 * A tag must carry its own ledger entry. `folio upgrade` plans from the running
 * CLI's `upgrade-ledger.json`, so a release whose ledger stops at the previous
 * version would plan every upgrade to it as a no-op. The unit test already allows
 * at most one entry above `package.json`'s version; this is the other half, run
 * only where a tag is being blessed.
 */
if ((tag || ci) && verify) {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const newest = newestRelease(readLedger("."));
  if (newest?.version !== version) {
    die(`the ledger has no entry for v${version}: add it in the version-bump PR.`);
  }
}

if (stage === "verify") {
  console.log(
    `\n✓ ${process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME} is a valid release tag.`,
  );
  process.exit(0);
}

// ── gates ────────────────────────────────────────────────────────────────────

if (gate) {
  console.log("Gates:");
  if (runs("tests")) runGate("tests", "pnpm", ["test"]);
  if (runs("static")) {
    runGate("biome", "./node_modules/.bin/biome", ["ci", "."]);
    runGate("typecheck", "pnpm", ["typecheck"]);
  }
  // Streamed, not swallowed: the sweep is dozens of dev servers and a gate with
  // no output for minutes is indistinguishable from a hung one. It runs the
  // scripts several at a time (`scripts/e2e-all.sh`), so it must not share a
  // machine with `tests`: see `stage`.
  if (tag && runs("e2e")) {
    runGate("end-to-end (26 scripts)", "./scripts/e2e-all.sh", [], { stream: true });
  }
} else {
  console.log(`Gates skipped (--no-gate).${tag ? " Including the end-to-end sweep." : ""}`);
}

// ── smoke test ───────────────────────────────────────────────────────────────

/**
 * Installs this repo the way a consumer does, over `git+file:` so it runs
 * *before* the push rather than after.
 *
 * The gates above run against the workspace. Nobody installs the workspace.
 * A consumer installs this repository and npm runs its `prepare`, which is an
 * esbuild and a `tsc` — a build that exists only on the consumer's machine and
 * that no gate here has ever executed. Typechecking the workspace says nothing
 * about whether the package builds from a clean clone with only what `files`
 * ships.
 *
 * Every export resolves into `dist/` and therefore proves `prepare` ran. The
 * private `folio-source` condition points into `src/`, which the package does not
 * ship (bar three files an eval gate bundles), so it is skipped here.
 *
 * It also proves the docs ship. `files` is an allowlist, and a consumer reading
 * `node_modules/folio` is the only reader some of them will ever have.
 */
function smokeTest(sha) {
  const repoRoot = git("rev-parse", "--show-toplevel");
  const dir = mkdtempSync(join(tmpdir(), "folio-release-"));
  try {
    execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });

    process.stdout.write("· consumer install (runs prepare) … ");
    const install = spawnSync(
      "npm",
      ["install", `git+file://${repoRoot}#${sha}`, "--no-audit", "--no-fund"],
      { cwd: dir, stdio: "pipe" },
    );
    if (install.status !== 0) {
      console.log("FAILED");
      process.stderr.write(install.stderr?.toString() ?? "");
      die("the package does not install. Nothing has been pushed.");
    }
    console.log("ok");

    const root = join(dir, "node_modules", "folio");

    process.stdout.write("· exports resolve … ");
    const { exports: map } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const missing = [];
    // Conditions nest, so collect every leaf string rather than assuming a shape.
    const walk = (subpath, node) => {
      if (typeof node === "string") {
        if (!existsSync(join(root, node))) missing.push(`${subpath} -> ${node}`);
        return;
      }
      if (node && typeof node === "object") {
        for (const [condition, child] of Object.entries(node)) {
          if (condition !== "folio-source") walk(subpath, child);
        }
      }
    };
    for (const [subpath, node] of Object.entries(map ?? {})) walk(subpath, node);
    if (missing.length) {
      console.log("FAILED");
      for (const m of missing) console.error(`    missing: ${m}`);
      die(`${missing.length} export target(s) absent from the built package.`);
    }
    // `src/` is not shipped: a host that resolved into it would be running source
    // the package does not carry, and the build would be proving nothing.
    // Three files under `src/server` ship on purpose: a host's LLM eval gate bundles
    // `describe-anthropic.ts` (and its two imports) from `node_modules/folio`, and runs the
    // suite in `evals/`. Anything else under `src/` is a leak.
    const SHIPPED_SRC = [
      "src/server/describe-anthropic.ts",
      "src/server/llm-tasks.json",
      "src/server/llm-tasks.ts",
    ];
    const srcFiles = [];
    const listSrc = (rel) => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (e.isDirectory()) listSrc(`${rel}/${e.name}`);
        else srcFiles.push(`${rel}/${e.name}`);
      }
    };
    if (existsSync(join(root, "src"))) listSrc("src");
    const strays = srcFiles.filter((f) => !SHIPPED_SRC.includes(f));
    const lacking = [
      ...SHIPPED_SRC,
      "evals/media.describe/run.mjs",
      "evals/media.describe/suite.json",
    ].filter((f) => !existsSync(join(root, f)));
    if (strays.length || lacking.length) {
      console.log("FAILED");
      for (const f of strays) console.error(`    unexpected in package: ${f}`);
      for (const f of lacking) console.error(`    missing from package: ${f}`);
      die("the installed package's src/ and evals/ are not what a host's eval gate needs.");
    }
    // The emitted declarations must not import CSS: a host without `vite/client` types and
    // with `skipLibCheck: false` fails TS2882 on it.
    const mountDts = readFileSync(join(root, "dist/types/preview/mount.d.ts"), "utf8");
    if (/import\s+["'][^"']*\.css["']/.test(mountDts)) {
      console.log("FAILED");
      die("dist/types/preview/mount.d.ts imports a stylesheet.");
    }
    console.log(`ok (${Object.keys(map ?? {}).length} subpaths)`);

    process.stdout.write("· exported names … ");
    /**
     * The check above sees files, not names: it would pass a barrel that had
     * dropped everything inside it. This reads the final `export { ... }` of each
     * built entry (the server entry cannot be imported under Node, it needs
     * `cloudflare:workers`, so the text is what is read for all five) and requires
     * the names below, which are the ones a host cannot do without. Add to a list
     * when a name becomes part of the contract; a name vanishing from it is a major.
     */
    const anchors = {
      "dist/core.js": [
        "defineBlock",
        "toRegistry",
        "fieldValue",
        "dataOf",
        "cacheControl",
        "ANY_TYPE_TAG",
        "SITE_TAG",
        "asAsset",
      ],
      "dist/engine.js": ["newUid", "apply", "defineMigration", "fieldValue"],
      "dist/server.js": ["createFolio", "StoryDO", "SITE_TAG", "ANY_TYPE_TAG", "typeTag"],
      "dist/vite.js": ["folio"],
      "dist/form.js": ["useFolioForm"],
      "dist/render.js": ["FolioDoc", "RenderBlok", "RenderRichtext"],
      "dist/preview.js": ["mountPreview"],
    };
    const absent = [];
    for (const [file, names] of Object.entries(anchors)) {
      const text = readFileSync(join(root, file), "utf8");
      const blocks = [...text.matchAll(/^export\s*\{([^}]*)\}/gm)];
      const have = new Set(
        blocks.flatMap((b) =>
          b[1]
            .split(",")
            .map((n) =>
              n
                .trim()
                .split(/\s+as\s+/)
                .pop(),
            )
            .filter(Boolean),
        ),
      );
      for (const n of names) if (!have.has(n)) absent.push(`${file}: ${n}`);
    }
    if (absent.length) {
      console.log("FAILED");
      for (const a of absent) console.error(`    missing export: ${a}`);
      die(`${absent.length} expected export(s) absent from the built package.`);
    }
    console.log(`ok (${Object.values(anchors).flat().length} names)`);

    process.stdout.write("· docs ship … ");
    /**
     * Every document `files` claims to carry, plus the starter `folio init`
     * copies. A consumer reading `node_modules` is the only reader some of
     * these get, and `bin/folio.mjs init` fails outright without the template —
     * both are silent failures that only a real install can see.
     */
    const shipped = [
      "README.md",
      "AGENTS.md",
      "UPGRADING.md",
      "docs/configuration.md",
      "docs/handbook.md",
      "docs/api.md",
      "docs/mcp.md",
      "bin/folio.mjs",
      "bin/lib/doctor.mjs",
      "upgrade-ledger.json",
      "examples/starter/package.json",
      "examples/starter/src/index.tsx",
    ];
    const docs = shipped.filter((f) => !existsSync(join(root, f)));
    if (docs.length) {
      console.log("FAILED");
      for (const d of docs) console.error(`    missing: ${d}`);
      die(
        `${docs.length} file(s) absent from the installed package. ` +
          "A consumer reading node_modules is the only reader some docs get, " +
          "and `folio init` cannot run without examples/starter.",
      );
    }
    console.log(`ok (${shipped.length} files)`);

    pnpmConsumerInstall(repoRoot, sha);

    consumerBoots(dir, `git+file://${repoRoot}#${sha}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Commit the working tree, tracked and untracked, to a ref that no branch points
 * at, and answer its SHA. `git+file:` installs a commit, so this is how
 * `--smoke-only` sees uncommitted work. Goes through a private index so the real
 * one is untouched, and the ref is dropped when the process exits.
 */
function snapshotWorkingTree() {
  const gitDir = git("rev-parse", "--absolute-git-dir");
  const env = { ...process.env, GIT_INDEX_FILE: join(gitDir, "folio-smoke-index") };
  const run = (...a) => execFileSync("git", a, { encoding: "utf8", env }).trim();
  try {
    run("read-tree", "HEAD");
    run("add", "-A");
    const treeId = run("write-tree");
    const sha = run("commit-tree", treeId, "-p", "HEAD", "-m", "folio smoke-only snapshot");
    const ref = "refs/folio-smoke/snapshot";
    git("update-ref", ref, sha);
    process.on("exit", () => spawnSync("git", ["update-ref", "-d", ref]));
    return sha;
  } finally {
    rmSync(env.GIT_INDEX_FILE, { force: true });
  }
}

// A declaration, not a const: `--smoke-only` calls `smokeTest` before this line runs.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A pnpm consumer's install of the commit must prepare it from the root project alone.
 *
 * pnpm prepares a git dependency by running `pnpm install` in the fetched tree, which
 * reads `pnpm-workspace.yaml` and, left alone, installs every workspace member (262
 * packages, about 230 MB, against the root's 89). `.pnpmfile.mjs` narrows that one
 * install by the lifecycle event pnpm names it with. That event is pnpm's internal
 * name, so if pnpm renames it the hook stops matching and nothing breaks: the install
 * just goes back to being slow. This is the only thing that notices.
 *
 * `Packages: +N` counts packages linked, not downloaded, so a warm store reads the
 * same and this uses the default one.
 *
 * pnpm clones the repository and checks the commit out, so unlike npm it cannot see a
 * commit that only a private ref (the `--smoke-only` snapshot) points at. The commit is
 * fetched into a throwaway repository and put on a branch there.
 */
function pnpmConsumerInstall(repoRoot, sha) {
  const MAX_PACKAGES = 150; // 89 today; headroom for dependency churn, not for a workspace member
  const dir = mkdtempSync(join(tmpdir(), "folio-pnpm-consumer-"));
  const source = mkdtempSync(join(tmpdir(), "folio-pnpm-source-"));
  try {
    const inSource = (...a) => execFileSync("git", a, { cwd: source, stdio: "ignore" });
    inSource("init", "-q");
    inSource("fetch", "-q", repoRoot, sha);
    inSource("update-ref", "refs/heads/smoke", sha);
    const spec = `git+file://${source}#${sha}`;
    writeFileSync(join(dir, "package.json"), '{"name":"pnpm-consumer","private":true}\n');
    // A throwaway consumer, so allow every build rather than compute folio's allowBuilds key.
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages: []\ndangerouslyAllowAllBuilds: true\n",
    );

    process.stdout.write("· pnpm consumer install (prepare stays root-only) … ");
    const r = spawnSync("pnpm", ["add", "--reporter=append-only", spec], {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf8",
    });
    const out = `${r.stdout}${r.stderr}`;
    const fail = (what) => {
      console.log("FAILED");
      process.stderr.write(`${out}\n`);
      die(`${what}. Nothing has been pushed.`);
    };
    if (r.status !== 0) fail(`a pnpm consumer cannot install the package (exit ${r.status})`);

    if (/pnpm-install: Scope: all \d+ workspace projects/.test(out))
      fail(
        "pnpm's git-dependency prepare installed the whole workspace; .pnpmfile.mjs did not narrow it",
      );
    const packages = /pnpm-install: Packages: \+(\d+)/.exec(out);
    if (!packages) fail("could not read the prepare install's package count from pnpm's output");
    const count = Number(packages[1]);
    if (count > MAX_PACKAGES)
      fail(`pnpm's prepare installed ${count} packages (limit ${MAX_PACKAGES})`);
    if (!existsSync(join(dir, "node_modules", "folio", "dist", "server.js")))
      fail("the pnpm-installed package has no dist/server.js");
    console.log(`ok (${count} packages)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
}

/**
 * The starter, installed from the built package, has to boot `vite dev` and build.
 *
 * Everything above proves the files and names are there; none of it runs the
 * package. Its worst failure ships green: `folio/server` resolves to `dist/`
 * inside `node_modules`, which Vite externalises, and workerd then loads React's
 * CommonJS entries raw and dies at startup with `module is not defined` before it
 * can answer a request. Folio's own demo resolves the library to TypeScript source
 * through the private `folio-source` export condition and never sees it, and `vite build`
 * bundles CommonJS through Rollup so it never sees it either. Only a dev server
 * started against the installed package does, which is what this does.
 *
 * Needs the network for the starter's own dependencies, as the install above
 * already does.
 */
function consumerBoots(dir, spec) {
  process.stdout.write("· consumer boots (init, install, doctor, add block, vite dev, build) … ");
  const fail = (what, detail = "") => {
    console.log("FAILED");
    if (detail) process.stderr.write(`${detail}\n`);
    die(`${what}. Nothing has been pushed.`);
  };
  const sh = (label, command, commandArgs, cwd) => {
    const r = spawnSync(command, commandArgs, { cwd, stdio: "pipe", encoding: "utf8" });
    if (r.status !== 0) fail(`${label} failed (exit ${r.status})`, `${r.stdout}${r.stderr}`);
  };

  sh("folio init", "node", ["node_modules/folio/bin/folio.mjs", "init", "app"], dir);
  const app = join(dir, "app");
  // `init` pins the published tag; point it at the commit under test instead.
  const pkgPath = join(app, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies.folio = spec;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  sh("the starter's npm install", "npm", ["install", "--no-audit", "--no-fund"], app);

  /**
   * The agent CLI, from the installed package, against a project installed the way
   * a consumer installs it: the only place `doctor`, `add block` and `upgrade` run
   * over a real `node_modules/folio`, a real wrangler and a real Vite config
   * (`agent-cli.md` phase 6). Gated on exit codes and parsed JSON, never on the
   * human output. Before the local database exists, `doctor` must fail on exactly
   * that and offer the local apply; after it, pass.
   */
  const folioCli = (args) => {
    const r = spawnSync("node", ["node_modules/folio/bin/folio.mjs", ...args], {
      cwd: app,
      stdio: "pipe",
      encoding: "utf8",
    });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, json, output: `${r.stdout}${r.stderr}` };
  };
  const fresh = folioCli(["doctor", "--json"]);
  const freshD1 = fresh.json?.checks?.find((c) => c.id === "d1.local");
  const freshOthers = (fresh.json?.checks ?? []).filter(
    (c) => c.status === "fail" && c.id !== "d1.local",
  );
  if (
    fresh.status !== 1 ||
    freshD1?.status !== "fail" ||
    !freshD1.fix?.[0]?.argv?.join(" ").endsWith("d1 migrations apply folio --local") ||
    freshOthers.length
  ) {
    fail(
      "folio doctor on the fresh install did not fail on exactly the local database",
      fresh.output,
    );
  }

  sh("db:local", "npm", ["run", "db:local"], app);

  const ready = folioCli(["doctor", "--json"]);
  if (ready.status !== 0 || ready.json?.ok !== true) {
    fail("folio doctor did not pass after db:local", ready.output);
  }
  const added = folioCli(["add", "block", "quote", "--into", "page.body", "--json"]);
  if (added.status !== 0 || added.json?.written !== true) {
    fail("folio add block quote --into page.body failed", added.output);
  }
  sh("the starter's typecheck, with the added block", "npm", ["run", "typecheck"], app);
  const planned = folioCli(["upgrade", "--json"]);
  if (planned.status !== 0 || !Array.isArray(planned.json?.hops) || planned.json.hops.length) {
    fail("folio upgrade did not answer an empty plan for an up-to-date install", planned.output);
  }

  const port = spawnSync(
    "node",
    [
      "-e",
      "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})",
    ],
    { encoding: "utf8" },
  ).stdout.trim();
  const logPath = join(dir, "dev.log");
  const logFd = openSync(logPath, "w");
  // Its own process group, because the Cloudflare plugin starts children that
  // outlive a plain kill of the vite process.
  const dev = spawn("./node_modules/.bin/vite", ["--port", port, "--strictPort"], {
    cwd: app,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  const status = (path) =>
    Number(
      spawnSync(
        "curl",
        [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          "10",
          `http://localhost:${port}${path}`,
        ],
        { encoding: "utf8" },
      ).stdout,
    );
  const commonJsError = /module is not defined|require is not defined/;
  try {
    let answered = 0;
    for (let i = 0; i < 90 && dev.exitCode === null; i++) {
      sleep(1000);
      answered = status("/folio/login");
      if (answered) break;
    }
    if (commonJsError.test(readFileSync(logPath, "utf8"))) {
      fail("vite dev hit a CommonJS error on startup", readFileSync(logPath, "utf8"));
    }
    if (!answered) fail("vite dev never answered", readFileSync(logPath, "utf8"));
    // The prebuilt admin is a real file in dev, not a module Vite compiles.
    for (const path of ["/folio-admin.js", "/folio-admin.css"]) {
      const code = status(path);
      if (code !== 200) fail(`vite dev answered ${code} for ${path}, not 200`);
    }
    // The Worker runs on the first request, so a startup failure can also arrive
    // as a 500 here rather than as an exit.
    for (const path of ["/", "/folio/login"]) {
      const code = status(path);
      if (code === 0 || code >= 500) {
        fail(`GET ${path} answered ${code}`, readFileSync(logPath, "utf8"));
      }
    }
    if (commonJsError.test(readFileSync(logPath, "utf8"))) {
      fail("the Worker hit a CommonJS error", readFileSync(logPath, "utf8"));
    }
    // The client environment, which is where `folio/preview` runs. It must resolve to
    // the built `dist/` (there is no `src/` in the install) and answer 200.
    const previewEntry = spawnSync(
      "curl",
      ["-s", "--max-time", "30", `http://localhost:${port}/@id/__x00__virtual:folio/preview`],
      { encoding: "utf8" },
    ).stdout;
    const previewImport = previewEntry.match(/from "([^"]*folio[^"]*preview[^"]*\.js[^"]*)"/)?.[1];
    if (!previewImport) {
      fail("the virtual preview entry does not import folio/preview", previewEntry.slice(0, 600));
    }
    if (/\/src\//.test(previewImport)) {
      fail(`folio/preview resolved into src/: ${previewImport}`);
    }
    const previewCode = status(previewImport);
    if (previewCode !== 200) fail(`vite dev answered ${previewCode} for ${previewImport}, not 200`);
    const mounted = folioCli([
      "doctor",
      "--url",
      `http://localhost:${port}`,
      "--check",
      "server.mounted",
      "--json",
    ]);
    if (mounted.status !== 0) {
      fail("folio doctor --check server.mounted failed against vite dev", mounted.output);
    }
  } finally {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
    closeSync(logFd);
  }
  sh("the starter's build", "npm", ["run", "build"], app);
  for (const file of ["folio-admin.js", "folio-admin.css"]) {
    if (!existsSync(join(app, "dist", "client", file))) {
      fail(`the starter's build did not emit ${file} into dist/client`);
    }
  }
  // The editor is bundled into the admin; none of it may reach a consumer's tree.
  const tree = spawnSync("npm", ["ls", "--all", "--parseable"], {
    cwd: app,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  const editorPackages = tree
    .split("\n")
    .filter((l) => /node_modules\/(@tiptap|@floating-ui|prosemirror-)[^/]*/.test(l));
  if (editorPackages.length) {
    fail(
      "the consumer's tree carries the editor's packages, which the admin bundle should have inlined",
      editorPackages.join("\n"),
    );
  }
  console.log("ok");
}

if (ci) {
  if (!gate) die("--ci runs the gates; it cannot be combined with --no-gate.");
  if (runs("smoke")) {
    console.log("\nSmoke test (what a consumer actually runs):");
    smokeTest(head);
  }
  console.log(
    stage
      ? `\n✓ stage ${stage} passed for ${head.slice(0, 7)}.`
      : `\n✓ ${process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME} (${head.slice(0, 7)}) is releasable.`,
  );
  process.exit(0);
}

// ── compare with what is published ───────────────────────────────────────────

let remoteHead = null;
try {
  remoteHead = git("rev-parse", `${REMOTE}/${REMOTE_BRANCH}`);
} catch {
  console.log(`· no ${REMOTE}/${REMOTE_BRANCH} locally — run \`git fetch ${REMOTE}\` to compare.`);
}

if (remoteHead === head) {
  console.log(`\n✓ ${REMOTE}/${REMOTE_BRANCH} is already ${head.slice(0, 7)}. Nothing to publish.`);
  process.exit(0);
}

if (remoteHead) {
  const fastForward =
    spawnSync("git", ["merge-base", "--is-ancestor", remoteHead, head]).status === 0;
  if (!fastForward && !force) {
    die(
      `${head.slice(0, 7)} is not a fast-forward of ${REMOTE}/${REMOTE_BRANCH} ` +
        `(${remoteHead.slice(0, 7)}).\n` +
        "  Pushing would orphan every SHA a consumer has pinned, so work out why first.\n" +
        "  The one sanctioned exception is the cutover from the old subtree-split\n" +
        "  history, whose commits are unrelated to these by construction. That is what\n" +
        "  --force is for, and it is a one-time act: re-pin both consumers afterwards.",
    );
  }
  if (fastForward) {
    const ahead = git("rev-list", "--count", `${remoteHead}..${head}`);
    console.log(`· ${ahead} commit(s) ahead of ${REMOTE}/${REMOTE_BRANCH}`);
  } else {
    console.log(`· UNRELATED to ${REMOTE}/${REMOTE_BRANCH} — forcing (one-time cutover)`);
  }
}

if (gate) {
  console.log("\nSmoke test (what a consumer actually runs):");
  smokeTest(head);
} else {
  console.log("Smoke test skipped (--no-gate).");
}

// ── publish ──────────────────────────────────────────────────────────────────

const pushArgs = [
  "push",
  ...(force ? ["--force"] : []),
  REMOTE,
  `${REMOTE_BRANCH}:${REMOTE_BRANCH}`,
];

if (!push) {
  console.log(`\nReady. To publish:\n\n  git ${pushArgs.join(" ")}\n`);
  process.exit(0);
}

process.stdout.write("\n· pushing … ");
const result = spawnSync("git", pushArgs, { stdio: "pipe" });
if (result.status !== 0) {
  console.log("FAILED");
  process.stderr.write(result.stderr?.toString() ?? "");
  die("push failed.");
}
console.log("ok");
console.log(`\n✓ Published ${head.slice(0, 7)}.`);
console.log(`  Consumers pin: "folio": "github:brendanmckenzie/folio#${head}"`);
