import { createExecutionContext, env } from "cloudflare:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server.browser";
import { beforeAll, describe, expect, it } from "vitest";
import { blocks, defineBlock, reference, text } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import { defineMigration, field } from "../../src/core/migrate";
import type { DocumentType } from "../../src/core/schema";
import type {
  AuditReport,
  FolioBindings,
  FolioBrand,
  FolioConfig,
  MigrateReport,
  ReindexReport,
} from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { MCP_PROTOCOL_VERSION } from "../../src/server/mcp/rpc";
import { createToken } from "../../src/server/auth/tokens";

/**
 * Many brands in one deployment, phase 4b (`docs/specs/foundation/multi-brand.md`
 * decisions 6, 10, 16 and 21): every entry point that is off a request reaches its
 * registry through the brand of the site it serves, built through `createFolio`.
 *
 * Two brands that collide on the block names `pageRoot`, `prose` and
 * `settingsRoot` and the type names `page` and `siteSettings`, with different
 * fields, as atlas and harbour do. Brand `atlas` owns `default`
 * (set by SQL, as `UPGRADING.md` says), group `east` and its site `kenya`; brand
 * `harbour` owns the site `harbour`. Each site has a live host and a preview
 * origin, and `auth: 'open'` lets every preview origin show drafts, so the render
 * paths are exercised without a grant.
 */

const atlRoot = defineBlock({
  name: "pageRoot",
  label: "Page",
  fields: {
    title: text({ indexed: true, default: "Karibu" }),
    strap: text(),
    body: blocks({ allow: ["prose"] }),
  },
  render: ({ title, body }) => h("main", { "data-brand": "atl" }, h("h1", null, title), body),
});
const atlProse = defineBlock({
  name: "prose",
  label: "Prose",
  fields: { words: text(), lang: text() },
  render: ({ words }) => h("p", { "data-prose": "atl" }, words),
});
const atlHeader = defineBlock({
  name: "header",
  label: "Header",
  fields: { tagline: text(), feature: reference() },
  render: ({ tagline, feature }) =>
    h(
      "header",
      null,
      tagline,
      h("nav", { "data-ref": (feature as { title?: string } | null)?.title ?? "UNRESOLVED" }),
    ),
});
const atlSettings = defineBlock({
  name: "settingsRoot",
  label: "Settings",
  fields: { colour: text() },
  render: ({ colour }) => h("dl", { "data-settings": "atl" }, colour),
});

const hbrRoot = defineBlock({
  name: "pageRoot",
  label: "Page",
  fields: {
    heading: text({ indexed: true, default: "CRM" }),
    body: blocks({ allow: ["prose"] }),
  },
  render: ({ heading, body }) => h("main", { "data-brand": "hbr" }, h("h2", null, heading), body),
});
const hbrProse = defineBlock({
  name: "prose",
  label: "Prose",
  fields: { copy: text(), tone: text() },
  render: ({ copy }) => h("p", { "data-prose": "hbr" }, copy),
});
const hbrSettings = defineBlock({
  name: "settingsRoot",
  label: "Settings",
  fields: { motto: text() },
  render: ({ motto }) => h("dl", { "data-settings": "hbr" }, motto),
});

const atlTypes: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
  { name: "header", label: "Header", kind: "singleton", root: "header" },
  { name: "siteSettings", label: "Settings", kind: "singleton", root: "settingsRoot" },
];
const hbrTypes: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
  { name: "siteSettings", label: "Settings", kind: "singleton", root: "settingsRoot" },
];

/** Each brand's migration touches `prose`, the block name both brands declare. */
const ATL_MIGRATION = defineMigration({
  id: "atlas/0001-prose-lang",
  description: "prose.lang defaults to sw",
  up: (_doc, ctx) => ctx.each("prose", (b) => field.default(b, "lang", "sw")),
});
const HBR_MIGRATION = defineMigration({
  id: "harbour/0001-prose-tone",
  description: "prose.tone defaults to warm",
  up: (_doc, ctx) => ctx.each("prose", (b) => field.default(b, "tone", "warm")),
});

/** Text that must never leave the gated v1 `/schema`. */
const HBR_VOICE = "HBR-VOICE-7f3a: warm, second person. Never mention the Smith account.";
const HBR_WRITING = {
  voice: HBR_VOICE,
  avoid: [{ term: "Smith account", use: "a client", reason: "Confidential." }],
};

