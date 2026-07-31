import { createExecutionContext, env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { blocks, defineBlock, text } from '../../src/core'
import type { Doc } from '../../src/core/doc'
import { encodeCursor } from '../../src/core/pagination'
import type { BulkSelection, StoryMeta } from '../../src/core/story'
import type { AuthConfig, Role } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import { createSession } from '../../src/server/auth/session'
import { createUser } from '../../src/server/auth/users'
import { type BulkDeps, type BulkReport, runBulk, wasRefused } from '../../src/server/bulk'
import { countStories, createStory, listStories, storyById } from '../../src/server/stories'
import { applySeedFixture } from './seed-fixture'

/**
 * Bulk writes (`../../../docs/specs/platform/bulk-writes.md`): the selection, the
 * count guard, the batched job, and the five routes over it.
 *
 * The runner is exercised against the **real** `publish`, `duplicateDocument`,
 * `moveDocument` and `deleteDocument` with a stubbed draft, rather than against a
 * stub of the workflows — the whole argument for `documents.ts` existing is that a
 * bulk delete reaches the identical batch a single delete reaches, and a test that
 * mocked them would assert that away. What is stubbed is exactly what a Durable
 * Object provides.
 */

const ORIGIN = 'https://bulk.test'
const API = `${ORIGIN}/folio/api`

const PAGE = { name: 'page', label: 'Page', kind: 'page', root: 'page' } as const

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('delete from schedules'),
    env.DB.prepare('delete from versions'),
    env.DB.prepare('delete from redirects'),
    env.DB.prepare('delete from content_index'),
    env.DB.prepare('delete from content_refs'),
    env.DB.prepare('delete from stories'),
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from users'),
  ])
  await applySeedFixture(env.DB)
}

beforeEach(reset)

function pageDoc(title: string): Doc {
  return {
    root: 'r1',
    bloks: {
      r1: { uid: 'r1', type: 'page', parent: null, slot: null, order: 'a0', data: { title } },
    },
  }
}

/**
 * `BulkDeps` with the Durable Object stubbed and nothing else.
 *
 * `seeded` and `purged` are what pin the two halves of the tree-shaped actions a
 * mock of the workflows would have hidden: a duplicate has to *seed* the copy's
 * object with a clone of the source's draft, and a delete has to purge every
 * descendant's.
 */
function deps(): BulkDeps & { seeded: string[]; purged: string[] } {
  const d = {
    db: env.DB,
    types: [PAGE],
    seeded: [] as string[],
    purged: [] as string[],
    draft: async (story: { title: string }) => pageDoc(story.title),
    draftWithSyncId: async (story: { title: string }) => ({ doc: pageDoc(story.title), syncId: 3 }),
    titleFor: (_story: unknown, doc: Doc) => String(doc.bloks[doc.root]?.data.title ?? ''),
    stub: (id: string) => ({
      getOrInit: async () => {
        d.seeded.push(id)
        return pageDoc('copy')
      },
      purge: async () => {
        d.purged.push(id)
      },
    }),
  }
  return d as unknown as BulkDeps & { seeded: string[]; purged: string[] }
}

/** A report, refusing to typecheck as one if the run was refused instead. */
function reported(outcome: Awaited<ReturnType<typeof runBulk>>): BulkReport {
  if (wasRefused(outcome)) throw new Error(`refused: expected ${outcome.expected}`)
  return outcome
}

const everyPage: BulkSelection = { all: true, filter: { routed: true }, expected: 3 }

const titles = async (): Promise<string[]> =>
  (await listStories(env.DB)).map((row) => row.title).sort()

/* -------------------------------------------------------------- the guard --- */

