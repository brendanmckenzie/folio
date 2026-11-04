import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asset, blocks, defineBlock, multilink, text } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { ContentCheck, ContentCheckReport, FolioBindings } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { createToken } from "../../src/server/auth/tokens";
import type { Scope } from "../../src/server/auth/roles";

/**
 * `GET {base}/api/v1/documents/:id/check` over real workerd, D1 and Durable
 * Objects (`docs/specs/content-model/authoring-guidance.md` decisions 8 to 12).
 * Under `auth: 'session'`, because every scope gate short-circuits under `open`.
 *
 * Ids are prefixed `chk_`: D1 state is isolated per file, not per test.
 */

const ORIGIN = "https://folio.test";
const API = `${ORIGIN}/folio/api/v1`;

const button = defineBlock({
  name: "chkButton",
  label: "Button",
  fields: { label: text({ label: "Label" }), target: multilink({ label: "Target" }) },
  render: () => null,
});

const hero = defineBlock({
  name: "chkHero",
  label: "Hero",
  help: "The first thing on a landing page.",
  fields: {
    heading: text({ label: "Heading", length: { max: 20 }, translatable: true }),
    image: asset({ label: "Image" }),
    actions: blocks({ allow: ["chkButton"] }),
  },
  render: () => null,
});

const pageRoot = defineBlock({
  name: "chkPage",
  label: "Page",
  summary: "title",
  fields: {
    title: text({ label: "Title", required: true, translatable: true }),
    body: blocks({ allow: ["chkHero"] }),
  },
  render: () => null,
});

const types: DocumentType[] = [
  { name: "chkPageType", label: "Page", kind: "page", root: "chkPage", default: true },
];

/**
 * What the spies saw: the SQL of every statement prepared through the request's
 * D1 (following `withSession` and `bind`, as `read-session.test.ts` explains), and
 * every story Durable Object addressed.
 */
const seen = { sql: [] as string[], unsessioned: [] as string[], objects: [] as string[] };

function watchDb(real: D1Database): D1Database {
  const watch = <T extends object>(target: T, sessioned: boolean): T =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "prepare") {
          return (sql: string) => {
            seen.sql.push(sql);
            if (!sessioned) seen.unsessioned.push(sql);
            return (value as (s: string) => D1PreparedStatement).call(t, sql);
          };
        }
        if (prop === "withSession") {
          return (...args: unknown[]) =>
            watch((value as (...a: unknown[]) => object).apply(t, args), true);
        }
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return watch(real, false);
}

function watchStories(real: DurableObjectNamespace): DurableObjectNamespace {
  return new Proxy(real, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (prop === "idFromName") {
        return (name: string) => {
          seen.objects.push(name);
          return t.idFromName(name);
        };
      }
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: watchDb(e.DB),
  story: watchStories(e.STORY as unknown as DurableObjectNamespace) as never,
  media: e.MEDIA,
  images: e.IMAGES,
});

const folio = createFolio<Cloudflare.Env>({
  blocks: [pageRoot, hero, button],
  types,
  bindings,
  basePath: "/folio",
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  route: (p) => (p ? `/${p}` : "/"),
  locales: {
    default: "en",
    available: [
      { code: "en", label: "English" },
      { code: "fr", label: "Français" },
    ],
  },
});

const call = (path: string, init?: RequestInit): Promise<Response> =>
  folio.handle(new Request(path, init), env, createExecutionContext()) as Promise<Response>;

async function tokenFor(...scopes: Scope[]) {
  const { token } = await createToken(env.DB, { name: "checker", scopes });
  return { authorization: `Bearer ${token}` };
}

let counter = 0;
const nextId = () => `chk_${(counter++).toString().padStart(4, "0")}`;

const image = (alt: string): Json =>
  ({ key: "lion.jpg", filename: "lion.jpg", contentType: "image/jpeg", size: 1, alt }) as Json;

