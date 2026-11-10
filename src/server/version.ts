/**
 * The package version, as MCP `server/discover` reports it in serverInfo.
 *
 * A constant rather than an import of `package.json`: `tsconfig.build.json`'s
 * `rootDir` is `src`, so a JSON import from the root fails declaration emit, and
 * esbuild would inline the whole manifest into every host's Worker to read one
 * field. A build-time `define` reaches `dist/` only, and the demo, vitest and a
 * host that sets `folio-source` all run this file as source. A literal is the
 * same value under every one of them.
 *
 * `test/unit/server/version.test.ts` fails when it disagrees with
 * `package.json`, so the version-bump PR changes both. `folio upgrade --url`
 * clears a `requiresDeployed` gate from this value, so a stale one is a wrong
 * answer about what a deployment runs, not a cosmetic one.
 */
export const FOLIO_VERSION = "1.5.2";
