import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ContentQuery } from "../../src/core/query";
import { contentSql, runQuery, runQuerySlice } from "../../src/server/query";

/**
 * **What an indexed-order listing reads, at the size where it matters.**
 *
 * `query-order.test.ts` proves the rows. It cannot prove the cost, because a fixture of
 * fifty rows reads fifty rows however the statement is shaped. `content_index` has no
 * type or site column, so a listing driven from it walks every story in the database that
 * has the field, and the shapes below are the ones where that is thousands of rows
 * against a page of twelve: a field shared with a much larger type, a small site beside a
 * large one in one database, a selective filter, a sparse field, a deep page.
 *
 * Each case runs the old statements (`contentSql`'s page and count) and `runQuery` /
 * `runQuerySlice` against the same data, compares `D1Result.meta.rows_read`, and requires
 * the same ids. The bound is the old cost plus a fixed allowance (the capped walk and its
 * fallback, which do not grow with the table) and a quarter, so a regression back to
 * walking the field fails by orders of magnitude, not by a margin.
 */
const indexed = new Set(["date", "pub", "topic", "label", "flag", "prio"]);
const N = 2500;

function spyDb() {
  const stats = { rows: 0, stmts: 0 };
  const track = (stmt: D1PreparedStatement) => ({
    all: async <T>() => {
      const r = await stmt.all<T>();
      stats.rows += r.meta.rows_read;
      stats.stmts++;
      return r;
    },
    first: async <T>() => {
      const r = await stmt.all<T>();
      stats.rows += r.meta.rows_read;
      stats.stmts++;
      return (r.results[0] ?? null) as T | null;
    },
  });
  const db = {
    prepare: (sql: string) => ({
      bind: (...b: unknown[]) => track(env.DB.prepare(sql).bind(...b)),
    }),
    batch: env.DB.batch.bind(env.DB),
  };
  return { db, stats };
}

async function oldCost(q: ContentQuery, chain: readonly string[], counted: boolean) {
  const { page, count } = contentSql(q, indexed, "", undefined, undefined, chain);
  const perPage = Math.min(q.perPage ?? 20, 100);
  const binds = counted ? page.binds : [...page.binds.slice(0, -2), perPage + 1, page.binds.at(-1)];
  const a = await env.DB.prepare(page.text)
    .bind(...binds)
    .all<{ id: string }>();
  const b = counted
    ? await env.DB.prepare(count.text)
        .bind(...count.binds)
        .all()
    : null;
  return {
    rows: a.meta.rows_read + (b?.meta.rows_read ?? 0),
    ids: a.results.map((r) => r.id).slice(0, perPage),
  };
}

async function newCost(q: ContentQuery, chain: readonly string[], counted: boolean) {
  const { db, stats } = spyDb();
  const deps = {
    db,
    indexed,
    localeKey: (c: string | undefined) => c ?? "",
    withUrls: <T>(s: T) => s,
    chain,
  } as unknown as Parameters<typeof runQuery>[0];
  const res = await (counted ? runQuery : runQuerySlice)(deps, q);
  return { ...stats, ids: res.items.map((i) => i.id) };
}

const doc = JSON.stringify({
  root: "r",
  bloks: { r: { uid: "r", type: "x", parent: null, slot: null, order: "a0", data: {} } },
});

beforeAll(async () => {
  const stmts: D1PreparedStatement[] = [];
  const story = (
    id: string,
    type: string,
    site: string,
    fields: Record<string, [string | null, number | null]>,
  ) => {
    stmts.push(
      env.DB.prepare(
        `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id, published_doc)
         values (?, ?, null, ?, ?, 'a0', ?, 0, ?, ?)`,
      ).bind(id, type, id, `${type}/${id}`, id, site, doc),
    );
    for (const [f, [t, n]] of Object.entries(fields)) {
      stmts.push(
        env.DB.prepare(
          `insert into content_index (story_id, locale, field, text_value, num_value)
           values (?, '', ?, ?, ?)`,
        ).bind(id, f, t, n),
      );
    }
  };
  const base = Date.parse("2020-01-01");
  const day = 86_400_000;
  const when = (ms: number): [string, number] => [new Date(ms).toISOString(), ms];
  // 30 posts with old dates; N events with newer dates in the same field.
  for (let i = 0; i < 30; i++)
    story(`p${i}`, "post", "default", {
      date: when(base + i * day),
      flag: ["true", 1],
      prio: ["1", 1 + (i % 3)],
    });
  for (let i = 0; i < N; i++)
    story(`e${i}`, "event", "default", {
      date: when(base + 1e11 + i * 6e4),
      flag: ["true", 1],
    });
  // N articles: a numeric field of their own, the shared one (older than the events), a rare
  // topic on 5, and a label on 10.
  for (let i = 0; i < N; i++) {
    story(`a${i}`, "article", "default", {
      pub: when(base + i * 36e5),
      date: when(base - 1e10 + i * 36e5),
      topic: [i % 500 === 0 ? "rare" : "common", null],
      flag: ["true", 1],
      prio: [String(1 + (i % 3)), 1 + (i % 3)],
      ...(i < 10 ? { label: [`l${i}`, null] as [string, null] } : {}),
    });
  }
  // A small site beside a large one, both on `date`.
  for (let i = 0; i < 20; i++) story(`al${i}`, "blog", "alpha", { date: when(base + i * day) });
  for (let i = 0; i < N; i++)
    story(`sh${i}`, "blog", "shared", { date: when(base + 1e11 + i * 6e4) });
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}, 120_000);

