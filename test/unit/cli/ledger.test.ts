import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lib, REPO_ROOT } from "./load";

/**
 * The cross-check `upgrade-ledger.json` exists on the strength of (spec 41
 * decision 8): the ledger, `migrations/` and `UPGRADING.md`'s release headings
 * are three records of one history, and a PR that changes one without the
 * others fails here rather than shipping a plan older than the prose.
 */

type Release = {
  version: string;
  date?: string;
  rollback: "safe" | "conditional" | "none";
  migrations: string[];
  headings: string[];
  requiresDeployed?: string;
};
type After =
  | { kind: "reindex"; drafts?: boolean }
  | { kind: "manual"; text: string; heading: string };
type Ledger = {
  schema: string;
  migrations: Record<string, { release: string; apply: string; after?: After[] }>;
  claimed: { file: string; rule: string; heading: string }[];
  releases: Release[];
};

const { readLedger } = await lib<{ readLedger: (root: string) => Ledger }>("ledger");
const { releaseHeadings, headings, slug } = await lib<{
  releaseHeadings: (md: string, version: string) => string[];
  headings: (md: string) => { level: number; text: string }[];
  slug: (heading: string) => string;
}>("upgrading");
const { compare } = await lib<{ compare: (a: string, b: string) => number }>("semver");

const ledger = readLedger(REPO_ROOT);
const upgrading = readFileSync(path.join(REPO_ROOT, "UPGRADING.md"), "utf8");
const shipped = readdirSync(path.join(REPO_ROOT, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const allHeadings = new Set(headings(upgrading).map((h) => h.text));

describe("upgrade-ledger.json against migrations/", () => {
  it("names every shipped migration exactly once, and nothing that is not shipped", () => {
    expect(Object.keys(ledger.migrations).sort()).toEqual(shipped);
  });

  it("lists no claimed file that has landed", () => {
    for (const c of ledger.claimed)
      expect(existsSync(path.join(REPO_ROOT, "migrations", c.file))).toBe(false);
  });

  it("gives every migration a listed release, and each release exactly its own", () => {
    const versions = ledger.releases.map((r) => r.version);
    for (const [file, m] of Object.entries(ledger.migrations)) {
      expect(versions, file).toContain(m.release);
      expect(["before-deploy", "with-deploy"], file).toContain(m.apply);
    }
    for (const r of ledger.releases) {
      const own = Object.entries(ledger.migrations)
        .filter(([, m]) => m.release === r.version)
        .map(([f]) => f)
        .sort();
      expect([...r.migrations].sort(), r.version).toEqual(own);
    }
  });
});

describe("upgrade-ledger.json against UPGRADING.md", () => {
  it("records, per release, exactly the ### headings that name its tag", () => {
    for (const r of ledger.releases) {
      expect(r.headings, `v${r.version}`).toEqual(releaseHeadings(upgrading, r.version));
    }
  });

  it("names only headings that exist", () => {
    const named = [
      ...ledger.claimed.map((c) => c.heading),
      ...Object.values(ledger.migrations).flatMap((m) =>
        (m.after ?? []).flatMap((a) => (a.kind === "manual" ? [a.heading] : [])),
      ),
    ];
    for (const h of named) expect(allHeadings, h).toContain(h);
  });

  it("reproduces every anchor the document links to itself with slug()", () => {
    const slugs = new Set([...allHeadings].map(slug));
    const anchors = [...upgrading.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(5);
    for (const a of anchors) expect(slugs, a).toContain(a);
  });
});

describe("upgrade-ledger.json, its own rules", () => {
  it("is folio.ledger/1", () => {
    expect(ledger.schema).toBe("folio.ledger/1");
  });

  it("lists releases in ascending order, at most one above package.json's version", () => {
    const versions = ledger.releases.map((r) => r.version);
    expect([...versions].sort(compare)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.filter((v) => compare(v, pkg.version) > 0).length).toBeLessThanOrEqual(1);
    expect(versions, "package.json's own version has an entry").toContain(pkg.version);
  });

  it("dates every released version and declares a known rollback class", () => {
    for (const r of ledger.releases) {
      expect(["safe", "conditional", "none"], r.version).toContain(r.rollback);
      if (compare(r.version, pkg.version) <= 0) {
        expect(r.date, `v${r.version} is released and has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("names only listed releases in requiresDeployed", () => {
    const versions = ledger.releases.map((r) => r.version);
    for (const r of ledger.releases) {
      if (r.requiresDeployed) {
        expect(versions).toContain(r.requiresDeployed);
        expect(compare(r.requiresDeployed, r.version)).toBeLessThan(0);
      }
    }
  });
});
