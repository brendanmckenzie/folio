// Exercises the richer field types end to end against a live dev server.
//
// The load-bearing check is `rename updates every link to that page`: story
// links store an id, so a path change has to reach the rendered href without
// anything rewriting the document.

// Library source is imported directly. ./lib/ts-resolve.mjs teaches Node to
// resolve the extensionless relative specifiers the library uses, so a module
// with real value imports (richtext.ts → values.ts) loads like any other.
import './lib/ts-resolve.mjs'

// The demo now configures a real sign-in provider (identity-and-access.md), so
// every route here needs a session. This signs in as the seeded admin and makes
// this process's `fetch` and `WebSocket` carry the cookie, exactly as a browser
// does — see scripts/lib/auth.mjs.
import { signInGlobally } from './lib/auth.mjs'

await signInGlobally()

const { diff } = await import(new URL('../packages/folio/src/core/diff.ts', import.meta.url))
const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const API = `${BASE}/api`
const STORY = 'sty_home'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())
const preview = () => fetch(`${HTTP}/?_folio=preview`).then((r) => r.text())

/** Two single-block documents differing only in one blok's data. */
const docWith = (data) => ({
  root: 'r',
  bloks: {
    r: { uid: 'r', type: 'page', parent: null, slot: null, order: 'a0', data: {} },
    x: { uid: 'x', type: 'button', parent: 'r', slot: 'body', order: 'a0', data },
  },
})
const diffOf = (before, after) => diff(docWith(before), docWith(after))

/**
 * A sync client for one story. `storyId` defaults to the home page, which is
 * what almost every check here drives; document-types.md's checks need a second
 * and a third document (a person record, an insight), so it is a parameter
 * rather than the hard-coded constant it used to be.
 */
function client(name, storyId = STORY) {
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
      ws.send(
        JSON.stringify({
          type: 'hello',
          lastSyncId: 0,
          identity: { actor: name, name, colour: '#0090ff' },
          v: PROTOCOL_VERSION,
        }),
      )
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    // Every frame carries the wire version, not only `hello` — the object
    // refuses any frame that omits it (test/workers/story-do.test.ts).
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    /** Send a transaction and wait for the Durable Object to echo it back. */
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
        setTimeout(() => reject(new Error(`timeout waiting on ${name}`)), ms)
      })
    },
  }
}

await fetch(`${HTTP}/?_folio=preview`)

const ed = client('fields')
const doc0 = await ed.hello()
const root = doc0.root

// Durable Object state outlives a D1 reseed, so start from a known-empty page.
const leftovers = Object.values(doc0.bloks).filter((b) => b.parent === root)
if (leftovers.length) {
  await ed.tx(
    'f0',
    leftovers.map((b) => ({ t: 'remove', uid: b.uid })),
  )
}

/* --- a CTA with four buttons, one per link kind -------------------------- */

// Two CTAs rather than one: the demo's cta caps its actions slot at two buttons
// (examples/demo/src/blocks/cta.tsx), and a transaction is all-or-nothing, so
// four buttons in one slot rejects the whole tx — including the valid cta insert.
const CTA = 'ctalink1'
const CTA2 = 'ctalink2'
const btn = (uid, parent, order, href) => ({
  t: 'insert',
  blok: {
    uid,
    type: 'button',
    parent,
    slot: 'actions',
    order,
    data: { label: uid, href, variant: 'primary' },
  },
})
const cta = (uid, order, heading) => ({
  t: 'insert',
  blok: {
    uid,
    type: 'cta',
    parent: root,
    slot: 'body',
    order,
    data: { heading, body: '' },
  },
})

await ed.tx('f1', [
  cta(CTA, 'a0', 'Links'),
  cta(CTA2, 'a1', 'More links'),
  btn('lstory', CTA, 'a0', { kind: 'story', id: 'sty_about' }),
  btn('lurl', CTA, 'a1', { kind: 'url', url: 'https://example.com', target: '_blank' }),
  btn('lmail', CTA2, 'a0', { kind: 'email', email: 'hi@example.com', subject: 'A & B' }),
  btn('lanch', CTA2, 'a1', { kind: 'anchor', anchor: 'section-two' }),
])

const html1 = await preview()
const hrefOf = (uid, doc) =>
  doc.match(new RegExp(`<a[^>]*>${uid}</a>`))?.[0]?.match(/href="([^"]*)"/)?.[1] ?? null

check(
  'story link resolves to the current path',
  hrefOf('lstory', html1) === '/about',
  hrefOf('lstory', html1),
)
check('external url passes through', hrefOf('lurl', html1) === 'https://example.com')
check(
  'email becomes a mailto with an encoded subject',
  hrefOf('lmail', html1) === 'mailto:hi@example.com?subject=A%20%26%20B',
  hrefOf('lmail', html1),
)
check('in-page anchor resolves to a fragment', hrefOf('lanch', html1) === '#section-two')

