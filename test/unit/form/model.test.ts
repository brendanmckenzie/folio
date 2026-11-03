import { describe, expect, it } from "vitest";
import { formLayout } from "../../../src/core/forms";
import {
  checkDom,
  controlPropsOf,
  enterAction,
  fileRefusal,
  groupPropsOf,
  initialStep,
  navigation,
  neighbour,
  problemsOf,
  sanitiseId,
  statusView,
  transportBody,
} from "../../../src/form/model";
import { baseForm, rf, steppedForm } from "./render/fixture";

const order = ["about", "group", "trip"];
const ctx = { prefix: "p", required: true, answer: undefined, invalid: false };

describe("initialStep", () => {
  const form = steppedForm();
  const layout = (answers: Record<string, string>) => formLayout(form, answers);

  it("starts on the first rendered step", () => {
    expect(initialStep(layout({}), { order, current: null })).toBe("about");
  });
  it("pulls to the earliest step holding a named question", () => {
    expect(initialStep(layout({}), { order, current: null, pull: ["notes", "email"] })).toBe(
      "about",
    );
    expect(initialStep(layout({}), { order, current: null, pull: ["notes"] })).toBe("trip");
  });
  it("ignores a stale name, and lands on the first rendered step for a dropped one", () => {
    expect(initialStep(layout({}), { order, current: null, pull: ["gone"] })).toBe("about");
    expect(initialStep(layout({}), { order, current: null, pull: ["group_size"] })).toBe("about");
  });
  it("keeps a current step that is still rendered, and clamps one that is not", () => {
    expect(initialStep(layout({ travelling: "group" }), { order, current: "group" })).toBe("group");
    expect(initialStep(layout({ travelling: "solo" }), { order, current: "group" })).toBe("about");
  });
  it("moves to the nearest earlier step when the current one is removed", () => {
    const l = formLayout({ ...form, steps: [form.steps?.[0], form.steps?.[2]] as never });
    expect(initialStep(l, { order, current: "group" })).toBe("about");
  });
  it("answers null when no step is rendered", () => {
    const empty = steppedForm({ fields: [rf("x", 0, { step: "about", showIf: { any: [] } })] });
    expect(initialStep(formLayout(empty, {}), { order, current: null })).toBeNull();
  });
});

describe("navigation", () => {
  const form = steppedForm();
  it("skips unreachable steps and counts the available ones", () => {
    const l = formLayout(form, { travelling: "solo" });
    const nav = navigation(form, l, null, {}, "about");
    expect(nav.map((s) => [s.name, s.available, s.index, s.total])).toEqual([
      ["about", true, 0, 2],
      ["group", false, -1, 2],
      ["trip", true, 1, 2],
    ]);
    expect(neighbour(nav, "about", 1)).toBe("trip");
    expect(neighbour(nav, "trip", 1)).toBeNull();
    expect(neighbour(nav, "trip", -1)).toBe("about");
  });
  it("marks a step incomplete while any of its questions has an error", () => {
    const l = formLayout(form, {});
    const nav = navigation(form, l, null, { phone: "invalid" }, "about");
    expect(nav.find((s) => s.name === "about")?.complete).toBe(false);
    expect(nav.find((s) => s.name === "trip")?.complete).toBe(true);
  });
});

describe("enterAction", () => {
  const on = { stepped: true, isLast: false };
  it("advances from a text input before the last step", () => {
    expect(enterAction({ key: "Enter", tag: "INPUT", type: "text" }, on)).toBe("next");
    expect(enterAction({ key: "Enter", tag: "INPUT", type: "email" }, on)).toBe("next");
  });
  it("does nothing on the last step, in a textarea, a checkbox, a button or while composing", () => {
    expect(
      enterAction({ key: "Enter", tag: "INPUT", type: "text" }, { ...on, isLast: true }),
    ).toBeNull();
    expect(enterAction({ key: "Enter", tag: "TEXTAREA" }, on)).toBeNull();
    for (const type of ["checkbox", "radio", "file", "submit", "button"]) {
      expect(enterAction({ key: "Enter", tag: "INPUT", type }, on)).toBeNull();
    }
    expect(enterAction({ key: "Enter", tag: "BUTTON" }, on)).toBeNull();
    expect(enterAction({ key: "Enter", tag: "INPUT", isComposing: true }, on)).toBeNull();
    expect(enterAction({ key: "a", tag: "INPUT" }, on)).toBeNull();
    expect(
      enterAction({ key: "Enter", tag: "INPUT" }, { stepped: false, isLast: false }),
    ).toBeNull();
  });
});

