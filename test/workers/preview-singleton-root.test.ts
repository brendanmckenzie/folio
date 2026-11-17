import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { blocks, defineBlock, defineRecord, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import { createFolio, magicLink } from "../../src/server";
import { createShare } from "../../src/server/auth/shares";

/**
 * A global previewed in a block Folio synthesises (`previewRoot` on a singleton type,
 * `?_folio=preview&as=<name>` at any path), `singleton-preview-root.md` decisions 2
 * and 3: nothing stored for the host, every global drawn as on a `previewPath` page,
 * the edited one's draft as the one editable document, `previewRoot` winning over
 * `previewPath`, and every refusal `as` has plus `_folio_id`. A singleton with only
 * `previewPath` is unchanged.
 */

const ORIGIN = "https://folio.test";

const frame = defineBlock({
  name: "psrFrame",
  label: "Frame",
  fields: { note: text({ default: "Neutral frame" }), body: blocks({ allow: [] }) },
  previewParams: { density: "tight" },
  // The frame is told nothing about the global being edited, and no record.
  render: ({ note }, resolution) =>
    createElement("main", null, `${note}|record:${resolution.record ?? "none"}`),
});
const hostPage = defineBlock({
  name: "psrHost",
  label: "Host",
  fields: { title: text(), body: blocks({ allow: [] }) },
  render: ({ title }) => createElement("main", null, createElement("h1", null, title)),
});
const header = defineBlock({
  name: "psrHeader",
  label: "Header",
  fields: { tagline: text({ default: "Header default" }) },
  render: ({ tagline }) => createElement("header", null, `header:${tagline}`),
});
const footer = defineBlock({
  name: "psrFooter",
  label: "Footer",
  fields: { note: text({ default: "Footer default" }) },
  render: ({ note }) => createElement("footer", null, `footer:${note}`),
});

const pageType: DocumentType = {
  name: "psrPageType",
  label: "Page",
  kind: "page",
  root: "psrHost",
  default: true,
};
const headerType: DocumentType = {
  name: "psrHeaderType",
  label: "Site header",
  kind: "singleton",
  root: "psrHeader",
  previewRoot: "psrFrame",
  // Both set is the ordinary state while a host migrates; the root wins.
  previewPath: "home",
};
/** The control: a global with only `previewPath`, exactly as before. */
const footerType: DocumentType = {
  name: "psrFooterType",
  label: "Footer",
  kind: "singleton",
  root: "psrFooter",
  previewPath: "home",
};

const bindings = (e: Cloudflare.Env) => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const build = (auth?: Parameters<typeof createFolio<Cloudflare.Env>>[0]["auth"]) =>
  createFolio<Cloudflare.Env>({
    blocks: [frame, hostPage, header, footer],
    types: [pageType, headerType, footerType],
    globals: ["psrHeaderType", "psrFooterType"],
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

const rootDoc = (uid: string, type: string, data: Record<string, string>): Doc => ({
  root: uid,
  bloks: { [uid]: { uid, type, parent: null, slot: null, order: "a0", data } },
});

/** The home page (the `previewPath` both globals name), and a draft for each global. */
let seeded: Promise<string> | undefined;
function fixture() {
  seeded ??= (async () => {
    const id = "sty_psrhome";
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
       values (?, 'psrPageType', null, 'home', 'home', 'a0', 'Home', ?, ?)`,
    )
      .bind(id, Date.now(), Date.now())
      .run();
    await runInDurableObject(env.STORY.get(env.STORY.idFromName(id)), (o) =>
      o.getOrInit(rootDoc("r0", "psrHost", { title: "Home hero" })),
    );
    await runInDurableObject(env.STORY.get(env.STORY.idFromName("sng_psrHeaderType")), (o) =>
      o.getOrInit(rootDoc("hdr00001", "psrHeader", { tagline: "Draft header" })),
    );
    await runInDurableObject(env.STORY.get(env.STORY.idFromName("sng_psrFooterType")), (o) =>
      o.getOrInit(rootDoc("ftr00001", "psrFooter", { note: "Draft footer" })),
    );
    return id;
  })();
  return seeded;
}

const pageCount = async () =>
  (await env.DB.prepare("select count(*) as c from stories where type = 'psrPageType'").first<{
    c: number;
  }>())!.c;

function bootstrap(html: string): {
  doc: Doc;
  resolution: { params?: Record<string, string>; record?: string };
  editing?: { global?: string; mount?: string; record?: string; page?: Doc };
} {
  const match = html.match(/window\.__FOLIO__=(.*?)<\/script>/s);
  expect(match, "no bootstrap").not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("?_folio=preview&as= with previewRoot", () => {
  it("renders the frame and every global around the global's draft, and stores nothing", async () => {
    await fixture();
    const before = await pageCount();
    const res = await call("/?_folio=preview&as=psrHeaderType");
    expect(res?.status).toBe(200);
    expect(res!.headers.get("cache-control")).toContain("no-store");
    const html = await res!.text();

    expect(html).toContain("header:Draft header");
    expect(html).toContain("footer:Draft footer");
    expect(html).toContain("Neutral frame|record:none");
    expect(html).not.toContain("Home hero");
    expect(html).toContain("<title>Preview · Site header</title>");
    // The frame is context, not the edited document: no marker on it (the globals have them).
    expect(html).not.toContain('data-folio-type="psrFrame"');
    expect(html).toContain('data-folio-global="psrHeaderType"');

    const boot = bootstrap(html);
    expect(boot.editing).toEqual({
      global: "psrHeaderType",
      mount: '[data-folio-global="psrHeaderType"]',
    });
    expect(boot.doc.bloks[boot.doc.root]?.data.tagline).toBe("Draft header");
    expect(boot.resolution.record).toBeUndefined();
    // No host page row, and the synthetic page carries no story into the bootstrap.
    expect(await pageCount()).toBe(before);
  });

  it("wins over previewPath, whatever the path", async () => {
    await fixture();
    for (const path of ["/", "/home", "/nowhere/at/all"]) {
      const html = await (await call(`${path}?_folio=preview&as=psrHeaderType`))!.text();
      expect(html, path).toContain("Neutral frame");
      expect(html, path).not.toContain("Home hero");
    }
  });

  it("carries the frame block's previewParams into the bootstrap", async () => {
    await fixture();
    const html = await (await call("/?_folio=preview&as=psrHeaderType"))!.text();
    expect(bootstrap(html).resolution.params).toEqual({ density: "tight" });
  });

  it("leaves a previewPath-only global exactly as it was", async () => {
    await fixture();
    // On the home page, the page's own content as context.
    const html = await (await call("/home?_folio=preview&as=psrFooterType"))!.text();
    expect(html).toContain("Home hero");
    expect(html).not.toContain("Neutral frame");
    expect(bootstrap(html).editing?.global).toBe("psrFooterType");
    // And at a path with no story it is handed back, as it always was.
    expect(await call("/?_folio=preview&as=psrFooterType")).toBeNull();
  });

  it("is refused in draft mode, with record, with _folio_id, and for a name that is no global", async () => {
    const home = await fixture();
    expect(await call("/?_folio=draft&as=psrHeaderType")).toBeNull();
    expect(await call(`/?_folio=preview&as=psrHeaderType&_folio_id=${home}`)).toBeNull();
    expect(await call(`/?_folio=preview&as=psrHeaderType&record=${home}`)).toBeNull();
    expect(await call("/?_folio=preview&as=nope")).toBeNull();
    expect(await call("/?_folio=preview&as=psrPageType")).toBeNull();
  });

  it("is refused for a share grant, and stamps no view", async () => {
    const home = await fixture();
    const share = await createShare(env.DB, { storyId: home, expiresAt: Date.now() + 60_000 });
    const cookie = { headers: { cookie: `folio_share=${share.token}` } };
    // The control: the same grant opens its own page.
    expect((await call("/home?_folio=draft", cookie, gated))?.status).toBe(200);
    const views = async () =>
      (await env.DB.prepare("select views from shares where id = ?").bind(share.row.id).first<{
        views: number;
      }>())!.views;
    const stamped = await views();
    expect(await call("/?_folio=preview&as=psrHeaderType", cookie, gated)).toBeNull();
    expect(await call("/home?_folio=preview&as=psrHeaderType", cookie, gated)).toBeNull();
    expect(await views()).toBe(stamped);
  });
});

describe("construction", () => {
  const withHeader =
    (over: Partial<DocumentType>, globals = ["psrHeaderType"]) =>
    () =>
      createFolio<Cloudflare.Env>({
        blocks: [frame, hostPage, header, footer, bareFrame],
        types: [pageType, { ...headerType, ...over }],
        globals,
        bindings,
        basePath: "/folio",
        assets: { admin: "/a.js", preview: "/p.js" },
        auth: "open",
        route: (p) => (p ? `/${p}` : "/"),
      });
  const bareFrame = defineRecord({ name: "psrBare", label: "Bare", fields: { x: text() } });

  it("accepts a configured global naming a rendering block", () => {
    expect(withHeader({})).not.toThrow();
  });

  it("refuses an unknown block, a block with no render, and a singleton that is not a global", () => {
    expect(withHeader({ previewRoot: "ghost" })).toThrow(
      /'psrHeaderType' names previewRoot 'ghost', which is not in the registry/,
    );
    expect(withHeader({ previewRoot: "psrBare" })).toThrow(
      /'psrHeaderType' names previewRoot 'psrBare', which has no render/,
    );
    expect(withHeader({}, [])).toThrow(
      /'psrHeaderType' names previewRoot 'psrFrame', but is not one of 'globals'/,
    );
  });
});
