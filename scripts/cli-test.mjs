// Drives the agent CLI (docs/specs/foundation/agent-cli.md phase 6) against a live
// dev server (FOLIO_E2E_BASE, else port 5199): `folio doctor`'s server checks and `folio preview block`,
// the two things no unit test can reach, because both need a real Worker answering
// over HTTP with a real token resolving off a real D1 row.
//
// The load-bearing checks:
//
//  1. `doctor --url … --check server.mounted --check server.schema --check d1.local`
//     exits 0 in examples/demo: the Worker constructed, the schema is served to the
//     token, and the local database the dev server uses has every migration.
//  2. `preview block hero` exits 0 and saves the rendered HTML (no `browser` binding
//     locally, so `preview_document` answers HTML rather than a PNG), and the scratch
//     draft it made is gone afterwards.
//  3. With `--keep` the scratch draft survives, unpublished.
//
// The CLI is run as a process, the way an agent runs it, and gated on its exit code
// and its JSON, never on human output.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { signInGlobally } from "./lib/auth.mjs";

const HTTP = process.env.FOLIO_E2E_BASE ?? "http://localhost:5199";
const ADMIN = `${HTTP}/folio/api`;
const ROOT = new URL("..", import.meta.url).pathname;
const DEMO = join(ROOT, "examples/demo");
const CLI = join(ROOT, "bin/folio.mjs");

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

const { realFetch } = await signInGlobally();

const made = await fetch(`${ADMIN}/tokens`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "e2e cli",
    scopes: ["content:read", "content:read:draft", "content:write"],
  }),
}).then((r) => r.json());
if (!made.token) throw new Error(`could not mint a token: ${JSON.stringify(made)}`);
const token = made.token;

// Asynchronous on purpose. `spawnSync` blocks this process's event loop for as long as the
// CLI runs, and undici's idle timer for the pooled keep-alive socket to the dev server
// cannot fire while it is blocked. The server drops an idle connection after about five
// seconds regardless, so a CLI call that outlasts that (a `preview block` on a loaded
// machine, which is what a parallel sweep is) leaves a dead socket in the pool and the
// next fetch fails with ECONNRESET.
function folio(args) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      cwd: DEMO,
      env: { ...process.env, FOLIO_TOKEN: token },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("close", (status) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ status, json, output: `${stdout}${stderr}` });
    });
  });
}

/** The scratch draft, searched for over v1 with the CLI's own token. */
async function scratch(name) {
  const res = await realFetch(
    `${HTTP}/folio/api/v1/search?q=${encodeURIComponent(`folio-scratch-${name}`)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const page = await res.json();
  return (page.rows ?? []).filter((r) => r.path === `folio-scratch-${name}`);
}

/* --- doctor against the running server ----------------------------------- */

const doctor = await folio([
  "doctor",
  "--url",
  HTTP,
  "--check",
  "server.mounted",
  "--check",
  "server.schema",
  "--check",
  "d1.local",
  // The local database the dev server is using, which e2e.sh puts in its own state directory.
  ...(process.env.FOLIO_E2E_STATE ? ["--persist-to", process.env.FOLIO_E2E_STATE] : []),
  "--json",
]);
check(
  "doctor's server and local-D1 checks pass against the dev server",
  doctor.status === 0 && doctor.json?.ok === true,
  doctor.json
    ? doctor.json.checks.map((c) => `${c.id}:${c.status}`).join(" ")
    : doctor.output.slice(0, 400),
);
check(
  "its answer is folio.doctor/1 with exactly the three checks asked for",
  doctor.json?.schema === "folio.doctor/1" &&
    doctor.json.checks.map((c) => c.id).join(",") === "d1.local,server.mounted,server.schema",
);

/* --- preview block -------------------------------------------------------- */

const preview = await folio(["preview", "block", "hero", "--url", HTTP, "--json"]);
const html = preview.json?.preview?.html;
check(
  "preview block hero exits 0 with an HTML file",
  preview.status === 0 && typeof html === "string" && existsSync(html),
  preview.json ? JSON.stringify(preview.json).slice(0, 400) : preview.output.slice(0, 400),
);
check(
  "the file holds the hero's rendered markup",
  typeof html === "string" &&
    existsSync(html) &&
    /class="hero[ "]/.test(readFileSync(html, "utf8")),
);
check(
  "the scratch draft is gone afterwards",
  (await scratch("hero")).length === 0 && preview.json?.preview?.kept === false,
);

const kept = await folio(["preview", "block", "hero", "--url", HTTP, "--keep", "--json"]);
const rows = await scratch("hero");
check("--keep exits 0", kept.status === 0, kept.output.slice(0, 400));
check(
  "--keep leaves the scratch draft, never published",
  rows.length === 1 && rows[0].state === "draft" && rows[0].id === kept.json?.preview?.documentId,
  JSON.stringify(rows),
);

/* --- summary --------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