const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
  atlas: {
    label: "Atlas Guides",
    blocks: [atlRoot, atlProse, atlHeader, atlSettings],
    types: atlTypes,
    globals: ["header"],
    settings: "siteSettings",
    previewCss: ["/atl-global.css"],
    migrations: [ATL_MIGRATION],
    describe: { fn: async () => ({ alt: "ATL ALT" }) },
  },
  harbour: {
    label: "Harbour Travel",
    blocks: [hbrRoot, hbrProse, hbrSettings],
    types: hbrTypes,
    settings: "siteSettings",
    previewCss: ["/hbr-global.css"],
    migrations: [HBR_MIGRATION],
    describe: { fn: async () => ({ alt: "HBR ALT" }) },
    // `authoring-guidance.md` decision 6: one brand with a guide, one without.
    writing: HBR_WRITING,
  },
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
  auth: "open",
  logger: { warn: () => {}, error: console.error },
  assets: {
    admin: "/folio-admin.js",
    brands: {
      atlas: {
        preview: "/folio-preview-atlas.js",
        previewCss: ["/folio-preview-atlas.css"],
      },
      harbour: {
        preview: "/folio-preview-harbour.js",
        previewCss: ["/folio-preview-harbour.css"],
      },
    },
  },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : "/",
};

// The construction test below builds this: phase 3 left `registry: rt.registry`
// reading a throwing getter here.
const folio = createFolio(config);

const blok = (
  uid: string,
  type: string,
  data: Record<string, Json>,
  parent: string | null = null,
  slot: string | null = null,
) => ({ uid, type, parent, slot, order: "a0", data });

const atlPage = (title: string, words: string): Doc => ({
  root: "r0",
  bloks: {
    r0: blok("r0", "pageRoot", { title }),
    p0: blok("p0", "prose", { words }, "r0", "body"),
  },
});
const hbrPage = (heading: string, copy: string): Doc => ({
  root: "r0",
  bloks: {
    r0: blok("r0", "pageRoot", { heading }),
    p0: blok("p0", "prose", { copy }, "r0", "body"),
  },
});
const rootOnly = (type: string, data: Record<string, Json>): Doc => ({
  root: "r0",
  bloks: { r0: blok("r0", type, data) },
});

async function row(
  id: string,
  site: string,
  type: string,
  path: string | null,
  title: string,
  doc: Doc | null,
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, ?, null, ?, ?, 'a0', ?, 1000, ?, ?, ?)`,
  )
    .bind(
      id,
      type,
      path ?? type,
      path,
      title,
      site,
      doc ? JSON.stringify(doc) : null,
      doc ? 2000 : null,
    )
    .run();
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("update sites set brand = 'atlas' where id = 'default'"),
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
         ('east', 'group', 'East', null, null, null, 'atlas', 0, 0),
         ('kenya', 'site', 'Kenya', 'east', 'live', 'https://preview.kenya.example', 'atlas', 0, 0),
         ('harbour', 'site', 'Harbour Travel', null, 'live', 'https://preview.harbour.example', 'harbour', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('kenya.example', 'kenya'), ('harbour.example', 'harbour')`,
    ),
  ]);
  await row("sty_atl_home", "kenya", "page", "home", "Home", atlPage("Karibu Kenya", "Hello"));
  await row("sty_hbr_home", "harbour", "page", "home", "Home", hbrPage("CRM", "Safari"));
  await row(
    "sng_siteSettings:east",
    "east",
    "siteSettings",
    null,
    "Settings",
    rootOnly("settingsRoot", { colour: "ochre" }),
  );
  await row(
    "sng_siteSettings:harbour",
    "harbour",
    "siteSettings",
    null,
    "Settings",
    rootOnly("settingsRoot", { motto: "Twende" }),
  );
});

const live = (host: string, path = "/home") => new Request(`https://${host}${path}`);

/* ------------------------------------------------------------ construction --- */

