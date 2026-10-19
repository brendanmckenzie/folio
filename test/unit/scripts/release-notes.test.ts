import { describe, expect, it } from "vitest";

type Mod = {
  upgradingEntries: (markdown: string, tag: string) => string;
  releaseNotes: (markdown: string, tag: string, repo?: string) => string;
};
// A computed specifier keeps the untyped .mjs out of the typechecker's way.
const path = "../../../scripts/release-notes.mjs";
const { upgradingEntries, releaseNotes } = (await import(/* @vite-ignore */ path)) as Mod;

const doc = [
  "# Upgrading",
  "",
  "## Things that need an eye on upgrade",
  "",
  "### Roles move (v1.0.0)",
  "",
  "Apply the migration first.",
  "",
  "```sh",
  "# A comment, not a heading",
  "### also not a heading (v1.0.0)",
  "```",
  "",
  "### Unrelated (v0.9.0)",
  "",
  "Old news.",
  "",
  "### Second entry (v1.0.0)",
  "",
  "More.",
  "",
  "## Rolling back",
  "",
  "Not an entry.",
].join("\n");

describe("release notes", () => {
  it("collects every ### section naming the tag, fences included", () => {
    const out = upgradingEntries(doc, "v1.0.0");
    expect(out).toContain("### Roles move (v1.0.0)");
    expect(out).toContain("### also not a heading (v1.0.0)");
    expect(out).toContain("### Second entry (v1.0.0)");
    expect(out).not.toContain("Old news.");
    expect(out).not.toContain("Not an entry.");
  });

  it("says so, and links the document, when nothing names the tag", () => {
    const out = releaseNotes(doc, "v2.0.0");
    expect(out).toContain("No UPGRADING.md entry is specific to v2.0.0");
    expect(out).toContain("blob/v2.0.0/UPGRADING.md");
  });

  it("headlines the entries when some do", () => {
    expect(releaseNotes(doc, "v1.0.0")).toMatch(/^## Upgrading to v1\.0\.0\n\n### Roles move/);
  });
});
