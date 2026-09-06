// Exercises content-model/forms.md end to end against a live dev server: an
// editor builds a form in the admin API, drops it on a page, and a stranger with
// no session and no JavaScript fills it in — then the answers come back through
// the admin, out as a CSV, and finally go with the form.
//
// The loop this covers is the one nothing else can: `pnpm test` runs against
// workerd with `auth: 'open'` and a hand-built request, so the two things it
// cannot see are a *real* anonymous browser POST reaching a *real* published
// page's markup, and the descriptor that markup was drawn from being compiled by
// `resolve()` on the way out. Both are here.
//
// Library source is imported directly (the honeypot's name and the wire version,
// which have to be *derived* rather than guessed at or this script would assert
// its own copy of them). `./lib/ts-resolve.mjs` teaches Node to resolve the
// extensionless relative specifiers the library uses.
import './lib/ts-resolve.mjs'
import { signInGlobally } from './lib/auth.mjs'

// `realFetch` is the unwrapped one: `signInGlobally` makes every later `fetch`
// carry the admin's cookie the way a browser does, which is exactly wrong for
// the half of this script that is a stranger. Every anonymous request below goes
// through it, so "anonymous" is a property of the request rather than a comment.
const { realFetch } = await signInGlobally()

const { PROTOCOL_VERSION } = await import(new URL('../src/core/protocol.ts', import.meta.url))
const { honeypotName } = await import(new URL('../src/core/forms.ts', import.meta.url))

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const API = `${BASE}/api`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())
const post = (path, body) =>
  json(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const patch = (path, body) =>
  fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/**
 * A submission as a browser makes one: no session cookie, no `fetch`, a native
 * `<form>`'s encoding, and `accept: text/html` — which is what tells the route to
 * answer a 303 rather than JSON (decision 5). `redirect: 'manual'` so the 303
 * itself is what comes back.
 */
const submit = (formId, fields) =>
  realFetch(`${BASE}/f/${formId}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml',
    },
    body: new URLSearchParams(fields).toString(),
  })

/** The same route, asked for JSON — the negotiated alternative. */
const submitJson = (formId, body) =>
  realFetch(`${BASE}/f/${formId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })

/** A real WebSocket to a story's sync endpoint — the one path a mutation can
 *  arrive by. Mirrors `scripts/redirects-test.mjs`'s client. */
function client(storyId) {
  const ws = new WebSocket(`ws://localhost:5199/folio/api/story/${storyId}/socket`)
  const inbox = []
  const waiters = []
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    inbox.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) waiters.splice(i, 1)[0].resolve(msg)
    }
  })
  return {
    ws,
    async hello() {
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      this.send({
        type: 'hello',
        lastSyncId: 0,
        identity: { actor: 'e2e', name: 'e2e', colour: '#0090ff' },
      })
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    // Every frame carries the wire version, not only `hello` — the object refuses
    // any frame that omits it, and a refused frame looks like a hang.
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    async tx(txId, mutations) {
      this.send({ type: 'tx', txId, mutations })
      await this.expect((m) => m.type === 'delta' && m.txId === txId)
      await wait(120)
    },
    expect(match, ms = 4000) {
      const hit = inbox.find(match)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error('timeout waiting on socket message')), ms)
      })
    },
    close() {
      this.ws.close()
    },
  }
}

/* --- an editor builds a form -------------------------------------------- */

const created = await post('/forms', { label: 'E2E Contact' })
check(
  'creating a form mints an frm_ id and slugifies its label',
  /^frm_[0-9a-f]{12}$/.test(created.id) && created.name === 'e2e-contact',
  `${created.id} / ${created.name}`,
)
check('a new form starts at version 1 and open', created.version === 1 && created.open === true)

const QUESTIONS = [
  { name: 'name', kind: 'text', label: 'Your name', required: true, max: 80 },
  { name: 'email', kind: 'email', label: 'Email', required: true },
  {
    name: 'topic',
    kind: 'select',
    label: 'Topic',
    options: [
      { value: 'sales', label: 'Sales' },
      { value: 'support', label: 'Support' },
    ],
  },
  { name: 'message', kind: 'textarea', label: 'Message', required: true },
  // A declared hidden field: the host's own value, validated, stored and
  // exported like any other answer (decision 13).
  { name: 'campaign', kind: 'hidden', label: 'Campaign', value: 'spring' },
]

const built = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: created.updatedAt,
  fields: QUESTIONS,
  successMessage: 'Thanks — we will be in touch.',
  closedMessage: 'This form has closed.',
  submitLabel: 'Send it',
}).then((r) => r.json())
check(
  'adding questions is a structural save and bumps the version',
  built.version === 2 && built.fields.length === 5,
  `v${built.version}, ${built.fields.length} fields`,
)