const tagOf = (uid, doc) => doc.match(new RegExp(`<a[^>]*>${uid}</a>`))?.[0] ?? ''
const urlTag = tagOf('lurl', html1)
check(
  'new-window link gets noopener without the block asking',
  urlTag.includes('target="_blank"') && urlTag.includes('rel="noopener noreferrer"'),
  urlTag,
)
check(
  'a same-window link is not given a rel',
  !tagOf('lmail', html1).includes('rel='),
  tagOf('lmail', html1),
)

/* --- THE invariant: rename the target, links follow -------------------- */

const docBefore = (await client('probe-a').hello()).bloks

await json(`${API}/stories/sty_about`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ slug: 'partners' }),
})

const html2 = await preview()
check(
  'rename updates every link to that page',
  hrefOf('lstory', html2) === '/partners',
  hrefOf('lstory', html2),
)

const docAfter = (await client('probe-b').hello()).bloks
check(
  'the document itself was not rewritten by the rename',
  JSON.stringify(docBefore.lstory.data.href) === JSON.stringify(docAfter.lstory.data.href),
  JSON.stringify(docAfter.lstory.data.href),
)
check(
  'the stored link still holds an id, not a path',
  docAfter.lstory.data.href.kind === 'story' && docAfter.lstory.data.href.id === 'sty_about',
)

// Renaming a branch cascades to descendants, so a link to the child follows too.
const tree = await json(`${API}/stories`)
const team = tree.flatMap((n) => n.children).find((c) => c.id === 'sty_team')
check('descendant paths cascade on rename', team?.path === 'partners/team', team?.path)

await json(`${API}/stories/sty_about`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ slug: 'about' }),
})
check('rename back restores the href', hrefOf('lstory', await preview()) === '/about')

/* --- a deleted target is reported, not silently dropped ----------------- */

await ed.tx('f2', [
  { t: 'set', uid: 'lstory', field: 'href', value: { kind: 'story', id: 'sty_gone' } },
])
const html3 = await preview()
check(
  'a link to a missing story is flagged broken',
  /<a[^>]*data-broken="true"[^>]*>lstory<\/a>/.test(html3),
)

await ed.tx('f3', [
  { t: 'set', uid: 'lstory', field: 'href', value: { kind: 'story', id: 'sty_about' } },
])

/* --- publish resolves too, and still ships no JS ------------------------ */

const pub = await json(`${API}/story/${STORY}/publish`, { method: 'POST' })
check('publish ok', pub.ok === true)
const live = await fetch(`${HTTP}/`).then((r) => r.text())
check(
  'published page resolves story links',
  hrefOf('lstory', live) === '/about',
  hrefOf('lstory', live),
)
check('published page still ships no JS', !live.includes('<script'))

/* --- assets: upload, render, focal point, legacy values ----------------- */

// A real 64x48 PNG, so the test needs nothing on disk and the resize path has
// something it can work with. A 1x1 placeholder is no good: the image pipeline
// declines to transform it and returns an empty body, so the test proves nothing.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAQ0lEQVR42u3PQQkAAAgEsItjCPtj' +
      'LCv4FQYrsEzXaxEQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQuFoOKBDTXECg5QAA' +
      'AABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

