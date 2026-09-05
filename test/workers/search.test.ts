import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  blocks,
  defineBlock,
  richtext,
  select,
  text,
  textarea,
  toSchemaIndex,
} from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import { defineMigration, field } from '../../src/core/migrate'
import type { DocumentType } from '../../src/core/schema'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'
import { contentProjection } from '../../src/server/content-index'
import { runMigrations } from '../../src/server/migrate'
import type { StoryStub } from '../../src/server/types'

/**
 * The full-text write path against real D1 and the real `0005_content_fts.sql`
 * (`../../docs/specs/content-model/full-text-search.md` phase 3): what a publish,
 * an unpublish, a delete, a reindex and a content migration each leave in
 * `content_text` and `content_fts`.
 *
 * `fts-smoke.test.ts` proves what FTS5 itself does with the statements; this file
 * proves that `server/content-index.ts` emits them, in the right order, from the
 * workflows that are supposed to.
 *
 * **`'integrity-check'` is asserted wherever a de-index happened**, because it is
 * the only assertion that can see a *partial* one. The statement order in
 * `indexStatements` is load-bearing and silent when wrong: FTS5's `'delete'`
 * command reads the old column values out of `content_text`, so running it after
 * the rows are gone raises nothing and leaves the old tokens in the index for
 * ever, matching documents that no longer contain the words. Every "the old word
 * is gone" assertion below therefore also asks `content_fts` on its own terms,
 * not only through the join — a lingering token entry answers a rowid the join
 * would silently drop.
 *
 * Story ids are prefixed `srch_` and every fixture uses a nonce word of its own
 * (`zqx…`), because D1 state is isolated per *file* rather than per test.
 */

/* --------------------------------------------------------------- schema --- */

const proseBlock = defineBlock({
  name: 'srchProse',
  label: 'Prose',
  summary: 'caption',
  fields: {
    caption: text({ translatable: true }),
    body: richtext({ translatable: true }),
    // The demo's `embed` case: raw iframe HTML nobody wants in a snippet
    // (checkpoint 2 — the one flag, and the reason it is an opt-*out*).
    embed: textarea({ searchable: false }),
  },
  render: () => null,
})

const pageRoot = defineBlock({
  name: 'srchPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ translatable: true }),
    body: blocks({ allow: ['srchProse'] }),
  },
  render: () => null,
})

/** The same prose block with its caption opted out — the reindex fixture. */
const proseNoCaption = defineBlock({
  name: 'srchProse',
  label: 'Prose',
  summary: 'caption',
  fields: {
    caption: text({ translatable: true, searchable: false }),
    body: richtext({ translatable: true }),
    embed: textarea({ searchable: false }),
  },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'srchPageType', label: 'Page', kind: 'page', root: 'srchPage', default: true },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const locales = {
  default: 'en',
  available: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
  ],
}

/**
 * Thirty declared locales, of which `searchRowsFor` keeps `MAX_SEARCH_ROWS` = 24
 * rows. At four binds a row that is 96 parameters against D1's cap of 100 and
 * `db.ts`'s budget of 90, so the insert chunks — which is the whole point of the
 * fixture.
 */
const manyLocales = {
  default: 'en',
  available: [
    { code: 'en', label: 'English' },
    ...Array.from({ length: 29 }, (_, i) => ({ code: `l${i}`, label: `Locale ${i}` })),
  ],
}

const make = (opts: { locales?: typeof locales | typeof manyLocales; noCaption?: boolean } = {}) =>
  createFolio<Cloudflare.Env>({
    blocks: [opts.noCaption ? proseNoCaption : proseBlock, pageRoot],
    types,
    bindings,
    basePath: '/folio',
    auth: 'open',
    route: (p) => (p ? `/${p}` : '/'),
    ...(opts.locales ? { locales: opts.locales } : {}),
  })

const folio = make({ locales })
const folioNoCaption = make({ locales, noCaption: true })
const wideFolio = make({ locales: manyLocales })

const ORIGIN = 'https://example.com'
const send = (path: string, method: string, body?: unknown) =>
  folio.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    createExecutionContext(),
  )

/* ------------------------------------------------------------- fixtures --- */

const richText = (...paragraphs: string[]): Json => ({
  type: 'doc',
  content: paragraphs.map((t) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: t }],
  })),
})

