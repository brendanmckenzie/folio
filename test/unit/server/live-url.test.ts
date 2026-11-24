import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import type { Doc } from "../../../src/core/doc";
import type { DocumentType } from "../../../src/core/schema";
import { liveUrlFor, safeLiveUrl, validateLiveUrls } from "../../../src/server/live-url";

/**
 * `liveUrls` in the server config (`record-live-url.md`): the check on what the host's
 * function answers, the gate on which record may have a link, construction-time
 * validation, and the guarantee that the function is not in the browser bundle.
 */

const postType: DocumentType = { name: "post", label: "Posts", kind: "record", root: "luPost" };
const pageType: DocumentType = { name: "page", label: "Page", kind: "page", root: "luPage" };
const postUrl = ({ slug, date }: Readonly<Record<string, unknown>>) =>
  `/posts/${String(date).slice(0, 4)}/${slug}`;

const docOf = (data: Record<string, string>): Doc => ({
  root: "r",
  bloks: { r: { uid: "r", type: "luPost", parent: null, slot: null, order: "a0", data } },
});
const published = docOf({ slug: "hello", date: "2026-03-04" });

describe("safeLiveUrl", () => {
  it("keeps a same-site path exactly as written", () => {
    expect(safeLiveUrl("/posts/2026/hello")).toBe("/posts/2026/hello");
    expect(safeLiveUrl("/posts/2026/hello/?a=1#x")).toBe("/posts/2026/hello/?a=1#x");
    expect(safeLiveUrl("/")).toBe("/");
    expect(safeLiveUrl("/posts/a.b/..c/d..")).toBe("/posts/a.b/..c/d..");
    expect(safeLiveUrl("/posts/2026/hello/")).toBe("/posts/2026/hello/");
    expect(safeLiveUrl("/posts/a?x=../b#../c")).toBe("/posts/a?x=../b#../c");
  });

  it.each([
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["data:text/html,x"],
    ["https://evil.example/x"],
    ["//evil.example/x"],
    ["/\\evil.example"],
    ["/\\/evil.example"],
    ["posts/2026/hello"],
    ["?a=1"],
    [""],
    [" /posts"],
    ["/posts/a b"],
    ["/posts/\n"],
    ["/posts/\u0000"],
    ["/posts/2026/../../folio/api/me"],
    ["/posts/2026/%2e%2e/%2E%2e/folio/api/me"],
    ["/posts/./x"],
    ["/posts/%2e/x"],
    ["/posts/.%2E/x"],
    ["/posts/..?x=1"],
    ["/.//evil.example"],
    ["/..//evil.example"],
    ["/posts//x"],
    ["/%2F/evil.example"],
    ["/%5Cevil.example"],
    ["/posts/%09x"],
    ["/" + "a".repeat(3000)],
  ])("refuses %j", (value) => {
    expect(safeLiveUrl(value)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{}], [["/a"]], [Promise.resolve("/a")]])(
    "refuses a non-string (%j)",
    (value) => {
      expect(safeLiveUrl(value)).toBeNull();
    },
  );
});

describe("liveUrlFor", () => {
  it.each(["live", "changed"] as const)(
    "answers for a %s record, from the published data",
    (state) => {
      expect(liveUrlFor(postUrl, { state }, published)).toBe("/posts/2026/hello");
    },
  );

  it.each(["draft", "unpublished"] as const)("answers nothing for a %s record", (state) => {
    expect(liveUrlFor(postUrl, { state }, published)).toBeNull();
  });

  it("answers nothing without a published document or a function", () => {
    expect(liveUrlFor(postUrl, { state: "live" }, undefined)).toBeNull();
    expect(liveUrlFor(undefined, { state: "live" }, published)).toBeNull();
  });

  it("treats a throwing function as no link", () => {
    const boom = () => {
      throw new Error("nope");
    };
    expect(liveUrlFor(boom, { state: "live" }, published)).toBeNull();
  });

  it.each(["javascript:alert(1)", "https://evil.example", "//evil.example", null, undefined])(
    "refuses an unsafe or empty answer (%j)",
    (answer) => {
      expect(liveUrlFor(() => answer, { state: "live" }, published)).toBeNull();
    },
  );

  it("refuses a published slug that walks out of the path", () => {
    const evil = docOf({ slug: "../../folio/api/me", date: "2026-01-01" });
    expect(liveUrlFor(postUrl, { state: "live" }, evil)).toBeNull();
  });
});

describe("validateLiveUrls", () => {
  const types = [pageType, postType];

  it("is empty for none, and keeps a valid entry", () => {
    expect(validateLiveUrls(undefined, types).size).toBe(0);
    expect(validateLiveUrls({ post: postUrl }, types).get("post")).toBe(postUrl);
  });

  it("refuses an unknown type, a page, a non-function and a non-object", () => {
    expect(() => validateLiveUrls({ nope: postUrl }, types)).toThrow(/not declared/);
    expect(() => validateLiveUrls({ page: postUrl }, types)).toThrow(/is for a record/);
    expect(() => validateLiveUrls({ post: "/x" as never }, types)).toThrow(/must be a function/);
    expect(() => validateLiveUrls([] as never, types)).toThrow(/keyed by record type name/);
  });
});

describe("the browser bundle", () => {
  // A block definition reaches `folio-preview.js` (the generated entry imports the host's
  // blocks module), which is why `liveUrl` is not on one. The entry is `mountPreview` plus
  // that module and nothing from `createFolio`'s config, so the server's own
  // `liveUrls` code must not be in what it bundles.
  it("does not contain a liveUrls function or the code that runs it", async () => {
    const result = await build({
      stdin: {
        contents: [
          `import { mountPreview } from "./src/preview/mount.tsx"`,
          `import * as m from "virtual:blocks"`,
          `mountPreview(m.blocks, {})`,
        ].join("\n"),
        resolveDir: process.cwd(),
        loader: "ts",
      },
      plugins: [
        {
          name: "virtual",
          setup(b) {
            b.onResolve({ filter: /^virtual:blocks$/ }, () => ({
              path: "blocks",
              namespace: "v",
            }));
            b.onLoad({ filter: /.*/, namespace: "v" }, () => ({
              contents: `import { defineRecord, text } from "./src/core/index.ts"
export const blocks = [defineRecord({ name: "luPost", label: "Post", fields: { slug: text() } })]`,
              resolveDir: process.cwd(),
              loader: "ts",
            }));
          },
        },
      ],
      bundle: true,
      write: false,
      minify: false,
      format: "esm",
      platform: "browser",
      external: ["react", "react-dom", "react-dom/*", "react/*"],
      logLevel: "silent",
      loader: { ".css": "empty" },
    });
    const code = result.outputFiles[0]?.text ?? "";
    expect(code.length).toBeGreaterThan(1000);
    for (const needle of ["safeLiveUrl", "validateLiveUrls", "live-url.invalid"]) {
      expect(code).not.toContain(needle);
    }
  });
});
