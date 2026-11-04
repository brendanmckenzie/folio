/**
 * The shapes every command answers in, and the two ways of writing them.
 *
 * A check is `{ id, status, title, detail?, data?, fix?, docs? }` with `status`
 * one of `pass | warn | fail | skip`. A `warn` or `fail` always carries `fix`, an
 * ordered list of steps (spec 41 decision 5), each one of:
 *
 *   { kind: "run", argv: string[], cwd: string, local: boolean }
 *       executed as written, no shell. `local: true` touches only this machine
 *       and is undone by a reset; `local: false` reaches Cloudflare, and an agent
 *       does not run one unasked.
 *   { kind: "edit", file: string, snippet: string, text?: string }
 *       a literal change to make by hand.
 *   { kind: "manual", text: string, docs?: string }
 *       prose, with a docs anchor where one exists.
 *
 * Under `--json` the one JSON value is the only thing written to stdout, and every
 * diagnostic goes to stderr, so `stdout` always parses (decision 14).
 */

/** @typedef {"pass" | "warn" | "fail" | "skip"} Status */

/** Writes the answer as one JSON value on stdout. */
export function writeJson(value, out = process.stdout) {
  out.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Where a command's progress notes go: stderr under `--json`, stdout otherwise. */
export function noteStream(json) {
  return json ? process.stderr : process.stdout;
}

/** One fix step as a line a person can read (and paste, for a `run`). */
export function describeFix(step) {
  if (step.kind === "run") {
    const where = step.local === false ? "remote" : "local";
    return `run (${where}): ${shellQuote(step.argv)}${step.cwd ? `   # in ${step.cwd}` : ""}`;
  }
  if (step.kind === "edit") {
    return `edit ${step.file}:${step.text ? ` ${step.text}` : ""}\n${indent(step.snippet, "    ")}`;
  }
  return `${step.text}${step.docs ? ` (${step.docs})` : ""}`;
}

/** `PASS  id  title`, with the detail and each fix indented beneath. */
export function renderChecks(checks) {
  const lines = [];
  for (const c of checks) {
    lines.push(`${c.status.toUpperCase().padEnd(4)}  ${c.id.padEnd(20)}  ${c.title}`);
    if (c.detail) lines.push(indent(c.detail, "      "));
    for (const step of c.fix ?? []) lines.push(indent(`→ ${describeFix(step)}`, "      "));
    if (c.docs && c.status !== "pass") lines.push(`      see ${c.docs}`);
  }
  return lines.join("\n");
}

/** `argv` as one line of POSIX shell, quoted only where it has to be. */
export function shellQuote(argv) {
  return argv
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

function indent(text, by) {
  return text
    .split("\n")
    .map((l) => (l ? `${by}${l}` : l))
    .join("\n");
}
