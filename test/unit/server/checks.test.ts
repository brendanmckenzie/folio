import { describe, expect, it } from "vitest";
import type { Blok, Doc, Json } from "../../../src/core/doc";
import {
  asset,
  blocks,
  date,
  multiasset,
  multilink,
  reference,
  references,
  richtext,
  text,
} from "../../../src/core/fields";
import type { LocaleConfig } from "../../../src/core/locales";
import type { DocumentType, SchemaIndex } from "../../../src/core/schema";
import type { StoryMeta, StoryState } from "../../../src/core/story";
import { DOCUMENT_CHECKS } from "../../../src/server/audit";
import {
  type CheckBrand,
  type CheckContext,
  checkDocument,
  type ContentCheck,
  MAX_FINDINGS,
} from "../../../src/server/checks";

/**
 * `checkDocument`, pure, with a literal `targets`
 * (`docs/specs/content-model/authoring-guidance.md` decisions 9 to 11 and 17).
 */

const schema: SchemaIndex = {
  page: {
    name: "page",
    label: "Page",
    fields: {
      title: text({ label: "Title", required: true, translatable: true }),
      body: blocks({ allow: ["hero", "button", "card"] }),
      slides: blocks({ label: "Slides", allow: ["hero"], required: true }),
    },
  },
  hero: {
    name: "hero",
    label: "Hero",
    fields: {
      heading: text({ label: "Heading", length: { max: 10 }, translatable: true }),
      image: asset({ label: "Image" }),
      texture: asset({ label: "Texture", decorative: true }),
      gallery: multiasset({ label: "Gallery" }),
      when: date({ label: "When" }),
      body: richtext({ label: "Body", translatable: true }),
    },
  },
  button: {
    name: "button",
    label: "Button",
    fields: {
      label: text({ label: "Label" }),
      target: multilink({ label: "Target", types: ["page"] }),
    },
  },
  card: {
    name: "card",
    label: "Card",
    fields: {
      who: reference({ label: "Who", types: ["person"] }),
      team: references({ label: "Team" }),
    },
  },
};

const types: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "page", default: true },
  { name: "person", label: "Person", kind: "record", root: "page" },
];

const locales: LocaleConfig = {
  default: "en",
  available: [
    { code: "en", label: "English" },
    { code: "fr", label: "Français" },
    { code: "de", label: "Deutsch" },
  ],
};

const brand = (writing: CheckBrand["writing"] = null): CheckBrand => ({ schema, types, writing });

const image = (alt: string, contentType = "image/jpeg"): Json =>
  ({ key: "k.jpg", filename: "k.jpg", contentType, size: 1, alt }) as Json;

const link = (id: string): Json => ({ kind: "story", id }) as Json;

const prose = (text: string, to?: string): Json =>
  ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text,
            ...(to
              ? { marks: [{ type: "link", attrs: { link: { kind: "story", id: to } } }] }
              : {}),
          },
        ],
      },
    ],
  }) as unknown as Json;

const blok = (
  uid: string,
  type: string,
  data: Record<string, Json>,
  at: { parent?: string; slot?: string; order?: string; i18n?: Blok["i18n"] } = {},
): Blok => ({
  uid,
  type,
  parent: at.parent ?? "root",
  slot: at.slot ?? "body",
  order: at.order ?? "a0",
  data,
  ...(at.i18n ? { i18n: at.i18n } : {}),
});

/** A sound page: everything filled, everything translated, a slide present. */
function sound(): Doc {
  const bloks: Blok[] = [
    {
      uid: "root",
      type: "page",
      parent: null,
      slot: null,
      order: "a0",
      data: { title: "Home" },
      i18n: { fr: { title: "Accueil" }, de: { title: "Start" } },
    },
    blok(
      "h",
      "hero",
      {
        heading: "Hi",
        image: image("A lion"),
        texture: image(""),
        gallery: [],
        when: "2026-01-01",
        body: prose("Hello"),
      },
      {
        i18n: {
          fr: { heading: "Salut", body: prose("Bonjour") },
          de: { heading: "Hallo", body: prose("Hallo") },
        },
      },
    ),
    blok(
      "s",
      "hero",
      { heading: "", image: null, texture: null, gallery: [], when: "", body: null },
      {
        slot: "slides",
      },
    ),
  ];
  return { root: "root", bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])) };
}

