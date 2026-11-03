import { describe, expect, it } from "vitest";
import type { FormActionAttachment, FormActionInfo } from "../../../src/core/form-actions";
import { FILE_ACCEPT, type FormField } from "../../../src/core/forms";
import type { LocaleContext } from "../../../src/core/locales";
import { formState } from "../../../src/core/form-logic";
import {
  compileForm,
  type Form,
  formById,
  LOCALE_INPUT,
  materialiseForm,
  PAGE_INPUT,
} from "../../../src/server/forms";
import { FormPatchBody, parseOrThrow } from "../../../src/server/validate";

/**
 * `compileForm` — the descriptor a host's `render` is handed
 * (`docs/specs/content-model/forms.md` architecture decision 4), which is pure
 * over a row and therefore tested here rather than against D1.
 *
 * Three of these are invariants nothing else can see:
 *
 *  - **`open` is `isOpen`, never `form.open`.** The switch is half the answer.
 *    A form whose `closesAt` has passed is closed, and the submit route will say
 *    so whatever the cached markup claimed (decision 14) — deriving it twice is
 *    how the page and the endpoint come to disagree, and only the clock case
 *    makes the difference visible.
 *  - **The descriptor is a projection, not a view of the row.** It travels to a
 *    visitor's browser, so nothing server-side may ride along: not `updatedAt`
 *    (the concurrency token), not `closesAt`, not the authoring `i18n` maps, and
 *    not whatever a later column adds. The exact key set is asserted, which is
 *    what turns a `{ ...form }` spread into a red test rather than a leak.
 *  - **The action names the id.** A slug in it would break every cached page for
 *    the whole week-long TTL the moment somebody renamed a form (decision 3).
 */

const BASE = "/folio";

const NAME: FormField = { name: "full_name", kind: "text", label: "Your name" };
const EMAIL: FormField = { name: "email", kind: "email", label: "Email", required: true };

function makeForm(over: Partial<Form> = {}): Form {
  return {
    id: "frm_0123456789ab",
    name: "contact",
    label: "Contact us",
    fields: [NAME, EMAIL],
    layout: {},
    actions: [],
    version: 3,
    open: true,
    closesAt: null,
    closedMessage: "This form has closed.",
    successMessage: "Thanks, we will be in touch.",
    submitLabel: "Send",
    redirectTo: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...over,
  };
}