describe("construction and the registry", () => {
  it("constructs, and folio.registry throws rather than answer the first brand", () => {
    expect(folio).toBeDefined();
    expect(() => folio.registry).toThrow(/folio\.registry has no brand/);
  });

  it("answers each brand's registry from registryFor, and refuses an unconfigured brand", () => {
    expect(Object.keys(folio.registryFor("atlas").pageRoot!.fields ?? {})).toEqual([
      "title",
      "strap",
      "body",
    ]);
    expect(Object.keys(folio.registryFor("harbour").pageRoot!.fields ?? {})).toEqual([
      "heading",
      "body",
    ]);
    expect(() => folio.registryFor("retired")).toThrow(/registryFor\('retired'\) names no brand/);
  });

  it("keeps folio.registry on a single-brand deployment, where registryFor has no brand to name", () => {
    const single = createFolio<Cloudflare.Env>({
      blocks: [atlRoot, atlProse],
      root: "pageRoot",
      bindings,
      basePath: "/folio",
      auth: "open",
      route: (p) => (p ? `/${p}` : "/"),
    });
    expect(single.registry.pageRoot).toBe(atlRoot);
    expect(() => single.registryFor("atlas")).toThrow(/registryFor needs 'brands'/);
  });

  it("refuses a render with no resolution naming a site", () => {
    expect(() => folio.render(rootOnly("pageRoot", {}))).toThrow(/needs a resolution/);
    expect(() => folio.renderGlobal({ stories: {} } as never, "header")).toThrow(
      /needs a resolution/,
    );
  });

  it("still throws for folio.reader with no request and no site", () => {
    expect(() => folio.reader(env)).toThrow(/a read must say which site it is for/);
  });
});

/* ------------------------------------------------------------------ render --- */

describe("a published page", () => {
  it("renders each brand's page with that brand's registry", async () => {
    const kenya = await folio.reader(env, live("kenya.example")).page("home");
    const hbr = await folio.reader(env, live("harbour.example")).page("home");
    expect(kenya?.resolution.site?.brand).toBe("atlas");
    expect(hbr?.resolution.site?.brand).toBe("harbour");

    const kenyaHtml = renderToString(folio.render(kenya!.doc, { resolution: kenya!.resolution }));
    const hbrHtml = renderToString(folio.render(hbr!.doc, { resolution: hbr!.resolution }));
    expect(kenyaHtml).toContain('<main data-brand="atl"><h1>Karibu Kenya</h1>');
    expect(kenyaHtml).toContain('<p data-prose="atl">Hello</p>');
    expect(hbrHtml).toContain('<main data-brand="hbr"><h2>CRM</h2>');
    expect(hbrHtml).toContain('<p data-prose="hbr">Safari</p>');
    expect(hbrHtml).not.toContain('data-brand="atl"');
  });

  it("answers folio.settings with the resolution's brand's settings", async () => {
    const kenya = await folio.reader(env, live("kenya.example")).page("home");
    const hbr = await folio.reader(env, live("harbour.example")).page("home");
    expect(folio.settings(kenya!.resolution)).toEqual({ colour: "ochre" });
    expect(folio.settings(hbr!.resolution)).toEqual({ motto: "Twende" });
  });

  it("reads a brand's global through its own reader, and none with no site", async () => {
    expect(await folio.reader(env, { site: "harbour" }).global("header")).toBeNull();
    const none = folio.reader(env, live("nowhere.example"));
    expect(await none.global("siteSettings")).toBeNull();
    expect(await none.page("home")).toBeNull();
    await expect(none.resolve(rootOnly("pageRoot", {}))).rejects.toThrow(/has no brand/);
  });
});

/* ------------------------------------------------------------------- draft --- */

describe("draft mode on a branded preview origin", () => {
  it("reads layers without creating a row", async () => {
    const count = async () =>
      (
        await env.DB.prepare(
          "select count(*) as n from stories where type in ('header', 'siteSettings')",
        ).first<{ n: number }>()
      )?.n;
    const before = await count();
    const req = new Request("https://preview.kenya.example/home", {
      headers: { cookie: "folio_draft=1" },
    });
    const page = await folio.reader(env, req).page("home");
    expect(page?.draft).toBe(true);
    // `sty_atl_home`'s object was never opened, so its draft is seeded from the
    // row's published document (#28), not from a blank under atlas's blocks.
    expect(page?.doc.bloks[page.doc.root]?.data.title).toBe("Karibu Kenya");
    expect(await count()).toBe(before);
    // No `sng_header` (the `default` layer ensureSingleton would make), nor kenya's.
    const header = await env.DB.prepare("select id from stories where id like 'sng_header%'").all();
    expect(header.results).toEqual([]);
  });
});

/* ----------------------------------------------------------------- preview --- */