const uploadOne = async (filename) => {
  const res = await fetch(`${API}/assets?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: PNG,
  })
  return res.json()
}

const one = await uploadOne('probe-one.png')
check('upload returns a library row and a field value', Boolean(one.asset?.id && one.value?.key))
check(
  'dimensions are read from the file header',
  one.asset?.width === 64 && one.asset?.height === 48,
  `${one.asset?.width}x${one.asset?.height}`,
)
check(
  'the R2 key keeps the filename',
  String(one.asset?.key).endsWith('-probe-one.png'),
  one.asset?.key,
)

const two = await uploadOne('probe-two.png')

const served = await fetch(`${HTTP}${'/folio/asset/'}${one.asset.key}`)
check(
  'asset serves from R2',
  served.status === 200 && served.headers.get('content-type') === 'image/png',
)
check(
  'asset is cached immutably',
  (served.headers.get('cache-control') ?? '').includes('immutable'),
  served.headers.get('cache-control'),
)
const resized = await fetch(`${HTTP}/folio/asset/${one.asset.key}?w=32&f=webp`)
const resizedBytes = new Uint8Array(await resized.arrayBuffer())
check(
  'a transform returns real webp bytes',
  resized.headers.get('content-type') === 'image/webp' &&
    // RIFF....WEBP, so an empty or mislabelled body cannot pass.
    String.fromCharCode(...resizedBytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...resizedBytes.subarray(8, 12)) === 'WEBP',
  `${resized.headers.get('content-type')} ${resizedBytes.byteLength}B`,
)
check(
  'a resize actually shrinks the file',
  resizedBytes.byteLength > 0 && resizedBytes.byteLength < one.asset.size,
  `${resizedBytes.byteLength} < ${one.asset.size}`,
)
// Two different refusals, deliberately: a key that cannot be an asset key is
// rejected by validation before any lookup (400), while a well-formed key that
// simply is not there is a miss (404). `nope` exercises the former only.
check(
  'a malformed asset key is refused by validation',
  (await fetch(`${HTTP}/folio/asset/nope`)).status === 400,
)
check(
  'a well-formed but unknown key is a 404',
  (await fetch(`${HTTP}/folio/asset/ast_000000000000-missing.png`)).status === 404,
)

await ed.tx('f4', [
  {
    t: 'insert',
    blok: {
      uid: 'img1',
      type: 'image',
      parent: root,
      slot: 'body',
      order: 'b0',
      data: {
        file: { ...one.value, alt: 'A described image', focal: { x: 0.25, y: 0.75 } },
        caption: 'Cap',
        ratio: 'wide',
      },
    },
  },
  {
    t: 'insert',
    blok: {
      uid: 'gal1',
      type: 'gallery',
      parent: root,
      slot: 'body',
      order: 'b1',
      data: { heading: 'Gal', images: [one.value, two.value] },
    },
  },
  // The URL string `asset()` used to store. Durable Object state outlives a
  // schema change, so old values have to keep rendering.
  {
    t: 'insert',
    blok: {
      uid: 'hero1',
      type: 'hero',
      parent: root,
      slot: 'body',
      order: 'b2',
      data: { heading: 'Legacy', image: 'https://cdn.example.com/legacy.jpg', align: 'left' },
    },
  },
])

const assetHtml = await preview()
// The renderer injects data-folio-uid, so the opening tag carries extra
// attributes after the class.
const figure =
  assetHtml.match(/<figure class="image image--wide"[^>]*>[\s\S]*?<\/figure>/)?.[0] ?? ''

check(
  'asset renders an img pointing at the asset route',
  figure.includes(`/folio/asset/${one.asset.key}`),
)
check(
  'alt text comes from the field, per usage',
  figure.includes('alt="A described image"'),
  figure.slice(0, 200),
)
check(
  'intrinsic width and height are emitted',
  /width="64"/.test(figure) && /height="48"/.test(figure),
)
check(
  'a focal point becomes object-position',
  /object-position:\s*25%\s+75%/.test(figure),
  figure.match(/style="[^"]*"/)?.[0],
)
check('srcset offers multiple widths', (figure.match(/\d+w/g) ?? []).length >= 3)
check('a cropping request carries the focal point', /fp=0\.25%2C0\.75|fp=0\.25,0\.75/.test(figure))

const galleryHtml = assetHtml.match(/<section class="gallery"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ''
check(
  'multiasset renders every image',
  (galleryHtml.match(/<img/g) ?? []).length === 2,
  String((galleryHtml.match(/<img/g) ?? []).length),
)

check(
  'a legacy asset stored as a plain URL still renders',
  assetHtml.includes('https://cdn.example.com/legacy.jpg'),
)

// Reordering a multiasset is one field write, not a per-item shuffle.
const reorder = diffOf({ images: [one.value, two.value] }, { images: [two.value, one.value] })
check('reordering a multiasset is a single set', reorder.length === 1 && reorder[0].t === 'set')

// `Page<AssetRow>` since foundation/pagination.md phase 4, with a filename search
// that is the whole reason asset 201 is reachable at all.
const libraryBefore = (await json(`${API}/assets?limit=200`)).rows
await fetch(`${API}/assets/${two.asset.id}`, { method: 'DELETE' })
const libraryAfter = (await json(`${API}/assets?limit=200`)).rows
check(
  'deleting removes the library row',
  libraryBefore.length - libraryAfter.length === 1 &&
    !libraryAfter.some((a) => a.id === two.asset.id),
)
const counted = await json(`${API}/assets?limit=1&count=1`)
check(
  'the library reports a total only when asked',
  counted.total === libraryAfter.length &&
    (await json(`${API}/assets?limit=1`)).total === undefined,
  `total=${counted.total} rows=${libraryAfter.length}`,
)
check(
  'deleting an asset leaves referencing documents alone',
  (await preview()).includes(two.value.key),
)

/* --- richtext ------------------------------------------------------------ */

const { sanitiseRichtext, richtextToText, asRichtext } = await import(
  new URL('../packages/folio/src/core/richtext.ts', import.meta.url)
)

const rt = (...content) => ({ type: 'doc', content })
const p = (...content) => ({ type: 'paragraph', content })
const t = (text, ...marks) => ({ type: 'text', text, ...(marks.length ? { marks } : {}) })

const BODY = rt(
  { type: 'heading', attrs: { level: 2 }, content: [t('A heading')] },
  p(t('Plain, '), t('bold', { type: 'bold' }), t(' and '), t('italic', { type: 'italic' })),
  p(t('An internal link', { type: 'link', attrs: { link: { kind: 'story', id: 'sty_about' } } })),
  {
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [p(t('one'))] },
      { type: 'listItem', content: [p(t('two'))] },
    ],
  },
  { type: 'blockquote', content: [p(t('Quoted'))] },
  { type: 'horizontalRule' },
)

await ed.tx('f5', [
  {
    t: 'insert',
    blok: {
      uid: 'rt1',
      type: 'prose',
      parent: root,
      slot: 'body',
      order: 'c0',
      data: { heading: 'Prose', body: BODY, width: 'narrow' },
    },
  },
  // A caption-style field: bold, italic and links only, nothing structural. The
  // stored value deliberately contains a heading and a strike mark it must reject.
  {
    t: 'insert',
    blok: {
      uid: 'pq1',
      type: 'pullquote',
      parent: root,
      slot: 'body',
      order: 'c1',
      data: {
        quote: rt(
          { type: 'heading', attrs: { level: 1 }, content: [t('Smuggled heading')] },
          p(t('kept '), t('struck', { type: 'strike' }), t(' text')),
        ),
        credit: 'Someone',
        tone: 'quiet',
      },
    },
  },
  // A prose block whose body is still the plain string the old textarea stored.
  {
    t: 'insert',
    blok: {
      uid: 'rt2',
      type: 'prose',
      parent: root,
      slot: 'body',
      order: 'c2',
      data: { heading: 'Legacy prose', body: 'First para.\n\nSecond para.', width: 'narrow' },
    },
  },
])

const rtHtml = await preview()
const bodyOf = (uid) =>
  rtHtml.match(
    new RegExp(`<section class="prose[^"]*" data-folio-uid="${uid}"[^>]*>[\\s\\S]*?</section>`),
  )?.[0] ?? ''
