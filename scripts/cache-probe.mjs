// Caching, measured against a real deployment (`docs/specs/platform/caching.md`).
//
//   node scripts/cache-probe.mjs https://your-worker.example.com
//   node scripts/cache-probe.mjs https://… --path /insights --token folio_xxx
//
// A multi-site deployment (`docs/specs/foundation/multi-site.md`) answers a site's
// pages on that site's own hosts and takes every write on the admin origin, under
// the site's `~<site>` segment, so the same run names all three:
//
//   node scripts/cache-probe.mjs https://alpha.example \
//     --admin https://cms.example --site alpha \
//     --preview https://preview.alpha.example --token folio_xxx
//
// `--admin` and `--site` go together and move the writes to
// `<admin>/folio/~<site>/api/v1`. `--preview` probes the same path on the site's
// preview origin, which is a separate cache entry (the surface is in the props,
// `cacheProps`), and, with a token, checks that one publish purges both.
// Without any of the three this behaves exactly as it always has.
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
// With `--admin` the publish is of the page's own document, and only when it is
// already `live` with no newer draft: republishing that changes nothing a visitor
// can see (a version row, a new `publishedAt`), where publishing a `changed`
// document would put someone's unfinished edits on the site. A page the site
// inherits from a scope above is not touched at all; the write would be that
// scope's, and the token may not have it.
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
    admin: { type: 'string' },
    site: { type: 'string' },
    preview: { type: 'string' },
    timeout: { type: 'string', default: '15000' },
    help: { type: 'boolean', short: 'h' },
  },
})

const USAGE = `usage: node scripts/cache-probe.mjs <deployment-url> [--path /] [--token <api token>] [--timeout ms]
                                     [--admin <origin> --site <id>] [--preview <origin>]

  <deployment-url>   the host serving the page (on a multi-site deployment, one of the site's live hosts)
  --path             the page to probe (default /)
  --token            an API token; without one the run is read-only and the purge checks are skipped
  --timeout          how long to wait for a purge to land, in ms (default 15000)

Multi-site (docs/specs/foundation/multi-site.md):
  --admin <origin>   the admin origin (sites.admin); writes go to <origin>/folio/~<site>/api/v1
  --site <id>        the site the writes are made under; required with --admin, and the other way round
  --preview <origin> the site's preview origin: the same path is probed there, must be a separate
                     cache entry from the live host's, and (with --admin) is checked to be purged by
                     the same publish`

const base = positionals[0]?.replace(/\/+$/, '')
if (!base || values.help) {
  console.error(USAGE)
  process.exit(values.help ? 0 : 2)
}
if (Boolean(values.admin) !== Boolean(values.site)) {
  console.error(
    `--admin and --site go together: ${values.admin ? '--admin needs --site' : '--site needs --admin'}\n`,
  )
  console.error(USAGE)
  process.exit(2)
}

const originOf = (flag, raw) => {
  try {
    return new URL(raw).origin
  } catch {
    console.error(`${flag} must be an absolute URL, like https://cms.example\n`)
    console.error(USAGE)
    process.exit(2)
  }
}

const PATH = values.path.startsWith('/') ? values.path : `/${values.path}`
const TARGET = `${base}${PATH}`
// The writes: on the admin origin under the site's segment on a multi-site
// deployment, on the host itself otherwise.
const MULTI = Boolean(values.admin)
const API = MULTI
  ? `${originOf('--admin', values.admin)}/folio/~${encodeURIComponent(values.site)}/api/v1`
  : `${base}/folio/api/v1`
