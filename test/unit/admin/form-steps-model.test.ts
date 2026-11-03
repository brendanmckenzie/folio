import { describe, expect, it } from "vitest";
import {
  type FormField,
  type FormLayout,
  MAX_FORM_STEPS,
  type FormStep,
} from "../../../src/core/forms";
import type { FormActionInfo } from "../../../src/core/form-actions";
import {
  type ActionContext,
  addField,
  canJoinPrevious,
  canMoveField,
  endSectionAfter,
  fieldRows,
  groupText,
  logicRefusal,
  mergeStepIntoPrevious,
  moveFieldStep,
  moveRefusal,
  pruneSections,
  removeField,
  removeRefusal,
  removeSection,
  removeSteps,
  renameField,
  splitRefusal,
  splitStepsAt,
  startSection,
  startStepAt,
  startStepRefusal,
  stepRuleRefusal,
  updateSection,
  updateStep,
  withGroupText,
} from "../../../src/admin/ui/screens/form-model";

/**
 * Steps in the builder (`docs/specs/content-model/form-steps.md` decision 14). The
 * property under test is the one the spec states in so many words: **a builder
 * action never produces a form `logicRefusal` would refuse**, and every step's
 * members stay together, in step order.
 */

const t = (name: string, over: Partial<FormField> = {}): FormField => ({
  name,
  kind: "text",
  label: name,
  ...over,
});
const heard: FormField = {
  name: "heard",
  kind: "radio",
  label: "Heard",
  options: [
    { value: "a", label: "A" },
    { value: "other", label: "Other" },
  ],
};
const names = (fields: readonly FormField[]) => fields.map((f) => f.name);
const stepsOf = (fields: readonly FormField[]) => fields.map((f) => f.step);

/** The step key of every question, run-length encoded: `[['step_1', 3], ['step_2', 2]]`. */
function runs(fields: readonly FormField[]): [string | undefined, number][] {
  const out: [string | undefined, number][] = [];
  for (const f of fields) {
    const last = out[out.length - 1];
    if (last && last[0] === f.step) last[1] += 1;
    else out.push([f.step, 1]);
  }
  return out;
}

/** Contiguity: each step is one run, and runs come in the order `layout.steps` lists them. */
function expectContiguous(fields: readonly FormField[], layout: FormLayout) {
  const listed = (layout.steps ?? []).map((s) => s.name);
  if (listed.length === 0) {
    expect(stepsOf(fields).every((s) => s === undefined)).toBe(true);
    return;
  }
  expect(runs(fields).map(([name]) => name)).toEqual(listed);
}

/** A stepped form: three pages, a section inside page 1, a hidden question, rules that
 *  stay on their own page or look back, and a conditional third page. */
function stepped(): { fields: FormField[]; layout: FormLayout } {
  const fields: FormField[] = [
    t("a", { step: "s1" }),
    { ...heard, step: "s1" },
    t("c", { step: "s1", section: "sec", showIf: { field: "heard", eq: "other" } }),
    t("d", { step: "s1", section: "sec" }),
    t("e", { step: "s2", requireIf: { field: "heard", eq: "other" } }),
    t("h1", { step: "s2", kind: "hidden" }),
    t("g", { step: "s2", beside: true, requireIf: { field: "e", isSet: true } }),
    t("i", { step: "s3" }),
    t("j", { step: "s3", requireIf: { field: "g", isSet: true } }),
  ];
  const layout: FormLayout = {
    sections: [{ name: "sec", label: "Section" }],
    steps: [
      { name: "s1", label: "One" },
      { name: "s2", label: "Two" },
      { name: "s3", label: "Three", showIf: { field: "heard", eq: "other" } },
    ],
  };
  return { fields, layout };
}

/** An unstepped form where `p`'s required rule names `q`, below it: legal until a step
 *  boundary falls between them. */
function plain(): { fields: FormField[]; layout: FormLayout } {
  return {
    fields: [
      t("a"),
      { ...heard },
      t("p", { requireIf: { field: "q", isSet: true } }),
      t("q"),
      t("r"),
      t("s", { section: "sec" }),
      t("u", { section: "sec" }),
      t("v"),
    ],
    layout: { sections: [{ name: "sec", label: "Section" }] },
  };
}

describe("fixtures are valid", () => {
  it("stepped and plain forms pass checkFormLogic", () => {
    expect(logicRefusal(stepped().fields, stepped().layout)).toBeNull();
    expect(logicRefusal(plain().fields, plain().layout)).toBeNull();
  });
});

