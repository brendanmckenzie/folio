import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ContentQuery } from "../../src/core/query";
import { SINGLE_SITE_CHAIN } from "../../src/core/sites";
import { contentSql, indexedOrderSql, runQuery, runQuerySlice } from "../../src/server/query";

/**
 * **An indexed-field listing returns what the single `left join` statement returned.**
 *
 * `contentSql` still compiles that statement and it is the oracle here: every case is
 * run through it (one `limit`/`offset` page, and its `count`) and through `runQuery`,
 * which now drives from `content_index` in up to three groups, and the two must agree
 * on the ids, their order and `total`. Only the order and the rows are compared; the
 * point of the change is that nothing else moves.
 *
 * The fixture is built to put a row in every place the old order could put one: a
 * numeric value (ISO dates with ties, and plain numbers), a text-only value, no
 * value at all, and an index row holding neither value; unpublished rows; another type
 * sharing the field; other sites and a shadowed path; another locale.
 */

const FIELDS = ["when", "label", "topic"];
const indexed = new Set(FIELDS);

interface Seed {
  id: string;
  type: string;
  site: string;
  path: string | null;
  published: boolean;
  parent?: string | null;
  /** locale → field → [text, num] (null for a value the row holds as null). */
  rows: Record<string, Record<string, [string | null, number | null]>>;
}

const date = (iso: string): [string, number] => [iso, Date.parse(iso)];
const num = (n: number): [string, number] => [String(n), n];
const word = (w: string): [string, null] => [w, null];

function seeds(): Seed[] {
  const out: Seed[] = [];
  const add = (
    n: string,
    type: string,
    site: string,
    when: [string | null, number | null] | undefined,
    extra: Partial<Seed> & { label?: string; topic?: string; fr?: [string, number | null] } = {},
  ) => {
    const rows: Seed["rows"] = { "": {} };
    if (when) rows[""]!.when = when;
    if (extra.label) rows[""]!.label = word(extra.label);
    if (extra.topic) rows[""]!.topic = word(extra.topic);
    if (extra.fr) rows.fr = { when: extra.fr };
    out.push({
      id: `qo_${n}`,
      type,
      site,
      path: extra.path === undefined ? `${type}/${n}` : extra.path,
      published: extra.published ?? true,
      parent: extra.parent ?? null,
      rows,
    });
  };

  // Numeric: ISO dates, three of them sharing a day.
  const days = [
    "2024-01-05",
    "2024-01-05",
    "2024-01-05",
    "2023-06-30",
    "2025-03-01",
    "2022-12-31",
    "2024-02-29T10:00:00Z",
    "2024-02-29T09:00:00Z",
    "2021-07-07",
    "2026-01-01",
    "2020-05-05",
    "2024-01-06",
  ];
  for (const [i, d] of days.entries()) {
    add(`d${i}`, "post", "default", date(d), {
      topic: i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : undefined,
      label: i % 2 === 0 ? `L${i % 4}` : undefined,
      fr: i < 4 ? date(`2019-0${i + 1}-01`) : undefined,
    });
  }
  // Numeric: plain numbers, with ties; sorts among the dates by value.
  for (const [i, v] of [5, 5, 1.7e12, 20, 0, -3].entries()) add(`n${i}`, "post", "default", num(v));
  // Text only.
  for (const [i, w] of ["pear", "apple", "apple", "zebra", "Mango", "10 things"].entries()) {
    add(`t${i}`, "post", "default", word(w), { topic: i % 2 === 0 ? "a" : undefined });
  }
  // Nothing for the field: no row at all.
  for (let i = 0; i < 5; i++) add(`x${i}`, "post", "default", undefined, { label: `Z${i}` });
  // An index row holding neither value.
  add("nn", "post", "default", [null, null]);
  // ...and one holding only a number, which no projection writes but the old order sorts.
  add("nm", "post", "default", [null, 42]);
  // Unpublished, with a value and without.
  add("u0", "post", "default", date("2025-09-09"), { published: false });
  add("u1", "post", "default", undefined, { published: false });
  // A child, for `parent`.
  add("c0", "post", "default", date("2024-05-05"), { parent: "qo_d0" });
  // Another type sharing the field.
  for (let i = 0; i < 6; i++) add(`o${i}`, "note", "default", date(`2024-0${i + 1}-10`));
  add("o6", "note", "default", word("zzz"));
  // Other sites. `a0` and `s0` share a path, so on the group chain alpha shadows shared.
  add("a0", "post", "alpha", date("2024-03-03"), { path: "post/d0" });
  add("a1", "post", "alpha", word("alpha-text"));
  add("a2", "post", "alpha", undefined);
  add("a3", "post", "alpha", num(7));
  add("s0", "post", "shared", date("2023-03-03"), { path: "post/d0" });
  add("s1", "post", "shared", date("2022-02-02"));
  add("s2", "post", "shared", word("shared-text"));
  add("s3", "post", "shared", undefined);
  return out;
}

