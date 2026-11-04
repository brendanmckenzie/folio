import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `Menu` items hold their content, and the list fits the viewport (#138).
 *
 * `.item` had `height: var(--row-h)` with `align-items: center`, so the form builder's
 * two-line items (label plus hint) overflowed into their neighbours, and the list had
 * no cap, so fourteen of them ran off a short screen. Source-text assertions because
 * the admin's suite mounts nothing; see scroll-regions.test.ts.
 */

const css = readFileSync(
  new URL("../../../src/admin/ui/Menu.module.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const rule = (selector: string) => {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/\./g, "\\.")} \\{`));
  expect(at, `${selector} is gone`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("Menu", () => {
  it("lets an item grow past one row", () => {
    const item = rule(".item");
    expect(item).toContain("min-height: var(--row-h)");
    expect(item).not.toMatch(/(^|[\s;])height:/);
  });

  it("caps the list and scrolls it, never against a percentage", () => {
    const list = rule(".list");
    expect(list).toMatch(/max-height: var\(--menu-max-h, /);
    expect(list).not.toMatch(/max-height:[^;]*%/);
    expect(list).toContain("overflow-y: auto");
  });
});