describe("compileForm", () => {
  it("builds the action from the base path and the id, never the slug", () => {
    const form = makeForm();
    expect(compileForm(form, { base: BASE }).action).toBe(`${BASE}/f/${form.id}`);

    // A rename moves `name` and nothing else: every page cached with the old
    // markup still posts to a form that exists.
    const renamed = compileForm(makeForm({ name: "contact-us" }), { base: BASE });
    expect(renamed.action).toBe(`${BASE}/f/${form.id}`);
    expect(renamed.name).toBe("contact-us");

    // Mounted elsewhere, and nothing stored had to change.
    expect(compileForm(form, { base: "/cms" }).action).toBe(`/cms/f/${form.id}`);
  });

  it("answers open from the switch and the clock together, not from the switch alone", () => {
    const now = 1_700_000_000_000;

    expect(compileForm(makeForm(), { base: BASE, now }).open).toBe(true);
    expect(compileForm(makeForm({ open: false }), { base: BASE, now }).open).toBe(false);

    // The case the switch alone gets wrong: still on, and past its closing time.
    const lapsed = makeForm({ open: true, closesAt: now - 1 });
    expect(compileForm(lapsed, { base: BASE, now }).open).toBe(false);

    const pending = makeForm({ open: true, closesAt: now + 60_000 });
    expect(compileForm(pending, { base: BASE, now }).open).toBe(true);

    // A closed form still compiles its questions: `open` is what a host branches
    // on, and `closedMessage` is what it shows instead.
    const closed = compileForm(lapsed, { base: BASE, now });
    expect(closed.fields).toHaveLength(2);
    expect(closed.closedMessage).toBe("This form has closed.");
  });

  it("is multipart only when a question takes a file", () => {
    expect(compileForm(makeForm(), { base: BASE }).enctype).toBe(
      "application/x-www-form-urlencoded",
    );

    // Getting this wrong submits the string `[object File]` and raises no error
    // anywhere, which is why it is on the descriptor rather than left to a host.
    const withFile = makeForm({
      fields: [NAME, { name: "cv", kind: "file", label: "CV", accept: "documents" }],
    });
    expect(compileForm(withFile, { base: BASE }).enctype).toBe("multipart/form-data");
  });

  it("carries `_folio_page` only when the render knows its page", () => {
    expect(compileForm(makeForm(), { base: BASE }).hidden).toEqual([]);
    expect(compileForm(makeForm(), { base: BASE, page: "/about/contact" }).hidden).toEqual([
      { name: PAGE_INPUT, value: "/about/contact" },
    ]);
  });

  it("carries `_folio_locale` only for a non-source render", () => {
    // A single-locale site's descriptor is byte-identical to the one it had
    // before this input existed — `localeContext` answers undefined for the
    // source locale, so there is nothing to emit and nothing to submit.
    expect(compileForm(makeForm(), { base: BASE, page: "/contact" }).hidden).toEqual([
      { name: PAGE_INPUT, value: "/contact" },
    ]);

    // Without it `form_responses.locale` could only ever be `''`, and decision 12
    // says a response records which language it was submitted in.
    const locale: LocaleContext = { code: "fr-CA", fallbacks: ["fr"] };
    expect(compileForm(makeForm(), { base: BASE, page: "/contact", locale }).hidden).toEqual([
      { name: PAGE_INPUT, value: "/contact" },
      { name: LOCALE_INPUT, value: "fr-CA" },
    ]);
  });

  it("names a honeypot that is stable per form and avoids its own field slugs", () => {
    const form = makeForm();
    const first = compileForm(form, { base: BASE }).honeypot;
    // Stable: a page cached for a week and the live route must agree on which
    // input is the decoy.
    expect(compileForm(form, { base: BASE, now: 1 }).honeypot).toBe(first);
    expect(form.fields.map((f) => f.name)).not.toContain(first);

    const clashing = makeForm({
      fields: [{ name: first, kind: "text", label: "Deliberately the decoy" }],
    });
    expect(compileForm(clashing, { base: BASE }).honeypot).not.toBe(first);
  });

  it("resolves every visitor-facing string through the locale chain", () => {
    const field: FormField = {
      name: "reason",
      kind: "select",
      label: "Reason",
      help: "Pick one",
      placeholder: "Choose…",
      options: [
        { value: "sales", label: "Sales" },
        { value: "support", label: "Support" },
      ],
      i18n: {
        fr: {
          label: "Motif",
          help: "Choisissez-en un",
          options: { sales: "Ventes" },
        },
        "fr-CA": { placeholder: "Choisissez…" },
      },
    };
    const locale: LocaleContext = { code: "fr-CA", fallbacks: ["fr"] };
    const [compiled] = compileForm(makeForm({ fields: [field] }), { base: BASE, locale }).fields;

    // The active locale wins, then its fallback, then the source — `fieldValue`'s
    // rule, so an untranslated string is a fallback rather than a hole.
    expect(compiled?.placeholder).toBe("Choisissez…");
    expect(compiled?.label).toBe("Motif");
    expect(compiled?.help).toBe("Choisissez-en un");
    expect(compiled?.options).toEqual([
      { value: "sales", label: "Ventes" },
      { value: "support", label: "Support" },
    ]);

    // No locale at all is the source locale, byte for byte.
    const source = compileForm(makeForm({ fields: [field] }), { base: BASE }).fields[0];
    expect(source?.label).toBe("Reason");
    expect(source?.options?.[0]).toEqual({ value: "sales", label: "Sales" });
  });

  it("expands a file question into the content types its accept stands for", () => {
    const form = makeForm({
      fields: [{ name: "cv", kind: "file", label: "CV", accept: "images", maxBytes: 1024 }],
    });
    const [compiled] = compileForm(form, { base: BASE }).fields;
    // The stored token is an editor's vocabulary; a host puts this on `accept`.
    expect(compiled?.accept).toEqual(FILE_ACCEPT.images);
    expect(compiled?.maxBytes).toBe(1024);
  });

  it("computes `row` from `rowsOf` and defaults `grow` to 1, once per field", () => {
    // Name: [First][Middle][Last] — a whole row, joined by `beside`.
    const form = makeForm({
      fields: [
        { name: "first", kind: "text", label: "First" },
        { name: "middle", kind: "text", label: "Middle", beside: true },
        { name: "last", kind: "text", label: "Last", beside: true, grow: 2 },
      ],
    });
    const { fields } = compileForm(form, { base: BASE });
    expect(fields.map((f) => f.row)).toEqual([0, 0, 0]);
    expect(fields.map((f) => f.grow)).toEqual([1, 1, 2]);
  });

  it("carries nothing a visitor should not see", () => {
    const form = makeForm({
      fields: [
        { ...NAME, i18n: { fr: { label: "Votre nom" } } },
        { name: "source", kind: "hidden", label: "Source", value: "newsletter" },
      ],
      closesAt: Date.now() + 60_000,
    });
    const descriptor = compileForm(form, { base: BASE, page: "/contact" });

    // The exact set. A `{ ...form }` spread — the tidy-up this test exists to
    // catch — would put `updatedAt`, `closesAt` and `createdAt` on a page.
    expect(Object.keys(descriptor).sort()).toEqual([
      "action",
      "closedMessage",
      "enctype",
      "fields",
      "hidden",
      "honeypot",
      "id",
      "method",
      "name",
      "open",
      "redirectTo",
      "sections",
      "submitLabel",
      "successMessage",
      "version",
    ]);

    // And per question: the authoring `i18n` map is resolved away, not shipped,
    // and `row`/`grow` are always present — layout, on every question, whether
    // or not it ever sets `beside` or `grow` itself.
    expect(Object.keys(descriptor.fields[0] ?? {}).sort()).toEqual([
      "grow",
      "kind",
      "label",
      "name",
      "required",
      "row",
    ]);
    expect(descriptor.fields[1]).toEqual({
      name: "source",
      kind: "hidden",
      label: "Source",
      required: false,
      row: 0,
      grow: 1,
      value: "newsletter",
    });
  });
});

