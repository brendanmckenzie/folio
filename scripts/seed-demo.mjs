// Seeds a page that exercises every field type, so there is something worth
// looking at in a browser. Creates its own stories rather than overwriting
// whatever the test scripts last left behind.
//
//   node scripts/seed-demo.mjs        (against a dev server on 5199)

import zlib from 'node:zlib'

// Imported directly: Node strips types natively and the module has only
// type-only imports, so there is nothing to compile.
// The demo now configures a real sign-in provider (identity-and-access.md), so
// every route here needs a session. This signs in as the seeded admin and makes
// this process's `fetch` and `WebSocket` carry the cookie, exactly as a browser
// does — see scripts/lib/auth.mjs.
import { signInGlobally } from './lib/auth.mjs'

await signInGlobally()

const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

const HTTP = 'http://localhost:5199'
const API = `${HTTP}/folio`

const json = (url, init) => fetch(url, init).then((r) => r.json())
const log = (...a) => console.log(...a)

/* ----------------------------------------------------------------- images --- */

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A gradient PNG, so the page has real images without shipping binaries. */
function png(width, height, from, to) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    for (let x = 0; x < width; x++) {
      const t = (x / width) * 0.55 + (y / height) * 0.45
      const p = row + 1 + x * 3
      for (let c = 0; c < 3; c++) raw[p + c] = Math.round(from[c] + (to[c] - from[c]) * t)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function upload(name, bytes) {
  const res = await fetch(`${API}/assets?filename=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: bytes,
  })
  if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`)
  const { value } = await res.json()
  return value
}

/* --------------------------------------------------------------- stories --- */

async function storyBySlug(slug, title, parentId = null) {
  const flatten = (ns) => ns.flatMap((n) => [n, ...flatten(n.children)])
  const existing = flatten(await json(`${API}/stories`)).find((s) => s.slug === slug)
  if (existing) return existing
  return json(`${API}/stories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, slug, parentId }),
  })
}

/** Opens a socket, replaces the story's body, and closes. */
async function seed(storyId, build) {
  const ws = new WebSocket(`ws://localhost:5199/folio/story/${storyId}/socket`)
  const doc = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bootstrap timeout for ${storyId}`)), 8000)
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'bootstrap') {
        clearTimeout(timer)
        resolve(msg.doc)
      }
    })
    ws.addEventListener('open', () =>
      ws.send(
        JSON.stringify({
          type: 'hello',
          lastSyncId: 0,
          identity: { actor: 'seed', name: 'Seed', colour: '#0090ff' },
          v: PROTOCOL_VERSION,
        }),
      ),
    )
  })

  const root = doc.root
  // Start from empty so re-running the seed is idempotent rather than additive.
  const clear = Object.values(doc.bloks)
    .filter((b) => b.parent === root)
    .map((b) => ({ t: 'remove', uid: b.uid }))

  const mutations = [...clear, ...build(root)]
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tx timeout for ${storyId}`)), 8000)
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'delta' && msg.txId === 'seed') {
        clearTimeout(timer)
        setTimeout(resolve, 200)
      }
    })
    ws.send(JSON.stringify({ type: 'tx', txId: 'seed', mutations, v: PROTOCOL_VERSION }))
  })
  ws.close()
  await fetch(`${API}/story/${storyId}/publish`, { method: 'POST' })
}

const blok = (uid, type, parent, slot, order, data) => ({
  t: 'insert',
  blok: { uid, type, parent, slot, order, data },
})

/* -------------------------------------------------------------- richtext --- */

const doc_ = (...content) => ({ type: 'doc', content })
const para = (...content) => ({ type: 'paragraph', content })
const h = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
})
const txt = (text, ...marks) => ({ type: 'text', text, ...(marks.length ? { marks } : {}) })
const li = (...content) => ({ type: 'listItem', content })
const storyLink = (id) => ({ type: 'link', attrs: { link: { kind: 'story', id } } })

/* ------------------------------------------------------------------ main --- */

