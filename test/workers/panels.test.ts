import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { DocumentType } from "../../src/core/schema";
import {
  createFolio,
  type FolioBindings,
  type FolioConfig,
  type FolioPanelContext,
  magicLink,
} from "../../src/server";
import { SECURE_COOKIE } from "../../src/server/auth/cookie";
import type { Role, Scope } from "../../src/server/auth/roles";
import { createSession } from "../../src/server/auth/session";
import { createToken } from "../../src/server/auth/tokens";
import { createUser } from "../../src/server/auth/users";

/**
 * Linked-data panels (`platform/admin-extensions.md` decision 21), in real D1 and workerd:
 * `ok`, `none` and each `error` reason, the role gate in both currencies, the fence, what
 * `load` is handed, and that the route writes nothing.
 */

const productRoot = defineBlock({
  name: "productPage",
  label: "Product page",
  summary: "title",
  fields: { title: text({ indexed: true }), sku: text() },
  render: () => null,
});
const plainRoot = defineBlock({
  name: "plainPage",
  label: "Plain page",
  fields: { title: text() },
  render: () => null,
});
const secretRoot = defineBlock({
  name: "secretPage",
  label: "Secret page",
  fields: { title: text() },
  render: () => null,
});

const types: DocumentType[] = [
  { name: "productPage", label: "Product page", kind: "page", root: "productPage", default: true },
  { name: "plainPage", label: "Plain page", kind: "page", root: "plainPage" },
  { name: "secretPage", label: "Secret page", kind: "page", root: "secretPage" },
];

type Mode = "ok" | "none" | "hang" | "throw" | "garbage" | "long";
let mode: Mode = "ok";
const seen: FolioPanelContext[] = [];
const logged: unknown[][] = [];

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const config = {
  blocks: [productRoot, plainRoot, secretRoot],
  types,
  bindings,
  basePath: "/folio",
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  logger: {
    warn: () => {},
    error: (...args: unknown[]) => void logged.push(args),
  },
  panels: {
    productPage: {
      label: "Shop",
      timeoutMs: 500,
      load(ctx: FolioPanelContext) {
        seen.push(ctx);
        if (mode === "none") return null;
        if (mode === "hang") return new Promise<never>(() => {});
        if (mode === "throw") throw new Error("https://shop.example/?key=SECRET");
        if (mode === "garbage") return { items: "not a list" } as never;
        if (mode === "long") {
          return {
            items: [
              { label: "Notes", value: "n".repeat(300) },
              { label: "Variants", value: "6", tone: "warn" as const },
            ],
            link: { label: "Bad", href: "javascript:alert(1)" },
          };
        }
        return {
          items: [
            { label: "Variants", value: "6" },
            { label: "From", value: "$28.50" },
          ],
          note: `SKU ${String(ctx.data.sku ?? "")}`,
          link: { label: "Open in Products", href: "/admin/products/prod_8812" },
        };
      },
    },
    secretPage: {
      label: "Margin",
      role: "publisher" as const,
      load: () => ({ items: [{ label: "Cost", value: "$9" }] }),
    },
  },
} satisfies FolioConfig<Cloudflare.Env>;
const folio = createFolio<Cloudflare.Env>(config);

const call = async (path: string, headers: Record<string, string>, f = folio) =>
  (await f.handle(
    new Request(`https://cms.example/folio${path}`, { headers }),
    env,
    createExecutionContext(),
  )) as Response;

let n = 0;
const person = async (role: Role) => {
  const user = await createUser(env.DB, { email: `panel-${role}-${n++}@example.com`, role });
  const session = await createSession(env.DB, user.id);
  return { cookie: `${SECURE_COOKIE}=${session.token}` };
};
const token = async (...scopes: Scope[]) => ({
  authorization: `Bearer ${(await createToken(env.DB, { name: `panel-${n++}`, scopes })).token}`,
});

const insertStory = async (id: string, type: string, site = "default") => {
  await env.DB.prepare(
    `insert into stories (id, type, slug, path, ord, title, updated_at, site_id)
     values (?, ?, ?, ?, 'a0', ?, 1, ?)`,
  )
    .bind(id, type, id, id, id, site)
    .run();
};

