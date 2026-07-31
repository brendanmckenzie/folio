import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { blocks, defineBlock, text } from '../../src/core'
import type { Blok, Doc } from '../../src/core/doc'
import { block, defineMigration, field, type Migration } from '../../src/core/migrate'
import { MAX_TX_MUTATIONS, PROTOCOL_VERSION } from '../../src/core/protocol'
import { createFolio } from '../../src/server'
import type { AuditReport, FolioBindings, MigrateReport } from '../../src/server'
import type { MigrationStatus } from '../../src/server/migrate'

/**
 * The migration runner end to end over a real D1 and real Durable Objects
 * (`schema-migrations.md` phase 3).
 *
 * Every test builds its own `createFolio`, following `app.test.ts`'s pattern
 * rather than going through `SELF`: the migration *config* is the thing under
 * test, and the pool's `main` module cannot carry one back over its RPC boundary
 * (see the trap noted for `worker.ts`).
 *
 * D1 and Durable Object state is isolated per *file*, not per test, so every test
 * takes story ids of its own.
 */

const ORIGIN = 'https://example.com'

const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title' }), body: blocks({ label: 'Body', allow: ['hero'] }) },
  render: () => null,
})

const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  summary: 'title',
  fields: { title: text({ label: 'Title' }), align: text({ label: 'Align' }) },
  render: () => null,
})

const quote = defineBlock({
  name: 'quote',
  label: 'Quote',
  summary: 'text',
  fields: { text: text({ label: 'Text' }), size: text({ label: 'Size' }) },
  render: () => null,
})

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

function makeFolio(migrations: readonly Migration[]) {
  return createFolio<Cloudflare.Env>({
    blocks: [page, hero, quote],
    root: 'page',
    migrations,
    bindings,
    basePath: '/folio',
    auth: 'open',
    route: (p) => (p ? `/${p}` : '/'),
  })
}

type Folio = ReturnType<typeof makeFolio>

const req = (folio: Folio, path: string, init?: RequestInit) =>
  folio.handle(new Request(`${ORIGIN}${path}`, init), env, createExecutionContext())

/** The canonical rename: `hero.heading` → `hero.title`. */
const RENAME = defineMigration({
  id: '0001-hero-heading-to-title',
  description: 'hero.heading → hero.title',
  up: (_doc, ctx) => ctx.each('hero', (b) => field.rename(b, 'heading', 'title')),
})

/** A retroactive default for a field added after these documents were written. */
const DEFAULT_ALIGN = defineMigration({
  id: '0002-hero-align-default',
  description: 'hero.align defaults to left',
  up: (_doc, ctx) => ctx.each('hero', (b) => field.default(b, 'align', 'left')),
})

/** Consolidates `bigQuote` into `quote` with a size. */
const RETYPE = defineMigration({
  id: '0003-bigquote-to-quote',
  description: 'bigQuote → quote, size large',
  up: (_doc, ctx) => ctx.each('bigQuote', (b) => block.retype(b, 'quote', { size: 'large' })),
})

const blok = (uid: string, type: string, data: Record<string, unknown>): Blok => ({
  uid,
  type,
  parent: 'root',
  slot: 'body',
  order: 'a0',
  data: data as Blok['data'],
})

/**
 * A story with a seeded draft that predates the schema, and optionally the same
 * document published. Seeded through the Durable Object's own `commit` (the RPC
 * this spec added) rather than by hand, so the object's log and doc row agree.
 */
