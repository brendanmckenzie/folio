import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defineBlock, reference, text } from "../../src/core";
import { cacheTags } from "../../src/core/cache-tags";
import type { Doc } from "../../src/core/doc";
import { createFolio } from "../../src/server";
import type { FolioBindings } from "../../src/server";

/**
 * `reference.content` resolves the target's own references (issue #89):
 * `resolve()` loads a second hop, the documents the referenced documents name.
 * Each property below is silent when broken: the answer looks plausible and only
 * the query shape, the Durable Object list or the tag set says otherwise.
 */

const page = defineBlock({
  name: "page",
  label: "Page",
  summary: "title",
  fields: {
    title: text({ label: "Title", required: true }),
    related: reference({ label: "Related", types: ["page"] }),
  },
  render: () => null,
});

/** Every Durable Object name asked for, so "no object was created" is observable. */
const touched: string[] = [];

function watchedNamespace(ns: DurableObjectNamespace): DurableObjectNamespace {
  return new Proxy(ns, {
    get(target, prop, receiver) {
      if (prop === "idFromName") {
        return (name: string) => {
          touched.push(name);
          return target.idFromName(name);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeFolio(db?: D1Database) {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    types: [{ name: "page", label: "Page", kind: "page", root: "page" }],
    bindings: (e): FolioBindings => ({
      db: db ?? e.DB,
      story: watchedNamespace(e.STORY as unknown as DurableObjectNamespace) as typeof e.STORY,
      media: e.MEDIA,
      images: e.IMAGES,
    }),
    basePath: "/folio",
    assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
    auth: "open",
    route: (p) => (p ? `/${p}` : "/"),
  });
}

function pageDoc(title: string, related?: string): Doc {
  return {
    root: "root0000",
    bloks: {
      root0000: {
        uid: "root0000",
        type: "page",
        parent: null,
        slot: null,
        order: "a0",
        data: { title, ...(related ? { related } : {}) },
      },
    },
  };
}

async function insertPage(id: string, title: string, related?: string, site = "default") {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at, site_id)
     values (?, 'page', null, ?, ?, 'a0', ?, ?, ?, ?, ?)`,
  )
    .bind(id, id, id, title, Date.now(), JSON.stringify(pageDoc(title, related)), Date.now(), site)
    .run();
}

/** Wraps the binding to count `prepare`s, following `withSession` and `bind`. */
function counting(real: D1Database) {
  const state = { prepares: 0, order: [] as string[] };
  const statement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "bind") {
          return (...a: unknown[]) =>
            statement((value as (...x: unknown[]) => D1PreparedStatement).apply(t, a));
        }
        if (prop !== "first" && prop !== "all" && prop !== "run") return value;
        return async (...a: unknown[]) => {
          state.order.push("send");
          const out = await (value as (...x: unknown[]) => Promise<unknown>).apply(t, a);
          state.order.push("recv");
          return out;
        };
      },
    });
  const watch = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "prepare") {
          return (...a: unknown[]) => {
            state.prepares++;
            return statement((value as (...x: unknown[]) => D1PreparedStatement).apply(t, a));
          };
        }
        if (prop === "withSession") {
          return (...a: unknown[]) => watch((value as (...x: unknown[]) => object).apply(t, a));
        }
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return { db: watch(real), state };
}

describe("resolve(): the second hop", () => {
  it("published: loads the documents a referenced document names", async () => {
    await insertPage("sty_h2_c", "C");
    await insertPage("sty_h2_b", "B", "sty_h2_c");
    const resolution = await makeFolio().resolve(env, pageDoc("A", "sty_h2_b"));
    expect(Object.keys(resolution.docs ?? {}).sort()).toEqual(["sty_h2_b", "sty_h2_c"]);
    expect(resolution.stories.sty_h2_c).toBeDefined();
  });

  it("published: stops at the second hop", async () => {
    await insertPage("sty_h3_d", "D");
    await insertPage("sty_h3_c", "C", "sty_h3_d");
    await insertPage("sty_h3_b", "B", "sty_h3_c");
    const resolution = await makeFolio().resolve(env, pageDoc("A", "sty_h3_b"));
    expect(Object.keys(resolution.docs ?? {}).sort()).toEqual(["sty_h3_b", "sty_h3_c"]);
  });

  it("draft: loads the second hop too", async () => {
    await insertPage("sty_hd_c", "C");
    await insertPage("sty_hd_b", "B", "sty_hd_c");
    const resolution = await makeFolio().resolve(env, pageDoc("A", "sty_hd_b"), { draft: true });
    expect(Object.keys(resolution.docs ?? {}).sort()).toEqual(["sty_hd_b", "sty_hd_c"]);
  });

  it("draft: a deleted second-hop target creates no Durable Object", async () => {
    await insertPage("sty_hx_b", "B", "sty_hx_gone");
    touched.length = 0;
    const resolution = await makeFolio().resolve(env, pageDoc("A", "sty_hx_b"), { draft: true });
    expect(Object.keys(resolution.docs ?? {})).toEqual(["sty_hx_b"]);
    expect(touched).toContain("sty_hx_b");
    expect(touched).not.toContain("sty_hx_gone");
  });

  it("published: a second-hop target outside the render's chain resolves like a deleted one", async () => {
    await insertPage("sty_hc_c", "C", undefined, "elsewhere");
    await insertPage("sty_hc_b", "B", "sty_hc_c");
    const resolution = await makeFolio().resolve(env, pageDoc("A", "sty_hc_b"));
    expect(Object.keys(resolution.docs ?? {})).toEqual(["sty_hc_b"]);
    expect(resolution.stories.sty_hc_c).toBeUndefined();
  });

  it("draft: a second-hop target outside the chain creates no Durable Object", async () => {
    await insertPage("sty_hf_c", "C", undefined, "elsewhere");
    await insertPage("sty_hf_b", "B", "sty_hf_c");
    touched.length = 0;
    const resolution = await makeFolio().resolve(env, pageDoc("A", "sty_hf_b"), { draft: true });
    expect(Object.keys(resolution.docs ?? {})).toEqual(["sty_hf_b"]);
    expect(touched).not.toContain("sty_hf_c");
  });

  it("tags the page with the second-hop story, so publishing it purges the page", async () => {
    await insertPage("sty_ht_c", "C");
    await insertPage("sty_ht_b", "B", "sty_ht_c");
    const resolution = await makeFolio().resolve(env, pageDoc("A", "sty_ht_b"));
    const { tags } = cacheTags(resolution, { story: "sty_ht_a" });
    expect(tags).toContain("story:sty_ht_b");
    expect(tags).toContain("story:sty_ht_c");
  });

  /**
   * The published branch must not pay a serial round trip for the second hop: it
   * goes out with pass three's story rows. Page -> B -> C is the story map plus
   * B's document (concurrent), then C's story row and C's document (concurrent):
   * four reads, and the last two are sent before either is waited on.
   */
  it("published: the second-hop documents go out with pass three's story rows", async () => {
    await insertPage("sty_hq_c", "C");
    await insertPage("sty_hq_b", "B", "sty_hq_c");
    const spy = counting(env.DB);
    await makeFolio(spy.db).resolve(env, pageDoc("A", "sty_hq_b"));
    expect(spy.state.prepares).toBe(4);
    expect(spy.state.order).toEqual([
      "send",
      "send",
      "recv",
      "recv",
      "send",
      "send",
      "recv",
      "recv",
    ]);
  });

  it("published: a referenced document with no references costs exactly what it did", async () => {
    await insertPage("sty_hn_b", "B");
    const spy = counting(env.DB);
    await makeFolio(spy.db).resolve(env, pageDoc("A", "sty_hn_b"));
    expect(spy.state.prepares).toBe(2);
  });
});
