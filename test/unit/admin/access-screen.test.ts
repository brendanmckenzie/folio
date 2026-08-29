import { describe, expect, it } from 'vitest'
import type { Me } from '../../../src/admin/me'
import {
  accessGate,
  accessQuery,
  CUSTOM_PRESET,
  DEFAULT_PRESET,
  effectiveScopes,
  expiryDays,
  grantedBy,
  isSelf,
  minimalScopes,
  mintRefusal,
  parseAccessUrl,
  presetOf,
  revokeRefusal,
  ROLE_MEANING,
  ROLE_OPTIONS,
  SCOPE_MEANING,
  SCOPE_OPTIONS,
  scopesOfPreset,
  since,
  TOKEN_PRESETS,
  toggleScope,
  tokenStatus,
  tokenStatusTone,
} from '../../../src/admin/ui/screens/access-model'
import { ROLES, SCOPES, hasScope } from '../../../src/server/auth/roles'

/**
 * The Access screen's arithmetic — `docs/ui-architecture.md`'s port phase 5.
 *
 * Nothing here mounts a component, per the admin's convention
 * (`vitest.config.ts`'s unit project is `environment: 'node'`), which is exactly
 * why the screen's decisions live in `access-model.ts`. The interesting half is the
 * scope control: the surface this replaces rendered six identifier-labelled
 * checkboxes and had no way to say that ticking one already grants three, so the
 * implication tests below are the ones that pin the actual design rather than the
 * styling.
 */

/* ---------------------------------------------------------------- the gate --- */

const admin: Me = {
  mode: 'session',
  actor: { kind: 'user', id: 'usr_a', name: 'Ada', colour: '#3b6ff5', role: 'admin' },
  loginUrl: '/folio/login',
}

describe('accessGate', () => {
  it('lets an admin through and hands back who they are', () => {
    const gate = accessGate(admin)
    expect(gate.kind).toBe('ok')
    if (gate.kind === 'ok') expect(gate.self.id).toBe('usr_a')
  })

  it('names `auth: open` as its own case, not as a refusal', () => {
    // The routes behind this screen 404 under `auth: 'open'` — the surface does not
    // exist rather than being forbidden — so a screen that said "you may not" would
    // be describing a permission system that is not there.
    expect(accessGate({ mode: 'open', actor: null, loginUrl: '' }).kind).toBe('open')
  })

  it('tells "not signed in" apart from "not allowed", and carries the login URL', () => {
    const gate = accessGate({ mode: 'session', actor: null, loginUrl: '/folio/login' })
    expect(gate.kind).toBe('anonymous')
    if (gate.kind === 'anonymous') expect(gate.loginUrl).toBe('/folio/login')
  })

  it('refuses every role below admin, naming the role and the one required', () => {
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      const gate = accessGate({ ...admin, actor: { ...admin.actor, role } as never })
      expect(gate.kind).toBe('refused')
      if (gate.kind === 'refused') {
        expect(gate.reason).toContain(role)
        expect(gate.reason).toContain('admin')
      }
    }
  })

  it('refuses a token even one holding the admin scope', () => {
    // `requireAccess(ADMIN)` would allow it, so this is the admin's own rule rather
    // than the server's: a token is not a person with a cursor, and the socket
    // refuses one outright (4004).
    const gate = accessGate({
      mode: 'session',
      actor: { kind: 'token', id: 'tok_a', name: 'import', scopes: ['admin'] },
      loginUrl: '/folio/login',
    })
    expect(gate.kind).toBe('refused')
    if (gate.kind === 'refused') expect(gate.reason).toContain('token')
  })
})

describe('isSelf', () => {
  it('is what stops somebody removing their own admin', () => {
    expect(isSelf('usr_a', 'usr_a')).toBe(true)
    expect(isSelf('usr_b', 'usr_a')).toBe(false)
  })
})

/* ------------------------------------------------------------------ scopes --- */

