import { describe, expect, it } from "vitest";
import {
  type ActionSettingDef,
  attachmentProblems,
  DEFAULT_ERROR_MESSAGE,
  type FormActionAttachment,
  type FormActionInfo,
  INPUT_ACCEPTS,
  MAX_FORM_ACTIONS,
  normaliseFormActions,
  refusalsOf,
  validateFormActions,
  validateSettings,
} from "../../../src/core/form-actions";
import type { FormField, FormFieldKind, FormLayout } from "../../../src/core/forms";

/** Spec 36 phase 1 (`docs/specs/content-model/form-actions.md` decisions 3, 5, 6, 7, 8). */

const KINDS: FormFieldKind[] = [
  "text",
  "textarea",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
  "checkboxes",
  "file",
  "hidden",
  "statement",
];

const info = (over: Partial<FormActionInfo> = {}): FormActionInfo => ({
  id: "crm",
  label: "CRM",
  inputs: [
    { name: "email", kind: "email", label: "Email", required: true },
    { name: "area", kind: "text", label: "Area", required: false },
  ],
  settings: {
    pipeline: {
      kind: "select",
      label: "Pipeline",
      options: [
        { label: "Sales", value: "sales" },
        { label: "Support", value: "support" },
      ],
      required: true,
      default: "sales",
    },
    note: { kind: "text", label: "Note" },
  },
  codes: [
    { code: "unknown_trip", label: "Unknown trip", message: "We do not know that trip." },
    { code: "error", label: "Error", message: DEFAULT_ERROR_MESSAGE },
  ],
  check: true,
  deliver: true,
  ...over,
});

const q = (
  name: string,
  kind: FormFieldKind = "text",
  over: Partial<FormField> = {},
): FormField => ({
  name,
  kind,
  label: name,
  ...over,
});

const FIELDS = [q("email", "email", { required: true }), q("area", "text")];
const OK: FormActionAttachment = {
  action: "crm",
  map: { email: "email" },
  settings: { pipeline: "sales" },
};

describe("INPUT_ACCEPTS", () => {
  const expected: Record<string, FormFieldKind[]> = {
    text: ["text", "textarea", "email", "tel", "url", "date", "select", "radio", "hidden"],
    email: ["email"],
    number: ["number"],
    boolean: ["checkbox"],
    list: ["checkboxes"],
    file: ["file"],
  };
  for (const [input, kinds] of Object.entries(expected)) {
    it(`${input} accepts exactly its row`, () => {
      expect([...INPUT_ACCEPTS[input as keyof typeof INPUT_ACCEPTS]].sort()).toEqual(
        [...kinds].sort(),
      );
    });
  }
  it("is respected by attachmentProblems for every question kind", () => {
    for (const [input, accepted] of Object.entries(INPUT_ACCEPTS)) {
      const i = info({
        inputs: [{ name: "x", kind: input as never, label: "X", required: false }],
        settings: {},
      });
      for (const kind of KINDS) {
        const problems = attachmentProblems(
          { action: "crm", map: { x: "f" } },
          i,
          [q("f", kind)],
          {},
        );
        expect(problems.length === 0, `${input} <- ${kind}`).toBe(accepted.includes(kind));
      }
    }
  });
  it("statement feeds nothing", () => {
    for (const accepted of Object.values(INPUT_ACCEPTS))
      expect(accepted).not.toContain("statement");
  });
});