const row = (id: string, type: string, state: StoryState): StoryMeta =>
  ({ id, type, state, path: type === "page" ? id : null }) as unknown as StoryMeta;

function ctx(over: Partial<CheckContext> = {}, rows: StoryMeta[] = []) {
  const calls: string[][] = [];
  const c: CheckContext = {
    id: "sty_x",
    source: "draft",
    locales,
    bare: false,
    targets: async (ids) => {
      calls.push(ids);
      return rows.filter((r) => ids.includes(r.id));
    },
    ...over,
  };
  return { c, calls };
}

const only = (findings: ContentCheck[], check: string) => findings.filter((f) => f.check === check);

describe("checkDocument", () => {
  it("finds nothing in a sound document, and makes no read for one with no edges", async () => {
    const { c, calls } = ctx();
    const report = await checkDocument(sound(), brand(), c);
    expect(report).toEqual({
      id: "sty_x",
      source: "draft",
      counts: { error: 0, warning: 0, info: 0 },
      findings: [],
      truncated: false,
    });
    expect(calls).toEqual([]);
  });

  it("reports field-shape for every stored value, and never date-invalid", async () => {
    const doc = sound();
    doc.bloks.h!.data.when = "2026-02-30";
    doc.bloks.h!.i18n!.fr!.heading = 5;
    const { findings } = await checkDocument(doc, brand(), ctx().c);
    expect(only(findings, "date-invalid")).toEqual([]);
    // Field declaration order: `heading` is declared before `when`.
    expect(only(findings, "field-shape")).toEqual([
      expect.objectContaining({
        field: "heading",
        locale: "fr",
        detail: { reason: "must be a string" },
      }),
      {
        check: "field-shape",
        severity: "error",
        message: "When must be a real calendar date.",
        uid: "h",
        type: "hero",
        field: "when",
        path: "body[0]",
        fix: "patch_fields",
        detail: { reason: "must be a real calendar date" },
      },
    ]);
  });

  it("reports required-empty by the one blank rule, a slot through write_content", async () => {
    const doc = sound();
    doc.bloks.root!.data.title = "   ";
    delete doc.bloks.s;
    const { findings } = await checkDocument(doc, brand(), ctx().c);
    expect(only(findings, "required-empty")).toEqual([
      expect.objectContaining({
        uid: "root",
        field: "title",
        path: "",
        fix: "patch_fields",
        severity: "warning",
      }),
      expect.objectContaining({ uid: "root", field: "slides", fix: "write_content" }),
    ]);
  });

  it("reports a required field with no stored key once, as required-empty, not also missing-field", async () => {
    const doc = sound();
    delete doc.bloks.root!.data.title;
    const { findings, counts } = await checkDocument(doc, brand(), ctx().c);
    expect(
      findings.filter((f) => f.uid === "root" && f.field === "title").map((f) => f.check),
    ).toEqual(["required-empty"]);
    expect(counts).toEqual({ error: 0, warning: 1, info: 0 });
  });

  it("reports alt-missing for an image, not a decorative field and not a PDF", async () => {
    const doc = sound();
    doc.bloks.h!.data.image = image(" ");
    doc.bloks.h!.data.texture = image("");
    doc.bloks.h!.data.gallery = [image("ok"), image(""), image("", "application/pdf"), image("")];
    const { findings } = await checkDocument(doc, brand(), ctx().c);
    expect(only(findings, "alt-missing").map((f) => [f.field, f.detail])).toEqual([
      ["image", undefined],
      ["gallery", { index: 1 }],
      ["gallery", { index: 3 }],
    ]);
  });

  it("reports length-over per stored value, carrying the locale and the same message", async () => {
    const doc = sound();
    doc.bloks.h!.i18n!.de!.heading = "Willkommen zu Hause";
    const { findings } = await checkDocument(doc, brand(), ctx().c);
    expect(only(findings, "length-over")).toEqual([
      {
        check: "length-over",
        severity: "warning",
        message: "Heading is 19 characters; the limit is 10.",
        uid: "h",
        type: "hero",
        field: "heading",
        locale: "de",
        path: "body[0]",
        fix: "patch_fields",
        detail: { length: 19, max: 10, unit: "characters" },
      },
    ]);
  });

  it("reports length-under with min, and not on an empty value", async () => {
    const short: SchemaIndex = {
      ...schema,
      hero: {
        ...schema.hero!,
        fields: { ...schema.hero!.fields, heading: text({ label: "Heading", length: { min: 5 } }) },
      },
    };
    const { findings } = await checkDocument(
      sound(),
      { schema: short, types, writing: null },
      ctx().c,
    );
    expect(only(findings, "length-under").map((f) => [f.uid, f.locale, f.detail])).toEqual([
      ["h", undefined, { length: 2, min: 5, unit: "characters" }],
    ]);
  });

  it("reports term-avoided on word boundaries in source prose, with what to use", async () => {
    const doc = sound();
    doc.bloks.h!.data.body = prose("Our CHEAP safaris, cheapest in town");
    doc.bloks.h!.i18n!.fr!.body = prose("cheap");
    const writing = {
      voice: "Warm.",
      avoid: [{ term: "cheap", use: "good value" }, { term: "synergy" }],
    };
    const { findings } = await checkDocument(doc, brand(writing), ctx().c);
    expect(only(findings, "term-avoided")).toEqual([
      expect.objectContaining({
        uid: "h",
        field: "body",
        message: "Body uses 'cheap', which this brand avoids; use 'good value' instead.",
        detail: { term: "cheap", use: "good value" },
      }),
    ]);
    expect(only(findings, "term-avoided")[0]).not.toHaveProperty("locale");
  });

  it("reports translation-missing per locale, from translationStatus", async () => {
    const doc = sound();
    delete doc.bloks.h!.i18n!.fr!.heading;
    const { findings } = await checkDocument(doc, brand(), ctx().c);
    expect(only(findings, "translation-missing")).toEqual([
      {
        check: "translation-missing",
        severity: "info",
        message: "Heading has no fr translation.",
        uid: "h",
        type: "hero",
        field: "heading",
        locale: "fr",
        path: "body[0]",
        fix: "patch_fields",
      },
    ]);
  });

  it("narrows per-locale findings to ?locale=, keeping source findings", async () => {
    const doc = sound();
    delete doc.bloks.h!.i18n!.fr!.heading;
    delete doc.bloks.h!.i18n!.de!.heading;
    doc.bloks.root!.data.title = "";
    const fr = await checkDocument(doc, brand(), ctx({ locale: "fr" }).c);
    expect(fr.locale).toBe("fr");
    expect(only(fr.findings, "translation-missing").map((f) => f.locale)).toEqual(["fr"]);
    expect(only(fr.findings, "required-empty")).toHaveLength(1);
    const en = await checkDocument(doc, brand(), ctx({ locale: "en" }).c);
    expect(en.findings.every((f) => f.locale === undefined)).toBe(true);
  });

  it("reports an undeclared locale's overrides once, as schema drift, and nothing patch_fields would refuse", async () => {
    // Configured en/fr/de; `xx` is not. Over-long, mis-shaped and alt-less values in it
    // would each point at patch_fields, which answers `unsupported` for `xx`.
    const doc = sound();
    doc.bloks.h!.i18n!.xx = { heading: "Far too long a heading", body: 5 as unknown as Json };
    const configured = (await checkDocument(doc, brand(), ctx().c)).findings.filter(
      (f) => f.locale === "xx",
    );
    expect(configured).toEqual([
      expect.objectContaining({ check: "unknown-locale", uid: "h", field: null, fix: "schema" }),
    ]);

    // A single-locale site: the audit's own check is silent with no LocaleConfig, so the
    // check reports the drift itself, still once per code, and no locale checks fire.
    const single = sound();
    single.bloks.h!.i18n = { de: { heading: "Willkommen zu Hause" } };
    const { findings } = await checkDocument(single, brand(), ctx({ locales: undefined }).c);
    expect(findings.filter((f) => f.uid === "h" && f.locale !== undefined)).toEqual([
      expect.objectContaining({ check: "unknown-locale", locale: "de", fix: "schema" }),
    ]);
    for (const name of ["translation-missing", "translated-not-translatable", "length-over"]) {
      expect(only(findings, name)).toEqual([]);
    }
    expect(findings.every((f) => f.fix !== "patch_fields" || f.locale === undefined)).toBe(true);
  });

  it("carries the audit's checks, unknown-locale with the code in locale", async () => {
    const doc = sound();
    doc.bloks.root!.data.legacy = "kept";
    doc.bloks.h!.i18n!.xx = { heading: "?" };
    doc.bloks.root!.i18n!.fr!.slides = null;
    delete doc.bloks.s!.data.when;
    doc.bloks.z = blok("z", "gone", {}, { order: "a9" });
    doc.bloks.zc = blok("zc", "button", { label: 5, target: null }, { parent: "z", slot: "kids" });
    const { findings } = await checkDocument(doc, brand(), ctx().c);
    expect(only(findings, "orphan-key")).toEqual([
      expect.objectContaining({ uid: "root", field: "legacy", fix: "schema", severity: "warning" }),
    ]);
    expect(only(findings, "unknown-locale")).toEqual([
      expect.objectContaining({ uid: "h", field: null, locale: "xx", fix: "schema" }),
    ]);
    expect(only(findings, "missing-field")).toEqual([
      expect.objectContaining({ uid: "s", field: "when", severity: "info", fix: "patch_fields" }),
    ]);
    expect(only(findings, "unknown-type")).toEqual([
      expect.objectContaining({ uid: "z", field: null, severity: "error", fix: "write_content" }),
    ]);
    // A child of an unknown-type parent is still placed and checked.
    expect(findings.find((f) => f.uid === "z")?.path).toBe("body[1]");
    expect(only(findings, "field-shape")).toEqual([
      expect.objectContaining({ uid: "zc", field: "label", path: "body[1].kids[0]" }),
    ]);
  });

  it("can produce every audit check other than date-invalid, so an audit addition reaches the report", async () => {
    const doc = sound();
    doc.bloks.root!.data.legacy = "kept";
    doc.bloks.h!.i18n!.xx = { heading: "?" };
    doc.bloks.h!.i18n!.fr!.image = image("Un lion");
    delete doc.bloks.s!.data.when;
    doc.bloks.z = blok("z", "gone", {}, { order: "a9" });
    const { findings } = await checkDocument(doc, brand(), ctx().c);
    const produced = new Set(findings.map((f) => f.check));
    const audit = new Set(
      DOCUMENT_CHECKS.flatMap((check) =>
        Object.values(doc.bloks).flatMap((b) => check(b, schema[b.type], { locales })),
      ).map((f) => f.check),
    );
    audit.delete("date-invalid");
    expect(audit.size).toBe(DOCUMENT_CHECKS.length - 1);
    for (const name of audit) expect(produced).toContain(name);
  });

  it("skips missing-field and required-empty on a bare layer, and still reports a broken link", async () => {
    const doc = sound();
    doc.bloks.root!.data.title = "";
    delete doc.bloks.s!.data.when;
    doc.bloks.b = blok("b", "button", { label: "Go", target: link("sty_dead") }, { order: "a1" });
    const { findings } = await checkDocument(doc, brand(), ctx({ bare: true }).c);
    expect(only(findings, "missing-field")).toEqual([]);
    expect(only(findings, "required-empty")).toEqual([]);
    expect(only(findings, "link-broken")).toHaveLength(1);
  });

  it("reads every target in one call and classifies links and references by decision 11", async () => {
    const doc = sound();
    doc.bloks.b1 = blok("b1", "button", { label: "a", target: link("sty_dead") }, { order: "a1" });
    doc.bloks.b2 = blok(
      "b2",
      "button",
      { label: "b", target: link("sty_person") },
      { order: "a2" },
    );
    doc.bloks.b3 = blok("b3", "button", { label: "c", target: link("sty_draft") }, { order: "a3" });
    doc.bloks.b4 = blok("b4", "button", { label: "d", target: link("sty_live") }, { order: "a4" });
    doc.bloks.h!.i18n!.fr!.body = prose("voir", "sty_dead");
    doc.bloks.c1 = blok(
      "c1",
      "card",
      { who: "sty_page", team: ["sty_person", "sty_gone", "sty_off"] },
      {
        order: "a5",
      },
    );
    const rows = [
      row("sty_person", "person", "live"),
      row("sty_draft", "page", "draft"),
      row("sty_live", "page", "changed"),
      row("sty_page", "page", "live"),
      row("sty_off", "person", "unpublished"),
    ];
    const { c, calls } = ctx({}, rows);
    const { findings } = await checkDocument(doc, brand(), c);
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(
      new Set([
        "sty_dead",
        "sty_person",
        "sty_draft",
        "sty_live",
        "sty_page",
        "sty_gone",
        "sty_off",
      ]),
    );
    const edges = findings
      .filter((f) => /^(link|reference)-/.test(f.check))
      .map((f) => [f.check, f.uid, f.field, f.locale ?? null, f.detail]);
    expect(edges).toEqual([
      ["link-broken", "h", "body", "fr", { target: "sty_dead", reason: "missing" }],
      ["link-broken", "b1", "target", null, { target: "sty_dead", reason: "missing" }],
      ["link-broken", "b2", "target", null, { target: "sty_person", reason: "unrouted" }],
      ["reference-broken", "c1", "who", null, { target: "sty_page", reason: "type" }],
      ["reference-broken", "c1", "team", null, { target: "sty_gone", reason: "missing" }],
      ["link-unpublished", "b3", "target", null, { target: "sty_draft", state: "draft" }],
      ["reference-unpublished", "c1", "team", null, { target: "sty_off", state: "unpublished" }],
    ]);
    expect(findings.find((f) => f.uid === "b1")).toMatchObject({
      path: "body[1]",
      fix: "patch_fields",
    });
  });

  it("refuses a link target of a type the multilink does not allow", async () => {
    const narrow: SchemaIndex = {
      ...schema,
      button: {
        ...schema.button!,
        fields: {
          ...schema.button!.fields,
          target: multilink({ label: "Target", types: ["post"] }),
        },
      },
    };
    const doc = sound();
    doc.bloks.b = blok("b", "button", { label: "a", target: link("sty_page") }, { order: "a1" });
    const { findings } = await checkDocument(
      doc,
      { schema: narrow, types, writing: null },
      ctx({}, [row("sty_page", "page", "live")]).c,
    );
    expect(only(findings, "link-broken")[0]?.detail).toEqual({
      target: "sty_page",
      reason: "type",
    });
  });

  it("orders errors first, then document order, then field order, then source before locales", async () => {
    const doc = sound();
    doc.bloks.root!.data.title = "";
    doc.bloks.h!.data.heading = "Much too long";
    doc.bloks.h!.i18n!.fr!.heading = "Beaucoup trop long";
    doc.bloks.h!.i18n!.de!.heading = "Viel zu lang hier";
    doc.bloks.h!.data.image = image("");
    doc.bloks.b = blok("b", "button", { label: "x", target: link("sty_dead") }, { order: "a1" });
    delete doc.bloks.s!.data.when;
    const { findings, counts } = await checkDocument(doc, brand(), ctx().c);
    expect(findings.map((f) => [f.severity, f.check, f.uid, f.field, f.locale ?? null])).toEqual([
      ["error", "link-broken", "b", "target", null],
      ["warning", "required-empty", "root", "title", null],
      ["warning", "length-over", "h", "heading", null],
      ["warning", "length-over", "h", "heading", "fr"],
      ["warning", "length-over", "h", "heading", "de"],
      ["warning", "alt-missing", "h", "image", null],
      ["info", "missing-field", "s", "when", null],
    ]);
    expect(counts).toEqual({ error: 1, warning: 5, info: 1 });
  });

  it("caps the list at 500, errors first, with counts complete", async () => {
    const doc = sound();
    for (let i = 0; i < 600; i++) {
      doc.bloks[`x${i}`] = blok(`x${i}`, "hero", {}, { order: `a${String(i).padStart(4, "0")}` });
    }
    doc.bloks.zb = blok("zb", "button", { label: "x", target: link("sty_dead") }, { order: "b0" });
    const report = await checkDocument(doc, brand(), ctx().c);
    expect(report.findings).toHaveLength(MAX_FINDINGS);
    expect(report.truncated).toBe(true);
    expect(report.counts.info).toBe(600 * 6);
    expect(report.counts.error).toBe(1);
    expect(report.findings[0]).toMatchObject({ check: "link-broken", uid: "zb" });
  });
});
