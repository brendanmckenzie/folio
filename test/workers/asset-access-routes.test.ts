import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asset, defineBlock, select, text } from "../../src/core";
import type { DocumentType } from "../../src/core/schema";
import type { FolioConfig } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { SECURE_COOKIE } from "../../src/server/auth/cookie";
import { createSession } from "../../src/server/auth/session";
import { createUser } from "../../src/server/auth/users";
import type { PurgeCapability } from "../../src/server/cache-purge";
import type { AssetAccessChangedHookPayload } from "../../src/server/hooks";

/**
 * The routes that set, read and filter asset access
 * (`docs/specs/platform/asset-access.md` phase 6): the admin's, `{base}/api/v1`'s and the
 * fence each draws. Real D1 and R2 with an injected purge capability, because Workers
 * Cache is not simulated: the failures are the half that matters, since a purge that
 * fails must be reported and retried rather than lost.
 */

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (ch) => ch.charCodeAt(0),
);

const page = defineBlock({
  name: "arrPage",
  label: "Page",
  summary: "title",
  fields: {
    title: text({ indexed: true }),
    access: select({
      options: [
        { label: "Everyone", value: "public" },
        { label: "Members", value: "members" },
        { label: "Premium", value: "premium" },
      ],
      indexed: true,
    }),
    hero: asset(),
  },
  render: () => null,
});
const types: DocumentType[] = [
  { name: "arrPage", label: "Page", kind: "page", root: "arrPage", default: true },
];

const MIN = 60_000;

/** A purge capability that records each call and answers as told. */
const purges = {
  calls: [] as string[][],
  result: "ok" as "ok" | "refused",
};
const capability: PurgeCapability = async () => async (options) => {
  purges.calls.push([...((options as { tags?: string[] }).tags ?? ["<everything>"])]);
  return (purges.result === "ok"
    ? { success: true, errors: [] }
    : {
        success: false,
        errors: [{ code: 429, message: "rate limited" }],
      }) as unknown as CachePurgeResult;
};

const logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  log() {},
} as unknown as Console;

const hookEvents: AssetAccessChangedHookPayload<Cloudflare.Env>[] = [];
let describeCalls = 0;

const gate = {
  field: "access",
  public: "public",
  visitor: () => null,
  allows: () => false,
  allowsAsset: () => false,
};

function config(gated: boolean, extra: object = {}): FolioConfig<Cloudflare.Env> {
  return {
    blocks: [page],
    types,
    bindings: (e: Cloudflare.Env) => ({
      db: e.DB,
      story: e.STORY,
      media: e.MEDIA,
      images: e.IMAGES,
    }),
    basePath: "/folio",
    assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
    auth: "open",
    route: (p: string) => (p ? `/${p}` : "/"),
    logger,
    assetPurgeCapability: capability,
    describe: {
      fn: async () => {
        describeCalls++;
        return { alt: "A picture" };
      },
    },
    hooks: {
      assetAccessChanged: (e: AssetAccessChangedHookPayload<Cloudflare.Env>) => {
        hookEvents.push(e);
      },
      await: ["assetAccessChanged"],
    },
    ...(gated ? { gate } : {}),
    ...extra,
  } as unknown as FolioConfig<Cloudflare.Env>;
}

const gated = createFolio<Cloudflare.Env>(config(true));
const plain = createFolio<Cloudflare.Env>(config(false));

/** The ExecutionContext of one request, with the promises it was handed to wait on. */
function context() {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, waits };
}

async function call(
  folio: typeof gated,
  path: string,
  init: RequestInit & { json?: unknown; cookie?: string; origin?: string } = {},
): Promise<{ res: Response; waits: Promise<unknown>[] }> {
  const { ctx, waits } = context();
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const res = await folio.handle(
    new Request(`${init.origin ?? "https://example.com"}/folio${path}`, {
      ...init,
      headers,
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    }),
    env,
    ctx,
  );
  if (!res) throw new Error(`handle() answered null for ${path}`);
  return { res, waits };
}

async function json<T = Record<string, unknown>>(
  folio: typeof gated,
  path: string,
  init: Parameters<typeof call>[2] = {},
): Promise<{ status: number; body: T }> {
  const { res } = await call(folio, path, init);
  return { status: res.status, body: (await res.json()) as T };
}