const proseHtml = bodyOf('rt1')

check('richtext renders headings', /<h2>A heading<\/h2>/.test(proseHtml))
check(
  'richtext renders marks',
  /<strong>bold<\/strong>/.test(proseHtml) && /<em>italic<\/em>/.test(proseHtml),
)
check(
  'richtext renders lists',
  /<ul><li><p>one<\/p><\/li><li><p>two<\/p><\/li><\/ul>/.test(proseHtml),
  proseHtml.match(/<ul>[\s\S]*?<\/ul>/)?.[0],
)
check(
  'richtext renders blockquotes and rules',
  /<blockquote>/.test(proseHtml) && /<hr\/?>/.test(proseHtml),
)
check(
  'a link inside richtext resolves to the story path',
  /<a href="\/about"[^>]*>An internal link<\/a>/.test(proseHtml),
  proseHtml.match(/<a [^>]*>An internal link<\/a>/)?.[0],
)
check(
  'richtext emits no stray wrapper elements around text',
  !/<span>Plain, <\/span>/.test(proseHtml),
  proseHtml.match(/<p>Plain[\s\S]{0,80}/)?.[0],
)

const pqHtml = rtHtml.match(/<figure class="pullquote"[^>]*>[\s\S]*?<\/figure>/)?.[0] ?? ''
check(
  'a constrained field drops a disallowed node',
  !/Smuggled heading<\/h1>/.test(pqHtml) && !/<h1>/.test(pqHtml),
)
check(
  'unwrapping a node rehouses its text in a paragraph',
  pqHtml.includes('<p>Smuggled heading</p>'),
  pqHtml,
)
check(
  'a constrained field drops a disallowed mark',
  !/<s>struck<\/s>/.test(pqHtml) && pqHtml.includes('struck'),
)
check(
  'text runs left adjacent by a dropped mark are merged',
  pqHtml.includes('<p>kept struck text</p>'),
  pqHtml.match(/<p>kept[\s\S]{0,60}/)?.[0],
)

check(
  'legacy plain-text richtext still renders',
  bodyOf('rt2').includes('<p>First para.</p>'),
  bodyOf('rt2'),
)
check('legacy plain text splits on blank lines', bodyOf('rt2').includes('<p>Second para.</p>'))

// The sanitiser is the second line of defence; the editor schema is the first.
check(
  'sanitise snaps a heading to the nearest permitted level',
  sanitiseRichtext(rt({ type: 'heading', attrs: { level: 5 }, content: [t('x')] }), {
    nodes: ['heading'],
    headingLevels: [2, 3],
  }).content[0].attrs.level === 3,
)
check(
  'sanitise implies listItem when a list is permitted',
  sanitiseRichtext(
    rt({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('x'))] }] }),
    { nodes: ['bulletList', 'paragraph'] },
  ).content[0].content[0].type === 'listItem',
)
check(
  'richtextToText flattens for excerpts',
  richtextToText(BODY).startsWith('A heading Plain, bold and italic'),
  richtextToText(BODY).slice(0, 60),
)
check('asRichtext rejects a non-doc object', asRichtext({ type: 'paragraph' }) === null)
check('asRichtext treats an empty doc as null', asRichtext({ type: 'doc', content: [] }) === null)

