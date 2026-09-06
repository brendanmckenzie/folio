import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, outboundRefs, text, toRegistry, toSchemaIndex } from '../../src/core'
import type { Doc } from '../../src/core/doc'
import type { Page } from '../../src/core/pagination'
import { createFolio } from '../../src/server'
import {
  countResponsesByForm,
  deleteForm,
  type Form,
  formById,
  type FormSummary,
  formsByIds,
  isOpen,
  listForms,
  updateForm,
} from '../../src/server/forms'
import type { FolioHooks, FormChangedHookPayload } from '../../src/server/hooks'

/**
 * The forms store and its six admin routes
 * (`docs/specs/content-model/forms.md` phase 2), against real D1 and the real
 * migrations.
 *
 * Four of these exist because the failure is silent rather than loud:
 *
 *  - **The `expectedUpdatedAt` guard is in the `update`'s own `where`.** A form
 *    is outside the mutation log, so this is the whole of its concurrency story
 *    (decision 18); a read-then-write pair loses one editor's questions with no
 *    error anywhere. Verified by breaking it — dropping the `and updated_at = ?`
 *    turns `refuses a save whose expectedUpdatedAt has moved` red.
 *  - **`version` bumps on shape and only on shape** (decision 7), because it is
 *    what makes a two-year-old response readable and what decides whether a
 *    week of cached pages gets purged.
 *  - **The delete cascades and reports what it destroyed** (checkpoint 17).
 *    Metadata that silently deletes content is the media library's decision 14
 *    failure; the numbers are the whole defence, so they are asserted.
 *  - **Two readers chunk their binds.** D1 binds at most 100 parameters per
 *    statement, so `formsByIds` and `countResponsesByForm` are exercised past
 *    the cap rather than trusted to stay under it.
 *
 * D1 state is isolated per *file*, not per test, so every test resets the three
 * tables it uses.
 */

const ORIGIN = 'https://example.com'
const API = `${ORIGIN}/folio/api`

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('delete from form_responses'),
    env.DB.prepare('delete from forms'),
    env.DB.prepare("delete from content_refs where kind = 'form'"),
  ])
}

beforeEach(reset)

interface ErrorBody {
  error: { code: string; message: string }
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await SELF.fetch(`${API}${path}`, { method: 'POST', body: JSON.stringify(body) })
  return { status: res.status, json: await res.json<T>() }
}

async function patch<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await SELF.fetch(`${API}${path}`, { method: 'PATCH', body: JSON.stringify(body) })
  return { status: res.status, json: await res.json<T>() }
}

async function get<T>(path: string): Promise<{ status: number; json: T }> {
  const res = await SELF.fetch(`${API}${path}`)
  return { status: res.status, json: await res.json<T>() }
}

/** A form through the route, so every test starts from what a client would have. */
async function makeForm(label: string, name?: string): Promise<Form> {
  const { status, json } = await post<Form>('/forms', name ? { label, name } : { label })
  expect(status).toBe(201)
  return json
}

const NAME_FIELD = { name: 'full_name', kind: 'text', label: 'Your name' }
const EMAIL_FIELD = { name: 'email', kind: 'email', label: 'Email', required: true }