describe("a harbour preview on harbour's preview origin", () => {
  it("renders with harbour's registry and links only harbour's assets", async () => {
    const draft = await folio.draft(env, "sty_hbr_home");
    await folio.write(
      env,
      "sty_hbr_home",
      [{ t: "set", uid: draft.root, field: "heading", value: "CRM Safari" }],
      { actor: "test" },
    );
    const res = (await folio.handle(
      new Request("https://preview.harbour.example/home?_folio=preview"),
      env,
      createExecutionContext(),
    )) as Response;
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<html lang="en" data-folio-brand="harbour">');
    expect(html).toContain('<main data-brand="hbr"');
    expect(html).toContain("CRM Safari");
    expect(html).not.toContain('data-brand="atl"');
    expect(html).toContain("/folio-preview-harbour.js");
    expect(html).toContain("/folio-preview-harbour.css");
    expect(html).toContain("/hbr-global.css");
    expect(html).not.toContain("atlas.js");
    expect(html).not.toContain("atlas.css");
    expect(html).not.toContain("/atl-global.css");
  });

  it("refuses ?as= for a global only the other brand declares", async () => {
    const res = await folio.handle(
      new Request("https://preview.harbour.example/home?_folio=preview&as=header"),
      env,
      createExecutionContext(),
    );
    expect(res).toBeNull();
  });
});

/* ------------------------------------------------------ the editor preview --- */

describe("the editor's bare global preview, per brand", () => {
  const bare = async (scope: string) => {
    const res = (await folio.handle(
      new Request(`${ADMIN}/folio/~${scope}/preview/global/siteSettings`),
      env,
      createExecutionContext(),
    )) as Response;
    return { status: res.status, html: await res.text() };
  };

  it("renders each brand's settings layer with that brand's blocks and bundle", async () => {
    const atl = await bare("east");
    expect(atl.status).toBe(200);
    expect(atl.html).toContain('<html lang="en" data-folio-brand="atlas">');
    expect(atl.html).toContain('data-settings="atl"');
    expect(atl.html).toContain("/folio-preview-atlas.js");
    expect(atl.html).not.toContain("harbour.js");

    const hbr = await bare("harbour");
    expect(hbr.status).toBe(200);
    expect(hbr.html).toContain('<html lang="en" data-folio-brand="harbour">');
    expect(hbr.html).toContain('data-settings="hbr"');
    expect(hbr.html).toContain("/folio-preview-harbour.js");
    expect(hbr.html).not.toContain("atlas.js");
  });
});

/* ------------------------------------------------------------ batch sweeps --- */

async function sweep<R extends { continueFrom: string | null }>(
  run: (continueFrom: string | null) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let cursor: string | null = null;
  do {
    const report: R = await run(cursor);
    out.push(report);
    cursor = report.continueFrom;
  } while (cursor !== null && out.length < 20);
  return out;
}

const publishedOf = async (id: string): Promise<Doc> => {
  const found = await env.DB.prepare("select published_doc from stories where id = ?")
    .bind(id)
    .first<{ published_doc: string }>();
  return JSON.parse(found!.published_doc) as Doc;
};

describe("migrate", () => {
  it("runs each brand's migrations over that brand's scopes only", async () => {
    const reports = await sweep<MigrateReport>((continueFrom) =>
      folio.migrate(env, { continueFrom }),
    );
    expect(reports.map((r) => r.brand)).toEqual(["atlas", "harbour"]);
    expect(reports[0]!.continueFrom).toBe("harbour/");
    const last = reports[reports.length - 1]!;
    expect(last.complete).toBe(true);
    expect(last.behind).toBe(0);

    // Both documents have a `prose`; each has only its own brand's migration.
    const atl = (await publishedOf("sty_atl_home")).bloks.p0!.data;
    const hbr = (await publishedOf("sty_hbr_home")).bloks.p0!.data;
    expect(atl).toEqual({ words: "Hello", lang: "sw" });
    expect(hbr).toEqual({ copy: "Safari", tone: "warm" });

    const stamps = await env.DB.prepare(
      "select id, schema_id as s from stories where id in ('sty_atl_home', 'sty_hbr_home') order by id",
    ).all<{ id: string; s: string }>();
    expect(stamps.results).toEqual([
      { id: "sty_atl_home", s: "atlas/0001-prose-lang" },
      { id: "sty_hbr_home", s: "harbour/0001-prose-tone" },
    ]);
    const ledger = await env.DB.prepare("select id from schema_migrations order by id").all();
    expect(ledger.results.map((r) => r.id)).toEqual([
      "atlas/0001-prose-lang",
      "harbour/0001-prose-tone",
    ]);

    // A second run is clean: neither brand's applied ids read as out of order to the other.
    const again = await sweep<MigrateReport>((continueFrom) =>
      folio.migrate(env, { continueFrom }),
    );
    expect(again.every((r) => r.changed === 0)).toBe(true);
    expect(again[again.length - 1]!.pending).toEqual([]);
  });

  it("refuses a cursor that names no brand", async () => {
    await expect(folio.migrate(env, { continueFrom: "sty_atl_home" })).rejects.toThrow(
      /names no brand/,
    );
  });
});

