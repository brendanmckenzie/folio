import { describe, expect, it } from "vitest";
import type { Json } from "../../../src/core/doc";
import {
  asset,
  blocks,
  boolean,
  type Field,
  isBlankValue,
  multiasset,
  number,
  references,
  richtext,
  text,
  textarea,
} from "../../../src/core/fields";
import {
  lengthMessage,
  lengthProblem,
  measureText,
  validateGuidance,
} from "../../../src/core/guidance";
import { isEmptySource } from "../../../src/core/locales";
import type { BlockSchema, SchemaIndex } from "../../../src/core/schema";
import { isBlank } from "../../../src/admin/ui/screens/inspector-model";

/**
 * The advisory length measure and the construction-time guidance check
 * (`docs/specs/content-model/authoring-guidance.md` decisions 2 to 4, 15, 16).
 */

const prose = (text: string): Json =>
  ({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Two words" }] },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: text,
            marks: [{ type: "link", attrs: { href: "https://x.test" } }],
          },
        ],
      },
    ],
  }) as unknown as Json;

describe("measureText", () => {
  it("counts code points after trimming, for text and textarea", () => {
    expect(measureText(text(), "  Hello  ")).toBe(5);
    expect(measureText(textarea(), "a\nb")).toBe(3);
  });

  it("counts an emoji as its code points, and a CJK string per character", () => {
    // Waving hand + medium skin tone: two code points, one grapheme.
    expect(measureText(text(), "👋🏽")).toBe(2);
    expect(measureText(text(), "東京の旅")).toBe(4);
  });

  it("counts runs of non-whitespace as words", () => {
    const f = text({ length: { max: 5, unit: "words" } });
    expect(measureText(f, "  find   your\tnext safari ")).toBe(4);
    // Words split on whitespace undercount languages that do not use it.
    expect(measureText(f, "東京の旅")).toBe(1);
  });

  it("measures richtext over its plain text, so marks and links add nothing", () => {
    expect(measureText(richtext({ length: { max: 9, unit: "words" } }), prose("one two"))).toBe(4);
    expect(measureText(richtext(), prose("ab"))).toBe("Two words ab".length);
  });

  it("answers null for an empty value or an unmeasured kind", () => {
    expect(measureText(text(), "   ")).toBeNull();
    expect(measureText(text(), null)).toBeNull();
    expect(measureText(richtext(), { type: "doc", content: [] } as unknown as Json)).toBeNull();
    expect(measureText(number(), 12)).toBeNull();
  });
});

describe("lengthProblem", () => {
  const heading = text({ label: "Heading", length: { min: 10, max: 20 } });

  it("answers over and under with the length, the limit and the unit", () => {
    expect(lengthProblem(heading, "x".repeat(21))).toEqual({
      kind: "over",
      length: 21,
      limit: 20,
      unit: "characters",
    });
    expect(lengthProblem(heading, "short")).toEqual({
      kind: "under",
      length: 5,
      limit: 10,
      unit: "characters",
    });
    expect(lengthProblem(heading, "x".repeat(15))).toBeNull();
  });

  it("answers null for an empty value, so a min never doubles up with required-empty", () => {
    expect(lengthProblem(heading, "")).toBeNull();
    expect(lengthProblem(heading, null)).toBeNull();
  });

  it("answers null for a field with no length", () => {
    expect(lengthProblem(text(), "x".repeat(5000))).toBeNull();
  });

  it("reads as one sentence naming the label", () => {
    const over = lengthProblem(heading, "x".repeat(74))!;
    expect(lengthMessage("Heading", over)).toBe("Heading is 74 characters; the limit is 20.");
    const one = lengthProblem(text({ length: { min: 3, unit: "words" } }), "hi")!;
    expect(lengthMessage("Title", one)).toBe("Title is 1 word; the minimum is 3.");
  });
});

