import { describe, expect, it } from "vitest";
import {
  asset,
  blocks,
  defineBlock,
  select,
  text,
  textarea,
  toRegistry,
  toSchemaIndex,
} from "../../../src/core";

/** `toRegistry` refuses a registry it would have to guess about (spec 34, phase 1). */

const block = (name: string) =>
  defineBlock({ name, label: name, fields: { t: text() }, render: () => null });

describe("toRegistry", () => {
  it("keys the array form by block name", () => {
    const a = block("a");
    const b = block("b");
    expect(toRegistry([a, b])).toEqual({ a, b });
  });

  it("passes a matching object form through", () => {
    const reg = { a: block("a"), b: block("b") };
    expect(toRegistry(reg)).toBe(reg);
  });

  it("throws on a repeated name in the array form", () => {
    expect(() => toRegistry([block("prose"), block("hero"), block("prose")])).toThrow(
      "folio: duplicate block 'prose'",
    );
  });

  it("throws when an object key is not its block name", () => {
    expect(() => toRegistry({ hero: block("banner") })).toThrow(
      "folio: registry key 'hero' names block 'banner'",
    );
  });
});

describe("toSchemaIndex and authoring guidance (authoring-guidance.md decision 5)", () => {
  it("carries a block's help and guidance as declared", () => {
    const hero = defineBlock({
      name: "hero",
      label: "Hero",
      help: "The first thing on a landing page.",
      guidance: { tone: "Confident.", examples: ["A safari hero"] },
      fields: {
        heading: text({
          help: "The promise.",
          length: { max: 60 },
          guidance: { tone: "Second person.", examples: ["Find your next safari"] },
        }),
      },
    });
    const index = toSchemaIndex(toRegistry([hero]));
    expect(index.hero?.help).toBe("The first thing on a landing page.");
    expect(index.hero?.guidance).toEqual({ tone: "Confident.", examples: ["A safari hero"] });
    expect(index.hero?.fields.heading).toEqual({
      kind: "text",
      help: "The promise.",
      length: { max: 60 },
      guidance: { tone: "Second person.", examples: ["Find your next safari"] },
    });
  });

  it("serialises a registry with no guidance to the same JSON as v1.3.1", () => {
    // The demo's hero as it stood at v1.3.1 (`examples/demo/src/blocks/hero.tsx`).
    const hero = defineBlock({
      name: "hero",
      label: "Hero",
      summary: "heading",
      fields: {
        eyebrow: text({
          label: "Eyebrow",
          placeholder: "Small label above the heading",
          translatable: true,
        }),
        heading: text({ label: "Heading", required: true, translatable: true }),
        body: textarea({ label: "Body", rows: 3, translatable: true }),
        image: asset({ label: "Background image", accept: "image/*" }),
        align: select({
          label: "Alignment",
          options: [
            { label: "Left", value: "left" },
            { label: "Centre", value: "center" },
          ],
        }),
        actions: blocks({ label: "Actions", allow: ["button"], max: 2 }),
      },
      render: () => null,
    });
    expect(JSON.stringify(toSchemaIndex(toRegistry([hero])))).toBe(
      '{"hero":{"name":"hero","label":"Hero","summary":"heading","fields":{"eyebrow":{"kind":"text","label":"Eyebrow","placeholder":"Small label above the heading","translatable":true},"heading":{"kind":"text","label":"Heading","required":true,"translatable":true},"body":{"kind":"textarea","label":"Body","rows":3,"translatable":true},"image":{"kind":"asset","label":"Background image","accept":"image/*"},"align":{"kind":"select","label":"Alignment","options":[{"label":"Left","value":"left"},{"label":"Centre","value":"center"}]},"actions":{"kind":"blocks","label":"Actions","allow":["button"],"max":2}}}}',
    );
    expect(Object.keys(toSchemaIndex(toRegistry([hero])).hero!)).not.toContain("help");
  });
});
