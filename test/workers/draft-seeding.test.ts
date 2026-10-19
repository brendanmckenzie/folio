import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import { defineMigration, field } from "../../src/core/migrate";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * Durable Object reseed (`../../docs/specs/foundation/draft-seeding.md`, issue #28).
 *
 * The missing object is simulated the way it actually arises: a D1 row inserted
 * directly for an id whose object has never been touched. `purge()` would not do,
 * because it leaves the log's autoincrement sequence behind and so is not the state
 * a copied database produces. Each test takes an id of its own, and so an object of
 * its own, since storage is isolated per file and not per test.
 */

const ORIGIN = "https://folio.test";

const page = defineBlock({
  name: "sdPage",
  label: "Page",
  summary: "title",
  fields: { title: text({ label: "Title" }) },
  render: () => null,
});

const headerRoot = defineBlock({
  name: "sdHeader",
  label: "Header",
  fields: { tagline: text({ label: "Tagline" }) },
  render: () => null,
});

const types: DocumentType[] = [
  { name: "sdPageType", label: "Page", kind: "page", root: "sdPage", default: true },
  { name: "sdHeaderType", label: "Header", kind: "singleton", root: "sdHeader" },
];

/** Not idempotent: running it twice over the same document gives a different answer. */
const APPEND = defineMigration({
  id: "sdPage-zz-append",
  description: "sdPage.title gets a suffix",
  up: (_doc, ctx) =>
    ctx.each("sdPage", (b) => {
      const t = b.data.title;
      return typeof t === "string"
        ? [{ t: "set", uid: b.uid, field: "title", value: `${t}!` }]
        : [];
    }),
});

const RENAME = defineMigration({
  id: "sdPage-titleOld-to-title",
  description: "sdPage.titleOld -> sdPage.title",
  up: (_doc, ctx) => ctx.each("sdPage", (b) => field.rename(b, "titleOld", "title")),
});

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

function build(db?: D1Database) {
  return createFolio<Cloudflare.Env>({
    blocks: [page, headerRoot],
    types,
    globals: ["sdHeaderType"],
    migrations: [RENAME, APPEND],
    bindings: (e) => ({ ...bindings(e), ...(db ? { db } : {}) }),
    basePath: "/folio",
    assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
    auth: "open",
    route: (p) => (p ? `/${p}` : "/"),
  });
}

const folio = build();

let counter = 0;
const nextId = () => `sty_sd${(counter++).toString().padStart(4, "0")}`;

/** A one-block page document with a root uid of the caller's choosing. */
const docOf = (root: string, title: string, extra: Record<string, string> = {}): Doc => ({
  root,
  bloks: {
    [root]: {
      uid: root,
      type: "sdPage",
      parent: null,
      slot: null,
      order: "a0",
      data: { ...(title ? { title } : {}), ...extra },
    },
  },
});

interface RowOpts {
  id?: string;
  published?: Doc | null;
  unpublished?: boolean;
  draftSyncId?: number;
  publishedSyncId?: number;
}

/** A `stories` row as a copied database delivers it: no object behind it. */
async function insertRow(opts: RowOpts = {}): Promise<string> {
  const id = opts.id ?? nextId();
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at, unpublished_at,
                          draft_sync_id, published_sync_id)
     values (?, 'sdPageType', null, ?, ?, 'a0', 'Copied', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      id,
      id,
      Date.now(),
      Date.now(),
      opts.published ? JSON.stringify(opts.published) : null,
      opts.published ? Date.now() : null,
      opts.unpublished ? Date.now() : null,
      opts.draftSyncId ?? 0,
      opts.publishedSyncId ?? 0,
    )
    .run();
  return id;
}

let versionCounter = 0;
async function insertVersion(
  storyId: string,
  doc: Doc,
  opts: { createdAt?: number; schemaId?: string | null; kind?: string } = {},
) {
  await env.DB.prepare(
    `insert into versions (id, story_id, kind, label, title, actor, doc, created_at, schema_id)
     values (?, ?, ?, null, 'Copied', null, ?, ?, ?)`,
  )
    .bind(
      `ver_sd${(versionCounter++).toString().padStart(4, "0")}`,
      storyId,
      opts.kind ?? "publish",
      JSON.stringify(doc),
      opts.createdAt ?? Date.now(),
      opts.schemaId === undefined ? RENAME.id : opts.schemaId,
    )
    .run();
}

type Peekable = { peek(): Promise<{ doc: Doc; syncId: number } | null> };
const objectOf = (id: string) => env.STORY.get(env.STORY.idFromName(id));
const peek = (id: string) =>
  runInDurableObject(objectOf(id), (i) => (i as unknown as Peekable).peek());

