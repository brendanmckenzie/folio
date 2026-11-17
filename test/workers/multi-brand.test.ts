import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { defineBlock, defineRecord, text } from "../../src/core";
import { defineMigration, field } from "../../src/core/migrate";
import type { Doc } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import { chain, layerSeed, type SiteRef } from "../../src/core/sites";
import type { FolioBindings, FolioBrand, FolioConfig } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { createApp } from "../../src/server/app";
import { createToken } from "../../src/server/auth/tokens";
import { envelope, FolioError } from "../../src/server/errors";
import { withActor, withBindings, withScope } from "../../src/server/middleware";
import { MCP_PROTOCOL_VERSION } from "../../src/server/mcp/rpc";
import { accessRoutes } from "../../src/server/routes/access";
import { siteRoutes } from "../../src/server/routes/sites";
import { createRuntime, type FolioRuntime } from "../../src/server/runtime";
import { SCOPE_HEADER, SITE_HEADER, SURFACE_HEADER, updateSite } from "../../src/server/sites";
import type { FolioEnv } from "../../src/server/types";

/**
 * Many brands in one deployment, phase 3 (`docs/specs/foundation/multi-brand.md`):
 * the brand core over one real D1 — the registry routes' brand rules (decision 4),
 * the chain that never leaves a brand and has no `shared` (decision 5), the fence
 * that keeps a row of no configured brand out of the snapshot, and construction
 * (decision 3). The routes that read a registry through `c.var.brand` are phase 4's,
 * and so is everything that renders; this file mounts the middleware and the
 * registry routes on their own for that reason.
 *
 * The brands collide on the block names `pageRoot` and `prose` and the type `page`,
 * as atlas and harbour do. The registry: brand `atlas` has group
 * `east` holding `kenya`, and `default` (set by SQL, as `UPGRADING.md` says a host
 * does after `0013`); brand `harbour` has `harbour`, which holds a story; and
 * `orphan` is a row with no brand, `ghost` one of a brand nobody configured.
 */

const atlRoot = defineBlock({
  name: "pageRoot",
  label: "Page",
  fields: { title: text(), strap: text() },
  render: () => null,
});
const atlProse = defineBlock({
  name: "prose",
  label: "Prose",
  fields: { body: text() },
  render: () => null,
});
const atlHeader = defineBlock({
  name: "header",
  label: "Header",
  fields: { tagline: text({ default: "Karibu" }) },
  render: () => null,
});
const hbrRoot = defineBlock({
  name: "pageRoot",
  label: "Page",
  fields: { heading: text() },
  render: () => null,
});
const hbrProse = defineBlock({
  name: "prose",
  label: "Prose",
  fields: { copy: text() },
  render: () => null,
});

const atlTypes: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
  { name: "header", label: "Header", kind: "singleton", root: "header" },
];
const hbrTypes: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
];

const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
  atlas: {
    label: "Atlas Guides",
    blocks: [atlRoot, atlProse, atlHeader],
    types: atlTypes,
    globals: ["header"],
  },
  harbour: { label: "Harbour Travel", blocks: [hbrRoot, hbrProse], types: hbrTypes },
};

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const ADMIN = "https://cms.example";

const config: FolioConfig<Cloudflare.Env> = {
  brands,
  sites: { admin: ADMIN },
  bindings,
  basePath: "/folio",
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : "/",
};

const rt: FolioRuntime = createRuntime(config);

/**
 * The middleware every Folio request passes, and the registry routes, in the order
 * `app.ts` mounts them, plus one probe that reports what `withScope` set. The
 * internal headers are written here the way `handle()` writes them.
 */
function mount(on: FolioRuntime, cfg: FolioConfig<Cloudflare.Env> = config) {
  const app = new Hono<FolioEnv<Cloudflare.Env>>().basePath("/folio");
  app.onError((err, c) =>
    err instanceof FolioError
      ? c.json(envelope(err), err.status)
      : c.json({ err: String(err) }, 500),
  );
  app.use("*", withBindings(cfg));
  app.use("*", withScope(on));
  app.use("*", withActor(on));
  app.get("/probe", (c) =>
    c.json({ scope: c.var.scope, brand: c.var.brand?.brand ?? null, has: c.var.brand !== null }),
  );
  app.route("/api", siteRoutes(on));
  app.route("/api", accessRoutes(on));
  return app;
}

const app = mount(rt);

async function call(
  path: string,
  init: { method?: string; body?: unknown; scope?: string; site?: string } = {},
) {
  const headers = new Headers({ "content-type": "application/json", ...(await auth()) });
  if (init.scope) headers.set(SCOPE_HEADER, init.scope);
  if (init.site) {
    headers.set(SITE_HEADER, init.site);
    headers.set(SURFACE_HEADER, "live");
  }
  const res = await app.request(
    `${ADMIN}/folio${path}`,
    {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let token: string | undefined;
async function auth(): Promise<Record<string, string>> {
  token ??= (await createToken(env.DB, { name: "platform", scopes: ["admin"] })).token;
  return { authorization: `Bearer ${token}` };
}

const errorOf = (body: Record<string, unknown>) =>
  (body as { error?: { code: string; message: string } }).error;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("update sites set brand = 'atlas' where id = 'default'"),
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
         ('east', 'group', 'East', null, null, null, 'atlas', 0, 0),
         ('kenya', 'site', 'Kenya', 'east', 'live', null, 'atlas', 0, 0),
         ('harbour', 'site', 'Harbour Travel', null, 'live', null, 'harbour', 0, 0),
         ('orphan', 'site', 'Orphan', null, 'live', null, null, 0, 0),
         ('ghost', 'site', 'Ghost', null, 'live', null, 'retired', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('kenya.example', 'kenya'), ('harbour.example', 'harbour'),
         ('orphan.example', 'orphan')`,
    ),
    env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id)
       values ('sty_hbr_home', 'page', null, 'home', 'home', 'a0', 'Home', 1, 'harbour')`,
    ),
  ]);
  rt.sites?.drop();
});