/** The acceptance fixture: every problem the spec names, in one draft. */
function troubled(linkTo: string): Doc {
  return {
    root: "r0",
    bloks: {
      r0: {
        uid: "r0",
        type: "chkPage",
        parent: null,
        slot: null,
        order: "a0",
        data: { title: "  " },
        i18n: { fr: { title: "Accueil" } },
      },
      h0: {
        uid: "h0",
        type: "chkHero",
        parent: "r0",
        slot: "body",
        order: "a0",
        data: { heading: "Find your next safari in Kenya today", image: image("") },
      },
      b0: {
        uid: "b0",
        type: "chkButton",
        parent: "h0",
        slot: "actions",
        order: "a0",
        data: { label: "Go", target: { kind: "story", id: linkTo } as Json },
      },
    },
  };
}

/** Clean: nothing to report, and no link to look up. */
function clean(): Doc {
  return {
    root: "r0",
    bloks: {
      r0: {
        uid: "r0",
        type: "chkPage",
        parent: null,
        slot: null,
        order: "a0",
        data: { title: "Home" },
        i18n: { fr: { title: "Accueil" } },
      },
    },
  };
}

async function seed(doc: Doc, opts: { published?: boolean } = {}): Promise<string> {
  const id = nextId();
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at)
     values (?, 'chkPageType', null, ?, ?, 'a0', 'Page', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      id,
      id,
      Date.now(),
      Date.now(),
      opts.published ? JSON.stringify(doc) : null,
      opts.published ? Date.now() : null,
    )
    .run();
  await (
    env.STORY.get(env.STORY.idFromName(id)) as unknown as { getOrInit: (d: Doc) => Promise<Doc> }
  ).getOrInit(doc);
  return id;
}

async function check(id: string, headers: Record<string, string>, query = "") {
  const res = await call(`${API}/documents/${id}/check${query}`, { headers });
  return { status: res.status, body: (await res.json()) as ContentCheckReport };
}

const key = (f: ContentCheck) => `${f.check} ${f.uid} ${f.field} ${f.locale ?? ""}`;

