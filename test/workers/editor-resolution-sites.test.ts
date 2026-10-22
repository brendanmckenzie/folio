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
import { createUser } from "../../src/server/auth/users";

/**
 * `GET {base}/api/story/:id/resolution?site=` on a deployment with `sites` (#77).
 *
 * The admin asks on its **own** mount and names the site its pane previews. The site is
 * context, never authority: the chain resolved on is narrowed to what the request's own
 * scope may already read. Three things follow and each has a case here:
 *
 * - a caller whose only role is `shared` (who `previewEligible` lets preview on any site)
 *   gets an answer, where asking on the pane site's own mount is a 403;
 * - a named site that cannot show the story is refused;
 * - naming a site never reveals content outside the caller's own chain.
 *
 * The registry: group `north`; `alpha` (in north); `bravo`. Stories: a shared page, an
 * alpha page and a bravo page; the shared page links to the alpha page.
 */

const ADMIN = "https://cms.example";

const hPage = defineBlock({
  name: "ersPage",
  label: "Page",
  summary: "title",
  fields: { title: text({ required: true }), link: multilink() },
  render: () => null,
});

const folio = createFolio<Cloudflare.Env>({
  blocks: [hPage],
  types: [{ name: "ersPage", label: "Page", kind: "page", root: "ersPage", default: true }],
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

async function cookieFor(email: string, grants: Grants) {
  const user = await createUser(env.DB, { email, grants });
  const session = await createSession(env.DB, user.id);
  return { cookie: `${SECURE_COOKIE}=${session.token}` };
}

const get = (path: string, headers: Record<string, string>) =>
  folio.handle(new Request(`${ADMIN}${path}`, { headers }), env, createExecutionContext());

const ids = (r: Resolution) => Object.keys(r.stories);

let N: Record<string, string>; // {shared: publisher}
let E: Record<string, string>; // {alpha: editor}
let B: Record<string, string>; // {bravo: editor}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', 'https://preview.alpha.example', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', 'https://preview.bravo.example', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values ('alpha.example', 'alpha'), ('bravo.example', 'bravo')`,
    ),
  ]);
  await story("sty_ers_alpha", "alpha", "alpha-page", docOf("Alpha page"));
  await story("sty_ers_bravo", "bravo", "bravo-page", docOf("Bravo page"));
  await story("sty_ers_shared", "shared", "shared-page", docOf("Shared page", "sty_ers_alpha"));
  await story("sty_ers_shared_b", "shared", "shared-b", docOf("Shared B", "sty_ers_shared"));
  N = await cookieFor("ers-n@example.com", { shared: "publisher" });
  E = await cookieFor("ers-e@example.com", { alpha: "editor" });
  B = await cookieFor("ers-b@example.com", { bravo: "editor" });
});

describe("resolution on a deployment with sites", () => {
  it("answers a shared-only caller on their own mount, as the pane site", async () => {
    const res = await get("/folio/~shared/api/story/sty_ers_shared/resolution?site=alpha", N);
    expect(res?.status).toBe(200);
    const resolution = (await res!.json()) as Resolution;
    expect(resolution.site?.id).toBe("alpha");
    // Alpha's own page is outside what a `shared` caller may read: the named site is
    // context, not authority.
    expect(ids(resolution)).not.toContain("sty_ers_alpha");
  });

  it("is a 403 on the pane site's own mount for that caller, which is why it is not used", async () => {
    const res = await get("/folio/~alpha/api/story/sty_ers_shared/resolution", N);
    expect(res?.status).toBe(403);
  });

  it("resolves a shared page's link to alpha's page for an alpha editor previewing as alpha", async () => {
    const res = await get("/folio/~alpha/api/story/sty_ers_shared/resolution?site=alpha", E);
    expect(res?.status).toBe(200);
    expect(ids((await res!.json()) as Resolution)).toContain("sty_ers_alpha");
  });

  it("does not let an alpha editor previewing as bravo read past their own chain", async () => {
    // Bravo shows shared pages, so the site is allowed; the link to alpha's page
    // resolves against alpha's chain and against nobody else's.
    const res = await get("/folio/~alpha/api/story/sty_ers_shared/resolution?site=bravo", E);
    expect(res?.status).toBe(200);
    const resolution = (await res!.json()) as Resolution;
    expect(resolution.site?.id).toBe("bravo");
    expect(ids(resolution)).not.toContain("sty_ers_alpha");
    expect(ids(resolution)).not.toContain("sty_ers_bravo");
  });

  it("refuses a site that cannot show the story", async () => {
    const res = await get("/folio/~alpha/api/story/sty_ers_alpha/resolution?site=bravo", E);
    expect(res?.status).toBe(400);
  });

  it("404s another site's story on the caller's own mount", async () => {
    const res = await get("/folio/~bravo/api/story/sty_ers_alpha/resolution?site=bravo", B);
    expect(res?.status).toBe(404);
  });

  it("answers for the shared scope with no site named, rather than an empty resolution", async () => {
    const res = await get("/folio/~shared/api/story/sty_ers_shared_b/resolution", N);
    expect(res?.status).toBe(200);
    const resolution = (await res!.json()) as Resolution;
    expect(ids(resolution)).toContain("sty_ers_shared");
  });
});
