/**
 * Bundles the admin SPA into `dist/admin/`, so a consumer never compiles it.
 *
 * Run by `prepare` (and `pnpm build`). React and the tiptap editor are bundled in:
 * they are devDependencies of this package, which is the point — a consumer's
 * `node_modules` carries none of them. The Vite plugin (`src/vite/index.ts`) emits
 * these files at the host's build root and serves them from `dist/` in dev.
 *
 * Output names are fixed because `__FOLIO_ASSETS__` is a compile-time constant:
 *
 *   folio-admin.js     the entry (ESM)
 *   folio-admin.css    `ui/tokens.css` plus every `*.module.css`, in one file
 *   folio-admin-*.js   split chunks (a dynamic `import()` in the admin)
 *
 * `*.module.css` goes through esbuild's `local-css` loader, which hashes class
 * names per file exactly as a CSS module should. A split chunk's CSS is also
 * emitted by esbuild as a sibling file that nothing links; the entry's stylesheet
 * already carries it, so the sibling is dropped (and folded in if it were not).
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outdir = join(root, "dist", "admin");

rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints: { "folio-admin": join(root, "src/admin/main.tsx") },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  tsconfig: join(root, "tsconfig.json"),
  chunkNames: "folio-admin-[hash]",
  loader: { ".css": "css", ".module.css": "local-css" },
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});

const entryCss = join(outdir, "folio-admin.css");
let css = readFileSync(entryCss, "utf8");
for (const name of readdirSync(outdir).filter(
  (n) => n.endsWith(".css") && n !== "folio-admin.css",
)) {
  const chunkCss = readFileSync(join(outdir, name), "utf8");
  // esbuild already puts a dynamically imported module's CSS in the entry's file
  // (checked, esbuild 0.28); fold only what is not there, so nothing is doubled.
  if (!css.includes(chunkCss.trim())) css += `\n${chunkCss}`;
  rmSync(join(outdir, name));
}
writeFileSync(entryCss, css);
