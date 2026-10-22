import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defineBlock, defineRecord, text } from "../../src/core";
import { NO_STORE } from "../../src/core/cache-tags";
import type { Doc } from "../../src/core/doc";
import type { Resolution } from "../../src/core/resolve";
import type { DocumentType } from "../../src/core/schema";
import type { AuthConfig, FolioBindings } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { SECURE_COOKIE, SECURE_DRAFT_COOKIE } from "../../src/server/auth/cookie";
import { createSession } from "../../src/server/auth/session";
import { createUser } from "../../src/server/auth/users";

/**
 * Host-supplied render parameters (issue #76). The security-shaped half is the headers:
 * Folio cannot see what `params` depend on, so a page given them is `no-store` unless
 * the host asserts they derive from the URL with `cacheable: true`. The other half is
 * that a block's `previewParams` reach the editor's preview, the editor's resolution
 * route and `?_folio=draft` identically. Ids are `rp_`-prefixed, D1 state being shared
 * across a file.
 */

const ORIGIN = "https://folio.test";

const rpPage = defineBlock({
  name: "rpPage",
  label: "Page",
  fields: { title: text() },
  previewParams: { tag: "preview-tag" },
  render: ({ title }, resolution) => (
    <p>{`${title}|${String(resolution.params?.tag ?? "none")}`}</p>
  ),
});
const rpArtist = defineRecord({
  name: "rpArtist",
  label: "Artist",
  summary: "name",
  previewParams: { genre: "jazz", tag: "record-tag" },
  fields: {
    name: text({ indexed: true }),
    slug: text({ indexed: true, unique: true }),
  },
});

const types: DocumentType[] = [
  { name: "rpPageType", label: "Page", kind: "page", root: "rpPage", default: true },
  {
    name: "rpArtistType",
    label: "Artist",
    kind: "record",
    root: "rpArtist",
    titleField: "name",
    previewPath: "rp-home",
  },
];

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
};

const folio = createFolio<Cloudflare.Env>({
  blocks: [rpPage, rpArtist],
  types,
  bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: "/folio",
  assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
  auth,
  route: (p) => (p ? `/${p}` : "/"),
});

const DRAFT = `${SECURE_DRAFT_COOKIE}=1`;
const req = (cookie?: string) =>
  new Request(`${ORIGIN}/`, cookie ? { headers: { cookie } } : undefined);

let users = 0;
async function editorCookie(): Promise<string> {
  const user = await createUser(env.DB, {
    email: `rp-editor${users++}@example.com`,
    name: "editor",
    role: "editor",
  });
  const session = await createSession(env.DB, user.id);
  return `${SECURE_COOKIE}=${session.token}`;
}

const pageDoc = (title: string): Doc => ({
  root: "r",
  bloks: {
    r: { uid: "r", type: "rpPage", parent: null, slot: null, order: "a0", data: { title } },
  },
});
const artistDoc = (name: string, slug: string): Doc => ({
  root: "r",
  bloks: {
    r: { uid: "r", type: "rpArtist", parent: null, slot: null, order: "a0", data: { name, slug } },
  },
});

async function seedPage(id: string, path: string): Promise<void> {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at)
     values (?, 'rpPageType', null, ?, ?, 'a0', 'Home', 1, 1, ?, 1)`,
  )
    .bind(id, path, path, JSON.stringify(pageDoc("Home")))
    .run();
  const stub = env.STORY.get(env.STORY.idFromName(id));
  await runInDurableObject(stub, (instance) => instance.getOrInit(pageDoc("Home")));
}

async function seedArtist(id: string, slug: string): Promise<void> {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at)
     values (?, 'rpArtistType', null, ?, null, 'a0', 'Ada', 1, 1, ?, 1)`,
  )
    .bind(id, id, JSON.stringify(artistDoc("Ada", slug)))
    .run();
  await env.DB.batch([
    env.DB.prepare(
      "insert into content_index (story_id, locale, field, text_value) values (?, '', 'slug', ?)",
    ).bind(id, slug),
  ]);
  const stub = env.STORY.get(env.STORY.idFromName(id));
  await runInDurableObject(stub, (instance) => instance.getOrInit(artistDoc("Ada", slug)));
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from sessions"),
    env.DB.prepare("delete from users"),
    env.DB.prepare("delete from content_index"),
    env.DB.prepare("delete from stories where id like 'rp_%'"),
  ]);
  await seedPage("rp_home", "rp-home");
  await seedArtist("rp_ada", "ada");
});

