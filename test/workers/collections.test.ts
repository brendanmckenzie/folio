import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  blocks,
  boolean,
  collection,
  defineBlock,
  multilink,
  reference,
  richtext,
  select,
  text,
} from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'

/**
 * Collections against real D1 and the real `content_index` schema
 * (`../../../docs/specs/content-model/collections.md`): the publish batch, the
 * delete cascade, every operator, reindex, and the narrowed resolution.
 *
 * Ids are prefixed `col_` throughout, because D1 state in this project is isolated
 * per *file* rather than per test and the seed fixture's own rows share the table.
 */

const TOPICS = [
  { label: 'Policy', value: 'policy' },
  { label: 'AI', value: 'ai' },
]

const insightRoot = defineBlock({
  name: 'colInsight',
  label: 'Insight',
  summary: 'title',
  fields: {
    title: text({ indexed: true, translatable: true }),
    topic: select({ options: TOPICS, indexed: true, translatable: true }),
    published: text({ indexed: true }),
    featured: boolean({ indexed: true }),
    body: richtext({ translatable: true }),
    author: reference({ types: ['colPerson'] }),
    seeAlso: multilink(),
  },
  render: () => null,
})

const indexPage = defineBlock({
  name: 'colIndexPage',
  label: 'Index page',
  summary: 'title',
  fields: {
    title: text(),
    list: collection({
      type: 'colInsight',
      filterable: ['topic', 'published'],
      maxPerPage: 6,
      defaultOrder: { field: 'published', dir: 'desc' },
    }),
    body: blocks({ allow: [] }),
  },
  render: () => null,
})

const personRecord = defineBlock({
  name: 'colPersonRecord',
  label: 'Person',
  summary: 'fullName',
  fields: { fullName: text(), homepage: multilink() },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'colPage', label: 'Page', kind: 'page', root: 'colIndexPage', default: true },
  { name: 'colInsight', label: 'Insight', kind: 'page', root: 'colInsight' },
  { name: 'colPerson', label: 'Person', kind: 'record', root: 'colPersonRecord' },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const folio = createFolio<Cloudflare.Env>({
  blocks: [insightRoot, indexPage, personRecord],
  types,
  bindings,
  basePath: '/folio',
  auth: 'open',
  route: (p) => (p ? `/${p}` : '/'),
  locales: {
    default: 'en',
    available: [
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'Français' },
    ],
  },
})

const ORIGIN = 'https://example.com'
const get = (path: string) =>
  folio.handle(new Request(`${ORIGIN}${path}`), env, createExecutionContext())

/* ------------------------------------------------------------- fixtures --- */

function insightDoc(data: Record<string, Json>, i18n?: Record<string, Record<string, Json>>): Doc {
  return {
    root: 'r0',
    bloks: {
      r0: {
        uid: 'r0',
        type: 'colInsight',
        parent: null,
        slot: null,
        order: 'a0',
        data,
        ...(i18n ? { i18n } : {}),
      },
    },
  }
}

/** Inserts a story row already published, the state every query reads. */
async function publishRow(
  id: string,
  opts: {
    type: string
    path: string | null
    title: string
    doc: Doc
    parentId?: string | null
    ord?: string
    publishedAt?: number
  },
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.type,
      opts.parentId ?? null,
      opts.path === null ? id : (opts.path.split('/').pop() ?? ''),
      opts.path,
      opts.ord ?? 'a0',
      opts.title,
      Date.now(),
      JSON.stringify(opts.doc),
      opts.publishedAt ?? Date.now(),
    )
    .run()
}

const rowsFor = async (id: string) =>
  (
    await env.DB.prepare(
      'select locale, field, text_value as text, num_value as num from content_index where story_id = ? order by locale, field',
    )
      .bind(id)
      .all<{ locale: string; field: string; text: string | null; num: number | null }>()
  ).results

const TOPIC_OF = ['policy', 'ai']

