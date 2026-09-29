import { useCallback, useState } from 'react'
import type { Me } from '../../me'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { ListHeader } from '../List'
import { type Column, Table } from '../Table'
import { SiteDialog } from './SiteDialog'
import css from './Sites.module.css'
import {
  createBody,
  emptyForm,
  formOf,
  hostsChanged,
  patchBody,
  previewNote,
  ROUTING_NOTE,
  type SiteForm,
  type SiteRow,
  settingsBlurb,
  settingsHref,
  settingsScopes,
  siteRows,
  sitesGate,
  statusTone,
} from './sites-model'
import { messageOf } from './useContent'
import { useSites } from './useSites'

interface Props {
  /** The admin's JSON base. `/sites` is unscoped, so any scope's answers alike. */
  apiBase: string
  /** The mount with no scope, for the links into a scope's settings. */
  base: string
  me: Me
  /** The shell's boot is in flight, so `me` is a guess. See `Access`. */
  loading?: boolean
  /** The singleton type that holds site-level fields, or null when the host declared
   * none — and then the Settings tab does not exist. */
  settings: string | null
  query: Readonly<Record<string, string>>
  onQuery: (next: Record<string, string | undefined>) => void
  onNotice: (message: string) => void
}

type Dialogue =
  | { kind: 'create'; form: SiteForm }
  | { kind: 'edit'; row: SiteRow }
  | { kind: 'delete'; row: SiteRow }

const SKELETON = ['s1', 's2', 's3', 's4']

/**
 * The registry: sites, groups, hostnames, preview origin and status
 * (`multi-site.md` decision 1), and the tab that opens a scope's settings layer
 * (decision 2).
 *
 * **Platform only, and absent for anyone else** — `nav.ts` offers the entry to
 * `canManageSites` alone. The gate here is for the URL typed by hand, and says which
 * of the four reasons applies (`sitesGate`) rather than drawing an empty table that
 * would read as "there are no sites". Nothing is fetched unless the gate said `ok`.
 *
 * Every write is a request to a platform route that re-checks, drops the registry
 * snapshot and purges (`routes/sites.ts`); this screen reloads the list afterwards
 * and reports the server's own sentence on a refusal — the 409 for a site that still
 * owns content is the one an editor will actually meet.
 */