describe("reader.page() with params", () => {
  it("reaches the resolution and answers no-store with no cache tag", async () => {
    const page = await folio.reader(env, req()).page("rp-home", { params: { tag: "jazz" } });
    expect(page?.resolution.params).toEqual({ tag: "jazz" });
    expect(page?.headers["cache-control"]).toBe(NO_STORE);
    expect(page?.headers["cache-tag"]).toBeUndefined();
  });

  it("is cacheable, and tagged, when the host asserts the params come from the URL", async () => {
    const page = await folio
      .reader(env, req())
      .page("rp-home", { params: { tag: "jazz" }, cacheable: true });
    expect(page?.resolution.params).toEqual({ tag: "jazz" });
    expect(page?.headers["cache-control"]).not.toBe(NO_STORE);
    expect(page?.headers["cache-tag"]).toContain("story:rp_home");
  });

  it("never puts a param value in a cache tag, whatever it holds", async () => {
    const page = await folio
      .reader(env, req())
      .page("rp-home", { params: { tag: "never-in-a-tag-7731" }, cacheable: true });
    expect(JSON.stringify(page?.headers)).not.toContain("never-in-a-tag-7731");
  });

  it("answers the ordinary cacheable headers when no params are passed", async () => {
    const page = await folio.reader(env, req()).page("rp-home");
    expect(page?.resolution.params).toBeUndefined();
    expect(page?.headers["cache-control"]).not.toBe(NO_STORE);
    // `cacheable` alone changes nothing: it only qualifies params.
    const alone = await folio.reader(env, req()).page("rp-home", { cacheable: true });
    expect(alone?.headers).toEqual(page?.headers);
  });

  it("treats an empty params object as params: no-store without cacheable", async () => {
    const page = await folio.reader(env, req()).page("rp-home", { params: {} });
    expect(page?.headers["cache-control"]).toBe(NO_STORE);
  });

  it("stays no-store for a draft even when the host says cacheable", async () => {
    const cookie = `${await editorCookie()}; ${DRAFT}`;
    const page = await folio
      .reader(env, req(cookie))
      .page("rp-home", { params: { tag: "x" }, cacheable: true });
    expect(page?.draft).toBe(true);
    expect(page?.headers["cache-control"]).toBe(NO_STORE);
    expect(page?.headers["cache-tag"]).toBeUndefined();
  });

  it("passes search through to the resolution's collections", async () => {
    const page = await folio.reader(env, req()).page("rp-home", { search: "needle" });
    expect(page?.resolution.search).toBe("needle");
  });
});

describe("reader.recordBy() with params", () => {
  it("applies the same rule: no-store unless cacheable", async () => {
    const reader = folio.reader(env, req());
    const bare = await reader.recordBy("rpArtistType", "slug", "ada", { params: { tag: "a" } });
    expect(bare?.resolution.params).toEqual({ tag: "a" });
    expect(bare?.headers["cache-control"]).toBe(NO_STORE);
    expect(bare?.headers["cache-tag"]).toBeUndefined();

    const cacheable = await reader.recordBy("rpArtistType", "slug", "ada", {
      params: { tag: "a" },
      cacheable: true,
    });
    expect(cacheable?.headers["cache-control"]).not.toBe(NO_STORE);
    expect(cacheable?.headers["cache-tag"]).toContain("story:rp_ada");

    const plain = await reader.recordBy("rpArtistType", "slug", "ada");
    expect(plain?.resolution.params).toBeUndefined();
    expect(plain?.headers["cache-control"]).not.toBe(NO_STORE);
  });
});

describe("previewParams reach every preview", () => {
  const call = (path: string, cookie: string): Promise<Response | null> =>
    folio.handle(
      new Request(`${ORIGIN}${path}`, { headers: { cookie } }),
      env,
      createExecutionContext(),
    );

  const bootstrap = (html: string): Resolution => {
    const match = html.match(/window\.__FOLIO__=([\s\S]*?)<\/script>/);
    expect(match, "no __FOLIO__ bootstrap").not.toBeNull();
    return (JSON.parse(match![1]!) as { resolution: Resolution }).resolution;
  };

  it("carries them in the editing preview's bootstrap and the resolution route, identically", async () => {
    const cookie = await editorCookie();
    const preview = await call("/rp-home?_folio=preview", cookie);
    expect(preview?.status).toBe(200);
    const html = await preview!.text();
    const booted = bootstrap(html);
    expect(booted.params).toEqual({ tag: "preview-tag" });
    expect(html).toContain("Home|preview-tag");

    const route = await call("/folio/api/story/rp_home/resolution", cookie);
    expect(route?.status).toBe(200);
    const served = (await route!.json()) as Resolution;
    expect(served.params).toEqual({ tag: "preview-tag" });
    expect(served).toEqual(booted);
  });

  it("renders them in ?_folio=draft too", async () => {
    const cookie = await editorCookie();
    const draft = await call("/rp-home?_folio=draft", cookie);
    expect(draft?.status).toBe(200);
    expect(await draft!.text()).toContain("Home|preview-tag");
  });

  it("keeps them through a record preview's merge", async () => {
    const cookie = await editorCookie();
    const res = await call("/rp-home?_folio=preview&record=rp_ada", cookie);
    expect(res?.status).toBe(200);
    const merged = bootstrap(await res!.text());
    expect(merged.record).toBe("rp_ada");
    // The page's declaration first, then the record's own `genre`.
    expect(merged.params).toEqual({ tag: "preview-tag", genre: "jazz" });
  });

  it("does not give a live render any: only the host's params are there", async () => {
    const page = await folio.reader(env, req()).page("rp-home");
    expect(page?.resolution.params).toBeUndefined();
  });
});
