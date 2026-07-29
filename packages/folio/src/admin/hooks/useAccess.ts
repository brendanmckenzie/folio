/**
 * Editors and API tokens, for the Access rail. `admin` role only — the rail is
 * not rendered otherwise, and the routes 403 regardless.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Role, Scope } from '../../server/auth/roles'
import type { TokenRow } from '../../server/auth/tokens'
import { afterWrite, expectJson, expectOk, send } from '../api'
import type { Notify } from './useNotice'

/** A user as `GET /folio/users` returns one. */
export interface AccessUser {
  id: string
  email: string
  name: string
  role: Role
  colour: string | null
  provider: string | null
  createdAt: number
  lastSeenAt: number | null
}

export interface Access {
  users: AccessUser[]
  tokens: TokenRow[]
  loading: boolean
  busy: boolean
  /**
   * The token minted by the last `createToken`, in the clear.
   *
   * Held in component state because there is nowhere else it can live: only the
   * creating response ever carries it, and the server keeps a SHA-256. Cleared by
   * `dismissToken` once it has been copied — a secret left on screen for the rest
   * of the session is a secret on a shared monitor.
   */
  minted: { name: string; token: string } | null
  dismissToken: () => void
  reload: () => Promise<void>
  invite: (email: string, role: Role) => Promise<void>
  setRole: (id: string, role: Role) => Promise<void>
  remove: (id: string) => Promise<void>
  createToken: (name: string, scopes: Scope[]) => Promise<void>
  revokeToken: (id: string) => Promise<void>
}

export function useAccess(apiBase: string, notify: Notify, active: boolean): Access {
  const [users, setUsers] = useState<AccessUser[]>([])
  const [tokens, setTokens] = useState<TokenRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [u, t] = await Promise.all([fetch(`${apiBase}/users`), fetch(`${apiBase}/tokens`)])
      if (u.ok) setUsers(((await u.json()) as { users: AccessUser[] }).users)
      if (t.ok) setTokens(((await t.json()) as { tokens: TokenRow[] }).tokens)
    } finally {
      setLoading(false)
    }
  }, [apiBase])

  // Loaded only while the rail is open: an admin screen nobody has opened has no
  // business costing two D1 reads on every editor load.
  useEffect(() => {
    if (active) void reload()
  }, [active, reload])

  /** Every mutation shares one shape: busy, refuse-to-toast, refresh through
   * `afterWrite` so a failed re-read is never reported as a failed write. */
  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await work()
        await afterWrite(reload())
      } catch (e) {
        notify((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [notify, reload],
  )

  const invite = useCallback(
    (email: string, role: Role) =>
      run(async () => expectOk(await send(`${apiBase}/users`, 'POST', { email, role }))),
    [apiBase, run],
  )

  const setRole = useCallback(
    (id: string, role: Role) =>
      run(async () =>
        expectOk(await send(`${apiBase}/users/${encodeURIComponent(id)}`, 'PATCH', { role })),
      ),
    [apiBase, run],
  )

  const remove = useCallback(
    (id: string) =>
      run(async () =>
        expectOk(await fetch(`${apiBase}/users/${encodeURIComponent(id)}`, { method: 'DELETE' })),
      ),
    [apiBase, run],
  )

  const createToken = useCallback(
    (name: string, scopes: Scope[]) =>
      run(async () => {
        const body = await expectJson<{ token: string }>(
          await send(`${apiBase}/tokens`, 'POST', { name, scopes }),
        )
        setMinted({ name, token: body.token })
      }),
    [apiBase, run],
  )

  const revokeToken = useCallback(
    (id: string) =>
      run(async () =>
        expectOk(await fetch(`${apiBase}/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })),
      ),
    [apiBase, run],
  )

  const dismissToken = useCallback(() => setMinted(null), [])

  return {
    users,
    tokens,
    loading,
    busy,
    minted,
    dismissToken,
    reload,
    invite,
    setRole,
    remove,
    createToken,
    revokeToken,
  }
}
