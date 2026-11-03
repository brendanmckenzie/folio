import { describe, expect, it } from "vitest";
import {
  type FormActionAttachment,
  type FormActionInfo,
  MAX_FORM_ACTIONS,
} from "../../../src/core/form-actions";
import type { FormField, FormLayout } from "../../../src/core/forms";
import { ATTENTION_LABEL, needsAttention } from "../../../src/admin/ui/screens/forms-model";
import {
  type ActionContext,
  actionReaders,
  addedActionProblems,
  attachAction,
  changeRefusal,
  compatibleQuestions,
  detachAction,
  messageText,
  moveAction,
  offerableActions,
  removeField,
  removeRefusal,
  renameField,
  withActionSetting,
  withMapping,
  withMessage,
} from "../../../src/admin/ui/screens/form-model";

/**
 * Form actions in the builder (`docs/specs/content-model/form-actions.md` phase 5):
 * the mapping surviving a rename, a mapped question not being removable, the reducers
 * behind the Actions section, and the Save rule that only an attachment made worse
 * is held back. Pure functions, like every other admin model test.
 */

const field = (name: string, over: Partial<FormField> = {}): FormField =>
  ({ name, kind: "text", label: name, ...over }) as FormField;

const jambo: FormActionInfo = {
  id: "jambo",
  label: "File in Jambo",
  description: "Creates a lead.",
  inputs: [
    { name: "email", kind: "email", label: "Email", required: true },
    { name: "area", kind: "text", label: "Area", required: false },
  ],
  settings: {
    pipeline: {
      kind: "select",
      label: "Pipeline",
      options: [{ label: "Sales", value: "sales" }],
      default: "sales",
      required: true,
    },
    note: { kind: "text", label: "Note" },
    retries: { kind: "number", label: "Retries", default: 3 },
    live: { kind: "boolean", label: "Live", default: true },
  },
  codes: [{ code: "error", label: "Could not process", message: "Sorry." }],
  check: true,
  deliver: true,
};
const mailer: FormActionInfo = {
  id: "mailer",
  label: "Email responses",
  inputs: [],
  settings: {},
  codes: [],
  check: false,
  deliver: true,
};
const infos = new Map([jambo, mailer].map((i) => [i.id, i]));

const email = field("email", { kind: "email", required: true });
const area = field("area");
const attached: FormActionAttachment = {
  action: "jambo",
  map: { email: "email" },
  settings: { pipeline: "sales" },
};
const ctx: ActionContext = { attachments: [attached], infos };

describe("removing a mapped question", () => {
  it("is refused with the action and the input named", () => {
    const reason = removeRefusal([email, area], {}, "email", ctx);
    expect(reason).toBe(
      "File in Jambo reads its email from this question. Change the mapping first.",
    );
  });

  it("is allowed for an unmapped question, and with no actions at all", () => {
    expect(removeRefusal([email, area], {}, "area", ctx)).toBeNull();
    expect(removeRefusal([email, area], {}, "email")).toBeNull();
  });

  it("removeField leaves the list alone while mapped", () => {
    expect(removeField([email, area], "email", {}, ctx).map((f) => f.name)).toEqual([
      "email",
      "area",
    ]);
    expect(removeField([email, area], "email", {}).map((f) => f.name)).toEqual(["area"]);
  });

  it("names an unregistered action by its id", () => {
    const gone: ActionContext = { attachments: [{ action: "old", map: { x: "area" } }], infos };
    expect(removeRefusal([email, area], {}, "area", gone)).toContain("old reads its x");
  });

  it("lists every reader", () => {
    const both: ActionContext = {
      attachments: [attached, { action: "mailer", map: { body: "email" } }],
      infos,
    };
    expect(actionReaders(both, "email").map((r) => r.action)).toEqual(["jambo", "mailer"]);
  });
});