describe('effectiveScopes', () => {
  it('closes over the implication table rather than restating it', () => {
    // The property, not the answer: whatever `auth/roles.ts` says `content:write`
    // implies is what this returns, so the two cannot drift.
    expect(effectiveScopes(['content:write'])).toEqual(
      SCOPES.filter((s) => hasScope(['content:write'], s)),
    )
  })

  it('makes content:write grant both reads', () => {
    expect(effectiveScopes(['content:write'])).toContain('content:read')
    expect(effectiveScopes(['content:read:draft'])).toContain('content:read')
  })

  it('makes admin grant everything', () => {
    expect(effectiveScopes(['admin'])).toEqual([...SCOPES])
  })

  it('keeps assets:write out of every content shape, because it implies nothing', () => {
    expect(effectiveScopes(['content:write'])).not.toContain('assets:write')
    expect(effectiveScopes(['publish'])).not.toContain('assets:write')
    // And the converse, which is the reason scopes are not a total order the way
    // roles are: uploading a file says nothing about writing a document.
    expect(effectiveScopes(['assets:write'])).toEqual(['assets:write'])
  })

  it('does not let publish imply writing the draft it publishes', () => {
    expect(effectiveScopes(['publish'])).toContain('content:read:draft')
    expect(effectiveScopes(['publish'])).not.toContain('content:write')
  })
})

describe('grantedBy', () => {
  it('names what already grants a scope, which is what a disabled box says', () => {
    expect(grantedBy('content:read', ['content:write'])).toBe('content:write')
    expect(grantedBy('content:read:draft', ['publish'])).toBe('publish')
  })

  it('answers null for a scope holding itself, so its own box stays clickable', () => {
    expect(grantedBy('content:write', ['content:write'])).toBe(null)
    expect(grantedBy('assets:write', ['assets:write'])).toBe(null)
  })

  it('answers null for a scope nothing selected reaches', () => {
    expect(grantedBy('publish', ['content:write', 'assets:write'])).toBe(null)
  })

  it('makes admin the thing that grants all five others', () => {
    for (const scope of SCOPES.filter((s) => s !== 'admin')) {
      expect(grantedBy(scope, ['admin'])).toBe('admin')
    }
  })
})

describe('minimalScopes', () => {
  it('drops what another selection already implies', () => {
    expect(minimalScopes(['content:read', 'content:read:draft', 'content:write'])).toEqual([
      'content:write',
    ])
  })

  it('collapses everything under admin', () => {
    expect(minimalScopes([...SCOPES])).toEqual(['admin'])
  })

  it('keeps two scopes neither of which reaches the other', () => {
    expect(minimalScopes(['assets:write', 'content:write'])).toEqual([
      'content:write',
      'assets:write',
    ])
  })

  it('is idempotent and de-duplicates', () => {
    const once = minimalScopes(['publish', 'publish', 'content:read'])
    expect(once).toEqual(['publish'])
    expect(minimalScopes(once)).toEqual(once)
  })

  it('returns declaration order, so set comparison needs no sort', () => {
    expect(minimalScopes(['assets:write', 'publish', 'content:write'])).toEqual([
      'content:write',
      'publish',
      'assets:write',
    ])
  })
})

describe('toggleScope', () => {
  it('adds and removes', () => {
    expect(toggleScope([], 'publish')).toEqual(['publish'])
    expect(toggleScope(['publish'], 'publish')).toEqual([])
  })

  it('canonicalises on the way in, so a redundant tick stores nothing extra', () => {
    // Ticking `content:write` over a `content:read` selection: the read box becomes
    // implied and the stored list says so.
    expect(toggleScope(['content:read'], 'content:write')).toEqual(['content:write'])
  })

  it('collapses the rest when admin goes on', () => {
    expect(toggleScope(['content:write', 'assets:write'], 'admin')).toEqual(['admin'])
  })

  it('leaves nothing behind when admin goes off', () => {
    // Everything else was dropped when admin was ticked, so unticking it is empty
    // rather than a restored set — and the mint button says so (`mintRefusal`)
    // instead of silently minting a scopeless token the route would 400.
    expect(toggleScope(['admin'], 'admin')).toEqual([])
  })
})

