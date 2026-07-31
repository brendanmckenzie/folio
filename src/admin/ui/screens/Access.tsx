import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useState } from 'react'
import { fallbackColour } from '../../../core/protocol'
import type { Role, Scope } from '../../../server/auth/roles'
import type { TokenRow } from '../../../server/auth/tokens'
import type { Me } from '../../me'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { Select } from '../Field'
import { ListHeader } from '../List'
import { type Column, Table } from '../Table'
import css from './Access.module.css'
import {
  type AccessGate,
  type AccessUser,
  ROLE_MEANING,
  ROLE_OPTIONS,
  SELF_REMOVE_REASON,
  SELF_ROLE_REASON,
  accessGate,
  accessQuery,
  isSelf,
  parseAccessUrl,
  revokeRefusal,
  since,
  tokenStatus,
  tokenStatusTone,
} from './access-model'
import { AccessInviteDialog } from './AccessInviteDialog'
import { AccessTokenDialog, type Minted, MintedTokenDialog } from './AccessTokenDialog'
import { type PagedList, useAccess } from './useAccess'
import { messageOf } from './useContent'

interface Props {
  /** The admin's internal JSON base. */
  apiBase: string
  /** Who is signed in, and the auth mode. Both matter here: the mode decides
   * whether this screen has a subject at all, and the identity decides which row
   * is yours. */
  me: Me
  query: Readonly<Record<string, string>>
  /** `replace`, not `push`: opening a dialog must not put a history entry between
   * a person and the screen behind it. */
  onQuery: (next: Record<string, string | undefined>) => void
  onNotice: (message: string) => void
  /**
   * The shell's boot is still in flight, so `me` is a guess rather than an answer.
   *
   * **Optional, and the screen is correct without it** — it defaults to false and
   * everything below still works, which is why it is a sixth prop rather than a
   * change to the five. It fixes one wart, and only this screen has it: the shell
   * initialises `me` to `OPEN` before `GET {base}/api/me` answers, deliberately, and
   * `admin/me.ts` argues that well — assuming a session and rendering everything
   * read-only makes the editor flicker into life disabled on every load.
   *
   * On every other screen the optimistic guess is harmless. Here it is a *false
   * statement*: `mode: 'open'` renders "this deployment has no accounts", so an admin
   * opening `{base}/access` cold reads a paragraph about their site having no auth
   * for one round trip before the tables appear. Skeleton rows for that beat is the
   * honest version, and it is what `## Cross-cutting` asks for anyway.
   *
   * Not derived from `me` itself, though it nearly can be — a real `auth: 'open'`
   * deployment answers a non-empty `loginUrl` while the pre-boot `OPEN` constant's is
   * `''`. Rejected: `Me`'s own comment says the opposite ("Empty under
   * `auth: 'open'`"), so the discriminator works by accident and would be quietly
   * removed by anybody making the code match its documentation.
   */
  loading?: boolean
}

/** Four placeholder rows per table. Fewer than a content list's six, because both
 * tables on this screen are short on any real site and a skeleton longer than the
 * data it stands in for reads as a promise of rows that never arrive. */
const SKELETON = ['s1', 's2', 's3', 's4']

/**
 * Editors and API tokens — `docs/ui-architecture.md`'s port phase 5, and the
 * screen `docs/ui-review.md` uses as its sharpest illustration of what was wrong
 * with the old admin: **user administration rendered in a 280px rail with every
 * email truncated to `demo@example.…`**.
 *
 * Almost everything here follows from giving it a screen instead. An address is a
 * primary key a person types into a support conversation, so it gets a column that
 * does not truncate; `Table`'s cells are `nowrap` and the first column absorbs the
 * slack, so the table scrolls before an email does. The old rail also had nowhere
 * to say what a role *means*, which is why `publisher` was a word in a `<select>`
 * and nothing else.
 *
 * Three decisions worth reading before changing anything:
 *
 * 1. **The gate is four cases, not a boolean.** This screen 404s under
 *    `auth: 'open'`, 403s for a viewer, and 401s for nobody — and rendering two
 *    empty tables in any of the three would read as "there are no editors" rather
 *    than "you are not being told". `access-model.ts`'s `AccessGate` names them and
 *    `useAccess` does not fetch unless the answer is `ok`.
 * 2. **Both tables are server-paged** over the cursor `/users` and `/tokens`
 *    already answer, with next / previous and `Showing n of N` — never page
 *    numbers (`ui-architecture.md` Resolved 5). The tokens list is the one that
 *    genuinely needs it: nothing is ever deleted there, revoked rows stay, so it
 *    only grows.
 * 3. **The destructive control is a column, not a hover-revealed action.**
 *    `Table`'s own `actions` slot is `visibility: hidden` until `:hover` or
 *    `:focus-within`, which needs another focusable element in the row to bootstrap
 *    into. The editors table has one (the role select); the tokens table has none,
 *    so its Revoke would be reachable by mouse only. `admin.css` already made this
 *    call once — "the version button is always visible, because hover-only is
 *    unreachable by keyboard" — and rather than have the two tables disagree, both
 *    put it in a named column.
 */
