import { describe, expect, it } from "vitest";
import type { FormField } from "../../../src/core/forms";
import type { DocumentType } from "../../../src/core/schema";
import type { ResponseRow } from "../../../src/server/form-responses";
import {
  blankField,
  emptyRequiredWarning,
  isSeededOptions,
  minTypedOptions,
  previewable,
  previewStatusText,
  withListedOptions,
  withOptionsFrom,
  withSetting,
  blankOptionsFrom,
} from "../../../src/admin/ui/screens/form-model";
import { answerLines, cellText } from "../../../src/admin/ui/screens/responses-model";

const select = () => blankField("select", { formId: "frm_a", existing: [] });
const content = { source: "content", settings: { type: "trip" } } as const;
const preview = (n: number) => ({
  options: Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `L${i}` })),
  total: n,
  truncated: false,
  status: "fresh" as const,
  loadedAt: null,
});

describe("withOptionsFrom", () => {
  it("drops the untouched seeded option when a source is chosen", () => {
    const next = withOptionsFrom(select(), content);
    expect(next.optionsFrom).toEqual(content);
    expect(next.options).toBeUndefined();
  });

  it("keeps typed extras, including an edited seed", () => {
    const typed: FormField = {
      ...select(),
      options: [{ value: "other", label: "Something else" }],
    };
    expect(withOptionsFrom(typed, content).options).toEqual([
      { value: "other", label: "Something else" },
    ]);
    const edited: FormField = { ...select(), options: [{ value: "option_1", label: "Renamed" }] };
    expect(withOptionsFrom(edited, content).options).toHaveLength(1);
    expect(isSeededOptions(edited.options)).toBe(false);
  });

  it("re-seeds when going back to typed options with nothing typed", () => {
    const sourced = withOptionsFrom(select(), content);
    const back = withOptionsFrom(sourced, undefined);
    expect(back.optionsFrom).toBeUndefined();
    expect(back.options).toEqual([{ value: "option_1", label: "Option 1" }]);
  });

  it("allows an empty typed list only when sourced", () => {
    expect(minTypedOptions(select())).toBe(1);
    expect(minTypedOptions(withOptionsFrom(select(), content))).toBe(0);
  });
});

describe("source descriptors", () => {
  const types = [
    { name: "page", kind: "page", label: "Page", root: "r" },
    { name: "site", kind: "singleton", label: "Site", root: "s" },
    { name: "trip", kind: "record", label: "Trip", root: "t" },
  ] as unknown as DocumentType[];

  it("starts content on the first page or record type, never a singleton", () => {
    expect(blankOptionsFrom("content", undefined, types)).toEqual({
      source: "content",
      settings: { type: "page" },
    });
  });

  it("starts a host source from declared defaults", () => {
    const info = {
      id: "c",
      label: "C",
      ttl: 60,
      localised: false,
      settings: { region: { kind: "text", default: "af" } },
    } as never;
    expect(blankOptionsFrom("c", info, types).settings).toEqual({ region: "af" });
  });

  it("removes a setting emptied, and previews only a usable descriptor", () => {
    expect(withSetting({ source: "c", settings: { a: 1 } }, "a", "").settings).toEqual({});
    expect(previewable({ source: "content", settings: {} })).toBe(false);
    expect(previewable(content)).toBe(true);
    expect(previewable(undefined)).toBe(false);
  });

  it("phrases a host source's status", () => {
    expect(previewStatusText({ ...preview(1), status: "stale", loadedAt: 5 }, () => "then")).toBe(
      "Stale since then",
    );
    expect(previewStatusText({ ...preview(0), status: "never-loaded", failure: "timeout" })).toBe(
      "Never loaded: timeout",
    );
  });
});

describe("emptyRequiredWarning", () => {
  const required: FormField = { ...withOptionsFrom(select(), content), required: true };
  it("warns for a required content question with an empty list and no extras", () => {
    expect(emptyRequiredWarning(required, preview(0))).toMatch(/this question is not asked/);
  });
  it("is quiet for every other case", () => {
    expect(emptyRequiredWarning(required, preview(2))).toBeNull();
    expect(emptyRequiredWarning(required, null)).toBeNull();
    expect(emptyRequiredWarning({ ...required, required: false }, preview(0))).toBeNull();
    expect(
      emptyRequiredWarning({ ...required, options: [{ value: "x", label: "X" }] }, preview(0)),
    ).toBeNull();
    expect(
      emptyRequiredWarning({ ...required, optionsFrom: { source: "countries" } }, preview(0)),
    ).toBeNull();
  });
});

describe("withListedOptions", () => {
  const sourced: FormField = {
    ...withOptionsFrom(select(), content),
    options: [{ value: "x", label: "Extra" }],
  };
  it("merges the previewed list with the extras", () => {
    const [out] = withListedOptions([sourced], { [sourced.name]: [{ value: "a", label: "A" }] });
    expect(out?.options?.map((o) => o.value)).toEqual(["a", "x"]);
  });
  it("drops the options of a sourced question whose list is unknown", () => {
    expect(withListedOptions([sourced], {})[0]?.options).toBeUndefined();
  });
  it("leaves an unsourced question alone", () => {
    const plain = select();
    expect(withListedOptions([plain], {})[0]).toBe(plain);
  });
});

describe("response labels", () => {
  const field: FormField = { name: "trip", kind: "select", label: "Trip", options: [] };
  const row = (data: ResponseRow["data"], optionLabels: ResponseRow["optionLabels"]) =>
    ({
      id: "res_1",
      data,
      files: [],
      unasked: [],
      optionLabels,
      page: "",
      locale: "",
      version: 1,
      createdAt: 1,
    }) as unknown as ResponseRow;

  it("reads a snapshotted label and falls back to the raw value", () => {
    const labels = { trip: { stry_1: "Serengeti" } };
    expect(cellText(field, row({ trip: "stry_1" }, labels))).toBe("Serengeti");
    expect(cellText(field, row({ trip: "typed" }, labels))).toBe("typed");
    expect(cellText(field, row({ trip: "stry_1" }, {}))).toBe("stry_1");
  });

  it("maps each value of a checkboxes answer", () => {
    const f = { ...field, kind: "checkboxes" } as FormField;
    expect(cellText(f, row({ trip: ["a", "b"] }, { trip: { a: "Alpha" } }))).toBe("Alpha, b");
  });

  it("gives the drawer the stored value beneath a label that differs", () => {
    const [line] = answerLines(row({ trip: "stry_1" }, { trip: { stry_1: "Serengeti" } }), [field]);
    expect(line).toMatchObject({ value: "Serengeti", raw: "stry_1" });
    const [plain] = answerLines(row({ trip: "x" }, {}), [field]);
    expect(plain?.raw).toBeUndefined();
  });
});
