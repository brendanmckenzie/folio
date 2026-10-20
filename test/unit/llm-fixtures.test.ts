import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Eval fixtures live in a public repository (Operate D2): CC0 or public-domain
 * photographs only, every source and licence recorded, and nothing that looks
 * like personal data. `evals/.denylist` holds terms that must never appear.
 */
const ROOT = join(import.meta.dirname, "../..");
const EVALS = join(ROOT, "evals");
const suites = readdirSync(EVALS).filter((n) => statSync(join(EVALS, n)).isDirectory());

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const denylist = readFileSync(join(EVALS, ".denylist"), "utf8")
  .split("\n")
  .map((l) => l.trim().toLowerCase())
  .filter((l) => l !== "" && !l.startsWith("#"));

describe("eval fixtures", () => {
  it("has at least one suite", () => {
    expect(suites.length).toBeGreaterThan(0);
  });

  for (const suite of suites) {
    describe(suite, () => {
      const dir = join(EVALS, suite);

      it("carries no address, phone number or denied term in any text file", () => {
        for (const file of files(dir)) {
          if (!/\.(json|md|mjs|txt)$/.test(file)) continue;
          const text = readFileSync(file, "utf8");
          const rel = file.slice(ROOT.length + 1);
          for (const email of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
            expect(email, `${rel}: email address`).toMatch(/@example\.(invalid|com)$/);
          }
          // URLs and ISO dates are digit-and-hyphen runs that are not phone numbers.
          const bare = text.replace(/https?:\/\/\S+/g, "").replace(/\d{4}-\d{2}-\d{2}/g, "");
          expect(bare, `${rel}: phone number`).not.toMatch(
            /(?<![\d.])\+?\d[\d ()-]{8,}\d(?![\d.])/,
          );
          for (const term of denylist) {
            expect(text.toLowerCase(), `${rel}: denied term "${term}"`).not.toContain(term);
          }
        }
      });

      it("records a CC0 or public-domain source for every case, and ships small images", () => {
        const sources: { case: string; licence: string; url: string }[] = JSON.parse(
          readFileSync(join(dir, "suite.json"), "utf8"),
        ).sources;
        const cases = readdirSync(join(dir, "cases"));
        expect(sources.map((s) => s.case).sort()).toEqual([...cases].sort());
        for (const s of sources) {
          expect(s.licence, s.case).toMatch(/^(CC0|Public domain)/);
          expect(s.url, s.case).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
        }
        for (const c of cases) {
          const image = join(dir, "cases", c, "image.webp");
          expect(existsSync(image), `${c} image`).toBe(true);
          expect(statSync(image).size, `${c} image size`).toBeLessThan(150 * 1024);
        }
      });
    });
  }
});
