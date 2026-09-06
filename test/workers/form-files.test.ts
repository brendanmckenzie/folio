import { createExecutionContext, env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import { createFolio } from '../../src/server'
import type { Folio, FolioBindings } from '../../src/server'
import type { Form } from '../../src/server/forms'

/**
 * Uploads: **the only way an anonymous stranger puts bytes in a host's R2
 * bucket** (`docs/specs/content-model/forms.md` decision 15).
 *
 * Phase 4 made the door; this is the door carrying payloads, so the whole file
 * is a threat-model test. Six properties, each of which is silent when it
 * breaks and expensive when it stays broken:
 *
 *  - **The submitted filename never decides the key.** Keys are minted
 *    `sub_<12 hex>-<safeFilename>`, so `../../.env` is a key that reads `.env`
 *    and collides with nothing.
 *  - **The declared content type is a claim.** `accept` is enforced against what
 *    the bytes say, because a gate on a header a stranger wrote is not a gate.
 *  - **Size is refused before the bytes are stored.** A cap checked after a put
 *    has already paid for the put — twice, because R2 bills the write.
 *  - **`{base}/asset/sub_…` cannot serve one**, and not because of a guard:
 *    `ASSET_KEY` is anchored to `^ast_…`, so it is a 400 from the parameter
 *    validator before a handler runs.
 *  - **The gated download is always an attachment**, always
 *    `application/octet-stream`, always `no-store`, however the bytes sniffed.
 *  - **Deleting a form takes its objects with it.** `deleteForm` walks the
 *    `files` column in keyset pages *before* the batch; without that, every file
 *    ever submitted stays in the bucket with nothing left naming it.
 *
 * D1 state is isolated per file, and so is R2 in practice — every test here
 * mints its own keys — but the two tables are reset anyway.
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

const CV = { name: 'cv', kind: 'file', label: 'Your CV', accept: 'documents', maxBytes: 4096 }
const HEADSHOT = { name: 'photo', kind: 'file', label: 'Photo', accept: 'images', maxBytes: 4096 }
const EMAIL_FIELD = { name: 'email', kind: 'email', label: 'Email', required: true }

/* ------------------------------------------------------------- fixtures --- */

const bytesOf = (...parts: (number[] | string)[]): Uint8Array => {
  const out: number[] = []
  for (const part of parts) {
    if (typeof part === 'string') for (const ch of part) out.push(ch.charCodeAt(0))
    else out.push(...part)
  }
  return new Uint8Array(out)
}

const PDF = bytesOf('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n')
const PNG = bytesOf([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 0x0d], 'IHDR')
const EXE = bytesOf('MZ', [0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00])

async function makeForm(label: string, fields: unknown[]): Promise<Form> {
  const created = await SELF.fetch(`${API}/forms`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  })
  const form = await created.json<Form>()
  const saved = await SELF.fetch(`${API}/forms/${form.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ expectedUpdatedAt: form.updatedAt, fields }),
  })
  expect(saved.status).toBe(200)
  return saved.json<Form>()
}

interface Attachment {
  field: string
  filename: string
  bytes: Uint8Array
  /** What the *client* claims. Never what decides anything. */
  type?: string
}

/** A native multipart POST, exactly as a browser with no JavaScript sends one. */
function submit(
  id: string,
  values: Record<string, string>,
  attachments: readonly Attachment[] = [],
): Promise<Response> {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.append(key, value)
  for (const file of attachments) {
    data.append(
      file.field,
      new File([file.bytes as BufferSource], file.filename, {
        type: file.type ?? 'application/octet-stream',
      }),
    )
  }
  return SELF.fetch(`${ORIGIN}/folio/f/${id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { accept: 'application/json' },
    body: data,
  })
}

interface StoredFile {
  field: string
  key: string
  filename: string
  size: number
  contentType: string
}

async function filesOf(formId: string): Promise<StoredFile[][]> {
  const { results } = await env.DB.prepare(
    'select files from form_responses where form_id = ? order by id',
  )
    .bind(formId)
    .all<{ files: string }>()
  return results.map((row) => JSON.parse(row.files) as StoredFile[])
}