const create = async (type: string, title: string, headers: Record<string, string>) => {
  const res = await folio.handle(
    new Request("https://cms.example/folio/api/v1/documents", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ type, title }),
    }),
    env,
    createExecutionContext(),
  );
  return ((await res!.json()) as { id: string }).id;
};
const patch = async (
  id: string,
  fields: Record<string, unknown>,
  headers: Record<string, string>,
) => {
  const res = await folio.handle(
    new Request(`https://cms.example/folio/api/v1/documents/${id}/fields`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ fields }),
    }),
    env,
    createExecutionContext(),
  );
  expect(res!.status).toBe(200);
};

let writer: Record<string, string>;
let viewer: Record<string, string>;
let editor: Record<string, string>;
let publisher: Record<string, string>;
let product: string;
let secret: string;
let plain: string;

beforeAll(async () => {
  writer = await token("content:read", "content:write");
  viewer = await person("viewer");
  editor = await person("editor");
  publisher = await person("publisher");
  product = await create("productPage", "Classic tee", writer);
  secret = await create("secretPage", "Margins", writer);
  plain = await create("plainPage", "About", writer);
});

beforeEach(() => {
  mode = "ok";
  seen.length = 0;
  logged.length = 0;
});

const panel = (id: string, headers: Record<string, string>, query = "") =>
  call(`/api/stories/${id}/panel${query}`, headers);

describe("GET /api/stories/:id/panel", () => {
  it("answers ok with the screened summary and a timestamp", async () => {
    const res = await panel(product, editor);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; at: number; summary: unknown };
    expect(body.status).toBe("ok");
    expect(body.at).toBeGreaterThan(0);
    expect(body.summary).toEqual({
      items: [
        { label: "Variants", value: "6" },
        { label: "From", value: "$28.50" },
      ],
      note: "SKU",
      link: { label: "Open in Products", href: "/admin/products/prod_8812" },
    });
  });

  it("cuts a long value, drops a javascript: link and renders the other items", async () => {
    mode = "long";
    const body = (await (await panel(product, editor)).json()) as {
      summary: { items: { label: string; value: string; tone?: string }[]; link?: unknown };
    };
    expect([...body.summary.items[0]!.value]).toHaveLength(80);
    expect(body.summary.items[1]).toEqual({ label: "Variants", value: "6", tone: "warn" });
    expect(body.summary.link).toBeUndefined();
  });

  it("answers none when load answers null", async () => {
    mode = "none";
    expect(await (await panel(product, editor)).json()).toEqual({ status: "none" });
  });

  it("answers error timeout after about the timeout when load never resolves", async () => {
    mode = "hang";
    const started = Date.now();
    const body = await (await panel(product, editor)).json();
    const took = Date.now() - started;
    expect(body).toEqual({ status: "error", reason: "timeout" });
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(3000);
    expect(seen[0]!.signal.aborted).toBe(true);
  });

  it("answers error threw, logs the failure and never shows the message", async () => {
    mode = "throw";
    const res = await panel(product, editor);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "error", reason: "threw" });
    expect(text).not.toContain("SECRET");
    expect(
      logged.some((args) => String(args[0]).includes("panel productPage failed (threw)")),
    ).toBe(true);
  });

  it("answers error malformed when nothing survives screening", async () => {
    mode = "garbage";
    expect(await (await panel(product, editor)).json()).toEqual({
      status: "error",
      reason: "malformed",
    });
  });

  it("hands load the Durable Object draft's root data, the story and the editor", async () => {
    await patch(product, { sku: "tee-classic" }, writer);
    const res = await panel(product, editor);
    expect(((await res.json()) as { summary: { note: string } }).summary.note).toBe(
      "SKU tee-classic",
    );
    const ctx = seen[0]!;
    expect(ctx.data).toMatchObject({ title: "Classic tee", sku: "tee-classic" });
    expect(ctx.story.id).toBe(product);
    expect(ctx.locale).toBeNull();
    expect(ctx.scope).toBeNull();
    expect(ctx.brand).toBeNull();
    expect(ctx.editor).toMatchObject({ kind: "user", role: "editor" });
    expect(JSON.stringify(ctx.editor)).not.toContain('session":"');
  });

  it("hands a token's editor projection, with its scopes", async () => {
    await panel(product, await token("content:read:draft"));
    expect(seen[0]!.editor).toMatchObject({ kind: "token", scopes: ["content:read:draft"] });
  });

  it("is 404 for a type with no panel, an unknown story and a signed-out caller is 401", async () => {
    expect((await panel(plain, editor)).status).toBe(404);
    expect((await panel("sty_nope000000", editor)).status).toBe(404);
    expect((await panel(product, {})).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("refuses an unknown locale", async () => {
    expect((await panel(product, editor, "?locale=xx")).status).toBe(501);
  });
});

describe("the gate, in both currencies", () => {
  it("admits a viewer to a viewer panel", async () => {
    expect((await panel(product, viewer)).status).toBe(200);
  });

  it("refuses a person below the panel's role with a 403 and never calls load", async () => {
    const res = await panel(secret, editor);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "Your role (editor) may not see this panel; publisher is required.",
    );
    expect(seen).toEqual([]);
    expect((await panel(secret, publisher)).status).toBe(200);
  });

  it("admits a content:read:draft token to a viewer panel, and refuses it an editor-or-above one", async () => {
    const draftReader = await token("content:read:draft");
    expect((await panel(product, draftReader)).status).toBe(200);
    // A role has no token equivalent: a panel above viewer admits no token at all.
    const res = await panel(
      secret,
      await token("content:read", "content:read:draft", "content:write"),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "which a token cannot hold",
    );
  });

  it("refuses a token holding content:read alone, since the panel is computed from the draft", async () => {
    const res = await panel(product, await token("content:read"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "content:read:draft",
    );
  });
});

describe("the route writes nothing", () => {
  it("leaves every table it could touch as it found them", async () => {
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          ["stories", "versions", "content_index", "option_lists", "sessions"].map((table) =>
            env.DB.prepare(`select * from ${table} order by 1, 2`).all(),
          ),
        ).then((all) =>
          all.map((r, i) =>
            // A session's last-seen may move on a renewal; the rest must not.
            i === 4 ? r.results.length : r.results,
          ),
        ),
      );
    const before = await snapshot();
    await panel(product, editor);
    mode = "throw";
    await panel(product, editor);
    expect(await snapshot()).toBe(before);
  });
});