if (
  !(await fetch(`${HTTP}/health`)
    .then((r) => r.ok)
    .catch(() => false))
) {
  console.error(`No server on ${HTTP}. Run \`pnpm dev\` in examples/demo first.`)
  process.exit(1)
}

log('Uploading images…')
const wide = await upload('coast.png', png(1400, 800, [32, 60, 110], [220, 130, 90]))
const tall = await upload('canyon.png', png(900, 1200, [70, 40, 90], [240, 190, 120]))
const one = await upload('tide.png', png(800, 800, [12, 90, 100], [180, 230, 210]))
const two = await upload('dune.png', png(800, 800, [150, 90, 40], [250, 225, 180]))
const three = await upload('scree.png', png(800, 800, [60, 70, 80], [200, 210, 220]))

const showcase = await storyBySlug('showcase', 'Field types')
const details = await storyBySlug('reference-target', 'A referenced page', showcase.id)
log(`Stories: ${showcase.url}  ${details.url}`)

// The page the `reference` field points at. Seeded first so the embed resolves.
await seed(details.id, (root) => [
  { t: 'set', uid: root, field: 'title', value: 'A referenced page' },
  {
    t: 'set',
    uid: root,
    field: 'description',
    value: 'This description is read straight off the referenced page’s root block.',
  },
  blok('rt-a', 'prose', root, 'body', 'a0', {
    heading: 'Content belonging to another page',
    width: 'narrow',
    body: doc_(
      para(
        txt('This paragraph lives on '),
        txt('a different story', { type: 'bold' }),
        txt(
          ' and is pulled in at render time. Editing it here changes it wherever it is embedded.',
        ),
      ),
    ),
  }),
])

