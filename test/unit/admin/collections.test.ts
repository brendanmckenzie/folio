import { describe, expect, it } from "vitest";
import { select, text } from "../../../src/core/fields";
import { queryToParams } from "../../../src/core/query";
import type { SchemaIndex } from "../../../src/core/schema";
import {
  filterField,
  filterValue,
  sortLabel,
  withFilter,
} from "../../../src/admin/ui/screens/fields/CollectionField";

/**
 * The admin half of collections (`collections.md` decision 5, phase 3 and 4).
 *
 * The pure pieces of the admin's collection field: filter helpers and the query's
 * wire encoding. (The fetching hook went when the server began building the
 * editor's resolution, `useServerResolution`.)
 *
 * The three filter helpers moved with the field: `admin/CollectionInput.tsx` became
 * `admin/ui/screens/fields/CollectionField.tsx` in port phase 7b, which carried them
 * over unchanged, and phase 8 deleted the original. `StoryTree.tsx`'s `visibleAt` and
 * `LEVEL_LIMIT` were tested here too and did **not** move — the rebuilt tree pages a
 * level server-side with `Show 25 more` rather than truncating a whole level it has
 * already fetched, so `content-model.ts`'s `Level` replaces both and
 * `ui-content-model.test.ts` covers it.
 */

const schema: SchemaIndex = {
  insightRoot: {
    name: "insightRoot",
    label: "Insight",
    fields: {
      topic: select({
        label: "Topic",
        options: [{ label: "Policy", value: "policy" }],
        indexed: true,
      }),
      // Same name, no `indexed`: must not be what the lookup finds.
      subtitle: text({ label: "Subtitle" }),
    },
  },
  page: { name: "page", label: "Page", fields: { topic: text({ label: "Wrong one" }) } },
};

describe("filterField", () => {
  it("finds the INDEXED declaration of a name, not merely the first one", () => {
    // `page.topic` is declared first in a real object-order sense but is not
    // indexed, so it is not what a filter is about.
    expect(filterField(schema, "topic")?.label).toBe("Topic");
    expect(filterField(schema, "subtitle")).toBeUndefined();
    expect(filterField(schema, "nothing")).toBeUndefined();
  });
});

describe("sortLabel", () => {
  it("names `relevance` (full-text-search.md decision 10), not the raw key", () => {
    // Reachable in the dropdown only when the field declares `searchable: true`
    // (`CollectionField.tsx`'s `orderable`) — the label just has to read well
    // once it is there.
    expect(sortLabel(schema, "relevance")).toBe("Best match");
  });
});

describe("withFilter / filterValue", () => {
  it("replaces one filter and leaves the rest alone", () => {
    const before = {
      where: [
        { field: "topic", op: "eq" as const, value: "ai" },
        { field: "featured", op: "eq" as const, value: "true" },
      ],
    };
    const after = withFilter(before, "topic", "policy");
    expect(after.where).toEqual([
      { field: "featured", op: "eq", value: "true" },
      { field: "topic", op: "eq", value: "policy" },
    ]);
  });

  it('removes the filter entirely for "any", rather than storing an empty value', () => {
    const after = withFilter({ where: [{ field: "topic", op: "eq", value: "ai" }] }, "topic", "");
    expect(after.where).toEqual([]);
    expect(filterValue(after, "topic")).toBe("");
  });

  it("reads back the current choice", () => {
    expect(filterValue({ where: [{ field: "topic", op: "eq", value: "ai" }] }, "topic")).toBe("ai");
    expect(filterValue({}, "topic")).toBe("");
  });
});

describe("queryToParams", () => {
  it("spells a query exactly as GET /folio/api/content reads it", () => {
    const params = queryToParams(
      {
        type: "insight",
        where: [{ field: "topic", op: "eq", value: "policy" }],
        order: { field: "published", dir: "desc" },
        perPage: 6,
        page: 2,
      },
      6,
    );
    expect(params.get("type")).toBe("insight");
    expect(params.getAll("where")).toEqual(["topic:eq:policy"]);
    expect(params.get("order")).toBe("published:desc");
    expect(params.get("perPage")).toBe("6");
    expect(params.get("page")).toBe("2");
  });

  it("spells an `in` list with commas, and a top-level parent as empty", () => {
    expect(
      queryToParams({ where: [{ field: "t", op: "in", value: ["a", "b"] }] }).getAll("where"),
    ).toEqual(["t:in:a,b"]);
    expect(queryToParams({ parent: null }).get("parent")).toBe("");
    expect(queryToParams({}).has("parent")).toBe(false);
  });
});
