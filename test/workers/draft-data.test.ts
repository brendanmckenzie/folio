import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { boolean, date, defineBlock, defineRecord, number, richtext, text } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { AuthConfig, FolioBindings } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { SECURE_COOKIE } from "../../src/server/auth/cookie";
import type { Role, Scope } from "../../src/server/auth/roles";
import { createSession } from "../../src/server/auth/session";
import { createToken } from "../../src/server/auth/tokens";
import { createUser } from "../../src/server/auth/users";
import { cellsOf } from "../../src/server/stories";

/**
 * Draft values in the Data table, and sorting by them (issue #82, migration 0015)
 * over real D1 and real Durable Objects.
 *
 * Its own `createFolio` under `auth: 'session'`, for the reason `api.test.ts` gives:
 * the one thing worth proving here, that `content:read` alone is never shown a
 * draft, is only observable when the gate is real. Ids are prefixed `dd_` because
 * D1 state is isolated per file, not per test.
 */

const person = defineRecord({
  name: "ddPerson",
  label: "Person",
  summary: "name",
  fields: {
    name: text({ indexed: true }),
    years: number({ indexed: true }),
    joined: date({ indexed: true, time: true }),
    active: boolean({ indexed: true }),
    bio: richtext(),
  },
});

const pageRoot = defineBlock({
  name: "ddPage",
  label: "Page",
  summary: "title",
  fields: { title: text() },
  render: () => null,
});

const types: DocumentType[] = [
  { name: "ddPageType", label: "Page", kind: "page", root: "ddPage", default: true },
  { name: "ddPersonType", label: "Person", kind: "record", root: "ddPerson", titleField: "name" },
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
  blocks: [person, pageRoot],
  types,
  bindings,
  basePath: "/folio",
  auth,
  route: (p) => (p ? `/${p}` : "/"),
});

const ORIGIN = "https://folio.test";
const call = (path: string, init?: RequestInit) =>
  folio.handle(
    new Request(`${ORIGIN}${path}`, init),
    env,
    createExecutionContext(),
  ) as Promise<Response>;

let users = 0;
async function cookieFor(role: Role) {
  const user = await createUser(env.DB, {
    email: `${role}${users++}@example.com`,
    name: role,
    role,
  });
  const session = await createSession(env.DB, user.id);
  return { cookie: `${SECURE_COOKIE}=${session.token}` };
}
async function tokenFor(...scopes: Scope[]) {
  const { token } = await createToken(env.DB, { name: "reader", scopes });
  return { authorization: `Bearer ${token}` };
}

/* --------------------------------------------------------------- fixtures --- */

const doc = (uid: string, data: Record<string, Json>): Doc => ({
  root: uid,
  bloks: { [uid]: { uid, type: "ddPerson", parent: null, slot: null, order: "a0", data } },
});

interface Fixture {
  id: string;
  title: string;
  /** The published document, or null for an unpublished story. */
  published: Record<string, Json> | null;
  /** The draft mirror, or null for a story that has none. */
  draft: Record<string, Json> | null;
}

async function insert(f: Fixture) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at, draft_data)
     values (?, 'ddPersonType', null, ?, null, 'a0', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      f.id,
      f.id,
      f.title,
      Date.now(),
      Date.now(),
      f.published ? JSON.stringify(doc("r", f.published)) : null,
      f.published ? Date.now() : null,
      f.draft ? JSON.stringify({ data: f.draft }) : null,
    )
    .run();
}

type Cell = { text: string; num: number | null; draft?: true };
type ListRow = { id: string; indexed: Record<string, Cell>; state: string };
type ListPage = { rows: ListRow[]; cursor: string | null; total?: number };