const relabelled = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: built.updatedAt,
  label: 'E2E Contact form',
}).then((r) => r.json())
check(
  'a label edit changes no constraint, so it does not bump the version',
  relabelled.version === 2,
  `v${relabelled.version}`,
)

const stale = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: built.updatedAt,
  label: 'Whoever saved second',
})
check(
  'a save carrying a stale expectedUpdatedAt is refused with 409, not merged',
  stale.status === 409,
  `status=${stale.status}`,
)

const form = relabelled

/* --- an editor drops it on a page --------------------------------------- */

const story = await post('/stories', { title: 'Forms E2E Contact' })
const conn = client(story.id)
const doc = await conn.hello()
await conn.tx('form1', [
  {
    t: 'insert',
    blok: {
      uid: 'formblok1',
      type: 'contactForm',
      parent: doc.root,
      slot: 'body',
      order: 'a0',
      // The whole of the embed: a form's **id**, never its slug — the action is
      // baked into HTML cached for a week, so renaming a form must not break it.
      data: { heading: 'Contact us', form: form.id },
    },
  },
])
conn.close()
await post(`/story/${story.id}/publish`, {})

const pageUrl = `${HTTP}/${story.path}`
const html = await realFetch(pageUrl).then((r) => r.text())
const decoy = honeypotName(
  form.id,
  QUESTIONS.map((q) => q.name),
)

check(
  'the published page carries an action naming the form id',
  html.includes(`action="/folio/f/${form.id}"`),
  html.match(/action="[^"]*"/)?.[0] ?? 'no action',
)
const hiddens = (markup) => (markup.match(/<input type="hidden"[^>]*>/g) ?? []).join(' ')
check(
  'it carries `_folio_page`, the path this render was served at, for the 303 to come back to',
  html.includes(`name="_folio_page" value="/${story.path}"`),
  hiddens(html),
)

// The second of Folio's two reserved inputs, and it appears only on a localised
// render: the source locale is stored as `''`, so there is nothing to stamp.
const french = await realFetch(`${HTTP}/fr/${story.path}`).then((r) => r.text())
check(
  'a localised render stamps `_folio_locale` as well, so the row records which language it was filled in in',
  french.includes('name="_folio_locale" value="fr"') &&
    french.includes(`name="_folio_page" value="/fr/${story.path}"`),
  hiddens(french),
)
check(
  'the honeypot is there under the name the route will look for, and looks like an ordinary input',
  html.includes(`name="${decoy}"`) && !decoy.startsWith('_'),
  decoy,
)
check(
  'every question is drawn from the descriptor, including the declared hidden one',
  html.includes('name="email"') &&
    html.includes('name="message"') &&
    html.includes('name="campaign"') &&
    html.includes('Send it'),
)
check(
  'the page ships no JavaScript: the transport is a native POST',
  !html.includes('<script'),
  html.match(/<script[^>]*>/)?.[0] ?? '',
)

/* --- a stranger fills it in --------------------------------------------- */

const ANSWER = {
  _folio_page: `/${story.path}`,
  _folio_locale: 'en',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  topic: 'sales',
  message: 'Hello from the e2e script.',
  campaign: 'spring',
  // What a real browser adds and Folio has never heard of: the submit button's
  // own name. Dropped silently rather than refused (decision 13).
  submit: 'Send it',
}

const sent = await submit(form.id, ANSWER)
const landed = new URL(sent.headers.get('location') ?? '', HTTP)
check(
  'a native submission answers 303 back to the page it came from',
  sent.status === 303 && landed.pathname === `/${story.path}`,
  `status=${sent.status} location=${sent.headers.get('location')}`,
)
check(
  'the redirect names the status and the form slug, and nothing personal',
  landed.searchParams.get('folio_status') === 'ok' &&
    landed.searchParams.get('folio_form') === form.name &&
    !landed.search.includes('ada@example.com'),
  landed.search,
)

const thanks = await realFetch(landed.toString()).then((r) => r.text())
check(
  "the host renders the descriptor's own successMessage from folio_status alone",
  thanks.includes('Thanks — we will be in touch.'),
)

const filled = await submit(form.id, { ...ANSWER, [decoy]: 'https://spam.example' })
check(
  'a submission that fills the honeypot is answered exactly like a real one',
  filled.status === 303 &&
    new URL(filled.headers.get('location'), HTTP).searchParams.get('folio_status') === 'ok',
  `status=${filled.status}`,
)

const short = await submit(form.id, { ...ANSWER, email: '', message: '' })
const refused = new URL(short.headers.get('location') ?? '', HTTP)
check(
  'a missing required answer comes back as folio_status=invalid, naming the fields and not their values',
  refused.searchParams.get('folio_status') === 'invalid' &&
    (refused.searchParams.get('folio_invalid') ?? '').split(',').sort().join(',') ===
      'email,message',
  refused.search,
)

