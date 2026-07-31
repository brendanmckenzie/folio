// Exercises localisation end to end (docs/specs/content-model/localisation.md)
// against the demo, which declares `en` (source) and `fr` and puts the locale in
// a `/fr` URL prefix — see examples/demo/src/index.tsx's `route` and
// `parseLocale`.
//
// The load-bearing checks, in the order the spec's testing requirements name
// them:
//
//   1. Two clients on one story in different locales: both edits land, neither
//      overwrites the other (they write different keys of the same blok), and
//      each client's undo reverts only its own language.
//   2. One publish serves both language URLs, with the untranslated fields
//      falling back rather than leaving holes — and the French page still ships
//      zero JavaScript.
//   3. A version restore preserves translations, expressed as locale-scoped
//      `set`s rather than as a document overwrite.
//   4. **A pre-v3 log still bootstraps identically**: a `set` with no locale is a
//      source-locale write, permanently, and that is the property the whole wire
//      bump rests on.

import './lib/ts-resolve.mjs'

// The demo configures a real sign-in provider (identity-and-access.md), so every
// route here needs a session; this makes the process's `fetch` and `WebSocket`
// carry the cookie exactly as a browser does.
import { signInGlobally } from './lib/auth.mjs'

await signInGlobally()

const { diff } = await import(new URL('../packages/folio/src/core/diff.ts', import.meta.url))
const { applyAll } = await import(
  new URL('../packages/folio/src/core/mutations.ts', import.meta.url)
)
const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

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
const text = (url, init) => fetch(url, init).then((r) => r.text())

function client(name, storyId) {
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
    inbox,
    async hello() {
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      ws.send(
        JSON.stringify({
          type: 'hello',
          lastSyncId: 0,
          // v3: one optional nested object, advisory, read only under
          // `auth: 'open'`. The demo has real accounts, so the object ignores it.
          identity: { actor: name, name, colour: '#0090ff' },
          v: PROTOCOL_VERSION,
        }),
      )
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    async tx(txId, mutations) {
      this.send({ type: 'tx', txId, mutations })
      const delta = await this.expect((m) => m.type === 'delta' && m.txId === txId)
      await wait(120)
      return delta
    },
    expect(match, ms = 5000) {
      const hit = inbox.find(match)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error(`timeout waiting on ${name}`)), ms)
      })
    },
  }
}

let txn = 0
const nextTx = () => `i18n${(txn++).toString().padStart(3, '0')}`

/* --------------------------------------------- a page with something on it --- */

const page = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Localisation' }),
})
check('a page to translate', Boolean(page.id), page.path)

// Per-locale URLs come off the story row, built by the host's own `route`.
check(
  'the story row carries a url per declared locale',
  page.urls?.en === `/${page.path}` && page.urls?.fr === `/fr/${page.path}`,
  JSON.stringify(page.urls),
)
check(
  'and a preview url per locale, with `&locale=` only for a non-source one',
  page.previewUrls?.en === `/${page.path}?_folio=preview` &&
    page.previewUrls?.fr === `/fr/${page.path}?_folio=preview&locale=fr`,
  JSON.stringify(page.previewUrls),
)

const fr = client('fr-translator', page.id)
const doc = await fr.hello()
const root = doc.root

// A hero, so there is a translatable heading and a subheading that stays English.
const HERO = 'heroi18n01'
await fr.tx(nextTx(), [
  {
    t: 'insert',
    blok: {
      uid: HERO,
      type: 'hero',
      parent: root,
      slot: 'body',
      order: 'a0',
      data: {
        eyebrow: '',
        heading: 'Hello world',
        body: 'Untranslated on purpose',
        image: null,
        align: 'left',
      },
    },
  },
])

// A source-locale edit, with no `locale` on the wire at all — byte-identical to
// every `set` written before v3. The log has to hold one for the replay check at
// the end to mean anything.
await fr.tx(nextTx(), [{ t: 'set', uid: HERO, field: 'eyebrow', value: 'Shared everywhere' }])

/* ------------------------------------- 1. two locales, one document, no clash --- */

const de = client('de-translator', page.id)
await de.hello()

// Two translators, two languages, the same field, at the same time.
await Promise.all([
  fr.tx(nextTx(), [
    { t: 'set', uid: HERO, field: 'heading', value: 'Bonjour le monde', locale: 'fr' },
  ]),
  de.tx(nextTx(), [{ t: 'set', uid: HERO, field: 'heading', value: 'Hallo Welt', locale: 'de' }]),
])
await wait(200)

