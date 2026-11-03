import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defineBlock, select, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import { sourceTag } from "../../src/core/cache-tags";
import type { FormField } from "../../src/core/forms";
import { optionListKey } from "../../src/core/option-sources";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings, FolioConfig } from "../../src/server";
import type { PurgeCapability } from "../../src/server/cache-purge";
import { D1_BIND_CAP, type FolioDb, PRIMARY_FIRST } from "../../src/server/db";
import type { Form } from "../../src/server/forms";
import {
  LEASE_MS,
  listId,
  readListOnPrimary,
  readLists,
  pruneLists,
  PRUNE_AFTER_MS,
  type RefreshDeps,
  refreshList,
} from "../../src/server/option-sources";
import { createRuntime } from "../../src/server/runtime";
import type { ResolvedOptionSource } from "../../src/server/form-responses";

/**
 * The option-list store against real D1 (`form-option-sources.md` decisions 6 and 7):
 * the lease, the purge, the last good copy and the render path's refusal to call
 * `load`. Every refresh here injects the clock and the purge capability, because
 * Workers Cache is not simulated and a 30-second lease is not waited out.
 */

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const tripRoot = defineBlock({
  name: "osTrip",
  label: "Trip",
  summary: "title",
  fields: { title: text({ indexed: true }) },
  render: () => null,
});
const pageRoot = defineBlock({
  name: "osPage",
  label: "Page",
  fields: { title: text() },
  render: () => null,
});
const types: DocumentType[] = [
  { name: "osPage", label: "Page", kind: "page", root: "osPage", default: true },
  { name: "osTrip", label: "Trip", kind: "page", root: "osTrip" },
];

const loads: Array<{ locale: string | null; settings: unknown; signal: AbortSignal }> = [];
let answer: () => unknown = () => [{ value: "au", label: "Australia" }];

const config = {
  blocks: [tripRoot, pageRoot],
  types,
  bindings,
  basePath: "/folio",
  auth: "open" as const,
  route: (p: string) => (p ? `/${p}` : "/"),
  forms: {
    sources: {
      regional: {
        label: "Regional",
        settings: {
          region: select({
            options: [
              { value: "all", label: "All" },
              { value: "africa", label: "Africa" },
            ],
            default: "all",
          }),
        },
        async load(input: { locale: string | null; settings: unknown; signal: AbortSignal }) {
          loads.push(input);
          return answer() as never;
        },
      },
      countries: {
        label: "Countries",
        ttl: 60,
        async load(input: { locale: string | null; settings: unknown; signal: AbortSignal }) {
          loads.push(input);
          return answer() as never;
        },
      },
    },
  },
} satisfies FolioConfig<Cloudflare.Env>;

const brand = createRuntime<Cloudflare.Env>(config).brands.get(null)!;
const source = brand.forms!.sources.get("countries") as ResolvedOptionSource;
const regional = brand.forms!.sources.get("regional") as ResolvedOptionSource;

const purges: string[][] = [];
const capability: PurgeCapability = async () => async (opts) => {
  if ("tags" in opts && opts.tags) purges.push([...opts.tags]);
  return { success: true, errors: [], messages: [], result: [] } as never;
};

const logs: unknown[][] = [];
const logger = { ...console, error: (...a: unknown[]) => logs.push(a), warn: () => {} };

let clock = 1_000_000;
const deps = (over: Partial<RefreshDeps> = {}): RefreshDeps => ({
  db: env.DB,
  env: {},
  brand: null,
  source,
  logger: logger as never,
  purgeCapability: capability,
  now: () => clock,
  ...over,
});

const target = { settings: undefined, locale: "" };
const rowOf = () => env.DB.prepare("select * from option_lists").first<Record<string, unknown>>();

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from option_lists"),
    env.DB.prepare("delete from stories"),
  ]);
  loads.length = 0;
  purges.length = 0;
  logs.length = 0;
  clock += 10 * LEASE_MS;
  answer = () => [{ value: "au", label: "Australia" }];
});