describe('the count guard', () => {
  it('runs when the captured filter still counts what the person was shown', async () => {
    const report = reported(await runBulk(deps(), 'publish', everyPage))
    expect(report.done).toBe(3)
    expect(report.failed).toEqual([])
    expect(report.continueFrom).toBeNull()
  })

  it('refuses with the new count when the set moved, and writes nothing', async () => {
    await createStory(env.DB, { title: 'Late arrival', type: PAGE }, [PAGE])

    const outcome = await runBulk(deps(), 'publish', everyPage)
    expect(wasRefused(outcome)).toBe(true)
    if (!wasRefused(outcome)) return
    // The *new* count, which is what makes re-confirming one click rather than a
    // mystery: a refusal has to be a door.
    expect(outcome).toEqual({ refused: 'count', expected: 3, actual: 4 })

    // Nothing published, so a refusal is not a partial run.
    expect(await countStories(env.DB, { state: 'live' })).toBe(0)
  })

  it('re-confirms at the new count, which is the whole point of reporting it', async () => {
    await createStory(env.DB, { title: 'Late arrival', type: PAGE }, [PAGE])
    const again = reported(
      await runBulk(deps(), 'publish', { all: true, filter: { routed: true }, expected: 4 }),
    )
    expect(again.done).toBe(4)
  })

  it('counts the exact set a list header counted, `routed` included', async () => {
    await createStory(env.DB, { title: 'A record', type: PAGE }, [PAGE])
    // Unrouted rows exist, so a guard that ignored `routed` would count four here
    // and refuse a selection Content made over three.
    await env.DB.prepare(
      "update stories set path = null, parent_id = null where title = 'A record'",
    ).run()

    expect(await countStories(env.DB, { routed: true })).toBe(3)
    expect(await countStories(env.DB)).toBe(4)
    expect(reported(await runBulk(deps(), 'publish', everyPage)).done).toBe(3)
  })

  it('is not re-checked on a resumed call, so live editors cannot stall a long job', async () => {
    const first = reported(await runBulk(deps(), 'publish', everyPage, { batch: 1 }))
    expect(first.continueFrom).not.toBeNull()

    // The world moves mid-job, exactly the case a per-batch guard would refuse.
    await createStory(env.DB, { title: 'Mid-job', type: PAGE }, [PAGE])

    const second = reported(
      await runBulk(deps(), 'publish', everyPage, { batch: 1, continueFrom: first.continueFrom }),
    )
    expect(second.done).toBe(1)
  })

  it('needs no guard for an explicit id list: the ids are the version of the set', async () => {
    const report = reported(await runBulk(deps(), 'publish', { ids: ['sty_home', 'sty_about'] }))
    expect(report.done).toBe(2)
    expect(report.total).toBe(2)
  })
})

/* ------------------------------------------------------------ the ceiling --- */

describe('the count is also the ceiling', () => {
  it('never touches more documents than were agreed to, however the set grows', async () => {
    // Batch 1 of 2 publishes one page; then two more drafts appear.
    const first = reported(await runBulk(deps(), 'publish', everyPage, { batch: 1 }))
    await createStory(env.DB, { title: 'Extra one', type: PAGE }, [PAGE])
    await createStory(env.DB, { title: 'Extra two', type: PAGE }, [PAGE])

    let cursor = first.continueFrom
    let done = first.done
    while (cursor !== null) {
      const next = reported(
        await runBulk(deps(), 'publish', everyPage, { batch: 1, continueFrom: cursor }),
      )
      done += next.done
      cursor = next.continueFrom
    }
    // Three, not five: two of the pages now matching the filter are pages nobody
    // agreed to publish.
    expect(done).toBe(3)
    expect(await countStories(env.DB, { state: 'live' })).toBe(3)
  })

  it('subtracts the exclusions from the ceiling, because that is what was agreed', async () => {
    const report = reported(
      await runBulk(deps(), 'publish', {
        all: true,
        filter: { routed: true },
        expected: 3,
        exclude: ['sty_team'],
      }),
    )
    expect(report.total).toBe(2)
    expect(report.done).toBe(2)
    expect((await storyById(env.DB, 'sty_team'))?.state).toBe('draft')
  })

  it('reports a finished job for a cursor that has already spent the allowance', async () => {
    const spent = reported(
      await runBulk(deps(), 'publish', everyPage, { continueFrom: encodeCursor(['sty_zzz', 3]) }),
    )
    expect(spent).toMatchObject({ done: 0, seen: 3, continueFrom: null })
  })
})

/* -------------------------------------------------------------- batching --- */

