import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineBlock, defineRecord, reference, references, richtext, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'

/**
 * Data documents against real D1 and the real `0006` / `0010` migrations
 * (`../../../docs/specs/content-model/data-documents.md`): the usage route, the
 * `references()` field's contribution to `content_refs`, a record's publish /
 * version / delete lifecycle, and the fact that no path resolves to one.
 *
 * Own `createFolio` rather than the shared `worker.ts` fixture, per the trap
 * `publish-hooks.md` recorded: vitest-pool-workers cannot carry a plain array
 * back over the pool's RPC boundary. Ids are prefixed `rec_` because D1 state is
 * isolated per *file*, not per test.
 */

/* --------------------------------------------------------------- schema --- */

/** A record WITH a renderer: `{person.content}` gets a card. */
const personRecord = defineRecord({
  name: 'recPerson',
  label: 'Person',
  summary: 'fullName',
  fields: {
    fullName: text({ indexed: true }),
    role: text({ indexed: true, translatable: true }),
    bio: richtext({ translatable: true }),
  },
  render: ({ fullName }) => fullName,
})

/** A record with NO renderer at all — the shape checkpoint 1 exists for. */
const officeRecord = defineRecord({
  name: 'recOffice',
  label: 'Office',
  summary: 'city',
  fields: { city: text({ indexed: true }), phone: text() },
})

const pageRoot = defineBlock({
  name: 'recPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text(),
    lead: reference({ types: ['recPersonType'] }),
    team: references({ types: ['recPersonType'], max: 6 }),
    office: reference({ types: ['recOfficeType'] }),
  },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'recPageType', label: 'Page', kind: 'page', root: 'recPage', default: true },
  {
    name: 'recPersonType',
    label: 'Person',
    kind: 'record',
    root: 'recPerson',
    titleField: 'fullName',
  },
  { name: 'recOfficeType', label: 'Office', kind: 'record', root: 'recOffice', titleField: 'city' },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const folio = createFolio<Cloudflare.Env>({
  blocks: [personRecord, officeRecord, pageRoot],
  types,
  bindings,
  basePath: '/folio',
  auth: 'open',
  route: (p) => (p ? `/${p}` : '/'),
})

const ORIGIN = 'https://example.com'
const get = (path: string) =>
  folio.handle(new Request(`${ORIGIN}${path}`), env, createExecutionContext())
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

function one(uid: string, type: string, data: Record<string, Json>): Doc {
  return { root: uid, bloks: { [uid]: { uid, type, parent: null, slot: null, order: 'a0', data } } }
}

async function insertRow(
  id: string,
  opts: { type: string; path: string | null; title: string; doc: Doc; ord?: string },
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at)
     values (?, ?, null, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.type,
      opts.path === null ? id : (opts.path.split('/').pop() ?? ''),
      opts.path,
      opts.ord ?? 'a0',
      opts.title,
      Date.now(),
      JSON.stringify(opts.doc),
      Date.now(),
    )
    .run()
}

const ADA = 'rec_ada'
const GRACE = 'rec_grace'
const SYDNEY = 'rec_syd'

beforeAll(async () => {
  await insertRow(ADA, {
    type: 'recPersonType',
    path: null,
    title: 'Ada Lovelace',
    doc: one('a', 'recPerson', { fullName: 'Ada Lovelace', role: 'Analyst' }),
  })
  await insertRow(GRACE, {
    type: 'recPersonType',
    path: null,
    title: 'Grace Hopper',
    ord: 'a1',
    doc: one('g', 'recPerson', { fullName: 'Grace Hopper', role: 'Rear Admiral' }),
  })
  await insertRow(SYDNEY, {
    type: 'recOfficeType',
    path: null,
    title: 'Sydney',
    doc: one('s', 'recOffice', { city: 'Sydney', phone: '000' }),
  })

  // Four published pages naming the office, plus one naming both people through
  // a hand-picked list. Inserted directly and then reindexed, which is how an
  // existing site's `content_refs` comes to exist at all.
  for (let i = 0; i < 4; i++) {
    await insertRow(`rec_p${i}`, {
      type: 'recPageType',
      path: `recpage${i}`,
      title: `Page ${i}`,
      doc: one(`p${i}`, 'recPage', { title: `Page ${i}`, office: SYDNEY }),
    })
  }
  await insertRow('rec_team', {
    type: 'recPageType',
    path: 'recteam',
    title: 'Leadership',
    doc: one('t', 'recPage', { title: 'Leadership', team: [GRACE, ADA], lead: ADA }),
  })

  const report = await folio.reindex(env, { batch: 200 })
  expect(report.documents).toBeGreaterThan(0)
})

