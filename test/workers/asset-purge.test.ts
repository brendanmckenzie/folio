import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asset, defineBlock, select, text } from "../../src/core";
import type { DocumentType } from "../../src/core/schema";
import { newGating, afterAccessChange } from "../../src/server/asset-access";
import {
  drainAssetPurges,
  type PurgeCapability,
  pendingAssetPurges,
  SITE_PURGE_DELAY_MS,
} from "../../src/server/cache-purge";
import { createFolio } from "../../src/server";
import type { FolioConfig } from "../../src/server";
import type { AssetAccessChangedHookPayload, HookRunner } from "../../src/server/hooks";

/**
 * The edge purge queue and what drains it (`docs/specs/platform/asset-access.md`
 * decision 10), against real D1 with an injected `PurgeCapability` (Workers Cache is not
 * simulated). The failures are the half that matters: a purge that fails or is rate
 * limited must leave its row, because a lost row is a gated file served from the edge
 * to anyone for a year.
 */

const NOW = 1_800_000_000_000;
const MIN = 60_000;

interface Fake {
  capability: PurgeCapability;
  calls: string[][];
  mode: { result: "ok" | "refused" | "throws" };
  /** Runs inside a call, to simulate a write racing the purge. */
  during?: () => Promise<void>;
}

function fake(): Fake {
  const f: Fake = {
    calls: [],
    mode: { result: "ok" },
    capability: async () => async (options) => {
      f.calls.push([...((options as { tags?: string[] }).tags ?? ["<everything>"])]);
      await f.during?.();
      if (f.mode.result === "throws") throw new Error("purge exploded");
      return f.mode.result === "ok"
        ? ({ success: true, errors: [] } as unknown as CachePurgeResult)
        : ({
            success: false,
            errors: [{ code: 429, message: "rate limited" }],
          } as unknown as CachePurgeResult);
    },
  };
  return f;
}

const logs: string[] = [];
const logger = {
  error: (m: string) => void logs.push(String(m)),
  warn: (m: string) => void logs.push(String(m)),
  info() {},
  debug() {},
  log() {},
} as unknown as Console;

async function queue(
  id: string,
  opts: { queuedAt?: number; settleAt?: number; site?: string } = {},
) {
  const queuedAt = opts.queuedAt ?? NOW;
  await env.DB.prepare(
    "insert into asset_purges (asset_id, site_id, queued_at, settle_at) values (?, ?, ?, ?)",
  )
    .bind(id, opts.site ?? "default", queuedAt, opts.settleAt ?? queuedAt + 10 * MIN)
    .run();
}
interface Row {
  asset_id: string;
  purged_at: number | null;
  attempts: number;
  last_error: string | null;
}
const rows = async (): Promise<Row[]> =>
  (
    await env.DB.prepare(
      "select asset_id, purged_at, attempts, last_error from asset_purges order by asset_id",
    ).all<Row>()
  ).results;

beforeEach(async () => {
  logs.length = 0;
  await env.DB.prepare("delete from asset_purges").run();
});