async function list(query: string, headers: Record<string, string>): Promise<ListPage> {
  const res = await call(`/folio/api/documents?type=ddPersonType&${query}`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as ListPage;
}

/** Every page of a listing, followed by cursor, as one array of ids. */
async function walk(query: string, headers: Record<string, string>, limit: number) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page: ListPage = await list(
      `${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
      headers,
    );
    ids.push(...page.rows.map((r) => r.id));
    cursor = page.cursor;
    if (!cursor) return ids;
  }
  throw new Error("a listing that never ends");
}

/*
 * Six people, chosen so that the draft-or-published order and the published-only
 * order disagree, and so that a tie, a null and a number whose text order differs
 * from its numeric order all sit in the data.
 *
 *            published years   draft years   shown to a drafts reader
 *   dd_p1    30                (no mirror)   30
 *   dd_p2    (unpublished)     9             9      <- "9" sorts after "50" as text
 *   dd_p3    20                50            50     <- changed: the draft differs
 *   dd_p4    (unpublished)     (no mirror)   none   <- null key
 *   dd_p5    20                (no mirror)   20     <- ties dd_p3's published value
 *   dd_p6    (unpublished)     (no years)    none   <- the draft cleared it: null key
 */
beforeAll(async () => {
  await insert({ id: "dd_p1", title: "Pat", published: { name: "Pat", years: 30 }, draft: null });
  await insert({
    id: "dd_p2",
    title: "alice",
    published: null,
    draft: { name: "alice", years: 9 },
  });
  // Inserted out of id order on purpose (p6 before p4, p5 before p3), so a tie or a
  // null block that is only in id order because that is the scan order fails.
  await insert({ id: "dd_p6", title: "Fay", published: null, draft: { name: "Fay" } });
  await insert({ id: "dd_p5", title: "Eve", published: { name: "Eve", years: 20 }, draft: null });
  await insert({ id: "dd_p4", title: "Dee", published: null, draft: null });
  await insert({
    id: "dd_p3",
    title: "Bob",
    published: { name: "Bob", years: 20 },
    draft: { name: "Bob", years: 50 },
  });
  await folio.reindex(env, { batch: 200 });
});

const ids = (page: ListPage) => page.rows.map((r) => r.id);

/* ------------------------------------------------------------- the display --- */

describe("GET /documents shows draft values to a caller who may read drafts", () => {
  it("fills an unpublished record's cells from its draft, marked as the draft's", async () => {
    const editor = await cookieFor("editor");
    const page = await list("sort=ord", editor);
    const p2 = page.rows.find((r) => r.id === "dd_p2");
    expect(p2?.indexed.years).toEqual({ text: "9", num: 9, draft: true });
    expect(p2?.indexed.name).toEqual({ text: "alice", num: null, draft: true });
  });

  it("shows a changed record's draft value, and leaves an agreeing cell unmarked", async () => {
    const editor = await cookieFor("editor");
    const p3 = (await list("sort=ord", editor)).rows.find((r) => r.id === "dd_p3");
    expect(p3?.indexed.years).toEqual({ text: "50", num: 50, draft: true });
    expect(p3?.indexed.name).toEqual({ text: "Bob", num: null });
  });

  it("reads a story with no mirror as published, and does not borrow for a cleared field", async () => {
    const editor = await cookieFor("editor");
    const rows = (await list("sort=ord", editor)).rows;
    expect(rows.find((r) => r.id === "dd_p1")?.indexed.years).toEqual({ text: "30", num: 30 });
    // dd_p6's draft has no `years`: blank, with no published value to fall back on.
    expect(rows.find((r) => r.id === "dd_p6")?.indexed.years).toBeUndefined();
  });

  it("withholds every draft value from a token holding content:read alone", async () => {
    const reader = await tokenFor("content:read");
    const page = await list("sort=ord", reader);
    const byId = new Map(page.rows.map((r) => [r.id, r]));
    // Published values only: the changed record shows 20, not its draft's 50.
    expect(byId.get("dd_p3")?.indexed.years).toEqual({ text: "20", num: 20 });
    // An unpublished record has nothing to show.
    expect(byId.get("dd_p2")?.indexed).toEqual({});
    // And nothing of the mirror is on the wire at all, under any key.
    const raw = JSON.stringify(page);
    expect(raw).not.toContain("draft_data");
    expect(raw).not.toContain("_draftData");
    expect(raw).not.toContain('"draft":true');
  });

  it("shows them to a token that also holds content:read:draft", async () => {
    const reader = await tokenFor("content:read", "content:read:draft");
    const p2 = (await list("sort=ord", reader)).rows.find((r) => r.id === "dd_p2");
    expect(p2?.indexed.years).toEqual({ text: "9", num: 9, draft: true });
  });
});

describe("cellsOf", () => {
  const was = { years: { text: "20", num: 20 } };

  it("is the published values when there is no mirror", () => {
    expect(cellsOf(was, null)).toBe(was);
  });

  it("marks only what differs, and drops what the draft does not have", () => {
    expect(
      cellsOf(
        { ...was, name: { text: "Bob", num: null }, gone: { text: "x", num: null } },
        { years: { text: "50", num: 50 }, name: { text: "Bob", num: null } },
      ),
    ).toEqual({ years: { text: "50", num: 50, draft: true }, name: { text: "Bob", num: null } });
  });
});

/* ----------------------------------------------------------------- sorting --- */

describe("GET /documents?sort=field:<name>", () => {
  it("orders by the draft-or-published value, numerically, nulls last", async () => {
    const editor = await cookieFor("editor");
    // 9 before 20, 30, 50: as text "9" would come last. dd_p4 and dd_p6 have no value
    // and follow in id order.
    expect(ids(await list("sort=field:years", editor))).toEqual([
      "dd_p2",
      "dd_p5",
      "dd_p1",
      "dd_p3",
      "dd_p4",
      "dd_p6",
    ]);
  });

  it("reverses, and still puts nulls last", async () => {
    const editor = await cookieFor("editor");
    expect(ids(await list("sort=field:years&dir=desc", editor))).toEqual([
      "dd_p3",
      "dd_p1",
      "dd_p5",
      "dd_p2",
      "dd_p4",
      "dd_p6",
    ]);
  });

  it("orders a caller without READ_DRAFT by published values only, ties by id", async () => {
    const reader = await tokenFor("content:read");
    // dd_p3 and dd_p5 tie at 20 and are told apart by id; the unpublished three are null.
    expect(ids(await list("sort=field:years", reader))).toEqual([
      "dd_p3",
      "dd_p5",
      "dd_p1",
      "dd_p2",
      "dd_p4",
      "dd_p6",
    ]);
    // The draft's 50 must not have leaked into the order either.
    expect(ids(await list("sort=field:years&dir=desc", reader)).slice(0, 3)).toEqual([
      "dd_p1",
      "dd_p3",
      "dd_p5",
    ]);
  });

  it("pages without repeating or skipping a row, across ties and the null block", async () => {
    const editor = await cookieFor("editor");
    const reader = await tokenFor("content:read");
    // Stated, not derived from the same query: a paging test that compares a walk
    // with the one-page answer passes for any order, however wrong.
    const expected = [
      [editor, "asc", ["dd_p2", "dd_p5", "dd_p1", "dd_p3", "dd_p4", "dd_p6"]],
      [editor, "desc", ["dd_p3", "dd_p1", "dd_p5", "dd_p2", "dd_p4", "dd_p6"]],
      [reader, "asc", ["dd_p3", "dd_p5", "dd_p1", "dd_p2", "dd_p4", "dd_p6"]],
      [reader, "desc", ["dd_p1", "dd_p3", "dd_p5", "dd_p2", "dd_p4", "dd_p6"]],
    ] as const;
    for (const [headers, dir, order] of expected) {
      for (const limit of [1, 2, 3, 4, 6]) {
        expect(await walk(`sort=field:years&dir=${dir}`, headers, limit)).toEqual(order);
      }
    }
  });

  it("sorts text without regard to case", async () => {
    const editor = await cookieFor("editor");
    // alice (dd_p2, lower case) before Bob, not after Pat as binary order would;
    // dd_p4 has no name anywhere and is last.
    expect(ids(await list("sort=field:name", editor))).toEqual([
      "dd_p2",
      "dd_p3",
      "dd_p5",
      "dd_p6",
      "dd_p1",
      "dd_p4",
    ]);
  });

  it("answers 400 for a field the type does not index, and for no type at all", async () => {
    const editor = await cookieFor("editor");
    const bio = await call("/folio/api/documents?type=ddPersonType&sort=field:bio", {
      headers: editor,
    });
    expect(bio.status).toBe(400);
    const none = await call("/folio/api/documents?type=ddPersonType&sort=field:nope", {
      headers: editor,
    });
    expect(none.status).toBe(400);
    const untyped = await call("/folio/api/documents?sort=field:years", { headers: editor });
    expect(untyped.status).toBe(400);
  });

  it("keeps the three column sorts on their keyset", async () => {
    const editor = await cookieFor("editor");
    const page = await list("sort=title&limit=2", editor);
    expect(page.cursor).not.toBeNull();
    // A keyset cursor carries the last row's key and id: two parts, not an offset.
    const parts = JSON.parse(atob(page.cursor!.replaceAll("-", "+").replaceAll("_", "/")));
    expect(parts).toHaveLength(2);
  });
});

describe("a date and a boolean sort as their projected numbers", () => {
  const rows: Fixture[] = [
    // The earlier instant is the *longer* string: text order would put it second.
    {
      id: "dd_d1",
      title: "d1",
      published: null,
      draft: { name: "d1", joined: "2026-10-22T09:30:00+10:00", active: true },
    },
    {
      id: "dd_d2",
      title: "d2",
      published: null,
      draft: { name: "d2", joined: "2026-10-22", active: false },
    },
  ];

  it("orders dates by instant and booleans false before true", async () => {
    for (const r of rows) await insert(r);
    const editor = await cookieFor("editor");
    const dated = ids(await list("sort=field:joined", editor)).filter((id) =>
      id.startsWith("dd_d"),
    );
    expect(dated).toEqual(["dd_d1", "dd_d2"]);
    const flags = ids(await list("sort=field:active", editor)).filter((id) =>
      id.startsWith("dd_d"),
    );
    expect(flags).toEqual(["dd_d2", "dd_d1"]);
  });
});

describe("the bind cap", () => {
  it("lists a full 200-row page sorted by a field without exceeding D1's 100 binds", async () => {
    for (let i = 0; i < 130; i++) {
      await insert({
        id: `dd_w${String(i).padStart(3, "0")}`,
        title: `w${i}`,
        published: null,
        draft: { name: `w${i}`, years: i },
      });
    }
    const editor = await cookieFor("editor");
    const page = await list("sort=field:years&limit=200", editor);
    expect(page.rows.length).toBeGreaterThan(100);
    expect(page.rows.every((r) => r.indexed.name !== undefined || r.id.startsWith("dd_p"))).toBe(
      true,
    );
  });
});

/* ---------------------------------------------------------------- backfill --- */

describe("POST /reindex?drafts=1", () => {
  const warm = async (id: string, data: Record<string, Json>) => {
    const stub = env.STORY.get(env.STORY.idFromName(id)) as unknown as {
      getOrInit: (d: Doc) => Promise<Doc>;
    };
    await stub.getOrInit(doc("r", data));
  };

  it("rewrites the mirror of a warm object, and seeds a cold one through initDraft", async () => {
    // Warm: the object holds a draft the mirror never saw. Seeding it wrote the
    // mirror already, so clear it to stand for a document last edited before 0015.
    await insert({ id: "dd_warm", title: "warm", published: null, draft: null });
    await warm("dd_warm", { name: "Warm draft", years: 7 });
    await env.DB.prepare("update stories set draft_data = null where id = 'dd_warm'").run();
    // Cold: a published row whose object was never touched.
    await insert({
      id: "dd_cold",
      title: "cold",
      published: { name: "Cold published", years: 3 },
      draft: null,
    });

    const admin = await cookieFor("admin");
    const res = await call("/folio/api/reindex?drafts=1", {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ batch: 200 }),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as { written: number; failed: number; continueFrom: null };
    expect(report.failed).toBe(0);
    expect(report.written).toBeGreaterThanOrEqual(2);

    const mirror = async (id: string) =>
      JSON.parse(
        (
          await env.DB.prepare("select draft_data as d from stories where id = ?")
            .bind(id)
            .first<{ d: string }>()
        )?.d ?? "null",
      );
    expect(await mirror("dd_warm")).toEqual({ data: { name: "Warm draft", years: 7 } });
    expect(await mirror("dd_cold")).toEqual({ data: { name: "Cold published", years: 3 } });
  });

  it("writes nothing on a dry run, and is ADMIN only", async () => {
    // Cold: a published row whose object was never touched. A dry run must not
    // seed it either, which is the half a warm object cannot show.
    await insert({ id: "dd_dry", title: "dry", published: { name: "Dry" }, draft: null });
    const admin = await cookieFor("admin");
    const dry = await call("/folio/api/reindex?drafts=1", {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true, batch: 200 }),
    });
    expect(((await dry.json()) as { dryRun: boolean }).dryRun).toBe(true);
    expect(
      (
        await env.DB.prepare("select draft_data as d from stories where id = 'dd_dry'").first<{
          d: string | null;
        }>()
      )?.d,
    ).toBeNull();
    const held = await runInDurableObject(env.STORY.get(env.STORY.idFromName("dd_dry")), (i) =>
      (i as unknown as { peek(): Promise<unknown> }).peek(),
    );
    expect(held).toBeNull();

    const editor = await cookieFor("editor");
    const refused = await call("/folio/api/reindex?drafts=1", {
      method: "POST",
      headers: editor,
    });
    expect(refused.status).toBe(403);
  });
});
