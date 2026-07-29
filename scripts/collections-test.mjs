// Exercises collections end to end (docs/specs/content-model/collections.md)
// against the demo's `insight` type and its `insightList` block — see
// examples/demo/src/blocks/insight.tsx.
//
// The load-bearing checks, in order of how much they would cost to get wrong:
//
//  1. An index page renders the right N insights in the right order, with no
//     `<script>` — the whole promise of resolving collections server-side.
//  2. `?page=2` continues where page one stopped, and no id appears on both.
//  3. A locale-filtered query matches a translated value, and the source value
//     still matches under the source locale.
//  4. The editor's preview shows a member insight's DRAFT title while the live
//     page still shows its published one (decision 3).
//  5. Deleting an insight takes it out of the list, in the same breath.
//  6. A story id reachable ONLY from a richtext link mark still resolves to a
//     real href on a published page. This is a regression guard, not a feature
//     test: a Folio-native link mark stores a structured `attrs.link` and has no
//     `href`, so narrowing `resolve()` to link and reference *fields* would have
//     rendered every internal prose link as plain text — and neither the
//     richtext sanitiser's tests nor a link-field test would have noticed.
//  7. `folio.query` in the host's own route (`/archive`), which is the user
//     story about a filtered archive being ordinary application code.

import './lib/ts-resolve.mjs'

// The demo configures a real sign-in provider (identity-and-access.md), so every
// route here needs a session. See scripts/lib/auth.mjs.
import { signInGlobally } from './lib/auth.mjs'

await signInGlobally()

const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

const HTTP = 'http://localhost:5199'
const API = `${HTTP}/folio`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())
const text = (url) => fetch(url).then((r) => r.text())

function client(name, storyId) {
  const ws = new WebSocket(`ws://localhost:5199/folio/story/${storyId}/socket`)
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
          // Every frame carries the wire version, not only `hello`: the object
          // refuses a frame that omits it, and a refused frame looks like a hang.
          v: PROTOCOL_VERSION,
        }),
      )
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
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
        setTimeout(() => reject(new Error(`timeout waiting on ${name}`)), ms)
      })
    },
  }
}

const post = (path, body) =>
  json(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const rootOf = (doc) => doc.root
const liveUrl = (story) => `${HTTP}/${story.path}`
const previewUrl = (story) => `${HTTP}/${story.path}?_folio=preview`

/* --- an index page, and twenty-five insights beneath it ------------------- */

const index = await post('/stories', { title: 'Collections Index' })
check('an index page exists', Boolean(index.id))

const TOPICS = ['policy', 'technology', 'practice']
const insights = []

// Twenty-five, per the spec's e2e requirement: nine `policy`, so a page of six
// has a second page with three on it and `pages` is 2.
for (let i = 0; i < 25; i++) {
  const created = await post('/stories', {
    title: `Insight ${String(i).padStart(2, '0')}`,
    parentId: index.id,
    type: 'insight',
  })
  insights.push(created)
}
check('twenty-five insights were created under it', insights.length === 25)

/**
 * Fills in one insight's root fields and publishes it. `published` descends with
 * `i`, so insight 00 is the newest and the expected order is by id.
 */
async function fillAndPublish(story, i, extra = {}) {
  const c = client(`ins${i}`, story.id)
  const doc = await c.hello()
  const root = rootOf(doc)
  const day = String(28 - (i % 28)).padStart(2, '0')
  const mutations = [
    { t: 'set', uid: root, field: 'title', value: story.title },
    { t: 'set', uid: root, field: 'topic', value: TOPICS[i % 3] },
    { t: 'set', uid: root, field: 'published', value: `2026-03-${day}` },
    { t: 'set', uid: root, field: 'standfirst', value: `Standfirst for ${story.title}` },
    ...(extra.mutations ?? []).map((m) => ({ ...m, uid: m.uid ?? root })),
  ]
  await c.tx(`ci${i}`, mutations)
  if (extra.after) await extra.after(c, root)
  c.ws.close()
  if (extra.publish !== false) await post(`/story/${story.id}/publish`)
  return root
}

// A story id reachable only from a link mark inside prose — check 6's fixture.
// The link points at the index page, which is a real published story, so a
// working resolution turns it into `/collections-index`. Note the mark carries
// `attrs.link` and NO `href`: the href is derived from the resolution at render
// time, which is exactly the case a narrowed resolution can silently break.
const proseWithStoryLink = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Background: ' },
        {
          type: 'text',
          text: 'the index',
          marks: [{ type: 'link', attrs: { link: { kind: 'story', id: index.id } } }],
        },
      ],
    },
  ],
}