describe("compileForm: logic (spec 35)", () => {
  const heard: FormField = {
    name: "heard",
    kind: "radio",
    label: "Heard",
    options: [
      { value: "a", label: "A" },
      { value: "other", label: "Other" },
    ],
  };
  const showIf = { field: "heard", eq: "other" } as const;

  it("emits the logic keys only when set, and always a sections array", () => {
    const plain = compileForm(makeForm(), { base: BASE });
    expect(plain.sections).toEqual([]);
    expect(Object.keys(plain.fields[0] ?? {}).sort()).toEqual([
      "grow",
      "kind",
      "label",
      "name",
      "required",
      "row",
    ]);

    const full: FormField = {
      name: "more",
      kind: "text",
      label: "More",
      section: "extra",
      showIf,
      requireIf: { field: "heard", isSet: true },
      hold: true,
      prefill: "query",
    };
    const compiled = compileForm(
      makeForm({
        fields: [heard, full],
        layout: { sections: [{ name: "extra", label: "Extra" }] },
      }),
      { base: BASE },
    );
    expect(Object.keys(compiled.fields[1] ?? {}).sort()).toEqual(
      [
        "grow",
        "hold",
        "kind",
        "label",
        "name",
        "prefill",
        "requireIf",
        "required",
        "row",
        "section",
        "showIf",
      ].sort(),
    );
  });

  describe("required is 'required unconditionally' (decision 6)", () => {
    const compiledOf = (field: FormField, layout: Form["layout"] = {}) =>
      compileForm(makeForm({ fields: [heard, field], layout }), { base: BASE }).fields[1];

    it("a plain required question compiles exactly as before", () => {
      const f = compiledOf({ name: "q", kind: "text", label: "Q", required: true });
      expect(f?.required).toBe(true);
      expect(f?.requireIf).toBeUndefined();
    });

    it("required with its own showIf compiles to false plus an always-true requireIf", () => {
      const f = compiledOf({ name: "q", kind: "text", label: "Q", required: true, showIf });
      expect(f?.required).toBe(false);
      expect(f?.requireIf).toEqual({ all: [] });
      expect(f?.showIf).toEqual(showIf);
    });

    it("required inside a conditional section compiles the same way", () => {
      const f = compiledOf(
        { name: "q", kind: "text", label: "Q", required: true, section: "s" },
        { sections: [{ name: "s", label: "S", showIf }] },
      );
      expect(f?.required).toBe(false);
      expect(f?.requireIf).toEqual({ all: [] });
    });

    it("required inside an unconditional section stays required", () => {
      const f = compiledOf(
        { name: "q", kind: "text", label: "Q", required: true, section: "s" },
        { sections: [{ name: "s", label: "S" }] },
      );
      expect(f?.required).toBe(true);
    });

    it("a requireIf alone keeps its own condition and is not required", () => {
      const requireIf = { field: "heard", isSet: true } as const;
      const f = compiledOf({ name: "q", kind: "text", label: "Q", requireIf });
      expect(f?.required).toBe(false);
      expect(f?.requireIf).toEqual(requireIf);
    });

    it("the engine reads the same answers off the stored row and the descriptor", () => {
      const fields: FormField[] = [
        heard,
        { name: "q", kind: "text", label: "Q", required: true, showIf },
        { name: "r", kind: "text", label: "R", requireIf: { field: "heard", eq: "a" } },
      ];
      const form = makeForm({ fields });
      const compiled = compileForm(form, { base: BASE });
      for (const answers of [{}, { heard: "a" }, { heard: "other" }, { heard: "other", q: "x" }]) {
        const stored = formState({ fields: form.fields, sections: [] }, answers);
        const seen = formState(compiled, answers);
        expect([...seen.asked]).toEqual([...stored.asked]);
        expect([...seen.required]).toEqual([...stored.required]);
      }
    });
  });

  it("ships sections with label and help through the locale chain, and never i18n", () => {
    const layout: Form["layout"] = {
      sections: [
        {
          name: "s",
          label: "Postal",
          help: "Where we write",
          showIf,
          i18n: { fr: { label: "Adresse" } },
        },
      ],
    };
    const fr: LocaleContext = { code: "fr", fallbacks: ["en"] };
    const compiled = compileForm(makeForm({ fields: [heard], layout }), { base: BASE, locale: fr });
    expect(compiled.sections).toEqual([
      { name: "s", label: "Adresse", help: "Where we write", showIf },
    ]);
    const source = compileForm(makeForm({ fields: [heard], layout }), { base: BASE });
    expect(source.sections[0]?.label).toBe("Postal");
  });
});