/* --- a link inside richtext follows a rename too ------------------------ */

await json(`${API}/stories/sty_about`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ slug: 'colleagues' }),
})
check(
  'a link inside richtext follows a rename',
  /<a href="\/colleagues"[^>]*>An internal link<\/a>/.test(await preview()),
  (await preview()).match(/<a [^>]*>An internal link<\/a>/)?.[0],
)
const storedRt = (await client('probe-mark').hello()).bloks.rt1.data.body
const linkMark = JSON.stringify(storedRt).match(/"link":\{[^}]*\}/)?.[0]
check(
  'the richtext link mark still stores an id, not a path',
  linkMark?.includes('sty_about') && !linkMark.includes('colleagues'),
  linkMark,
)
await json(`${API}/stories/sty_about`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ slug: 'about' }),
})

/* --- richtext survives versioning -------------------------------------- */

const rtCheckpoint = await json(`${API}/story/${STORY}/versions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'with richtext', actor: 'fields' }),
})
await ed.tx('f6', [{ t: 'set', uid: 'rt1', field: 'body', value: rt(p(t('Replaced'))) }])
check('richtext edit reached the preview', (await preview()).includes('Replaced'))

const { doc: snapshot } = await json(`${API}/versions/${rtCheckpoint.id}`)
const liveDoc = await client('probe-rt').hello()
const restoreMutations = diff(liveDoc, snapshot)
check(
  'restoring a richtext tree is a single set',
  restoreMutations.length === 1 &&
    restoreMutations[0].t === 'set' &&
    restoreMutations[0].field === 'body',
  JSON.stringify(restoreMutations.map((m) => `${m.t}:${m.field ?? ''}`)),
)
await ed.tx('f7', restoreMutations)
check('the richtext tree restored intact', (await preview()).includes('<h2>A heading</h2>'))

/* --- reference: resolve another story's content at render ---------------- */

// Give the About page some content of its own to be pulled in.
const about = client('about')
const aboutDoc = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:5199/folio/api/story/sty_about/socket`)
  const inbox = []
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    inbox.push(msg)
    if (msg.type === 'bootstrap') resolve({ ws, doc: msg.doc })
  })
  ws.addEventListener('open', () =>
    ws.send(
      JSON.stringify({
        type: 'hello',
        lastSyncId: 0,
        identity: { actor: 'about', name: 'about', colour: '#000' },
        v: PROTOCOL_VERSION,
      }),
    ),
  )
})
about.ws.close()

const aboutRoot = aboutDoc.doc.root
const send = (ws, txId, mutations) =>
  new Promise((resolve) => {
    const onMsg = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'delta' && msg.txId === txId) {
        ws.removeEventListener('message', onMsg)
        setTimeout(resolve, 140)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ type: 'tx', txId, mutations, v: PROTOCOL_VERSION }))
  })

// Published and draft copies are given different text on purpose, so which one a
// given surface resolved is unambiguous. Ordering matters: publish first, then
// move the draft on, so the two genuinely differ regardless of how previous runs
// left things.
await send(aboutDoc.ws, 'a1', [
  { t: 'set', uid: aboutRoot, field: 'description', value: 'What we are about.' },
  {
    t: 'insert',
    blok: {
      uid: 'abtxt',
      type: 'prose',
      parent: aboutRoot,
      slot: 'body',
      order: 'a0',
      data: { heading: 'About us', body: rt(p(t('PUBLISHED-COPY.'))), width: 'narrow' },
    },
  },
])
await fetch(`${API}/story/sty_about/publish`, { method: 'POST' })
await send(aboutDoc.ws, 'a2', [
  { t: 'set', uid: 'abtxt', field: 'body', value: rt(p(t('DRAFT-ONLY-COPY.'))) },
])

await ed.tx('f8', [
  {
    t: 'insert',
    blok: {
      uid: 'emb1',
      type: 'embed',
      parent: root,
      slot: 'body',
      order: 'd0',
      data: { heading: 'Embedded', source: 'sty_about', mode: 'content' },
    },
  },
  {
    t: 'insert',
    blok: {
      uid: 'emb2',
      type: 'embed',
      parent: root,
      slot: 'body',
      order: 'd1',
      data: { heading: '', source: 'sty_about', mode: 'summary' },
    },
  },
])

const refHtml = await preview()
const embedOf = (uid) =>
  refHtml.match(
    new RegExp(
      `<section class="embed" data-folio-uid="${uid}"[^>]*>[\\s\\S]*?</section></section>`,
    ),
  )?.[0] ??
  refHtml.match(
    new RegExp(`<section class="embed" data-folio-uid="${uid}"[^>]*>[\\s\\S]*?</section>`),
  )?.[0] ??
  ''