describe('batching', () => {
  it('walks the whole selection one batch at a time, by cursor', async () => {
    const seen: number[] = []
    let cursor: string | null = null
    let calls = 0
    do {
      const report = reported(
        await runBulk(deps(), 'publish', everyPage, {
          batch: 1,
          ...(cursor === null ? {} : { continueFrom: cursor }),
        }),
      )
      seen.push(report.seen)
      cursor = report.continueFrom
      calls++
    } while (cursor !== null && calls < 10)

    expect(calls).toBe(3)
    expect(seen).toEqual([1, 2, 3])
    expect(await countStories(env.DB, { state: 'live' })).toBe(3)
  })

  it('answers a null cursor on a short read rather than one more empty call', async () => {
    const report = reported(await runBulk(deps(), 'publish', everyPage, { batch: 50 }))
    expect(report.continueFrom).toBeNull()
    expect(report.seen).toBe(3)
  })

  it('pages an explicit id list too, and checks the list did not change under it', async () => {
    const ids = ['sty_about', 'sty_home', 'sty_team']
    const first = reported(await runBulk(deps(), 'publish', { ids }, { batch: 2 }))
    expect(first.done).toBe(2)
    expect(first.continueFrom).not.toBeNull()

    // Re-posting a *different* list with the same cursor is a client bug, and the
    // two ways of absorbing it are skipping documents and doing some twice.
    await expect(
      runBulk(deps(), 'publish', { ids: ['sty_team'] }, { continueFrom: first.continueFrom }),
    ).rejects.toThrow('changed between batches')

    const second = reported(
      await runBulk(deps(), 'publish', { ids }, { batch: 2, continueFrom: first.continueFrom }),
    )
    expect(second.done).toBe(1)
    expect(second.continueFrom).toBeNull()
  })

  it('refuses a malformed cursor rather than silently starting over', async () => {
    await expect(
      runBulk(deps(), 'publish', everyPage, { continueFrom: 'not-a-cursor' }),
    ).rejects.toThrow('Malformed pagination cursor')
  })

  it('clamps the batch size, so a caller cannot ask for a run that outlives the request', async () => {
    // 5,000 asked for, 200 allowed, 3 documents present: the observable part is
    // that it neither throws nor pages.
    const report = reported(await runBulk(deps(), 'publish', everyPage, { batch: 5000 }))
    expect(report.done).toBe(3)
  })
})

/* --------------------------------------------------------- the five actions --- */