const roots = []
for (let i = 0; i < 25; i++) {
  // Insight 24 stays a draft, so "a query never returns unpublished content" has
  // something to be about.
  roots.push(
    await fillAndPublish(insights[i], i, {
      publish: i !== 24,
      mutations:
        // Insight 01 gets a French title, for the locale check.
        i === 1 ? [{ t: 'set', field: 'title', value: 'Politique du réseau', locale: 'fr' }] : [],
      // Insight 00 carries the prose link *and* a related-insights list, in child
      // blocks — `body` is a `blocks` field, so richtext lives on a `prose` block
      // rather than on the root. The list is what makes the self-including case
      // (and the draft patch below) reachable at all.
      after:
        i === 0
          ? async (c, root) => {
              await c.tx('cprose', [
                {
                  t: 'insert',
                  blok: {
                    uid: 'cprose01',
                    type: 'prose',
                    parent: root,
                    slot: 'body',
                    order: 'a0',
                    data: { body: proseWithStoryLink },
                  },
                },
                {
                  t: 'insert',
                  blok: {
                    uid: 'crelated1',
                    type: 'insightList',
                    parent: root,
                    slot: 'body',
                    order: 'a1',
                    data: {
                      heading: 'Related insights',
                      list: {
                        where: [{ field: 'topic', op: 'eq', value: 'policy' }],
                        perPage: 6,
                        order: { field: 'published', dir: 'desc' },
                      },
                    },
                  },
                },
              ])
            }
          : undefined,
    }),
  )
}

// i % 3 === 0 for i in 0..24 is nine insights; insight 24 is one of them and is
// deliberately left unpublished, so eight are queryable.
const policyCount = insights.filter((_, i) => i % 3 === 0 && i !== 24).length
check('eight policy insights are published', policyCount === 8, `counted ${policyCount}`)

/* --- the query engine, over HTTP ----------------------------------------- */

const q1 = await json(
  `${API}/content?type=insight&where=topic:eq:policy&order=published:desc&perPage=6&page=1`,
)
check('a filtered, sorted, paged query answers a ContentPage', Array.isArray(q1.items))
check('six items come back on page one', q1.items.length === 6, `got ${q1.items.length}`)
check('total counts every match, not just the page', q1.total === 8, `total ${q1.total}`)
check('pages is derived from total and perPage', q1.pages === 2, `pages ${q1.pages}`)

const dates1 = q1.items.map((i) => String(i.data.published))
check(
  'newest first, per the order clause',
  JSON.stringify(dates1) === JSON.stringify([...dates1].sort().reverse()),
  dates1.join(', '),
)

const q2 = await json(
  `${API}/content?type=insight&where=topic:eq:policy&order=published:desc&perPage=6&page=2`,
)
check('page two holds the remaining two', q2.items.length === 2, `got ${q2.items.length}`)
const ids1 = new Set(q1.items.map((i) => i.id))
check(
  'no id appears on both pages',
  q2.items.every((i) => !ids1.has(i.id)),
)

const draftId = insights[24].id
const everything = await json(`${API}/content?type=insight&perPage=100`)
check(
  'an unpublished insight is in no query at all',
  !everything.items.some((i) => i.id === draftId),
)
check('every published insight is', everything.total === 24, `total ${everything.total}`)

const refused = await fetch(`${API}/content?type=insight&where=secret:eq:x`)
const refusedBody = await refused.json()
check('a filter on an unindexed field is a 400', refused.status === 400, `${refused.status}`)
check(
  'and the message names the field rather than answering empty',
  String(refusedBody?.error?.message ?? '').includes('secret'),
  refusedBody?.error?.message,
)

/* --- the same query in a locale ----------------------------------------- */

