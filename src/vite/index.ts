import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, UserConfig } from "vite";

const VIRTUAL_PREVIEW = "virtual:folio/preview";
const RESOLVED_PREVIEW = `\0${VIRTUAL_PREVIEW}`;

/**
 * Where the single stylesheet goes when a host has turned CSS code splitting off.
 *
 * Unhashed and at the root, exactly as `folio-admin.css` and `folio-preview.css`
 * already are: the Worker links it from `__FOLIO_ASSETS__`, which is a
 * compile-time constant, so the name cannot carry a content hash.
 */
const SINGLE_CSS_BUNDLE = "folio-client.css";

/**
 * The two client entries this plugin adds, each paired with the one stylesheet
 * `__FOLIO_ASSETS__` links for it.
 *
 * Both names are fixed for the same reason `SINGLE_CSS_BUNDLE` is, and that fixed
 * name is exactly one file — which is the assumption `importHoistedCss` exists to
 * repair. See it for what breaks without it.
 */
const ENTRY_STYLESHEETS: ReadonlyArray<readonly [entry: string, stylesheet: string]> = [
  ["folio-admin.js", "folio-admin.css"],
  ["folio-preview.js", "folio-preview.css"],
];

/**
 * The entries and stylesheets for the record form: the admin, then one preview per
 * brand. `folio-preview-<brand>` starts with `folio-`, so the existing
 * `entryFileNames` / `assetFileNames` rule names it at a fixed path with no change.
 */
function brandEntryStylesheets(brands: readonly string[]): typeof ENTRY_STYLESHEETS {
  return [
    ["folio-admin.js", "folio-admin.css"],
    ...brands.map((b): readonly [string, string] => [
      `folio-preview-${b}.js`,
      `folio-preview-${b}.css`,
    ]),
  ];
}

/** The same rule a site id follows, which is what a brand id is (`multi-brand.md` decision 3). */
const BRAND_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export interface FolioPluginOptions {
  /**
   * Module with a named `blocks` export listing the project's block
   * definitions. Resolved relative to the Vite root.
   *
   * A record keyed by brand id, each value such a module, builds one preview
   * bundle per brand (`folio-preview-<brand>.js` and `.css`) and bakes
   * `__FOLIO_ASSETS__` with an `assets.brands` for a `createFolio({ brands })`.
   * It cannot be combined with `build.cssCodeSplit: false`: one stylesheet would
   * carry every brand's CSS into every brand's preview.
   */
  blocks: string | Readonly<Record<string, string>>;
  /** Must match `basePath` passed to `createFolio`. Default `/folio`. */
  basePath?: string;
  /**
   * Compile the admin from `src/admin` through this project's own Vite instead of
   * serving the prebuilt bundle. Only Folio's own demo sets it, for HMR: a consumer's
   * install does not ship `src/admin`, so it has nothing to compile.
   */
  adminFromSource?: boolean;
}

/**
 * Wires a host project's blocks into the two bundles that need real
 * components, and serves the prebuilt admin from the package.
 *
 * The admin is *not* rebuilt per project: it is schema-driven and ships
 * compiled (`scripts/build-admin.mjs` writes `dist/admin/`), so a project's
 * block code never enters that bundle and the editor's dependencies never
 * enter its `node_modules`. `build` emits those files at the build root and
 * `serve` answers them from `dist/`; `adminFromSource` opts out, for Folio's demo.
 */