/* ------------------------------------------------------------ construction --- */

describe("construction", () => {
  it("refuses a top-level writing guide, and prefixes a brand's own refusals (spec 40)", () => {
    expect(() =>
      createFolio({ ...config, writing: { voice: "x" } } as unknown as FolioConfig<Cloudflare.Env>),
    ).toThrow("folio: 'writing' belongs to a brand beside 'brands'");
    const withBrand = (over: Partial<FolioBrand<Cloudflare.Env>>) =>
      createFolio({
        ...config,
        brands: { ...brands, harbour: { ...brands.harbour!, ...over } },
      });
    expect(() => withBrand({ writing: { voice: "x".repeat(16_001) } })).toThrow(
      "folio: brand 'harbour': 'writing.voice' must be",
    );
    expect(() =>
      withBrand({ writing: { voice: "Warm.", avoid: [{ term: "Cheap" }, { term: "cheap" }] } }),
    ).toThrow("folio: brand 'harbour': 'writing.avoid[1].term' repeats 'cheap'");
    const tooLong = defineBlock({
      name: "pageRoot",
      label: "Page",
      fields: { heading: text({ length: { min: 10, max: 5 } }) },
      render: () => null,
    });
    expect(() => withBrand({ blocks: [tooLong, hbrProse] })).toThrow(
      "folio: brand 'harbour': block 'pageRoot' field 'heading': 'length.max' (5) is below",
    );
    expect(() =>
      withBrand({ writing: { voice: "Warm.", avoid: [{ term: "cheap" }] } }),
    ).not.toThrow();
  });

  it("refuses through createFolio exactly as through the runtime", () => {
    const { sites: _sites, ...noSites } = config;
    expect(() => createFolio(noSites as FolioConfig<Cloudflare.Env>)).toThrow(
      /'brands' needs 'sites'/,
    );
    expect(() =>
      createFolio({ ...config, blocks: [atlRoot] } as unknown as FolioConfig<Cloudflare.Env>),
    ).toThrow(/'blocks' belongs to a brand beside 'brands'/);
    expect(() =>
      createFolio({
        ...config,
        brands: {
          ...brands,
          harbour: {
            ...brands.harbour!,
            migrations: [{ id: "0001-x", description: "x", up: () => [] }],
          },
        },
      }),
    ).toThrow(/brand 'harbour': migration id '0001-x' must start with its brand/);
    expect(() =>
      createFolio({
        ...config,
        assets: { admin: "/a.js", brands: { atlas: { preview: "/p.js" } } },
      }),
    ).toThrow(/'assets.brands' must name exactly the brands/);
  });

  it("checks a record type's previewRoot against its own brand's registry (spec 45)", () => {
    const person = defineBlock({
      name: "person",
      label: "Person",
      fields: { name: text() },
      render: () => null,
    });
    const withRoot = (previewRoot: string, extra: (typeof hbrRoot)[] = []) =>
      createFolio({
        ...config,
        brands: {
          ...brands,
          harbour: {
            ...brands.harbour!,
            blocks: [hbrRoot, hbrProse, person, ...extra],
            types: [
              ...hbrTypes,
              { name: "person", label: "Person", kind: "record", root: "person", previewRoot },
            ],
          },
        },
      });
    // `header` exists, but only atlas declares it.
    expect(() => withRoot("header")).toThrow(
      /document type 'person' names previewRoot 'header', which is not in the registry/,
    );
    const bare = defineRecord({ name: "bareFrame", label: "Bare", fields: { x: text() } });
    expect(() => withRoot("bareFrame", [bare as unknown as typeof hbrRoot])).toThrow(
      /document type 'person' names previewRoot 'bareFrame', which has no render/,
    );
    expect(() => withRoot("prose")).not.toThrow();
  });

  it("checks a global's previewRoot against its own brand's registry and globals (spec 46)", () => {
    const footer = defineBlock({
      name: "footer",
      label: "Footer",
      fields: { note: text() },
      render: () => null,
    });
    const withRoot = (previewRoot: string, globals: string[] = ["footer"]) =>
      createFolio({
        ...config,
        brands: {
          ...brands,
          harbour: {
            ...brands.harbour!,
            blocks: [hbrRoot, hbrProse, footer],
            types: [
              ...hbrTypes,
              { name: "footer", label: "Footer", kind: "singleton", root: "footer", previewRoot },
            ],
            globals,
          },
        },
      });
    // `header` exists, but only atlas declares it.
    expect(() => withRoot("header")).toThrow(
      /document type 'footer' names previewRoot 'header', which is not in the registry/,
    );
    expect(() => withRoot("prose", [])).toThrow(
      /'footer' names previewRoot 'prose', but is not one of 'globals'/,
    );
    expect(() => withRoot("prose")).not.toThrow();
  });

  it("builds one brand runtime per brand, each with its own pageRoot and prose", () => {
    expect([...rt.brands.keys()]).toEqual(["atlas", "harbour"]);
    expect(Object.keys(rt.brands.get("atlas")!.schema.pageRoot!.fields)).toEqual([
      "title",
      "strap",
    ]);
    expect(Object.keys(rt.brands.get("harbour")!.schema.pageRoot!.fields)).toEqual(["heading"]);
  });
});

/* ---------------------------------------------------------------- registry --- */