describe('presets', () => {
  it('offers a default that is the narrowest thing there is', () => {
    // The lazy path produces the least dangerous token rather than the most useful
    // one, which is the one decision the old rail's scope control got right.
    expect(scopesOfPreset(DEFAULT_PRESET)).toEqual(['content:read'])
  })

  it('round-trips every preset through presetOf', () => {
    for (const preset of TOKEN_PRESETS) {
      expect(presetOf([...preset.scopes])).toBe(preset.id)
    }
  })

  it('recognises a hand-picked set as the preset it mints the same token as', () => {
    // Ticking the two boxes that make up `import` selects `import`, because the two
    // sets are the same token and telling them apart would be a distinction with no
    // consequence.
    expect(presetOf(['assets:write', 'content:write'])).toBe('import')
    // And the redundant spelling of it, too.
    expect(presetOf(['content:read', 'content:write', 'assets:write'])).toBe('import')
  })

  it('reports custom for a set no preset covers', () => {
    expect(presetOf(['assets:write'])).toBe(CUSTOM_PRESET)
    expect(presetOf([])).toBe(CUSTOM_PRESET)
  })

  it('names one preset that grants everything, and marks only that one dangerous', () => {
    const dangerous = TOKEN_PRESETS.filter((p) => p.danger)
    expect(dangerous).toHaveLength(1)
    expect(dangerous[0]?.scopes).toEqual(['admin'])
  })

  it('declares every preset in minimal form, so the radio group cannot disagree with the boxes', () => {
    for (const preset of TOKEN_PRESETS) {
      expect(minimalScopes(preset.scopes)).toEqual([...preset.scopes])
    }
  })

  it('answers null for an id nothing declares, so a stale URL cannot name a sixth', () => {
    expect(scopesOfPreset('nonesuch')).toBe(null)
    expect(scopesOfPreset(CUSTOM_PRESET)).toBe(null)
  })
})

describe('the vocabulary', () => {
  it('gives every scope a meaning, because the identifier is not a label', () => {
    // The fault this screen exists to fix is as much this as the font size:
    // `content:read:draft` as a checkbox label is unreadable.
    for (const scope of SCOPES) {
      expect(SCOPE_MEANING[scope].label).toBeTruthy()
      expect(SCOPE_MEANING[scope].description).toBeTruthy()
      expect(SCOPE_MEANING[scope].label).not.toContain(':')
    }
  })

  it('offers every declared scope, so adding one to the server surfaces it here', () => {
    expect(SCOPE_OPTIONS).toEqual([...SCOPES])
  })

  it('gives every role a meaning, and offers them weakest first', () => {
    expect(ROLE_OPTIONS).toEqual([...ROLES])
    for (const role of ROLES) expect(ROLE_MEANING[role]).toBeTruthy()
  })
})