beforeAll(async () => {
  // Twelve insights under one index page: six policy, six ai, with descending
  // publish dates so ordering is observable.
  await publishRow('col_index', {
    type: 'colPage',
    path: 'colinsights',
    title: 'Insights',
    doc: {
      root: 'i0',
      bloks: {
        i0: {
          uid: 'i0',
          type: 'colIndexPage',
          parent: null,
          slot: null,
          order: 'a0',
          data: {
            title: 'Insights',
            list: { where: [{ field: 'topic', op: 'eq', value: 'policy' }], perPage: 4 },
          },
        },
      },
    },
  })

  for (let i = 0; i < 12; i++) {
    const day = String(28 - i).padStart(2, '0')
    await publishRow(`col_i${String(i).padStart(2, '0')}`, {
      type: 'colInsight',
      path: `colinsights/i${i}`,
      title: `Insight ${i}`,
      parentId: 'col_index',
      ord: `a${i}`,
      doc: insightDoc({
        title: `Insight ${i}`,
        topic: TOPIC_OF[i % 2]!,
        published: `2026-03-${day}`,
        featured: i === 0,
      }),
    })
  }

  // Rows are written by publish, and these were inserted directly — so build the
  // index the same way an existing site would: by reindexing.
  const report = await folio.reindex(env, { batch: 200 })
  expect(report.documents).toBeGreaterThan(0)
})

/* ---------------------------------------------------------------- index --- */

