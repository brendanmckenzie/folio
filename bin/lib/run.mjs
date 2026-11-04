/**
 * The one way the CLI runs another program: `spawnSync` with no shell, output
 * captured. Every command takes a runner as a parameter rather than importing this
 * directly, so a test can pass a recording one and assert the argv it would have
 * run instead of executing it.
 */
import { spawnSync } from "node:child_process";

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string, error?: Error }} RunResult
 * @typedef {(argv: string[], opts?: { cwd?: string, env?: Record<string, string> }) => RunResult} Runner
 */

/** @type {Runner} */
export function run(argv, { cwd, env } = {}) {
  const [command, ...args] = argv;
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    // Always captured, never inherited: a child writing to our stdout would break
    // `--json`, whose stdout is one document (review M3).
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

/** The last `n` lines of a run's combined output, for a failed step's report. */
export function tail(result, n = 40) {
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  return text.split("\n").slice(-n).join("\n");
}