/** A page whose prose lives in a *child* blok — the whole-graph walk, published. */
function pageDoc(title: string, caption: string, body: string, embed = ''): Doc {
  return {
    root: 'r',
    bloks: {
      r: { uid: 'r', type: 'srchPage', parent: null, slot: null, order: 'a0', data: { title } },
      p: {
        uid: 'p',
        type: 'srchProse',
        parent: 'r',
        slot: 'body',
        order: 'a0',
        data: { caption, body: richText(body), embed },
      },
    },
  }
}

async function insertRow(
  id: string,
  opts: { path: string | null; title: string; doc: Doc; published?: boolean; type?: string },
): Promise<void> {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at)
     values (?, ?, ?, ?, ?, 'a0', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.type ?? 'srchPageType',
      null,
      opts.path === null ? id : (opts.path.split('/').pop() ?? ''),
      opts.path,
      opts.title,
      Date.now(),
      opts.published === false ? null : JSON.stringify(opts.doc),
      opts.published === false ? null : Date.now(),
    )
    .run()
}

const stubFor = (id: string) =>
  env.STORY.get(env.STORY.idFromName(id)) as unknown as { getOrInit: (d: Doc) => Promise<Doc> }

/** Row, draft and one real publish through the route — the path a site takes. */
async function seedAndPublish(id: string, doc: Doc, path: string | null = null): Promise<void> {
  await insertRow(id, { path, title: (doc.bloks.r?.data.title as string) ?? id, doc })
  await stubFor(id).getOrInit(doc)
  const res = await send(`/folio/api/story/${id}/publish`, 'POST')
  expect(res?.status).toBe(200)
}

/* ------------------------------------------------------------- readers --- */

const textRows = async (id: string) => {
  const { results } = await env.DB.prepare(
    'select locale, title, body from content_text where story_id = ? order by locale',
  )
    .bind(id)
    .all<{ locale: string; title: string; body: string }>()
  return results
}

/** `story:locale` for every indexed row this file owns that matches. */
const matched = async (query: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    `select t.story_id as story_id, t.locale as locale
     from content_fts f
     join content_text t on t.id = f.rowid
     where content_fts match ? and t.story_id like 'srch_%'
     order by t.story_id, t.locale`,
  )
    .bind(query)
    .all<{ story_id: string; locale: string }>()
  return results.map((r) => `${r.story_id}:${r.locale || '-'}`)
}

/**
 * The index asked on its own terms. `matched` joins back to `content_text`, so it
 * reports an empty set for a token FTS5 still holds against a deleted rowid —
 * exactly the state a mis-ordered de-index leaves behind.
 */