describe("attachmentProblems", () => {
  it("is empty for a complete attachment", () => {
    expect(attachmentProblems(OK, info(), FIELDS, {})).toEqual([]);
  });

  it("flags a required input unmapped, missing, or incompatible", () => {
    expect(attachmentProblems({ ...OK, map: {} }, info(), FIELDS, {})).toHaveLength(1);
    expect(attachmentProblems({ ...OK, map: { email: "gone" } }, info(), FIELDS, {})).toHaveLength(
      1,
    );
    expect(attachmentProblems({ ...OK, map: { email: "area" } }, info(), FIELDS, {})).toHaveLength(
      1,
    );
  });

  it("flags an optional input mapped to a missing or incompatible question", () => {
    const base = { ...OK, map: { email: "email", area: "gone" } };
    expect(attachmentProblems(base, info(), FIELDS, {})).toHaveLength(1);
    const n = [...FIELDS, q("n", "number")];
    expect(
      attachmentProblems({ ...OK, map: { email: "email", area: "n" } }, info(), n, {}),
    ).toHaveLength(1);
    expect(attachmentProblems({ ...OK, map: { email: "email" } }, info(), FIELDS, {})).toEqual([]);
  });

  describe("a required input must map to an always-answered question", () => {
    const problems = (f: FormField, layout: FormLayout = {}) =>
      attachmentProblems(OK, info(), [f], layout);
    it("accepts stored required", () => {
      expect(problems(q("email", "email", { required: true }))).toEqual([]);
    });
    it("refuses an optional question", () => {
      expect(problems(q("email", "email"))).toHaveLength(1);
    });
    it("refuses a showIf on the question", () => {
      const f = q("email", "email", { required: true, showIf: { field: "a", eq: "b" } });
      expect(problems(f)).toHaveLength(1);
    });
    it("refuses a showIf on its section", () => {
      const f = q("email", "email", { required: true, section: "s" });
      const layout = { sections: [{ name: "s", label: "S", showIf: { field: "a", eq: "b" } }] };
      expect(problems(f, layout)).toHaveLength(1);
      expect(problems(f, { sections: [{ name: "s", label: "S" }] })).toEqual([]);
    });
    it("refuses a showIf on its step", () => {
      const f = q("email", "email", { required: true, step: "s" });
      const layout = { steps: [{ name: "s", label: "S", showIf: { field: "a", eq: "b" } }] };
      expect(problems(f, layout)).toHaveLength(1);
      expect(problems(f, { steps: [{ name: "s", label: "S" }] })).toEqual([]);
    });
    it("refuses a requireIf, matching compileField", () => {
      const f = q("email", "email", { required: true, requireIf: { field: "a", eq: "b" } });
      expect(problems(f)).toHaveLength(1);
    });
    it("accepts checkbox and checkboxes without required", () => {
      const box = info({
        inputs: [{ name: "x", kind: "boolean", label: "X", required: true }],
        settings: {},
      });
      const list = info({
        inputs: [{ name: "x", kind: "list", label: "X", required: true }],
        settings: {},
      });
      const a = { action: "crm", map: { x: "f" } };
      expect(attachmentProblems(a, box, [q("f", "checkbox")], {})).toEqual([]);
      expect(attachmentProblems(a, list, [q("f", "checkboxes")], {})).toEqual([]);
      expect(
        attachmentProblems(a, box, [q("f", "checkbox", { showIf: { field: "a", eq: 1 } })], {}),
      ).toHaveLength(1);
    });
    it("treats hidden like any text question", () => {
      const a = { action: "crm", map: { email: "h" } };
      const i = info({
        inputs: [{ name: "email", kind: "text", label: "E", required: true }],
        settings: {},
      });
      expect(attachmentProblems(a, i, [q("h", "hidden")], {})).toHaveLength(1);
      expect(attachmentProblems(a, i, [q("h", "hidden", { required: true })], {})).toEqual([]);
    });
    it("does not demand an optional input be always answered", () => {
      const a = { ...OK, map: { email: "email", area: "area" } };
      expect(attachmentProblems(a, info(), FIELDS, {})).toEqual([]);
    });
  });

  it("flags a required setting unset, and a value its definition refuses", () => {
    expect(attachmentProblems({ ...OK, settings: {} }, info(), FIELDS, {})).toHaveLength(1);
    expect(
      attachmentProblems({ ...OK, settings: { pipeline: "nope" } }, info(), FIELDS, {}),
    ).toHaveLength(1);
  });

  it("is a set, so a fix removes a problem and adds none", () => {
    const bad = attachmentProblems({ action: "crm" }, info(), FIELDS, {});
    const better = attachmentProblems(
      { action: "crm", map: { email: "email" } },
      info(),
      FIELDS,
      {},
    );
    expect(bad).toHaveLength(2);
    expect(better).toHaveLength(1);
    expect(bad).toEqual(expect.arrayContaining(better));
  });

  it("does not require a setting its showIf hides", () => {
    const i = info({
      settings: {
        mode: { kind: "text", label: "Mode" },
        extra: { kind: "text", label: "Extra", required: true, showIf: { field: "mode", eq: "x" } },
      },
    });
    expect(attachmentProblems({ action: "crm", map: { email: "email" } }, i, FIELDS, {})).toEqual(
      [],
    );
    expect(
      attachmentProblems(
        { action: "crm", map: { email: "email" }, settings: { mode: "x" } },
        i,
        FIELDS,
        {},
      ),
    ).toHaveLength(1);
  });
});

