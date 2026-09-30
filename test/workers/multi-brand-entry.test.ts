import { createExecutionContext, env } from 'cloudflare:test'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server.browser'
import { beforeAll, describe, expect, it } from 'vitest'
import { blocks, defineBlock, reference, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import { defineMigration, field } from '../../src/core/migrate'
import type { DocumentType } from '../../src/core/schema'
import type {
  AuditReport,
  FolioBindings,
  FolioBrand,
  FolioConfig,
  MigrateReport,
  ReindexReport,
} from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { MCP_PROTOCOL_VERSION } from '../../src/server/mcp/rpc'
import { createToken } from '../../src/server/auth/tokens'

/**
 * Many brands in one deployment, phase 4b (`docs/specs/foundation/multi-brand.md`
 * decisions 6, 10, 16 and 21): every entry point that is off a request reaches its
 * registry through the brand of the site it serves, built through `createFolio`.
 *
 * Two brands that collide on the block names `pageRoot`, `prose` and
 * `settingsRoot` and the type names `page` and `siteSettings`, with different
 * fields, as allaboutafrica and takeoffgo do. Brand `allaboutafrica` owns `default`
 * (set by SQL, as `UPGRADING.md` says), group `east` and its site `kenya`; brand
 * `takeoffgo` owns the site `takeoffgo`. Each site has a live host and a preview
 * origin, and `auth: 'open'` lets every preview origin show drafts, so the render
 * paths are exercised without a grant.
 */

const aaaRoot = defineBlock({
  name: 'pageRoot',
  label: 'Page',
  fields: {
    title: text({ indexed: true, default: 'Karibu' }),
    strap: text(),
    body: blocks({ allow: ['prose'] }),
  },
  render: ({ title, body }) => h('main', { 'data-brand': 'aaa' }, h('h1', null, title), body),
})
const aaaProse = defineBlock({
  name: 'prose',
  label: 'Prose',
  fields: { words: text(), lang: text() },
  render: ({ words }) => h('p', { 'data-prose': 'aaa' }, words),
})
const aaaHeader = defineBlock({
  name: 'header',
  label: 'Header',
  fields: { tagline: text(), feature: reference() },
  render: ({ tagline, feature }) =>
    h(
      'header',
      null,
      tagline,
      h('nav', { 'data-ref': (feature as { title?: string } | null)?.title ?? 'UNRESOLVED' }),
    ),
})
const aaaSettings = defineBlock({
  name: 'settingsRoot',
  label: 'Settings',
  fields: { colour: text() },
  render: ({ colour }) => h('dl', { 'data-settings': 'aaa' }, colour),
})

const tgoRoot = defineBlock({
  name: 'pageRoot',
  label: 'Page',
  fields: {
    heading: text({ indexed: true, default: 'Jambo' }),
    body: blocks({ allow: ['prose'] }),
  },
  render: ({ heading, body }) => h('main', { 'data-brand': 'tgo' }, h('h2', null, heading), body),
})
const tgoProse = defineBlock({
  name: 'prose',
  label: 'Prose',
  fields: { copy: text(), tone: text() },
  render: ({ copy }) => h('p', { 'data-prose': 'tgo' }, copy),
})
const tgoSettings = defineBlock({
  name: 'settingsRoot',
  label: 'Settings',
  fields: { motto: text() },
  render: ({ motto }) => h('dl', { 'data-settings': 'tgo' }, motto),
})

const aaaTypes: DocumentType[] = [
  { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot', default: true },
  { name: 'header', label: 'Header', kind: 'singleton', root: 'header' },
  { name: 'siteSettings', label: 'Settings', kind: 'singleton', root: 'settingsRoot' },
]
const tgoTypes: DocumentType[] = [
  { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot', default: true },
  { name: 'siteSettings', label: 'Settings', kind: 'singleton', root: 'settingsRoot' },
]

/** Each brand's migration touches `prose`, the block name both brands declare. */
const AAA_MIGRATION = defineMigration({
  id: 'allaboutafrica/0001-prose-lang',
  description: 'prose.lang defaults to sw',
  up: (_doc, ctx) => ctx.each('prose', (b) => field.default(b, 'lang', 'sw')),
})
const TGO_MIGRATION = defineMigration({
  id: 'takeoffgo/0001-prose-tone',
  description: 'prose.tone defaults to warm',
  up: (_doc, ctx) => ctx.each('prose', (b) => field.default(b, 'tone', 'warm')),
})

const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
  allaboutafrica: {
    label: 'All About Africa',
    blocks: [aaaRoot, aaaProse, aaaHeader, aaaSettings],
    types: aaaTypes,
    globals: ['header'],
    settings: 'siteSettings',
    previewCss: ['/aaa-global.css'],
    migrations: [AAA_MIGRATION],
    describe: { fn: async () => ({ alt: 'AAA ALT' }) },
  },
  takeoffgo: {
    label: 'Take Off Go',
    blocks: [tgoRoot, tgoProse, tgoSettings],
    types: tgoTypes,
    settings: 'siteSettings',
    previewCss: ['/tgo-global.css'],
    migrations: [TGO_MIGRATION],
    describe: { fn: async () => ({ alt: 'TGO ALT' }) },
  },
}

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const ADMIN = 'https://cms.example'

const config: FolioConfig<Cloudflare.Env> = {
  brands,
  sites: { admin: ADMIN },
  bindings,
  basePath: '/folio',
  auth: 'open',
  logger: { warn: () => {}, error: console.error },
  assets: {
    admin: '/folio-admin.js',
    brands: {
      allaboutafrica: {
        preview: '/folio-preview-allaboutafrica.js',
        previewCss: ['/folio-preview-allaboutafrica.css'],
      },
      takeoffgo: {
        preview: '/folio-preview-takeoffgo.js',
        previewCss: ['/folio-preview-takeoffgo.css'],
      },
    },
  },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
}

// The construction test below builds this: phase 3 left `registry: rt.registry`
// reading a throwing getter here.
const folio = createFolio(config)

const blok = (
  uid: string,
  type: string,
  data: Record<string, Json>,
  parent: string | null = null,
  slot: string | null = null,
) => ({ uid, type, parent, slot, order: 'a0', data })

const aaaPage = (title: string, words: string): Doc => ({
  root: 'r0',
  bloks: {
    r0: blok('r0', 'pageRoot', { title }),
    p0: blok('p0', 'prose', { words }, 'r0', 'body'),
  },
})
const tgoPage = (heading: string, copy: string): Doc => ({
  root: 'r0',
  bloks: {
    r0: blok('r0', 'pageRoot', { heading }),
    p0: blok('p0', 'prose', { copy }, 'r0', 'body'),
  },
})
const rootOnly = (type: string, data: Record<string, Json>): Doc => ({
  root: 'r0',
  bloks: { r0: blok('r0', type, data) },
})

async function row(
  id: string,
  site: string,
  type: string,
  path: string | null,
  title: string,
  doc: Doc | null,
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, ?, null, ?, ?, 'a0', ?, 1000, ?, ?, ?)`,
  )
    .bind(
      id,
      type,
      path ?? type,
      path,
      title,
      site,
      doc ? JSON.stringify(doc) : null,
      doc ? 2000 : null,
    )
    .run()
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("update sites set brand = 'allaboutafrica' where id = 'default'"),
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
         ('east', 'group', 'East', null, null, null, 'allaboutafrica', 0, 0),
         ('kenya', 'site', 'Kenya', 'east', 'live', 'https://preview.kenya.example', 'allaboutafrica', 0, 0),
         ('takeoffgo', 'site', 'Take Off Go', null, 'live', 'https://preview.takeoffgo.example', 'takeoffgo', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('kenya.example', 'kenya'), ('takeoffgo.example', 'takeoffgo')`,
    ),
  ])
  await row('sty_aaa_home', 'kenya', 'page', 'home', 'Home', aaaPage('Karibu Kenya', 'Hello'))
  await row('sty_tgo_home', 'takeoffgo', 'page', 'home', 'Home', tgoPage('Jambo', 'Safari'))
  await row(
    'sng_siteSettings:east',
    'east',
    'siteSettings',
    null,
    'Settings',
    rootOnly('settingsRoot', { colour: 'ochre' }),
  )
  await row(
    'sng_siteSettings:takeoffgo',
    'takeoffgo',
    'siteSettings',
    null,
    'Settings',
    rootOnly('settingsRoot', { motto: 'Twende' }),
  )
})

