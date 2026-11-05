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
    expect(sheets).toEqual(["folio-admin.css"]);
  });
});
