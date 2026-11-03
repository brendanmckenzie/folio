import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NO_STORE } from "../../src/core/cache-tags";
import { collection, defineBlock, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { ResolvedForm } from "../../src/core/forms";
import type { LocaleConfig } from "../../src/core/locales";
import { optionListKey } from "../../src/core/option-sources";
import { createFolio, type FolioBindings } from "../../src/server";
import { createForm, updateForm } from "../../src/server/forms";

/**
 * Phase 3 of form option sources (`docs/specs/content-model/form-option-sources.md`):
 * a sourced question's list on the rendered descriptor, its tags, and the `no-store`
 * rule for a list that could not be read.
 */

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const tripRoot = defineBlock({
  name: "frsTrip",
  label: "Trip",
  summary: "title",
  fields: { title: text({ indexed: true, translatable: true }) },
  render: () => null,
});
const pageRoot = defineBlock({
  name: "frsPage",
  label: "Page",
  summary: "title",
  fields: {
    title: text(),
    enquiry: { kind: "form" as const, label: "Enquiry" },
    trips: collection({
      type: "frsTrip",
      maxPerPage: 6,
      defaultOrder: { field: "title", dir: "asc" },
    }),
  },
  render: () => null,
});
const footerRoot = defineBlock({
  name: "frsFooter",
  label: "Footer",
  fields: { signup: { kind: "form" as const, label: "Sign-up" } },
  render: () => null,
});
const plainRoot = defineBlock({
  name: "frsPlain",
  label: "Plain",
  fields: { title: text(), enquiry: { kind: "form" as const, label: "Enquiry" } },
  render: () => null,
});

const LOCALES: LocaleConfig = {
  default: "en",
  available: [
    { code: "en", label: "English" },
    { code: "fr", label: "Francais" },
  ],
};

let loadCalls = 0;
const sourceConfig = {
  countries: {
    label: "Countries",
    ttl: 60,
    async load(): Promise<never> {
      loadCalls++;
      throw new Error("a render must never call load");
    },
  },
};

function makeFolio(db?: D1Database) {
  return createFolio<Cloudflare.Env>({
    blocks: [pageRoot, tripRoot, footerRoot, plainRoot],
    types: [
      { name: "frsPage", label: "Page", kind: "page", root: "frsPage", default: true },
      { name: "frsTrip", label: "Trip", kind: "page", root: "frsTrip" },
      { name: "frsPlain", label: "Plain", kind: "page", root: "frsPlain" },
      { name: "frsFooter", label: "Footer", kind: "singleton", root: "frsFooter" },
    ],
    globals: ["frsFooter"],
    bindings: (e) => ({ ...bindings(e), ...(db ? { db } : {}) }),
    basePath: "/folio",
    auth: "open",
    locales: LOCALES,
    route: (p, locale) => `${locale && locale !== "en" ? `/${locale}` : ""}/${p}`,
    forms: { sources: sourceConfig },
  });
}

const doc = (type: string, data: Record<string, unknown>): Doc => ({
  root: "r0",
  bloks: { r0: { uid: "r0", type, parent: null, slot: null, order: "a0", data: data as never } },
});

async function insertStory(
  id: string,
  type: string,
  path: string,
  title: string,
  d: Doc | null,
  titleI18n?: Record<string, string>,
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, title_i18n, updated_at,
                          published_doc, published_at)
     values (?, ?, null, ?, ?, 'a0', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      type,
      path,
      path,
      title,
      titleI18n ? JSON.stringify(titleI18n) : null,
      Date.now(),
      d ? JSON.stringify(d) : null,
      d ? Date.now() : null,
    )
    .run();
}

async function trip(id: string, title: string, fr?: string) {
  const d = doc("frsTrip", { title });
  if (fr) (d.bloks.r0 as { i18n?: unknown }).i18n = { fr: { title: fr } };
  await insertStory(id, "frsTrip", id, title, d, fr ? { fr } : undefined);
}

const CONTENT = { source: "content", settings: { type: "frsTrip" } };
const sourcedField = (optionsFrom: unknown, extra: Record<string, unknown> = {}) => ({
  name: "trip",
  kind: "select",
  label: "Trip",
  optionsFrom,
  ...extra,
});
const UNSOURCED = {
  name: "colour",
  kind: "select",
  label: "Colour",
  options: [{ value: "r", label: "Red" }],
};

async function makeForm(fields: unknown[]): Promise<string> {
  const f = await createForm(env.DB, { label: `Enquiry ${crypto.randomUUID().slice(0, 6)}` });
  await updateForm(env.DB, f.id, { expectedUpdatedAt: f.updatedAt, fields });
  return f.id;
}