check(
  'a reference inlines the referenced content in preview',
  embedOf('emb1').includes('DRAFT-ONLY-COPY.'),
  embedOf('emb1').slice(0, 240),
)
check(
  'preview resolves the referenced draft, not its published copy',
  refHtml.includes('DRAFT-ONLY-COPY.') && !refHtml.includes('PUBLISHED-COPY.'),
)
check(
  'a reference exposes the referenced root fields',
  embedOf('emb2').includes('What we are about.'),
  embedOf('emb2'),
)
check(
  'a reference falls back to the referenced title',
  embedOf('emb2').includes('>About<'),
  embedOf('emb2').match(/<h2[^>]*>[^<]*<\/h2>/)?.[0],
)
check(
  'referenced content carries no edit markers of its own',
  // The embed block itself is tagged; nothing inside it should be.
  !/data-folio-uid="abtxt"/.test(refHtml),
)

/* --- a self-reference must not render forever --------------------------- */

await ed.tx('f9', [{ t: 'set', uid: 'emb1', field: 'source', value: STORY }])
const selfRes = await fetch(`${HTTP}/?_folio=preview`)
const selfHtml = await selfRes.text()
check(
  'a story referencing itself still renders',
  selfRes.status === 200 && selfHtml.includes('<section'),
)
check(
  'a self-reference is bounded to one level',
  // The embed appears twice: once as itself, once inside the inlined copy. A
  // third would mean resolution recursed.
  (selfHtml.match(/class="embed"/g) ?? []).length <= 4,
  String((selfHtml.match(/class="embed"/g) ?? []).length),
)
await ed.tx('f10', [{ t: 'set', uid: 'emb1', field: 'source', value: 'sty_about' }])

/* --- published pages resolve published content ------------------------- */

const pub2 = await json(`${API}/story/${STORY}/publish`, { method: 'POST' })
check('publish with a reference succeeds', pub2.ok === true)
const liveRef = await fetch(`${HTTP}/`).then((r) => r.text())
check(
  'a live page inlines the referenced published copy',
  liveRef.includes('PUBLISHED-COPY.'),
  liveRef.match(/embed__content[\s\S]{0,120}/)?.[0],
)
check(
  'a live page does not leak the referenced draft',
  !liveRef.includes('DRAFT-ONLY-COPY.'),
  liveRef.includes('DRAFT-ONLY-COPY.') ? 'draft leaked' : '',
)
check('published page still ships no JS with references', !liveRef.includes('<script'))

// Republishing the referenced story moves the live page on, with no republish of
// the referencing page: resolution happens at render, not at publish.
await fetch(`${API}/story/sty_about/publish`, { method: 'POST' })
check(
  'republishing the reference updates the referencing page without republishing it',
  (await fetch(`${HTTP}/`).then((r) => r.text())).includes('DRAFT-ONLY-COPY.'),
)

// A story with nothing published at all must resolve to nothing on a live page:
// public pages never show another story's unpublished content.
const fresh = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Never published' }),
})
await ed.tx('f10b', [{ t: 'set', uid: 'emb1', field: 'source', value: fresh.id }])
await fetch(`${API}/story/${STORY}/publish`, { method: 'POST' })
const unpub = await fetch(`${HTTP}/`).then((r) => r.text())
check(
  'a live page with an unpublished reference renders the empty state',
  unpub.includes('embed--empty'),
  unpub.match(/<section class="embed[^"]*"/)?.[0],
)
check(
  'that same reference still resolves in preview, from the draft',
  (await preview()).includes('embed__content'),
)
await fetch(`${API}/stories/${fresh.id}`, { method: 'DELETE' })

await ed.tx('f11', [{ t: 'set', uid: 'emb1', field: 'source', value: 'sty_deleted' }])
const danglingRes = await fetch(`${HTTP}/?_folio=preview`)
const dangling = await danglingRes.text()
check(
  'a reference to a story that does not exist renders an empty state',
  danglingRes.status === 200 && dangling.includes('Nothing selected to embed.'),
  String(danglingRes.status),
)
await ed.tx('f12', [{ t: 'set', uid: 'emb1', field: 'source', value: 'sty_about' }])

aboutDoc.ws.close()

/* --- document types: a record has no URL, and type filtering bites ------ */
// docs/specs/foundation/document-types.md. The demo declares six types (see
// examples/demo/src/index.tsx): `page`, a second routable `insight`, two
// unrouted records — `person` and `office`, the latter with no renderer at all
// (content-model/data-documents.md) — and two singletons, `settings` and
// `header`, both globals (content-model/globals.md).

const schema = await json(`${API}/schema`)
check(
  'the manifest carries every declared document type',
  schema.types?.map((t) => `${t.name}:${t.kind}`).join(',') ===
    'page:page,insight:page,person:record,office:record,settings:singleton,header:singleton',
  schema.types?.map((t) => `${t.name}:${t.kind}`).join(','),
)
check(
  'the manifest carries the configured globals',
  schema.globals?.slice().sort().join(',') === 'header,settings',
  schema.globals?.join(','),
)
check(
  'the manifest keeps `root` as the default page type’s root block',
  schema.root === 'page',
  schema.root,
)
check(
  'a type-restricted reference field carries its `types` to the admin',
  JSON.stringify(schema.blocks?.find((b) => b.name === 'personCard')?.fields?.person?.types) ===
    '["person"]',
  JSON.stringify(schema.blocks?.find((b) => b.name === 'personCard')?.fields?.person?.types),
)

