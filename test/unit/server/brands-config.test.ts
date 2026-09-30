import { describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../../src/core'
import type { Migration } from '../../../src/core/migrate'
import type { DocumentType } from '../../../src/core/schema'
import type { Registry as SiteRegistry, SiteRef } from '../../../src/core/sites'
import type { FolioBindings, FolioBrand, FolioConfig } from '../../../src/server'
import { createRuntime } from '../../../src/server/runtime'

/**
 * `createFolio({ brands })` at construction (`docs/specs/foundation/multi-brand.md`
 * decision 3): one test per refusal in the decision's list, the per-brand runtime
 * (decision 6) — two brands that declare the same block and type names, each with
 * its own — and the old `rt.*` members, which answer on a single-brand runtime
 * exactly as they always did and throw on a branded one rather than answer the
 * first brand.
 */

type Env = Record<string, never>

/** Two brands that collide on `pageRoot`, `prose` and `page`, with different fields. */
const aaaRoot = defineBlock({
  name: 'pageRoot',
  label: 'Page',
  fields: { title: text(), strap: text() },
  render: () => null,
})
const aaaProse = defineBlock({
  name: 'prose',
  label: 'Prose',
  fields: { body: text() },
  render: () => null,
})
const aaaSettings = defineBlock({
  name: 'aaaSettings',
  label: 'Settings',
  fields: { colour: text() },
  render: () => null,
})
const tgoRoot = defineBlock({
  name: 'pageRoot',
  label: 'Page',
  fields: { heading: text() },
  render: () => null,
})
const tgoProse = defineBlock({
  name: 'prose',
  label: 'Prose',
  fields: { copy: text(), lede: text() },
  render: () => null,
})

const aaaTypes: DocumentType[] = [
  { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot', default: true },
  { name: 'aaaSettings', label: 'Settings', kind: 'singleton', root: 'aaaSettings' },
]
const tgoTypes: DocumentType[] = [
  { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot', default: true },
]

const migration = (id: string): Migration => ({
  id,
  description: `migration ${id}`,
  up: () => [],
})

const aaa = (): FolioBrand<Env> => ({
  label: 'All About Africa',
  blocks: [aaaRoot, aaaProse, aaaSettings],
  types: aaaTypes,
  settings: 'aaaSettings',
  globals: ['aaaSettings'],
  previewCss: ['/aaa.css'],
})
const tgo = (): FolioBrand<Env> => ({
  label: 'Take Off Go',
  blocks: [tgoRoot, tgoProse],
  types: tgoTypes,
  migrations: [migration('takeoffgo/0001-fifty-fifty-to-feature')],
})

const bindings = () => ({}) as unknown as FolioBindings

const route = (p: string, _l?: string, site?: SiteRef) =>
  site ? `https://${site.id}.example/${p}` : `/${p}`

/** A valid two-brand config; `over` replaces keys, `undefined` removes one. */
function brandedConfig(over: Record<string, unknown> = {}): FolioConfig<Env> {
  return {
    brands: { allaboutafrica: aaa(), takeoffgo: tgo() },
    sites: { admin: 'https://cms.example' },
    assets: {
      admin: '/folio-admin.js',
      brands: {
        allaboutafrica: { preview: '/folio-preview-allaboutafrica.js', previewCss: ['/p-a.css'] },
        takeoffgo: { preview: '/folio-preview-takeoffgo.js' },
      },
    },
    bindings,
    auth: 'open',
    route,
    logger: { warn: () => {}, error: () => {} },
    ...over,
  } as FolioConfig<Env>
}

const build =
  (over: Record<string, unknown> = {}) =>
  () =>
    createRuntime(brandedConfig(over))

describe('construction refuses each misuse of brands (decision 3)', () => {
  it('constructs a valid two-brand config', () => {
    expect(build()).not.toThrow()
  })

  it('refuses brands without sites', () => {
    expect(build({ sites: undefined })).toThrow(/'brands' needs 'sites'/)
  })

  it('refuses an empty brands', () => {
    expect(build({ brands: {} })).toThrow(/'brands' is empty/)
  })

  it('refuses a brand id that does not follow the site id rule', () => {
    expect(build({ brands: { Take_Off: tgo() } })).toThrow(/brand id 'Take_Off'/)
    expect(build({ brands: { '-tgo': tgo() } })).toThrow(/brand id '-tgo'/)
  })

  it('refuses a brand with no label', () => {
    expect(build({ brands: { takeoffgo: { ...tgo(), label: ' ' } } })).toThrow(
      /'brands.takeoffgo.label'/,
    )
  })

  it.each([
    ['blocks', [aaaRoot]],
    ['root', 'pageRoot'],
    ['types', aaaTypes],
    ['globals', ['aaaSettings']],
    ['previewCss', ['/x.css']],
    ['previewWrap', () => null],
    ['gate', { field: 'x', public: true, allow: () => true }],
    ['forms', { ratePerHour: 5 }],
    ['describe', { fn: async () => ({}) }],
    ['migrations', [migration('0001-x')]],
  ])('refuses a top-level %s beside brands, naming the key', (key, value) => {
    expect(build({ [key]: value })).toThrow(
      new RegExp(`'${key}' belongs to a brand beside 'brands'`),
    )
  })

  it('refuses sites.settings beside brands', () => {
    expect(build({ sites: { admin: 'https://cms.example', settings: 'aaaSettings' } })).toThrow(
      /'sites.settings' belongs to a brand/,
    )
  })

  it('refuses an assets.brands that differs from brands, missing or extra', () => {
    const one = { admin: '/a.js', brands: { allaboutafrica: { preview: '/p.js' } } }
    expect(build({ assets: one })).toThrow(/'assets.brands' must name exactly/)
    const extra = {
      admin: '/a.js',
      brands: {
        allaboutafrica: { preview: '/p.js' },
        takeoffgo: { preview: '/t.js' },
        nobody: { preview: '/n.js' },
      },
    }
    expect(build({ assets: extra })).toThrow(/'assets.brands' must name exactly/)
    expect(build({ assets: { admin: '/a.js' } })).toThrow(/it names none/)
  })

  it('refuses an assets.preview at the top', () => {
    const assets = {
      admin: '/a.js',
      preview: '/p.js',
      brands: { allaboutafrica: { preview: '/p.js' }, takeoffgo: { preview: '/t.js' } },
    }
    expect(build({ assets })).toThrow(/'assets.preview' belongs to a brand/)
  })

  it('refuses a brand migration id that does not carry its brand', () => {
    const bare = { ...tgo(), migrations: [migration('0001-fifty-fifty-to-feature')] }
    expect(build({ brands: { allaboutafrica: aaa(), takeoffgo: bare } })).toThrow(
      /brand 'takeoffgo': migration id '0001-fifty-fifty-to-feature' must start with its brand, 'takeoffgo\/'/,
    )
  })

  it('refuses a migration id carrying another brand, the declaring brand’s prefix only', () => {
    const theirs = { ...aaa(), migrations: [migration('takeoffgo/0001-x')] }
    expect(build({ brands: { allaboutafrica: theirs, takeoffgo: tgo() } })).toThrow(
      /brand 'allaboutafrica': migration id 'takeoffgo\/0001-x'/,
    )
  })

  it('runs the single-brand migration rules below the prefix', () => {
    const mixed = {
      ...tgo(),
      migrations: [migration('takeoffgo/0001-a'), migration('takeoffgo/2-b')],
    }
    expect(build({ brands: { allaboutafrica: aaa(), takeoffgo: mixed } })).toThrow(
      /brand 'takeoffgo': .*numeric prefix of the same width/,
    )
  })

  it('runs every single-brand check per brand, naming the brand', () => {
    const twice = { ...tgo(), types: [...tgoTypes, ...tgoTypes] }
    expect(build({ brands: { allaboutafrica: aaa(), takeoffgo: twice } })).toThrow(
      /brand 'takeoffgo': duplicate document type 'page'/,
    )
    const repeated = { ...tgo(), blocks: [tgoRoot, tgoProse, tgoProse] }
    expect(build({ brands: { allaboutafrica: aaa(), takeoffgo: repeated } })).toThrow(
      /brand 'takeoffgo': duplicate block 'prose'/,
    )
    const unknownGlobal = { ...tgo(), globals: ['nav'] }
    expect(build({ brands: { allaboutafrica: aaa(), takeoffgo: unknownGlobal } })).toThrow(
      /brand 'takeoffgo': .*nav/,
    )
    const settings = { ...tgo(), settings: 'page' }
    expect(build({ brands: { allaboutafrica: aaa(), takeoffgo: settings } })).toThrow(
      /brand 'takeoffgo': 'settings' names 'page', which is not a singleton type/,
    )
  })
})

describe('one BrandRuntime per brand (decision 6)', () => {
  const rt = createRuntime(brandedConfig())
  const aaaRt = rt.brands.get('allaboutafrica')!
  const tgoRt = rt.brands.get('takeoffgo')!

  it('keeps both brands’ blocks and types under their own names', () => {
    expect([...rt.brands.keys()]).toEqual(['allaboutafrica', 'takeoffgo'])
    expect(Object.keys(aaaRt.schema.pageRoot!.fields)).toEqual(['title', 'strap'])
    expect(Object.keys(tgoRt.schema.pageRoot!.fields)).toEqual(['heading'])
    expect(Object.keys(tgoRt.schema.prose!.fields)).toEqual(['copy', 'lede'])
    expect(aaaRt.typeOf('aaaSettings')?.kind).toBe('singleton')
    expect(tgoRt.typeOf('aaaSettings')).toBeUndefined()
  })

  it('carries each brand’s ref, settings, globals, layered and migrations', () => {
    expect(aaaRt.brand).toEqual({ id: 'allaboutafrica', label: 'All About Africa' })
    expect(aaaRt.settings).toBe('aaaSettings')
    expect(aaaRt.layered).toEqual(['aaaSettings'])
    expect(tgoRt.layered).toEqual([])
    expect(tgoRt.schemaId).toBe('takeoffgo/0001-fifty-fifty-to-feature')
    expect(aaaRt.schemaId).toBeNull()
  })

  it('answers a manifest per brand, with brand and settings', () => {
    expect(aaaRt.manifest.brand).toEqual({ id: 'allaboutafrica', label: 'All About Africa' })
    expect(aaaRt.manifest.settings).toBe('aaaSettings')
    expect(aaaRt.manifest.blocks.map((b) => b.name)).toEqual(['pageRoot', 'prose', 'aaaSettings'])
    expect(tgoRt.manifest.brand).toEqual({ id: 'takeoffgo', label: 'Take Off Go' })
    expect('settings' in tgoRt.manifest).toBe(false)
    expect(tgoRt.manifest.blocks.map((b) => b.name)).toEqual(['pageRoot', 'prose'])
  })

  it('answers each brand’s own preview bundle and stylesheets', () => {
    expect(aaaRt.page('preview')).toEqual({
      entries: ['/folio-preview-allaboutafrica.js'],
      stylesheets: ['/aaa.css', '/p-a.css'],
    })
    expect(tgoRt.page('preview')).toEqual({
      entries: ['/folio-preview-takeoffgo.js'],
      stylesheets: [],
    })
    expect(rt.page('admin')).toEqual({ entries: ['/folio-admin.js'], stylesheets: [] })
    expect(() => rt.page('preview')).toThrow(/rt.page\('preview'\) has no brand/)
  })

  it('seeds from its own schema', () => {
    const doc = tgoRt.seed(tgoRt.typeOf('page'), 'Hi')
    expect(Object.keys(doc.bloks[doc.root]?.data ?? {})).toEqual(['heading'])
  })
})

describe('forScope: the brand of a scope, never a default', () => {
  const rt = createRuntime(brandedConfig())
  const row = (id: string, brand: string | null, group: string | null = null): SiteRef => ({
    id,
    name: id,
    group,
    status: 'live',
    hosts: [],
    preview: null,
    brand,
  })
  const registry: SiteRegistry = {
    sites: [row('default', 'allaboutafrica'), row('takeoffgo', 'takeoffgo', 'tg')],
    groups: [{ id: 'tg', name: 'TG', brand: 'takeoffgo' }],
    shared: false,
  }

  it('answers a site’s and a group’s brand', () => {
    expect(rt.forScope(registry, 'default')?.brand?.id).toBe('allaboutafrica')
    expect(rt.forScope(registry, 'takeoffgo')?.brand?.id).toBe('takeoffgo')
    expect(rt.forScope(registry, 'tg')?.brand?.id).toBe('takeoffgo')
  })

  it('answers null for no scope, shared, an unknown scope and a row of no brand', () => {
    expect(rt.forScope(registry, null)).toBeNull()
    expect(rt.forScope(registry, 'shared')).toBeNull()
    expect(rt.forScope(registry, 'zulu')).toBeNull()
    const unbranded = { ...registry, sites: [row('orphan', null), row('ghost', 'retired')] }
    expect(rt.forScope(unbranded, 'orphan')).toBeNull()
    expect(rt.forScope(unbranded, 'ghost')).toBeNull()
  })
})

describe('the old rt.* members', () => {
  it('are absent from a branded runtime, requiring access through rt.brands', () => {
    const rt = createRuntime(brandedConfig())
    // The schema, types, registry and other brand-specific members are no longer
    // on the runtime itself; they're accessed through rt.brands.
    expect('schema' in rt).toBe(false)
    expect('registry' in rt).toBe(false)
    expect('types' in rt).toBe(false)
    expect('manifest' in rt).toBe(false)
    expect('globals' in rt).toBe(false)
    expect('migrations' in rt).toBe(false)
    expect('gate' in rt).toBe(false)
    expect('describe' in rt).toBe(false)
    expect('forms' in rt).toBe(false)
    // rt.sites.settings is undefined on a branded runtime (one per brand)
    expect(rt.sites?.settings).toBeUndefined()
    // Everything that is the deployment's still answers.
    expect(rt.base).toBe('/folio')
    expect(rt.sites?.brands).toEqual(['allaboutafrica', 'takeoffgo'])
    expect(rt.sites?.admin).toBe('https://cms.example')
  })

  it('answer on a single-brand runtime from its one brand through rt.brands', () => {
    const rt = createRuntime<Env>({
      blocks: [aaaRoot, aaaProse, aaaSettings],
      types: aaaTypes,
      globals: ['aaaSettings'],
      bindings,
      auth: 'open',
      assets: { admin: '/folio-admin.js', preview: '/folio-preview.js', previewCss: ['/p.css'] },
      previewCss: ['/host.css'],
    })
    const one = rt.brands.get(null)!
    expect([...rt.brands.keys()]).toEqual([null])
    expect(one.brand).toBeNull()
    expect(rt.forScope({ sites: [], groups: [], shared: true }, 'anything')).toBe(one)
    // The brand-specific members are accessed through the brand, not on rt directly
    expect(one.schema).toBeDefined()
    expect(one.registry).toBeDefined()
    expect(one.types).toBe(aaaTypes)
    expect(one.manifest).toEqual({
      types: aaaTypes,
      blocks: one.manifest.blocks,
      root: 'pageRoot',
      globals: ['aaaSettings'],
    })
    expect('brand' in one.manifest).toBe(false)
    expect(rt.page('preview')).toEqual({
      entries: ['/folio-preview.js'],
      stylesheets: ['/host.css', '/p.css'],
    })
    expect(rt.page('admin')).toEqual({ entries: ['/folio-admin.js'], stylesheets: [] })
    expect(rt.sites).toBeNull()
  })

  it('answer rt.sites.settings on a single-brand multi-site runtime, as before', () => {
    const rt = createRuntime<Env>({
      blocks: [aaaRoot, aaaProse, aaaSettings],
      types: aaaTypes,
      bindings,
      auth: 'open',
      route,
      sites: { admin: 'https://cms.example', settings: 'aaaSettings' },
      logger: { warn: () => {}, error: () => {} },
    })
    expect(rt.sites?.settings).toBe('aaaSettings')
  })
})
