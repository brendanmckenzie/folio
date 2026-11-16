import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AssetFilter } from "../../src/core/assets";
import type { BulkSelection } from "../../src/core/bulk";
import { runAssetBulk } from "../../src/server/asset-bulk";
import { newGating, presentAssetRows } from "../../src/server/asset-access";
import { createFolder, deleteFolder, updateFolder } from "../../src/server/asset-folders";
import {
  assetById,
  deleteAsset,
  listAssets,
  updateAsset,
  uploadAsset,
} from "../../src/server/assets";
import type { FolioDb } from "../../src/server/db";
import type { AssetAccessDomain } from "../../src/server/gate";

/**
 * Inheritance and the purge queue (`docs/specs/platform/asset-access.md` decisions 3, 4
 * and 10), against real D1. Every assertion reads `effective_access`, the one column the
 * route will read, so a stale one is the failure these are here to catch.
 */

const DOMAIN: AssetAccessDomain = {
  primitive: "string",
  public: "public",
  options: [
    { value: "public", label: "Everyone" },
    { value: "members", label: "Members" },
    { value: "premium", label: "Premium" },
  ],
};
const gating = () => newGating(DOMAIN);

let minted = 0;
async function seedAsset(folderId: string | null = null): Promise<string> {
  minted += 1;
  const id = `ast_a${String(minted).padStart(9, "0")}`;
  await env.DB.prepare(
    `insert into assets (id, key, filename, content_type, size, created_at, folder_id, effective_access)
     values (?, ?, ?, 'image/png', 1, ?, ?, (select effective_access from asset_folders where id = ?))`,
  )
    .bind(id, `${id}-f.png`, `${id}.png`, 1_700_000_000_000 + minted, folderId, folderId)
    .run();
  return id;
}

const eff = async (table: "assets" | "asset_folders", id: string): Promise<string | null> =>
  (
    await env.DB.prepare(`select effective_access as e from ${table} where id = ?`)
      .bind(id)
      .first<{ e: string | null }>()
  )?.e ?? null;
const own = async (table: "assets" | "asset_folders", id: string): Promise<string | null> =>
  (
    await env.DB.prepare(`select access as a from ${table} where id = ?`)
      .bind(id)
      .first<{ a: string | null }>()
  )?.a ?? null;
const queued = async (): Promise<string[]> =>
  (
    await env.DB.prepare("select asset_id from asset_purges order by asset_id").all<{
      asset_id: string;
    }>()
  ).results.map((r) => r.asset_id);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from asset_purges"),
    env.DB.prepare("delete from asset_folders"),
    env.DB.prepare("delete from assets"),
  ]);
});

describe("folder inheritance", () => {
  it("flows through three levels, and a nearer own value overrides a farther one", async () => {
    const a = await createFolder(env.DB, { name: "A", access: "members" });
    const b = await createFolder(env.DB, { name: "B", parentId: a.id });
    const c = await createFolder(env.DB, { name: "C", parentId: b.id });
    expect(await eff("asset_folders", c.id)).toBe('"members"');
    const f = await seedAsset(c.id);
    expect(await eff("assets", f)).toBe('"members"');

    await updateFolder(env.DB, b.id, { access: "premium" });
    expect(await eff("asset_folders", c.id)).toBe('"premium"');
    expect(await eff("assets", f)).toBe('"premium"');
    expect(await eff("asset_folders", a.id)).toBe('"members"');

    // A file's own value beats every folder; null puts it back.
    await updateAsset(env.DB, f, { access: "public" });
    expect(await eff("assets", f)).toBe('"public"');
    await updateAsset(env.DB, f, { access: null });
    expect(await eff("assets", f)).toBe('"premium"');

    // Clearing a folder's own value inherits again.
    await updateFolder(env.DB, b.id, { access: null });
    expect(await eff("assets", f)).toBe('"members"');
  });

  it("recomputes on rename and on folder move", async () => {
    const gated = await createFolder(env.DB, { name: "Gated", access: "members" });
    const open = await createFolder(env.DB, { name: "Open" });
    const child = await createFolder(env.DB, { name: "Child", parentId: open.id });
    const f = await seedAsset(child.id);
    expect(await eff("assets", f)).toBeNull();

    await updateFolder(env.DB, child.id, { parentId: gated.id });
    expect(await eff("asset_folders", child.id)).toBe('"members"');
    expect(await eff("assets", f)).toBe('"members"');
    await updateFolder(env.DB, child.id, { name: "Renamed" });
    expect(await eff("assets", f)).toBe('"members"');
    await updateFolder(env.DB, child.id, { parentId: null });
    expect(await eff("assets", f)).toBeNull();
  });
});

