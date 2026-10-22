import { describe, expect, it } from "vitest";
import { resolutionSignature, resolutionUrl } from "../../../src/admin/hooks/useServerResolution";
import type { Doc } from "../../../src/core/doc";
import type { BlockSchema, SchemaIndex } from "../../../src/core/schema";

/**
 * What decides whether the editor asks the server for its resolution again. The claim
 * under test is "never per keystroke": a text edit must leave the signature alone, and
 * anything the server's resolution is built from must move it.
 */

const linky: BlockSchema = {
  name: "linky",
  label: "Linky",
  fields: {
    title: { kind: "text" },
    cta: { kind: "multilink" },
    author: { kind: "reference" },
    signup: { kind: "form" },
  },
};
const index: SchemaIndex = { linky };

const one = (data: Record<string, unknown>): Doc => ({
  root: "r",
  bloks: {
    r: {
      uid: "r",
      type: "linky",
      parent: null,
      slot: null,
      order: "a0",
      data: data as Doc["bloks"][string]["data"],
    },
  },
});

describe("resolutionSignature", () => {
  it("is empty with no document", () => {
    expect(resolutionSignature(null, index)).toBe("");
  });

  it("does not move when only a text value changes", () => {
    const a = resolutionSignature(one({ title: "He", cta: { kind: "story", id: "s1" } }), index);
    const b = resolutionSignature(one({ title: "Hello", cta: { kind: "story", id: "s1" } }), index);
    expect(b).toBe(a);
  });

  it("moves when a link, a reference or a form is added", () => {
    const base = resolutionSignature(one({ title: "x" }), index);
    const link = resolutionSignature(one({ cta: { kind: "story", id: "s1" } }), index);
    const ref = resolutionSignature(one({ author: "s2" }), index);
    const embedded = resolutionSignature(one({ signup: "frm_1" }), index);
    expect(new Set([base, link, ref, embedded]).size).toBe(4);
  });

  it("moves with the locale and with the story's place in the tree", () => {
    const d = one({ author: "s2" });
    const source = resolutionSignature(d, index);
    expect(resolutionSignature(d, index, { locale: { code: "fr", fallbacks: [] } })).not.toBe(
      source,
    );
    expect(resolutionSignature(d, index, { place: "a/b" })).not.toBe(source);
  });
});

describe("resolutionUrl", () => {
  it("is the admin's own mount, with the pane site and locale as query", () => {
    expect(resolutionUrl("/folio/api", "sty_1")).toBe("/folio/api/story/sty_1/resolution");
    expect(resolutionUrl("/folio/~alpha/api", "sty_1", { site: "bravo", locale: "fr" })).toBe(
      "/folio/~alpha/api/story/sty_1/resolution?locale=fr&site=bravo",
    );
  });
});