/** Records every statement D1 is asked to prepare, following `withSession` and `bind`. */
function recordingDb(real: D1Database): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const watch = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "prepare") {
          return (q: string) => {
            sql.push(q);
            return (value as (q: string) => object).call(t, q);
          };
        }
        if (prop === "withSession") {
          return (...args: unknown[]) =>
            watch((value as (...a: unknown[]) => object).apply(t, args));
        }
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return { db: watch(real), sql };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from versions"),
    env.DB.prepare("delete from stories where id like 'sty_sd%' or id like 'sng_sd%'"),
  ]);
});

describe("a story whose object has no state", () => {
  it("opens with its published document, root uid included", async () => {
    const published = docOf("oldroot1", "Real content");
    const id = await insertRow({ published, draftSyncId: 57, publishedSyncId: 50 });
    await insertVersion(id, docOf("verroot1", "A version"));

    expect(await folio.draft(env, id)).toEqual(published);
  });

  it("falls back to the newest version when nothing is published", async () => {
    const id = await insertRow({ unpublished: true });
    await insertVersion(id, docOf("verold01", "Older"), { createdAt: 1000 });
    await insertVersion(id, docOf("vernew01", "Newer"), { createdAt: 2000 });

    const draft = await folio.draft(env, id);
    expect(draft.root).toBe("vernew01");
    expect(draft.bloks.vernew01!.data.title).toBe("Newer");
  });

  it("migrates a version through the brand's migrations on the way in", async () => {
    const id = await insertRow();
    await env.DB.prepare("update stories set schema_id = ? where id = ?").bind(RENAME.id, id).run();
    await insertVersion(id, docOf("vermig01", "", { titleOld: "Old shape" }), { schemaId: null });

    const draft = await folio.draft(env, id);
    expect(draft.bloks.vermig01!.data.title).toBe("Old shape");
    // A rename empties the old key rather than deleting it; what matters is that
    // the old value no longer lives there.
    expect(draft.bloks.vermig01!.data.titleOld ?? null).toBeNull();
  });

  it("seeds a version only up to the row's schema, so migrate applies the rest once", async () => {
    const id = await insertRow({ unpublished: true });
    await env.DB.prepare("update stories set schema_id = ? where id = ?").bind(RENAME.id, id).run();
    await insertVersion(id, docOf("vernon01", "Once"), { schemaId: RENAME.id });

    // The row is at RENAME, so APPEND is still due and has not been applied to the seed.
    expect((await folio.draft(env, id)).bloks.vernon01!.data.title).toBe("Once");

    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/api/migrate`, { method: "POST" }),
      env,
      createExecutionContext(),
    );
    expect(res?.status).toBeLessThan(300);
    expect((await folio.draft(env, id)).bloks.vernon01!.data.title).toBe("Once!");
  });

  it("seeds blank at position 0 when the row has neither a publish nor a version", async () => {
    const id = await insertRow();
    const draft = await folio.draft(env, id);
    expect(draft.bloks[draft.root]!.type).toBe("sdPage");
    expect((await peek(id))?.syncId).toBe(0);
  });

  it("starts the log at the row's own position, so the badge keeps reading right", async () => {
    const id = await insertRow({
      published: docOf("oldroot2", "Live"),
      draftSyncId: 57,
      publishedSyncId: 50,
    });
    await folio.draft(env, id);
    expect((await peek(id))?.syncId).toBe(57);

    const result = await runInDurableObject(objectOf(id), (i) =>
      i.commit(
        [{ t: "set", uid: "oldroot2", field: "title", value: "Edited" }],
        { id: "tester", name: "Tester" },
        "tx_seedbase",
      ),
    );
    expect(result).toEqual({ syncId: 58, txId: "tx_seedbase" });

    // The sentinel rows the seed used to advance the sequence never survive it.
    const trail = (await runInDurableObject(objectOf(id), (i) => i.recent())).rows;
    expect(trail.map((e) => e.syncId)).toEqual([58]);

    await runDurableObjectAlarm(objectOf(id));
    const row = await env.DB.prepare(
      "select draft_sync_id as d, published_sync_id as p from stories where id = ?",
    )
      .bind(id)
      .first<{ d: number; p: number }>();
    expect(row!.d).toBe(58);
    expect(row!.d).toBeGreaterThan(row!.p);
  });

  it("reads live after a publish with no edit in between", async () => {
    const id = await insertRow({
      published: docOf("oldroot3", "Live"),
      draftSyncId: 57,
      publishedSyncId: 50,
    });
    await folio.draft(env, id);

    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/api/story/${id}/publish`, { method: "POST" }),
      env,
      createExecutionContext(),
    );
    expect(res?.status).toBe(200);
    const row = await env.DB.prepare(
      "select draft_sync_id as d, published_sync_id as p from stories where id = ?",
    )
      .bind(id)
      .first<{ d: number; p: number }>();
    expect(row!.p).toBe(57);
    expect(row!.p).toBeGreaterThanOrEqual(row!.d);
  });

  it("answers a hello from across the seeded gap with a bootstrap, never an empty catch-up", async () => {
    const id = await insertRow({ published: docOf("oldroot4", "Live"), draftSyncId: 57 });
    await folio.draft(env, id);

    const res = await objectOf(id).fetch("https://story.test/ws", {
      headers: { Upgrade: "websocket" },
    });
    const ws = res.webSocket!;
    ws.accept();
    const first = new Promise<{ type: string }>((resolve) =>
      ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string))),
    );
    ws.send(
      JSON.stringify({
        type: "hello",
        v: (await import("../../src/core/protocol")).PROTOCOL_VERSION,
        lastSyncId: 50,
        identity: { actor: "a", name: "A", colour: "#000000" },
      }),
    );
    expect((await first).type).toBe("bootstrap");
    ws.close();
  });

  it("takes the D1 read once, and a warm object ignores later changes in D1", async () => {
    const id = await insertRow({ published: docOf("oldroot5", "First") });
    await folio.draft(env, id);

    await env.DB.prepare("update stories set published_doc = ? where id = ?")
      .bind(JSON.stringify(docOf("oldroot5", "Changed in D1")), id)
      .run();
    const spy = recordingDb(env.DB);
    const again = await build(spy.db).draft(env, id);

    expect(again.bloks.oldroot5!.data.title).toBe("First");
    expect(spy.sql.some((q) => q.includes("latestVersionId"))).toBe(false);
  });

  it("seeds the same document for two cold opens at once", async () => {
    const id = await insertRow({ published: docOf("oldroot6", "Same") });
    const [a, b] = await Promise.all([folio.draft(env, id), folio.draft(env, id)]);
    expect(a).toEqual(b);
    expect(a.root).toBe("oldroot6");
  });
});

