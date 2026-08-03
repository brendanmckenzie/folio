import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'

const VIRTUAL_PREVIEW = 'virtual:folio/preview'
const RESOLVED_PREVIEW = `\0${VIRTUAL_PREVIEW}`

export interface FolioPluginOptions {
  /**
   * Module with a named `blocks` export listing the project's block
   * definitions. Resolved relative to the Vite root.
   */
  blocks: string
  /** Must match `basePath` passed to `createFolio`. Default `/folio`. */
  basePath?: string
}

/**
 * Wires a host project's blocks into the two bundles that need real
 * components, and serves the prebuilt admin from the package.
 *
 * The admin is *not* rebuilt per project: it is schema-driven and ships
 * compiled, so a project's block code never enters that bundle.
 */
export function folio(options: FolioPluginOptions): Plugin[] {
  const base = options.basePath ?? '/folio'
  let root = process.cwd()

  const resolveBlocks = () =>
    options.blocks.startsWith('.') ? path.resolve(root, options.blocks) : options.blocks

  const main: Plugin = {
    name: 'folio',

    config(userConfig, { command }) {
      const isDev = command === 'serve'
      // In dev these are served by Vite's module graph, not as built files.
      const admin = isDev ? `/@fs${adminEntry()}` : '/folio-admin.js'
      const preview = isDev ? `/@id/__x00__${VIRTUAL_PREVIEW}` : '/folio-preview.js'
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
           * Declared by the plugin rather than left to each host because no
           * host could reasonably deduce it: the error mentions neither Folio
           * nor react-dom. Folio's own demo never sees it, since that project
           * resolves the library to TypeScript source through the `development`
           * export condition — which is exactly why this went unnoticed until a
           * second project installed the built package.
           *
           * The environment is named `ssr` because that is what the Cloudflare
           * Vite plugin calls the Worker environment; a host that renames it
           * (`cloudflare({ viteEnvironment: { name: … } })`) has to repeat this.
           */
          ssr: {
            optimizeDeps: {
              include: ['react-dom/server.edge'],
            },
          },
          client: {
            /**
             * `@tiptap/react` imports `useSyncExternalStore` **by name** from
             * `use-sync-external-store/shim`, which is CommonJS. Pre-bundled,
             * esbuild inlines it and the named import works; loaded raw, the
             * browser throws
             *
             *   SyntaxError: The requested module '…/use-sync-external-store/
             *   shim/index.js' does not provide an export named
             *   'useSyncExternalStore'
             *
             * and the admin never mounts — a blank page whose only clue is one
             * console line naming two packages the host has never heard of.
             *
             * It is not pre-bundled by default because Vite's dep scanner
             * crawls the *host's* entries, and the admin entry is a file inside
             * `node_modules`. Every dependency reached only from there is
             * invisible to it.
             *
             * **Every tiptap package the admin imports has to be named here, not
             * just the one that needed interop.** This list used to be
             * `['@tiptap/react']`, on the reasoning that the rest would come
             * along inside the same optimised bundle. They do not: the admin
             * imports `@tiptap/core`, `@tiptap/starter-kit` and the two extra
             * marks *directly*, and an unlisted dependency of a file under
             * `node_modules` is served raw. So `useEditor` came from the
             * optimised chunk — with `prosemirror-state` bundled inside it —
             * while `StarterKit` came from `/node_modules/@tiptap/starter-kit/
             * dist/index.js`, which imports its own.
             *
             * Two copies of `prosemirror-state` means two copies of the
             * module-level counter behind `createKey`, so each hands out
             * `plugin$` for its first unkeyed plugin. Put both in one editor and
             * ProseMirror throws
             *
             *   RangeError: Adding different instances of a keyed plugin (plugin$)
             *
             * on mount, which unmounts the admin: a white screen from clicking
             * any block with a richtext field. Dev only — the build resolves one
             * copy — which is the worst place for it, because dev is where the
             * editor is used.
             *
             * `@tiptap/pm` must **not** be added here: it has no `.` export,
             * only subpaths, so naming it fails config resolution outright with
             * `Missing "." specifier`.
             */
            optimizeDeps: {
              include: [
                '@tiptap/react',
                '@tiptap/core',
                '@tiptap/starter-kit',
                '@tiptap/extension-subscript',
                '@tiptap/extension-superscript',
              ],
            },
            /**
             * The same hazard for anything that still escapes pre-bundling: one
             * `prosemirror-state` in the graph, whichever route reaches it.
             * Belt and braces, and it costs nothing when the list above is
             * already doing its job.
             */
            resolve: {
              dedupe: [
                '@tiptap/core',
                '@tiptap/pm',
                'prosemirror-state',
                'prosemirror-view',
                'prosemirror-model',
              ],
            },
            build: {
              rollupOptions: {
                input: {
                  ...(typeof userConfig.build?.rollupOptions?.input === 'object' &&
                  !Array.isArray(userConfig.build?.rollupOptions?.input)
                    ? userConfig.build.rollupOptions.input
                    : {}),
                  'folio-preview': VIRTUAL_PREVIEW,
                  'folio-admin': adminEntry(),
                },
                output: {
                  entryFileNames: (chunk: { name: string }) =>
                    chunk.name.startsWith('folio-') ? '[name].js' : 'assets/[name]-[hash].js',
                  assetFileNames: (asset: { names?: string[] }) =>
                    asset.names?.some((n) => n.startsWith('folio-'))
                      ? '[name][extname]'
                      : 'assets/[name]-[hash][extname]',
                },
              },
            },
          },
        },
        define: {
          // Read by the host's Worker so asset URLs always match this build.
          // In dev Vite injects entry CSS from JS, so there is nothing to link.
          __FOLIO_ASSETS__: JSON.stringify({
            admin,
            preview,
            devClient: isDev ? '/@vite/client' : undefined,
            adminCss: isDev ? [] : ['/folio-admin.css'],
            previewCss: isDev ? [] : ['/folio-preview.css'],
          }),
          __FOLIO_BASE__: JSON.stringify(base),
        },
      }
    },

    configResolved(resolved) {
      root = resolved.root
      foldClientEntries(resolved)
    },

    resolveId(id) {
      if (id === VIRTUAL_PREVIEW) return RESOLVED_PREVIEW
      return null
    },

    load(id) {
      if (id !== RESOLVED_PREVIEW) return null
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
        `import * as m from ${JSON.stringify(resolveBlocks())}`,
        `mountPreview(m.blocks, { wrap: m.wrap })`,
      ].join('\n')
    },
  }

  return [main]
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
  environments?: Record<string, { build?: { rollupOptions?: { input?: unknown } } }>
}): void {
  const build = resolved.environments?.client?.build
  const input = build?.rollupOptions?.input
  if (!build?.rollupOptions || !Array.isArray(input)) return

  const named: Record<string, string> = {}
  const ids: string[] = []
  for (const entry of input) {
    if (entry && typeof entry === 'object') Object.assign(named, entry)
    else if (typeof entry === 'string') ids.push(entry)
  }
  // Nothing of ours in there: some other plugin's array, left alone.
  if (Object.keys(named).length === 0) return

  const folded: Record<string, string> = {}
  for (const id of ids) {
    let name = entryName(id)
    // Two ids that reduce to the same name would silently drop one.
    for (let n = 2; name in folded; n++) name = `${entryName(id)}${n}`
    folded[name] = id
  }
  build.rollupOptions.input = { ...folded, ...named }
}

/** An id as Rollup would name its chunk: basename, no query, no extension. */
function entryName(id: string): string {
  const base = path.basename(id.split('?')[0] ?? id)
  const ext = path.extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

/**
 * `src/admin/main.tsx`, wherever the package sits. The admin ships as **source**,
 * not as a prebuilt bundle: it is an entry point of the *host's* client build (see
 * `config` above, which puts it in `rollupOptions.input`), so the host's Vite owns
 * transpiling its TSX and its `*.module.css`. That is not an assumption — a project
 * reaching this plugin has Vite by construction.
 */
function adminEntry(): string {
  const require = createRequire(import.meta.url)
  try {
    // Package self-reference. Works from `src/vite/index.ts` and from the built
    // `dist/vite.js`, since both sit inside the package whose `exports` names the
    // subpath, and `./admin-entry` is unconditional in that map.
    return require.resolve('folio/admin-entry')
  } catch {
    // A resolver with no self-reference support. `dist/vite.js` is one directory
    // below the package root; `src/vite/index.ts` is two.
    const dir = import.meta.dirname
    return path.resolve(dir, path.basename(dir) === 'vite' ? '../..' : '..', 'src/admin/main.tsx')
  }
}
