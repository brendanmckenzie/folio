import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineBlock, multilink, text } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { Resolution } from "../../src/core/resolve";
import type { FolioBindings } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { SECURE_COOKIE } from "../../src/server/auth/cookie";
import type { Grants } from "../../src/server/auth/roles";
import { createSession } from "../../src/server/auth/session";
import { createToken } from "../../src/server/auth/tokens";
import { createUser } from "../../src/server/auth/users";

/**
 * `GET {base}/api/story/:id/resolution?site=` on a deployment with `sites` (#77).
 *
 * The admin asks on its **own** mount and names the site its pane previews. The site is
 * authorised the way `site/start` authorises it (`mayPreviewDrafts`) and is then
 * resolved on its **full** chain, because the pane's iframe already renders that chain
 * and the two must agree. Each case is one way that has gone wrong:
 *
 * - a group editor's preview must show the pane site's layers, not the group's;
 * - a caller whose only role is `shared` (`previewEligible` on any site) gets an answer
 *   where asking on the pane site's own mount is a 403;
 * - a site the caller may not preview is refused, and **indistinguishably from one that
 *   does not exist**, so `?site=` is neither a metadata leak nor an id oracle.
 *
 * The registry: group `north`; `alpha` and draft site `gamma` (both in north); `bravo`.
 * The global `ersHeader` has a layer on `shared`, `north` and `alpha`, each titled for
 * where it lives, so the title says which chain a resolution was built on.
 */

const ADMIN = "https://cms.example";

const hPage = defineBlock({
  name: "ersPage",
  label: "Page",
  summary: "title",
  fields: { title: text({ required: true }), link: multilink() },
  render: () => null,
});

const headerRoot = defineBlock({
  name: "ersHeaderRoot",
  label: "Header",
  fields: { title: text() },
  render: () => null,
});

const folio = createFolio<Cloudflare.Env>({
  blocks: [hPage, headerRoot],
  types: [
    { name: "ersPage", label: "Page", kind: "page", root: "ersPage", default: true },
    { name: "ersHeader", label: "Header", kind: "singleton", root: "ersHeaderRoot" },
  ],
  globals: ["ersHeader"],
  bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: "/folio",
  assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : "/",
  sites: { admin: ADMIN },
});

const docOf = (title: string, link?: string): Doc => ({
  root: "r0",
  bloks: {
    r0: {
      uid: "r0",
      type: "ersPage",
      parent: null,
      slot: null,
      order: "a0",
      data: { title, ...(link ? { link: { kind: "story", id: link } } : {}) } as Record<
        string,
        Json
      >,
    },
  },
});

async function story(id: string, site: string, path: string, doc: Doc) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id)
     values (?, 'ersPage', null, ?, ?, 'a0', ?, 1, ?)`,
  )
    .bind(id, path, path, path, site)
    .run();
  await runInDurableObject(env.STORY.get(env.STORY.idFromName(id)), (instance) =>
    instance.getOrInit(doc),
  );
}

/** A published layer of the global, so a cold object seeds from it. */
async function layer(scope: string, title: string) {
  const doc: Doc = {
    root: "h0",
    bloks: {
      h0: {
        uid: "h0",
        type: "ersHeaderRoot",
        parent: null,
        slot: null,
        order: "a0",
        data: { title },
      },
    },
  };
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, 'ersHeader', null, 'ersHeader', null, 'a0', 'Header', 1, ?, ?, 2)`,
  )
    .bind(`sng_ersHeader:${scope}`, scope, JSON.stringify(doc))
    .run();
}

async function cookieFor(email: string, grants: Grants) {
  const user = await createUser(env.DB, { email, grants });
  const session = await createSession(env.DB, user.id);
  return { cookie: `${SECURE_COOKIE}=${session.token}` };
}

async function bearer(site: string) {
  const { token } = await createToken(env.DB, {
    name: `ers-${site}`,
    scopes: ["content:read", "content:read:draft"],
    site,
  });
  return { authorization: `Bearer ${token}` };
}

const get = (path: string, headers: Record<string, string>) =>
  folio.handle(new Request(`${ADMIN}${path}`, { headers }), env, createExecutionContext());

const ids = (r: Resolution) => Object.keys(r.stories);
const headerOf = (r: Resolution) =>
  (r.globals?.ersHeader?.bloks.h0?.data as { title?: string } | undefined)?.title;