describe("validateGuidance", () => {
  const index = (fields: Record<string, Field>, extra: Partial<BlockSchema> = {}): SchemaIndex => ({
    hero: { name: "hero", label: "Hero", fields, ...extra },
  });
  const refuses = (schema: SchemaIndex, message: string | RegExp) =>
    expect(() => validateGuidance(schema)).toThrow(message);

  it("accepts every valid shape", () => {
    expect(() =>
      validateGuidance(
        index(
          {
            heading: text({
              help: "The promise.",
              length: { min: 0, max: 60 },
              guidance: { tone: "Second person.", examples: ["Find your next safari"] },
            }),
            body: textarea({ length: { max: 40, unit: "words" } }),
            prose: richtext({ length: { min: 1 } }),
            image: asset({ decorative: true }),
            gallery: multiasset({ decorative: false }),
            cards: blocks({ allow: ["card"], guidance: { tone: "Two to four, each a benefit." } }),
          },
          { help: "The first thing on a landing page.", guidance: { examples: ["A safari hero"] } },
        ),
      ),
    ).not.toThrow();
  });

  it("refuses a length on a kind it means nothing on, for a JS host the types cannot stop", () => {
    refuses(
      index({ count: { kind: "number", length: { max: 5 } } as unknown as Field }),
      "folio: block 'hero' field 'count': 'length' is for text, textarea and richtext, not number",
    );
  });

  it("refuses a malformed length, naming the key", () => {
    refuses(index({ h: text({ length: { min: 10, max: 5 } }) }), /'length.max' \(5\) is below/);
    refuses(index({ h: text({ length: { max: 0 } }) }), /'length.max' must be a whole number/);
    refuses(index({ h: text({ length: { min: -1 } }) }), /'length.min' must be a whole number/);
    refuses(index({ h: text({ length: { max: 2.5 } }) }), /'length.max'/);
    refuses(
      index({ h: text({ length: { unit: "letters" } } as never) }),
      /'length.unit' must be "characters" or "words"/,
    );
  });

  it("refuses guidance over its caps, naming the block and the field", () => {
    refuses(
      index({ h: text({ guidance: { examples: Array.from({ length: 11 }, () => "x") } }) }),
      "folio: block 'hero' field 'h': 'guidance.examples' must be an array of at most 10 strings",
    );
    refuses(index({ h: text({ guidance: { examples: [""] } }) }), /'guidance.examples\[\]'/);
    refuses(index({ h: text({ guidance: { tone: "x".repeat(501) } }) }), /'guidance.tone'/);
    refuses(
      index({ h: text({ guidance: { purpose: "x" } as never }) }),
      /unknown 'guidance.purpose'/,
    );
    refuses(index({}, { help: "x".repeat(501) }), "folio: block 'hero': 'help' must be");
    refuses(index({}, { guidance: { tone: 4 } as never }), /block 'hero': 'guidance.tone'/);
  });

  it("refuses decorative off an image kind", () => {
    refuses(
      index({ h: { kind: "text", decorative: true } as unknown as Field }),
      /'decorative' is for asset and multiasset, not text/,
    );
  });

  it("accepts a very long existing field help, which this spec does not cap", () => {
    expect(() => validateGuidance(index({ h: text({ help: "x".repeat(2000) }) }))).not.toThrow();
  });
});

describe("isBlankValue (decision 15)", () => {
  it("treats false and 0 as values", () => {
    expect(isBlankValue(boolean(), false)).toBe(false);
    expect(isBlankValue(number(), 0)).toBe(false);
  });

  it("treats whitespace, an empty richtext document and an empty array as blank", () => {
    expect(isBlankValue(text(), "  ")).toBe(true);
    expect(isBlankValue(richtext(), { type: "doc", content: [] } as unknown as Json)).toBe(true);
    expect(isBlankValue(references(), [])).toBe(true);
    expect(isBlankValue(text(), undefined)).toBe(true);
    expect(isBlankValue(text(), "x")).toBe(false);
  });

  it("treats an image-only or embed-only richtext as content, and a rule as content", () => {
    const doc = (...content: unknown[]) => ({ type: "doc", content }) as unknown as Json;
    expect(isBlankValue(richtext(), doc({ type: "image", attrs: { src: "x.png" } }))).toBe(false);
    expect(isBlankValue(richtext(), doc({ type: "blok", attrs: {} }))).toBe(false);
    expect(isBlankValue(richtext(), doc({ type: "horizontalRule" }))).toBe(false);
    expect(isBlankValue(richtext(), doc({ type: "paragraph" }, { type: "heading" }))).toBe(true);
    expect(
      isBlankValue(
        richtext(),
        doc({
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
        }),
      ),
    ).toBe(true);
  });

  it("is the one rule: the translation walk and the inspector read the same function", () => {
    expect(isEmptySource).toBe(isBlankValue);
    expect(isBlank).toBe(isBlankValue);
  });
});