const again = await submit(form.id, ANSWER)
check(
  'an identical submission a moment later still reads as success to whoever made it',
  again.status === 303 &&
    new URL(again.headers.get('location'), HTTP).searchParams.get('folio_status') === 'ok',
)

const asJson = await submitJson(form.id, {
  ...ANSWER,
  // A cell a spreadsheet would happily execute, on its way to the CSV below.
  name: '=1+1',
  message: 'The negotiated transport.',
})
const jsonBody = await asJson.json()
check(
  'the JSON transport answers 200 and a response id',
  asJson.status === 200 && jsonBody.ok === true && /^res_[0-9a-f]{12}$/.test(jsonBody.id ?? ''),
  `status=${asJson.status} ${JSON.stringify(jsonBody)}`,
)

/* --- and a publisher reads them back ------------------------------------- */

const anon = await realFetch(`${API}/forms/${form.id}/responses`)
check(
  'the responses are not public: an anonymous read is refused',
  anon.status === 401 || anon.status === 403,
  `status=${anon.status}`,
)

const page = await json(`${API}/forms/${form.id}/responses?count=1`)
check(
  'the honeypot, the invalid one and the duplicate stored nothing: two rows for five submissions',
  page.total === 2 && page.rows.length === 2,
  `total=${page.total} rows=${page.rows.length}`,
)
check(
  'the oldest row is reported, which is what makes manual retention visible',
  typeof page.oldest === 'number',
  String(page.oldest),
)

const newest = page.rows[0]
check(
  'the newest row is first, and it is the JSON one',
  newest.data.message === 'The negotiated transport.',
  newest.data.message,
)
check(
  'a declared hidden field is stored as an answer and an undeclared key is not',
  newest.data.campaign === 'spring' && !('submit' in newest.data),
  Object.keys(newest.data).join(','),
)
check(
  'the row carries the page it was submitted from, and the version it answered',
  page.rows[1].page === `/${story.path}` && newest.version === 2,
  `${page.rows[1].page} v${newest.version}`,
)
check(
  'no reader ever answers the ip hash or the body hash',
  !('ipHash' in newest) && !('bodyHash' in newest),
  Object.keys(newest).join(','),
)

const one = await json(`${API}/forms/${form.id}/responses/${newest.id}`)
check('one response reads back by id', one.id === newest.id)

/* --- the export ---------------------------------------------------------- */

const exported = await realFetch(`${API}/forms/${form.id}/responses.csv`)
check(
  'the CSV export is not public either',
  exported.status === 401 || exported.status === 403,
  `status=${exported.status}`,
)

const csvRes = await fetch(`${API}/forms/${form.id}/responses.csv`)
// The bytes, not `.text()`: decoding **strips** the BOM, so a test that only
// reads the string passes whether or not the export writes one.
const csvBytes = new Uint8Array(await csvRes.arrayBuffer())
const csv = new TextDecoder().decode(csvBytes)
const [header, ...lines] = csv.trim().split('\r\n')
check(
  'it answers a file, not JSON',
  csvRes.headers.get('content-type')?.startsWith('text/csv') &&
    (csvRes.headers.get('content-disposition') ?? '').startsWith('attachment;'),
  `${csvRes.headers.get('content-type')} / ${csvRes.headers.get('content-disposition')}`,
)
check(
  'it leads with a BOM, which is what makes Excel on Windows read it as UTF-8',
  csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
  [...csvBytes.slice(0, 3)].map((b) => b.toString(16)).join(' '),
)
check(
  "the header is the five metadata columns in Folio's own namespace, then the answers in the form's order",
  header === '_submitted_at,_response_id,_version,_locale,_page,name,email,topic,message,campaign',
  header,
)
check(
  'a cell a spreadsheet would execute is prefixed with an apostrophe',
  lines.some((line) => line.includes(",'=1+1,")),
  lines.find((line) => line.includes('=1+1')) ?? 'no such row',
)
check('every stored response is a row', lines.length === 2, `${lines.length} rows`)

/* --- a file question, which is the only public write path in Folio -------- */

const jobs = await post('/forms', { label: 'E2E Application' })
const withFile = await patch(`/forms/${jobs.id}`, {
  expectedUpdatedAt: jobs.updatedAt,
  fields: [
    { name: 'applicant', kind: 'text', label: 'Name', required: true },
    {
      name: 'cv',
      kind: 'file',
      label: 'CV',
      accept: 'documents',
      required: true,
      maxBytes: 200000,
    },
  ],
}).then((r) => r.json())
check(
  'a file question is accepted when a media bucket is bound',
  withFile.fields.some((f) => f.kind === 'file'),
)

