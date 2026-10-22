import { createExecutionContext, env } from "cloudflare:test";
import { createElement as h } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { defineBlock, resolveReference, text } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings, FolioBrand } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * The fences around `?_folio=preview&record=` on a deployment with `sites` and
 * `brands` (`multi-site.md` decision 3, `multi-brand.md` decisions 6 and 10): the
 * record has to be one the **site's chain** reads and a record type **of this brand**.
 * An id outside either resolves exactly like a deleted one, so the parameter is no
 * oracle for other sites' or other brands' documents.
 *
 * Two brands, both declaring a page, and each its own record type: `person` is
 * allaboutafrica's, `guide` is takeoffgo's. `auth: 'open'` lets every preview origin
 * show drafts, so the fences are the whole of what is being tested.
 */

const page = (brand: string) =>
  defineBlock({
    name: "pageRoot",
    label: "Page",
    fields: { title: text() },
    render: ({ title }, resolution) => {
      const rec = resolveReference(resolution.record, resolution);
      return h(
        "main",
        { "data-brand": brand },
        title,
        h("i", null, rec ? `rec:${String(rec.data.name)}` : "none"),
      );
    },
  });
const named = (name: string) =>
  defineBlock({ name, label: name, fields: { name: text() }, render: () => null });

const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
  allaboutafrica: {
    label: "All About Africa",
    blocks: [page("aaa"), named("personRoot")],
    types: [
      { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
      { name: "person", label: "Person", kind: "record", root: "personRoot", previewPath: "home" },
    ] satisfies DocumentType[],
  },
  takeoffgo: {
    label: "Take Off Go",
    blocks: [page("tgo"), named("guideRoot")],
    types: [
      { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
      { name: "guide", label: "Guide", kind: "record", root: "guideRoot", previewPath: "home" },
    ] satisfies DocumentType[],
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
      allaboutafrica: { preview: "/aaa.js" },
      takeoffgo: { preview: "/tgo.js" },
    },
  },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : "/",
});

const blok = (uid: string, type: string, data: Record<string, Json>) => ({
  uid,
  type,
  parent: null,
  slot: null,
  order: "a0",
  data,
});
const doc = (type: string, data: Record<string, Json>): Doc => ({
  root: "r0",
  bloks: { r0: blok("r0", type, data) },
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
    env.DB.prepare("update sites set brand = 'allaboutafrica' where id = 'default'"),
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
         ('east', 'group', 'East', null, null, null, 'allaboutafrica', 0, 0),
         ('kenya', 'site', 'Kenya', 'east', 'live', 'https://preview.kenya.example', 'allaboutafrica', 0, 0),
         ('uganda', 'site', 'Uganda', null, 'live', 'https://preview.uganda.example', 'allaboutafrica', 0, 0),
         ('takeoffgo', 'site', 'Take Off Go', null, 'live', 'https://preview.takeoffgo.example', 'takeoffgo', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values ('kenya.example', 'kenya'), ('uganda.example', 'uganda'), ('takeoffgo.example', 'takeoffgo')`,
    ),
  ]);
  await row("sty_home", "kenya", "page", "home", doc("pageRoot", { title: "Kenya home" }));
  await row("sty_own", "kenya", "person", null, doc("personRoot", { name: "Own" }));
  await row("sty_group", "east", "person", null, doc("personRoot", { name: "Group" }));
  await row("sty_uganda", "uganda", "person", null, doc("personRoot", { name: "Uganda" }));
  await row("sty_tgo_guide", "takeoffgo", "guide", null, doc("guideRoot", { name: "Guide" }));
  // A row in kenya's own site whose type is the *other* brand's: in the chain, not a
  // record of this brand.
  await row("sty_wrongtype", "kenya", "guide", null, doc("guideRoot", { name: "Wrong" }));
});

const preview = (id: string) =>
  folio.handle(
    new Request(`https://preview.kenya.example/home?_folio=preview&record=${id}`),
    env,
    createExecutionContext(),
  );

describe("?_folio=preview&record= on a deployment with sites and brands", () => {
  it("renders a record in the site's own scope and in a group it reads", async () => {
    for (const [id, name] of [
      ["sty_own", "Own"],
      ["sty_group", "Group"],
    ] as const) {
      const res = await preview(id);
      expect(res?.status).toBe(200);
      expect(await res?.text()).toContain(`rec:${name}`);
    }
  });

  it("hands back a record of a site outside the chain, as if it were deleted", async () => {
    expect(await preview("sty_uganda")).toBeNull();
    expect(await preview("sty_deleted")).toBeNull();
  });

  it("hands back another brand's record, and a row of the other brand's type in the chain", async () => {
    expect(await preview("sty_tgo_guide")).toBeNull();
    expect(await preview("sty_wrongtype")).toBeNull();
  });
});
