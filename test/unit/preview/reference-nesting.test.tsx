/**
 * `reference.content` resolves the target's own references (issue #89). `docs` is
 * no longer emptied on the way down, so what stops a cycle rendering until the
 * stack gives out is the trail of ids `referenceContent` threads through.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defineRecord, references, text, toRegistry } from "../../../src/core";
import type { Blok, Doc, Json } from "../../../src/core/doc";
import { buildResolution, type Resolution } from "../../../src/core/resolve";
import type { StoryMeta } from "../../../src/core/story";
import { FolioDoc } from "../../../src/preview/Render";

/**
 * Without the trail a cycle never returns (React walks it iteratively, so there is
 * no stack overflow to catch), and a hung test cannot report anything. Every render
 * of `person` is counted, and past a generous bound it throws so the failure is red.
 */
let renders = 0;
const TRIPWIRE = 100;

const person = defineRecord({
  name: "person",
  label: "Person",
  summary: "name",
  fields: { name: text(), friends: references({ types: ["person"] }) },
  render: ({ name, friends }) => {
    if (++renders > TRIPWIRE) throw new Error("unbounded reference.content recursion");
    return (
      <div className="p" data-name={name}>
        {friends.map((f) => (
          <span key={f.id} className="f">
            {String(f.data.name)}
            {f.content}
          </span>
        ))}
      </div>
    );
  },
});

const registry = toRegistry([person]);

const story = (id: string): StoryMeta => ({
  id,
  type: "person",
  parentId: null,
  slug: id,
  path: null,
  ord: "a0",
  title: id,
  publishedAt: null,
  unpublishedAt: null,
  draftSyncId: 0,
  draftUpdatedAt: null,
  publishedSyncId: 0,
  updatedAt: 0,
  state: "draft",
  hasUnpublishedChanges: false,
});

const doc = (uid: string, data: Record<string, Json>): Doc => {
  const blok: Blok = { uid, type: "person", parent: null, slot: null, order: "a0", data };
  return { root: uid, bloks: { [uid]: blok } };
};

const render = (page: Doc, resolution: Resolution) => {
  renders = 0;
  return renderToStaticMarkup(<FolioDoc doc={page} registry={registry} resolution={resolution} />);
};

const count = (markup: string, needle: string) => markup.split(needle).length - 1;

describe("reference.content resolves the target's own references", () => {
  it("renders a second-hop target inside the first", () => {
    const resolution: Resolution = {
      ...buildResolution([story("b"), story("c")]),
      docs: {
        b: doc("bb", { name: "B", friends: ["c"] }),
        c: doc("cc", { name: "C", friends: [] }),
      },
    };
    const markup = render(doc("pp", { name: "A", friends: ["b"] }), resolution);
    expect(markup).toContain('data-name="B"');
    // C is B's friend: present only because B's own `friends` resolved.
    expect(markup).toContain('data-name="C"');
  });

  it("stops a cycle (A, B, A) instead of recursing, and renders each document once per path", () => {
    const resolution: Resolution = {
      ...buildResolution([story("a"), story("b")]),
      docs: {
        a: doc("aa", { name: "A", friends: ["b"] }),
        b: doc("bb", { name: "B", friends: ["a"] }),
      },
    };
    // The page is A itself, reached again as B's friend.
    const markup = render(doc("aa", { name: "A", friends: ["b"] }), resolution);
    expect(count(markup, 'data-name="B"')).toBe(1);
    expect(count(markup, 'data-name="A"')).toBe(2);
  });

  it("stops a document that references itself", () => {
    const resolution: Resolution = {
      ...buildResolution([story("s")]),
      docs: { s: doc("ss", { name: "S", friends: ["s"] }) },
    };
    const markup = render(doc("pp", { name: "P", friends: ["s"] }), resolution);
    expect(count(markup, 'data-name="S"')).toBe(1);
  });

  it("leaves a third hop unresolved when it was never loaded", () => {
    const resolution: Resolution = {
      ...buildResolution([story("b"), story("c"), story("d")]),
      docs: {
        b: doc("bb", { name: "B", friends: ["c"] }),
        c: doc("cc", { name: "C", friends: ["d"] }),
      },
    };
    const markup = render(doc("pp", { name: "A", friends: ["b"] }), resolution);
    expect(markup).toContain('data-name="C"');
    expect(markup).not.toContain('data-name="D"');
  });
});