describe("what never seeds from D1", () => {
  it("a deleted story, even with an orphaned version naming it", async () => {
    const id = nextId();
    await env.DB.prepare(
      `insert into versions (id, story_id, kind, label, title, actor, doc, created_at, schema_id)
       values ('ver_sd_orphan', ?, 'publish', null, 'Gone', null, ?, ?, null)`,
    )
      .bind(id, JSON.stringify(docOf("orphan01", "Resurrected")), Date.now())
      .run();

    // `folio.draft` refuses an id with no row on a branded deployment and seeds
    // 'Untitled' otherwise; this one is the latter, so go through it.
    const draft = await folio.draft(env, id).catch((e: Error) => e);
    if (draft instanceof Error) {
      expect(draft.message).toMatch(/unknown/i);
    } else {
      expect(draft.root).not.toBe("orphan01");
    }
  });

  it("a story created through the API, whose content is the caller's", async () => {
    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/api/stories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Brand new", type: "sdPageType" }),
      }),
      env,
      createExecutionContext(),
    );
    expect(res?.status).toBeLessThan(300);
    const created = (await res!.json()) as { id: string };
    const draft = await folio.draft(env, created.id);
    expect(draft.bloks[draft.root]!.data.title).toBe("Brand new");
    expect((await peek(created.id))?.syncId).toBe(0);
  });

  it("writes nothing to D1 when a preview reads a cold imported row", async () => {
    const stored: Doc = {
      root: "hdrroot1",
      bloks: {
        hdrroot1: {
          uid: "hdrroot1",
          type: "sdHeader",
          parent: null,
          slot: null,
          order: "a0",
          data: { tagline: "From production" },
        },
      },
    };
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                            published_doc, published_at)
       values ('sng_sdHeaderType', 'sdHeaderType', null, 'sdHeaderType', null, 'a0', 'Header', ?, ?, ?, ?)`,
    )
      .bind(Date.now(), Date.now(), JSON.stringify(stored), Date.now())
      .run();

    const spy = recordingDb(env.DB);
    const resolution = await build(spy.db).resolve(env, docOf("pg000001", "Home"), { draft: true });

    expect(resolution.globals?.sdHeaderType).toEqual(stored);
    expect(spy.sql.filter((q) => /^\s*(insert|update|delete)\b/i.test(q))).toEqual([]);
  });
});