describe("GET /documents/:id/check", () => {
  it("finds what is wrong in the draft and says where, errors first", async () => {
    const id = await seed(troubled("chk_deleted"));
    const { status, body } = await check(id, await tokenFor("content:write"));
    expect(status).toBe(200);
    expect(body.source).toBe("draft");
    expect(body.findings.map(key)).toEqual([
      "link-broken b0 target ",
      "required-empty r0 title ",
      "length-over h0 heading ",
      "alt-missing h0 image ",
      "translation-missing h0 heading fr",
    ]);
    expect(body.findings[0]).toEqual({
      check: "link-broken",
      severity: "error",
      message: "Target links to a document that does not exist on this site.",
      uid: "b0",
      type: "chkButton",
      field: "target",
      path: "body[0].actions[0]",
      fix: "patch_fields",
      detail: { target: "chk_deleted", reason: "missing" },
    });
    expect(body.counts).toEqual({ error: 1, warning: 3, info: 1 });
    expect(body.truncated).toBe(false);
  });

  it("clears a finding when patch_fields writes the address it gave, and changes nothing else", async () => {
    const id = await seed(troubled("chk_deleted"));
    const writer = await tokenFor("content:write");
    const before = (await check(id, writer)).body.findings;

    for (const target of [
      before.find((f) => f.check === "length-over")!,
      before.find((f) => f.check === "translation-missing")!,
    ]) {
      const patched = await call(`${API}/documents/${id}/fields`, {
        method: "PATCH",
        headers: { ...writer, "content-type": "application/json" },
        body: JSON.stringify({
          bloks: [{ uid: target.uid, fields: { [target.field!]: "Short" } }],
          ...(target.locale ? { locale: target.locale } : {}),
        }),
      });
      expect(patched.status).toBe(200);
      const after = (await check(id, writer)).body.findings;
      expect(after.map(key)).not.toContain(key(target));
      before.splice(before.indexOf(target), 1);
      expect(after.map(key)).toEqual(before.map(key));
    }

    // The root's own field, addressed by its uid in `bloks`, as `setsFor` allows.
    const title = before.find((f) => f.check === "required-empty")!;
    expect(title.uid).toBe("r0");
    await call(`${API}/documents/${id}/fields`, {
      method: "PATCH",
      headers: { ...writer, "content-type": "application/json" },
      body: JSON.stringify({ bloks: [{ uid: title.uid, fields: { title: "Home" } }] }),
    });
    expect((await check(id, writer)).body.findings.map(key)).not.toContain(key(title));
  });

  it("narrows per-locale findings to ?locale=, and refuses an unknown one", async () => {
    const id = await seed(troubled("chk_deleted"));
    const writer = await tokenFor("content:write");
    const en = await check(id, writer, "?locale=en");
    expect(en.body.locale).toBe("en");
    expect(en.body.findings.map((f) => f.check)).not.toContain("translation-missing");
    const fr = await check(id, writer, "?locale=fr");
    expect(fr.body.findings.map((f) => f.check)).toContain("translation-missing");
    // `unsupported`, exactly as `GET /documents/:id` answers an undeclared locale.
    const de = await check(id, writer, "?locale=de");
    const same = await call(`${API}/documents/${id}?status=draft&locale=de`, { headers: writer });
    expect(de.status).toBe(same.status);
    expect(de.body).toMatchObject({ error: { code: "unsupported" } });
  });

  it("checks the published snapshot on request, and 404s when nothing is published", async () => {
    const reader = await tokenFor("content:read");
    const draftOnly = await seed(troubled("chk_deleted"));
    const none = await check(draftOnly, reader, "?status=published");
    expect(none.status).toBe(404);
    expect(JSON.stringify(none.body)).toContain("nothing published");

    const live = await seed(clean(), { published: true });
    const report = await check(live, reader, "?status=published");
    expect(report.status).toBe(200);
    expect(report.body).toEqual({
      id: live,
      source: "published",
      counts: { error: 0, warning: 0, info: 0 },
      findings: [],
      truncated: false,
    });
    expect((await check(live, reader, "?status=publishd")).status).toBe(400);
  });

  it("needs content:read:draft for the default, which a content:read token does not hold", async () => {
    const id = await seed(clean(), { published: true });
    const refused = await check(id, await tokenFor("content:read"));
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("content:read:draft");
    expect((await check(id, await tokenFor("content:read:draft"))).status).toBe(200);
    expect((await call(`${API}/documents/${id}/check`)).status).toBe(401);
    expect((await check("chk_nobody", await tokenFor("content:write"))).status).toBe(404);
  });

  it("makes one storiesFor read for a document with links, none without, and writes nothing", async () => {
    const writer = await tokenFor("content:write");
    // Two edges, so "one read" is a claim about batching and not about a lone link.
    const two = troubled("chk_gone_for_good");
    two.bloks.b1 = {
      ...two.bloks.b0!,
      uid: "b1",
      order: "a1",
      data: { label: "Also", target: { kind: "story", id: "chk_also_gone" } as Json },
    };
    const linked = await seed(two);
    const plain = await seed(clean());
    const storiesFor = (sql: string) => /from stories where \(?id in \(/.test(sql);
    const writes = (sql: string) => /^\s*(insert|update|delete)\b/i.test(sql);

    seen.sql = [];
    seen.unsessioned = [];
    seen.objects = [];
    expect((await check(linked, writer)).status).toBe(200);
    expect(seen.sql.filter(storiesFor)).toHaveLength(1);
    // On the request's session, so it can reach a read replica (`server/db.ts`).
    expect(seen.unsessioned.filter(storiesFor)).toEqual([]);
    expect(seen.sql.filter(writes).filter((s) => /stories|content_refs/.test(s))).toEqual([]);
    // No Durable Object is addressed for the deleted target; only the document's own.
    expect(seen.objects).not.toContain("chk_gone_for_good");
    expect(seen.objects).not.toContain("chk_also_gone");
    expect(seen.objects).toContain(linked);

    seen.sql = [];
    expect((await check(plain, writer)).status).toBe(200);
    expect(seen.sql.filter(storiesFor)).toHaveLength(0);
  });
});
