import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defineBlock, defineRecord, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { AuthConfig, FolioBindings } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { SECURE_COOKIE, SECURE_DRAFT_COOKIE } from "../../src/server/auth/cookie";
import { createSession } from "../../src/server/auth/session";
import { createUser } from "../../src/server/auth/users";

/**
 * An editor's draft lookup follows the locale fallback chain the published one does
 * (`fr-CA` falls back to `fr`, which falls back to the source), because the published
 * projection writes a row per locale holding what that locale renders.
 */

const artist = defineRecord({
  name: "rlArtist",
  label: "Artist",
  fields: { slug: text({ indexed: true, unique: true, translatable: true }) },
});
const page = defineBlock({ name: "rlPage", label: "Page", fields: {}, render: () => null });

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
};
const folio = createFolio<Cloudflare.Env>({
  blocks: [artist, page],
  types: [
    { name: "rlPageType", label: "Page", kind: "page", root: "rlPage", default: true },
    { name: "rlArtistType", label: "Artist", kind: "record", root: "rlArtist" },
  ],
  locales: {
    default: "en",
    available: [
      { code: "en", label: "English" },
      { code: "fr", label: "French", fallback: "en" },
      { code: "fr-CA", label: "Canadian French", fallback: "fr" },
    ],
  },
  bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: "/folio",
  auth,
  route: (p) => (p ? `/${p}` : "/"),
});

const doc: Doc = {
  root: "r",
  bloks: {
    r: {
      uid: "r",
      type: "rlArtist",
      parent: null,
      slot: null,
      order: "a0",
      data: { slug: "ada" },
      i18n: { fr: { slug: "ada-fr" } },
    },
  },
};

describe("a draft lookup in a locale with a fallback chain", () => {
  it("finds a value that comes from the second hop, and from the source", async () => {
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at, draft_data)
       values ('rl_ada', 'rlArtistType', null, 'rl_ada', null, 'a0', 'Ada', 1, 1, ?)`,
    )
      .bind(JSON.stringify({ data: { slug: "ada" }, i18n: { fr: { slug: "ada-fr" } } }))
      .run();
    const stub = env.STORY.get(env.STORY.idFromName("rl_ada")) as unknown as {
      getOrInit: (d: Doc) => Promise<Doc>;
    };
    await stub.getOrInit(doc);

    const user = await createUser(env.DB, { email: "rl@example.com", name: "e", role: "editor" });
    const session = await createSession(env.DB, user.id);
    const cookie = `${SECURE_COOKIE}=${session.token}; ${SECURE_DRAFT_COOKIE}=1`;
    const reader = folio.reader(env, new Request("https://folio.test/", { headers: { cookie } }));

    // fr-CA has no translation; `fieldValue` reads fr's.
    const viaFr = await reader.recordBy("rlArtistType", "slug", "ada-fr", { locale: "fr-CA" });
    expect(viaFr?.story.id).toBe("rl_ada");
    // And the source value, which every chain ends at.
    const viaSource = await reader.recordBy("rlArtistType", "slug", "ada", { locale: "en" });
    expect(viaSource?.story.id).toBe("rl_ada");
    // A value no locale in the chain reads is a miss.
    expect(await reader.recordBy("rlArtistType", "slug", "nope", { locale: "fr-CA" })).toBeNull();
  });
});
