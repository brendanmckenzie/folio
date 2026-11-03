import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { FormActionAttachment } from "../../src/core/form-actions";
import type { ResolvedForm } from "../../src/core/forms";
import {
  createFolio,
  type FolioBindings,
  type FolioBrand,
  type FolioConfig,
  formAction,
  magicLink,
} from "../../src/server";
import type { Scope } from "../../src/server/auth/roles";
import { createToken } from "../../src/server/auth/tokens";
import type { PurgeCapability } from "../../src/server/cache-purge";

/**
 * Phase 3 of form actions (`docs/specs/content-model/form-actions.md`): the stored
 * attachments, the builder's PATCH, the descriptor's `refusals`, `attention` and the
 * registry's `actions`. Real D1 and workerd; no action is ever run here.
 */

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
});

const page = defineBlock({
  name: "faPage",
  label: "Page",
  fields: { title: text(), enquiry: { kind: "form" as const, label: "Enquiry" } },
  render: () => null,
});

const tripCode = formAction({
  id: "trip-code",
  label: "Check the trip code",
  codes: { unknown_trip: { label: "Unknown trip", message: "We do not recognise that trip." } },
  inputs: { code: { kind: "text", label: "Trip code", required: true } },
  check: () => ({ ok: true }),
});
const jambo = formAction({
  id: "jambo",
  label: "File in Jambo",
  inputs: {
    email: { kind: "email", label: "Email", required: true },
    first: { kind: "text", label: "First name", required: true },
    area: { kind: "text", label: "Area" },
  },
  settings: {
    pipeline: {
      kind: "select",
      label: "Pipeline",
      options: [
        { label: "Sales", value: "sales" },
        { label: "Support", value: "support" },
      ],
      default: "sales",
    },
    listId: { kind: "text", label: "List id" },
  },
  deliver: () => {},
});

const purges: unknown[] = [];
const capability: PurgeCapability = async () => async (options) => {
  purges.push(options);
  return { success: true, errors: [] };
};

const config = {
  blocks: [page],
  types: [{ name: "page", label: "Page", kind: "page", root: "faPage", default: true }],
  bindings,
  basePath: "/folio",
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  logger: { warn: () => {}, error: () => {} },
  locales: {
    default: "en",
    available: [
      { code: "en", label: "English" },
      { code: "fr", label: "Francais" },
    ],
  },
  forms: { actions: [tripCode, jambo] },
  formPurgeCapability: capability,
} satisfies FolioConfig<Cloudflare.Env> & { formPurgeCapability: PurgeCapability };
const folio = createFolio<Cloudflare.Env>(config);

const bearer = async (name: string, scopes: Scope[]) => ({
  authorization: `Bearer ${(await createToken(env.DB, { name, scopes })).token}`,
});
let editor: Record<string, string>;
let publisher: Record<string, string>;