let n = 0;
async function seed(
  opts: { site?: string; access?: string | null; effective?: string | null; folder?: string } = {},
): Promise<{ id: string; key: string }> {
  n += 1;
  const id = `ast_${(0xc00000 + n).toString(16).padStart(12, "0")}`;
  const key = `${id}-pic.png`;
  await env.MEDIA.put(key, PNG, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare(
    `insert into assets (id, key, filename, content_type, size, created_at, site_id, folder_id,
                         access, effective_access)
     values (?, ?, 'pic.png', 'image/png', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      key,
      PNG.byteLength,
      1_700_000_000_000 + n,
      opts.site ?? "default",
      opts.folder ?? null,
      opts.access === undefined || opts.access === null ? null : JSON.stringify(opts.access),
      opts.effective ?? (opts.access ? JSON.stringify(opts.access) : null),
    )
    .run();
  return { id, key };
}

const stored = async (id: string) =>
  env.DB.prepare("select access, effective_access as effective from assets where id = ?")
    .bind(id)
    .first<{ access: string | null; effective: string | null }>();
const queued = async () =>
  (await env.DB.prepare("select asset_id, purged_at from asset_purges order by asset_id").all())
    .results as { asset_id: string; purged_at: number | null }[];

beforeEach(async () => {
  purges.calls.length = 0;
  purges.result = "ok";
  hookEvents.length = 0;
  describeCalls = 0;
  await env.DB.batch([
    env.DB.prepare("delete from asset_purges"),
    env.DB.prepare("delete from asset_taggings"),
    env.DB.prepare("delete from asset_folders"),
    env.DB.prepare("delete from assets"),
  ]);
});

/* -------------------------------------------------------------- the admin --- */

describe("PATCH /api/assets/:id with access", () => {
  it("sets a value, answers the row with both fields, and queues and issues the purge", async () => {
    const f = await seed();
    const { status, body } = await json(gated, `/api/assets/${f.id}`, {
      method: "PATCH",
      json: { access: "members" },
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: f.id,
      access: "members",
      effectiveAccess: "members",
      purge: { pending: 0 },
    });
    expect(await stored(f.id)).toEqual({ access: '"members"', effective: '"members"' });
    expect(purges.calls[0]).toContain(`asset:${f.id}`);
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]?.assets).toEqual([
      { id: f.id, key: f.key, scope: "default", from: null, to: "members" },
    ]);
  });

  it("answers pending when the purge fails, and the row survives for a retry", async () => {
    purges.result = "refused";
    const f = await seed();
    const { body } = await json(gated, `/api/assets/${f.id}`, {
      method: "PATCH",
      json: { access: "premium" },
    });
    expect(body.purge).toEqual({ pending: 1 });
    expect(await queued()).toEqual([{ asset_id: f.id, purged_at: null }]);

    const notice = await json(gated, "/api/assets/purges");
    expect(notice.status).toBe(200);
    expect(notice.body).toMatchObject({ pending: 1 });
    expect(typeof notice.body.oldest).toBe("number");

    // The cron retires it once the capability answers and settle_at has passed.
    purges.result = "ok";
    const report = await gated.runSchedules(env, { now: Date.now() + 11 * MIN });
    expect(report.assetPurges?.pending).toBe(0);
    expect(await queued()).toEqual([]);
    expect((await json(gated, "/api/assets/purges")).body).toMatchObject({ pending: 0 });
  });

  it("inherits on null, and leaves access alone when it is absent", async () => {
    const folder = await json<{ id: string }>(gated, "/api/assets/folders", {
      method: "POST",
      json: { name: "Reports", access: "members" },
    });
    const f = await seed({ access: "premium", folder: folder.body.id });
    const keep = await json(gated, `/api/assets/${f.id}`, {
      method: "PATCH",
      json: { alt: "kept" },
    });
    expect(keep.body).toMatchObject({ access: "premium", effectiveAccess: "premium" });
    const inherit = await json(gated, `/api/assets/${f.id}`, {
      method: "PATCH",
      json: { access: null },
    });
    expect(inherit.body).toMatchObject({ access: null, effectiveAccess: "members" });
  });

  it("refuses an unknown option, a wrong primitive and a non-scalar, writing nothing", async () => {
    const f = await seed();
    for (const access of ["bogus", 5, true, "x".repeat(300)]) {
      const { status, body } = await json<{ error: { code: string; message: string } }>(
        gated,
        `/api/assets/${f.id}`,
        { method: "PATCH", json: { access } },
      );
      expect([access, status, body.error.code]).toEqual([access, 400, "bad_request"]);
    }
    const bad = await json<{ error: { message: string } }>(gated, `/api/assets/${f.id}`, {
      method: "PATCH",
      json: { access: "bogus" },
    });
    expect(bad.body.error.message).toMatch(/"members"/);
    expect(await stored(f.id)).toEqual({ access: null, effective: null });
    expect(await queued()).toEqual([]);
    expect(purges.calls).toEqual([]);
  });

  it("is refused on a deployment that does not gate files, and answers no access keys", async () => {
    const f = await seed();
    for (const access of ["members", null]) {
      const { status, body } = await json<{ error: { code: string; message: string } }>(
        plain,
        `/api/assets/${f.id}`,
        { method: "PATCH", json: { access } },
      );
      expect(status).toBe(501);
      expect(body.error).toMatchObject({
        code: "unsupported",
        message: "This site does not gate files",
      });
    }
    const row = await json(plain, `/api/assets/${f.id}`, { method: "PATCH", json: { alt: "a" } });
    expect(row.status).toBe(200);
    expect(Object.keys(row.body)).not.toContain("access");
    expect(Object.keys(row.body)).not.toContain("effectiveAccess");
    expect(Object.keys(row.body)).not.toContain("purge");
  });
});

describe("rows and the gated filter", () => {
  it("adds access and effectiveAccess to the list and the single row, only when gating", async () => {
    const open = await seed();
    const locked = await seed({ access: "members" });
    const list = await json<{ rows: { id: string; access: unknown; effectiveAccess: unknown }[] }>(
      gated,
      "/api/assets",
    );
    const byId = Object.fromEntries(list.body.rows.map((r) => [r.id, r]));
    expect(byId[open.id]).toMatchObject({ access: null, effectiveAccess: null });
    expect(byId[locked.id]).toMatchObject({ access: "members", effectiveAccess: "members" });
    const one = await json(gated, `/api/assets/${locked.id}`);
    expect(one.body).toMatchObject({ access: "members", effectiveAccess: "members" });

    const plainList = await json<{ rows: Record<string, unknown>[] }>(plain, "/api/assets");
    for (const row of plainList.body.rows) {
      expect(Object.keys(row)).not.toContain("access");
      expect(Object.keys(row)).not.toContain("effectiveAccess");
    }
  });

  it("filters to gated files with ?gated=1, and a file with the public value is not one", async () => {
    await seed();
    const publicValue = await seed({ access: "public" });
    const locked = await seed({ access: "premium" });
    const list = await json<{ rows: { id: string }[] }>(gated, "/api/assets?gated=1");
    expect(list.body.rows.map((r) => r.id)).toEqual([locked.id]);
    expect(list.body.rows.map((r) => r.id)).not.toContain(publicValue.id);
  });

  it("refuses ?gated=1 on a deployment that does not gate files", async () => {
    const { status, body } = await json<{ error: { code: string } }>(plain, "/api/assets?gated=1");
    expect([status, body.error.code]).toEqual([501, "unsupported"]);
  });

  it("presents the row the describe route answers", async () => {
    const f = await seed({ access: "members" });
    const { status, body } = await json<{ asset: Record<string, unknown> }>(
      gated,
      `/api/assets/${f.id}/describe`,
      { method: "POST", json: {} },
    );
    expect(status).toBe(200);
    expect(describeCalls).toBe(1);
    expect(body.asset).toMatchObject({ altAuto: "A picture", access: "members" });
    expect(body.asset.effectiveAccess).toBe("members");
  });
});

describe("GET /api/assets/access", () => {
  it("answers { key: value } for gated keys only, public and unknown keys absent", async () => {
    const locked = await seed({ access: "members" });
    const open = await seed();
    const explicitPublic = await seed({ access: "public" });
    const { status, body } = await json(
      gated,
      `/api/assets/access?key=${locked.key}&key=${open.key}&key=${explicitPublic.key}&key=ast_000000000000-nope.png`,
    );
    expect(status).toBe(200);
    expect(body).toEqual({ [locked.key]: "members" });
  });

  it("is not read as an asset id, refuses a malformed key, and is unsupported without gating", async () => {
    expect((await json(gated, "/api/assets/access")).body).toEqual({});
    expect((await json(gated, "/api/assets/access?key=../etc/passwd")).status).toBe(400);
    expect((await json(plain, "/api/assets/access")).status).toBe(501);
    expect((await json(plain, "/api/assets/purges")).status).toBe(501);
  });
});

describe("POST /api/assets/purge-all", () => {
  it("issues one purgeEverything, and answers ok false when there is nothing to call", async () => {
    const ok = await json(plain, "/api/assets/purge-all", { method: "POST", json: {} });
    expect(ok.body).toEqual({ ok: true });
    expect(purges.calls).toEqual([["<everything>"]]);
    purges.result = "refused";
    expect((await json(plain, "/api/assets/purge-all", { method: "POST", json: {} })).body).toEqual(
      { ok: false },
    );
    const noCapability = createFolio<Cloudflare.Env>(
      config(false, { assetPurgeCapability: undefined }),
    );
    expect(
      (await json(noCapability, "/api/assets/purge-all", { method: "POST", json: {} })).body,
    ).toEqual({ ok: false });
  });
});

describe("uploads", () => {
  const upload = (folio: typeof gated, query: string) =>
    json<{ asset: Record<string, unknown>; value: unknown }>(
      folio,
      `/api/assets?filename=pic.png${query}`,
      { method: "POST", body: PNG, headers: { "content-type": "image/png" } },
    );

  it("stores ?access= with the file, gated from its first byte", async () => {
    const { status, body } = await upload(gated, "&access=members");
    expect(status).toBe(201);
    expect(body.asset).toMatchObject({ access: "members", effectiveAccess: "members" });
    expect(await stored(body.asset.id as string)).toEqual({
      access: '"members"',
      effective: '"members"',
    });
    // A new file was never public, so nothing is owed to the edge.
    expect(await queued()).toEqual([]);
  });

  it("files the upload in ?folderId= and inherits that folder's value", async () => {
    const folder = await json<{ id: string }>(gated, "/api/assets/folders", {
      method: "POST",
      json: { name: "Members", access: "premium" },
    });
    const { body } = await upload(gated, `&folderId=${folder.body.id}`);
    expect(body.asset).toMatchObject({
      folderId: folder.body.id,
      access: null,
      effectiveAccess: "premium",
    });
    const unknown = await upload(gated, "&folderId=fld_000000000000");
    expect(unknown.status).toBe(400);
  });

  it("refuses a bad ?access= before writing the object or the row", async () => {
    const before = (await env.MEDIA.list()).objects.length;
    const bad = await upload(gated, "&access=bogus");
    expect(bad.status).toBe(400);
    expect((await env.MEDIA.list()).objects.length).toBe(before);
    expect(
      (await env.DB.prepare("select count(*) as n from assets").first<{ n: number }>())?.n,
    ).toBe(0);
    const ungated = await upload(plain, "&access=members");
    expect(ungated.status).toBe(501);
    expect((await env.MEDIA.list()).objects.length).toBe(before);
  });
});

describe("folders", () => {
  it("sets access on create and patch, presents both values, and cascades to the files", async () => {
    const created = await json<{ id: string; access: unknown; effectiveAccess: unknown }>(
      gated,
      "/api/assets/folders",
      { method: "POST", json: { name: "Reports", access: "members" } },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ access: "members", effectiveAccess: "members" });
    const f = await seed({ folder: created.body.id, effective: '"members"' });

    const patched = await json(gated, `/api/assets/folders/${created.body.id}`, {
      method: "PATCH",
      json: { access: "premium" },
    });
    expect(patched.body).toMatchObject({ access: "premium", effectiveAccess: "premium" });
    expect((await stored(f.id))?.effective).toBe('"premium"');

    const listed = await json<{ rows: { id: string; access: unknown }[] }>(
      gated,
      "/api/assets/folders",
    );
    expect(listed.body.rows[0]).toMatchObject({ id: created.body.id, access: "premium" });

    const refused = await json(gated, `/api/assets/folders/${created.body.id}`, {
      method: "PATCH",
      json: { access: "bogus" },
    });
    expect(refused.status).toBe(400);
    expect((await stored(f.id))?.effective).toBe('"premium"');
  });

  it("refuses access on a deployment that does not gate files, and lists plain folders", async () => {
    const refused = await json(plain, "/api/assets/folders", {
      method: "POST",
      json: { name: "Reports", access: "members" },
    });
    expect(refused.status).toBe(501);
    const created = await json<Record<string, unknown>>(plain, "/api/assets/folders", {
      method: "POST",
      json: { name: "Reports" },
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body)).not.toContain("access");
  });
});

describe("POST /api/assets/bulk/access", () => {
  it("sets a selection, validated once before any row is touched", async () => {
    const a = await seed();
    const b = await seed();
    const bad = await json(gated, "/api/assets/bulk/access", {
      method: "POST",
      json: { selection: { ids: [a.id, b.id] }, access: "bogus" },
    });
    expect(bad.status).toBe(400);
    expect((await stored(a.id))?.effective).toBeNull();

    const dry = await json(gated, "/api/assets/bulk/access", {
      method: "POST",
      json: { selection: { ids: [a.id, b.id] }, access: "members", dryRun: true },
    });
    expect(dry.status).toBe(200);
    expect(Object.keys(dry.body)).not.toContain("purge");
    expect((await stored(a.id))?.effective).toBeNull();

    const done = await json(gated, "/api/assets/bulk/access", {
      method: "POST",
      json: { selection: { ids: [a.id, b.id] }, access: "members" },
    });
    expect(done.body).toMatchObject({ action: "access", done: 2, continueFrom: null });
    expect(done.body.purge).toEqual({ pending: 0 });
    expect((await stored(b.id))?.effective).toBe('"members"');
    expect(purges.calls).toHaveLength(1);
    expect(purges.calls[0]).toEqual(expect.arrayContaining([`asset:${a.id}`, `asset:${b.id}`]));
  });

  it("is unsupported without asset gating", async () => {
    const a = await seed();
    const res = await json(plain, "/api/assets/bulk/access", {
      method: "POST",
      json: { selection: { ids: [a.id] }, access: "members" },
    });
    expect(res.status).toBe(501);
  });

  it("walks 40 batches, queueing every batch and draining only on the last", async () => {
    const files = [];
    for (let i = 0; i < 40; i++) files.push(await seed());
    const ids = files.map((f) => f.id);
    let continueFrom: string | null = null;
    let batches = 0;
    let scheduledRepeats = 0;
    do {
      const { res, waits } = await call(gated, "/api/assets/bulk/access", {
        method: "POST",
        json: {
          selection: { ids },
          access: "members",
          batch: 1,
          ...(continueFrom ? { continueFrom } : {}),
        },
      });
      const body = (await res.json()) as { continueFrom: string | null };
      expect(res.status).toBe(200);
      batches += 1;
      continueFrom = body.continueFrom;
      scheduledRepeats += waits.length;
      // Not final: every row queued so far, and nothing issued.
      if (continueFrom !== null) expect(purges.calls).toEqual([]);
    } while (continueFrom !== null);
    expect(batches).toBe(40);
    expect(await queued()).toHaveLength(40);
    // One drain now (a single `asset:<id>` call over all 40 rows, which is under the
    // 100-tag cap) and one repeat scheduled under `waitUntil`: two purge calls, not eighty.
    expect(purges.calls).toHaveLength(1);
    expect(purges.calls[0]).toHaveLength(40);
    expect(scheduledRepeats).toBe(1);
  });
});

/* ----------------------------------------------------------------- v1 API --- */

describe("{base}/api/v1/assets", () => {
  it("PATCH sets and clears access, answering the row and the pending count", async () => {
    const f = await seed();
    const set = await json(gated, `/api/v1/assets/${f.id}`, {
      method: "PATCH",
      json: { access: "members", alt: "Hello" },
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      id: f.id,
      alt: "Hello",
      access: "members",
      effectiveAccess: "members",
      purge: { pending: 0 },
    });
    const clear = await json(gated, `/api/v1/assets/${f.id}`, {
      method: "PATCH",
      json: { access: null },
    });
    expect(clear.body).toMatchObject({ access: null, effectiveAccess: null });
  });

  it("validates, refuses admin-only fields rather than ignoring them, and 404s an unknown id", async () => {
    const f = await seed();
    const patch = (json_: unknown, id = f.id) =>
      json<{ error: { code: string } }>(gated, `/api/v1/assets/${id}`, {
        method: "PATCH",
        json: json_,
      });
    expect((await patch({ access: "bogus" })).status).toBe(400);
    expect((await patch({ folderId: "fld_000000000000" })).status).toBe(400);
    expect((await patch({ tags: [] })).status).toBe(400);
    expect((await patch({ alt: "x" }, "ast_000000000000")).status).toBe(404);
    expect(await stored(f.id)).toEqual({ access: null, effective: null });
    const ungated = await json(plain, `/api/v1/assets/${f.id}`, {
      method: "PATCH",
      json: { access: "members" },
    });
    expect(ungated.status).toBe(501);
  });

  it("POST ?access= stores the value, and the list carries both fields", async () => {
    const up = await json<{ asset: { id: string }; value: unknown }>(
      gated,
      "/api/v1/assets?filename=pic.png&access=members",
      { method: "POST", body: PNG, headers: { "content-type": "image/png" } },
    );
    expect(up.status).toBe(201);
    expect(await stored(up.body.asset.id)).toEqual({ access: '"members"', effective: '"members"' });
    const bad = await json(gated, "/api/v1/assets?filename=pic.png&access=bogus", {
      method: "POST",
      body: PNG,
    });
    expect(bad.status).toBe(400);
    const list = await json<{ assets: Record<string, unknown>[] }>(gated, "/api/v1/assets");
    expect(list.body.assets[0]).toMatchObject({ access: "members", effectiveAccess: "members" });
    const plainList = await json<{ assets: Record<string, unknown>[] }>(plain, "/api/v1/assets");
    expect(Object.keys(plainList.body.assets[0] ?? {})).not.toContain("access");
  });
});

/* ------------------------------------------------------------- the fences --- */

describe("the scope fences on a multi-site deployment", () => {
  const ADMIN_ORIGIN = "https://cms.example";
  const multi = createFolio<Cloudflare.Env>(
    config(true, {
      sites: { admin: ADMIN_ORIGIN },
      auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
    }),
  );

  let alpha: string;
  let aKey: string;
  let aId: string;
  let bId: string;
  let bKey: string;
  let sKey: string;

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("delete from site_hosts"),
      env.DB.prepare("delete from sites"),
    ]);
    await env.DB.batch([
      env.DB.prepare(
        `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
           ('alpha', 'site', 'Alpha', null, 'live', null, 0, 0),
           ('bravo', 'site', 'Bravo', null, 'live', null, 0, 0)`,
      ),
      env.DB.prepare(
        "insert into site_hosts (host, site_id) values ('alpha.example', 'alpha'), ('bravo.example', 'bravo')",
      ),
    ]);
    const user = await createUser(env.DB, {
      email: `e${++n}@example.com`,
      grants: { alpha: "editor" },
    });
    alpha = `${SECURE_COOKIE}=${(await createSession(env.DB, user.id)).token}`;
    ({ id: aId, key: aKey } = await seed({ site: "alpha", access: "members" }));
    ({ id: bId, key: bKey } = await seed({ site: "bravo", access: "members" }));
    ({ key: sKey } = await seed({ site: "shared", access: "premium" }));
  });

  const at = (path: string) =>
    json(multi, `/~alpha${path}`, { cookie: alpha, origin: ADMIN_ORIGIN });

  it("GET /api/assets/access answers the chain's keys, and a key outside it like an unknown one", async () => {
    const { status, body } = await at(`/api/assets/access?key=${aKey}&key=${bKey}&key=${sKey}`);
    expect(status).toBe(200);
    expect(body).toEqual({ [aKey]: "members", [sKey]: "premium" });
  });

  it("GET /api/assets/purges counts the request's scope alone", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into asset_purges (asset_id, site_id, queued_at, settle_at) values (?, 'alpha', ?, ?)",
      ).bind(aId, now, now + 10 * MIN),
      env.DB.prepare(
        "insert into asset_purges (asset_id, site_id, queued_at, settle_at) values (?, 'bravo', ?, ?)",
      ).bind(bId, now, now + 10 * MIN),
    ]);
    const { body } = await at("/api/assets/purges");
    expect(body).toMatchObject({ pending: 1, oldest: now });
  });

  it("PATCH /api/v1/assets/:id 404s another site's file and writes nothing", async () => {
    const refused = await json(multi, `/~alpha/api/v1/assets/${bId}`, {
      method: "PATCH",
      json: { access: "premium", alt: "taken" },
      cookie: alpha,
      origin: ADMIN_ORIGIN,
    });
    expect(refused.status).toBe(404);
    expect(await stored(bId)).toEqual({ access: '"members"', effective: '"members"' });
    expect(await queued()).toEqual([]);

    const own = await json(multi, `/~alpha/api/v1/assets/${aId}`, {
      method: "PATCH",
      json: { access: "premium" },
      cookie: alpha,
      origin: ADMIN_ORIGIN,
    });
    expect(own.status).toBe(200);
    expect((await stored(aId))?.effective).toBe('"premium"');
  });
});