describe('the five actions', () => {
  it('publishes, and each document gets the version row a manual publish leaves', async () => {
    const report = reported(await runBulk(deps(), 'publish', everyPage, { actor: 'user_ann' }))
    expect(report.done).toBe(3)

    const versions = await env.DB.prepare(
      "select story_id as id, actor from versions where kind = 'publish' order by story_id",
    ).all<{ id: string; actor: string }>()
    expect(versions.results.map((r) => r.id)).toEqual(['sty_about', 'sty_home', 'sty_team'])
    expect(versions.results.every((r) => r.actor === 'user_ann')).toBe(true)
  })

  it('unpublishes, and is idempotent about a page that was never live', async () => {
    reported(await runBulk(deps(), 'publish', everyPage))
    const report = reported(await runBulk(deps(), 'unpublish', everyPage))
    expect(report.done).toBe(3)
    expect(await countStories(env.DB, { state: 'unpublished' })).toBe(3)

    // Again: `unpublish` performs no write for something already down, and reports
    // success rather than a failure — taking a page down is what people double-click.
    expect(reported(await runBulk(deps(), 'unpublish', everyPage)).done).toBe(3)
  })

  it('duplicates each document and seeds the copy’s object with the source draft', async () => {
    const d = deps()
    const report = reported(await runBulk(d, 'duplicate', { ids: ['sty_about', 'sty_team'] }))
    expect(report.done).toBe(2)
    expect(d.seeded).toHaveLength(2)
    expect(await titles()).toEqual(['About', 'About (copy)', 'Home', 'Our team', 'Our team (copy)'])
  })

  it('refuses to duplicate a select-all, because a copy joins the set it is walking', async () => {
    await expect(runBulk(deps(), 'duplicate', everyPage)).rejects.toThrow(
      'explicit list of documents',
    )
  })

  it('moves the set into a destination in the order it walked, not reversed', async () => {
    const dest = await createStory(env.DB, { title: 'Section', type: PAGE }, [PAGE])
    const a = await createStory(env.DB, { title: 'One', type: PAGE }, [PAGE])
    const b = await createStory(env.DB, { title: 'Two', type: PAGE }, [PAGE])

    const report = reported(
      await runBulk(deps(), 'move', { ids: [a.id, b.id] }, { destination: { parentId: dest.id } }),
    )
    expect(report.done).toBe(2)

    const rows = (await listStories(env.DB))
      .filter((row) => row.parentId === dest.id)
      .sort((x, y) => (x.ord < y.ord ? -1 : 1))
    // `index: 0` per item — what the admin's client loop did — lands the set in
    // reverse. Each document goes below the one before it instead.
    expect(rows.map((row) => row.title)).toEqual(['One', 'Two'])
    expect(rows.map((row) => row.path)).toEqual(['section/one', 'section/two'])
  })

  it('keeps the tree rules, and reports the one refusal without failing the batch', async () => {
    const child = (await listStories(env.DB)).find((row) => row.id === 'sty_team')!
    const report = reported(
      await runBulk(
        deps(),
        'move',
        { ids: ['sty_about', 'sty_home'] },
        { destination: { parentId: child.id } },
      ),
    )
    // `sty_about` cannot move under its own descendant; `sty_home` is the root and
    // cannot be reparented at all, so it is a no-op rather than a refusal.
    expect(report.failed).toEqual([
      { id: 'sty_about', title: 'About', message: 'Cannot move a story into its own subtree' },
    ])
    expect(report.done).toBe(1)
  })

  it('needs a destination, which is not a thing to guess', async () => {
    await expect(runBulk(deps(), 'move', { ids: ['sty_about'] })).rejects.toThrow(
      'needs a destination',
    )
  })

  it('deletes, purges every descendant’s object, and leaves the redirects a single delete would', async () => {
    const d = deps()
    const report = reported(await runBulk(d, 'delete', { ids: ['sty_about'] }))
    expect(report.done).toBe(1)
    // The subtree, so `sty_team` went with it.
    expect(await titles()).toEqual(['Home'])
    expect(d.purged.sort()).toEqual(['sty_about', 'sty_team'])

    const redirects = await env.DB.prepare(
      'select from_path as from_, to_path as to_ from redirects order by from_path',
    ).all<{ from_: string; to_: string }>()
    expect(redirects.results).toEqual([
      { from_: 'about', to_: '' },
      { from_: 'about/team', to_: '' },
    ])
  })

  it('leaves no redirect when the caller asks for none', async () => {
    reported(await runBulk(deps(), 'delete', { ids: ['sty_about'] }, { redirect: false }))
    const { results } = await env.DB.prepare('select count(*) as n from redirects').all<{
      n: number
    }>()
    expect(results[0]?.n).toBe(0)
  })

  it('counts a document its own ancestor already removed as done, not as a failure', async () => {
    // The ordinary way this happens: a selection holding both a page and one of its
    // descendants. Reporting it as a failure would make correct behaviour look broken.
    const report = reported(await runBulk(deps(), 'delete', { ids: ['sty_about', 'sty_team'] }))
    expect(report.done).toBe(2)
    expect(report.failed).toEqual([])
  })

  it('refuses to delete the root, and says so per document', async () => {
    const report = reported(await runBulk(deps(), 'delete', { ids: ['sty_home', 'sty_about'] }))
    expect(report.done).toBe(1)
    expect(report.failed).toEqual([
      { id: 'sty_home', title: 'Home', message: 'Cannot delete the root story' },
    ])
  })
})

/* --------------------------------------------------------------- the report --- */

describe('the report', () => {
  it('names an id nothing is behind rather than failing the whole call', async () => {
    const report = reported(await runBulk(deps(), 'publish', { ids: ['sty_gone', 'sty_about'] }))
    expect(report.done).toBe(1)
    expect(report.failed).toEqual([{ id: 'sty_gone', title: '', message: 'No such document' }])
  })

  it('carries the failure prose a toast can show and never D1’s own text', async () => {
    // A slug collision is the one refusal whose message comes out of D1, naming the
    // table and the index. `rethrow`'s table is what keeps it from travelling.
    const dest = await createStory(env.DB, { title: 'Section', type: PAGE }, [PAGE])
    await createStory(env.DB, { title: 'Team', slug: 'team', type: PAGE, parentId: dest.id }, [
      PAGE,
    ])

    const report = reported(
      await runBulk(deps(), 'move', { ids: ['sty_team'] }, { destination: { parentId: dest.id } }),
    )
    for (const failure of report.failed) {
      expect(failure.message).not.toContain('constraint')
      expect(failure.message).not.toContain('stories')
    }
  })

  it('writes nothing on a dry run and tallies the intent', async () => {
    const report = reported(await runBulk(deps(), 'delete', everyPage, { dryRun: true }))
    expect(report).toMatchObject({ dryRun: true, done: 3, failed: [] })
    expect(await countStories(env.DB)).toBe(3)
  })

  it('reports progress against the job rather than against the call', async () => {
    const first = reported(await runBulk(deps(), 'publish', everyPage, { batch: 2 }))
    expect(first).toMatchObject({ action: 'publish', total: 3, seen: 2, done: 2 })
    const second = reported(
      await runBulk(deps(), 'publish', everyPage, { batch: 2, continueFrom: first.continueFrom }),
    )
    // `done` is this call's; `seen` and `total` are the job's.
    expect(second).toMatchObject({ total: 3, seen: 3, done: 1, continueFrom: null })
  })
})