async function seedStory(
  folio: Folio,
  id: string,
  bloks: Blok[],
  opts: { publish?: boolean; schemaId?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, schema_id)
     values (?, 'page', null, ?, ?, 'a0', ?, ?)`,
  )
    .bind(id, id, id, id, opts.schemaId ?? null)
    .run()

  // `folio.draft` seeds the object from the *current* schema on first touch, so
  // the pre-schema bloks have to be inserted after it.
  await folio.draft(env, id)
  const stub = env.STORY.get(env.STORY.idFromName(id))
  // Chunked, because `commit` shares the socket path's `MAX_TX_MUTATIONS` cap —
  // which is the point of the whole exercise, and would otherwise silently refuse
  // the seed for the oversized-document test below and leave it asserting on an
  // empty document.
  const inserts = bloks.map((b) => ({ t: 'insert' as const, blok: b }))
  for (let i = 0; i < inserts.length; i += MAX_TX_MUTATIONS) {
    const part = inserts.slice(i, i + MAX_TX_MUTATIONS)
    const result = await runInDurableObject(stub, (instance) =>
      instance.commit(part, { id: 'seed', name: 'Seed' }, `seed-${id}-${i}`),
    )
    if ('rejected' in result) throw new Error(`seeding ${id} was refused: ${result.rejected}`)
  }

  if (opts.publish) {
    const doc = await folio.draft(env, id)
    await env.DB.prepare('update stories set published_doc = ?, published_at = ? where id = ?')
      .bind(JSON.stringify(doc), Date.now(), id)
      .run()
  }
}

const publishedDocOf = async (id: string): Promise<Doc | null> => {
  const row = await env.DB.prepare('select published_doc from stories where id = ?')
    .bind(id)
    .first<{ published_doc: string | null }>()
  return row?.published_doc ? (JSON.parse(row.published_doc) as Doc) : null
}

/** The one hero every fixture below seeds, off a published snapshot. */
const publishedHero = (doc: Doc | null) => doc?.bloks.h1?.data

const schemaIdOf = async (id: string): Promise<string | null> => {
  const row = await env.DB.prepare('select schema_id from stories where id = ?')
    .bind(id)
    .first<{ schema_id: string | null }>()
  return row?.schema_id ?? null
}

/**
 * D1 is isolated per *file*, not per test, and the runner's whole job is to sweep
 * every row that is behind — so a leftover story from an earlier test is a story
 * this one migrates and counts. Cleared here rather than worked around with
 * per-test filters, since "how many documents are behind" is exactly what several
 * of these assert.
 *
 * Durable Object state also persists for the file, which is why every test below
 * takes story ids of its own.
 */
beforeEach(async () => {
  await env.DB.prepare('delete from schema_migrations').run()
  await env.DB.prepare('delete from versions').run()
  await env.DB.prepare('delete from stories').run()
})

describe('folio.migrate: a rename reaches every copy of a document', () => {
  it('migrates the draft as a logged transaction and the published snapshot in place', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_rename', [blok('h1', 'hero', { heading: 'Hi' })], {
      publish: true,
    })

    const report = await folio.migrate(env)
    expect(report).toMatchObject({
      pending: ['0001-hero-heading-to-title'],
      stories: 1,
      changed: 1,
      unchanged: 0,
      mutations: 2,
      publishedMutations: 2,
      transactions: 1,
      failed: [],
      oversized: [],
      complete: true,
      continueFrom: null,
    })

    // The draft: a *logged* transaction, not a rewrite. That is what makes it
    // sync, appear in the activity trail and undo.
    const draft = await folio.draft(env, 'mig_rename')
    expect(draft.bloks.h1!.data).toEqual({ heading: null, title: 'Hi' })
    const stub = env.STORY.get(env.STORY.idFromName('mig_rename'))
    const trail = (await runInDurableObject(stub, (instance) => instance.recent())).rows
    expect(trail[0]).toMatchObject({
      actor: 'migration:0001-hero-heading-to-title',
      actorName: 'Migration 0001-hero-heading-to-title',
    })

    // The published snapshot: one D1 write, batched with the watermark.
    expect(publishedHero(await publishedDocOf('mig_rename'))).toEqual({
      heading: null,
      title: 'Hi',
    })
    expect(await schemaIdOf('mig_rename')).toBe('0001-hero-heading-to-title')

    // The ledger.
    const ledger = await env.DB.prepare('select * from schema_migrations').all<{
      id: string
      stories_changed: number
      failed: string | null
    }>()
    expect(ledger.results).toHaveLength(1)
    expect(ledger.results[0]).toMatchObject({
      id: '0001-hero-heading-to-title',
      stories_changed: 1,
      failed: null,
    })
  })

  /**
   * The published snapshot's mutations are computed *independently* of the
   * draft's, and this is why: the snapshot was taken at some past publish, so it
   * is a different document. Replaying the draft's mutations at it would migrate
   * only what happens to overlap.
   */
  it('migrates a published snapshot that has diverged from the draft', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_diverged', [blok('h1', 'hero', { heading: 'Old' })], {
      publish: true,
    })
    // The draft moves on: a second hero the snapshot has never seen.
    const stub = env.STORY.get(env.STORY.idFromName('mig_diverged'))
    await runInDurableObject(stub, (instance) =>
      instance.commit(
        [{ t: 'insert', blok: blok('h2', 'hero', { heading: 'New' }) }],
        { id: 'editor', name: 'Editor' },
        'diverge',
      ),
    )

    await folio.migrate(env)

    const published = await publishedDocOf('mig_diverged')
    expect(publishedHero(published)).toEqual({ heading: null, title: 'Old' })
    // The snapshot never had h2, so nothing invented one there.
    expect(published?.bloks.h2).toBeUndefined()
    const draft = await folio.draft(env, 'mig_diverged')
    expect(draft.bloks.h2!.data).toEqual({ heading: null, title: 'New' })
  })

  it('reaches a connected editor live, as a delta on the open socket', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_live', [blok('h1', 'hero', { heading: 'Hi' })])

    const res = await req(folio, '/folio/api/story/mig_live/socket', {
      headers: { Upgrade: 'websocket' },
    })
    const ws = res?.webSocket
    if (!ws) throw new Error('no socket')
    ws.accept()
    const inbox: { type: string }[] = []
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data as string)))
    ws.send(
      JSON.stringify({
        type: 'hello',
        lastSyncId: 0,
        identity: { actor: 'a', name: 'A', colour: '#ffffff' },
        v: PROTOCOL_VERSION,
      }),
    )
    for (let i = 0; i < 200 && inbox.length === 0; i++) await new Promise((r) => setTimeout(r, 1))

    await folio.migrate(env)

    for (let i = 0; i < 300; i++) {
      if (inbox.some((f) => f.type === 'delta')) break
      await new Promise((r) => setTimeout(r, 1))
    }
    const delta = inbox.find((f) => f.type === 'delta') as
      | { mutations: { field: string }[] }
      | undefined
    expect(delta?.mutations.map((m) => m.field)).toEqual(['title', 'heading'])
    ws.close()
  })
})

/**
 * Checkpoint 2, and the whole correctness mechanism: a migration applied to an
 * already-migrated document produces zero mutations. Which makes the ledger an
 * optimisation rather than a guarantee — so this deletes the ledger row first, to
 * prove idempotence rather than bookkeeping (the spec's own acceptance criterion).
 */
describe('folio.migrate: re-running does nothing', () => {
  it('reports 0 changed and writes no transaction, with the ledger row deleted', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_again', [blok('h1', 'hero', { heading: 'Hi' })], { publish: true })
    await folio.migrate(env)

    const stub = env.STORY.get(env.STORY.idFromName('mig_again'))
    const before = (await runInDurableObject(stub, (i) => i.recent())).rows.length
    // The ledger is not the mechanism. Prove it.
    await env.DB.prepare('delete from schema_migrations').run()
    await env.DB.prepare('update stories set schema_id = null where id = ?').bind('mig_again').run()

    const second = await folio.migrate(env)
    expect(second).toMatchObject({ stories: 1, changed: 0, unchanged: 1, mutations: 0 })
    expect((await runInDurableObject(stub, (i) => i.recent())).rows.length).toBe(before)
  })
})

describe('folio.migrate: retype', () => {
  it('changes the type, keeps the uid and the children, and sets the new field', async () => {
    const folio = makeFolio([RETYPE])
    await seedStory(folio, 'mig_retype', [
      blok('bq', 'bigQuote', { text: 'Hi' }),
      { ...blok('c1', 'hero', { title: 'one' }), parent: 'bq', slot: 'body', order: 'a0' },
      { ...blok('c2', 'hero', { title: 'two' }), parent: 'bq', slot: 'body', order: 'a1' },
    ])

    await folio.migrate(env)

    const draft = await folio.draft(env, 'mig_retype')
    expect(draft.bloks.bq).toMatchObject({
      uid: 'bq',
      type: 'quote',
      parent: 'root',
      data: { text: 'Hi', size: 'large' },
    })
    expect(draft.bloks.c1).toMatchObject({ parent: 'bq', order: 'a0' })
    expect(draft.bloks.c2).toMatchObject({ parent: 'bq', order: 'a1' })
  })
})

describe('folio.migrate: dry run', () => {
  it('counts everything and writes nothing at all', async () => {
    const folio = makeFolio([RENAME, DEFAULT_ALIGN])
    await seedStory(folio, 'mig_dry', [blok('h1', 'hero', { heading: 'Hi' })], { publish: true })

    const report = await folio.migrate(env, { dryRun: true })
    expect(report).toMatchObject({
      pending: ['0001-hero-heading-to-title', '0002-hero-align-default'],
      dryRun: true,
      stories: 1,
      changed: 1,
      // rename's two, plus one default fill.
      mutations: 3,
      complete: false,
    })

    // Nothing logged, nothing published, no ledger row, no watermark.
    const stub = env.STORY.get(env.STORY.idFromName('mig_dry'))
    expect((await runInDurableObject(stub, (i) => i.recent())).rows).toHaveLength(1) // just the seed
    expect(publishedHero(await publishedDocOf('mig_dry'))).toEqual({ heading: 'Hi' })
    expect(await schemaIdOf('mig_dry')).toBeNull()
    const ledger = await env.DB.prepare('select count(*) as n from schema_migrations').first<{
      n: number
    }>()
    expect(ledger?.n).toBe(0)
  })
})

/**
 * The `migrated` hook (`../../../docs/specs/platform/caching.md`). A run
 * rewrites `published_doc` per story and used to tell nobody at all, which is a
 * cached page outliving the schema change that rewrote it.
 */
describe('folio.migrate: the migrated hook', () => {
  function withHook(migrations: readonly Migration[], onMigrated: (e: unknown) => void) {
    return createFolio<Cloudflare.Env>({
      blocks: [page, hero, quote],
      root: 'page',
      migrations,
      bindings,
      basePath: '/folio',
      auth: 'open',
      route: (p) => (p ? `/${p}` : '/'),
      hooks: { migrated: (e) => onMigrated(e) },
    })
  }

  it('names the documents whose published snapshot it rewrote, and the migrations it applied', async () => {
    const calls: { ids: string[]; migrations: string[] }[] = []
    const folio = withHook([RENAME], (e) => {
      calls.push(e as (typeof calls)[number])
    })
    await seedStory(folio, 'mig_hook_pub', [blok('h1', 'hero', { heading: 'Hi' })], {
      publish: true,
    })
    // Never published, so its published snapshot cannot have been rewritten and
    // no cached page can exist for it.
    await seedStory(folio, 'mig_hook_draft', [blok('h1', 'hero', { heading: 'Yo' })])

    await folio.migrate(env)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.ids).toEqual(['mig_hook_pub'])
    expect(calls[0]!.migrations).toEqual(['0001-hero-heading-to-title'])
  })

  it('fires nothing on a dry run, and nothing when no published snapshot changed', async () => {
    const calls: unknown[] = []
    const folio = withHook([RENAME], (e) => {
      calls.push(e)
    })
    await seedStory(folio, 'mig_hook_dry', [blok('h1', 'hero', { heading: 'Hi' })], {
      publish: true,
    })

    await folio.migrate(env, { dryRun: true })
    expect(calls).toEqual([])

    // Second run: everything is already in the target shape, so it rewrites
    // nothing and the event would have nothing to be about.
    await folio.migrate(env)
    expect(calls).toHaveLength(1)
    await folio.migrate(env)
    expect(calls).toHaveLength(1)
  })
})

/**
 * Chunking splits a large migration into several transactions, which means
 * several undo steps rather than one. The honest trade: the alternative is
 * refusing to migrate documents over a size.
 */
describe('folio.migrate: oversized documents are chunked, not refused', () => {
  it('lands 450 mutations as three transactions and names the document in the report', async () => {
    const folio = makeFolio([RENAME])
    // 225 heroes × 2 mutations each = 450.
    const bloks = Array.from({ length: 225 }, (_, i) => ({
      ...blok(`h${String(i).padStart(3, '0')}`, 'hero', { heading: `H${i}` }),
      order: `a${String(i).padStart(3, '0')}`,
    }))
    await seedStory(folio, 'mig_big', bloks)

    const report = await folio.migrate(env)
    expect(report.mutations).toBe(450)
    expect(report.transactions).toBe(3)
    expect(report.oversized).toEqual([{ storyId: 'mig_big', mutations: 450, transactions: 3 }])
    expect(report.failed).toEqual([])

    const draft = await folio.draft(env, 'mig_big')
    for (let i = 0; i < 225; i++) {
      const uid = `h${String(i).padStart(3, '0')}`
      expect(draft.bloks[uid]!.data).toEqual({ heading: null, title: `H${i}` })
    }
    // Three transactions, each within the wire cap.
    const stub = env.STORY.get(env.STORY.idFromName('mig_big'))
    const trail = (await runInDurableObject(stub, (i) => i.recent())).rows
    const migrationTxs = trail.filter((t) => t.actor.startsWith('migration:'))
    expect(migrationTxs).toHaveLength(3)
    for (const tx of migrationTxs) expect(tx.mutations.length).toBeLessThanOrEqual(MAX_TX_MUTATIONS)
  })
})

describe('folio.migrate: partial failure is resumable', () => {
  /**
   * A row whose document type nothing declares any more has no
   * `MigrationContext.type` to hand a migration. Recorded rather than skipped:
   * the document genuinely has not been migrated, so the ledger must not claim
   * the run is complete.
   */
  it('records the failure, leaves the watermark alone, and migrates its neighbours', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_ok1', [blok('h1', 'hero', { heading: 'One' })])
    await seedStory(folio, 'mig_ok2', [blok('h1', 'hero', { heading: 'Two' })])
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title)
       values ('mig_orphan', 'longGone', null, 'orphan', 'orphan', 'a0', 'Orphan')`,
    ).run()

    const report = await folio.migrate(env)
    expect(report.failed).toEqual([
      {
        storyId: 'mig_orphan',
        reason: expect.stringContaining("unknown document type 'longGone'"),
      },
    ])
    expect(report.complete).toBe(false)
    expect(report.behind).toBe(1)
    // No ledger row: nothing may claim the migration reached every document.
    const ledger = await env.DB.prepare('select count(*) as n from schema_migrations').first<{
      n: number
    }>()
    expect(ledger?.n).toBe(0)

    // The other two are done and stay done.
    expect(await schemaIdOf('mig_ok1')).toBe('0001-hero-heading-to-title')
    expect(await schemaIdOf('mig_ok2')).toBe('0001-hero-heading-to-title')
    expect(await schemaIdOf('mig_orphan')).toBeNull()

    const rerun = await folio.migrate(env)
    // The two neighbours are no longer behind, so the sweep only sees the orphan.
    expect(rerun.stories).toBe(1)
    expect(rerun.failed).toHaveLength(1)
  })
})