async function call(
  path: string,
  auth: Record<string, string> | null,
  init: { method?: string; body?: unknown } = {},
  app: Pick<typeof folio, "handle"> = folio,
) {
  const ctx = createExecutionContext();
  const res = await app.handle(
    new Request(`https://cms.example/folio${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(auth ?? {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  if (!res) throw new Error(`handle() answered null for ${path}`);
  return res;
}

const FORM = "frm_aaaaaaaaaaaa";
const EMAIL = { name: "email", kind: "email", label: "Email", required: true };
const FIRST = { name: "first_name", kind: "text", label: "First", required: true };
const CODE = { name: "code", kind: "text", label: "Code", required: true };

const insertForm = (id: string, fields: unknown[], actions: unknown[] | string = []) =>
  env.DB.prepare(
    `insert into forms (id, name, label, fields, actions, created_at, updated_at)
     values (?, ?, 'Enquiry', ?, ?, 1000, 1000)`,
  )
    .bind(
      id,
      `f-${id}`,
      JSON.stringify(fields),
      typeof actions === "string" ? actions : JSON.stringify(actions),
    )
    .run();

const stored = async (id = FORM) =>
  (await env.DB.prepare("select actions, fields, version, updated_at from forms where id = ?")
    .bind(id)
    .first<{ actions: string; fields: string; version: number; updated_at: number }>())!;

/** Carries the row's current `updated_at`, so a second save in one test is not a 409. */
const patch = async (body: Record<string, unknown>, auth = editor, id = FORM) =>
  call(`/api/forms/${id}`, auth, {
    method: "PATCH",
    body: { expectedUpdatedAt: (await stored(id)).updated_at, ...body },
  });

const message = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

beforeAll(async () => {
  editor = await bearer("editor", ["content:read", "content:write"]);
  publisher = await bearer("publisher", ["content:read", "content:write", "forms:read"]);
});

beforeEach(async () => {
  purges.length = 0;
  await env.DB.prepare("delete from forms").run();
});

const COMPLETE: FormActionAttachment[] = [
  {
    action: "jambo",
    map: { email: "email", first: "first_name" },
    settings: { pipeline: "sales" },
    delivers: true,
  },
];

describe("who may change actions (decision 8)", () => {
  beforeEach(async () => {
    await insertForm(FORM, [EMAIL, FIRST], COMPLETE);
  });

  it("refuses an editor who changes the actions, and saves nothing", async () => {
    const before = await stored();
    const res = await patch({
      label: "Renamed",
      actions: [{ ...COMPLETE[0], settings: { pipeline: "support" } }],
    });
    expect(res.status).toBe(403);
    expect(await message(res)).toEqual({
      code: "forbidden",
      message: "Changing where responses go needs publisher access",
    });
    expect(await stored()).toEqual(before);
  });

  it("refuses an editor who removes an action or adds one", async () => {
    expect((await patch({ actions: [] })).status).toBe(403);
    expect(
      (await patch({ actions: [...COMPLETE, { action: "trip-code", map: { code: "code" } }] }))
        .status,
    ).toBe(403);
  });

  it("lets a publisher change them, normalised, with delivers recomputed by the server", async () => {
    const res = await patch(
      {
        actions: [
          {
            action: "jambo",
            map: { email: "email", first: "first_name", gone: "nowhere" },
            settings: { pipeline: "support", undeclared: "x" },
            messages: { unknown_trip: "not a code of this action" },
            // A client cannot set it: it is recomputed from the registry.
            delivers: true,
          },
        ],
      },
      publisher,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse((await stored()).actions)).toEqual([
      {
        action: "jambo",
        map: { email: "email", first: "first_name" },
        settings: { pipeline: "support" },
        delivers: true,
      },
    ]);
  });

  it("fills a declared default only into an attachment the save adds", async () => {
    await insertForm("frm_bbbbbbbbbbbb", [CODE], []);
    const res = await patch(
      { actions: [{ action: "jambo", map: { email: "code", first: "code" } }] },
      publisher,
      "frm_bbbbbbbbbbbb",
    );
    // email cannot read a text question, so this is refused: use a compatible form.
    expect(res.status).toBe(400);
    const ok = await patch(
      {
        fields: [EMAIL, FIRST],
        actions: [{ action: "jambo", map: { email: "email", first: "first_name" } }],
      },
      publisher,
      "frm_bbbbbbbbbbbb",
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse((await stored("frm_bbbbbbbbbbbb")).actions)[0].settings).toEqual({
      pipeline: "sales",
    });
  });

  it("treats an unchanged save as unchanged after normalising, and writes the stored value back", async () => {
    // A stored attachment a deploy has left behind: a setting the code no longer
    // declares, and a message for a code the action never had.
    const legacy = [{ ...COMPLETE[0], settings: { pipeline: "sales", retired: "keep me" } }];
    await env.DB.prepare("update forms set actions = ? where id = ?")
      .bind(JSON.stringify(legacy), FORM)
      .run();
    // The editor's builder echoes what it knows: no `retired`, the same everything else.
    const res = await patch({ label: "A new label", actions: COMPLETE });
    expect(res.status).toBe(200);
    const after = await stored();
    expect(JSON.parse(after.actions)).toEqual(legacy);
  });

  it("does not let an echo of an unregistered attachment grant it a delivery", async () => {
    await env.DB.prepare("update forms set actions = ? where id = ?")
      .bind(JSON.stringify([{ action: "retired" }]), FORM)
      .run();
    // Carried through unchanged: fine for an editor.
    expect((await patch({ label: "x", actions: [{ action: "retired" }] })).status).toBe(200);
    // A client-supplied `delivers` on it is not believed: it normalises to the stored
    // attachment, so it is no change and the stored value stays as it was.
    expect(
      (await patch({ label: "y", actions: [{ action: "retired", delivers: true }] })).status,
    ).toBe(200);
    expect(JSON.parse((await stored()).actions)).toEqual([{ action: "retired" }]);
    // And a publisher cannot attach an action the code does not provide.
    const added = await patch({ actions: [{ action: "retired" }, { action: "ghost" }] }, publisher);
    expect(added.status).toBe(400);
    expect((await message(added)).message).toContain("ghost");
  });
});

describe("a save is refused only for a problem it adds (decision 13)", () => {
  it("refuses a save that makes a mapped question optional", async () => {
    await insertForm(FORM, [EMAIL, FIRST], COMPLETE);
    const before = await stored();
    const res = await patch({ fields: [{ ...EMAIL, required: false }, FIRST] });
    expect(res.status).toBe(400);
    expect((await message(res)).message).toContain("File in Jambo");
    expect(
      (await message(await patch({ fields: [{ ...EMAIL, required: false }, FIRST] }))).message,
    ).toContain("not always answered");
    expect(await stored()).toEqual(before);
  });

  it("refuses removing a mapped question, and retyping it to one that does not fit", async () => {
    await insertForm(FORM, [EMAIL, FIRST], COMPLETE);
    expect((await patch({ fields: [FIRST] })).status).toBe(400);
    expect((await patch({ fields: [{ ...EMAIL, kind: "number" }, FIRST] })).status).toBe(400);
  });

  it("refuses a publisher's save that attaches an incomplete action", async () => {
    await insertForm(FORM, [EMAIL, FIRST], []);
    const res = await patch({ actions: [{ action: "jambo", map: { email: "email" } }] }, publisher);
    expect(res.status).toBe(400);
    expect((await message(res)).message).toContain("First name needs a question");
    expect(JSON.parse((await stored()).actions)).toEqual([]);
  });

  describe("an attachment already incomplete", () => {
    const INCOMPLETE = [{ action: "jambo", delivers: true, settings: { pipeline: "sales" } }];
    beforeEach(async () => {
      await insertForm(FORM, [EMAIL, FIRST], INCOMPLETE);
    });

    it("leaves an editor free to rename, close and edit the questions", async () => {
      expect((await patch({ label: "Renamed" })).status).toBe(200);
      expect((await patch({ open: false })).status).toBe(200);
      expect((await patch({ fields: [EMAIL, FIRST, { ...NAMEQ }] })).status).toBe(200);
    });

    it("allows a partial fix: one of two missing inputs mapped", async () => {
      const res = await patch(
        { actions: [{ ...INCOMPLETE[0], map: { email: "email" } }] },
        publisher,
      );
      expect(res.status).toBe(200);
      expect(JSON.parse((await stored()).actions)[0].map).toEqual({ email: "email" });
    });

    it("refuses a save that adds a different problem while leaving the old ones", async () => {
      const res = await patch(
        { actions: [{ ...INCOMPLETE[0], map: { email: "email", first: "missing_q" } }] },
        publisher,
      );
      expect(res.status).toBe(400);
      expect((await message(res)).message).toContain("missing_q");
    });
  });
});

const NAMEQ = { name: "nick", kind: "text", label: "Nickname" };

describe("the descriptor purge (decision 18)", () => {
  const WITH_CHECK = [
    { action: "trip-code", map: { code: "code" }, messages: { unknown_trip: "No such trip." } },
  ];
  beforeEach(async () => {
    await insertForm(FORM, [CODE, EMAIL, FIRST], [...WITH_CHECK, ...COMPLETE]);
  });
  const tag = [{ tags: [`form:${FORM}`] }];

  it("purges form:<id> when a refusal message changes", async () => {
    const res = await patch(
      { actions: [{ ...WITH_CHECK[0], messages: { unknown_trip: "Try again." } }, ...COMPLETE] },
      publisher,
    );
    expect(res.status).toBe(200);
    expect(purges).toEqual(tag);
  });

  it("purges for a translated message too", async () => {
    const res = await patch(
      {
        actions: [
          { ...WITH_CHECK[0], i18n: { fr: { messages: { unknown_trip: "Non." } } } },
          ...COMPLETE,
        ],
      },
      publisher,
    );
    expect(res.status).toBe(200);
    expect(purges).toEqual(tag);
  });

  it("purges nothing for a settings change or a mapping change", async () => {
    const settings = await patch(
      {
        actions: [
          ...WITH_CHECK,
          { ...COMPLETE[0], settings: { pipeline: "support", listId: "L1" } },
        ],
      },
      publisher,
    );
    expect(settings.status).toBe(200);
    const mapping = await patch(
      {
        actions: [
          { ...WITH_CHECK[0], map: { code: "first_name" } },
          { ...COMPLETE[0], settings: { pipeline: "support", listId: "L1" } },
        ],
      },
      publisher,
    );
    expect(mapping.status).toBe(200);
    expect(purges).toEqual([]);
  });

  it("purges when a checking action is attached, since the page gains refusals", async () => {
    await env.DB.prepare("update forms set actions = '[]'").run();
    const res = await patch({ actions: WITH_CHECK }, publisher);
    expect(res.status).toBe(200);
    expect(purges).toEqual(tag);
  });
});

describe("the descriptor", () => {
  const WITH_CHECK = [
    { action: "trip-code", map: { code: "code" }, messages: { unknown_trip: "No such trip." } },
  ];

  it("carries refusals for a checking action through /forms/resolved, and no key without one", async () => {
    await insertForm(FORM, [CODE], WITH_CHECK);
    await insertForm("frm_bbbbbbbbbbbb", [CODE], []);
    // A deliver-only action contributes nothing.
    await insertForm("frm_cccccccccccc", [EMAIL, FIRST], COMPLETE);
    const res = await call(
      `/api/forms/resolved?ids=${FORM},frm_bbbbbbbbbbbb,frm_cccccccccccc`,
      editor,
    );
    const body = (await res.json()) as Record<string, ResolvedForm>;
    expect(body[FORM]?.refusals).toEqual({
      "trip-code.unknown_trip": "No such trip.",
      "trip-code.error": "We could not process that submission. Please try again later.",
    });
    expect(body.frm_bbbbbbbbbbbb).not.toHaveProperty("refusals");
    expect(body.frm_cccccccccccc).not.toHaveProperty("refusals");
  });

  it("reaches a rendered page's resolution, in the render's locale, with the brand's registry", async () => {
    await insertForm(
      FORM,
      [CODE],
      [
        {
          action: "trip-code",
          messages: { unknown_trip: "No such trip." },
          i18n: { fr: { messages: { unknown_trip: "Voyage inconnu." } } },
        },
      ],
    );
    const doc = {
      root: "r0",
      bloks: {
        r0: {
          uid: "r0",
          type: "faPage",
          parent: null,
          slot: null,
          order: "a0",
          data: { title: "T", enquiry: FORM },
        },
      },
    };
    await env.DB.prepare("delete from stories").run();
    await env.DB.prepare(
      `insert into stories (id, type, slug, path, ord, title, updated_at, published_doc, published_at)
       values ('sty_fa', 'page', 'fa', 'fa', 'a0', 'T', 1, ?, 1)`,
    )
      .bind(JSON.stringify(doc))
      .run();
    const source = await folio.reader(env).page("fa");
    expect(source?.resolution.forms?.[FORM]?.refusals?.["trip-code.unknown_trip"]).toBe(
      "No such trip.",
    );
    const french = await folio.reader(env).page("fa", { locale: "fr" });
    expect(french?.resolution.forms?.[FORM]?.refusals?.["trip-code.unknown_trip"]).toBe(
      "Voyage inconnu.",
    );
  });

  it("answers GET /forms/:id with its actions at READ", async () => {
    await insertForm(FORM, [CODE], WITH_CHECK);
    const res = await call(`/api/forms/${FORM}`, await bearer("reader", ["content:read"]));
    expect(((await res.json()) as { actions: unknown }).actions).toEqual(WITH_CHECK);
  });

  it("reads an unreadable column as no attachments rather than failing the form", async () => {
    await insertForm(FORM, [CODE], "{not json");
    const res = await call(`/api/forms/${FORM}`, editor);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { actions: unknown }).actions).toEqual([]);
  });
});

describe("attention (decision 13)", () => {
  type Row = { id: string; attention: boolean };
  const list = async () =>
    Object.fromEntries(
      ((await (await call("/api/forms", editor)).json()) as { rows: Row[] }).rows.map((r) => [
        r.id,
        r,
      ]),
    );

  it("marks a form whose registered attachment has a problem, and only that form", async () => {
    await insertForm("frm_aaaaaaaaaaaa", [EMAIL, FIRST], COMPLETE);
    await insertForm("frm_bbbbbbbbbbbb", [EMAIL, FIRST], [{ action: "jambo", delivers: true }]);
    await insertForm("frm_cccccccccccc", [EMAIL, FIRST], []);
    // Unregistered: the code no longer provides it, which the builder shows, not the list.
    await insertForm("frm_dddddddddddd", [EMAIL, FIRST], [{ action: "retired" }]);
    // A mapped question that has since gone.
    await insertForm("frm_eeeeeeeeeeee", [FIRST], COMPLETE);
    const rows = await list();
    expect(Object.fromEntries(Object.values(rows).map((r) => [r.id, r.attention]))).toEqual({
      frm_aaaaaaaaaaaa: false,
      frm_bbbbbbbbbbbb: true,
      frm_cccccccccccc: false,
      frm_dddddddddddd: false,
      frm_eeeeeeeeeeee: true,
    });
  });
});

describe("GET /forms/registry actions (decision 4)", () => {
  it("answers each action as metadata, with no function and booleans for the phases", async () => {
    const res = await call("/api/forms/registry", await bearer("reader", ["content:read"]));
    const raw = await res.text();
    const { actions } = JSON.parse(raw) as { actions: Array<Record<string, unknown>> };
    expect(actions.map((a) => a.id)).toEqual(["trip-code", "jambo"]);
    expect(Object.keys(actions[0]!).sort()).toEqual(
      ["check", "codes", "deliver", "id", "inputs", "label", "settings"].sort(),
    );
    expect(actions[0]).toMatchObject({ check: true, deliver: false });
    expect(actions[1]).toMatchObject({ check: false, deliver: true });
    expect((actions[0]!.codes as Array<{ code: string }>).map((c) => c.code)).toEqual([
      "unknown_trip",
      "error",
    ]);
    expect(raw).not.toContain("=>");
    expect(raw).not.toContain("function");
  });

  describe("per brand", () => {
    const brand = (actions: unknown[]): FolioBrand<Cloudflare.Env> => ({
      label: "B",
      blocks: [page],
      types: [{ name: "page", label: "Page", kind: "page", root: "faPage", default: true }],
      forms: { actions: actions as never },
    });
    const branded = createFolio<Cloudflare.Env>({
      brands: { aaa: brand([jambo]), tgo: brand([tripCode]), bare: brand([]) },
      sites: { admin: "https://cms.example" },
      bindings,
      basePath: "/folio",
      auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
      logger: { warn: () => {}, error: () => {} },
      assets: {
        admin: "/folio-admin.js",
        brands: {
          aaa: { preview: "/a.js", previewCss: ["/a.css"] },
          tgo: { preview: "/t.js", previewCss: ["/t.css"] },
          bare: { preview: "/b.js", previewCss: ["/b.css"] },
        },
      },
      route: (p) => `/${p}`,
    });
    let admin: Record<string, string>;
    beforeAll(async () => {
      admin = await bearer("platform", ["admin"]);
      await env.DB.prepare(
        `insert or ignore into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
           ('fa-aaa', 'site', 'A', null, 'live', null, 'aaa', 0, 0),
           ('fa-tgo', 'site', 'T', null, 'live', null, 'tgo', 0, 0),
           ('fa-bare', 'site', 'B', null, 'live', null, 'bare', 0, 0)`,
      ).run();
    });

    // Characterisation, not a red-without-the-fix test: an unscoped request to a scoped
    // route is refused by `scopedActor` before the handler, so the handler's own
    // `brandOf` for a fields-only save of a form with attachments is a second fence.
    it("never saves fields of a form with attachments on a request with no brand", async () => {
      await insertForm("frm_bbbbbbbbbbbb", [EMAIL, FIRST], COMPLETE);
      const before = await stored("frm_bbbbbbbbbbbb");
      const res = await call(
        "/api/forms/frm_bbbbbbbbbbbb",
        admin,
        {
          method: "PATCH",
          body: {
            expectedUpdatedAt: before.updated_at,
            fields: [{ ...EMAIL, required: false }, FIRST],
          },
        },
        branded,
      );
      expect(res.status).toBe(400);
      expect(await stored("frm_bbbbbbbbbbbb")).toEqual(before);
    });

    it("answers each brand's own actions, [] for none, and 400 site_required unscoped", async () => {
      const ids = async (site: string) =>
        (
          (await (await call(`/~${site}/api/forms/registry`, admin, {}, branded)).json()) as {
            actions: Array<{ id: string }>;
          }
        ).actions.map((a) => a.id);
      expect(await ids("fa-aaa")).toEqual(["jambo"]);
      expect(await ids("fa-tgo")).toEqual(["trip-code"]);
      expect(await ids("fa-bare")).toEqual([]);
      const none = await call("/api/forms/registry", admin, {}, branded);
      expect(none.status).toBe(400);
      expect((await message(none)).code).toBe("site_required");
    });
  });
});
