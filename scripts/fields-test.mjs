// Exercises the richer field types end to end against a live dev server.
//
// The load-bearing check is `rename updates every link to that page`: story
// links store an id, so a path change has to reach the rendered href without
// anything rewriting the document.

// Imported directly: Node strips types natively and these modules have only
// type-only imports, so there is nothing to resolve at runtime. Modules with real
// value imports cannot be loaded this way, since the library uses extensionless
// specifiers that only a bundler resolves — those are covered over HTTP instead.
const { diff } = await import(new URL('../packages/folio/src/core/diff.ts', import.meta.url))

const HTTP = 'http://localhost:5199'
const API = `${HTTP}/folio`
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

function client(name) {
  const ws = new WebSocket(`ws://localhost:5199/folio/story/${STORY}/socket`)
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
        JSON.stringify({ type: 'hello', actor: name, name, colour: '#0090ff', lastSyncId: 0 }),
      )
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    send: (m) => ws.send(JSON.stringify(m)),
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

const CTA = 'ctalink1'
const btn = (uid, order, href) => ({
  t: 'insert',
  blok: {
    uid,
    type: 'button',
    parent: CTA,
    slot: 'actions',
    order,
    data: { label: uid, href, variant: 'primary' },
  },
})

await ed.tx('f1', [
  {
    t: 'insert',
    blok: {
      uid: CTA,
      type: 'cta',
      parent: root,
      slot: 'body',
      order: 'a0',
      data: { heading: 'Links', body: '' },
    },
  },
  btn('lstory', 'a0', { kind: 'story', id: 'sty_about' }),
  btn('lurl', 'a1', { kind: 'url', url: 'https://example.com', target: '_blank' }),
  btn('lmail', 'a2', { kind: 'email', email: 'hi@example.com', subject: 'A & B' }),
  btn('lanch', 'a3', { kind: 'anchor', anchor: 'section-two' }),
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
check('an unknown key is a 404', (await fetch(`${HTTP}/folio/asset/nope`)).status === 404)

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

const libraryBefore = await json(`${API}/assets`)
await fetch(`${API}/assets/${two.asset.id}`, { method: 'DELETE' })
const libraryAfter = await json(`${API}/assets`)
check(
  'deleting removes the library row',
  libraryBefore.length - libraryAfter.length === 1 &&
    !libraryAfter.some((a) => a.id === two.asset.id),
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
        attribution: 'Someone',
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
  const ws = new WebSocket(`ws://localhost:5199/folio/story/sty_about/socket`)
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
        actor: 'about',
        name: 'about',
        colour: '#000',
        lastSyncId: 0,
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
    ws.send(JSON.stringify({ type: 'tx', txId, mutations }))
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
