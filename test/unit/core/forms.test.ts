import { describe, expect, it } from "vitest";
import {
  FILE_ACCEPT,
  formLayout,
  formSlug,
  honeypotName,
  MAX_FORM_FIELDS,
  RESERVED_PREFIX,
  rowsOf,
  shapeOf,
  validateFormFields,
  checkFormLogic,
  FORM_FIELD_KEYS,
  MAX_FORM_SECTIONS,
  readFormLayout,
  validateFormLayout,
} from "../../../src/core/forms";
import type {
  FormField,
  FormLayout,
  FormSection,
  ResolvedForm,
  ResolvedFormField,
} from "../../../src/core/forms";

/**
 * `core/forms.ts`'s pure vocabulary (`docs/specs/content-model/forms.md`
 * architecture decisions 2, 3, 7, 9, 13). Phase 1 leaves the field kind
 * resolving to `null` — this is what pins the vocabulary itself, ahead of
 * anything that stores or renders it.
 */

describe("formSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(formSlug("Contact Us")).toBe("contact-us");
  });

  it("strips leading and trailing separators", () => {
    expect(formSlug("  --Contact--  ")).toBe("contact");
  });

  it('falls back to "form", not "untitled" (a form is not a page)', () => {
    expect(formSlug("")).toBe("form");
    expect(formSlug("!!!")).toBe("form");
  });

  it("bounds the length the same way story.ts slugify does", () => {
    expect(formSlug("a".repeat(200)).length).toBe(64);
  });
});