describe("splitStepsAt", () => {
  it("makes step_1 from everything above and step_2 from the question down", () => {
    const { fields, layout } = plain();
    const out = splitStepsAt(fields, { sections: layout.sections }, "r");
    expect(out).not.toBeNull();
    expect(out?.layout.steps?.map((s) => s.name)).toEqual(["step_1", "step_2"]);
    expect(runs(out!.fields)).toEqual([
      ["step_1", 4],
      ["step_2", 4],
    ]);
    expect(out?.step).toBe("step_2");
    expect(logicRefusal(out!.fields, out!.layout)).toBeNull();
    // sections survive
    expect(out?.layout.sections).toEqual(layout.sections);
  });

  it("is refused on the first question, on a stepped form, and for an unknown name", () => {
    const { fields, layout } = plain();
    expect(splitRefusal(fields, layout, "a")).toMatch(/Nothing is above/);
    expect(splitStepsAt(fields, layout, "a")).toBeNull();
    expect(splitStepsAt(fields, layout, "ghost")).toBeNull();
    const s = stepped();
    expect(splitRefusal(s.fields, s.layout, "e")).toMatch(/already has steps/);
    expect(splitStepsAt(s.fields, s.layout, "e")).toBeNull();
  });

  it("is refused where it would cut a section in two", () => {
    const { fields, layout } = plain();
    expect(splitRefusal(fields, layout, "u")).toMatch(/cut the section "Section" in two/);
    expect(splitStepsAt(fields, layout, "u")).toBeNull();
  });

  it("is refused where a required rule's source would land on a later step", () => {
    const { fields, layout } = plain();
    // p (requireIf q) above, q below: splitting at q puts the source on step 2.
    const reason = splitRefusal(fields, layout, "q");
    expect(reason).toMatch(/required rule depends on .*q.*later step/);
    expect(splitStepsAt(fields, layout, "q")).toBeNull();
    // Splitting at p keeps both on the second step: allowed.
    expect(splitStepsAt(fields, layout, "p")).not.toBeNull();
  });

  it("is refused where a side would have nothing a visitor can see", () => {
    const fields = [t("h", { kind: "hidden" }), t("x"), t("y")];
    expect(splitRefusal(fields, {}, "x")).toMatch(/no question a visitor can see/);
    const tail = [t("x"), t("y"), t("h", { kind: "hidden" })];
    expect(splitRefusal(tail, {}, "h")).toMatch(/no question a visitor can see/);
    // A statement alone is a legal page (an interstitial).
    const note = [t("n", { kind: "statement", text: "Before you start" }), t("y")];
    expect(splitStepsAt(note, {}, "y")).not.toBeNull();
  });
});

describe("startStepAt", () => {
  it("splits a step, listing the new one right after it", () => {
    const { fields, layout } = stepped();
    const out = startStepAt(fields, layout, "g");
    expect(out).not.toBeNull();
    expect(out!.layout.steps!.map((s) => s.name)).toEqual(["s1", "s2", "step_1", "s3"]);
    expect(runs(out!.fields).map(([n]) => n)).toEqual(["s1", "s2", "step_1", "s3"]);
    expect(logicRefusal(out!.fields, out!.layout)).toBeNull();
    // The earlier part keeps its step and the new one is unconditional.
    expect(out!.layout.steps![3]!.showIf).toBeDefined();
    expect(out!.layout.steps![2]!.showIf).toBeUndefined();
  });

  it("is refused on a step's first question and on an unstepped form", () => {
    const { fields, layout } = stepped();
    expect(startStepRefusal(fields, layout, "e")).toMatch(/already starts/);
    expect(startStepAt(fields, layout, "e")).toBeNull();
    const p = plain();
    expect(startStepRefusal(p.fields, p.layout, "r")).toMatch(/no steps/);
  });

  it("is refused at the cap", () => {
    const fields: FormField[] = [];
    const steps: FormStep[] = [];
    for (let i = 0; i < MAX_FORM_STEPS; i++) {
      steps.push({ name: `st${i}`, label: `S${i}` });
      fields.push(t(`a${i}`, { step: `st${i}` }), t(`b${i}`, { step: `st${i}` }));
    }
    expect(startStepRefusal(fields, { steps }, "b0")).toMatch(/at most 20 steps/);
  });

  it("is refused where it would cut a section, or put a rule source on a later step", () => {
    const { fields, layout } = stepped();
    expect(startStepRefusal(fields, layout, "d")).toMatch(/cut the section/);
    // g requires e; starting a step at e's... e is first of s2. Use j requireIf g: split at j's
    // step is s3, so make a case inside one step: i then j, j requireIf g on s2 (earlier): fine.
    // Put a required rule on a same-step later source instead.
    const forward = [
      t("a", { step: "s1" }),
      t("x", { step: "s1", requireIf: { field: "y", isSet: true } }),
      t("y", { step: "s1" }),
    ];
    const l: FormLayout = { steps: [{ name: "s1", label: "One" }] };
    expect(logicRefusal(forward, l)).toBeNull();
    expect(startStepRefusal(forward, l, "y")).toMatch(/later step/);
    expect(startStepAt(forward, l, "y")).toBeNull();
    expect(startStepAt(forward, l, "x")).not.toBeNull();
  });

  it("clears a stale beside across the new seam through contiguity, not data", () => {
    const { fields, layout } = stepped();
    const out = startStepAt(fields, layout, "g")!;
    // g sits beside e in the data, but a step boundary starts a fresh row.
    expect(fieldRows(out.fields).some((r) => r.length > 1)).toBe(false);
    expect(canJoinPrevious(out.fields, "g")).toBe(false);
  });
});