export function folio(options: FolioPluginOptions): Plugin[] {
  const base = options.basePath ?? "/folio";
  let root = process.cwd();
  /** Set in `config()`, read again in `configResolved`. See `cssBundledIntoOne`. */
  let noSplit = false;

  const brandBlocks = typeof options.blocks === "string" ? null : options.blocks;
  const brandIds = brandBlocks ? Object.keys(brandBlocks) : [];
  if (brandBlocks) {
    if (brandIds.length === 0) throw new Error("folio: `blocks` names no brands");
    for (const id of brandIds) {
      if (!BRAND_ID.test(id)) {
        throw new Error(
          `folio: '${id}' is not a brand id: lowercase letters, digits and hyphens, at most 32 characters`,
        );
      }
    }
  }
  const prebuilt = !options.adminFromSource;
  // A prebuilt admin is not a chunk in this build, so there is no hoisted CSS to import.
  const entryPairs = (brandBlocks ? brandEntryStylesheets(brandIds) : ENTRY_STYLESHEETS).filter(
    ([entry]) => !(prebuilt && entry === "folio-admin.js"),
  );

  const resolveModule = (blocks: string) =>
    blocks.startsWith(".") ? path.resolve(root, blocks) : blocks;

  const main: Plugin = {
    name: "folio",

    /**
     * Read-only data for tools, on the channel Vite documents for it. `folio
     * doctor`, `add block` and `preview block` load the host's own Vite config and
     * read the blocks modules and base path here, so their answer is the one the
     * build uses rather than a guess at `vite.config.ts` (`agent-cli.md` decision
     * 13). `version` bumps if this shape ever changes; nothing in the plugin reads it.
     */
    api: { folio: { version: 1, blocks: options.blocks, basePath: base } },

    config(userConfig, { command }) {
      const isDev = command === "serve";
      // In dev these are served by Vite's module graph, not as built files.
      const admin = isDev && !prebuilt ? `/@fs${adminEntry()}` : "/folio-admin.js";
      // The prebuilt stylesheet is a real file in dev too; only source mode has Vite inject it.
      const adminCss = isDev && !prebuilt ? [] : ["/folio-admin.css"];
      const preview = isDev ? `/@id/__x00__${VIRTUAL_PREVIEW}` : "/folio-preview.js";
      noSplit = cssBundledIntoOne(userConfig);
      if (brandBlocks && noSplit) {
        throw new Error(
          "folio: `blocks` is a record of brands, which cannot be built with `cssCodeSplit: false`: " +
            "one stylesheet would carry every brand's CSS into every brand's preview. " +
            "Remove `build.cssCodeSplit: false` (or `environments.client.build.cssCodeSplit: false`), " +
            "or pass one `blocks` module for a single brand.",
        );
      }
      const previewInputs: Record<string, string> = brandBlocks
        ? Object.fromEntries(brandIds.map((b) => [`folio-preview-${b}`, `${VIRTUAL_PREVIEW}/${b}`]))
        : { "folio-preview": VIRTUAL_PREVIEW };
      const assets = brandBlocks
        ? {
            admin,
            devClient: isDev ? "/@vite/client" : undefined,
            adminCss,
            brands: Object.fromEntries(
              brandIds.map((b) => [
                b,
                {
                  preview: isDev ? `/@id/__x00__${VIRTUAL_PREVIEW}/${b}` : `/folio-preview-${b}.js`,
                  previewCss: isDev ? [] : [`/folio-preview-${b}.css`],
                },
              ]),
            ),
          }
        : {
            admin,
            preview,
            devClient: isDev ? "/@vite/client" : undefined,
            adminCss:
              prebuilt || isDev
                ? adminCss
                : [noSplit ? `/${SINGLE_CSS_BUNDLE}` : "/folio-admin.css"],
            previewCss: isDev ? [] : [noSplit ? `/${SINGLE_CSS_BUNDLE}` : "/folio-preview.css"],
          };
      return {
        environments: {
          /**
           * `react-dom/server.edge` is **CommonJS**, and left external it stops
           * the host's Worker booting.
           *
           * `folio/server` imports it to render the admin and preview shells.
           * When the library resolves to `dist/`, that import comes from inside
           * `node_modules`, which Vite externalises by default — so workerd
           * loads react-dom's CJS file raw and throws
           * `ReferenceError: require is not defined` *during startup*, from a
           * stack that names the runner and nothing else. Naming it here makes
           * Vite pre-bundle it with the interop it needs.
           *
           * **React itself is listed too, not only `react-dom/server.edge`.**
           * Reproduced against the built package (a `git+file:` install of the
           * starter, `vite` with no extra config): `vite dev` died at startup with
           * `ReferenceError: module is not defined` from the runner worker, and
           * adding `react`, `react/jsx-runtime`, `react/jsx-dev-runtime` and
           * `react-dom` here was what made it boot. Those are CommonJS as well,
           * reached from the externalised `dist/` the same way, and a host used
           * to have to name them in its own `ssr.optimizeDeps.include`.
           *
           * Declared by the plugin rather than left to each host because no
           * host could reasonably deduce it: the error mentions neither Folio
           * nor react-dom. Folio's own demo never sees it, since that project
           * resolves the library to TypeScript source through the `folio-source`
           * export condition — which is exactly why this went unnoticed until a
           * second project installed the built package.
           *
           * The environment is named `ssr` because that is what the Cloudflare
           * Vite plugin calls the Worker environment; a host that renames it
           * (`cloudflare({ viteEnvironment: { name: … } })`) has to repeat this.
           */
          ssr: {
            optimizeDeps: {
              include: [
                "react",
                "react/jsx-runtime",
                "react/jsx-dev-runtime",
                "react-dom",
                "react-dom/server.edge",
              ],
            },
          },
          client: {
            build: {
              rollupOptions: {
                input: {
                  ...(typeof userConfig.build?.rollupOptions?.input === "object" &&
                  !Array.isArray(userConfig.build?.rollupOptions?.input)
                    ? userConfig.build.rollupOptions.input
                    : {}),
                  ...previewInputs,
                  ...(prebuilt ? {} : { "folio-admin": adminEntry() }),
                },
                output: {
                  entryFileNames: (chunk: { name: string }) =>
                    chunk.name.startsWith("folio-") ? "[name].js" : "assets/[name]-[hash].js",
                  assetFileNames: (asset: { names?: string[] }) => {
                    /**
                     * With `cssCodeSplit: false` there is exactly **one**
                     * stylesheet for the whole client build, and Vite names it
                     * `style.css` — which does not start with `folio-`, so the
                     * branch below would content-hash it into `assets/`. That is
                     * a path nothing can name until the bundle is written, and
                     * `__FOLIO_ASSETS__` is a `define` baked in `config()`. Pin
                     * it instead, and point both stylesheet lists at it.
                     *
                     * The file holds the **host's** CSS as well as ours, because
                     * one stylesheet is all there is. That is the cost of the
                     * flag rather than of this branch, and it is why the fixed
                     * name says `client` and not `admin`.
                     */
                    if (noSplit && asset.names?.some((n) => n.endsWith(".css"))) {
                      return SINGLE_CSS_BUNDLE;
                    }
                    return asset.names?.some((n) => n.startsWith("folio-"))
                      ? "[name][extname]"
                      : "assets/[name]-[hash][extname]";
                  },
                },
              },
            },
          },
        },
        define: {
          // Read by the host's Worker so asset URLs always match this build.
          // In dev Vite injects entry CSS from JS, so there is nothing to link.
          __FOLIO_ASSETS__: JSON.stringify(assets),
          __FOLIO_BASE__: JSON.stringify(base),
        },
      };
    },

    configResolved(resolved) {
      root = resolved.root;
      foldClientEntries(resolved);
      assertCssStrategyWasVisible(resolved, noSplit);
    },

    /**
     * **`order: 'post'` is load-bearing.** `vite:css-post` rewrites this graph in
     * its own `generateBundle`: a chunk that turned out to hold nothing but CSS is
     * deleted, its `importedCss` merged into every chunk that imported it, and
     * those chunks' `imports` rewritten to drop it. Reading the bundle before that
     * runs is reading a graph that is about to change shape.
     *
     * Nothing here happens when code splitting is off: there is one stylesheet
     * then, both entries already link it, and it holds everything by construction.
     */
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (
          prebuilt &&
          (this as { environment?: { name: string } }).environment?.name === "client"
        ) {
          // At the root under the names `__FOLIO_ASSETS__` carries; split chunks
          // import each other relatively, so they sit beside the entry.
          //
          // `originalFileName` is the real file under the package: a consumer's
          // build tooling attributes a stylesheet to its source through the
          // asset's `originalFileNames`, and an emitted asset with none reads as
          // CSS from nowhere (group-web's `check-brand-css` refuses it).
          for (const [name, { source, file }] of adminFiles()) {
            this.emitFile({ type: "asset", fileName: name, source, originalFileName: file });
          }
        }
        if (noSplit) return;
        for (const [entry, stylesheet] of entryPairs) {
          importHoistedCss(this, bundle as unknown as Bundle, entry, stylesheet);
        }
      },
    },

    /**
     * Dev answers the prebuilt admin from `dist/admin/`, at the same root paths a
     * build emits it. In source mode Vite's module graph serves it instead.
     */
    configureServer(server) {
      if (!prebuilt) return;
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? "").split("?")[0]?.slice(1) ?? "";
        const file = /^folio-admin[\w.-]*\.(js|css)$/.test(name)
          ? adminFiles().get(name)?.source
          : undefined;
        if (file === undefined) return next();
        res.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "text/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.end(file);
      });
    },

    resolveId(id) {
      if (id === VIRTUAL_PREVIEW || id.startsWith(`${VIRTUAL_PREVIEW}/`)) return `\0${id}`;
      return null;
    },

    load(id) {
      if (id !== RESOLVED_PREVIEW && !id.startsWith(`${RESOLVED_PREVIEW}/`)) return null;
      const brand = id === RESOLVED_PREVIEW ? null : id.slice(RESOLVED_PREVIEW.length + 1);
      const blocks = brand === null ? options.blocks : brandBlocks?.[brand];
      if (typeof blocks !== "string") return null;
      // Generated so the preview bundle contains the project's own components
      // while the entry itself stays owned by the library.
      //
      // `import * as m` rather than a named import of `wrap`, because `wrap` is
      // optional: a named import of a missing export is a hard ESM error, and
      // most projects will never need one. See `PreviewWrapper` — it exists so
      // a host whose blocks sit inside a router or a theme provider can supply
      // it, which is not exotic and had no expression at all before.
      return [
        `import { mountPreview } from 'folio/preview'`,
        `import * as m from ${JSON.stringify(resolveModule(blocks))}`,
        `mountPreview(m.blocks, { wrap: m.wrap })`,
      ].join("\n");
    },
  };

  return [main];
}