describe("problemsOf", () => {
  it("lists in form order, with step null for a question on no rendered step", () => {
    const form = steppedForm();
    const l = formLayout(form, {});
    const problems = problemsOf(
      form,
      l,
      { notes: "too_long", group_size: "invalid", email: "required" },
      { fields: { required: "Fill it in." } },
    );
    expect(problems.map((p) => [p.name, p.step, p.token])).toEqual([
      ["email", "about", "required"],
      ["group_size", null, "invalid"],
      ["notes", "trip", "too_long"],
    ]);
    expect(problems[0]?.message).toBe("Fill it in.");
    expect(problems[1]?.message).toBe("Check this answer.");
  });
});

describe("statusView", () => {
  const f = {
    successMessage: "Thanks",
    closedMessage: "",
    refusals: { "a.bad": "Bad one.", "a.error": "A failed." },
  };
  it("ok is the form's success message", () => {
    expect(statusView(f, { kind: "ok" }).message).toBe("Thanks");
  });
  it("closed falls back from an empty closedMessage to the host, then the default", () => {
    expect(statusView(f, { kind: "closed" }, { closed: "Shut." }).message).toBe("Shut.");
    expect(statusView(f, { kind: "closed" }).message).toBe("This form is closed.");
    expect(
      statusView({ ...f, closedMessage: "Gone" }, { kind: "closed" }, { closed: "x" }).message,
    ).toBe("Gone");
  });
  it("a host's message beats the server reply for rate, verify, error and invalid", () => {
    for (const kind of ["rate", "verify", "error", "invalid"] as const) {
      expect(statusView(f, { kind, reply: "Server." }, { [kind]: "Host." }).message).toBe("Host.");
      expect(statusView(f, { kind, reply: "Server." }).message).toBe("Server.");
    }
  });
  it("refused keeps the editor's text ahead of the host's", () => {
    expect(statusView(f, { kind: "refused", reason: "a.bad" }, { refused: "Host." }).message).toBe(
      "Bad one.",
    );
  });
  it("refused follows the reason, then <action>.error, then the host, then the default", () => {
    expect(statusView(f, { kind: "refused", reason: "a.bad" }).message).toBe("Bad one.");
    expect(statusView(f, { kind: "refused", reason: "a.gone" }).message).toBe("A failed.");
    expect(
      statusView(
        { ...f, refusals: undefined },
        { kind: "refused", reason: "a.x" },
        { refused: "Host." },
      ).message,
    ).toBe("Host.");
    expect(statusView({ ...f, refusals: undefined }, { kind: "refused" }).message).toBe(
      "We could not accept that submission.",
    );
    expect(statusView(f, { kind: "refused", reason: "a.bad", reply: "Server." }).message).toBe(
      "Server.",
    );
  });
  it("the host's copy wins, then the reply, then the default", () => {
    expect(statusView(f, { kind: "rate", reply: "R" }, { rate: "H" }).message).toBe("H");
    expect(statusView(f, { kind: "rate", reply: "R" }).message).toBe("R");
    expect(statusView(f, { kind: "verify" }).message).toBe("We could not verify that submission.");
  });
});

describe("controlPropsOf", () => {
  const radio = rf("travelling", 0, {
    kind: "radio",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  });
  const boxes = rf("interests", 0, {
    kind: "checkboxes",
    required: true,
    options: [
      { value: "x", label: "X" },
      { value: "y", label: "Y" },
    ],
  });
  it("builds ids from the prefix", () => {
    const p = controlPropsOf(rf("email", 0, { kind: "email", max: 50 }), undefined, ctx);
    expect(p).toMatchObject({
      id: "p-email",
      name: "email",
      type: "email",
      required: true,
    });
  });
  it("puts required on the first radio only", () => {
    const [a, b] = radio.options ?? [];
    expect(controlPropsOf(radio, a, ctx).required).toBe(true);
    expect(controlPropsOf(radio, b, ctx).required).toBeUndefined();
  });
  it("never puts required on a checkboxes option", () => {
    for (const o of boxes.options ?? []) {
      expect(controlPropsOf(boxes, o, ctx).required).toBeUndefined();
    }
  });
  it("ticks from the answer", () => {
    expect(
      controlPropsOf(boxes, boxes.options?.[1], { ...ctx, answer: ["y"] }).defaultChecked,
    ).toBe(true);
    expect(
      controlPropsOf(boxes, boxes.options?.[0], { ...ctx, answer: ["y"] }).defaultChecked,
    ).toBe(false);
    expect(
      controlPropsOf(rf("c", 0, { kind: "checkbox" }), undefined, { ...ctx, answer: true }),
    ).toMatchObject({
      value: "yes",
      defaultChecked: true,
    });
  });
  it("puts invalid state on the control, but on the group for a group", () => {
    const text = controlPropsOf(rf("e", 0), undefined, { ...ctx, invalid: true });
    expect(text).toMatchObject({ "aria-invalid": true, "aria-describedby": "p-e-error" });
    expect(
      controlPropsOf(radio, radio.options?.[0], { ...ctx, invalid: true })["aria-invalid"],
    ).toBeUndefined();
    expect(groupPropsOf(radio, { ...ctx, invalid: true })).toMatchObject({
      role: "radiogroup",
      "aria-invalid": true,
    });
  });
  it("gives aria-required on a required checkboxes group", () => {
    expect(groupPropsOf(boxes, { prefix: "p", required: true, invalid: false })).toMatchObject({
      role: "group",
      "aria-required": true,
      "aria-labelledby": "p-interests-label",
    });
    expect(
      groupPropsOf(boxes, { prefix: "p", required: false, invalid: false })["aria-required"],
    ).toBeUndefined();
  });
  it("prefers the answer, then field.value, for a hidden question", () => {
    const h = rf("ref", 0, { kind: "hidden", value: "dflt" });
    expect(controlPropsOf(h, undefined, ctx).defaultValue).toBe("dflt");
    expect(controlPropsOf(h, undefined, { ...ctx, answer: "q" }).defaultValue).toBe("q");
  });
});

