import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import { honeypotName } from '../../src/core/forms'
import { createFolio } from '../../src/server'
import { type FolioForms, ipHash, RATE_WINDOW_MS } from '../../src/server/form-responses'
import type { Form } from '../../src/server/forms'
import type { FolioHooks, SubmittedHookPayload } from '../../src/server/hooks'

/**
 * `POST {base}/f/:id` — **the one route in Folio an anonymous stranger on the
 * internet may write through** (`docs/specs/content-model/forms.md` phase 4).
 *
 * Everything here is a threat-model test rather than a feature test, because the
 * feature is two lines and the threat model is the rest of the file. Six
 * properties, each of which is silent when it breaks:
 *
 *  - **The honeypot is indistinguishable from success.** A refusal, a different
 *    status, a missing id or a measurably different shape all tell whoever wrote
 *    the bot which input to leave alone next time (decision 9).
 *  - **`verify` fails closed, including when it throws.** Failing open converts a
 *    vendor outage from "the form is briefly unavailable" into "the form is
 *    briefly unprotected", and the second is the state somebody is waiting for
 *    (decision 11).
 *  - **The rate limit spans the hour boundary.** One bucket makes "ten an hour"
 *    into "ten a wall-clock hour", which resets at the top of it (decision 10).
 *  - **Nothing personal reaches a URL.** A redirect target is a cache key, a
 *    `Referer`, a history entry and a log line at once (decision 6).
 *  - **Only declared questions are stored**, and no submitted key can land
 *    anywhere but inside `data` (decision 13).
 *  - **A closed form is refused at the route**, not only in the markup a cached
 *    page is still serving (decision 14).
 *
 * D1 state is isolated per *file*, so every test resets the two tables it uses.
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
const SOURCE_FIELD = { name: 'source', kind: 'hidden', label: 'Source', value: '' }

interface ResponseRow {
  id: string
  form_id: string
  version: number
  created_at: number
  data: string
  locale: string
  page: string
  ip_hash: string | null
  body_hash: string
  files: string
}

/** A form through the admin routes, so every test starts from what an editor
 *  would have built. */
