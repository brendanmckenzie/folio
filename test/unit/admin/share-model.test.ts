import { describe, expect, it } from 'vitest'
import type { Me } from '../../../src/admin/me'
import { OPEN } from '../../../src/admin/me'
import {
  expiresPhrase,
  openedPhrase,
  shareBody,
  shareDays,
  shareRefusal,
  sharedBy,
} from '../../../src/admin/ui/screens/share-model'

/** The "Share a preview" dialog's decisions (`draft-sharing.md`, "No admin UI"). */

const as = (role: 'editor' | 'publisher'): Me => ({
  mode: 'session',
  actor: { kind: 'user', id: 'usr_a', name: 'Ann', colour: '#123456', role },
  loginUrl: '/folio/login',
})

describe('shareRefusal', () => {
  it('is the role first, then the missing page', () => {
    expect(shareRefusal(as('editor'), { path: 'about' })).toBe('Your role (editor) may not publish')
    // The role is the one the editor cannot fix by opening another document.
    expect(shareRefusal(as('editor'), { path: null })).toBe('Your role (editor) may not publish')
  })

  it('disables an unrouted document with a reason, for someone who may share', () => {
    expect(shareRefusal(as('publisher'), { path: null })).toMatch(/no page/)
    expect(shareRefusal(OPEN, { path: null })).toMatch(/no page/)
  })

  it('does not refuse a routed page, including the home page whose path is empty', () => {
    expect(shareRefusal(as('publisher'), { path: '' })).toBeUndefined()
    expect(shareRefusal(as('publisher'), { path: 'about' })).toBeUndefined()
  })
})

describe('shareDays and shareBody', () => {
  it('defaults an empty field to 7 and bounds the rest to 1 to 90', () => {
    expect(shareDays('')).toEqual({ ok: true, days: 7 })
    expect(shareDays('1')).toEqual({ ok: true, days: 1 })
    expect(shareDays('90')).toEqual({ ok: true, days: 90 })
    expect(shareDays('0').ok).toBe(false)
    expect(shareDays('91').ok).toBe(false)
    expect(shareDays('2.5').ok).toBe(false)
    expect(shareDays('abc').ok).toBe(false)
  })

  it('omits a blank note and trims a real one', () => {
    expect(shareBody('  ', 7)).toEqual({ expiresInDays: 7 })
    expect(shareBody(' For Rachel ', 3)).toEqual({ expiresInDays: 3, note: 'For Rachel' })
  })
})

describe('how a row reads', () => {
  const now = new Date(2026, 9, 13, 15, 0).getTime()
  const at = (days: number, hour = 9) => new Date(2026, 9, 13 - days, hour, 0).getTime()

  it('says whether and when it was opened', () => {
    expect(openedPhrase({ views: 0, lastViewedAt: null }, now)).toBe('not opened yet')
    expect(openedPhrase({ views: 3, lastViewedAt: at(1, 22) }, now)).toBe(
      'opened 3 times, last yesterday',
    )
    expect(openedPhrase({ views: 1, lastViewedAt: at(0) }, now)).toBe('opened once, last today')
    expect(openedPhrase({ views: 2, lastViewedAt: at(5) }, now)).toBe(
      'opened 2 times, last 5 days ago',
    )
  })

  it('says when it stops working', () => {
    const later = (days: number) => ({ expiresAt: new Date(2026, 9, 13 + days, 9, 0).getTime() })
    expect(expiresPhrase(later(0), now)).toBe('expires today')
    expect(expiresPhrase(later(1), now)).toBe('expires tomorrow')
    expect(expiresPhrase(later(6), now)).toBe('expires in 6 days')
  })

  it('names the creator: you, then their real name, then a token or a removed account', () => {
    const row = (createdBy: string | null, createdByName: string | null) => ({
      createdBy,
      createdByName,
    })
    expect(sharedBy(row('usr_a', 'Ann'), 'usr_a')).toBe('You')
    expect(sharedBy(row('usr_b', 'Ben'), 'usr_a')).toBe('Ben')
    expect(sharedBy(row('token:import', null), 'usr_a')).toBe('token:import')
    expect(sharedBy(row('usr_gone', null), 'usr_a')).toBe('A removed account')
    expect(sharedBy(row(null, null), null)).toBe('Unknown')
  })
})