const live = (host: string, path = '/home') => new Request(`https://${host}${path}`)

/* ------------------------------------------------------------ construction --- */

describe('construction and the registry', () => {
  it('constructs, and folio.registry throws rather than answer the first brand', () => {
    expect(folio).toBeDefined()
    expect(() => folio.registry).toThrow(/folio\.registry has no brand/)
  })

  it("answers each brand's registry from registryFor, and refuses an unconfigured brand", () => {
    expect(Object.keys(folio.registryFor('allaboutafrica').pageRoot!.fields ?? {})).toEqual([
      'title',
      'strap',
      'body',
    ])
    expect(Object.keys(folio.registryFor('takeoffgo').pageRoot!.fields ?? {})).toEqual([
      'heading',
      'body',
    ])
    expect(() => folio.registryFor('retired')).toThrow(/registryFor\('retired'\) names no brand/)
  })

  it('keeps folio.registry on a single-brand deployment, where registryFor has no brand to name', () => {
    const single = createFolio<Cloudflare.Env>({
      blocks: [aaaRoot, aaaProse],
      root: 'pageRoot',
      bindings,
      basePath: '/folio',
      auth: 'open',
      route: (p) => (p ? `/${p}` : '/'),
    })
    expect(single.registry.pageRoot).toBe(aaaRoot)
    expect(() => single.registryFor('allaboutafrica')).toThrow(/registryFor needs 'brands'/)
  })

  it('refuses a render with no resolution naming a site', () => {
    expect(() => folio.render(rootOnly('pageRoot', {}))).toThrow(/needs a resolution/)
    expect(() => folio.renderGlobal({ stories: {} } as never, 'header')).toThrow(
      /needs a resolution/,
    )
  })

  it('still throws for folio.reader with no request and no site', () => {
    expect(() => folio.reader(env)).toThrow(/a read must say which site it is for/)
  })
})

