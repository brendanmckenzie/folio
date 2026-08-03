import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * The one rule that lets a contract and an unstable internal surface share the
 * `/api` prefix (`docs/specs/foundation/pagination.md` decision 3):
 *
 * > **A version segment is a promise. Its absence is the absence of one.**
 *
 * `{base}/api/v1/*` is a contract with somebody's script and changes by adding a
 * `v2`. `{base}/api/*` with no version is internal to the admin, ships in the same
 * deploy as its only caller, and may change shape in any commit.
 *
 * **This file is what earns that prefix.** The objection to sharing one was that
 * the two surfaces would look like siblings and be told apart only by the presence
 * of `v1` — which is true, so the difference is asserted here rather than left to a
 * reader's memory. Adding `{base}/api/v1/stories` by reflex fails CI.
 *
 * Deliberately black-box over `SELF`: it checks what the mounted app *answers*, not
 * what `app.ts` looks like, so it keeps working if the mounting is refactored.
 */

const ORIGIN = 'https://partition.test'
const BASE = `${ORIGIN}/folio`

/** Answered by *something* — anything but a 404 means the path is routed. */
const routed = async (path: string): Promise<boolean> => {
  const res = await SELF.fetch(`${ORIGIN}${path}`)
  return res.status !== 404
}

describe('the /api partition', () => {
  /**
   * Every internal route this spec moved. If one of these 404s, it was missed by
   * the prefix move; if its bare twin answers, the move was not a move.
   */
  const INTERNAL = [
    '/folio/api/schema',
    '/folio/api/me',
    '/folio/api/stories',
    '/folio/api/documents',
    '/folio/api/search',
    '/folio/api/assets',
    '/folio/api/redirects',
    // `scheduled-publishing.md`. Internal, so it may change shape in any commit —
    // and deliberately *not* `{base}/api/v1/schedules`, which would be a promise to
    // somebody's script about a surface nothing outside the admin reads yet.
    '/folio/api/schedules',
    '/folio/api/content',
    '/folio/api/migrations',
    '/folio/api/audit',
  ]

  /**
   * `users` and `tokens` are internal too, and are **not** in the list above: this
   * worker runs `auth: 'open'`, where the whole identity surface 404s on purpose
   * because there are no accounts to administer. `auth-http.test.ts` addresses both
   * off an `${BASE}/api` constant under a session fixture, so they fail there if
   * either one is ever left behind on the bare mount.
   */

  it('answers every internal route under /api', async () => {
    for (const path of INTERNAL) {
      expect([path, await routed(path)]).toEqual([path, true])
    }
  })

  it('no longer answers any of them on the bare mount', async () => {
    // The whole point of the move: these paths belong to screens now, and a screen
    // is served by the shell's wildcard as HTML. So "not JSON any more" is the
    // assertion, not "404" — see the shell test below.
    for (const path of INTERNAL) {
      const bare = path.replace('/folio/api/', '/folio/')
      const res = await SELF.fetch(`${ORIGIN}${bare}`)
      const type = res.headers.get('content-type') ?? ''
      expect([bare, type.includes('application/json')]).toEqual([bare, false])
    }
  })

  /**
   * Stated as an **allow-list over the versioned surface**, which is the only form
   * of this check that works.
   *
   * The first two attempts were "no internal name appears under a version", and
   * both were wrong for the same reason: `schema` and `documents` exist on *both*
   * surfaces deliberately. The internal `/api/schema` is ungated because the admin
   * bundle needs the manifest before it can render its own sign-in prompt; the
   * contract's `/api/v1/schema` is gated behind `READ` because a script reading it
   * is a credentialed caller. `documents` is two genuinely different shapes: the
   * admin's unrouted-document list, and `collections.md`'s published-content query.
   *
   * So the invariant is not "these names are exclusive" — it is **the v1 surface is
   * exactly this list**. A new internal route cannot leak into it, because anything
   * not named here has to 404 under `/api/v1`.
   */
  const V1_SEGMENTS = ['schema', 'documents', 'assets', 'search']

  it('keeps the v1 surface to exactly its documented segments', async () => {
    for (const path of INTERNAL) {
      const name = path.slice('/folio/api/'.length)
      if (V1_SEGMENTS.includes(name)) continue
      for (const version of ['v1', 'v2']) {
        const versioned = `/folio/api/${version}/${name}`
        expect([versioned, await routed(versioned)]).toEqual([versioned, false])
      }
    }
  })

  /**
   * The internal routes that only answer `POST`, so `routed()` above cannot see
   * them: an unmatched *method* falls through to the `/api/*` terminator and 404s
   * exactly as an unmatched path does.
   *
   * They belong here for one reason — a version segment is a promise, and
   * `{base}/api/bulk/*` writes to every document in a selection. Adding
   * `{base}/api/v1/bulk/publish` by reflex has to fail CI.
   */
  const INTERNAL_POST = [
    '/folio/api/migrate',
    '/folio/api/schedules/run',
    // `bulk-writes.md`. Five paths rather than one `/bulk/:action`, because each
    // carries its single-document twin's gate.
    '/folio/api/bulk/publish',
    '/folio/api/bulk/unpublish',
    '/folio/api/bulk/duplicate',
    '/folio/api/bulk/move',
    '/folio/api/bulk/delete',
  ]

  const posted = async (path: string): Promise<number> =>
    (await SELF.fetch(`${ORIGIN}${path}`, { method: 'POST' })).status

  it('answers every internal POST route, and answers none of them to a GET', async () => {
    for (const path of INTERNAL_POST) {
      // Anything but 404 means routed: a bulk route with no body is a 400.
      expect([path, await posted(path)]).not.toEqual([path, 404])
      expect([path, await routed(path)]).toEqual([path, false])
    }
  })

  it('keeps the internal POST routes off the versioned surface', async () => {
    for (const path of INTERNAL_POST) {
      const name = path.slice('/folio/api/'.length)
      for (const version of ['v1', 'v2']) {
        const versioned = `/folio/api/${version}/${name}`
        expect([versioned, await posted(versioned)]).toEqual([versioned, 404])
      }
    }
  })

  it('has no v2 at all, so a promise has not been made twice', async () => {
    for (const name of V1_SEGMENTS) {
      const path = `/folio/api/v2/${name}`
      expect([path, await routed(path)]).toEqual([path, false])
    }
  })

  it('answers the v1 contract, which is the surface that does not move', async () => {
    expect(await routed('/folio/api/v1/documents')).toBe(true)
  })

  /**
   * `mcp` is **not** an `/api` segment at all, and that is decision 8 of
   * `docs/specs/platform/mcp-server.md` rather than an oversight: every route
   * under `/api` answers `errors.ts`'s single envelope, and `{base}/mcp` answers
   * JSON-RPC — a 200 carrying an `error` object with its own code space. One
   * prefix with two error envelopes is exactly the confusion this file exists to
   * prevent, so it lives on the bare mount and both `/api` spellings 404.
   *
   * It is also deliberately **unversioned**: MCP negotiates its own version in
   * `initialize` and tools are discovered per session, so a version segment here
   * would be a second ledger tracking a protocol that already has one.
   */
  it('keeps {base}/mcp off the /api partition, versioned or not', async () => {
    for (const path of ['/folio/api/mcp', '/folio/api/v1/mcp', '/folio/api/v2/mcp']) {
      expect([path, await posted(path)]).toEqual([path, 404])
      expect([path, await routed(path)]).toEqual([path, false])
    }
  })

  it('answers POST {base}/mcp on the bare mount', async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ jsonrpc: string; result: { serverInfo: { name: string } } }>()
    expect(body.jsonrpc).toBe('2.0')
    expect(body.result.serverInfo.name).toBe('folio')
  })

  it('answers a GET on it with 405 and Allow: POST, not the shell’s HTML', async () => {
    const res = await SELF.fetch(`${BASE}/mcp`)
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('answers an unmatched /api path with a JSON 404, not the shell’s HTML', async () => {
    // The bug this file found. The shell's wildcard covers every unmatched bare
    // path; without an explicit `/api/*` terminator it covered unmatched *API*
    // paths too, so a typo'd fetch got 200 and an HTML body, and failed inside
    // `res.json()` with a syntax error about `<!doctype`.
    for (const path of ['/folio/api/nope', '/folio/api/v1/nope', '/folio/api/v1/document']) {
      const res = await SELF.fetch(`${ORIGIN}${path}`)
      expect([path, res.status]).toEqual([path, 404])
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = await res.json<{ error: { code: string } }>()
      expect(body.error.code).toBe('not_found')
    }
  })
})

