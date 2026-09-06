import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BulkReport } from '../../src/core/bulk'
import type { Page } from '../../src/core/pagination'
import {
  deleteResponses,
  listResponses,
  type ResponsePage,
  type ResponseRow,
  responseById,
} from '../../src/server/form-responses'
import type { Form } from '../../src/server/forms'

/**
 * The admin's half of a form: reading responses, deleting them, and exporting
 * them (`docs/specs/content-model/forms.md` phase 7), against real D1, real R2
 * and the real migrations.
 *
 * Five properties, each of which is silent when it breaks:
 *
 *  - **Nothing here answers `ip_hash` or `body_hash`.** The first is the one
 *    quasi-identifier in the table and expires by construction (decision 10); a
 *    reader that handed it to a screen would give a stored hash a second life.
 *  - **Every reader binds `form_id` as well as an id**, so a response cannot be
 *    read, downloaded or deleted through another form's URL. A route that checks
 *    only an unguessable id is a route whose access control *is* the id.
 *  - **A delete takes the R2 objects with it.** Rows first, objects after, the
 *    failure swallowed — `deleteAsset`'s rule, and the inverse of `deleteForm`'s.
 *    Without it every CV anybody ever attached stays in the bucket forever.
 *  - **A bulk delete never binds a caller-sized list.** D1 takes 100 parameters
 *    per statement and a selection is caller-sized by definition, so the id batch
 *    is exercised past the cap rather than trusted to stay under it.
 *  - **Every CSV cell is de-fanged.** A form's whole input surface is strangers,
 *    and `=cmd|'/c calc'!A1` in a name field executes when the file is opened.
 *
 * D1 and R2 state is isolated per *file*, not per test, so every test resets.
 */

const ORIGIN = 'https://example.com'
const API = `${ORIGIN}/folio/api`

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('delete from form_responses'),
    env.DB.prepare('delete from forms'),
  ])
}

beforeEach(reset)

const NAME_FIELD = { name: 'full_name', kind: 'text', label: 'Your name' }
const EMAIL_FIELD = { name: 'email', kind: 'email', label: 'Email', required: true }
const CV_FIELD = { name: 'cv', kind: 'file', label: 'Your CV', accept: 'documents' as const }

async function makeForm(label: string, fields: unknown[] = []): Promise<Form> {
  const created = await SELF.fetch(`${API}/forms`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  })
  const form = await created.json<Form>()
  if (fields.length === 0) return form
  const saved = await SELF.fetch(`${API}/forms/${form.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ expectedUpdatedAt: form.updatedAt, fields }),
  })
  expect(saved.status).toBe(200)
  return saved.json<Form>()
}

let minted = 0
const nextId = (): string => `res_${(minted++).toString(16).padStart(12, '0')}`

interface Seed {
  id?: string
  data?: Record<string, unknown>
  createdAt?: number
  version?: number
  locale?: string
  page?: string
  files?: { field: string; key: string; filename: string; size: number; contentType: string }[]
  ipHash?: string | null
}

/** One row, inserted directly: nothing in this file is about submitting. */
async function seed(formId: string, over: Seed = {}): Promise<string> {
  const id = over.id ?? nextId()
  await env.DB.prepare(
    `insert into form_responses
       (id, form_id, version, created_at, data, locale, page, ip_hash, body_hash, files)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      formId,
      over.version ?? 1,
      over.createdAt ?? Date.now(),
      JSON.stringify(over.data ?? {}),
      over.locale ?? '',
      over.page ?? '',
      over.ipHash === undefined ? 'hash-of-an-ip' : over.ipHash,
      `body-${id}`,
      JSON.stringify(over.files ?? []),
    )
    .run()
  return id
}

/** An object in the bucket under a `sub_` key, and the `files` entry naming it. */
async function attach(field: string, filename: string, body: string) {
  const key = `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}-${filename}`
  await env.MEDIA.put(key, body)
  return { field, key, filename, size: body.length, contentType: 'application/octet-stream' }
}

