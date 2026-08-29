import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  afterWrite,
  expectJson,
  expectOk,
  failureOf,
  onUnauthorized,
  signInUrl,
} from '../../../src/admin/api'

const envelope = (message: string, status: number) =>
  new Response(JSON.stringify({ error: { code: 'conflict', message } }), { status })

describe('failureOf', () => {
  it('quotes the message from the error envelope', async () => {
    const message = 'Another story already occupies that path.'
    expect(await failureOf(envelope(message, 409))).toBe(message)
  })

  it('falls back when the body is not an envelope at all', async () => {
    // A proxy's own error page, or a response that never reached the worker.
    expect(await failureOf(new Response('<html>502</html>', { status: 502 }))).toBe(
      'Request failed (502)',
    )
  })

  it('prefers a fallback the caller supplied', async () => {
    expect(await failureOf(new Response('', { status: 500 }), 'Upload failed (500)')).toBe(
      'Upload failed (500)',
    )
  })

  it('ignores an envelope with no message', async () => {
    const res = new Response(JSON.stringify({ error: { code: 'internal' } }), { status: 500 })
    expect(await failureOf(res)).toBe('Request failed (500)')
  })
})

describe('expectOk', () => {
  it('passes a successful response through', async () => {
    const res = new Response('{}', { status: 200 })
    expect(await expectOk(res)).toBe(res)
  })

  it('throws the envelope message, so one catch can report any failure', async () => {
    await expect(expectOk(envelope('Unknown story', 404))).rejects.toThrow('Unknown story')
  })

  it('parses the body only on success', async () => {
    expect(await expectJson<{ ok: boolean }>(new Response('{"ok":true}'))).toEqual({ ok: true })
    await expect(expectJson(envelope('Empty upload', 400))).rejects.toThrow('Empty upload')
  })
})

describe('afterWrite', () => {
  it('waits for the refresh, so a caller can still clear its busy flag after it', async () => {
    const order: string[] = []
    const refresh = Promise.resolve().then(() => {
      order.push('refreshed')
    })
    await afterWrite(refresh)
    order.push('continued')
    expect(order).toEqual(['refreshed', 'continued'])
  })

  /**
   * The whole point. A publish, checkpoint or restore reports its own failure
   * through the toast; the refresh that follows a *successful* one must not be
   * able to reach that same catch, or a write that landed is reported as having
   * failed — and its success notice is replaced by the error.
   */
  it('does not reject when the refresh does', async () => {
    const notify = vi.fn()
    let flashed = false

    try {
      flashed = true
      await afterWrite(Promise.reject(new Error('Failed to fetch')))
    } catch (e) {
      notify((e as Error).message)
    }

    expect(flashed).toBe(true)
    expect(notify).not.toHaveBeenCalled()
  })

  it('discards the refresh’s value: nothing downstream reads it', async () => {
    expect(await afterWrite(Promise.resolve(['a', 'b']))).toBeUndefined()
  })
})

/**
 * identity-and-access.md phase 4, step 1: a 401 is the one failure that must not
 * become a toast. Every mutating call in the admin goes through `expectOk`, so
 * this is the single place that can turn "your session ended" into a navigation
 * rather than a message telling you to sign in with no way to.
 */
describe('the 401 handler', () => {
  afterEach(() => onUnauthorized(null))

  const unauthorized = () =>
    new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in to continue.' } }),
      {
        status: 401,
      },
    )

  it('fires for a 401, and still throws so the caller can unwind', async () => {
    const seen: string[] = []
    onUnauthorized((message) => seen.push(message))

    await expect(expectOk(unauthorized())).rejects.toThrow('Sign in to continue.')
    // Both: the navigation is not instantaneous, and the caller's busy flag and
    // optimistic state have to come back either way.
    expect(seen).toEqual(['Sign in to continue.'])
  })

  it('does not fire for a 403: signing in again cannot change that answer', async () => {
    const seen: string[] = []
    onUnauthorized((message) => seen.push(message))

    const forbidden = new Response(
      JSON.stringify({ error: { code: 'forbidden', message: 'Your role (viewer) is read-only.' } }),
      { status: 403 },
    )
    await expect(expectOk(forbidden)).rejects.toThrow('read-only')
    // Redirecting here would be a loop dressed up as a fix.
    expect(seen).toEqual([])
  })

  it('does not fire for any other failure, or for a success', async () => {
    const handler = vi.fn()
    onUnauthorized(handler)

    await expect(expectOk(envelope('Unknown story', 404))).rejects.toThrow('Unknown story')
    await expectOk(new Response('{}', { status: 200 }))
    expect(handler).not.toHaveBeenCalled()
  })

  it('is a no-op once unregistered, so an auth: open deployment never navigates', async () => {
    onUnauthorized(null)
    await expect(expectOk(unauthorized())).rejects.toThrow('Sign in to continue.')
  })
})

describe('signInUrl', () => {
  it('brings the browser back to the page it was on', () => {
    expect(signInUrl('/folio/login', '/folio/edit/sty_home')).toBe(
      '/folio/login?next=%2Ffolio%2Fedit%2Fsty_home',
    )
  })

  it('encodes a next that carries its own query string', () => {
    expect(signInUrl('/folio/login', '/folio/edit/sty_a?rail=history')).toBe(
      '/folio/login?next=%2Ffolio%2Fedit%2Fsty_a%3Frail%3Dhistory',
    )
  })
})