async function pageWith(id: string, path: string, formId: string) {
  await insertStory(
    id,
    "frsPlain",
    path,
    "Contact",
    doc("frsPlain", { title: "Contact", enquiry: formId }),
  );
}

async function globalWith(formId: string) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at)
     values ('sng_frsFooter', 'frsFooter', null, 'frsFooter', null, 'a0', 'Footer', ?, ?, ?)`,
  )
    .bind(Date.now(), JSON.stringify(doc("frsFooter", { signup: formId })), Date.now())
    .run();
}

async function loadRow(source: string, options: unknown) {
  await env.DB.prepare(
    `insert into option_lists (brand, source, key, options, digest, loaded_at, attempted_at, failures)
     values ('', ?, ?, ?, 'd', ?, ?, 0)`,
  )
    .bind(source, optionListKey(undefined, ""), JSON.stringify(options), Date.now(), Date.now())
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from stories"),
    env.DB.prepare("delete from forms"),
    env.DB.prepare("delete from option_lists"),
    env.DB.prepare("delete from content_index"),
    env.DB.prepare("delete from content_refs"),
  ]);
  loadCalls = 0;
});

const descriptor = (
  page: { resolution: { forms?: Record<string, ResolvedForm> } } | null,
  id: string,
) => page?.resolution.forms?.[id];

describe("render: a content-sourced question", () => {
  it("lists published documents only, by story id, on a page with no collection", async () => {
    await trip("sty_t_b", "Bali");
    await trip("sty_t_a", "Alps");
    await insertStory("sty_t_draft", "frsTrip", "draft", "Unpublished", null);
    const form = await makeForm([sourcedField(CONTENT)]);
    await pageWith("sty_p1", "p1", form);

    const page = await makeFolio().reader(env).page("p1");
    const field = descriptor(page, form)!.fields[0]!;

    // The plain page has no collection: the early return sat above this once.
    expect(field.options).toEqual([
      { value: "sty_t_a", label: "Alps" },
      { value: "sty_t_b", label: "Bali" },
    ]);
    expect(field.optionsFrom).toEqual({ source: "content", types: ["frsTrip"] });
  });

  it("tags the page with the type and not with the items", async () => {
    await trip("sty_t_a", "Alps");
    const form = await makeForm([sourcedField(CONTENT)]);
    await pageWith("sty_p2", "p2", form);

    const page = await makeFolio().reader(env).page("p2");
    const tags = page!.headers["cache-tag"]!.split(",");
    expect(tags).toContain("type:frsTrip");
    expect(tags).toContain(`form:${form}`);
    expect(tags.filter((t) => t.startsWith("story:"))).toEqual(["story:sty_p2"]);
    expect(page!.headers["cache-control"]).not.toBe(NO_STORE);
  });

  it("materialises a form embedded in a global", async () => {
    await trip("sty_t_a", "Alps");
    const form = await makeForm([sourcedField(CONTENT)]);
    await globalWith(form);
    await insertStory("sty_bare", "frsPlain", "bare", "Bare", doc("frsPlain", { title: "Bare" }));

    const page = await makeFolio().reader(env).page("bare");
    const field = descriptor(page, form)!.fields[0]!;
    expect(field.options).toEqual([{ value: "sty_t_a", label: "Alps" }]);
    expect(field.optionsFrom).toEqual({ source: "content", types: ["frsTrip"] });
    expect(page!.headers["cache-tag"]).toContain("type:frsTrip");
  });

  it("does not ask a required question over an empty type", async () => {
    const form = await makeForm([sourcedField(CONTENT, { required: true })]);
    await pageWith("sty_p3", "p3", form);

    const page = await makeFolio().reader(env).page("p3");
    const field = descriptor(page, form)!.fields[0]!;
    expect(field.showIf).toEqual({ any: [] });
    expect(field.options).toEqual([]);
    // An empty list is an answer, not an outage: cacheable, and not unavailable.
    expect(field.optionsFrom).toEqual({ source: "content", types: ["frsTrip"] });
    expect(page!.headers["cache-control"]).not.toBe(NO_STORE);
  });

  it("keeps a typed extra and lets it win a collision", async () => {
    await trip("sty_t_a", "Alps");
    const form = await makeForm([
      sourcedField(CONTENT, {
        options: [
          { value: "sty_t_a", label: "Alps (editor)" },
          { value: "other", label: "Other" },
        ],
      }),
    ]);
    await pageWith("sty_p4", "p4", form);
    const field = descriptor(await makeFolio().reader(env).page("p4"), form)!.fields[0]!;
    expect(field.options).toEqual([
      { value: "sty_t_a", label: "Alps (editor)" },
      { value: "other", label: "Other" },
    ]);
  });

  it("sorts a French render by French label", async () => {
    await trip("sty_t_1", "Egypt", "Zanzibar");
    await trip("sty_t_2", "Zambia", "Egypte");
    const form = await makeForm([sourcedField(CONTENT)]);
    await pageWith("sty_p5", "p5", form);

    const en = descriptor(await makeFolio().reader(env).page("p5"), form)!.fields[0]!;
    expect(en.options?.map((o) => o.label)).toEqual(["Egypt", "Zambia"]);
    const fr = descriptor(await makeFolio().reader(env).page("p5", { locale: "fr" }), form)!
      .fields[0]!;
    expect(fr.options?.map((o) => o.label)).toEqual(["Egypte", "Zanzibar"]);
  });
});

describe("render: a host-sourced question", () => {
  const HOST = { source: "countries" };
  const countryField = () => sourcedField(HOST, { name: "country", label: "Country" });

  it("compiles unavailable with no row, answers no-store, and never calls load", async () => {
    const form = await makeForm([countryField()]);
    await pageWith("sty_h1", "h1", form);

    const page = await makeFolio().reader(env).page("h1");
    const field = descriptor(page, form)!.fields[0]!;
    expect(field.optionsFrom).toEqual({ source: "countries", unavailable: true });
    expect(field.options).toEqual([]);
    expect(page!.headers["cache-control"]).toBe(NO_STORE);
    expect(loadCalls).toBe(0);
  });

  it("reads the stored row, answers the cache headers, and never calls load", async () => {
    await loadRow("countries", [{ value: "au", label: "Australia" }]);
    const form = await makeForm([countryField()]);
    await pageWith("sty_h2", "h2", form);

    const page = await makeFolio().reader(env).page("h2");
    const field = descriptor(page, form)!.fields[0]!;
    expect(field.options).toEqual([{ value: "au", label: "Australia" }]);
    expect(field.optionsFrom).toEqual({ source: "countries" });
    expect(page!.headers["cache-control"]).not.toBe(NO_STORE);
    expect(page!.headers["cache-tag"]).toContain("source:countries");
    expect(loadCalls).toBe(0);
  });

  it("is no-store when only a form in a global is unavailable", async () => {
    const form = await makeForm([countryField()]);
    await globalWith(form);
    await insertStory("sty_bare2", "frsPlain", "bare2", "Bare", doc("frsPlain", { title: "Bare" }));
    const page = await makeFolio().reader(env).page("bare2");
    expect(page!.headers["cache-control"]).toBe(NO_STORE);
  });

  it("an unregistered source compiles unavailable too", async () => {
    const form = await makeForm([sourcedField({ source: "gone" })]);
    await pageWith("sty_h3", "h3", form);
    const page = await makeFolio().reader(env).page("h3");
    expect(descriptor(page, form)!.fields[0]!.optionsFrom).toEqual({
      source: "gone",
      unavailable: true,
    });
    expect(page!.headers["cache-control"]).toBe(NO_STORE);
  });
});

describe("render: draft preview", () => {
  it("lists published content and a stored row, and writes nothing", async () => {
    await trip("sty_t_a", "Alps");
    await loadRow("countries", [{ value: "au", label: "Australia" }]);
    const form = await makeForm([
      sourcedField(CONTENT),
      sourcedField({ source: "countries" }, { name: "country", label: "Country" }),
    ]);
    const d = doc("frsPlain", { title: "Draft", enquiry: form });
    const count = () =>
      env.DB.prepare("select count(*) as n from option_lists").first<{ n: number }>();
    const before = await count();

    const resolution = await makeFolio().resolve(env, d, { draft: true });
    const fields = resolution.forms![form]!.fields;
    expect(fields[0]!.options).toEqual([{ value: "sty_t_a", label: "Alps" }]);
    expect(fields[1]!.options).toEqual([{ value: "au", label: "Australia" }]);
    expect((await count())!.n).toBe(before!.n);
    expect(loadCalls).toBe(0);
  });
});

describe("render: an unsourced form is untouched", () => {
  it("carries no optionsFrom key on any question", async () => {
    const form = await makeForm([UNSOURCED]);
    await pageWith("sty_u1", "u1", form);
    const field = descriptor(await makeFolio().reader(env).page("u1"), form)!.fields[0]!;
    expect(field).not.toHaveProperty("optionsFrom");
    expect(field.options).toEqual([{ value: "r", label: "Red" }]);
  });
});

/** Sends and receipts, for the two properties only an order can show. */
function spyOn(real: D1Database) {
  const spy = { db: real, prepares: 0, order: [] as string[] };
  const watchStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "bind") {
          return (...a: unknown[]) =>
            watchStatement((value as (...x: unknown[]) => D1PreparedStatement).apply(t, a));
        }
        if (prop !== "first" && prop !== "all" && prop !== "run") return value;
        return async (...a: unknown[]) => {
          spy.order.push("send");
          const out = await (value as (...x: unknown[]) => Promise<unknown>).apply(t, a);
          spy.order.push("recv");
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
            spy.prepares++;
            return watchStatement((value as (...x: unknown[]) => D1PreparedStatement).apply(t, a));
          };
        }
        if (prop === "batch") {
          return async (...a: unknown[]) => {
            spy.order.push("send");
            const out = await (value as (...x: unknown[]) => Promise<unknown>).apply(t, a);
            spy.order.push("recv");
            return out;
          };
        }
        if (prop === "withSession") {
          return (...a: unknown[]) => watch((value as (...x: unknown[]) => object).apply(t, a));
        }
        return value;
      },
    });
  spy.db = watch(real);
  return spy;
}

describe("render: round trips", () => {
  it("an unsourced form costs only the forms read it always did", async () => {
    const form = await makeForm([UNSOURCED]);
    const without = spyOn(env.DB);
    await makeFolio(without.db).resolve(env, doc("frsPlain", { title: "x" }));
    const withForm = spyOn(env.DB);
    await makeFolio(withForm.db).resolve(env, doc("frsPlain", { title: "x", enquiry: form }));
    expect(withForm.prepares - without.prepares).toBe(1);
  });

  it("a sourced form with no collection pays one more round trip, of two statements", async () => {
    await trip("sty_t_a", "Alps");
    const sourced = await makeForm([sourcedField(CONTENT)]);
    const unsourced = await makeForm([UNSOURCED]);
    const a = spyOn(env.DB);
    await makeFolio(a.db).resolve(env, doc("frsPlain", { title: "x", enquiry: sourced }));
    const b = spyOn(env.DB);
    await makeFolio(b.db).resolve(env, doc("frsPlain", { title: "x", enquiry: unsourced }));
    // `runQuery` sends its count and its page together: one trip, two statements.
    expect(a.prepares - b.prepares).toBe(2);
    expect(a.order.slice(-4)).toEqual(["send", "send", "recv", "recv"]);
  });

  it("a content list is sent with the collection query, not after it", async () => {
    await trip("sty_t_a", "Alps");
    const form = await makeForm([sourcedField(CONTENT)]);
    const spy = spyOn(env.DB);
    await makeFolio(spy.db).resolve(env, doc("frsPage", { title: "x", enquiry: form }));
    // Pass four is the collection's two statements and the list's two: all four
    // leave before any answers, so the list adds no round trip to this page.
    expect(spy.order.slice(-8)).toEqual([
      "send",
      "send",
      "send",
      "send",
      "recv",
      "recv",
      "recv",
      "recv",
    ]);
  });
});

describe("GET /forms/resolved", () => {
  const resolved = async (ids: string, query = "") => {
    const res = await makeFolio().handle(
      new Request(`https://example.com/folio/api/forms/resolved?ids=${ids}${query}`),
      env,
      createExecutionContext(),
    );
    return { status: res!.status, json: await res!.json<Record<string, ResolvedForm>>() };
  };

  it("materialises content and host questions, reading rows and calling nothing", async () => {
    await trip("sty_t_a", "Alps");
    await loadRow("countries", [{ value: "au", label: "Australia" }]);
    const form = await makeForm([
      sourcedField(CONTENT),
      sourcedField({ source: "countries" }, { name: "country", label: "Country" }),
    ]);
    const { status, json } = await resolved(form);
    expect(status).toBe(200);
    const fields = json[form]!.fields;
    expect(fields[0]!.options).toEqual([{ value: "sty_t_a", label: "Alps" }]);
    expect(fields[0]!.optionsFrom).toEqual({ source: "content", types: ["frsTrip"] });
    expect(fields[1]!.options).toEqual([{ value: "au", label: "Australia" }]);
    expect(loadCalls).toBe(0);
  });

  it("marks a list that never loaded unavailable, and sorts a French preview by label", async () => {
    await trip("sty_t_1", "Egypt", "Zanzibar");
    await trip("sty_t_2", "Zambia", "Egypte");
    const form = await makeForm([
      sourcedField(CONTENT),
      sourcedField({ source: "countries" }, { name: "country", label: "Country" }),
    ]);
    const { json } = await resolved(form, "&locale=fr");
    expect(json[form]!.fields[0]!.options?.map((o) => o.label)).toEqual(["Egypte", "Zanzibar"]);
    expect(json[form]!.fields[1]!.optionsFrom).toEqual({ source: "countries", unavailable: true });
  });
});
