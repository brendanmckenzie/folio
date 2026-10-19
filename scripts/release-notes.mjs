/**
 * The hand-written half of a release's notes: every UPGRADING.md entry whose
 * `###` heading names the tag, e.g. `### Turning sites on (v1.2.0)`.
 *
 *   node scripts/release-notes.mjs v1.0.0 > notes.md
 *
 * `release.yml` hands the output to `gh release create --generate-notes`, which
 * appends the commit list. When no entry names the tag the output says so and
 * links the whole document, so the notes are never silently thin.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The `###` sections of `markdown` whose heading contains `tag`, joined by a blank line. */
export function upgradingEntries(markdown, tag) {
  const lines = markdown.split("\n");
  const entries = [];
  let current = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const heading = !inFence && /^(#{1,6}) /.exec(line);
    if (heading) {
      if (current) entries.push(current);
      current = heading[1] === "###" && line.includes(tag) ? [line] : null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) entries.push(current);
  return entries.map((e) => e.join("\n").trim()).join("\n\n");
}

/** The notes body for `tag`. */
export function releaseNotes(markdown, tag, repo = "brendanmckenzie/folio") {
  const link = `https://github.com/${repo}/blob/${tag}/UPGRADING.md`;
  const entries = upgradingEntries(markdown, tag);
  if (!entries) {
    return `No UPGRADING.md entry is specific to ${tag}. Read [the upgrade procedure and schema ledger](${link}) before you bump.`;
  }
  return `## Upgrading to ${tag}\n\n${entries}\n\nThe full procedure and the schema ledger are in [UPGRADING.md](${link}).`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: node scripts/release-notes.mjs <tag>");
    process.exit(2);
  }
  console.log(releaseNotes(readFileSync("UPGRADING.md", "utf8"), tag));
}
