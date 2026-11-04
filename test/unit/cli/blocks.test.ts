import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, host, STARTER } from "./fixtures";
import { lib, REPO_ROOT } from "./load";

type File = { path: string; action: "create" | "edit"; before: string | null; after: string };
const { planAddBlock, applyEdits, labelOf, AddBlockRefusal } = await lib<{
  planAddBlock: (input: { module: string; name: string; label?: string; into?: string }) => {
    files: File[];
  };
  applyEdits: (
    files: File[],
    io?: { write?: (p: string, t: string) => void; remove?: (p: string) => void },
  ) => void;
  labelOf: (name: string) => string;
  AddBlockRefusal: new (...a: unknown[]) => Error & { fix: { kind: string; snippet: string }[] };
}>("blocks");
const { UsageError } = await lib<{ UsageError: new (m: string) => Error }>("args");

afterAll(cleanup);

/** A copy of a real blocks directory in a temporary host. */
function blocksDir(from: string): string {
  const root = host({ installed: null, tools: false, vite: null, wrangler: null });
  const dir = path.join(root, "src/blocks");
  mkdirSync(dir, { recursive: true });
  cpSync(from, dir, { recursive: true });
  return dir;
}

const GROUP_WEB_INDEX = `export { PreviewWrap as wrap } from "../render/PreviewWrap";
import "../../styles/global.scss";

import { ctaLink } from "./ctaLink";
import { hero } from "./hero";
import { pageRoot } from "./pageRoot";

export const blocks = [
  // The root.
  pageRoot,
  hero, // inline comment, with a ] in it
  /* a ] in a block comment */
  ctaLink,
];
`;

const SINGLE_QUOTE_INDEX = `import { hero } from './hero'
import { page } from './page'

export const blocks = [page, hero]
`;

const PAGE_ROOT = `import { blocks, defineBlock, text } from 'folio/core'

export const pageRoot = defineBlock({
  name: 'pageRoot',
  label: 'Page',
  fields: {
    title: text({ label: 'Title' }),
    body: blocks({
      label: 'Body',
      allow: [
        'hero',
        'ctaLink',
      ],
    }),
    sidebar: text({ label: 'Not a slot' }),
  },
  render: ({ body }) => <main className="it's">{body}</main>,
})
`;

describe("add block against the starter", () => {
  it("scaffolds the file, imports it, lists it last and adds it to page.body", () => {
    const dir = blocksDir(path.join(STARTER, "src/blocks"));
    const { files } = planAddBlock({
      module: path.join(dir, "index.ts"),
      name: "quote",
      into: "page.body",
    });
    expect(files.map((f) => [path.basename(f.path), f.action])).toEqual([
      ["quote.tsx", "create"],
      ["index.ts", "edit"],
      ["page.tsx", "edit"],
    ]);
    const [created, index, page] = files as [File, File, File];
    expect(created.after).toContain('export const quote = defineBlock({\n  name: "quote",');
    expect(created.after).toContain('import { defineBlock, text } from "folio/core";');
    expect(index.after).toContain(
      'import { prose } from "./prose";\nimport { quote } from "./quote";\n',
    );
    expect(index.after).toContain("  button,\n  quote,\n];");
    // Its comments, intact.
    expect(index.after).toContain("  // Content blocks.\n");
    expect(page.after).toContain('allow: ["hero", "prose", "quote"]');
    applyEdits(files);
    expect(readFileSync(path.join(dir, "quote.tsx"), "utf8")).toBe(created.after);
  });

  it("matches the starter's own file exactly but for the two added lines", () => {
    const dir = blocksDir(path.join(STARTER, "src/blocks"));
    const before = readFileSync(path.join(dir, "index.ts"), "utf8");
    const { files } = planAddBlock({ module: path.join(dir, "index.ts"), name: "travelCard" });
    const index = files[1] as File;
    expect(
      index.after
        .replace('import { travelCard } from "./travelCard";\n', "")
        .replace("  travelCard,\n", ""),
    ).toBe(before);
    expect((files[0] as File).after).toContain('label: "Travel card"');
    expect((files[0] as File).after).toContain('<section className="travel-card">');
  });
});

