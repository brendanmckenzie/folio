import { describe, expect, it } from "vitest";
import { DEFAULT_ERROR_MESSAGE } from "../../../src/core/form-actions";
import type { FolioConfig } from "../../../src/server";
import {
  actionInfoOf,
  actionWarnings,
  formAction,
  validateActions,
} from "../../../src/server/form-actions";
import { validateForms } from "../../../src/server/form-responses";

type Env = Record<string, never>;

const base = {
  id: "jambo",
  label: "File in Jambo",
  deliver: () => {},
};

const make = (over: Record<string, unknown> = {}) =>
  validateForms({ actions: [{ ...base, ...over }] as never });

describe("formAction", () => {
  it("is the identity, and infers required and optional inputs", () => {
    const def = formAction<Env, { email: { kind: "email"; label: string; required: true } }>({
      ...base,
      inputs: { email: { kind: "email", label: "Email", required: true } },
      deliver(ctx) {
        const email: string = ctx.inputs.email;
        void email;
      },
    });
    expect(def.id).toBe("jambo");
  });
});

describe("actionInfoOf", () => {
  const def = formAction({
    id: "trip",
    label: "Trip",
    description: "Checks a trip code",
    inputs: {
      email: { kind: "email", label: "Email", required: true },
      area: { kind: "text", label: "Area", help: "Where" },
    },
    settings: {
      pipeline: {
        kind: "select",
        label: "Pipeline",
        options: [{ label: "Sales", value: "sales" }],
        required: true,
      },
      listId: { kind: "text", label: "List", showIf: () => true } as never,
    },
    codes: { unknown_trip: { label: "Unknown", message: "No such trip." } },
    check: () => ({ ok: true }),
    deliver: () => {},
  });

  it("carries no function anywhere, however deep", () => {
    const info = actionInfoOf(def as never);
    const walk = (x: unknown, path: string): void => {
      expect(typeof x, path).not.toBe("function");
      if (x && typeof x === "object") {
        for (const [k, v] of Object.entries(x)) walk(v, `${path}.${k}`);
      }
    };
    walk(info, "info");
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
    expect("check" in info && typeof info.check).toBe("boolean");
  });

  it("lists inputs in order, declared codes then error, and the phase booleans", () => {
    const info = actionInfoOf(def as never);
    expect(info.inputs).toEqual([
      { name: "email", kind: "email", label: "Email", required: true },
      { name: "area", kind: "text", label: "Area", help: "Where", required: false },
    ]);
    expect(info.codes.map((c) => c.code)).toEqual(["unknown_trip", "error"]);
    expect(info.codes[1]?.message).toBe(DEFAULT_ERROR_MESSAGE);
    expect(info).toMatchObject({ check: true, deliver: true, description: "Checks a trip code" });
    expect(Object.keys(info.settings)).toEqual(["pipeline", "listId"]);
  });

  it("gives a deliver-only action no codes and check false", () => {
    const info = actionInfoOf({ ...base } as never);
    expect(info).toMatchObject({ check: false, deliver: true, codes: [], inputs: [] });
  });
});

