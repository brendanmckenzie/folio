// Brings `deferred` issues back into triage on their `Revisit: YYYY-MM-DD` date.
// Dependency-free: Node built-ins and fetch against the REST API.
//
//   GITHUB_TOKEN=... node scripts/github/revisit.mjs [--dry-run] [--today=YYYY-MM-DD]
//
// GITHUB_REPOSITORY (owner/name) defaults to brendanmckenzie/folio.
import { fileURLToPath } from "node:url";

const TIME_ZONE = "Australia/Melbourne";
const REVISIT_LINE = /^Revisit: (\d{4})-(\d{2})-(\d{2})[ \t]*$/m;

/** A real calendar date, not just something shaped like one. */
function isCivilDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** The `Revisit: YYYY-MM-DD` date from an issue body, or null if absent or not a real date. */
export function parseRevisit(body) {
  if (typeof body !== "string") return null;
  const m = REVISIT_LINE.exec(body.replace(/\r\n?/g, "\n"));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isCivilDate(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Today's civil date in Australia/Melbourne as YYYY-MM-DD. */
export function melbourneToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * What to do with one deferred issue: "revisit" (date today or earlier),
 * "no-date" (no parseable line) or "wait". ISO dates compare as strings.
 */
export function decide(body, today) {
  const date = parseRevisit(body);
  if (date === null) return { action: "no-date", date: null };
  return { action: date <= today ? "revisit" : "wait", date };
}

export function commentFor(decision) {
  if (decision.action === "revisit") {
    return `The revisit date (${decision.date}) has arrived. Removed \`deferred\`; this issue is back in triage.`;
  }
  return "This issue was labelled `deferred` but has no readable `Revisit: YYYY-MM-DD` line in its body. Removed `deferred` so it lands in triage. To park it again, add the line and re-add the label.";
}

async function gh(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "folio-revisit",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return method === "DELETE" ? null : res.json();
}

async function listDeferred(token, repo) {
  const out = [];
  for (let page = 1; ; page++) {
    const rows = await gh(
      token,
      "GET",
      `/repos/${repo}/issues?state=open&labels=deferred&per_page=100&page=${page}`,
    );
    out.push(...rows.filter((r) => !r.pull_request));
    if (rows.length < 100) return out;
  }
}

export async function run({ token, repo, today, dryRun, log = console.log }) {
  const issues = await listDeferred(token, repo);
  log(
    `today=${today} (${TIME_ZONE}) deferred open issues: ${issues.length}${dryRun ? " [dry run]" : ""}`,
  );
  for (const issue of issues) {
    const decision = decide(issue.body, today);
    const tag = `#${issue.number} "${issue.title}"`;
    if (decision.action === "wait") {
      log(`${tag}: not yet (revisit ${decision.date})`);
      continue;
    }
    const remove = issue.labels
      .map((l) => (typeof l === "string" ? l : l.name))
      .filter((n) => n === "deferred" || n.startsWith("status:"));
    log(
      `${tag}: ${decision.action === "revisit" ? `selected (revisit ${decision.date})` : "no readable Revisit line, flagging"}; ` +
        `${dryRun ? "would remove" : "removing"} ${remove.join(", ")} and comment`,
    );
    if (dryRun) continue;
    for (const name of remove) {
      await gh(
        token,
        "DELETE",
        `/repos/${repo}/issues/${issue.number}/labels/${encodeURIComponent(name)}`,
      );
    }
    await gh(token, "POST", `/repos/${repo}/issues/${issue.number}/comments`, {
      body: commentFor(decision),
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const flag = args.find((a) => a.startsWith("--today="))?.slice(8) || process.env.TODAY || "";
  if (flag && !/^\d{4}-\d{2}-\d{2}$/.test(flag)) throw new Error(`bad today: ${flag}`);
  await run({
    token,
    repo: process.env.GITHUB_REPOSITORY || "brendanmckenzie/folio",
    today: flag || melbourneToday(),
    dryRun: args.includes("--dry-run"),
  });
}