/**
 * Whether the client build will bundle every stylesheet into one file.
 *
 * Read from the **user's** config rather than the resolved one, because
 * `__FOLIO_ASSETS__` is a `define` and is baked while `config()` runs — long
 * before `configResolved` knows anything. `build.cssCodeSplit` is a flag a host
 * sets in its own config, which is the object this hook is handed, so the case
 * that actually happens is visible here.
 *
 * What is *not* visible here is a **plugin** setting it, or a
 * `configEnvironment` hook doing so. `assertCssStrategyWasVisible` covers that
 * by failing the build rather than by shipping a stylesheet link that 404s.
 *
 * Checked in both places it can be written: `build` applies to every
 * environment, and `environments.client.build` overrides it for the one that
 * matters.
 */
function cssBundledIntoOne(userConfig: UserConfig): boolean {
  return (
    userConfig.build?.cssCodeSplit === false ||
    userConfig.environments?.client?.build?.cssCodeSplit === false
  );
}

/**
 * Fail the build when the client environment resolved to `cssCodeSplit: false`
 * but `config()` could not see that coming.
 *
 * **This cannot repair the paths** — `__FOLIO_ASSETS__` is baked by now — so it
 * refuses to ship them instead. What it replaces is a failure that is silent at
 * build time and arrives at deploy: `adminCss` links `/folio-admin.css`, the
 * build emitted one hashed `assets/style-<hash>.css` and no such file, and the
 * admin renders unstyled behind a 200. Dev is unaffected, because Vite injects
 * entry CSS from JS there, so the first sign of it is production.
 *
 * Only reachable when something other than the host's own config sets the flag.
 * `build.lib` is the other route: it defaults `cssCodeSplit` to false, and a
 * client build in library mode has the same broken link, so failing is right
 * there too.
 */
