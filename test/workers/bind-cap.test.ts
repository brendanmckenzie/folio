import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claimShare, sharedStoriesAt } from "../../src/server/auth/shares";
import { D1_BIND_CAP, type FolioDb } from "../../src/server/db";
import { indexedValuesFor } from "../../src/server/content-index";
import { countPasskeysByUser } from "../../src/server/auth/passkeys";
import { knownScopes } from "../../src/server/auth/sign-in";
import { redirectsAtPaths } from "../../src/server/redirects";

/**
 * D1 binds at most `D1_BIND_CAP` parameters per statement (#29). Each path here
 * took a caller-sized list and bound all of it; `db.ts` says any such query must
 * chunk or cap. The proxy records the widest `bind()` so the assertion does not
 * depend on how miniflare enforces the cap.
 */

function recording(): { db: FolioDb; widest: () => number } {
  let widest = 0;
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") {
          return (...args: unknown[]) => {
            widest = Math.max(widest, args.length);
            return wrap(target.bind(...args));
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  const db = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql)),
    batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
  } as FolioDb;
  return { db, widest: () => widest };
}

describe("caller-sized binds stay under D1's cap", () => {
  it("indexedValuesFor chunks the Data list's 200-row page", async () => {
    const { db, widest } = recording();
    const ids = Array.from({ length: 200 }, (_, i) => `sty_${i}`);
    await expect(indexedValuesFor(db, ids)).resolves.toEqual({});
    expect(widest()).toBeGreaterThan(0);
    expect(widest()).toBeLessThanOrEqual(D1_BIND_CAP);
  });

  it("countPasskeysByUser chunks the Users list's 200-row page", async () => {
    const { db, widest } = recording();
    const ids = Array.from({ length: 200 }, (_, i) => `usr_${i}`);
    await expect(countPasskeysByUser(db, ids)).resolves.toEqual(new Map());
    expect(widest()).toBeGreaterThan(0);
    expect(widest()).toBeLessThanOrEqual(D1_BIND_CAP);
  });

  it("redirectsAtPaths chunks a deep ancestor list, chain binds included", async () => {
    const { db, widest } = recording();
    const paths = Array.from({ length: 250 }, (_, i) => `p${i}`);
    await expect(redirectsAtPaths(db, ["a", "b", "c"], paths)).resolves.toEqual([]);
    expect(widest()).toBeGreaterThan(0);
    expect(widest()).toBeLessThanOrEqual(D1_BIND_CAP);
  });

  it("knownScopes chunks a mapper's scope list, and still answers membership", async () => {
    const { db, widest } = recording();
    await env.DB.prepare(
      "insert into sites (id, kind, name, created_at, updated_at) values ('g200', 'site', 'Real', 0, 0)",
    ).run();
    const scopes = [...Array.from({ length: 250 }, (_, i) => `g${i}`), "*"];
    const known = await knownScopes(db, scopes);
    expect(known.has("*")).toBe(true);
    expect(known.has("g200")).toBe(true); // lives in the second chunk
    expect(known.has("g1")).toBe(false);
    expect(widest()).toBeGreaterThan(0);
    expect(widest()).toBeLessThanOrEqual(D1_BIND_CAP);
  });

  it("claimShare and sharedStoriesAt look at no more than the cookie's token cap", async () => {
    const { db, widest } = recording();
    const presented = Array.from({ length: 150 }, (_, i) => `token-${i}`);
    await expect(claimShare(db, presented, "sty_x", Date.now(), "default")).resolves.toBeNull();
    await expect(sharedStoriesAt(db, presented, "default", "/x")).resolves.toEqual([]);
    expect(widest()).toBeGreaterThan(0);
    expect(widest()).toBeLessThanOrEqual(D1_BIND_CAP);
  });
});