async function rowCount(formId: string): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from form_responses where form_id = ?')
    .bind(formId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** Every `sub_` object currently in the bucket. R2 is shared across this file,
 *  so tests compare sets rather than counts where it matters. */
async function bucketKeys(): Promise<Set<string>> {
  const listed = await env.MEDIA.list({ prefix: 'sub_', limit: 1000 })
  return new Set(listed.objects.map((o) => o.key))
}

/* ---------------------------------------------------------- storing them --- */

describe('an upload lands under a minted key, and the visitor never chooses it', () => {
  it('stores the object, the metadata and nothing the submitter named', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV])
    const before = await bucketKeys()

    const res = await submit(
      form.id,
      { email: 'ada@example.com' },
      // A filename that is a path, in a form that would be a traversal anywhere
      // it were treated as one.
      [{ field: 'cv', filename: '../../../.env', bytes: PDF, type: 'application/pdf' }],
    )
    expect(res.status).toBe(200)

    const [files] = await filesOf(form.id)
    expect(files).toHaveLength(1)
    const file = files?.[0] as StoredFile
    expect(file.field).toBe('cv')
    expect(file.key).toMatch(/^sub_[0-9a-f]{12}-[a-z0-9.-]{1,80}$/)
    expect(file.key).not.toContain('/')
    expect(file.key).not.toContain('..')
    expect(file.filename).toBe('.env')
    expect(file.size).toBe(PDF.byteLength)
    expect(file.contentType).toBe('application/pdf')

    // And the bytes are actually there, under exactly that key.
    const object = await env.MEDIA.get(file.key)
    expect(object).not.toBeNull()
    expect(await object?.text()).toBe(new TextDecoder().decode(PDF))
    expect([...(await bucketKeys())].filter((k) => !before.has(k))).toEqual([file.key])

    // An upload is not an answer: the bytes are the object and the metadata is
    // the `files` column, so `data` holds only what was typed.
    const row = await env.DB.prepare('select data from form_responses where form_id = ?')
      .bind(form.id)
      .first<{ data: string }>()
    expect(JSON.parse(row?.data ?? '{}')).toEqual({ email: 'ada@example.com' })
  })

  it('drops a part under a name the form does not declare', async () => {
    const form = await makeForm('Text only', [EMAIL_FIELD])
    const before = await bucketKeys()

    const res = await submit(form.id, { email: 'ada@example.com' }, [
      { field: 'payload', filename: 'x.pdf', bytes: PDF },
    ])
    expect(res.status).toBe(200)

    // The loop walks the form's questions, not the request's parts, so a
    // stranger cannot make the server buffer an attachment for a field that
    // does not exist (decision 13).
    expect((await filesOf(form.id))[0]).toEqual([])
    expect(await bucketKeys()).toEqual(before)
  })

  it('treats the empty part a browser sends for an untouched input as no file', async () => {
    const form = await makeForm('Optional CV', [EMAIL_FIELD, CV])
    const res = await submit(form.id, { email: 'ada@example.com' }, [
      { field: 'cv', filename: '', bytes: new Uint8Array(0) },
    ])
    // Storing it would put an empty object in the bucket for every visitor who
    // left the input alone; refusing it would make every optional file question
    // effectively required.
    expect(res.status).toBe(200)
    expect((await filesOf(form.id))[0]).toEqual([])
  })
})

/* ------------------------------------------------------------ the limits --- */