describe("add block against other hosts' modules", () => {
  it("handles the demo's module, with comments inside the array", () => {
    const dir = blocksDir(path.join(REPO_ROOT, "examples/demo/src/blocks"));
    const { files } = planAddBlock({
      module: path.join(dir, "index.ts"),
      name: "quote",
      into: "page.body",
    });
    expect((files[1] as File).after).toContain("  searchResults,\n  quote,\n];");
    expect((files[2] as File).after).toMatch(/"contactForm",\n {8}"quote",\n {6}\]/);
  });

  it("handles a group-web-shaped module: wrap export, side-effect import, comments with brackets", () => {
    const root = host({ installed: null, tools: false, vite: null, wrangler: null });
    const dir = path.join(root, "src/blocks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), GROUP_WEB_INDEX);
    writeFileSync(path.join(dir, "pageRoot.tsx"), PAGE_ROOT);
    const { files } = planAddBlock({
      module: path.join(dir, "index.ts"),
      name: "travelCard",
      into: "pageRoot.body",
    });
    const index = (files[1] as File).after;
    expect(index).toContain(
      'import { pageRoot } from "./pageRoot";\nimport { travelCard } from "./travelCard";\n',
    );
    expect(index).toContain("  ctaLink,\n  travelCard,\n];");
    expect(
      index.startsWith(
        'export { PreviewWrap as wrap } from "../render/PreviewWrap";\nimport "../../styles/global.scss";\n',
      ),
    ).toBe(true);
    expect((files[2] as File).after).toContain(
      "        'ctaLink',\n        'travelCard',\n      ],",
    );
  });

  it("follows single quotes and no semicolons, inline arrays included", () => {
    const root = host({ installed: null, tools: false, vite: null, wrangler: null });
    const dir = path.join(root, "src/blocks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), SINGLE_QUOTE_INDEX);
    const { files } = planAddBlock({ module: path.join(dir, "index.ts"), name: "quote" });
    expect((files[1] as File).after).toBe(`import { hero } from './hero'
import { page } from './page'
import { quote } from './quote'

export const blocks = [page, hero, quote]
`);
    const created = (files[0] as File).after;
    expect(created).toContain("import { defineBlock, text } from 'folio/core'\n");
    expect(created).toContain("  name: 'quote',");
    expect(created.trimEnd().endsWith("})")).toBe(true);
  });
});

describe("add block refusals", () => {
  const module = (text: string) => {
    const root = host({ installed: null, tools: false, vite: null, wrangler: null });
    const dir = path.join(root, "src/blocks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), text);
    return path.join(dir, "index.ts");
  };

  for (const [label, text] of [
    ["a spread", 'import { a } from "./a";\nexport const blocks = [...others, a];\n'],
    ["not an array literal", 'import { a } from "./a";\nexport const blocks = makeBlocks();\n'],
    ["no blocks export", 'import { a } from "./a";\nexport default [a];\n'],
  ] as const) {
    it(`writes nothing for ${label}, and hands back the two edits`, () => {
      const file = module(text);
      let caught: InstanceType<typeof AddBlockRefusal> | null = null;
      try {
        planAddBlock({ module: file, name: "quote" });
      } catch (err) {
        caught = err as InstanceType<typeof AddBlockRefusal>;
      }
      expect(caught).toBeInstanceOf(AddBlockRefusal);
      expect(caught?.fix.map((f) => f.snippet)).toEqual([
        'import { quote } from "./quote";',
        "quote,",
      ]);
      expect(existsSync(path.join(path.dirname(file), "quote.tsx"))).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(text);
    });
  }

  it("refuses --into a field that is not blocks()", () => {
    const root = host({ installed: null, tools: false, vite: null, wrangler: null });
    const dir = path.join(root, "src/blocks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), GROUP_WEB_INDEX);
    writeFileSync(path.join(dir, "pageRoot.tsx"), PAGE_ROOT);
    expect(() =>
      planAddBlock({ module: path.join(dir, "index.ts"), name: "quote", into: "pageRoot.sidebar" }),
    ).toThrow(/not a blocks\(\) field/);
    expect(() =>
      planAddBlock({ module: path.join(dir, "index.ts"), name: "quote", into: "nope.body" }),
    ).toThrow(AddBlockRefusal);
  });

  it("refuses a label that would break the string literal, and escapes quotes", () => {
    const dir = blocksDir(path.join(STARTER, "src/blocks"));
    const file = path.join(dir, "index.ts");
    for (const label of ["Line1\nLine2", "a\rb", "tab\there", "x\u2028y"]) {
      expect(
        () => planAddBlock({ module: file, name: "quote", label }),
        JSON.stringify(label),
      ).toThrow(UsageError);
    }
    const { files } = planAddBlock({ module: file, name: "quote", label: 'Say "hi" \\ ${x} `y`' });
    expect((files[0] as File).after).toContain('label: "Say \\"hi\\" \\\\ ${x} `y`",');
  });

  it("refuses bad names and collisions as usage errors", () => {
    const dir = blocksDir(path.join(STARTER, "src/blocks"));
    const file = path.join(dir, "index.ts");
    for (const name of ["Quote", "quote-box", "default", "1x", "class"]) {
      expect(() => planAddBlock({ module: file, name }), name).toThrow(UsageError);
    }
    // A file that exists, an imported binding, and a name another file declares.
    expect(() => planAddBlock({ module: file, name: "prose" })).toThrow(/already exists/);
    expect(() => planAddBlock({ module: file, name: "button" })).toThrow(/already imported/);
    writeFileSync(
      path.join(dir, "other.tsx"),
      'export const x = defineBlock({ name: "quote" });\n',
    );
    expect(() => planAddBlock({ module: file, name: "quote" })).toThrow(/already declares/);
  });
});

describe("add block writes everything or nothing", () => {
  it("restores the first file and removes the created one when a later write fails", () => {
    const dir = blocksDir(path.join(STARTER, "src/blocks"));
    const file = path.join(dir, "index.ts");
    const before = readFileSync(file, "utf8");
    const { files } = planAddBlock({ module: file, name: "quote", into: "page.body" });
    let writes = 0;
    expect(() =>
      applyEdits(files, {
        write: (p, t) => {
          if (++writes === 3) throw new Error("disk full");
          writeFileSync(p, t);
        },
      }),
    ).toThrow(/disk full/);
    expect(existsSync(path.join(dir, "quote.tsx"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("labels", () => {
  it("splits at capitals and sentence-cases", () => {
    expect(labelOf("travelCard")).toBe("Travel card");
    expect(labelOf("quote")).toBe("Quote");
  });
});