describe("validateFormFields", () => {
  const textField = { name: "email", kind: "text", label: "Email" };

  it("accepts a well-formed field, carrying only what was declared", () => {
    expect(validateFormFields([textField])).toEqual([
      { name: "email", kind: "text", label: "Email" },
    ]);
  });

  it("refuses a non-array", () => {
    expect(() => validateFormFields("nope")).toThrow();
    expect(() => validateFormFields(null)).toThrow();
    expect(() => validateFormFields({})).toThrow();
  });

  it(`refuses more than MAX_FORM_FIELDS (${MAX_FORM_FIELDS})`, () => {
    const many = Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => ({
      name: `f${i}`,
      kind: "text",
      label: `F${i}`,
    }));
    expect(() => validateFormFields(many)).toThrow();
  });

  it("accepts exactly MAX_FORM_FIELDS", () => {
    const many = Array.from({ length: MAX_FORM_FIELDS }, (_, i) => ({
      name: `f${i}`,
      kind: "text",
      label: `F${i}`,
    }));
    expect(validateFormFields(many)).toHaveLength(MAX_FORM_FIELDS);
  });

  // Screened on read, like `parseScopes` (roles.ts:83): a kind this build does
  // not recognise is dropped rather than thrown on, so removing a field kind
  // from the code narrows a stored form instead of breaking it.
  it("drops a field of an unrecognised kind rather than throwing", () => {
    expect(
      validateFormFields([textField, { name: "ranking", kind: "nps-score", label: "Score" }]),
    ).toEqual([{ name: "email", kind: "text", label: "Email" }]);
  });

  it("refuses an invalid or empty name", () => {
    expect(() => validateFormFields([{ name: "", kind: "text", label: "X" }])).toThrow();
    expect(() => validateFormFields([{ name: "Email", kind: "text", label: "X" }])).toThrow();
    expect(() => validateFormFields([{ name: "1st", kind: "text", label: "X" }])).toThrow();
    expect(() => validateFormFields([{ kind: "text", label: "X" }])).toThrow();
  });

  it(`refuses a name starting with the reserved prefix "${RESERVED_PREFIX}"`, () => {
    expect(() => validateFormFields([{ name: "_folio_page", kind: "text", label: "X" }])).toThrow();
  });

  it("refuses two fields sharing a name", () => {
    expect(() =>
      validateFormFields([textField, { name: "email", kind: "textarea", label: "Email again" }]),
    ).toThrow();
  });

  it("refuses a field with no label", () => {
    expect(() => validateFormFields([{ name: "email", kind: "text" }])).toThrow();
    expect(() => validateFormFields([{ name: "email", kind: "text", label: "" }])).toThrow();
  });

  it("carries help, placeholder, required, min and max through when present", () => {
    const [field] = validateFormFields([
      {
        name: "age",
        kind: "number",
        label: "Age",
        help: "In years",
        placeholder: "18",
        required: true,
        min: 0,
        max: 120,
      },
    ]) as [FormField];
    expect(field).toEqual({
      name: "age",
      kind: "number",
      label: "Age",
      help: "In years",
      placeholder: "18",
      required: true,
      min: 0,
      max: 120,
    });
  });

  it("carries `beside` and `grow` through when present, and narrows a bad `grow` away rather than throwing", () => {
    const [joined] = validateFormFields([{ ...textField, beside: true, grow: 3 }]) as [FormField];
    expect(joined).toEqual({ ...textField, beside: true, grow: 3 });

    // Not 2, 3 or 4 (the doc's "1 is the default, and the type excludes it"):
    // dropped, like every other malformed presentational key here — a layout
    // mistake must never be the thing that empties `readFields`.
    const [badGrow] = validateFormFields([{ ...textField, grow: 1 }]) as [FormField];
    expect(badGrow.grow).toBeUndefined();
    const [alsoBadGrow] = validateFormFields([{ ...textField, grow: 9 }]) as [FormField];
    expect(alsoBadGrow.grow).toBeUndefined();
  });

  describe("options", () => {
    for (const kind of ["select", "radio", "checkboxes"]) {
      it(`requires at least one option for "${kind}"`, () => {
        expect(() => validateFormFields([{ name: "x", kind, label: "X", options: [] }])).toThrow();
        expect(() => validateFormFields([{ name: "x", kind, label: "X" }])).toThrow();
      });
    }

    it("refuses a duplicate option value", () => {
      expect(() =>
        validateFormFields([
          {
            name: "x",
            kind: "select",
            label: "X",
            options: [
              { value: "a", label: "A" },
              { value: "a", label: "A again" },
            ],
          },
        ]),
      ).toThrow();
    });

    it("refuses an option with no value, and defaults a missing label to the value", () => {
      expect(() =>
        validateFormFields([
          { name: "x", kind: "select", label: "X", options: [{ label: "No value" }] },
        ]),
      ).toThrow();

      const [field] = validateFormFields([
        { name: "x", kind: "select", label: "X", options: [{ value: "yes" }] },
      ]) as [FormField];
      expect(field.options).toEqual([{ value: "yes", label: "yes" }]);
    });

    it("does not attach options to a kind that does not use them", () => {
      const [field] = validateFormFields([
        { name: "x", kind: "text", label: "X", options: [{ value: "a", label: "A" }] },
      ]) as [FormField];
      expect(field.options).toBeUndefined();
    });
  });

  describe("file", () => {
    it("requires a valid accept", () => {
      expect(() => validateFormFields([{ name: "cv", kind: "file", label: "CV" }])).toThrow();
      expect(() =>
        validateFormFields([{ name: "cv", kind: "file", label: "CV", accept: "exe" }]),
      ).toThrow();
    });

    it("accepts every FILE_ACCEPT key", () => {
      for (const accept of Object.keys(FILE_ACCEPT)) {
        const [field] = validateFormFields([{ name: "cv", kind: "file", label: "CV", accept }]) as [
          FormField,
        ];
        expect(field.accept).toBe(accept);
      }
    });

    it("refuses a non-positive or non-finite maxBytes", () => {
      expect(() =>
        validateFormFields([
          { name: "cv", kind: "file", label: "CV", accept: "documents", maxBytes: 0 },
        ]),
      ).toThrow();
      expect(() =>
        validateFormFields([
          { name: "cv", kind: "file", label: "CV", accept: "documents", maxBytes: Number.NaN },
        ]),
      ).toThrow();
    });
  });

  it('defaults a hidden field\'s value to "" when absent', () => {
    const [field] = validateFormFields([{ name: "src", kind: "hidden", label: "Source" }]) as [
      FormField,
    ];
    expect(field.value).toBe("");
  });

  it("requires non-empty text for a statement field", () => {
    expect(() =>
      validateFormFields([{ name: "intro", kind: "statement", label: "Intro" }]),
    ).toThrow();
    const [field] = validateFormFields([
      { name: "intro", kind: "statement", label: "Intro", text: "Please answer honestly." },
    ]) as [FormField];
    expect(field.text).toBe("Please answer honestly.");
  });

  describe("pattern", () => {
    it("compiles and keeps a valid pattern", () => {
      const [field] = validateFormFields([
        { name: "zip", kind: "text", label: "ZIP", pattern: "^[0-9]{5}$" },
      ]) as [FormField];
      expect(field.pattern).toBe("^[0-9]{5}$");
    });

    it("refuses a pattern that does not compile as a RegExp", () => {
      expect(() =>
        validateFormFields([{ name: "zip", kind: "text", label: "ZIP", pattern: "(" }]),
      ).toThrow();
    });

    it("refuses a pattern past the length cap, before ever compiling it", () => {
      expect(() =>
        validateFormFields([
          { name: "zip", kind: "text", label: "ZIP", pattern: ".".repeat(1000) },
        ]),
      ).toThrow();
    });
  });

  describe("i18n", () => {
    it("keeps a well-formed translation", () => {
      const [field] = validateFormFields([
        {
          name: "email",
          kind: "text",
          label: "Email",
          i18n: { fr: { label: "Courriel", options: { yes: "Oui" } } },
        },
      ]) as [FormField];
      expect(field.i18n).toEqual({ fr: { label: "Courriel", options: { yes: "Oui" } } });
    });

    it("drops a malformed locale entry rather than throwing (best-effort, like a missing translation)", () => {
      const [field] = validateFormFields([
        {
          name: "email",
          kind: "text",
          label: "Email",
          i18n: { fr: "not an object", de: { label: "E-Mail" } },
        },
      ]) as [FormField];
      expect(field.i18n).toEqual({ de: { label: "E-Mail" } });
    });

    it("omits i18n entirely when nothing survived screening", () => {
      const [field] = validateFormFields([
        { name: "email", kind: "text", label: "Email", i18n: { fr: "nope" } },
      ]) as [FormField];
      expect(field.i18n).toBeUndefined();
    });
  });
});