async function rowCount(formId: string): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from form_responses where form_id = ?')
    .bind(formId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/* -------------------------------------------------------------- the list --- */

describe('listResponses', () => {
  it('pages newest first, with an opt-in total and the age of the oldest row', async () => {
    const form = await makeForm('Contact')
    const now = Date.UTC(2026, 8, 6)
    await seed(form.id, { createdAt: now - 3000, data: { full_name: 'Ada' } })
    await seed(form.id, { createdAt: now - 2000, data: { full_name: 'Grace' } })
    await seed(form.id, { createdAt: now - 1000, data: { full_name: 'Alan' } })

    const bare = await listResponses(env.DB, form.id)
    expect(bare.rows.map((row) => row.data.full_name)).toEqual(['Alan', 'Grace', 'Ada'])
    // Two opt-in aggregates behind one flag, and both absent until asked
    // (`pagination.md` decision 5).
    expect(bare.total).toBeUndefined()
    expect(bare.oldest).toBeUndefined()

    const counted = await listResponses(env.DB, form.id, { count: true })
    expect(counted.total).toBe(3)
    expect(counted.oldest).toBe(now - 3000)
  })

  it('answers a null oldest for a form nobody has answered', async () => {
    const form = await makeForm('Empty')
    const page = await listResponses(env.DB, form.id, { count: true })
    expect(page.total).toBe(0)
    expect(page.oldest).toBeNull()
  })

  it('walks a cursor without repeating or skipping a row', async () => {
    const form = await makeForm('Contact')
    const now = Date.UTC(2026, 8, 6)
    for (let at = 0; at < 5; at++) await seed(form.id, { createdAt: now - at * 1000 })

    const first = await listResponses(env.DB, form.id, { limit: 2 })
    expect(first.rows).toHaveLength(2)
    const second = await listResponses(env.DB, form.id, {
      limit: 2,
      cursor: first.cursor ?? undefined,
    })
    const third = await listResponses(env.DB, form.id, {
      limit: 2,
      cursor: second.cursor ?? undefined,
    })
    expect(third.cursor).toBeNull()

    const seen = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id)
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('filters by an inclusive `from` and an exclusive `to`', async () => {
    const form = await makeForm('Contact')
    const day = Date.UTC(2026, 8, 3)
    await seed(form.id, { createdAt: day - 1, data: { full_name: 'before' } })
    await seed(form.id, { createdAt: day, data: { full_name: 'on it' } })
    await seed(form.id, { createdAt: day + 86_400_000, data: { full_name: 'after' } })

    const page = await listResponses(env.DB, form.id, {
      filter: { from: day, to: day + 86_400_000 },
    })
    expect(page.rows.map((row) => row.data.full_name)).toEqual(['on it'])
  })

  it('scans the stored answers for `q`', async () => {
    const form = await makeForm('Contact')
    await seed(form.id, { data: { full_name: 'Ada Lovelace' } })
    await seed(form.id, { data: { full_name: 'Grace Hopper' } })

    const page = await listResponses(env.DB, form.id, { filter: { q: 'Lovelace' }, count: true })
    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(1)
    // `oldest` deliberately ignores the filter: it is the standing retention
    // symptom (decision 17), and a number that moved with the search box would
    // say nothing about retention at all.
    expect(page.oldest).not.toBeNull()
  })

  it('never answers the ip hash or the body hash', async () => {
    const form = await makeForm('Contact')
    await seed(form.id, { data: { full_name: 'Ada' } })
    const [row] = (await listResponses(env.DB, form.id)).rows
    expect(row).toBeDefined()
    expect(Object.keys(row as ResponseRow).sort()).toEqual([
      'createdAt',
      'data',
      'files',
      'formId',
      'id',
      'locale',
      'page',
      'version',
    ])
  })

  it('screens a malformed `data` rather than throwing the whole page away', async () => {
    const form = await makeForm('Contact')
    await env.DB.prepare(
      `insert into form_responses (id, form_id, version, created_at, data, body_hash)
       values (?, ?, 1, ?, ?, 'x')`,
    )
      .bind(nextId(), form.id, Date.now(), 'not json at all')
      .run()
    // `parseScopes`' posture for every JSON column in this schema.
    const page = await listResponses(env.DB, form.id)
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]?.data).toEqual({})
  })

  it('is reachable through the route, keyed by the form', async () => {
    const a = await makeForm('One', [NAME_FIELD])
    const b = await makeForm('Two', [NAME_FIELD])
    await seed(a.id, { data: { full_name: 'Ada' } })
    await seed(b.id, { data: { full_name: 'Grace' } })

    const res = await SELF.fetch(`${API}/forms/${a.id}/responses?count=1`)
    expect(res.status).toBe(200)
    const page = await res.json<ResponsePage>()
    expect(page.total).toBe(1)
    expect(page.rows[0]?.data.full_name).toBe('Ada')
  })
})

