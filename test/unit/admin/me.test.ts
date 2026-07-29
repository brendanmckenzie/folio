import { describe, expect, it } from 'vitest'
import type { Role } from '../../../src/server/auth/roles'
import {
  actorLabel,
  canEdit,
  canManageAccess,
  canManageContent,
  canPublish,
  type Me,
  OPEN,
  whyNot,
} from '../../../src/admin/me'

/**
 * What the admin will offer, given who is signed in.
 *
 * Worth its own tests even though the server is the authority: a wrong answer
 * here is not a security hole (every route re-checks), it is a button that always
 * errors or an editor that looks broken to somebody who has full access.
 */

const user = (role: Role): Me => ({
  mode: 'session',
  actor: { kind: 'user', id: 'usr_a', name: 'Ann', colour: '#123456', role },
  loginUrl: '/folio/login',
})

const token: Me = {
  mode: 'session',
  actor: { kind: 'token', id: 'sha', name: 'import-script', scopes: ['admin'] },
  loginUrl: '/folio/login',
}

const signedOut: Me = { mode: 'session', actor: null, loginUrl: '/folio/login' }

describe('auth: open', () => {
  it('allows everything except the access surface', () => {
    expect(canEdit(OPEN)).toBe(true)
    expect(canPublish(OPEN)).toBe(true)
    expect(canManageContent(OPEN)).toBe(true)
    // The routes 404 there — there is no admin and no way to become one — so
    // offering the rail would be offering a broken screen.
    expect(canManageAccess(OPEN)).toBe(false)
    expect(whyNot(OPEN, 'edit')).toBeUndefined()
    expect(actorLabel(OPEN)).toBeNull()
  })
})

describe('roles', () => {
  it('follows the role table exactly', () => {
    expect([canEdit(user('viewer')), canPublish(user('viewer'))]).toEqual([false, false])
    expect([canEdit(user('editor')), canPublish(user('editor'))]).toEqual([true, false])
    expect([canEdit(user('publisher')), canPublish(user('publisher'))]).toEqual([true, true])
    expect([canEdit(user('admin')), canPublish(user('admin'))]).toEqual([true, true])
  })

  it('reserves creating, deleting and moving for a publisher', () => {
    // All three change what URLs the site serves, which is a publishing act.
    expect(canManageContent(user('editor'))).toBe(false)
    expect(canManageContent(user('publisher'))).toBe(true)
  })

  it('reserves the access surface for an admin', () => {
    expect(canManageAccess(user('publisher'))).toBe(false)
    expect(canManageAccess(user('admin'))).toBe(true)
  })
})

describe('a token in the admin', () => {
  it('can do nothing at all, whatever its scopes', () => {
    // A token is a script, not a person with a cursor; the socket refuses it
    // outright (4004), so an editor driven by one would be an editor that cannot
    // load a document.
    expect(canEdit(token)).toBe(false)
    expect(canPublish(token)).toBe(false)
    expect(canManageAccess(token)).toBe(false)
    expect(actorLabel(token)).toBe('token:import-script')
  })
})

describe('whyNot', () => {
  it('names the role that is in the way, not just "no"', () => {
    expect(whyNot(user('viewer'), 'edit')).toContain('viewer')
    expect(whyNot(user('editor'), 'publish')).toContain('editor')
    // "Why is this greyed out" with no answer is the most annoying possible
    // version of a permissions system.
    expect(whyNot(user('publisher'), 'publish')).toBeUndefined()
    expect(whyNot(signedOut, 'edit')).toBe('Sign in to make changes')
  })
})

describe('actorLabel', () => {
  it('is the display name for a person', () => {
    expect(actorLabel(user('editor'))).toBe('Ann')
    expect(actorLabel(signedOut)).toBeNull()
  })
})
