import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { LocaleConfig } from "../../src/core/locales";
import { optionListKey } from "../../src/core/option-sources";
import { createFolio, type FolioBindings } from "../../src/server";
import type { PurgeCapability } from "../../src/server/cache-purge";
import { PRIMARY_FIRST } from "../../src/server/db";
import {
  listResponses,
  responseCsv,
  responseById,
  type FolioForms,
} from "../../src/server/form-responses";
import { createForm, formById, LOCALE_INPUT, updateForm } from "../../src/server/forms";

/**
 * Phase 4 of form option sources (`docs/specs/content-model/form-option-sources.md`):
 * `POST {base}/f/:id` validates a sourced question against the list the page was drawn
 * from, maps an outage to `source_unavailable`, and snapshots the labels.
 *
 * Every test here is a threat-model test: the route is the one an anonymous stranger
 * may write through, and a sourced question's list is the thing standing between a
 * crafted POST and a stored story id the form never offered.
 */

const ORIGIN = "https://example.com";

const tripRoot = defineBlock({
  name: "fssTrip",
  label: "Trip",
  summary: "title",
  fields: { title: text({ indexed: true, translatable: true }) },
  render: () => null,
});
const pageRoot = defineBlock({
  name: "fssPage",
  label: "Page",
  fields: { title: text() },
  render: () => null,
});

const LOCALES: LocaleConfig = {
  default: "en",
  available: [
    { code: "en", label: "English" },
    { code: "fr", label: "Francais" },
  ],
};

/** Per-source behaviour, swapped by each test. */
let loadCalls: Record<string, number> = {};
let behaviour: Record<string, () => unknown> = {};

const hostSource = (id: string, ttl = 60) => ({
  label: id,
  ttl,
  async load() {
    loadCalls[id] = (loadCalls[id] ?? 0) + 1;
    return (behaviour[id] ?? (() => []))() as never;
  },
});

/** The replica a session reads before it has seen another request's load. */
const sessions: unknown[] = [];
let lagFirstSession = false;

function lagging(real: D1Database): D1Database {
  const hide = (session: D1DatabaseSession): D1DatabaseSession =>
    new Proxy(session, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!/^\s*select/i.test(sql) || !sql.includes("option_lists")) return stmt;
            const empty = {
              all: async () => ({ results: [], success: true, meta: {} }),
              first: async () => null,
              bind: () => empty,
            };
            return empty as never;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "withSession") {
        return (arg?: string) => {
          const first = sessions.length === 0;
          sessions.push(arg);
          const session = target.withSession(arg);
          return lagFirstSession && first ? hide(session) : session;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const purges: string[][] = [];
const capability: PurgeCapability = async () => async (opts) => {
  if ("tags" in opts && opts.tags) purges.push([...opts.tags]);
  return { success: true, errors: [], messages: [], result: [] } as never;
};

function makeFolio(forms: Partial<FolioForms<Cloudflare.Env>> = {}) {
  const bindings = (e: Cloudflare.Env): FolioBindings => ({
    db: lagging(e.DB),
    story: e.STORY,
    media: e.MEDIA,
    images: e.IMAGES,
  });
  return createFolio<Cloudflare.Env>({
    blocks: [pageRoot, tripRoot],
    types: [
      { name: "fssPage", label: "Page", kind: "page", root: "fssPage", default: true },
      { name: "fssTrip", label: "Trip", kind: "page", root: "fssTrip" },
    ],
    bindings,
    basePath: "/folio",
    auth: "open",
    locales: LOCALES,
    route: (p: string, locale?: string) => `${locale && locale !== "en" ? `/${locale}` : ""}/${p}`,
    logger: { ...console, error: () => {}, warn: () => {} },
    formPurgeCapability: capability,
    forms: {
      sources: { countries: hostSource("countries"), ports: hostSource("ports") },
      ...forms,
    },
  } as never);
}

const folio = makeFolio();

const doc = (type: string, data: Record<string, unknown>): Doc => ({
  root: "r0",
  bloks: { r0: { uid: "r0", type, parent: null, slot: null, order: "a0", data: data as never } },
});

async function trip(id: string, title: string, opts: { published?: boolean; fr?: string } = {}) {
  const published = opts.published ?? true;
  const d = doc("fssTrip", { title });
  if (opts.fr) (d.bloks.r0 as { i18n?: unknown }).i18n = { fr: { title: opts.fr } };
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, title_i18n, updated_at,
                          published_doc, published_at)
     values (?, 'fssTrip', null, ?, ?, 'a0', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      id,
      id,
      title,
      opts.fr ? JSON.stringify({ fr: opts.fr }) : null,
      Date.now(),
      published ? JSON.stringify(d) : null,
      published ? Date.now() : null,
    )
    .run();
}

async function row(
  source: string,
  options: unknown,
  over: { loadedAt?: number; attemptedAt?: number } = {},
) {
  await env.DB.prepare(
    `insert into option_lists (brand, source, key, options, digest, loaded_at, attempted_at, failures)
     values ('', ?, ?, ?, 'd0', ?, ?, 0)`,
  )
    .bind(
      source,
      optionListKey(undefined, ""),
      options === null ? null : JSON.stringify(options),
      options === null ? null : (over.loadedAt ?? Date.now()),
      over.attemptedAt ?? Date.now(),
    )
    .run();
}

const CONTENT = { source: "content", settings: { type: "fssTrip" } };
const HOST = (source: string) => ({ source });
const q = (name: string, optionsFrom: unknown, extra: Record<string, unknown> = {}) => ({
  name,
  kind: "select",
  label: name,
  optionsFrom,
  ...extra,
});

async function makeForm(fields: unknown[]): Promise<string> {
  const f = await createForm(env.DB, { label: `Enquiry ${crypto.randomUUID().slice(0, 6)}` });
  await updateForm(env.DB, f.id, { expectedUpdatedAt: f.updatedAt, fields });
  return f.id;
}

const body = (values: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
  }
  return params.toString();
};