/** One response row, inserted directly: nothing here is about submitting. */
async function seedResponse(
  formId: string,
  over: { files?: unknown[]; createdAt?: number; version?: number } = {},
): Promise<void> {
  const id = `res_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  await env.DB.prepare(
    `insert into form_responses (id, form_id, version, created_at, data, body_hash, files)
     values (?, ?, ?, ?, '{}', ?, ?)`,
  )
    .bind(
      id,
      formId,
      over.version ?? 1,
      over.createdAt ?? Date.now(),
      id,
      JSON.stringify(over.files ?? []),
    )
    .run()
}

/* --------------------------------------------------------------- the store --- */

describe('the forms store', () => {
  it('mints an id the action URL can name, and a slug from the label', async () => {
    const form = await makeForm('Contact us')
    // `frm_<12 hex>` — anchored, because it is a public route's parameter
    // (decision 3) and `formIdParam` screens the shape rather than the charset.
    expect(form.id).toMatch(/^frm_[0-9a-f]{12}$/)
    expect(form.name).toBe('contact-us')
    expect(form.version).toBe(1)
    expect(form.open).toBe(true)
    expect(form.fields).toEqual([])
    expect(form.submitLabel).toBe('Submit')
  })

  it('refuses a second form on the same slug, naming the one that has it', async () => {
    await makeForm('Contact us')
    const clash = await post<ErrorBody>('/forms', { label: 'Contact Us' })
    expect(clash.status).toBe(409)
    expect(clash.json.error.code).toBe('conflict')
    // The message names the existing form, not the constraint: a slug alone
    // leaves an editor hunting for which of forty forms has it.
    expect(clash.json.error.message).toContain('Contact us')
    expect(clash.json.error.message).toContain('contact-us')
  })

  it('lets two forms share a label, because the label is prose and the name is the key', async () => {
    const a = await makeForm('Enquiry')
    const b = await makeForm('Enquiry', 'enquiry-nz')
    expect(a.name).toBe('enquiry')
    expect(b.name).toBe('enquiry-nz')
  })

  it('bumps version on a shape change and leaves it alone for a label edit', async () => {
    const form = await makeForm('Careers')

    const added = await patch<Form>(`/forms/${form.id}`, {
      expectedUpdatedAt: form.updatedAt,
      fields: [NAME_FIELD, EMAIL_FIELD],
    })
    expect(added.status).toBe(200)
    expect(added.json.version).toBe(2)

    // A label, help, placeholder or translation edit touches no constraint a
    // cached page could now be violating, so it bumps nothing (decision 7).
    const relabelled = await patch<Form>(`/forms/${form.id}`, {
      expectedUpdatedAt: added.json.updatedAt,
      fields: [
        { ...NAME_FIELD, label: 'Full name', help: 'As it appears on your passport' },
        EMAIL_FIELD,
      ],
      label: 'Careers 2026',
    })
    expect(relabelled.status).toBe(200)
    expect(relabelled.json.version).toBe(2)
    expect(relabelled.json.fields[0]?.label).toBe('Full name')

    // Making a question required is structural: every cached page is now
    // serving markup whose submission the live form would refuse.
    const tightened = await patch<Form>(`/forms/${form.id}`, {
      expectedUpdatedAt: relabelled.json.updatedAt,
      fields: [{ ...NAME_FIELD, required: true }, EMAIL_FIELD],
    })
    expect(tightened.json.version).toBe(3)
  })

  it('refuses a save whose expectedUpdatedAt has moved', async () => {
    const form = await makeForm('Newsletter')
    const first = await patch<Form>(`/forms/${form.id}`, {
      expectedUpdatedAt: form.updatedAt,
      label: 'Newsletter signup',
    })
    expect(first.status).toBe(200)

    // The second editor read the row before the first saved. Last-write-wins
    // would take the first editor's rename back out with nothing to show for it.
    const stale = await patch<ErrorBody>(`/forms/${form.id}`, {
      expectedUpdatedAt: form.updatedAt,
      label: 'Newsletter (old tab)',
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('conflict')

    const kept = await get<Form>(`/forms/${form.id}`)
    expect(kept.json.label).toBe('Newsletter signup')
  })

  it('moves updated_at on every save, so two saves in one millisecond cannot share a token', async () => {
    const form = await makeForm('Feedback')
    let at = form.updatedAt
    for (let i = 0; i < 5; i++) {
      const saved = await updateForm(env.DB, form.id, {
        expectedUpdatedAt: at,
        label: `Feedback ${i}`,
      })
      expect(saved?.form.updatedAt).toBeGreaterThan(at)
      at = saved?.form.updatedAt ?? at
    }
  })

  it('drops a field kind this build does not know rather than refusing the save', async () => {
    const form = await makeForm('Screened')
    const saved = await patch<Form>(`/forms/${form.id}`, {
      expectedUpdatedAt: form.updatedAt,
      fields: [NAME_FIELD, { name: 'signature', kind: 'holopad', label: 'Sign here' }],
    })
    // `parseScopes`' rule: removing a kind from the code narrows every stored
    // form instead of breaking it.
    expect(saved.status).toBe(200)
    expect(saved.json.fields.map((f) => f.name)).toEqual(['full_name'])
  })

  it('refuses a reserved field name, because `_` is the library namespace', async () => {
    const form = await makeForm('Reserved')
    const refused = await patch<ErrorBody>(`/forms/${form.id}`, {
      expectedUpdatedAt: form.updatedAt,
      fields: [{ name: '_folio_page', kind: 'text', label: 'Page' }],
    })
    expect(refused.status).toBe(400)
  })

  it('computes open from the switch and the clock together, never one of them', async () => {
    const form = await makeForm('Applications')
    expect(isOpen(form)).toBe(true)

    const closing = await patch<Form>(`/forms/${form.id}`, {
      expectedUpdatedAt: form.updatedAt,
      closesAt: Date.now() - 1000,
    })
    // The switch is still on and the form is still closed: there is deliberately
    // no stored "closed" column for a cron to flip and the clock to disagree
    // with (0004_shares.sql's rule).
    expect(closing.json.open).toBe(true)
    expect(isOpen(closing.json)).toBe(false)

    const cleared = await patch<Form>(`/forms/${form.id}`, {
      expectedUpdatedAt: closing.json.updatedAt,
      closesAt: null,
    })
    expect(cleared.json.closesAt).toBeNull()
    expect(isOpen(cleared.json)).toBe(true)
  })
})

/* -------------------------------------------------------------- the routes --- */

describe('the form routes', () => {
  it('pages newest-changed first, with an opt-in total and opt-in response counts', async () => {
    const a = await makeForm('One')
    const b = await makeForm('Two')
    await seedResponse(b.id)
    await seedResponse(b.id)

    const plain = await get<Page<FormSummary>>('/forms?count=1')
    expect(plain.json.total).toBe(2)
    expect(plain.json.rows.map((r) => r.id)).toEqual([b.id, a.id])
    // The array itself is not in a list page: `questions` is the count, so two
    // hundred forms do not drag two hundred field arrays across the wire.
    expect(plain.json.rows[0]).not.toHaveProperty('fields')
    expect(plain.json.rows[0]?.questions).toBe(0)
    expect(plain.json.rows[0]?.responses).toBeUndefined()

    const counted = await get<Page<FormSummary>>('/forms?counts=1')
    expect(counted.json.rows.find((r) => r.id === b.id)?.responses).toBe(2)
    expect(counted.json.rows.find((r) => r.id === a.id)?.responses).toBe(0)
  })

  it('walks a cursor without repeating or skipping a row', async () => {
    const made: string[] = []
    for (let i = 0; i < 7; i++) made.push((await makeForm(`Form ${i}`)).id)

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const res = await get<Page<FormSummary>>(
        `/forms?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      seen.push(...res.json.rows.map((r) => r.id))
      cursor = res.json.cursor ?? undefined
      if (!cursor) break
    }
    expect(seen).toEqual([...made].reverse())
  })

  it('refuses a malformed cursor rather than silently restarting', async () => {
    const res = await get<ErrorBody>('/forms?cursor=not-a-cursor')
    expect(res.status).toBe(400)
  })

  it('screens the id by its mint format, so the param is not a read primitive', async () => {
    for (const id of ['sty_abc123abc123', 'frm_zzzz', 'frm_abc123abc12', '../../etc']) {
      const res = await get<ErrorBody>(`/forms/${encodeURIComponent(id)}`)
      expect(res.status).toBe(400)
      expect(res.json.error.code).toBe('bad_request')
    }
    // A well-formed id with no row behind it is the 404 it should be.
    const missing = await get<ErrorBody>('/forms/frm_000000000000')
    expect(missing.status).toBe(404)
  })

  it('answers usage with the pages, the responses and the files, in one call', async () => {
    const form = await makeForm('Campaign')
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
       values ('sty_usage', 'page', null, 'landing', 'landing', 'a0', 'Landing', 1, 1)`,
    ).run()
    await env.DB.prepare('insert into content_refs (from_story, to_id, kind) values (?, ?, ?)')
      .bind('sty_usage', form.id, 'form')
      .run()
    await seedResponse(form.id, { files: [{ field: 'cv', key: 'sub_aaaaaaaaaaaa-cv.pdf' }] })
    await seedResponse(form.id, {
      files: [
        { field: 'cv', key: 'sub_bbbbbbbbbbbb-cv.pdf' },
        { field: 'folio', key: 'sub_cccccccccccc-p.pdf' },
      ],
    })

    const usage = await get<{
      published: { id: string; title: string }[]
      total: number
      responses: number
      files: number
    }>(`/forms/${form.id}/usage`)

    // All three numbers the delete dialog names, before anything is destroyed
    // (checkpoint 17). A dialog that has to make three calls is a dialog that
    // ships with one of them missing.
    expect(usage.json.total).toBe(1)
    expect(usage.json.published[0]?.title).toBe('Landing')
    expect(usage.json.responses).toBe(2)
    expect(usage.json.files).toBe(3)

    await env.DB.prepare("delete from stories where id = 'sty_usage'").run()
  })

  it('cascades a delete and reports exactly what it destroyed', async () => {
    const form = await makeForm('Finished')
    await seedResponse(form.id, { files: [{ field: 'cv', key: 'sub_aaaaaaaaaaaa-cv.pdf' }] })
    await seedResponse(form.id)
    await env.DB.prepare('insert into content_refs (from_story, to_id, kind) values (?, ?, ?)')
      .bind('sty_page', form.id, 'form')
      .run()

    const res = await SELF.fetch(`${API}/forms/${form.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, responses: 2, files: 1 })

    expect(await formById(env.DB, form.id)).toBeNull()
    const left = await env.DB.prepare('select count(*) as n from form_responses where form_id = ?')
      .bind(form.id)
      .first<{ n: number }>()
    expect(left?.n).toBe(0)
    // The inbound edges go too: they meant "this published page renders this
    // form", and nothing renders a form that no longer exists.
    const edges = await env.DB.prepare(
      "select count(*) as n from content_refs where to_id = ? and kind = 'form'",
    )
      .bind(form.id)
      .first<{ n: number }>()
    expect(edges?.n).toBe(0)

    const again = await SELF.fetch(`${API}/forms/${form.id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
  })
})

/* ---------------------------------------------------------------- binds --- */

describe('the two readers that bind a caller-sized list', () => {
  /**
   * D1 binds at most 100 parameters per statement and that is the ceiling
   * itself, not a soft limit (`server/db.ts`). Both of these take an id list
   * somebody else sized — the forms a document embeds, and a list page's worth
   * of rows — so both are exercised past the cap rather than trusted to stay
   * under it.
   */
  it('reads 150 forms by id and counts 150 forms responses without tripping the cap', async () => {
    const ids: string[] = []
    for (let i = 0; i < 150; i++) {
      const id = `frm_${i.toString(16).padStart(12, '0')}`
      ids.push(id)
      await env.DB.prepare(
        `insert into forms (id, name, label, fields, version, open, created_at, updated_at)
         values (?, ?, ?, '[]', 1, 1, ?, ?)`,
      )
        .bind(id, `bulk-${i}`, `Bulk ${i}`, 1_700_000_000_000 + i, 1_700_000_000_000 + i)
        .run()
      await seedResponse(id)
    }

    expect((await formsByIds(env.DB, ids)).map((f) => f.id).sort()).toEqual([...ids].sort())

    const counts = await countResponsesByForm(env.DB, ids)
    expect(Object.keys(counts)).toHaveLength(150)
    expect(counts[ids[0]!]).toBe(1)

    // Empty in, empty out: `in ()` is not valid SQL.
    expect(await formsByIds(env.DB, [])).toEqual([])
    expect(await countResponsesByForm(env.DB, [])).toEqual({})
  })

  it('counts responses per row on a 200-row list page, over the same cap', async () => {
    for (let i = 0; i < 120; i++) {
      const id = `frm_${(i + 500).toString(16).padStart(12, '0')}`
      await env.DB.prepare(
        `insert into forms (id, name, label, fields, version, open, created_at, updated_at)
         values (?, ?, ?, '[]', 1, 1, ?, ?)`,
      )
        .bind(id, `page-${i}`, `Page ${i}`, 1_700_000_000_000 + i, 1_700_000_000_000 + i)
        .run()
      await seedResponse(id)
    }

    const page = await listForms(env.DB, { limit: 200, counts: true })
    expect(page.rows).toHaveLength(120)
    expect(page.rows.every((row) => row.responses === 1)).toBe(true)
  })
})

/* ----------------------------------------------------------------- hooks --- */

const hookPage = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title', required: true }) },
  render: () => null,
})

function folioWithHooks(hooks: FolioHooks<Cloudflare.Env>) {
  return createFolio<Cloudflare.Env>({
    blocks: [hookPage],
    root: 'page',
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    auth: 'open',
    hooks,
  })
}

async function callHooked(
  folio: ReturnType<typeof folioWithHooks>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await folio.handle(new Request(`${ORIGIN}${path}`, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res!
}

describe('formChanged', () => {
  it('fires on a structural save and on nothing else', async () => {
    const form = await makeForm('Hooked')
    const calls: FormChangedHookPayload<Cloudflare.Env>[] = []
    const folio = folioWithHooks({ formChanged: (e) => calls.push(e) })

    const structural = await callHooked(folio, `/folio/api/forms/${form.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedUpdatedAt: form.updatedAt, fields: [EMAIL_FIELD] }),
    })
    const after = await structural.json<Form>()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.form.id).toBe(form.id)
    expect(calls[0]?.form.name).toBe('hooked')
    expect(calls[0]?.version).toBe(2)
    // `auth: 'open'`, so there is genuinely nobody to attribute the save to.
    expect(calls[0]?.actor).toBeNull()

    const cosmetic = await callHooked(folio, `/folio/api/forms/${form.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedUpdatedAt: after.updatedAt, label: 'Hooked up' }),
    })
    expect(cosmetic.status).toBe(200)
    // A label edit changes no constraint a cached page could now be violating,
    // so it fires nothing and purges nothing (decision 7).
    expect(calls).toHaveLength(1)
  })

  it('does not fire for a save that was refused', async () => {
    const form = await makeForm('Refused')
    const calls: FormChangedHookPayload<Cloudflare.Env>[] = []
    const folio = folioWithHooks({ formChanged: (e) => calls.push(e) })

    const stale = await callHooked(folio, `/folio/api/forms/${form.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedUpdatedAt: form.updatedAt - 1, fields: [EMAIL_FIELD] }),
    })
    expect(stale.status).toBe(409)
    expect(calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------ deleteForm --- */

describe('deleteForm as a method', () => {
  it('answers false for a form that was never there, and destroys nothing', async () => {
    expect(await deleteForm(env.DB, 'frm_000000000000')).toEqual({
      deleted: false,
      responses: 0,
      files: 0,
    })
  })
})

/* ---------------------------------------------------------- the descriptor --- */

/**
 * A `form` field is a lookup on `resolution.forms` (decision 4), which means
 * three things have to line up and each is silent when it does not:
 *
 *  - **The ids come off the document walk.** `resolve()` loads the forms a page
 *    embeds, not every form on the site, and a page embedding none must issue no
 *    forms query at all (`read-session.test.ts` pins that half, where the query
 *    count is observable).
 *  - **A rendered page carries `form:<id>`.** The purge is already wired —
 *    `formChanged` → `purge('form change', [formTag(id)])` — and it reaches
 *    nothing at all unless the tag is on the page in the first place. This is the
 *    half that makes a structural save honest about a week-long TTL.
 *  - **The action and `_folio_page` are computed at render**, from the base path
 *    and the host's own `route`, so remounting Folio or renaming a form
 *    invalidates nothing.
 */

const formPage = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true }),
    // No `form()` builder exists yet — phase 1 added the union member and the
    // resolution, and a block author writes the literal until one does.
    enquiry: { kind: 'form' as const, label: 'Enquiry' },
  },
  render: () => null,
})