const orphanedTokens = async (query: string): Promise<number> => {
  const row = await env.DB.prepare(
    'select count(*) as n from content_fts where content_fts match ?',
  )
    .bind(query)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const integrityCheck = () =>
  env.DB.prepare("insert into content_fts(content_fts) values('integrity-check')").run()

/* --------------------------------------------------------------- publish --- */

describe('publish writes the full-text index in the same batch', () => {
  const ID = 'srch_publish'

  it('writes one row per configured locale, from the whole blok graph', async () => {
    await seedAndPublish(
      ID,
      pageDoc(
        'Zqxharbour Report',
        'Photographed at zqxcaption',
        'The harbour at zqxsunset was very quiet indeed.',
        '<iframe src="https://example.invalid/zqxembed"></iframe>',
      ),
      'zqxharbour-report',
    )

    // `''` and `fr`: the source locale plus each declared non-source one, with
    // the fallback text under `fr` because nothing is translated.
    const rows = await textRows(ID)
    expect(rows.map((r) => r.locale)).toEqual(['', 'fr'])
    for (const row of rows) {
      expect(row.title).toBe('Zqxharbour Report')
      // The caption comes from the root's *child* blok: `indexRowsFor` reads the
      // root only, and this is the invariant search deliberately breaks.
      expect(row.body).toContain('zqxcaption')
      expect(row.body).toContain('zqxsunset')
    }

    expect(await matched('zqxsunset')).toEqual([`${ID}:-`, `${ID}:fr`])
    expect(await matched('zqxcaption')).toEqual([`${ID}:-`, `${ID}:fr`])
  })

  it('leaves a `searchable: false` field out of the index entirely', async () => {
    expect((await textRows(ID)).every((r) => !r.body.includes('zqxembed'))).toBe(true)
    expect(await matched('zqxembed')).toEqual([])
  })

  it('passes FTS5’s own integrity-check after the publish', async () => {
    await expect(integrityCheck()).resolves.toBeTruthy()
  })
})

/* ------------------------------------------------------------ republish --- */

describe('republishing de-indexes before it deletes', () => {
  const ID = 'srch_replace'

  it('drops the old tokens rather than orphaning them in the index', async () => {
    await seedAndPublish(
      ID,
      pageDoc('Old', 'caption one', 'The zqxbefore word is here.'),
      'zqx-replace',
    )
    expect(await matched('zqxbefore')).toHaveLength(2)

    // Edit the draft through the mutation log, exactly as an editor would, then
    // publish again. `indexStatements` runs its four statements over a story that
    // already has rows: this is the replace half.
    await folio.write(
      env,
      ID,
      [{ t: 'set', uid: 'p', field: 'body', value: richText('The zqxafter word is here.') }],
      { actor: 'test' },
    )
    expect((await send(`/folio/api/story/${ID}/publish`, 'POST'))?.status).toBe(200)

    const rows = await textRows(ID)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.body.includes('zqxafter'))).toBe(true)
    expect(rows.every((r) => !r.body.includes('zqxbefore'))).toBe(true)

    expect(await matched('zqxafter')).toHaveLength(2)
    expect(await matched('zqxbefore')).toEqual([])

    // **The assertion the statement order exists for.** With the `'delete'`
    // command emitted after `delete from content_text` it reads an empty select,
    // raises nothing, and this count stays at two for ever.
    expect(await orphanedTokens('zqxbefore')).toBe(0)
    await expect(integrityCheck()).resolves.toBeTruthy()
  })
})

/* -------------------------------------------------- unpublish and delete --- */

describe('unpublish and delete clear it', () => {
  it('takes an unpublished document out of the index', async () => {
    const ID = 'srch_unpub'
    await seedAndPublish(ID, pageDoc('Paused', '', 'A note about zqxpaused things.'), 'zqx-paused')
    expect(await matched('zqxpaused')).toHaveLength(2)

    expect((await send(`/folio/api/story/${ID}/unpublish`, 'POST'))?.status).toBe(200)

    expect(await textRows(ID)).toEqual([])
    expect(await matched('zqxpaused')).toEqual([])
    expect(await orphanedTokens('zqxpaused')).toBe(0)
    await expect(integrityCheck()).resolves.toBeTruthy()
  })

  it('takes a deleted subtree out of it, parent and child in one `in (…)`', async () => {
    // Two ids through `clearIndexStatements`' list form, which is the shape a
    // delete uses and an unpublish does not.
    const PARENT = 'srch_del_parent'
    const CHILD = 'srch_del_child'
    await seedAndPublish(PARENT, pageDoc('Hub', '', 'The zqxhub of it all.'), 'zqx-hub')
    await insertRow(CHILD, {
      path: 'zqx-hub/leaf',
      title: 'Leaf',
      doc: pageDoc('Leaf', '', 'A zqxleaf hanging off it.'),
    })
    await env.DB.prepare('update stories set parent_id = ? where id = ?').bind(PARENT, CHILD).run()
    await stubFor(CHILD).getOrInit(pageDoc('Leaf', '', 'A zqxleaf hanging off it.'))
    expect((await send(`/folio/api/story/${CHILD}/publish`, 'POST'))?.status).toBe(200)

    expect(await matched('zqxhub')).toHaveLength(2)
    expect(await matched('zqxleaf')).toHaveLength(2)

    expect((await send(`/folio/api/stories/${PARENT}?redirect=false`, 'DELETE'))?.status).toBe(200)

    expect(await textRows(PARENT)).toEqual([])
    expect(await textRows(CHILD)).toEqual([])
    expect(await matched('zqxhub')).toEqual([])
    expect(await matched('zqxleaf')).toEqual([])
    expect(await orphanedTokens('zqxhub OR zqxleaf')).toBe(0)
    await expect(integrityCheck()).resolves.toBeTruthy()
  })
})