describe("validateForms: actions", () => {
  it("defaults to empty maps", () => {
    const forms = validateForms({})!;
    expect(forms.actions.size).toBe(0);
    expect(forms.infos.size).toBe(0);
  });

  it("registers a valid action, bound, with its info", () => {
    const forms = make({
      codes: { dupe: { label: "Dupe", message: "Already enquired." } },
      check: () => ({ ok: true }),
    })!;
    expect(typeof forms.actions.get("jambo")?.check).toBe("function");
    expect(forms.infos.get("jambo")?.codes.map((c) => c.code)).toEqual(["dupe", "error"]);
  });

  it("keeps actions as a valid forms key", () => {
    expect(() => validateForms({ action: [] } as never)).toThrow(/unknown `forms` key/);
  });

  it.each([
    ["actions that is not an array", { actions: {} }, /must be an array/],
    ["an id with capitals", { id: "Jambo" }, /not a valid action id/],
    ["an id that is too long", { id: `a${"b".repeat(48)}` }, /not a valid action id/],
    ["no id", { id: undefined }, /not a valid action id/],
    ["no label", { label: " " }, /non-empty label/],
    ["neither check nor deliver", { deliver: undefined }, /check, a deliver, or both/],
    ["a check that is not a function", { check: "yes" }, /check must be a function/],
    ["a deliver that is not a function", { deliver: {} }, /deliver must be a function/],
    ["a bad input name", { inputs: { "1st": { kind: "text", label: "X" } } }, /input name/],
    ["an unknown input kind", { inputs: { a: { kind: "date", label: "X" } } }, /needs a kind/],
    ["an input with no label", { inputs: { a: { kind: "text" } } }, /non-empty label/],
    ["a rich setting kind", { settings: { a: { kind: "richtext", label: "X" } } }, /must be a/],
    [
      "a translatable setting",
      { settings: { a: { kind: "text", label: "X", translatable: true } } },
      /translatable/,
    ],
    [
      "an indexed setting",
      { settings: { a: { kind: "text", label: "X", indexed: false } } },
      /indexed/,
    ],
    [
      "a searchable setting",
      { settings: { a: { kind: "text", label: "X", searchable: true } } },
      /searchable/,
    ],
    ["a unique setting", { settings: { a: { kind: "text", label: "X", unique: true } } }, /unique/],
    [
      "a select with no options",
      { settings: { a: { kind: "select", label: "X", options: [] } } },
      /at least one option/,
    ],
    [
      "a select with duplicate values",
      {
        settings: {
          a: {
            kind: "select",
            label: "X",
            options: [
              { label: "A", value: "x" },
              { label: "B", value: "x" },
            ],
          },
        },
      },
      /repeats the option/,
    ],
    ["codes with no check", { codes: { a: { label: "A", message: "m" } } }, /no check/],
    [
      "a code outside the charset",
      { check: () => ({ ok: true }), codes: { Bad: { label: "A", message: "m" } } },
      /not a valid code/,
    ],
    [
      "a code named error",
      { check: () => ({ ok: true }), codes: { error: { label: "A", message: "m" } } },
      /cannot declare "error"/,
    ],
    [
      "a code with no message",
      { check: () => ({ ok: true }), codes: { a: { label: "A" } } },
      /label and a message/,
    ],
  ])("refuses %s", (_name, over, message) => {
    expect(() =>
      "actions" in over ? validateForms(over as never) : make(over as Record<string, unknown>),
    ).toThrow(message);
  });

  it("refuses a repeated id", () => {
    expect(() => validateForms({ actions: [base, { ...base }] as never })).toThrow(
      /registered twice/,
    );
  });

  it("allows two brands to register the same id, since each validates alone", () => {
    expect(() => {
      validateForms({ actions: [base] as never });
      validateForms({ actions: [base] as never });
    }).not.toThrow();
  });
});

describe("the verify warning", () => {
  const coded = {
    id: "dup",
    label: "Dup",
    check: () => ({ ok: true }),
    codes: { duplicate: { label: "D", message: "m" } },
  };
  const infosOf = (...defs: object[]) => validateActions(defs).infos;

  it("names the action and brand for a check with codes and no verify", () => {
    const lines = actionWarnings(infosOf(coded), false, "takeoffgo");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/"dup".*brand 'takeoffgo'/);
  });

  it("is silent with a verify configured", () => {
    expect(actionWarnings(infosOf(coded), true, null)).toEqual([]);
  });

  it("is silent for a check with no declared codes, and for a deliver-only action", () => {
    const bare = { id: "bare", label: "Bare", check: () => ({ ok: true }) };
    expect(actionWarnings(infosOf(bare, base), false, null)).toEqual([]);
  });
});

describe("the verify warning at construction", () => {
  it("is logged by createRuntime, once per offending action, and not with verify", async () => {
    const { createRuntime } = await import("../../../src/server/runtime");
    const { defineBlock, text } = await import("../../../src/core");
    const root = defineBlock({
      name: "root",
      label: "Root",
      fields: { t: text() },
      render: () => null,
    });
    const run = (forms: object) => {
      const warns: string[] = [];
      createRuntime({
        blocks: [root],
        root: "root",
        bindings: () => ({}) as never,
        auth: "open",
        logger: { warn: (m: unknown) => warns.push(String(m)), error: () => {} },
        forms,
      } as unknown as FolioConfig<Env>);
      return warns.filter((w) => w.includes("form action"));
    };
    const action = {
      id: "dup",
      label: "Dup",
      check: () => ({ ok: true }),
      codes: { duplicate: { label: "D", message: "m" } },
    };
    expect(run({ actions: [action] })).toHaveLength(1);
    expect(run({ actions: [action], verify: () => true })).toEqual([]);
    expect(run({ actions: [{ ...action, codes: undefined }] })).toEqual([]);
  });
});