const afterBoth = (await json(`${API}/story/${page.id}/document`)).doc
check(
  'both translations landed; neither overwrote the other',
  afterBoth.bloks[HERO]?.i18n?.fr?.heading === 'Bonjour le monde' &&
    afterBoth.bloks[HERO]?.i18n?.de?.heading === 'Hallo Welt',
  JSON.stringify(afterBoth.bloks[HERO]?.i18n),
)
check(
  'and the source locale is untouched by either',
  afterBoth.bloks[HERO]?.data.heading === 'Hello world',
  String(afterBoth.bloks[HERO]?.data.heading),
)
check(
  'each client saw the other’s delta: one document, one log, one channel',
  fr.inbox.some((m) => m.type === 'delta' && m.mutations?.some((x) => x.locale === 'de')) &&
    de.inbox.some((m) => m.type === 'delta' && m.mutations?.some((x) => x.locale === 'fr')),
)

// Undo, the way the store computes it: the inverse against the document as it was
// before. `null` reads as untranslated, which is how "untranslate this" is
// expressible at all.
await fr.tx(nextTx(), [{ t: 'set', uid: HERO, field: 'heading', value: null, locale: 'fr' }])
const afterUndo = (await json(`${API}/story/${page.id}/document`)).doc
check(
  'undoing the French reverts only the French',
  afterUndo.bloks[HERO]?.i18n?.fr?.heading === null &&
    afterUndo.bloks[HERO]?.i18n?.de?.heading === 'Hallo Welt' &&
    afterUndo.bloks[HERO]?.data.heading === 'Hello world',
  JSON.stringify(afterUndo.bloks[HERO]?.i18n),
)

// Put the French back for the publish checks below, and translate the page title
// so the tree's per-locale cache has something to write.
await fr.tx(nextTx(), [
  { t: 'set', uid: HERO, field: 'heading', value: 'Bonjour le monde', locale: 'fr' },
  { t: 'set', uid: root, field: 'title', value: 'Localisation (FR)', locale: 'fr' },
])

/* ------------------------------------------- the completeness route and badge --- */

const status = await json(`${API}/story/${page.id}/translation?locale=fr`)
check(
  'the translation route counts what French still owes',
  status.locale === 'fr' && status.total > status.translated && status.missing.length > 0,
  `${status.translated}/${status.total}`,
)
check(
  'and names the untranslated hero body among the gaps',
  status.missing.some((m) => m.field === 'body'),
  JSON.stringify(status.missing.map((m) => m.field)),
)
const unknownLocale = await fetch(`${API}/story/${page.id}/translation?locale=kl`)
check(
  'an undeclared locale is 501, not 404',
  unknownLocale.status === 501,
  String(unknownLocale.status),
)

/* --------------------------------------------- 2. one publish, both languages --- */

const pub = await json(`${API}/story/${page.id}/publish`, { method: 'POST' })
check('published once', pub.ok === true)

const enHtml = await text(`${HTTP}/${page.path}`)
const frHtml = await text(`${HTTP}/fr/${page.path}`)

check('the English URL serves the source values', enHtml.includes('Hello world'), '')
check(
  'the French URL serves the translation',
  frHtml.includes('Bonjour le monde') && !frHtml.includes('Hello world'),
)
check(
  'an untranslated field falls back rather than leaving a hole',
  frHtml.includes('Untranslated on purpose'),
)
check('the French page declares its language', frHtml.includes('<html lang="fr"'), '')
check('and ships no JavaScript, like any published page', !frHtml.includes('<script'), '')

// One document, one snapshot, every locale (checkpoint 3).
const published = await json(`${API}/story/${page.id}/versions`)
const publishVersion = published.find((v) => v.id === pub.version.id)
const { doc: snapshot } = await json(`${API}/versions/${publishVersion.id}`)
check(
  'the single published snapshot contains every locale',
  snapshot.bloks[HERO]?.i18n?.fr?.heading === 'Bonjour le monde' &&
    snapshot.bloks[HERO]?.i18n?.de?.heading === 'Hallo Welt',
)

