// Caching, measured against a real deployment (`docs/specs/platform/caching.md`).
//
//   node scripts/cache-probe.mjs https://your-worker.example.com
//   node scripts/cache-probe.mjs https://… --path /insights --token folio_xxx
//
// **This is a tool, not a test, and it can never gate CI.** Workers Cache is not
// simulated by miniflare — `wrangler dev`, vitest-pool-workers and every
// `scripts/*-test.mjs` see no cache at all — so a hit, a purge and the time
// between them are only observable against a deployed Worker with
// `"cache": { "enabled": true }` in its wrangler config. Everything that *can*
// be checked locally is a pure function with unit tests behind it
// (`core/cache-tags.ts`, `server/cache-purge.ts`'s `purgePlan`); this covers the
// one line they cannot reach.
//
// It exists because the throwaway version of it caught a bug that would have
// shipped silently: `cloudflare:workers`' `cache` export is **request-scoped**,
// so holding a reference to `cache.purge` at module scope gives a permanent
// no-op that never purges, never errors, and passes every unit test in the spec.
// Run this after changing the purge hook or the tag vocabulary.
//
// It is deliberately not named `*-test.mjs`: `scripts/e2e.sh` globs those, and
// this one needs a deployment rather than a local dev server.
//
// **What it writes.** Phase 1 is pure reads. Phase 2 needs an API token and
// *causes* purges, which means writing: a title patch (reverted before it
// finishes) and one or two publishes, each of which writes a version row. Point
// it at a staging deployment, not at production during business hours.
//
// **What it cannot tell you.** Whether a purge propagated to any colo other than
// the one answering this client. One client cannot observe that, and no amount
// of polling from here will change it. If a stale page is ever reported from
// another region, that is the assumption to re-test, not this script.

import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    path: { type: 'string', default: '/' },
    token: { type: 'string' },
    timeout: { type: 'string', default: '15000' },
    help: { type: 'boolean', short: 'h' },
  },
})

const base = positionals[0]?.replace(/\/+$/, '')
if (!base || values.help) {
  console.error(
    'usage: node scripts/cache-probe.mjs <deployment-url> [--path /] [--token <api token>] [--timeout ms]',
  )
  process.exit(values.help ? 0 : 2)
}

const TARGET = `${base}${values.path.startsWith('/') ? values.path : `/${values.path}`}`
const API = `${base}/folio/api/v1`
const TIMEOUT = Number(values.timeout)
const POLL_MS = 50

const auth = values.token ? { authorization: `Bearer ${values.token}` } : undefined

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const record = (step, ok, detail) => {
  rows.push({ step, ok, detail })
  console.log(
    `${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  ${detail}` : ''}`,
  )
}

/** One plain GET of the target, as a browser navigation would make it. */
async function probe(headers = {}) {
  const started = Date.now()
  const res = await fetch(TARGET, { redirect: 'manual', headers })
  await res.arrayBuffer() // drain, so the connection is reusable
  return {
    status: res.status,
    ms: Date.now() - started,
    // Cloudflare's own verdict. Absent entirely when the Worker has no cache
    // enabled — which is the first thing worth telling the operator.
    cacheStatus: res.headers.get('cf-cache-status'),
    cacheControl: res.headers.get('cache-control'),
    cacheTag: res.headers.get('cache-tag'),
    setCookie: res.headers.get('set-cookie'),
    vary: res.headers.get('vary'),
  }
}

async function api(path, init = {}) {
  if (!auth) throw new Error('no token')
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...auth,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`)
  }
  return body
}

/**
 * How long until the target stops being served from cache.
 *
 * Freshness is read off `cf-cache-status` rather than off the page's bytes,
 * deliberately: most triggers here (a title patch, a sibling's publish) change
 * what *another* page renders about this one, or change nothing visible at all,
 * so "the HTML differs" is not a signal that exists for every prefix. A MISS is.
 */
async function timeToFresh() {
  const started = Date.now()
  while (Date.now() - started < TIMEOUT) {
    const seen = await probe()
    if (seen.cacheStatus !== 'HIT') {
      const ms = Date.now() - started
      // Warm it again, so the next measurement starts from a HIT like this one did.
      await probe()
      return { ms, status: seen.cacheStatus }
    }
    await wait(POLL_MS)
  }
  return { ms: null, status: 'HIT' }
}