async function makeForm(
  label: string,
  fields: unknown[] = [NAME_FIELD, EMAIL_FIELD],
  over: Record<string, unknown> = {},
): Promise<Form> {
  const created = await SELF.fetch(`${API}/forms`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  })
  const form = await created.json<Form>()
  const saved = await SELF.fetch(`${API}/forms/${form.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ expectedUpdatedAt: form.updatedAt, fields, ...over }),
  })
  expect(saved.status).toBe(200)
  return saved.json<Form>()
}

function encode(values: Record<string, string | string[]>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    for (const one of Array.isArray(value) ? value : [value]) params.append(key, one)
  }
  return params
}

/** A native browser POST: urlencoded, `accept: text/html`, redirects unfollowed. */
function submit(
  id: string,
  values: Record<string, string | string[]>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/folio/f/${id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml',
      ...headers,
    },
    body: encode(values).toString(),
  })
}

/** The same route, negotiated the other way (decision 5). */
function submitJson(id: string, values: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/folio/f/${id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  })
}

function locationOf(res: Response): URL {
  const location = res.headers.get('location')
  expect(location, 'a native POST answers a redirect').toBeTruthy()
  return new URL(location as string)
}

async function rows(formId?: string): Promise<ResponseRow[]> {
  const { results } = formId
    ? await env.DB.prepare('select * from form_responses where form_id = ?')
        .bind(formId)
        .all<ResponseRow>()
    : await env.DB.prepare('select * from form_responses').all<ResponseRow>()
  return results
}

/* ------------------------------------------------------- the happy paths --- */

describe('a native POST, the transport a page with no JavaScript has', () => {
  it('stores the typed answers and lands back on the page it came from', async () => {
    const form = await makeForm('Contact us')
    const res = await submit(form.id, {
      full_name: 'Ada Lovelace',
      email: 'ada@example.com',
      _folio_page: '/about/contact',
    })

    // 303, so the follow-up is a GET whatever the browser would have done and a
    // refresh on the thank-you page does not re-post.
    expect(res.status).toBe(303)
    const url = locationOf(res)
    expect(url.pathname).toBe('/about/contact')
    expect(url.searchParams.get('folio_status')).toBe('ok')
    expect(url.searchParams.get('folio_form')).toBe('contact-us')

    const [row] = await rows(form.id)
    expect(JSON.parse(row?.data ?? '{}')).toEqual({
      full_name: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    // Server-authoritative, never what the page claimed: a cached page submits
    // against the live form (decision 7).
    expect(row?.version).toBe(form.version)
    // Host-supplied rather than sniffed from `Referer`, which is stripped or
    // forged often enough to be a lie.
    expect(row?.page).toBe('/about/contact')
    // Single-locale site: `''`, the convention `content_index` already uses.
    expect(row?.locale).toBe('')
    expect(row?.files).toBe('[]')
  })

  it('sends a successful submission to redirectTo, and a refused one back to the page', async () => {
    const form = await makeForm('Redirected', [EMAIL_FIELD], { redirectTo: '/thanks' })

    const ok = await submit(form.id, { email: 'ada@example.com', _folio_page: '/contact' })
    expect(locationOf(ok).pathname).toBe('/thanks')

    // Never for a refusal: sending somebody to a thank-you page for a message
    // that was not accepted is worse than saying nothing.
    const bad = await submit(form.id, { email: 'not-an-address', _folio_page: '/contact' })
    const url = locationOf(bad)
    expect(url.pathname).toBe('/contact')
    expect(url.searchParams.get('folio_status')).toBe('invalid')
  })

  it('falls back to the Referer, and refuses one from another origin', async () => {
    const form = await makeForm('Referred', [EMAIL_FIELD])

    const same = await submit(
      form.id,
      { email: 'ada@example.com' },
      { referer: `${ORIGIN}/enquire?x=1` },
    )
    expect(locationOf(same).pathname).toBe('/enquire')
    // `Referer` decides only where a browser lands; `_folio_page` is what gets
    // stored, and it was not sent.
    expect((await rows(form.id))[0]?.page).toBe('')

    // An open redirect out of a form endpoint would be the most-scanned URL on
    // the site.
    const cross = await submit(
      form.id,
      { email: 'grace@example.com' },
      { referer: 'https://evil.example/x' },
    )
    expect(locationOf(cross).origin).toBe(ORIGIN)
    expect(locationOf(cross).pathname).toBe('/')
  })

  it('answers JSON to a caller that asked for it, from the same route', async () => {
    const form = await makeForm('Negotiated')

    const ok = await submitJson(form.id, { full_name: 'Ada', email: 'ada@example.com' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, status: 'ok', id: expect.stringMatching(/^res_/) })

    const bad = await submitJson(form.id, { full_name: 'Ada' })
    expect(bad.status).toBe(422)
    // The field names and why, so a script can point at the input — and, in the
    // native transport, only the *names* ever travel.
    expect(await bad.json()).toEqual({
      error: { code: 'invalid', message: expect.any(String) },
      status: 'invalid',
      fields: { email: 'required' },
    })
    // Only the first one landed: a refusal writes nothing.
    expect(await rows(form.id)).toHaveLength(1)
  })
})

/* -------------------------------------------------------- what is stored --- */

describe('what a submission may and may not write', () => {
  it('drops every undeclared key, keeps a declared hidden one, and never forges metadata', async () => {
    const form = await makeForm('Strict', [NAME_FIELD, EMAIL_FIELD, SOURCE_FIELD])
    const decoy = honeypotName(form.id, ['full_name', 'email', 'source'])

    const res = await submit(form.id, {
      full_name: 'Ada',
      email: 'ada@example.com',
      source: 'newsletter',
      // Everything a real browser POST carries beyond the questions.
      submit: 'Send',
      _folio_page: '/contact',
      [decoy]: '',
      utm_medium: 'email',
      // …and a deliberate attempt to write the row's own columns.
      version: '99',
      form_id: 'frm_ffffffffffff',
      created_at: '0',
      ip_hash: 'mine',
      locale: 'fr',
      // …and Folio's own locale input, naming a locale this site does not have.
      _folio_locale: 'fr-CA',
    })
    expect(res.status).toBe(303)

    const [row] = await rows(form.id)
    expect(JSON.parse(row?.data ?? '{}')).toEqual({
      full_name: 'Ada',
      email: 'ada@example.com',
      source: 'newsletter',
    })
    // Every one of these is Folio's to decide. A submitted key lands inside
    // `data` or nowhere, and `data` holds declared names only (decision 13).
    expect(row?.version).toBe(form.version)
    expect(row?.form_id).toBe(form.id)
    expect(row?.created_at).toBeGreaterThan(0)
    // `''` rather than `fr-CA`: the hidden input is run back through the
    // runtime's own locale resolution, so an undeclared code — or one a submitter
    // invented — is stored as the source-locale convention rather than as itself.
    expect(row?.locale).toBe('')
    expect(row?.ip_hash).toBeNull()
    expect(row?.page).toBe('/contact')
  })

  it('never lets a submitted value reach the redirect, whatever happened', async () => {
    const form = await makeForm('Private', [NAME_FIELD, EMAIL_FIELD])
    const allowed = new Set(['folio_status', 'folio_form', 'folio_invalid'])

    const good = await submit(form.id, {
      full_name: 'Ada Lovelace',
      email: 'ada@example.com',
      _folio_page: '/contact',
    })
    const bad = await submit(form.id, {
      full_name: 'Ada Lovelace',
      email: 'nope',
      _folio_page: '/contact',
    })

    for (const res of [good, bad]) {
      const url = locationOf(res)
      expect([...url.searchParams.keys()].every((k) => allowed.has(k))).toBe(true)
      // A URL is a cache key, a Referer, a history entry and a log line at once.
      expect(url.toString()).not.toContain('ada@example.com')
      expect(url.toString()).not.toContain('Lovelace')
      expect(url.toString()).not.toContain('res_')
    }
    // The names, never the values.
    expect(locationOf(bad).searchParams.get('folio_invalid')).toBe('email')
  })

  it('refuses a body bigger than the form could possibly hold', async () => {
    const form = await makeForm('Bounded', [{ name: 'note', kind: 'text', label: 'Note', max: 20 }])
    const res = await SELF.fetch(`${ORIGIN}/folio/f/${form.id}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `note=${'x'.repeat(200_000)}`,
    })
    // The cap is derived from the questions the editor built, so a one-question
    // form is tens of kilobytes rather than the media library's twenty megabytes.
    expect(res.status).toBe(413)
    expect(await rows(form.id)).toHaveLength(0)
  })

  it('refuses an id that is not a Folio form id before anything reads the database', async () => {
    const res = await submit('not-a-form-id', { email: 'ada@example.com' })
    expect(res.status).toBe(400)
  })

  it('answers a page cached past the form’s own life without a stack trace', async () => {
    const res = await submit('frm_ffffffffffff', { email: 'ada@example.com' })
    expect(res.status).toBe(303)
    expect(locationOf(res).searchParams.get('folio_status')).toBe('error')

    const json = await submitJson('frm_ffffffffffff', { email: 'ada@example.com' })
    expect(json.status).toBe(404)
  })
})

