import { describe, expect, it } from "vitest";
import type { FieldCondition } from "../../../src/core/conditions";
import type { FormField, FormFieldKind } from "../../../src/core/forms";
import { checkFormLogic } from "../../../src/core/forms";
import {
  blankClause,
  blankCondition,
  formConditionText,
  fromEditable,
  operatorsFor,
  sourcesFor,
  toEditable,
} from "../../../src/admin/ui/screens/condition-model";

/**
 * The condition editor's arithmetic (`docs/specs/content-model/form-logic.md`
 * phase 4). `operatorsFor` is pinned against the spec's table, and against
 * `checkFormLogic` itself, so the builder can never offer an operator the server
 * would refuse.
 */

const heard: FormField = {
  name: "heard",
  kind: "radio",
  label: "How did you hear about us?",
  options: [
    { value: "friend", label: "A friend" },
    { value: "other", label: "Other" },
  ],
};
const ways: FormField = { ...heard, name: "ways", kind: "checkboxes", label: "Ways" };

describe("toEditable / fromEditable", () => {
  const roundTrips: FieldCondition[] = [
    { field: "a", eq: "x" },
    { field: "a", ne: 3 },
    { field: "a", in: ["x", "y"] },
    { field: "a", isSet: true },
    { field: "a", isSet: false },
    { field: "a", includes: "x" },
    {
      all: [
        { field: "a", eq: 1 },
        { field: "b", isSet: true },
      ],
    },
    {
      any: [
        { field: "a", eq: 1 },
        { field: "b", ne: 2 },
      ],
    },
  ];

  for (const condition of roundTrips) {
    it(`round trips ${JSON.stringify(condition)}`, () => {
      const editable = toEditable(condition);
      expect(editable).not.toBeNull();
      expect(fromEditable(editable as NonNullable<typeof editable>)).toEqual(condition);
    });
  }

  it("answers null for anything outside the editable subset", () => {
    expect(toEditable({ not: { field: "a", eq: 1 } })).toBeNull();
    expect(toEditable({ all: [{ any: [{ field: "a", eq: 1 }] }] })).toBeNull();
    expect(toEditable({ all: [{ not: { field: "a", eq: 1 } }] })).toBeNull();
    expect(toEditable({ all: [] })).toBeNull();
    expect(toEditable({ any: [] })).toBeNull();
    expect(toEditable(undefined)).toBeNull();
  });

  it("reads a single clause as mode 'all' and writes it back bare", () => {
    expect(toEditable({ field: "a", eq: 1 })).toEqual({
      mode: "all",
      clauses: [{ field: "a", op: "eq", value: 1 }],
    });
  });
});

describe("operatorsFor matches the table", () => {
  const expected: Record<FormFieldKind, string[]> = {
    select: ["eq", "ne", "in", "set", "unset"],
    radio: ["eq", "ne", "in", "set", "unset"],
    checkboxes: ["includes", "set", "unset"],
    checkbox: ["eq"],
    number: ["eq", "ne", "in", "set", "unset"],
    text: ["eq", "ne", "in", "set", "unset"],
    textarea: ["eq", "ne", "in", "set", "unset"],
    email: ["eq", "ne", "in", "set", "unset"],
    tel: ["eq", "ne", "in", "set", "unset"],
    url: ["eq", "ne", "in", "set", "unset"],
    date: ["eq", "ne", "in", "set", "unset"],
    hidden: ["eq", "ne", "in", "set", "unset"],
    file: [],
    statement: [],
  };
  for (const [kind, ops] of Object.entries(expected)) {
    it(`${kind}: ${ops.join(", ") || "none"}`, () => {
      expect(operatorsFor(kind as FormFieldKind)).toEqual(ops);
    });
  }

  it("every blank clause the editor starts from is one checkFormLogic accepts", () => {
    for (const source of [heard, ways]) {
      const dependant: FormField = {
        name: "t",
        kind: "text",
        label: "t",
        showIf: blankCondition(source),
      };
      expect(() => checkFormLogic([source, dependant], {})).not.toThrow();
    }
    for (const kind of Object.keys(expected) as FormFieldKind[]) {
      if (operatorsFor(kind).length === 0) continue;
      const source: FormField = {
        name: "src",
        kind,
        label: "src",
        ...(kind === "select" || kind === "radio" || kind === "checkboxes"
          ? { options: [{ value: "a", label: "A" }] }
          : {}),
      };
      const dependant: FormField = {
        name: "t",
        kind: "text",
        label: "t",
        showIf: fromEditable({ mode: "all", clauses: [blankClause(source)] }),
      };
      expect(() => checkFormLogic([source, dependant], {}), kind).not.toThrow();
    }
  });
});

describe("sourcesFor", () => {
  const file: FormField = { name: "cv", kind: "file", label: "cv", accept: "documents" };
  const prose: FormField = { name: "p", kind: "statement", label: "p", text: "x" };
  const fields = [heard, file, prose, ways];

  it("offers only earlier value-bearing questions for showIf", () => {
    expect(sourcesFor(fields, 3, "show").map((f) => f.name)).toEqual(["heard"]);
    expect(sourcesFor(fields, 0, "show")).toEqual([]);
  });

  it("offers every other value-bearing question for requireIf", () => {
    expect(sourcesFor(fields, 0, "require").map((f) => f.name)).toEqual(["ways"]);
    expect(sourcesFor(fields, 3, "require").map((f) => f.name)).toEqual(["heard"]);
  });
});

describe("formConditionText", () => {
  const fields = [heard, ways];

  it("uses question and option labels, not slugs", () => {
    expect(formConditionText({ field: "heard", eq: "other" }, fields)).toBe(
      '"How did you hear about us?" is "Other"',
    );
    expect(formConditionText({ field: "ways", includes: "friend" }, fields)).toBe(
      '"Ways" includes "A friend"',
    );
    expect(formConditionText({ field: "heard", isSet: false }, fields)).toContain("has no answer");
    expect(formConditionText({ field: "heard", in: ["friend", "other"] }, fields)).toBe(
      '"How did you hear about us?" is one of "A friend", "Other"',
    );
  });

  it("joins combinators and describes a not", () => {
    expect(
      formConditionText(
        {
          all: [
            { field: "heard", eq: "other" },
            { field: "ways", isSet: true },
          ],
        },
        fields,
      ),
    ).toContain(" and ");
    expect(formConditionText({ not: { field: "heard", eq: "other" } }, fields)).toMatch(/^not \(/);
  });

  it("falls back to the slug for a question that is gone, and never throws", () => {
    expect(formConditionText({ field: "ghost", eq: "x" }, fields)).toBe('"ghost" is "x"');
    expect(formConditionText({ bogus: 1 } as unknown as FieldCondition, fields)).toBe(
      "an unrecognised condition",
    );
  });

  it("phrases a checkbox as ticked or not", () => {
    const box: FormField = { name: "box", kind: "checkbox", label: "Box" };
    expect(formConditionText({ field: "box", eq: true }, [box])).toBe('"Box" is ticked');
  });
});