describe("the registry routes under brands (decision 4)", () => {
  it("lists every row with its brand, the ones that serve nothing included", async () => {
    const listed = await call("/api/sites");
    const sites = listed.body.sites as SiteRef[];
    const brandOf = (id: string) => sites.find((s) => s.id === id)?.brand;
    expect(brandOf("kenya")).toBe("atlas");
    expect(brandOf("orphan")).toBeNull();
    expect(brandOf("ghost")).toBe("retired");
    expect(listed.body.shared).toBe(false);
  });

  it("requires a brand on create, for a site and for a group", async () => {
    const site = await call("/api/sites", {
      method: "POST",
      body: { id: "uganda", kind: "site", name: "Uganda" },
    });
    expect(site.status).toBe(400);
    expect(errorOf(site.body)?.message).toMatch(/brand is required/);
    const group = await call("/api/sites", {
      method: "POST",
      body: { id: "west", kind: "group", name: "West" },
    });
    expect(group.status).toBe(400);
  });

  it("refuses a brand nobody configured, on create and on edit", async () => {
    const created = await call("/api/sites", {
      method: "POST",
      body: { id: "uganda", kind: "site", name: "Uganda", brand: "retired" },
    });
    expect(created.status).toBe(400);
    expect(errorOf(created.body)?.message).toMatch(/No brand 'retired'/);
    const edited = await call("/api/sites/kenya", { method: "PATCH", body: { brand: "nobody" } });
    expect(edited.status).toBe(400);
  });

  it("creates a site and a group with a configured brand", async () => {
    const group = await call("/api/sites", {
      method: "POST",
      body: { id: "hbr-group", kind: "group", name: "TG", brand: "harbour" },
    });
    expect(group).toEqual({
      status: 201,
      body: { id: "hbr-group", name: "TG", brand: "harbour" },
    });
    const site = await call("/api/sites", {
      method: "POST",
      body: { id: "hbr-au", kind: "site", name: "TG AU", group: "hbr-group", brand: "harbour" },
    });
    expect(site.status).toBe(201);
    expect(site.body.brand).toBe("harbour");
    const row = await env.DB.prepare("select brand from sites where id = 'hbr-au'").first();
    expect(row).toEqual({ brand: "harbour" });
  });

  it("refuses a site joining a group of another brand: 400, on create and on edit", async () => {
    const created = await call("/api/sites", {
      method: "POST",
      body: { id: "rwanda", kind: "site", name: "Rwanda", group: "east", brand: "harbour" },
    });
    expect(created.status).toBe(400);
    expect(errorOf(created.body)?.message).toMatch(/Group 'east' is brand 'atlas'/);
    const joined = await call("/api/sites/harbour", { method: "PATCH", body: { group: "east" } });
    expect(joined.status).toBe(400);
    // Nothing was written.
    const row = await env.DB.prepare("select group_id from sites where id = 'harbour'").first();
    expect(row).toEqual({ group_id: null });
  });

  it("refuses a brand change on a scope that holds a story: 409", async () => {
    const res = await call("/api/sites/harbour", {
      method: "PATCH",
      body: { brand: "atlas" },
    });
    expect(res.status).toBe(409);
    expect(errorOf(res.body)).toMatchObject({ code: "conflict" });
    expect(errorOf(res.body)?.message).toMatch(/still owns stories/);
    const row = await env.DB.prepare("select brand from sites where id = 'harbour'").first();
    expect(row).toEqual({ brand: "harbour" });
  });

  it("refuses a brand change on a group that has sites: 409", async () => {
    const res = await call("/api/sites/east", { method: "PATCH", body: { brand: "harbour" } });
    expect(res.status).toBe(409);
    expect(errorOf(res.body)?.message).toMatch(/still has sites/);
  });

  it("refuses a brand change when a story lands between any probe and the write", async () => {
    // A concurrent create, simulated: a story is inserted just before the batch
    // that carries the brand's \`update\` runs. A probe made before it saw an empty
    // scope; only a check inside the update itself sees the story.
    const created = await call("/api/sites", {
      method: "POST",
      body: { id: "zambia", kind: "site", name: "Zambia", brand: "atlas" },
    });
    expect(created.status).toBe(201);
    let pending: string[] = [];
    const racing = {
      prepare: (sql: string) => {
        pending.push(sql);
        return env.DB.prepare(sql);
      },
      batch: async (statements: D1PreparedStatement[]) => {
        if (pending.some((sql) => sql.trim().startsWith("update sites set"))) {
          await env.DB.prepare(
            `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id)
             values ('sty_zm_race', 'page', null, 'race', 'race', 'a0', 'Race', 1, 'zambia')`,
          ).run();
        }
        pending = [];
        return env.DB.batch(statements);
      },
    };
    const registry = await rt.sites!.fresh(env);
    await expect(
      updateSite(
        racing as unknown as Parameters<typeof updateSite>[0],
        registry,
        "zambia",
        { brand: "harbour" },
        {
          sites: rt.sites!,
          route: rt.route,
          brands: rt.sites!.brands,
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    const row = await env.DB.prepare("select brand from sites where id = 'zambia'").first();
    expect(row).toEqual({ brand: "atlas" });
  });

  it("changes the brand of an empty site, which then leaves its old chain", async () => {
    const created = await call("/api/sites", {
      method: "POST",
      body: { id: "tanzania", kind: "site", name: "Tanzania", brand: "atlas" },
    });
    expect(created.status).toBe(201);
    const moved = await call("/api/sites/tanzania", {
      method: "PATCH",
      body: { brand: "harbour", group: "hbr-group" },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ brand: "harbour", group: "hbr-group" });
    expect((await call("/probe", { scope: "tanzania" })).body.brand).toEqual({
      id: "harbour",
      label: "Harbour Travel",
    });
  });
});

/* ------------------------------------------------------------------ chain --- */

describe("a chain never crosses a brand, and there is no shared (decision 5)", () => {
  it("answers ~shared with 404 No site or group", async () => {
    const res = await call("/probe", { scope: "shared" });
    expect(res.status).toBe(404);
    expect(errorOf(res.body)?.message).toBe("No site or group 'shared'");
  });

  it("still answers ~shared on a single-brand multi-site deployment", async () => {
    const single: FolioConfig<Cloudflare.Env> = {
      blocks: [atlRoot, atlProse, atlHeader],
      types: atlTypes,
      sites: { admin: ADMIN },
      bindings,
      basePath: "/folio",
      auth: config.auth,
      route: config.route,
    };
    const res = await mount(createRuntime(single), single).request(
      `${ADMIN}/folio/probe`,
      { headers: { [SCOPE_HEADER]: "shared" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "shared", brand: null, has: true });
  });

  it("stops a site’s chain at its group, and a group’s at itself", async () => {
    const registry = await rt.sites!.registry(env);
    expect(registry.shared).toBe(false);
    expect(chain(registry, "kenya")).toEqual(["kenya", "east"]);
    expect(chain(registry, "east")).toEqual(["east"]);
    expect(chain(registry, "default")).toEqual(["default"]);
  });

  it("skips a group of another brand for a row SQL wrote", async () => {
    await env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at)
       values ('sneaky', 'site', 'Sneaky', 'east', 'live', null, 'harbour', 0, 0)`,
    ).run();
    rt.sites!.drop();
    const registry = await rt.sites!.registry(env);
    expect(chain(registry, "sneaky")).toEqual(["sneaky"]);
    await env.DB.prepare("delete from sites where id = 'sneaky'").run();
    rt.sites!.drop();
  });

  it("seeds a global layer on a site with no group, and on a group, in full", async () => {
    const registry = await rt.sites!.registry(env);
    expect(layerSeed(registry, "default")).toBe("full");
    expect(layerSeed(registry, "east")).toBe("full");
    expect(layerSeed(registry, "kenya")).toBe("bare");

    const atl = rt.brands.get("atlas")!;
    const story = (scope: string) => ({ id: `sng_header:${scope}`, type: "header", title: "H" });
    const rootData = (doc: Doc) => doc.bloks[doc.root]?.data;
    // The default of the brand's declared field is what a bottom layer starts from.
    expect(rootData(atl.seedFor(story("default"), registry))).toEqual({ tagline: "Karibu" });
    expect(rootData(atl.seedFor(story("east"), registry))).toEqual({ tagline: "Karibu" });
    expect(rootData(atl.seedFor(story("kenya"), registry))).toEqual({});
    // Without the registry a layer's seed is not guessed.
    expect(() => atl.seedFor(story("kenya"))).toThrow(/seeds by its chain/);
    // Not a layer: the id alone answers.
    expect(rootData(atl.seedFor({ id: "sty_x", type: "page", title: "X" }))).toMatchObject({
      title: "X",
    });
  });
});

/* ------------------------------------------------------------------ fence --- */

describe("the fence: a row of no configured brand serves nothing", () => {
  it("leaves null-brand and unconfigured-brand rows out of the snapshot", async () => {
    const registry = await rt.sites!.registry(env);
    const ids = registry.sites.map((s) => s.id);
    expect(ids).toContain("kenya");
    expect(ids).toContain("harbour");
    expect(ids).not.toContain("orphan");
    expect(ids).not.toContain("ghost");
    expect(registry.sites.every((s) => s.brand !== null)).toBe(true);
  });

  it("answers ~<scope> of such a row with 404, as an unknown scope", async () => {
    for (const scope of ["orphan", "ghost", "zulu"]) {
      const res = await call("/probe", { scope });
      expect(res.status, scope).toBe(404);
      expect(errorOf(res.body)?.message).toBe(`No site or group '${scope}'`);
    }
  });

  it("sets c.var.brand from the scope, else the gated site, and never a default", async () => {
    expect((await call("/probe", { scope: "kenya" })).body).toEqual({
      scope: "kenya",
      brand: { id: "atlas", label: "Atlas Guides" },
      has: true,
    });
    expect((await call("/probe", { site: "harbour" })).body.brand).toEqual({
      id: "harbour",
      label: "Harbour Travel",
    });
    // No scope and no site: no brand at all, not the first one.
    expect((await call("/probe")).body).toEqual({ scope: null, brand: null, has: false });
    // A site header naming a row the snapshot left out is no brand either.
    expect((await call("/probe", { site: "orphan" })).body.has).toBe(false);
  });

  it("refuses a brand’s render or query for another brand’s site, or for none", async () => {
    const registry = await rt.sites!.registry(env);
    const tango = registry.sites.find((s) => s.id === "harbour")!;
    const atl = rt.brands.get("atlas")!;
    const b = { ...bindings(env), db: env.DB };
    await expect(
      atl.resolve(b, undefined, {
        site: { site: tango, surface: "live", chain: chain(registry, "harbour") },
      }),
    ).rejects.toThrow(/brand 'atlas' cannot resolve site 'harbour'/);
    await expect(atl.resolve(b)).rejects.toThrow(/cannot resolve with no site/);
    await expect(atl.query(b, { type: "page" }, ["harbour"], tango)).rejects.toThrow(
      /cannot query site 'harbour'/,
    );
  });
});

/* ----------------------------------------------------------- credentials --- */

describe("a grant or a token binding names only a scope the snapshot serves", () => {
  it("refuses to bind a token to shared, or to a row of no configured brand", async () => {
    for (const site of ["shared", "orphan", "ghost"]) {
      const res = await call("/api/tokens", {
        method: "POST",
        body: { name: `t-${site}`, scopes: ["content:read"], site },
      });
      expect(res.status, site).toBe(400);
      expect(errorOf(res.body)?.message).toBe(`site names '${site}', which is not a site or group`);
    }
    const ok = await call("/api/tokens", {
      method: "POST",
      body: { name: "t-kenya", scopes: ["content:read"], site: "kenya" },
    });
    expect(ok.status).toBe(201);
  });

  it("refuses a grant on shared, or on a row of no configured brand", async () => {
    for (const scope of ["shared", "orphan", "ghost"]) {
      const res = await call("/api/users", {
        method: "POST",
        body: { email: `${scope}@x.example`, grants: { [scope]: "editor" } },
      });
      expect(res.status, scope).toBe(400);
      expect(errorOf(res.body)?.message).toBe(
        `grants names '${scope}', which is not a site or group`,
      );
    }
    const ok = await call("/api/users", {
      method: "POST",
      body: { email: "kenya@x.example", grants: { kenya: "editor" } },
    });
    expect(ok.status).toBe(201);
  });
});

/* ------------------------------------------------------------------ routes --- */

/**
 * Phase 4a: every route reads its registry from `c.var.brand`. The whole app over
 * `createRuntime` (not `createFolio`, whose entry points are phase 4b's), on two
 * scopes of my own so the sections above cannot have moved them. Each brand has a
 * type the other lacks, and the block names `pageRoot` and `prose` are shared.
 */
describe("the routes read the scope’s brand (decision 6)", () => {
  const atlMigration = defineMigration({
    id: "atlas/0001-noop",
    description: "stamps atlas documents",
    up: () => [],
  });
  const hbrMigration = defineMigration({
    id: "harbour/0001-noop",
    description: "stamps harbour documents",
    up: () => [],
  });
  const routeBrands: Record<string, FolioBrand<Cloudflare.Env>> = {
    atlas: {
      ...brands.atlas!,
      types: [...atlTypes, { name: "article", label: "Article", kind: "page", root: "pageRoot" }],
      migrations: [atlMigration],
    },
    harbour: {
      ...brands.harbour!,
      types: [...hbrTypes, { name: "landing", label: "Landing", kind: "page", root: "pageRoot" }],
      migrations: [hbrMigration],
    },
  };
  const routeConfig: FolioConfig<Cloudflare.Env> = { ...config, brands: routeBrands };
  const routeRt = createRuntime(routeConfig);
  const routeApp = createApp(routeConfig, routeRt);

  const ATL = "r-atl";
  const HBR = "r-hbr";

  async function api(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      scope?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers = new Headers({
      "content-type": "application/json",
      ...(await auth()),
      ...(init.headers ?? {}),
    });
    if (init.scope) headers.set(SCOPE_HEADER, init.scope);
    const res = await routeApp.request(
      `${ADMIN}/folio${path}`,
      {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      env,
      createExecutionContext(),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
           ('${ATL}', 'site', 'Routes ATL', null, 'live', null, 'atlas', 0, 0),
           ('${HBR}', 'site', 'Routes HBR', null, 'live', null, 'harbour', 0, 0)`,
      ),
      env.DB.prepare(
        `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id)
         values ('sty_r_atl', 'page', null, 'home', 'home', 'a0', 'ATL home', 1, '${ATL}'),
                ('sty_r_hbr', 'page', null, 'home', 'home', 'a0', 'HBR home', 1, '${HBR}')`,
      ),
    ]);
    routeRt.sites?.drop();
  });

  it("creates a document of the scope’s own types, and refuses the other brand’s", async () => {
    const own = await api("/api/stories", {
      method: "POST",
      scope: ATL,
      body: { type: "article", title: "A story" },
    });
    expect(own.status).toBe(200);
    expect(own.body.type).toBe("article");
    expect(own.body.site).toBe(ATL);

    const wrong = await api("/api/stories", {
      method: "POST",
      scope: HBR,
      body: { type: "article", title: "Not here" },
    });
    expect(wrong.status).toBe(501);
    expect(errorOf(wrong.body)?.message).toBe("Unknown document type: article");

    const hbr = await api("/api/stories", {
      method: "POST",
      scope: HBR,
      body: { type: "landing", title: "Landing" },
    });
    expect(hbr.status).toBe(200);
    const back = await api("/api/stories", {
      method: "POST",
      scope: ATL,
      body: { type: "landing", title: "Not here either" },
    });
    expect(back.status).toBe(501);
  });

  it("does the same through the versioned API", async () => {
    const own = await api("/api/v1/documents", {
      method: "POST",
      scope: HBR,
      body: { type: "landing", title: "v1 landing" },
    });
    expect(own.status).toBe(201);
    const wrong = await api("/api/v1/documents", {
      method: "POST",
      scope: HBR,
      body: { type: "article", title: "v1 wrong" },
    });
    expect(wrong.status).toBe(501);
    // The draft is read against the brand's own schema: `heading` is harbour's
    // `pageRoot` field, and `strap` is atlas's.
    const put = await api(`/api/v1/documents/${own.body.id}/content`, {
      method: "PUT",
      scope: HBR,
      body: { content: { fields: { heading: "Hello" } } },
    });
    expect(put.status).toBe(200);
    const refused = await api(`/api/v1/documents/${own.body.id}/content`, {
      method: "PUT",
      scope: HBR,
      body: { content: { fields: { strap: "Not a harbour field" } } },
    });
    expect(refused.status).toBe(400);
  });

  it("answers each scope’s blocks and types only from the schema routes", async () => {
    const names = (m: Record<string, unknown>) =>
      (m.blocks as { name: string }[]).map((b) => b.name);
    const typeNames = (m: Record<string, unknown>) =>
      (m.types as { name: string }[]).map((t) => t.name);
    const atl = await api("/api/schema", { scope: ATL });
    const hbr = await api("/api/schema", { scope: HBR });
    expect(names(atl.body).sort()).toEqual(["header", "pageRoot", "prose"]);
    expect(names(hbr.body).sort()).toEqual(["pageRoot", "prose"]);
    expect(typeNames(atl.body)).toContain("article");
    expect(typeNames(atl.body)).not.toContain("landing");
    expect(typeNames(hbr.body)).toContain("landing");
    expect(typeNames(hbr.body)).not.toContain("article");
    // A block name both brands declare answers each brand's own fields.
    const fieldsOf = (m: Record<string, unknown>) =>
      Object.keys(
        (m.blocks as { name: string; fields: object }[]).find((b) => b.name === "pageRoot")!.fields,
      );
    expect(fieldsOf(atl.body).sort()).toEqual(["strap", "title"]);
    expect(fieldsOf(hbr.body)).toEqual(["heading"]);

    const v1 = await api("/api/v1/schema", { scope: HBR });
    expect(names(v1.body).sort()).toEqual(["pageRoot", "prose"]);
    // Unscoped on a branded deployment there is no brand to answer for, and none is chosen.
    const bare = await api("/api/v1/schema");
    expect(bare.status).toBe(400);
    expect(bare.body.blocks).toBeUndefined();
  });

  it("describes the scope’s brand’s types and blocks in MCP, and no other’s", async () => {
    const list = async (scope: string | undefined) => {
      const params = {};
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/list",
        ...(await auth()),
      };
      if (scope) headers[SCOPE_HEADER] = scope;
      const res = await routeApp.request(
        `${ADMIN}/folio/mcp`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params }),
        },
        env,
        createExecutionContext(),
      );
      if (!scope) return { status: res.status, text: "" };
      expect(res.status).toBe(200);
      const answer = (await res.json()) as {
        result: { tools: { name: string; description: string }[] };
      };
      return { status: 200, text: answer.result.tools.map((t) => t.description).join("\n") };
    };
    const atl = (await list(ATL)).text;
    const hbr = (await list(HBR)).text;
    expect(atl).toContain("article");
    expect(atl).toContain("header");
    expect(atl).not.toContain("landing");
    expect(hbr).toContain("landing");
    expect(hbr).not.toContain("article");
    expect(hbr).not.toContain("header");
    // MCP names the site first: no scope, no brand, and no list of anyone's types.
    expect((await list(undefined)).status).toBe(400);
  });

  it("keeps a form of one brand out of the other’s scope", async () => {
    const made = await api("/api/forms", {
      method: "POST",
      scope: ATL,
      body: { label: "Enquiry" },
    });
    expect(made.status).toBe(201);
    const id = ((made.body.form ?? made.body) as { id: string }).id;
    expect((await api(`/api/forms/${id}`, { scope: ATL })).status).toBe(200);
    expect((await api(`/api/forms/${id}`, { scope: HBR })).status).toBe(404);
    const listed = await api("/api/forms", { scope: HBR });
    expect(JSON.stringify(listed.body)).not.toContain(id);
  });

  it("runs a migration on one brand’s scopes and leaves the other’s documents alone", async () => {
    const status = await api("/api/migrations", { scope: ATL });
    expect(status.body.pending).toEqual(["atlas/0001-noop"]);

    const run = await api("/api/migrate", { method: "POST", scope: ATL, body: {} });
    expect(run.status).toBe(200);
    const stamp = async (id: string) =>
      (
        await env.DB.prepare("select schema_id as s from stories where id = ?")
          .bind(id)
          .first<{ s: string | null }>()
      )?.s;
    expect(await stamp("sty_r_atl")).toBe("atlas/0001-noop");
    expect(await stamp("sty_r_hbr")).toBeNull();
  });
});

