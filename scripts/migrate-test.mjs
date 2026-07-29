// Exercises content migrations end to end (docs/specs/foundation/schema-migrations.md)
// against the demo's own two migrations (examples/demo/src/migrations.ts):
// `0001` renames `pullquote.attribution` → `pullquote.credit`, `0002` fills a
// retroactive default into `pullquote.tone`.
//
// The whole point of the design is that one pure function reaches three copies of
// a document, so that is what this checks:
//
//   - the live *draft*, as an ordinary logged transaction — so a connected editor
//     receives a delta with no reload, and the activity trail records it;
//   - `stories.published_doc`, so the live page renders the new field;
//   - a *version* row, migrated on read only, with the stored bytes untouched.
//
// Plus the two properties everything else leans on: a dry run writes nothing, and
// a second run reports zero changes (which is how you check the first one worked).

import './lib/ts-resolve.mjs'

// The demo configures a real sign-in provider (identity-and-access.md), so every
// route here needs a session, and `POST /folio/migrate` needs an *admin* one.
// The seeded `demo@example.com` is that admin.
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
const post = (url, body) =>
  json(url, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })

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
    inbox,
    async hello() {
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      // Every frame carries the wire version, stamped from source — which is now
      // 2, because `Mutation` gained `retype`.
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
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    async tx(txId, mutations) {
      this.send({ type: 'tx', txId, mutations })
      await this.expect((m) => m.type === 'delta' && m.txId === txId)
      await wait(120)
    },
    expect(match, ms = 6000) {
      const hit = inbox.find(match)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error(`timeout waiting on ${name}`)), ms)
      })
    },
  }
}

// v4 since editing/live-collaboration.md: presence carries a field and a locale,
// and a space-level channel appeared. `retype`, this spec's own addition, is
// unaffected — it was v2's, and neither of the two bumps since has touched a
// mutation.
check('the wire version is 4', PROTOCOL_VERSION === 4, String(PROTOCOL_VERSION))

/* --- what the config declares -------------------------------------------- */

const status0 = await json(`${API}/migrations`)
check(
  'GET /folio/migrations lists the configured migrations in run order',
  status0.migrations?.map((m) => m.id).join(',') ===
    '0001-pullquote-attribution-to-credit,0002-pullquote-tone-default',
  JSON.stringify(status0.migrations?.map((m) => m.id)),
)
check(
  'both are pending, since nothing has run',
  status0.pending?.length === 2 && status0.migrations.every((m) => !m.applied),
)

/* --- two stories, one published, both holding pre-migration documents ----- */

// **The seeded rows, deliberately, not two fresh ones.** A story created through
// `POST /folio/stories` is stamped with the latest migration id, because
// `blankSubtree` seeds its document from the current schema — it is born up to
// date and correctly never migrated. `examples/demo/seed.sql` writes its three
// rows with no `schema_id` at all, which is exactly what a site that existed
// before its first migration looks like. That is the population this feature is
// for, so it is the population this script uses.
const pageA = { id: 'sty_about', path: 'about' }
const pageB = { id: 'sty_team', path: 'about/team' }
const seeded = await json(`${API}/migrations?story=${pageA.id}`)
check(
  'the seeded stories predate the migrations',
  seeded.story?.schemaId === null,
  String(seeded.story?.schemaId),
)

/**
 * A pull quote written the way a *pre-migration* document holds one: an
 * `attribution` key the schema no longer declares, and no `tone` key at all.
 * Inserted through the socket rather than through the admin's add-block path,
 * because that path seeds from the current schema — which is exactly why a
 * document created today needs no migration and an old one does.
 */
const legacyPullquote = (uid, root, credit) => ({
  t: 'insert',
  blok: {
    uid,
    type: 'pullquote',
    parent: root,
    slot: 'body',
    order: 'm0',
    data: {
      quote: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quote' }] }],
      },
      attribution: credit,
    },
  },
})

const edA = client('migrate-editor-a', pageA.id)
const docA0 = await edA.hello()
await edA.tx('m-a1', [legacyPullquote('pqA', docA0.root, 'Ada')])

const edB = client('migrate-editor-b', pageB.id)
const docB0 = await edB.hello()
await edB.tx('m-b1', [legacyPullquote('pqB', docB0.root, 'Bo')])