describe("fileRefusal and checkDom", () => {
  it("refuses a file over maxBytes as too_long and leaves the type to the server", () => {
    const f = { maxBytes: 10, accept: ["image/png", "image/*"] };
    expect(fileRefusal(f, { size: 11, type: "image/png" })).toBe("too_long");
    // The server sniffs bytes: a csv or json the client would call off-type is taken.
    const docs = { accept: ["application/pdf"] };
    expect(fileRefusal(docs, { size: 1, type: "text/csv" })).toBeNull();
    expect(fileRefusal(docs, { size: 1, type: "application/json" })).toBeNull();
    expect(fileRefusal(f, { size: 1, type: "" })).toBeNull();
  });
  it("gives number inputs step any, and no maxLength, so the browser matches the server", () => {
    const n = controlPropsOf(rf("w", 0, { kind: "number", min: 0 }), undefined, ctx);
    expect(n.step).toBe("any");
    expect(controlPropsOf(rf("t", 0, { max: 10 }), undefined, ctx).maxLength).toBeUndefined();
    expect(
      controlPropsOf(rf("t", 0, { kind: "textarea", max: 10 }), undefined, ctx).maxLength,
    ).toBeUndefined();
  });
  it("does not read Object.prototype for a question named constructor", () => {
    const form = baseForm({ fields: [rf("constructor", 0)] });
    expect(problemsOf(form, formLayout(form, {}), {})).toEqual([]);
  });
  it("judges a required file by the chosen File, and leaves an unavailable list to the server", () => {
    const form = baseForm({
      enctype: "multipart/form-data",
      fields: [
        rf("cv", 0, { kind: "file", required: true, maxBytes: 5 }),
        rf("pick", 1, {
          kind: "select",
          required: true,
          options: [{ value: "a", label: "A" }],
          optionsFrom: { source: "content", unavailable: true },
        }),
      ],
    });
    const none = new FormData();
    expect(checkDom(form, none).errors).toEqual({ cv: "required" });
    const big = new FormData();
    big.set("cv", new File(["123456789"], "cv.txt"));
    expect(checkDom(form, big).errors).toEqual({ cv: "too_long" });
  });
  it("never asks a content-sourced question with an empty list", () => {
    const form = baseForm({
      fields: [rf("pick", 0, { kind: "select", required: true, showIf: { any: [] }, options: [] })],
    });
    const out = checkDom(form, new FormData());
    expect(out.errors).toEqual({});
    expect(out.check.state.asked.has("pick")).toBe(false);
  });
});

describe("transportBody and sanitiseId", () => {
  const data = new FormData();
  data.append("a", "1");
  data.append("a", "2");
  it("urlencoded is URLSearchParams, multipart keeps the FormData", () => {
    const body = transportBody("application/x-www-form-urlencoded", data);
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).getAll("a")).toEqual(["1", "2"]);
    expect(transportBody("multipart/form-data", data)).toBe(data);
  });
  it("reduces a useId to id-safe characters", () => {
    expect(sanitiseId(":r0:")).toBe("r0");
    expect(sanitiseId("«r1»")).toBe("r1");
    expect(sanitiseId("_r_2_")).toBe("_r_2_");
  });
});