describe("reindex", () => {
  it("rebuilds each brand's documents with that brand's schema", async () => {
    await env.DB.prepare("delete from content_index").run();
    const reports = await sweep<ReindexReport>((continueFrom) =>
      folio.reindex(env, { continueFrom }),
    );
    expect(reports.map((r) => r.brand)).toEqual(["atlas", "harbour"]);
    // atlas's two published documents are its home and east's settings;
    // harbour's are its home and its settings.
    expect(reports.map((r) => r.documents)).toEqual([2, 2]);
    const rows = await env.DB.prepare(
      "select story_id as id, field, text_value as v from content_index where story_id in ('sty_atl_home', 'sty_hbr_home') order by story_id",
    ).all<{ id: string; field: string; v: string }>();
    expect(rows.results).toEqual([
      { id: "sty_atl_home", field: "title", v: "Karibu Kenya" },
      { id: "sty_hbr_home", field: "heading", v: "CRM" },
    ]);
  });
});

describe("audit", () => {
  it("audits each brand against its own schema, one brand per report", async () => {
    const reports = await sweep<AuditReport>((continueFrom) => folio.audit(env, { continueFrom }));
    expect(reports.map((r) => r.brand)).toEqual(["atlas", "harbour"]);
    // A document audited against the other brand's `pageRoot` would read every one
    // of its fields as an orphan key.
    for (const report of reports) {
      expect(report.orphanKeys).toEqual([]);
      expect(report.unknownTypes).toEqual([]);
    }
  });
});

describe("runSchedules", () => {
  it("publishes each story with its scope's brand's deps", async () => {
    await row("sty_atl_sched", "kenya", "page", "later", "Later", null);
    await row("sty_hbr_sched", "harbour", "page", "later", "Later", null);
    await env.DB.prepare(
      `insert into schedules (id, story_id, action, at, created_at) values
         ('sch_atl000000001', 'sty_atl_sched', 'publish', 5, 1),
         ('sch_hbr000000001', 'sty_hbr_sched', 'publish', 6, 1)`,
    ).run();

    const report = await folio.runSchedules(env, { now: 10 });
    expect(report.failed).toEqual([]);
    expect([...report.published].sort()).toEqual(["sty_atl_sched", "sty_hbr_sched"]);

    // Each projected with its own brand's schema: the seed's indexed field, which is
    // atlas's title (seeded from the story's) and harbour's heading.
    const rows = await env.DB.prepare(
      "select story_id as id, field, text_value as v from content_index where story_id in ('sty_atl_sched', 'sty_hbr_sched') order by story_id",
    ).all<{ id: string; field: string; v: string }>();
    expect(rows.results).toEqual([
      { id: "sty_atl_sched", field: "title", v: "Later" },
      { id: "sty_hbr_sched", field: "heading", v: "CRM" },
    ]);
  });

  it("fires through POST ~<scope>/api/schedules/run only the scope's brand's schedules", async () => {
    await row("sty_atl_run", "kenya", "page", "soon", "Soon", null);
    await row("sty_hbr_run", "harbour", "page", "soon", "Soon", null);
    await env.DB.prepare(
      `insert into schedules (id, story_id, action, at, created_at) values
         ('sch_atl000000002', 'sty_atl_run', 'publish', 5, 1),
         ('sch_hbr000000002', 'sty_hbr_run', 'publish', 6, 1)`,
    ).run();

    const res = (await folio.handle(
      new Request(`${ADMIN}/folio/~harbour/api/schedules/run`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ADMIN },
        body: "{}",
      }),
      env,
      createExecutionContext(),
    )) as Response;
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      published: string[];
      failed: unknown[];
      remaining: number;
    };
    expect(report.failed).toEqual([]);
    // The permission is harbour's, so atlas's due schedule is neither
    // fired nor counted.
    expect(report.published).toEqual(["sty_hbr_run"]);
    expect(report.remaining).toBe(0);
    const published = async (id: string) =>
      (
        await env.DB.prepare("select published_doc is not null as p from stories where id = ?")
          .bind(id)
          .first<{ p: number }>()
      )?.p;
    expect(await published("sty_hbr_run")).toBe(1);
    expect(await published("sty_atl_run")).toBe(0);

    // The cron's sweep still covers every brand.
    const cron = await folio.runSchedules(env);
    expect(cron.published).toEqual(["sty_atl_run"]);
    const rows = await env.DB.prepare(
      "select story_id as id, field, text_value as v from content_index where story_id in ('sty_atl_run', 'sty_hbr_run') order by story_id",
    ).all<{ id: string; field: string; v: string }>();
    expect(rows.results).toEqual([
      { id: "sty_atl_run", field: "title", v: "Soon" },
      { id: "sty_hbr_run", field: "heading", v: "CRM" },
    ]);
  });
});

