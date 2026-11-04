/**
 * Imports a `bin/lib/*.mjs` module by a computed specifier, which keeps the
 * untyped `.mjs` out of the typechecker's way (as `release-notes.test.ts` does).
 * Each test file declares the slice of the module's surface it uses.
 */
export async function lib<T>(name: string): Promise<T> {
  const specifier = `../../../bin/lib/${name}.mjs`;
  return (await import(/* @vite-ignore */ specifier)) as T;
}

/** The repository root, for tests that read shipped files. */
export const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
