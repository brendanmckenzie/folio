import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defineBlock, defineRecord, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { AuditReport, AuthConfig, FolioBindings } from "../../src/server";
import { createFolio, magicLink } from "../../src/server";
import { SECURE_COOKIE } from "../../src/server/auth/cookie";
import type { Role, Scope } from "../../src/server/auth/roles";
import { createSession } from "../../src/server/auth/session";
import { createToken } from "../../src/server/auth/tokens";
import { createUser } from "../../src/server/auth/users";

/**
 * `unique` is enforced where a record goes live (issue #75, owner decision: at
 * publish only), and every path that publishes inherits it from `publish()`: the
 * admin route, the v1 API, bulk and the scheduler. One test per path, because a
 * check skipped on one of the four reads as green on the other three.
 *
 * Its own `createFolio`, driven through `folio.handle` directly.
 */

const artist = defineRecord({
  name: "uqArtist",
  label: "Artist",
  summary: "name",
  fields: {
    name: text({ indexed: true }),
    slug: text({ label: "Slug", indexed: true, unique: true }),
  },
});
const pageRoot = defineBlock({
  name: "uqPage",
  label: "Page",
  fields: { title: text() },
  render: () => null,
});
const types: DocumentType[] = [
  { name: "uqPageType", label: "Page", kind: "page", root: "uqPage", default: true },
  { name: "uqArtistType", label: "Artist", kind: "record", root: "uqArtist", titleField: "name" },
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

const ORIGIN = "https://folio.test";
const call = (path: string, init?: RequestInit) =>
  folio.handle(new Request(`${ORIGIN}${path}`, init), env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext) as Promise<Response>;

let users = 0;
async function cookieFor(role: Role): Promise<Record<string, string>> {
  const user = await createUser(env.DB, {
    email: `${role}${users++}@example.com`,
    name: role,
    role,
  });
  const session = await createSession(env.DB, user.id);
  return { cookie: `${SECURE_COOKIE}=${session.token}`, "content-type": "application/json" };
}
async function tokenFor(...scopes: Scope[]): Promise<Record<string, string>> {
  const { token } = await createToken(env.DB, { name: "t", scopes });
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

const doc = (data: Record<string, string>): Doc => ({
  root: "r",
  bloks: { r: { uid: "r", type: "uqArtist", parent: null, slot: null, order: "a0", data } },
});
const stubFor = (id: string) =>
  env.STORY.get(env.STORY.idFromName(id)) as unknown as {
    getOrInit: (d: Doc) => Promise<Doc>;
    purge: () => Promise<void>;
  };

/** A record with a draft, and published (indexed) only when `live`. */
async function seed(id: string, name: string, slug: string, live = false, site = "default") {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          site_id, published_doc, published_at)
     values (?, 'uqArtistType', null, ?, null, 'a0', ?, 1, 1, ?, ?, ?)`,
  )
    .bind(id, id, name, site, live ? JSON.stringify(doc({ name, slug })) : null, live ? 1 : null)
    .run();
  if (live) {
    await env.DB.prepare(
      "insert into content_index (story_id, locale, field, text_value) values (?, '', 'slug', ?)",
    )
      .bind(id, slug)
      .run();
  }
  await stubFor(id).purge();
  await stubFor(id).getOrInit(doc({ name, slug }));
}

const state = async (id: string) =>
  env.DB.prepare("select published_at as p from stories where id = ?")
    .bind(id)
    .first<{ p: number | null }>();
const versions = async (id: string) =>
  (await env.DB.prepare("select count(*) as n from versions where story_id = ?")
    .bind(id)
    .first<{ n: number }>())!.n;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from schedules"),
    env.DB.prepare("delete from versions"),
    env.DB.prepare("delete from content_index"),
    env.DB.prepare("delete from stories where id like 'uq_%'"),
    env.DB.prepare("delete from sessions"),
    env.DB.prepare("delete from api_tokens"),
    env.DB.prepare("delete from users"),
  ]);
});

/** Ada is live; her namesake's draft holds the same slug. */
async function seedClash() {
  await seed("uq_ada", "Ada Lovelace", "ada", true);
  await seed("uq_other", "Ada Byron", "ada");
}

type Err = { error: { code: string; message: string } };
const NAMES_THE_OTHER = /“Slug” is already “ada” on “Ada Lovelace” \(uq_ada\)/;

describe("publishing a duplicate is refused with 409 conflict naming the other record", () => {
  it("through the admin route", async () => {
    await seedClash();
    const res = await call("/folio/api/story/uq_other/publish", {
      method: "POST",
      headers: await cookieFor("publisher"),
    });
    expect(res.status).toBe(409);
    const body = await res.json<Err>();
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toMatch(NAMES_THE_OTHER);
    // Refused before the batch: nothing went live and no version was retained.
    expect((await state("uq_other"))?.p).toBeNull();
    expect(await versions("uq_other")).toBe(0);
  });

  it("through the v1 API", async () => {
    await seedClash();
    const res = await call("/folio/api/v1/documents/uq_other/publish", {
      method: "POST",
      headers: await tokenFor("publish"),
    });
    expect(res.status).toBe(409);
    expect((await res.json<Err>()).error.message).toMatch(NAMES_THE_OTHER);
    expect((await state("uq_other"))?.p).toBeNull();
  });

  it("through bulk, reported against the item rather than failing the job", async () => {
    await seedClash();
    await seed("uq_free", "Free", "free");
    const res = await call("/folio/api/bulk/publish", {
      method: "POST",
      headers: await cookieFor("publisher"),
      body: JSON.stringify({ selection: { ids: ["uq_other", "uq_free"] } }),
    });
    expect(res.status).toBe(200);
    const report = await res.json<{
      done: number;
      failed: { id: string; message: string }[];
    }>();
    expect(report.done).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.id).toBe("uq_other");
    expect(report.failed[0]?.message).toMatch(NAMES_THE_OTHER);
    expect((await state("uq_other"))?.p).toBeNull();
    expect((await state("uq_free"))?.p).not.toBeNull();
  });

  it("through the scheduler, recorded as a failed attempt and left unpublished", async () => {
    await seedClash();
    await env.DB.prepare(
      `insert into schedules (id, story_id, action, at, created_at)
       values ('sch_uq0000000001', 'uq_other', 'publish', 5, 1)`,
    ).run();
    const report = await folio.runSchedules(env, { now: 10 });
    expect(report.published).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect((await state("uq_other"))?.p).toBeNull();
    const row = await env.DB.prepare("select status, last_error as e from schedules where id = ?")
      .bind("sch_uq0000000001")
      .first<{ status: string; e: string | null }>();
    expect(row?.e).toMatch(NAMES_THE_OTHER);
  });
});

describe("what the check leaves alone", () => {
  it("lets a record republish itself, and publish once its value is free", async () => {
    await seedClash();
    const publisher = await cookieFor("publisher");
    // Self is excluded: Ada republishing her own slug is no conflict.
    expect(
      (await call("/folio/api/story/uq_ada/publish", { method: "POST", headers: publisher }))
        .status,
    ).toBe(200);
    // The namesake changes her draft and goes live.
    await stubFor("uq_other").purge();
    await stubFor("uq_other").getOrInit(doc({ name: "Ada Byron", slug: "ada-byron" }));
    expect(
      (await call("/folio/api/story/uq_other/publish", { method: "POST", headers: publisher }))
        .status,
    ).toBe(200);
  });

  it("is per owning scope: the same value on another site's record is no conflict", async () => {
    await seed("uq_ada", "Ada Lovelace", "ada", true, "default");
    await seed("uq_far", "Ada Far", "ada", false, "elsewhere");
    // `uq_far` belongs to a scope the single-site route fence does not reach, so the
    // cron (which has no request scope) publishes it: the question is only whether the
    // check compares across scopes.
    await env.DB.prepare(
      `insert into schedules (id, story_id, action, at, created_at)
       values ('sch_uq0000000002', 'uq_far', 'publish', 5, 1)`,
    ).run();
    const report = await folio.runSchedules(env, { now: 10 });
    expect(report.failed).toEqual([]);
    expect(report.published).toEqual(["uq_far"]);
  });

  it("does not treat two empty values as a duplicate", async () => {
    await seed("uq_a", "A", "");
    await seed("uq_b", "B", "");
    const publisher = await cookieFor("publisher");
    expect(
      (await call("/folio/api/story/uq_a/publish", { method: "POST", headers: publisher })).status,
    ).toBe(200);
    expect(
      (await call("/folio/api/story/uq_b/publish", { method: "POST", headers: publisher })).status,
    ).toBe(200);
  });
});

describe("the audit's unique-duplicate finding", () => {
  it("names every record in a group the publish check could not see", async () => {
    // Two live records already holding one value, as a race or a newly declared flag leaves.
    await seed("uq_ada", "Ada Lovelace", "ada", true);
    await seed("uq_dup", "Ada Byron", "ada", true);
    await seed("uq_solo", "Solo", "solo", true);
    const res = await call("/folio/api/audit", { headers: await cookieFor("admin") });
    expect(res.status).toBe(200);
    const report = (await res.json()) as AuditReport;
    const found = report.stories.filter((f) => f.check === "unique-duplicate");
    expect(found.map((f) => f.story).sort()).toEqual(["uq_ada", "uq_dup"]);
    expect(found[0]).toMatchObject({ type: "uqArtistType" });
    expect(found[0]?.detail).toMatch(/'Slug' is 'ada'/);
  });

  it("reports nothing when every value is held once", async () => {
    await seed("uq_ada", "Ada Lovelace", "ada", true);
    await seed("uq_solo", "Solo", "solo", true);
    const res = await call("/folio/api/audit", { headers: await cookieFor("admin") });
    const report = (await res.json()) as AuditReport;
    expect(report.stories.filter((f) => f.check === "unique-duplicate")).toEqual([]);
  });

  it("runs on the first call of a walk only, so a merged report names a pair once", async () => {
    await seed("uq_ada", "Ada Lovelace", "ada", true);
    await seed("uq_dup", "Ada Byron", "ada", true);
    const res = await call("/folio/api/audit?continueFrom=uq_a", {
      headers: await cookieFor("admin"),
    });
    const report = (await res.json()) as AuditReport;
    expect(report.stories.filter((f) => f.check === "unique-duplicate")).toEqual([]);
  });
});