// The tree's per-locale title cache, written by that same publish.
const tree = await json(`${API}/stories`)
const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])])
const row = flatten(tree).find((n) => n.id === page.id)
check(
  'publish cached the translated title for the tree',
  row?.titleI18n?.fr === 'Localisation (FR)',
  JSON.stringify(row?.titleI18n),
)
check(
  'and left the source-locale title as the row’s own `title`',
  row?.title === 'Localisation',
  row?.title,
)

// An undeclared locale prefix is not a page.
const bogus = await fetch(`${HTTP}/kl/${page.path}`)
check('an undeclared locale prefix 404s', bogus.status === 404, String(bogus.status))

/* -------------------------------------------- the preview, per locale --- */

const frPreview = await text(`${HTTP}/fr/${page.path}?_folio=preview&locale=fr`)
check(
  'the preview finds the story behind a locale-prefixed URL',
  frPreview.includes('Bonjour le monde'),
)
check(
  'and puts the locale on the resolution the client re-renders from',
  frPreview.includes('"locale":{"code":"fr"'),
)
const enPreview = await text(`${HTTP}/${page.path}?_folio=preview`)
check(
  'the source-locale preview carries no locale at all',
  enPreview.includes('Hello world') && !enPreview.includes('"locale":'),
)

/* --------------------------------- 3. a version restore preserves translations --- */

// Change the French, then restore the publish version — which still holds the
// French as it was.
await fr.tx(nextTx(), [
  { t: 'set', uid: HERO, field: 'heading', value: 'Salut le monde', locale: 'fr' },
])
const { doc: liveDoc } = await json(`${API}/story/${page.id}/document`)
const restore = diff(liveDoc, snapshot)
check(
  'the restore is a locale-scoped set, not a document overwrite',
  restore.length === 1 &&
    restore[0].t === 'set' &&
    restore[0].locale === 'fr' &&
    restore[0].value === 'Bonjour le monde',
  JSON.stringify(restore),
)
await fr.tx(nextTx(), restore)
const restored = (await json(`${API}/story/${page.id}/document`)).doc
check(
  'the restore landed and touched no other locale',
  restored.bloks[HERO]?.i18n?.fr?.heading === 'Bonjour le monde' &&
    restored.bloks[HERO]?.i18n?.de?.heading === 'Hallo Welt' &&
    restored.bloks[HERO]?.data.heading === 'Hello world',
)

/* ------------------------------------------------- 4. a pre-v3 log still replays --- */

// The property the whole wire bump rests on, checked against the object's own
// log: replaying every mutation it holds must produce exactly the document it
// serves. A `set` with no locale in that log is a source-locale write, and one
// with a locale is not — the same log, the same reducer, no migration.
const activity = await json(`${API}/story/${page.id}/activity`)
const logged = [...activity].reverse().flatMap((entry) => entry.mutations)
const sourceSets = logged.filter((m) => m.t === 'set' && m.locale === undefined)
const localeSets = logged.filter((m) => m.t === 'set' && m.locale !== undefined)
check(
  'the log holds both shapes of `set`, old and new',
  sourceSets.length > 0 && localeSets.length > 0,
  `${sourceSets.length} source, ${localeSets.length} locale`,
)

const replayed = applyAll({ root, bloks: {} }, logged)
check(
  'replaying the whole log reproduces the document the object serves',
  JSON.stringify(replayed.bloks[HERO]) === JSON.stringify(restored.bloks[HERO]),
  JSON.stringify(replayed.bloks[HERO]?.i18n),
)

// And the same log with every `locale` key stripped — literally a pre-v3 log —
// lands every value in `data` and creates no `i18n` at all.
const asV2 = logged.map((m) => {
  if (m.t !== 'set') return m
  const { locale: _locale, ...rest } = m
  return rest
})
const legacy = applyAll({ root, bloks: {} }, asV2)
check(
  'a pre-v3 log (no locale anywhere) produces a document with no i18n at all',
  Object.values(legacy.bloks).every((b) => b.i18n === undefined),
)

/* --------------------------------- the audit finds what a translator cannot see --- */

const audit = await json(`${API}/audit`)
check(
  'the audit names text fields nobody marked translatable',
  audit.schema.some((f) => f.check === 'not-translatable'),
  String(audit.schema.filter((f) => f.check === 'not-translatable').length),
)
check(
  'and reports the German values, whose locale the demo does not declare',
  audit.content.some((f) => f.check === 'unknown-locale' && f.field === 'de'),
  JSON.stringify(audit.content.filter((f) => f.check === 'unknown-locale')),
)

fr.ws.close()
de.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
