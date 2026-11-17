import { createExecutionContext, env } from "cloudflare:test";
import { createElement as h } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings, FolioBrand } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * `?_folio=preview&as=<global>` for a global whose type declares `previewRoot`, on a
 * deployment with `sites` and `brands` (`singleton-preview-root.md` decision 6): the
 * frame is the **gated site's brand's** block, the global is that brand's, the layer
 * read is the site's chain, and the path is never read, so `/` on a preview origin with
 * no page at all renders.
 *
 * Two brands, each declaring a `banner` global over a `frame` block of the same name.
 * `auth: 'open'` lets every preview origin show drafts, so the fences are the whole of
 * what is being tested.
 */

const page = (brand: string) =>
  defineBlock({
    name: "pageRoot",
    label: "Page",
    fields: { title: text() },
    render: ({ title }) => h("main", { "data-brand": brand }, title),
  });
const banner = (brand: string) =>
  defineBlock({
    name: "bannerRoot",
    label: "Banner",
    fields: { text: text() },
    render: ({ text: t }) => h("aside", null, `banner-${brand}:${String(t)}`),
  });
const frame = (brand: string) =>
  defineBlock({
    name: "frame",
    label: "Frame",
    fields: { caption: text() },
    render: () => h("section", null, `frame-${brand}`),
  });

const types = [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
  { name: "banner", label: "Banner", kind: "singleton", root: "bannerRoot", previewRoot: "frame" },
] satisfies DocumentType[];

const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
  atlas: {
    label: "Atlas Guides",
    blocks: [page("atl"), banner("atl"), frame("atl")],
    types,
    globals: ["banner"],
  },
  harbour: {
    label: "Harbour Travel",
    blocks: [page("hbr"), banner("hbr"), frame("hbr")],
    types,
    globals: ["banner"],
  },
};

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const folio = createFolio<Cloudflare.Env>({
  brands,
  sites: { admin: "https://cms.example" },
  bindings,
  basePath: "/folio",
  auth: "open",
  assets: {
    admin: "/a.js",
    brands: {
      atlas: { preview: "/atl.js" },
      harbour: { preview: "/hbr.js" },
    },
  },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : "/",
});

const doc = (type: string, data: Record<string, Json>): Doc => ({
  root: "r0",
  bloks: { r0: { uid: "r0", type, parent: null, slot: null, order: "a0", data } },
});

async function row(id: string, site: string, type: string, path: string | null, body: Doc) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, ?, null, ?, ?, 'a0', ?, 1000, ?, ?, 2000)`,
  )
    .bind(id, type, path ?? id, path, id, site, JSON.stringify(body))
    .run();
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("update sites set brand = 'atlas' where id = 'default'"),
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
         ('kenya', 'site', 'Kenya', null, 'live', 'https://preview.kenya.example', 'atlas', 0, 0),
         ('harbour', 'site', 'Harbour Travel', null, 'live', 'https://preview.harbour.example', 'harbour', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values ('kenya.example', 'kenya'), ('harbour.example', 'harbour')`,
    ),
  ]);
  await row("sty_home", "kenya", "page", "home", doc("pageRoot", { title: "Kenya home" }));
  await row("sng_banner:kenya", "kenya", "banner", null, doc("bannerRoot", { text: "Kenya" }));
  await row(
    "sng_banner:harbour",
    "harbour",
    "banner",
    null,
    doc("bannerRoot", { text: "Harbour" }),
  );
});

const root = (origin: string, extra = "") =>
  folio.handle(
    new Request(`${origin}/?_folio=preview&as=banner${extra}`),
    env,
    createExecutionContext(),
  );

describe("?_folio=preview&as= with previewRoot on sites and brands", () => {
  it("renders the site's own layer in its brand's frame, with no page at the path", async () => {
    const res = await root("https://preview.kenya.example");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("frame-atl");
    expect(html).toContain("banner-atl:Kenya");
    expect(html).not.toContain("Kenya home");
    expect(html).toContain('data-folio-global="banner"');
  });

  it("draws the gated site's brand's frame and global, not another's of the same name", async () => {
    const res = await root("https://preview.harbour.example");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("frame-hbr");
    expect(html).toContain("banner-hbr:Harbour");
    expect(html).not.toContain("-atl");
  });

  it("hands back _folio_id", async () => {
    expect(await root("https://preview.kenya.example", "&_folio_id=sty_home")).toBeNull();
  });
});