const french = await json(
  `${API}/content?type=insight&locale=fr&where=${encodeURIComponent('title:eq:Politique du réseau')}`,
)
check(
  'a French query matches a translated title',
  french.items.length === 1 && french.items[0].id === insights[1].id,
  `${french.items.length} item(s)`,
)

const english = await json(
  `${API}/content?type=insight&where=${encodeURIComponent('title:eq:Insight 01')}`,
)
check(
  'and the source title still matches the same story under the source locale',
  english.items.length === 1 && english.items[0].id === insights[1].id,
)

const frenchTopic = await json(
  `${API}/content?type=insight&locale=fr&where=topic:eq:policy&perPage=100`,
)
check(
  'an untranslated field falls back, so a French filter on `topic` still matches',
  frenchTopic.total === 8,
  `total ${frenchTopic.total}`,
)

/* --- the index page renders the list ------------------------------------ */

const ic = client('index', index.id)
const indexDoc = await ic.hello()
const indexRoot = rootOf(indexDoc)
await ic.tx('cx1', [{ t: 'set', uid: indexRoot, field: 'title', value: 'Collections Index' }])

// One `insightList` block in the page's body, configured to policy, six a page.
const listUid = 'cl000001'
await ic.tx('cx2', [
  {
    t: 'insert',
    blok: {
      uid: listUid,
      type: 'insightList',
      parent: indexRoot,
      slot: 'body',
      order: 'a0',
      data: {
        heading: 'Policy insights',
        list: {
          where: [{ field: 'topic', op: 'eq', value: 'policy' }],
          perPage: 6,
          order: { field: 'published', dir: 'desc' },
        },
      },
    },
  },
])
await post(`/story/${index.id}/publish`)

const live1 = await text(liveUrl(index))
check('the index page renders its heading', live1.includes('Policy insights'))

const rendered = [...live1.matchAll(/class="insight-list__item"[\s\S]*?<\/li>/g)].map((m) => m[0])
check('six insight items render', rendered.length === 6, `rendered ${rendered.length}`)
check(
  'they are the same six the query returned, in the same order',
  q1.items.every((item, i) => rendered[i]?.includes(item.title)),
)
check(
  'each carries its own URL, resolved at render time',
  q1.items.every((item) => live1.includes(`href="${item.url}"`)),
)
check('the page ships no JavaScript', !live1.includes('<script'))
// React's server output separates adjacent text nodes with `<!-- -->` markers, so
// "Page 1 of 2" is not a contiguous string in the HTML.
check('and says which page of how many', /Page\D*1\D*of\D*2/.test(live1))

const live2 = await text(`${liveUrl(index)}?page=2`)
const rendered2 = [...live2.matchAll(/class="insight-list__item"[\s\S]*?<\/li>/g)].map((m) => m[0])
check('?page=2 renders the remaining two', rendered2.length === 2, `rendered ${rendered2.length}`)
check(
  'page two holds none of page one’s items',
  q1.items.every((item) => !live2.includes(`>${item.title}<`)),
)

/* --- a page with no collection field runs no collection query ------------ */

const plain = await post('/stories', { title: 'Collections Plain Page' })
const pc = client('plain', plain.id)
const plainDoc = await pc.hello()
await pc.tx('cp1', [
  { t: 'set', uid: rootOf(plainDoc), field: 'title', value: 'Collections Plain Page' },
])
pc.ws.close()
await post(`/story/${plain.id}/publish`)
const plainLive = await text(liveUrl(plain))
check(
  'a page with no collection field renders with no list markup at all',
  plainLive.includes('Collections Plain Page') && !plainLive.includes('insight-list'),
)

/* --- a preview lists PUBLISHED items, and says so ----------------------- */

const indexPreview = await text(previewUrl(index))
check('the index page’s preview renders the list too', indexPreview.includes('Policy insights'))
check(
  'and says it shows published items, because a preview cannot query drafts',
  indexPreview.includes('Showing published insights'),
)
check('the LIVE page carries no such note', !live1.includes('Showing published insights'))

/* --- the open story's own draft is patched into a list it belongs to ----- */