describe("moving a file", () => {
  it("takes the destination's value in one PATCH, into and out of a gated folder", async () => {
    const gated = await createFolder(env.DB, { name: "Gated", access: "members" });
    const f = await seedAsset();
    expect(await eff("assets", f)).toBeNull();
    // The before-image trap: the recompute must read the destination, not the folder left.
    await updateAsset(env.DB, f, { folderId: gated.id });
    expect(await eff("assets", f)).toBe('"members"');
    await updateAsset(env.DB, f, { folderId: null });
    expect(await eff("assets", f)).toBeNull();
    await updateAsset(env.DB, f, { folderId: gated.id });
    expect(await eff("assets", f)).toBe('"members"');
  });
});

describe("deleting a folder never opens a file", () => {
  it("materialises inherited values so no effective value changes", async () => {
    const a = await createFolder(env.DB, { name: "A", access: "members" });
    const b = await createFolder(env.DB, { name: "B", parentId: a.id });
    const pub = await createFolder(env.DB, { name: "Pub", parentId: a.id, access: "public" });
    const inA = await seedAsset(a.id);
    const inB = await seedAsset(b.id);
    const own1 = await seedAsset(a.id);
    await updateAsset(env.DB, own1, { access: "premium" });

    await deleteFolder(env.DB, a.id);
    expect(await own("asset_folders", b.id)).toBe('"members"');
    expect(await own("asset_folders", pub.id)).toBe('"public"');
    expect(await own("assets", inA)).toBe('"members"');
    expect(await own("assets", own1)).toBe('"premium"');
    expect(await eff("assets", inA)).toBe('"members"');
    expect(await eff("assets", inB)).toBe('"members"');
    expect(await eff("assets", own1)).toBe('"premium"');
    expect(await eff("asset_folders", pub.id)).toBe('"public"');
    expect(await queued()).toEqual([]);
  });
});

describe("concurrent edits converge", () => {
  for (const order of ["gate first", "move first"] as const) {
    it(`gating A while public C moves under it, ${order}`, async () => {
      const a = await createFolder(env.DB, { name: "A" });
      const c = await createFolder(env.DB, { name: "C" });
      const f = await seedAsset(c.id);
      const gate = () => updateFolder(env.DB, a.id, { access: "members" });
      const move = () => updateFolder(env.DB, c.id, { parentId: a.id });
      if (order === "gate first") {
        await gate();
        await move();
      } else {
        await move();
        await gate();
      }
      expect(await eff("asset_folders", c.id)).toBe('"members"');
      expect(await eff("assets", f)).toBe('"members"');
    });
  }
});

describe("fixed binds", () => {
  it("gates a 600-file folder in one write", async () => {
    const a = await createFolder(env.DB, { name: "Big" });
    const rows: D1PreparedStatement[] = [];
    for (let i = 0; i < 600; i++) {
      rows.push(
        env.DB.prepare(
          `insert into assets (id, key, filename, content_type, size, created_at, folder_id)
           values (?, ?, 'f.png', 'image/png', 1, 1, ?)`,
        ).bind(
          `ast_b${String(i).padStart(9, "0")}`,
          `ast_b${String(i).padStart(9, "0")}-f.png`,
          a.id,
        ),
      );
    }
    for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50));
    const g = gating();
    await updateFolder(env.DB, a.id, { access: "members" }, "default", g);
    const n = await env.DB.prepare(
      "select count(*) as n from assets where effective_access = '\"members\"'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(600);
    // Every one was public and is now gated: all 600 are owed a purge, though the
    // hook payload stops at 500.
    expect((await queued()).length).toBe(600);
    expect(g.transitions).toHaveLength(500);
    expect(g.truncated).toBe(true);
  });
});