describe('responseById', () => {
  it('binds the form as well as the id, so a response cannot be read through another form', async () => {
    const a = await makeForm('One')
    const b = await makeForm('Two')
    const id = await seed(a.id, { data: { full_name: 'Ada' } })

    expect(await responseById(env.DB, a.id, id)).not.toBeNull()
    // The id is unguessable; a route that checked only the id would have access
    // control that *is* the id.
    expect(await responseById(env.DB, b.id, id)).toBeNull()

    const wrong = await SELF.fetch(`${API}/forms/${b.id}/responses/${id}`)
    expect(wrong.status).toBe(404)
  })

  it('answers every key the row holds, and screens the files column', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV_FIELD])
    const file = await attach('cv', 'cv.pdf', '%PDF-1.7')
    const id = await seed(form.id, {
      data: { email: 'ada@example.com', retired_key: 'kept' },
      files: [file, { field: '', key: '', filename: '', size: 0, contentType: '' }],
    })

    const res = await SELF.fetch(`${API}/forms/${form.id}/responses/${id}`)
    const row = await res.json<ResponseRow>()
    expect(row.data).toEqual({ email: 'ada@example.com', retired_key: 'kept' })
    expect(row.files).toHaveLength(1)
    // The stored label is never echoed: the route sends octet-stream whatever
    // the column says, so there is nothing here to ignore.
    expect(row.files[0]?.contentType).toBe('application/octet-stream')
  })
})

/* ------------------------------------------------------------ one delete --- */

