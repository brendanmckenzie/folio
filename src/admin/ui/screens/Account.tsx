import { useCallback, useState } from 'react'
import { MAX_PASSKEYS_PER_USER } from '../../../server/auth/passkeys'
import type { Me } from '../../me'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { Field, Input } from '../Field'
import { ListHeader } from '../List'
import { type Column, Table } from '../Table'
import css from './Account.module.css'
import {
  aaguidVendor,
  accountGate,
  algLabel,
  canEnrol,
  type EventRow,
  eventLabel,
  passkeyAvailability,
  passkeyCapReason,
  type PasskeyRow,
  providerLabel,
  type SessionRow,
  since,
  userAgentLabel,
} from './account-model'
import { AccountPasskeyDialog } from './AccountPasskeyDialog'
import { messageOf } from './useContent'
import { useAccount } from './useAccount'

interface Props {
  apiBase: string
  me: Me
  onNotice: (message: string) => void
  /**
   * The shell's boot is still in flight, so `me` is still the optimistic `OPEN`
   * guess — see `Access.tsx`'s identical prop for the fuller argument. Here the
   * false statement it would otherwise render is "you have no account", which
   * is exactly as wrong as Access's "this deployment has no accounts".
   */
  loading?: boolean
}

const SKELETON = ['s1', 's2', 's3']

/**
 * "Your account" — `docs/specs/foundation/passkeys.md` decision 6. Reached from
 * the user menu, deliberately absent from the sidebar (`ui-nav.test.ts`):
 * nobody manages anybody else's passkeys or sessions here, so there is no list
 * to put beside Access and Model.
 *
 * Four sections, top to bottom, and each reads its own route:
 *
 * 1. **Identity** — name, email and role from `me.actor` itself, no fetch of its
 *    own, plus "Set by `<provider>`" when spec 28's `role_from` is filled, which
 *    is decision 6's whole reason for putting the role here: it is *why* the
 *    Access screen will not let an admin change it.
 *
 *    `GET {base}/api/me` projected only `{ kind, id, name, colour, role }` when
 *    this screen was first built, so the last two were unbuildable; `email` and
 *    `roleFrom` were added to `UserActor` and that projection afterwards. Both
 *    ride the join `readSession` already runs, so neither costs a query, and
 *    neither is a new disclosure — it is the caller's own row answered to the
 *    caller.
 * 2. **Passkeys** — absent entirely (no fetch) on a deployment that never
 *    listed `passkeys()`; listed with the Add button **absent, not disabled**
 *    under an enforced domain (`canEnrol`); listed with it present otherwise.
 * 3. **Sessions** — every route needs only `requireAuthConfigured`, matching
 *    `routes/passkeys.ts`'s own reasoning: useful with no passkeys in sight.
 * 4. **Recent sign-ins** — `GET {base}/api/me/events`, spec 28 phase 4's route,
 *    read-only.
 */
