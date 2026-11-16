import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asset, defineBlock, select, text } from "../../src/core";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings, FolioConfig, FolioGate } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { signAssetUrl } from "../../src/server/asset-signing";
import { cacheVerdictFor } from "../../src/server/cache-request";
import { SECURE_DRAFT_COOKIE, SECURE_GRANT_COOKIE } from "../../src/server/auth/cookie";
import { consumeGrantCode, mintGrantCode } from "../../src/server/auth/grants";
import { clearShareKeyMemo } from "../../src/server/asset-gate";
import { SECURE_COOKIE, SECURE_SHARE_COOKIE } from "../../src/server/auth/cookie";
import type { Scope } from "../../src/server/auth/roles";
import { createSession } from "../../src/server/auth/session";
import { createShare, revokeShare } from "../../src/server/auth/shares";
import { createToken } from "../../src/server/auth/tokens";
import { createUser } from "../../src/server/auth/users";

/**
 * Visitor access for files, the route (`docs/specs/platform/asset-access.md` phase 3):
 * what `{base}/asset/:key` answers for a public file, a gated one, a denied visitor and
 * every kind of Folio credential, against real D1 and R2.
 *
 * The calls that must NOT happen are the half a passing response hides, so R2 and the
 * Images binding are counted and so is every host function.
 */

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (ch) => ch.charCodeAt(0),
);

