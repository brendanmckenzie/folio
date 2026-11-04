/**
 * `upgrade-ledger.json`: the machine-readable companion to `UPGRADING.md`.
 *
 * It carries only what a plan is computed from (spec 41 decision 8). The prose
 * wins: `test/unit/cli/ledger.test.ts` fails whenever this file disagrees with
 * `migrations/` or with the document's release headings, so it can never be the
 * older of the two.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { compare } from "./semver.mjs";

export const LEDGER_SCHEMA = "folio.ledger/1";
export const LEDGER_FILE = "upgrade-ledger.json";

/** Reads and shape-checks the ledger in a package root. Throws on a foreign schema. */
export function readLedger(pkgRoot) {
  const ledger = JSON.parse(readFileSync(path.join(pkgRoot, LEDGER_FILE), "utf8"));
  if (ledger.schema !== LEDGER_SCHEMA) {
    throw new Error(
      `${LEDGER_FILE} is "${ledger.schema}", and this CLI reads "${LEDGER_SCHEMA}" only`,
    );
  }
  return ledger;
}

/** The release entry for `version`, or `undefined`. */
export function releaseOf(ledger, version) {
  return ledger.releases.find((r) => r.version === version);
}

/** Releases with `from < version <= to`, ascending. */
export function releasesBetween(ledger, from, to) {
  return ledger.releases
    .filter((r) => compare(r.version, from) > 0 && compare(r.version, to) <= 0)
    .sort((a, b) => compare(a.version, b.version));
}

/** The newest release the ledger lists. */
export function newestRelease(ledger) {
  return [...ledger.releases].sort((a, b) => compare(a.version, b.version)).at(-1);
}