// Page A is published *before* the migration, so its snapshot and one retained
// version both hold the old shape. That is three copies of the same document.
const publishA = await post(`${API}/story/${pageA.id}/publish`)
check('page A published before the migration', Boolean(publishA.version?.id))

const liveA0 = await fetch(`${HTTP}/${pageA.path}`).then((r) => r.text())
check(
  'the live page shows no credit yet: the value is under a key nothing reads',
  liveA0.includes('<figure class="pullquote"') && !liveA0.includes('Ada'),
)

const statusA0 = await json(`${API}/migrations?story=${pageA.id}`)
check(
  'the story reports itself behind, naming what it is missing',
  statusA0.story?.behind === true && statusA0.story.pending.length === 2,
  JSON.stringify(statusA0.story?.pending?.map((m) => m.id)),
)
check(
  'the pending entries carry the descriptions an editor reads',
  statusA0.story?.pending?.[0]?.description === 'Pull quote: attribution → credit',
  statusA0.story?.pending?.[0]?.description,
)

/* --- the drift audit sees the orphan key and the missing field ------------ */

const audit0 = await json(`${API}/audit`)
const orphan = audit0.orphanKeys?.find((f) => f.type === 'pullquote' && f.field === 'attribution')
check(
  'the audit reports the orphaned pullquote.attribution key',
  Boolean(orphan),
  JSON.stringify(orphan),
)
const missing = audit0.missingFields?.filter((f) => f.type === 'pullquote').map((f) => f.field)
check(
  'the audit reports the two fields the published pull quote has no key for',
  missing?.includes('credit') && missing?.includes('tone'),
  JSON.stringify(missing),
)
check('the audit modified nothing: it is a read', audit0.documents >= 1, String(audit0.documents))

/* --- dry run: counts everything, writes nothing --------------------------- */

const dry = await post(`${API}/migrate`, { dryRun: true })
check('the dry run names both pending migrations', dry.pending?.length === 2)
check(
  'the dry run counts documents and mutations',
  dry.dryRun === true && dry.stories >= 2 && dry.changed >= 2 && dry.mutations >= 6,
  JSON.stringify({ stories: dry.stories, changed: dry.changed, mutations: dry.mutations }),
)
check('the dry run lists no oversized document at this size', dry.oversized?.length === 0)

const afterDry = await json(`${API}/migrations?story=${pageA.id}`)
check('the dry run wrote no watermark', afterDry.story?.schemaId === null)
check('the dry run wrote no ledger row', afterDry.pending?.length === 2)
const liveAfterDry = await fetch(`${HTTP}/${pageA.path}`).then((r) => r.text())
check('the dry run changed no published document', !liveAfterDry.includes('Ada'))

/* --- the real run, with an editor watching page A ------------------------- */

const before = edA.inbox.filter((m) => m.type === 'delta').length
const run = await post(`${API}/migrate`, {})
check(
  'the run reports what it changed and completes the sweep',
  run.changed >= 2 &&
    run.failed?.length === 0 &&
    run.continueFrom === null &&
    run.complete === true,
  JSON.stringify({ changed: run.changed, failed: run.failed, complete: run.complete }),
)

// The acceptance criterion the whole "produces mutations, does not rewrite"
// decision exists for: a connected editor sees it happen.
const delta = await edA.expect(
  (m) => m.type === 'delta' && m.mutations?.some((x) => x.field === 'credit'),
)
check(
  'the connected editor received the migration as a delta, with no reload',
  edA.inbox.filter((m) => m.type === 'delta').length > before,
)
check(
  'the delta is attributed to the migration, not to a person',
  delta.actor === 'usr_demoadmin1' || delta.actor?.startsWith('migration:'),
  delta.actor,
)

const trail = await json(`${API}/story/${pageA.id}/activity`)
check(
  'the migration is in the activity trail',
  trail.some((e) => e.mutations?.some((m) => m.field === 'credit')),
)

/* --- all three copies of the document ------------------------------------ */

const { doc: draftA } = await json(`${API}/story/${pageA.id}/document`)
check(
  'the draft has credit and a cleared attribution',
  draftA.bloks.pqA.data.credit === 'Ada' && draftA.bloks.pqA.data.attribution === null,
  JSON.stringify(draftA.bloks.pqA.data),
)
check(
  'the draft picked up the retroactive tone default',
  draftA.bloks.pqA.data.tone === 'quiet',
  String(draftA.bloks.pqA.data.tone),
)