/* ------------------------------------------------------------------ render --- */

describe('a published page', () => {
  it("renders each brand's page with that brand's registry", async () => {
    const kenya = await folio.reader(env, live('kenya.example')).page('home')
    const tgo = await folio.reader(env, live('takeoffgo.example')).page('home')
    expect(kenya?.resolution.site?.brand).toBe('allaboutafrica')
    expect(tgo?.resolution.site?.brand).toBe('takeoffgo')

    const kenyaHtml = renderToString(folio.render(kenya!.doc, { resolution: kenya!.resolution }))
    const tgoHtml = renderToString(folio.render(tgo!.doc, { resolution: tgo!.resolution }))
    expect(kenyaHtml).toContain('<main data-brand="aaa"><h1>Karibu Kenya</h1>')
    expect(kenyaHtml).toContain('<p data-prose="aaa">Hello</p>')
    expect(tgoHtml).toContain('<main data-brand="tgo"><h2>Jambo</h2>')
    expect(tgoHtml).toContain('<p data-prose="tgo">Safari</p>')
    expect(tgoHtml).not.toContain('data-brand="aaa"')
  })

  it("answers folio.settings with the resolution's brand's settings", async () => {
    const kenya = await folio.reader(env, live('kenya.example')).page('home')
    const tgo = await folio.reader(env, live('takeoffgo.example')).page('home')
    expect(folio.settings(kenya!.resolution)).toEqual({ colour: 'ochre' })
    expect(folio.settings(tgo!.resolution)).toEqual({ motto: 'Twende' })
  })

  it("reads a brand's global through its own reader, and none with no site", async () => {
    expect(await folio.reader(env, { site: 'takeoffgo' }).global('header')).toBeNull()
    const none = folio.reader(env, live('nowhere.example'))
    expect(await none.global('siteSettings')).toBeNull()
    expect(await none.page('home')).toBeNull()
    await expect(none.resolve(rootOnly('pageRoot', {}))).rejects.toThrow(/has no brand/)
  })
})

/* ------------------------------------------------------------------- draft --- */

describe('draft mode on a branded preview origin', () => {
  it('reads layers without creating a row', async () => {
    const count = async () =>
      (
        await env.DB.prepare(
          "select count(*) as n from stories where type in ('header', 'siteSettings')",
        ).first<{ n: number }>()
      )?.n
    const before = await count()
    const req = new Request('https://preview.kenya.example/home', {
      headers: { cookie: 'folio_draft=1' },
    })
    const page = await folio.reader(env, req).page('home')
    expect(page?.draft).toBe(true)
    // The seed of `sty_aaa_home`'s draft, under allaboutafrica's blocks: its title
    // field carries the story's title.
    expect(page?.doc.bloks[page.doc.root]?.data.title).toBe('Home')
    expect(await count()).toBe(before)
    // No `sng_header` (the `default` layer ensureSingleton would make), nor kenya's.
    const header = await env.DB.prepare("select id from stories where id like 'sng_header%'").all()
    expect(header.results).toEqual([])
  })
})