describe("shapeOf", () => {
  const base: FormField = { name: "email", kind: "text", label: "Email" };

  it("is stable for the identical field list", () => {
    expect(shapeOf([base])).toBe(shapeOf([{ ...base }]));
  });

  it("does NOT change for a label, help, placeholder or translation edit", () => {
    const before = shapeOf([base]);
    const after = shapeOf([
      { ...base, label: "Your email", help: "We will reply here", placeholder: "jane@example.com" },
    ]);
    expect(after).toBe(before);
  });

  it("changes when a field is added", () => {
    expect(shapeOf([base, { name: "name", kind: "text", label: "Name" }])).not.toBe(
      shapeOf([base]),
    );
  });

  it("changes when a field is removed", () => {
    expect(shapeOf([base])).not.toBe(shapeOf([]));
  });

  it("changes when a field is renamed", () => {
    expect(shapeOf([{ ...base, name: "contact_email" }])).not.toBe(shapeOf([base]));
  });

  it("changes when a field is retyped", () => {
    expect(shapeOf([{ ...base, kind: "email" }])).not.toBe(shapeOf([base]));
  });

  it("changes when required flips either way", () => {
    const required = shapeOf([{ ...base, required: true }]);
    const notRequired = shapeOf([{ ...base, required: false }]);
    const absent = shapeOf([base]);
    expect(required).not.toBe(notRequired);
    expect(notRequired).toBe(absent); // absent and explicit-false are the same shape
  });

  it("changes when an option value changes, but not when only its label does", () => {
    const select: FormField = {
      name: "plan",
      kind: "select",
      label: "Plan",
      options: [{ value: "a", label: "Plan A" }],
    };
    const relabelled: FormField = { ...select, options: [{ value: "a", label: "Renamed plan A" }] };
    const revalued: FormField = { ...select, options: [{ value: "b", label: "Plan A" }] };

    expect(shapeOf([relabelled])).toBe(shapeOf([select]));
    expect(shapeOf([revalued])).not.toBe(shapeOf([select]));
  });

  it("does NOT change for `beside` or `grow` — layout, not shape (decision 2)", () => {
    expect(shapeOf([{ ...base, beside: true, grow: 3 }])).toBe(shapeOf([base]));
  });
});

describe("honeypotName", () => {
  it("is deterministic for the same form id", () => {
    expect(honeypotName("frm_abc123abc123", [])).toBe(honeypotName("frm_abc123abc123", []));
  });

  it("never returns a name in `taken`, unless every pool name is taken", () => {
    // Run it against several ids so the assertion is not one lucky index.
    const ids = ["frm_a", "frm_b", "frm_c", "frm_d", "frm_e"];
    const taken = ["company_website", "fax", "url_confirm"];
    for (const id of ids) {
      expect(taken).not.toContain(honeypotName(id, taken));
    }
  });

  it("falls back to the fixed pool when every name in it is somehow taken", () => {
    const everything = [
      "company_website",
      "fax",
      "url_confirm",
      "middle_name",
      "company_name",
      "phone_extension",
      "address_2",
      "department",
      "reference_code",
      "home_page",
      "contact_id",
      "account_number",
    ];
    expect(() => honeypotName("frm_x", everything)).not.toThrow();
    expect(typeof honeypotName("frm_x", everything)).toBe("string");
  });
});

/* ------------------------------------------------------------------ rowsOf --- */

describe("rowsOf", () => {
  const q = (name: string, extra: Partial<FormField> = {}): FormField => ({
    name,
    kind: "text",
    label: name,
    ...extra,
  });

  it("starts a new row at the start of the form, whatever the first question's own beside says", () => {
    expect(rowsOf([q("first", { beside: true })])).toEqual([0]);
  });

  it("joins a `beside` question to the row before it", () => {
    expect(rowsOf([q("first"), q("last", { beside: true })])).toEqual([0, 0]);
  });

  it("Name: [First][Middle][Last] all share a row, `beside` on everything but the first", () => {
    const fields = [q("first"), q("middle", { beside: true }), q("last", { beside: true })];
    expect(rowsOf(fields)).toEqual([0, 0, 0]);
  });

  it("a `statement` is its own row, and breaks the row on both sides", () => {
    const statement: FormField = { name: "note", kind: "statement", label: "Note", text: "Prose" };
    // `last` sets `beside`, but a statement breaks the row it would have joined.
    const fields = [q("first"), statement, q("last", { beside: true })];
    expect(rowsOf(fields)).toEqual([0, 1, 2]);
  });

  it(`a fifth beside question narrows into a new row rather than a row of five`, () => {
    const fields = [
      q("a"),
      q("b", { beside: true }),
      q("c", { beside: true }),
      q("d", { beside: true }),
      q("e", { beside: true }),
    ];
    expect(rowsOf(fields)).toEqual([0, 0, 0, 0, 1]);
  });

  it("`hidden` questions are layout-transparent: they neither join nor break a row", () => {
    // Hear: [How did you hear? ▾][Other] — `other` joins across a hidden field.
    const hidden: FormField = { name: "campaign", kind: "hidden", label: "Campaign", value: "x" };
    const fields = [q("how", { kind: "select" }), hidden, q("other", { beside: true })];
    expect(rowsOf(fields)).toEqual([0, 0, 0]);
  });

  it("Address: [Street] then [City][State][Postcode] as two rows", () => {
    const fields = [
      q("street"),
      q("city"),
      q("state", { beside: true }),
      q("postcode", { beside: true }),
    ];
    expect(rowsOf(fields)).toEqual([0, 1, 1, 1]);
  });
});