const page = defineBlock({
  name: "agPage",
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
  { name: "agPage", label: "Page", kind: "page", root: "agPage", default: true },
];

/* ------------------------------------------------------------ the counters --- */

const calls = { r2: 0, images: 0, visitor: 0, allowsAsset: 0, assetDenied: 0, d1: 0 };
const errors: string[] = [];
const logger = {
  error: (m: string) => void errors.push(String(m)),
  warn() {},
  info() {},
  debug() {},
  log() {},
} as unknown as Console;

const media = new Proxy(env.MEDIA, {
  get(t, k) {
    const v = (t as never)[k] as unknown;
    if (k === "get") {
      return (...a: unknown[]) => {
        calls.r2++;
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    }
    return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
  },
});

const images = {
  input() {
    calls.images++;
    return {
      transform: () => ({
        output: async () => ({
          response: () => new Response(new Uint8Array([1, 2, 3])),
          contentType: () => "image/webp",
        }),
      }),
    };
  },
} as unknown as ImagesBinding;

/** Counts every statement prepared on the database or on any session of it. */
function counted<T extends object>(db: T): T {
  return new Proxy(db, {
    get(t, k) {
      if (k === "withSession") {
        return (...a: unknown[]) =>
          counted((t as unknown as { withSession: (...x: unknown[]) => object }).withSession(...a));
      }
      if (k === "prepare") {
        return (sql: string) => {
          calls.d1++;
          return (t as unknown as D1Database).prepare(sql);
        };
      }
      const v = (t as never)[k] as unknown;
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: counted(e.DB),
  story: e.STORY,
  media,
  images,
});

/** A visitor is whoever the `x-member` header names; the host decides per file. */
let verdict: (value: unknown, ctxAssetId: string) => boolean = () => false;
let denial: FolioGate<Cloudflare.Env>["assetDenied"];

const gate: FolioGate<Cloudflare.Env> = {
  field: "access",
  public: "public",
  visitor(req) {
    calls.visitor++;
    if (req.headers.get("x-boom") === "visitor") throw new Error("idp down");
    return req.headers.get("x-member") ? { id: "m1" } : null;
  },
  allows: () => false,
  allowsAsset(who, value, ctx) {
    calls.allowsAsset++;
    if (who === null) return false;
    if ((who as { id: string }).id === "m1" && value === "boom") throw new Error("nope");
    return verdict(value, ctx.asset.id);
  },
  assetDenied(req, env, ctx) {
    calls.assetDenied++;
    return denial?.(req, env, ctx);
  },
};

const BASE = "https://example.com/folio";
const K1 = "asset-sign-key-one-0123456789abcdef";
const K2 = "asset-sign-key-two-0123456789abcdef";
let signKeys: string[] = [K1];

function config(withGate: boolean): FolioConfig<Cloudflare.Env> {
  return {
    blocks: [page],
    types,
    bindings,
    basePath: "/folio",
    assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
    auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
    route: (p) => (p ? `/${p}` : "/"),
    logger,
    draftMode: true,
    assetSigning: { keys: () => signKeys },
    ...(withGate ? { gate } : {}),
  };
}
const gated = createFolio<Cloudflare.Env>(config(true));
const plain = createFolio<Cloudflare.Env>(config(false));

async function get(
  folio: typeof gated,
  key: string,
  init: RequestInit & { query?: string; url?: string } = {},
): Promise<Response> {
  const res = await folio.handle(
    new Request(init.url ?? `${BASE}/asset/${key}${init.query ?? ""}`, init),
    env,
    createExecutionContext(),
  );
  if (!res) throw new Error("handle() answered null");
  return res;
}

let n = 0;
/** A library row with its object in R2. `effective` is the JSON text the route reads. */
async function seed(
  effective: string | null,
  site = "default",
): Promise<{ id: string; key: string }> {
  n += 1;
  const id = `ast_${(0xa00000 + n).toString(16).padStart(12, "0")}`;
  const key = `${id}-pic.png`;
  await env.MEDIA.put(key, PNG, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare(
    `insert into assets (id, key, filename, content_type, size, created_at, site_id, effective_access)
     values (?, ?, 'pic.png', 'image/png', ?, 1, ?, ?)`,
  )
    .bind(id, key, PNG.byteLength, site, effective)
    .run();
  return { id, key };
}

const reset = () => {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
  errors.length = 0;
  verdict = () => false;
  denial = undefined;
};

async function person(email: string, role: "editor" | "viewer" = "editor") {
  const user = await createUser(env.DB, { email, role });
  const { token } = await createSession(env.DB, user.id);
  return `${SECURE_COOKIE}=${token}`;
}

beforeAll(async () => {
  await env.DB.batch([env.DB.prepare("delete from shares"), env.DB.prepare("delete from stories")]);
});
beforeEach(() => {
  reset();
  signKeys = [K1];
  clearShareKeyMemo();
});

/* -------------------------------------------------------- public files --- */

describe("a public file on a gated deployment", () => {
  it("is byte-identical to a no-gate run but for Cache-Tag, with one statement and no host call", async () => {
    const a = await seed(null);
    const b = await seed('"public"');
    for (const file of [a, b]) {
      const control = await get(plain, file.key);
      const res = await get(gated, file.key);
      const strip = (r: Response) =>
        [...r.headers.entries()].filter(([k]) => k !== "cache-tag").sort();
      expect(res.status).toBe(200);
      expect(strip(res)).toEqual(strip(control));
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("cache-tag")).toBe(`asset:${file.id},asset:*`);
      expect(control.headers.get("cache-tag")).toBeNull();
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(
        new Uint8Array(await control.arrayBuffer()),
      );
    }
    expect(calls.visitor).toBe(0);
    expect(calls.allowsAsset).toBe(0);
  });

  it("issues exactly one D1 statement, and a no-gate deployment none", async () => {
    const a = await seed(null);
    await get(plain, a.key);
    expect(calls.d1).toBe(0);
    await get(gated, a.key);
    expect(calls.d1).toBe(1);
  });

  it("a deployment with no gate emits no tag and reads no row", async () => {
    const a = await seed('"members"');
    const res = await get(plain, a.key);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-tag")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});

/* ---------------------------------------------------------- gated files --- */

describe("a gated file", () => {
  it("is a bare 403 to a visitor the host refuses, with R2 and Images untouched", async () => {
    const f = await seed('"members"');
    for (const query of ["", "?w=320&f=webp"]) {
      const res = await get(gated, f.key, { query });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(calls.r2).toBe(0);
    expect(calls.images).toBe(0);
  });

  it("serves the bytes private, no-store with the original's headers when the host grants", async () => {
    const f = await seed('"members"');
    verdict = (value, id) => value === "members" && id === f.id;
    const res = await get(gated, f.key, { headers: { "x-member": "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cache-tag")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("stores a granted variant under the private key and serves it twice for one Images call", async () => {
    const f = await seed('"members"');
    verdict = () => true;
    const init = { headers: { "x-member": "1" }, query: "?w=320&f=webp" };
    const first = await get(gated, f.key, init);
    const second = await get(gated, f.key, init);
    for (const res of [first, second]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(calls.images).toBe(1);
    const cache = (caches as unknown as { default: Cache }).default;
    const base = `${BASE}/asset/${f.key}?w=320&f=webp`;
    const priv = await cache.match(new Request(`${base}&__folio_private=1`));
    expect(priv?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await cache.match(new Request(base))).toBeUndefined();
  });

  it("answers 404 private, no-store for an object with no row", async () => {
    const orphan = "ast_0123456789ab-orphan.png";
    await env.MEDIA.put(orphan, PNG, { httpMetadata: { contentType: "image/png" } });
    const res = await get(gated, orphan);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves HEAD through the same admission, with no body", async () => {
    const f = await seed('"members"');
    expect((await get(gated, f.key, { method: "HEAD" })).status).toBe(403);
    verdict = () => true;
    const ok = await get(gated, f.key, { method: "HEAD", headers: { "x-member": "1" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
  });

  it("fails closed on an unreadable stored value, logged, and the host sees undefined", async () => {
    const f = await seed("{nope");
    let seen: unknown = "unset";
    verdict = (value) => {
      seen = value;
      return true;
    };
    const res = await get(gated, f.key, { headers: { "x-member": "1" } });
    expect(res.status).toBe(200);
    expect(seen).toBeUndefined();
    expect(errors.some((e) => e.includes("unreadable asset access value"))).toBe(true);
    expect((await get(gated, f.key)).status).toBe(403);
  });
});

describe("the host's hooks", () => {
  it("treats a throwing visitor, allowsAsset and assetDenied as denials, logged", async () => {
    const f = await seed('"members"');
    expect((await get(gated, f.key, { headers: { "x-boom": "visitor" } })).status).toBe(403);
    expect(errors).toContain("folio: gate.visitor threw; denying asset");

    const boom = await seed('"boom"');
    expect((await get(gated, boom.key, { headers: { "x-member": "1" } })).status).toBe(403);
    expect(errors).toContain("folio: gate.allowsAsset threw; denying");

    denial = () => {
      throw new Error("x");
    };
    const res = await get(gated, f.key);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(errors).toContain("folio: gate.assetDenied threw");
  });

  it("answers the host's redirect, forced private, no-store, and the 403 for null", async () => {
    const f = await seed('"members"');
    denial = (req, _env, ctx) =>
      Response.redirect(
        `https://example.com/sign-in?next=${encodeURIComponent(req.url)}&v=${ctx.value}`,
        302,
      );
    const res = await get(gated, f.key);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/sign-in?next=");
    expect(res.headers.get("location")).toContain("v=members");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    denial = () => null;
    expect((await get(gated, f.key)).status).toBe(403);
  });
});

/* --------------------------------------------------- Folio credentials --- */

describe("Folio credentials", () => {
  it("admits a signed-in editor with only the session cookie, with no host call", async () => {
    const f = await seed('"members"');
    const cookie = await person("ed@ag.example");
    const res = await get(gated, f.key, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(calls.visitor).toBe(0);
  });

  it("admits a token with content:read, and a token without it falls through to the host", async () => {
    const f = await seed('"members"');
    const read = await createToken(env.DB, { name: "r", scopes: ["content:read"] as Scope[] });
    const write = await createToken(env.DB, { name: "w", scopes: ["assets:write"] as Scope[] });
    const ok = await get(gated, f.key, { headers: { authorization: `Bearer ${read.token}` } });
    expect(ok.status).toBe(200);
    expect(calls.visitor).toBe(0);
    const no = await get(gated, f.key, { headers: { authorization: `Bearer ${write.token}` } });
    expect(no.status).toBe(403);
    expect(calls.visitor).toBe(1);
  });

  it("treats a stale cookie as nobody", async () => {
    const f = await seed('"members"');
    const res = await get(gated, f.key, { headers: { cookie: `${SECURE_COOKIE}=bogus` } });
    expect(res.status).toBe(403);
  });
});

/* -------------------------------------------------------------- shares --- */

describe("a share cookie", () => {
  async function storyUsing(id: string, key: string | null) {
    await env.DB.prepare(
      `insert or replace into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
       values (?, 'agPage', null, ?, ?, 'a0', 'T', 1, 1)`,
    )
      .bind(id, id, id)
      .run();
    const draft = await gated.draft(env, id);
    if (key) {
      await gated.write(
        env,
        id,
        [{ t: "set", uid: draft.root, field: "hero", value: { key, filename: "pic.png" } }],
        { actor: "test" },
      );
    }
  }

  it("admits a file the story's draft uses, stamps no view, and ends when revoked", async () => {
    const f = await seed('"members"');
    const other = await seed('"members"');
    await storyUsing("sty_ag_a", f.key);
    const minted = await createShare(env.DB, {
      storyId: "sty_ag_a",
      expiresAt: Date.now() + 60_000,
    });
    const cookie = `${SECURE_SHARE_COOKIE}=${minted.token}`;

    const ok = await get(gated, f.key, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(calls.visitor).toBe(0);
    const views = await env.DB.prepare("select views from shares where id = ?")
      .bind(minted.row.id)
      .first<{ views: number }>();
    expect(views?.views).toBe(0);

    // The share names a story, and the story does not use this file.
    expect((await get(gated, other.key, { headers: { cookie } })).status).toBe(403);

    // The memo holds the key set, but revocation is read on every request.
    await revokeShare(env.DB, minted.row.id);
    expect((await get(gated, f.key, { headers: { cookie } })).status).toBe(403);
  });
});

/* -------------------------------------------------------- multi-site --- */

describe("on a deployment with sites", () => {
  const ADMIN = "https://cms.example";
  const multi = createFolio<Cloudflare.Env>({
    ...config(true),
    sites: { admin: ADMIN },
    route: (p, _l, site) =>
      site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : "/",
  });

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert or ignore into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
           ('alpha', 'site', 'Alpha', null, 'live', null, 0, 0),
           ('bravo', 'site', 'Bravo', null, 'live', null, 0, 0)`,
      ),
      env.DB.prepare(
        `insert or ignore into site_hosts (host, site_id) values ('alpha.example', 'alpha'), ('bravo.example', 'bravo')`,
      ),
    ]);
  });

  it("governs a file by its own scope on a site host, where the request carries no scope", async () => {
    const alpha = await seed('"members"', "alpha");
    const bravo = await seed('"members"', "bravo");
    const aliceCookie = await (async () => {
      const user = await createUser(env.DB, {
        email: "alice@ag.example",
        grants: { alpha: "editor" },
      });
      const { token } = await createSession(env.DB, user.id);
      return `${SECURE_COOKIE}=${token}`;
    })();
    const at = (host: string, key: string, headers: Record<string, string>) =>
      get(multi, key, { url: `https://${host}/folio/asset/${key}`, headers });

    expect((await at("alpha.example", alpha.key, { cookie: aliceCookie })).status).toBe(200);
    // Alice holds no role on bravo, so her cookie is no credential for its file.
    const denied = await at("bravo.example", bravo.key, { cookie: aliceCookie });
    expect(denied.status).toBe(403);
    // Same file reached through the other site's host: the file's own scope decides.
    expect((await at("alpha.example", bravo.key, { cookie: aliceCookie })).status).toBe(403);
    // And the host's own gate still works for a member.
    verdict = () => true;
    expect((await at("bravo.example", bravo.key, { "x-member": "1" })).status).toBe(200);
  });

  it("admits a bound token only in its own scope, and serves a ~scope admin-origin request", async () => {
    const alpha = await seed('"members"', "alpha");
    const bravo = await seed('"members"', "bravo");
    const { token } = await createToken(env.DB, {
      name: "alpha-read",
      scopes: ["content:read"] as Scope[],
      site: "alpha",
    });
    const auth = { authorization: `Bearer ${token}` };
    const at = (host: string, key: string) =>
      get(multi, key, { url: `https://${host}/folio/asset/${key}`, headers: auth });
    expect((await at("alpha.example", alpha.key)).status).toBe(200);
    expect((await at("alpha.example", bravo.key)).status).toBe(403);

    const cookie = await (async () => {
      const user = await createUser(env.DB, {
        email: "bob@ag.example",
        grants: { alpha: "viewer" },
      });
      const { token: t } = await createSession(env.DB, user.id);
      return `${SECURE_COOKIE}=${t}`;
    })();
    const viaAdmin = await get(multi, alpha.key, {
      url: `${ADMIN}/folio/~alpha/asset/${alpha.key}`,
      headers: { cookie },
    });
    expect(viaAdmin.status).toBe(200);
    expect(viaAdmin.headers.get("cache-control")).toBe("private, no-store");
  });
});

/* ---------------------------------------------------------------- brands --- */

describe("on a deployment with brands", () => {
  const seen: string[] = [];
  const brandGate = (name: string, grants: boolean): FolioGate<Cloudflare.Env> => ({
    ...gate,
    allowsAsset: () => {
      seen.push(`${name}:allows`);
      return grants;
    },
    assetDenied: () => {
      seen.push(`${name}:denied`);
      return new Response(null, { status: 302, headers: { location: `/sign-in/${name}` } });
    },
  });
  const brandsFolio = createFolio<Cloudflare.Env>({
    brands: {
      ga: { label: "A", blocks: [page], types, gate: brandGate("ga", true) },
      gb: { label: "B", blocks: [page], types, gate: brandGate("gb", false) },
    },
    sites: { admin: "https://cms.example" },
    bindings,
    basePath: "/folio",
    auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
    logger,
    assets: {
      admin: "/folio-admin.js",
      brands: { ga: { preview: "/a.js" }, gb: { preview: "/b.js" } },
    },
    route: (p, _l, site) =>
      site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : "/",
  });

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert or ignore into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
           ('ba', 'site', 'BA', null, 'live', null, 'ga', 0, 0),
           ('bb', 'site', 'BB', null, 'live', null, 'gb', 0, 0)`,
      ),
      env.DB.prepare(
        `insert or ignore into site_hosts (host, site_id) values ('ba.example', 'ba'), ('bb.example', 'bb')`,
      ),
    ]);
  });
  beforeEach(() => {
    seen.length = 0;
  });

  const at = (host: string, key: string) =>
    get(brandsFolio, key, {
      url: `https://${host}/folio/asset/${key}`,
      headers: { "x-member": "1" },
    });

  it("asks the asset's own brand's gate, whichever site's host served the request", async () => {
    const a = await seed('"members"', "ba");
    const b = await seed('"members"', "bb");
    expect((await at("ba.example", a.key)).status).toBe(200);
    expect(seen).toEqual(["ga:allows"]);
    seen.length = 0;
    // The request arrives on brand A's host for brand B's file: B's gate decides.
    const res = await at("ba.example", b.key);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sign-in/gb");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(seen).toEqual(["gb:allows", "gb:denied"]);
  });

  it("answers a bare 403 for a gated file in a scope with no brand, without the hook", async () => {
    const shared = await seed('"members"', "shared");
    const res = await at("ba.example", shared.key);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(seen).toEqual([]);
  });

  it("still serves a public file from a scope with no brand", async () => {
    const shared = await seed(null, "shared");
    expect((await at("ba.example", shared.key)).status).toBe(200);
  });
});

/* ----------------------------------------------------------- signed URLs --- */

describe("a signed URL", () => {
  const signed = async (key: string, expiresIn = 60) =>
    gated.signAsset(env, `/folio/asset/${key}`, { expiresIn });
  const getSigned = (key: string, url: string, init: RequestInit = {}) =>
    get(gated, key, { url: `https://example.com${url}`, ...init });

  it("is served private, no-store with no referrer to a visitor with no cookie, and the host is never asked", async () => {
    const f = await seed('"members"');
    const url = await signed(f.key);
    const res = await getSigned(f.key, url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(calls.visitor).toBe(0);
    expect(calls.allowsAsset).toBe(0);
    // And the edge is told never to store it.
    expect(cacheVerdictFor(new Request(`https://example.com${url}`), "/folio")).toBe("bypass");
  });

  it("covers every transform of the file, each served private", async () => {
    const f = await seed('"members"');
    const url = await signed(f.key);
    const res = await getSigned(f.key, `${url}&w=200&f=webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("falls through to the host when expired, tampered, far-future, for another file, or unsigned", async () => {
    const f = await seed('"members"');
    const other = await seed('"members"');
    const base = `/folio/asset/${f.key}`;
    const url = await signed(f.key);
    const expired = await signAssetUrl([K1], base, 60, Date.now() - 120_000);
    const far = await signAssetUrl([K1], base, 60, Date.now() + 2 * 86_400_000);
    const wrongKey = await signAssetUrl([K2], base, 60, Date.now());
    const flipped = url.replace(/sig=(.)/, (_m, ch: string) => `sig=${ch === "A" ? "B" : "A"}`);
    const forOther = await signed(other.key);
    const swapped = `${base}?${forOther.split("?")[1]}`;
    for (const bad of [expired, far, wrongKey, flipped, swapped, base]) {
      calls.visitor = 0;
      const res = await getSigned(f.key, bad);
      expect(res.status, bad).toBe(403);
      expect(calls.visitor, bad).toBe(1);
    }
  });

  it("falls through to the member's own cookie when expired", async () => {
    const f = await seed('"members"');
    const expired = await signAssetUrl([K1], `/folio/asset/${f.key}`, 60, Date.now() - 120_000);
    verdict = () => true;
    const res = await getSigned(f.key, expired, { headers: { "x-member": "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBeNull();
    expect(calls.visitor).toBe(1);
  });

  it("is invalid when a configured key is under 32 characters, with one logged line", async () => {
    const f = await seed('"members"');
    const url = await signed(f.key);
    signKeys = [K1, "short"];
    const res = await getSigned(f.key, url);
    expect(res.status).toBe(403);
    expect(errors.some((e) => e.includes("assetSigning keys are unusable"))).toBe(true);
    await expect(gated.signAsset(env, `/folio/asset/${f.key}`)).rejects.toThrow(/32 characters/);
  });

  it("is ignored on a deployment with no assetSigning, and signAsset answers the plain URL", async () => {
    const f = await seed('"members"');
    const url = await signed(f.key);
    const noSigning = createFolio<Cloudflare.Env>({ ...config(true), assetSigning: undefined });
    const res = await get(noSigning, f.key, { url: `https://example.com${url}` });
    expect(res.status).toBe(403);
    expect(await noSigning.signAsset(env, `/folio/asset/${f.key}`)).toBe(`/folio/asset/${f.key}`);
  });
});

/* ------------------------------------------- grants and open + draft cookie --- */

describe("a preview-origin grant", () => {
  const PREVIEW = "https://prev-preview.example";
  const multi = createFolio<Cloudflare.Env>({
    ...config(true),
    sites: { admin: "https://cms.example" },
    route: (p, _l, site) =>
      site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : "/",
  });

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert or ignore into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
           ('prev', 'site', 'Prev', null, 'live', ?, 0, 0),
           ('prevother', 'site', 'Other', null, 'live', 'https://prevother-preview.example', 0, 0)`,
      ).bind(PREVIEW),
      env.DB.prepare(
        `insert or ignore into site_hosts (host, site_id) values ('prev.example', 'prev'), ('prevother.example', 'prevother')`,
      ),
    ]);
  });

  async function grantCookie(site: string, role: "editor" | "viewer" = "editor") {
    const user = await createUser(env.DB, {
      email: `${site}-${role}@ag.example`,
      grants: { [site]: role },
    });
    const { sessionId } = (await createSession(env.DB, user.id)) as unknown as {
      sessionId?: string;
      token: string;
    };
    const row = await env.DB.prepare("select id from sessions where user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    const minted = await mintGrantCode(env.DB, { sessionId: sessionId ?? row!.id }, site);
    const redeemed = await consumeGrantCode(env.DB, minted.code, site);
    return `${SECURE_GRANT_COOKIE}=${redeemed!.token}`;
  }
  const at = (origin: string, key: string, cookie: string) =>
    get(multi, key, { url: `${origin}/folio/asset/${key}`, headers: { cookie } });

  it("admits a file of its own scope and refuses another scope's, with no host call", async () => {
    const mine = await seed('"members"', "prev");
    const theirs = await seed('"members"', "prevother");
    const cookie = await grantCookie("prev");
    const ok = await at(PREVIEW, mine.key, cookie);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(calls.visitor).toBe(0);
    expect((await at(PREVIEW, theirs.key, cookie)).status).toBe(403);
    // Its grant is no credential on another site's preview origin.
    expect((await at("https://prevother-preview.example", theirs.key, cookie)).status).toBe(403);
  });
});

describe("auth: 'open'", () => {
  const open = createFolio<Cloudflare.Env>({ ...config(true), auth: "open" });

  it("admits a gated file on the draft cookie alone, and refuses without it", async () => {
    const f = await seed('"members"');
    const ok = await get(open, f.key, { headers: { cookie: `${SECURE_DRAFT_COOKIE}=1` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(calls.visitor).toBe(0);
    expect((await get(open, f.key)).status).toBe(403);
  });
});
