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
 * A record previewed in a block Folio synthesises (`previewRoot` on a record type,
 * `?_folio=preview&record=<id>` at any path), `record-preview-root.md` decisions 2, 7
 * and 8: nothing stored for the host, every global above the frame, `previewRoot`
 * winning over `previewPath`, and every refusal the `previewPath` form has plus
 * `_folio_id`.
 */

const ORIGIN = "https://folio.test";

const Framed = ({ resolution }: { resolution: Resolution }) => {
  const rec = resolveReference(resolution.record, resolution);
  return createElement("p", { className: "rec" }, rec ? `record:${String(rec.data.name)}` : "none");
};

const frame = defineBlock({
  name: "prrFrame",
  label: "Frame",
  fields: { caption: text({ default: "Frame caption" }), body: blocks({ allow: [] }) },
  previewParams: { density: "tight" },
  render: ({ caption }, resolution) =>
    createElement(
      "main",
      null,
      createElement("h1", null, caption),
      createElement(Framed, { resolution }),
    ),
});
const hostPage = defineBlock({
  name: "prrHost",
  label: "Host",
  fields: { title: text(), body: blocks({ allow: [] }) },
  render: ({ title }) => createElement("main", null, createElement("h1", null, title)),
});
const header = defineBlock({
  name: "prrHeader",
  label: "Header",
  fields: { tagline: text({ default: "Global header" }) },
  render: ({ tagline }) => createElement("header", null, tagline),
});
const personRoot = defineBlock({
  name: "prrPerson",
  label: "Person",
  fields: { name: text() },
  render: () => null,
});

const pageType: DocumentType = {
  name: "prrPageType",
  label: "Page",
  kind: "page",
  root: "prrHost",
  default: true,
};
const headerType: DocumentType = {
  name: "prrHeaderType",
  label: "Header",
  kind: "singleton",
  root: "prrHeader",
};
const personType: DocumentType = {
  name: "prrPersonType",
  label: "Person",
  kind: "record",
  root: "prrPerson",
  previewRoot: "prrFrame",
  // Both set is the ordinary state while a host migrates; the root wins.
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
    blocks: [frame, hostPage, header, personRoot],
    types: [pageType, headerType, personType],
    globals: ["prrHeaderType"],
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
  const id = `sty_prr${(n++).toString().padStart(3, "0")}`;
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
     values (?, ?, null, ?, ?, 'a0', ?, ?, ?)`,
  )
    .bind(id, type, slug, routed ? slug : null, title, Date.now(), Date.now())
    .run();
  await runInDurableObject(env.STORY.get(env.STORY.idFromName(id)), (o) => o.getOrInit(doc));
  return id;
}

const rootDoc = (type: string, data: Record<string, string>): Doc => ({
  root: "r0",
  bloks: { r0: { uid: "r0", type, parent: null, slot: null, order: "a0", data } },
});

// The configured global's singleton row is created by any render that draws it, and is not a host page.
const storyCount = async () =>
  (await env.DB.prepare(
    "select count(*) as c from stories where type not in ('prrHeaderType')",
  ).first<{ c: number }>())!.c;

const doStorageSize = (id: string) =>
  runInDurableObject(
    env.STORY.get(env.STORY.idFromName(id)),
    async (_o, state) => (await state.storage.list()).size,
  );

/** A record whose *draft* differs from anything published, and a page at `/authors`. */
let authorsPage: Promise<string> | undefined;
async function fixture() {
  authorsPage ??= seed(
    "prrPageType",
    "authors",
    rootDoc("prrHost", { title: "Authors page" }),
    "Authors",
  );
  const authors = await authorsPage;
  const record = await seed(
    "prrPersonType",
    `person${n}`,
    rootDoc("prrPerson", { name: "Seeded" }),
    "Ada",
    false,
  );
  await runInDurableObject(env.STORY.get(env.STORY.idFromName(record)), (o) =>
    o.commit([{ t: "set", uid: "r0", field: "name", value: "Draft Ada" }], { id: "t", name: "T" }),
  );
  return { record, authors };
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

describe("?_folio=preview&record= with previewRoot", () => {
  it("renders the frame and every global around the record's draft, and stores nothing", async () => {
    const { record } = await fixture();
    const before = await storyCount();
    const res = await call(`/?_folio=preview&record=${record}`);
    expect(res?.status).toBe(200);
    expect(res!.headers.get("cache-control")).toContain("no-store");
    const html = await res!.text();

    expect(html).toContain("Global header");
    expect(html).toContain("Frame caption");
    expect(html).toContain("record:Draft Ada");
    expect(html).not.toContain("Authors page");
    // The frame is context, not the edited document: no marker on it (the globals have them).
    expect(html).not.toContain('data-folio-type="prrFrame"');

    const boot = bootstrap(html);
    expect(boot.resolution.record).toBe(record);
    expect(boot.doc.root).toBe("r0");
    expect(boot.doc.bloks.r0?.data.name).toBe("Draft Ada");
    const page = boot.editing?.page;
    expect(boot.editing?.record).toBe(record);
    expect(page?.bloks[page.root]?.type).toBe("prrFrame");
    // No host row and no Durable Object for the synthetic page.
    expect(await storyCount()).toBe(before);
    expect(await doStorageSize(page!.root)).toBe(0);
  });

  it("wins over previewPath, whatever the path", async () => {
    const { record } = await fixture();
    for (const path of ["/", "/authors", "/nowhere/at/all"]) {
      const html = await (await call(`${path}?_folio=preview&record=${record}`))!.text();
      expect(html, path).toContain("Frame caption");
      expect(html, path).not.toContain("Authors page");
    }
  });

  it("carries the frame block's previewParams into the bootstrap", async () => {
    const { record } = await fixture();
    const html = await (await call(`/?_folio=preview&record=${record}`))!.text();
    expect(bootstrap(html).resolution.params).toEqual({ density: "tight" });
  });

  it("is refused in draft mode, with as, with _folio_id, and for anything that is not a record", async () => {
    const { record, authors } = await fixture();
    expect(await call(`/?_folio=draft&record=${record}`)).toBeNull();
    expect(await call(`/?_folio=preview&record=${record}&as=prrHeaderType`)).toBeNull();
    expect(await call(`/?_folio=preview&record=${record}&_folio_id=${authors}`)).toBeNull();
    // A page is not a record, and an id that is nothing is not either.
    expect(await call(`/?_folio=preview&record=${authors}`)).toBeNull();
    expect(await call(`/?_folio=preview&record=sty_nothing`)).toBeNull();
    // Refused before any draft is read: no Durable Object is made for the stranger.
    expect(await doStorageSize("sty_nothing")).toBe(0);
  });

  it("is refused for a share grant, and stamps no view", async () => {
    const { record, authors } = await fixture();
    const share = await createShare(env.DB, { storyId: authors, expiresAt: Date.now() + 60_000 });
    const cookie = { headers: { cookie: `folio_share=${share.token}` } };
    // The control: the same grant opens its own page.
    expect((await call(`/authors?_folio=draft`, cookie, gated))?.status).toBe(200);
    const views = async () =>
      (await env.DB.prepare("select views from shares where id = ?").bind(share.row.id).first<{
        views: number;
      }>())!.views;
    const stamped = await views();
    expect(await call(`/?_folio=preview&record=${record}`, cookie, gated)).toBeNull();
    expect(await call(`/authors?_folio=preview&record=${record}`, cookie, gated)).toBeNull();
    expect(await views()).toBe(stamped);
  });
});
