import { useState } from 'react'
import { ROLES, SCOPES, type Role, type Scope } from '../server/auth/roles'
import type { Access as AccessState, AccessUser } from './hooks/useAccess'

/**
 * The Access rail: who can edit, and which scripts hold a token.
 *
 * Rendered only for an `admin` (`canManageAccess`), and the routes behind it 403
 * regardless — the server is the authority and this is only about not offering an
 * affordance it will refuse (`identity-and-access.md` architecture decision 5).
 */

/** The scopes a fresh token is offered with checked. Read-only by default, so the
 * lazy path produces the least dangerous token rather than the most useful one. */
const DEFAULT_SCOPES: Scope[] = ['content:read']

/** Never `null` on screen: a row with no colour still has a stable derived one
 * server-side, and "—" is a clearer placeholder than an empty cell. */
const dash = (value: string | null) => value ?? '—'

function when(at: number | null): string {
  if (at === null) return 'never'
  return new Date(at).toLocaleDateString()
}

function UserRow({
  user,
  self,
  busy,
  onRole,
  onRemove,
}: {
  user: AccessUser
  /** True for the signed-in admin's own row: the server refuses both actions on
   * it, so offering them would be a button that always errors. */
  self: boolean
  busy: boolean
  onRole: (role: Role) => void
  onRemove: () => void
}) {
  return (
    <li className="access__row">
      <div className="access__who">
        <strong>{user.name}</strong>
        <span className="access__email">{user.email}</span>
        <span className="access__meta">
          {dash(user.provider)} · last seen {when(user.lastSeenAt)}
        </span>
      </div>
      <select
        value={user.role}
        disabled={busy || self}
        title={self ? 'You cannot change your own role' : undefined}
        aria-label={`Role for ${user.name}`}
        onChange={(e) => onRole(e.target.value as Role)}
      >
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || self}
        title={self ? 'You cannot remove your own account' : undefined}
        onClick={onRemove}
      >
        Remove
      </button>
    </li>
  )
}

export function Access({ state, selfId }: { state: AccessState; selfId: string | null }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [tokenName, setTokenName] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES)

  const toggleScope = (scope: Scope) =>
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    )

  return (
    <div className="access">
      <h3>Editors</h3>
      {state.loading ? <p className="rail__loading">Loading…</p> : null}
      <ul className="access__list">
        {state.users.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            self={user.id === selfId}
            busy={state.busy}
            onRole={(next) => void state.setRole(user.id, next)}
            onRemove={() => void state.remove(user.id)}
          />
        ))}
      </ul>

      {/* No mail is sent: the row *is* the invitation, and they sign in through
          whichever provider the site configured. Folio does not own a
          from-address (see server/auth/magic-link.ts). */}
      <form
        className="access__form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!email.trim()) return
          void state.invite(email.trim(), role)
          setEmail('')
        }}
      >
        <input
          type="email"
          value={email}
          placeholder="name@example.com"
          aria-label="Email address to invite"
          onChange={(e) => setEmail(e.target.value)}
        />
        <select value={role} aria-label="Role" onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="submit" disabled={state.busy}>
          Give access
        </button>
      </form>

      <h3>API tokens</h3>

      {/* The one and only time this value exists. Shown until dismissed, then
          gone: only its SHA-256 is stored, so there is nothing to read it back
          from — and a secret left on screen is a secret on a shared monitor. */}
      {state.minted ? (
        <div className="access__minted">
          <p>
            <strong>{state.minted.name}</strong> — copy this now, it is not shown again:
          </p>
          <code>{state.minted.token}</code>
          <button type="button" onClick={state.dismissToken}>
            Done
          </button>
        </div>
      ) : null}

      <ul className="access__list">
        {state.tokens.map((token) => (
          <li key={token.id} className="access__row">
            <div className="access__who">
              <strong>{token.name}</strong>
              <span className="access__meta">{token.scopes.join(', ') || 'no scopes'}</span>
              <span className="access__meta">
                {token.revokedAt ? 'revoked' : `last used ${when(token.lastUsedAt)}`}
              </span>
            </div>
            <button
              type="button"
              disabled={state.busy || token.revokedAt !== null}
              onClick={() => void state.revokeToken(token.id)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>

      <form
        className="access__form access__form--token"
        onSubmit={(e) => {
          e.preventDefault()
          if (!tokenName.trim() || scopes.length === 0) return
          void state.createToken(tokenName.trim(), scopes)
          setTokenName('')
          setScopes(DEFAULT_SCOPES)
        }}
      >
        <input
          type="text"
          value={tokenName}
          placeholder="import-script"
          aria-label="Token name"
          onChange={(e) => setTokenName(e.target.value)}
        />
        <div className="access__scopes">
          {SCOPES.map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              {scope}
            </label>
          ))}
        </div>
        <button type="submit" disabled={state.busy || scopes.length === 0}>
          Create token
        </button>
      </form>
    </div>
  )
}
