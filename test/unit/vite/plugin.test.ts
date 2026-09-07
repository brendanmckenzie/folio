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

/* --------------------------------------------------- CSS Rollup hoisted out --- */

/** A stand-in for the shape `generateBundle` reads out of Rollup's bundle. */
type FakeBundle = Record<
  string,
  | { type: 'chunk'; imports?: string[]; viteMetadata?: { importedCss?: Set<string> } }
  | { type: 'asset'; source: string | Uint8Array }
>

const chunk = (imports: string[], css: string[] = []) => ({
  type: 'chunk' as const,
  imports,
  viteMetadata: { importedCss: new Set(css) },
})

/**
 * Run the plugin's `generateBundle` over a fake bundle, the way Rollup would, and
 * hand back what it left behind.
 *
 * `config()` first, because `noSplit` is state the two hooks share — running the
 * second alone would test a plugin no build can produce.
 */
function generate(userConfig: UserConfig, bundle: FakeBundle) {
  const plugin = folio({ blocks: './src/blocks/index.ts' })[0] as Plugin
  const hook = plugin.config as unknown as ConfigHook
  hook.call(plugin, userConfig, { command: 'build', mode: 'production' })

  const emitted: { fileName: string; source: string }[] = []
  const ctx = { emitFile: (f: { fileName: string; source: string }) => void emitted.push(f) }
  const gen = plugin.generateBundle as { order: string; handler: (o: unknown, b: unknown) => void }
  gen.handler.call(ctx as never, {}, bundle)

  const sourceOf = (fileName: string) => {
    const entry = bundle[fileName]
    if (entry?.type === 'asset') return String(entry.source)
    return emitted.find((f) => f.fileName === fileName)?.source
  }
  return { emitted, sourceOf, order: gen.order }
}

/**
 * The shape every host has: the preview entry renders the host's blocks, the
 * host's own pages render them too, so Rollup hoists that CSS into a shared chunk
 * with a content-hashed name — a name `config()` could not have baked.
 */
const hostWithBlocks = (): FakeBundle => ({
  'folio-preview.js': chunk(['assets/blocks-abc123.js'], ['folio-preview.css']),
  'assets/blocks-abc123.js': chunk([], ['assets/blocks-abc123.css']),
  'folio-preview.css': { type: 'asset', source: '.folio-editing{color:red}' },
  'folio-admin.js': chunk([], ['folio-admin.css']),
  'folio-admin.css': { type: 'asset', source: '.admin{}' },
})

describe('the Vite plugin, stylesheets Rollup hoisted out of an entry', () => {
  /**
   * The regression this whole hook exists for: without it `folio-preview.css`
   * holds the library's selection outlines and nothing else, and the editor's
   * iframe renders the host's blocks unstyled behind a 200.
   */
  it('imports the shared chunk the preview entry needs but cannot name', () => {
    const { sourceOf } = generate({}, hostWithBlocks())
    expect(sourceOf('folio-preview.css')).toBe(
      '@import url("/assets/blocks-abc123.css");\n.folio-editing{color:red}',
    )
  })

  it('runs after the plugins that rewrite the chunk graph', () => {
    // `vite:css-post` deletes pure-CSS chunks and re-attributes their CSS in its
    // own `generateBundle`. Reading the bundle before that is reading a graph
    // that is about to change shape.
    expect(generate({}, hostWithBlocks()).order).toBe('post')
  })

  it('leaves an entry whose CSS was not hoisted byte-identical', () => {
    const { sourceOf, emitted } = generate({}, hostWithBlocks())
    expect(sourceOf('folio-admin.css')).toBe('.admin{}')
    expect(emitted).toEqual([])
  })

  /**
   * `@charset` has to be the first thing in a stylesheet, and `@import` has to
   * precede every rule that is not one. Vite writes a charset whenever the file
   * holds a non-ASCII byte, which block content very often does.
   */
  it('keeps @charset first when it has to insert imports after it', () => {
    const bundle = hostWithBlocks()
    bundle['folio-preview.css'] = { type: 'asset', source: '@charset "UTF-8";.a{content:"→"}' }
    expect(generate({}, bundle).sourceOf('folio-preview.css')).toBe(
      '@charset "UTF-8";\n@import url("/assets/blocks-abc123.css");\n.a{content:"→"}',
    )
  })

  /**
   * An entry can reach hoisted CSS while importing none of its own, and then Vite
   * emits no file at the baked name at all — a link that 404s rather than one that
   * is merely incomplete.
   */
  it('emits the stylesheet when the entry had none of its own', () => {
    const bundle = hostWithBlocks()
    bundle['folio-preview.js'] = chunk(['assets/blocks-abc123.js'])
    delete bundle['folio-preview.css']
    expect(generate({}, bundle).sourceOf('folio-preview.css')).toBe(
      '@import url("/assets/blocks-abc123.css");\n',
    )
  })

  /** Vite's own order for an HTML entry: a chunk's dependencies before its own CSS. */
  it('imports dependencies before dependents, and each file once', () => {
    const bundle: FakeBundle = {
      'folio-preview.js': chunk(['assets/mid.js', 'assets/deep.js'], ['folio-preview.css']),
      'assets/mid.js': chunk(['assets/deep.js'], ['assets/mid.css']),
      'assets/deep.js': chunk([], ['assets/deep.css']),
      'folio-preview.css': { type: 'asset', source: '.p{}' },
    }
    expect(generate({}, bundle).sourceOf('folio-preview.css')).toBe(
      '@import url("/assets/deep.css");\n@import url("/assets/mid.css");\n.p{}',
    )
  })

  /**
   * Mirrors Vite: CSS behind a dynamic import is fetched by the preload helper
   * when the import runs, so linking it up front would load stylesheets for code
   * that may never execute.
   */
  it('does not follow dynamic imports', () => {
    const bundle = hostWithBlocks()
    bundle['folio-preview.js'] = {
      type: 'chunk',
      imports: [],
      dynamicImports: ['assets/blocks-abc123.js'],
      viteMetadata: { importedCss: new Set(['folio-preview.css']) },
    } as FakeBundle[string]
    expect(generate({}, bundle).sourceOf('folio-preview.css')).toBe('.folio-editing{color:red}')
  })

  /**
   * With one stylesheet there is nothing hoisted anywhere: both entries already
   * link it and it holds the whole client build by construction.
   */
  it('does nothing when the host turned code splitting off', () => {
    const bundle = hostWithBlocks()
    const { sourceOf, emitted } = generate({ build: { cssCodeSplit: false } }, bundle)
    expect(sourceOf('folio-preview.css')).toBe('.folio-editing{color:red}')
    expect(emitted).toEqual([])
  })

  it('reads a stylesheet Rollup handed over as bytes', () => {
    const bundle = hostWithBlocks()
    bundle['folio-preview.css'] = {
      type: 'asset',
      source: new TextEncoder().encode('.folio-editing{color:red}'),
    }
    expect(generate({}, bundle).sourceOf('folio-preview.css')).toBe(
      '@import url("/assets/blocks-abc123.css");\n.folio-editing{color:red}',
    )
  })
})
