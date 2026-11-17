import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBlock, select, text } from "../../src/core";
import { optionListKey } from "../../src/core/option-sources";
import type { DocumentType } from "../../src/core/schema";
import { createFolio, type FolioBindings, type FolioConfig, magicLink } from "../../src/server";
import type { Scope } from "../../src/server/auth/roles";
import { createToken } from "../../src/server/auth/tokens";

/**
 * Option sources on document fields (`platform/admin-extensions.md` decisions 14 to 20),
 * in real D1 and workerd. The vendor is a counting `load`.
 *
 * Built up per step: this first half is the registry (step 10): a source registered for
 * fields only reaches no forms surface, and a field's list survives the cron and the prune.
 */

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const DAY = 86_400_000;

const calls: string[] = [];
let behaviour: "list" | "throw" = "list";

const products = {
  label: "Products",
  ttl: 60,
  load() {
    calls.push("products");
    if (behaviour === "throw") throw new Error("https://shop.example/?key=SECRET");
    return [
      { value: "prod_1", label: "Classic tee" },
      { value: "prod_2", label: "Hoodie" },
    ];
  },
};
const customers = {
  label: "Customers",
  ttl: 60,
  load() {
    calls.push("customers");
    return [{ value: "cus_1", label: "Mina" }];
  },
};
const countries = {
  label: "Countries",
  ttl: 60,
  load() {
    calls.push("countries");
    return [{ value: "ke", label: "Kenya" }];
  },
};

const productPage = defineBlock({
  name: "productPage",
  label: "Product page",
  summary: "title",
  fields: {
    title: text({ indexed: true }),
    product: select({ label: "Product", optionsFrom: { source: "products" }, indexed: true }),
  },
  render: () => null,
});

const types: DocumentType[] = [
  { name: "productPage", label: "Product page", kind: "page", root: "productPage", default: true },
];

const config = {
  blocks: [productPage],
  types,
  bindings,
  basePath: "/folio",
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  logger: { warn: () => {}, error: () => {} },
  forms: { sources: { countries } },
  optionSources: { products, customers },
} satisfies FolioConfig<Cloudflare.Env>;
const folio = createFolio<Cloudflare.Env>(config);

let reader: Record<string, string>;
let editor: Record<string, string>;

const bearer = async (name: string, scopes: Scope[]) => ({
  authorization: `Bearer ${(await createToken(env.DB, { name, scopes })).token}`,
});

async function call(
  path: string,
  auth: Record<string, string> | null,
  init: { method?: string; body?: unknown } = {},
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
    createExecutionContext(),
  );
  if (!res) throw new Error(`handle() answered null for ${path}`);
  return res;
}

const rows = async () =>
  (
    await env.DB.prepare(
      "select brand, source, key, options is not null as loaded, loaded_at from option_lists order by brand, source, key",
    ).all<{ brand: string; source: string; key: string; loaded: number; loaded_at: number }>()
  ).results;

const FORM = "frm_bbbbbbbbbbbb";
const insertForm = () =>
  env.DB.prepare(
    `insert into forms (id, name, label, fields, created_at, updated_at, site_id)
     values (?, 'f', 'Enquiry', '[]', 1000, 1000, 'default')`,
  )
    .bind(FORM)
    .run();

beforeAll(async () => {
  reader = await bearer("fs-reader", ["content:read"]);
  editor = await bearer("fs-editor", ["content:read", "content:write"]);
});

beforeEach(async () => {
  calls.length = 0;
  behaviour = "list";
  await env.DB.batch([
    env.DB.prepare("delete from forms"),
    env.DB.prepare("delete from option_lists"),
  ]);
  await insertForm();
});

