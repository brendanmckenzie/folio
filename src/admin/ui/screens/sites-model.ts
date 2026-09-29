/**
 * The Sites screen's arithmetic: who may see it, what a registry row looks like as
 * a table row, what a form says before it is sent, and where the Settings tab goes.
 *
 * Pure functions over plain data, for the admin's testing convention — the screen's
 * decisions live where a Node test can reach them, and `Sites.tsx` renders their
 * answers. `access-model.ts` is the pattern: a gate with a case per reason, because
 * the URL is reachable by hand and the refusals have nothing in common.
 *
 * **The registry is the platform's** (`multi-site.md` decision 1): creating and
 * deleting sites and groups, hostnames, the preview origin, group membership and
 * status. A site's own admin edits its *settings*, which are content (decision 2),
 * and the Settings tab is how they get there from here — a link into the scope's
 * layer, which is an ordinary document with a draft, a preview, a publish and a
 * history.
 */
import {
  type GroupRef,
  layerId,
  type Registry,
  type SiteRef,
  type SiteStatus,
} from '../../../core/sites'
import { canManageSites, type Me } from '../../me'
import type { BadgeTone } from '../Badge'
import { href, scopedMount } from '../route'

/* --------------------------------------------------------------- the gate --- */

/**
 * Why this screen is or is not usable.
 *
 * `canManageSites` in `admin/me.ts` is the boolean, and it gates the sidebar entry
 * (`nav.ts`). Inside the screen the boolean is the wrong shape for the reason
 * `AccessGate` gives: a site admin who typed `{base}/sites` and a single-site host
 * that never had a registry are told different things, and neither is "there are no
 * sites".
 *
 * `auth: 'open'` is `ok`: the registry is open there too, which the spec records
 * as the deployment's own choice (`createFolio` warns).
 */
export type SitesGate =
  | { kind: 'ok' }
  | { kind: 'booting' }
  | { kind: 'absent' }
  | { kind: 'anonymous'; loginUrl: string }
  | { kind: 'refused'; reason: string }

export function sitesGate(me: Me, loading: boolean): SitesGate {
  // `me` is a guess until `/me` answers (`OPEN`), and on this screen the guess is a
  // false statement: it would read "this deployment has one site".
  if (loading) return { kind: 'booting' }
  if (!me.sites) return { kind: 'absent' }
  if (canManageSites(me)) return { kind: 'ok' }
  if (me.actor === null) return { kind: 'anonymous', loginUrl: me.loginUrl }
  return {
    kind: 'refused',
    reason:
      'Only a platform administrator manages sites, groups and hostnames. A site administrator edits the site’s settings from the site itself.',
  }
}

/* -------------------------------------------------------------------- rows --- */

/** One registry row as the table draws it: a site and a group in one shape. */
export interface SiteRow {
  id: string
  kind: 'site' | 'group'
  name: string
  /** The group a site is in, or null. Always null for a group. */
  group: string | null
  /** A site's status; null for a group, which is never served. */
  status: SiteStatus | null
  hosts: readonly string[]
  preview: string | null
}

/** Groups first, then sites, each by id — the order the registry reads in. */
export function siteRows(registry: Registry): SiteRow[] {
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const groups: SiteRow[] = [...registry.groups].sort(byId).map((g: GroupRef) => ({
    id: g.id,
    kind: 'group',
    name: g.name,
    group: null,
    status: null,
    hosts: [],
    preview: null,
  }))
  const sites: SiteRow[] = [...registry.sites].sort(byId).map((s: SiteRef) => ({
    id: s.id,
    kind: 'site',
    name: s.name,
    group: s.group,
    status: s.status,
    hosts: s.hosts,
    preview: s.preview,
  }))
  return [...groups, ...sites]
}

export const STATUS_OPTIONS: readonly { value: SiteStatus; label: string; help: string }[] = [
  {
    value: 'draft',
    label: 'Draft',
    help: 'Nobody sees it. Its preview origin answers only someone previewing from the admin.',
  },
  {
    value: 'preview',
    label: 'Preview',
    help: 'Its preview origin is open, its live hostnames are not.',
  },
  { value: 'live', label: 'Live', help: 'Its live hostnames and its preview origin both answer.' },
]

/** Live is the state that changes what visitors see; the others are neutral, and
 * `preview` is amber because it is a state a site is meant to leave. */
export function statusTone(status: SiteStatus): BadgeTone {
  return status === 'live' ? 'ok' : status === 'preview' ? 'warn' : 'neutral'
}

/**
 * What a site without a preview origin cannot do, or null when it has one
 * (`multi-site.md`'s edge cases: "preview, draft mode and shares for it are
 * unavailable and say why"). The `default` row after an upgrade is the case.
 */
