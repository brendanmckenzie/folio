import { describe, expect, it } from "vitest";
import { checkSubmission, stepStatus } from "../../../src/core/form-answers";
import type { CheckField } from "../../../src/core/form-answers";
import type { LogicForm } from "../../../src/core/form-logic";

/**
 * The validator moved here from the server (spec 38 decision 3). Its per-kind cases
 * run against `checkSubmission` in `test/unit/server/form-validate.test.ts`, beside
 * the wrapper that still fronts it; this file is what `stepStatus` adds.
 */

const source = (raw: Record<string, string | string[]>) => ({
  getAll: (name: string): readonly unknown[] => {
    const v = raw[name];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  },
});

const text = (name: string, over: Partial<CheckField> = {}): CheckField => ({
  name,
  kind: "text",
  ...over,
});

describe("checkSubmission", () => {
  it("answers the engine state it judged by", () => {
    const form = { fields: [text("a")] };
    expect([...checkSubmission(form, source({ a: "x" })).state.asked]).toEqual(["a"]);
  });

  it("ignores a File entry the way the server's body never carries one", () => {
    const file = new File(["x"], "x.txt");
    const form = { fields: [text("a", { required: true })] };
    const check = checkSubmission(form, { getAll: () => [file] });
    expect(check.errors).toEqual({ a: "required" });
  });

  it("gates on steps passed to it", () => {
    const form = {
      fields: [text("go", { step: "one" }), text("late", { step: "two", required: true })],
      steps: [{ name: "one" }, { name: "two", showIf: { field: "go", eq: "yes" } as const }],
    };
    expect(checkSubmission(form, source({ go: "no" })).unasked).toEqual(["late"]);
    expect(checkSubmission(form, source({ go: "yes" })).errors).toEqual({ late: "required" });
  });
});

describe("stepStatus: Object.prototype names", () => {
  it("is complete for a question named constructor with no errors", () => {
    const form: LogicForm & { fields: CheckField[] } = {
      fields: [text("constructor", { step: "one" })],
      steps: [{ name: "one" }],
    };
    const check = checkSubmission(form, source({}));
    expect(stepStatus(form, check)[0]?.complete).toBe(true);
  });
});

describe("stepStatus", () => {
  const form: LogicForm & { fields: CheckField[] } = {
    fields: [
      text("email", { kind: "email", required: true, step: "about" }),
      text("phone", { kind: "tel", pattern: "\\+?[0-9 ]{8,}", step: "about" }),
      text("go", { step: "trip", kind: "radio", options: [{ value: "yes" }, { value: "no" }] }),
      text("group", { step: "group", required: true }),
      { name: "intro", kind: "statement", step: "end" },
    ],
    steps: [
      { name: "about" },
      { name: "trip" },
      { name: "group", showIf: { field: "go", eq: "yes" } as const },
      { name: "end" },
    ],
  };
  const run = (raw: Record<string, string>) => {
    const check = checkSubmission(form, source(raw));
    return { check, status: stepStatus(form, check) };
  };

  it("reports steps in step order with their questions", () => {
    const { status } = run({});
    expect(status.map((s) => s.name)).toEqual(["about", "trip", "group", "end"]);
    expect(status[0]?.questions).toEqual(["email", "phone"]);
  });

  it("is complete only when none of its questions has an error from the validator", () => {
    expect(run({ email: "a@b.co" }).status[0]?.complete).toBe(true);
    expect(run({}).status[0]?.complete).toBe(false);
    // Answered but invalid is incomplete: required-and-present is not the test.
    const bad = run({ email: "a@b.co", phone: "abc" });
    expect(bad.check.errors).toEqual({ phone: "invalid" });
    expect(bad.status[0]?.complete).toBe(false);
  });

  it("marks an unreachable step as neither reachable nor complete", () => {
    const { status } = run({ go: "no" });
    expect(status[2]).toMatchObject({ name: "group", reachable: false, complete: false });
    expect(run({ go: "yes" }).status[2]).toMatchObject({ reachable: true, complete: false });
    expect(run({ go: "yes", group: "x" }).status[2]?.complete).toBe(true);
  });

  it("treats a step of only a statement as reachable and complete", () => {
    expect(run({}).status[3]).toMatchObject({ reachable: true, complete: true });
  });

  it("answers [] for a form without steps", () => {
    const plain = { fields: [text("a")] };
    expect(stepStatus(plain, checkSubmission(plain, source({})))).toEqual([]);
  });
});