describe("bulk", () => {
  const deps = (g = gating()) => ({ db: env.DB as FolioDb, media: env.MEDIA, gating: g });

  it("moves with the destination's value and queues what it gates", async () => {
    const gated = await createFolder(env.DB, { name: "Gated", access: "members" });
    const x = await seedAsset();
    const y = await seedAsset();
    const g = gating();
    const out = await runAssetBulk(deps(g), "move", { ids: [x, y] }, { folderId: gated.id });
    expect("refused" in out).toBe(false);
    expect(await eff("assets", x)).toBe('"members"');
    expect(await queued()).toEqual([x, y].sort());
    expect(g.transitions.map((t) => [t.from, t.to])).toEqual([
      [null, "members"],
      [null, "members"],
    ]);
  });

  it("sets access over a selection, validated once before the walk", async () => {
    const x = await seedAsset();
    await runAssetBulk(deps(), "access", { ids: [x] }, { access: "premium" });
    expect(await own("assets", x)).toBe('"premium"');
    expect(await eff("assets", x)).toBe('"premium"');
    await expect(runAssetBulk(deps(), "access", { ids: [x] }, { access: "bogus" })).rejects.toThrow(
      /access must be/,
    );
    await expect(
      runAssetBulk({ db: env.DB as FolioDb }, "access", { ids: [x] }, { access: "members" }),
    ).rejects.toThrow(/does not gate files/);
  });

  it("filters a captured select-all by gated", async () => {
    const gated = await createFolder(env.DB, { name: "Gated", access: "members" });
    const x = await seedAsset(gated.id);
    await seedAsset();
    const selection: BulkSelection<AssetFilter> = {
      all: true,
      filter: { gated: true },
      expected: 1,
    };
    const out = await runAssetBulk(deps(), "access", selection, { access: "premium" });
    expect("refused" in out).toBe(false);
    expect(await eff("assets", x)).toBe('"premium"');
  });
});

describe("the gated filter", () => {
  it("lists effective non-public files, and is refused where files are not gated", async () => {
    const gated = await createFolder(env.DB, { name: "Gated", access: "members" });
    const x = await seedAsset(gated.id);
    const y = await seedAsset();
    await updateAsset(env.DB, y, { access: "public" });
    const page = await listAssets(env.DB, { gated: true, accessPublic: "public" });
    expect(page.rows.map((r) => r.id)).toEqual([x]);
    await expect(listAssets(env.DB, { gated: true })).rejects.toThrow(/does not gate files/);
  });
});

describe("upload", () => {
  it("files into a folder and is gated in the one insert", async () => {
    const gated = await createFolder(env.DB, { name: "Gated", access: "members" });
    const row = await uploadAsset(env.DB, env.MEDIA, {
      bytes: new Uint8Array([1, 2, 3]).buffer,
      filename: "a.bin",
      folderId: gated.id,
    });
    expect(row.folderId).toBe(gated.id);
    expect(await eff("assets", row.id)).toBe('"members"');
    const own2 = await uploadAsset(env.DB, env.MEDIA, {
      bytes: new Uint8Array([1, 2, 3]).buffer,
      filename: "b.bin",
      access: "premium",
    });
    expect(await eff("assets", own2.id)).toBe('"premium"');
    await expect(
      uploadAsset(env.DB, env.MEDIA, {
        bytes: new Uint8Array([1]).buffer,
        filename: "c.bin",
        folderId: "fld_nope",
      }),
    ).rejects.toThrow(/Unknown folder/);
  });

  it("an unfiled upload with no access is untouched", async () => {
    const row = await uploadAsset(env.DB, env.MEDIA, {
      bytes: new Uint8Array([1, 2, 3]).buffer,
      filename: "d.bin",
    });
    expect(await eff("assets", row.id)).toBeNull();
    expect(await own("assets", row.id)).toBeNull();
  });
});