describe("a field-only source stays out of forms", () => {
  it("is not listed by GET /forms/registry, which keeps its own sources", async () => {
    const body = (await (await call("/api/forms/registry", reader)).json()) as {
      sources: { id: string }[];
    };
    expect(body.sources.map((s) => s.id)).toEqual(["countries"]);
    expect(calls).toEqual([]);
  });

  it("is refused as a form question's source, and saves nothing", async () => {
    const res = await call(`/api/forms/${FORM}`, editor, {
      method: "PATCH",
      body: {
        expectedUpdatedAt: 1000,
        fields: [
          { name: "who", kind: "select", label: "Who", optionsFrom: { source: "customers" } },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    const form = await env.DB.prepare("select fields from forms where id = ?")
      .bind(FORM)
      .first<{ fields: string }>();
    expect(form?.fields).toBe("[]");
  });

  it("is refused by the builder preview, and never loaded", async () => {
    const res = await call(`/api/forms/${FORM}/option-preview`, editor, {
      method: "POST",
      body: { field: "who", optionsFrom: { source: "customers" }, locale: null },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(calls).toEqual([]);
  });

  it("does not put a field source on the unauthenticated manifest, only the field's descriptor", async () => {
    const body = await (await call("/api/schema", null)).text();
    expect(body).not.toContain("Customers");
    expect(body).not.toContain("customers");
    expect(body).toContain('"optionsFrom":{"source":"products"}');
  });
});

describe("folio.refreshOptionSources and a field's list", () => {
  it("loads the lists the schema names with no sourced form saved at all", async () => {
    const report = await folio.refreshOptionSources(env);
    expect(report).toMatchObject({ due: 1, loaded: 1, failed: 0 });
    expect(calls).toEqual(["products"]);
    expect(await rows()).toMatchObject([{ brand: "", source: "products", loaded: 1 }]);
  });

  it("refreshes a list loaded nine days ago instead of pruning it", async () => {
    const old = Date.now() - 9 * DAY;
    await env.DB.prepare(
      `insert into option_lists (brand, source, key, options, digest, loaded_at, attempted_at)
       values ('', 'products', ?, '[{"value":"prod_old","label":"Old"}]', 'd', ?, ?)`,
    )
      .bind(optionListKey(undefined, ""), old, old)
      .run();
    const report = await folio.refreshOptionSources(env);
    expect(report).toMatchObject({ due: 1, loaded: 1, pruned: 0 });
    const [row] = await rows();
    expect(row).toMatchObject({ source: "products", loaded: 1 });
    expect(row?.loaded_at).toBeGreaterThan(old + 8 * DAY);
  });

  it("prunes a week-old list that nothing names", async () => {
    const old = Date.now() - 9 * DAY;
    await env.DB.prepare(
      `insert into option_lists (brand, source, key, options, digest, loaded_at, attempted_at)
       values ('', 'retired', '', '[]', 'd', ?, ?)`,
    )
      .bind(old, old)
      .run();
    const report = await folio.refreshOptionSources(env);
    expect(report.pruned).toBe(1);
    expect((await rows()).map((r) => r.source)).toEqual(["products"]);
  });

  it("does not load a source no field names", async () => {
    await folio.refreshOptionSources(env);
    expect(calls).not.toContain("customers");
    expect(calls).not.toContain("countries");
  });
});

/* ------------------------------------------------------- v1 content writes --- */

const KEY = optionListKey(undefined, "");

/** A list as the store holds it: `loadedAt` decides fresh (ttl 60 s) or stale. */
const putList = async (
  options: string[],
  loadedAt = Date.now(),
  source = "products",
): Promise<void> => {
  await env.DB.prepare("delete from option_lists where source = ?").bind(source).run();
  await env.DB.prepare(
    `insert into option_lists (brand, source, key, options, digest, loaded_at, attempted_at)
     values ('', ?, ?, ?, 'd', ?, ?)`,
  )
    .bind(
      source,
      KEY,
      JSON.stringify(options.map((value) => ({ value, label: value }))),
      loadedAt,
      loadedAt,
    )
    .run();
};

const writer = async () => bearer(`fs-writer-${Math.random()}`, ["content:read", "content:write"]);
let write: Record<string, string>;

const v1 = async (
  path: string,
  init: { method?: string; body?: unknown; auth?: Record<string, string> } = {},
) => {
  const res = await folio.handle(
    new Request(`https://cms.example/folio/api/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.auth ?? write),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    env,
    createExecutionContext(),
  );
  if (!res) throw new Error(`handle() answered null for ${path}`);
  return res;
};

const create = async (content?: unknown) => {
  const res = await v1("/documents", {
    method: "POST",
    body: { type: "productPage", title: "A product page", ...(content ? { content } : {}) },
  });
  return res;
};
const patchFields = (id: string, fields: Record<string, unknown>) =>
  v1(`/documents/${id}/fields`, { method: "PATCH", body: { fields } });
const putContent = (id: string, fields: Record<string, unknown>) =>
  v1(`/documents/${id}/content`, { method: "PUT", body: { content: { fields } } });

const draftProduct = async (id: string) => {
  const res = await v1(`/documents/${id}?status=draft`);
  const body = (await res.json()) as { content: { fields: Record<string, unknown> } };
  return body.content.fields.product;
};

describe("v1 writes to a sourced select (decision 20)", () => {
  let id: string;
  beforeAll(async () => {
    write = await writer();
  });
  beforeEach(async () => {
    const res = await create();
    expect(res.status).toBe(201);
    id = ((await res.json()) as { id: string }).id;
  });

  it("accepts a value the loaded list offers, and refuses one it does not", async () => {
    await putList(["prod_1", "prod_2"]);
    expect((await patchFields(id, { product: "prod_1" })).status).toBe(200);
    expect(await draftProduct(id)).toBe("prod_1");

    const refused = await patchFields(id, { product: "prod_x" });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("productPage.product");
    expect(body.error.message).toContain("`products`");
    expect(body.error.message).toContain("/api/v1/options/productPage/product");
    expect(await draftProduct(id)).toBe("prod_1");
  });

  it("accepts the empty string and null, which clear the field", async () => {
    await putList(["prod_1"]);
    await patchFields(id, { product: "prod_1" });
    expect((await patchFields(id, { product: "" })).status).toBe(200);
    expect((await patchFields(id, { product: null })).status).toBe(200);
  });

  it("refuses PUT content the same way, and accepts a listed value", async () => {
    await putList(["prod_1"]);
    expect((await putContent(id, { product: "prod_x" })).status).toBe(400);
    expect((await putContent(id, { product: "prod_1" })).status).toBe(200);
    expect(await draftProduct(id)).toBe("prod_1");
  });

  it("accepts a stale list's value when the refresh fails", async () => {
    await putList(["prod_1"], Date.now() - 3_600_000);
    behaviour = "throw";
    expect((await patchFields(id, { product: "prod_1" })).status).toBe(200);
    // A stale list is checked as it stands: an outage is not the writer's problem.
    expect((await patchFields(id, { product: "prod_x" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 503 unavailable for a list that never loaded and a load that throws", async () => {
    behaviour = "throw";
    const res = await patchFields(id, { product: "prod_1" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unavailable");
    expect(body.error.message).toContain("has not loaded");
    expect(body.error.message).not.toContain("SECRET");
    expect(calls).toEqual(["products"]);
    expect(await draftProduct(id)).toBeFalsy();
  });

  it("refreshes a never-loaded list under the lease and then decides", async () => {
    expect((await patchFields(id, { product: "prod_1" })).status).toBe(200);
    expect(calls).toEqual(["products"]);
    expect((await rows()).map((r) => r.source)).toEqual(["products"]);
    expect((await patchFields(id, { product: "prod_x" })).status).toBe(400);
    expect(calls).toEqual(["products"]);
  });

  it("does not refuse a merge payload that hands back a stored retired id", async () => {
    await putList(["prod_9"]);
    await patchFields(id, { product: "prod_9" });
    await putList(["prod_1"]);
    expect((await putContent(id, { title: "Renamed", product: "prod_9" })).status).toBe(200);
    expect(await draftProduct(id)).toBe("prod_9");
    // The same value through PATCH is no change either.
    expect((await patchFields(id, { product: "prod_9" })).status).toBe(200);
  });

  it("checks a create's content, and writes nothing when it is refused", async () => {
    await putList(["prod_1"]);
    const before = (await env.DB.prepare("select count(*) as n from stories").first<{
      n: number;
    }>())!.n;
    const refused = await create({ fields: { product: "prod_x" } });
    expect(refused.status).toBe(400);
    expect(
      (await env.DB.prepare("select count(*) as n from stories").first<{ n: number }>())!.n,
    ).toBe(before);
    const ok = await create({ fields: { product: "prod_1" } });
    expect(ok.status).toBe(201);
  });

  it("leaves a field that is not sourced alone", async () => {
    await putList(["prod_1"]);
    expect((await patchFields(id, { title: "Anything at all" })).status).toBe(200);
    expect(calls).toEqual([]);
  });
});