/* ---------------------------------------------------------- the controls --- */

describe('the honeypot', () => {
  it('looks exactly like success and stores nothing', async () => {
    const form = await makeForm('Trapped')
    const decoy = honeypotName(form.id, ['full_name', 'email'])
    // The decoy is a plausible-looking name from a fixed pool, not `_hp`: a
    // reserved-looking name is one a competent bot skips.
    expect(decoy).not.toMatch(/^_/)

    const real = await submit(form.id, {
      full_name: 'Ada',
      email: 'ada@example.com',
      _folio_page: '/contact',
    })
    const caught = await submit(form.id, {
      full_name: 'Ada',
      email: 'ada@example.com',
      _folio_page: '/contact',
      [decoy]: 'http://spam.example',
    })

    // Byte-identical answers, because anything else tells the bot which input to
    // leave alone next time.
    expect(caught.status).toBe(real.status)
    expect(locationOf(caught).toString()).toBe(locationOf(real).toString())

    // …and a JSON caller gets an id that looks exactly like a stored one.
    const json = await submitJson(form.id, {
      email: 'grace@example.com',
      [decoy]: 'http://spam.example',
    })
    expect(json.status).toBe(200)
    expect(await json.json<{ id: string }>()).toEqual({
      ok: true,
      status: 'ok',
      id: expect.stringMatching(/^res_[0-9a-f]{12}$/),
    })

    // One row: the genuine one.
    expect(await rows(form.id)).toHaveLength(1)
  })
})

describe('the duplicate collapse', () => {
  it('stores one row for a double-click and answers success both times', async () => {
    const form = await makeForm('Twice')
    const body = { full_name: 'Ada', email: 'ada@example.com', _folio_page: '/contact' }

    const first = await submit(form.id, body)
    const second = await submit(form.id, body)

    // From the visitor's side it worked, twice.
    expect(locationOf(first).searchParams.get('folio_status')).toBe('ok')
    expect(locationOf(second).searchParams.get('folio_status')).toBe('ok')
    expect(await rows(form.id)).toHaveLength(1)

    // A genuinely different answer a moment later is a new row, which is the
    // right side to be wrong on: a lost duplicate is invisible and a lost
    // genuine submission is somebody who thinks they contacted you.
    await submit(form.id, { ...body, full_name: 'Grace' })
    expect(await rows(form.id)).toHaveLength(2)
  })
})