/* --------------------------------------------------------------- reindex --- */

describe('reindex rebuilds it from published_doc', () => {
  it('indexes a row published by hand, and counts the rows it wrote', async () => {
    const ID = 'srch_reindex'
    // Inserted already-published and never routed through `publish()` — how an
    // imported site's index comes to exist at all.
    await insertRow(ID, {
      path: 'zqx-imported',
      title: 'Imported',
      doc: pageDoc('Imported', 'zqxcap', 'Imported prose mentioning zqximported.'),
    })
    expect(await textRows(ID)).toEqual([])

    const report = await folio.reindex(env, { batch: 200 })
    expect(report.searchRows).toBeGreaterThan(0)
    expect(await textRows(ID)).toHaveLength(2)
    expect(await matched('zqximported')).toHaveLength(2)
    await expect(integrityCheck()).resolves.toBeTruthy()
  })

  it('stops finding a field that has since been marked `searchable: false`', async () => {
    // The acceptance case for the flag: nothing republishes, so only a reindex
    // can take the caption out — and it has to de-index the old tokens to do it.
    const ID = 'srch_optout'
    await seedAndPublish(ID, pageDoc('Optout', 'zqxdropped', 'Body says zqxkept.'), 'zqx-optout')
    expect(await matched('zqxdropped')).toHaveLength(2)

    await folioNoCaption.reindex(env, { batch: 200 })

    expect(await matched('zqxdropped')).toEqual([])
    expect(await orphanedTokens('zqxdropped')).toBe(0)
    expect(await matched('zqxkept')).toHaveLength(2)
    await expect(integrityCheck()).resolves.toBeTruthy()
  })
})

/* --------------------------------------------------------------- migrate --- */

/**
 * `MigrateDeps.projection` (decision 8), which closes a gap that predates search:
 * a run rewrites `published_doc` and used to write nothing else, so a migration
 * that changed an indexed or searchable value left the index describing the
 * document as it used to be until somebody reindexed by hand.
 *
 * Driven through `runMigrations` directly rather than `folio.migrate(env)`,
 * because the two places that assemble `MigrateDeps` (`server/index.tsx` and
 * `server/routes/migrations.ts`) do not pass a `projection` yet — see this
 * phase's report.
 */
describe('a content migration re-projects what it rewrote', () => {
  const schema = toSchemaIndex(folio.registry)
  const typeOf = (name: string | undefined) => types.find((t) => t.name === name)

  const REWRITE = defineMigration({
    id: '0001-zqx-rewrite',
    description: 'prose: zqxstale → zqxfresh',
    up: (_doc, ctx) =>
      ctx.each('srchProse', (b) =>
        field.map(b, 'body', () => richText('The zqxfresh word replaced it.')),
      ),
  })

  /**
   * `runMigrations` sweeps every document whose `schema_id` is behind, and every
   * fixture in this file has a null one. Stamping the rest leaves exactly the
   * document under test for the run to find, so the counts below mean what they
   * say.
   */
  const onlyBehind = (id: string) =>
    env.DB.prepare('update stories set schema_id = ? where id != ?').bind(REWRITE.id, id).run()

  const deps = (withProjection: boolean) => ({
    db: env.DB,
    schema,
    migrations: [REWRITE],
    typeOf,
    draft: (story: { id: string }) => folio.draft(env, story.id),
    stub: (id: string) => env.STORY.get(env.STORY.idFromName(id)) as unknown as StoryStub,
    ...(withProjection
      ? {
          projection: (story: { id: string; type?: string }, doc: Doc) =>
            contentProjection(story.id, doc, typeOf(story.type), schema, locales),
        }
      : {}),
  })

  it('finds the new prose and not the old, with no reindex', async () => {
    const ID = 'srch_migrate'
    await seedAndPublish(ID, pageDoc('Migrated', '', 'The zqxstale word is here.'), 'zqx-migrate')
    expect(await matched('zqxstale')).toHaveLength(2)
    await onlyBehind(ID)

    const report = await runMigrations(deps(true), { batch: 200 })
    expect(report.stories).toBe(1)
    expect(report.publishedMutations).toBeGreaterThan(0)

    expect(await matched('zqxfresh')).toHaveLength(2)
    expect(await matched('zqxstale')).toEqual([])
    expect(await orphanedTokens('zqxstale')).toBe(0)
    await expect(integrityCheck()).resolves.toBeTruthy()

    await env.DB.prepare('delete from schema_migrations').run()
    await send(`/folio/api/stories/${ID}?redirect=false`, 'DELETE')
  })

  it('leaves the index alone when no projection is supplied, as every caller did before', async () => {
    const ID = 'srch_migrate_bare'
    await seedAndPublish(
      ID,
      pageDoc('Bare', '', 'The zqxstale word is here too.'),
      'zqx-migrate-bare',
    )
    await onlyBehind(ID)

    const report = await runMigrations(deps(false), { batch: 200 })
    expect(report.stories).toBe(1)
    expect(report.publishedMutations).toBeGreaterThan(0)

    // `published_doc` moved on; the index did not. This is the documented cost of
    // the dep being optional, not a second behaviour worth having.
    expect(await matched('zqxstale')).toEqual([`${ID}:-`, `${ID}:fr`])

    await env.DB.prepare('delete from schema_migrations').run()
    await env.DB.prepare('delete from stories where id = ?').bind(ID).run()
  })
})