let N: Record<string, string>; // {shared: publisher}
let E: Record<string, string>; // {alpha: editor}
let R: Record<string, string>; // {north: editor}
let T: Record<string, string>; // token bound to alpha

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', 'https://preview.alpha.example', 0, 0),
         ('gamma', 'site', 'Secret Gamma Launch', 'north', 'draft', 'https://preview.gamma.example', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', 'https://preview.bravo.example', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values ('alpha.example', 'alpha'), ('bravo.example', 'bravo')`,
    ),
  ]);
  await story("sty_ers_alpha", "alpha", "alpha-page", docOf("Alpha page"));
  await story("sty_ers_north", "north", "north-page", docOf("North page"));
  await story("sty_ers_shared", "shared", "shared-page", docOf("Shared page", "sty_ers_alpha"));
  await layer("shared", "SHARED HEADER");
  await layer("north", "NORTH HEADER");
  await layer("alpha", "ALPHA HEADER");
  N = await cookieFor("ers-n@example.com", { shared: "publisher" });
  E = await cookieFor("ers-e@example.com", { alpha: "editor" });
  R = await cookieFor("ers-r@example.com", { north: "editor" });
  T = await bearer("alpha");
});

describe("resolution on a deployment with sites", () => {
  it("resolves a group editor's preview on the pane site's chain, not the group's", async () => {
    const res = await get("/folio/~north/api/story/sty_ers_north/resolution?site=alpha", R);
    expect(res?.status).toBe(200);
    const resolution = (await res!.json()) as Resolution;
    expect(resolution.site?.id).toBe("alpha");
    expect(headerOf(resolution)).toBe("ALPHA HEADER");
  });

  it("answers a shared-only caller on their own mount, as the pane site", async () => {
    const res = await get("/folio/~shared/api/story/sty_ers_shared/resolution?site=alpha", N);
    expect(res?.status).toBe(200);
    const resolution = (await res!.json()) as Resolution;
    expect(resolution.site?.id).toBe("alpha");
    // The same chain the iframe's own bootstrap was rendered on.
    expect(headerOf(resolution)).toBe("ALPHA HEADER");
    expect(ids(resolution)).toContain("sty_ers_alpha");
  });

  it("is a 403 on the pane site's own mount for that caller, which is why it is not used", async () => {
    const res = await get("/folio/~alpha/api/story/sty_ers_shared/resolution", N);
    expect(res?.status).toBe(403);
  });

  it("resolves an alpha editor previewing as alpha", async () => {
    const res = await get("/folio/~alpha/api/story/sty_ers_shared/resolution?site=alpha", E);
    expect(res?.status).toBe(200);
    expect(headerOf((await res!.json()) as Resolution)).toBe("ALPHA HEADER");
  });

  /** The body and status of a refused site, which must not depend on why. */
  async function refusal(path: string, who: Record<string, string>) {
    const res = await get(path, who);
    return { status: res?.status, body: await res?.text() };
  }

  it("refuses a site the token's binding does not reach, as it does one that does not exist", async () => {
    const bravo = await refusal("/folio/api/story/sty_ers_shared/resolution?site=bravo", T);
    const unknown = await refusal("/folio/api/story/sty_ers_shared/resolution?site=nowhere", T);
    expect(bravo.status).toBe(404);
    expect(bravo).toEqual(unknown);
    expect(bravo.body).not.toContain("Bravo");
  });

  it("refuses a draft site the caller may not preview, as it does one that does not exist", async () => {
    const alphaEditor = await refusal(
      "/folio/~alpha/api/story/sty_ers_shared/resolution?site=gamma",
      E,
    );
    const alphaUnknown = await refusal(
      "/folio/~alpha/api/story/sty_ers_shared/resolution?site=nowhere",
      E,
    );
    expect(alphaEditor.status).toBe(404);
    expect(alphaEditor).toEqual(alphaUnknown);
    expect(alphaEditor.body).not.toContain("Secret");
  });

  it("refuses a site that cannot show the story", async () => {
    const res = await get("/folio/~alpha/api/story/sty_ers_alpha/resolution?site=bravo", E);
    expect(res?.status).toBe(404);
  });

  it("answers for the shared scope with no site named, rather than an empty resolution", async () => {
    const res = await get("/folio/~shared/api/story/sty_ers_shared/resolution", N);
    expect(res?.status).toBe(200);
    expect(headerOf((await res!.json()) as Resolution)).toBe("SHARED HEADER");
  });
});