/* ----------------------------------------------------------------- preview --- */

describe("a takeoffgo preview on takeoffgo's preview origin", () => {
  it("renders with takeoffgo's registry and links only takeoffgo's assets", async () => {
    const draft = await folio.draft(env, 'sty_tgo_home')
    await folio.write(
      env,
      'sty_tgo_home',
      [{ t: 'set', uid: draft.root, field: 'heading', value: 'Jambo Safari' }],
      { actor: 'test' },
    )
    const res = (await folio.handle(
      new Request('https://preview.takeoffgo.example/home?_folio=preview'),
      env,
      createExecutionContext(),
    )) as Response
    expect(res.status).toBe(200)
    const html = await res.text()

    expect(html).toContain('<html lang="en" data-folio-brand="takeoffgo">')
    expect(html).toContain('<main data-brand="tgo"')
    expect(html).toContain('Jambo Safari')
    expect(html).not.toContain('data-brand="aaa"')
    expect(html).toContain('/folio-preview-takeoffgo.js')
    expect(html).toContain('/folio-preview-takeoffgo.css')
    expect(html).toContain('/tgo-global.css')
    expect(html).not.toContain('allaboutafrica.js')
    expect(html).not.toContain('allaboutafrica.css')
    expect(html).not.toContain('/aaa-global.css')
  })

  it('refuses ?as= for a global only the other brand declares', async () => {
    const res = await folio.handle(
      new Request('https://preview.takeoffgo.example/home?_folio=preview&as=header'),
      env,
      createExecutionContext(),
    )
    expect(res).toBeNull()
  })
})

/* ------------------------------------------------------ the editor preview --- */

describe("the editor's bare global preview, per brand", () => {
  const bare = async (scope: string) => {
    const res = (await folio.handle(
      new Request(`${ADMIN}/folio/~${scope}/preview/global/siteSettings`),
      env,
      createExecutionContext(),
    )) as Response
    return { status: res.status, html: await res.text() }
  }

  it("renders each brand's settings layer with that brand's blocks and bundle", async () => {
    const aaa = await bare('east')
    expect(aaa.status).toBe(200)
    expect(aaa.html).toContain('<html lang="en" data-folio-brand="allaboutafrica">')
    expect(aaa.html).toContain('data-settings="aaa"')
    expect(aaa.html).toContain('/folio-preview-allaboutafrica.js')
    expect(aaa.html).not.toContain('takeoffgo.js')

    const tgo = await bare('takeoffgo')
    expect(tgo.status).toBe(200)
    expect(tgo.html).toContain('<html lang="en" data-folio-brand="takeoffgo">')
    expect(tgo.html).toContain('data-settings="tgo"')
    expect(tgo.html).toContain('/folio-preview-takeoffgo.js')
    expect(tgo.html).not.toContain('allaboutafrica.js')
  })
})

/* ------------------------------------------------------------ batch sweeps --- */

async function sweep<R extends { continueFrom: string | null }>(
  run: (continueFrom: string | null) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  let cursor: string | null = null
  do {
    const report: R = await run(cursor)
    out.push(report)
    cursor = report.continueFrom
  } while (cursor !== null && out.length < 20)
  return out
}

const publishedOf = async (id: string): Promise<Doc> => {
  const found = await env.DB.prepare('select published_doc from stories where id = ?')
    .bind(id)
    .first<{ published_doc: string }>()
  return JSON.parse(found!.published_doc) as Doc
}