/* -------------------------------------------------------------- chunking --- */

describe('a document with more locale rows than one statement can bind', () => {
  it(`writes and indexes all ${24} rows, across two insert chunks`, async () => {
    // Four binds a row against a ninety-parameter budget is twenty-two rows a
    // statement, so `MAX_SEARCH_ROWS` rows chunk into 22 + 2. Both halves have to
    // land, and the statement that *indexes* them has to run after both — which
    // is what asking `content_fts` for every row proves, rather than counting
    // `content_text` alone.
    const ID = 'srch_wide'
    const doc = pageDoc('Wide', '', 'Every locale falls back to zqxwide.')
    await insertRow(ID, { path: 'zqx-wide', title: 'Wide', doc })
    await stubFor(ID).getOrInit(doc)
    const res = await wideFolio.handle(
      new Request(`${ORIGIN}/folio/api/story/${ID}/publish`, { method: 'POST' }),
      env,
      createExecutionContext(),
    )
    expect(res?.status).toBe(200)

    expect(await textRows(ID)).toHaveLength(24)
    expect(await matched('zqxwide')).toHaveLength(24)
    // Asked of `content_fts` alone rather than through the join, so "every row
    // is in the index" is not being inferred from "every row is in the table":
    // emitted before the inserts instead of after them, the indexing statement
    // sees nothing and this answers zero while `content_text` still has all 24.
    expect(await orphanedTokens('zqxwide')).toBe(24)
    await expect(integrityCheck()).resolves.toBeTruthy()
  })
})

/* =================================================== the query compiler === */

/**
 * Phase 4 against real D1 and real FTS5: what the nested statement in
 * `server/query.ts` actually answers.
 *
 * `test/unit/server/query.test.ts` pins its text and its bind order, which is the
 * only place either is visible. What it cannot see is whether SQLite accepts the
 * statement at all — a correlated `snippet()` over a paged subquery, an aliased
 * `content_text` beside an unaliased `content_fts`, and `-bm25` through a join
 * are each the sort of thing that compiles as a string and fails as SQL.
 */

const queryDoc = (title: string, body: string, i18n?: Record<string, Json>, caption = ''): Doc => {
  const doc = pageDoc(title, caption, body)
  if (i18n) {
    const prose = doc.bloks.p
    if (prose) doc.bloks.p = { ...prose, i18n: { fr: i18n } }
  }
  return doc
}

const ids = (page: { items: { id: string }[] }) => page.items.map((i) => i.id)