describe('the rate limit', () => {
  const IP = '203.0.113.9'

  /** A response already in the table, under a hash from `at`'s hour. */
  async function seedFrom(form: Form, at: number, createdAt: number, n: number): Promise<void> {
    const hash = await ipHash(IP, form.id, at)
    for (let i = 0; i < n; i++) {
      await env.DB.prepare(
        `insert into form_responses (id, form_id, version, created_at, data, body_hash, ip_hash)
         values (?, ?, 1, ?, '{}', ?, ?)`,
      )
        .bind(`res_seed${String(i).padStart(7, '0')}`, form.id, createdAt, `seed-${i}`, hash)
        .run()
    }
  }

  it('counts the previous hour’s bucket too, so it does not reset at the top of the hour', async () => {
    const form = await makeForm('Throttled', [EMAIL_FIELD])
    const now = Date.now()

    // Ten submissions three minutes ago — which, if the clock has just crossed
    // an hour boundary, are stored under the *previous* bucket's hash.
    await seedFrom(form, now - RATE_WINDOW_MS, now - 3 * 60_000, 10)

    const refused = await submit(form.id, { email: 'ada@example.com' }, { 'cf-connecting-ip': IP })
    // Distinct from `invalid`, so a host can say something true about it rather
    // than telling a genuine visitor behind a shared NAT that their message was
    // malformed.
    expect(locationOf(refused).searchParams.get('folio_status')).toBe('rate')
    expect(await rows(form.id)).toHaveLength(10)

    // And a different address is unaffected: the limit is per hash, and the hash
    // carries the address.
    const other = await submit(
      form.id,
      { email: 'grace@example.com' },
      { 'cf-connecting-ip': '198.51.100.4' },
    )
    expect(locationOf(other).searchParams.get('folio_status')).toBe('ok')
  })

  it('lets the same address through once its rows have aged out of the window', async () => {
    const form = await makeForm('Aged', [EMAIL_FIELD])
    const now = Date.now()
    // Two hours ago: a different bucket *and* outside the rolling window.
    await seedFrom(form, now - 2 * RATE_WINDOW_MS, now - 2 * RATE_WINDOW_MS, 20)

    const res = await submit(form.id, { email: 'ada@example.com' }, { 'cf-connecting-ip': IP })
    expect(locationOf(res).searchParams.get('folio_status')).toBe('ok')
  })

  it('stores the hash and never the address, and stores nothing at all without one', async () => {
    const form = await makeForm('Hashed', [EMAIL_FIELD])

    await submit(form.id, { email: 'ada@example.com' }, { 'cf-connecting-ip': IP })
    const [withIp] = await rows(form.id)
    expect(withIp?.ip_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(withIp?.ip_hash).not.toContain('203')

    await submit(form.id, { email: 'grace@example.com' })
    const none = (await rows(form.id)).find((r) => r.id !== withIp?.id)
    // A local `wrangler dev` has no client address; the row sits outside the
    // partial index and no limit can ever match it.
    expect(none?.ip_hash).toBeNull()
  })
})

describe('a closed form', () => {
  it('is refused at the route, however recently the markup was cached', async () => {
    const form = await makeForm('Closed', [EMAIL_FIELD], { open: false })
    const res = await submit(form.id, { email: 'ada@example.com', _folio_page: '/contact' })
    expect(locationOf(res).searchParams.get('folio_status')).toBe('closed')
    expect(await rows(form.id)).toHaveLength(0)

    // The clock's half of the same answer: still switched on, and past its
    // closing time (decision 14).
    const lapsed = await makeForm('Lapsed', [EMAIL_FIELD], { closesAt: Date.now() - 1000 })
    const late = await submit(lapsed.id, { email: 'ada@example.com' })
    expect(locationOf(late).searchParams.get('folio_status')).toBe('closed')
    expect(await rows(lapsed.id)).toHaveLength(0)

    const json = await submitJson(lapsed.id, { email: 'ada@example.com' })
    expect(json.status).toBe(409)
    expect(await json.json()).toMatchObject({ status: 'closed' })
  })
})

/* ------------------------------------------------- the host's own halves --- */

const hostPage = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title', required: true }) },
  render: () => null,
})

function folioWith(config: {
  hooks?: FolioHooks<Cloudflare.Env>
  forms?: FolioForms<Cloudflare.Env>
}) {
  return createFolio<Cloudflare.Env>({
    blocks: [hostPage],
    root: 'page',
    bindings: (e) => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: '/folio',
    auth: 'open',
    ...config,
  })
}