beforeAll(async () => {
  const stmts: D1PreparedStatement[] = [];
  for (const s of seeds()) {
    const doc = JSON.stringify({
      root: "r",
      bloks: { r: { uid: "r", type: "x", parent: null, slot: null, order: "a0", data: {} } },
    });
    stmts.push(
      env.DB.prepare(
        `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id, published_doc)
         values (?, ?, ?, ?, ?, 'a0', ?, 0, ?, ?)`,
      ).bind(s.id, s.type, s.parent, s.id, s.path, s.id, s.site, s.published ? doc : null),
    );
    for (const [locale, fields] of Object.entries(s.rows)) {
      for (const [field, [text, n]] of Object.entries(fields)) {
        stmts.push(
          env.DB.prepare(
            `insert into content_index (story_id, locale, field, text_value, num_value)
             values (?, ?, ?, ?, ?)`,
          ).bind(s.id, locale, field, text, n),
        );
      }
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
});

const CHAINS: [string, readonly string[]][] = [
  ["single-site", SINGLE_SITE_CHAIN],
  ["a site in a group", ["alpha", "shared"]],
];

const deps = (chain: readonly string[]) => ({
  db: env.DB,
  indexed,
  localeKey: (code: string | undefined) => code ?? "",
  withUrls: <T>(story: T) => story,
  chain,
});

/** The old statement, one page of it, and its count. */
async function oracle(q: ContentQuery, chain: readonly string[]) {
  const { page, count } = contentSql(q, indexed, q.locale ?? "", undefined, undefined, chain);
  const rows = await env.DB.prepare(page.text)
    .bind(...page.binds)
    .all<{ id: string }>();
  const n = await env.DB.prepare(count.text)
    .bind(...count.binds)
    .first<{ n: number }>();
  return { ids: rows.results.map((r) => r.id), total: n?.n ?? 0 };
}

const FILTERS: [string, Partial<ContentQuery>][] = [
  ["no filter", {}],
  ["one type", { type: "post" }],
  ["both types", { type: ["post", "note"] }],
  ["top level only", { type: "post", parent: null }],
  [
    "numeric range, lower bound",
    { type: "post", where: [{ field: "when", op: "gte", value: Date.parse("2024-01-05") }] },
  ],
  [
    "numeric range, both bounds",
    {
      type: "post",
      where: [
        { field: "when", op: "gt", value: Date.parse("2022-12-31") },
        { field: "when", op: "lt", value: Date.parse("2024-02-29T10:00:00Z") },
      ],
    },
  ],
  ["numeric range, open top", { where: [{ field: "when", op: "lte", value: 20 }] }],
  ["string range", { type: "post", where: [{ field: "when", op: "gte", value: "2024-01-05" }] }],
  [
    "string range matching text values",
    { type: "post", where: [{ field: "when", op: "gt", value: "b" }] },
  ],
  ["eq on the sort field", { type: "post", where: [{ field: "when", op: "eq", value: "apple" }] }],
  ["eq on a date", { type: "post", where: [{ field: "when", op: "eq", value: "2024-01-05" }] }],
  ["ne on the sort field", { type: "post", where: [{ field: "when", op: "ne", value: "apple" }] }],
  [
    "in on the sort field",
    { type: "post", where: [{ field: "when", op: "in", value: ["apple", "pear", "2024-01-05"] }] },
  ],
  [
    "startsWith on the sort field",
    { type: "post", where: [{ field: "when", op: "startsWith", value: "a" }] },
  ],
  [
    "a filter on another field",
    { type: "post", where: [{ field: "topic", op: "eq", value: "a" }] },
  ],
  ["ne on another field", { type: "post", where: [{ field: "topic", op: "ne", value: "a" }] }],
  [
    "sort-field range and another field",
    {
      type: "post",
      where: [
        { field: "when", op: "gte", value: Date.parse("2023-01-01") },
        { field: "topic", op: "eq", value: "b" },
      ],
    },
  ],
  ["a filter nothing matches", { type: "post", where: [{ field: "when", op: "gt", value: 9e15 }] }],
];

const SORTS = ["when", "label", "topic"];
const PER_PAGES = [1, 4, 7, 100];

describe("an indexed-field listing equals the single-statement oracle", () => {
  for (const [chainName, chain] of CHAINS) {
    for (const [filterName, filter] of FILTERS) {
      it(`${chainName}, ${filterName}: every sort, direction, page size and page`, async () => {
        for (const field of SORTS) {
          for (const dir of ["asc", "desc"] as const) {
            for (const perPage of PER_PAGES) {
              for (let page = 1; page <= 12; page++) {
                const q: ContentQuery = { ...filter, order: { field, dir }, perPage, page };
                const want = await oracle(q, chain);
                const got = await runQuery(deps(chain), q);
                const label = `${field} ${dir} perPage=${perPage} page=${page}`;
                expect({ label, ids: got.items.map((i) => i.id), total: got.total }).toEqual({
                  label,
                  ids: want.ids,
                  total: want.total,
                });
                if (want.ids.length === 0 && page > 1) break;
              }
            }
          }
        }
      });
    }
  }

  it("the same in another locale", async () => {
    for (const dir of ["asc", "desc"] as const) {
      for (const perPage of [1, 3, 100]) {
        for (let page = 1; page <= 8; page++) {
          const q: ContentQuery = {
            type: "post",
            locale: "fr",
            order: { field: "when", dir },
            perPage,
            page,
          };
          const want = await oracle(q, SINGLE_SITE_CHAIN);
          const got = await runQuery(deps(SINGLE_SITE_CHAIN), q);
          expect({ dir, perPage, page, ids: got.items.map((i) => i.id) }).toEqual({
            dir,
            perPage,
            page,
            ids: want.ids,
          });
        }
      }
    }
  });
});

describe("`runQuerySlice`", () => {
  it("returns the counted page's items and hasMore, for every page", async () => {
    for (const order of [
      { field: "when", dir: "desc" as const },
      { field: "when", dir: "asc" as const },
      "publishedAt" as const,
    ]) {
      for (const perPage of [1, 5, 9]) {
        for (let page = 1; page <= 40; page++) {
          const q: ContentQuery = { type: "post", order, perPage, page };
          const counted = await runQuery(deps(SINGLE_SITE_CHAIN), q);
          const slice = await runQuerySlice(deps(SINGLE_SITE_CHAIN), q);
          const label = `${JSON.stringify(order)} perPage=${perPage} page=${page}`;
          expect({ label, ids: slice.items.map((i) => i.id) }).toEqual({
            label,
            ids: counted.items.map((i) => i.id),
          });
          expect({ label, hasMore: slice.hasMore }).toEqual({
            label,
            hasMore: page < counted.pages,
          });
          expect(slice.total).toBeNull();
          expect(slice.pages).toBeNull();
          if (!slice.hasMore) break;
        }
      }
    }
  });

  it("issues no count statement, and the default still issues one", async () => {
    const seen: string[] = [];
    const spying = {
      ...deps(SINGLE_SITE_CHAIN),
      db: {
        prepare: (sql: string) => {
          seen.push(sql);
          return env.DB.prepare(sql);
        },
        batch: env.DB.batch.bind(env.DB),
      },
    };
    for (const order of [{ field: "when", dir: "desc" as const }, "publishedAt" as const]) {
      seen.length = 0;
      await runQuerySlice(spying, { type: "post", order, perPage: 5 });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((s) => /count\(\*\) as n/.test(s))).toEqual([]);
      seen.length = 0;
      await runQuery(spying, { type: "post", order, perPage: 5 });
      expect(seen.filter((s) => /count\(\*\) as n/.test(s)).length).toBe(1);
    }
  });
});

describe("what the ordered statements read", () => {
  const plan = async (sql: string, binds: unknown[]) =>
    (
      await env.DB.prepare(`explain query plan ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>()
    ).results.map((r) => r.detail);

  for (const analyse of [false, true]) {
    it(`walks content_index_num in order and never sorts the whole set${analyse ? " (after ANALYZE)" : ""}`, async () => {
      if (analyse) await env.DB.exec("analyze");
      const q: ContentQuery = { type: "post", order: { field: "when", dir: "desc" }, perPage: 12 };
      const ordered = indexedOrderSql(q, "", undefined, SINGLE_SITE_CHAIN)!;
      const first = ordered.page(12, 0)!;
      const details = (await plan(first.text, first.binds)).join("\n");
      expect(details).toMatch(/SEARCH ci USING INDEX content_index_num/);
      // `cross join` keeps the index walk outer: stories is only ever probed by key.
      expect(details).toMatch(/SEARCH stories USING INDEX sqlite_autoindex_stories_1/);
      expect(details).not.toMatch(/SCAN stories/);
    });
  }

  it("emits nothing new for a built-in order or a search", () => {
    for (const q of [
      { order: "ord" as const },
      { order: "publishedAt" as const },
      { order: "title" as const },
      { search: "hello", order: { field: "when", dir: "desc" as const } },
    ])
      expect(indexedOrderSql(q, "", undefined, SINGLE_SITE_CHAIN)).toBeNull();
  });
});