describe("refreshList", () => {
  it("stores a first load and purges the source's tag", async () => {
    const result = await refreshList(deps(), target, 1000);
    expect(result).toMatchObject({ status: "loaded", changed: true });
    expect(JSON.parse((await rowOf())!.options as string)).toEqual([
      { value: "au", label: "Australia" },
    ]);
    expect(purges).toEqual([[sourceTag("countries")]]);
  });

  it("does not purge an unchanged list, and purges a changed one", async () => {
    await refreshList(deps(), target, 1000);
    purges.length = 0;
    clock += LEASE_MS + 1;
    expect(await refreshList(deps(), target, 1000)).toMatchObject({
      status: "loaded",
      changed: false,
    });
    expect(purges).toEqual([]);

    answer = () => [
      { value: "au", label: "Australia" },
      { value: "nz", label: "New Zealand" },
    ];
    clock += LEASE_MS + 1;
    expect(await refreshList(deps(), target, 1000)).toMatchObject({ changed: true });
    expect(purges).toEqual([[sourceTag("countries")]]);
  });

  it("tags a branded source with its brand", async () => {
    await refreshList(deps({ brand: { id: "alpha", label: "Alpha" } }), target, 1000);
    expect(purges).toEqual([[sourceTag("countries", "alpha")]]);
    expect((await rowOf())!.brand).toBe("alpha");
  });

  it("issues the second purge under waitUntil, after the delay", async () => {
    const pending: Promise<unknown>[] = [];
    const slept: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await refreshList(
      deps({
        waitUntil: (p) => pending.push(p),
        sleep: async (ms) => {
          slept.push(ms);
          await gate;
        },
      }),
      target,
      1000,
    );
    expect(purges).toHaveLength(1);
    release();
    await Promise.all(pending);
    expect(slept).toEqual([25_000]);
    expect(purges).toHaveLength(2);
  });

  it("times the second purge from the request, not from the end of the load", async () => {
    const pending: Promise<unknown>[] = [];
    const slept: number[] = [];
    await refreshList(
      deps({
        waitUntil: (p) => pending.push(p),
        requestStartedAt: Date.now() - 20_000,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
      target,
      1000,
    );
    await Promise.all(pending);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeLessThanOrEqual(5_000);
    expect(slept[0]).toBeGreaterThan(0);
    // A load that outlasted the window leaves no delay at all.
    clock += LEASE_MS + 1;
    answer = () => [{ value: "nz", label: "New Zealand" }];
    slept.length = 0;
    await refreshList(
      deps({
        waitUntil: (p) => pending.push(p),
        requestStartedAt: Date.now() - 40_000,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
      target,
      1000,
    );
    await Promise.all(pending);
    expect(slept).toEqual([0]);
  });

  it("fills a declared default and drops null and empty before load, and keys them as one", async () => {
    await refreshList(deps({ source: regional }), { settings: undefined, locale: "" }, 1000);
    expect(loads[0]!.settings).toEqual({ region: "all" });
    const keys = () =>
      env.DB.prepare("select key from option_lists")
        .all<{ key: string }>()
        .then((r) => r.results);
    expect(await keys()).toHaveLength(1);
    clock += LEASE_MS + 1;
    await refreshList(deps({ source: regional }), { settings: { region: null }, locale: "" }, 1000);
    clock += LEASE_MS + 1;
    await refreshList(deps({ source: regional }), { settings: { region: "" }, locale: "" }, 1000);
    expect(await keys()).toHaveLength(1);
    expect(loads.map((l) => l.settings)).toEqual([
      { region: "all" },
      { region: "all" },
      { region: "all" },
    ]);
  });

  it("makes one load for two concurrent refreshes (the lease)", async () => {
    const [a, b] = await Promise.all([
      refreshList(deps(), target, 1000),
      refreshList(deps(), target, 1000),
    ]);
    expect(loads).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual(["leased", "loaded"]);
  });

  it("lets a second refresh through once the lease has expired", async () => {
    await refreshList(deps(), target, 1000);
    expect((await refreshList(deps(), target, 1000)).status).toBe("leased");
    clock += LEASE_MS + 1;
    expect((await refreshList(deps(), target, 1000)).status).toBe("loaded");
    expect(loads).toHaveLength(2);
  });

  it("treats an empty list as a failure and keeps the last good one", async () => {
    await refreshList(deps(), target, 1000);
    answer = () => [];
    clock += LEASE_MS + 1;
    expect(await refreshList(deps(), target, 1000)).toEqual({ status: "failed", failure: "empty" });
    const row = (await rowOf())!;
    expect(JSON.parse(row.options as string)).toEqual([{ value: "au", label: "Australia" }]);
    expect(row.failure).toBe("empty");
    expect(row.failures).toBe(1);
    // and nothing was purged for the failure
    expect(purges).toHaveLength(1);
  });

  it("keeps the last good list through a throw, and stores a category, not the message", async () => {
    await refreshList(deps(), target, 1000);
    answer = () => {
      throw new Error("GET https://vendor.example/?key=SECRET failed");
    };
    clock += LEASE_MS + 1;
    expect(await refreshList(deps(), target, 1000)).toEqual({ status: "failed", failure: "threw" });
    const row = (await rowOf())!;
    expect(row.failure).toBe("threw");
    expect(JSON.stringify(row)).not.toContain("SECRET");
    expect(JSON.parse(row.options as string)).toHaveLength(1);
    expect(String(logs[0]?.[1])).toContain("SECRET");
    // A success clears the count.
    answer = () => [{ value: "nz" }];
    clock += LEASE_MS + 1;
    await refreshList(deps(), target, 1000);
    expect(await rowOf()).toMatchObject({ failures: 0, failure: null });
  });

  it("times out a load that ignores its signal, and aborts the signal", async () => {
    answer = () => new Promise(() => {});
    const result = await refreshList(deps(), target, 20);
    expect(result).toEqual({ status: "failed", failure: "timeout" });
    expect(loads[0]!.signal.aborted).toBe(true);
    expect((await rowOf())!.options).toBeNull();
  });

  it("fails a result that is not an array as malformed", async () => {
    answer = () => ({ value: "au" });
    expect(await refreshList(deps(), target, 1000)).toEqual({
      status: "failed",
      failure: "malformed",
    });
  });

  it("passes null for the source locale and the code for a localised one", async () => {
    await refreshList(deps(), target, 1000);
    clock += LEASE_MS + 1;
    await refreshList(deps(), { settings: { region: "oceania" }, locale: "fr" }, 1000);
    expect(loads.map((l) => l.locale)).toEqual([null, "fr"]);
    expect(loads[1]!.settings).toEqual({ region: "oceania" });
  });
});

describe("pruneLists", () => {
  it("does not delete a row a concurrent save loaded after the select", async () => {
    await refreshList(deps(), target, 1000);
    const later = clock + PRUNE_AFTER_MS + 10_000;
    await env.DB.prepare("update option_lists set attempted_at = ?").bind(clock).run();
    // The select sees a stale row; before the delete runs, a save loads it afresh.
    const racing = {
      prepare(sql: string) {
        const stmt = env.DB.prepare(sql);
        if (!sql.includes("select brand, source, key")) return stmt;
        return {
          bind: (...a: unknown[]) => {
            const bound = stmt.bind(...a);
            return {
              all: async () => {
                const seen = await bound.all();
                await env.DB.prepare("update option_lists set attempted_at = ?").bind(later).run();
                return seen;
              },
            };
          },
        };
      },
      batch: (s: never) => env.DB.batch(s),
    } as unknown as FolioDb;
    await pruneLists(racing, new Set(), later);
    expect(await rowOf()).not.toBeNull();
    // And a genuinely old unreferenced row still goes.
    await env.DB.prepare("update option_lists set attempted_at = ?").bind(clock).run();
    expect(await pruneLists(env.DB as unknown as FolioDb, new Set(), later)).toBe(1);
    expect(await rowOf()).toBeNull();
  });
});

describe("readLists", () => {
  it("chunks a caller-sized list under D1's bind ceiling", async () => {
    let widest = 0;
    const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(stmt, {
        get(t, prop) {
          if (prop === "bind") {
            return (...args: unknown[]) => {
              widest = Math.max(widest, args.length);
              return wrap(t.bind(...args));
            };
          }
          const v = Reflect.get(t, prop);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    const db = {
      prepare: (sql: string) => wrap(env.DB.prepare(sql)),
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
    } as FolioDb;
    await refreshList(deps(), target, 1000);
    const refs = Array.from({ length: 300 }, (_, i) => ({
      source: "countries",
      key: i === 0 ? optionListKey(undefined, "") : `[{},"k${i}"]`,
    }));
    const rows = await readLists(db, "", refs);
    expect(widest).toBeGreaterThan(0);
    expect(widest).toBeLessThanOrEqual(D1_BIND_CAP);
    expect([...rows.keys()]).toEqual([listId(refs[0]!)]);
  });

  it("keeps two brands' rows apart", async () => {
    await refreshList(deps({ brand: { id: "alpha", label: "A" } }), target, 1000);
    const ref = { source: "countries", key: optionListKey(undefined, "") };
    expect((await readLists(env.DB, "alpha", [ref])).size).toBe(1);
    expect((await readLists(env.DB, "beta", [ref])).size).toBe(0);
    expect((await readLists(env.DB, "", [ref])).size).toBe(0);
  });

  it("reads on the primary through a session of its own", async () => {
    const seen: string[] = [];
    const d1 = {
      withSession: (c: string) => {
        seen.push(c);
        return env.DB.withSession(c);
      },
    };
    await refreshList(deps(), target, 1000);
    const row = await readListOnPrimary(d1, "", {
      source: "countries",
      key: optionListKey(undefined, ""),
    });
    expect(row?.options).toHaveLength(1);
    expect(seen).toEqual([PRIMARY_FIRST]);
  });
});

describe("BrandRuntime.optionLists", () => {
  const form = (fields: FormField[]): Form =>
    ({ id: "frm_000000000001", fields }) as unknown as Form;
  const hostQ: FormField = {
    name: "country",
    kind: "select",
    label: "Country",
    optionsFrom: { source: "countries" },
  };
  const ctx = { chain: ["default"], env: {} };

  const publish = async (id: string, title: string) => {
    const doc: Doc = {
      root: "r0",
      bloks: {
        r0: { uid: "r0", type: "osTrip", parent: null, slot: null, order: "a0", data: { title } },
      },
    };
    await env.DB.prepare(
      `insert into stories (id, type, slug, path, ord, title, updated_at, published_doc, published_at)
       values (?, 'osTrip', ?, ?, 'a0', ?, 1, ?, 1)`,
    )
      .bind(id, id, id, title, JSON.stringify(doc))
      .run();
  };

  it("answers a host question unavailable when no row exists, without calling load", async () => {
    const out = await brand.optionLists(bindings(env), [form([hostQ])], {
      ...ctx,
      refresh: "never",
    });
    expect(out.get("frm_000000000001")!.get("country")).toEqual({
      options: null,
      resolved: { source: "countries", unavailable: true },
    });
    expect(loads).toEqual([]);
  });

  it("reads a stored row on 'never', stale or not, and still calls nothing", async () => {
    await refreshList(deps({ now: () => Date.now() - 10 * 3600_000 }), target, 1000);
    loads.length = 0;
    const out = await brand.optionLists(bindings(env), [form([hostQ])], {
      ...ctx,
      refresh: "never",
    });
    expect(out.get("frm_000000000001")!.get("country")!.options).toEqual([
      { value: "au", label: "Australia" },
    ]);
    expect(loads).toEqual([]);
  });

  it("answers a source that is no longer registered as unavailable", async () => {
    const q = { ...hostQ, optionsFrom: { source: "gone" } };
    const out = await brand.optionLists(bindings(env), [form([q])], { ...ctx, refresh: "submit" });
    expect(out.get("frm_000000000001")!.get("country")!.resolved.unavailable).toBe(true);
    expect(loads).toEqual([]);
  });

  it("on 'submit' uses a stale row as read and refreshes it under waitUntil", async () => {
    await refreshList(deps({ now: () => Date.now() - 10 * 3600_000 }), target, 1000);
    loads.length = 0;
    answer = () => [{ value: "nz", label: "New Zealand" }];
    const pending: Promise<unknown>[] = [];
    const out = await brand.optionLists(bindings(env), [form([hostQ])], {
      ...ctx,
      refresh: "submit",
      waitUntil: (p) => pending.push(p),
    });
    expect(out.get("frm_000000000001")!.get("country")!.options).toEqual([
      { value: "au", label: "Australia" },
    ]);
    await Promise.all(pending);
    expect(loads).toHaveLength(1);
    expect(JSON.parse((await rowOf())!.options as string)).toEqual([
      { value: "nz", label: "New Zealand" },
    ]);
  });

  it("on 'submit' awaits a load for a row that never held options", async () => {
    const out = await brand.optionLists(bindings(env), [form([hostQ])], {
      ...ctx,
      refresh: "submit",
    });
    expect(out.get("frm_000000000001")!.get("country")!.options).toEqual([
      { value: "au", label: "Australia" },
    ]);
    expect(loads).toHaveLength(1);
  });

  it("on 'submit' shares one load between questions that name one list", async () => {
    const out = await brand.optionLists(
      bindings(env),
      [form([hostQ, { ...hostQ, name: "second" }])],
      { ...ctx, refresh: "submit" },
    );
    expect(out.get("frm_000000000001")!.size).toBe(2);
    expect(loads).toHaveLength(1);
  });

  it("on a lost lease re-reads once on the primary, and stays unavailable without one", async () => {
    // Another request holds the lease and has not written yet.
    await env.DB.prepare(
      "insert into option_lists (brand, source, key, attempted_at) values ('', 'countries', ?, ?)",
    )
      .bind(optionListKey(undefined, ""), Date.now())
      .run();
    const without = await brand.optionLists(bindings(env), [form([hostQ])], {
      ...ctx,
      refresh: "submit",
    });
    expect(without.get("frm_000000000001")!.get("country")!.resolved.unavailable).toBe(true);
    expect(loads).toEqual([]);

    // The holder finishes between the replica read and the re-read.
    const seen: string[] = [];
    const primary = {
      withSession(c: string) {
        seen.push(c);
        return env.DB.withSession(c);
      },
    };
    await env.DB.prepare("update option_lists set options = ?, loaded_at = 1")
      .bind(JSON.stringify([{ value: "fj", label: "Fiji" }]))
      .run();
    const out = await brand.optionLists(bindings(env), [form([hostQ])], {
      ...ctx,
      refresh: "submit",
      primary,
    });
    // The row read on the session already holds options (stale), so no re-read.
    expect(out.get("frm_000000000001")!.get("country")!.options).toEqual([
      { value: "fj", label: "Fiji" },
    ]);
    expect(seen).toEqual([]);
  });

  it("re-reads on the primary when the session saw no options and the lease is held", async () => {
    await env.DB.prepare(
      "insert into option_lists (brand, source, key, attempted_at) values ('', 'countries', ?, ?)",
    )
      .bind(optionListKey(undefined, ""), Date.now())
      .run();
    const seen: string[] = [];
    const primary = {
      withSession(c: string) {
        seen.push(c);
        return env.DB.withSession(c);
      },
    };
    // The session handed to optionLists reads the row before the holder writes it.
    let reads = 0;
    const replica = {
      prepare: (sql: string) => {
        const stmt = env.DB.prepare(sql);
        if (sql.startsWith("select") && reads++ === 0) {
          return {
            bind: (...a: unknown[]) => ({
              all: async () => {
                const r = await stmt.bind(...a).all();
                await env.DB.prepare("update option_lists set options = ?, loaded_at = ?")
                  .bind(JSON.stringify([{ value: "fj", label: "Fiji" }]), Date.now())
                  .run();
                return r;
              },
            }),
          } as unknown as D1PreparedStatement;
        }
        return stmt;
      },
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
    } as FolioDb;
    const out = await brand.optionLists({ ...bindings(env), db: replica }, [form([hostQ])], {
      ...ctx,
      refresh: "submit",
      primary,
    });
    expect(seen).toEqual([PRIMARY_FIRST]);
    expect(out.get("frm_000000000001")!.get("country")!.options).toEqual([
      { value: "fj", label: "Fiji" },
    ]);
    expect(loads).toEqual([]);
  });

  it("lists published documents of one type for a content question, labelled by title", async () => {
    await publish("os_a", "Zanzibar");
    await publish("os_b", "Amalfi");
    await env.DB.prepare(
      `insert into stories (id, type, slug, path, ord, title, updated_at) values ('os_draft', 'osTrip', 'd', 'd', 'a0', 'Draft only', 1)`,
    ).run();
    const q: FormField = {
      name: "trip",
      kind: "select",
      label: "Trip",
      optionsFrom: { source: "content", settings: { type: "osTrip" } },
    };
    const out = await brand.optionLists(bindings(env), [form([q])], { ...ctx, refresh: "never" });
    const answer = out.get("frm_000000000001")!.get("trip")!;
    expect(answer.options).toEqual([
      { value: "os_b", label: "Amalfi" },
      { value: "os_a", label: "Zanzibar" },
    ]);
    expect(answer.resolved).toEqual({ source: "content", types: ["osTrip"] });
    expect(loads).toEqual([]);
  });

  it("answers an unsourced question not at all", async () => {
    const plain: FormField = { name: "n", kind: "text", label: "N" };
    const out = await brand.optionLists(bindings(env), [form([plain])], {
      ...ctx,
      refresh: "never",
    });
    expect(out.size).toBe(0);
  });
});