describe('folio.migrate: batching and the cursor', () => {
  it('answers a cursor and finishes on the re-call', async () => {
    const folio = makeFolio([RENAME])
    for (const id of ['mig_b1', 'mig_b2', 'mig_b3']) {
      await seedStory(folio, id, [blok('h1', 'hero', { heading: id })])
    }

    const first = await folio.migrate(env, { batch: 2 })
    expect(first.stories).toBe(2)
    expect(first.continueFrom).toBe('mig_b2')
    expect(first.complete).toBe(false)

    const second = await folio.migrate(env, { batch: 2, continueFrom: first.continueFrom })
    expect(second.stories).toBe(1)
    expect(second.continueFrom).toBeNull()
    expect(second.complete).toBe(true)
    expect(second.pending).toEqual(['0001-hero-heading-to-title'])
  })

  it('sees nothing to do when no migrations are configured', async () => {
    const report = await makeFolio([]).migrate(env)
    expect(report).toMatchObject({ pending: [], stories: 0, complete: true, continueFrom: null })
  })
})

/**
 * The spec put this check at construction, which cannot work: construction reads
 * no D1, and "already applied" is a database fact.
 */
describe('folio.migrate: a migration inserted into the past', () => {
  it('refuses the whole run and names both ids', async () => {
    await env.DB.prepare(`insert into schema_migrations (id, applied_at) values ('0002-later', ?)`)
      .bind(Date.now())
      .run()
    const sneaked: Migration = { id: '0001-earlier', description: 'sneaked in', up: () => [] }
    await expect(
      makeFolio([sneaked, { ...sneaked, id: '0002-later' }]).migrate(env),
    ).rejects.toThrow(/cannot be inserted into the past/)
  })
})