const ALLOWANCE = 400;
const desc = (field: string) => ({ field, dir: "desc" as const });

const CASES: [string, ContentQuery, readonly string[]][] = [
  ["own numeric field, page 1", { type: "article", order: desc("pub"), perPage: 12 }, ["default"]],
  [
    "own numeric field, page 3",
    { type: "article", order: desc("pub"), perPage: 12, page: 3 },
    ["default"],
  ],
  [
    "field shared with a larger type (30 posts, N newer events)",
    { type: "post", order: desc("date"), perPage: 12 },
    ["default"],
  ],
  [
    "the larger type's own listing of the shared field",
    { type: "article", order: desc("date"), perPage: 12 },
    ["default"],
  ],
  [
    "a small site beside a large one (chain [alpha])",
    { type: "blog", order: desc("date"), perPage: 12 },
    ["alpha"],
  ],
  [
    "a selective filter (5 of N) on a shared field",
    {
      type: "article",
      where: [{ field: "topic", op: "eq", value: "rare" }],
      order: desc("date"),
      perPage: 12,
    },
    ["default"],
  ],
  [
    "a sparse field (10 of N)",
    { type: "article", order: { field: "label", dir: "asc" }, perPage: 12 },
    ["default"],
  ],
  [
    "a boolean every story shares (30 posts, N events, N articles)",
    { type: "post", order: desc("flag"), perPage: 12 },
    ["default"],
  ],
  [
    "a boolean on the large type itself",
    { type: "article", order: desc("flag"), perPage: 12 },
    ["default"],
  ],
  [
    "three distinct values, shared with a larger type",
    { type: "post", order: { field: "prio", dir: "asc" }, perPage: 12 },
    ["default"],
  ],
  [
    "three distinct values on the large type itself",
    { type: "article", order: desc("prio"), perPage: 12 },
    ["default"],
  ],
  ["a deep page", { type: "article", order: desc("pub"), perPage: 12, page: 100 }, ["default"]],
  [
    "a neighbour (numeric bound on the sort field, one row)",
    {
      type: "article",
      where: [{ field: "pub", op: "lt", value: Date.parse("2020-03-01") }],
      order: desc("pub"),
      perPage: 1,
    },
    ["default"],
  ],
];

describe("an indexed-order listing never reads materially more than the old statements", () => {
  for (const counted of [true, false]) {
    for (const [name, q, chain] of CASES) {
      it(`${name} (${counted ? "counted" : "slice"})`, async () => {
        const old = await oldCost(q, chain, counted);
        const now = await newCost(q, chain, counted);
        expect(now.ids).toEqual(old.ids);
        expect({ name, rows: now.rows <= old.rows * 1.25 + ALLOWANCE }).toEqual({
          name,
          rows: true,
        });
        // And one statement for a page the capped walk can answer, two with the count.
        if (name.startsWith("own numeric") && !name.includes("page 3")) {
          expect(now.stmts).toBe(counted ? 2 : 1);
        }
      });
    }
  }

  it("keeps the win where one type owns the field", async () => {
    const q: ContentQuery = { type: "article", order: desc("pub"), perPage: 12 };
    const old = await oldCost(q, ["default"], true);
    const counted = await newCost(q, ["default"], true);
    const slice = await newCost(q, ["default"], false);
    // The count is N rows whichever way it is asked; the page itself reads a handful.
    expect(counted.rows).toBeLessThan(N + 200);
    expect(slice.rows).toBeLessThan(200);
    expect(old.rows).toBeGreaterThan(3 * N);
  });
});