export function Account({ apiBase, me, onNotice, loading }: Props) {
  const gate = accountGate(me)
  const availability = passkeyAvailability(me)
  const data = useAccount(
    apiBase,
    !loading && gate.kind === 'ok' && availability.kind !== 'unavailable',
  )

  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<PasskeyRow | null>(null)
  const [draftName, setDraftName] = useState('')
  const [removing, setRemoving] = useState<PasskeyRow | null>(null)

  const send = useCallback(
    async (path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) => {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      if (!res.ok) throw new Error(await messageOf(res))
      return res
    },
    [apiBase],
  )

  /** One write: busy, a toast either way, a reload of the list it touched — the
   * same shape `Access.tsx`'s `run` takes, for the same reason. */
  const run = useCallback(
    async (work: () => Promise<string>, reload: () => void) => {
      setBusy(true)
      try {
        onNotice(await work())
        reload()
      } catch (e) {
        onNotice((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [onNotice],
  )

  const startRename = (row: PasskeyRow) => {
    setRenaming(row)
    setDraftName(row.name)
  }

  const confirmRename = () =>
    void run(async () => {
      const target = renaming
      if (!target) return 'Nothing to rename.'
      const name = draftName.trim()
      await send(`/me/passkeys/${encodeURIComponent(target.id)}`, 'PATCH', { name })
      setRenaming(null)
      return `Renamed to "${name}".`
    }, data.passkeys.reload)

  const confirmRemove = () =>
    void run(async () => {
      const target = removing
      if (!target) return 'Nothing to remove.'
      await send(`/me/passkeys/${encodeURIComponent(target.id)}`, 'DELETE')
      setRemoving(null)
      return `Removed "${target.name}". Anything signed in with it stops working now.`
    }, data.passkeys.reload)

  const signOutOthers = () =>
    void run(async () => {
      const res = await send('/me/sessions/others', 'DELETE')
      const body = (await res.json()) as { revoked: number }
      return body.revoked > 0
        ? `Signed out ${body.revoked} other ${body.revoked === 1 ? 'browser' : 'browsers'}.`
        : 'No other browsers were signed in.'
    }, data.sessions.reload)

  if (loading) return <Booting />

  if (gate.kind === 'open') {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Your account</ListHeader>
        <EmptyState
          title="This deployment has no accounts"
          body="`auth` is not configured on the host Worker, so there is nobody signed in and nothing here to show."
        />
      </div>
    )
  }
  if (gate.kind === 'anonymous') {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Your account</ListHeader>
        <EmptyState
          title="Sign in to see your account"
          body="Passkeys, sessions and sign-in history are only shown to a signed-in person."
          action={
            <a className={css.signIn} href={gate.loginUrl}>
              Sign in
            </a>
          }
        />
      </div>
    )
  }
  if (gate.kind === 'token') {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Your account</ListHeader>
        <EmptyState
          title="A token has no account"
          body="This session is authenticated by an API token, which has no passkeys and no browser of its own to sign out."
        />
      </div>
    )
  }

  const self = gate.self

  const passkeyColumns: Column<PasskeyRow>[] = [
    {
      key: 'name',
      label: 'Name',
      cell: (row) => {
        const vendor = aaguidVendor(row.aaguid)
        return (
          <span className={css.who}>
            <span className={css.name}>{row.name}</span>
            {vendor ? <span className={css.muted}>{vendor}</span> : null}
          </span>
        )
      },
    },
    {
      key: 'added',
      label: 'Added',
      cell: (row) => <span className={css.stamp}>{since(row.createdAt)}</span>,
    },
    {
      key: 'used',
      label: 'Last used',
      cell: (row) => <span className={css.stamp}>{since(row.lastUsedAt)}</span>,
    },
    {
      key: 'synced',
      label: 'Synced',
      cell: (row) =>
        row.backedUp ? (
          <Badge title={`${algLabel(row.alg)} — backed up to a cloud keychain`}>synced</Badge>
        ) : (
          <span className={css.blank}>—</span>
        ),
    },
    {
      key: 'act',
      label: 'Actions',
      cell: (row) => (
        <span className={css.rowActions}>
          <Button
            size="sm"
            disabled={busy}
            reason="A write is in flight"
            onClick={() => startRename(row)}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            reason="A write is in flight"
            onClick={() => setRemoving(row)}
          >
            Remove
          </Button>
        </span>
      ),
    },
  ]

  const sessionColumns: Column<SessionRow>[] = [
    {
      key: 'created',
      label: 'Created',
      cell: (row) => (
        <span className={css.who}>
          <span className={css.stamp}>{since(row.createdAt)}</span>
          {row.current ? <Badge tone="accent">this browser</Badge> : null}
        </span>
      ),
    },
    {
      key: 'expires',
      label: 'Expires',
      cell: (row) => <span className={css.stamp}>{since(row.expiresAt)}</span>,
    },
    {
      key: 'provider',
      label: 'Signed in with',
      cell: (row) => <Badge mono>{providerLabel(row.provider)}</Badge>,
    },
    {
      key: 'agent',
      label: 'Browser',
      cell: (row) => <span className={css.muted}>{userAgentLabel(row.userAgent)}</span>,
    },
  ]

  const eventColumns: Column<EventRow>[] = [
    {
      key: 'at',
      label: 'When',
      cell: (row) => <span className={css.stamp}>{since(row.at)}</span>,
    },
    {
      key: 'event',
      label: 'Event',
      cell: (row) => eventLabel(row),
    },
    {
      key: 'provider',
      label: 'Provider',
      cell: (row) => (row.provider ? <Badge mono>{providerLabel(row.provider)}</Badge> : null),
    },
  ]

  const others = data.sessions.rows.filter((row) => !row.current).length

  return (
    <div className={css.screen}>
      <ListHeader level={1}>Your account</ListHeader>

      <section className={css.section} aria-label="Identity">
        <ListHeader>Identity</ListHeader>
        <dl className={css.identity}>
          <div className={css.identityRow}>
            <dt>Name</dt>
            <dd>{self.name}</dd>
          </div>
          {self.email ? (
            <div className={css.identityRow}>
              <dt>Email</dt>
              <dd>{self.email}</dd>
            </div>
          ) : null}
          <div className={css.identityRow}>
            <dt>Role</dt>
            <dd className={css.roleValue}>
              {self.role}
              {/* Not decoration: this is the reason the Access screen refuses to
                  change this role, and the person reading it is the one who would
                  otherwise ask an admin to. */}
              {self.roleFrom ? (
                <span className={css.roleFrom}>Set by {providerLabel(self.roleFrom)}</span>
              ) : null}
            </dd>
          </div>
        </dl>
      </section>

      <section className={css.section} aria-label="Passkeys">
        <ListHeader
          actions={
            canEnrol(me) ? (
              <Button
                variant="primary"
                size="sm"
                disabled={
                  busy ||
                  passkeyCapReason(data.passkeys.rows.length, MAX_PASSKEYS_PER_USER) !== undefined
                }
                reason={
                  passkeyCapReason(data.passkeys.rows.length, MAX_PASSKEYS_PER_USER) ??
                  'A write is in flight'
                }
                onClick={() => setAdding(true)}
              >
                Add a passkey
              </Button>
            ) : undefined
          }
        >
          Passkeys
        </ListHeader>

        {availability.kind === 'unavailable' ? (
          <EmptyState
            title="Passkeys are not offered here"
            body="This deployment has not listed a passkey provider, so there is nothing to enrol."
          />
        ) : (
          <>
            {availability.kind === 'forbidden' ? (
              <p className={css.notice}>{availability.reason}</p>
            ) : null}
            {data.passkeys.loading && data.passkeys.rows.length === 0 ? (
              <Skeleton />
            ) : data.passkeys.error && data.passkeys.rows.length === 0 ? (
              <EmptyState
                title="Could not load passkeys"
                body={data.passkeys.error}
                action={
                  <Button size="sm" onClick={data.passkeys.reload}>
                    Try again
                  </Button>
                }
              />
            ) : (
              <Table
                label="Passkeys"
                columns={passkeyColumns}
                rows={data.passkeys.rows}
                rowKey={(row) => row.id}
                empty={
                  <EmptyState
                    title="No passkeys yet"
                    body="A passkey is a fingerprint, a face or a device PIN standing in for a mailed link, on this device only."
                  />
                }
              />
            )}
          </>
        )}
      </section>

      <section className={css.section} aria-label="Sessions">
        <ListHeader
          actions={
            <Button
              size="sm"
              disabled={busy || others === 0}
              reason={others === 0 ? 'There is nothing else signed in' : 'A write is in flight'}
              onClick={signOutOthers}
            >
              Sign out other browsers
            </Button>
          }
        >
          Sessions
        </ListHeader>
        {data.sessions.loading && data.sessions.rows.length === 0 ? (
          <Skeleton />
        ) : data.sessions.error && data.sessions.rows.length === 0 ? (
          <EmptyState
            title="Could not load sessions"
            body={data.sessions.error}
            action={
              <Button size="sm" onClick={data.sessions.reload}>
                Try again
              </Button>
            }
          />
        ) : (
          <Table
            label="Sessions"
            columns={sessionColumns}
            rows={data.sessions.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title="No open sessions" />}
          />
        )}
      </section>

      <section className={css.section} aria-label="Recent sign-ins">
        <ListHeader>Recent sign-ins</ListHeader>
        {data.events.loading && data.events.rows.length === 0 ? (
          <Skeleton />
        ) : data.events.error && data.events.rows.length === 0 ? (
          <EmptyState
            title="Could not load sign-in history"
            body={data.events.error}
            action={
              <Button size="sm" onClick={data.events.reload}>
                Try again
              </Button>
            }
          />
        ) : (
          <Table
            label="Recent sign-ins"
            columns={eventColumns}
            rows={data.events.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title="Nothing recorded yet" />}
          />
        )}
      </section>

      {adding ? (
        <AccountPasskeyDialog
          apiBase={apiBase}
          onClose={() => setAdding(false)}
          onEnrolled={() => {
            setAdding(false)
            onNotice('Passkey added.')
            data.passkeys.reload()
          }}
        />
      ) : null}

      {renaming ? (
        <Dialog
          title={`Rename "${renaming.name}"`}
          onClose={() => setRenaming(null)}
          actions={
            <>
              <Button onClick={() => setRenaming(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy || !draftName.trim()}
                onClick={confirmRename}
              >
                Save
              </Button>
            </>
          }
        >
          <Field label="Name">
            {(id) => (
              <Input id={id} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
            )}
          </Field>
        </Dialog>
      ) : null}

      {removing ? (
        <Dialog
          title={`Remove "${removing.name}"?`}
          description="You will no longer be able to sign in with it."
          danger
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button variant="danger" disabled={busy} onClick={confirmRemove}>
                Remove
              </Button>
            </>
          }
        >
          <p className={css.dialogNote}>
            If this is the only way you sign in, make sure another door — a magic link or single
            sign-on — still works before removing it.
          </p>
        </Dialog>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- states --- */

function Skeleton() {
  return (
    <div className={css.skeletons} aria-hidden="true">
      {SKELETON.map((key) => (
        <div className={css.skeleton} key={key} />
      ))}
    </div>
  )
}

/** The screen before `/me` has answered. Mirrors `Access.tsx`'s `Booting`: the
 * headings are already on screen, so the shape of the answer does not wait on
 * the round trip that decides whether there is one at all. */
function Booting() {
  return (
    <div className={css.screen}>
      <ListHeader level={1}>Your account</ListHeader>
      {(['Identity', 'Passkeys', 'Sessions', 'Recent sign-ins'] as const).map((label) => (
        <section className={css.section} key={label} aria-label={label}>
          <ListHeader>{label}</ListHeader>
          <Skeleton />
        </section>
      ))}
    </div>
  )
}
