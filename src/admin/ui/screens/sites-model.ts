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
  chain,
  type GroupRef,
  layerId,
  type Registry,
  type SiteRef,
  type SiteStatus,
} from '../../../core/sites'
import type { BrandRef } from '../../../server/types'
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
  /** The brand's id, or null: on a deployment with no `brands`, and for a row a
   * branded deployment does not serve (`GET /api/sites` still lists it). */
  brand: string | null
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
    brand: g.brand,
  }))
  const sites: SiteRow[] = [...registry.sites].sort(byId).map((s: SiteRef) => ({
    id: s.id,
    kind: 'site',
    name: s.name,
    group: s.group,
    status: s.status,
    hosts: s.hosts,
    preview: s.preview,
    brand: s.brand,
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
  /** A brand id, or '' when none is chosen (and always on a deployment with no `brands`). */
  brand: string
}

/** A lone configured brand is the only choice, so it starts chosen. */
export function emptyForm(kind: 'site' | 'group', brands: readonly BrandRef[] = []): SiteForm {
  return {
    kind,
    id: '',
    name: '',
    group: '',
    status: 'draft',
    preview: '',
    hosts: '',
    brand: brands.length === 1 ? (brands[0]?.id ?? '') : '',
  }
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
    brand: row.brand ?? '',
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
export function formRefusal(
  form: SiteForm,
  mode: 'create' | 'edit',
  brands: readonly BrandRef[] = [],
): string | undefined {
  if (mode === 'create') {
    if (!form.id) return 'Give it an id first'
    if (!ID_PATTERN.test(form.id)) {
      return 'An id is lowercase letters, digits and hyphens, and cannot start or end with a hyphen'
    }
    if (RESERVED_IDS.includes(form.id)) return `“${form.id}” is reserved`
  }
  if (!form.name.trim()) return 'Give it a name first'
  if (brands.length > 0 && !form.brand) return 'Choose a brand first'
  return undefined
}

/** `POST {base}/api/sites`. A group carries only what a group has. */
export function createBody(form: SiteForm): Record<string, unknown> {
  // No `brand` key at all on a deployment with no `brands`, where the server refuses one.
  const base = {
    id: form.id,
    kind: form.kind,
    name: form.name.trim(),
    ...(form.brand ? { brand: form.brand } : {}),
  }
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
  // Never `null`: the server refuses to un-brand a row, so an empty choice sends nothing.
  if (form.brand !== '' && form.brand !== (before.brand ?? '')) out.brand = form.brand
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

/* ------------------------------------------------------------------ brands --- */

/**
 * How the dialog draws the brand (`multi-brand.md` decision 20), decided here so the
 * control is absent rather than disabled when it cannot apply:
 *
 * - `absent`: a deployment with no `brands`, which is every deployment that has never
 *   heard of them, and whose dialog is what it always was.
 * - `fixed`: a site in a group, whose brand is its group's (a site cannot join another
 *   brand's group, and its brand cannot differ), and a group that has sites, whose brand
 *   the server refuses to change (409). Both are shown as a fact.
 * - `choose`: everything else.
 *
 * `hasSites` is whether the group being edited has member sites, which the registry the
 * screen already holds answers (`groupHasSites`).
 */
export function brandField(
  form: SiteForm,
  brands: readonly BrandRef[],
  hasSites = false,
): 'absent' | 'fixed' | 'choose' {
  if (brands.length === 0) return 'absent'
  if (form.kind === 'group') return hasSites ? 'fixed' : 'choose'
  return form.group !== '' ? 'fixed' : 'choose'
}

/** Whether any site is in this group, from the registry the screen holds. */
export function groupHasSites(registry: Registry, id: string): boolean {
  return registry.sites.some((site) => site.group === id)
}

/** A brand's label, or its id when the deployment no longer configures it, or a dash
 * for a row of no brand. */
export function brandLabel(brands: readonly BrandRef[], id: string | null): string {
  if (id === null) return '—'
  return brands.find((brand) => brand.id === id)?.label ?? id
}

/** The groups a site may join: a site cannot join a group of another brand (400), so
 * once a brand is chosen only its groups are offered. A group of no brand, or of one the
 * deployment no longer configures, serves nothing and is never offered (with no brands
 * configured there is nothing to check against). */
export function groupChoices<G extends { brand: string | null }>(
  form: SiteForm,
  groups: readonly G[],
  brands: readonly BrandRef[] = [],
): G[] {
  const served =
    brands.length === 0 ? groups : groups.filter((g) => brands.some((b) => b.id === g.brand))
  return form.brand === '' ? [...served] : served.filter((group) => group.brand === form.brand)
}

/** Joining a group takes its brand with it. */
export function withGroup(
  form: SiteForm,
  group: string,
  groups: readonly { id: string; brand: string | null }[],
): SiteForm {
  const brand = groups.find((g) => g.id === group)?.brand
  return { ...form, group, ...(group !== '' && brand ? { brand } : {}) }
}

/** Choosing a brand drops a group that belongs to another. */
export function withBrand(
  form: SiteForm,
  brand: string,
  groups: readonly { id: string; brand: string | null }[],
): SiteForm {
  const held = groups.find((g) => g.id === form.group)
  return { ...form, brand, group: held && held.brand !== brand ? '' : form.group }
}

/* ---------------------------------------------------------------- settings --- */

/**
 * The scopes whose settings layer exists to be edited: `shared`, groups and sites.
 *
 * With `brand` (a scoped manifest on a deployment with `brands`, whose settings type
 * is that brand's) only that brand's rows, and no `shared`, which such a deployment
 * does not have.
 */
export function settingsScopes(
  registry: Registry,
  brand: string | null = null,
): { id: string; name: string; bottom: boolean }[] {
  const mine = (row: { brand: string | null }) => brand === null || row.brand === brand
  return [
    ...(registry.shared && brand === null ? [{ id: 'shared', name: 'Shared', bottom: true }] : []),
    ...registry.groups
      .filter(mine)
      .map((g) => ({ id: g.id, name: g.name, bottom: chain(registry, g.id).length <= 1 })),
    ...registry.sites
      .filter(mine)
      .map((s) => ({ id: s.id, name: s.name, bottom: chain(registry, s.id).length <= 1 })),
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

/** How the tab explains a scope's layer, by what sits below it. `bottom` is a scope
 * with nothing below it in its chain (`settingsScopes`): the editor draws no
 * Inherited labels there, so the tab must not promise them. */
export function settingsBlurb(scope: string, bottom = scope === 'shared'): string {
  if (scope === 'shared') {
    return 'The base layer. Every site inherits these values until a group or a site overrides them.'
  }
  return bottom
    ? 'The base layer of its chain: nothing sits below it, so every field is set here.'
    : 'Each field reads Inherited, Overridden here or Removed here. Only what is overridden is stored on this scope.'
}
