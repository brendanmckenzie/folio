import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SUITE = join(import.meta.dirname, "../../evals/media.describe");
// A variable specifier: the suite is plain JavaScript and has no declarations.
const { score } = (await import(/* @vite-ignore */ join(SUITE, "score.mjs"))) as {
  score: (
    output: unknown,
    expected: unknown,
    input?: unknown,
  ) => { pass: boolean; metrics: Record<string, number> };
};

const expected = {
  tags: ["Animals", "Dogs"],
  mustMention: [["dog", "puppy"]],
  decorative: false,
};
const input = {
  tags: ["Animals", "Dogs", "Food"].map((name) => ({ id: name.toLowerCase(), name })),
};

describe("media.describe score", () => {
  it("passes a good answer", () => {
    const r = score(
      {
        alt: "A small dog trotting across a woodchip park.",
        description: "A husky mix.",
        tags: ["dogs", "Animals"],
      },
      expected,
      input,
    );
    expect(r.pass).toBe(true);
    expect(r.metrics.tagF1).toBe(1);
  });

  it("fails a missing fact, a wrong tag set, an invented tag and a bad alt", () => {
    const good = { alt: "A dog in a park.", description: "", tags: ["Animals", "Dogs"] };
    expect(score({ ...good, alt: "A creature in a park." }, expected, input).pass).toBe(false);
    expect(score({ ...good, tags: ["Food"] }, expected, input).pass).toBe(false);
    expect(
      score({ ...good, tags: ["Animals", "Dogs", "Hounds"] }, expected, input).metrics.inventedTags,
    ).toBe(1);
    expect(score({ ...good, alt: "Photo of a dog in a park." }, expected, input).pass).toBe(false);
    expect(score({ ...good, alt: "A dog. It runs." }, expected, input).pass).toBe(false);
    expect(score({ ...good, alt: "" }, expected, input).pass).toBe(false);
    expect(score(null, expected, input).pass).toBe(false);
  });

  it("requires an empty answer where nothing applies", () => {
    const none = { tags: [], mustMention: [["kitchen"]], decorative: false };
    expect(score({ alt: "A kitchen.", tags: [] }, none).pass).toBe(true);
    expect(score({ alt: "A kitchen.", tags: ["Food"] }, none).pass).toBe(false);
  });

  it("does not require alt text for a decorative image", () => {
    const decorative = { tags: [], mustMention: [], decorative: true };
    expect(score({ tags: [] }, decorative).pass).toBe(true);
  });

  it("scores every committed gold answer as a well-formed case", () => {
    const cases = join(SUITE, "cases");
    for (const name of readdirSync(cases)) {
      const exp = JSON.parse(readFileSync(join(cases, name, "expected.json"), "utf8"));
      const inp = JSON.parse(readFileSync(join(cases, name, "input.json"), "utf8"));
      const names = inp.tags.map((t: { name: string }) => t.name);
      for (const tag of exp.tags) expect(names, `${name}: gold tag ${tag}`).toContain(tag);
      expect(inp.tags.length === 0 || (inp.tags.length >= 12 && inp.tags.length <= 20), name).toBe(
        true,
      );
    }
  });
});
