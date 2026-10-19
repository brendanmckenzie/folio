import { describe, expect, it } from "vitest";
import {
  answerOf,
  answersFrom,
  formState,
  prefillAnswers,
  type LogicField,
} from "../../../src/core/form-logic";
import type { FormField, FormFieldKind, ResolvedForm } from "../../../src/core/forms";
import { validateSubmission } from "../../../src/server/form-responses";

/**
 * The one engine (`docs/specs/content-model/form-logic.md` decisions 1, 2, 5, 12).
 * The parity block is the one that keeps decision 5 true: if `answerOf` and the
 * validator ever disagree about what a value is, a condition reads one thing in
 * the browser and another on the server.
 */

const OPTIONS = [{ value: "a" }, { value: "b" }, { value: "other" }];

const q = (name: string, over: Partial<LogicField> = {}): LogicField => ({
  name,
  kind: "text",
  ...over,
});

describe("answerOf", () => {
  const kind = (k: FormFieldKind, options = OPTIONS) => ({ kind: k, options });

  it("reads a checkbox as ticked unless blank or 'false'", () => {
    expect(answerOf(kind("checkbox"), ["1"])).toBe(true);
    expect(answerOf(kind("checkbox"), ["on"])).toBe(true);
    expect(answerOf(kind("checkbox"), ["false"])).toBe(false);
    expect(answerOf(kind("checkbox"), [""])).toBe(false);
    expect(answerOf(kind("checkbox"), [])).toBe(false);
  });

  it("limits checkboxes to declared options, deduplicated, empty as []", () => {
    expect(answerOf(kind("checkboxes"), ["a", "a", "b", "", "nope"])).toEqual(["a", "b"]);
    expect(answerOf(kind("checkboxes"), [])).toEqual([]);
  });

  it("answers a select or radio only with a declared option", () => {
    expect(answerOf(kind("select"), ["b"])).toBe("b");
    expect(answerOf(kind("radio"), ["nope"])).toBeUndefined();
    expect(answerOf(kind("select"), [""])).toBeUndefined();
  });

  it("reads a number by shape, and refuses '12abc'", () => {
    expect(answerOf(kind("number"), [" 12 "])).toBe(12);
    expect(answerOf(kind("number"), ["-1.5e2"])).toBe(-150);
    expect(answerOf(kind("number"), ["12abc"])).toBeUndefined();
    expect(answerOf(kind("number"), [""])).toBeUndefined();
  });

  it("reads a date only if it is a real calendar day", () => {
    expect(answerOf(kind("date"), ["2026-02-28"])).toBe("2026-02-28");
    expect(answerOf(kind("date"), ["2026-02-31"])).toBeUndefined();
    expect(answerOf(kind("date"), ["28/02/2026"])).toBeUndefined();
  });

  it("trims every other kind and answers undefined for blank", () => {
    expect(answerOf(kind("text"), ["  hi  "])).toBe("hi");
    expect(answerOf(kind("email"), ["   "])).toBeUndefined();
    expect(answerOf(kind("textarea"), ["a\r\nb\r\n"])).toBe("a\nb");
  });

  it("never answers for a file or a statement", () => {
    expect(answerOf(kind("file"), ["x"])).toBeUndefined();
    expect(answerOf(kind("statement"), ["x"])).toBeUndefined();
  });
});