/* --------------------------------------- the admin and agent surfaces (phase 7) --- */

describe("the admin and agent surfaces (decisions 12, 16, 19, 20)", () => {
  const P_ATL = "p7-atl";
  const P_HBR = "p7-hbr";

  /** Every hook payload, by event, in the order fired. `await` so a route has fired them by its answer. */
  const fired: { event: string; payload: Record<string, unknown> }[] = [];
  const record =
    (event: string) =>
    (payload: unknown): void => {
      fired.push({ event, payload: payload as Record<string, unknown> });
    };

  const p7Brands: Record<string, FolioBrand<Cloudflare.Env>> = {
    atlas: {
      ...brands.atlas!,
      settings: "header",
      migrations: [
        defineMigration({
          id: "atlas/0002-p7-title",
          description: "title defaults",
          up: (_doc, ctx) => ctx.each("pageRoot", (b) => field.default(b, "title", "Untitled")),
        }),
      ],
    },
    harbour: {
      ...brands.harbour!,
      migrations: [
        defineMigration({
          id: "harbour/0002-p7-heading",
          description: "heading defaults",
          up: (_doc, ctx) => ctx.each("pageRoot", (b) => field.default(b, "heading", "Untitled")),
        }),
      ],
    },
  };
  const p7Config: FolioConfig<Cloudflare.Env> = {
    ...config,
    brands: p7Brands,
    // No `sites.settings`: with brands it belongs to a brand.
    hooks: {
      await: ["created", "migrated", "reindexed", "siteChanged"],
      created: record("created"),
      migrated: record("migrated"),
      reindexed: record("reindexed"),
      siteChanged: record("siteChanged"),
    },
  };
  const p7Rt = createRuntime(p7Config);
  const p7App = createApp(p7Config, p7Rt);
  const openConfig: FolioConfig<Cloudflare.Env> = { ...p7Config, auth: "open", hooks: undefined };
  const openApp = createApp(openConfig, createRuntime(openConfig));

  async function api(
    path: string,
    init: { method?: string; body?: unknown; scope?: string; on?: typeof p7App } = {},
  ) {
    const headers = new Headers({ "content-type": "application/json", ...(await auth()) });
    if (init.scope) headers.set(SCOPE_HEADER, init.scope);
    const res = await (init.on ?? p7App).request(
      `${ADMIN}/folio${path}`,
      {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      env,
      createExecutionContext(),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
           ('${P_ATL}', 'site', 'P7 ATL', null, 'live', null, 'atlas', 0, 0),
           ('${P_HBR}', 'site', 'P7 HBR', null, 'live', null, 'harbour', 0, 0)`,
      ),
      // One published document each, for the sweeps whose hooks fire only when a
      // published snapshot was rewritten or reindexed.
      env.DB.prepare(
        `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                              published_doc, published_at)
         values ('sty_p7_atl', 'page', null, 'home', 'home', 'a0', 'Home', 1, '${P_ATL}', ?, 2),
                ('sty_p7_hbr', 'page', null, 'home', 'home', 'a0', 'Home', 1, '${P_HBR}', ?, 2)`,
      ).bind(
        JSON.stringify({
          root: "r0",
          bloks: {
            r0: { uid: "r0", type: "pageRoot", parent: null, slot: null, order: "a0", data: {} },
          },
        }),
        JSON.stringify({
          root: "r0",
          bloks: {
            r0: { uid: "r0", type: "pageRoot", parent: null, slot: null, order: "a0", data: {} },
          },
        }),
      ),
    ]);
    p7Rt.sites?.drop();
  });

  describe("the manifest (decision 12)", () => {
    it("is the scope’s brand’s, with the brand and its settings type", async () => {
      const atl = await api("/api/schema", { scope: P_ATL });
      const hbr = await api("/api/schema", { scope: P_HBR });
      expect(atl.body.brand).toEqual({ id: "atlas", label: "Atlas Guides" });
      expect(atl.body.settings).toBe("header");
      expect(hbr.body.brand).toEqual({ id: "harbour", label: "Harbour Travel" });
      // A brand that declares no settings type carries no key.
      expect("settings" in hbr.body).toBe(false);
    });

    it("is neutral with no scope: no types, blocks or globals, and the deployment’s own hooks", async () => {
      const bare = await api("/api/schema");
      expect(bare.status).toBe(200);
      expect(bare.body).toMatchObject({ types: [], blocks: [], globals: [] });
      expect("brand" in bare.body).toBe(false);
      expect("settings" in bare.body).toBe(false);
      // Same as every brand's: `hooks` is the deployment's, not a brand's.
      const scoped = await api("/api/schema", { scope: P_HBR });
      expect(bare.body.hooks).toEqual(scoped.body.hooks);
      expect((bare.body.hooks as { declared: string[] }).declared).toContain("created");
    });

    it("carries no brand or settings on a deployment without brands", async () => {
      const single: FolioConfig<Cloudflare.Env> = {
        blocks: [atlRoot, atlProse, atlHeader],
        types: atlTypes,
        sites: { admin: ADMIN, settings: "header" },
        bindings,
        basePath: "/folio",
        auth: config.auth,
        route: config.route,
      };
      const on = createApp(single, createRuntime(single));
      const res = await api("/api/schema", { on });
      expect(res.status).toBe(200);
      expect("brand" in res.body).toBe(false);
      expect("settings" in res.body).toBe(false);
      expect((res.body.types as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe("the versioned schema (decisions 12 and 19)", () => {
    it("adds the scope and its brand when scoped", async () => {
      const res = await api("/api/v1/schema", { scope: P_HBR });
      expect(res.status).toBe(200);
      expect(res.body.scope).toEqual({
        id: P_HBR,
        name: "P7 HBR",
        kind: "site",
        brand: { id: "harbour", label: "Harbour Travel" },
      });
    });

    it("is 400 site_required unscoped, and names no brand’s types or blocks", async () => {
      const res = await api("/api/v1/schema");
      expect(res.status).toBe(400);
      expect(errorOf(res.body)?.code).toBe("site_required");
      expect(res.body.types).toBeUndefined();
      expect(res.body.blocks).toBeUndefined();
    });

    it("is 400 site_required for the other unscoped routes that need a registry", async () => {
      for (const path of ["/api/migrations", "/api/audit"]) {
        const res = await api(path);
        expect(res.status, path).toBe(400);
        expect(errorOf(res.body)?.code, path).toBe("site_required");
      }
    });

    it("adds a scope with brand null on a single-brand multi-site deployment", async () => {
      const single: FolioConfig<Cloudflare.Env> = {
        blocks: [atlRoot, atlProse, atlHeader],
        types: atlTypes,
        sites: { admin: ADMIN },
        bindings,
        basePath: "/folio",
        auth: config.auth,
        route: config.route,
      };
      const on = createApp(single, createRuntime(single));
      const res = await api("/api/v1/schema", { on, scope: "shared" });
      expect(res.status).toBe(200);
      expect(res.body.scope).toEqual({ id: "shared", name: "Shared", kind: "shared", brand: null });
    });
  });

  describe("an unscoped route that picks a brand needs the caller to reach the scope", () => {
    const bearer = async (site: string | null) => ({
      authorization: `Bearer ${(await createToken(env.DB, { name: `l1-${site}`, scopes: ["content:read"], site })).token}`,
    });
    const get = async (path: string, scope: string, headers: Record<string, string>) => {
      const res = await p7App.request(
        `${ADMIN}/folio${path}`,
        { headers: { ...headers, [SCOPE_HEADER]: scope } },
        env,
        createExecutionContext(),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const PATHS = ["/api/v1/schema", "/api/migrations", "/api/assets/describe"];

    it("refuses a token bound to one brand’s site on another brand’s scope", async () => {
      const bound = await bearer(P_ATL);
      for (const path of PATHS) {
        const res = await get(path, P_HBR, bound);
        expect(res.status, path).toBe(403);
        expect(res.body.types, path).toBeUndefined();
      }
    });

    it("still answers that token on its own scope, and an unbound one on either", async () => {
      const bound = await bearer(P_ATL);
      expect((await get("/api/v1/schema", P_ATL, bound)).status).toBe(200);
      const unbound = await bearer(null);
      expect((await get("/api/v1/schema", P_HBR, unbound)).status).toBe(200);
      expect((await get("/api/v1/schema", P_ATL, unbound)).status).toBe(200);
    });
  });

  describe("/me (decision 20)", () => {
    it("carries each scope’s brand and the brand list, no shared, and no settings type", async () => {
      const me = (await api("/api/me", { on: openApp, scope: P_HBR })).body as {
        sites: {
          settings: string | null;
          brands: { id: string; label: string }[];
          scopes: { id: string; kind: string; brand: { id: string; label: string } | null }[];
        };
      };
      expect(me.sites.settings).toBeNull();
      expect(me.sites.brands).toEqual([
        { id: "atlas", label: "Atlas Guides" },
        { id: "harbour", label: "Harbour Travel" },
      ]);
      expect(me.sites.scopes.some((s) => s.kind === "shared")).toBe(false);
      expect(me.sites.scopes.find((s) => s.id === P_HBR)?.brand).toEqual({
        id: "harbour",
        label: "Harbour Travel",
      });
      expect(me.sites.scopes.find((s) => s.id === P_ATL)?.brand?.id).toBe("atlas");
    });

    it("answers with no scope too", async () => {
      const res = await api("/api/me", { on: openApp });
      expect(res.status).toBe(200);
      expect((res.body.sites as { settings: string | null }).settings).toBeNull();
    });
  });

  describe("the MCP instructions (decision 19)", () => {
    const discover = async (scope: string | undefined) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "server/discover",
        ...(await auth()),
      };
      if (scope) headers[SCOPE_HEADER] = scope;
      const res = await p7App.request(
        `${ADMIN}/folio/mcp`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
        },
        env,
        createExecutionContext(),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const instructions = async (scope: string) =>
      ((await discover(scope)).body.result as { instructions: string }).instructions;

    it("names the site and the brand, and says other brands are not visible", async () => {
      const text = await instructions(P_HBR);
      expect(text).toContain(
        `This session is scoped to site 'P7 HBR' (\`${P_HBR}\`) of brand 'Harbour Travel'`,
      );
      expect(text).toContain("documents, types and blocks of other brands are not visible");
      expect(text).toContain("get_schema describes this brand only");
      expect(await instructions(P_ATL)).toContain("of brand 'Atlas Guides'");
    });

    it("names the site alone on a multi-site deployment without brands", async () => {
      const single: FolioConfig<Cloudflare.Env> = {
        blocks: [atlRoot, atlProse, atlHeader],
        types: atlTypes,
        sites: { admin: ADMIN },
        bindings,
        basePath: "/folio",
        auth: config.auth,
        route: config.route,
      };
      const on = createApp(single, createRuntime(single));
      const res = await on.request(
        `${ADMIN}/folio/mcp`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            "mcp-method": "server/discover",
            ...(await auth()),
            [SCOPE_HEADER]: P_HBR,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
        },
        env,
        createExecutionContext(),
      );
      const text = ((await res.json()) as { result: { instructions: string } }).result.instructions;
      expect(text).toContain(`This session is scoped to site 'P7 HBR' (\`${P_HBR}\`).`);
      expect(text).not.toContain("brand");
    });

    it("keeps the three sentences every session gets", async () => {
      const text = await instructions(P_HBR);
      expect(text).toContain("call get_schema first");
      expect(text).toContain("undoable");
    });
  });

  describe("hooks are told the brand (decision 16)", () => {
    it("created carries the brand of the scope it happened in", async () => {
      fired.length = 0;
      expect(
        (await api("/api/stories", { method: "POST", scope: P_HBR, body: { title: "Made" } }))
          .status,
      ).toBe(200);
      expect(
        (await api("/api/stories", { method: "POST", scope: P_ATL, body: { title: "Made" } }))
          .status,
      ).toBe(200);
      const created = fired.filter((f) => f.event === "created");
      expect(created.map((f) => [f.payload.site, f.payload.brand])).toEqual([
        [P_HBR, "harbour"],
        [P_ATL, "atlas"],
      ]);
    });

    it("migrated and reindexed carry the brand they ran for", async () => {
      fired.length = 0;
      expect((await api("/api/migrate", { method: "POST", scope: P_HBR, body: {} })).status).toBe(
        200,
      );
      expect((await api("/api/reindex", { method: "POST", scope: P_ATL, body: {} })).status).toBe(
        200,
      );
      const brandsOf = (event: string) =>
        fired.filter((f) => f.event === event).map((f) => f.payload.brand);
      expect(brandsOf("migrated")).toEqual(["harbour"]);
      expect(brandsOf("reindexed")).toEqual(["atlas"]);
    });

    it("siteChanged carries the row’s brand, including on a delete", async () => {
      fired.length = 0;
      const made = await api("/api/sites", {
        method: "POST",
        body: { id: "p7-new", kind: "site", name: "New", brand: "harbour" },
      });
      expect(made.status).toBe(201);
      expect(made.body.brand).toBe("harbour");
      expect((await api("/api/sites/p7-new", { method: "DELETE" })).status).toBe(200);
      expect(
        fired
          .filter((f) => f.event === "siteChanged")
          .map((f) => [f.payload.change, f.payload.brand]),
      ).toEqual([
        ["created", "harbour"],
        ["deleted", "harbour"],
      ]);
    });
  });
});