interface Posted {
  res: Response;
  json: Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: a reply read by shape
  settle: () => Promise<void>;
}

async function post(
  id: string,
  values: Record<string, string | string[]>,
  opts: { app?: ReturnType<typeof makeFolio>; headers?: Record<string, string> } = {},
): Promise<Posted> {
  const ctx = createExecutionContext();
  const res = (await (opts.app ?? folio).handle(
    new Request(`${ORIGIN}/folio/f/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...opts.headers,
      },
      body: body(values),
    }),
    env,
    ctx,
  )) as Response;
  return { res, json: await res.json(), settle: () => waitOnExecutionContext(ctx) };
}

const stored = async (formId: string) =>
  (
    await env.DB.prepare("select * from form_responses where form_id = ? order by created_at")
      .bind(formId)
      .all<{ data: string; option_labels: string; locale: string; unasked: string }>()
  ).results;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from stories"),
    env.DB.prepare("delete from forms"),
    env.DB.prepare("delete from form_responses"),
    env.DB.prepare("delete from option_lists"),
    env.DB.prepare("delete from content_index"),
    env.DB.prepare("delete from content_refs"),
  ]);
  loadCalls = {};
  behaviour = {};
  purges.length = 0;
  sessions.length = 0;
  lagFirstSession = false;
});

/* ------------------------------------------------------- content: crafted --- */

describe("a content-sourced question refuses what the page never offered", () => {
  it("accepts a published trip and stores its id with the label it had", async () => {
    await trip("sty_a", "Alps");
    const form = await makeForm([q("trip", CONTENT)]);

    const { res, json } = await post(form, { trip: "sty_a" });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);

    const [saved] = await stored(form);
    expect(JSON.parse(saved!.data)).toEqual({ trip: "sty_a" });
    expect(JSON.parse(saved!.option_labels)).toEqual({ trip: { sty_a: "Alps" } });
  });

  it("answers invalid for a draft, an unpublished, a deleted and an unknown id, storing nothing", async () => {
    await trip("sty_pub", "Alps");
    await trip("sty_draft", "Never published", { published: false });
    await trip("sty_gone", "Withdrawn");
    await env.DB.prepare(
      "update stories set published_doc = null, published_at = null where id = 'sty_gone'",
    ).run();
    // A published document of a *different* type is not a trip either.
    await env.DB.prepare(
      `insert into stories (id, type, slug, path, ord, title, updated_at, published_doc, published_at)
       values ('sty_page', 'fssPage', 'p', 'p', 'a0', 'A page', 1, ?, 1)`,
    )
      .bind(JSON.stringify(doc("fssPage", { title: "A page" })))
      .run();
    const form = await makeForm([q("trip", CONTENT)]);

    for (const id of ["sty_draft", "sty_gone", "stry_doesnotexist", "sty_page", ""]) {
      const { res, json } = await post(form, { trip: id });
      // An empty value on an optional question is blank, not a choice.
      if (id === "") {
        expect(res.status).toBe(200);
        continue;
      }
      expect(res.status, id).toBe(422);
      expect(json.status).toBe("invalid");
      expect(json.fields).toEqual({ trip: "invalid" });
    }
    // Only the blank submission was stored.
    expect((await stored(form)).map((r) => JSON.parse(r.data))).toEqual([{}]);
  });

  it("still refuses a value outside an unsourced question's typed list", async () => {
    await trip("sty_a", "Alps");
    const form = await makeForm([
      q("trip", CONTENT),
      {
        name: "colour",
        kind: "select",
        label: "Colour",
        options: [
          { value: "red", label: "Red" },
          { value: "blue", label: "Blue" },
        ],
      },
    ]);

    const bad = await post(form, { trip: "sty_a", colour: "green" });
    expect(bad.res.status).toBe(422);
    expect(bad.json.fields).toEqual({ colour: "invalid" });
    // A sourced id is not a value of the typed list either.
    const crossed = await post(form, { trip: "sty_a", colour: "sty_a" });
    expect(crossed.json.fields).toEqual({ colour: "invalid" });
    expect((await post(form, { trip: "sty_a", colour: "red" })).res.status).toBe(200);
  });

  it("accepts a typed extra beside the source and refuses the neighbour's value", async () => {
    await trip("sty_a", "Alps");
    const form = await makeForm([
      q("trip", CONTENT, { options: [{ value: "other", label: "Something else" }] }),
    ]);
    expect((await post(form, { trip: "other" })).res.status).toBe(200);
    expect((await post(form, { trip: "sty_a" })).res.status).toBe(200);
    expect((await post(form, { trip: "nope" })).res.status).toBe(422);
    const labels = (await stored(form)).map((r) => JSON.parse(r.option_labels));
    expect(labels).toEqual([{ trip: { other: "Something else" } }, { trip: { sty_a: "Alps" } }]);
  });

  it("refuses a checkboxes answer if any one of its values was not offered", async () => {
    await trip("sty_a", "Alps");
    await trip("sty_b", "Bali");
    await trip("sty_d", "Draft", { published: false });
    const form = await makeForm([q("trips", CONTENT, { kind: "checkboxes" })]);

    expect((await post(form, { trips: ["sty_a", "sty_d"] })).res.status).toBe(422);
    const ok = await post(form, { trips: ["sty_b", "sty_a"] });
    expect(ok.res.status).toBe(200);
    const [saved] = await stored(form);
    expect(JSON.parse(saved!.option_labels)).toEqual({ trips: { sty_a: "Alps", sty_b: "Bali" } });
  });

  it("is not asked, stored and listed in unasked, when the type is empty", async () => {
    const form = await makeForm([q("trip", CONTENT, { required: true })]);
    const { res } = await post(form, { trip: "sty_anything" });
    expect(res.status).toBe(200);
    const [saved] = await stored(form);
    expect(JSON.parse(saved!.data)).toEqual({});
    expect(JSON.parse(saved!.unasked)).toEqual(["trip"]);
  });
});

/* ------------------------------------------------------------ the locale --- */

describe("labels are snapshotted in the submission's locale", () => {
  it("stores the French title when the form was submitted in French", async () => {
    await trip("sty_a", "Alps", { fr: "Les Alpes" });
    await trip("sty_b", "Bali");
    const form = await makeForm([q("trip", CONTENT)]);

    const fr = await post(form, { trip: "sty_a", [LOCALE_INPUT]: "fr" });
    expect(fr.res.status).toBe(200);
    // A different trip: an identical body inside a minute collapses into the first.
    const en = await post(form, { trip: "sty_b" });
    expect(en.res.status).toBe(200);

    const rows = await stored(form);
    const byLocale = Object.fromEntries(rows.map((r) => [r.locale, JSON.parse(r.option_labels)]));
    expect(byLocale.fr).toEqual({ trip: { sty_a: "Les Alpes" } });
    expect(byLocale[""]).toEqual({ trip: { sty_b: "Bali" } });
  });
});

/* ----------------------------------------------- the order of the controls --- */

describe("the lists load behind the abuse controls", () => {
  it("makes no load call for a honeypot hit", async () => {
    const form = await formWithCountries();
    const f = (await formById(env.DB, form))!;
    const { honeypotName } = await import("../../src/core/forms");
    const decoy = honeypotName(
      f.id,
      f.fields.map((x) => x.name),
    );

    const { res } = await post(form, { country: "au", [decoy]: "bot" });
    expect(res.status).toBe(200);
    expect(loadCalls.countries ?? 0).toBe(0);
    expect(await stored(form)).toHaveLength(0);
  });

  it("makes no load call for a rate-limited post", async () => {
    const limited = makeFolio({ ratePerHour: 1 });
    behaviour.countries = () => [{ value: "au", label: "Australia" }];
    const form = await formWithCountries();
    const headers = { "cf-connecting-ip": "203.0.113.7" };

    const first = await post(form, { country: "au" }, { app: limited, headers });
    expect(first.res.status).toBe(200);
    expect(loadCalls.countries).toBe(1);

    // Forget the list: a post that reached the loader would call it again.
    await env.DB.prepare("delete from option_lists").run();
    const second = await post(form, { country: "au" }, { app: limited, headers });
    expect(second.res.status).toBe(429);
    await second.settle();
    expect(loadCalls.countries).toBe(1);
  });

  it("makes no load call for a failed verify", async () => {
    const refusing = makeFolio({ verify: () => false });
    const form = await formWithCountries();
    const { res } = await post(form, { country: "au" }, { app: refusing });
    expect(res.status).toBe(403);
    expect(loadCalls.countries ?? 0).toBe(0);
  });
});

async function formWithCountries(extra: Record<string, unknown> = {}) {
  return makeForm([q("country", HOST("countries"), extra)]);
}

/* ------------------------------------------------- every list, asked or not --- */

describe("every sourced question's list is loaded, asked or not", () => {
  it("loads the list of a question the visitor's answers do not ask", async () => {
    behaviour.countries = () => [{ value: "au", label: "Australia" }];
    behaviour.ports = () => [{ value: "syd", label: "Sydney" }];
    const form = await makeForm([
      q("country", HOST("countries")),
      q("port", HOST("ports"), { showIf: { field: "country", eq: "au" } }),
    ]);

    // country = nz is not offered, so it reads blank and port is not asked; the
    // ports list is still read (and loaded here, never having been).
    const { res } = await post(form, { country: "au" });
    expect(res.status).toBe(200);
    expect(loadCalls).toEqual({ countries: 1, ports: 1 });
  });

  it("accepts a valid pair where one sourced question gates another", async () => {
    await trip("sty_a", "Alps");
    behaviour.countries = () => [
      { value: "au", label: "Australia" },
      { value: "nz", label: "New Zealand" },
    ];
    const form = await makeForm([
      q("country", HOST("countries")),
      q("region", CONTENT, { showIf: { field: "country", eq: "au" } }),
    ]);

    const ok = await post(form, { country: "au", region: "sty_a" });
    expect(ok.res.status).toBe(200);
    const [saved] = await stored(form);
    expect(JSON.parse(saved!.data)).toEqual({ country: "au", region: "sty_a" });
    expect(JSON.parse(saved!.option_labels)).toEqual({
      country: { au: "Australia" },
      region: { sty_a: "Alps" },
    });

    const bad = await post(form, { country: "au", region: "sty_nope" });
    expect(bad.res.status).toBe(422);
    expect(bad.json.fields).toEqual({ region: "invalid" });

    // country = nz: region is not asked, so a region answer is dropped, not refused.
    const dropped = await post(form, { country: "nz", region: "sty_nope" });
    expect(dropped.res.status).toBe(200);
    const rows = await stored(form);
    expect(JSON.parse(rows[rows.length - 1]!.unasked)).toEqual(["region"]);
  });
});

/* ----------------------------------------------------- source_unavailable --- */

describe("source_unavailable", () => {
  beforeEach(() => {
    behaviour.countries = () => {
      throw new Error("vendor is down");
    };
  });

  it("is a 503 for a never-loaded list the visitor answered", async () => {
    const form = await formWithCountries();
    const { res, json } = await post(form, { country: "au" });
    expect(res.status).toBe(503);
    expect(json.status).toBe("error");
    expect(json.error.code).toBe("source_unavailable");
    expect(json.error.message).toBe(
      "This form cannot take submissions right now. Try again later.",
    );
    expect(await stored(form)).toHaveLength(0);

    // The native transport carries it as `folio_status=error`.
    const ctx = createExecutionContext();
    const native = (await folio.handle(
      new Request(`${ORIGIN}/folio/f/${form}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
          "cf-connecting-ip": "203.0.113.1",
        },
        body: body({ country: "au" }),
      }),
      env,
      ctx,
    )) as Response;
    expect(new URL(native.headers.get("location") as string).searchParams.get("folio_status")).toBe(
      "error",
    );
  });

  it("is also what a required, blank question gets", async () => {
    const form = await formWithCountries({ required: true });
    const { res, json } = await post(form, {});
    expect(res.status).toBe(503);
    expect(json.error.code).toBe("source_unavailable");
  });

  it("stores an optional blank, and a question the engine did not ask", async () => {
    const form = await makeForm([
      { name: "name", kind: "text", label: "Name" },
      q("country", HOST("countries")),
      q("port", HOST("countries"), { showIf: { field: "name", eq: "never" } }),
    ]);
    // Optional and left blank.
    expect((await post(form, { name: "Ada" })).res.status).toBe(200);
    // Not asked: an answer posted for it is dropped, with no refusal to map.
    expect((await post(form, { name: "Grace", port: "au" })).res.status).toBe(200);
    expect(await stored(form)).toHaveLength(2);
  });

  it("is a plain invalid for a refusal on a question whose list is available", async () => {
    await trip("sty_a", "Alps");
    const form = await makeForm([q("trip", CONTENT), q("country", HOST("countries"))]);
    // The unavailable one is left blank, so nothing maps to 503.
    const { res, json } = await post(form, { trip: "sty_nope" });
    expect(res.status).toBe(422);
    expect(json.status).toBe("invalid");
  });

  it("is a 503 for a source the brand no longer registers", async () => {
    const form = await makeForm([q("country", { source: "removed-source" })]);
    const { res, json } = await post(form, { country: "au" });
    expect(res.status).toBe(503);
    expect(json.error.code).toBe("source_unavailable");
    expect(loadCalls).toEqual({});
  });

  it("accepts a typed extra on an unavailable question", async () => {
    const form = await formWithCountries({ options: [{ value: "other", label: "Other" }] });
    expect((await post(form, { country: "other" })).res.status).toBe(200);
    expect((await post(form, { country: "au" })).res.status).toBe(503);
  });
});