describe("validateFormActions", () => {
  it("accepts up to MAX_FORM_ACTIONS", () => {
    const eight = Array.from({ length: MAX_FORM_ACTIONS }, (_, i) => ({ action: `a${i}` }));
    expect(validateFormActions(eight)).toHaveLength(8);
    expect(() => validateFormActions([...eight, { action: "a9" }])).toThrow(/at most 8/);
  });
  it("refuses one action attached twice", () => {
    expect(() => validateFormActions([{ action: "crm" }, { action: "crm" }])).toThrow(/twice/);
  });
  it("refuses bad charsets", () => {
    expect(() => validateFormActions([{ action: "CRM" }])).toThrow();
    expect(() => validateFormActions([{ action: "crm", map: { "1x": "email" } }])).toThrow();
    expect(() => validateFormActions([{ action: "crm", map: { email: "Email" } }])).toThrow();
    expect(() => validateFormActions([{ action: "crm", messages: { Bad: "x" } }])).toThrow();
    expect(() => validateFormActions([{ action: "crm", settings: { a: { x: 1 } } }])).toThrow();
    expect(() => validateFormActions([{ action: "crm", delivers: false }])).toThrow();
    expect(() => validateFormActions({})).toThrow();
  });
  it("keeps only known keys", () => {
    expect(validateFormActions([{ action: "crm", junk: 1, delivers: true }])).toEqual([
      { action: "crm", delivers: true },
    ]);
  });
});

describe("normaliseFormActions", () => {
  const infos = new Map([["crm", info()]]);
  it("drops undeclared mapping keys, settings and codes, and empty texts", () => {
    const [out] = normaliseFormActions(
      [
        {
          action: "crm",
          map: { email: "email", ghost: "x" },
          settings: { pipeline: "sales", gone: "x" },
          messages: { unknown_trip: "Nope", removed: "x", error: "" },
          i18n: { fr: { messages: { removed: "x" } } },
        },
      ],
      infos,
      new Set(),
    );
    expect(out).toEqual({
      action: "crm",
      map: { email: "email" },
      settings: { pipeline: "sales" },
      messages: { unknown_trip: "Nope" },
      delivers: true,
    });
  });
  it("makes equal attachments compare equal regardless of key order", () => {
    const a: FormActionAttachment = {
      action: "crm",
      map: { area: "area", email: "email" },
      settings: { note: "n", pipeline: "sales" },
      messages: { error: "E", unknown_trip: "U" },
      i18n: { fr: { messages: { error: "F" } }, de: { messages: { error: "D" } } },
    };
    const b: FormActionAttachment = {
      i18n: { de: { messages: { error: "D" } }, fr: { messages: { error: "F" } } },
      messages: { unknown_trip: "U", error: "E" },
      settings: { pipeline: "sales", note: "n", gone: 1 },
      map: { email: "email", area: "area" },
      action: "crm",
      delivers: true,
    };
    const na = normaliseFormActions([a], infos, new Set());
    const nb = normaliseFormActions([b], infos, new Set());
    expect(JSON.stringify(na)).toBe(JSON.stringify(nb));
  });
  it("recomputes delivers from the registry", () => {
    const check = new Map([["crm", info({ deliver: false })]]);
    const [out] = normaliseFormActions([{ action: "crm", delivers: true }], check, new Set());
    expect(out?.delivers).toBeUndefined();
  });
  it("fills defaults only for an added attachment", () => {
    const att = [{ action: "crm" }];
    expect(normaliseFormActions(att, infos, new Set(["crm"]))[0]?.settings).toEqual({
      pipeline: "sales",
    });
    expect(normaliseFormActions(att, infos, new Set())[0]?.settings).toBeUndefined();
    const set = [{ action: "crm", settings: { pipeline: "support" } }];
    expect(normaliseFormActions(set, infos, new Set(["crm"]))[0]?.settings).toEqual({
      pipeline: "support",
    });
  });
  it("passes an unregistered attachment through as stored", () => {
    const stored: FormActionAttachment = {
      action: "old",
      settings: { z: 1, a: 2 },
      delivers: true,
    };
    const [out] = normaliseFormActions([stored], infos, new Set());
    expect(out).toBe(stored);
  });
  it("preserves run order", () => {
    const two = new Map([...infos, ["b", info({ id: "b" })]]);
    const out = normaliseFormActions([{ action: "b" }, { action: "crm" }], two, new Set());
    expect(out.map((x) => x.action)).toEqual(["b", "crm"]);
  });
});