// A record: unrouted, so it takes no path and blocks no page.
const ada = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Ada Lovelace', type: 'person' }),
})
check(
  'a record is created outside the page tree, with no path and no parent',
  ada.type === 'person' && ada.path === null && ada.parentId === null,
  `${ada.type} ${JSON.stringify(ada.path)} ${JSON.stringify(ada.parentId)}`,
)
check(
  'a record has no URL for anything to navigate to',
  ada.url === undefined && ada.previewUrl === undefined,
  `${ada.url} ${ada.previewUrl}`,
)

const treeIds = (nodes) => nodes.flatMap((n) => [n.id, ...treeIds(n.children)])
check(
  'a record is absent from GET /folio/api/stories',
  !treeIds(await json(`${API}/stories`)).includes(ada.id),
)
const docs = await json(`${API}/documents?type=person`)
check(
  'a record is present in GET /folio/api/documents?type=person',
  docs.documents?.some((d) => d.id === ada.id),
  JSON.stringify(docs.documents?.map((d) => d.id)),
)

// A page may still take the slug a record already uses: different namespaces.
const adaPage = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Ada Lovelace' }),
})
check(
  'a page can take the slug a record already uses — no collision at all',
  adaPage.slug === 'ada-lovelace' && adaPage.path === 'ada-lovelace',
  `${adaPage.slug} ${adaPage.path}`,
)
check(
  'the record still 404s at that path: the page owns it',
  (await fetch(`${HTTP}/ada-lovelace`)).status === 404,
)

// Fill the record in, then point a type-restricted reference at it.
const adaConn = client('ada', ada.id)
const adaDoc = await adaConn.hello()
check(
  'a record is seeded from its own root block, not the page root',
  adaDoc.bloks[adaDoc.root].type === 'personRecord',
  adaDoc.bloks[adaDoc.root].type,
)
check(
  'the title lands in the type’s own titleField, since personRecord has no `title`',
  adaDoc.bloks[adaDoc.root].data.fullName === 'Ada Lovelace' &&
    adaDoc.bloks[adaDoc.root].data.title === undefined,
  JSON.stringify(adaDoc.bloks[adaDoc.root].data.fullName),
)
await adaConn.tx('dt1', [{ t: 'set', uid: adaDoc.root, field: 'role', value: 'Mathematician' }])
adaConn.ws.close()

await ed.tx('dt2', [
  {
    t: 'insert',
    blok: {
      uid: 'pcard1',
      type: 'personCard',
      parent: root,
      slot: 'body',
      order: 'a5',
      data: { person: ada.id },
    },
  },
])

const withPerson = await preview()
check(
  'a reference to a record resolves, rendering the record’s own markup',
  withPerson.includes('person__name') && withPerson.includes('Mathematician'),
  withPerson.match(/<figcaption[\s\S]{0,120}/)?.[0],
)

// THE type-filter invariant: a value an importer could have written, pointing at
// the wrong kind of document, must resolve to nothing rather than render
// something strange (architecture decision 5).
await ed.tx('dt3', [{ t: 'set', uid: 'pcard1', field: 'person', value: 'sty_about' }])
const wrongType = await preview()
check(
  'a reference pointing at the wrong document type resolves to nothing',
  wrongType.includes('card--empty') && !wrongType.includes('person__name'),
  wrongType.match(/<section class="card[^"]*"/)?.[0],
)
await ed.tx('dt4', [{ t: 'set', uid: 'pcard1', field: 'person', value: ada.id }])

// A link to a record comes back broken: there is no URL to emit.
await ed.tx('dt5', [btn('lrecord', CTA2, 'a2', { kind: 'story', id: ada.id })])
const withRecordLink = await preview()
check(
  'a multilink pointing at an unrouted document resolves broken, not to a path',
  tagOf('lrecord', withRecordLink).includes('data-broken="true"') &&
    hrefOf('lrecord', withRecordLink) === '#',
  tagOf('lrecord', withRecordLink),
)

// A second routable page type: routed from the tree, `under` enforced.
const looseInsight = await fetch(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Loose insight', type: 'insight' }),
})
check(
  '`under` refuses an insight at the top level, with a notice naming the parent',
  looseInsight.status === 400 &&
    (await looseInsight.clone().json()).error.message.includes('only allowed under: page'),
  `${looseInsight.status} ${(await looseInsight.json()).error?.message}`,
)

const landing = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Insights' }),
})
const insight = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Hello world', type: 'insight', parentId: landing.id }),
})
check(
  'a second page type routes from the tree with no rule to configure',
  insight.path === 'insights/hello-world',
  insight.path,
)