describe('DELETE one response', () => {
  it('removes the row and the object behind it', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV_FIELD])
    const file = await attach('cv', 'cv.pdf', '%PDF-1.7')
    const id = await seed(form.id, { data: { email: 'ada@example.com' }, files: [file] })

    const res = await SELF.fetch(`${API}/forms/${form.id}/responses/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, files: 1 })
    expect(await rowCount(form.id)).toBe(0)
    // The half that is silent when it breaks: the row goes either way, and an
    // orphaned object is invisible and paid for monthly.
    expect(await env.MEDIA.get(file.key)).toBeNull()
  })

  it('404s an unknown response and one belonging to another form', async () => {
    const a = await makeForm('One')
    const b = await makeForm('Two')
    const id = await seed(a.id)

    const unknown = await SELF.fetch(`${API}/forms/${a.id}/responses/res_ffffffffffff`, {
      method: 'DELETE',
    })
    expect(unknown.status).toBe(404)

    const wrongForm = await SELF.fetch(`${API}/forms/${b.id}/responses/${id}`, { method: 'DELETE' })
    expect(wrongForm.status).toBe(404)
    expect(await rowCount(a.id)).toBe(1)
  })

  it('screens the id by its mint format, so the param is not a read primitive', async () => {
    const form = await makeForm('One')
    const res = await SELF.fetch(`${API}/forms/${form.id}/responses/whatever`)
    expect(res.status).toBe(400)
  })
})

/* ----------------------------------------------------------- bulk delete --- */

describe('deleteResponses', () => {
  it('deletes the ids it was given and reports what it did', async () => {
    const form = await makeForm('Contact')
    const ids = [await seed(form.id), await seed(form.id), await seed(form.id)]

    const outcome = await deleteResponses({ db: env.DB }, form.id, { ids: ids.slice(0, 2) })
    expect(outcome).toMatchObject({ action: 'delete', done: 2, failed: [], total: 2, seen: 2 })
    expect(await rowCount(form.id)).toBe(1)
    expect(await responseById(env.DB, form.id, ids[2] as string)).not.toBeNull()
  })

  it('chunks an id list past D1’s 100-parameter ceiling', async () => {
    const form = await makeForm('Contact')
    const ids: string[] = []
    for (let at = 0; at < 150; at++) ids.push(await seed(form.id))

    // A selection is caller-sized by definition. One `in (…)` over 150 ids is
    // `D1_ERROR: too many SQL variables`; `bindChunks` is what makes this pass.
    const outcome = await deleteResponses({ db: env.DB }, form.id, { ids }, { batch: 200 })
    expect(outcome).toMatchObject({ done: 150, failed: [] })
    expect(await rowCount(form.id)).toBe(0)
  })

  it('counts an id with no row behind it as done, because a delete got what it asked for', async () => {
    const form = await makeForm('Contact')
    const id = await seed(form.id)
    const outcome = await deleteResponses({ db: env.DB }, form.id, {
      ids: [id, 'res_ffffffffffff'],
    })
    expect(outcome).toMatchObject({ done: 2, failed: [] })
  })

  it('takes every object the batch read, once per batch rather than once per row', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV_FIELD])
    const files = [
      await attach('cv', 'one.pdf', 'a'),
      await attach('cv', 'two.pdf', 'b'),
      await attach('cv', 'three.pdf', 'c'),
    ]
    const ids: string[] = []
    for (const file of files) ids.push(await seed(form.id, { files: [file] }))

    await deleteResponses({ db: env.DB, media: env.MEDIA }, form.id, { ids })
    expect(await rowCount(form.id)).toBe(0)
    for (const file of files) expect(await env.MEDIA.get(file.key)).toBeNull()
  })

  it('walks a captured filter in batches, ending on `continueFrom`', async () => {
    const form = await makeForm('Contact')
    for (let at = 0; at < 5; at++) await seed(form.id, { data: { full_name: `n${at}` } })

    let outcome = (await deleteResponses(
      { db: env.DB },
      form.id,
      { all: true, filter: {}, expected: 5 },
      { batch: 2 },
    )) as BulkReport<'delete'>
    expect(outcome.done).toBe(2)
    expect(outcome.continueFrom).not.toBeNull()

    // Loop on `continueFrom`, never on `seen < total`.
    let guard = 0
    while (outcome.continueFrom !== null && guard++ < 10) {
      outcome = (await deleteResponses(
        { db: env.DB },
        form.id,
        { all: true, filter: {}, expected: 5 },
        { batch: 2, continueFrom: outcome.continueFrom },
      )) as BulkReport<'delete'>
    }
    expect(await rowCount(form.id)).toBe(0)
  })

  it('honours a filter, and leaves everything outside it alone', async () => {
    const form = await makeForm('Contact')
    await seed(form.id, { data: { full_name: 'Ada Lovelace' } })
    await seed(form.id, { data: { full_name: 'Grace Hopper' } })

    const outcome = await deleteResponses({ db: env.DB }, form.id, {
      all: true,
      filter: { q: 'Lovelace' },
      expected: 1,
    })
    expect(outcome).toMatchObject({ done: 1 })
    const left = await listResponses(env.DB, form.id)
    expect(left.rows.map((row) => row.data.full_name)).toEqual(['Grace Hopper'])
  })

  it('drops the rows a select-all ticked off, without binding them', async () => {
    const form = await makeForm('Contact')
    const ids = [await seed(form.id), await seed(form.id), await seed(form.id)]

    const outcome = await deleteResponses({ db: env.DB }, form.id, {
      all: true,
      filter: {},
      expected: 3,
      exclude: [ids[0] as string],
    })
    expect(outcome).toMatchObject({ done: 2, total: 2 })
    expect(await responseById(env.DB, form.id, ids[0] as string)).not.toBeNull()
  })

  it('refuses when the set moved between the number somebody read and the button', async () => {
    const form = await makeForm('Contact')
    await seed(form.id)
    await seed(form.id)

    const outcome = await deleteResponses({ db: env.DB }, form.id, {
      all: true,
      filter: {},
      expected: 5,
    })
    // A value, not a throw, and it carries the new count so re-confirming is one
    // click rather than a mystery.
    expect(outcome).toEqual({ refused: 'count', expected: 5, actual: 2 })
    expect(await rowCount(form.id)).toBe(2)
  })

  it('is answered as a 409 with the counts beside the error envelope', async () => {
    const form = await makeForm('Contact')
    await seed(form.id)

    const res = await SELF.fetch(`${API}/forms/${form.id}/responses/delete`, {
      method: 'POST',
      body: JSON.stringify({ selection: { all: true, filter: {}, expected: 9 } }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: { code: 'conflict' },
      refused: 'count',
      expected: 9,
      actual: 1,
    })
  })

  it('writes nothing on a dry run, and reports what it would have done', async () => {
    const form = await makeForm('Contact')
    await seed(form.id)
    await seed(form.id)

    const outcome = await deleteResponses(
      { db: env.DB },
      form.id,
      { all: true, filter: {}, expected: 2 },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ done: 2, dryRun: true })
    expect(await rowCount(form.id)).toBe(2)
  })

  it('refuses a body naming both an id list and a filter', async () => {
    const form = await makeForm('Contact')
    // `v.strictObject`: a stripped key here changes which rows get deleted.
    const res = await SELF.fetch(`${API}/forms/${form.id}/responses/delete`, {
      method: 'POST',
      body: JSON.stringify({
        selection: { ids: ['res_000000000000'], all: true, filter: {}, expected: 1 },
      }),
    })
    expect(res.status).toBe(400)
  })
})

/* ---------------------------------------------------------- the CSV file --- */

/** The export, as text, through the route. */
async function exportCsv(formId: string, query = ''): Promise<{ res: Response; text: string }> {
  const res = await SELF.fetch(`${API}/forms/${formId}/responses.csv${query}`)
  return { res, text: await res.text() }
}

const rowsOf = (text: string): string[] => text.split('\r\n').filter(Boolean)

describe('the CSV export', () => {
  it('sends a file, not JSON, and keeps it out of every cache', async () => {
    const form = await makeForm('Contact us', [NAME_FIELD])
    const { res } = await exportCsv(form.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // ASCII by construction — `safeFilename` — so the header cannot be split.
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="contact-us-responses-\d{4}-\d{2}-\d{2}\.csv"$/,
    )
  })

  it('answers the header row alone for a form with no responses', async () => {
    // A file with a header is a better answer than an empty file.
    const form = await makeForm('Contact', [NAME_FIELD])
    const { text } = await exportCsv(form.id)
    expect(rowsOf(text)).toEqual(['_submitted_at,_response_id,_version,_locale,_page,full_name'])
    // The BOM is what makes Excel on Windows read this as UTF-8. It has to be
    // asserted on the *bytes*: `Response#text()` decodes UTF-8, and decoding
    // strips a leading BOM, so a check on the string would pass either way.
    const raw = await SELF.fetch(`${API}/forms/${form.id}/responses.csv`)
    const bytes = new Uint8Array(await raw.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('carries every key ever submitted, retired ones after the current questions', async () => {
    const form = await makeForm('Contact', [NAME_FIELD])
    await seed(form.id, { data: { full_name: 'Ada', fax: '555' } })

    const [header, row] = rowsOf((await exportCsv(form.id)).text)
    expect(header?.endsWith('full_name,fax')).toBe(true)
    expect(row?.endsWith('Ada,555')).toBe(true)
  })

  it('names a retired file question, which leaves no key in `data` at all', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD])
    const file = await attach('resume', 'me.pdf', 'x')
    await seed(form.id, { data: { email: 'ada@example.com' }, files: [file] })

    const [header, row] = rowsOf((await exportCsv(form.id)).text)
    expect(header?.endsWith('email,resume')).toBe(true)
    expect(row?.endsWith('ada@example.com,me.pdf')).toBe(true)
  })

  it('writes an em dash for a question a response predates, and empty for a blank one', async () => {
    const form = await makeForm('Contact', [NAME_FIELD, { ...EMAIL_FIELD, required: false }])
    await seed(form.id, { data: { full_name: 'Ada', email: '' } })
    await seed(form.id, { data: { full_name: 'Grace' } })

    const rows = rowsOf((await exportCsv(form.id)).text)
    // Newest first, so Grace's row comes back before Ada's.
    expect(rows[1]?.endsWith('Grace,—')).toBe(true)
    expect(rows[2]?.endsWith('Ada,')).toBe(true)
  })

  it('de-fangs a formula a visitor typed, end to end', async () => {
    const form = await makeForm('Contact', [NAME_FIELD])
    await seed(form.id, { data: { full_name: "=cmd|'/c calc'!A1" } })

    const rows = rowsOf((await exportCsv(form.id)).text)
    // The apostrophe is what Excel and Sheets read as "this is text".
    expect(rows[1]?.endsWith("'=cmd|'/c calc'!A1")).toBe(true)
    expect(rows[1]).not.toContain(',=cmd')
  })

  it('quotes a comma, a quote and a newline, and de-fangs on top of the quoting', async () => {
    const form = await makeForm('Contact', [NAME_FIELD])
    await seed(form.id, { data: { full_name: '-1,000 "each"' } })

    const text = (await exportCsv(form.id)).text
    expect(text).toContain('"\'-1,000 ""each"""')
  })

  it('honours the same filter the table is showing', async () => {
    const form = await makeForm('Contact', [NAME_FIELD])
    await seed(form.id, { data: { full_name: 'Ada Lovelace' } })
    await seed(form.id, { data: { full_name: 'Grace Hopper' } })

    const { text } = await exportCsv(form.id, '?q=Lovelace')
    const rows = rowsOf(text)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('Ada Lovelace')
    // But the header is the whole form's key union either way, so two exports of
    // different filters have the same columns.
    expect(rows[0]?.endsWith('full_name')).toBe(true)
  })

  it('streams every page rather than the first', async () => {
    const form = await makeForm('Contact', [NAME_FIELD])
    for (let at = 0; at < 250; at++) await seed(form.id, { data: { full_name: `n${at}` } })

    const rows = rowsOf((await exportCsv(form.id)).text)
    // 250 rows past a 200-row page: a walk that stopped at the first page would
    // answer 201 lines and look entirely plausible.
    expect(rows).toHaveLength(251)
  })

  it('404s an unknown form rather than answering an empty file', async () => {
    const { res } = await exportCsv('frm_ffffffffffff')
    expect(res.status).toBe(404)
  })
})

/* --------------------------------------------------------- the partition --- */

describe('the responses routes are internal, not a promise', () => {
  it('answers nothing under {base}/api/v1', async () => {
    const form = await makeForm('Contact')
    // Checkpoint 20: a version segment is a promise and nobody has asked for
    // this one. `api-partition.test.ts` pins the split; this is the local half.
    const res = await SELF.fetch(`${ORIGIN}/folio/api/v1/forms/${form.id}/responses`)
    expect(res.status).toBe(404)
    const page = await SELF.fetch(`${API}/forms/${form.id}/responses`)
    expect(page.status).toBe(200)
    expect(((await page.json()) as Page<ResponseRow>).rows).toEqual([])
  })
})