describe("drainAssetPurges", () => {
  it("issues one call naming each asset when there are at most 100", async () => {
    const f = fake();
    for (const id of ["ast_a", "ast_b", "ast_c"]) await queue(id);
    const drained = await drainAssetPurges(env.DB, f.capability, NOW + 1000, logger);
    expect(f.calls).toEqual([["asset:ast_a", "asset:ast_b", "asset:ast_c"]]);
    expect(drained).toEqual({ purge: { tags: f.calls[0] }, ok: true });
  });

  it("issues one coarse asset:* call for more than 100, and retires only the 101 it read", async () => {
    const f = fake();
    for (let i = 0; i < 150; i++) {
      await queue(`ast_${String(i).padStart(3, "0")}`, {
        queuedAt: NOW + i,
        settleAt: NOW + i + 1,
      });
    }
    await drainAssetPurges(env.DB, f.capability, NOW + 10_000, logger);
    expect(f.calls).toEqual([["asset:*"]]);
    expect(await rows()).toHaveLength(150 - 101);
  });

  it("keeps every row, with attempts and last_error, when the purge is rate limited", async () => {
    const f = fake();
    f.mode.result = "refused";
    await queue("ast_a");
    await queue("ast_b");
    const drained = await drainAssetPurges(env.DB, f.capability, NOW + 20 * MIN, logger);
    expect(drained.ok).toBe(false);
    const after = await rows();
    expect(after.map((r) => [r.asset_id, r.purged_at, r.attempts])).toEqual([
      ["ast_a", null, 1],
      ["ast_b", null, 1],
    ]);
    expect(after[0]?.last_error).toContain("rate limited");
    expect((await pendingAssetPurges(env.DB, "default")).pending).toBe(2);
  });

  it("keeps every row when the call throws, and the next drain retries and retires them", async () => {
    const f = fake();
    f.mode.result = "throws";
    await queue("ast_a");
    const late = NOW + 20 * MIN;
    expect((await drainAssetPurges(env.DB, f.capability, late, logger)).ok).toBe(false);
    expect(await rows()).toMatchObject([{ asset_id: "ast_a", purged_at: null, attempts: 1 }]);
    expect((await rows())[0]?.last_error).toContain("purge exploded");

    f.mode.result = "ok";
    expect((await drainAssetPurges(env.DB, f.capability, late + 1000, logger)).ok).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(await rows()).toEqual([]);
  });

  it("stamps but keeps a row purged before settle_at, and retires it after", async () => {
    const f = fake();
    await queue("ast_a");
    await drainAssetPurges(env.DB, f.capability, NOW + MIN, logger);
    expect(await rows()).toMatchObject([{ asset_id: "ast_a", purged_at: NOW + MIN }]);
    // Purged once, but not yet after `settle_at`: still owed, and reported as such, so a
    // host with no cron is told the post-settle purge has not happened.
    expect((await pendingAssetPurges(env.DB, "default")).pending).toBe(1);

    // Inside its window a second drain spends nothing on it...
    await drainAssetPurges(env.DB, f.capability, NOW + 2 * MIN, logger);
    expect(f.calls).toHaveLength(1);
    // ...and the repeat after a write (`all`) does purge it again.
    await drainAssetPurges(env.DB, f.capability, NOW + 2 * MIN, logger, { all: true });
    expect(f.calls).toHaveLength(2);
    expect(await rows()).toHaveLength(1);

    // Past settle_at it is purged once more and retired by that success.
    await drainAssetPurges(env.DB, f.capability, NOW + 11 * MIN, logger);
    expect(f.calls).toHaveLength(3);
    expect(await rows()).toEqual([]);
    expect((await pendingAssetPurges(env.DB, "default")).pending).toBe(0);
  });

  it("a failure after settle_at does not retire a row", async () => {
    const f = fake();
    f.mode.result = "refused";
    await queue("ast_a");
    await drainAssetPurges(env.DB, f.capability, NOW + 11 * MIN, logger);
    expect(await rows()).toHaveLength(1);
  });

  it("issues nothing and keeps the rows without a capability", async () => {
    await queue("ast_a");
    const drained = await drainAssetPurges(env.DB, async () => null, NOW + 20 * MIN, logger);
    expect(drained).toEqual({ purge: null, ok: true });
    expect(await rows()).toMatchObject([{ asset_id: "ast_a", purged_at: null, attempts: 0 }]);
  });

  it("leaves a row re-queued while its purge was in flight unpurged, with its new window", async () => {
    const f = fake();
    await queue("ast_a", { queuedAt: NOW, settleAt: NOW + 1 });
    f.during = async () => {
      await env.DB.prepare(
        "update asset_purges set queued_at = ?, settle_at = ?, purged_at = null where asset_id = ?",
      )
        .bind(NOW + 5000, NOW + 5000 + 10 * MIN, "ast_a")
        .run();
    };
    await drainAssetPurges(env.DB, f.capability, NOW + 6000, logger);
    expect(await rows()).toMatchObject([{ asset_id: "ast_a", purged_at: null }]);
  });

  it("never throws into the write that ran it", async () => {
    const broken = {
      prepare() {
        throw new Error("d1 down");
      },
    } as never;
    expect(await drainAssetPurges(broken, fake().capability, NOW, logger)).toEqual({
      purge: null,
      ok: false,
    });
  });
});