export function Access({ apiBase, me, query, onQuery, onNotice, loading }: Props) {
  const gate = accessGate(me)
  const url = parseAccessUrl(query)
  const data = useAccess(apiBase, !loading && gate.kind === 'ok')

  const [busy, setBusy] = useState(false)
  const [minted, setMinted] = useState<Minted | null>(null)
  const [removing, setRemoving] = useState<AccessUser | null>(null)
  const [revoking, setRevoking] = useState<TokenRow | null>(null)

  const close = useCallback(() => onQuery(accessQuery({ open: null })), [onQuery])

  /**
   * One write: busy, a toast either way, a reload of the list it touched.
   *
   * Returns whether it worked rather than throwing, and that is what the two dialogs
   * read: a mint that 400s must leave the form standing with the reason in a toast,
   * not vanish and take the half-filled scope selection with it. `## Cross-cutting`
   * puts a transient failure in a toast, and a dialog that closed on one would be
   * throwing the recovery away with the error.
   */
  const run = useCallback(
    async (work: () => Promise<string>, reload: () => void) => {
      setBusy(true)
      try {
        onNotice(await work())
        reload()
        return true
      } catch (e) {
        onNotice((e as Error).message)
        return false
      } finally {
        setBusy(false)
      }
    },
    [onNotice],
  )

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

  const invite = async (body: { email: string; name?: string; role: Role }) => {
    const ok = await run(async () => {
      await send('/users', 'POST', body)
      return `${body.email} can sign in now, as a ${body.role}.`
    }, data.users.reload)
    if (ok) close()
  }

  const changeRole = (user: AccessUser, role: Role) =>
    void run(async () => {
      await send(`/users/${encodeURIComponent(user.id)}`, 'PATCH', { role })
      // The sign-out is the route's doing and is deliberate — a demotion that left
      // the old role in every open socket until it expired is not a window worth
      // accepting. Saying so here means it does not look like a bug when it happens
      // to somebody.
      return `${user.name} is now a ${role}. They will need to sign in again.`
    }, data.users.reload)

  const remove = (user: AccessUser) =>
    void run(async () => {
      await send(`/users/${encodeURIComponent(user.id)}`, 'DELETE')
      return `${user.name} no longer has access. Their edit history is untouched.`
    }, data.users.reload)

  const mint = async (body: { name: string; scopes: Scope[]; expiresInDays?: number }) => {
    const ok = await run(async () => {
      const res = await send('/tokens', 'POST', body)
      const answer = (await res.json()) as { token: string }
      setMinted({ name: body.name, token: answer.token })
      return `Created ${body.name}.`
    }, data.tokens.reload)
    if (ok) close()
  }

  const revoke = (token: TokenRow) =>
    void run(async () => {
      await send(`/tokens/${encodeURIComponent(token.id)}`, 'DELETE')
      return `${token.name} is revoked. Anything using it stops working now.`
    }, data.tokens.reload)

  // Before the gate, because until `/me` answers the gate is guessing — see
  // `loading`. Both branches are after every hook, so the hook order is fixed.
  if (loading) return <Booting />
  if (gate.kind !== 'ok') return <Unavailable gate={gate} />
  const selfId = gate.self.id

  const userColumns: Column<AccessUser>[] = [
    {
      key: 'name',
      label: 'Name',
      cell: (user) => (
        <span className={css.who}>
          {/* The presence hue, which is otherwise invisible outside a live editing
              session — and derived exactly as the server derives it, so the dot here
              and the ring on a field are the same colour for the same person.
              `users.colour` is null until something sets one, which is the usual
              case. */}
          <span
            className={css.dot}
            style={{ '--dot': user.colour ?? fallbackColour(user.id) } as CSSProperties}
          />
          <span className={css.name}>{user.name}</span>
          {isSelf(user.id, selfId) ? <Badge>you</Badge> : null}
        </span>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      // The column this screen exists for. No truncation and no ellipsis: `Table`'s
      // cells are `nowrap`, so a long address widens the table and the table
      // scrolls, which is recoverable in a way `demo@example.…` was not.
      cell: (user) => <span className={css.email}>{user.email}</span>,
    },
    {
      key: 'role',
      label: 'Role',
      cell: (user) => {
        const self = isSelf(user.id, selfId)
        return (
          <span className={css.roleCell}>
            <Select
              value={user.role}
              disabled={busy || self}
              title={self ? SELF_ROLE_REASON : ROLE_MEANING[user.role]}
              aria-label={`Role for ${user.name}`}
              onChange={(e) => changeRole(user, e.target.value as Role)}
            >
              {ROLE_OPTIONS.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
          </span>
        )
      },
    },
    {
      key: 'provider',
      label: 'Signs in with',
      cell: (user) =>
        user.provider ? (
          <Badge mono>{user.provider}</Badge>
        ) : (
          // Not an error: an invited account has no provider until the first
          // sign-in, and "never" in the column beside it is the other half of the
          // same sentence.
          <span className={css.blank}>—</span>
        ),
    },
    {
      key: 'seen',
      label: 'Last seen',
      cell: (user) => <span className={css.stamp}>{since(user.lastSeenAt)}</span>,
    },
    {
      key: 'act',
      label: 'Actions',
      cell: (user) => {
        const self = isSelf(user.id, selfId)
        return (
          <Button
            size="sm"
            variant="danger"
            disabled={busy || self}
            reason={self ? SELF_REMOVE_REASON : 'A write is in flight'}
            onClick={() => setRemoving(user)}
          >
            Remove
          </Button>
        )
      },
    },
  ]

  const tokenColumns: Column<TokenRow>[] = [
    { key: 'name', label: 'Name', cell: (token) => <span className={css.name}>{token.name}</span> },
    {
      key: 'scopes',
      label: 'Permissions',
      cell: (token) => (
        <span className={css.scopeList}>
          {token.scopes.length === 0 ? (
            // Possible without being a bug the admin caused: `parseScopes` drops
            // anything the current build does not declare, so a token minted before a
            // scope was removed from the code reads as granting nothing — which is
            // exactly what it now grants.
            <span className={css.blank}>none</span>
          ) : (
            /*
             * Neutral, including `admin`. It rendered `danger` at first and the UI
             * review caught it: `Revoke` sits on the same row and is also red, so one
             * row carried two reds meaning different things — "this scope is
             * powerful" and "this control destroys something".
             * `design-system.md`'s first commitment reserves hue for *state*, and a
             * scope is not a state. The one that matters stays legible because it
             * says `admin`, which is the widest word available.
             */
            token.scopes.map((scope) => (
              <Badge key={scope} mono>
                {scope}
              </Badge>
            ))
          )}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      cell: (token) => {
        const status = tokenStatus(token)
        return (
          <Badge
            tone={tokenStatusTone(status)}
            {...(status === 'active' && token.expiresAt !== null
              ? { title: `Expires ${new Date(token.expiresAt).toLocaleDateString()}` }
              : {})}
          >
            {status}
          </Badge>
        )
      },
    },
    {
      key: 'created',
      label: 'Created',
      cell: (token) => <span className={css.stamp}>{since(token.createdAt)}</span>,
    },
    {
      key: 'used',
      label: 'Last used',
      // Stamped whether the request succeeded or was refused for a missing scope
      // (`readToken`), because the question this column answers is "is this
      // credential in use", not "did it work".
      cell: (token) => <span className={css.stamp}>{since(token.lastUsedAt)}</span>,
    },
    {
      key: 'act',
      label: 'Actions',
      cell: (token) => {
        const refusal = revokeRefusal(token)
        return (
          <Button
            size="sm"
            variant="danger"
            disabled={busy || refusal !== undefined}
            reason={refusal ?? 'A write is in flight'}
            onClick={() => setRevoking(token)}
          >
            Revoke
          </Button>
        )
      },
    },
  ]

  return (
    <div className={css.screen}>
      {/* A named `<section>` per table, so each is a landmark a screen reader can
          jump between — two tables on one screen is exactly the case where "which
          table am I in" needs an answer. `aria-label` rather than `aria-labelledby`
          pointing at the heading: `ListHeader` owns the `<h2>` and takes no id, and a
          region whose name repeats its visible heading is the ordinary pattern. */}
      <section className={css.section} aria-label="Editors">
        <ListHeader
          actions={
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              reason="A write is in flight"
              onClick={() => onQuery(accessQuery({ open: 'user' }))}
            >
              Give access
            </Button>
          }
        >
          Editors
        </ListHeader>

        <Panel
          list={data.users}
          label="Editors"
          columns={userColumns}
          rowKey={(user) => user.id}
          noun="editor"
          onRetry={data.users.reload}
          empty={
            <EmptyState
              title="No editors"
              // Unreachable in practice — you are signed in, so you are in this
              // list — which is why it does not offer a next step it cannot
              // guarantee. It exists because a paged list with a failed count and
              // an empty page is a state, and rendering nothing there is worse.
              body="Nobody has access to this site yet."
            />
          }
        />
      </section>

      <section className={css.section} aria-label="API tokens">
        <ListHeader
          actions={
            <Button
              size="sm"
              disabled={busy}
              reason="A write is in flight"
              onClick={() => onQuery(accessQuery({ open: 'token' }))}
            >
              New token
            </Button>
          }
        >
          API tokens
        </ListHeader>

        <Panel
          list={data.tokens}
          label="API tokens"
          columns={tokenColumns}
          rowKey={(token) => token.id}
          noun="token"
          onRetry={data.tokens.reload}
          empty={
            <EmptyState
              title="No API tokens"
              body="A token lets a script read or write content without being a person: an import, a preview deployment, a scheduled publish."
              action={
                <Button size="sm" onClick={() => onQuery(accessQuery({ open: 'token' }))}>
                  New token
                </Button>
              }
            />
          }
        />
      </section>

      {url.open === 'user' ? <AccessInviteDialog onClose={close} onInvite={invite} /> : null}

      {/*
        `&& minted === null` is not belt-and-braces, it is the handover.
        A successful mint does two things — it sets the secret and it clears
        `?new=token` — and the second is a `history` write that lands a render later
        than the first. Without this guard both dialogs are mounted for that render,
        which means two focus traps: the second takes focus, the first then unmounts
        and hands focus back to whatever opened *it*, so the secret's Copy button
        loses focus a frame after gaining it. The secret itself lives in state rather
        than in the URL for the obvious reason, so it survives the clear.
      */}
      {url.open === 'token' && minted === null ? (
        <AccessTokenDialog onClose={close} onMint={mint} />
      ) : null}
      {minted ? <MintedTokenDialog minted={minted} onClose={() => setMinted(null)} /> : null}

      {removing ? (
        <Dialog
          title={`Remove ${removing.name}?`}
          description="They lose access immediately."
          danger
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const user = removing
                  setRemoving(null)
                  remove(user)
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          {/* Warn and proceed, the same shape as `DeleteDialog`: the dialog's job is
              to make sure the person pressing the button knows what it costs, not to
              decide for them. What it costs here is small and worth saying, because
              the fear is that it is large — their sessions go, their history does
              not. */}
          <p className={css.dialogNote}>
            <code className={css.inlineCode}>{removing.email}</code> can no longer sign in, and
            every session they hold is dropped.
          </p>
          <p className={css.dialogNote}>
            Their edit history stays. Version rows record who made a change as a string, not as a
            link to an account, so removing somebody never rewrites the record of what they did.
          </p>
        </Dialog>
      ) : null}

      {revoking ? (
        <Dialog
          title={`Revoke ${revoking.name}?`}
          description="Anything using this token stops working immediately."
          danger
          onClose={() => setRevoking(null)}
          actions={
            <>
              <Button onClick={() => setRevoking(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const token = revoking
                  setRevoking(null)
                  revoke(token)
                }}
              >
                Revoke
              </Button>
            </>
          }
        >
          <p className={css.dialogNote}>
            The row stays in the list so "which token was that, and when did we turn it off" is
            still answerable — and it keeps the hash, so a token that leaked can never be minted
            again by chance.
          </p>
          <p className={css.dialogNote}>There is no way to un-revoke it. Mint a new one instead.</p>
        </Dialog>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------- panel --- */

/**
 * One table, its skeleton, its error state and its pager.
 *
 * Shared between the two halves because they are the same object twice: the same
 * `Showing n of N` footer, the same next / previous over a cursor stack, the same
 * "the list failed and there is nothing to show" branch. Documents has one of these
 * inline; the second copy is where it becomes a component.
 */
function Panel<T>({
  list,
  label,
  columns,
  rowKey,
  noun,
  empty,
  onRetry,
}: {
  list: PagedList<T>
  label: string
  columns: readonly Column<T>[]
  rowKey: (row: T) => string
  /** Singular. The footer pluralises it. */
  noun: string
  empty: ReactNode
  onRetry: () => void
}) {
  const { page } = list

  if (page.error && page.rows.length === 0) {
    return (
      <EmptyState
        title={`Could not load ${label.toLowerCase()}`}
        body={page.error}
        action={
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    )
  }

  if (page.loading && page.rows.length === 0) {
    return (
      <div className={css.skeletons} aria-hidden="true">
        {SKELETON.map((key) => (
          <div className={css.skeleton} key={key} />
        ))}
      </div>
    )
  }

  return (
    <>
      <Table label={label} columns={columns} rows={page.rows} rowKey={rowKey} empty={empty} />
      {page.rows.length === 0 ? null : (
        <div className={css.footer}>
          <span className={css.count}>
            {page.total === undefined
              ? `${page.rows.length} shown`
              : `${page.rows.length} of ${page.total} ${page.total === 1 ? noun : `${noun}s`}`}
          </span>
          <span className={css.pager}>
            <Button
              size="sm"
              disabled={!list.canGoBack}
              reason="This is the first page"
              onClick={list.prevPage}
            >
              Previous
            </Button>
            <Button
              size="sm"
              disabled={page.cursor === null}
              reason="This is the last page"
              onClick={list.nextPage}
            >
              Next
            </Button>
          </span>
        </div>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- the gate --- */

/**
 * The screen before it knows whether it has a subject.
 *
 * Both headings and both skeletons, so the shape a person is about to read is
 * already on screen — which is the whole argument for skeletons over a spinner, and
 * it holds twice as strongly here because the alternative was a paragraph making a
 * claim about the deployment that is very likely false. `--row-h` is fixed, so this
 * is the right height by construction.
 */
function Booting() {
  return (
    <div className={css.screen}>
      {(['Editors', 'API tokens'] as const).map((label) => (
        <section className={css.section} key={label} aria-label={label}>
          <ListHeader>{label}</ListHeader>
          <div className={css.skeletons} aria-hidden="true">
            {SKELETON.map((key) => (
              <div className={css.skeleton} key={key} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/**
 * What the screen says when it has no subject.
 *
 * Three different sentences, because the three conditions have nothing in common
 * beyond the tables being absent — and `## Cross-cutting` puts a persistent
 * condition in flow rather than in an overlay, which is what an `EmptyState`
 * already is.
 *
 * Only one of the three offers an action, and that is honest rather than lazy: the
 * next step for `auth: 'open'` is a change to the host Worker's `folio()` call, and
 * the next step for a viewer is to ask somebody. Inventing a button for either would
 * be furniture.
 */
function Unavailable({ gate }: { gate: Exclude<AccessGate, { kind: 'ok' }> }) {
  if (gate.kind === 'open') {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Access</ListHeader>
        <EmptyState
          title="This deployment has no accounts"
          body={
            <>
              <code className={css.inlineCode}>auth</code> is not configured on the host Worker, so
              every request is allowed and there are no editors, roles or tokens to manage. The
              routes behind this screen answer <b>404</b> rather than 403 — deliberately, so a
              deployment that has no such thing never says "you may not". Configure a provider in
              the <code className={css.inlineCode}>folio()</code> call to turn accounts on.
            </>
          }
        />
      </div>
    )
  }

  if (gate.kind === 'anonymous') {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Access</ListHeader>
        <EmptyState
          title="Sign in to manage access"
          body="Editors and tokens are only listed to a signed-in admin."
          action={
            // A link and not a `Button`: signing in is a navigation out of the
            // single-page shell to a server-rendered page that ships no JavaScript,
            // and an anchor is what survives a middle-click.
            <a className={css.signIn} href={gate.loginUrl}>
              Sign in
            </a>
          }
        />
      </div>
    )
  }

  return (
    <div className={css.screen}>
      <ListHeader level={1}>Access</ListHeader>
      <EmptyState
        title="You may not manage access"
        body={
          <>
            {gate.reason} An admin can change that from this screen — the sidebar does not show it
            to anybody else, so this URL was reached by hand or by a link.
          </>
        }
      />
    </div>
  )
}
