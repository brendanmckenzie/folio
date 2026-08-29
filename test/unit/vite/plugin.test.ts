import { describe, expect, it } from 'vitest'
import type { Plugin, UserConfig } from 'vite'
import { folio } from '../../../src/vite/index'

/**
 * The Vite plugin had no test at all before this file, and the gap had a cost: a
 * host that sets `build.cssCodeSplit: false` shipped an admin linking
 * `/folio-admin.css`, a file that build does not emit. Nothing caught it, because
 * the only build in this repo is the demo's and the demo does not set the flag —
 * so `pnpm build` was green and proved nothing. Dev is green too, since Vite
 * injects entry CSS from JS there. The first sign was a deploy.
 *
 * These tests drive the `config()` hook directly rather than running a build.
 * That is the whole point: the defect lives in what the hook *computes*, and a
 * build fixture per CSS strategy would be minutes of CI to observe one string.
 */

type ConfigHook = (config: UserConfig, env: { command: 'build' | 'serve'; mode: string }) => unknown

/** Only the parts of the returned config these tests read. */
interface HookResult {
  define: Record<string, string | undefined>
  environments: {
    client: {
      build: {
        rollupOptions: { output: { assetFileNames: (asset: { names?: string[] }) => string } }
      }
    }
  }
}

interface FolioAssets {
  admin: string
  preview: string
  devClient?: string
  adminCss: string[]
  previewCss: string[]
}

function runConfig(userConfig: UserConfig, command: 'build' | 'serve' = 'build'): HookResult {
  const plugin = folio({ blocks: './src/blocks/index.ts' })[0] as Plugin
  const hook = plugin.config as unknown as ConfigHook
  const result = hook.call(plugin, userConfig, { command, mode: 'production' })
  if (!result) throw new Error('config() returned nothing')
  return result as HookResult
}

/** Read back the assets the hook baked into `__FOLIO_ASSETS__`. */
function assetsFor(userConfig: UserConfig, command: 'build' | 'serve' = 'build'): FolioAssets {
  const baked = runConfig(userConfig, command).define.__FOLIO_ASSETS__
  if (!baked) throw new Error('__FOLIO_ASSETS__ was not defined')
  return JSON.parse(baked)
}

/**
 * The `assetFileNames` callback the hook installed, invoked the way Rollup would.
 * Reaching it through the returned config rather than exporting it keeps the test
 * honest about where it actually has to be wired.
 */
function assetNamer(userConfig: UserConfig): (asset: { names?: string[] }) => string {
  return runConfig(userConfig).environments.client.build.rollupOptions.output.assetFileNames
}

describe('the Vite plugin, CSS strategy', () => {
  it('links the per-entry stylesheets when code splitting is on', () => {
    const assets = assetsFor({})
    expect(assets.adminCss).toEqual(['/folio-admin.css'])
    expect(assets.previewCss).toEqual(['/folio-preview.css'])
  })

  it('links the single bundle when the host turns code splitting off', () => {
    const assets = assetsFor({ build: { cssCodeSplit: false } })
    expect(assets.adminCss).toEqual(['/folio-client.css'])
    expect(assets.previewCss).toEqual(['/folio-client.css'])
  })

  it('sees the flag on the client environment too, not only at the top level', () => {
    const assets = assetsFor({ environments: { client: { build: { cssCodeSplit: false } } } })
    expect(assets.adminCss).toEqual(['/folio-client.css'])
    expect(assets.previewCss).toEqual(['/folio-client.css'])
  })

  it('is unaffected by the flag in dev, where Vite injects entry CSS from JS', () => {
    const assets = assetsFor({ build: { cssCodeSplit: false } }, 'serve')
    expect(assets.adminCss).toEqual([])
    expect(assets.previewCss).toEqual([])
  })

  /**
   * `style.css` is the name Vite gives the one bundled stylesheet, verified
   * against a real `cssCodeSplit: false` build of the demo: it emitted
   * `assets/style-<hash>.css` and no `folio-admin.css` at all. Left to the
   * generic branch it is hashed into `assets/`, which is exactly the path a
   * compile-time constant cannot name.
   */
  it('pins the one bundled stylesheet to a fixed path when code splitting is off', () => {
    const name = assetNamer({ build: { cssCodeSplit: false } })
    expect(name({ names: ['style.css'] })).toBe('folio-client.css')
  })

  it('still hashes ordinary assets when code splitting is off', () => {
    const name = assetNamer({ build: { cssCodeSplit: false } })
    expect(name({ names: ['logo.svg'] })).toBe('assets/[name]-[hash][extname]')
  })

  it('leaves stylesheet naming alone when code splitting is on', () => {
    const name = assetNamer({})
    expect(name({ names: ['style.css'] })).toBe('assets/[name]-[hash][extname]')
    expect(name({ names: ['folio-admin.css'] })).toBe('[name][extname]')
  })
})

describe('the Vite plugin, a CSS strategy it could not see', () => {
  /**
   * The residual hole in reading the flag from `userConfig`: a *plugin* can set
   * it, and `config()` runs before that is knowable. The paths are baked by then,
   * so the only honest move left is to fail the build — which is strictly better
   * than the silent 404 it replaces, and is the case this assertion exists for.
   */
  const resolvedWith = (cssCodeSplit: boolean) => ({
    root: '/tmp/host',
    environments: { client: { build: { cssCodeSplit, rollupOptions: {} } } },
  })

  function configure(userConfig: UserConfig, resolved: ReturnType<typeof resolvedWith>) {
    const plugin = folio({ blocks: './src/blocks/index.ts' })[0] as Plugin
    const hook = plugin.config as unknown as ConfigHook
    hook.call(plugin, userConfig, { command: 'build', mode: 'production' })
    const after = plugin.configResolved as unknown as (r: unknown) => void
    after.call(plugin, resolved)
  }

  it('throws when the client build resolved to no code splitting behind its back', () => {
    expect(() => configure({}, resolvedWith(false))).toThrow(/cssCodeSplit: false/)
  })

  it('does not throw when the host set the flag itself', () => {
    expect(() => configure({ build: { cssCodeSplit: false } }, resolvedWith(false))).not.toThrow()
  })

  it('does not throw in the ordinary case', () => {
    expect(() => configure({}, resolvedWith(true))).not.toThrow()
  })
})