// Insight 00 carries a "Related insights" list filtered to policy, and is itself
// a published policy insight — so it is a member of its own list. That is the one
// case decision 3 patches: the editor is previewing THIS document, so its draft is
// in hand and its published row in the results is stale by definition.
const selfMember = insights[0]
const selfRoot = roots[0]
const sc = client('self', selfMember.id)
await sc.hello()
await sc.tx('cself', [{ t: 'set', uid: selfRoot, field: 'title', value: 'DRAFT RETITLED INSIGHT' }])
sc.ws.close()

const selfPreview = await text(previewUrl(selfMember))
check(
  'a list on the story being previewed shows its DRAFT title, not its published one',
  selfPreview.includes('DRAFT RETITLED INSIGHT'),
)
// Counting rendered *markup*, not the string: the preview's `__FOLIO__` bootstrap
// carries the document and the resolution as JSON, so the heading's text appears
// there too. One rendered list is the assertion — a list that included its own page
// and recursed would draw a second.
check(
  'and a collection listing its own page does not recurse',
  (selfPreview.match(/class="insight-list__heading"/g) ?? []).length === 1,
  `${(selfPreview.match(/class="insight-list__heading"/g) ?? []).length} list(s) drawn`,
)

const selfLive = await text(liveUrl(selfMember))
check(
  'the LIVE page still shows the published title everywhere',
  selfLive.includes(selfMember.title) && !selfLive.includes('DRAFT RETITLED INSIGHT'),
)

/* --- a link mark's story id still resolves ------------------------------- */

check(
  'an internal link inside richtext renders as a real anchor, not plain text',
  selfLive.includes(`href="/${index.path}"`),
  'a story link mark carries no href; the resolution derives it',
)
check('and its text survives', selfLive.includes('the index'))

/* --- delete takes it out of the list ------------------------------------ */

// Not `q1.items[0]`, which is insight 00 and is the fixture for two checks above.
const doomed = q1.items[1]
await fetch(`${API}/stories/${doomed.id}`, { method: 'DELETE' })

const afterDelete = await json(
  `${API}/content?type=insight&where=topic:eq:policy&order=published:desc&perPage=100`,
)
check('a deleted insight leaves the query', !afterDelete.items.some((i) => i.id === doomed.id))
check('and the total drops with it', afterDelete.total === 7, `total ${afterDelete.total}`)

const liveAfterDelete = await text(liveUrl(index))
check('and leaves the rendered list', !liveAfterDelete.includes(`>${doomed.title}<`))

/* --- unpublish takes it out too ---------------------------------------- */

// The last one, so insight 00 (the fixture above) stays live.
const takenDown = afterDelete.items[afterDelete.items.length - 1]
await post(`/story/${takenDown.id}/unpublish`)
const afterUnpublish = await json(`${API}/content?type=insight&where=topic:eq:policy&perPage=100`)
check(
  'an unpublished insight leaves the query',
  !afterUnpublish.items.some((i) => i.id === takenDown.id),
)
check('and the total drops again', afterUnpublish.total === 6, `total ${afterUnpublish.total}`)

/* --- folio.query in the host's own route -------------------------------- */

const archive = await json(`${HTTP}/archive?topic=technology`)
check(
  'the host’s own /archive route queries published content directly',
  archive.total > 0 && archive.items.every((i) => i.topic === 'technology'),
  `total ${archive.total}`,
)
check('and pages independently of any block', archive.perPage === undefined && archive.pages >= 1)

const archive2 = await json(`${HTTP}/archive?topic=technology&page=2`)
check(
  'page two of the archive is a different set',
  archive2.items.every((i) => !archive.items.some((j) => j.id === i.id)),
)

/* --- reindex is idempotent --------------------------------------------- */

const reindexed = await post('/reindex', { batch: 200 })
check(
  'POST /folio/reindex sweeps every published document',
  reindexed.documents > 0 && reindexed.indexRows > 0,
  `${reindexed.documents} documents, ${reindexed.indexRows} rows`,
)

const afterReindex = await json(`${API}/content?type=insight&where=topic:eq:policy&perPage=100`)
check(
  'and changes nothing: the same query answers the same way',
  afterReindex.total === afterUnpublish.total,
  `${afterReindex.total} vs ${afterUnpublish.total}`,
)

const dryRun = await post('/reindex', { batch: 200, dryRun: true })
check('a dry run reports without writing', dryRun.dryRun === true && dryRun.documents > 0)

ic.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