describe('a search, run', () => {
  it('ranks a title hit above a body hit, and scores both', async () => {
    // The root's `title` field is searchable, so a title hit is in the body
    // column too — bm25's title weight of 10 is what separates them.
    await seedAndPublish(
      'srch_q_title',
      queryDoc('Zqxrank', 'Nothing to do with it.'),
      'zqx-rank-a',
    )
    await seedAndPublish(
      'srch_q_body',
      queryDoc('Unrelated', 'A passing mention of zqxrank in the prose.'),
      'zqx-rank-b',
    )

    const page = await folio.query(env, { search: 'zqxrank' })
    expect(ids(page)).toEqual(['srch_q_title', 'srch_q_body'])
    expect(page.total).toBe(2)
    // Negated bm25: positive, and bigger is better.
    const [first, second] = page.items
    expect(first?.score).toBeGreaterThan(0)
    expect(second?.score).toBeGreaterThan(0)
    expect(first?.score ?? 0).toBeGreaterThan(second?.score ?? 0)
  })

  it('hands back a snippet split on the markers, never a <mark> string', async () => {
    const page = await folio.query(env, { search: 'zqxrank', type: 'srchPageType' })
    const snippet = page.items.find((i) => i.id === 'srch_q_body')?.snippet
    expect(snippet).toBeDefined()
    expect(snippet?.some((p) => p.match && p.text.toLowerCase().includes('zqxrank'))).toBe(true)
    expect(snippet?.some((p) => !p.match)).toBe(true)
    // The markers themselves never survive into a part.
    const open = String.fromCharCode(1)
    const close = String.fromCharCode(2)
    expect(snippet?.every((p) => !p.text.includes(open) && !p.text.includes(close))).toBe(true)
  })

  it('keeps the score under another order, and sorts by that order', async () => {
    const page = await folio.query(env, { search: 'zqxrank', order: 'publishedAt' })
    expect(page.items.every((i) => (i.score ?? 0) > 0)).toBe(true)
    expect(ids(page).sort()).toEqual(['srch_q_body', 'srch_q_title'])
  })

  it('carries neither score nor snippet when the query had no search', async () => {
    const page = await folio.query(env, { type: 'srchPageType', perPage: 1 })
    expect(page.items[0]?.score).toBeUndefined()
    expect(page.items[0]?.snippet).toBeUndefined()
  })

  it('finds a translation under its own locale and not under the source', async () => {
    await seedAndPublish(
      'srch_q_fr',
      queryDoc(
        'Coucher',
        'The zqxenglish word.',
        { body: richText('coucher de zqxsoleil') },
        'A zqxuntranslated caption.',
      ),
      'zqx-fr',
    )
    expect(ids(await folio.query(env, { search: 'zqxsoleil', locale: 'fr' }))).toEqual([
      'srch_q_fr',
    ])
    expect(ids(await folio.query(env, { search: 'zqxsoleil' }))).toEqual([])
    // A translated field *replaces* its source in the `fr` row rather than
    // joining it: the English body is not what a French visitor reads, so it is
    // not what a French search matches.
    expect(ids(await folio.query(env, { search: 'zqxenglish', locale: 'fr' }))).toEqual([])
    expect(ids(await folio.query(env, { search: 'zqxenglish' }))).toEqual(['srch_q_fr'])
    // …and the fallback is per field: a sibling nobody translated is indexed
    // under `fr` too, so a French visitor still finds a half-translated page.
    expect(ids(await folio.query(env, { search: 'zqxuntranslated', locale: 'fr' }))).toEqual([
      'srch_q_fr',
    ])
  })

  it('conjoins search with a type, and still refuses an unindexed where field', async () => {
    const refused = await folio
      .query(env, {
        search: 'zqxrank',
        type: 'srchPageType',
        where: [{ field: 'zqxnothing', op: 'eq', value: 'x' }],
      })
      .catch((e: unknown) => e)
    // Proof the field check still runs first with a search in the query.
    expect((refused as { code?: string }).code).toBe('bad_request')

    const typed = await folio.query(env, { search: 'zqxrank', type: 'srchPageType' })
    expect(ids(typed)).toEqual(['srch_q_title', 'srch_q_body'])
    expect(ids(await folio.query(env, { search: 'zqxrank', type: 'srchNoSuchType' }))).toEqual([])
  })

  it('answers a page past the end with the right total, not an error', async () => {
    const page = await folio.query(env, { search: 'zqxrank', page: 99, perPage: 10 })
    expect(page.items).toEqual([])
    expect(page.total).toBe(2)
    expect(page.pages).toBe(1)
    expect(page.page).toBe(99)
  })

  it('answers every malformed term with a well-formed page rather than a 500', async () => {
    // A `MATCH` syntax error would be a 500 with the visitor's own text in the
    // log. Every one of these reaches FTS5 as quoted terms or not at all.
    const fuzz = ['"', '-x', 'foo:bar', 'NOT', '(x', '*', '^', '"" ""', 'a'.repeat(10_000)]
    for (const search of fuzz) {
      const page = await folio.query(env, { search })
      expect(Array.isArray(page.items)).toBe(true)
      expect(typeof page.total).toBe('number')
    }
    // Nothing to search for at all: an honest empty page, never everything.
    for (const search of ['???', '🙂🙂']) {
      expect(await folio.query(env, { search })).toMatchObject({ items: [], total: 0 })
    }
  })

  it('answers the same thing over HTTP, on the internal route and the versioned one', async () => {
    const read = async (path: string) => {
      const res = await send(path, 'GET')
      expect(res?.status).toBe(200)
      return (await res?.json()) as { items: { id: string; score?: number }[] }
    }
    const internal = await read('/folio/api/content?search=zqxrank')
    const versioned = await read('/folio/api/v1/documents?search=zqxrank')
    expect(internal.items.map((i) => i.id)).toEqual(['srch_q_title', 'srch_q_body'])
    expect(versioned.items.map((i) => i.id)).toEqual(internal.items.map((i) => i.id))
    expect(internal.items[0]?.score).toBeGreaterThan(0)

    // `order=relevance` with nothing to rank is the one refusal in the family.
    const bad = await send('/folio/api/content?order=relevance', 'GET')
    expect(bad?.status).toBe(400)
    expect(JSON.stringify(await bad?.json())).toContain('relevance')
  })
})