describe("mergeStepIntoPrevious", () => {
  it("moves the members onto the previous step and drops the merged one", () => {
    const { fields, layout } = stepped();
    const out = mergeStepIntoPrevious(fields, layout, "s3")!;
    expect(out.step).toBe("s2");
    expect(out.layout.steps!.map((s) => s.name)).toEqual(["s1", "s2"]);
    expectContiguous(out.fields, out.layout);
    expect(runs(out.fields)).toEqual([
      ["s1", 4],
      ["s2", 5],
    ]);
    expect(logicRefusal(out.fields, out.layout)).toBeNull();
  });

  it("merges a middle step and keeps contiguity", () => {
    const { fields, layout } = stepped();
    const out = mergeStepIntoPrevious(fields, layout, "s2")!;
    expect(runs(out.fields)).toEqual([
      ["s1", 7],
      ["s3", 2],
    ]);
    expectContiguous(out.fields, out.layout);
    expect(logicRefusal(out.fields, out.layout)).toBeNull();
  });

  it("is refused for the first step and for an unknown one", () => {
    const { fields, layout } = stepped();
    expect(mergeStepIntoPrevious(fields, layout, "s1")).toBeNull();
    expect(mergeStepIntoPrevious(fields, layout, "ghost")).toBeNull();
  });
});

describe("removeSteps", () => {
  it("clears every membership and the list, keeping sections", () => {
    const { fields, layout } = stepped();
    const out = removeSteps(fields, layout);
    expect(stepsOf(out.fields).every((s) => s === undefined)).toBe(true);
    expect(out.layout.steps).toBeUndefined();
    expect(out.layout.sections).toEqual(layout.sections);
    expect(names(out.fields)).toEqual(names(fields));
    expect(logicRefusal(out.fields, out.layout)).toBeNull();
  });
});

describe("updateStep and the layout reducers that must not drop steps", () => {
  it("replaces one step and keeps sections", () => {
    const { layout } = stepped();
    const next = updateStep(layout, "s2", { name: "s2", label: "Renamed" });
    expect(next.steps!.find((s) => s.name === "s2")?.label).toBe("Renamed");
    expect(next.sections).toEqual(layout.sections);
  });

  it("updateSection, removeSection, startSection and pruneSections keep steps", () => {
    const { fields, layout } = stepped();
    expect(updateSection(layout, "sec", { name: "sec", label: "X" }).steps).toEqual(layout.steps);
    expect(removeSection(fields, layout, "sec").layout.steps).toEqual(layout.steps);
    expect(pruneSections(fields, layout).steps).toEqual(layout.steps);
    expect(startSection(fields, layout, "i")!.layout.steps).toEqual(layout.steps);
  });

  it("renameField repoints a step's rule", () => {
    const { fields, layout } = stepped();
    const out = renameField(fields, layout, "heard", "source");
    expect(out.layout.steps![2]!.showIf).toEqual({ field: "source", eq: "other" });
    expect(logicRefusal(out.fields, out.layout)).toBeNull();
  });
});

describe("addField", () => {
  it("puts a new question on the last step", () => {
    const { fields, layout } = stepped();
    const out = addField(fields, "text", "f1", layout);
    expect(out[out.length - 1]!.step).toBe("s3");
    expectContiguous(out, layout);
  });
  it("leaves an unstepped form unstepped", () => {
    const out = addField(plain().fields, "text", "f1");
    expect(out[out.length - 1]!.step).toBeUndefined();
  });
});