describe("FormPatchBody keeps every FormField key", () => {
  // Typed `Required<FormField>`: adding a key to `FormField` fails typecheck here
  // until the fixture sets it, which is what makes this a guard against
  // `v.object` stripping a new key without anybody noticing.
  const everything: Required<FormField> = {
    name: "q",
    kind: "text",
    label: "Q",
    help: "h",
    placeholder: "p",
    required: true,
    max: 10,
    min: 1,
    pattern: "a+",
    options: [{ value: "a", label: "A" }],
    accept: "documents",
    maxBytes: 100,
    value: "v",
    text: "t",
    beside: true,
    grow: 2,
    showIf: { field: "heard", eq: "other" },
    requireIf: { field: "heard", isSet: true },
    section: "s",
    hold: true,
    prefill: "query",
    optionsFrom: { source: "countries", settings: { region: "oceania", limit: 5, all: false } },
    i18n: { fr: { label: "Q" } },
  };

  it("survives parseOrThrow unstripped", () => {
    const parsed = parseOrThrow(
      FormPatchBody,
      { expectedUpdatedAt: 1, fields: [everything] },
      "body",
    );
    expect(parsed.fields?.[0]).toEqual(everything);
  });

  it("refuses an optionsFrom that is not a bounded plain object", () => {
    const patch = (optionsFrom: unknown) =>
      parseOrThrow(
        FormPatchBody,
        { expectedUpdatedAt: 1, fields: [{ ...everything, optionsFrom }] },
        "body",
      );
    expect(() => patch({ source: "" })).toThrow();
    expect(() => patch({ source: "x".repeat(49) })).toThrow();
    expect(() => patch({ source: "a", settings: [] })).toThrow();
    expect(() => patch({ source: "a", settings: { big: "x".repeat(4100) } })).toThrow();
    expect(() => patch("countries")).toThrow();
  });

  it("refuses a malformed condition and a malformed layout before anything is parsed", () => {
    const patch = (over: Record<string, unknown>) =>
      parseOrThrow(FormPatchBody, { expectedUpdatedAt: 1, ...over }, "body");
    expect(() => patch({ fields: [{ ...everything, showIf: { field: "x" } }] })).toThrow();
    expect(() => patch({ fields: [{ ...everything, hold: false }] })).toThrow();
    expect(() => patch({ fields: [{ ...everything, prefill: "body" }] })).toThrow();
    expect(() => patch({ layout: { sections: [{ name: "Bad Name", label: "x" }] } })).toThrow();
    expect(
      patch({ layout: { sections: [{ name: "s", label: "S", showIf: { field: "a", eq: 1 } }] } })
        .layout,
    ).toEqual({ sections: [{ name: "s", label: "S", showIf: { field: "a", eq: 1 } }] });
  });
});

