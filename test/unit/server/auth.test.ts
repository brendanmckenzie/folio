import { describe, expect, it } from 'vitest'
import {
  clearSessionCookies,
  cookieName,
  PLAIN_COOKIE,
  readCookie,
  readSessionCookie,
  SECURE_COOKIE,
  serialiseCookie,
} from '../../../src/server/auth/cookie'
import { resolveAuth, screenScopes } from '../../../src/server/auth/config'
import {
  actorString,
  ADMIN,
  allows,
  atLeast,
  EDIT,
  hasScope,
  isRole,
  isScope,
  MANAGE,
  parseScopes,
  PUBLISH,
  READ,
  READ_DRAFT,
  refusalOf,
  ROLES,
  type Actor,
  type Role,
} from '../../../src/server/auth/roles'
import { bearerToken } from '../../../src/server/auth/tokens'
import { safeNext } from '../../../src/server/validate'

/**
 * The pure half of identity and access: the cookie-name rule, the role and scope
 * predicates, and the construction-time check that makes `auth: 'open'`
 * something a host has to write rather than something it can forget.
 *
 * These are here rather than in a workers suite because none of them touch D1 or
 * a Request. The cookie-name rule in particular is worth testing on its own: it
 * is the difference between "works deployed, never works locally" and the
 * reverse, and neither failure is visible from a passing HTTP test on one scheme.
 */

const user = (role: Role): Actor => ({
  kind: 'user',
  id: 'usr_abc',
  name: 'Ann',
  colour: '#123456',
  role,
  session: 'sha',
  expiresAt: 0,
})

describe('the session cookie name', () => {
  it('is __Host- prefixed on https and plain otherwise', () => {
    expect(cookieName('https://example.com/folio/edit')).toBe(SECURE_COOKIE)
    // `wrangler dev` serves http://localhost, where a __Host- cookie is refused
    // by the browser outright — so a single hard-coded name would mean auth that
    // can never be exercised locally.
    expect(cookieName('http://localhost:5199/folio/edit')).toBe(PLAIN_COOKIE)
  })

  it('reads either name on the way in, preferring the prefixed one', () => {
    expect(readSessionCookie(`${PLAIN_COOKIE}=plain`)).toBe('plain')
    expect(readSessionCookie(`${SECURE_COOKIE}=secure`)).toBe('secure')
    // A developer who moved from localhost to a preview URL can be holding
    // both. The __Host- one can only have been set by this exact host over
    // HTTPS, so it wins.
    expect(readSessionCookie(`${PLAIN_COOKIE}=plain; ${SECURE_COOKIE}=secure`)).toBe('secure')
  })

  it('returns null for an absent, empty or unrelated cookie', () => {
    expect(readSessionCookie(undefined)).toBeNull()
    expect(readSessionCookie('')).toBeNull()
    expect(readSessionCookie('other=1; another=2')).toBeNull()
    expect(readSessionCookie(`${PLAIN_COOKIE}=`)).toBeNull()
  })

  it('does not confuse a cookie whose name merely ends with ours', () => {
    expect(readCookie(`not_${PLAIN_COOKIE}=nope`, PLAIN_COOKIE)).toBeNull()
  })
})

describe('serialising the cookie', () => {
  it('is HttpOnly, SameSite=Lax and Path=/, with Secure only on https', () => {
    const secure = serialiseCookie('https://example.com', SECURE_COOKIE, 'abc', { maxAge: 60 })
    expect(secure).toContain('HttpOnly')
    expect(secure).toContain('SameSite=Lax')
    expect(secure).toContain('Path=/')
    expect(secure).toContain('Secure')
    expect(secure).toContain('Max-Age=60')

    // A `Secure` cookie on http://localhost would simply never be stored.
    expect(serialiseCookie('http://localhost:5199', PLAIN_COOKIE, 'abc')).not.toContain('Secure')
  })

  it('clears both names on https, so a stale plain cookie cannot outlive a sign-out', () => {
    const https = clearSessionCookies('https://example.com')
    expect(https).toHaveLength(2)
    expect(https[0]).toContain(SECURE_COOKIE)
    expect(https[0]).toContain('Secure')
    expect(https[1]).toContain(PLAIN_COOKIE)
    expect(https.every((c) => c.includes('Max-Age=0'))).toBe(true)

    // On http there is no prefixed cookie to have been set in the first place.
    expect(clearSessionCookies('http://localhost:5199')).toHaveLength(1)
  })
})