function assertCssStrategyWasVisible(
  resolved: { environments?: Record<string, { build?: { cssCodeSplit?: boolean } }> },
  noSplit: boolean,
): void {
  if (noSplit) return;
  if (resolved.environments?.client?.build?.cssCodeSplit !== false) return;
  throw new Error(
    "folio: the client build resolved to `cssCodeSplit: false`, but that was not set in this project's own Vite config — " +
      "so the admin and preview stylesheet paths were already baked as if CSS were split per entry, and they will 404 in production. " +
      "Set `build.cssCodeSplit: false` (or `environments.client.build.cssCodeSplit: false`) in vite.config.ts so the plugin can see it, " +
      "or find the plugin that is setting it and let it be configured instead.",
  );
}

/**
 * Only the parts of Rollup's output bundle the CSS walk below reads. Structural,
 * like `assertCssStrategyWasVisible` and `foldClientEntries` above, so the plugin
 * keeps compiling against both Vite majors in `peerDependencies` without pinning
 * itself to one release's Rollup types.
 */
interface Bundle {
  [fileName: string]:
    | {
        type: "chunk";
        imports?: string[];
        viteMetadata?: { importedCss?: Set<string> };
        source?: undefined;
      }
    | { type: "asset"; imports?: undefined; viteMetadata?: undefined; source: string | Uint8Array };
}

