import { describe, expect, it } from "vitest";
import { text } from "../../../src/core/fields";
import {
  type BlockSchema,
  type DocumentType,
  type SchemaIndex,
  uniqueFieldsOf,
  validateTypes,
} from "../../../src/core/schema";

/**
 * `text({ indexed: true, unique: true })` (issue #75): a flag the publish check can
 * only keep by reading `content_index`, so a declaration that can never be enforced is
 * refused at construction rather than left reading as a constraint.
 */

const hero: BlockSchema = { name: "hero", label: "Hero", fields: { title: text() } };
const person = (fields: BlockSchema["fields"]): BlockSchema => ({
  name: "person",
  label: "Person",
  fields,
});
const types: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "hero" },
  { name: "person", label: "Person", kind: "record", root: "person" },
];

describe("validateTypes: unique fields", () => {
  it("accepts a unique indexed text field on a document type's root", () => {
    const index: SchemaIndex = {
      hero,
      person: person({ slug: text({ indexed: true, unique: true }) }),
    };
    expect(() => validateTypes(types, index)).not.toThrow();
  });

  it("refuses unique without indexed, naming the fix", () => {
    const index: SchemaIndex = { hero, person: person({ slug: text({ unique: true }) }) };
    expect(() => validateTypes(types, index)).toThrow(
      /'slug' on 'person' is 'unique' but not an 'indexed' text field.*text\(\{ indexed: true, unique: true \}\)/,
    );
  });

  it("refuses unique on a block that is no type's root", () => {
    const card: BlockSchema = {
      name: "card",
      label: "Card",
      fields: { slug: text({ indexed: true, unique: true }) },
    };
    const index: SchemaIndex = { hero, person: person({}), card };
    expect(() => validateTypes(types, index)).toThrow(
      /'slug' on 'card' is 'unique', but 'card' is no document type's root/,
    );
  });

  it("refuses unique on a field that is not text", () => {
    const odd = {
      kind: "number",
      indexed: true,
      unique: true,
    } as unknown as BlockSchema["fields"][string];
    const index: SchemaIndex = { hero, person: person({ n: odd }) };
    expect(() => validateTypes(types, index)).toThrow(
      /'n' on 'person' is 'unique' but not an 'indexed' text field/,
    );
  });
});

describe("uniqueFieldsOf", () => {
  it("lists unique indexed text fields with their labels, falling back to the name", () => {
    const def = person({
      slug: text({ label: "Slug", indexed: true, unique: true }),
      code: text({ indexed: true, unique: true }),
      name: text({ indexed: true }),
    });
    expect(uniqueFieldsOf(def)).toEqual([
      ["slug", "Slug"],
      ["code", "code"],
    ]);
    expect(uniqueFieldsOf(undefined)).toEqual([]);
  });
});
