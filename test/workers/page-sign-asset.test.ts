import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { asset, defineBlock, multiasset, resolveAsset, select, text } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings, FolioGate, FolioPage } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * `page.signAsset` (`docs/specs/platform/asset-access.md` decision 9, revised): signs only
 * for a visitor this page has itself admitted to *this file's* value, and answers the plain
 * `src` everywhere else. Every refusal here is the half a passing render hides, so each
 * asserts the URL carries no `sig`.
 */

const KEY = "page-sign-key-0123456789abcdef0123";
const ORIGIN = "https://example.com";

const root = defineBlock({
  name: "psRoot",
  label: "Page",
  summary: "title",
  fields: {
    title: text({ indexed: true }),
    access: select({
      options: [
        { label: "Everyone", value: "public" },
        { label: "Members", value: "members" },
      ],
      indexed: true,
    }),
    hero: asset(),
    extras: multiasset(),
  },
  render: () => null,
});
const types: DocumentType[] = [
  { name: "psPage", label: "Page", kind: "page", root: "psRoot", default: true },
];

const asked: string[] = [];
let throwOn: string | null = null;
const gate: FolioGate<Cloudflare.Env> = {
  field: "access",
  public: "public",
  visitor: (req) => (req.headers.get("cookie")?.includes("member=1") ? { id: "m" } : null),
  allows: (who) => who !== null,
  allowsAsset(who, value) {
    asked.push(String(value));
    if (throwOn === value) throw new Error("boom");
    // A member may open `members` files; `premium` is above their tier.
    return who !== null && value === "members";
  },
};

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});
const folio = createFolio<Cloudflare.Env>({
  blocks: [root],
  types,
  bindings,
  basePath: "/folio",
  assets: { admin: "/a.js", preview: "/p.js" },
  auth: "open",
  route: (p) => (p ? `/${p}` : "/"),
  gate,
  assetSigning: { keys: () => [KEY] },
});

let n = 0;
async function file(effective: string | null): Promise<Json> {
  n += 1;
  const id = `ast_${(0xc00000 + n).toString(16).padStart(12, "0")}`;
  const key = `${id}-f.pdf`;
  await env.DB.prepare(
    `insert into assets (id, key, filename, content_type, size, created_at, site_id, effective_access)
     values (?, ?, 'f.pdf', 'application/pdf', 1, 1, 'default', ?)`,
  )
    .bind(id, key, effective)
    .run();
  return { key, filename: "f.pdf", contentType: "application/pdf", size: 1, alt: "" } as Json;
}

function doc(data: Record<string, Json>): Doc {
  return {
    root: "r",
    bloks: { r: { uid: "r", type: "psRoot", parent: null, slot: null, order: "a0", data } },
  };
}
async function publish(id: string, path: string, d: Doc): Promise<void> {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at)
     values (?, 'psPage', null, ?, ?, 'a0', 'T', 1, 1, ?, 1)`,
  )
    .bind(id, path, path, JSON.stringify(d))
    .run();
}

const open = (path: string, cookie?: string) =>
  folio.reader(env, new Request(`${ORIGIN}/${path}`, cookie ? { headers: { cookie } } : undefined));
const MEMBER = "member=1";

let members: Json;
let premium: Json;

async function signedFor(page: FolioPage, value: Json): Promise<string> {
  const resolved = resolveAsset(value, page.resolution)!;
  return page.signAsset(resolved);
}
const isSigned = (url: string) => /[?&]sig=/.test(url) && /[?&]exp=/.test(url);

beforeAll(async () => {
  members = await file('"members"');
  premium = await file('"premium"');
  await publish("sty_ps_pub", "ps-public", doc({ access: "public", hero: members }));
  await publish(
    "sty_ps_mem",
    "ps-members",
    doc({ access: "members", hero: members, extras: [premium] }),
  );
});

describe("page.signAsset", () => {
  it("answers the plain src on a public page, whoever is asking, without asking the host", async () => {
    asked.length = 0;
    const page = (await open("ps-public", MEMBER).page("ps-public"))!;
    expect(page.access).toBe("public");
    const url = await signedFor(page, members);
    expect(isSigned(url)).toBe(false);
    expect(url).toBe(resolveAsset(members, page.resolution)!.src);
    expect(asked).toEqual([]);
  });

  it("answers the plain src on a denied teaser", async () => {
    const page = (await open("ps-members").page("ps-members"))!;
    expect(page.access).toBe("denied");
    expect(isSigned(await signedFor(page, members))).toBe(false);
  });

  it("answers the plain src on a public page rendered no-store because of params", async () => {
    const page = (await open("ps-public", MEMBER).page("ps-public", { params: { q: 1 } }))!;
    expect(page.headers["cache-control"]).toBe("private, no-store");
    expect(page.access).toBe("public");
    expect(isSigned(await signedFor(page, members))).toBe(false);
  });

  it("answers the plain src for a file above the visitor's tier on a granted page", async () => {
    asked.length = 0;
    const page = (await open("ps-members", MEMBER).page("ps-members"))!;
    expect(page.access).toBe("granted");
    expect(isSigned(await signedFor(page, premium))).toBe(false);
    expect(asked).toEqual(["premium"]);
  });

  it("signs a file the visitor is admitted to, asking the host once per file", async () => {
    asked.length = 0;
    const page = (await open("ps-members", MEMBER).page("ps-members"))!;
    const first = await signedFor(page, members);
    const second = await page.signAsset(resolveAsset(members, page.resolution)!, {
      expiresIn: 60,
    });
    expect(isSigned(first)).toBe(true);
    expect(isSigned(second)).toBe(true);
    expect(first).toContain(`/folio/asset/${(members as { key: string }).key}?`);
    expect(asked).toEqual(["members"]);
  });

  it("treats a throwing allowsAsset as a refusal", async () => {
    throwOn = "members";
    try {
      const page = (await open("ps-members", MEMBER).page("ps-members"))!;
      expect(isSigned(await signedFor(page, members))).toBe(false);
    } finally {
      throwOn = null;
    }
  });

  it("signs a gated file in the chain on a draft page, with no host call", async () => {
    asked.length = 0;
    const draft = await folio.draft(env, "sty_ps_pub");
    await folio.write(
      env,
      "sty_ps_pub",
      [{ t: "set", uid: draft.root, field: "hero", value: members }],
      { actor: "t" },
    );
    const page = (await open("ps-public", "folio_draft=1").page("ps-public"))!;
    expect(page.draft).toBe(true);
    expect(isSigned(await signedFor(page, members))).toBe(true);
    expect(asked).toEqual([]);
  });

  it("answers the plain src for a public library file and for an external URL", async () => {
    const free = await file(null);
    const page = (await open("ps-members", MEMBER).page("ps-members"))!;
    expect(isSigned(await signedFor(page, free))).toBe(false);
    expect(isSigned(await page.signAsset({ src: "https://cdn.example/x.pdf" }))).toBe(false);
  });
});
