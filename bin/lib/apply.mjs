/**
 * `folio upgrade --apply`: run the first hop's local steps, in order, stopping at
 * the first failure. Never a `deploy` or `post-deploy` step, under any flag
 * (spec 41 decision 7).
 *
 * It refuses to start unless `package.json` and the lockfile are committed (or
 * `--allow-dirty`), because the rollback of an applied plan is `git checkout` of
 * those two files plus a reinstall, and that rollback has to exist before anything
 * runs. Its own pin edit is the one uncommitted change it accepts, so a rerun after
 * an interruption is not refused for it. Every step is idempotent, and the plan
 * reads where the upgrade began from the committed pin when the installed copy is
 * not whole (`resolveFrom`), so a rerun picks up the remaining work.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { committedFile, gitDirty } from "./project.mjs";
import { PlanRefusal } from "./plan.mjs";
import { tail } from "./run.mjs";

/**
 * @param {any} plan a `folio.upgrade/1` plan, mutated in place
 * @param {any} project
 * @param {{ run: import("./run.mjs").Runner, allowDirty?: boolean,
 *   doctor: (checks: string[]) => Promise<any>, note?: (line: string) => void }} opts
 * @returns {Promise<boolean>} whether every local step finished
 */
export async function applyPlan(
  plan,
  project,
  { run, allowDirty = false, doctor, note = () => {} },
) {
  plan.mode = "apply";
  const hop = plan.hops[0];
  if (!hop) return true;

  if (!allowDirty) {
    const files = ["package.json", ...(project.lockfile ? [project.lockfile] : [])];
    const git = gitDirty(project, files, run);
    if (!git.repo) {
      throw new PlanRefusal(
        `${project.root} is not a git repository, so an applied plan would have no rollback. Commit it to git first, or pass --allow-dirty.`,
      );
    }
    // The pin rewritten to this plan's target, and nothing else, is this command's own
    // edit from a run that stopped part-way: HEAD still holds the rollback (review M2).
    const own = (file) => file === "package.json" && onlyPinMoved(project, run, plan);
    git.dirty = git.dirty.filter((f) => !own(f));
    if (git.dirty.length) {
      throw new PlanRefusal(
        `Uncommitted changes in ${git.dirty.join(", ")}. Commit them first, so \`git checkout\` can undo this upgrade, or pass --allow-dirty.`,
      );
    }
  }

  for (const step of hop.steps) {
    if (step.phase !== "local") continue;
    note(`· ${step.id}`);
    try {
      if (step.kind === "edit" && step.id === "pin") {
        editPin(path.join(project.root, step.file), project.dep, step.after);
        step.status = "done";
      } else if (step.kind === "doctor") {
        const result = await doctor(step.checks);
        step.result = result;
        step.status = result.ok ? "done" : "failed";
      } else if (step.kind === "run") {
        const result = run(step.argv, { cwd: project.root });
        step.exitCode = result.status;
        if (result.status === 0) step.status = "done";
        else {
          step.status = "failed";
          step.output = tail(result);
        }
      }
    } catch (err) {
      step.status = "failed";
      step.output = String(err?.message ?? err);
    }
    if (step.status === "failed") {
      note(`✗ ${step.id} failed`);
      return false;
    }
  }
  if (plan.stop) plan.next = plan.stop.text;
  return true;
}

/**
 * Rewrites the `folio` dependency's string and nothing else, so the file keeps its
 * indentation, key order and trailing newline. A no-op when it already names the
 * target, which is what makes a rerun safe.
 */
export function editPin(file, dep, after) {
  const text = readFileSync(file, "utf8");
  const next = rewritePin(text, dep, after);
  if (next !== text) writeFileSync(file, next);
}

export function rewritePin(text, dep, after) {
  if (!dep) throw new Error("package.json has no folio dependency to rewrite");
  if (dep.spec === after) return text;
  const pattern = new RegExp(`("folio"\\s*:\\s*)${escapeRegExp(JSON.stringify(dep.spec))}`, "g");
  const matches = text.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `expected one "folio": ${JSON.stringify(dep.spec)} in package.json, found ${matches.length}`,
    );
  }
  return text.replace(pattern, (_, key) => `${key}${JSON.stringify(after)}`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether package.json differs from HEAD only in a folio pin naming one of the plan's hops. */
function onlyPinMoved(project, run, plan) {
  try {
    const head = JSON.parse(committedFile(project, "package.json", run) ?? "null");
    const now = JSON.parse(readFileSync(path.join(project.root, "package.json"), "utf8"));
    const field = project.dep?.field;
    if (!head || !field || !head[field]?.folio) return false;
    const targets = plan.hops.map((h) => `github:brendanmckenzie/folio#v${h.to}`);
    if (!targets.includes(now[field]?.folio)) return false;
    head[field].folio = now[field].folio;
    return JSON.stringify(head) === JSON.stringify(now);
  } catch {
    return false;
  }
}