describe("startSection stays inside one step", () => {
  it("runs to the end of the question's step, not the form", () => {
    const { fields, layout } = stepped();
    const out = startSection(fields, layout, "e")!;
    expect(out.fields.filter((f) => f.section === out.section).map((f) => f.name)).toEqual([
      "e",
      "h1",
      "g",
    ]);
    expect(logicRefusal(out.fields, out.layout)).toBeNull();
  });
  it("endSectionAfter does not reach across a step", () => {
    const { fields } = stepped();
    expect(endSectionAfter(fields, "c").find((f) => f.name === "d")?.section).toBeUndefined();
  });
});

describe("removeRefusal on a stepped form", () => {
  it("refuses removing the last visible question of a step", () => {
    const { fields, layout } = stepped();
    const only = [...fields.filter((f) => f.step !== "s3"), t("lonely", { step: "s3" })];
    const l = { ...layout, steps: layout.steps };
    expect(removeRefusal(only, l, "lonely")).toMatch(/only question on step "Three"/);
    expect(removeField(only, "lonely", l)).toHaveLength(only.length);
  });
  it("allows it while another visible question remains, and for a hidden one", () => {
    const { fields, layout } = stepped();
    expect(removeRefusal(fields, layout, "j")).toBeNull();
    expect(removeRefusal(fields, layout, "h1")).toBeNull();
  });
  it("refuses removing a question a step's rule names", () => {
    const fields = [t("a", { step: "s1" }), t("src", { step: "s1" }), t("b", { step: "s2" })];
    const layout: FormLayout = {
      steps: [
        { name: "s1", label: "One" },
        { name: "s2", label: "Two", showIf: { field: "src", isSet: true } },
      ],
    };
    expect(removeRefusal(fields, layout, "src")).toMatch(/Step "Two"/);
  });
});

describe("moving across a step boundary", () => {
  it("moves a step's first member up onto the previous step", () => {
    const { fields, layout } = stepped();
    const at = names(fields).indexOf("i");
    expect(canMoveField(fields, at, -1, layout)).toBe(true);
    const out = moveFieldStep(fields, at, -1, layout);
    const moved = out.find((f) => f.name === "i")!;
    expect(moved.step).toBe("s2");
    expectContiguous(out, layout);
    expect(logicRefusal(out, layout)).toBeNull();
  });

  it("moves a step's last member down onto the next", () => {
    const { fields, layout } = stepped();
    const at = names(fields).indexOf("g");
    // g sits beside e: the first move leaves the row, the second crosses the boundary.
    const left = moveFieldStep(fields, at, 1, layout);
    expect(left.find((f) => f.name === "g")?.step).toBe("s2");
    const out = moveFieldStep(left, at, 1, layout);
    expect(out.find((f) => f.name === "g")?.step).toBe("s3");
    expectContiguous(out, layout);
    expect(logicRefusal(out, layout)).toBeNull();
  });

  it("is refused when it would empty a step of visible questions", () => {
    const fields = [t("a", { step: "s1" }), t("b", { step: "s2" }), t("c", { step: "s2" })];
    const layout: FormLayout = {
      steps: [
        { name: "s1", label: "One" },
        { name: "s2", label: "Two" },
      ],
    };
    // a is alone on step 1; moving it down would leave step 1 empty.
    expect(canMoveField(fields, 0, 1, layout)).toBe(false);
    expect(moveRefusal(fields, 0, 1, layout)).toMatch(/Step "One" has no questions/);
    expect(moveFieldStep(fields, 0, 1, layout)).toEqual(fields);
  });

  it("is refused when it would carry a section member across a boundary", () => {
    const { fields, layout } = stepped();
    // d is the last of section "sec" and of step 1; moving it down lands it on step 2.
    const at = names(fields).indexOf("d");
    expect(moveRefusal(fields, at, 1, layout)).toMatch(/more than one step|not together/);
    expect(moveFieldStep(fields, at, 1, layout)).toEqual(fields);
  });

  it("is refused when it would put a requireIf source on a later step than its dependent", () => {
    const fields = [
      t("p", { step: "s1", requireIf: { field: "q", isSet: true } }),
      t("x", { step: "s1" }),
      t("q", { step: "s1" }),
      t("w", { step: "s2" }),
      t("z", { step: "s2" }),
    ];
    const layout: FormLayout = {
      steps: [
        { name: "s1", label: "One" },
        { name: "s2", label: "Two" },
      ],
    };
    expect(logicRefusal(fields, layout)).toBeNull();
    // q is last on step 1; moving it down would put it on step 2, after p which requires it.
    expect(moveRefusal(fields, 2, 1, layout)).toMatch(/required rule depends on .*q.*later step/);
    expect(canMoveField(fields, 2, 1, layout)).toBe(false);
    expect(moveFieldStep(fields, 2, 1, layout)).toEqual(fields);
    // Moving w up onto step 1 is fine (the source stays on or before the dependent).
    expect(canMoveField(fields, 3, -1, layout)).toBe(true);
  });

  it("respects a mapped required question: refused onto a conditional step", () => {
    const fields = [
      t("a", { step: "s1" }),
      t("b", { step: "s1" }),
      t("m", { step: "s2" }),
      t("n", { step: "s2" }),
    ];
    const layout: FormLayout = {
      steps: [
        { name: "s1", label: "One" },
        { name: "s2", label: "Two", showIf: { field: "a", isSet: true } },
      ],
    };
    const info = {
      id: "act",
      label: "Notify",
      inputs: [{ name: "who", label: "Who", kind: "email", required: true }],
    } as unknown as FormActionInfo;
    const actions: ActionContext = {
      attachments: [{ action: "act", map: { who: "b" } }] as ActionContext["attachments"],
      infos: new Map([["act", info]]),
    };
    // b is last on step 1; moving it down puts it on conditional step 2.
    expect(moveRefusal(fields, 1, 1, layout, actions)).toMatch(/Notify .*conditional/);
    expect(moveRefusal(fields, 1, 1, layout)).toBeNull();
    expect(stepRuleRefusal(fields, "s1", actions)).toMatch(/cannot be conditional/);
    expect(stepRuleRefusal(fields, "s2", actions)).toBeNull();
  });
});