/* ------------------------------------------------------ no path resolves --- */

describe('a record has no URL', () => {
  it('answers nothing for a path spelled like its slug', async () => {
    expect(await folio.published(env, 'rec_ada')).toBeNull()
    expect(await folio.published(env, 'ada-lovelace')).toBeNull()
  })

  it('leaves the page tree free of records', async () => {
    const tree = (await (await get('/folio/stories'))!.json()) as { id: string }[]
    const ids = JSON.stringify(tree)
    expect(ids).not.toContain(ADA)
    expect(ids).not.toContain(SYDNEY)
  })

  it('lists them in GET /documents instead, unrouted and with no url', async () => {
    const body = (await (await get('/folio/documents?type=recPersonType'))!.json()) as {
      documents: { id: string; path: string | null; url?: string }[]
    }
    expect(body.documents.map((d) => d.id).sort()).toEqual([ADA, GRACE])
    expect(body.documents.every((d) => d.path === null)).toBe(true)
    expect(body.documents.every((d) => d.url === undefined)).toBe(true)
  })
})

/* ------------------------------------------------- indexed list columns --- */

describe('GET /documents carries the indexed values the list view columns need', () => {
  it('returns one entry per document, keyed by field', async () => {
    const body = (await (await get('/folio/documents'))!.json()) as {
      indexed?: Record<string, Record<string, { text: string; num: number | null }>>
    }
    expect(body.indexed?.[ADA]?.fullName?.text).toBe('Ada Lovelace')
    expect(body.indexed?.[ADA]?.role?.text).toBe('Analyst')
    expect(body.indexed?.[SYDNEY]?.city?.text).toBe('Sydney')
  })

  it('leaves a document with nothing published out, so its cells read blank', async () => {
    const created = (await (await send('/folio/stories', 'POST', {
      title: 'Unpublished Person',
      type: 'recPersonType',
    }))!.json()) as { id: string }
    const body = (await (await get('/folio/documents?type=recPersonType'))!.json()) as {
      documents: { id: string }[]
      indexed?: Record<string, unknown>
    }
    // The row IS in the list — the admin lists documents, not published content.
    expect(body.documents.map((d) => d.id)).toContain(created.id)
    expect(body.indexed?.[created.id]).toBeUndefined()
    await send(`/folio/stories/${created.id}`, 'DELETE')
  })
})

/* ------------------------------------------------------------ the usage --- */

describe('GET /documents/:id/usage', () => {
  it('counts the four published pages referencing an office, and names them', async () => {
    const usage = (await (await get(`/folio/documents/${SYDNEY}/usage`))!.json()) as {
      published: { id: string; title: string; url: string; kind: string }[]
      total: number
      links: number
      references: number
    }
    expect(usage.total).toBe(4)
    expect(usage.references).toBe(4)
    expect(usage.links).toBe(0)
    expect(usage.published.map((p) => p.id).sort()).toEqual([
      'rec_p0',
      'rec_p1',
      'rec_p2',
      'rec_p3',
    ])
    // Decorated through the host's own `route`, not assembled here.
    expect(usage.published[0]?.url).toBe('/recpage0')
    expect(usage.published.every((p) => p.kind === 'reference')).toBe(true)
  })

  it('counts a hand-picked references() list as a usage of every member', async () => {
    const grace = (await (await get(`/folio/documents/${GRACE}/usage`))!.json()) as {
      published: { id: string }[]
      total: number
    }
    // Grace appears only inside `team`, never as `lead`, so this row exists
    // solely because the plural walk sees it.
    expect(grace.total).toBe(1)
    expect(grace.published.map((p) => p.id)).toEqual(['rec_team'])
  })

  it('counts one document once even when it both references and lists the target', async () => {
    const ada = (await (await get(`/folio/documents/${ADA}/usage`))!.json()) as {
      published: { id: string; kind: string }[]
      total: number
      references: number
    }
    // `lead` and `team` are two `reference`-kind rows for one document...
    expect(ada.total).toBe(1)
    // ...and `content_refs`'s primary key collapses them, because `kind` is part
    // of it and both rows are `reference`.
    expect(ada.references).toBe(1)
  })

  it('is empty and does not 404 for a document nothing points at', async () => {
    const created = (await (await send('/folio/stories', 'POST', {
      title: 'Nobody',
      type: 'recPersonType',
    }))!.json()) as { id: string }
    const usage = (await (await get(`/folio/documents/${created.id}/usage`))!.json()) as {
      published: unknown[]
      total: number
    }
    expect(usage.total).toBe(0)
    expect(usage.published).toEqual([])
    await send(`/folio/stories/${created.id}`, 'DELETE')
  })

  it('is empty for an id that never existed, rather than an error', async () => {
    const res = (await get('/folio/documents/rec_nope/usage'))!
    expect(res.status).toBe(200)
    expect(((await res.json()) as { total: number }).total).toBe(0)
  })

  it('excludes unpublished references, and says so by simply not having them', async () => {
    // A draft page referencing the office. Never published, so nothing was ever
    // written to `content_refs` for it — which is the whole honesty caveat.
    const created = (await (await send('/folio/stories', 'POST', {
      title: 'Draft Referrer',
    }))!.json()) as { id: string }
    await folio.handle(
      new Request(`${ORIGIN}/folio/story/${created.id}/document`),
      env,
      createExecutionContext(),
    )
    const usage = (await (await get(`/folio/documents/${SYDNEY}/usage`))!.json()) as {
      total: number
    }
    expect(usage.total).toBe(4)
    await send(`/folio/stories/${created.id}`, 'DELETE')
  })
})

