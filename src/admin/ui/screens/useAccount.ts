import { useCallback, useEffect, useState } from 'react'
import type { EventRow, PasskeyRow, SessionRow } from './account-model'
import { messageOf } from './useContent'

/**
 * The Your account screen's data: three independent, unpaged lists.
 *
 * Unpaged is deliberate and follows from the server, not a shortcut taken here:
 * `MAX_PASSKEYS_PER_USER` bounds passkeys at ten, a person's own open sessions
 * are never more than a handful, and `GET {base}/api/me/events` answers a fixed
 * "last twenty" with no cursor at all. `useAccess.ts`'s cursor-stack shape
 * solves a problem this screen does not have.
 *
 * Three lists rather than one combined fetch because each has its own write
 * that must reload only itself: renaming a passkey has no reason to re-read
 * sessions, and "sign out other browsers" has no reason to re-read passkeys.
 */

interface Fetched<T> {
  rows: readonly T[]
  loading: boolean
  error?: string
}

export interface FetchedList<T> extends Fetched<T> {
  reload: () => void
}

export interface AccountData {
  passkeys: FetchedList<PasskeyRow>
  sessions: FetchedList<SessionRow>
  events: FetchedList<EventRow>
}

/**
 * `passkeysEnabled` is `passkeyAvailability(me).kind !== 'unavailable'`
 * (`account-model.ts`) — on a deployment that never listed `passkeys()`,
 * `GET {base}/api/me/passkeys` 404s, and there is nothing worth asking for.
 * Sessions and recent sign-ins carry no such gate: both are useful on a
 * deployment that has never heard of passkeys, which is exactly why
 * `routes/passkeys.ts` keeps them off `requirePasskeys`.
 */
export function useAccount(apiBase: string, passkeysEnabled: boolean): AccountData {
  return {
    passkeys: useList<PasskeyRow>(apiBase, '/me/passkeys', 'passkeys', passkeysEnabled),
    sessions: useList<SessionRow>(apiBase, '/me/sessions', 'sessions', true),
    events: useList<EventRow>(apiBase, '/me/events', 'events', true),
  }
}

function useList<T>(
  apiBase: string,
  path: string,
  key: 'passkeys' | 'sessions' | 'events',
  enabled: boolean,
): FetchedList<T> {
  const [state, setState] = useState<Fetched<T>>({ rows: [], loading: enabled })

  const load = useCallback(async () => {
    if (!enabled) {
      setState({ rows: [], loading: false })
      return
    }
    setState((prev) => ({ ...prev, loading: true }))
    try {
      const res = await fetch(`${apiBase}${path}`)
      if (!res.ok) throw new Error(await messageOf(res))
      const body = (await res.json()) as Record<string, unknown>
      setState({ rows: (body[key] as T[]) ?? [], loading: false })
    } catch (e) {
      setState({ rows: [], loading: false, error: (e as Error).message })
    }
  }, [apiBase, path, key, enabled])

  useEffect(() => {
    void load()
  }, [load])

  return { ...state, reload: load }
}