/* ----------------------------------------------------------------- over HTTP --- */

describe('the routes', () => {
  const post = (path: string, body: unknown): Promise<Response> =>
    SELF.fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('answers a report for each of the five', async () => {
    const dest = await createStory(env.DB, { title: 'Section', type: PAGE }, [PAGE])
    const cases: [string, unknown][] = [
      ['/bulk/publish', { selection: { ids: ['sty_about'] } }],
      ['/bulk/unpublish', { selection: { ids: ['sty_about'] } }],
      ['/bulk/duplicate', { selection: { ids: ['sty_about'] } }],
      ['/bulk/move', { selection: { ids: ['sty_team'] }, parentId: dest.id }],
      ['/bulk/delete', { selection: { ids: ['sty_team'] } }],
    ]
    for (const [path, body] of cases) {
      const res = await post(path, body)
      expect([path, res.status]).toEqual([path, 200])
      const report = await res.json<BulkReport>()
      expect([path, report.done, report.failed]).toEqual([path, 1, []])
    }
  })

  it('answers a count mismatch with 409, the one error envelope, and the new count', async () => {
    const res = await post('/bulk/publish', {
      selection: { all: true, filter: { routed: true }, expected: 99 },
    })
    expect(res.status).toBe(409)
    const body = await res.json<{
      error: { code: string; message: string }
      refused: string
      expected: number
      actual: number
    }>()
    // The envelope stays where every client already looks, so a generic fetch
    // wrapper shows a sentence...
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toContain('99')
    // ...and the numbers sit beside it for the one-click re-confirmation.
    expect(body.refused).toBe('count')
    expect(body).toMatchObject({ expected: 99, actual: 3 })
  })

  it('refuses a selection that is both an id list and a filter', async () => {
    const res = await post('/bulk/publish', {
      selection: { ids: ['sty_about'], all: true, filter: {}, expected: 3 },
    })
    expect(res.status).toBe(400)
    // Silently stripping one of them would write to a set nobody described.
    expect(await countStories(env.DB, { state: 'live' })).toBe(0)
  })

  it('refuses an id list carrying a count, which would look like a guarded run', async () => {
    expect(
      (await post('/bulk/publish', { selection: { ids: ['sty_about'], expected: 1 } })).status,
    ).toBe(400)
  })

  it('refuses an empty selection and a body with none', async () => {
    expect((await post('/bulk/publish', { selection: { ids: [] } })).status).toBe(400)
    expect((await post('/bulk/publish', {})).status).toBe(400)
  })

  it('refuses a move with no destination at the schema, not in the runner', async () => {
    expect((await post('/bulk/move', { selection: { ids: ['sty_about'] } })).status).toBe(400)
  })

  it('is not readable by GET, and is not on the versioned surface', async () => {
    // A version segment is a promise, and this is internal to the admin.
    for (const path of ['/bulk/publish', '/v1/bulk/publish']) {
      const res = await SELF.fetch(`${API}${path}`)
      expect([path, res.status]).toEqual([path, 404])
    }
    const versioned = await post('/v1/bulk/publish', { selection: { ids: ['sty_about'] } })
    expect(versioned.status).toBe(404)
  })
})

/* --------------------------------------------------------------- role gates --- */

/**
 * Each bulk route carries **its single-document twin's gate**, which is the whole
 * reason there are five routes rather than one `POST /bulk/:action`.
 *
 * Its own `createFolio` with a provider configured, for the reason `auth-http.ts`
 * gives: the shared test worker runs `auth: 'open'`, where there is nothing to
 * refuse.
 */