describe("formById: a question this build cannot read costs that question (spec 37 decision 19)", () => {
  const rowWith = (fields: unknown) => ({
    id: "frm_0123456789ab",
    name: "contact",
    label: "Contact",
    fields: typeof fields === "string" ? fields : JSON.stringify(fields),
    layout: "{}",
    actions: "[]",
    version: 1,
    open: 1,
    closes_at: null,
    closedMessage: "",
    successMessage: "",
    submitLabel: "",
    redirectTo: null,
    createdAt: 0,
    updatedAt: 0,
  });
  const fakeDb = (row: unknown) =>
    ({
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
      batch: async () => [],
    }) as never;
  const logger = () => {
    const errors: string[] = [];
    return {
      errors,
      log: { error: (m: string) => errors.push(m), warn() {}, info() {}, debug() {} } as never,
    };
  };

  it("keeps the rest of the form and logs the one dropped", async () => {
    const { errors, log } = logger();
    const form = await formById(
      fakeDb(rowWith([NAME, { name: "trip", kind: "select", label: "Trip" }, EMAIL])),
      "frm_0123456789ab",
      log,
    );
    expect(form?.fields.map((f) => f.name)).toEqual(["full_name", "email"]);
    expect(errors).toEqual(["folio: form frm_0123456789ab question trip unreadable"]);
  });

  it("still answers no questions for a column that is not JSON at all", async () => {
    const { errors, log } = logger();
    const form = await formById(fakeDb(rowWith("{nope")), "frm_0123456789ab", log);
    expect(form?.fields).toEqual([]);
    expect(errors).toEqual(["folio: form frm_0123456789ab has unreadable fields"]);
  });
});

describe("materialiseForm and a sourced question", () => {
  const sourced: FormField = {
    name: "trip",
    kind: "select",
    label: "Trip",
    optionsFrom: { source: "content", settings: { type: "trip" } },
  };
  const answer = (options: { value: string; label: string }[] | null) =>
    new Map([
      [
        "trip",
        {
          options,
          resolved: {
            source: "content",
            types: ["trip"],
            ...(options === null ? { unavailable: true as const } : {}),
          },
        },
      ],
    ]);

  it("compiles the list and the source onto the descriptor", () => {
    const { form, sources } = materialiseForm(
      makeForm({ fields: [sourced] }),
      answer([{ value: "sty_1", label: "Alps" }]),
    );
    const field = compileForm(form, { base: BASE, sources }).fields[0]!;
    expect(field.options).toEqual([{ value: "sty_1", label: "Alps" }]);
    expect(field.optionsFrom).toEqual({ source: "content", types: ["trip"] });
  });

  it("compiles a sourced question nobody resolved as unavailable, never as an empty list", () => {
    const field = compileForm(makeForm({ fields: [sourced] }), { base: BASE }).fields[0]!;
    expect(field.optionsFrom).toEqual({ source: "content", unavailable: true });
  });

  it("leaves an unsourced form byte-identical", () => {
    const form = makeForm({ fields: [NAME] });
    expect(materialiseForm(form, undefined).form).toBe(form);
    expect(compileForm(form, { base: BASE }).fields[0]).not.toHaveProperty("optionsFrom");
  });

  it("does not ask an empty content question with no extras, and asks one with extras", () => {
    expect(
      materialiseForm(makeForm({ fields: [sourced] }), answer([])).form.fields[0]!.showIf,
    ).toEqual({ any: [] });
    const withExtra = { ...sourced, options: [{ value: "x", label: "Other" }] };
    expect(
      materialiseForm(makeForm({ fields: [withExtra] }), answer([])).form.fields[0]!.showIf,
    ).toBeUndefined();
  });

  it("re-sorts a title-ordered content list by the render's locale, and leaves other orders", () => {
    const list = [
      { value: "a", label: "Zanzibar" },
      { value: "b", label: "Egypte" },
    ];
    const labels = (f: FormField, collate: string) =>
      materialiseForm(
        makeForm({ fields: [f] }),
        answer(list),
        collate,
      ).form.fields[0]!.options?.map((o) => o.label);
    expect(labels(sourced, "fr")).toEqual(["Egypte", "Zanzibar"]);
    const dated = {
      ...sourced,
      optionsFrom: {
        source: "content",
        settings: { type: "trip", order: { field: "published", dir: "asc" } },
      },
    };
    expect(labels(dated, "fr")).toEqual(["Zanzibar", "Egypte"]);
  });
});

