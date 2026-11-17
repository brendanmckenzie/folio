import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { FolioConfig } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { SECURE_COOKIE } from "../../src/server/auth/cookie";
import type { Grants } from "../../src/server/auth/roles";
import { createSession } from "../../src/server/auth/session";
import { createUser } from "../../src/server/auth/users";

/**
 * `admin.pages` on `GET {base}/api/me` (`platform/admin-extensions.md` decision 13):
 * present exactly when configured, `allowed` computed on the server from the `*` grant,
 * and byte-identical answers for a host that declares nothing.
 */

const ORIGIN = "https://folio.test";
const ADMIN = "https://cms.example";

const page = defineBlock({
  name: "hpPage",
  label: "Page",
  summary: "title",
  fields: { title: text({ label: "Title" }) },
  render: () => null,
});

const base = {
  blocks: [page],
  root: "hpPage",
  bindings: (e: Cloudflare.Env) => ({
    db: e.DB,
    story: e.STORY,
    media: e.MEDIA,
    images: e.IMAGES,
  }),
  basePath: "/folio",
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
};

const pages = [
  { id: "orders", label: "Orders", path: "/admin/orders", role: "editor" as const, group: "Shop" },
  { id: "stock", label: "Stock", path: "/admin/stock" },
];

const plain = createFolio<Cloudflare.Env>({ ...base } as FolioConfig<Cloudflare.Env>);
const withPages = createFolio<Cloudflare.Env>({
  ...base,
  admin: { pages },
} as FolioConfig<Cloudflare.Env>);

async function cookieFor(email: string, grants: Grants) {
  const user = await createUser(env.DB, { email, grants });
  const session = await createSession(env.DB, user.id);
  return `${SECURE_COOKIE}=${session.token}`;
}

const get = (folio: typeof plain, path: string, cookie: string, origin = ORIGIN) =>
  folio.handle(
    new Request(`${origin}${path}`, { headers: { cookie } }),
    env,
    createExecutionContext(),
  ) as Promise<Response>;

describe("/api/me hostPages", () => {
  it("is absent when nothing is configured", async () => {
    const cookie = await cookieFor("hp-a@example.com", { "*": "editor" });
    const body = (await (await get(plain, "/folio/api/me", cookie)).json()) as Record<
      string,
      unknown
    >;
    expect("hostPages" in body).toBe(false);
  });

  it("answers byte-identical /me, schema and v1 schema when nothing is configured", async () => {
    const cookie = await cookieFor("hp-b@example.com", { "*": "editor" });
    const other = createFolio<Cloudflare.Env>({ ...base } as FolioConfig<Cloudflare.Env>);
    for (const path of ["/folio/api/me", "/folio/api/schema", "/folio/api/v1/schema"]) {
      const a = await (await get(plain, path, cookie)).text();
      const b = await (await get(other, path, cookie)).text();
      expect(b).toBe(a);
    }
  });

  it("leaves the unauthenticated schema free of host paths", async () => {
    const cookie = await cookieFor("hp-c@example.com", { "*": "admin" });
    const a = await (await get(plain, "/folio/api/schema", cookie)).text();
    const b = await (await get(withPages, "/folio/api/schema", cookie)).text();
    expect(b).toBe(a);
    expect(b).not.toContain("/admin/orders");
  });

  it("lists the pages with defaults and allowed from the * grant", async () => {
    const editor = await cookieFor("hp-d@example.com", { "*": "editor" });
    const body = (await (await get(withPages, "/folio/api/me", editor)).json()) as {
      hostPages: Record<string, unknown>[];
    };
    expect(body.hostPages).toEqual([
      {
        id: "orders",
        label: "Orders",
        path: "/admin/orders",
        icon: "window",
        role: "editor",
        group: "Shop",
        scope: "deployment",
        allowed: true,
      },
      {
        id: "stock",
        label: "Stock",
        path: "/admin/stock",
        icon: "window",
        role: "viewer",
        scope: "deployment",
        allowed: true,
      },
    ]);
    const viewer = await cookieFor("hp-e@example.com", { "*": "viewer" });
    const low = (await (await get(withPages, "/folio/api/me", viewer)).json()) as {
      hostPages: { id: string; allowed: boolean }[];
    };
    expect(low.hostPages.map((p) => [p.id, p.allowed])).toEqual([
      ["orders", false],
      ["stock", true],
    ]);
  });
});

describe("/api/me hostPages with sites", () => {
  const sited = createFolio<Cloudflare.Env>({
    ...base,
    sites: { admin: ADMIN },
    route: (p: string) => `/${p}`,
    admin: {
      pages: [
        { id: "orders", label: "Orders", path: "/admin/orders", scope: "site" },
        { id: "stock", label: "Stock", path: "/admin/stock", role: "editor" },
      ],
    },
  } as unknown as FolioConfig<Cloudflare.Env>);

  beforeAll(async () => {
    await env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at)
       values ('hpalpha', 'site', 'Alpha', null, 'live', null, 0, 0)`,
    ).run();
  });

  it("reads a site-only editor as refused on a deployment page, with no allowed on a site page", async () => {
    const cookie = await cookieFor("hp-f@example.com", { hpalpha: "admin" });
    const body = (await (await get(sited, "/folio/api/me", cookie, ADMIN)).json()) as {
      hostPages: { id: string; allowed?: boolean }[];
    };
    expect(body.hostPages).toEqual([
      expect.objectContaining({ id: "orders", scope: "site" }),
      expect.objectContaining({ id: "stock", allowed: false }),
    ]);
    expect("allowed" in body.hostPages[0]!).toBe(false);
  });
});

describe("construction", () => {
  it("throws under auth: 'open'", () => {
    expect(() =>
      createFolio<Cloudflare.Env>({
        ...base,
        auth: "open",
        admin: { pages },
      } as FolioConfig<Cloudflare.Env>),
    ).toThrow(/auth: 'open'/);
  });
});
