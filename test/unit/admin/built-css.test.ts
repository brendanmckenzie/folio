import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The prebuilt admin's stylesheet (`scripts/build-admin.mjs`, run by `pnpm build`).
 *
 * The admin page links the host's own `adminCss` beside ours, so a short global
 * class like `.a` (what esbuild's minified `local-css` names are) can collide with a
 * host class in both directions. `build-admin.mjs` prefixes every module class with
 * `folio-`; this pins it on the artefact. Skipped when `dist/admin` has not been
 * built: CI and `release.mjs` build before they test.
 */
const dist = new URL("../../../dist/admin/", import.meta.url);
const built = existsSync(new URL("folio-admin.css", dist));

/** Global classes the admin's own stylesheets define on purpose, besides `folio-*`. */
const KNOWN_GLOBALS = new Set(["mono"]);

describe.skipIf(!built)("the built admin stylesheet", () => {
  const css = built ? readFileSync(new URL("folio-admin.css", dist), "utf8") : "";
  const selectors = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/url\([^)]*\)/g, "")
    .replace(/\{[^{}]*\}/g, "{}");
  const classes = [...selectors.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1] as string);

  it("holds class selectors at all", () => {
    expect(classes.length).toBeGreaterThan(100);
  });

  it("prefixes every class with folio-, bar the known globals", () => {
    const bare = [...new Set(classes)].filter(
      (c) => !c.startsWith("folio-") && !KNOWN_GLOBALS.has(c),
    );
    expect(bare).toEqual([]);
  });

  it("leaves no split chunk's stylesheet beside the entry's", () => {
    const sheets = readdirSync(dist).filter((n) => n.endsWith(".css"));
    // `folio-host.css` is a host page's stylesheet, built beside the admin's on purpose.
    expect(sheets).toEqual(["folio-admin.css", "folio-host.css"]);
  });
});

/**
 * `folio-host.css` (`platform/admin-extensions.md` decision 11): the public `--folio-*`
 * tokens in light and dark, an opt-in element layer under `body.folio-host`, and nothing
 * else. A host page links it, so a rule outside that scope would restyle the host.
 */
const hostBuilt = existsSync(new URL("folio-host.css", dist));

describe.skipIf(!hostBuilt)("the built host stylesheet", () => {
  const css = hostBuilt ? readFileSync(new URL("folio-host.css", dist), "utf8") : "";
  // The build minifies, which drops the quotes in an attribute selector.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const PUBLIC = [
    "bg-app",
    "bg-panel",
    "bg-inset",
    "bg-hover",
    "fg",
    "fg-muted",
    "fg-subtle",
    "fg-accent",
    "border",
    "border-strong",
    "ring",
    ...["ok", "warn", "danger", "accent"].flatMap((s) =>
      ["bg", "border", "fg"].map((p) => `state-${s}-${p}`),
    ),
    ...["xs", "sm", "base", "lg", "xl"].map((n) => `text-${n}`),
    ...[0, 1, 2, 3, 4, 5, 6].map((n) => `space-${n}`),
    ...["sm", "md", "lg", "full"].map((n) => `radius-${n}`),
    "font-ui",
    "font-mono",
  ];

  /** The body of the first rule whose selector is exactly `selector`, inside `from`. */
  const bodyOf = (from: string, selector: string) => {
    const start = from.indexOf(`${selector}{`);
    if (start === -1) return "";
    return from.slice(start + selector.length + 1, from.indexOf("}", start));
  };

  it("declares every public token on :root", () => {
    const root = bodyOf(bare, ":root");
    for (const name of PUBLIC) expect(root, name).toContain(`--folio-${name}:`);
  });

  it("restates the themed tokens in both dark blocks", () => {
    const media = bare.slice(bare.indexOf("@media"));
    for (const block of [
      bodyOf(media, ":root:not([data-theme=light])"),
      bodyOf(bare, "[data-theme=dark]"),
    ]) {
      for (const name of [
        "bg-app",
        "bg-panel",
        "fg",
        "fg-muted",
        "border",
        "state-ok-bg",
        "state-danger-fg",
      ]) {
        expect(block, name).toContain(`--folio-${name}:`);
      }
      expect(block).toContain("color-scheme:dark");
    }
  });

  it("publishes nothing from the scale tier, and no unprefixed token", () => {
    expect(bare).not.toMatch(/--(?:n|blue|green|amber|red)-\d+/);
    expect(bare).not.toMatch(/--(?!folio-)[a-z]/);
  });

  it("holds no rule outside :root, the dark blocks and body.folio-host", () => {
    // Selectors are what precedes each `{`, after dropping declaration bodies.
    const flat = bare.replace(/@media[^{]*\{/g, "").replace(/\}\s*\}/g, "}");
    const selectors = [...flat.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(selectors.length).toBeGreaterThan(10);
    const stray = selectors
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(
        (s) =>
          s !== ":root" &&
          s !== ":root:not([data-theme=light])" &&
          s !== "[data-theme=dark]" &&
          !s.startsWith("body.folio-host"),
      );
    expect(stray).toEqual([]);
  });
});
