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
const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");

/** The text of one `## ` section of a document, by its exact heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
}

/** UPGRADING.md's schema ledger table: file name to its "anything else to do" cell. */
const ledgerSection = section(upgrading, "The schema ledger");
const rows = new Map(
  [...ledgerSection.matchAll(/^\| `(\d{4}_[\w]+\.sql)` \|[^|]*\|(.*)\|\s*$/gm)].map((m) => [
    m[1] as string,
    m[2] as string,
  ]),
);
const releaseOf = (file: string) => ledger.migrations[file]?.release;

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

/**
 * The fields a plan is computed from, each checked against the prose it is derived
 * from. Names and headings alone are not enough: a ledger with the right file names
 * and the wrong `apply`, `release`, `rollback`, `after` or `claimed` plans a wrong
 * upgrade and passes every check above (the spec 41 review, H2).
 */
describe("upgrade-ledger.json's plan fields against the prose", () => {
  it("has a schema-ledger row for every shipped migration", () => {
    expect([...rows.keys()].sort()).toEqual(shipped);
  });

  it("marks with-deploy exactly the migrations whose row says apply, then deploy", () => {
    for (const [file, m] of Object.entries(ledger.migrations)) {
      const row = rows.get(file) ?? "";
      const withDeploy = /apply it, then deploy/i.test(row);
      expect(m.apply, file).toBe(withDeploy ? "with-deploy" : "before-deploy");
    }
  });

  it("reindexes after exactly the migrations whose row asks for it, drafts where it says so", () => {
    for (const [file, m] of Object.entries(ledger.migrations)) {
      const row = rows.get(file) ?? "";
      const reindex = (m.after ?? []).find((a) => a.kind === "reindex");
      expect(Boolean(reindex), file).toBe(/reindex/i.test(row));
      if (reindex) expect(Boolean(reindex.drafts), file).toBe(row.includes("drafts=1"));
    }
  });

  it("attributes each migration to the release whose CHANGELOG section names it", () => {
    const first = ledger.releases[0]?.version as string;
    for (const r of ledger.releases) {
      const text = section(changelog, r.version);
      const named = new Set(
        [...text.matchAll(/\b(\d{4}_[a-z_]+\.sql)\b/g)]
          .map((m) => m[1] as string)
          .filter((f) => shipped.includes(f)),
      );
      if (!text) {
        // Only the release in progress may lack a CHANGELOG section.
        expect(
          compare(r.version, pkg.version),
          `v${r.version} has no CHANGELOG section`,
        ).toBeGreaterThan(0);
        continue;
      }
      if (r.version === first) {
        // The first release shipped the base; every file its section names is in it.
        for (const f of named) expect(r.migrations, `v${r.version} ${f}`).toContain(f);
      } else {
        expect([...r.migrations].sort(), `v${r.version}`).toEqual([...named].sort());
      }
    }
  });

  it("calls a release roll-forward only when a heading says so, conditional when it carries a with-deploy migration", () => {
    for (const r of ledger.releases) {
      const none = r.headings.some((h) => /roll-forward only/i.test(h));
      const withDeploy = r.migrations.some((f) => ledger.migrations[f]?.apply === "with-deploy");
      expect(r.rollback, `v${r.version}`).toBe(none ? "none" : withDeploy ? "conditional" : "safe");
    }
  });

  it("claims exactly the unshipped migrations the schema ledger names", () => {
    const unshipped = [
      ...new Set(
        [...ledgerSection.matchAll(/`(\d{4}_[\w]+\.sql)`/g)]
          .map((m) => m[1] as string)
          .filter((f) => !shipped.includes(f)),
      ),
    ].sort();
    expect(ledger.claimed.map((c) => c.file).sort()).toEqual(unshipped);
  });

  it("holds back a migration the prose says must never share a step with another", () => {
    const rules = ledgerSection.split(/\.\s+/).flatMap((sentence) => {
      const guard = /never be applied in the same step as `(\d{4})`/.exec(sentence)?.[1];
      const dependent = /`(\d{4}_[\w]+\.sql)`/.exec(sentence)?.[1];
      return guard && dependent ? [{ guard, dependent }] : [];
    });
    expect(rules.length, "the 0012 rule is stated").toBeGreaterThan(0);
    for (const { guard, dependent } of rules) {
      const guardFile = shipped.find((f) => f.startsWith(`${guard}_`)) as string;
      if (!shipped.includes(dependent)) {
        expect(
          ledger.claimed.map((c) => c.file),
          dependent,
        ).toContain(dependent);
        continue;
      }
      // Landed: its release must refuse to be crossed until the guard's release is deployed.
      const r = ledger.releases.find((x) => x.version === releaseOf(dependent));
      expect(r?.requiresDeployed, `${dependent}'s release declares requiresDeployed`).toBeDefined();
      expect(
        compare(r?.requiresDeployed as string, releaseOf(guardFile) as string),
      ).toBeGreaterThanOrEqual(0);
      expect(r?.version).not.toBe(releaseOf(guardFile));
    }
  });
});

describe("upgrade-ledger.json, its own rules", () => {
  it("lists every release a ### heading names", () => {
    const versions = new Set(ledger.releases.map((r) => r.version));
    for (const h of headings(upgrading)) {
      if (h.level !== 3) continue;
      for (const m of h.text.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) {
        expect(versions, `${h.text} names v${m[1]}`).toContain(m[1]);
      }
    }
  });

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