describe('role gates', () => {
  const page = defineBlock({
    name: 'page',
    label: 'Page',
    summary: 'title',
    fields: {
      title: text({ label: 'Title', required: true }),
      body: blocks({ label: 'Body', allow: [] }),
    },
    render: () => null,
  })

  const auth: AuthConfig<Cloudflare.Env> = {
    providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
  }

  const folio = createFolio<Cloudflare.Env>({
    blocks: [page],
    root: 'page',
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    auth,
    route: (p) => (p ? `/${p}` : '/'),
  })

  async function cookieFor(role: Role): Promise<string> {
    const user = await createUser(env.DB, { email: `${role}@bulk.test`, name: role, role })
    const session = await createSession(env.DB, user.id)
    return `${SECURE_COOKIE}=${session.token}`
  }

  const call = (path: string, cookie: string, body: unknown): Promise<Response> =>
    folio.handle(
      new Request(`${API}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      createExecutionContext(),
    ) as Promise<Response>

  const selection = { selection: { ids: ['sty_about'] } }

  it('refuses every one of them to a viewer', async () => {
    const cookie = await cookieFor('viewer')
    for (const action of ['publish', 'unpublish', 'duplicate', 'delete']) {
      const res = await call(`/bulk/${action}`, cookie, selection)
      expect([action, res.status]).toEqual([action, 403])
    }
    expect((await call('/bulk/move', cookie, { ...selection, parentId: null })).status).toBe(403)
  })

  it('lets an editor duplicate but not publish, move or delete', async () => {
    const cookie = await cookieFor('editor')
    // `CREATE` is editor+, exactly as `POST /stories/:id/duplicate` is.
    expect((await call('/bulk/duplicate', cookie, selection)).status).toBe(200)
    expect((await call('/bulk/publish', cookie, selection)).status).toBe(403)
    expect((await call('/bulk/delete', cookie, selection)).status).toBe(403)
    expect((await call('/bulk/move', cookie, { ...selection, parentId: null })).status).toBe(403)
  })

  it('lets a publisher do all five, since each is its twin performed N times', async () => {
    const cookie = await cookieFor('publisher')
    expect((await call('/bulk/publish', cookie, selection)).status).toBe(200)
    expect((await call('/bulk/unpublish', cookie, selection)).status).toBe(200)
    expect((await call('/bulk/move', cookie, { ...selection, parentId: null })).status).toBe(200)
    expect((await call('/bulk/delete', cookie, selection)).status).toBe(200)
  })

  it('attributes the run to the session, whatever the body claims', async () => {
    const user = await createUser(env.DB, {
      email: 'pub@bulk.test',
      name: 'Pub',
      role: 'publisher',
    })
    const session = await createSession(env.DB, user.id)
    const res = await call(`/bulk/publish`, `${SECURE_COOKIE}=${session.token}`, {
      ...selection,
      // Undeclared, so valibot strips it in silence — the same treatment
      // `CheckpointBody` gives a stale tab still sending one. What matters is that
      // "who published this" comes off the session and cannot be typed.
      actor: 'user_someone_else',
    })
    expect(res.status).toBe(200)

    const row = await env.DB.prepare(
      "select actor from versions where story_id = 'sty_about' and kind = 'publish'",
    ).first<{ actor: string }>()
    expect(row?.actor).toBe(user.id)
  })
})

/* ------------------------------------------------------- the selection reader --- */

describe('storiesMatching', () => {
  it('is not a list route in disguise: it walks by id, which no write moves', async () => {
    const { storiesMatching } = await import('../../src/server/stories')
    const first = await storiesMatching(env.DB, { routed: true }, { limit: 2 })
    expect(first.map((row: StoryMeta) => row.id)).toEqual(['sty_about', 'sty_home'])
    const second = await storiesMatching(env.DB, { routed: true }, { limit: 2, after: 'sty_home' })
    expect(second.map((row: StoryMeta) => row.id)).toEqual(['sty_team'])
  })

  it('applies exclusions in SQL, so a batch does a batch of work', async () => {
    const { storiesMatching } = await import('../../src/server/stories')
    const rows = await storiesMatching(
      env.DB,
      { routed: true },
      { limit: 2, exclude: ['sty_about', 'sty_home'] },
    )
    expect(rows.map((row: StoryMeta) => row.id)).toEqual(['sty_team'])
  })

  it('honours the filter keys no list route sends', async () => {
    const { storiesMatching } = await import('../../src/server/stories')
    const top = await storiesMatching(env.DB, { parentId: null, routed: true }, { limit: 10 })
    expect(top.map((row: StoryMeta) => row.id)).toEqual(['sty_about', 'sty_home'])
    const under = await storiesMatching(env.DB, { parentId: 'sty_about' }, { limit: 10 })
    expect(under.map((row: StoryMeta) => row.id)).toEqual(['sty_team'])
  })
})