/* -------------------------------------------------- publish and version --- */

describe('a record publishes and versions like a page', () => {
  it('publishes twice and retains two versions, with no path involved', async () => {
    const created = (await (await send('/folio/stories', 'POST', {
      title: 'Versioned Person',
      type: 'recPersonType',
    }))!.json()) as { id: string; path: string | null }
    expect(created.path).toBeNull()

    // Opening the document is what seeds the Durable Object; publish reads it.
    await get(`/folio/story/${created.id}/document`)
    const first = (await (await send(`/folio/story/${created.id}/publish`, 'POST'))!.json()) as {
      ok: boolean
    }
    expect(first.ok).toBe(true)
    const second = (await (await send(`/folio/story/${created.id}/publish`, 'POST'))!.json()) as {
      ok: boolean
    }
    expect(second.ok).toBe(true)

    const list = (await (await get(`/folio/story/${created.id}/versions`))!.json()) as {
      kind: string
    }[]
    expect(list.filter((v) => v.kind === 'publish').length).toBeGreaterThanOrEqual(2)

    // Still no route to it, published or not.
    expect(await folio.published(env, created.id)).toBeNull()
    await send(`/folio/stories/${created.id}`, 'DELETE')
  })

  it('refuses to duplicate a singleton but happily duplicates a record', async () => {
    const created = (await (await send('/folio/stories', 'POST', {
      title: 'Copy Me',
      type: 'recPersonType',
    }))!.json()) as { id: string }
    await get(`/folio/story/${created.id}/document`)
    const res = (await send(`/folio/stories/${created.id}/duplicate`, 'POST', {
      title: 'Copy Me 2',
    }))!
    expect(res.status).toBe(201)
    const copy = ((await res.json()) as { story: { id: string; path: string | null } }).story
    expect(copy.path).toBeNull()
    await send(`/folio/stories/${copy.id}`, 'DELETE')
    await send(`/folio/stories/${created.id}`, 'DELETE')
  })
})

/* --------------------------------------------------------------- delete --- */

describe('deleting a referenced record proceeds', () => {
  it('removes the row, its index rows, and leaves the referring pages alone', async () => {
    const created = (await (await send('/folio/stories', 'POST', {
      title: 'Doomed Office',
      type: 'recOfficeType',
    }))!.json()) as { id: string }
    await insertRow('rec_referrer', {
      type: 'recPageType',
      path: 'recreferrer',
      title: 'Referrer',
      doc: one('rr', 'recPage', { title: 'Referrer', office: created.id }),
    })
    await folio.reindex(env, { batch: 200 })

    const before = (await (await get(`/folio/documents/${created.id}/usage`))!.json()) as {
      total: number
    }
    expect(before.total).toBe(1)

    // Warns with a count, and proceeds (decision 4): the delete is not gated on
    // the usage being zero.
    const res = (await send(`/folio/stories/${created.id}`, 'DELETE'))!
    expect(res.status).toBe(200)
    expect(((await res.json()) as { deleted: string[] }).deleted).toEqual([created.id])

    const rows = await env.DB.prepare('select count(*) as n from content_index where story_id = ?')
      .bind(created.id)
      .first<{ n: number }>()
    expect(rows?.n).toBe(0)

    // The referring page is still live and still published; it renders its
    // block's empty state, which is what makes a broken reference safe.
    expect(await folio.published(env, 'recreferrer')).not.toBeNull()
    // And the `to_story` row survives deliberately, so the *next* publish of the
    // referrer is what prunes it.
    const refs = await env.DB.prepare('select count(*) as n from content_refs where to_story = ?')
      .bind(created.id)
      .first<{ n: number }>()
    expect(refs?.n).toBe(1)
  })
})