describe("the manifest", () => {
  it("carries panels, by type, when declared, and never a function", async () => {
    const body = (await (await call("/api/schema", {})).json()) as {
      panels?: Record<string, { label: string; role: string }>;
    };
    expect(body.panels).toEqual({
      productPage: { label: "Shop", role: "viewer" },
      secretPage: { label: "Margin", role: "publisher" },
    });
  });

  it("is absent when none are declared, so the manifest is what it always was", async () => {
    const bare = createFolio<Cloudflare.Env>({
      ...config,
      panels: undefined,
    } as FolioConfig<Cloudflare.Env>);
    const body = (await (await call("/api/schema", {}, bare)).json()) as Record<string, unknown>;
    expect("panels" in body).toBe(false);
    const v1 = (await (await call("/api/v1/schema", writer, bare)).json()) as Record<
      string,
      unknown
    >;
    expect("panels" in v1).toBe(false);
  });
});

describe("the fence, with sites", () => {
  const sited = createFolio<Cloudflare.Env>({
    ...config,
    sites: { admin: "https://cms.example" },
    route: (p: string) => `/${p}`,
  } as unknown as FolioConfig<Cloudflare.Env>);

  beforeAll(async () => {
    await env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('pnalpha', 'site', 'Alpha', null, 'live', null, 0, 0),
         ('pnbravo', 'site', 'Bravo', null, 'live', null, 0, 0)`,
    ).run();
    await insertStory("sty_pn_bravo", "productPage", "pnbravo");
    await insertStory("sty_pn_alpha", "productPage", "pnalpha");
  });

  it("is 404 for another site's story and answers the scope's own", async () => {
    const reader = await token("content:read", "content:read:draft");
    expect((await call("/~pnalpha/api/stories/sty_pn_bravo/panel", reader, sited)).status).toBe(
      404,
    );
    const own = await call("/~pnalpha/api/stories/sty_pn_alpha/panel", reader, sited);
    expect(own.status).toBe(200);
    expect(seen.at(-1)!.scope).toBe("pnalpha");
  });
});
