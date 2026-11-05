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
 * Three things here are not what a plain esbuild call gives, and each is guarded:
 *
 * - **Class names are `folio-<File>_<name>`.** esbuild's `local-css` loader names a
 *   class `<File>_<name>`, or `a`, `aa`... under `minifyIdentifiers`, and the admin
 *   page also links the host's own stylesheets, so a short global name can collide
 *   with a host class. esbuild has no naming option for it, so the bundle is built
 *   unminified, the names are prefixed in the CSS and the JS together, and only then
 *   minified. `test/unit/admin/built-css.test.ts` asserts every class is prefixed.
 * - **A split chunk's CSS is dropped, not appended.** esbuild writes a dynamically
 *   imported module's CSS into the entry's `folio-admin.css` *and* a sibling file
 *   for the chunk (which also repeats everything the chunk imports, `tokens.css`
 *   included). Appending that sibling would re-apply the tokens after every module
 *   rule. Nothing links the sibling, so it is deleted, after checking that every
 *   class it defines is in the entry's stylesheet; the build fails if one is not.
 * - **`process.env.NODE_ENV` is defined** so React's production build is the one bundled.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outdir = join(root, "dist", "admin");
const PREFIX = "folio-";
const TARGET = "es2022";

rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints: { "folio-admin": join(root, "src/admin/main.tsx") },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: TARGET,
  minify: false,
  jsx: "automatic",
  tsconfig: join(root, "tsconfig.json"),
  chunkNames: "folio-admin-[hash]",
  loader: { ".css": "css", ".module.css": "local-css" },
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});

const files = readdirSync(outdir);
const read = (name) => readFileSync(join(outdir, name), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// The stems of every CSS module, which is what esbuild prefixes its local names with.
const stems = readdirSync(join(root, "src/admin"), { recursive: true })
  .filter((f) => f.endsWith(".module.css"))
  .map((f) => basename(f, ".module.css"));
const localName = new RegExp(`(?<![\\w-])(?:${[...new Set(stems)].join("|")})_[\\w-]+`, "g");

const cssFiles = files.filter((n) => n.endsWith(".css"));
const classesIn = (css) => new Set(stripComments(css).match(localName) ?? []);

// A chunk's stylesheet is already inside the entry's. Prove it, then drop it.
const entryClasses = classesIn(read("folio-admin.css"));
for (const name of cssFiles.filter((n) => n !== "folio-admin.css")) {
  const missing = [...classesIn(read(name))].filter((c) => !entryClasses.has(c));
  if (missing.length) {
    throw new Error(
      `build-admin: ${name} defines classes that folio-admin.css does not (${missing.slice(0, 5).join(", ")}). ` +
        "esbuild no longer folds a dynamic chunk's CSS into the entry's, and nothing links the chunk's file.",
    );
  }
  rmSync(join(outdir, name));
}

const names = [...entryClasses];
const renamed = names.length
  ? new RegExp(`(?<![\\w-])(?:${names.join("|")})(?![\\w-])`, "g")
  : null;
const prefix = (text) => (renamed ? text.replace(renamed, (n) => `${PREFIX}${n}`) : text);
// In JS a class name is only ever a string value, so only string literals are touched.
const prefixStrings = (js) => js.replace(/"(?:[^"\\\n]|\\.)*"/g, prefix);

for (const name of readdirSync(outdir)) {
  const text = name.endsWith(".css") ? prefix(read(name)) : prefixStrings(read(name));
  const out = name.endsWith(".css")
    ? await transform(text, { loader: "css", minify: true, target: TARGET, legalComments: "none" })
    : await transform(text, { loader: "js", format: "esm", minify: true, target: TARGET });
  writeFileSync(join(outdir, name), out.code);
}
