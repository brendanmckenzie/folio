import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import { optionListKey } from "../../src/core/option-sources";
import type { DocumentType } from "../../src/core/schema";
import {
  createFolio,
  type FolioBindings,
  type FolioBrand,
  type FolioConfig,
  magicLink,
} from "../../src/server";
import type { Scope } from "../../src/server/auth/roles";
import { createToken } from "../../src/server/auth/tokens";

/**
 * Phase 5 of form option sources (`docs/specs/content-model/form-option-sources.md`
 * decisions 7, 14, 16 and 17): the save, the registry route, the preview route and the
 * cron. Real D1 and workerd; the vendor is a counting `load`.
 */

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const trip = (name: string) =>
  defineBlock({
    name,
    label: "Trip",
    summary: "title",
    fields: { title: text({ indexed: true }), note: text() },
    render: () => null,
  });
const page = (name: string) =>
  defineBlock({ name, label: "Page", fields: { title: text() }, render: () => null });

const types: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
  { name: "trip", label: "Trip", kind: "page", root: "tripRoot" },
];

const calls: Array<{ source: string; brand: string | null; settings: unknown; locale: unknown }> =
  [];
let behaviour: "list" | "never" | "throw" = "list";

const source = (label: string) => ({
  label,
  ttl: 60,
  settings: {
    region: {
      kind: "select" as const,
      label: "Region",
      options: [
        { value: "all", label: "All" },
        { value: "africa", label: "Africa" },
      ],
      default: "all",
    },
    limit: { kind: "number" as const, label: "Limit", min: 1, max: 50 },
    token: { kind: "text" as const, label: "Token", required: true },
  },
  load(input: {
    settings: unknown;
    locale: string | null;
    brand: { id: string } | null;
    signal: AbortSignal;
  }) {
    calls.push({
      source: label,
      brand: input.brand?.id ?? null,
      settings: input.settings,
      locale: input.locale,
    });
    if (behaviour === "throw") throw new Error("https://vendor.example/?key=SECRET");
    if (behaviour === "never") return new Promise<never>(() => {});
    return [
      { value: "ke", label: `Kenya (${label})` },
      { value: "tz", label: "Tanzania" },
    ];
  },
});

/* -------------------------------------------------------- single brand --- */

const single = {
  blocks: [page("pageRoot"), trip("tripRoot")],
  types,
  bindings,
  basePath: "/folio",
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  logger: { warn: () => {}, error: () => {} },
  forms: { sources: { countries: source("Countries"), cities: source("Cities") } },
} satisfies FolioConfig<Cloudflare.Env>;
const folio = createFolio<Cloudflare.Env>(single);

let reader: Record<string, string>;
let editor: Record<string, string>;

const bearer = async (name: string, scopes: Scope[]) => ({
  authorization: `Bearer ${(await createToken(env.DB, { name, scopes })).token}`,
});

