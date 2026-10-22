import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { blocks, defineBlock, resolveReference, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { Resolution } from "../../src/core/resolve";
import type { DocumentType } from "../../src/core/schema";
import { createFolio, magicLink } from "../../src/server";
import { createShare } from "../../src/server/auth/shares";

/**
 * A record previewed in the context of a host page (`previewPath` on a record type,
 * `?_folio=preview&record=<id>`): the page is drawn around the record's **draft**,
 * `resolution.record` names it, and the request is refused in every shape that would
 * make it something else.
 *
 * `auth: 'open'` for the happy path and a session-gated twin for the share-grant
 * refusal, which has no meaning when every route is open.
 */

const ORIGIN = "https://folio.test";

const Hosted = ({ resolution }: { resolution: Resolution }) => {
  const rec = resolveReference(resolution.record, resolution);
  return createElement("p", { className: "rec" }, rec ? `record:${String(rec.data.name)}` : "none");
};

const hostPage = defineBlock({
  name: "prHost",
  label: "Host",
  fields: { title: text(), body: blocks({ allow: [] }) },
  render: ({ title }, resolution) =>
    createElement(
      "main",
      null,
      createElement("h1", null, title),
      createElement(Hosted, { resolution }),
    ),
});
const personRoot = defineBlock({
  name: "prPerson",
  label: "Person",
  fields: { name: text() },
  render: () => null,
});

const pageType: DocumentType = {
  name: "prPageType",
  label: "Page",
  kind: "page",
  root: "prHost",
  default: true,
};
const personType: DocumentType = {
  name: "prPersonType",
  label: "Person",
  kind: "record",
  root: "prPerson",
  previewPath: "authors",
};

const bindings = (e: Cloudflare.Env) => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const build = (auth?: Parameters<typeof createFolio<Cloudflare.Env>>[0]["auth"]) =>
  createFolio<Cloudflare.Env>({
    blocks: [hostPage, personRoot],
    types: [pageType, personType],
    bindings,
    basePath: "/folio",
    assets: { admin: "/a.js", preview: "/p.js" },
    ...(auth ? { auth } : { auth: "open" }),
    route: (p) => (p ? `/${p}` : "/"),
  });

const open = build();
const gated = build({ providers: [magicLink<Cloudflare.Env>({ send: () => {} })] });

const call = (path: string, init?: RequestInit, which = open) =>
  which.handle(new Request(`${ORIGIN}${path}`, init), env, createExecutionContext());

let n = 0;
async function seed(type: string, slug: string, doc: Doc, title: string, routed = true) {
  const id = `sty_pr${(n++).toString().padStart(3, "0")}`;
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
     values (?, ?, null, ?, ?, 'a0', ?, ?, ?)`,
  )
    .bind(id, type, slug, routed ? slug : null, title, Date.now(), Date.now())
    .run();
  await runInDurableObject(env.STORY.get(env.STORY.idFromName(id)), (o) => o.getOrInit(doc));
  return id;
}

const pageDoc = (title: string): Doc => ({
  root: "r0",
  bloks: {
    r0: { uid: "r0", type: "prHost", parent: null, slot: null, order: "a0", data: { title } },
  },
});
const personDoc = (name: string): Doc => ({
  root: "p0",
  bloks: {
    p0: { uid: "p0", type: "prPerson", parent: null, slot: null, order: "a0", data: { name } },
  },
});

/** A host page and a record whose *draft* differs from anything published. */
async function fixture() {
  const slug = `host${n}`;
  const page = await seed("prPageType", slug, pageDoc("Host page heading"), "Host");
  const record = await seed("prPersonType", `person${n}`, personDoc("Seeded"), "Ada", false);
  await runInDurableObject(env.STORY.get(env.STORY.idFromName(record)), (o) =>
    o.commit([{ t: "set", uid: "p0", field: "name", value: "Draft Ada" }], { id: "t", name: "T" }),
  );
  return { page, record, path: `/${slug}` };
}

function bootstrap(html: string): {
  doc: Doc;
  resolution: Resolution;
  editing?: { record?: string; page?: Doc };
} {
  const match = html.match(/window\.__FOLIO__=(.*?)<\/script>/s);
  expect(match, "no bootstrap").not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("?_folio=preview&record=", () => {
  it("renders the host page around the record's draft", async () => {
    const { record, path } = await fixture();
    const res = await call(`${path}?_folio=preview&record=${record}`);
    expect(res?.status).toBe(200);
    const html = await res!.text();

    // The page's own content, and the record's *draft* through the host block.
    expect(html).toContain("Host page heading");
    expect(html).toContain("record:Draft Ada");

    const boot = bootstrap(html);
    expect(boot.resolution.record).toBe(record);
    expect(boot.resolution.docs?.[record]?.bloks.p0?.data.name).toBe("Draft Ada");
    expect(boot.resolution.stories[record]?.title).toBe("Ada");
    // The bootstrap's document is the record's; the page rides beside it.
    expect(boot.doc.root).toBe("p0");
    expect(boot.editing?.record).toBe(record);
    expect(boot.editing?.page?.bloks.r0?.data.title).toBe("Host page heading");
    // Context, not the edited document: no uids on the page.
    expect(html).not.toContain("data-folio-uid");
  });

  it("is unchanged for a page with no record parameter", async () => {
    const { path } = await fixture();
    const html = await (await call(`${path}?_folio=preview`))!.text();
    expect(html).toContain("none");
    expect(bootstrap(html).resolution.record).toBeUndefined();
    expect(bootstrap(html).editing).toBeUndefined();
  });

  it("is refused in draft mode, with both parameters, and for anything that is not a record", async () => {
    const { page, record, path } = await fixture();
    expect(await call(`${path}?_folio=draft&record=${record}`)).toBeNull();
    expect(await call(`${path}?_folio=preview&record=${record}&as=prPersonType`)).toBeNull();
    // A page is not a record, and an id that is nothing is not either.
    expect(await call(`${path}?_folio=preview&record=${page}`)).toBeNull();
    expect(await call(`${path}?_folio=preview&record=sty_nothing`)).toBeNull();
    // Refused before any draft is read: no Durable Object is made for the stranger.
    const stub = env.STORY.get(env.STORY.idFromName("sty_nothing"));
    expect(
      await runInDurableObject(stub, async (_o, state) => (await state.storage.list()).size),
    ).toBe(0);
  });

  /**
   * Editor-only. A share grant covers one page and a record is another document, so
   * the cookie that is good for the host page is refused here, and the link itself
   * cannot be minted for a record (`routes/preview.ts`).
   */
  it("is refused for a share grant, even one for the host page", async () => {
    const { page, record, path } = await fixture();
    const share = await createShare(env.DB, { storyId: page, expiresAt: Date.now() + 60_000 });
    const cookie = { headers: { cookie: `folio_share=${share.token}` } };
    // The control: the same grant opens the page itself.
    expect((await call(`${path}?_folio=draft`, cookie, gated))?.status).toBe(200);
    expect(await call(`${path}?_folio=preview&record=${record}`, cookie, gated)).toBeNull();
    expect(await call(`${path}?_folio=draft&record=${record}`, cookie, gated)).toBeNull();
  });
});
