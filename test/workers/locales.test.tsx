import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { renderToString } from 'react-dom/server.browser'
import { describe, expect, it } from 'vitest'
import { blocks, defineBlock, richtext, text } from '../../src/core'
import type { Doc } from '../../src/core/doc'
import { PROTOCOL_VERSION } from '../../src/core/protocol'
import type { LocaleConfig } from '../../src/server'
import { createFolio } from '../../src/server'
import type { FolioBindings, StoryMeta } from '../../src/server'

/**
 * Localisation over a real D1 and a real Durable Object
 * (`../../../docs/specs/content-model/localisation.md` phase 2): rendering per
 * locale including the fallback chain, the construction-time validation, the
 * per-locale title cache, `?locale=` on the preview, and the translation route.
 *
 * Its own `createFolio` per test group, following `app.test.ts` and
 * `globals.test.ts`: the locale *config* is what is under test, and the pool's
 * `main` module cannot carry one back over its RPC boundary. D1 and Durable
 * Object state is isolated per *file*, so every story id here is unique within
 * the file.
 */

const ORIGIN = 'https://example.com'

const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  fields: {
    heading: text({ label: 'Heading', translatable: true }),
    sub: text({ label: 'Subheading', translatable: true }),
    align: text({ label: 'Alignment' }),
    prose: richtext({ label: 'Prose', translatable: true }),
  },
  render: ({ heading, sub, align, prose }) => (
    <section data-align={align}>
      <h1>{heading}</h1>
      <p>{sub}</p>
      <div className="prose">{prose}</div>
    </section>
  ),
})

const pageBlock = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', translatable: true }),
    body: blocks({ label: 'Body', allow: ['hero'] }),
  },
  render: ({ title, body }) => (
    <main>
      <title>{title}</title>
      {body}
    </main>
  ),
})

const EN_FR_DE: LocaleConfig = {
  default: 'en',
  available: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch', fallback: 'fr' },
  ],
}

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

/** `/fr/about`, `/about` for the source locale — checkpoint 4's URL prefix. */
const prefixRoute = (path: string, locale?: string) => {
  const prefix = locale && locale !== 'en' ? `/${locale}` : ''
  return path ? `${prefix}/${path}` : prefix || '/'
}

function makeFolio(locales?: LocaleConfig, route = prefixRoute) {
  return createFolio<Cloudflare.Env>({
    blocks: [pageBlock, hero],
    root: 'page',
    bindings,
    basePath: '/folio',
    assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
    auth: 'open',
    route,
    ...(locales ? { locales } : {}),
  })
}

function get(folio: ReturnType<typeof makeFolio>, path: string) {
  return folio.handle(new Request(`${ORIGIN}${path}`), env, createExecutionContext())
}

/** A page with one hero, translated as the caller asks. */
function doc(over: {
  title?: string
  titleI18n?: Record<string, Record<string, string>>
  heroData?: Record<string, string>
  heroI18n?: Record<string, Record<string, string>>
}): Doc {
  return {
    root: 'root0000',
    bloks: {
      root0000: {
        uid: 'root0000',
        type: 'page',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title: over.title ?? 'About' },
        ...(over.titleI18n ? { i18n: over.titleI18n } : {}),
      },
      hero0001: {
        uid: 'hero0001',
        type: 'hero',
        parent: 'root0000',
        slot: 'body',
        order: 'a0',
        data: { heading: 'Hello', sub: 'World', align: 'left', ...over.heroData },
        ...(over.heroI18n ? { i18n: over.heroI18n } : {}),
      },
    },
  }
}

let n = 0

