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
    const tree = (await (await get('/folio/api/stories'))!.json()) as { id: string }[]
    const ids = JSON.stringify(tree)
    expect(ids).not.toContain(ADA)
    expect(ids).not.toContain(SYDNEY)
  })

  it('lists them in GET /documents instead, unrouted and with no url', async () => {
    const body = (await (await get('/folio/api/documents?type=recPersonType'))!.json()) as {
      rows: { id: string; path: string | null; url?: string }[]
    }
    expect(body.rows.map((d) => d.id).sort()).toEqual([ADA, GRACE])
    expect(body.rows.every((d) => d.path === null)).toBe(true)
    expect(body.rows.every((d) => d.url === undefined)).toBe(true)
  })
})

/* ------------------------------------------------- indexed list columns --- */

/**
 * The values are **on the row**, not in a sibling map keyed by id, which is what
 * this route answered with before it was paged. `server/stories.ts`'s `DocumentRow`
 * carries the reason; the short version is that a map covering one page's ids is a
 * structure the client has to zip against `rows`, and a map left over from the
 * previous page would quietly supply values for rows no longer on screen.
 */
describe('GET /documents carries the indexed values the list view columns need', () => {
  type Row = { id: string; indexed: Record<string, { text: string; num: number | null }> }

  it('carries each document’s own values, keyed by field', async () => {
    const body = (await (await get('/folio/api/documents'))!.json()) as { rows: Row[] }
    const byId = new Map(body.rows.map((r) => [r.id, r]))
    expect(byId.get(ADA)?.indexed.fullName?.text).toBe('Ada Lovelace')
    expect(byId.get(ADA)?.indexed.role?.text).toBe('Analyst')
    expect(byId.get(SYDNEY)?.indexed.city?.text).toBe('Sydney')
  })

  it('gives a document with nothing published an empty object, so its cells read blank', async () => {
    const created = (await (await send('/folio/api/stories', 'POST', {
      title: 'Unpublished Person',
      type: 'recPersonType',
    }))!.json()) as { id: string }
    const body = (await (await get('/folio/api/documents?type=recPersonType'))!.json()) as {
      rows: Row[]
    }
    // The row IS in the list — the admin lists documents, not published content.
    const row = body.rows.find((r) => r.id === created.id)
    expect(row).toBeDefined()
    // `{}` rather than absent: a cell renderer that had to tell "no values" from
    // "no entry" would need a second branch for a distinction with no meaning.
    expect(row?.indexed).toEqual({})
    await send(`/folio/api/stories/${created.id}`, 'DELETE')
  })

  /**
   * `filterRows`' one interesting assertion, moved server-side: it matched the
   * title *and every indexed value* on screen, so a person searching People for
   * `Analyst` found the row. `?q=` reaches `content_index` for exactly that
   * reason — see `storyFilters`' `indexedText` option, which the tree and flat
   * reads deliberately do not pass.
   */
  it('searches indexed values, not only the title', async () => {
    const body = (await (await get(
      '/folio/api/documents?type=recPersonType&q=analyst',
    ))!.json()) as { rows: Row[] }
    expect(body.rows.map((r) => r.id)).toEqual([ADA])
  })

  it('does not let an indexed value match on the tree or flat reads', async () => {
    // Those rows show title, slug, path and state — nothing on them comes from
    // `content_index`, so a match there would return a page for a reason the list
    // cannot show.
    const body = (await (await get('/folio/api/stories?flat=1&q=analyst'))!.json()) as {
      rows: { id: string }[]
    }
    expect(body.rows).toEqual([])
  })
})

/* ------------------------------------------------------------ the usage --- */