/* ========================================================= decision 11 === */

/**
 * A search on a gated deployment is scoped to the gate's public value
 * (`full-text-search.md` decision 11), and the predicate keys off `stories.type`
 * rather than off the absence of a `content_index` row.
 *
 * The fixtures below are the whole argument, and the SQL text cannot show it —
 * only running the query can:
 *
 *   - a **gated page holding 'members'** must be absent, which any predicate
 *     gets right;
 *   - a **gated page holding nothing at all** must be absent too, because
 *     `projectValue` writes no row for an absent value and spec 31 checkpoint 2
 *     fails that closed. `exists … or not exists …` admits it;
 *   - a **record whose root never declares the field** must be present, because
 *     it is not gated at all. A predicate that simply required a public row
 *     excludes it and takes every record on the site out of search.
 *
 * The last two look identical to any row-absence test and want opposite answers.
 */

const gateRoot = defineBlock({
  name: 'srchGateRoot',
  label: 'Gated page',
  summary: 'title',
  fields: {
    title: text({ indexed: true }),
    access: select({
      options: [
        { label: 'Everyone', value: 'public' },
        { label: 'Members', value: 'members' },
      ],
      indexed: true,
    }),
    standfirst: text(),
  },
  render: () => null,
})

/** A `record` root that never heard of the gate field: not gated, and it has to
 * stay searchable. */
const noteRoot = defineBlock({
  name: 'srchNoteRoot',
  label: 'Note',
  summary: 'title',
  fields: { title: text(), note: textarea() },
  render: () => null,
})

const gateTypes: DocumentType[] = [
  { name: 'srchGateType', label: 'Gated page', kind: 'page', root: 'srchGateRoot', default: true },
  { name: 'srchNoteType', label: 'Note', kind: 'record', root: 'srchNoteRoot' },
]

const makeGated = (gated: boolean) =>
  createFolio<Cloudflare.Env>({
    blocks: [gateRoot, noteRoot],
    types: gateTypes,
    bindings,
    basePath: '/folio',
    auth: 'open',
    route: (p) => (p ? `/${p}` : '/'),
    ...(gated
      ? { gate: { field: 'access', public: 'public', visitor: () => null, allows: () => false } }
      : {}),
  })

const gatedFolio = makeGated(true)
const ungatedFolio = makeGated(false)

const gateDoc = (title: string, standfirst: string, access?: string): Doc => ({
  root: 'r',
  bloks: {
    r: {
      uid: 'r',
      type: 'srchGateRoot',
      parent: null,
      slot: null,
      order: 'a0',
      data: { title, standfirst, ...(access === undefined ? {} : { access }) },
    },
  },
})