describe('mintRefusal', () => {
  it('explains an unnamed token before the click rather than after the 400', () => {
    expect(mintRefusal('  ', ['content:read'])).toBeTruthy()
  })

  it('explains a scopeless one, which TokenCreateBody refuses', () => {
    expect(mintRefusal('import', [])).toBeTruthy()
  })

  it('is silent when the request would be accepted', () => {
    expect(mintRefusal('import', ['content:read'])).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ tokens --- */

describe('tokenStatus', () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0)

  it('reads an ordinary token as active', () => {
    expect(tokenStatus({ revokedAt: null, expiresAt: null }, now)).toBe('active')
    expect(tokenStatus({ revokedAt: null, expiresAt: now + 1000 }, now)).toBe('active')
  })

  it('separates expired from revoked, because the row alone could not say so', () => {
    // `readToken` refuses both identically, so a list that showed only "revoked"
    // described a working credential that had in fact stopped.
    expect(tokenStatus({ revokedAt: null, expiresAt: now - 1 }, now)).toBe('expired')
    expect(tokenStatus({ revokedAt: now - 1, expiresAt: null }, now)).toBe('revoked')
  })

  it('calls the boundary expired, matching readToken’s `expiresAt <= now`', () => {
    expect(tokenStatus({ revokedAt: null, expiresAt: now }, now)).toBe('expired')
  })

  it('prefers revoked over expired, since revocation is the deliberate act', () => {
    expect(tokenStatus({ revokedAt: now - 5000, expiresAt: now - 1 }, now)).toBe('revoked')
  })
})

describe('tokenStatusTone', () => {
  it('leaves the normal case grey', () => {
    // Commitment 1: colour is reserved for state, so the two rows that need looking
    // at are the ones that carry a hue. Green means "complete" and an active token
    // has not completed anything.
    expect(tokenStatusTone('active')).toBe('neutral')
  })

  it('reads red as withdrawal and amber as history', () => {
    expect(tokenStatusTone('revoked')).toBe('danger')
    expect(tokenStatusTone('expired')).toBe('warn')
  })
})

describe('revokeRefusal', () => {
  it('refuses a second revoke, which the route answers 404 for', () => {
    expect(revokeRefusal({ revokedAt: 1 })).toBeTruthy()
  })

  it('allows revoking an expired token, because expiry is not revocation', () => {
    // The hash is only permanently spent once `revoked_at` is set, so a lapsed token
    // is still worth revoking.
    expect(revokeRefusal({ revokedAt: null })).toBeUndefined()
  })
})

describe('expiryDays', () => {
  it('turns the "never" option into an absent key, which is what the body wants', () => {
    expect(expiryDays('')).toBeUndefined()
  })

  it('passes a chosen span through as a whole number of days', () => {
    expect(expiryDays('90')).toBe(90)
    expect(expiryDays('365')).toBe(365)
  })

  it('refuses anything TokenCreateBody would', () => {
    expect(expiryDays('0')).toBeUndefined()
    expect(expiryDays('-30')).toBeUndefined()
    expect(expiryDays('1.5')).toBeUndefined()
    expect(expiryDays('soon')).toBeUndefined()
  })
})

describe('since', () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0)

  it('says never for an account nobody has signed into', () => {
    // Half of a sentence the Signs-in-with column finishes: an invited row has no
    // provider and has never been seen.
    expect(since(null, now)).toBe('never')
  })

  it('borrows Content’s coarsening rather than inventing a second one', () => {
    expect(since(now - 30_000, now)).toBe('just now')
    expect(since(now - 3 * 86_400_000, now)).toBe('3d ago')
  })

  it('switches to a date past a month', () => {
    const stamp = since(now - 120 * 86_400_000, now)
    expect(stamp).not.toMatch(/ago/)
  })
})

/* --------------------------------------------------------------------- URL --- */

describe('the URL', () => {
  it('carries which creation dialog is open, and nothing else', () => {
    expect(parseAccessUrl({ new: 'token' })).toEqual({ open: 'token' })
    expect(parseAccessUrl({ new: 'user' })).toEqual({ open: 'user' })
  })

  it('ignores a value nothing declares', () => {
    expect(parseAccessUrl({ new: 'wat' })).toEqual({ open: null })
    expect(parseAccessUrl({})).toEqual({ open: null })
  })

  it('round-trips, so a link the screen writes is one it can read', () => {
    for (const open of ['user', 'token'] as const) {
      expect(parseAccessUrl(accessQuery({ open }) as Record<string, string>)).toEqual({ open })
    }
  })

  it('writes the closed state as undefined, so it leaves the URL rather than sitting in it', () => {
    expect(accessQuery({ open: null })).toEqual({ new: undefined })
  })
})
