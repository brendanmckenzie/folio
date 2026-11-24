import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defineBlock, defineRecord, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * `GET {base}/api/story/:id/live-url` (`record-live-url.md`): a record's public URL
 * from the host's `liveUrl`, computed from the published document and never the draft,
 * and never written onto the story, so a record is still not a page anywhere.
 *
 * Own `createFolio`, ids prefixed `lu_`, per `records.test.ts`.
 */

const luPost = defineRecord({
  name: "luPost",
  label: "Post",
  fields: { slug: text({ indexed: true }), date: text() },
});
const luEvil = defineRecord({
  name: "luEvil",
  label: "Evil",
  fields: { slug: text() },
});
const luPlain = defineRecord({ name: "luPlain", label: "Plain", fields: { slug: text() } });
const luPage = defineBlock({
  name: "luPage",
  label: "Page",
  fields: { title: text() },
  render: () => null,
});

const types: DocumentType[] = [
  { name: "luPageType", label: "Page", kind: "page", root: "luPage", default: true },
  { name: "luPostType", label: "Posts", kind: "record", root: "luPost" },
  { name: "luEvilType", label: "Evil", kind: "record", root: "luEvil" },
  { name: "luPlainType", label: "Plain", kind: "record", root: "luPlain" },
];

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const folio = createFolio<Cloudflare.Env>({
  blocks: [luPost, luEvil, luPlain, luPage],
  types,
  bindings,
  basePath: "/folio",
  liveUrls: {
    luPostType: ({ slug, date }) => `/posts/${String(date).slice(0, 4)}/${slug}`,
    luEvilType: ({ slug }) => String(slug),
  },
  auth: "open",
  route: (p) => (p ? `/${p}` : "/"),
});

const get = (path: string) =>
  folio.handle(new Request(`https://example.com${path}`), env, createExecutionContext());

const docOf = (type: string, data: Record<string, string>): Doc => ({
  root: "r",
  bloks: { r: { uid: "r", type, parent: null, slot: null, order: "a0", data } },
});

async function insert(
  id: string,
  type: string,
  opts: { published?: Doc; unpublishedAt?: number },
): Promise<void> {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at, unpublished_at)
     values (?, ?, null, ?, null, 'a0', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      type,
      id,
      id,
      Date.now(),
      opts.published ? JSON.stringify(opts.published) : null,
      opts.published && opts.unpublishedAt === undefined ? Date.now() : null,
      opts.unpublishedAt ?? null,
    )
    .run();
}

const urlOf = async (id: string) => {
  const res = await get(`/folio/api/story/${id}/live-url`);
  expect(res?.status).toBe(200);
  return ((await res!.json()) as { url: string | null }).url;
};

describe("GET /story/:id/live-url", () => {
  it("is the path built from the published data", async () => {
    await insert("lu_a", "luPostType", {
      published: docOf("luPost", { slug: "hello", date: "2026-03-04" }),
    });
    expect(await urlOf("lu_a")).toBe("/posts/2026/hello");
  });

  it("is not moved by a draft edit made after publishing", async () => {
    // The draft lives in the Durable Object; the route never opens it, so a renamed
    // draft slug cannot reach the answer. The stored row says changed-since-publish.
    await insert("lu_b", "luPostType", {
      published: docOf("luPost", { slug: "old", date: "2025-01-01" }),
    });
    await env.DB.prepare("update stories set draft_sync_id = 9 where id = 'lu_b'").run();
    expect(await urlOf("lu_b")).toBe("/posts/2025/old");
  });

  it("is null for a record that was never published", async () => {
    await insert("lu_c", "luPostType", {});
    expect(await urlOf("lu_c")).toBeNull();
  });

  it("is null for an unpublished record, though it still has a document", async () => {
    await insert("lu_d", "luPostType", {
      published: docOf("luPost", { slug: "gone", date: "2024-01-01" }),
      unpublishedAt: Date.now(),
    });
    expect(await urlOf("lu_d")).toBeNull();
  });

  it.each([
    ["lu_e1", "javascript:alert(1)"],
    ["lu_e2", "https://evil.example/x"],
    ["lu_e3", "//evil.example/x"],
  ])("is null when liveUrl answers something unsafe (%s)", async (id, slug) => {
    await insert(id, "luEvilType", { published: docOf("luEvil", { slug }) });
    expect(await urlOf(id)).toBeNull();
  });

  it("is null for a record type with no liveUrl", async () => {
    await insert("lu_f", "luPlainType", { published: docOf("luPlain", { slug: "/x" }) });
    expect(await urlOf("lu_f")).toBeNull();
  });

  it("is null when a published slug walks out of the path", async () => {
    await insert("lu_g", "luPostType", {
      published: docOf("luPost", { slug: "../../folio/api/me", date: "2026-01-01" }),
    });
    expect(await urlOf("lu_g")).toBeNull();
  });

  it("refuses a liveUrls key that names no type, at construction", () => {
    expect(() =>
      createFolio<Cloudflare.Env>({
        blocks: [luPost, luEvil, luPlain, luPage],
        types,
        bindings,
        liveUrls: { nope: () => "/x" },
        auth: "open",
        route: (p: string) => `/${p}`,
      } as never),
    ).toThrow(/liveUrls\.nope/);
  });

  it("is a 404 for an unknown story", async () => {
    expect((await get("/folio/api/story/lu_missing/live-url"))?.status).toBe(404);
  });

  it("does not make the record a page: no url on the story, a name in the manifest only", async () => {
    const res = await get("/folio/api/stories?ids=lu_a");
    const { rows } = (await res!.json()) as { rows: Record<string, unknown>[] };
    expect(rows[0]?.id).toBe("lu_a");
    expect(rows[0]).not.toHaveProperty("url");
    expect(rows[0]).not.toHaveProperty("previewUrl");
    expect(rows[0]?.path).toBeNull();
    const manifest = (await (await get("/folio/api/schema"))!.json()) as {
      liveUrlTypes?: string[];
    };
    expect(manifest.liveUrlTypes).toEqual(["luPostType", "luEvilType"]);
  });
});