const noteDoc = (title: string, note: string): Doc => ({
  root: 'r',
  bloks: {
    r: {
      uid: 'r',
      type: 'srchNoteRoot',
      parent: null,
      slot: null,
      order: 'a0',
      data: { title, note },
    },
  },
})

async function publishGated(
  id: string,
  doc: Doc,
  opts: { path: string | null; type: string },
): Promise<void> {
  await insertRow(id, {
    path: opts.path,
    title: (doc.bloks.r?.data.title as string) ?? id,
    doc,
    type: opts.type,
  })
  await stubFor(id).getOrInit(doc)
  const res = await gatedFolio.handle(
    new Request(`${ORIGIN}/folio/api/story/${id}/publish`, { method: 'POST' }),
    env,
    createExecutionContext(),
  )
  expect(res?.status).toBe(200)
}

describe('a gated deployment scopes a search to the public value', () => {
  const TERM = 'zqxgatecrash'

  beforeAll(async () => {
    await publishGated('srch_g_public', gateDoc('Public', `Everyone reads ${TERM}.`, 'public'), {
      path: 'zqx-g-public',
      type: 'srchGateType',
    })
    await publishGated('srch_g_members', gateDoc('Members', `Members read ${TERM}.`, 'members'), {
      path: 'zqx-g-members',
      type: 'srchGateType',
    })
    // Declares the field, holds nothing: no `content_index` row at all.
    await publishGated('srch_g_empty', gateDoc('Unset', `Nobody set ${TERM}.`), {
      path: 'zqx-g-empty',
      type: 'srchGateType',
    })
    await publishGated('srch_g_note', noteDoc('Note', `A record mentioning ${TERM}.`), {
      path: null,
      type: 'srchNoteType',
    })
  })

  it('leaves every one of them in the index, gated or not', async () => {
    // The scoping is a read-side predicate, not a write-side omission: a gated
    // document is indexed exactly like a public one and stays findable to a
    // caller that filters for it.
    expect(await matched(TERM)).toEqual([
      'srch_g_empty:-',
      'srch_g_members:-',
      'srch_g_note:-',
      'srch_g_public:-',
    ])
  })

  it('answers an unfiltered search with the public page and the ungated record only', async () => {
    const page = await gatedFolio.query(env, { search: TERM })
    expect(ids(page).sort()).toEqual(['srch_g_note', 'srch_g_public'])
    expect(page.total).toBe(2)
  })

  it('never excludes a record type whose root does not declare the field', async () => {
    // The case a predicate that simply required a public row would have broken,
    // taking every record on the site out of search with it.
    const page = await gatedFolio.query(env, { search: TERM, type: 'srchNoteType' })
    expect(ids(page)).toEqual(['srch_g_note'])
  })

  it('excludes a declaring type that holds no value at all, which is fail-closed', async () => {
    // The case `exists … or not exists …` would have admitted, silently
    // reversing spec 31 checkpoint 2. It has no `content_index` row, exactly
    // like the record above, and has to get the opposite answer.
    const page = await gatedFolio.query(env, { search: TERM, type: 'srchGateType' })
    expect(ids(page)).toEqual(['srch_g_public'])
  })

  it('steps aside entirely when the caller filters the gate field itself', async () => {
    // A members' search over members' content: the caller has taken the scoping
    // on itself, and the auto-clause is not emitted at all.
    const page = await gatedFolio.query(env, {
      search: TERM,
      where: [{ field: 'access', op: 'in', value: ['public', 'members'] }],
    })
    expect(ids(page).sort()).toEqual(['srch_g_members', 'srch_g_public'])
  })

  it('leaves a list with no search term alone, per spec 31 checkpoint 6', async () => {
    const page = await gatedFolio.query(env, { type: 'srchGateType' })
    expect(ids(page).sort()).toEqual(['srch_g_empty', 'srch_g_members', 'srch_g_public'])
  })

  it('does none of it on a deployment with no gate', async () => {
    const page = await ungatedFolio.query(env, { search: TERM })
    expect(ids(page).sort()).toEqual([
      'srch_g_empty',
      'srch_g_members',
      'srch_g_note',
      'srch_g_public',
    ])
  })
})