/* ------------------------------------------------- the last good, and a lease --- */

describe("a host list is validated as stored", () => {
  it("accepts against a stale list without waiting for load, and records a failure after", async () => {
    await row("countries", [{ value: "au", label: "Australia" }], { loadedAt: 0, attemptedAt: 0 });
    behaviour.countries = () => {
      throw new Error("vendor is down");
    };
    const form = await formWithCountries();

    const { res, settle } = await post(form, { country: "au" });
    expect(res.status).toBe(200);
    await settle();

    const saved = await env.DB.prepare(
      "select options, failures, failure from option_lists",
    ).first<{
      options: string;
      failures: number;
      failure: string;
    }>();
    expect(saved).toEqual({
      options: JSON.stringify([{ value: "au", label: "Australia" }]),
      failures: 1,
      failure: "threw",
    });
    expect(JSON.parse((await stored(form))[0]!.option_labels)).toEqual({
      country: { au: "Australia" },
    });
  });

  it("does not wait for a load that never settles", async () => {
    await row("countries", [{ value: "au", label: "Australia" }], { loadedAt: 0, attemptedAt: 0 });
    behaviour.countries = () => new Promise(() => {});
    const form = await formWithCountries();
    const { res } = await post(form, { country: "au" });
    expect(res.status).toBe(200);
  });

  it("still refuses a value the last good list never held", async () => {
    await row("countries", [{ value: "au", label: "Australia" }], { loadedAt: 0, attemptedAt: 0 });
    behaviour.countries = () => {
      throw new Error("vendor is down");
    };
    const form = await formWithCountries();
    const { res, json } = await post(form, { country: "zz" });
    expect(res.status).toBe(422);
    expect(json.fields).toEqual({ country: "invalid" });
  });

  it("calls load once for two submissions inside the lease", async () => {
    await row("countries", [{ value: "au", label: "Australia" }], { loadedAt: 0, attemptedAt: 0 });
    behaviour.countries = () => {
      throw new Error("vendor is down");
    };
    const form = await formWithCountries();

    const a = await post(form, { country: "au" });
    await a.settle();
    const b = await post(form, { country: "au" });
    await b.settle();
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    expect(loadCalls.countries).toBe(1);
  });

  it("awaits a first load, stores the list and purges the source tag", async () => {
    behaviour.countries = () => [{ value: "au", label: "Australia" }];
    const form = await formWithCountries();

    const { res } = await post(form, { country: "au" });
    expect(res.status).toBe(200);
    expect(purges[0]).toEqual(["source:countries"]);
    expect(
      (await env.DB.prepare("select count(*) as n from option_lists").first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it("does not purge for a refresh that loads an identical list", async () => {
    const list = [{ value: "au", label: "Australia" }];
    behaviour.countries = () => list;
    const form = await formWithCountries();
    const first = await post(form, { country: "au" });
    expect(first.res.status).toBe(200);
    purges.length = 0;

    await env.DB.prepare("update option_lists set loaded_at = 0, attempted_at = 0").run();
    const second = await post(form, { country: "au" });
    await second.settle();
    expect(loadCalls.countries).toBe(2);
    expect(purges).toEqual([]);
  });

  it("re-reads on the primary when it lost the lease to a load its replica has not seen", async () => {
    // Another request holds the lease and has loaded the list; this request's
    // session cannot see the row yet.
    await row("countries", [{ value: "au", label: "Australia" }]);
    lagFirstSession = true;
    const form = await formWithCountries();

    const { res } = await post(form, { country: "au" });
    expect(res.status).toBe(200);
    expect(loadCalls.countries ?? 0).toBe(0);
    // The request's session, then one opened on the raw binding at the primary.
    expect(sessions).toEqual([PRIMARY_FIRST, PRIMARY_FIRST]);
  });

  it("is source_unavailable when the primary has no list either", async () => {
    // A lease held on a row that has never held options.
    await row("countries", null);
    const form = await formWithCountries();
    const { res, json } = await post(form, { country: "au" });
    expect(res.status).toBe(503);
    expect(json.error.code).toBe("source_unavailable");
    expect(loadCalls.countries ?? 0).toBe(0);
  });

  it("opens no second session when the list was fresh", async () => {
    await row("countries", [{ value: "au", label: "Australia" }]);
    const form = await formWithCountries();
    expect((await post(form, { country: "au" })).res.status).toBe(200);
    expect(sessions).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- body cap --- */

describe("the body cap budgets a list that does not exist yet", () => {
  it("takes 500 ticked values of 120 characters", async () => {
    const options = Array.from({ length: 500 }, (_, i) => ({
      value: `${String(i).padStart(3, "0")}${"x".repeat(117)}`,
      label: `Country ${i}`,
    }));
    await row("countries", options);
    const form = await makeForm([q("countries", HOST("countries"), { kind: "checkboxes" })]);

    const { res } = await post(form, { countries: options.map((o) => o.value) });
    expect(res.status).toBe(200);
    const [saved] = await stored(form);
    expect(JSON.parse(saved!.data).countries).toHaveLength(500);
    expect(Object.keys(JSON.parse(saved!.option_labels).countries)).toHaveLength(500);
  });
});

/* ------------------------------------------------------------ the responses --- */

describe("responses read their snapshot", () => {
  it("keeps the label after the story is deleted, in the table, the CSV and the search", async () => {
    await trip("sty_a", "Serengeti");
    const id = await makeForm([q("trip", CONTENT)]);
    expect((await post(id, { trip: "sty_a" })).res.status).toBe(200);
    await env.DB.prepare("delete from stories where id = 'sty_a'").run();
    const form = (await formById(env.DB, id))!;

    const page = await listResponses(env.DB, id, {});
    expect(page.rows[0]!.optionLabels).toEqual({ trip: { sty_a: "Serengeti" } });
    expect(page.rows[0]!.data).toEqual({ trip: "sty_a" });
    expect((await responseById(env.DB, id, page.rows[0]!.id))!.optionLabels).toEqual({
      trip: { sty_a: "Serengeti" },
    });

    // A search for the title finds a response that stored only the id.
    expect((await listResponses(env.DB, id, { filter: { q: "Serengeti" } })).rows).toHaveLength(1);
    expect((await listResponses(env.DB, id, { filter: { q: "Kilimanjaro" } })).rows).toHaveLength(
      0,
    );

    const csv = await new Response((await responseCsv(env.DB, form)).body).text();
    const [header, line] = csv.replace(/^﻿/, "").split("\r\n");
    expect(header!.split(",").slice(-2)).toEqual(["trip", "trip:value"]);
    expect(line!.split(",").slice(-2)).toEqual(["Serengeti", "sty_a"]);
  });

  it("screens a stored snapshot on the way out", async () => {
    const id = await makeForm([q("trip", CONTENT)]);
    await env.DB.prepare(
      `insert into form_responses (id, form_id, version, created_at, data, locale, page, body_hash, files, unasked, option_labels)
       values ('res_aaaaaaaaaaaa', ?, 1, 1, '{"trip":"sty_a"}', '', '', 'h', '[]', '[]', ?)`,
    )
      .bind(
        id,
        JSON.stringify({
          trip: { sty_a: "Alps", sty_b: 5, sty_c: "bad\u0000label", sty_d: "  " },
          "Not A Name": { x: "y" },
          other: "not an object",
        }),
      )
      .run();
    const [r] = (await listResponses(env.DB, id, {})).rows;
    expect(r!.optionLabels).toEqual({ trip: { sty_a: "Alps" } });
  });

  it("reads {} for a response written before the column and for malformed text", async () => {
    const id = await makeForm([q("trip", CONTENT)]);
    await env.DB.prepare(
      `insert into form_responses (id, form_id, version, created_at, data, locale, page, body_hash, files, unasked, option_labels)
       values ('res_bbbbbbbbbbbb', ?, 1, 1, '{}', '', '', 'h', '[]', '[]', 'not json')`,
    )
      .bind(id)
      .run();
    expect((await listResponses(env.DB, id, {})).rows[0]!.optionLabels).toEqual({});
  });

  it("de-fangs a label that begins with a formula character", async () => {
    const id = await makeForm([q("trip", CONTENT)]);
    await env.DB.prepare(
      `insert into form_responses (id, form_id, version, created_at, data, locale, page, body_hash, files, unasked, option_labels)
       values ('res_cccccccccccc', ?, 1, 1, '{"trip":"sty_x"}', '', '', 'h', '[]', '[]', ?)`,
    )
      .bind(id, JSON.stringify({ trip: { sty_x: '=HYPERLINK("http://evil")' } }))
      .run();
    const form = (await formById(env.DB, id))!;
    const csv = await new Response((await responseCsv(env.DB, form)).body).text();
    const line = csv.replace(/^﻿/, "").split("\r\n")[1]!;
    expect(line).toContain(`"'=HYPERLINK(""http://evil"")",sty_x`);
  });
});