/** A `FolioDb` that records the SQL of each statement in each `batch`. */
function recording() {
  const batches: string[][] = [];
  const sqlOf = new WeakMap<object, string>();
  const db: FolioDb = {
    prepare(sql: string) {
      const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(stmt, {
          get(t, k) {
            if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
            const v = (t as never)[k] as unknown;
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        });
        sqlOf.set(proxy, sql);
        real.set(proxy, stmt);
        return proxy;
      };
      return wrap(env.DB.prepare(sql));
    },
    batch(stmts) {
      batches.push(stmts.map((s) => sqlOf.get(s) ?? "?"));
      return env.DB.batch(stmts.map((s) => real.get(s) ?? s));
    },
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  return { db, batches };
}

describe("the purge queue", () => {
  it("is written in the same batch as the transition, only for public to gated", async () => {
    const x = await seedAsset();
    const rec = recording();
    const g = gating();
    await updateAsset(rec.db, x, { access: "members" }, "default", g);
    const batch = rec.batches.find((b) => b.some((s) => s.startsWith("update assets set")));
    expect(batch?.some((s) => s.includes("insert into asset_purges"))).toBe(true);
    expect(await queued()).toEqual([x]);
    const row = await env.DB.prepare(
      "select queued_at, settle_at, purged_at from asset_purges",
    ).first<{
      queued_at: number;
      settle_at: number;
      purged_at: number | null;
    }>();
    expect(row?.settle_at).toBe((row?.queued_at ?? 0) + 10 * 60 * 1000);
    expect(row?.purged_at).toBeNull();
    expect(g.transitions).toEqual([
      expect.objectContaining({ id: x, scope: "default", from: null, to: "members" }),
    ]);

    // gated to gated, and gated to public, queue nothing new.
    await env.DB.prepare("delete from asset_purges").run();
    await updateAsset(env.DB, x, { access: "premium" }, "default", gating());
    await updateAsset(env.DB, x, { access: "public" }, "default", gating());
    expect(await queued()).toEqual([]);
  });

  it("re-queues by moving settle_at forward, and deleting the file deletes the row", async () => {
    const x = await seedAsset();
    await updateAsset(env.DB, x, { access: "members" }, "default", gating());
    await env.DB.prepare("update asset_purges set purged_at = 5, settle_at = 1").run();
    await updateAsset(env.DB, x, { access: null }, "default", gating());
    await updateAsset(env.DB, x, { access: "members" }, "default", gating());
    const row = await env.DB.prepare("select settle_at, purged_at from asset_purges").first<{
      settle_at: number;
      purged_at: number | null;
    }>();
    expect(row?.purged_at).toBeNull();
    expect(row?.settle_at).toBeGreaterThan(1000);
    const media = env.MEDIA;
    const real = await uploadAsset(env.DB, media, {
      bytes: new Uint8Array([9]).buffer,
      filename: "z.bin",
    });
    await updateAsset(env.DB, real.id, { access: "members" }, "default", gating());
    expect(await queued()).toContain(real.id);
    await deleteAsset(env.DB, media, real.id);
    expect(await queued()).not.toContain(real.id);
    expect(await assetById(env.DB, real.id)).toBeNull();
  });

  it("queues nothing and records nothing without a gating context", async () => {
    const gated = await createFolder(env.DB, { name: "Gated", access: "members" });
    const x = await seedAsset();
    await updateAsset(env.DB, x, { folderId: gated.id });
    expect(await eff("assets", x)).toBe('"members"');
    expect(await queued()).toEqual([]);
  });
});

describe("presentAssetRows", () => {
  it("returns rows untouched and reads nothing with no domain", async () => {
    const x = await seedAsset();
    const rec = recording();
    const rows = [{ id: x }];
    expect(await presentAssetRows(rec.db, rows, null)).toBe(rows);
    expect(rec.batches).toEqual([]);
  });

  it("merges the decoded own and effective values with a domain", async () => {
    const gated = await createFolder(env.DB, { name: "Gated", access: "members" });
    const x = await seedAsset(gated.id);
    const y = await seedAsset();
    const out = await presentAssetRows(env.DB, [{ id: x }, { id: y }], DOMAIN);
    expect(out).toEqual([
      { id: x, access: null, effectiveAccess: "members" },
      { id: y, access: null, effectiveAccess: null },
    ]);
  });
});
