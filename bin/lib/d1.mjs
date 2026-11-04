/**
 * What a D1 database has applied, read through the host's own wrangler.
 *
 * Only ever a `select` (spec 41 decision 4). Wrangler records each applied file in
 * `d1_migrations` (or the database's `migrations_table`) by file name, and answers
 * `wrangler d1 execute --json` with either `[{ results: [...], success: true }]`
 * (exit 0) or `{ error: { text } }` (exit 1). A missing table is "nothing applied
 * yet", which is a real state and not an error.
 */

export const DEFAULT_MIGRATIONS_TABLE = "d1_migrations";

/**
 * @param {{ cwd: string, wranglerBin: string, database: string, table?: string,
 *   remote?: boolean, env?: string | null, config?: string | null, persistTo?: string | null,
 *   run: import("./run.mjs").Runner }} opts
 * @returns {{ ok: true, applied: string[], argv: string[] } |
 *   { ok: false, reason: "auth" | "locked" | "other", message: string, argv: string[] }}
 */
export function appliedMigrations(opts) {
  const table = opts.table ?? DEFAULT_MIGRATIONS_TABLE;
  const argv = [
    opts.wranglerBin,
    "d1",
    "execute",
    opts.database,
    opts.remote ? "--remote" : "--local",
    "--json",
    "--command",
    `select name from ${table} order by id`,
    ...(opts.env ? ["--env", opts.env] : []),
    ...(opts.config ? ["--config", opts.config] : []),
    ...(opts.persistTo && !opts.remote ? ["--persist-to", opts.persistTo] : []),
  ];
  const result = opts.run(argv, { cwd: opts.cwd });
  return { ...parseExecute(result, table), argv };
}

/** Parses one `wrangler d1 execute --json` run. Exported for `d1.test.ts`. */
export function parseExecute(result, table = DEFAULT_MIGRATIONS_TABLE) {
  const json = firstJson(result.stdout) ?? firstJson(result.stderr);
  if (result.status === 0 && Array.isArray(json)) {
    const rows = json.flatMap((r) => r?.results ?? []);
    return { ok: true, applied: rows.map((r) => r.name).filter((n) => typeof n === "string") };
  }
  const text =
    json?.error?.text ??
    json?.error?.message ??
    `${result.stderr ?? ""}${result.stdout ?? ""}`.trim() ??
    "wrangler failed";
  if (new RegExp(`no such table: (main\\.)?${table}`).test(text)) return { ok: true, applied: [] };
  if (/SQLITE_BUSY|database is locked/i.test(text)) {
    return { ok: false, reason: "locked", message: text };
  }
  if (
    /not logged in|wrangler login|authenticat|CLOUDFLARE_API_TOKEN|Authentication error|\b10000\b/i.test(
      text,
    )
  ) {
    return { ok: false, reason: "auth", message: text };
  }
  return { ok: false, reason: "other", message: text || `wrangler exited ${result.status}` };
}

/** Shipped files the database has not applied, in file order. Gaps are not pending. */
export function pending(shipped, applied) {
  const have = new Set(applied);
  return shipped.filter((f) => !have.has(f)).sort();
}

/**
 * Folio-shaped files (`NNNN_*.sql`) the database recorded that the installed
 * package does not ship: it was migrated by a newer Folio.
 */
export function unknown(shipped, applied) {
  const known = new Set(shipped);
  return applied.filter((f) => /^\d{4}_.*\.sql$/.test(f) && !known.has(f)).sort();
}

/** The first JSON value in `text`, tolerating a banner line before it. */
function firstJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.search(/^[[{]/m);
  if (start === -1) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}
