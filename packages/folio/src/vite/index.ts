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
          client: {
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
    },

    resolveId(id) {
      if (id === VIRTUAL_PREVIEW) return RESOLVED_PREVIEW
      return null
    },

    load(id) {
      if (id !== RESOLVED_PREVIEW) return null
      // Generated so the preview bundle contains the project's own components
      // while the entry itself stays owned by the library.
      return [
        `import { mountPreview } from 'folio/preview'`,
        `import { blocks } from ${JSON.stringify(resolveBlocks())}`,
        `mountPreview(blocks)`,
      ].join('\n')
    },
  }

  return [main]
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
