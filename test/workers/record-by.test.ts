import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defineBlock, defineRecord, text } from "../../src/core";
import { NO_STORE } from "../../src/core/cache-tags";
import type { Doc } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { AuthConfig, FolioBindings } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import {
  SECURE_COOKIE,
  SECURE_DRAFT_COOKIE,
  SECURE_SHARE_COOKIE,
} from "../../src/server/auth/cookie";
import { createSession } from "../../src/server/auth/session";
import { createShare } from "../../src/server/auth/shares";
import { createUser } from "../../src/server/auth/users";

/**
 * `reader.recordBy()` (issue #75): a record addressed by a `unique` indexed field,
 * with `page()`'s authority, redaction and headers.
 *
 * The negative assertions carry the weight, as they do in `draft-mode.test.ts`: a
 * share link covers one story and a record is looked up by a value anyone can guess,
 * so a share must never be what admits a record's draft. Ids are prefixed `rb_`
 * because D1 state is isolated per file, not per test.
 */

const ORIGIN = "https://folio.test";

const artist = defineRecord({
  name: "rbArtist",
  label: "Artist",
  summary: "name",
  fields: {
    name: text({ indexed: true }),
    slug: text({ label: "Slug", indexed: true, unique: true }),
    // Not unique: `recordBy` must refuse it rather than answer an ambiguous lookup.
    city: text({ indexed: true }),
  },
});
const pageRoot = defineBlock({
  name: "rbPage",
  label: "Page",
  fields: { title: text() },
  render: () => null,
});

const types: DocumentType[] = [
  { name: "rbPageType", label: "Page", kind: "page", root: "rbPage", default: true },
  { name: "rbArtistType", label: "Artist", kind: "record", root: "rbArtist", titleField: "name" },
];

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
};

const folio = createFolio<Cloudflare.Env>({
  blocks: [artist, pageRoot],
  types,
  bindings,
  basePath: "/folio",
  auth,
  route: (p) => (p ? `/${p}` : "/"),
});

const DRAFT = `${SECURE_DRAFT_COOKIE}=1`;
const req = (cookie?: string) =>
  new Request(`${ORIGIN}/`, cookie ? { headers: { cookie } } : undefined);

let users = 0;
async function editorCookie(): Promise<string> {
  const user = await createUser(env.DB, {
    email: `editor${users++}@example.com`,
    name: "editor",
    role: "editor",
  });
  const session = await createSession(env.DB, user.id);
  return `${SECURE_COOKIE}=${session.token}`;
}

const doc = (data: Record<string, string>): Doc => ({
  root: "r",
  bloks: { r: { uid: "r", type: "rbArtist", parent: null, slot: null, order: "a0", data } },
});

const stubFor = (id: string) =>
  env.STORY.get(env.STORY.idFromName(id)) as unknown as {
    getOrInit: (d: Doc) => Promise<Doc>;
    purge: () => Promise<void>;
  };

interface Seed {
  id: string;
  name: string;
  slug: string;
  /** Published with `slug` (and indexed), or not published at all. */
  published?: boolean;
  /** What the Durable Object's draft says; defaults to `slug`. */
  draftSlug?: string;
  /** Whether `stories.draft_data` mirrors the draft. */
  mirror?: boolean;
  site?: string;
}