/** The tag set the response carries, grouped by prefix. */
function tagsOf(header) {
  const tags = (header ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const byPrefix = new Map()
  for (const tag of tags) {
    const prefix = tag.includes(':') ? `${tag.split(':')[0]}:` : tag
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), tag])
  }
  return { tags, byPrefix }
}

console.log(`\ncache-probe → ${TARGET}\n`)

/* ------------------------------------------------- phase 1: is it cached --- */

const first = await probe()
if (first.status >= 400) {
  record('the target answers', false, `${first.status} — nothing to probe`)
  process.exit(1)
}
record('the target answers', true, `${first.status} in ${first.ms}ms`)

record(
  'the host sets Cache-Control',
  Boolean(first.cacheControl),
  first.cacheControl ?? 'absent — the host has not applied folio.cacheHeaders()',
)
/**
 * The asymmetry decision 2 is built on: both headers or neither. One without the
 * other is a page cached for its full TTL with no purge path.
 *
 * **But `Cache-Tag` is unobservable on a cached response.** Cloudflare consumes
 * the header and strips it before the response reaches a client, so a request
 * that Workers Caching handled can never show it — and `cf-cache-status` being
 * present is exactly the signal that it did. Reporting FAIL there is a false
 * alarm, which is worse than no check: this probe exists to be believed.
 *
 * So the tags are read from a request that *bypassed* the cache. Folio's own
 * draft cookie is the reliable way to arrange one — `cacheVerdictFor` answers
 * `'bypass'` for any request carrying it, on any path — and it grants nothing on
 * its own, so an unauthenticated probe still gets the published page.
 */
if (first.cacheStatus) {
  const bypassed = await probe({ cookie: 'folio_draft=1' })
  record(
    'the host sets Cache-Tag',
    Boolean(bypassed.cacheTag),
    bypassed.cacheTag
      ? `${tagsOf(bypassed.cacheTag).tags.length} tags (read off a bypassed request; Cloudflare strips the header from a cached one)`
      : 'absent — nothing can be purged',
  )
  first.cacheTag = bypassed.cacheTag
} else {
  record(
    'the host sets Cache-Tag',
    Boolean(first.cacheTag),
    first.cacheTag
      ? `${tagsOf(first.cacheTag).tags.length} tags`
      : 'absent — nothing can be purged',
  )
}
if (first.cacheControl && !/max-age=0/.test(first.cacheControl)) {
  record(
    'max-age is 0',
    false,
    'a purge reaches the edge and cannot reach a browser cache — see decision 9',
  )
} else if (first.cacheControl) {
  record('max-age is 0', true, 'no browser holds a copy a purge cannot reach')
}

// The trap that silently disables caching entirely: Workers Cache never stores a
// response carrying Set-Cookie. A host that rolls a session on a published page
// gets zero caching and no error at all.
record(
  'no Set-Cookie on the published response',
  !first.setCookie,
  first.setCookie ? 'set — Workers Cache will never store this response' : '',
)
if (first.vary) record('Vary', null, `${first.vary} — a cache variant; confirm it is intended`)

if (first.cacheStatus === null) {
  record(
    'the deployment has caching enabled',
    false,
    'no cf-cache-status header at all — add "cache": { "enabled": true } to wrangler.jsonc',
  )
  process.exit(1)
}

const second = await probe()
record(
  'MISS then HIT',
  second.cacheStatus === 'HIT',
  `${first.cacheStatus} → ${second.cacheStatus}`,
)

const { byPrefix } = tagsOf(first.cacheTag ?? second.cacheTag)
console.log(
  `\ntags on this response: ${[...byPrefix].map(([p, t]) => `${p}×${t.length}`).join('  ') || 'none'}\n`,
)

/* ------------------------------------------- phase 2: does a purge land --- */

if (!auth) {
  record('purge by tag', null, 'no --token, so no write can be made to trigger one')
  summarise()
}