/**
 * Checkpoint 3: version rows are never rewritten, so history stays byte-true and
 * a restore across a migration diffs two documents in the same shape.
 */
describe('versions are migrated on read, never rewritten', () => {
  it('leaves the stored bytes alone and applies the pending migrations on the way out', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_ver', [blok('h1', 'hero', { heading: 'Then' })])
    const doc = await folio.draft(env, 'mig_ver')
    await env.DB.prepare(
      `insert into versions (id, story_id, kind, label, title, actor, doc, created_at, schema_id)
       values ('ver_pre', 'mig_ver', 'publish', null, 'Then', null, ?, ?, null)`,
    )
      .bind(JSON.stringify(doc), Date.now())
      .run()

    const res = await req(folio, '/folio/api/versions/ver_pre')
    const body = await res?.json<{ doc: Doc; migrated: string[]; meta: { schemaId: null } }>()
    expect(body?.doc.bloks.h1?.data).toEqual({ heading: null, title: 'Then' })
    expect(body?.migrated).toEqual(['0001-hero-heading-to-title'])
    expect(body?.meta.schemaId).toBeNull()

    // The row itself is untouched: still the pre-migration bytes.
    const stored = await env.DB.prepare('select doc, schema_id from versions where id = ?')
      .bind('ver_pre')
      .first<{ doc: string; schema_id: string | null }>()
    expect((JSON.parse(stored!.doc) as Doc).bloks.h1!.data).toEqual({ heading: 'Then' })
    expect(stored?.schema_id).toBeNull()
  })

  it('leaves a version already at the current watermark alone', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_ver2', [blok('h1', 'hero', { title: 'Now' })])
    const doc = await folio.draft(env, 'mig_ver2')
    await env.DB.prepare(
      `insert into versions (id, story_id, kind, label, title, actor, doc, created_at, schema_id)
       values ('ver_now', 'mig_ver2', 'publish', null, 'Now', null, ?, ?, '0001-hero-heading-to-title')`,
    )
      .bind(JSON.stringify(doc), Date.now())
      .run()

    const res = await req(folio, '/folio/api/versions/ver_now')
    const body = await res?.json<{ migrated: string[] }>()
    expect(body?.migrated).toEqual([])
  })

  /**
   * A version records the shape of the document *it holds*, which is the story's
   * own watermark — not the latest configured migration. Stamping the latest
   * would make a version of a page that has not been migrated yet claim to be
   * current, so `getVersion` would hand back pre-migration bytes with nothing
   * pending, and a restore from it would reintroduce the old keys. Found by the
   * end-to-end script, which publishes before migrating.
   */
  it('stamps the story’s own watermark on a version a publish writes', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_pub', [blok('h1', 'hero', { heading: 'Then' })])

    const before = await req(folio, '/folio/api/story/mig_pub/publish', { method: 'POST' })
    expect(before?.status).toBe(200)
    const behindRow = await env.DB.prepare(
      'select id, schema_id from versions where story_id = ? order by created_at desc',
    )
      .bind('mig_pub')
      .first<{ id: string; schema_id: string | null }>()
    expect(behindRow?.schema_id).toBeNull()

    // And so it is migrated on read, which is the whole point of recording it.
    const version = await req(folio, `/folio/api/versions/${behindRow!.id}`)
    const body = await version?.json<{ doc: Doc; migrated: string[] }>()
    expect(body?.migrated).toEqual(['0001-hero-heading-to-title'])
    expect(body?.doc.bloks.h1?.data).toEqual({ heading: null, title: 'Then' })

    // Once the story is migrated, a fresh publish records the new watermark.
    await folio.migrate(env)
    await req(folio, '/folio/api/story/mig_pub/publish', { method: 'POST' })
    const currentRow = await env.DB.prepare(
      'select schema_id from versions where story_id = ? order by created_at desc',
    )
      .bind('mig_pub')
      .first<{ schema_id: string | null }>()
    expect(currentRow?.schema_id).toBe('0001-hero-heading-to-title')
  })
})