describe("validateSettings", () => {
  const defs: Record<string, ActionSettingDef> = {
    t: { kind: "text", label: "T" },
    ta: { kind: "textarea", label: "TA" },
    n: { kind: "number", label: "N", min: 1, max: 5 },
    b: { kind: "boolean", label: "B" },
    d: { kind: "date", label: "D" },
    s: { kind: "select", label: "S", options: [{ label: "A", value: "a" }] },
  };
  it("accepts a valid value of each kind", () => {
    expect(
      validateSettings({ t: "x", ta: "y", n: 3, b: false, d: "2026-02-03", s: "a" }, defs),
    ).toEqual({
      t: "x",
      ta: "y",
      n: 3,
      b: false,
      d: "2026-02-03",
      s: "a",
    });
  });
  it("refuses a wrong kind for each", () => {
    for (const bad of [
      { t: 1 },
      { ta: true },
      { n: "3" },
      { b: "true" },
      { d: 20260203 },
      { s: 1 },
    ]) {
      expect(() => validateSettings(bad, defs), JSON.stringify(bad)).toThrow();
    }
  });
  it("refuses out-of-range, non-real dates and unlisted options", () => {
    expect(() => validateSettings({ n: 0 }, defs)).toThrow(/at least 1/);
    expect(() => validateSettings({ n: 6 }, defs)).toThrow(/at most 5/);
    expect(() => validateSettings({ n: Number.NaN }, defs)).toThrow();
    expect(() => validateSettings({ d: "2026-02-30" }, defs)).toThrow();
    expect(() => validateSettings({ d: "03/02/2026" }, defs)).toThrow();
    expect(() => validateSettings({ s: "z" }, defs)).toThrow();
  });
  it("drops undeclared keys and treats blank as unset", () => {
    expect(validateSettings({ t: "", zzz: 1 }, defs)).toEqual({});
  });
  it("requires a required setting", () => {
    const req: Record<string, ActionSettingDef> = {
      t: { kind: "text", label: "T", required: true },
    };
    expect(() => validateSettings({}, req)).toThrow(/required/);
    expect(() => validateSettings(undefined, req)).toThrow(/required/);
    expect(validateSettings({ t: "x" }, req)).toEqual({ t: "x" });
  });
  it("refuses a non-object", () => {
    expect(() => validateSettings([], defs)).toThrow();
    expect(() => validateSettings("x", defs)).toThrow();
  });
});

describe("refusalsOf", () => {
  const infos = new Map([["crm", info()]]);
  const att: FormActionAttachment = {
    action: "crm",
    messages: { unknown_trip: "Source text" },
    i18n: {
      fr: { messages: { unknown_trip: "Texte fr" } },
      "fr-CA": { messages: {} },
    },
  };
  it("falls back to the declared message and the default error text", () => {
    expect(refusalsOf([{ action: "crm" }], infos)).toEqual({
      "crm.unknown_trip": "We do not know that trip.",
      "crm.error": DEFAULT_ERROR_MESSAGE,
    });
  });
  it("uses the editor's source text with no locale", () => {
    expect(refusalsOf([att], infos)["crm.unknown_trip"]).toBe("Source text");
  });
  it("uses the active locale, then its fallbacks, then the source", () => {
    expect(refusalsOf([att], infos, { code: "fr", fallbacks: [] })["crm.unknown_trip"]).toBe(
      "Texte fr",
    );
    expect(refusalsOf([att], infos, { code: "fr-CA", fallbacks: ["fr"] })["crm.unknown_trip"]).toBe(
      "Texte fr",
    );
    expect(refusalsOf([att], infos, { code: "de", fallbacks: ["nl"] })["crm.unknown_trip"]).toBe(
      "Source text",
    );
  });
  it("falls back per code, not per attachment", () => {
    const r = refusalsOf([att], infos, { code: "fr", fallbacks: [] });
    expect(r["crm.error"]).toBe(DEFAULT_ERROR_MESSAGE);
  });
  it("treats an empty editor text as unwritten", () => {
    const r = refusalsOf([{ action: "crm", messages: { unknown_trip: "" } }], infos);
    expect(r["crm.unknown_trip"]).toBe("We do not know that trip.");
  });
  it("adds error for a check even when the info omits it", () => {
    const bare = new Map([["crm", info({ codes: [] })]]);
    expect(refusalsOf([{ action: "crm" }], bare)).toEqual({ "crm.error": DEFAULT_ERROR_MESSAGE });
  });
  it("emits nothing for a deliver-only or unregistered action", () => {
    const d = new Map([["crm", info({ check: false })]]);
    expect(refusalsOf([{ action: "crm" }], d)).toEqual({});
    expect(refusalsOf([{ action: "ghost" }], infos)).toEqual({});
  });
});