describe("renaming a mapped question", () => {
  it("rewrites the mapping in the same step", () => {
    const out = renameField([email, area], {}, "email", "work_email", [attached]);
    expect(out.fields[0]?.name).toBe("work_email");
    expect(out.actions[0]?.map).toEqual({ email: "work_email" });
  });

  it("leaves other attachments and unrelated mappings alone", () => {
    const other: FormActionAttachment = { action: "mailer", map: { body: "area" } };
    const out = renameField([email, area], {}, "email", "work_email", [attached, other]);
    expect(out.actions[1]).toBe(other);
  });

  it("is a no-op with no attachments", () => {
    expect(renameField([email], {}, "email", "e2").actions).toEqual([]);
  });
});

describe("changing a mapped question", () => {
  it("refuses a retype to a kind the input does not accept", () => {
    const reason = changeRefusal([email], {}, "email", { ...email, kind: "text" }, ctx);
    expect(reason).toContain("File in Jambo");
    expect(reason).toContain("Change the mapping first.");
  });

  it("refuses making a required input's question optional, or conditional", () => {
    expect(changeRefusal([email], {}, "email", { ...email, required: false }, ctx)).not.toBeNull();
    expect(
      changeRefusal(
        [email, area],
        {},
        "email",
        { ...email, showIf: { field: "area", isSet: true } },
        ctx,
      ),
    ).not.toBeNull();
  });

  it("allows an edit that adds no problem", () => {
    expect(changeRefusal([email], {}, "email", { ...email, label: "Work email" }, ctx)).toBeNull();
  });

  it("does not hold an already-broken attachment hostage", () => {
    const optional = field("email", { kind: "email" });
    expect(changeRefusal([optional], {}, "email", { ...optional, label: "E" }, ctx)).toBeNull();
  });

  it("ignores a question no attachment reads", () => {
    expect(changeRefusal([email, area], {}, "area", { ...area, kind: "number" }, ctx)).toBeNull();
  });
});

describe("attachAction and the other reducers", () => {
  it("fills each declared default, and nothing else", () => {
    const out = attachAction([], jambo);
    expect(out).toEqual([
      { action: "jambo", settings: { pipeline: "sales", retries: 3, live: true } },
    ]);
  });

  it("attaches an action with no defaults bare", () => {
    expect(attachAction([], mailer)).toEqual([{ action: "mailer" }]);
  });

  it("does not attach twice, nor past the limit", () => {
    const once = attachAction([], jambo);
    expect(attachAction(once, jambo)).toEqual(once);
    const full = Array.from({ length: MAX_FORM_ACTIONS }, (_, i) => ({ action: `a${i}` }));
    expect(attachAction(full, jambo)).toHaveLength(MAX_FORM_ACTIONS);
  });

  it("does not offer an attached action again", () => {
    expect(offerableActions([jambo, mailer], attachAction([], jambo)).map((i) => i.id)).toEqual([
      "mailer",
    ]);
    expect(offerableActions([jambo, mailer], [])).toHaveLength(2);
  });

  it("offers nothing once the form is full", () => {
    const full = Array.from({ length: MAX_FORM_ACTIONS }, (_, i) => ({ action: `a${i}` }));
    expect(offerableActions([jambo], full)).toEqual([]);
  });

  it("detaches and reorders without mutating", () => {
    const list: FormActionAttachment[] = [{ action: "a" }, { action: "b" }, { action: "c" }];
    expect(detachAction(list, "b").map((a) => a.action)).toEqual(["a", "c"]);
    expect(moveAction(list, "b", -1).map((a) => a.action)).toEqual(["b", "a", "c"]);
    expect(moveAction(list, "a", -1).map((a) => a.action)).toEqual(["a", "b", "c"]);
    expect(moveAction(list, "c", 1).map((a) => a.action)).toEqual(["a", "b", "c"]);
    expect(list.map((a) => a.action)).toEqual(["a", "b", "c"]);
  });

  it("maps and unmaps an input", () => {
    const mapped = withMapping([{ action: "jambo" }], "jambo", "email", "email");
    expect(mapped[0]?.map).toEqual({ email: "email" });
    const cleared = withMapping(mapped, "jambo", "email", "");
    expect(cleared[0]).toEqual({ action: "jambo" });
  });

  it("sets a setting and clears it on empty", () => {
    const set = withActionSetting([{ action: "jambo" }], "jambo", "note", "hi");
    expect(set[0]?.settings).toEqual({ note: "hi" });
    expect(withActionSetting(set, "jambo", "note", "")[0]).toEqual({ action: "jambo" });
    expect(withActionSetting(set, "jambo", "note", undefined)[0]).toEqual({ action: "jambo" });
    expect(withActionSetting(set, "jambo", "retries", 0)[0]?.settings).toEqual({
      note: "hi",
      retries: 0,
    });
    expect(withActionSetting(set, "jambo", "live", false)[0]?.settings?.live).toBe(false);
  });

  it("writes a message to the source, or to a locale's translation", () => {
    const source = withMessage([{ action: "jambo" }], "jambo", "error", "Sorry", "en", "en");
    expect(source[0]?.messages).toEqual({ error: "Sorry" });
    const fr = withMessage(source, "jambo", "error", "Désolé", "fr", "en");
    expect(fr[0]?.i18n).toEqual({ fr: { messages: { error: "Désolé" } } });
    expect(messageText(fr[0] as FormActionAttachment, "error", "fr", "en")).toBe("Désolé");
    expect(messageText(fr[0] as FormActionAttachment, "error", "en", "en")).toBe("Sorry");
    const cleared = withMessage(fr, "jambo", "error", "", "fr", "en");
    expect(cleared[0]?.i18n).toBeUndefined();
    expect(withMessage(cleared, "jambo", "error", "", "en", "en")[0]).toEqual({ action: "jambo" });
  });

  it("lists the questions an input may read, by kind", () => {
    const fields = [email, area, field("n", { kind: "number" }), field("c", { kind: "checkbox" })];
    expect(compatibleQuestions({ kind: "email" }, fields).map((f) => f.name)).toEqual(["email"]);
    expect(compatibleQuestions({ kind: "text" }, fields).map((f) => f.name)).toEqual([
      "email",
      "area",
    ]);
    expect(compatibleQuestions({ kind: "boolean" }, fields).map((f) => f.name)).toEqual(["c"]);
  });
});

