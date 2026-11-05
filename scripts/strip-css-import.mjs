/**
 * Removes side-effect stylesheet imports from the emitted declarations.
 *
 * `src/preview/mount.tsx` does `import "./preview.css"`, and `tsc` keeps a side-effect
 * import in the `.d.ts`. A host with `skipLibCheck: false` and no `vite/client` types then
 * fails TS2882 on a file that carries no types from the stylesheet. The built
 * `dist/preview.js` keeps the import, which is the one that matters.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "types");
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".d.ts") ? [join(d, e.name)] : [],
  );
for (const file of walk(dir)) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(/^import\s+["'][^"']*\.css["'];?\r?\n/gm, "");
  if (after !== before) writeFileSync(file, after);
}
