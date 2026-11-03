import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings, FolioBrand, FolioConfig } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * Phase 4 of form option sources, the fences: a content-sourced question validates
 * against the **receiving site's chain** and the receiving site's **brand**, so a crafted
 * POST naming a story of another site or another brand is `invalid`
 * (`form-option-sources.md` decision 8, and the multi-site and multi-brand invariants).
 *
 * Group `north` holds site `alpha`; `bravo` is a separate site of the same brand; `tgo`
 * is a site of the other brand. Each has a published trip.
 */

const trip = (name: string) =>
  defineBlock({
    name,
    label: "Trip",
    summary: "title",
    fields: { title: text({ indexed: true }) },
    render: () => null,
  });
const page = (name: string) =>
  defineBlock({ name, label: "Page", fields: { title: text() }, render: () => null });

const types = (): DocumentType[] => [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
  { name: "trip", label: "Trip", kind: "page", root: "tripRoot" },
];

const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
  aaa: { label: "AAA", blocks: [page("pageRoot"), trip("tripRoot")], types: types() },
  tgo: { label: "TGO", blocks: [page("pageRoot"), trip("tripRoot")], types: types() },
};

const config: FolioConfig<Cloudflare.Env> = {
  brands,
  sites: { admin: "https://cms.example" },
  bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: "/folio",
  auth: "open",
  logger: { warn: () => {}, error: () => {} },
  assets: {
    admin: "/folio-admin.js",
    brands: {
      aaa: { preview: "/aaa.js", previewCss: ["/aaa.css"] },
      tgo: { preview: "/tgo.js", previewCss: ["/tgo.css"] },
    },
  },
  route: (p, _l, site) => (site ? `https://${site.hosts[0] ?? site.id}/${p}` : `/${p}`),
};
const folio = createFolio(config);

const doc = (title: string): Doc => ({
  root: "r0",
  bloks: {
    r0: { uid: "r0", type: "tripRoot", parent: null, slot: null, order: "a0", data: { title } },
  },
});

async function story(id: string, site: string, title: string, published = true) {
  await env.DB.prepare(
    `insert into stories (id, type, slug, path, ord, title, updated_at, site_id, published_doc, published_at)
     values (?, 'trip', ?, ?, 'a0', ?, 1, ?, ?, ?)`,
  )
    .bind(
      id,
      id,
      id,
      title,
      site,
      published ? JSON.stringify(doc(title)) : null,
      published ? 1 : null,
    )
    .run();
}

let formId = "";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 'aaa', 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', null, 'aaa', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', null, 'aaa', 0, 0),
         ('tgo', 'site', 'TGO', null, 'live', null, 'tgo', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('alpha.example', 'alpha'), ('bravo.example', 'bravo'), ('tgo.example', 'tgo')`,
    ),
  ]);
  await story("sty_alpha", "alpha", "Alpha trip");
  await story("sty_north", "north", "Group trip");
  await story("sty_bravo", "bravo", "Bravo trip");
  await story("sty_tgo", "tgo", "TGO trip");
  await story("sty_alpha_draft", "alpha", "Alpha draft", false);

  formId = "frm_0a0a0a0a0a0a";
  // Owned by the group, so it is in alpha's chain; the group's own trips are too.
  await env.DB.prepare(
    `insert into forms (id, name, label, fields, created_at, updated_at, site_id)
     values (?, 'enquiry', 'Enquiry', ?, 0, 0, 'north')`,
  )
    .bind(
      formId,
      JSON.stringify([
        {
          name: "trip",
          kind: "select",
          label: "Trip",
          optionsFrom: { source: "content", settings: { type: "trip" } },
        },
      ]),
    )
    .run();
});

async function submit(host: string, value: string) {
  const res = (await folio.handle(
    new Request(`https://${host}/folio/f/${formId}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ trip: value }).toString(),
    }),
    env,
    createExecutionContext(),
  )) as Response;
  return { status: res.status, json: (await res.json()) as Record<string, any> }; // biome-ignore lint/suspicious/noExplicitAny: a reply read by shape
}

const storedFor = async (site: string) =>
  (
    await env.DB.prepare("select data, option_labels from form_responses where site_id = ?")
      .bind(site)
      .all<{ data: string; option_labels: string }>()
  ).results;

describe("a content-sourced question is validated against the receiving site's chain", () => {
  it("accepts the site's own trip and its group's", async () => {
    expect((await submit("alpha.example", "sty_alpha")).status).toBe(200);
    expect((await submit("alpha.example", "sty_north")).status).toBe(200);
    const rows = await storedFor("alpha");
    expect(rows.map((r) => JSON.parse(r.option_labels))).toEqual([
      { trip: { sty_alpha: "Alpha trip" } },
      { trip: { sty_north: "Group trip" } },
    ]);
  });

  it("refuses another site's trip of the same brand", async () => {
    const { status, json } = await submit("alpha.example", "sty_bravo");
    expect(status).toBe(422);
    expect(json.fields).toEqual({ trip: "invalid" });
  });

  it("refuses another brand's trip", async () => {
    const { status, json } = await submit("alpha.example", "sty_tgo");
    expect(status).toBe(422);
    expect(json.fields).toEqual({ trip: "invalid" });
  });

  it("refuses an unpublished trip of the site's own", async () => {
    expect((await submit("alpha.example", "sty_alpha_draft")).status).toBe(422);
  });

  it("stores nothing for any refusal", async () => {
    expect(await storedFor("alpha")).toHaveLength(2);
    expect(await storedFor("bravo")).toHaveLength(0);
  });
});