describe('the index', () => {
  it('has one row per indexed field per locale, and none for an absent value', async () => {
    const rows = await rowsFor('col_i01')
    // title, topic, published, featured — `featured` is false on i01, which is a
    // real value (0), so four fields; two locales (source + fr) = eight rows.
    expect(rows).toHaveLength(8)
    expect(rows.filter((r) => r.locale === '')).toHaveLength(4)
    expect(rows.filter((r) => r.locale === 'fr')).toHaveLength(4)
  })

  it('stores a date in both columns and a boolean as 0/1', async () => {
    const rows = await rowsFor('col_i00')
    const published = rows.find((r) => r.locale === '' && r.field === 'published')!
    expect(published.text).toBe('2026-03-28')
    expect(published.num).toBe(Date.parse('2026-03-28'))
    expect(rows.find((r) => r.field === 'featured' && r.locale === '')).toMatchObject({
      text: 'true',
      num: 1,
    })
  })

  it('is rewritten atomically by a publish, and the old value stops matching', async () => {
    await publishRow('col_moved', {
      type: 'colInsight',
      path: 'colinsights/moved',
      title: 'Moved',
      parentId: 'col_index',
      doc: insightDoc({ title: 'Moved', topic: 'ai', published: '2026-02-01' }),
    })
    await folio.reindex(env, { batch: 200 })
    expect(
      (await folio.query(env, { where: [{ field: 'topic', op: 'eq', value: 'ai' }] })).items.map(
        (i) => i.id,
      ),
    ).toContain('col_moved')

    // Now a real publish through the workflow, so the index write is in the same
    // `db.batch` as the `stories` update rather than a reindex sweep. Seed the
    // object from the published snapshot first, so `r0` is the uid the `set` names.
    const stub = env.STORY.get(env.STORY.idFromName('col_moved')) as unknown as {
      getOrInit: (d: Doc) => Promise<Doc>
      commit: (m: unknown[], a: { id: string; name: string }) => Promise<unknown>
    }
    await stub.getOrInit(insightDoc({ title: 'Moved', topic: 'ai', published: '2026-02-01' }))
    const committed = await stub.commit(
      [{ t: 'set', uid: 'r0', field: 'topic', value: 'policy' }],
      {
        id: 'test',
        name: 'Test',
      },
    )
    expect(committed).not.toHaveProperty('rejected')

    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/api/story/col_moved/publish`, { method: 'POST' }),
      env,
      createExecutionContext(),
    )
    expect(res?.status).toBe(200)
    // The published snapshot really is the edited draft.
    const stored = await env.DB.prepare('select published_doc from stories where id = ?')
      .bind('col_moved')
      .first<{ published_doc: string }>()
    expect((JSON.parse(stored!.published_doc) as Doc).bloks.r0?.data.topic).toBe('policy')

    const rows = await rowsFor('col_moved')
    expect(rows.find((r) => r.locale === '' && r.field === 'topic')?.text).toBe('policy')
    const ai = await folio.query(env, { where: [{ field: 'topic', op: 'eq', value: 'ai' }] })
    expect(ai.items.map((i) => i.id)).not.toContain('col_moved')
  })

  it('leaves the index when the story is unpublished, and again when it is deleted', async () => {
    await publishRow('col_gone', {
      type: 'colInsight',
      path: 'colinsights/gone',
      title: 'Gone',
      parentId: 'col_index',
      doc: insightDoc({ title: 'Gone', topic: 'policy', published: '2026-01-01' }),
    })
    await folio.reindex(env, { batch: 200 })
    expect(await rowsFor('col_gone')).not.toHaveLength(0)

    const unpub = await folio.handle(
      new Request(`${ORIGIN}/folio/api/story/col_gone/unpublish`, { method: 'POST' }),
      env,
      createExecutionContext(),
    )
    expect(unpub?.status).toBe(200)
    expect(await rowsFor('col_gone')).toHaveLength(0)

    // And a delete takes the rows with it, in the same batch as the story row.
    await publishRow('col_deleted', {
      type: 'colInsight',
      path: 'colinsights/deleted',
      title: 'Deleted',
      parentId: 'col_index',
      doc: insightDoc({ title: 'Deleted', topic: 'policy', published: '2026-01-02' }),
    })
    await folio.reindex(env, { batch: 200 })
    expect(await rowsFor('col_deleted')).not.toHaveLength(0)

    const del = await folio.handle(
      new Request(`${ORIGIN}/folio/api/stories/col_deleted`, { method: 'DELETE' }),
      env,
      createExecutionContext(),
    )
    expect(del?.status).toBe(200)
    expect(await rowsFor('col_deleted')).toHaveLength(0)
    const after = await folio.query(env, { type: 'colInsight', perPage: 100 })
    expect(after.items.map((i) => i.id)).not.toContain('col_deleted')
  })

  it('records outbound edges, so a reference can be counted before a delete', async () => {
    await publishRow('col_person', {
      type: 'colPerson',
      path: null,
      title: 'Ada',
      doc: {
        root: 'p0',
        bloks: {
          p0: {
            uid: 'p0',
            type: 'colPersonRecord',
            parent: null,
            slot: null,
            order: 'a0',
            data: { fullName: 'Ada' },
          },
        },
      },
    })
    await publishRow('col_credits', {
      type: 'colInsight',
      path: 'colinsights/credits',
      title: 'Credits',
      parentId: 'col_index',
      doc: insightDoc({
        title: 'Credits',
        topic: 'policy',
        published: '2026-03-01',
        author: 'col_person',
        seeAlso: { kind: 'story', id: 'col_i00' },
      }),
    })
    await folio.reindex(env, { batch: 200 })

    const refs = (
      await env.DB.prepare(
        'select to_story as target, kind from content_refs where from_story = ? order by kind, target',
      )
        .bind('col_credits')
        .all<{ target: string; kind: string }>()
    ).results
    expect(refs).toEqual([
      { target: 'col_i00', kind: 'link' },
      { target: 'col_person', kind: 'reference' },
    ])
  })

  /** The critical one: an id reachable only from a richtext link mark. */
  it('records a link mark’s story id, which carries no href to notice it by', async () => {
    await publishRow('col_prose', {
      type: 'colInsight',
      path: 'colinsights/prose',
      title: 'Prose',
      parentId: 'col_index',
      doc: insightDoc({
        title: 'Prose',
        topic: 'policy',
        published: '2026-03-02',
        body: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'see the policy',
                  marks: [{ type: 'link', attrs: { link: { kind: 'story', id: 'col_i00' } } }],
                },
              ],
            },
          ],
        } as unknown as Json,
      }),
    })
    await folio.reindex(env, { batch: 200 })

    const refs = (
      await env.DB.prepare('select to_story as target from content_refs where from_story = ?')
        .bind('col_prose')
        .all<{ target: string }>()
    ).results
    expect(refs.map((r) => r.target)).toEqual(['col_i00'])
  })
})

/* -------------------------------------------------------------- reindex --- */

describe('reindex', () => {
  it('is resumable by a cursor and idempotent', async () => {
    const first = await folio.reindex(env, { batch: 3 })
    expect(first.documents).toBe(3)
    expect(first.continueFrom).not.toBeNull()

    let cursor = first.continueFrom
    let sweeps = 1
    while (cursor !== null && sweeps < 40) {
      const next = await folio.reindex(env, { batch: 3, continueFrom: cursor })
      cursor = next.continueFrom
      sweeps++
    }
    expect(cursor).toBeNull()

    // Running the whole thing again produces the identical rows.
    const before = await rowsFor('col_i03')
    await folio.reindex(env, { batch: 200 })
    expect(await rowsFor('col_i03')).toEqual(before)
  })

  it('writes nothing on a dry run but reports the same counts', async () => {
    await env.DB.prepare('delete from content_index where story_id = ?').bind('col_i04').run()
    const dry = await folio.reindex(env, { batch: 200, dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.indexRows).toBeGreaterThan(0)
    expect(await rowsFor('col_i04')).toHaveLength(0)
    await folio.reindex(env, { batch: 200 })
    expect(await rowsFor('col_i04')).not.toHaveLength(0)
  })
})

/* ---------------------------------------------------------------- query --- */

describe('query', () => {
  it('filters, sorts and pages, reporting total and pages', async () => {
    const page2 = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'topic', op: 'eq', value: 'policy' }],
      order: { field: 'published', dir: 'desc' },
      perPage: 4,
      page: 2,
    })
    expect(page2.perPage).toBe(4)
    expect(page2.page).toBe(2)
    expect(page2.pages).toBe(Math.ceil(page2.total / 4))
    expect(page2.items.length).toBeLessThanOrEqual(4)
    // Newest first, and page two continues where page one stopped.
    const page1 = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'topic', op: 'eq', value: 'policy' }],
      order: { field: 'published', dir: 'desc' },
      perPage: 4,
      page: 1,
    })
    const dates1 = page1.items.map((i) => String(i.data.published))
    expect([...dates1].sort().reverse()).toEqual(dates1)
    expect(page1.items.map((i) => i.id)).not.toEqual(
      expect.arrayContaining(page2.items.map((i) => i.id)),
    )
  })

  it('hands items back as ReferenceTargets, with a URL and the root block’s data', async () => {
    const { items } = await folio.query(env, { type: 'colInsight', perPage: 1, order: 'title' })
    const item = items[0]!
    expect(item.url).toMatch(/^\/colinsights\//)
    expect(item.path).toMatch(/^colinsights\//)
    expect(typeof item.data.title).toBe('string')
    expect(item.doc.bloks[item.doc.root]?.type).toBe('colInsight')
  })

  it('answers an empty page past the end, with the right total', async () => {
    const far = await folio.query(env, { type: 'colInsight', perPage: 4, page: 99 })
    expect(far.items).toEqual([])
    expect(far.total).toBeGreaterThan(0)
  })

  it('runs every operator', async () => {
    const eq = await folio.query(env, { where: [{ field: 'featured', op: 'eq', value: 'true' }] })
    expect(eq.items.map((i) => i.id)).toEqual(['col_i00'])

    const inList = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'topic', op: 'in', value: ['policy', 'ai'] }],
      perPage: 100,
    })
    expect(inList.total).toBeGreaterThanOrEqual(12)

    const range = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'published', op: 'gte', value: '2026-03-25' }],
      perPage: 100,
    })
    expect(range.items.every((i) => String(i.data.published) >= '2026-03-25')).toBe(true)

    const numeric = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'published', op: 'lt', value: Date.parse('2026-03-20') }],
      perPage: 100,
    })
    expect(numeric.total).toBeGreaterThan(0)

    const starts = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'title', op: 'startsWith', value: 'Insight 1' }],
      perPage: 100,
    })
    expect(starts.items.every((i) => String(i.data.title).startsWith('Insight 1'))).toBe(true)

    const has = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'title', op: 'contains', value: 'sight 0' }],
      perPage: 100,
    })
    expect(has.total).toBe(1)

    // `ne` matches documents with no value for the field as well.
    const notAi = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'topic', op: 'ne', value: 'ai' }],
      perPage: 100,
    })
    expect(notAi.items.every((i) => i.data.topic !== 'ai')).toBe(true)
  })

  it('filters children of one parent, and top-level pages', async () => {
    const kids = await folio.query(env, { parent: 'col_index', perPage: 100 })
    expect(kids.total).toBeGreaterThanOrEqual(12)
    expect(kids.items.every((i) => i.path.startsWith('colinsights/'))).toBe(true)
  })

  it('matches a translated value under its locale and the source under the source', async () => {
    await publishRow('col_fr', {
      type: 'colInsight',
      path: 'colinsights/fr',
      title: 'Grid policy',
      parentId: 'col_index',
      doc: insightDoc(
        { title: 'Grid policy', topic: 'policy', published: '2026-03-05' },
        { fr: { title: 'Politique du réseau' } },
      ),
    })
    await folio.reindex(env, { batch: 200 })

    const french = await folio.query(env, {
      type: 'colInsight',
      locale: 'fr',
      where: [{ field: 'title', op: 'eq', value: 'Politique du réseau' }],
    })
    expect(french.items.map((i) => i.id)).toEqual(['col_fr'])

    const english = await folio.query(env, {
      type: 'colInsight',
      where: [{ field: 'title', op: 'eq', value: 'Grid policy' }],
    })
    expect(english.items.map((i) => i.id)).toEqual(['col_fr'])

    // The French row for an untranslated field holds the fallback, so a French
    // page filtering on `topic` still matches.
    const frTopic = await folio.query(env, {
      type: 'colInsight',
      locale: 'fr',
      where: [{ field: 'topic', op: 'eq', value: 'policy' }],
      perPage: 100,
    })
    expect(frTopic.items.map((i) => i.id)).toContain('col_fr')
  })

  it('never returns a document that is not published', async () => {
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at)
       values ('col_draft', 'colInsight', 'col_index', 'draft', 'colinsights/draft', 'z0', 'Draft', ?)`,
    )
      .bind(Date.now())
      .run()
    const all = await folio.query(env, { type: 'colInsight', perPage: 100 })
    expect(all.items.map((i) => i.id)).not.toContain('col_draft')
  })
})