export function Sites({
  apiBase,
  base,
  me,
  loading = false,
  settings,
  query,
  onQuery,
  onNotice,
}: Props) {
  const gate = sitesGate(me, loading)
  const data = useSites(apiBase, gate.kind === 'ok')
  const [dialogue, setDialogue] = useState<Dialogue | null>(null)
  const [busy, setBusy] = useState(false)

  const tab = settings !== null && query.tab === 'settings' ? 'settings' : 'registry'

  const write = useCallback(
    async (work: () => Promise<string>) => {
      setBusy(true)
      try {
        onNotice(await work())
        data.reload()
        return true
      } catch (e) {
        onNotice((e as Error).message)
        return false
      } finally {
        setBusy(false)
      }
    },
    [onNotice, data.reload],
  )

  const call = useCallback(
    async (path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown) => {
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

  if (gate.kind === 'booting') return <Booting />
  if (gate.kind !== 'ok') return <Unavailable gate={gate} />

  const rows = siteRows(data.registry)

  const save = async (form: SiteForm) => {
    const ok = await write(async () => {
      if (dialogue?.kind === 'edit') {
        const before = dialogue.row
        const patch = patchBody(form, before)
        if (Object.keys(patch).length > 0) {
          await call(`/sites/${encodeURIComponent(before.id)}`, 'PATCH', patch)
        }
        if (before.kind === 'site' && hostsChanged(form, before)) {
          await call(`/sites/${encodeURIComponent(before.id)}/hosts`, 'PUT', {
            hosts: form.hosts
              .split(/[\s,]+/)
              .map((host) => host.trim())
              .filter(Boolean),
          })
        }
        return `Saved ${form.name.trim()}.`
      }
      await call('/sites', 'POST', createBody(form))
      return `Created ${form.name.trim()}.`
    })
    if (ok) setDialogue(null)
  }

  const remove = (row: SiteRow) =>
    void write(async () => {
      await call(`/sites/${encodeURIComponent(row.id)}`, 'DELETE')
      return `${row.name} is deleted.`
    })

  const columns: Column<SiteRow>[] = [
    {
      key: 'name',
      label: 'Name',
      cell: (row) => (
        <span className={css.ids}>
          <span className={css.name}>{row.name}</span>
          <Badge mono>{row.id}</Badge>
          {row.kind === 'group' ? <Badge>group</Badge> : null}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      cell: (row) =>
        row.status === null ? (
          <span className={css.blank}>—</span>
        ) : (
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
        ),
    },
    {
      key: 'group',
      label: 'Group',
      cell: (row) =>
        row.group === null ? <span className={css.blank}>—</span> : <Badge mono>{row.group}</Badge>,
    },
    {
      key: 'hosts',
      label: 'Hostnames',
      cell: (row) =>
        row.kind === 'group' ? (
          <span className={css.blank}>—</span>
        ) : row.hosts.length === 0 ? (
          <span className={css.blank}>none</span>
        ) : (
          <span className={css.ids}>
            {row.hosts.map((host) => (
              <Badge key={host} mono>
                {host}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      key: 'preview',
      label: 'Preview origin',
      cell: (row) => {
        if (row.kind === 'group') return <span className={css.blank}>—</span>
        const note = previewNote(row)
        return note ? (
          <span className={css.blank} title={note}>
            none
          </span>
        ) : (
          <Badge mono>{row.preview}</Badge>
        )
      },
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
            onClick={() => setDialogue({ kind: 'edit', row })}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            reason="A write is in flight"
            onClick={() => setDialogue({ kind: 'delete', row })}
          >
            Delete
          </Button>
        </span>
      ),
    },
  ]

  return (
    <div className={css.screen}>
      {settings !== null ? (
        <div className={css.tabs} role="tablist" aria-label="Sites">
          {(['registry', 'settings'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`${css.tab} ${tab === id ? css.tabOn : ''}`}
              onClick={() => onQuery({ tab: id === 'registry' ? undefined : id })}
            >
              {id === 'registry' ? 'Registry' : 'Settings'}
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'registry' ? (
        <section className={css.section} aria-label="Sites and groups">
          <ListHeader
            actions={
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  reason="A write is in flight"
                  onClick={() => setDialogue({ kind: 'create', form: emptyForm('group') })}
                >
                  New group
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  reason="A write is in flight"
                  onClick={() => setDialogue({ kind: 'create', form: emptyForm('site') })}
                >
                  New site
                </Button>
              </>
            }
          >
            Sites and groups
          </ListHeader>
          <p className={css.note}>{ROUTING_NOTE}</p>

          {data.error && rows.length === 0 ? (
            <EmptyState
              title="Could not load the registry"
              body={data.error}
              action={
                <Button size="sm" onClick={data.reload}>
                  Try again
                </Button>
              }
            />
          ) : data.loading && rows.length === 0 ? (
            <div className={css.skeletons} aria-hidden="true">
              {SKELETON.map((key) => (
                <div className={css.skeleton} key={key} />
              ))}
            </div>
          ) : (
            <Table
              label="Sites and groups"
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              empty={<EmptyState title="No sites" body="Create the first site to give it pages." />}
            />
          )}
        </section>
      ) : (
        <SettingsTab base={base} type={settings ?? ''} registry={data.registry} />
      )}

      {dialogue?.kind === 'create' ? (
        <SiteDialog
          mode="create"
          initial={dialogue.form}
          groups={data.registry.groups}
          onClose={() => setDialogue(null)}
          onSave={save}
        />
      ) : null}
      {dialogue?.kind === 'edit' ? (
        <SiteDialog
          mode="edit"
          initial={formOf(dialogue.row)}
          groups={data.registry.groups}
          onClose={() => setDialogue(null)}
          onSave={save}
        />
      ) : null}
      {dialogue?.kind === 'delete' ? (
        <Dialog
          title={`Delete ${dialogue.row.name}?`}
          description="Refused while it still owns any content."
          danger
          onClose={() => setDialogue(null)}
          actions={
            <>
              <Button onClick={() => setDialogue(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const row = dialogue.row
                  setDialogue(null)
                  remove(row)
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className={css.dialogNote}>
            Pages, assets, forms and redirects must be moved or deleted first. Deleting removes
            every grant on <code>{dialogue.row.id}</code>, whoever set it.
          </p>
        </Dialog>
      ) : null}
    </div>
  )
}

/**
 * The Settings tab: pick a scope and open its layer of the settings document.
 *
 * A link into the ordinary editor rather than a second editing surface — the layer
 * is a document (`multi-site.md` decision 2), so it already has a draft, a preview,
 * a publish, a history and an activity trail, and the editor labels each field
 * Inherited / Overridden here / Removed here (`Inspector`).
 */
function SettingsTab({
  base,
  type,
  registry,
}: {
  base: string
  type: string
  registry: ReturnType<typeof useSites>['registry']
}) {
  const scopes = settingsScopes(registry)
  return (
    <section className={css.section} aria-label="Settings by scope">
      <ListHeader>Settings</ListHeader>
      <ul className={css.scopes}>
        {scopes.map((scope) => (
          <li key={scope.id}>
            <a href={settingsHref(base, type, scope.id)}>
              {scope.name} <Badge mono>{scope.id}</Badge>
            </a>
            <p className={css.note}>{settingsBlurb(scope.id)}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* -------------------------------------------------------------- the gate --- */

function Booting() {
  return (
    <div className={css.screen}>
      <ListHeader>Sites and groups</ListHeader>
      <div className={css.skeletons} aria-hidden="true">
        {SKELETON.map((key) => (
          <div className={css.skeleton} key={key} />
        ))}
      </div>
    </div>
  )
}

/**
 * What the screen says when it has no subject. Three sentences, because the three
 * conditions have nothing in common: a host with one site, a person who is not
 * signed in, and a person who is signed in and not the platform.
 */
function Unavailable({
  gate,
}: {
  gate: Exclude<ReturnType<typeof sitesGate>, { kind: 'ok' | 'booting' }>
}) {
  if (gate.kind === 'absent') {
    return (
      <EmptyState
        title="This deployment has one site"
        body="Sites are switched on by configuring `sites` in createFolio. Until then there is nothing to register."
      />
    )
  }
  if (gate.kind === 'anonymous') {
    return (
      <EmptyState
        title="Sign in to manage sites"
        body="The registry is for signed-in platform administrators."
        action={
          <a href={gate.loginUrl}>
            <Button size="sm" variant="primary">
              Sign in
            </Button>
          </a>
        }
      />
    )
  }
  return <EmptyState title="Sites are managed by the platform" body={gate.reason} />
}