async function through(
  folio: ReturnType<typeof folioWith>,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await folio.handle(new Request(`${ORIGIN}${path}`, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res as Response
}

function nativePost(values: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
    },
    body: encode(values).toString(),
  }
}

describe('verify', () => {
  it('refuses when it answers false, and refuses when it throws', async () => {
    const form = await makeForm('Verified', [EMAIL_FIELD])

    const refusing = folioWith({ forms: { verify: () => false } })
    const no = await through(refusing, `/folio/f/${form.id}`, nativePost({ email: 'a@b.co' }))
    expect(new URL(no.headers.get('location') as string).searchParams.get('folio_status')).toBe(
      'verify',
    )

    // A captcha that opens on error is decorative: the first thing an attacker
    // does is make it error (decision 11).
    const throwing = folioWith({
      forms: {
        verify: () => {
          throw new Error('vendor is down')
        },
      },
    })
    const boom = await through(throwing, `/folio/f/${form.id}`, nativePost({ email: 'a@b.co' }))
    expect(new URL(boom.headers.get('location') as string).searchParams.get('folio_status')).toBe(
      'verify',
    )

    expect(await rows(form.id)).toHaveLength(0)
  })

  it('receives the raw body, including the key no question declares', async () => {
    const form = await makeForm('Widgeted', [EMAIL_FIELD])
    const seen: Record<string, string>[] = []
    const folio = folioWith({
      forms: {
        verify: ({ body, form: meta }) => {
          seen.push({ ...body, __form: meta.name })
          // The token's name belongs to the host's widget and Folio does not know
          // it, which is the whole reason this runs before undeclared keys are
          // dropped (decision 13).
          return body['cf-turnstile-response'] === 'good'
        },
      },
    })

    const ok = await through(
      folio,
      `/folio/f/${form.id}`,
      nativePost({ email: 'a@b.co', 'cf-turnstile-response': 'good' }),
    )
    expect(new URL(ok.headers.get('location') as string).searchParams.get('folio_status')).toBe(
      'ok',
    )
    expect(seen[0]?.['cf-turnstile-response']).toBe('good')
    expect(seen[0]?.__form).toBe('widgeted')
    expect(await rows(form.id)).toHaveLength(1)
  })
})

describe('the submitted hook', () => {
  it('fires once for a stored row, with the answers and no actor', async () => {
    const form = await makeForm('Hooked', [NAME_FIELD, EMAIL_FIELD])
    const calls: SubmittedHookPayload<Cloudflare.Env>[] = []
    const folio = folioWith({
      hooks: { submitted: (e) => calls.push(e), await: ['submitted'] },
    })

    await through(
      folio,
      `/folio/f/${form.id}`,
      nativePost({ full_name: 'Ada', email: 'ada@example.com', _folio_page: '/contact' }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.form).toEqual({
      id: form.id,
      name: 'hooked',
      label: 'Hooked',
      version: form.version,
    })
    expect(calls[0]?.response.data).toEqual({ full_name: 'Ada', email: 'ada@example.com' })
    expect(calls[0]?.response.page).toBe('/contact')
    expect(calls[0]?.files).toEqual([])
    // The route is unauthenticated and the row is a stranger's: naming an editor
    // here would be a lie about who filled the form in.
    expect(calls[0]?.actor).toBeNull()

    // A projection, not the row. The one quasi-identifier in the table and the
    // fingerprint of the answers have no business in a Slack message.
    expect(Object.keys(calls[0]?.response ?? {}).sort()).toEqual([
      'createdAt',
      'data',
      'formId',
      'id',
      'locale',
      'page',
      'version',
    ])
  })

  it('does not fire for a honeypot or for a duplicate', async () => {
    const form = await makeForm('Quiet', [EMAIL_FIELD])
    const decoy = honeypotName(form.id, ['email'])
    const calls: SubmittedHookPayload<Cloudflare.Env>[] = []
    const folio = folioWith({
      hooks: { submitted: (e) => calls.push(e), await: ['submitted'] },
    })

    await through(folio, `/folio/f/${form.id}`, nativePost({ email: 'a@b.co', [decoy]: 'caught' }))
    expect(calls).toHaveLength(0)

    await through(folio, `/folio/f/${form.id}`, nativePost({ email: 'a@b.co' }))
    // The second click of a double-click collapsed into the first, and a row that
    // reached a CRM twice is exactly what the collapse exists to prevent.
    await through(folio, `/folio/f/${form.id}`, nativePost({ email: 'a@b.co' }))
    expect(calls).toHaveLength(1)
    expect(await rows(form.id)).toHaveLength(1)
  })
})