/* ------------------------------------------------------------ review round --- */

const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  folio.handle(
    new Request(`${ADMIN}/folio${path}`, {
      ...init,
      headers: { "content-type": "application/json", origin: ADMIN, ...init.headers },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    }),
    env,
    createExecutionContext(),
  ) as Promise<Response>;

describe("the batched describe run, per brand", () => {
  const asset = async (id: string, site: string) => {
    await env.MEDIA.put(`${id}.png`, "PNGBYTES");
    await env.DB.prepare(
      `insert into assets (id, key, filename, content_type, size, width, height, alt, created_at, site_id)
       values (?, ?, ?, 'image/png', 8, 10, 10, '', 1, ?)`,
    )
      .bind(id, `${id}.png`, `${id}.png`, site)
      .run();
  };
  const altOf = async (id: string) =>
    (
      await env.DB.prepare("select alt_auto as a from assets where id = ?")
        .bind(id)
        .first<{ a: string }>()
    )?.a;

  it("counts, walks and describes only the request brand's assets", async () => {
    await asset("ast_atl00000001", "kenya");
    await asset("ast_hbr00000001", "harbour");

    // An explicit id of another brand's asset reads as absent: nothing describes it.
    const byId = await admin("/~harbour/api/assets/describe", {
      method: "POST",
      json: { selection: { ids: ["ast_atl00000001"] } },
    });
    expect(byId.status).toBe(200);
    expect(((await byId.json()) as { done: number }).done).toBe(0);
    expect(await altOf("ast_atl00000001")).toBe("");

    // The confirmed count is the brand's, not the deployment's.
    const wide = await admin("/~harbour/api/assets/describe", {
      method: "POST",
      json: { selection: { all: true, filter: {}, expected: 2 } },
    });
    expect(wide.status).toBe(409);
    const all = await admin("/~harbour/api/assets/describe", {
      method: "POST",
      json: { selection: { all: true, filter: {}, expected: 1 } },
    });
    expect(all.status).toBe(200);
    expect(((await all.json()) as { done: number }).done).toBe(1);
    expect(await altOf("ast_hbr00000001")).toBe("HBR ALT");
    expect(await altOf("ast_atl00000001")).toBe("");
  });
});

describe("a v1 read of a layer nobody has written", () => {
  it("makes no row on a preview origin; the first write does", async () => {
    const rows = async () =>
      (
        await env.DB.prepare(
          "select count(*) as n from stories where id = 'sng_header:kenya'",
        ).first<{ n: number }>()
      )?.n;
    const read = (await folio.handle(
      new Request("https://preview.kenya.example/folio/~kenya/api/v1/documents/sng_header:kenya"),
      env,
      createExecutionContext(),
    )) as Response;
    expect(read.status).toBe(404);
    expect(await rows()).toBe(0);

    const write = await admin("/~kenya/api/v1/documents/sng_header:kenya/fields", {
      method: "PATCH",
      json: { fields: {} },
    });
    expect(write.status).toBe(200);
    expect(await rows()).toBe(1);
  });
});