describe('a document created now is born up to date', () => {
  it('stamps the latest migration on a new story, so it is never reported behind', async () => {
    const folio = makeFolio([RENAME, DEFAULT_ALIGN])
    const res = await req(folio, '/folio/api/stories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Born Migrated' }),
    })
    const story = await res?.json<{ id: string }>()
    expect(await schemaIdOf(story!.id)).toBe('0002-hero-align-default')

    const status = await req(folio, `/folio/api/migrations?story=${story!.id}`)
    expect((await status?.json<MigrationStatus>())?.story).toMatchObject({
      behind: false,
      pending: [],
    })
  })
})

describe('GET /folio/api/migrations', () => {
  it('reports what is configured, what has run, and whether one story is behind', async () => {
    const folio = makeFolio([RENAME, DEFAULT_ALIGN])
    await seedStory(folio, 'mig_status', [blok('h1', 'hero', { heading: 'Hi' })])

    const before = await req(folio, '/folio/api/migrations?story=mig_status')
    expect(await before?.json<MigrationStatus>()).toMatchObject({
      migrations: [
        { id: '0001-hero-heading-to-title', applied: false },
        { id: '0002-hero-align-default', applied: false },
      ],
      pending: ['0001-hero-heading-to-title', '0002-hero-align-default'],
      story: {
        id: 'mig_status',
        schemaId: null,
        behind: true,
        pending: [
          { id: '0001-hero-heading-to-title', description: 'hero.heading → hero.title' },
          { id: '0002-hero-align-default', description: 'hero.align defaults to left' },
        ],
      },
    })

    await folio.migrate(env)

    const after = await req(folio, '/folio/api/migrations?story=mig_status')
    expect(await after?.json<MigrationStatus>()).toMatchObject({
      pending: [],
      behind: 0,
      story: { schemaId: '0002-hero-align-default', behind: false, pending: [] },
    })
  })

  /** The banner is an explanation; refusing the request over an id the editor is
   * closing anyway would surface as an error toast. */
  it('reports an unknown story as up to date rather than 404ing', async () => {
    const res = await req(makeFolio([RENAME]), '/folio/api/migrations?story=sty_nope')
    expect(res?.status).toBe(200)
    expect((await res?.json<MigrationStatus>())?.story).toMatchObject({ behind: false })
  })
})