describe('migrate', () => {
  it("runs each brand's migrations over that brand's scopes only", async () => {
    const reports = await sweep<MigrateReport>((continueFrom) =>
      folio.migrate(env, { continueFrom }),
    )
    expect(reports.map((r) => r.brand)).toEqual(['allaboutafrica', 'takeoffgo'])
    expect(reports[0]!.continueFrom).toBe('takeoffgo/')
    const last = reports[reports.length - 1]!
    expect(last.complete).toBe(true)
    expect(last.behind).toBe(0)

    // Both documents have a `prose`; each has only its own brand's migration.
    const aaa = (await publishedOf('sty_aaa_home')).bloks.p0!.data
    const tgo = (await publishedOf('sty_tgo_home')).bloks.p0!.data
    expect(aaa).toEqual({ words: 'Hello', lang: 'sw' })
    expect(tgo).toEqual({ copy: 'Safari', tone: 'warm' })

    const stamps = await env.DB.prepare(
      "select id, schema_id as s from stories where id in ('sty_aaa_home', 'sty_tgo_home') order by id",
    ).all<{ id: string; s: string }>()
    expect(stamps.results).toEqual([
      { id: 'sty_aaa_home', s: 'allaboutafrica/0001-prose-lang' },
      { id: 'sty_tgo_home', s: 'takeoffgo/0001-prose-tone' },
    ])
    const ledger = await env.DB.prepare('select id from schema_migrations order by id').all()
    expect(ledger.results.map((r) => r.id)).toEqual([
      'allaboutafrica/0001-prose-lang',
      'takeoffgo/0001-prose-tone',
    ])

    // A second run is clean: neither brand's applied ids read as out of order to the other.
    const again = await sweep<MigrateReport>((continueFrom) => folio.migrate(env, { continueFrom }))
    expect(again.every((r) => r.changed === 0)).toBe(true)
    expect(again[again.length - 1]!.pending).toEqual([])
  })

  it('refuses a cursor that names no brand', async () => {
    await expect(folio.migrate(env, { continueFrom: 'sty_aaa_home' })).rejects.toThrow(
      /names no brand/,
    )
  })
})

describe('reindex', () => {
  it("rebuilds each brand's documents with that brand's schema", async () => {
    await env.DB.prepare('delete from content_index').run()
    const reports = await sweep<ReindexReport>((continueFrom) =>
      folio.reindex(env, { continueFrom }),
    )
    expect(reports.map((r) => r.brand)).toEqual(['allaboutafrica', 'takeoffgo'])
    // allaboutafrica's two published documents are its home and east's settings;
    // takeoffgo's are its home and its settings.
    expect(reports.map((r) => r.documents)).toEqual([2, 2])
    const rows = await env.DB.prepare(
      "select story_id as id, field, text_value as v from content_index where story_id in ('sty_aaa_home', 'sty_tgo_home') order by story_id",
    ).all<{ id: string; field: string; v: string }>()
    expect(rows.results).toEqual([
      { id: 'sty_aaa_home', field: 'title', v: 'Karibu Kenya' },
      { id: 'sty_tgo_home', field: 'heading', v: 'Jambo' },
    ])
  })
})

describe('audit', () => {
  it('audits each brand against its own schema, one brand per report', async () => {
    const reports = await sweep<AuditReport>((continueFrom) => folio.audit(env, { continueFrom }))
    expect(reports.map((r) => r.brand)).toEqual(['allaboutafrica', 'takeoffgo'])
    // A document audited against the other brand's `pageRoot` would read every one
    // of its fields as an orphan key.
    for (const report of reports) {
      expect(report.orphanKeys).toEqual([])
      expect(report.unknownTypes).toEqual([])
    }
  })
})

