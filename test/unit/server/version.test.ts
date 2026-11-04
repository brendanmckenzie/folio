import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FOLIO_VERSION } from "../../../src/server/version";

/**
 * `FOLIO_VERSION` is a literal (`src/server/version.ts` says why), so this is what
 * keeps it the package's: a version-bump PR that edits `package.json` alone fails
 * here, rather than shipping a server whose MCP serverInfo names the release before
 * it. `folio upgrade --url` reads that answer to clear a `requiresDeployed` gate, so
 * a stale constant would let a plan past a gate the deployment has not reached.
 */
describe("FOLIO_VERSION", () => {
  it("is package.json's version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(FOLIO_VERSION).toBe(pkg.version);
  });
});