/* ------------------------------------------------------- GET /content --- */

describe('GET /folio/api/content', () => {
  it('answers a ContentPage for a query spelled as parameters', async () => {
    const res = await get(
      '/folio/api/content?type=colInsight&where=topic:eq:policy&order=published:desc&perPage=4&page=1',
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { items: { id: string }[]; total: number; pages: number }
    expect(body.items.length).toBe(4)
    expect(body.total).toBeGreaterThanOrEqual(6)
    expect(body.pages).toBe(Math.ceil(body.total / 4))
  })

  it('400s naming the field for a filter on something unindexed', async () => {
    const res = await get('/folio/api/content?type=colInsight&where=secret:eq:x')
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('secret')
  })

  it('cannot be injected through a field name or a value', async () => {
    const injected = await get(
      `/folio/api/content?where=${encodeURIComponent("topic' or 1=1 --:eq:x")}`,
    )
    expect(injected?.status).toBe(400)

    const value = await get(
      `/folio/api/content?type=colInsight&where=${encodeURIComponent("topic:eq:x'; drop table stories; --")}`,
    )
    expect(value?.status).toBe(200)
    // The table is still there, which is the whole assertion.
    const still = await env.DB.prepare('select count(*) as n from stories').first<{ n: number }>()
    expect(still?.n).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------ resolve --- */

describe('resolve(): narrowed, and collections', () => {
  it('resolves a story id reachable ONLY from a richtext link mark', async () => {
    // The bug this guards: a Folio-native link mark stores `attrs.link` and has no
    // `href` at all, so a resolution that walked only `multilink` and `reference`
    // fields would leave every internal prose link with nothing to resolve — and
    // the sanitiser's own tests would still pass.
    const doc = insightDoc({
      title: 'Prose only',
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'link', attrs: { link: { kind: 'story', id: 'col_i00' } } }],
              },
            ],
          },
        ],
      } as unknown as Json,
    })

    const resolution = await folio.resolve(env, doc)
    expect(resolution.stories.col_i00).toBeDefined()
    expect(resolution.stories.col_i00?.url).toBe('/colinsights/i0')
    // And nothing else: this is the narrowing.
    expect(Object.keys(resolution.stories)).toEqual(['col_i00'])
  })

  it('loads a multilink target, a reference target, and the ancestors of opts.story', async () => {
    const doc = insightDoc({
      title: 'Linked',
      seeAlso: { kind: 'story', id: 'col_i01' },
      author: 'col_person',
    })
    const resolution = await folio.resolve(env, doc, {
      story: { id: 'col_i02', path: 'colinsights/i2', type: 'colInsight', title: 'Insight 2' },
    })
    expect(resolution.stories.col_i01).toBeDefined()
    expect(resolution.stories.col_person).toBeDefined()
    // `colinsights` is the parent; `''` is the root, which this fixture has no row
    // for — an absent ancestor is simply absent, not an error.
    expect(resolution.stories.col_index).toBeDefined()
    // The reference's document came along too.
    expect(resolution.docs?.col_person).toBeDefined()
  })

  it('loads what a REFERENCED document links to, since `stories` survives one level down', async () => {
    await env.DB.prepare('update stories set published_doc = ? where id = ?')
      .bind(
        JSON.stringify({
          root: 'p0',
          bloks: {
            p0: {
              uid: 'p0',
              type: 'colPersonRecord',
              parent: null,
              slot: null,
              order: 'a0',
              data: { fullName: 'Ada', homepage: { kind: 'story', id: 'col_i03' } },
            },
          },
        }),
        'col_person',
      )
      .run()

    const resolution = await folio.resolve(env, insightDoc({ title: 'X', author: 'col_person' }))
    expect(resolution.stories.col_person).toBeDefined()
    expect(resolution.stories.col_i03).toBeDefined()
  })

  it('runs each distinct collection query once and keys it so the block finds it', async () => {
    const indexDoc = JSON.parse(
      (await env.DB.prepare('select published_doc from stories where id = ?')
        .bind('col_index')
        .first<{ published_doc: string }>())!.published_doc,
    ) as Doc

    const resolution = await folio.resolve(env, indexDoc)
    const answers = Object.values(resolution.collections ?? {})
    expect(answers).toHaveLength(1)
    expect(answers[0]!.items.length).toBe(4)
    expect(answers[0]!.total).toBeGreaterThanOrEqual(6)
    expect(answers[0]!.stale).toBeUndefined()
    // Newest first, per the field's defaultOrder.
    const dates = answers[0]!.items.map((i) => String(i.data.published))
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('offsets every collection in the document when a host passes a page', async () => {
    const indexDoc = JSON.parse(
      (await env.DB.prepare('select published_doc from stories where id = ?')
        .bind('col_index')
        .first<{ published_doc: string }>())!.published_doc,
    ) as Doc

    const first = await folio.resolve(env, indexDoc, { page: 1 })
    const second = await folio.resolve(env, indexDoc, { page: 2 })
    const ids = (r: typeof first) => Object.values(r.collections ?? {})[0]!.items.map((i) => i.id)
    expect(second.page).toBe(2)
    expect(ids(second)).not.toEqual(ids(first))
  })

  it('costs no query at all for a document with nothing to resolve', async () => {
    let queries = 0
    const counted = new Proxy(env.DB, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === 'prepare') {
          queries++
          return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args)
        }
        return value
      },
    }) as D1Database

    await folio.resolve({ ...env, DB: counted } as Cloudflare.Env, insightDoc({ title: 'Alone' }))
    expect(queries).toBe(0)
  })
})