describe("afterAccessChange", () => {
  const domain = { primitive: "string", public: "public" } as const;
  const hookCalls: AssetAccessChangedHookPayload<unknown>[] = [];
  const hooks = {
    async run(name: string, extra: unknown) {
      if (name === "assetAccessChanged")
        hookCalls.push(extra as AssetAccessChangedHookPayload<unknown>);
    },
  } as HookRunner<unknown>;
  const later: Promise<unknown>[] = [];
  const ctx = (f: Fake) => ({
    db: env.DB as never,
    capability: f.capability,
    logger,
    hooks,
    waitUntil: (p: Promise<unknown>) => void later.push(p),
    site: "default",
    actor: "usr_x",
  });
  const gating = () => {
    const g = newGating(domain);
    g.transitions.push({
      id: "ast_a",
      key: "ast_a-f.png",
      scope: "default",
      from: null,
      to: "members",
    });
    return g;
  };
  beforeEach(() => {
    hookCalls.length = 0;
    later.length = 0;
  });

  it("drains, repeats 25 seconds later under waitUntil, and tells the hook", async () => {
    const f = fake();
    await queue("ast_a");
    const slept: number[] = [];
    const out = await afterAccessChange(ctx(f), gating(), {
      now: NOW + 1000,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(out.pending).toBe(1);
    expect(out.purge).toEqual({ tags: ["asset:ast_a"] });
    await Promise.all(later);
    expect(slept).toEqual([SITE_PURGE_DELAY_MS]);
    // the drain, the repeat, and the best-effort lock tags
    expect(f.calls.filter((c) => c.includes("asset:ast_a")).length).toBeGreaterThanOrEqual(2);
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]).toMatchObject({ pending: 1, truncated: false, actor: "usr_x" });
    expect(hookCalls[0]?.purge).toEqual({ tags: ["asset:ast_a"] });
  });

  it("reports pending when the purge fails, and the row is retried by the next drain", async () => {
    const f = fake();
    f.mode.result = "refused";
    await queue("ast_a");
    const out = await afterAccessChange(ctx(f), gating(), { now: NOW + 1000 });
    expect(out.pending).toBe(1);
    expect(hookCalls[0]?.pending).toBe(1);
    f.mode.result = "ok";
    await drainAssetPurges(env.DB, f.capability, NOW + 11 * MIN, logger);
    expect(await rows()).toEqual([]);
  });

  it("a non-final bulk batch does not drain", async () => {
    const f = fake();
    await queue("ast_a");
    await afterAccessChange(ctx(f), gating(), { final: false, now: NOW });
    expect(f.calls).toEqual([]);
    expect(later).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ the cron --- */

const page = defineBlock({
  name: "apPage",
  label: "Page",
  summary: "title",
  fields: {
    title: text({ indexed: true }),
    access: select({
      options: [
        { label: "Everyone", value: "public" },
        { label: "Members", value: "members" },
      ],
      indexed: true,
    }),
    hero: asset(),
  },
  render: () => null,
});
const types: DocumentType[] = [
  { name: "apPage", label: "Page", kind: "page", root: "apPage", default: true },
];

function folioWith(capability: PurgeCapability, gated: boolean) {
  const config = {
    blocks: [page],
    types,
    bindings: (e: Cloudflare.Env) => ({
      db: e.DB,
      story: e.STORY,
      media: e.MEDIA,
      images: e.IMAGES,
    }),
    basePath: "/folio",
    auth: "open" as const,
    logger,
    assetPurgeCapability: capability,
    ...(gated
      ? {
          gate: {
            field: "access",
            public: "public",
            visitor: () => null,
            allows: () => false,
            allowsAsset: () => false,
          },
        }
      : {}),
  };
  return createFolio<Cloudflare.Env>(config as unknown as FolioConfig<Cloudflare.Env>);
}

describe("runSchedules' assetPurges pass", () => {
  it("drains the queue and reports it, and retires the row after settle_at", async () => {
    const f = fake();
    const folio = folioWith(f.capability, true);
    await queue("ast_a");
    const first = await folio.runSchedules(env, { now: NOW + MIN });
    expect(first.assetPurges).toEqual({ issued: { tags: ["asset:ast_a"] }, pending: 1 });
    expect(first.assetPurgesFailed).toBeUndefined();
    expect(await rows()).toHaveLength(1);

    const second = await folio.runSchedules(env, { now: NOW + 11 * MIN });
    expect(second.assetPurges?.issued).toEqual({ tags: ["asset:ast_a"] });
    expect(await rows()).toEqual([]);
  });

  it("flags a failed drain, keeps the row, and retries it on the next tick", async () => {
    const f = fake();
    f.mode.result = "refused";
    const folio = folioWith(f.capability, true);
    await queue("ast_a");
    const failed = await folio.runSchedules(env, { now: NOW + 11 * MIN });
    expect(failed.assetPurgesFailed).toBe(true);
    expect(failed.assetPurges?.pending).toBe(1);
    f.mode.result = "ok";
    const ok = await folio.runSchedules(env, { now: NOW + 12 * MIN });
    expect(ok.assetPurgesFailed).toBeUndefined();
    expect(await rows()).toEqual([]);
  });

  it("does nothing on a deployment that does not gate files", async () => {
    const f = fake();
    await queue("ast_a");
    const report = await folioWith(f.capability, false).runSchedules(env, { now: NOW + 11 * MIN });
    expect(report.assetPurges).toBeUndefined();
    expect(f.calls).toEqual([]);
  });
});