const insightConn = client('insight', insight.id)
const insightDoc = await insightConn.hello()
check(
  'an insight is seeded from insightPage, not from the page root',
  insightDoc.bloks[insightDoc.root].type === 'insightPage',
  insightDoc.bloks[insightDoc.root].type,
)
await insightConn.tx('dt6', [
  { t: 'set', uid: insightDoc.root, field: 'standfirst', value: 'A standfirst' },
  { t: 'set', uid: insightDoc.root, field: 'author', value: ada.id },
])
insightConn.ws.close()

await fetch(`${API}/story/${insight.id}/publish`, { method: 'POST' })
const insightHtml = await fetch(`${HTTP}/insights/hello-world`).then((r) => r.text())
check(
  'the insight serves at its derived path once published',
  insightHtml.includes('insight__title') && insightHtml.includes('A standfirst'),
  insightHtml.match(/<h1 class="insight__title">[^<]*/)?.[0],
)
// A live page resolves *published* references, so an author record that has
// never been published resolves to nothing — the same rule the embed checks
// above prove for a page, now shown to hold for a record too.
check(
  'a live page does not leak an unpublished record’s fields',
  !insightHtml.includes('insight__author'),
  insightHtml.match(/<p class="insight__author">[^<]*/)?.[0] ?? 'absent',
)

await fetch(`${API}/story/${ada.id}/publish`, { method: 'POST' })
const insightHtml2 = await fetch(`${HTTP}/insights/hello-world`).then((r) => r.text())
check(
  'once the record is published, the author reference reads its own fields',
  insightHtml2.includes('Ada Lovelace') && insightHtml2.includes('Mathematician'),
  insightHtml2.match(/<p class="insight__author">[^<]*/)?.[0],
)

// The singleton: created by asking, refusing to be deleted or duplicated.
const settings = await json(`${API}/documents?type=settings`)
check(
  'a singleton is created on first access, under a derived id',
  settings.documents?.length === 1 && settings.documents[0].id === 'sng_settings',
  JSON.stringify(settings.documents?.map((d) => d.id)),
)
check(
  'asking again returns the same one, never a second',
  (await json(`${API}/documents?type=settings`)).documents?.length === 1,
)
check(
  'a singleton refuses to be deleted',
  (await fetch(`${API}/stories/sng_settings`, { method: 'DELETE' })).status === 409,
)
check(
  'a singleton refuses to be duplicated',
  (await fetch(`${API}/stories/sng_settings/duplicate`, { method: 'POST' })).status === 409,
)
check(
  'creating a second singleton is refused outright',
  (
    await fetch(`${API}/stories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Another', type: 'settings' }),
    })
  ).status === 409,
)

// Refusals that keep a document on the side of the fence it was created on.
check(
  'moving a record into the page tree is refused',
  (
    await fetch(`${API}/stories/${ada.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: landing.id }),
    })
  ).status === 400,
)
check(
  'changing a document’s type is refused: that is a schema migration',
  (
    await fetch(`${API}/stories/${insight.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'page' }),
    })
  ).status === 409,
)
check(
  'an undeclared type answers `unsupported`, not `not_found`',
  (
    await fetch(`${API}/stories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'X', type: 'nosuchtype' }),
    })
  ).status === 501,
)

// The sitemap must not emit a URL for something that has none. `ada` is
// published by now (above), so this is a published-but-unrouted document.
const xml = await fetch(`${HTTP}/sitemap.xml`).then((r) => r.text())
check(
  'a published record contributes no sitemap entry: it has no URL',
  !xml.includes('/null') && !xml.includes('><loc></loc>'),
  xml.match(/<loc>[^<]*null[^<]*<\/loc>/)?.[0] ?? 'clean',
)
check('the published insight does appear in the sitemap', xml.includes('/insights/hello-world'))

/* --- nested objects diff and restore correctly -------------------------- */

check(
  'an unchanged link object produces no mutation',
  diffOf({ href: { kind: 'story', id: 'a' } }, { href: { kind: 'story', id: 'a' } }).length === 0,
)
check(
  'a changed link object produces exactly one set',
  (() => {
    const ms = diffOf({ href: { kind: 'story', id: 'a' } }, { href: { kind: 'story', id: 'b' } })
    return ms.length === 1 && ms[0].t === 'set' && ms[0].value.id === 'b'
  })(),
)
check(
  'a nested focal point change is detected',
  diffOf(
    { file: { key: 'k', alt: '', focal: { x: 0.1, y: 0.1 } } },
    { file: { key: 'k', alt: '', focal: { x: 0.1, y: 0.9 } } },
  ).length === 1,
)
check(
  'an identical nested asset object is not a change',
  diffOf(
    { file: { key: 'k', alt: 'a', focal: { x: 0.1, y: 0.1 } } },
    { file: { key: 'k', alt: 'a', focal: { x: 0.1, y: 0.1 } } },
  ).length === 0,
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