/** The one thing `importHoistedCss` needs from the plugin context. */
interface EmitsAssets {
  emitFile(file: { type: "asset"; fileName: string; source: string }): string;
}

/**
 * Every stylesheet an entry needs, in the order Vite would have linked them.
 *
 * Mirrors Vite's own `getCssFilesForChunk`, which is what it uses to write the
 * `<link>` tags for an HTML entry: depth-first over `imports`, a chunk's
 * dependencies before the chunk's own CSS, first occurrence wins. Matching it is
 * the point — the file we are assembling stands in for those tags.
 *
 * **`dynamicImports` is deliberately not walked**, also mirroring Vite: CSS behind
 * a dynamic import is fetched by the preload helper when the import runs, so
 * linking it up front would load stylesheets for code that may never execute.
 */
function cssReachableFrom(bundle: Bundle, entryFileName: string): string[] {
  const seenChunks = new Set<string>();
  const seenCss = new Set<string>();
  const files: string[] = [];

  const walk = (fileName: string): void => {
    const chunk = bundle[fileName];
    if (chunk?.type !== "chunk" || seenChunks.has(fileName)) return;
    seenChunks.add(fileName);
    for (const imported of chunk.imports ?? []) walk(imported);
    for (const css of chunk.viteMetadata?.importedCss ?? []) {
      if (seenCss.has(css)) continue;
      seenCss.add(css);
      files.push(css);
    }
  };

  walk(entryFileName);
  return files;
}

/**
 * Pull the stylesheets Rollup hoisted out of an entry back into the one file
 * `__FOLIO_ASSETS__` links for it.
 *
 * **The bug this fixes is the preview iframe rendering the host's blocks with no
 * styling at all**, behind a 200, in a build with nothing wrong in it. With code
 * splitting on, `folio-preview.css` holds only what the *preview entry's own
 * chunk* imported — which is `preview.css`, this library's selection outlines and
 * empty-slot placeholders. The host's block CSS is imported by the preview entry
 * *and* by the host's own page routes, so Rollup does the obviously right thing
 * and hoists it into a shared chunk with a content-hashed name. `previewCss` was
 * baked in `config()` and names one fixed file, so it never mentions that chunk.
 *
 * The condition is not exotic and does not depend on how a host is written: the
 * preview entry exists **to render the host's blocks**, and any host that also
 * renders those blocks on its own pages — which is the entire purpose of the
 * blocks — shares that CSS. It went unseen because `examples/demo` styles its
 * blocks from a hand-written `public/site.css` and imports no CSS through Vite at
 * all, so `pnpm build:demo` has never emitted a hoisted chunk to get this wrong.
 *
 * `@import` rather than concatenating the bytes, for three reasons that all point
 * the same way: the host's public pages link that same hashed file, so the editor
 * reuses their cache entry instead of downloading a second copy; `url()` inside
 * the imported CSS keeps resolving against `/assets/`, where its images actually
 * are, rather than against this file at the root; and an `@import`ed sheet
 * cascades *before* the importing file's own rules, which is the order these two
 * want — host styles first, this library's editing chrome over the top.
 *
 * The cost is one serialised request in the editor's iframe, which is the right
 * place to pay it.
 */
function importHoistedCss(
  ctx: EmitsAssets,
  bundle: Bundle,
  entryFileName: string,
  stylesheet: string,
): void {
  // The entry's own CSS is `stylesheet` itself; everything else was hoisted.
  const hoisted = cssReachableFrom(bundle, entryFileName).filter((file) => file !== stylesheet);
  if (hoisted.length === 0) return;

  const rules = hoisted.map((file) => `@import url("/${file}");`).join("\n");
  const own = bundle[stylesheet];

  // An entry can reach hoisted CSS while importing none of its own, in which case
  // Vite emits no file at this name and the baked link is already a 404. Writing
  // it here fixes that case too.
  if (own?.type !== "asset") {
    ctx.emitFile({ type: "asset", fileName: stylesheet, source: `${rules}\n` });
    return;
  }

  const source = typeof own.source === "string" ? own.source : new TextDecoder().decode(own.source);
  /**
   * `@charset` has to be the first thing in a stylesheet and `@import` has to
   * precede every rule that is not one, so the two orders conflict unless the
   * charset stays put. Vite writes one whenever the file holds a non-ASCII byte,
   * which a block's content very often does.
   */
  const charset = /^@charset\s+"[^"]*";/.exec(source);
  own.source = charset
    ? `${charset[0]}\n${rules}\n${source.slice(charset[0].length)}`
    : `${rules}\n${source}`;
}

