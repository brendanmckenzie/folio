import { describe, expect, it } from 'vitest'
import type { Me } from '../../../src/admin/me'
import {
  aaguidVendor,
  accountGate,
  algLabel,
  canEnrol,
  eventLabel,
  passkeyAvailability,
  passkeyCapReason,
  providerLabel,
  since,
  userAgentLabel,
} from '../../../src/admin/ui/screens/account-model'

/**
 * The Your account screen's arithmetic — `docs/specs/foundation/passkeys.md`
 * decision 6. Nothing here mounts a component, per the admin's convention
 * (`vitest.config.ts`'s unit project is `environment: 'node'`), which is why the
 * screen's decisions live in `account-model.ts` and `Account.tsx` only draws them.
 */

const user = (extra: Partial<Me> = {}): Me => ({
  mode: 'session',
  actor: { kind: 'user', id: 'usr_a', name: 'Ann', colour: '#3b6ff5', role: 'editor' },
  loginUrl: '/folio/login',
  ...extra,
})

const OPEN: Me = { mode: 'open', actor: null, loginUrl: '' }
const anonymous: Me = { mode: 'session', actor: null, loginUrl: '/folio/login' }
const token: Me = {
  mode: 'session',
  actor: { kind: 'token', id: 'sha', name: 'import-script', scopes: ['admin'] },
  loginUrl: '/folio/login',
}

describe('accountGate', () => {
  it('has no account to show on a deployment with no accounts at all', () => {
    expect(accountGate(OPEN)).toEqual({ kind: 'open' })
  })

  it('asks an anonymous visitor to sign in first', () => {
    expect(accountGate(anonymous)).toEqual({ kind: 'anonymous', loginUrl: '/folio/login' })
  })

  it('refuses a token: it is not a person with a browser to sign out', () => {
    expect(accountGate(token)).toEqual({ kind: 'token' })
  })

  it('is ok for anyone signed in, whatever their role', () => {
    const gate = accountGate(user())
    expect(gate.kind).toBe('ok')
    expect(gate.kind === 'ok' && gate.self.name).toBe('Ann')
  })
})

describe('passkeyAvailability and canEnrol', () => {
  it('is unavailable, not forbidden, when the deployment never listed passkeys()', () => {
    // `'passkeys' in me` is false here, which is the whole distinction this type
    // exists to make: there is nothing to add and nothing to explain.
    expect(passkeyAvailability(user())).toEqual({ kind: 'unavailable' })
    expect(canEnrol(user())).toBe(false)
  })

  it('is forbidden with the server’s own reason under an enforced domain', () => {
    const me = user({
      passkeys: { allowed: false, reason: 'Signing in for client.com goes through oidc.' },
    })
    expect(passkeyAvailability(me)).toEqual({
      kind: 'forbidden',
      reason: 'Signing in for client.com goes through oidc.',
    })
    expect(canEnrol(me)).toBe(false)
  })

  it('is available when the deployment offers it and this person may enrol', () => {
    const me = user({ passkeys: { allowed: true } })
    expect(passkeyAvailability(me)).toEqual({ kind: 'available' })
    expect(canEnrol(me)).toBe(true)
  })
})

describe('aaguidVendor', () => {
  it('names the common half-dozen', () => {
    expect(aaguidVendor('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4')).toBe('Google Password Manager')
    expect(aaguidVendor('dd4ec289-e01d-41c9-bb89-70fa845d4bf2')).toBe('iCloud Keychain')
  })

  it('is case-insensitive, since an authenticator’s own casing is not this file’s business', () => {
    expect(aaguidVendor('EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4')).toBe('Google Password Manager')
  })

  it('is null for an authenticator that zeroed it, and for one this map does not know', () => {
    expect(aaguidVendor(null)).toBeNull()
    expect(aaguidVendor('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('algLabel', () => {
  it('names the two algorithms the options route ever asks for', () => {
    expect(algLabel(-7)).toBe('ES256')
    expect(algLabel(-257)).toBe('RS256')
  })

  it('falls back to the raw number for anything else, since the schema has no CHECK', () => {
    expect(algLabel(-8)).toBe('alg -8')
  })
})

describe('passkeyCapReason', () => {
  it('refuses at the limit', () => {
    expect(passkeyCapReason(10, 10)).toBeTruthy()
  })

  it('allows it under the limit', () => {
    expect(passkeyCapReason(9, 10)).toBeUndefined()
    expect(passkeyCapReason(0, 10)).toBeUndefined()
  })
})

describe('providerLabel', () => {
  it('names a passkey and an emailed link in plain words', () => {
    expect(providerLabel('passkey')).toBe('Passkey')
    expect(providerLabel('mail')).toBe('Emailed link')
  })

  it('says Unknown for a session minted before spec 28, rather than blank', () => {
    expect(providerLabel(null)).toBe('Unknown')
  })

  it('falls back to the identifier for a redirect or trusted provider', () => {
    expect(providerLabel('okta')).toBe('okta')
  })
})

describe('userAgentLabel', () => {
  it('passes the raw string through', () => {
    expect(userAgentLabel('Mozilla/5.0 (Macintosh)')).toBe('Mozilla/5.0 (Macintosh)')
  })

  it('says Unknown browser for one the browser did not send', () => {
    expect(userAgentLabel(null)).toBe('Unknown browser')
  })
})

describe('eventLabel', () => {
  it('names a passkey sign-in specifically', () => {
    expect(eventLabel({ kind: 'sign_in', provider: 'passkey' })).toBe('Signed in with Passkey')
  })

  it('names a sign-in with no provider recorded', () => {
    expect(eventLabel({ kind: 'sign_in', provider: null })).toBe('Signed in')
  })

  it('names every kind this spec adds', () => {
    expect(eventLabel({ kind: 'passkey_removed', provider: null })).toContain('passkey')
    expect(eventLabel({ kind: 'passkeys_removed', provider: null })).toContain('admin')
    expect(eventLabel({ kind: 'sessions_revoked', provider: null })).toContain('other browsers')
    expect(eventLabel({ kind: 'passkey_rejected', provider: null })).toContain('refused')
  })

  it('reads back a kind this build has not been taught yet as data, not a crash', () => {
    expect(eventLabel({ kind: 'something_new', provider: null })).toBe('something_new')
  })
})

describe('since', () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0)

  it('says never for a passkey that has never been used to sign in', () => {
    expect(since(null, now)).toBe('never')
  })

  it('coarsens like every other list in this admin', () => {
    expect(since(now - 30_000, now)).toBe('just now')
    expect(since(now - 3 * 86_400_000, now)).toBe('3d ago')
  })
})