/**
 * `GET /documents/by-path/:path` answers the document **flat** — `meta()` is
 * spread into the top level alongside `source` and `content` — not wrapped in a
 * `meta` key. Reading `d.meta` gave `undefined`, and because the guard below was
 * a bare `if`, every phase-2 check was skipped and the run still reported
 * "0 failed". A probe that quietly does nothing is the failure this script was
 * written to catch, so the miss is now recorded rather than stepped over.
 */
const meta = await api(`/documents/by-path/${values.path.replace(/^\/+/, '')}`).catch((err) => {
  record('find the document behind the path', false, String(err))
  return null
})

if (meta && !meta.id) {
  record(
    'find the document behind the path',
    false,
    `no id in ${JSON.stringify(meta).slice(0, 120)}`,
  )
}

if (meta?.id) {
  record('find the document behind the path', true, `${meta.id} (${meta.type})`)

  // --- story: --------------------------------------------------------------
  // A title patch fires `updated`, which purges `story:<id>` and nothing else —
  // the only trigger in the whole vocabulary that is precisely one prefix. It is
  // also the write that used to fire no event at all, which is why the `updated`
  // event exists.
  if (byPrefix.has('story:')) {
    const original = meta.title
    await api(`/documents/${meta.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: `${original} (cache-probe)` }),
    })
    const fresh = await timeToFresh()
    record(
      'story: purge lands',
      fresh.ms !== null,
      fresh.ms !== null ? `${fresh.ms}ms → ${fresh.status}` : `still HIT after ${TIMEOUT}ms`,
    )
    // Reverted whatever happened above, so the probe leaves the title as it
    // found it. This purges the same tag a second time, harmlessly.
    await api(`/documents/${meta.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: original }),
    })
  } else {
    record('story: purge lands', null, 'the response carries no story: tag')
  }

  // --- global: -------------------------------------------------------------
  // Publishing a global purges `global:<name>` on every page that *rendered* it,
  // which is the case no reverse index could ever have answered: a global comes
  // from config and writes no `content_refs` edge at all.
  const globals = (byPrefix.get('global:') ?? []).map((t) => decodeURIComponent(t.slice(7)))
  if (globals.length > 0) {
    const name = globals[0]
    try {
      await api(`/documents/sng_${name}/publish`, { method: 'POST' })
      const fresh = await timeToFresh()
      record(
        `global:${name} purge lands`,
        fresh.ms !== null,
        fresh.ms !== null ? `${fresh.ms}ms → ${fresh.status}` : `still HIT after ${TIMEOUT}ms`,
      )
    } catch (err) {
      record(`global:${name} purge lands`, false, String(err))
    }
  } else {
    record('global: purge lands', null, 'the response carries no global: tag')
  }

  // --- type: ---------------------------------------------------------------
  // Publishing any document of the type purges every index page listing it,
  // with nothing anywhere recording which pages those are. The document itself
  // is chosen from the same query the page's own collection would run.
  const types = (byPrefix.get('type:') ?? [])
    .map((t) => decodeURIComponent(t.slice(5)))
    .filter((t) => t !== '*')
  if (types.length > 0) {
    const type = types[0]
    try {
      const page = await api(`/documents?type=${encodeURIComponent(type)}&perPage=1`)
      const item = page.items?.[0]
      if (!item) {
        record(`type:${type} purge lands`, null, 'no published document of that type to publish')
      } else {
        await api(`/documents/${item.id}/publish`, { method: 'POST' })
        const fresh = await timeToFresh()
        record(
          `type:${type} purge lands`,
          fresh.ms !== null,
          fresh.ms !== null
            ? `${fresh.ms}ms → ${fresh.status} (via publishing ${item.id})`
            : `still HIT after ${TIMEOUT}ms`,
        )
      }
    } catch (err) {
      record(`type:${type} purge lands`, false, String(err))
    }
  } else {
    record('type: purge lands', null, 'the response carries no type: tag')
  }
}

summarise()

function summarise() {
  const failed = rows.filter((r) => r.ok === false).length
  const skipped = rows.filter((r) => r.ok === null).length
  const passed = rows.filter((r) => r.ok === true).length
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  console.log(
    'Measured at one colo only. Global propagation is not observable from a single client.\n',
  )
  process.exit(failed > 0 ? 1 : 0)
}