describe('roles', () => {
  it('is a total order, so a route can declare one minimum', () => {
    expect(ROLES).toEqual(['viewer', 'editor', 'publisher', 'admin'])
    expect(atLeast('admin', 'viewer')).toBe(true)
    expect(atLeast('publisher', 'publisher')).toBe(true)
    expect(atLeast('editor', 'publisher')).toBe(false)
    expect(atLeast('viewer', 'editor')).toBe(false)
  })

  it('screens an unknown role', () => {
    expect(isRole('editor')).toBe(true)
    expect(isRole('owner')).toBe(false)
    expect(isRole(undefined)).toBe(false)
  })
})

describe('scopes', () => {
  it('grants what a scope implies, not only the scope itself', () => {
    expect(hasScope(['content:write'], 'content:read')).toBe(true)
    expect(hasScope(['content:write'], 'content:read:draft')).toBe(true)
    // Publishing means reading the draft it is about to publish, but says
    // nothing about writing one.
    expect(hasScope(['publish'], 'content:read:draft')).toBe(true)
    expect(hasScope(['publish'], 'content:write')).toBe(false)
    expect(hasScope(['admin'], 'assets:write')).toBe(true)
    // And nothing implies assets:write except admin.
    expect(hasScope(['content:write'], 'assets:write')).toBe(false)
    expect(hasScope([], 'content:read')).toBe(false)
  })

  it('drops a stored scope this build no longer declares rather than throwing', () => {
    expect(parseScopes('["content:read","legacy:everything"]')).toEqual(['content:read'])
    expect(parseScopes('not json')).toEqual([])
    expect(parseScopes('{"scopes":[]}')).toEqual([])
    expect(isScope('content:read')).toBe(true)
    expect(isScope('content:destroy')).toBe(false)
    expect(screenScopes(['publish', 3, 'nope'])).toEqual(['publish'])
    expect(screenScopes('publish')).toEqual([])
  })
})

describe('allows', () => {
  it('refuses a null actor outright', () => {
    // The `auth: 'open'` bypass lives in the middleware, deliberately, so this
    // file can never be the reason an unauthenticated request got through.
    expect(allows(null, READ)).toBe(false)
  })

  it('gates a person on their role and a token on its scopes', () => {
    expect(allows(user('viewer'), READ_DRAFT)).toBe(true)
    expect(allows(user('viewer'), EDIT)).toBe(false)
    expect(allows(user('editor'), EDIT)).toBe(true)
    // create / delete / move is a publisher act, per the role table.
    expect(allows(user('editor'), MANAGE)).toBe(false)
    expect(allows(user('publisher'), PUBLISH)).toBe(true)
    expect(allows(user('publisher'), ADMIN)).toBe(false)
    expect(allows(user('admin'), ADMIN)).toBe(true)

    const token: Actor = { kind: 'token', id: 'sha', name: 'import', scopes: ['content:read'] }
    expect(allows(token, READ)).toBe(true)
    expect(allows(token, EDIT)).toBe(false)
  })

  it('names the missing scope for a token and the required role for a person', () => {
    const token: Actor = { kind: 'token', id: 'sha', name: 'import', scopes: ['content:read'] }
    expect(refusalOf(token, EDIT)).toContain("'content:write'")
    expect(refusalOf(user('editor'), PUBLISH)).toContain('publisher')
  })
})