function folioWithForm() {
  return createFolio<Cloudflare.Env>({
    blocks: [formPage],
    types: [{ name: 'page', label: 'Page', kind: 'page', root: 'page' }],
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    auth: 'open',
    route: (p) => (p ? `/${p}` : '/'),
  })
}

/** A published page whose root block embeds `formId` (or nothing). */
async function insertFormPage(id: string, path: string, formId?: string): Promise<Doc> {
  const doc = {
    root: 'root0000',
    bloks: {
      root0000: {
        uid: 'root0000',
        type: 'page',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title: 'Contact', ...(formId ? { enquiry: formId } : {}) },
      },
    },
  }
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                          published_doc, published_at)
     values (?, 'page', null, ?, ?, 'a0', 'Contact', ?, ?, ?)`,
  )
    .bind(id, path, path, Date.now(), JSON.stringify(doc), Date.now())
    .run()
  return doc
}

describe('resolve(): the descriptor a page renders from', () => {
  it('compiles one per embedded form, with the action and the page it was rendered on', async () => {
    const form = await makeForm('Enquiry')
    await patch<Form>(`/forms/${form.id}`, {
      expectedUpdatedAt: form.updatedAt,
      fields: [NAME_FIELD, EMAIL_FIELD],
      submitLabel: 'Send it',
    })
    await insertFormPage('sty_fx_a', 'fx-a', form.id)

    const page = await folioWithForm().reader(env).page('fx-a')
    const descriptor = page?.resolution.forms?.[form.id]

    expect(descriptor?.action).toBe(`/folio/f/${form.id}`)
    expect(descriptor?.method).toBe('post')
    expect(descriptor?.enctype).toBe('application/x-www-form-urlencoded')
    expect(descriptor?.open).toBe(true)
    expect(descriptor?.version).toBe(2)
    expect(descriptor?.submitLabel).toBe('Send it')
    expect(descriptor?.fields.map((f) => f.name)).toEqual(['full_name', 'email'])
    // The page it came from, through the host's own `route` — which is what the
    // submit route sends the browser back to.
    expect(descriptor?.hidden).toEqual([{ name: '_folio_page', value: '/fx-a' }])
  })

  it('puts the form on the page cache tags, which is what a structural save purges', async () => {
    const form = await makeForm('Tagged')
    await insertFormPage('sty_fx_b', 'fx-b', form.id)

    const page = await folioWithForm().reader(env).page('fx-b')
    // `formChanged` purges exactly this string. Without it on the page, a
    // required field added to the form leaves a week of cached markup that the
    // live route refuses, and nothing anywhere says so.
    expect(page?.headers['cache-tag']).toContain(`form:${form.id}`)
    expect(page?.headers['cache-tag']).toContain('story:sty_fx_b')
  })

  it('leaves the map absent for a page that embeds none, and for a form since deleted', async () => {
    await insertFormPage('sty_fx_c', 'fx-c')
    const bare = await folioWithForm().reader(env).page('fx-c')
    // Absent rather than `{}`, the rule `docs` and `globals` follow.
    expect(bare?.resolution.forms).toBeUndefined()
    expect(bare?.headers['cache-tag']).not.toContain('form:')

    const form = await makeForm('Doomed')
    await insertFormPage('sty_fx_d', 'fx-d', form.id)
    await deleteForm(env.DB, form.id)

    const orphaned = await folioWithForm().reader(env).page('fx-d')
    // The same posture a `reference` to a deleted document takes: no entry, and
    // `resolveValue` answers `null` so the host's block renders nothing.
    expect(orphaned?.resolution.forms).toBeUndefined()
  })

  it('walks the same edge the usage count reads, so a page renders and is counted', async () => {
    const form = await makeForm('Used')
    const doc = await insertFormPage('sty_fx_e', 'fx-e', form.id)

    // The publish projection's edges, from the identical walk `resolve()` uses
    // to decide which forms to load (`core/refs.ts`'s `formIds`). Written here
    // the way `contentProjection` writes them, so the two strings that have to
    // agree — the kind the walk emits and the kind the counter binds — are both
    // under test rather than both hard-coded.
    const edges = outboundRefs(doc, toSchemaIndex(toRegistry([formPage])), 'sty_fx_e')
    expect(edges).toContainEqual({ to: form.id, kind: 'form' })
    for (const edge of edges) {
      await env.DB.prepare('insert into content_refs (from_story, to_id, kind) values (?, ?, ?)')
        .bind('sty_fx_e', edge.to, edge.kind)
        .run()
    }

    const { json } = await get<{ published: { path: string }[]; total: number }>(
      `/forms/${form.id}/usage`,
    )
    expect(json.total).toBe(1)
    expect(json.published[0]?.path).toBe('fx-e')
  })
})