describe("compileForm: refusals (form-actions.md decision 3)", () => {
  const check: FormActionInfo = {
    id: "trip-code",
    label: "Check the trip code",
    inputs: [],
    settings: {},
    codes: [
      { code: "unknown_trip", label: "Unknown", message: "We do not recognise that trip." },
      { code: "error", label: "Could not process", message: "Could not process." },
    ],
    check: true,
    deliver: false,
  };
  const deliverOnly: FormActionInfo = {
    ...check,
    id: "jambo",
    codes: [],
    check: false,
    deliver: true,
  };
  const infos = new Map([check, deliverOnly].map((info) => [info.id, info]));
  const attached: FormActionAttachment[] = [
    { action: "trip-code", messages: { unknown_trip: "No such trip." } },
    { action: "jambo", delivers: true },
  ];

  const BASE_KEYS = [
    "action",
    "closedMessage",
    "enctype",
    "fields",
    "hidden",
    "honeypot",
    "id",
    "method",
    "name",
    "open",
    "redirectTo",
    "sections",
    "submitLabel",
    "successMessage",
    "version",
  ];

  it("adds exactly one key to the pinned set, and only for a checking action", () => {
    const plain = compileForm(makeForm(), { base: BASE, page: "/contact" });
    expect(Object.keys(plain).sort()).toEqual(BASE_KEYS);

    // Attachments with no registry to read them against, a registry with none attached,
    // and a delivering attachment alone: all byte-identical to the plain descriptor.
    const form = makeForm({ actions: attached });
    expect(Object.keys(compileForm(form, { base: BASE }))).not.toContain("refusals");
    expect(Object.keys(compileForm(makeForm(), { base: BASE, actions: infos }))).not.toContain(
      "refusals",
    );
    expect(
      Object.keys(
        compileForm(makeForm({ actions: [attached[1]!] }), { base: BASE, actions: infos }),
      ),
    ).not.toContain("refusals");

    const checked = compileForm(form, { base: BASE, page: "/contact", actions: infos });
    expect(Object.keys(checked).sort()).toEqual([...BASE_KEYS, "refusals"].sort());
    expect(checked.refusals).toEqual({
      "trip-code.unknown_trip": "No such trip.",
      "trip-code.error": "Could not process.",
    });
  });

  it("resolves the editor's text through the locale chain, then the declared message", () => {
    const fr: LocaleContext = { code: "fr", fallbacks: [] };
    const form = makeForm({
      actions: [
        {
          action: "trip-code",
          messages: { unknown_trip: "No such trip." },
          i18n: { fr: { messages: { unknown_trip: "Voyage inconnu." } } },
        },
      ],
    });
    expect(compileForm(form, { base: BASE, actions: infos, locale: fr }).refusals).toEqual({
      "trip-code.unknown_trip": "Voyage inconnu.",
      "trip-code.error": "Could not process.",
    });
    expect(
      compileForm(makeForm({ actions: [{ action: "trip-code" }] }), { base: BASE, actions: infos })
        .refusals?.["trip-code.unknown_trip"],
    ).toBe("We do not recognise that trip.");
  });
});

describe("FormPatchBody keeps every attachment key", () => {
  const everything: Required<FormActionAttachment> = {
    action: "jambo",
    map: { email: "email" },
    settings: { pipeline: "sales", limit: 3, on: true },
    messages: { unknown_trip: "No." },
    i18n: { fr: { messages: { unknown_trip: "Non." } } },
    delivers: true,
  };

  it("survives parseOrThrow unstripped, newlines in a setting included", () => {
    const parsed = parseOrThrow(
      FormPatchBody,
      { expectedUpdatedAt: 1, actions: [everything] },
      "body",
    );
    expect(parsed.actions?.[0]).toEqual(everything);
    const lines = { ...everything, settings: { to: "a@b.c\nd@e.f " } };
    expect(
      parseOrThrow(FormPatchBody, { expectedUpdatedAt: 1, actions: [lines] }, "body").actions?.[0]
        ?.settings,
    ).toEqual({ to: "a@b.c\nd@e.f " });
  });

  it("refuses more than eight attachments and a settings value of the wrong type", () => {
    const patch = (actions: unknown) =>
      parseOrThrow(FormPatchBody, { expectedUpdatedAt: 1, actions }, "body");
    expect(() => patch(Array.from({ length: 9 }, () => ({ action: "a" })))).toThrow();
    expect(() => patch([{ action: "a", settings: { x: null } }])).toThrow();
    expect(() => patch([{ action: "a", delivers: false }])).toThrow();
    expect(() => patch("jambo")).toThrow();
  });
});