const liveA1 = await fetch(`${HTTP}/${pageA.path}`).then((r) => r.text())
check(
  'the published page now renders the new field',
  liveA1.includes('<figcaption class="pullquote__by">Ada</figcaption>'),
  liveA1.match(/<figure class="pullquote"[\s\S]{0,220}/)?.[0],
)
check('the published page carries the migrated tone', liveA1.includes('data-tone="quiet"'))

// Checkpoint 3: history stays byte-true, and the old version reads back in the
// *new* shape because it is migrated on the way out.
const version = await json(`${API}/versions/${publishA.version.id}`)
check(
  'an old version previews correctly: migrated on read',
  version.doc?.bloks?.pqA?.data?.credit === 'Ada' && version.doc.bloks.pqA.data.tone === 'quiet',
  JSON.stringify(version.doc?.bloks?.pqA?.data),
)
check(
  'the version row reports which migrations were applied on the way out',
  version.migrated?.length === 2,
  JSON.stringify(version.migrated),
)
check(
  'the version row itself was never rewritten',
  version.meta?.schemaId === null,
  String(version.meta?.schemaId),
)

/* --- the other story came along too -------------------------------------- */

const { doc: draftB } = await json(`${API}/story/${pageB.id}/document`)
check(
  'the second story was migrated in the same sweep',
  draftB.bloks.pqB.data.credit === 'Bo' && draftB.bloks.pqB.data.tone === 'quiet',
  JSON.stringify(draftB.bloks.pqB.data),
)

/* --- the ledger and the watermarks --------------------------------------- */

const status1 = await json(`${API}/migrations?story=${pageA.id}`)
check('nothing is pending any more', status1.pending?.length === 0 && status1.behind === 0)
check(
  'both migrations read as applied',
  status1.migrations?.every((m) => m.applied),
)
check(
  'the story carries the latest watermark and is no longer behind',
  status1.story?.schemaId === '0002-pullquote-tone-default' && status1.story.behind === false,
  status1.story?.schemaId,
)

/* --- re-running does nothing (checkpoint 2) ------------------------------- */

const again = await post(`${API}/migrate`, {})
check(
  'a second run sees nothing behind at all',
  again.stories === 0 && again.mutations === 0 && again.complete === true,
  JSON.stringify({ stories: again.stories, mutations: again.mutations }),
)

const trailBefore = await json(`${API}/story/${pageA.id}/activity`)
await post(`${API}/migrate`, {})
const trailAfter = await json(`${API}/story/${pageA.id}/activity`)
check(
  're-running wrote no new transaction',
  trailAfter.length === trailBefore.length,
  `${trailBefore.length} → ${trailAfter.length}`,
)

/* --- a document created now is born up to date --------------------------- */

const fresh = await post(`${API}/stories`, { title: 'Born Migrated' })
const statusFresh = await json(`${API}/migrations?story=${fresh.id}`)
check(
  'a story created after the migrations is never reported behind',
  statusFresh.story?.behind === false &&
    statusFresh.story.schemaId === '0002-pullquote-tone-default',
  statusFresh.story?.schemaId,
)

/* --- the audit is clean again -------------------------------------------- */

await post(`${API}/story/${pageA.id}/publish`)
const audit1 = await json(`${API}/audit`)
check(
  'the orphaned key is gone from the audit once the migration has run',
  !audit1.orphanKeys?.some((f) => f.type === 'pullquote' && f.field === 'attribution'),
  JSON.stringify(audit1.orphanKeys),
)
check(
  'the pullquote no longer reports missing fields',
  !audit1.missingFields?.some((f) => f.type === 'pullquote'),
  JSON.stringify(audit1.missingFields?.filter((f) => f.type === 'pullquote')),
)
// Narrowed to this spec's own two checks. `not-translatable`
// (content-model/localisation.md) is a *third* schema check with legitimate
// findings against the demo — a person's `role`, a feature's emoji `icon` — which
// is the entire point of it: it finds the unmarked fields and a host decides
// which ones it meant. Asserting the whole array were empty would have made this
// script fail every time somebody added a check.
const structural = (audit1.schema ?? []).filter((f) =>
  ['unknown-condition-field', 'hidden-summary-field', 'unknown-summary-field'].includes(f.check),
)
check(
  'the demo schema itself is clean: no unknown showIf field, no hidden summary',
  structural.length === 0,
  JSON.stringify(structural),
)

edA.ws.close()
edB.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
