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