async function seed(s: Seed): Promise<string> {
  const published = s.published ?? true;
  const draftSlug = s.draftSlug ?? s.slug;
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          site_id, published_doc, published_at, draft_data)
     values (?, 'rbArtistType', null, ?, null, 'a0', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      s.id,
      s.id,
      s.name,
      Date.now(),
      Date.now(),
      s.site ?? "default",
      published ? JSON.stringify(doc({ name: s.name, slug: s.slug })) : null,
      published ? Date.now() : null,
      s.mirror ? JSON.stringify({ data: { name: s.name, slug: draftSlug } }) : null,
    )
    .run();
  if (published) {
    await env.DB.batch([
      env.DB.prepare(
        "insert into content_index (story_id, locale, field, text_value) values (?, '', 'slug', ?)",
      ).bind(s.id, s.slug),
      env.DB.prepare(
        "insert into content_index (story_id, locale, field, text_value) values (?, '', 'name', ?)",
      ).bind(s.id, s.name),
    ]);
  }
  // Durable Object state outlives a test in this file, so start from none.
  await stubFor(s.id).purge();
  await stubFor(s.id).getOrInit(doc({ name: s.name, slug: draftSlug }));
  return s.id;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from shares"),
    env.DB.prepare("delete from sessions"),
    env.DB.prepare("delete from users"),
    env.DB.prepare("delete from content_index"),
    env.DB.prepare("delete from stories where id like 'rb_%'"),
  ]);
});

const slugOf = (doc: Doc) => doc.bloks[doc.root]?.data.slug;

/* ------------------------------------------------------------ a visitor --- */

describe("a visitor", () => {
  it("finds a published record by its unique field, with the published headers", async () => {
    await seed({ id: "rb_ada", name: "Ada", slug: "ada" });
    const page = await folio.reader(env, req()).recordBy("rbArtistType", "slug", "ada");
    expect(page?.story.id).toBe("rb_ada");
    expect(slugOf(page!.doc)).toBe("ada");
    expect(page).toMatchObject({ draft: false, access: "public" });
    // One tail with `page()`: a published hit is cacheable and carries the tag its next
    // publish purges by.
    expect(page!.headers["cache-control"]).not.toBe(NO_STORE);
    expect(page!.headers["cache-tag"]).toContain("story:rb_ada");
  });

  it("answers null for a value nothing holds", async () => {
    await seed({ id: "rb_ada", name: "Ada", slug: "ada" });
    expect(await folio.reader(env, req()).recordBy("rbArtistType", "slug", "grace")).toBeNull();
  });

  it("never finds an unpublished record, whatever its draft says", async () => {
    await seed({ id: "rb_wip", name: "Wip", slug: "wip", published: false, mirror: true });
    expect(await folio.reader(env, req()).recordBy("rbArtistType", "slug", "wip")).toBeNull();
  });

  it("matches the value exactly, not as a pattern", async () => {
    await seed({ id: "rb_ada", name: "Ada", slug: "ada" });
    const reader = folio.reader(env, req());
    for (const value of ["ad", "ada%", "a_a", "ADA", "ada "]) {
      expect([value, await reader.recordBy("rbArtistType", "slug", value)]).toEqual([value, null]);
    }
  });

  it("stays on the draft-less path for a request carrying a stale draft cookie and no session", async () => {
    await seed({ id: "rb_wip", name: "Wip", slug: "wip", published: false, mirror: true });
    await seed({ id: "rb_ada", name: "Ada", slug: "ada" });
    const reader = folio.reader(env, req(DRAFT));
    expect(await reader.recordBy("rbArtistType", "slug", "wip")).toBeNull();
    expect((await reader.recordBy("rbArtistType", "slug", "ada"))?.draft).toBe(false);
  });
});

/* ------------------------------------------------------------ misuse --- */