export function previewNote(row: Pick<SiteRow, 'kind' | 'preview'>): string | null {
  if (row.kind !== 'site' || row.preview !== null) return null
  return 'No preview origin: preview, draft mode and shares are unavailable for this site.'
}

/** Hostnames in the registry are not routed to the Worker by being there. */
export const ROUTING_NOTE =
  'Adding a hostname here does not send traffic to the Worker. Routing it is a separate step in Cloudflare.'

/* -------------------------------------------------------------------- form --- */

/** The dialog's state. Hosts are one text box, a host to a line, because a list
 * editor for fifty hostnames is more furniture than a paste. */
export interface SiteForm {
  kind: 'site' | 'group'
  id: string
  name: string
  group: string
  status: SiteStatus
  preview: string
  hosts: string
}

export function emptyForm(kind: 'site' | 'group'): SiteForm {
  return { kind, id: '', name: '', group: '', status: 'draft', preview: '', hosts: '' }
}

export function formOf(row: SiteRow): SiteForm {
  return {
    kind: row.kind,
    id: row.id,
    name: row.name,
    group: row.group ?? '',
    status: row.status ?? 'draft',
    preview: row.preview ?? '',
    hosts: row.hosts.join('\n'),
  }
}

/** One host per line, trimmed, blanks dropped. The server lowercases and validates. */
export function parseHosts(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((host) => host.trim())
    .filter(Boolean)
}

/** The server's id rule (`multi-site.md` decision 1), stated so the button can say
 * what is wrong before the request. Reserved ids are the server's to refuse. */
export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
export const RESERVED_IDS: readonly string[] = ['shared', 'default', '*']

/**
 * Why Save is refused, or undefined. The same rules the routes enforce, so the
 * reason arrives before the click; the server stays the authority (uniqueness of an
 * id or a hostname is only knowable there).
 */
export function formRefusal(form: SiteForm, mode: 'create' | 'edit'): string | undefined {
  if (mode === 'create') {
    if (!form.id) return 'Give it an id first'
    if (!ID_PATTERN.test(form.id)) {
      return 'An id is lowercase letters, digits and hyphens, and cannot start or end with a hyphen'
    }
    if (RESERVED_IDS.includes(form.id)) return `“${form.id}” is reserved`
  }
  if (!form.name.trim()) return 'Give it a name first'
  return undefined
}

/** `POST {base}/api/sites`. A group carries only what a group has. */
export function createBody(form: SiteForm): Record<string, unknown> {
  const base = { id: form.id, kind: form.kind, name: form.name.trim() }
  if (form.kind === 'group') return base
  return {
    ...base,
    group: form.group || null,
    status: form.status,
    preview: form.preview.trim() || null,
    hosts: parseHosts(form.hosts),
  }
}

/**
 * `PATCH {base}/api/sites/:id`, holding only what changed — so a rename does not
 * re-send (and re-validate) a preview origin nobody touched. Empty when nothing did.
 */
export function patchBody(form: SiteForm, before: SiteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (form.name.trim() !== before.name) out.name = form.name.trim()
  if (before.kind === 'site') {
    if ((form.group || null) !== before.group) out.group = form.group || null
    if (form.status !== before.status) out.status = form.status
    if ((form.preview.trim() || null) !== before.preview) out.preview = form.preview.trim() || null
  }
  return out
}

/** Whether the host list changed, which is its own route (`PUT …/hosts`). Order is
 * not a change: the registry keeps hosts sorted. */
export function hostsChanged(form: SiteForm, before: SiteRow): boolean {
  const next = [...parseHosts(form.hosts)].sort()
  const prior = [...before.hosts].sort()
  return next.length !== prior.length || next.some((host, i) => host !== prior[i])
}

/* ---------------------------------------------------------------- settings --- */

/** The scopes whose settings layer exists to be edited: `shared`, groups and sites. */
export function settingsScopes(registry: Registry): { id: string; name: string }[] {
  return [
    { id: 'shared', name: 'Shared' },
    ...registry.groups.map((g) => ({ id: g.id, name: g.name })),
    ...registry.sites.map((s) => ({ id: s.id, name: s.name })),
  ]
}

/**
 * Where a scope's settings layer is edited: the ordinary editor, under that scope's
 * mount, on the layer document (`layerId`). The layer is created by this first
 * open, which is the one write that makes it exist (`multi-site.md` decision 8:
 * "A layer row is created only by an editor's first write").
 */
export function settingsHref(base: string, settingsType: string, scope: string): string {
  return href({ name: 'edit', id: layerId(settingsType, scope) }, scopedMount(base, scope))
}

/** How the tab explains a scope's layer, by what sits below it. */
export function settingsBlurb(scope: string): string {
  return scope === 'shared'
    ? 'The base layer. Every site inherits these values until a group or a site overrides them.'
    : 'Each field reads Inherited, Overridden here or Removed here. Only what is overridden is stored on this scope.'
}