describe('the actor string history records', () => {
  it('is the user id for a person and token:<name> for a token', () => {
    expect(actorString(user('editor'))).toBe('usr_abc')
    // Never a person who was not there.
    expect(actorString({ kind: 'token', id: 'sha', name: 'import-script', scopes: [] })).toBe(
      'token:import-script',
    )
    expect(actorString(null)).toBeNull()
  })
})

describe('bearer parsing', () => {
  it('accepts any case of the scheme and nothing else', () => {
    expect(bearerToken('Bearer folio_abc')).toBe('folio_abc')
    expect(bearerToken('bearer folio_abc')).toBe('folio_abc')
    expect(bearerToken('BEARER   folio_abc')).toBe('folio_abc')
    expect(bearerToken('Basic folio_abc')).toBeNull()
    expect(bearerToken('folio_abc')).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })
})

describe('safeNext: the login page cannot be turned into an open redirect', () => {
  const FALLBACK = '/folio/edit'

  it('keeps a same-origin path', () => {
    expect(safeNext('/folio/edit/sty_home', FALLBACK)).toBe('/folio/edit/sty_home')
    expect(safeNext('/folio/edit?rail=history', FALLBACK)).toBe('/folio/edit?rail=history')
  })

  it('refuses anything that could leave the site', () => {
    // The case a bare startsWith('/') check waves through: browsers read this as
    // a protocol-relative URL to another host.
    expect(safeNext('//evil.example/steal', FALLBACK)).toBe(FALLBACK)
    expect(safeNext('https://evil.example', FALLBACK)).toBe(FALLBACK)
    // Some browsers normalise a backslash to a slash, so this is the same trick
    // wearing a different character.
    expect(safeNext('/\\evil.example', FALLBACK)).toBe(FALLBACK)
    expect(safeNext('folio/edit', FALLBACK)).toBe(FALLBACK)
    expect(safeNext('javascript:alert(1)', FALLBACK)).toBe(FALLBACK)
  })

  it('falls back for absent, empty and absurdly long values', () => {
    expect(safeNext(undefined, FALLBACK)).toBe(FALLBACK)
    expect(safeNext(null, FALLBACK)).toBe(FALLBACK)
    expect(safeNext('', FALLBACK)).toBe(FALLBACK)
    expect(safeNext(`/${'x'.repeat(600)}`, FALLBACK)).toBe(FALLBACK)
  })
})

describe('resolveAuth: construction refuses ambiguity', () => {
  it('throws when `auth` is absent, naming the deliberate escape hatch', () => {
    expect(() => resolveAuth(undefined)).toThrow(/auth. must be configured/)
    expect(() => resolveAuth(undefined)).toThrow(/auth: 'open'/)
  })

  it("accepts 'open' as the deliberate, written-out choice", () => {
    expect(resolveAuth('open')).toEqual({ mode: 'open' })
  })

  it('refuses an empty provider list', () => {
    expect(() => resolveAuth({ providers: [] })).toThrow(/at least one provider/)
  })

  it('refuses two providers sharing an id', () => {
    const provider = { id: 'magic', label: 'Email', redirect: false, send: () => {} }
    expect(() => resolveAuth({ providers: [provider, { ...provider }] })).toThrow(
      /share the id 'magic'/,
    )
  })

  it('refuses a non-redirect provider with no way to send anything', () => {
    expect(() =>
      resolveAuth({ providers: [{ id: 'magic', label: 'Email', redirect: false }] }),
    ).toThrow(/redirect flow or supply `send`/)
  })

  it('defaults the session length and the link rate limit', () => {
    const resolved = resolveAuth({
      providers: [{ id: 'magic', label: 'Email', redirect: false, send: () => {} }],
    })
    expect(resolved).toMatchObject({ mode: 'session', sessionDays: 30, linksPerHour: 5 })
  })

  it('refuses a nonsensical session length', () => {
    const providers = [{ id: 'magic', label: 'Email', redirect: false, send: () => {} }]
    expect(() => resolveAuth({ providers, sessionDays: 0 })).toThrow(/positive number of days/)
  })
})
