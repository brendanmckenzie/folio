// The pool behind `scripts/e2e-all.sh`: every end-to-end script, several at a time,
// each against its own dev server, port and state directory.
//
//   node scripts/lib/e2e-sweep.mjs [scripts/a-test.mjs ...]
//
// Isolation is the whole design and it is unchanged from the serial sweep: a script
// mutates content and is not idempotent, so it gets a database nobody else has
// touched. What changed is that "its own" no longer means "the one on port 5199, after
// the last script's was wiped". `scripts/e2e.sh` is given a port and a state directory
// per script, so nothing is shared and nothing waits for anything else.
//
// Two costs are paid once instead of per script. `build:js` (the dev server's config
// imports `folio/vite` from `dist/`) runs up front, and migrate + seed run into a
// template state directory that each script copies. The copy is a few small files.
//
// Knobs:
//   FOLIO_E2E_JOBS   scripts at a time. Default: half the CPUs, between 2 and 6. A
//                    dev server is a vite process plus a workerd, so more than about
//                    one per two cores slows each script past the point of gain.
//
// Output is buffered per script (`<run dir>/<name>.txt`) and printed as each finishes,
// never interleaved. Exits 1 if any script did and names each with its output and
// server-log paths.
import { spawn, spawnSync } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { freePort } from "./free-port.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const E2E = join(ROOT, "scripts/e2e.sh");

const requested = process.argv.slice(2);
const scripts = requested.length
  ? requested
  : readdirSync(join(ROOT, "scripts"))
      .filter((f) => f.endsWith("-test.mjs"))
      .sort()
      .map((f) => `scripts/${f}`);

const jobs = Math.max(
  1,
  Number.parseInt(process.env.FOLIO_E2E_JOBS ?? "", 10) ||
    Math.min(6, Math.max(2, Math.floor(cpus().length / 2))),
);

const runDir = mkdtempSync(join(tmpdir(), "folio-e2e-run-"));
const started = Date.now();
const minutes = (ms) =>
  `${Math.floor(ms / 60000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;

console.log(
  `Running ${scripts.length} end-to-end script(s), ${Math.min(jobs, scripts.length)} at a time, one fresh database each.`,
);
console.log(`Run directory: ${runDir}\n`);

// Once: the library build, then migrate and seed into the template.
const build = spawnSync("pnpm", ["--filter", "folio", "build:js"], { cwd: ROOT, encoding: "utf8" });
if (build.status !== 0) {
  console.error(`build:js failed\n${build.stdout}${build.stderr}`);
  process.exit(1);
}
const template = join(runDir, "template");
const wrangler = join(ROOT, "examples/demo/node_modules/.bin/wrangler");
for (const argv of [
  ["d1", "migrations", "apply", "folio", "--local", "--persist-to", template],
  ["d1", "execute", "folio", "--local", "--persist-to", template, "--file=./seed.sql"],
]) {
  const r = spawnSync(wrangler, argv, { cwd: join(ROOT, "examples/demo"), encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`${argv.slice(0, 3).join(" ")} failed\n${r.stdout}${r.stderr}`);
    process.exit(1);
  }
}

// Ports are handed out here, not left to each run to pick, so two runs starting in the
// same instant cannot be offered the same free port.
const claimed = new Set();
async function claimPort() {
  for (;;) {
    const port = await freePort();
    if (!claimed.has(port)) {
      claimed.add(port);
      return port;
    }
  }
}

const results = [];

async function runOne(script) {
  const name = basename(script).replace(/-test\.mjs$/, "");
  const state = join(runDir, `${name}-state`);
  const out = join(runDir, `${name}.txt`);
  const devLog = join(runDir, `${name}-dev.log`);
  const port = await claimPort();
  const t0 = Date.now();
  const status = await new Promise((done) => {
    const child = spawn(E2E, [script], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FOLIO_E2E_PORT: String(port),
        FOLIO_E2E_STATE: state,
        FOLIO_E2E_TEMPLATE: template,
        FOLIO_E2E_SKIP_BUILD: "1",
        FOLIO_E2E_OUT: out,
        FOLIO_E2E_DEV_LOG: devLog,
      },
    });
    let text = "";
    child.stdout.on("data", (d) => {
      text += d;
    });
    child.stderr.on("data", (d) => {
      text += d;
    });
    child.on("error", (e) => {
      text += `${e}\n`;
      done(127);
    });
    child.on("close", (code, signal) => done(code ?? (signal ? 128 : 1)));
    child.on("close", () => {
      results.push({ name, text, out, devLog });
    });
  });
  claimed.delete(port);
  const ms = Date.now() - t0;
  const entry = results.find((r) => r.name === name);
  entry.status = status;
  entry.ms = ms;
  // One block per script, printed whole, so concurrent output cannot interleave.
  console.log(
    `── ${name} (${(ms / 1000).toFixed(0)}s) ${"─".repeat(Math.max(0, 40 - name.length))}`,
  );
  console.log(entry.text.trimEnd());
  console.log(status === 0 ? `  ✓ ${name}\n` : `  ✗ ${name} — exit ${status}\n`);
  if (status === 0) rmSync(state, { recursive: true, force: true });
}

const queue = [...scripts];
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) await runOne(queue.shift());
  }),
);

const failed = results.filter((r) => r.status !== 0);
console.log("═════════════════════════════════════════════════════");
console.log(
  `${results.length - failed.length}/${scripts.length} passed in ${minutes(Date.now() - started)}`,
);

if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) {
    console.log(`  ✗ ${f.name} (exit ${f.status})`);
    console.log(`      output:     ${f.out}`);
    console.log(`      server log: ${f.devLog}`);
  }
  process.exit(1);
}
rmSync(runDir, { recursive: true, force: true });