describe('GET /documents/:id/usage', () => {
  it('counts the four published pages referencing an office, and names them', async () => {
    const usage = (await (await get(`/folio/api/documents/${SYDNEY}/usage`))!.json()) as {
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
    const grace = (await (await get(`/folio/api/documents/${GRACE}/usage`))!.json()) as {
      published: { id: string }[]
      total: number
    }
    // Grace appears only inside `team`, never as `lead`, so this row exists
    // solely because the plural walk sees it.
    expect(grace.total).toBe(1)
    expect(grace.published.map((p) => p.id)).toEqual(['rec_team'])
  })

  it('counts one document once even when it both references and lists the target', async () => {
    const ada = (await (await get(`/folio/api/documents/${ADA}/usage`))!.json()) as {
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
    const created = (await (await send('/folio/api/stories', 'POST', {
      title: 'Nobody',
      type: 'recPersonType',
    }))!.json()) as { id: string }
    const usage = (await (await get(`/folio/api/documents/${created.id}/usage`))!.json()) as {
      published: unknown[]
      total: number
    }
    expect(usage.total).toBe(0)
    expect(usage.published).toEqual([])
    await send(`/folio/api/stories/${created.id}`, 'DELETE')
  })

  it('is empty for an id that never existed, rather than an error', async () => {
    const res = (await get('/folio/api/documents/rec_nope/usage'))!
    expect(res.status).toBe(200)
    expect(((await res.json()) as { total: number }).total).toBe(0)
  })

  it('excludes unpublished references, and says so by simply not having them', async () => {
    // A draft page referencing the office. Never published, so nothing was ever
    // written to `content_refs` for it — which is the whole honesty caveat.
    const created = (await (await send('/folio/api/stories', 'POST', {
      title: 'Draft Referrer',
    }))!.json()) as { id: string }
    await folio.handle(
      new Request(`${ORIGIN}/folio/api/story/${created.id}/document`),
      env,
      createExecutionContext(),
    )
    const usage = (await (await get(`/folio/api/documents/${SYDNEY}/usage`))!.json()) as {
      total: number
    }
    expect(usage.total).toBe(4)
    await send(`/folio/api/stories/${created.id}`, 'DELETE')
  })
})

/* -------------------------------------------------- publish and version --- */

describe('a record publishes and versions like a page', () => {
  it('publishes twice and retains two versions, with no path involved', async () => {
    const created = (await (await send('/folio/api/stories', 'POST', {
      title: 'Versioned Person',
      type: 'recPersonType',
    }))!.json()) as { id: string; path: string | null }
    expect(created.path).toBeNull()

    // Opening the document is what seeds the Durable Object; publish reads it.
    await get(`/folio/api/story/${created.id}/document`)
    const first = (await (await send(
      `/folio/api/story/${created.id}/publish`,
      'POST',
    ))!.json()) as {
      ok: boolean
    }
    expect(first.ok).toBe(true)
    const second = (await (await send(
      `/folio/api/story/${created.id}/publish`,
      'POST',
    ))!.json()) as {
      ok: boolean
    }
    expect(second.ok).toBe(true)

    const list = (await (await get(`/folio/api/story/${created.id}/versions`))!.json()) as {
      rows: { kind: string }[]
    }
    expect(list.rows.filter((v) => v.kind === 'publish').length).toBeGreaterThanOrEqual(2)

    // Still no route to it, published or not.
    expect(await folio.published(env, created.id)).toBeNull()
    await send(`/folio/api/stories/${created.id}`, 'DELETE')
  })

  it('refuses to duplicate a singleton but happily duplicates a record', async () => {
    const created = (await (await send('/folio/api/stories', 'POST', {
      title: 'Copy Me',
      type: 'recPersonType',
    }))!.json()) as { id: string }
    await get(`/folio/api/story/${created.id}/document`)
    const res = (await send(`/folio/api/stories/${created.id}/duplicate`, 'POST', {
      title: 'Copy Me 2',
    }))!
    expect(res.status).toBe(201)
    const copy = ((await res.json()) as { story: { id: string; path: string | null } }).story
    expect(copy.path).toBeNull()
    await send(`/folio/api/stories/${copy.id}`, 'DELETE')
    await send(`/folio/api/stories/${created.id}`, 'DELETE')
  })
})

/* --------------------------------------------------------------- delete --- */

describe('deleting a referenced record proceeds', () => {
  it('removes the row, its index rows, and leaves the referring pages alone', async () => {
    const created = (await (await send('/folio/api/stories', 'POST', {
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

    const before = (await (await get(`/folio/api/documents/${created.id}/usage`))!.json()) as {
      total: number
    }
    expect(before.total).toBe(1)

    // Warns with a count, and proceeds (decision 4): the delete is not gated on
    // the usage being zero.
    const res = (await send(`/folio/api/stories/${created.id}`, 'DELETE'))!
    expect(res.status).toBe(200)
    expect(((await res.json()) as { deleted: string[] }).deleted).toEqual([created.id])

    const rows = await env.DB.prepare('select count(*) as n from content_index where story_id = ?')
      .bind(created.id)
      .first<{ n: number }>()
    expect(rows?.n).toBe(0)

    // The referring page is still live and still published; it renders its
    // block's empty state, which is what makes a broken reference safe.
    expect(await folio.published(env, 'recreferrer')).not.toBeNull()

    // And the inbound edge goes with the target. It used to survive until the
    // referrer's next publish rewrote it, which meant a site that never
    // republishes accumulated edges to ids with no document behind them.
    const refs = await env.DB.prepare('select count(*) as n from content_refs where to_id = ?')
      .bind(created.id)
      .first<{ n: number }>()
    expect(refs?.n).toBe(0)

    // The referrer's *other* rows are untouched: this pruned one edge, not the
    // whole source document's outbound set.
    const outbound = await env.DB.prepare(
      'select count(*) as n from content_refs where from_story = ?',
    )
      .bind('rec_referrer')
      .first<{ n: number }>()
    expect(outbound?.n).toBe(0)

    await env.DB.prepare('delete from stories where id = ?').bind('rec_referrer').run()
  })

  it('takes the deleted subtree out of content_refs from both directions at once', async () => {
    // A page that both points at a record and is pointed at by another page, so
    // one delete has an outbound edge and an inbound edge to lose.
    await insertRow('rec_hub', {
      type: 'recPageType',
      path: 'rechub',
      title: 'Hub',
      doc: one('h', 'recPage', { title: 'Hub', office: SYDNEY }),
    })
    await insertRow('rec_pointer', {
      type: 'recPageType',
      path: 'recpointer',
      title: 'Pointer',
      doc: one('pt', 'recPage', { title: 'Pointer', lead: ADA, office: SYDNEY }),
    })
    await folio.reindex(env, { batch: 200 })
    // A `link`-kind edge on top of the two `reference` ones the walk produced —
    // the shape a richtext link mark writes. Inserted after the reindex, because
    // a reindex rewrites `rec_pointer`'s whole outbound set.
    await env.DB.prepare('insert into content_refs (from_story, to_id, kind) values (?, ?, ?)')
      .bind('rec_pointer', 'rec_hub', 'link')
      .run()

    const res = (await send('/folio/api/stories/rec_hub?redirect=false', 'DELETE'))!
    expect(res.status).toBe(200)

    const rows = await env.DB.prepare(
      'select count(*) as n from content_refs where from_story = ? or to_id = ?',
    )
      .bind('rec_hub', 'rec_hub')
      .first<{ n: number }>()
    expect(rows?.n).toBe(0)

    // `rec_pointer` itself is untouched — only the edge naming the deleted page
    // went, not every edge it owns.
    const survivors = await env.DB.prepare(
      'select to_id as target from content_refs where from_story = ? order by target',
    )
      .bind('rec_pointer')
      .all<{ target: string }>()
    expect(survivors.results.map((r) => r.target)).toEqual([ADA, SYDNEY])

    await env.DB.prepare('delete from stories where id = ?').bind('rec_pointer').run()
  })

  it('keeps the inbound edges when a referenced record is only unpublished', async () => {
    // The distinction `clearIndexStatements` and `clearInboundRefStatements`
    // exist to draw: the story is still there, so "used by N" is still a true
    // and useful warning about it.
    await insertRow('rec_paused', {
      type: 'recOfficeType',
      path: null,
      title: 'Paused Office',
      doc: one('pa', 'recOffice', { city: 'Paused', phone: '111' }),
    })
    await insertRow('rec_naming', {
      type: 'recPageType',
      path: 'recnaming',
      title: 'Naming',
      doc: one('nm', 'recPage', { title: 'Naming', office: 'rec_paused' }),
    })
    await folio.reindex(env, { batch: 200 })

    expect((await send('/folio/api/story/rec_paused/unpublish', 'POST'))!.status).toBe(200)

    // Its own projection is gone: an unpublished document leaves every collection.
    const own = await env.DB.prepare('select count(*) as n from content_index where story_id = ?')
      .bind('rec_paused')
      .first<{ n: number }>()
    expect(own?.n).toBe(0)

    // The inbound edge is not.
    const usage = (await (await get('/folio/api/documents/rec_paused/usage'))!.json()) as {
      total: number
    }
    expect(usage.total).toBe(1)

    await env.DB.prepare('delete from stories where id in (?, ?)')
      .bind('rec_paused', 'rec_naming')
      .run()
  })
})

/* --------------------------------------------------------------- the search --- */

/**
 * `GET {base}/api/search` — `foundation/pagination.md` decision 8's "one route,
 * three consumers". The palette is the first; the link and reference pickers adopt
 * it with their own ports, which is why `?kind=` exists before anything passes it.
 *
 * The route this replaces for the palette was `?flat=1&q=`, and the two things it
 * could not do are the two things asserted here: reach a *record*, and reach a
 * value that lives in `content_index` rather than on the row.
 */
describe('GET /api/search', () => {
  type Found = { rows: { id: string; type: string; title: string }[]; total?: number }
  const search = async (query: string) =>
    (await (await get(`/folio/api/search?${query}`))!.json()) as Found

  it('spans every kind, so a record is reachable where flat mode could not reach it', async () => {
    const found = await search('q=lovelace')
    expect(found.rows.map((r) => r.id)).toContain(ADA)
  })

  it('reaches an indexed value, not only the title', async () => {
    const found = await search('q=analyst')
    expect(found.rows.map((r) => r.id)).toEqual([ADA])
  })

  it('narrows to a declared kind, which is what a picker needs', async () => {
    const records = await search('kind=record')
    expect(
      records.rows.every((r) => r.type === 'recPersonType' || r.type === 'recOfficeType'),
    ).toBe(true)
    const pages = await search('kind=page')
    expect(pages.rows.some((r) => r.id === ADA)).toBe(false)
  })

  /**
   * Absent `types` is every type; an **empty** list is none. The distinction only
   * shows up here: a kind no type declares has to answer an empty page rather than
   * the whole table, and getting it wrong would silently offer every document in a
   * picker narrowed to something the site does not have.
   */
  it('answers an empty page for a kind this site declares none of', async () => {
    const found = await search('kind=singleton&count=1')
    expect(found.rows).toEqual([])
    expect(found.total).toBe(0)
  })

  it('answers every candidate for no query at all, which is what a picker opens on', async () => {
    const found = await search('limit=100')
    expect(found.rows.length).toBeGreaterThan(1)
  })

  it('refuses an unknown kind and an unknown sort', async () => {
    const kind = await get('/folio/api/search?kind=widget')
    expect(kind?.status).toBe(400)
    const sort = await get('/folio/api/search?sort=path')
    expect(sort?.status).toBe(400)
  })

  it('pages over a cursor like every other admin list', async () => {
    const first = (await (await get('/folio/api/search?limit=1&count=1'))!.json()) as Found & {
      cursor: string | null
    }
    expect(first.rows).toHaveLength(1)
    expect(first.cursor).not.toBeNull()

    const second = (await (await get(
      `/folio/api/search?limit=1&cursor=${encodeURIComponent(first.cursor ?? '')}`,
    ))!.json()) as Found
    expect(second.rows[0]?.id).not.toBe(first.rows[0]?.id)
  })
})
