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
 *
 * Tags are created by hand (CLAUDE.md "Releasing"), never by this script. What it
 * does about them is refuse to bless a tag that has moved: see `assertTagNotMoved`.
 *
 * What it does NOT do is push by default. Publishing is an explicit act, and the
 * printed command is one paste.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

if (ci) {
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
} else {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== REMOTE_BRANCH) {
    die(`on "${branch}", not ${REMOTE_BRANCH}. Release from there.`);
  }
}
if (git("status", "--porcelain")) {
  die("working tree is dirty. A push ships commits, so uncommitted work would ship as nothing.");
}

const head = git("rev-parse", "HEAD");

if (ci) {
  assertTagNotMoved(process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME, head, {
    // A workflow_dispatch rehearsal names a tag that is deliberately not pushed.
    required: process.env.GITHUB_REF_TYPE === "tag",
  });
} else if (tag) {
  assertTagNotMoved(`v${JSON.parse(readFileSync("package.json", "utf8")).version}`, head, {
    required: false,
  });
}

// ── gates ────────────────────────────────────────────────────────────────────

if (gate) {
  console.log("Gates:");
  runGate("tests", "pnpm", ["test"]);
  runGate("biome", "./node_modules/.bin/biome", ["ci", "."]);
  runGate("typecheck", "pnpm", ["typecheck"]);
  // Streamed, not swallowed: it is 22 resets and 22 dev servers, and a gate with
  // no output for ten minutes is indistinguishable from a hung one.
  if (tag) runGate("end-to-end (22 scripts)", "./scripts/e2e-all.sh", [], { stream: true });
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
 * Both export shapes are checked because the package uses both: `./core` and
 * friends resolve into `dist/` and therefore prove `prepare` ran, while
 * `./render`, `./preview` and `./admin-entry` are plain strings into `src/` that
 * the consumer's own bundler compiles — those prove `files` still carries `src`.
 * A build that half-works fails one set and not the other.
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
        for (const [, child] of Object.entries(node)) walk(subpath, child);
      }
    };
    for (const [subpath, node] of Object.entries(map ?? {})) walk(subpath, node);
    if (missing.length) {
      console.log("FAILED");
      for (const m of missing) console.error(`    missing: ${m}`);
      die(`${missing.length} export target(s) absent from the built package.`);
    }
    console.log(`ok (${Object.keys(map ?? {}).length} subpaths)`);

    process.stdout.write("· exported names … ");
    /**
     * The check above sees files, not names: it would pass a barrel that had
     * dropped everything inside it. This reads the final `export { ... }` of each
     * built entry (the server entry cannot be imported under Node, it needs
     * `cloudflare:workers`, so the text is what is read for all four) and requires
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (ci) {
  if (!gate) die("--ci runs the gates; it cannot be combined with --no-gate.");
  console.log("\nSmoke test (what a consumer actually runs):");
  smokeTest(head);
  console.log(
    `\n✓ ${process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME} (${head.slice(0, 7)}) is releasable.`,
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