async function publish(path: string, document: Doc, title = 'About'): Promise<string> {
  const id = `sty_loc${(n++).toString().padStart(5, '0')}`
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, published_doc,
                          published_at, updated_at)
     values (?, 'page', null, ?, ?, 'a0', ?, ?, ?, ?)`,
  )
    .bind(id, path || 'home', path, title, JSON.stringify(document), Date.now(), Date.now())
    .run()
  return id
}

/**
 * Seeds the story's Durable Object with `document` itself, rather than letting
 * `draftFor` mint a blank one: these tests write locale-scoped mutations against
 * known uids, and a seeded document has fresh ones.
 */
async function seedDraft(id: string, document: Doc): Promise<void> {
  const stub = env.STORY.get(env.STORY.idFromName(id))
  await runInDurableObject(stub, (instance) => instance.getOrInit(document))
}

/** One transaction through the second door into the log, with no socket. */
async function commit(
  id: string,
  mutations: Parameters<Awaited<ReturnType<typeof env.STORY.get>>['commit']>[0],
): Promise<void> {
  const stub = env.STORY.get(env.STORY.idFromName(id))
  await runInDurableObject(stub, (instance) =>
    instance.commit(mutations, { id: 'test', name: 'Test' }),
  )
}

/** The host's own render of a published page, in one locale. */
async function render(
  folio: ReturnType<typeof makeFolio>,
  path: string,
  locale?: string,
): Promise<string> {
  const document = await folio.published(env, path, locale)
  if (!document) return ''
  const resolution = await folio.resolve(env, document, { locale })
  return renderToString(folio.render(document, { resolution }) as never)
}

/* ------------------------------------------------------ construction --- */

describe('construction validation', () => {
  it('accepts a well-formed locale config', () => {
    expect(() => makeFolio(EN_FR_DE)).not.toThrow()
  })

  it('accepts no locale config at all', () => {
    expect(() => makeFolio()).not.toThrow()
  })

  it('refuses a default that is not available', () => {
    expect(() =>
      makeFolio({ default: 'fr', available: [{ code: 'en', label: 'English' }] }),
    ).toThrow(/locales.default 'fr'/)
  })

  it('refuses a duplicate locale code', () => {
    expect(() =>
      makeFolio({
        default: 'en',
        available: [
          { code: 'en', label: 'English' },
          { code: 'en', label: 'Also English' },
        ],
      }),
    ).toThrow(/duplicate locale/)
  })

  it('refuses a fallback that does not exist', () => {
    expect(() =>
      makeFolio({
        default: 'en',
        available: [
          { code: 'en', label: 'English' },
          { code: 'fr', label: 'Français', fallback: 'kl' },
        ],
      }),
    ).toThrow(/falls back to 'kl'/)
  })

  it('refuses a fallback cycle', () => {
    expect(() =>
      makeFolio({
        default: 'en',
        available: [
          { code: 'en', label: 'English' },
          { code: 'a', label: 'A', fallback: 'b' },
          { code: 'b', label: 'B', fallback: 'a' },
        ],
      }),
    ).toThrow(/fallback cycle/)
  })

  it('publishes `locales` on the manifest, and omits it for a single-locale site', async () => {
    const withLocales = await get(makeFolio(EN_FR_DE), '/folio/api/schema')
    expect((await withLocales?.json<{ locales?: LocaleConfig }>())?.locales).toEqual(EN_FR_DE)
    const without = await get(makeFolio(), '/folio/api/schema')
    expect(await without?.json<{ locales?: LocaleConfig }>()).not.toHaveProperty('locales')
  })
})

/* ---------------------------------------------------------- rendering --- */

describe('rendering a published page per locale', () => {
  it('renders the translation, and falls back per field', async () => {
    const folio = makeFolio(EN_FR_DE)
    await publish(
      'lrender',
      doc({
        titleI18n: { fr: { title: 'À propos' } },
        // `heading` translated, `sub` not.
        heroI18n: { fr: { heading: 'Bonjour' } },
      }),
    )

    const en = await render(folio, 'lrender')
    expect(en).toContain('Hello')
    expect(en).toContain('World')
    expect(en).not.toContain('Bonjour')

    const fr = await render(folio, 'lrender', 'fr')
    expect(fr).toContain('Bonjour')
    // Untranslated, so the English source shows rather than a hole.
    expect(fr).toContain('World')
    expect(fr).not.toContain('Hello')
    expect(fr).toContain('À propos')
  })

  it('follows a fallback chain before reaching the source', async () => {
    const folio = makeFolio(EN_FR_DE)
    await publish('lchain', doc({ heroI18n: { fr: { heading: 'Bonjour' } } }))
    // de falls back to fr, which has the heading; nobody has the subheading.
    const de = await render(folio, 'lchain', 'de')
    expect(de).toContain('Bonjour')
    expect(de).toContain('World')
  })

  it('renders an empty translation as empty, and a null one as the source', async () => {
    const folio = makeFolio(EN_FR_DE)
    await publish('lempty', doc({ heroI18n: { fr: { heading: '' } } }))
    expect(await render(folio, 'lempty', 'fr')).toContain('<h1></h1>')

    await publish('lnull', doc({ heroI18n: { fr: { heading: null as unknown as string } } }))
    expect(await render(folio, 'lnull', 'fr')).toContain('<h1>Hello</h1>')
  })

  it('honours a translation on a non-translatable field, as decision 4 says', async () => {
    const folio = makeFolio(EN_FR_DE)
    await publish('lunmarked', doc({ heroI18n: { fr: { align: 'droite' } } }))
    expect(await render(folio, 'lunmarked', 'fr')).toContain('data-align="droite"')
  })

  it('renders richtext per locale', async () => {
    const folio = makeFolio(EN_FR_DE)
    const prose = (body: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    })
    await publish(
      'lrich',
      doc({
        // `as unknown as string`, matching the locale branch below: a suppression on
        // the `doc(` line above suppressed nothing — biome-ignore applies to the next
        // line, not to the expression's whole subtree — so the `any` it named was
        // reported anyway. Two identical casts is the fix rather than a third comment.
        heroData: { prose: prose('English prose') as unknown as string },
        heroI18n: {
          fr: { prose: prose('Prose française') as unknown as string },
        },
      }),
    )
    expect(await render(folio, 'lrich', 'fr')).toContain('Prose française')
    expect(await render(folio, 'lrich')).toContain('English prose')
  })

  /**
   * A localised page is still a published page: same document, same renderer,
   * same zero client bundle. `render` produces markup with no script tag at all —
   * the locale never buys a hydration boundary.
   */
  it('ships no JavaScript', async () => {
    const folio = makeFolio(EN_FR_DE)
    await publish('lzerojs', doc({ heroI18n: { fr: { heading: 'Bonjour' } } }))
    const fr = await render(folio, 'lzerojs', 'fr')
    expect(fr).not.toContain('<script')
    expect(fr).not.toContain('data-folio-uid')
  })
})

/* ------------------------------------------------- published(): locale --- */

describe('published()', () => {
  it('answers the same document for every declared locale', async () => {
    const folio = makeFolio(EN_FR_DE)
    await publish('lsame', doc({ heroI18n: { fr: { heading: 'Bonjour' } } }))
    const en = await folio.published(env, 'lsame')
    const fr = await folio.published(env, 'lsame', 'fr')
    expect(fr).toEqual(en)
  })

  /**
   * The one thing the locale argument actually decides. Without it a host would
   * have to check the code itself, and `/xx/about` would serve English under a
   * URL that means nothing.
   */
  it('refuses a locale this site never declared', async () => {
    const folio = makeFolio(EN_FR_DE)
    await publish('lunknown', doc({}))
    expect(await folio.published(env, 'lunknown', 'kl')).toBeNull()
    expect(await folio.published(env, 'lunknown', 'en')).not.toBeNull()
  })

  it('refuses any locale on a site with none configured', async () => {
    const folio = makeFolio()
    await publish('lnone', doc({}))
    expect(await folio.published(env, 'lnone', 'fr')).toBeNull()
    expect(await folio.published(env, 'lnone')).not.toBeNull()
  })
})

/* ------------------------------------------------------- per-locale URLs --- */

describe('stories(): per-locale URLs', () => {
  it('carries a url and a preview url per declared locale', async () => {
    const folio = makeFolio(EN_FR_DE)
    const id = await publish('lurls', doc({}))
    const story = (await folio.stories(env)).find((s: StoryMeta) => s.id === id)

    expect(story?.url).toBe('/lurls')
    expect(story?.urls).toEqual({ en: '/lurls', fr: '/fr/lurls', de: '/de/lurls' })
    // The source locale's preview URL is the one it always was — no `&locale=`.
    expect(story?.previewUrls?.en).toBe('/lurls?_folio=preview')
    expect(story?.previewUrls?.fr).toBe('/fr/lurls?_folio=preview&locale=fr')
  })

  it('grows neither map on a single-locale site', async () => {
    const folio = makeFolio()
    const id = await publish('lbare', doc({}))
    const story = (await folio.stories(env)).find((s: StoryMeta) => s.id === id)
    expect(story).not.toHaveProperty('urls')
    expect(story).not.toHaveProperty('previewUrls')
    expect(story?.previewUrl).toBe('/lbare?_folio=preview')
  })
})

/* ------------------------------------------------------------- preview --- */

describe('the preview reads ?locale=', () => {
  it('finds the story behind a locale-prefixed URL and renders that language', async () => {
    const folio = makeFolio(EN_FR_DE)
    const id = await publish('lpreview', doc({}))
    // The draft, not the published snapshot.
    await seedDraft(id, doc({ heroI18n: { fr: { heading: 'Bonjour' } } }))

    const res = await get(folio, '/fr/lpreview?_folio=preview&locale=fr')
    expect(res?.status).toBe(200)
    const html = await res!.text()
    // Folio's own preview shell is the one piece of chrome it can get right.
    expect(html).toContain('<html lang="fr"')
    // The bootstrap carries the locale on the resolution, so the client renders
    // the same language without a second request.
    expect(html).toContain('"locale":{"code":"fr"')
  })

  it('renders the source locale, and no locale on the resolution, with no query', async () => {
    const folio = makeFolio(EN_FR_DE)
    const id = await publish('lpreviewen', doc({}))
    await seedDraft(id, doc({}))

    const res = await get(folio, '/lpreviewen?_folio=preview')
    const html = await res!.text()
    expect(html).toContain('<html lang="en"')
    expect(html).not.toContain('"locale":')
  })

  it('hands an undeclared locale back to the host rather than guessing', async () => {
    const folio = makeFolio(EN_FR_DE)
    await publish('lpreviewbad', doc({}))
    expect(await get(folio, '/kl/lpreviewbad?_folio=preview&locale=kl')).toBeNull()
  })

  /**
   * `pathForLocale` asks the host's own `route` rather than assuming a prefix, so
   * a host that puts the locale in a query parameter needs no special case.
   */
  it('works for a host whose locale is not a path prefix at all', async () => {
    const queryRoute = (path: string, locale?: string) => {
      const url = path ? `/${path}` : '/'
      return locale && locale !== 'en' ? `${url}?lang=${locale}` : url
    }
    const folio = makeFolio(EN_FR_DE, queryRoute)
    const id = await publish('lquery', doc({}))
    await seedDraft(id, doc({}))

    const res = await get(folio, '/lquery?lang=fr&_folio=preview&locale=fr')
    expect(res?.status).toBe(200)
    expect(await res!.text()).toContain('<html lang="fr"')
  })
})

/* ------------------------------------------------------- title caching --- */

describe('the per-locale title cache', () => {
  async function row(id: string) {
    return env.DB.prepare('select title, title_i18n from stories where id = ?')
      .bind(id)
      .first<{ title: string; title_i18n: string | null }>()
  }

  it('is written by publish, in every locale that has one', async () => {
    const folio = makeFolio(EN_FR_DE)
    const id = await publish('ltitles', doc({}), 'About')
    // A draft with translated titles, then publish through the real route.
    await seedDraft(id, doc({}))
    await commit(id, [
      { t: 'set', uid: 'root0000', field: 'title', value: 'À propos', locale: 'fr' },
      { t: 'set', uid: 'root0000', field: 'title', value: 'Über uns', locale: 'de' },
    ])

    const posted = await folio.handle(
      new Request(`${ORIGIN}/folio/api/story/${id}/publish`, { method: 'POST' }),
      env,
      createExecutionContext(),
    )
    expect(posted?.status).toBe(200)

    const after = await row(id)
    expect(after?.title).toBe('About')
    expect(JSON.parse(after?.title_i18n ?? 'null')).toEqual({ fr: 'À propos', de: 'Über uns' })
  })

  it('leaves the column alone on a site with no locales', async () => {
    const folio = makeFolio()
    const id = await publish('ltitlesbare', doc({}), 'Bare')
    await seedDraft(id, doc({}))
    await folio.handle(
      new Request(`${ORIGIN}/folio/api/story/${id}/publish`, { method: 'POST' }),
      env,
      createExecutionContext(),
    )
    expect((await row(id))?.title_i18n).toBeNull()
  })

  it('reaches every story read as a parsed record', async () => {
    const folio = makeFolio(EN_FR_DE)
    const id = await publish('ltitlesread', doc({}), 'Read')
    await env.DB.prepare('update stories set title_i18n = ? where id = ?')
      .bind(JSON.stringify({ fr: 'Lire' }), id)
      .run()
    const story = (await folio.stories(env)).find((s: StoryMeta) => s.id === id)
    expect(story?.titleI18n).toEqual({ fr: 'Lire' })
  })

  it('degrades to null for JSON nobody can read, rather than throwing', async () => {
    const folio = makeFolio(EN_FR_DE)
    const id = await publish('ltitlesjunk', doc({}), 'Junk')
    await env.DB.prepare('update stories set title_i18n = ? where id = ?')
      .bind('not json {{{', id)
      .run()
    const story = (await folio.stories(env)).find((s: StoryMeta) => s.id === id)
    expect(story?.titleI18n).toBeNull()
  })
})

/* ------------------------------------------------- the translation route --- */

describe('GET {base}/story/:id/translation', () => {
  it('reports what is missing in one locale', async () => {
    const folio = makeFolio(EN_FR_DE)
    const id = await publish('ltrans', doc({}), 'Trans')
    await seedDraft(id, doc({}))
    await commit(id, [
      { t: 'set', uid: 'hero0001', field: 'heading', value: 'Bonjour', locale: 'fr' },
    ])

    const res = await get(folio, `/folio/api/story/${id}/translation?locale=fr`)
    expect(res?.status).toBe(200)
    const body = await res!.json<{
      locale: string
      total: number
      translated: number
      missing: { field: string }[]
    }>()
    expect(body.locale).toBe('fr')
    // title + heading + sub have source values; `align` is not translatable and
    // `prose` is empty at source.
    expect(body.total).toBe(3)
    expect(body.translated).toBe(1)
    expect(body.missing.map((m) => m.field).sort()).toEqual(['sub', 'title'])
  })

  it('400s with no locale, and 501s for one this site never declared', async () => {
    const folio = makeFolio(EN_FR_DE)
    const id = await publish('ltransbad', doc({}), 'Bad')
    await seedDraft(id, doc({}))
    expect((await get(folio, `/folio/api/story/${id}/translation`))?.status).toBe(400)
    expect((await get(folio, `/folio/api/story/${id}/translation?locale=kl`))?.status).toBe(501)
  })

  it('501s every locale on a site with none configured', async () => {
    const folio = makeFolio()
    const id = await publish('ltransnone', doc({}), 'None')
    await seedDraft(id, doc({}))
    expect((await get(folio, `/folio/api/story/${id}/translation?locale=fr`))?.status).toBe(501)
  })
})

/* -------------------------------------------------------------- the audit --- */

describe('the audit reports what a translator cannot see', () => {
  it('names a text-ish field nobody marked translatable, only when locales exist', async () => {
    const withLocales = await makeFolio(EN_FR_DE).audit(env)
    const found = withLocales.schema.filter((f) => f.check === 'not-translatable')
    expect(found.map((f) => `${f.block}.${f.field}`)).toEqual(['hero.align'])

    const without = await makeFolio().audit(env)
    expect(without.schema.filter((f) => f.check === 'not-translatable')).toEqual([])
  })

  it('names a translated value in a field the schema does not mark translatable', async () => {
    await publish('laudit1', doc({ heroI18n: { fr: { align: 'droite' } } }))
    const report = await makeFolio(EN_FR_DE).audit(env)
    expect(report.content.some((f) => f.check === 'translated-not-translatable')).toBe(true)
  })

  it('names values under a locale the config no longer declares', async () => {
    await publish('laudit2', doc({ heroI18n: { es: { heading: 'Hola' } } }))
    const report = await makeFolio(EN_FR_DE).audit(env)
    const found = report.content.find((f) => f.check === 'unknown-locale')
    expect(found?.field).toBe('es')
  })
})

/* ------------------------------------------------- the wire, end to end --- */

describe('the wire', () => {
  // Bumped to 4 by `../../../docs/specs/editing/live-collaboration.md`: presence
  // carries a field and a locale, and a space-level channel appears. Nothing in
  // that bump touches a mutation, so v3's own guarantee below is unaffected.
  it('is version 4', () => {
    expect(PROTOCOL_VERSION).toBe(4)
  })
})