describe("a lookup that is a programming error", () => {
  it("throws for a type that is not a record", async () => {
    await expect(folio.reader(env, req()).recordBy("rbPageType", "title", "x")).rejects.toThrow(
      /not a record type/,
    );
    await expect(folio.reader(env, req()).recordBy("nope", "slug", "x")).rejects.toThrow(
      /not a record type/,
    );
  });

  it("throws for a field that is not unique, and for one that does not exist", async () => {
    await expect(folio.reader(env, req()).recordBy("rbArtistType", "city", "x")).rejects.toThrow(
      /'city' is not a text\(\{ indexed: true, unique: true \}\) field/,
    );
    await expect(folio.reader(env, req()).recordBy("rbArtistType", "nope", "x")).rejects.toThrow(
      /not a text/,
    );
  });

  it("answers null for a locale the site never declared, as page() does", async () => {
    await seed({ id: "rb_ada", name: "Ada", slug: "ada" });
    expect(
      await folio.reader(env, req()).recordBy("rbArtistType", "slug", "ada", { locale: "fr" }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------ an editor --- */

describe("an editor in draft mode", () => {
  it("finds an unpublished record by its draft value, with no-store", async () => {
    await seed({ id: "rb_wip", name: "Wip", slug: "wip", published: false, mirror: true });
    const cookie = await editorCookie();
    const page = await folio
      .reader(env, req(`${cookie}; ${DRAFT}`))
      .recordBy("rbArtistType", "slug", "wip");
    expect(page?.story.id).toBe("rb_wip");
    expect(page).toMatchObject({ draft: true });
    expect(page!.headers["cache-control"]).toBe(NO_STORE);
    expect(page!.headers["cache-tag"]).toBeUndefined();
  });

  it("reads nothing as a draft without the draft cookie", async () => {
    await seed({ id: "rb_wip", name: "Wip", slug: "wip", published: false, mirror: true });
    const cookie = await editorCookie();
    expect(await folio.reader(env, req(cookie)).recordBy("rbArtistType", "slug", "wip")).toBeNull();
  });

  it("finds a record at the slug its draft changed to, and not at the published one", async () => {
    await seed({ id: "rb_ada", name: "Ada", slug: "ada", draftSlug: "ada-l", mirror: true });
    const cookie = await editorCookie();
    const reader = folio.reader(env, req(`${cookie}; ${DRAFT}`));
    const moved = await reader.recordBy("rbArtistType", "slug", "ada-l");
    expect(moved?.story.id).toBe("rb_ada");
    expect(slugOf(moved!.doc)).toBe("ada-l");
    expect(moved?.draft).toBe(true);
    expect(await reader.recordBy("rbArtistType", "slug", "ada")).toBeNull();
    // A visitor is still served the published slug.
    expect((await folio.reader(env, req()).recordBy("rbArtistType", "slug", "ada"))?.draft).toBe(
      false,
    );
  });

  it("falls back to the published value for a record with no draft mirror yet", async () => {
    await seed({ id: "rb_ada", name: "Ada", slug: "ada", mirror: false });
    const cookie = await editorCookie();
    const page = await folio
      .reader(env, req(`${cookie}; ${DRAFT}`))
      .recordBy("rbArtistType", "slug", "ada");
    expect(page).toMatchObject({ draft: true });
    expect(page?.story.id).toBe("rb_ada");
  });

  /**
   * The mirror cuts a string at 512 characters, so a stored prefix must never be
   * mistaken for a longer value: the candidate is confirmed against the draft itself.
   */
  it("matches a long value on the mirror's stored prefix, confirmed against the draft", async () => {
    const long = "x".repeat(600);
    await seed({ id: "rb_long", name: "Long", slug: long, published: false, mirror: false });
    await env.DB.prepare("update stories set draft_data = ? where id = 'rb_long'")
      .bind(JSON.stringify({ data: { name: "Long", slug: long.slice(0, 512) } }))
      .run();
    const cookie = await editorCookie();
    const reader = folio.reader(env, req(`${cookie}; ${DRAFT}`));
    // The prefix alone is another value: the draft document says so.
    expect(await reader.recordBy("rbArtistType", "slug", long.slice(0, 512))).toBeNull();
    expect((await reader.recordBy("rbArtistType", "slug", long))?.story.id).toBe("rb_long");
  });

  it("finds a slug that is exactly the mirror's cut length", async () => {
    const exact = "y".repeat(512);
    await seed({ id: "rb_exact", name: "Exact", slug: exact, published: false, mirror: true });
    const cookie = await editorCookie();
    const reader = folio.reader(env, req(`${cookie}; ${DRAFT}`));
    expect((await reader.recordBy("rbArtistType", "slug", exact))?.story.id).toBe("rb_exact");
  });
});

/* ----------------------------------------------------------- a reviewer --- */

describe("a reviewer holding a share cookie", () => {
  async function shareCookieFor(storyId: string): Promise<string> {
    const { token } = await createShare(env.DB, { storyId, expiresAt: Date.now() + 86_400_000 });
    return `${SECURE_SHARE_COOKIE}=${token}`;
  }

  it("is never admitted to a record's draft", async () => {
    await seed({ id: "rb_wip", name: "Wip", slug: "wip", published: false, mirror: true });
    const cookie = await shareCookieFor("rb_wip");
    expect(await folio.reader(env, req(cookie)).recordBy("rbArtistType", "slug", "wip")).toBeNull();
    expect(
      await folio.reader(env, req(`${cookie}; ${DRAFT}`)).recordBy("rbArtistType", "slug", "wip"),
    ).toBeNull();
  });

  it("reads a published record's published copy, never its draft", async () => {
    await seed({ id: "rb_ada", name: "Ada", slug: "ada", draftSlug: "ada-l", mirror: true });
    const cookie = await shareCookieFor("rb_ada");
    const reader = folio.reader(env, req(`${cookie}; ${DRAFT}`));
    const page = await reader.recordBy("rbArtistType", "slug", "ada");
    expect(page?.draft).toBe(false);
    expect(slugOf(page!.doc)).toBe("ada");
    expect(await reader.recordBy("rbArtistType", "slug", "ada-l")).toBeNull();
  });
});

/* ------------------------------------------------------------ the fence --- */

describe("the chain fence", () => {
  it("holds for an editor's draft lookup too", async () => {
    await seed({ id: "rb_far", name: "Far", slug: "far", site: "elsewhere", mirror: true });
    await seed({
      id: "rb_farwip",
      name: "Farwip",
      slug: "farwip",
      published: false,
      site: "elsewhere",
      mirror: true,
    });
    const cookie = await editorCookie();
    const reader = folio.reader(env, req(`${cookie}; ${DRAFT}`));
    expect(await reader.recordBy("rbArtistType", "slug", "far")).toBeNull();
    expect(await reader.recordBy("rbArtistType", "slug", "farwip")).toBeNull();
  });

  it("does not reach a record owned by a scope outside the reader's chain", async () => {
    await seed({ id: "rb_far", name: "Far", slug: "far", site: "elsewhere" });
    expect(await folio.reader(env, req()).recordBy("rbArtistType", "slug", "far")).toBeNull();
    // Control: the same row, owned by the reader's own scope, is found.
    await seed({ id: "rb_near", name: "Near", slug: "near" });
    expect(
      (await folio.reader(env, req()).recordBy("rbArtistType", "slug", "near"))?.story.id,
    ).toBe("rb_near");
  });
});

/* -------------------------------------------------- the one headers tail --- */

describe("the headers rule", () => {
  /**
   * `recordBy` and `page` end in the same function, so one rule decides both. A page
   * and a record answered for an editor in draft mode must agree on `no-store`, and a
   * published hit of each must agree on carrying cache-control with a tag.
   */
  it("is the same rule page() applies", async () => {
    await seed({ id: "rb_ada", name: "Ada", slug: "ada" });
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                            published_doc, published_at)
       values ('rb_home', 'rbPageType', null, 'home', 'home', 'a0', 'Home', 1, 1, ?, 1)`,
    )
      .bind(
        JSON.stringify({
          root: "r",
          bloks: {
            r: { uid: "r", type: "rbPage", parent: null, slot: null, order: "a0", data: {} },
          },
        }),
      )
      .run();
    const reader = folio.reader(env, req());
    const record = await reader.recordBy("rbArtistType", "slug", "ada");
    const page = await reader.page("home");
    expect(Object.keys(record!.headers).sort()).toEqual(Object.keys(page!.headers).sort());
    expect(record!.headers["cache-control"]).toBe(page!.headers["cache-control"]);
  });
});