describe('POST /folio/api/migrate', () => {
  it('runs a batch and answers the report, cursor and all', async () => {
    const folio = makeFolio([RENAME])
    await seedStory(folio, 'mig_route', [blok('h1', 'hero', { heading: 'Hi' })])

    const res = await req(folio, '/folio/api/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: 50 }),
    })
    expect(res?.status).toBe(200)
    expect(await res?.json<MigrateReport>()).toMatchObject({ changed: 1, continueFrom: null })
  })

  it('accepts an empty body as "run everything"', async () => {
    const res = await req(makeFolio([RENAME]), '/folio/api/migrate', { method: 'POST' })
    expect(res?.status).toBe(200)
  })

  it('refuses a batch outside the bounds', async () => {
    const res = await req(makeFolio([RENAME]), '/folio/api/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: 5000 }),
    })
    expect(res?.status).toBe(400)
  })
})

describe('GET /folio/api/audit', () => {
  it('reports orphan keys and unknown block types over published documents', async () => {
    const folio = makeFolio([])
    await seedStory(
      folio,
      'aud_a',
      [blok('h1', 'hero', { heading: 'orphaned', title: 'A', align: 'left' })],
      { publish: true },
    )
    await seedStory(folio, 'aud_b', [blok('bq', 'bigQuote', { text: 'x' })], { publish: true })

    const res = await req(folio, '/folio/api/audit')
    expect(res?.status).toBe(200)
    const report = await res?.json<AuditReport>()
    expect(report?.orphanKeys).toEqual([{ type: 'hero', field: 'heading', documents: 1 }])
    expect(report?.unknownTypes).toEqual([{ type: 'bigQuote', documents: 1 }])
    // The story-level checks ride the same response and stay quiet on documents
    // nowhere near `MAX_DOC_BYTES`, which is every document on a normal site.
    expect(report?.stories).toEqual([])
    // Nothing was modified.
    expect(publishedHero(await publishedDocOf('aud_a'))?.heading).toBe('orphaned')
  })

  it('reports the schema-only checks conditional-fields.md deferred here', async () => {
    const brokenCondition = defineBlock({
      name: 'broken',
      label: 'Broken',
      summary: 'secret',
      fields: {
        secret: text({ hidden: true }),
        caption: text({ showIf: { field: 'nope', eq: true } }),
      },
      render: () => null,
    })
    const folio = createFolio<Cloudflare.Env>({
      blocks: [page, hero, brokenCondition],
      root: 'page',
      bindings,
      basePath: '/folio',
      auth: 'open',
    })
    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/api/audit`),
      env,
      createExecutionContext(),
    )
    const report = await res?.json<AuditReport>()
    expect(report?.schema.map((f) => [f.check, f.block, f.field])).toEqual(
      expect.arrayContaining([
        ['unknown-condition-field', 'broken', 'caption'],
        ['hidden-summary-field', 'broken', 'secret'],
      ]),
    )
  })

  /**
   * The route is batched and resumable, like `/migrate`
   * (`../../../docs/specs/foundation/pagination.md`'s route table). It read the
   * whole `stories` table in one query until the Model screen was built on it, which
   * is the one place a *read-only* report could still exceed a request's CPU limit:
   * every published document, JSON-parsed, walked blok by blok.
   */
  it('pages the walk by continueFrom and merges as the admin does', async () => {
    const folio = makeFolio([])
    for (const id of ['aub_1', 'aub_2', 'aub_3']) {
      await seedStory(folio, id, [blok('h1', 'hero', { heading: 'orphaned', title: id })], {
        publish: true,
      })
    }

    // A set: one document produces several findings (an orphan key *and* a missing
    // field), and each of them samples it, so the interesting claim is which
    // documents the walk reached rather than how many findings named them.
    const seen = new Set<string>()
    let documents = 0
    let cursor: string | null = null
    let calls = 0
    do {
      const params = new URLSearchParams({ batch: '1' })
      if (cursor) params.set('continueFrom', cursor)
      const res = await req(folio, `/folio/api/audit?${params}`)
      expect(res?.status).toBe(200)
      const page = await res?.json<AuditReport>()
      documents += page?.documents ?? 0
      for (const finding of page?.content ?? []) for (const id of finding.sample) seen.add(id)
      cursor = page?.continueFrom ?? null
      calls++
    } while (cursor !== null && calls < 10)

    // One per batch of one, plus the short final batch that ends the walk.
    expect(calls).toBe(4)
    expect(documents).toBe(3)
    // Every document seen exactly once, which is the property a cursor buys over an
    // OFFSET: `sample` is per finding, so this is also the batched half of the
    // admin's "each finding links to the document it is about".
    expect([...seen].filter((id) => id.startsWith('aub_')).sort()).toEqual([
      'aub_1',
      'aub_2',
      'aub_3',
    ])
  })

  /** A short batch ends the walk, so an unbatched call over a small site is one
   * request with a null cursor — the shape every existing caller already reads. */
  it('answers a null cursor when one call reached the end', async () => {
    const res = await req(makeFolio([]), '/folio/api/audit')
    expect((await res?.json<AuditReport>())?.continueFrom).toBeNull()
  })

  /**
   * `continueFrom` names a story, so unlike an opaque keyset cursor it can be
   * checked without decoding — and a bad one is a 400 rather than a silent first
   * page, per `pagination.md`'s edge cases.
   */
  it('refuses a malformed continueFrom', async () => {
    const res = await req(makeFolio([]), '/folio/api/audit?continueFrom=not%20an%20id')
    expect(res?.status).toBe(400)
  })

  /** `batch` clamps rather than refusing: an out-of-range limit is a stale bookmark
   * with an obvious right answer (`limitParam`'s own asymmetry with `requireCursor`). */
  it('clamps an out-of-range batch instead of refusing it', async () => {
    const res = await req(makeFolio([]), '/folio/api/audit?batch=99999')
    expect(res?.status).toBe(200)
  })
})