describe("the editor's bare preview of a group's layer", () => {
  it("resolves on the group's own chain, so its references resolve", async () => {
    await row("sty_east_page", "east", "page", "east-page", "East Page", atlPage("East", "x"));
    await row("sng_header:east", "east", "header", null, "Header", rootOnly("header", {}));
    const draft = await folio.draft(env, "sng_header:east");
    await folio.write(
      env,
      "sng_header:east",
      [
        { t: "set", uid: draft.root, field: "tagline", value: "Karibu" },
        { t: "set", uid: draft.root, field: "feature", value: "sty_east_page" },
      ],
      { actor: "test" },
    );
    const res = await admin("/~east/preview/global/header");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-ref="East Page"');
  });
});

describe("the migrate and reindex routes on a branded deployment", () => {
  it("name the brand they swept", async () => {
    const migrate = await admin("/~harbour/api/migrate", { method: "POST", json: {} });
    expect(migrate.status).toBe(200);
    expect(((await migrate.json()) as MigrateReport).brand).toBe("harbour");
    const reindexed = await admin("/~kenya/api/reindex", { method: "POST", json: {} });
    expect(reindexed.status).toBe(200);
    expect(((await reindexed.json()) as ReindexReport).brand).toBe("atlas");
  });
});

describe("a site-bound token at an unscoped URL", () => {
  const secured = createFolio({
    ...config,
    auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  } as FolioConfig<Cloudflare.Env>);
  const bearer = async (site: string | null) => {
    const { token } = await createToken(env.DB, {
      name: `bound-${site ?? "none"}`,
      scopes: ["content:read"],
      site,
    });
    return { authorization: `Bearer ${token}` };
  };
  const get = async (path: string, who: Record<string, string>, init: RequestInit = {}) =>
    (await secured.handle(
      new Request(`${ADMIN}/folio${path}`, { ...init, headers: { ...who, ...init.headers } }),
      env,
      createExecutionContext(),
    )) as Response;

  it("takes its binding's brand, over REST and in MCP's tool descriptions", async () => {
    const who = await bearer("harbour");
    const docs = await get("/api/v1/documents", who);
    expect(docs.status).toBe(200);
    expect(JSON.stringify(await docs.json())).toContain("sty_hbr_home");

    const schema = await get("/api/v1/schema", who);
    expect(schema.status).toBe(200);
    const blocks = ((await schema.json()) as { blocks: { name: string; fields: object }[] }).blocks;
    expect(Object.keys(blocks.find((b) => b.name === "pageRoot")!.fields)).toEqual([
      "heading",
      "body",
    ]);

    const list = await get("/mcp", who, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(list.status).toBe(200);
    const text = (
      (await list.json()) as { result: { tools: { description: string }[] } }
    ).result.tools
      .map((t) => t.description)
      .join("\n");
    expect(text).toContain("Declared document types: page, siteSettings.");
    expect(text).not.toContain("header");
  });

  it("still refuses an unbound token with no scope", async () => {
    expect((await get("/api/v1/schema", await bearer(null))).status).toBe(400);
  });

  it("serves each brand its own writing guide, and only on the gated v1 schema", async () => {
    const hbr = await get("/api/v1/schema", await bearer("harbour"));
    expect(((await hbr.json()) as { writing?: unknown }).writing).toEqual(HBR_WRITING);
    const atl = await get("/api/v1/schema", await bearer("kenya"));
    expect(atl.status).toBe(200);
    expect(await atl.json()).not.toHaveProperty("writing");

    // The open manifest, which the admin fetches before anyone signs in, carries
    // neither the key nor a word of the guide, under either brand's scope.
    for (const scope of ["harbour", "kenya"]) {
      const open = await get(`/~${scope}/api/schema`, {});
      expect(open.status).toBe(200);
      const text = await open.text();
      expect(text).not.toContain('"writing"');
      expect(text).not.toContain("HBR-VOICE-7f3a");
      expect(text).not.toContain("Smith account");
    }

    // Nor does MCP's `server/discover`, which also answers without a credential.
    const discover = await get(
      "/~harbour/mcp",
      {},
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
      },
    );
    const instructions = ((await discover.json()) as { result: { instructions: string } }).result
      .instructions;
    expect(instructions).toContain("Harbour Travel");
    expect(instructions).not.toContain("HBR-VOICE-7f3a");
    expect(instructions).not.toContain("Smith account");
  });
});