/**
 * Fold the two entries this plugin adds back into one object, after Vite has
 * merged every plugin's contribution.
 *
 * **`config()` cannot get this right on its own, and the failure is a build that
 * never starts.** The hook returns a *named* input map, because the names are
 * what `output.entryFileNames` matches on to emit `folio-admin.js` and
 * `folio-preview.js` at fixed paths — the paths `__FOLIO_ASSETS__` hands the
 * Worker. A framework plugin, meanwhile, declares the client's entries as an
 * **array**: React Router lists `root`, the client entry and one module per
 * route. Vite's `mergeConfig` concatenates when either side is an array, so the
 * two contributions come out as `[...routeIds, { 'folio-admin': … }]` — an array
 * with an object in it, which is not a shape Rollup accepts.
 *
 * What it actually looks like is `input$1.endsWith is not a function`, thrown out
 * of Vite's own config resolution, naming nothing. And only for a host that sets
 * `build.cssCodeSplit: false`, because that is the branch that happens to call
 * `.endsWith` on every entry first; everything else reaches Rollup and fails
 * later and differently. Folio's own demo has no framework plugin contributing an
 * array, so its build was green throughout.
 *
 * Folding here rather than emitting chunks from `buildStart` keeps the naming in
 * one place. The array's own entries keep working: an id becomes a name the way
 * Rollup would have derived one, and those chunks are content-hashed anyway, so
 * the name is cosmetic for everything but ours.
 */
function foldClientEntries(resolved: {
  environments?: Record<string, { build?: { rollupOptions?: { input?: unknown } } }>;
}): void {
  const build = resolved.environments?.client?.build;
  const input = build?.rollupOptions?.input;
  if (!build?.rollupOptions || !Array.isArray(input)) return;

  const named: Record<string, string> = {};
  const ids: string[] = [];
  for (const entry of input) {
    if (entry && typeof entry === "object") Object.assign(named, entry);
    else if (typeof entry === "string") ids.push(entry);
  }
  // Nothing of ours in there: some other plugin's array, left alone.
  if (Object.keys(named).length === 0) return;

  const folded: Record<string, string> = {};
  for (const id of ids) {
    let name = entryName(id);
    // Two ids that reduce to the same name would silently drop one.
    for (let n = 2; name in folded; n++) name = `${entryName(id)}${n}`;
    folded[name] = id;
  }
  build.rollupOptions.input = { ...folded, ...named };
}

/** An id as Rollup would name its chunk: basename, no query, no extension. */
function entryName(id: string): string {
  const base = path.basename(id.split("?")[0] ?? id);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * The prebuilt admin: `dist/admin/folio-admin*.{js,css}`, read fresh each call so a
 * rebuild in a linked checkout is picked up without restarting the server.
 *
 * `dist/vite.js` sits one directory below the package root and `src/vite/index.ts`
 * two, which is the same walk `adminEntry` makes.
 */
function adminFiles(): Map<string, { source: string; file: string }> {
  const dir = import.meta.dirname;
  const dist = path.resolve(dir, path.basename(dir) === "vite" ? "../../dist" : ".", "admin");
  if (!existsSync(path.join(dist, "folio-admin.js"))) {
    throw new Error(
      `folio: the prebuilt admin is missing (${dist}). Folio's \`prepare\` step builds it when the ` +
        "package is installed, so that step did not run or failed. Reinstall folio and check the " +
        "install log for the build error (in a Folio checkout, run `pnpm build`).",
    );
  }
  return new Map(
    readdirSync(dist)
      .filter((n) => n.startsWith("folio-admin") && /\.(js|css)$/.test(n))
      .map((n) => [
        n,
        { source: readFileSync(path.join(dist, n), "utf8"), file: path.join(dist, n) },
      ]),
  );
}

/**
 * `src/admin/main.tsx`, for `adminFromSource` only (Folio's own demo). Not the
 * `./admin-entry` export: that names the prebuilt file now. `dist/vite.js` is one
 * directory below the package root; `src/vite/index.ts` is two.
 */
function adminEntry(): string {
  const dir = import.meta.dirname;
  return path.resolve(dir, path.basename(dir) === "vite" ? "../.." : "..", "src/admin/main.tsx");
}