// The same path on the preview origin, when one was named.
const PREVIEW = values.preview ? `${originOf('--preview', values.preview)}${PATH}` : null
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
async function probe(headers = {}, url = TARGET) {
  const started = Date.now()
  const res = await fetch(url, { redirect: 'manual', headers })
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
async function timeToFresh(url = TARGET) {
  const started = Date.now()
  while (Date.now() - started < TIMEOUT) {
    const seen = await probe({}, url)
    if (seen.cacheStatus !== 'HIT') {
      const ms = Date.now() - started
      // Warm it again, so the next measurement starts from a HIT like this one did.
      await probe({}, url)
      return { ms, status: seen.cacheStatus }
    }
    await wait(POLL_MS)
  }
  return { ms: null, status: 'HIT' }
}

/** Requests until `url` answers from cache, at most three: a HIT is what a purge check starts from. */
async function warm(url) {
  for (let i = 0; i < 3; i++) {
    if ((await probe({}, url)).cacheStatus === 'HIT') return true
    await wait(POLL_MS)
  }
  return false
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

console.log(`\ncache-probe → ${TARGET}`)
if (PREVIEW) console.log(`preview     → ${PREVIEW}`)
if (MULTI) console.log(`writes      → ${API}`)
console.log('')

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

/* ------------------------- phase 1b: is the preview origin its own entry --- */

/**
 * The surface is in the props (`folio.cacheProps`), so the preview origin's copy of
 * the page is a different entry from the live host's, even at the same path: the
 * headers a host sets only there (`X-Robots-Tag`, Folio's `frame-ancestors`) must
 * never be served to the public. The live entry is confirmed warm first, so a
 * MISS here means the preview origin did not share it.
 */
if (PREVIEW) {
  const live = await probe()
  const seen = await probe({}, PREVIEW)
  if (seen.status >= 400) {
    record(
      'the preview origin answers',
      false,
      `${seen.status} — a draft site serves nobody on its preview origin without a grant`,
    )
  } else {
    record('the preview origin answers', true, `${seen.status} in ${seen.ms}ms`)
    if (live.cacheStatus !== 'HIT') {
      record('preview is a separate entry', null, `the live entry was ${live.cacheStatus}, not HIT`)
    } else if (seen.cacheStatus === 'MISS') {
      record(
        'preview is a separate entry',
        true,
        `live ${live.cacheStatus}, preview ${seen.cacheStatus}`,
      )
    } else if (seen.cacheStatus === 'HIT') {
      record(
        'preview is a separate entry',
        null,
        'the preview entry was already warm from an earlier request; run again after a publish',
      )
    } else {
      record(
        'preview is a separate entry',
        false,
        `preview ${seen.cacheStatus ?? 'has no cf-cache-status'} — the preview origin is not cached`,
      )
    }
    const again = await probe({}, PREVIEW)
    if (seen.cacheStatus !== null) {
      record(
        'preview MISS then HIT',
        again.cacheStatus === 'HIT',
        `${seen.cacheStatus} → ${again.cacheStatus}`,
      )
    }
  }
}

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

// On a multi-site deployment the page may be inherited: owned by `shared` or a group,
// and served here by the walk up the chain. A write under `~<site>` cannot reach it,
// and the token may hold no role on the owner, so none is attempted.
const owned = !MULTI || !meta?.site || meta.site === values.site

if (meta?.id && !owned) {
  record(
    'story: purge lands',
    null,
    `the page belongs to ${meta.site}, not ${values.site}; point --path at a page the site owns`,
  )
  record('publish purges both entries', null, 'nothing is written to a page the site does not own')
}

if (meta?.id && owned) {
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

  if (MULTI) {
    // A layer's id and its tags carry the scope (`sng_<type>:<scope>`,
    // `global:<name>@<scope>`, `type:<name>@<scope>`), so the two lookups below, which
    // read a bare name off the tag, would publish the wrong document. What a multi-site
    // deployment adds is one publish that reaches both surfaces, which is checked here.
    record('global: purge lands', null, 'not probed with --admin: layer ids carry the scope')
    record('type: purge lands', null, 'not probed with --admin: type tags carry the scope')

    // --- one publish, both entries: ---------------------------------------------
    // A tag purge reaches every props variant, so the live host's entry and the preview
    // origin's are both dropped by the one publish. Only a document that is already
    // `live` with no newer draft is republished: `changed` would publish someone's
    // unfinished edits.
    if (!PREVIEW) {
      record('publish purges both entries', null, 'no --preview, so there is only one entry')
    } else if (meta.state !== 'live') {
      record(
        'publish purges both entries',
        null,
        `the page is ${meta.state}; publishing it would change what visitors see`,
      )
    } else if (!(await warm(TARGET)) || !(await warm(PREVIEW))) {
      record('publish purges both entries', null, 'could not get both entries to HIT first')
    } else {
      try {
        await api(`/documents/${meta.id}/publish`, { method: 'POST' })
        const [live, preview] = await Promise.all([timeToFresh(TARGET), timeToFresh(PREVIEW)])
        record(
          'publish purges the live entry',
          live.ms !== null,
          live.ms !== null ? `${live.ms}ms → ${live.status}` : `still HIT after ${TIMEOUT}ms`,
        )
        record(
          'publish purges the preview entry',
          preview.ms !== null,
          preview.ms !== null
            ? `${preview.ms}ms → ${preview.status}`
            : `still HIT after ${TIMEOUT}ms`,
        )
      } catch (err) {
        record('publish purges both entries', false, String(err))
      }
    }
  } else {
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