await seed(showcase.id, (root) => [
  { t: 'set', uid: root, field: 'title', value: 'Field types' },
  { t: 'set', uid: root, field: 'description', value: 'Every Folio field type on one page.' },
  { t: 'set', uid: root, field: 'socialImage', value: { ...wide, alt: 'Social preview' } },

  /* hero: asset with a focal point, plus two resolved links -------------- */
  blok('hero', 'hero', root, 'body', 'a0', {
    eyebrow: 'Phase 1',
    heading: 'Content model completeness',
    body: 'Links, assets, richtext and cross-document references, rendered with no client JavaScript.',
    align: 'center',
    image: { ...wide, alt: 'Background', focal: { x: 0.35, y: 0.65 } },
  }),
  blok('hero-a', 'button', 'hero', 'actions', 'a0', {
    label: 'The referenced page',
    variant: 'primary',
    href: { kind: 'story', id: details.id },
  }),
  blok('hero-b', 'button', 'hero', 'actions', 'a1', {
    label: 'Cloudflare docs',
    variant: 'ghost',
    href: { kind: 'url', url: 'https://developers.cloudflare.com/', target: '_blank' },
  }),

  /* richtext: the full vocabulary --------------------------------------- */
  blok('prose', 'prose', root, 'body', 'a1', {
    heading: 'Richtext',
    width: 'narrow',
    body: doc_(
      para(
        txt('Stored as ProseMirror JSON and rendered by a walker that '),
        txt('never imports TipTap', { type: 'bold' }),
        txt(', which is why this page ships no JavaScript at all.'),
      ),
      h(2, 'Marks'),
      para(
        txt('Bold', { type: 'bold' }),
        txt(', '),
        txt('italic', { type: 'italic' }),
        txt(', '),
        txt('underline', { type: 'underline' }),
        txt(', '),
        txt('strikethrough', { type: 'strike' }),
        txt(', '),
        txt('inline code', { type: 'code' }),
        txt(', x'),
        txt('2', { type: 'superscript' }),
        txt(' and H'),
        txt('2', { type: 'subscript' }),
        txt('O.'),
      ),
      h(3, 'Links inside prose'),
      para(
        txt('This links to '),
        txt('the referenced page', storyLink(details.id)),
        txt(' by id, so renaming that page rewrites this href without touching the document. '),
        txt('An external one', {
          type: 'link',
          attrs: { link: { kind: 'url', url: 'https://example.com', target: '_blank' } },
        }),
        txt(' opens in a new tab with rel="noopener noreferrer" added for you.'),
      ),
      h(2, 'Blocks'),
      {
        type: 'bulletList',
        content: [li(para(txt('Bulleted lists'))), li(para(txt('…with several items')))],
      },
      {
        type: 'orderedList',
        content: [li(para(txt('Numbered lists'))), li(para(txt('…also work')))],
      },
      {
        type: 'blockquote',
        content: [para(txt('A blockquote, rendered as a real blockquote element.'))],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [txt('render: ({ body }) => <div>{body}</div>')],
      },
      { type: 'horizontalRule' },
      para(txt('Everything above came out of one field value.')),
    ),
  }),

  /* a deliberately constrained richtext field --------------------------- */
  blok('pq', 'pullquote', root, 'body', 'a2', {
    quote: doc_(
      para(
        txt('This field permits '),
        txt('bold', { type: 'bold' }),
        txt(
          ', italic and links only. Its toolbar shrinks to match, and pasted formatting is stripped on the way in.',
        ),
      ),
    ),
    credit: 'A caption-style field',
    tone: 'quiet',
  }),

  /* asset: intrinsic size, alt text, focal point ------------------------ */
  blok('img', 'image', root, 'body', 'a3', {
    file: {
      ...tall,
      alt: 'A tall gradient, cropped wide around its focal point',
      focal: { x: 0.5, y: 0.22 },
    },
    caption:
      'Cropped 16:9 from a portrait source, held to its focal point. Resized behind /folio/asset.',
    ratio: 'wide',
  }),

  /* multiasset ---------------------------------------------------------- */
  blok('gal', 'gallery', root, 'body', 'a4', {
    heading: 'Multiasset',
    images: [
      { ...one, alt: 'Tide' },
      { ...two, alt: 'Dune', focal: { x: 0.8, y: 0.2 } },
      { ...three, alt: 'Scree' },
    ],
  }),

  /* reference, both ways ------------------------------------------------ */
  blok('emb', 'embed', root, 'body', 'a5', {
    heading: 'Reference: inlined content',
    source: details.id,
    mode: 'content',
  }),
  blok('emb2', 'embed', root, 'body', 'a6', {
    heading: 'Reference: reading its fields',
    source: details.id,
    mode: 'summary',
  }),

  /* nested blocks, and the remaining link kinds ------------------------- */
  blok('feat', 'features', root, 'body', 'a7', {
    heading: 'Nested blocks',
    columns: 3,
    items: null,
  }),
  blok('f1', 'feature', 'feat', 'items', 'a0', {
    icon: '🔗',
    title: 'Links store ids',
    body: 'Renaming a page updates every link to it, with no rewrite pass.',
  }),
  blok('f2', 'feature', 'feat', 'items', 'a1', {
    icon: '🖼',
    title: 'Assets resize behind our own route',
    body: 'So a stored value never names a resizing service.',
  }),
  blok('f3', 'feature', 'feat', 'items', 'a2', {
    icon: '📄',
    title: 'Richtext is data',
    body: 'The editor is admin-only; the page is plain HTML.',
  }),

  blok('cta', 'cta', root, 'body', 'a8', {
    heading: 'The other link kinds',
    body: 'An email link and an in-page anchor, both resolved by the same field.',
  }),
  blok('cta-a', 'button', 'cta', 'actions', 'a0', {
    label: 'Email link',
    variant: 'primary',
    href: { kind: 'email', email: 'hello@example.com', subject: 'Folio & fields' },
  }),
  blok('cta-b', 'button', 'cta', 'actions', 'a1', {
    label: 'Jump to top',
    variant: 'ghost',
    href: { kind: 'anchor', anchor: 'top' },
  }),
])

log('')
log('Published. Have a look at:')
log(`  ${HTTP}${showcase.url}                  the page, zero JavaScript`)
log(`  ${HTTP}${showcase.url}?_folio=preview   the same page in preview mode`)
log(`  ${API}/edit/${showcase.id}       the editor`)
log(`  ${HTTP}${details.url}      the referenced page on its own`)