describe("group text", () => {
  const step: FormStep = { name: "s", label: "One" };
  it("reads and writes source text and translations", () => {
    const fr = withGroupText(step, "label", "Un", "fr", "en");
    expect(groupText(fr, "label", "fr", "en")).toBe("Un");
    expect(groupText(fr, "label", "en", "en")).toBe("One");
    expect(withGroupText(fr, "label", "", "fr", "en").i18n).toBeUndefined();
    expect(withGroupText({ ...step, help: "h" }, "help", "", "en", "en").help).toBeUndefined();
  });
});

describe("property: no builder action yields a form logicRefusal rejects", () => {
  const forms = [stepped(), plain()];
  const check = (what: string, fields: readonly FormField[], layout: FormLayout) => {
    expect(logicRefusal(fields, layout), what).toBeNull();
    expectContiguous(fields, layout);
  };

  for (const [fi, form] of forms.entries()) {
    const { fields, layout } = form;
    it(`form ${fi}: every split, start, merge, remove, move, section and add`, () => {
      for (const f of fields) {
        const split = splitStepsAt(fields, layout, f.name);
        if (split) check(`split ${f.name}`, split.fields, split.layout);
        const start = startStepAt(fields, layout, f.name);
        if (start) check(`start ${f.name}`, start.fields, start.layout);
        const rm = removeField(fields, f.name, layout);
        check(`remove ${f.name}`, rm, pruneSections(rm, layout));
        const sec = startSection(fields, layout, f.name);
        if (sec) check(`section ${f.name}`, sec.fields, sec.layout);
        check(`end ${f.name}`, endSectionAfter(fields, f.name), layout);
      }
      for (const s of layout.steps ?? []) {
        const merged = mergeStepIntoPrevious(fields, layout, s.name);
        if (merged) check(`merge ${s.name}`, merged.fields, merged.layout);
      }
      for (const sec of layout.sections ?? []) {
        const out = removeSection(fields, layout, sec.name);
        check(`removeSection ${sec.name}`, out.fields, out.layout);
      }
      const cleared = removeSteps(fields, layout);
      check("removeSteps", cleared.fields, cleared.layout);
      for (let i = 0; i < fields.length; i++) {
        for (const dir of [-1, 1] as const) {
          check(`move ${i} ${dir}`, moveFieldStep(fields, i, dir, layout), layout);
        }
      }
      check("add", addField(fields, "text", "f", layout), layout);
    });
  }

  it("chains actions: repeated splits and moves never leave a refused form", () => {
    let cur = splitStepsAt(plain().fields, plain().layout, "p")!;
    let { fields, layout } = cur;
    for (let round = 0; round < 3; round++) {
      for (const f of [...fields]) {
        const out = startStepAt(fields, layout, f.name);
        if (out) ({ fields, layout } = out);
      }
      for (let i = 0; i < fields.length; i++) {
        for (const dir of [-1, 1] as const) {
          fields = moveFieldStep(fields, i, dir, layout);
          check(`chain ${round}/${i}/${dir}`, fields, layout);
        }
      }
    }
    void cur;
    cur = { ...cur };
  });
});