describe('the caps, and both are enforced before anything is stored', () => {
  it('refuses a file over the question’s own maxBytes', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV])
    const before = await bucketKeys()

    const big = bytesOf('%PDF-1.7\n', new Array(8000).fill(0x41) as number[])
    const res = await submit(form.id, { email: 'ada@example.com' }, [
      { field: 'cv', filename: 'cv.pdf', bytes: big },
    ])

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ status: 'invalid', fields: { cv: 'too_long' } })
    // Nothing written, and that is the point of checking the size before the
    // put rather than after it.
    expect(await rowCount(form.id)).toBe(0)
    expect(await bucketKeys()).toEqual(before)
  })

  it('says too_long rather than required when a required question’s file was oversized', async () => {
    const form = await makeForm('Apply', [{ ...CV, required: true }])
    const big = bytesOf('%PDF-1.7\n', new Array(8000).fill(0x41) as number[])
    const res = await submit(form.id, {}, [{ field: 'cv', filename: 'cv.pdf', bytes: big }])
    // The file's own refusal wins: "you did not attach one" is not true, and it
    // is the answer a visitor cannot act on.
    expect(await res.json()).toMatchObject({ fields: { cv: 'too_long' } })
  })

  it('caps the whole body at capFor, which is nowhere near MAX_UPLOAD_BYTES', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV])

    // An honest oversized client, refused on its declared length before a byte
    // is read. 20MB is what `readCappedBody`'s own default would have allowed;
    // this form budgets its one 4KB question plus the fixed allowance.
    const res = await SELF.fetch(`${ORIGIN}/folio/f/${form.id}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(2 * 1024 * 1024),
      },
      body: 'x'.repeat(64),
    })
    expect(res.status).toBe(413)
    const body = await res.json<{ error: { message: string } }>()
    // The number in the message is the form's own arithmetic, not the media
    // library's ceiling.
    const cap = Number(body.error.message.match(/(\d+) bytes/)?.[1])
    expect(cap).toBeGreaterThan(4096)
    expect(cap).toBeLessThan(20 * 1024 * 1024)
    expect(await rowCount(form.id)).toBe(0)
  })

  it('enforces a per-question cap that the body cap alone would let through', async () => {
    // Two 4KB questions is an 8KB-plus body budget, so a single 6KB file passes
    // the request cap and must still be refused by its own question's.
    const form = await makeForm('Two files', [CV, { ...HEADSHOT, accept: 'documents' }])
    const before = await bucketKeys()
    const big = bytesOf('%PDF-1.7\n', new Array(6000).fill(0x41) as number[])

    const res = await submit(form.id, {}, [{ field: 'cv', filename: 'cv.pdf', bytes: big }])
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ fields: { cv: 'too_long' } })
    expect(await bucketKeys()).toEqual(before)
  })
})

/* ------------------------------------------------------------ the sniffs --- */

describe('accept is enforced against the bytes, never against the claim', () => {
  it('accepts an image whose header lies about it, and names it from its bytes', async () => {
    const form = await makeForm('Headshot', [HEADSHOT])
    const res = await submit(form.id, {}, [
      // The client says PDF; the bytes say PNG. The bytes decide, and the lie
      // changes nothing that matters.
      { field: 'photo', filename: 'me.pdf', bytes: PNG, type: 'application/pdf' },
    ])
    expect(res.status).toBe(200)
    expect((await filesOf(form.id))[0]?.[0]?.contentType).toBe('image/png')
  })

  it('refuses a document sent at an images question, however it is labelled', async () => {
    const form = await makeForm('Headshot', [HEADSHOT])
    const before = await bucketKeys()

    const res = await submit(form.id, {}, [
      { field: 'photo', filename: 'me.png', bytes: PDF, type: 'image/png' },
    ])
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ fields: { photo: 'invalid' } })
    expect(await bucketKeys()).toEqual(before)
  })

  it('refuses bytes nothing recognises, rather than storing them as a download', async () => {
    const form = await makeForm('Apply', [CV])
    const before = await bucketKeys()

    const res = await submit(form.id, {}, [
      { field: 'cv', filename: 'cv.pdf', bytes: EXE, type: 'application/pdf' },
    ])
    // `uploadAsset` stores an unrecognised upload as `application/octet-stream`,
    // because an editor uploading to their own library gets the benefit of the
    // doubt. An anonymous stranger does not.
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ fields: { cv: 'invalid' } })
    expect(await bucketKeys()).toEqual(before)
  })

  it('enforces required only once the upload half exists', async () => {
    const form = await makeForm('Apply', [{ ...CV, required: true }])

    const missing = await submit(form.id, {})
    expect(missing.status).toBe(422)
    expect(await missing.json()).toMatchObject({ fields: { cv: 'required' } })

    const attached = await submit(form.id, {}, [
      { field: 'cv', filename: 'cv.pdf', bytes: PDF, type: 'application/pdf' },
    ])
    expect(attached.status).toBe(200)
  })
})

/* ------------------------------------------------------- the duplicate --- */

describe('a double-click stores one row and one object', () => {
  it('writes nothing the second time, because body_hash covers the bytes', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV])
    const before = await bucketKeys()
    const attach = [
      { field: 'cv', filename: 'cv.pdf', bytes: PDF, type: 'application/pdf' },
    ] as const

    const first = await submit(form.id, { email: 'ada@example.com' }, attach)
    const second = await submit(form.id, { email: 'ada@example.com' }, attach)

    // Both answered success — from the visitor's side it worked twice.
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await rowCount(form.id)).toBe(1)

    // And exactly one object: hashing the bytes is what lets the duplicate check
    // run *before* the put, so a double-clicked 5MB CV is uploaded once.
    const added = [...(await bucketKeys())].filter((k) => !before.has(k))
    expect(added).toHaveLength(1)
  })

  it('stores both when the bytes differ, even with identical answers', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV])
    const before = await bucketKeys()

    await submit(form.id, { email: 'ada@example.com' }, [
      { field: 'cv', filename: 'cv.pdf', bytes: PDF, type: 'application/pdf' },
    ])
    await submit(form.id, { email: 'ada@example.com' }, [
      { field: 'cv', filename: 'cv.pdf', bytes: bytesOf('%PDF-1.7\nsecond draft'), type: '' },
    ])

    // A genuine second submission is a new row — the side to be wrong on, since
    // a lost duplicate is invisible and a lost submission is somebody who thinks
    // they contacted you.
    expect(await rowCount(form.id)).toBe(2)
    expect([...(await bucketKeys())].filter((k) => !before.has(k))).toHaveLength(2)
  })
})

/* --------------------------------------------------------- reading back --- */

describe('a form’s uploads are not assets', () => {
  it('is a 400 from the public asset route, before any handler runs', async () => {
    const form = await makeForm('Apply', [CV])
    await submit(form.id, {}, [
      { field: 'cv', filename: 'cv.pdf', bytes: PDF, type: 'application/pdf' },
    ])
    const key = (await filesOf(form.id))[0]?.[0]?.key as string

    const res = await SELF.fetch(`${ORIGIN}/folio/asset/${key}`)
    // `ASSET_KEY` is anchored to `^ast_[0-9a-f]{12}-…`, so this never reaches
    // `serveAsset` at all. There is no new guard, so there is no new guard to
    // forget — and the two routes are one path segment apart.
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('key')
  })

  it('downloads through the gated route as an attachment and nothing else', async () => {
    const form = await makeForm('Apply', [CV])
    await submit(form.id, {}, [
      // Bytes that are legitimately text, so a route willing to serve inline
      // would have something to serve inline.
      { field: 'cv', filename: 'notes.txt', bytes: bytesOf('<h1>hello</h1>'), type: 'text/html' },
    ])
    const rid = (
      await env.DB.prepare('select id from form_responses where form_id = ?')
        .bind(form.id)
        .first<{ id: string }>()
    )?.id as string

    const res = await SELF.fetch(`${API}/forms/${form.id}/responses/${rid}/file/cv`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>hello</h1>')

    // Always `octet-stream`, always `attachment`, however the bytes sniffed:
    // these came from a stranger and there is no case for rendering them in a
    // browser tab on this origin.
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="notes.txt"')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
  })

  it('404s a response id from another form, and an unknown question', async () => {
    const mine = await makeForm('Mine', [CV])
    const theirs = await makeForm('Theirs', [CV])
    await submit(mine.id, {}, [
      { field: 'cv', filename: 'cv.pdf', bytes: PDF, type: 'application/pdf' },
    ])
    const rid = (
      await env.DB.prepare('select id from form_responses where form_id = ?')
        .bind(mine.id)
        .first<{ id: string }>()
    )?.id as string

    // The form id is bound as well as the response id: a route that only checks
    // the id is a route whose access control is the id.
    const crossed = await SELF.fetch(`${API}/forms/${theirs.id}/responses/${rid}/file/cv`)
    expect(crossed.status).toBe(404)

    const wrongField = await SELF.fetch(`${API}/forms/${mine.id}/responses/${rid}/file/photo`)
    expect(wrongField.status).toBe(404)
  })

  it('refuses a path parameter that is not a minted id or a field slug', async () => {
    const form = await makeForm('Apply', [CV])
    for (const path of [
      `${API}/forms/${form.id}/responses/notanid/file/cv`,
      `${API}/forms/${form.id}/responses/res_zzzzzzzzzzzz/file/cv`,
      // A Folio-reserved name and a name outside the slug charset. `..` is not
      // in this list because a URL parser normalises it away long before the
      // router sees it — the traversal a key parameter would have to survive is
      // one this route cannot be handed in the first place.
      `${API}/forms/${form.id}/responses/res_aaaaaaaaaaaa/file/_folio_page`,
      `${API}/forms/${form.id}/responses/res_aaaaaaaaaaaa/file/CV`,
    ]) {
      expect((await SELF.fetch(path)).status, path).toBe(400)
    }
  })
})

/* -------------------------------------------------------------- deleting --- */

describe('deleting a form takes its objects with it', () => {
  it('removes every object across every response, then the rows', async () => {
    const form = await makeForm('Apply', [EMAIL_FIELD, CV])
    for (const who of ['ada', 'grace', 'katherine']) {
      const res = await submit(form.id, { email: `${who}@example.com` }, [
        { field: 'cv', filename: `${who}.pdf`, bytes: bytesOf(`%PDF-1.7\n${who}`), type: '' },
      ])
      expect(res.status).toBe(200)
    }
    const keys = (await filesOf(form.id)).flat().map((f) => f.key)
    expect(keys).toHaveLength(3)
    for (const key of keys) expect(await env.MEDIA.head(key)).not.toBeNull()

    const usage = await SELF.fetch(`${API}/forms/${form.id}/usage`)
    expect(await usage.json()).toMatchObject({ responses: 3, files: 3 })

    const deleted = await SELF.fetch(`${API}/forms/${form.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: true, responses: 3, files: 3 })

    // The walk runs *before* the batch, because the keys are only knowable from
    // the rows the batch is about to destroy. Without it every file ever
    // submitted stays in the bucket, invisibly and permanently.
    for (const key of keys) expect(await env.MEDIA.head(key), key).toBeNull()
    expect(await rowCount(form.id)).toBe(0)
  })

  it('walks past the first page, so a big form does not leave a tail behind', async () => {
    // `UPLOAD_WALK_PAGE` is 200; this is a scaled proof that the walk resumes at
    // all rather than reading one page and stopping — the failure that leaves
    // every response past the first page orphaned.
    const form = await makeForm('Apply', [CV])
    const rows: string[] = []
    for (let i = 0; i < 3; i++) {
      const key = `sub_${i}aaaaaaaaaaa-seed.pdf`
      await env.MEDIA.put(key, 'seed')
      rows.push(key)
      await env.DB.prepare(
        `insert into form_responses (id, form_id, version, created_at, data, body_hash, files)
         values (?, ?, 1, ?, '{}', ?, ?)`,
      )
        .bind(
          `res_${i}aaaaaaaaaaa`,
          form.id,
          Date.now(),
          `h${i}`,
          JSON.stringify([{ field: 'cv', key, filename: 'seed.pdf', size: 4, contentType: '' }]),
        )
        .run()
    }

    await SELF.fetch(`${API}/forms/${form.id}`, { method: 'DELETE' })
    for (const key of rows) expect(await env.MEDIA.head(key), key).toBeNull()
  })

  it('leaves a text-only form’s delete exactly as it was', async () => {
    const form = await makeForm('Contact', [EMAIL_FIELD])
    await submit(form.id, { email: 'ada@example.com' })
    const res = await SELF.fetch(`${API}/forms/${form.id}`, { method: 'DELETE' })
    expect(await res.json()).toEqual({ deleted: true, responses: 1, files: 0 })
  })
})