describe("parity with the validator", () => {
  const cases: [FormField, string[][]][] = [
    [{ name: "t", kind: "text", label: "t" }, [["hello"], ["  padded  "], ["x y"]]],
    [{ name: "t", kind: "textarea", label: "t" }, [["line\nbreak"], ["crlf\r\nbreak"]]],
    [{ name: "t", kind: "email", label: "t" }, [["a@b.co"]]],
    [{ name: "t", kind: "tel", label: "t" }, [["0400 000 000"]]],
    [{ name: "t", kind: "url", label: "t" }, [["https://example.com"]]],
    [{ name: "t", kind: "hidden", label: "t", value: "" }, [["spring"]]],
    [{ name: "t", kind: "number", label: "t" }, [["3"], ["-2.5"], [".5"], ["1e3"]]],
    [{ name: "t", kind: "date", label: "t" }, [["2026-10-19"], ["2024-02-29"]]],
    [{ name: "t", kind: "select", label: "t", options: [{ value: "a", label: "A" }] }, [["a"]]],
    [{ name: "t", kind: "radio", label: "t", options: [{ value: "a", label: "A" }] }, [["a"]]],
    [{ name: "t", kind: "checkbox", label: "t" }, [["1"], ["on"], ["true"], ["false"], [""], []]],
    [
      {
        name: "t",
        kind: "checkboxes",
        label: "t",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      [["a"], ["a", "b"], ["b", "a", "a"], []],
    ],
  ];

  for (const [field, inputs] of cases) {
    it(`${field.kind}: answerOf equals what the validator stores`, () => {
      for (const raw of inputs) {
        const body = new Map<string, string[]>([[field.name, raw]]);
        const { values, errors } = validateSubmission([field], body);
        expect(errors, JSON.stringify(raw)).toEqual({});
        const stored = values[field.name];
        const answered = answerOf(field, raw);
        // A blank optional answer stores no key; the engine reads it as absent.
        expect(answered, JSON.stringify(raw)).toEqual(stored);
      }
    });
  }
});

describe("formState: what is asked", () => {
  it("asks everything on a form with no logic", () => {
    const state = formState({ fields: [q("a"), q("b")] }, {});
    expect([...state.asked]).toEqual(["a", "b"]);
  });

  it("evaluates showIf against earlier answers only", () => {
    const form = {
      fields: [
        q("heard", { kind: "radio", options: OPTIONS }),
        q("more", { showIf: { field: "heard", eq: "other" } }),
      ],
    };
    expect(formState(form, { heard: "a" }).asked.has("more")).toBe(false);
    expect(formState(form, { heard: "other" }).asked.has("more")).toBe(true);
  });

  it("reads a forward reference as absent", () => {
    const form = {
      fields: [q("first", { showIf: { field: "later", eq: "yes" } }), q("later")],
    };
    expect(formState(form, { later: "yes" }).asked.has("first")).toBe(false);
    // `ne` against an absent answer is true, on both sides of the wire.
    const ne = { fields: [q("first", { showIf: { field: "later", ne: "yes" } }), q("later")] };
    expect(formState(ne, { later: "yes" }).asked.has("first")).toBe(true);
  });

  it("evaluates a section's showIf where it begins, and hides every member", () => {
    const form = {
      fields: [
        q("differs", { kind: "checkbox" }),
        q("street", { section: "postal", required: true }),
        q("city", { section: "postal", required: true }),
      ],
      sections: [{ name: "postal", showIf: { field: "differs", eq: true } }],
    };
    const off = formState(form, { differs: "false", street: "1 Main", city: "X" });
    expect([...off.asked]).toEqual(["differs"]);
    expect([...off.required]).toEqual([]);
    expect(off.sections.has("postal")).toBe(false);
    expect(off.answers).toEqual({ differs: false });

    const on = formState(form, { differs: "1" });
    expect([...on.asked]).toEqual(["differs", "street", "city"]);
    expect([...on.required]).toEqual(["street", "city"]);
    expect(on.sections.has("postal")).toBe(true);
  });

  it("requires a question to pass both its own and its section's condition", () => {
    const form = {
      fields: [
        q("a", { kind: "checkbox" }),
        q("b", { kind: "checkbox" }),
        q("inside", { section: "s", showIf: { field: "b", eq: true } }),
      ],
      sections: [{ name: "s", showIf: { field: "a", eq: true } }],
    };
    expect(formState(form, { a: "1", b: "1" }).asked.has("inside")).toBe(true);
    expect(formState(form, { a: "1" }).asked.has("inside")).toBe(false);
    expect(formState(form, { b: "1" }).asked.has("inside")).toBe(false);
  });

  it("drops the answer of a question that was not asked, for later conditions too", () => {
    const form = {
      fields: [
        q("gate", { kind: "checkbox" }),
        q("hidden_one", { showIf: { field: "gate", eq: true } }),
        q("downstream", { showIf: { field: "hidden_one", isSet: true } }),
      ],
    };
    const state = formState(form, { gate: "false", hidden_one: "sneaky" });
    expect(state.answers).toEqual({ gate: false });
    expect(state.asked.has("downstream")).toBe(false);
  });

  it("normalises string inputs the way a host's controlled input would hand them", () => {
    const form = {
      fields: [
        q("guests", { kind: "number" }),
        q("extra", { showIf: { field: "guests", in: [3, 4] } }),
      ],
    };
    expect(formState(form, { guests: "3" }).asked.has("extra")).toBe(true);
    expect(formState(form, { guests: 3 }).asked.has("extra")).toBe(true);
    expect(formState(form, { guests: "5" }).asked.has("extra")).toBe(false);
  });

  it("evaluates includes over a checkboxes answer", () => {
    const form = {
      fields: [
        q("ways", { kind: "checkboxes", options: OPTIONS }),
        q("which", { showIf: { field: "ways", includes: "other" } }),
      ],
    };
    expect(formState(form, { ways: ["a", "other"] }).asked.has("which")).toBe(true);
    expect(formState(form, { ways: ["a"] }).asked.has("which")).toBe(false);
  });
});

describe("formState: what is required", () => {
  it("requires an asked question that is required, and never an unasked one", () => {
    const form = {
      fields: [
        q("gate", { kind: "checkbox" }),
        q("must", { required: true, showIf: { field: "gate", eq: true } }),
      ],
    };
    expect([...formState(form, {}).required]).toEqual([]);
    expect([...formState(form, { gate: "1" }).required]).toEqual(["must"]);
  });

  it("lets requireIf name any other question: email or phone, at least one", () => {
    const form = {
      fields: [
        q("email", { kind: "email", requireIf: { field: "phone", isSet: false } }),
        q("phone", { kind: "tel", requireIf: { field: "email", isSet: false } }),
      ],
    };
    expect([...formState(form, {}).required].sort()).toEqual(["email", "phone"]);
    // Answering one makes the *other* not required; the answered one still reads as
    // required (its own rule sees the other blank) and is satisfied by its answer.
    expect([...formState(form, { email: "a@b.co" }).required]).toEqual(["email"]);
    expect([...formState(form, { phone: "0400" }).required]).toEqual(["phone"]);
  });

  it("never counts a statement as required", () => {
    const form = { fields: [q("prose", { kind: "statement", required: true })] };
    expect(formState(form, {}).required.size).toBe(0);
  });
});

describe("answersFrom", () => {
  it("normalises a FormData and ignores files and reserved names", () => {
    const data = new FormData();
    data.append("heard", "other");
    data.append("ways", "a");
    data.append("ways", "b");
    data.append("_folio_page", "/x");
    data.append("cv", new File(["x"], "cv.pdf"));
    const form = {
      fields: [
        q("heard", { kind: "radio", options: OPTIONS }),
        q("ways", { kind: "checkboxes", options: OPTIONS }),
        q("cv", { kind: "file" }),
        q("_folio_page"),
      ],
    };
    expect(answersFrom(form, data)).toEqual({ heard: "other", ways: ["a", "b"] });
  });
});

describe("prefillAnswers", () => {
  const form = {
    fields: [
      {
        name: "area",
        kind: "select",
        prefill: "query",
        options: [{ value: "safari" }, { value: "beach" }],
      },
      { name: "name", kind: "text" },
      { name: "cv", kind: "file", prefill: "query" },
      { name: "note", kind: "statement", prefill: "query" },
      { name: "email", kind: "email", prefill: "query" },
    ],
  } as unknown as ResolvedForm;

  it("seeds only the questions that opted in", () => {
    expect(prefillAnswers(form, { query: "?area=safari&name=Mallory" })).toEqual({
      area: "safari",
    });
  });

  it("drops a value that is not a declared option", () => {
    expect(prefillAnswers(form, { query: "?area=moon" })).toEqual({});
  });

  it("lets the host's own values beat the query, and apply to any question", () => {
    const answers = prefillAnswers(form, {
      query: new URLSearchParams("area=safari&email=evil@example.com"),
      values: { email: "member@example.com", name: "Ada", area: "beach" },
    });
    expect(answers).toEqual({ area: "beach", email: "member@example.com", name: "Ada" });
  });

  it("never prefills a file or a statement", () => {
    expect(prefillAnswers(form, { query: "?cv=x&note=y", values: { cv: "x", note: "y" } })).toEqual(
      {},
    );
  });
});

describe("round 2: parity, unreadable rules, cache-stripped prefill", () => {
  const optout = { name: "optout", kind: "checkbox" as const };
  const reason = {
    name: "reason",
    kind: "text" as const,
    required: true,
    showIf: { field: "optout", eq: false },
  };
  const form = { fields: [optout, reason] };

  it("an unticked checkbox reads false through every entry point", () => {
    const server = formState(form, answersFrom(form, { getAll: () => [] }));
    const hostMap = formState(form, {});
    expect([...server.asked]).toEqual(["optout", "reason"]);
    expect([...hostMap.asked]).toEqual([...server.asked]);
    expect([...hostMap.required]).toEqual([...server.required]);

    const resolved = {
      ...form,
      fields: form.fields.map((f) => ({ ...f, label: f.name, row: 0, grow: 1 })),
    } as unknown as ResolvedForm;
    const seeded = prefillAnswers(resolved, { query: "" });
    expect([...formState(resolved, seeded).asked]).toEqual(["optout", "reason"]);
  });

  it("an absent checkboxes answer is [] on both sides", () => {
    const f = {
      fields: [
        { name: "w", kind: "checkboxes" as const, options: [{ value: "a" }] },
        { name: "x", kind: "text" as const, showIf: { field: "w", isSet: false } },
      ],
    };
    expect([...formState(f, {}).asked]).toEqual([
      ...formState(f, answersFrom(f, { getAll: () => [] })).asked,
    ]);
  });

  it("never prefills from a parameter the cache key strips", () => {
    const resolved = {
      fields: ["utm_campaign", "gclid", "area"].map((name) => ({
        name,
        kind: "text",
        prefill: "query",
      })),
    } as unknown as ResolvedForm;
    expect(prefillAnswers(resolved, { query: "?utm_campaign=x&gclid=y&area=z" })).toEqual({
      area: "z",
    });
    expect(prefillAnswers(resolved, { values: { utm_campaign: "mine" } })).toEqual({
      utm_campaign: "mine",
    });
  });
});