/* --------------------------------------------------------------- formLayout --- */

function resolvedForm(fields: readonly ResolvedFormField[]): ResolvedForm {
  return {
    id: "frm_test0000ab",
    name: "test",
    action: "/f/frm_test0000ab",
    method: "post",
    enctype: "application/x-www-form-urlencoded",
    version: 1,
    open: true,
    fields,
    sections: [],
    hidden: [],
    honeypot: "company_website",
    submitLabel: "Send",
    successMessage: "",
    closedMessage: "",
    redirectTo: null,
  };
}

function rf(name: string, row: number, extra: Partial<ResolvedFormField> = {}): ResolvedFormField {
  return { name, kind: "text", label: name, required: false, row, grow: 1, ...extra };
}

describe("formLayout", () => {
  it("groups consecutive same-row fields into one row, inside the one `section: null` group", () => {
    const view = formLayout(resolvedForm([rf("first", 0), rf("middle", 0), rf("last", 0)]));
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0]?.section).toBeNull();
    expect(view.sections[0]?.rows.map((r) => r.cells.map((c) => c.field.name))).toEqual([
      ["first", "middle", "last"],
    ]);
  });

  it("starts a new row the moment the row number changes", () => {
    const view = formLayout(
      resolvedForm([rf("street", 0), rf("city", 1), rf("state", 1), rf("postcode", 1)]),
    );
    expect(view.sections[0]?.rows.map((r) => r.cells.map((c) => c.field.name))).toEqual([
      ["street"],
      ["city", "state", "postcode"],
    ]);
  });

  it("every cell is `shown` and carries its own `grow`, until slice 3 gives `shown` a second value", () => {
    const view = formLayout(resolvedForm([rf("a", 0, { grow: 2 }), rf("b", 0, { grow: 4 })]));
    const cells = view.sections[0]?.rows[0]?.cells ?? [];
    expect(cells.map((c) => ({ grow: c.grow, shown: c.shown }))).toEqual([
      { grow: 2, shown: true },
      { grow: 4, shown: true },
    ]);
  });

  it("pulls `hidden`-kind fields into `inputs`, position-free, and never into a row", () => {
    const view = formLayout(
      resolvedForm([
        rf("how", 0, { kind: "select" }),
        rf("campaign", 0, { kind: "hidden", value: "spring" }),
        rf("other", 0),
      ]),
    );
    expect(view.inputs.map((f) => f.name)).toEqual(["campaign"]);
    expect(view.sections[0]?.rows[0]?.cells.map((c) => c.field.name)).toEqual(["how", "other"]);
  });

  it("a row's key is its first cell's name, stable across a render", () => {
    const view = formLayout(resolvedForm([rf("a", 0), rf("b", 0), rf("c", 1)]));
    expect(view.sections[0]?.rows.map((r) => r.key)).toEqual(["a", "c"]);
  });

  it("an empty form still answers one `section: null` group with no rows", () => {
    const view = formLayout(resolvedForm([]));
    expect(view.sections).toEqual([{ section: null, rows: [] }]);
    expect(view.inputs).toEqual([]);
  });

  // Rows-slice review, finding 4: `row`/`grow` are typed as always present,
  // but a descriptor a host cached across a deploy (KV, its own
  // `caches.default`) can be one an older `compileField` built, before either
  // existed. `field.row` is then `undefined` at runtime despite the type, and
  // the old code's `openRow === field.row` joined every field into the one
  // row `undefined === undefined` describes — a single row for the whole
  // form, and `undefinedfr` tracks for a host following the handbook's CSS.
  it("falls back to one row per field when `row` is missing, not one row for the whole form", () => {
    // Cast through `unknown`: a stale descriptor is exactly a value this
    // build's own types say cannot happen, which is the point of the test.
    const stale = [
      { name: "a", kind: "text", label: "A", required: false },
      { name: "b", kind: "text", label: "B", required: false },
    ] as unknown as ResolvedFormField[];
    const view = formLayout(resolvedForm(stale));
    expect(view.sections[0]?.rows.map((r) => r.cells.map((c) => c.field.name))).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  it("falls back `grow` to 1 when it is missing, rather than to `undefined`", () => {
    const stale = [
      { name: "a", kind: "text", label: "A", required: false, row: 0 },
    ] as unknown as ResolvedFormField[];
    const view = formLayout(resolvedForm(stale));
    expect(view.sections[0]?.rows[0]?.cells[0]?.grow).toBe(1);
  });

  it("a present `row` still groups normally alongside a stale, `row`-less field", () => {
    const fields = [
      rf("a", 0),
      { name: "b", kind: "text", label: "B", required: false } as unknown as ResolvedFormField,
      rf("c", 0),
    ];
    const view = formLayout(resolvedForm(fields));
    // `b` (no `row`) never joins `a` or `c`'s row 0, on either side of it.
    expect(view.sections[0]?.rows.map((r) => r.cells.map((c) => c.field.name))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });
});

/* ------------------------------------------------- form logic (spec 35) --- */

const radio = (name: string, over: Partial<FormField> = {}): FormField => ({
  name,
  kind: "radio",
  label: name,
  options: [
    { value: "a", label: "A" },
    { value: "other", label: "Other" },
  ],
  ...over,
});
const txt = (name: string, over: Partial<FormField> = {}): FormField => ({
  name,
  kind: "text",
  label: name,
  ...over,
});

describe("validateFormFields: logic keys narrow rather than throw", () => {
  it("keeps a well formed showIf, requireIf, section, hold and prefill", () => {
    const [field] = validateFormFields([
      txt("more", {
        showIf: { field: "heard", eq: "other" },
        requireIf: { field: "heard", isSet: true },
        section: "extra",
        hold: true,
        prefill: "query",
      }),
    ]) as [FormField];
    expect(field).toMatchObject({
      showIf: { field: "heard", eq: "other" },
      requireIf: { field: "heard", isSet: true },
      section: "extra",
      hold: true,
      prefill: "query",
    });
  });

  it("turns a showIf that is not an object into a never-true node", () => {
    const [field] = validateFormFields([{ ...txt("more"), showIf: "yes please" }]) as [FormField];
    expect(field.showIf).toEqual({ any: [] });
  });

  it("drops a malformed requireIf, and any requireIf on a statement", () => {
    const [a, b] = validateFormFields([
      { ...txt("a"), requireIf: 42 },
      {
        name: "prose",
        kind: "statement",
        label: "p",
        text: "hi",
        requireIf: { field: "a", isSet: true },
      },
    ]) as [FormField, FormField];
    expect(a.requireIf).toBeUndefined();
    expect(b.requireIf).toBeUndefined();
  });

  it("drops a section that is not a slug, hold that is not true, prefill that is not 'query'", () => {
    const [field] = validateFormFields([
      { ...txt("a"), section: "Not A Slug", hold: false, prefill: "body" },
    ]) as [FormField];
    expect(field.section).toBeUndefined();
    expect(field.hold).toBeUndefined();
    expect(field.prefill).toBeUndefined();
  });

  it("never prefills a file or a statement", () => {
    const [file, prose] = validateFormFields([
      { name: "cv", kind: "file", label: "cv", accept: "documents", prefill: "query" },
      { name: "p", kind: "statement", label: "p", text: "x", prefill: "query" },
    ]) as [FormField, FormField];
    expect(file.prefill).toBeUndefined();
    expect(prose.prefill).toBeUndefined();
  });

  it("never throws because of a logic or layout key", () => {
    const hostile = [
      { ...txt("a"), showIf: { field: "zzz", eq: { nested: true } } },
      { ...txt("b"), showIf: { not: { not: { not: { not: { not: { field: "a", eq: 1 } } } } } } },
      { ...txt("c"), section: 12, requireIf: [] },
    ];
    const out = validateFormFields(hostile);
    expect(out.map((f) => f.name)).toEqual(["a", "b", "c"]);
  });
});

describe("validateFormLayout", () => {
  const fields = [txt("a")];

  it("answers {} for nothing and for an empty list", () => {
    expect(validateFormLayout(undefined, fields)).toEqual({});
    expect(validateFormLayout({ sections: [] }, fields)).toEqual({});
  });

  it("keeps a well formed section, key by key", () => {
    expect(
      validateFormLayout(
        {
          sections: [
            {
              name: "postal",
              label: "Postal address",
              help: "Where to send it",
              showIf: { field: "a", eq: "x" },
              i18n: { fr: { label: "Adresse" } },
              junk: 1,
            },
          ],
        },
        fields,
      ),
    ).toEqual({
      sections: [
        {
          name: "postal",
          label: "Postal address",
          help: "Where to send it",
          showIf: { field: "a", eq: "x" },
          i18n: { fr: { label: "Adresse" } },
        },
      ],
    });
  });

  it("refuses a bad name, a duplicate, no label, a bad condition and more than the cap", () => {
    const s = (over: Record<string, unknown> = {}) => ({ name: "s", label: "S", ...over });
    expect(() => validateFormLayout({ sections: [s({ name: "Bad Name" })] }, fields)).toThrow(
      /name/,
    );
    expect(() => validateFormLayout({ sections: [s(), s()] }, fields)).toThrow(/duplicate/);
    expect(() => validateFormLayout({ sections: [s({ label: "" })] }, fields)).toThrow(/label/);
    expect(() =>
      validateFormLayout({ sections: [s({ showIf: { field: "a" } })] }, fields),
    ).toThrow();
    const many = Array.from({ length: MAX_FORM_SECTIONS + 1 }, (_, i) => s({ name: `s${i}` }));
    expect(() => validateFormLayout({ sections: many }, fields)).toThrow(/at most/);
    expect(() => validateFormLayout("nope", fields)).toThrow();
  });
});

describe("readFormLayout", () => {
  it("answers {} for anything unparseable and leaves the fields alone", () => {
    const fields = [txt("a")];
    for (const raw of [null, "x", 3, [], { sections: "x" }]) {
      const read = readFormLayout(raw, fields);
      expect(read.layout).toEqual({});
      expect(read.fields).toEqual(fields);
    }
  });

  it("clears a membership that names no section", () => {
    const read = readFormLayout({ sections: [] }, [txt("a", { section: "ghost" })]);
    expect(read.fields[0]?.section).toBeUndefined();
  });

  it("clears the membership of a section that has already closed", () => {
    const read = readFormLayout({ sections: [{ name: "s", label: "S" }] }, [
      txt("a", { section: "s" }),
      txt("b"),
      txt("c", { section: "s" }),
    ]);
    expect(read.fields.map((f) => f.section)).toEqual(["s", undefined, undefined]);
    expect(read.layout.sections?.map((s) => s.name)).toEqual(["s"]);
  });

  it("drops a section with no members, and one that is malformed", () => {
    const read = readFormLayout(
      {
        sections: [{ name: "empty", label: "E" }, { name: "x" }, "junk", { name: "s", label: "S" }],
      },
      [txt("a", { section: "s" })],
    );
    expect(read.layout.sections?.map((s) => s.name)).toEqual(["s"]);
  });

  it("reads a section condition it cannot use as never true", () => {
    const read = readFormLayout({ sections: [{ name: "s", label: "S", showIf: "x" }] }, [
      txt("a", { section: "s" }),
    ]);
    expect(read.layout.sections?.[0]?.showIf).toEqual({ any: [] });
  });

  it("caps at MAX_FORM_SECTIONS", () => {
    const sections = Array.from({ length: MAX_FORM_SECTIONS + 5 }, (_, i) => ({
      name: `s${i}`,
      label: "S",
    }));
    const fields = sections.map((s) => txt(`f_${s.name}`, { section: s.name }));
    expect(readFormLayout({ sections }, fields).layout.sections).toHaveLength(MAX_FORM_SECTIONS);
  });
});

describe("checkFormLogic", () => {
  const heard = radio("heard");
  const refusal = (fields: FormField[], layout: FormLayout = {}): string => {
    try {
      checkFormLogic(fields, layout);
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };

  it("accepts a rule on an earlier question", () => {
    expect(refusal([heard, txt("more", { showIf: { field: "heard", eq: "other" } })])).toBe("");
  });

  it("refuses a showIf naming a later question, naming both", () => {
    const message = refusal([
      txt("more", { label: "Tell us more", showIf: { field: "heard", eq: "other" } }),
      { ...heard, label: "How did you hear" },
    ]);
    expect(message).toContain("Tell us more");
    expect(message).toContain("more");
    expect(message).toContain("How did you hear");
    expect(message).toContain("heard");
  });

  it("refuses an unknown, same, or non-value source", () => {
    expect(refusal([txt("a", { showIf: { field: "ghost", eq: "x" } })])).toMatch(/ghost/);
    expect(refusal([txt("a", { showIf: { field: "a", eq: "x" } })])).toMatch(/itself/);
    expect(refusal([txt("a", { requireIf: { field: "a", isSet: true } })])).toMatch(/itself/);
    expect(
      refusal([
        { name: "cv", kind: "file", label: "cv", accept: "documents" },
        txt("a", { showIf: { field: "cv", isSet: true } }),
      ]),
    ).toMatch(/no answer/);
    expect(
      refusal([
        { name: "p", kind: "statement", label: "p", text: "x" },
        txt("a", { requireIf: { field: "p", isSet: true } }),
      ]),
    ).toMatch(/no answer/);
  });

  it("lets requireIf name a later question", () => {
    expect(
      refusal([
        txt("email", { requireIf: { field: "phone", isSet: false } }),
        txt("phone", { requireIf: { field: "email", isSet: false } }),
      ]),
    ).toBe("");
  });

  it("refuses required together with requireIf, and requireIf on a statement", () => {
    expect(
      refusal([txt("a"), txt("b", { required: true, requireIf: { field: "a", isSet: true } })]),
    ).toMatch(/both/);
    expect(
      refusal([
        txt("a"),
        {
          name: "p",
          kind: "statement",
          label: "p",
          text: "x",
          requireIf: { field: "a", isSet: true },
        },
      ]),
    ).toMatch(/cannot be required/);
  });

  describe("the operator table", () => {
    const withSource = (source: FormField, condition: Record<string, unknown>) =>
      refusal([source, txt("t", { showIf: { field: source.name, ...condition } as never })]);

    it("select and radio take eq, ne, in and isSet over declared options", () => {
      expect(withSource(heard, { eq: "other" })).toBe("");
      expect(withSource(heard, { ne: "a" })).toBe("");
      expect(withSource(heard, { in: ["a", "other"] })).toBe("");
      expect(withSource(heard, { isSet: true })).toBe("");
      expect(withSource(heard, { eq: "nope" })).toMatch(/option/);
      expect(withSource(heard, { includes: "a" })).toMatch(/includes/);
    });

    it("checkboxes take includes and isSet only", () => {
      const ways: FormField = { ...radio("ways"), kind: "checkboxes" };
      expect(withSource(ways, { includes: "a" })).toBe("");
      expect(withSource(ways, { isSet: false })).toBe("");
      expect(withSource(ways, { eq: "a" })).toMatch(/cannot answer/);
      expect(withSource(ways, { includes: "nope" })).toMatch(/option/);
    });

    it("a checkbox takes eq with true or false", () => {
      const box: FormField = { name: "box", kind: "checkbox", label: "box" };
      expect(withSource(box, { eq: true })).toBe("");
      expect(withSource(box, { eq: "yes" })).toMatch(/ticked/);
      expect(withSource(box, { ne: true })).toMatch(/cannot answer/);
    });

    it("a number takes finite numbers, a text kind takes short strings", () => {
      const n: FormField = { name: "n", kind: "number", label: "n" };
      expect(withSource(n, { eq: 3 })).toBe("");
      expect(withSource(n, { eq: "3" })).toMatch(/number/);
      expect(withSource(txt("s"), { eq: "x" })).toBe("");
      expect(withSource(txt("s"), { eq: 3 })).toMatch(/text/);
      expect(withSource(txt("s"), { eq: "x".repeat(121) })).toMatch(/120/);
    });
  });

  it("refuses a section with no members, one that is not contiguous, and an unknown one", () => {
    const sec = (name = "s", extra: Partial<FormSection> = {}): FormSection => ({
      name,
      label: "Postal",
      ...extra,
    });
    expect(refusal([txt("a")], { sections: [sec()] })).toMatch(/no questions/);
    expect(
      refusal([txt("a", { section: "s" }), txt("b"), txt("c", { section: "s" })], {
        sections: [sec()],
      }),
    ).toMatch(/not together/);
    expect(refusal([txt("a", { section: "ghost" })], {})).toMatch(/does not exist/);
  });

  it("refuses a section whose showIf names a question at or after its first member", () => {
    const sec: FormSection = { name: "s", label: "Postal", showIf: { field: "b", eq: "x" } };
    expect(refusal([txt("a", { section: "s" }), txt("b")], { sections: [sec] })).toMatch(/above/);
    expect(refusal([txt("b"), txt("a", { section: "s" })], { sections: [sec] })).toBe("");
  });
});

describe("shapeOf covers everything the server enforces", () => {
  const base: Required<FormField> = {
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
    showIf: { field: "o", eq: 1 },
    requireIf: { field: "o", eq: 2 },
    section: "s",
    hold: true,
    prefill: "query",
    i18n: { fr: { label: "Q" } },
  };
  const drop = (f: FormField, key: keyof FormField): FormField => {
    const next = { ...f };
    delete next[key];
    return next;
  };
  /** One change per key. Typed over every key of `FormField`, so a new key fails
   *  typecheck here until it is given a mutation. */
  const change: Record<keyof FormField, (f: FormField) => FormField> = {
    name: (f) => ({ ...f, name: "q2" }),
    kind: (f) => ({ ...f, kind: "email" }),
    label: (f) => ({ ...f, label: "Other" }),
    help: (f) => ({ ...f, help: "other" }),
    placeholder: (f) => ({ ...f, placeholder: "other" }),
    required: (f) => drop(f, "required"),
    max: (f) => ({ ...f, max: 11 }),
    min: (f) => ({ ...f, min: 2 }),
    pattern: (f) => ({ ...f, pattern: "b+" }),
    options: (f) => ({ ...f, options: [{ value: "z", label: "Z" }] }),
    accept: (f) => ({ ...f, accept: "images" }),
    maxBytes: (f) => ({ ...f, maxBytes: 200 }),
    value: (f) => ({ ...f, value: "other" }),
    text: (f) => ({ ...f, text: "other" }),
    beside: (f) => drop(f, "beside"),
    grow: (f) => ({ ...f, grow: 3 }),
    showIf: (f) => ({ ...f, showIf: { field: "o", eq: 99 } }),
    requireIf: (f) => ({ ...f, requireIf: { field: "o", eq: 99 } }),
    // Moves to another, equally unconditional, section.
    section: (f) => ({ ...f, section: "t" }),
    hold: (f) => drop(f, "hold"),
    prefill: (f) => drop(f, "prefill"),
    i18n: (f) => ({ ...f, i18n: { fr: { label: "Autre" } } }),
  };
  const layout: FormLayout = {
    sections: [
      { name: "s", label: "S" },
      { name: "t", label: "T" },
    ],
  };

  for (const key of Object.keys(FORM_FIELD_KEYS) as (keyof FormField)[]) {
    const kind = FORM_FIELD_KEYS[key];
    it(`${kind === "shape" ? "moves" : "does not move"} for ${key}`, () => {
      const moved = shapeOf([change[key](base)], layout) !== shapeOf([base], layout);
      expect(moved).toBe(kind === "shape");
    });
  }

  it("moves through a section's condition, and only through it", () => {
    const fields = [txt("a", { section: "s" })];
    const plain: FormLayout = { sections: [{ name: "s", label: "S" }] };
    const conditional: FormLayout = {
      sections: [{ name: "s", label: "S", showIf: { field: "x", eq: 1 } }],
    };
    expect(shapeOf(fields, plain)).toBe(shapeOf([txt("a")], {}));
    expect(shapeOf(fields, conditional)).not.toBe(shapeOf(fields, plain));
    expect(shapeOf(fields, { sections: [{ ...plain.sections![0]!, label: "Renamed" }] })).toBe(
      shapeOf(fields, plain),
    );
  });
});

describe("rowsOf: sections", () => {
  it("breaks a row at a section boundary even when beside is set", () => {
    const fields = [
      txt("a"),
      txt("b", { beside: true, section: "s" }),
      txt("c", { beside: true, section: "s" }),
      txt("d", { beside: true }),
    ];
    expect(rowsOf(fields)).toEqual([0, 1, 1, 2]);
  });
});

describe("formLayout: answers", () => {
  const resolved = (
    fields: ResolvedFormField[],
    sections: ResolvedForm["sections"] = [],
  ): ResolvedForm => ({ ...resolvedForm(fields), sections });

  const heardField = rf("heard", 0, {
    kind: "radio",
    options: [
      { value: "a", label: "A" },
      { value: "other", label: "Other" },
    ],
  });
  const moreField = (extra: Partial<ResolvedFormField> = {}) =>
    rf("more", 1, { showIf: { field: "heard", eq: "other" }, ...extra });

  it("with no answers every question and section is present, shown, and statically required", () => {
    const form = resolved(
      [
        heardField,
        moreField({ required: false, requireIf: { all: [] } }),
        rf("street", 2, { section: "postal", required: true }),
      ],
      [{ name: "postal", label: "Postal", showIf: { field: "heard", eq: "x" } }],
    );
    const view = formLayout(form);
    expect(view.sections.map((s) => s.section?.name ?? null)).toEqual([null, "postal"]);
    const cells = view.sections.flatMap((s) => s.rows.flatMap((r) => r.cells));
    expect(cells.every((c) => c.shown)).toBe(true);
    expect(cells.map((c) => c.required)).toEqual([false, false, true]);
  });

  it("with answers removes a question that is not asked, and its now-empty row", () => {
    const view = formLayout(resolved([heardField, moreField()]), { heard: "a" });
    expect(view.sections[0]?.rows.map((r) => r.key)).toEqual(["heard"]);
    const open = formLayout(resolved([heardField, moreField()]), { heard: "other" });
    expect(open.sections[0]?.rows.map((r) => r.key)).toEqual(["heard", "more"]);
  });

  it("with answers keeps a held cell as shown: false, so its row-mates keep their width", () => {
    const form = resolved([
      rf("heard", 0, heardField),
      rf("more", 0, { showIf: { field: "heard", eq: "other" }, hold: true }),
    ]);
    const cells = formLayout(form, { heard: "a" }).sections[0]?.rows[0]?.cells ?? [];
    expect(cells.map((c) => [c.field.name, c.shown])).toEqual([
      ["heard", true],
      ["more", false],
    ]);
  });

  it("drops a row whose every cell is not asked, holds and all", () => {
    const form = resolved([
      heardField,
      rf("x", 1, { showIf: { field: "heard", eq: "other" }, hold: true }),
      rf("y", 1, { showIf: { field: "heard", eq: "other" }, hold: true }),
    ]);
    expect(formLayout(form, { heard: "a" }).sections[0]?.rows.map((r) => r.key)).toEqual(["heard"]);
  });

  it("with answers removes a section whose condition fails, and reports effective requiredness", () => {
    const form = resolved(
      [
        rf("differs", 0, { kind: "checkbox" }),
        rf("street", 1, { section: "postal", required: false, requireIf: { all: [] } }),
      ],
      [{ name: "postal", label: "Postal", showIf: { field: "differs", eq: true } }],
    );
    const off = formLayout(form, { differs: "false" });
    expect(off.sections.map((s) => s.section?.name ?? null)).toEqual([null]);
    const on = formLayout(form, { differs: "1" });
    expect(on.sections.map((s) => s.section?.name ?? null)).toEqual([null, "postal"]);
    expect(on.sections[1]?.rows[0]?.cells[0]?.required).toBe(true);
  });

  it("with answers keeps only asked questions among inputs", () => {
    const form = resolved([
      rf("gate", 0, { kind: "checkbox" }),
      rf("tag", 1, { kind: "hidden", value: "x", showIf: { field: "gate", eq: true } }),
    ]);
    expect(formLayout(form).inputs.map((f) => f.name)).toEqual(["tag"]);
    expect(formLayout(form, { gate: "false" }).inputs).toEqual([]);
    expect(formLayout(form, { gate: "1" }).inputs.map((f) => f.name)).toEqual(["tag"]);
  });

  it("copes with a descriptor cached before sections existed", () => {
    const old = resolvedForm([rf("a", 0, { section: "gone" })]) as Partial<ResolvedForm>;
    delete old.sections;
    const view = formLayout(old as ResolvedForm);
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0]?.section).toBeNull();
  });
});