/* --------------------------------------------------- the missing binding --- */

const page = defineBlock({
  name: 'page',
  label: 'Page',
  fields: { title: text() },
  render: () => null,
})

/** A host with D1 and a story namespace and **no `media`**, which is a supported
 *  configuration: the media library is read-only there and a form may not take
 *  files at all. */
function noMediaHost(): Folio<Cloudflare.Env> {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    root: 'page',
    bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY }),
    basePath: '/folio',
    assets: { admin: '/a.js', preview: '/p.js' },
    auth: 'open',
    route: (path) => (path ? `/${path}` : '/'),
  })
}

function call(folio: Folio<Cloudflare.Env>, path: string, init?: RequestInit) {
  return folio.handle(new Request(`${ORIGIN}${path}`, init), env, createExecutionContext())
}

describe('a file question needs the media binding, and says so', () => {
  it('refuses to save one, naming the binding', async () => {
    const folio = noMediaHost()
    const created = await call(folio, '/folio/api/forms', {
      method: 'POST',
      body: JSON.stringify({ label: 'Apply' }),
    })
    const form = await created?.json<Form>()

    const saved = await call(folio, `/folio/api/forms/${form?.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedUpdatedAt: form?.updatedAt, fields: [CV] }),
    })
    // `unsupported`, the legible refusal `FolioBindings` already gives for
    // `media`, `images` and `browser`: "this deployment is not configured for
    // that" is a different fact from "you may not".
    expect(saved?.status).toBe(501)
    expect(await saved?.text()).toContain('media bucket')

    // …and a form with no file question still saves.
    const fine = await call(folio, `/folio/api/forms/${form?.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedUpdatedAt: form?.updatedAt, fields: [EMAIL_FIELD] }),
    })
    expect(fine?.status).toBe(200)
  })

  it('refuses the submission too, before the body is read', async () => {
    // The form is built on the host that *has* the bucket, then posted to on the
    // one that does not — a host that lost the binding after the form existed.
    const form = await makeForm('Apply', [CV])
    const res = await call(noMediaHost(), `/folio/f/${form.id}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'multipart/form-data; boundary=x' },
      body: 'x'.repeat(64),
    })
    expect(res?.status).toBe(501)
    expect(await res?.json()).toMatchObject({ status: 'error', error: { code: 'unsupported' } })
    expect(await rowCount(form.id)).toBe(0)
  })
})