const attach = async (bytes, filename, type) => {
  const body = new FormData()
  body.set('applicant', 'Ada Lovelace')
  body.set('cv', new Blob([bytes], { type }), filename)
  return realFetch(`${BASE}/f/${jobs.id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { accept: 'text/html' },
    body,
  })
}

// Bytes, not a string: a PNG signature run through UTF-8 stops being one, and
// this check is about what the sniffer sees rather than what the part claimed.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const wrongType = await attach(PNG, 'screenshot.png', 'image/png')
check(
  'a documents-only question refuses an image, whatever the part claimed',
  new URL(wrongType.headers.get('location'), HTTP).searchParams.get('folio_invalid') === 'cv',
  wrongType.headers.get('location'),
)

const uploaded = await attach('%PDF-1.4\n% e2e\ntrailer\n%%EOF\n', 'cv.pdf', 'application/pdf')
check(
  'a multipart submission with a real PDF is accepted',
  new URL(uploaded.headers.get('location'), HTTP).searchParams.get('folio_status') === 'ok',
  uploaded.headers.get('location'),
)

const applications = await json(`${API}/forms/${jobs.id}/responses`)
const application = applications.rows[0]
const file = application?.files?.[0]
check(
  'the row names the object, under the sub_ prefix and never as an asset',
  file && /^sub_[0-9a-f]{12}-cv\.pdf$/.test(file.key) && file.field === 'cv',
  file ? file.key : 'no file',
)

const publicly = await realFetch(`${BASE}/asset/${file.key}`)
check(
  'the public asset route physically cannot serve it: ASSET_KEY is anchored to ast_',
  publicly.status === 400,
  `status=${publicly.status}`,
)

const downloadUrl = `${API}/forms/${jobs.id}/responses/${application.id}/file/cv`
const strangerTries = await realFetch(downloadUrl)
check(
  "a stranger cannot read a stranger's CV",
  strangerTries.status === 401 || strangerTries.status === 403,
  `status=${strangerTries.status}`,
)

const download = await fetch(downloadUrl)
const downloaded = await download.text()
check(
  'a publisher downloads it as an attachment, never inline, whatever the bytes sniffed as',
  download.status === 200 &&
    download.headers.get('content-type') === 'application/octet-stream' &&
    (download.headers.get('content-disposition') ?? '').includes('attachment') &&
    downloaded.startsWith('%PDF-'),
  `${download.status} ${download.headers.get('content-type')}`,
)

/* --- closing, and deleting ----------------------------------------------- */

const closed = await patch(`/forms/${form.id}`, {
  expectedUpdatedAt: (await json(`${API}/forms/${form.id}`)).updatedAt,
  open: false,
}).then((r) => r.json())
check('closing a form is one switch', closed.open === false)

const afterClose = await submit(form.id, ANSWER)
check(
  'a closed form refuses at the route, not only in the markup',
  new URL(afterClose.headers.get('location'), HTTP).searchParams.get('folio_status') === 'closed',
  afterClose.headers.get('location'),
)
const closedPage = await realFetch(pageUrl).then((r) => r.text())
check(
  'and the page now renders the closed message instead of the form',
  closedPage.includes('This form has closed.') && !closedPage.includes(`action="/folio/f/`),
)

const usage = await json(`${API}/forms/${form.id}/usage`)
check(
  'usage names both counts the delete dialog warns with: the pages that render it, and the responses',
  usage.total === 1 && usage.published[0]?.path === story.path && usage.responses === 2,
  `${usage.total} page(s), ${usage.responses} response(s), ${usage.files} file(s)`,
)

const removedOne = await fetch(`${API}/forms/${jobs.id}/responses/delete`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ selection: { ids: [application.id] } }),
}).then((r) => r.json())
check(
  'a bulk delete over a ticked selection removes the row',
  removedOne.done === 1 && removedOne.total === 1 && removedOne.continueFrom === null,
  JSON.stringify(removedOne),
)
const goneFile = await fetch(downloadUrl)
check(
  'and the object behind it goes with it, rather than being paid for forever',
  goneFile.status === 404,
  `status=${goneFile.status}`,
)

const deleted = await fetch(`${API}/forms/${form.id}`, { method: 'DELETE' }).then((r) => r.json())
check(
  'deleting a form says what it destroyed',
  deleted.deleted === true && deleted.responses === 2,
  JSON.stringify(deleted),
)
const lookedUp = await fetch(`${API}/forms/${form.id}`)
check('the form is gone', lookedUp.status === 404, `status=${lookedUp.status}`)

const orphaned = await realFetch(pageUrl).then((r) => r.text())
check(
  'a page embedding a form that has since been deleted renders nothing where it was, rather than failing',
  !orphaned.includes('/folio/f/') && !orphaned.includes('This form has closed.'),
)

await fetch(`${API}/forms/${jobs.id}`, { method: 'DELETE' })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