describe("addedActionProblems (the Save rule)", () => {
  const layout: FormLayout = {};
  const saved = { fields: [email, area], layout, actions: [attached] };

  it("is empty when nothing changed", () => {
    expect(addedActionProblems(saved, saved, infos)).toEqual([]);
  });

  it("names a problem the draft adds", () => {
    const draft = { ...saved, actions: [{ action: "jambo", settings: { pipeline: "sales" } }] };
    expect(addedActionProblems(saved, draft, infos)[0]).toContain(
      "File in Jambo: Email needs a question",
    );
  });

  it("holds back a newly attached action that is incomplete", () => {
    const draft = { ...saved, actions: [{ action: "jambo" }] };
    expect(addedActionProblems({ ...saved, actions: [] }, draft, infos).length).toBeGreaterThan(0);
  });

  it("lets an already-incomplete attachment save, and a partial fix", () => {
    const broken = { fields: [email, area], layout, actions: [{ action: "jambo" }] };
    expect(
      addedActionProblems(
        broken,
        { ...broken, fields: [email, field("area", { label: "A" })] },
        infos,
      ),
    ).toEqual([]);
    const fixed = { ...broken, actions: [{ action: "jambo", map: { email: "email" } }] };
    expect(addedActionProblems(broken, fixed, infos)).toEqual([]);
  });

  it("ignores an unregistered action", () => {
    const draft = { ...saved, actions: [{ action: "gone" }] };
    expect(addedActionProblems(saved, draft, infos)).toEqual([]);
  });
});

describe("the Forms list mark", () => {
  it("reads attention, absent as false", () => {
    expect(needsAttention({ attention: true })).toBe(true);
    expect(needsAttention({ attention: false })).toBe(false);
    expect(needsAttention({})).toBe(false);
    expect(ATTENTION_LABEL).toBe("Needs attention");
  });
});
