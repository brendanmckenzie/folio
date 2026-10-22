import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineBlock, defineRecord, text } from "../../src/core";
import { scopedTypeTag } from "../../src/core/cache-tags";
import type { Doc } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings, FolioBrand, FolioConfig } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * `recordBy()` is fenced twice (issue #75, `multi-site.md` decision 3 and
 * `multi-brand.md` decision 5): a record is found only in the reader's chain, and
 * only through the reader's own brand's schema. Two brands that both declare an
 * `artist` record with a unique `slug`, as two real brands would, so a lookup that
 * leaked across either fence would answer the wrong brand's record.
 *
 * `east` is a group with the site `kenya` under it, brand `alpha`; `beta-site` is
 * brand `beta`. `auth: 'open'` and no `draftMode` keep this on published reads.
 */

const root = (name: string) =>
  defineBlock({ name, label: "Page", fields: { title: text() }, render: () => null });
const artist = (label: string) =>
  defineRecord({
    name: "artist",
    label,
    fields: { slug: text({ indexed: true, unique: true }) },
  });

const alphaTypes: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "alphaPage", default: true },
  { name: "artist", label: "Artist", kind: "record", root: "artist" },
  { name: "venue", label: "Venue", kind: "record", root: "venue" },
];
const betaTypes: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "betaPage", default: true },
  { name: "artist", label: "Artist", kind: "record", root: "artist" },
];
const venue = defineRecord({
  name: "venue",
  label: "Venue",
  fields: { slug: text({ indexed: true, unique: true }) },
});

const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
  alpha: {
    label: "Alpha",
    blocks: [root("alphaPage"), artist("Alpha artist"), venue],
    types: alphaTypes,
  },
  beta: { label: "Beta", blocks: [root("betaPage"), artist("Beta artist")], types: betaTypes },
};

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const config: FolioConfig<Cloudflare.Env> = {
  brands,
  sites: { admin: "https://cms.example" },
  bindings,
  basePath: "/folio",
  auth: "open",
  logger: { warn: () => {}, error: console.error },
  assets: {
    admin: "/folio-admin.js",
    brands: {
      alpha: { preview: "/folio-preview-alpha.js" },
      beta: { preview: "/folio-preview-beta.js" },
    },
  },
  route: (p, _locale, site) => (site ? `https://${site.hosts[0] ?? site.id}/${p}` : `/${p}`),
};
const folio = createFolio(config);

const doc = (slug: string): Doc => ({
  root: "r",
  bloks: { r: { uid: "r", type: "artist", parent: null, slot: null, order: "a0", data: { slug } } },
});

async function record(id: string, site: string, slug: string, type = "artist") {
  await env.DB.batch([
    env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                            published_doc, published_at)
       values (?, ?, null, ?, null, 'a0', ?, 1, ?, ?, 1)`,
    ).bind(id, type, id, id, site, JSON.stringify(doc(slug))),
    env.DB.prepare(
      "insert into content_index (story_id, locale, field, text_value) values (?, '', 'slug', ?)",
    ).bind(id, slug),
  ]);
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("update sites set brand = 'alpha' where id = 'default'"),
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
         ('east', 'group', 'East', null, null, null, 'alpha', 0, 0),
         ('kenya', 'site', 'Kenya', 'east', 'live', 'https://preview.kenya.example', 'alpha', 0, 0),
         ('beta-site', 'site', 'Beta', null, 'live', 'https://preview.beta.example', 'beta', 0, 0)`,
    ),
    env.DB.prepare(
      "insert into site_hosts (host, site_id) values ('kenya.example', 'kenya'), ('beta.example', 'beta-site')",
    ),
  ]);
  // The same slug in both brands; one record inherited from the group; one only beta has.
  await record("rb2_east", "east", "ada");
  await record("rb2_beta", "beta-site", "ada");
  await record("rb2_beta_only", "beta-site", "beta-only");
});

const reader = (host: string) => folio.reader(env, new Request(`https://${host}/`));

describe("recordBy on a deployment with sites and brands", () => {
  it("answers each site's own brand's record for one value", async () => {
    expect((await reader("kenya.example").recordBy("artist", "slug", "ada"))?.story.id).toBe(
      "rb2_east",
    );
    expect((await reader("beta.example").recordBy("artist", "slug", "ada"))?.story.id).toBe(
      "rb2_beta",
    );
  });

  it("does not reach a record outside the chain, even one the other brand holds", async () => {
    expect(await reader("kenya.example").recordBy("artist", "slug", "beta-only")).toBeNull();
    expect((await reader("beta.example").recordBy("artist", "slug", "beta-only"))?.story.id).toBe(
      "rb2_beta_only",
    );
  });

  it("throws for a record type the reader's brand never declared", async () => {
    await expect(reader("beta.example").recordBy("venue", "slug", "x")).rejects.toThrow(
      /not a record type of this brand/,
    );
    // Control: its own brand declares it, so a miss is null and not a throw.
    expect(await reader("kenya.example").recordBy("venue", "slug", "x")).toBeNull();
  });

  /**
   * The nearest scope's record wins, so a publish of the type at kenya must purge the
   * page kenya serves from east's record. That publish purges `type:artist@kenya`
   * (`scopedTagsFor`), and a record page carries no tag of its own type, so the hit
   * has to.
   */
  it("tags a hit with its type at every scope of the chain, so a nearer publish purges it", async () => {
    const hit = await reader("kenya.example").recordBy("artist", "slug", "ada");
    expect(hit?.story.id).toBe("rb2_east");
    const tags = hit!.headers["cache-tag"]!.split(",");
    expect(tags).toContain(scopedTypeTag("artist", "kenya"));
    expect(tags).toContain(scopedTypeTag("artist", "east"));
    expect(tags).toContain("story:rb2_east");
    // Another brand's scope is not in this chain.
    expect(tags).not.toContain(scopedTypeTag("artist", "beta-site"));
  });

  it("answers null for a host that is no site", async () => {
    expect(await reader("stranger.example").recordBy("artist", "slug", "ada")).toBeNull();
  });
});