describe('the bare mount', () => {
  // The sign-in flow is asserted bare in `auth-login.test.ts` and
  // `auth-http.test.ts`, which build their own session fixtures — this worker runs
  // `auth: 'open'`, where `/login` 404s on purpose because there is nothing to sign
  // in to. Both of those suites address it off a bare `BASE`, so they fail if it
  // ever moves under `/api`.

  it('serves an asset’s bytes, whose URL is baked into published HTML', async () => {
    // Not asserting a hit — no asset is seeded here. Asserting it is *routed*: a
    // 404 would mean the path moved, and `Resolution.assetBase` points at it from
    // inside every rendered page.
    const res = await SELF.fetch(`${BASE}/asset/ast_missing`)
    expect(res.status).not.toBe(404)
  })

  it('serves the shell at the root and at an unknown path', async () => {
    for (const path of ['/folio', '/folio/content', '/folio/nope/at/all']) {
      const res = await SELF.fetch(`${ORIGIN}${path}`)
      expect([path, res.status]).toEqual([path, 200])
      expect(res.headers.get('content-type')).toContain('text/html')
    }
  })

  it('gives the shell the two boot values it needs, and nothing more', async () => {
    const html = await (await SELF.fetch(`${BASE}/content`)).text()
    // `base` for screens and public bytes, `apiBase` for JSON. They were one field
    // until the move, and four of that field's uses turned out not to be JSON.
    expect(html).toContain('"base":"/folio"')
    expect(html).toContain('"apiBase":"/folio/api"')
  })
})