async function call(
  path: string,
  auth: Record<string, string> | null,
  init: { method?: string; body?: unknown } = {},
  ctx: ExecutionContext = createExecutionContext(),
) {
  const res = await folio.handle(
    new Request(`https://cms.example/folio${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(auth ?? {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    env,
    ctx,
  );
  if (!res) throw new Error(`handle() answered null for ${path}`);
  return res;
}

const rows = async () =>
  (
    await env.DB.prepare(
      "select brand, source, key, options is not null as loaded, attempted_at from option_lists order by brand, source, key",
    ).all<{ brand: string; source: string; key: string; loaded: number; attempted_at: number }>()
  ).results;

const FORM = "frm_aaaaaaaaaaaa";
const field = (optionsFrom: unknown, name = "country") => ({
  name,
  kind: "select",
  label: "Country",
  optionsFrom,
});
const saved = async (id = FORM) => {
  const row = await env.DB.prepare("select version, updated_at, fields from forms where id = ?")
    .bind(id)
    .first<{ version: number; updated_at: number; fields: string }>();
  return row!;
};
const insertForm = (id: string, fields: unknown[], site = "default") =>
  env.DB.prepare(
    `insert into forms (id, name, label, fields, created_at, updated_at, site_id)
     values (?, ?, 'Enquiry', ?, 1000, 1000, ?)`,
  )
    .bind(id, `f-${id}`, JSON.stringify(fields), site)
    .run();

const patch = (fields: unknown[], auth = editor, id = FORM, ctx?: ExecutionContext) =>
  call(
    `/api/forms/${id}`,
    auth,
    { method: "PATCH", body: { expectedUpdatedAt: 1000, fields } },
    ctx,
  );
const preview = (body: unknown, auth: Record<string, string> | null = editor, id = FORM) =>
  call(`/api/forms/${id}/option-preview`, auth, { method: "POST", body });

const doc = (title: string): Doc => ({
  root: "r0",
  bloks: {
    r0: { uid: "r0", type: "tripRoot", parent: null, slot: null, order: "a0", data: { title } },
  },
});
async function story(id: string, title: string, published = true) {
  await env.DB.prepare(
    `insert into stories (id, type, slug, path, ord, title, updated_at, published_doc, published_at)
     values (?, 'trip', ?, ?, 'a0', ?, 1, ?, ?)`,
  )
    .bind(id, id, id, title, published ? JSON.stringify(doc(title)) : null, published ? 1 : null)
    .run();
}

beforeAll(async () => {
  reader = await bearer("reader", ["content:read"]);
  editor = await bearer("editor", ["content:read", "content:write"]);
});

beforeEach(async () => {
  calls.length = 0;
  behaviour = "list";
  await env.DB.batch([
    env.DB.prepare("delete from forms"),
    env.DB.prepare("delete from option_lists"),
    env.DB.prepare("delete from stories"),
  ]);
  await insertForm(FORM, []);
});

describe("GET /forms/registry", () => {
  it("refuses a request with no session", async () => {
    expect((await call("/api/forms/registry", null)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("answers the brand's sources as metadata, with no function, and no actions", async () => {
    const res = await call("/api/forms/registry", reader);
    expect(res.status).toBe(200);
    const body = await res.text();
    const parsed = JSON.parse(body) as { sources: Array<Record<string, unknown>>; actions: [] };
    expect(parsed.actions).toEqual([]);
    expect(parsed.sources.map((s) => s.id).sort()).toEqual(["cities", "countries"]);
    const countries = parsed.sources.find((s) => s.id === "countries")!;
    expect(Object.keys(countries).sort()).toEqual(["id", "label", "localised", "settings", "ttl"]);
    expect(countries).toMatchObject({ label: "Countries", ttl: 60, localised: false });
    expect(Object.keys(countries.settings as object)).toEqual(["region", "limit", "token"]);
    expect(body).not.toContain("load");
    // `content` is built in and not listed; the route is not read as a form id.
    expect(body).not.toContain('"content"');
    expect(calls).toEqual([]);
  });

  it("is not on the manifest, which anybody can fetch", async () => {
    const res = await call("/api/schema", null);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("Countries");
    expect(body).not.toContain("countries");
  });
});

describe("PATCH /forms/:id", () => {
  const ok = { source: "countries", settings: { token: "t" } };
  const refusals: Array<[string, unknown]> = [
    ["an unregistered source", { source: "nowhere" }],
    ["an undeclared setting", { source: "countries", settings: { token: "t", nope: 1 } }],
    ["a wrong-kind setting", { source: "countries", settings: { token: 5 } }],
    [
      "a select value outside its options",
      { source: "countries", settings: { token: "t", region: "europe" } },
    ],
    ["a missing required setting", { source: "countries" }],
    ["an out-of-range number", { source: "countries", settings: { token: "t", limit: 99 } }],
    ["a content type that is not a type", { source: "content", settings: { type: "ghost" } }],
    [
      "a content filter on a field that is not indexed",
      {
        source: "content",
        settings: { type: "trip", where: [{ field: "note", op: "eq", value: "x" }] },
      },
    ],
  ];

  for (const [name, optionsFrom] of refusals) {
    it(`refuses ${name} and saves nothing`, async () => {
      const before = await saved();
      const res = await patch([field(optionsFrom)]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("bad_request");
      expect(body.error.message).toContain("country");
      expect(await saved()).toEqual(before);
      expect(calls).toEqual([]);
    });
  }

  it("saves a valid source, bumps the version on a settings change and loads in the background", async () => {
    const ctx = createExecutionContext();
    const v0 = (await saved()).version;
    const res = await patch([field(ok)], editor, FORM, ctx);
    expect(res.status).toBe(200);
    expect((await saved()).version).toBe(v0 + 1);
    await waitOnExecutionContext(ctx);
    expect(calls).toEqual([
      { source: "Countries", brand: null, settings: { region: "all", token: "t" }, locale: null },
    ]);
    expect(await rows()).toMatchObject([{ brand: "", source: "countries", loaded: 1 }]);

    // A settings change is a shape change.
    const ctx2 = createExecutionContext();
    const res2 = await call(
      `/api/forms/${FORM}`,
      editor,
      {
        method: "PATCH",
        body: {
          expectedUpdatedAt: (await saved()).updated_at,
          fields: [field({ source: "countries", settings: { token: "t", region: "africa" } })],
        },
      },
      ctx2,
    );
    expect(res2.status).toBe(200);
    await waitOnExecutionContext(ctx2);
    expect(calls).toHaveLength(2);
    expect((await saved()).version).toBe(v0 + 2);
  });

  it("answers without waiting for a load that never settles", async () => {
    behaviour = "never";
    const v0 = (await saved()).version;
    const res = await patch([field(ok)]);
    expect(res.status).toBe(200);
    expect((await saved()).version).toBe(v0 + 1);
    // The load started in the background and is still pending: the reply did not wait.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
  });

  it("does not load a fresh list again, and leaves a content question alone", async () => {
    const content = field({ source: "content", settings: { type: "trip" } }, "trip");
    const ctx = createExecutionContext();
    await patch([field(ok), content], editor, FORM, ctx);
    await waitOnExecutionContext(ctx);
    expect(calls).toHaveLength(1);
    expect((await rows()).map((r) => r.source)).toEqual(["countries"]);

    const ctx2 = createExecutionContext();
    const again = await call(
      `/api/forms/${FORM}`,
      editor,
      {
        method: "PATCH",
        body: {
          expectedUpdatedAt: (await saved()).updated_at,
          fields: [field(ok), content, { name: "x", kind: "text", label: "X" }],
        },
      },
      ctx2,
    );
    expect(again.status).toBe(200);
    await waitOnExecutionContext(ctx2);
    expect(calls).toHaveLength(1);
  });
});

describe("POST /forms/:id/option-preview", () => {
  const okFrom = { source: "countries", settings: { token: "t" } };

  it("requires EDIT", async () => {
    expect((await preview({ optionsFrom: okFrom }, reader)).status).toBe(403);
    expect((await preview({ optionsFrom: okFrom }, null)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses what a save would, and never calls load", async () => {
    for (const optionsFrom of [
      { source: "countries", settings: { token: "t", region: "europe" } },
      { source: "countries", settings: { token: "t", nope: 1 } },
      { source: "countries" },
      { source: "nowhere" },
      { source: "content", settings: { type: "ghost" } },
    ]) {
      const res = await preview({ optionsFrom });
      expect([optionsFrom, res.status]).toEqual([optionsFrom, 400]);
    }
    expect((await preview({ optionsFrom: okFrom, extra: 1 })).status).toBe(400);
    expect((await preview({ optionsFrom: okFrom, locale: "xx" })).status).toBe(501);
    expect(calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("404s an unknown form", async () => {
    expect((await preview({ optionsFrom: okFrom }, editor, "frm_000000000000")).status).toBe(404);
  });

  it("answers the list for a key no saved form references and writes no row", async () => {
    const res = await preview({ optionsFrom: okFrom });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      options: [
        { value: "ke", label: "Kenya (Countries)" },
        { value: "tz", label: "Tanzania" },
      ],
      total: 2,
      truncated: false,
      status: "fresh",
    });
    expect(calls).toHaveLength(1);
    expect(await rows()).toEqual([]);
  });

  it("writes the row when a saved form already references the key", async () => {
    await insertForm("frm_bbbbbbbbbbbb", [field(okFrom)]);
    const res = await preview({ optionsFrom: okFrom });
    expect(res.status).toBe(200);
    expect(await rows()).toMatchObject([
      {
        brand: "",
        source: "countries",
        key: optionListKey({ region: "all", token: "t" }, ""),
        loaded: 1,
      },
    ]);
    // A second preview inside the lease is answered from the row.
    await preview({ optionsFrom: okFrom });
    expect(calls).toHaveLength(1);
  });

  it("answers a failure as a category, never the thrown message", async () => {
    behaviour = "throw";
    const res = await preview({ optionsFrom: okFrom });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({
      options: [],
      status: "never-loaded",
      failure: "threw",
    });
    expect(body).not.toContain("SECRET");
    expect(await rows()).toEqual([]);
  });

  it("lists published documents of a type", async () => {
    await story("sty_1", "Alpha trip");
    await story("sty_2", "Draft trip", false);
    const res = await preview({ optionsFrom: { source: "content", settings: { type: "trip" } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      options: [{ value: "sty_1", label: "Alpha trip" }],
      total: 1,
      truncated: false,
    });
    expect(calls).toEqual([]);
  });
});

describe("folio.refreshOptionSources", () => {
  const keys = ["a", "b", "c"].map((t) => ({ source: "countries", settings: { token: t } }));
  // The key is spelled with the declared default filled in (`effectiveSettings`).
  const keyOf = (token: string) => optionListKey({ region: "all", token }, "");
  const canonical = (token: string) => `\u0000countries\u0000${keyOf(token)}`;

  it("loads referenced lists, resumes after the cursor and finishes with null", async () => {
    await insertForm(
      "frm_cccccccccccc",
      keys.map((k, i) => field(k, `q${i}`)),
    );
    const first = await folio.refreshOptionSources(env, { batch: 2 });
    expect(first).toMatchObject({ due: 3, loaded: 2, failed: 0, pruned: 0 });
    expect(first.continueFrom).toBe(canonical("b"));
    expect(calls.map((c) => (c.settings as { token: string }).token).sort()).toEqual(["a", "b"]);

    const second = await folio.refreshOptionSources(env, {
      batch: 2,
      continueFrom: first.continueFrom,
    });
    expect(second).toMatchObject({ due: 1, loaded: 1, continueFrom: null });
    expect(calls).toHaveLength(3);
    expect(await rows()).toHaveLength(3);

    // Nothing is due now.
    const third = await folio.refreshOptionSources(env);
    expect(third).toMatchObject({ due: 0, loaded: 0, failed: 0, continueFrom: null });
    expect(calls).toHaveLength(3);
  });

  it("moves past a key that failed instead of retrying it forever", async () => {
    await insertForm(
      "frm_cccccccccccc",
      keys.map((k, i) => field(k, `q${i}`)),
    );
    behaviour = "throw";
    const first = await folio.refreshOptionSources(env, { batch: 1 });
    expect(first).toMatchObject({ due: 3, failed: 1, continueFrom: canonical("a") });
    behaviour = "list";
    // `a` is still due (and leased); the cursor is what carries the sweep on to `b`.
    const second = await folio.refreshOptionSources(env, {
      batch: 1,
      continueFrom: first.continueFrom,
    });
    expect(second).toMatchObject({ due: 2, loaded: 1, continueFrom: canonical("b") });
    expect((calls[calls.length - 1]!.settings as { token: string }).token).toBe("b");
  });

  it("counts a failing source and keeps its row", async () => {
    await insertForm("frm_cccccccccccc", [field(keys[0], "q0")]);
    behaviour = "throw";
    expect(await folio.refreshOptionSources(env)).toMatchObject({ due: 1, loaded: 0, failed: 1 });
    expect(await rows()).toHaveLength(1);
  });

  it("prunes unreferenced rows nobody has attempted for 7 days, and nothing a form names", async () => {
    const old = Date.now() - 8 * 24 * 3600 * 1000;
    const insert = (src: string, key: string, at: number) =>
      env.DB.prepare(
        `insert into option_lists (brand, source, key, options, digest, loaded_at, attempted_at)
         values ('', ?, ?, '[{"value":"x","label":"x"}]', 'd', ?, ?)`,
      )
        .bind(src, key, at, at)
        .run();
    // Referenced by a form outside the batch: kept even though old.
    await insertForm("frm_cccccccccccc", [field(keys[0], "q0")]);
    await insertForm("frm_dddddddddddd", [field(keys[1], "q1"), field(keys[2], "q2")]);
    await insert("countries", keyOf("a"), old);
    await insert("countries", keyOf("b"), old);
    await insert("countries", keyOf("orphan"), old);
    await insert("gone", '[{},""]', old);
    await insert("countries", keyOf("young"), Date.now());

    const report = await folio.refreshOptionSources(env, { batch: 1 });
    expect(report.pruned).toBe(2);
    const left = await rows();
    const keysLeft = left.map((r) => r.key);
    expect(keysLeft).toContain(keyOf("a"));
    expect(keysLeft).toContain(keyOf("b"));
    expect(keysLeft).toContain(keyOf("young"));
    expect(keysLeft).not.toContain(keyOf("orphan"));
    expect(left.map((r) => r.source)).not.toContain("gone");
  });
});

/* ------------------------------------------------------------ branded --- */

describe("brands", () => {
  const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
    aaa: {
      label: "AAA",
      blocks: [page("pageRoot"), trip("tripRoot")],
      types,
      forms: { sources: { countries: source("AAA countries"), onlyaaa: source("Only AAA") } },
    },
    tgo: {
      label: "TGO",
      blocks: [page("pageRoot"), trip("tripRoot")],
      types,
      forms: { sources: { countries: source("TGO countries") } },
    },
  };
  const branded = createFolio<Cloudflare.Env>({
    brands,
    sites: { admin: "https://cms.example" },
    bindings,
    basePath: "/folio",
    auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
    logger: { warn: () => {}, error: () => {} },
    assets: {
      admin: "/folio-admin.js",
      brands: {
        aaa: { preview: "/aaa.js", previewCss: ["/aaa.css"] },
        tgo: { preview: "/tgo.js", previewCss: ["/tgo.css"] },
      },
    },
    route: (p) => `/${p}`,
  });
  let admin: Record<string, string>;

  beforeAll(async () => {
    admin = await bearer("platform", ["admin"]);
    await env.DB.batch([
      env.DB.prepare(
        `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
           ('north', 'group', 'North', null, null, null, 'aaa', 0, 0),
           ('alpha', 'site', 'Alpha', 'north', 'live', null, 'aaa', 0, 0),
           ('tgosite', 'site', 'TGO', null, 'live', null, 'tgo', 0, 0),
           ('nobrand', 'site', 'Nobrand', null, 'live', null, null, 0, 0)`,
      ),
    ]);
  });

  async function bcall(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await branded.handle(
      new Request(`https://cms.example/folio${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...admin,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      env,
      createExecutionContext(),
    );
    if (!res) throw new Error(`handle() answered null for ${path}`);
    return res;
  }

  it("answers each brand's own sources, and 400 site_required unscoped", async () => {
    type Reg = { sources: Array<{ id: string; label: string }> };
    const aaa = (await (await bcall("/~alpha/api/forms/registry")).json()) as Reg;
    expect(aaa.sources.map((s) => s.label).sort()).toEqual(["AAA countries", "Only AAA"]);
    const tgo = (await (await bcall("/~tgosite/api/forms/registry")).json()) as Reg;
    expect(tgo.sources.map((s) => s.label)).toEqual(["TGO countries"]);
    const none = await bcall("/api/forms/registry");
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("site_required");
  });

  it("refuses a source the form's brand does not register, and an unscoped preview", async () => {
    await insertForm("frm_eeeeeeeeeeee", [], "tgosite");
    const own = { source: "onlyaaa", settings: { token: "t" } };
    const res = await bcall("/~tgosite/api/forms/frm_eeeeeeeeeeee", {
      method: "PATCH",
      body: { expectedUpdatedAt: 1000, fields: [field(own)] },
    });
    expect(res.status).toBe(400);
    const unscoped = await bcall("/api/forms/frm_eeeeeeeeeeee/option-preview", {
      method: "POST",
      body: { optionsFrom: own },
    });
    expect(unscoped.status).toBe(400);
    expect(((await unscoped.json()) as { error: { code: string } }).error.code).toBe(
      "site_required",
    );
    expect(calls).toEqual([]);
  });

  it("keeps two brands' rows and loads apart, and never crosses a scope in the cron", async () => {
    const from = { source: "countries", settings: { token: "t" } };
    await insertForm("frm_ffffffffffff", [field(from)], "alpha");
    await insertForm("frm_gggggggggggg", [field(from)], "tgosite");
    // A form of no brand names no row, and neither does one naming a source its brand lacks.
    await insertForm("frm_hhhhhhhhhhhh", [field(from)], "nobrand");
    await insertForm(
      "frm_iiiiiiiiiiii",
      [field({ source: "onlyaaa", settings: { token: "t" } })],
      "tgosite",
    );

    const report = await branded.refreshOptionSources(env);
    expect(report).toMatchObject({ due: 2, loaded: 2, failed: 0 });
    expect(calls.map((c) => [c.brand, c.source]).sort()).toEqual([
      ["aaa", "AAA countries"],
      ["tgo", "TGO countries"],
    ]);
    expect((await rows()).map((r) => [r.brand, r.source])).toEqual([
      ["aaa", "countries"],
      ["tgo", "countries"],
    ]);
  });
});