describe('runSchedules', () => {
  it("publishes each story with its scope's brand's deps", async () => {
    await row('sty_aaa_sched', 'kenya', 'page', 'later', 'Later', null)
    await row('sty_tgo_sched', 'takeoffgo', 'page', 'later', 'Later', null)
    await env.DB.prepare(
      `insert into schedules (id, story_id, action, at, created_at) values
         ('sch_aaa000000001', 'sty_aaa_sched', 'publish', 5, 1),
         ('sch_tgo000000001', 'sty_tgo_sched', 'publish', 6, 1)`,
    ).run()

    const report = await folio.runSchedules(env, { now: 10 })
    expect(report.failed).toEqual([])
    expect([...report.published].sort()).toEqual(['sty_aaa_sched', 'sty_tgo_sched'])

    // Each projected with its own brand's schema: the seed's indexed field, which is
    // allaboutafrica's title (seeded from the story's) and takeoffgo's heading.
    const rows = await env.DB.prepare(
      "select story_id as id, field, text_value as v from content_index where story_id in ('sty_aaa_sched', 'sty_tgo_sched') order by story_id",
    ).all<{ id: string; field: string; v: string }>()
    expect(rows.results).toEqual([
      { id: 'sty_aaa_sched', field: 'title', v: 'Later' },
      { id: 'sty_tgo_sched', field: 'heading', v: 'Jambo' },
    ])
  })

  it("fires through POST ~<scope>/api/schedules/run only the scope's brand's schedules", async () => {
    await row('sty_aaa_run', 'kenya', 'page', 'soon', 'Soon', null)
    await row('sty_tgo_run', 'takeoffgo', 'page', 'soon', 'Soon', null)
    await env.DB.prepare(
      `insert into schedules (id, story_id, action, at, created_at) values
         ('sch_aaa000000002', 'sty_aaa_run', 'publish', 5, 1),
         ('sch_tgo000000002', 'sty_tgo_run', 'publish', 6, 1)`,
    ).run()

    const res = (await folio.handle(
      new Request(`${ADMIN}/folio/~takeoffgo/api/schedules/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ADMIN },
        body: '{}',
      }),
      env,
      createExecutionContext(),
    )) as Response
    expect(res.status).toBe(200)
    const report = (await res.json()) as {
      published: string[]
      failed: unknown[]
      remaining: number
    }
    expect(report.failed).toEqual([])
    // The permission is takeoffgo's, so allaboutafrica's due schedule is neither
    // fired nor counted.
    expect(report.published).toEqual(['sty_tgo_run'])
    expect(report.remaining).toBe(0)
    const published = async (id: string) =>
      (
        await env.DB.prepare('select published_doc is not null as p from stories where id = ?')
          .bind(id)
          .first<{ p: number }>()
      )?.p
    expect(await published('sty_tgo_run')).toBe(1)
    expect(await published('sty_aaa_run')).toBe(0)

    // The cron's sweep still covers every brand.
    const cron = await folio.runSchedules(env)
    expect(cron.published).toEqual(['sty_aaa_run'])
    const rows = await env.DB.prepare(
      "select story_id as id, field, text_value as v from content_index where story_id in ('sty_aaa_run', 'sty_tgo_run') order by story_id",
    ).all<{ id: string; field: string; v: string }>()
    expect(rows.results).toEqual([
      { id: 'sty_aaa_run', field: 'title', v: 'Soon' },
      { id: 'sty_tgo_run', field: 'heading', v: 'Jambo' },
    ])
  })
})

/* ------------------------------------------------------------ review round --- */

const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  folio.handle(
    new Request(`${ADMIN}/folio${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', origin: ADMIN, ...init.headers },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    }),
    env,
    createExecutionContext(),
  ) as Promise<Response>

describe('the batched describe run, per brand', () => {
  const asset = async (id: string, site: string) => {
    await env.MEDIA.put(`${id}.png`, 'PNGBYTES')
    await env.DB.prepare(
      `insert into assets (id, key, filename, content_type, size, width, height, alt, created_at, site_id)
       values (?, ?, ?, 'image/png', 8, 10, 10, '', 1, ?)`,
    )
      .bind(id, `${id}.png`, `${id}.png`, site)
      .run()
  }
  const altOf = async (id: string) =>
    (
      await env.DB.prepare('select alt_auto as a from assets where id = ?')
        .bind(id)
        .first<{ a: string }>()
    )?.a

  it("counts, walks and describes only the request brand's assets", async () => {
    await asset('ast_aaa00000001', 'kenya')
    await asset('ast_tgo00000001', 'takeoffgo')

    // An explicit id of another brand's asset reads as absent: nothing describes it.
    const byId = await admin('/~takeoffgo/api/assets/describe', {
      method: 'POST',
      json: { selection: { ids: ['ast_aaa00000001'] } },
    })
    expect(byId.status).toBe(200)
    expect(((await byId.json()) as { done: number }).done).toBe(0)
    expect(await altOf('ast_aaa00000001')).toBe('')

    // The confirmed count is the brand's, not the deployment's.
    const wide = await admin('/~takeoffgo/api/assets/describe', {
      method: 'POST',
      json: { selection: { all: true, filter: {}, expected: 2 } },
    })
    expect(wide.status).toBe(409)
    const all = await admin('/~takeoffgo/api/assets/describe', {
      method: 'POST',
      json: { selection: { all: true, filter: {}, expected: 1 } },
    })
    expect(all.status).toBe(200)
    expect(((await all.json()) as { done: number }).done).toBe(1)
    expect(await altOf('ast_tgo00000001')).toBe('TGO ALT')
    expect(await altOf('ast_aaa00000001')).toBe('')
  })
})

describe('a v1 read of a layer nobody has written', () => {
  it('makes no row on a preview origin; the first write does', async () => {
    const rows = async () =>
      (
        await env.DB.prepare(
          "select count(*) as n from stories where id = 'sng_header:kenya'",
        ).first<{ n: number }>()
      )?.n
    const read = (await folio.handle(
      new Request('https://preview.kenya.example/folio/~kenya/api/v1/documents/sng_header:kenya'),
      env,
      createExecutionContext(),
    )) as Response
    expect(read.status).toBe(404)
    expect(await rows()).toBe(0)

    const write = await admin('/~kenya/api/v1/documents/sng_header:kenya/fields', {
      method: 'PATCH',
      json: { fields: {} },
    })
    expect(write.status).toBe(200)
    expect(await rows()).toBe(1)
  })
})

describe("the editor's bare preview of a group's layer", () => {
  it("resolves on the group's own chain, so its references resolve", async () => {
    await row('sty_east_page', 'east', 'page', 'east-page', 'East Page', aaaPage('East', 'x'))
    await row('sng_header:east', 'east', 'header', null, 'Header', rootOnly('header', {}))
    const draft = await folio.draft(env, 'sng_header:east')
    await folio.write(
      env,
      'sng_header:east',
      [
        { t: 'set', uid: draft.root, field: 'tagline', value: 'Karibu' },
        { t: 'set', uid: draft.root, field: 'feature', value: 'sty_east_page' },
      ],
      { actor: 'test' },
    )
    const res = await admin('/~east/preview/global/header')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-ref="East Page"')
  })
})

describe('the migrate and reindex routes on a branded deployment', () => {
  it('name the brand they swept', async () => {
    const migrate = await admin('/~takeoffgo/api/migrate', { method: 'POST', json: {} })
    expect(migrate.status).toBe(200)
    expect(((await migrate.json()) as MigrateReport).brand).toBe('takeoffgo')
    const reindexed = await admin('/~kenya/api/reindex', { method: 'POST', json: {} })
    expect(reindexed.status).toBe(200)
    expect(((await reindexed.json()) as ReindexReport).brand).toBe('allaboutafrica')
  })
})

describe('a site-bound token at an unscoped URL', () => {
  const secured = createFolio({
    ...config,
    auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  } as FolioConfig<Cloudflare.Env>)
  const bearer = async (site: string | null) => {
    const { token } = await createToken(env.DB, {
      name: `bound-${site ?? 'none'}`,
      scopes: ['content:read'],
      site,
    })
    return { authorization: `Bearer ${token}` }
  }
  const get = async (path: string, who: Record<string, string>, init: RequestInit = {}) =>
    (await secured.handle(
      new Request(`${ADMIN}/folio${path}`, { ...init, headers: { ...who, ...init.headers } }),
      env,
      createExecutionContext(),
    )) as Response

  it("takes its binding's brand, over REST and in MCP's tool descriptions", async () => {
    const who = await bearer('takeoffgo')
    const docs = await get('/api/v1/documents', who)
    expect(docs.status).toBe(200)
    expect(JSON.stringify(await docs.json())).toContain('sty_tgo_home')

    const schema = await get('/api/v1/schema', who)
    expect(schema.status).toBe(200)
    const blocks = ((await schema.json()) as { blocks: { name: string; fields: object }[] }).blocks
    expect(Object.keys(blocks.find((b) => b.name === 'pageRoot')!.fields)).toEqual([
      'heading',
      'body',
    ])

    const list = await get('/mcp', who, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(list.status).toBe(200)
    const text = (
      (await list.json()) as { result: { tools: { description: string }[] } }
    ).result.tools
      .map((t) => t.description)
      .join('\n')
    expect(text).toContain('Declared document types: page, siteSettings.')
    expect(text).not.toContain('header')
  })

  it('still refuses an unbound token with no scope', async () => {
    expect((await get('/api/v1/schema', await bearer(null))).status).toBe(400)
  })
})
