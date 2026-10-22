import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineRecord, text } from "../../src/core";
import { SINGLE_SITE_CHAIN } from "../../src/core/sites";
import { createFolio } from "../../src/server";
import {
  duplicateUniqueValues,
  recordByField,
  recordDraftCandidates,
  uniqueConflict,
} from "../../src/server/stories";

/**
 * How `reader.recordBy()` reads (issue #75): on a D1 session like every reader, and
 * through `content_index_lookup` rather than a scan. Both are invisible in the
 * answer — the same rows come back either way — so each is pinned as the shape that
 * produces it, as `read-session.test.ts` and `query-plan.test.ts` do for the readers
 * they cover.
 */

/* ---------------------------------------------------------- the session --- */

interface Spy {
  db: D1Database;
  sessions: number;
  prepares: number;
  unsessioned: number;
}

/** Follows `withSession` *and* `bind`: a proxy watching only `prepare` records nothing. */
function spyOn(real: D1Database): Spy {
  const spy: Spy = { db: real, sessions: 0, prepares: 0, unsessioned: 0 };
  const watch = <T extends object>(target: T, sessioned: boolean): T =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "prepare") {
          return (...args: unknown[]) => {
            spy.prepares++;
            if (!sessioned) spy.unsessioned++;
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (prop === "withSession") {
          return (...args: unknown[]) => {
            spy.sessions++;
            return watch((value as (...a: unknown[]) => object).apply(t, args), true);
          };
        }
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  spy.db = watch(real, false);
  return spy;
}

const artist = defineRecord({
  name: "rrArtist",
  label: "Artist",
  fields: { slug: text({ indexed: true, unique: true }) },
});

function makeFolio(db: D1Database) {
  return createFolio<Cloudflare.Env>({
    blocks: [artist],
    types: [
      { name: "rrPage", label: "Page", kind: "page", root: "rrArtist", default: true },
      { name: "rrArtistType", label: "Artist", kind: "record", root: "rrArtist" },
    ],
    bindings: (e) => ({ db, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: "/folio",
    assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
    auth: "open",
    route: (p) => (p ? `/${p}` : "/"),
  });
}

const publishedDoc = JSON.stringify({
  root: "r",
  bloks: {
    r: { uid: "r", type: "rrArtist", parent: null, slot: null, order: "a0", data: { slug: "ada" } },
  },
});

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, published_doc, published_at)
       values ('rr_ada', 'rrArtistType', null, 'rr_ada', null, 'a0', 'Ada', 1, ?, 1)`,
    ).bind(publishedDoc),
    env.DB.prepare(
      "insert into content_index (story_id, locale, field, text_value) values ('rr_ada', '', 'slug', 'ada')",
    ),
  ]);
});

describe("recordBy reads on a session", () => {
  it("never issues a query straight on the binding, and opens one session", async () => {
    const spy = spyOn(env.DB);
    const reader = makeFolio(spy.db).reader(env, new Request("https://example.com/ada"));
    const page = await reader.recordBy("rrArtistType", "slug", "ada");
    expect(page?.story.id).toBe("rr_ada");
    expect(spy.prepares).toBeGreaterThan(0);
    expect(spy.unsessioned).toBe(0);
    expect(spy.sessions).toBe(1);
  });

  it("does the same for a miss", async () => {
    const spy = spyOn(env.DB);
    const reader = makeFolio(spy.db).reader(env, new Request("https://example.com/x"));
    expect(await reader.recordBy("rrArtistType", "slug", "nobody")).toBeNull();
    expect(spy.unsessioned).toBe(0);
  });
});

/* ------------------------------------------------------------- the plan --- */

interface Recorded {
  sql: string;
  binds: unknown[];
}

function recording(real: D1Database): { db: D1Database; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const watchStatement = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "bind") {
          return (...args: unknown[]) => {
            seen.push({ sql, binds: args });
            return (value as (...a: unknown[]) => D1PreparedStatement).apply(t, args);
          };
        }
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  const db = new Proxy(real, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (prop === "prepare") return (sql: string) => watchStatement(real.prepare(sql), sql);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
  return { db, seen };
}

async function plan(stmt: Recorded): Promise<string[]> {
  const { results } = await env.DB.prepare(`explain query plan ${stmt.sql}`)
    .bind(...stmt.binds)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

const lookup = { type: "rrArtistType", field: "slug", locale: "", value: "ada" };
const CHAINS: [string, readonly string[]][] = [
  ["single-site", SINGLE_SITE_CHAIN],
  ["a site in a group", ["alpha", "north", "shared"]],
];

describe("the record lookups plan an index, never a scan", () => {
  for (const [label, chain] of CHAINS) {
    it(`recordByField reaches content_index_lookup (${label})`, async () => {
      const { db, seen } = recording(env.DB);
      await recordByField(db, chain, lookup);
      expect(seen).toHaveLength(1);
      const steps = await plan(seen[0]!);
      expect(steps.join("\n")).toContain("content_index_lookup");
      expect(steps.filter((s) => /^SCAN /.test(s))).toEqual([]);
    });

    it(`recordDraftCandidates does not scan stories (${label})`, async () => {
      const { db, seen } = recording(env.DB);
      await recordDraftCandidates(db, chain, lookup);
      expect(seen.length).toBeGreaterThan(0);
      for (const stmt of seen) {
        const steps = await plan(stmt);
        expect({ sql: stmt.sql, scans: steps.filter((s) => /^SCAN /.test(s)) }).toEqual({
          sql: stmt.sql,
          scans: [],
        });
      }
    });
  }

  it("the publish-time check seeks content_index_lookup", async () => {
    const { db, seen } = recording(env.DB);
    await uniqueConflict(
      db,
      { id: "rr_new", type: "rrArtistType", site: "default" },
      [{ locale: "", field: "slug", text: "ada", num: null }],
      new Set(["slug"]),
    );
    expect(seen).toHaveLength(1);
    expect((await plan(seen[0]!)).join("\n")).toContain("content_index_lookup");
  });

  it("the audit's group-by seeks content_index by field", async () => {
    const { db, seen } = recording(env.DB);
    await duplicateUniqueValues(db, "rrArtistType", "slug");
    expect(seen).toHaveLength(1);
    const steps = await plan(seen[0]!);
    expect(steps.filter((s) => /^SCAN /.test(s))).toEqual([]);
  });
});
