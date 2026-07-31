/**
 * The Settings screen's arithmetic: what each section's rows say, which of them a
 * filter keeps, and how the filter gets into and out of a URL.
 *
 * Pure functions over a `Manifest`, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node test
 * can reach it. `documents-model.ts` is the pattern; this is the third instance.
 *
 * **Everything here is a projection and nothing is a setting.** The screen is a
 * mirror of code (`../../../../docs/ui-architecture.md` decision 6), so there is
 * no parse-and-validate half, no write path and no draft state: a function here
 * takes what the host declared and answers what a row should say about it.
 *
 * Two of those answers are load-bearing beyond their size, because they are the
 * two declarations that produce a refusal an editor meets and cannot explain:
 *
 *   - **`under`** — an Insight that will not be created at the top level. Every
 *     `TypeRow` carries both halves of it: what it may sit under, and whether the
 *     top level is one of them (`topLevel`).
 *   - **`indexed`** — a collection query that refuses a field. Every `FieldRow`
 *     says whether the flag is set *and* whether it can take effect
 *     (`indexedInert`), because `indexed` on a block that is no document type's
 *     root does nothing at all.
 */
import {
  DEFAULT_S_MAXAGE,
  MAX_CACHE_TAG_BYTES,
  MAX_CACHE_TAGS,
  NO_STORE,
  SITE_TAG,
} from '../../../core/cache-tags'
import type { FieldCondition } from '../../../core/conditions'
import type { Field } from '../../../core/fields'
import type { AuthPolicy } from '../../../server/auth/config'
import { type LocaleConfig, localeChain } from '../../../core/locales'
import {
  type BlockSchema,
  canNest,
  type DocumentKind,
  type DocumentType,
  type Manifest,
  titleFieldOf,
} from '../../../core/schema'

/* ---------------------------------------------------------------- sections --- */

export type SectionId = 'types' | 'blocks' | 'globals' | 'locales' | 'signin' | 'hooks' | 'caching'

export interface Section {
  id: SectionId
  label: string
  /** The `id` attribute the jump link targets. Prefixed, because a section named
   * `types` sharing an anchor with anything else on the page is a silent bug. */
  anchor: string
}

/**
 * The sections, in the order they are drawn.
 *
 * Document types and block types lead, which is not the order
 * `ui-architecture.md` lists them in ("locales, globals, document types, block
 * types, auth providers, cache configuration"). That sentence is an enumeration
 * rather than a ranking, and the two questions this screen exists to answer —
 * *why can't I put an Insight at the top level*, *why won't a collection filter
 * on this field* — are both answered in the first two sections. Locales and
 * globals are short and read like reference; they are better beneath the thing
 * somebody came here for than above it.
 */
export const SECTIONS: readonly Section[] = [
  { id: 'types', label: 'Document types', anchor: 'settings-types' },
  { id: 'blocks', label: 'Block types', anchor: 'settings-blocks' },
  { id: 'globals', label: 'Globals', anchor: 'settings-globals' },
  { id: 'locales', label: 'Locales', anchor: 'settings-locales' },
  { id: 'signin', label: 'Sign-in', anchor: 'settings-signin' },
  { id: 'hooks', label: 'Publish hooks', anchor: 'settings-hooks' },
  { id: 'caching', label: 'Caching', anchor: 'settings-caching' },
]

/* --------------------------------------------------------------------- URL --- */

export interface SettingsUrl {
  q: string
}

export function parseSettingsUrl(query: Readonly<Record<string, string>>): SettingsUrl {
  return { q: query.q ?? '' }
}

/** The inverse, as the query object `href` takes. An empty filter leaves the URL
 * rather than sitting in it as `?q=`. */
export function settingsQuery(url: SettingsUrl): Record<string, string | undefined> {
  return { q: url.q || undefined }
}

/**
 * Substring, case-insensitive, over any of several strings — `ui-architecture.md`
 * Resolved 7, which settled search for the whole admin: `team` finds `Our team`
 * and `teem` finds nothing. Fuzzy ranking is refused there for the palette and
 * refused here for the same reason, plus one of this screen's own: a filter over
 * a schema is somebody looking for a name they already know.
 */
export function matchesQuery(q: string, ...text: (string | undefined)[]): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return text.some((t) => (t ?? '').toLowerCase().includes(needle))
}

/* ------------------------------------------------------------------ locales --- */

export interface LocaleRow {
  code: string
  label: string
  /** The locale `Blok.data` holds. Exactly one is. */
  source: boolean
  /** The declared `fallback`, or `''`. */
  fallback: string
  /**
   * What an untranslated field actually reads, in order — the locale, its
   * fallback chain, then the source.
   *
   * Resolved rather than restated, through `localeChain`, which is the same
   * function `fieldValue` reads. A column showing the declared `fallback` alone
   * answers a one-hop question and this screen's reader has a two-hop one: with
   * `de → fr → en` declared, "what does a German visitor see on a field nobody
   * translated" is `en`, and no single config key says so.
   */
  readOrder: string[]
}

export function localeRows(locales: LocaleConfig | undefined): LocaleRow[] {
  if (!locales) return []
  return locales.available.map((locale) => {
    const chain = [locale.code, ...localeChain(locales, locale.code)]
    // The source is the last resort for every locale, whether or not a declared
    // fallback chain happens to reach it.
    if (!chain.includes(locales.default)) chain.push(locales.default)
    return {
      code: locale.code,
      label: locale.label,
      source: locale.code === locales.default,
      fallback: locale.fallback ?? '',
      readOrder: chain,
    }
  })
}

/* ----------------------------------------------------------- document types --- */

export interface TypeRow {
  name: string
  label: string
  kind: DocumentKind
  root: string
  /** Resolved through `titleFieldOf`, so a type that declared none still shows
   * the field its documents are actually titled from. */
  titleField: string
  /** True when `titleField` was derived rather than declared. */
  titleDerived: boolean
  under: readonly string[]
  /**
   * Where a document of this type may be created, as a sentence — the `under`
   * constraint made legible, which is the whole reason this row exists.
   */
  where: string
  /**
   * Whether the top level of the tree is one of the places it may go. `null` for
   * a kind that is not in the tree at all, where the question does not apply.
   *
   * Separate from `where` because it is the refusal an editor actually meets:
   * declaring `under` at all means this type can never sit at the top level,
   * since the top level has no type to match, and that consequence is invisible
   * in the declaration.
   */
  topLevel: boolean | null
  /** `previewPath` for a singleton, resolved to something readable. `''` for a
   * kind that has a URL of its own and needs no stand-in. */
  preview: string
  group: string
  /** The type a bare "New page" creates. */
  isDefault: boolean
  /** Named in `FolioConfig.globals`, so it is loaded into every render. */
  isGlobal: boolean
}

export function typeRows(manifest: Manifest, schema: Record<string, BlockSchema>): TypeRow[] {
  const globals = new Set(manifest.globals)
  const labelOf = (name: string) => manifest.types.find((t) => t.name === name)?.label ?? name
  return manifest.types.map((type) => {
    const derived = titleFieldOf(type, schema[type.root])
    return {
      name: type.name,
      label: type.label,
      kind: type.kind,
      root: type.root,
      titleField: derived ?? '',
      titleDerived: !type.titleField && derived !== undefined,
      under: type.under ?? [],
      where: whereClause(type, labelOf),
      topLevel: type.kind === 'page' ? canNest(type, undefined) : null,
      preview: previewClause(type),
      group: type.group ?? '',
      isDefault: Boolean(type.default),
      isGlobal: globals.has(type.name),
    }
  })
}

function whereClause(type: DocumentType, labelOf: (name: string) => string): string {
  if (type.kind === 'singleton') return 'Not in the tree — exactly one, created on first open'
  if (type.kind === 'record') return 'Not in the tree — edited as a table'
  if (!type.under || type.under.length === 0) return 'Anywhere in the tree'
  return `Only under ${type.under.map(labelOf).join(', ')}`
}

function previewClause(type: DocumentType): string {
  if (type.kind !== 'singleton') return ''
  if (type.previewPath === undefined) return 'No host page configured'
  return type.previewPath === '' ? 'The site root' : `/${type.previewPath}`
}

/* -------------------------------------------------------------- block types --- */

export interface FieldRow {
  name: string
  label: string
  kind: Field['kind']
  required: boolean
  translatable: boolean
  /**
   * `translatable` on a site that declares no locales. The flag is real and does
   * nothing: there is no second locale to hold a value, so no translator ever
   * sees the field.
   */
  translatableInert: boolean
  indexed: boolean
  /**
   * `indexed` on a block that is no document type's root. The index is a *fixed*
   * projection of a document (`collections.md` decision 2), so a flag on a nested
   * block projects nothing — and a `collection` field naming it is refused with a
   * `bad_request`. `GET {base}/api/audit` reports this too; the difference is that
   * here it is beside the declaration.
   */
  indexedInert: boolean
  hidden: boolean
  /** `showIf`, as a sentence. `''` when the field is unconditional. */
  showIf: string
  help: string
  /** The kind's own constraints, flattened — options, allowed link kinds,
   * min/max, which document types a reference may point at. */
  detail: string
  /** `default`, printed. `''` when the field declares none. */
  fieldDefault: string
}

export interface SlotRow {
  name: string
  label: string
  allow: readonly string[]
  max: string
}

export interface PresetRow {
  name: string
  label: string
  /** Field names the preset sets. */
  sets: string[]
  /** `slot: type` for each child it plants. */
  children: string[]
}

export interface BlockCard {
  name: string
  label: string
  /** The field whose value labels the block in the tree. */
  summary: string
  /** Only its presets are offered in the add menu. */
  presetsOnly: boolean
  fields: FieldRow[]
  slots: SlotRow[]
  presets: PresetRow[]
  /**
   * Document types using this block as their root, by label.
   *
   * The fact that makes `indexed` readable: a flag only projects on a root block,
   * so an empty list here is what `indexedInert` is derived from.
   */
  rootFor: string[]
}

export function blockCards(manifest: Manifest): BlockCard[] {
  const roots = new Map<string, string[]>()
  for (const type of manifest.types) {
    roots.set(type.root, [...(roots.get(type.root) ?? []), type.label])
  }
  const localised = Boolean(manifest.locales)

  return manifest.blocks.map((block) => {
    const rootFor = roots.get(block.name) ?? []
    return {
      name: block.name,
      label: block.label,
      summary: block.summary ?? '',
      presetsOnly: Boolean(block.presetsOnly),
      // `blocks` fields are the block's slots, not its values, so they are listed
      // once as slots and not twice.
      fields: Object.entries(block.fields)
        .filter(([, field]) => field.kind !== 'blocks')
        .map(([name, field]) => fieldRow(name, field, rootFor.length > 0, localised)),
      slots: Object.entries(block.fields)
        .filter(
          (entry): entry is [string, Extract<Field, { kind: 'blocks' }>] =>
            entry[1].kind === 'blocks',
        )
        .map(([name, field]) => ({
          name,
          label: field.label ?? name,
          allow: field.allow,
          max: field.max === undefined ? 'Unlimited' : String(field.max),
        })),
      presets: (block.presets ?? []).map((preset) => ({
        name: preset.name,
        label: preset.label,
        sets: Object.keys(preset.data ?? {}),
        children: (preset.children ?? []).map((c) => `${c.slot}: ${c.type}`),
      })),
      rootFor,
    }
  })
}

export function fieldRow(
  name: string,
  field: Field,
  isRoot: boolean,
  localised: boolean,
): FieldRow {
  const translatable = 'translatable' in field && field.translatable === true
  const indexed = 'indexed' in field && field.indexed === true
  return {
    name,
    label: field.label ?? name,
    kind: field.kind,
    required: Boolean(field.required),
    translatable,
    translatableInert: translatable && !localised,
    indexed,
    indexedInert: indexed && !isRoot,
    hidden: Boolean(field.hidden),
    showIf: field.showIf ? conditionText(field.showIf) : '',
    help: field.help ?? '',
    detail: fieldDetail(field),
    fieldDefault: 'default' in field && field.default !== undefined ? printJson(field.default) : '',
  }
}

/**
 * A `showIf` as a sentence.
 *
 * Total over shapes it does not recognise, the same discipline `matches` in
 * `core/conditions.ts` keeps and for the same reason: a schema can be newer than
 * the admin bundle reading it, and a settings row that throws takes the screen
 * down over a condition it merely could not phrase.
 */
export function conditionText(condition: FieldCondition): string {
  if ('all' in condition) return condition.all.map(conditionText).join(' and ')
  if ('any' in condition) return condition.any.map(conditionText).join(' or ')
  if ('not' in condition) return `not (${conditionText(condition.not)})`
  if ('field' in condition) {
    if ('eq' in condition) return `${condition.field} is ${printJson(condition.eq)}`
    if ('ne' in condition) return `${condition.field} is not ${printJson(condition.ne)}`
    if ('in' in condition) {
      return `${condition.field} is one of ${condition.in.map(printJson).join(', ')}`
    }
    if ('isSet' in condition) {
      return condition.isSet ? `${condition.field} has a value` : `${condition.field} is empty`
    }
  }
  return 'an unrecognised condition'
}

/** One field kind's own constraints, flattened to a phrase. `''` when the kind
 * carries none worth printing. */
function fieldDetail(field: Field): string {
  switch (field.kind) {
    case 'number':
      return range(field.min, field.max)
    case 'select':
      return field.options.map((o) => o.value).join(', ')
    case 'asset':
      return field.accept ?? ''
    case 'multiasset':
      return [field.accept, field.max === undefined ? '' : `up to ${field.max}`]
        .filter(Boolean)
        .join(', ')
    case 'multilink':
      return [
        field.allow ? `${field.allow.join(', ')} targets` : '',
        field.types ? `types: ${field.types.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(', ')
    case 'richtext':
      return [
        field.marks ? `marks: ${field.marks.join(', ')}` : 'every mark',
        field.nodes ? `nodes: ${field.nodes.join(', ')}` : 'every node',
        field.headingLevels ? `headings: h${field.headingLevels.join(', h')}` : '',
      ]
        .filter(Boolean)
        .join('; ')
    case 'reference':
      return field.types ? `types: ${field.types.join(', ')}` : 'any document'
    case 'references':
      return [
        field.types ? `types: ${field.types.join(', ')}` : 'any document',
        range(field.min, field.max),
      ]
        .filter(Boolean)
        .join(', ')
    case 'collection':
      return [
        field.type
          ? `type: ${(Array.isArray(field.type) ? field.type : [field.type]).join(', ')}`
          : 'every type',
        field.filterable ? `filterable: ${field.filterable.join(', ')}` : '',
        field.maxPerPage === undefined ? '' : `≤ ${field.maxPerPage} per page`,
        field.defaultOrder ? `order: ${field.defaultOrder.field} ${field.defaultOrder.dir}` : '',
      ]
        .filter(Boolean)
        .join('; ')
    default:
      return ''
  }
}

function range(min: number | undefined, max: number | undefined): string {
  if (min === undefined && max === undefined) return ''
  if (min === undefined) return `at most ${max}`
  if (max === undefined) return `at least ${min}`
  return `${min}–${max}`
}

/** A `Json` default or condition operand as display text. Strings unquoted —
 * `title is Home` reads better than `title is "Home"` and no operand here is
 * ambiguous enough to need the quotes. */
function printJson(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Which block cards survive the filter, and each one's fields narrowed to the
 * matching ones.
 *
 * **This is the answer to eighty-seven block types**, which is what the reference
 * project has. A match on the block's own name or label keeps the whole card —
 * you asked for that block, you want all of it. A match on a *field* keeps the
 * card with only the matching fields, so searching `indexed` or `alt` answers
 * "which blocks have one of those" without making you read the other eighty-six.
 */
export function filterBlocks(cards: readonly BlockCard[], q: string): BlockCard[] {
  if (!q.trim()) return [...cards]
  const out: BlockCard[] = []
  for (const card of cards) {
    if (matchesQuery(q, card.name, card.label)) {
      out.push(card)
      continue
    }
    const fields = card.fields.filter((f) => matchesQuery(q, f.name, f.label, f.kind))
    const slots = card.slots.filter((s) => matchesQuery(q, s.name, s.label, ...s.allow))
    const presets = card.presets.filter((p) => matchesQuery(q, p.name, p.label))
    if (fields.length || slots.length || presets.length) {
      out.push({ ...card, fields, slots, presets })
    }
  }
  return out
}

/**
 * Which filtered cards are drawn open, by name.
 *
 * Two rules, and the second is the one worth arguing:
 *
 * 1. **A card kept because one of its *fields* matched opens.** Its answer is
 *    inside it, so leaving it collapsed would make the filter report a hit and
 *    then hide it. A card kept because its own name matched normally stays shut —
 *    the reader asked for a block, not for its schema, and eighty-seven cards
 *    expanded at once is the flat dump this screen exists to avoid.
 * 2. **Unless it is the only one left, in which case it opens too.** Narrowing
 *    eighty-seven blocks to one *is* asking for that block, whichever way the
 *    query got there, and a single collapsed row with nothing else on the page is
 *    a dead end. This is also what makes the types table's root-block link land
 *    somewhere useful, since that link filters by an exact block name.
 *
 * A set of names rather than a per-card predicate, because rule 2 cannot be
 * decided from one card.
 */
export function openCards(cards: readonly BlockCard[], q: string): Set<string> {
  if (!q.trim()) return new Set()
  if (cards.length === 1) return new Set([cards[0]!.name])
  return new Set(cards.filter((c) => !matchesQuery(q, c.name, c.label)).map((c) => c.name))
}

/* ------------------------------------------------------------------ globals --- */

export interface GlobalRow {
  name: string
  label: string
  root: string
  /** Where the admin previews it, since it has no URL of its own. */
  preview: string
}

/**
 * `FolioConfig.globals`, joined back to the types they name.
 *
 * A name with no matching type cannot happen — `validateGlobals` throws at
 * construction for it — so this drops rather than reports: a row saying "unknown"
 * would be a row for a state the server refuses to boot in.
 */
export function globalRows(manifest: Manifest): GlobalRow[] {
  const rows: GlobalRow[] = []
  for (const name of manifest.globals) {
    const type = manifest.types.find((t) => t.name === name)
    if (!type) continue
    rows.push({
      name,
      label: type.label,
      root: type.root,
      preview: previewClause(type),
    })
  }
  return rows
}

/* ------------------------------------------------------------------ sign-in --- */

export interface ProviderRow {
  id: string
  label: string
  /** How a person gets through it. */
  flow: string
  /** What happens to an identity the provider verified that Folio has never seen. */
  unknownEmail: string
}

/**
 * The providers, from `GET {base}/api/me`'s `policy` — **not from the manifest.**
 *
 * `undefined` covers three states the screen treats alike and should: `auth:
 * 'open'` (no providers exist), a `/me` that has not answered yet, and a caller
 * the route refused. All three mean "no policy to show", and the section's own
 * prose distinguishes the first from the others using `Me.mode`.
 */
export function providerRows(policy: AuthPolicy | undefined): ProviderRow[] {
  return (policy?.providers ?? []).map((provider) => ({
    id: provider.id,
    label: provider.label,
    flow: provider.redirect ? 'Redirect to the provider' : 'Emailed sign-in link',
    unknownEmail:
      provider.provision === 'create'
        ? `Creates ${article(provider.provisionRole ?? 'viewer')}`
        : 'Refused — access is a list someone maintains',
  }))
}

/** `an editor`, `a viewer`. Worth the three lines: the roles are `viewer`,
 * `editor`, `publisher` and `admin`, so a hard-coded `a` is wrong half the time
 * and "Creates a editor" reads as a bug in the screen rather than a fact about the
 * site. */
function article(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`
}

/* -------------------------------------------------------------------- facts --- */

/**
 * A row in one of the two sections that are not lists of declarations: session
 * policy and caching. Three columns, and the third is the one that earns the
 * shape — a number with no explanation beside it is the thing this screen is
 * trying not to be.
 */
export interface Fact {
  label: string
  value: string
  why: string
}

export function sessionFacts(policy: AuthPolicy | undefined): Fact[] {
  if (!policy) return []
  return [
    {
      label: 'Session length',
      value: policy.sessionDays === 1 ? '1 day' : `${policy.sessionDays} days`,
      why: 'How long a sign-in lasts before the editor asks again.',
    },
    {
      label: 'Sign-in links per hour',
      value: `${policy.linksPerHour} per address`,
      why: 'Further requests are dropped silently, so a full inbox is not a way to enumerate accounts.',
    },
  ]
}

/**
 * Caching, which is the one section with nothing host-declared in it.
 *
 * `FolioConfig` has no cache key: `platform/caching.md` made every number here a
 * fixed decision rather than a parameter, and the one switch that exists lives in
 * the host's `wrangler.jsonc` where Folio cannot see it. So this mirrors the
 * *code* — the constants come straight out of `core/cache-tags.ts`, so a screen
 * that says seven days and a header that says something else is not possible —
 * and the last row states plainly that whether any of it is in effect is not a
 * question this screen can answer.
 */
export function cacheFacts(): Fact[] {
  return [
    {
      label: 'Browser cache',
      value: 'max-age=0',
      why: 'Zero on purpose: a purge cannot reach a browser cache, so a longer TTL buys a stale copy nothing can evict.',
    },
    {
      label: 'Edge cache',
      value: `s-maxage=${DEFAULT_S_MAXAGE} (${Math.round(DEFAULT_S_MAXAGE / 86_400)} days)`,
      why: 'Long, because a publish purges by tag rather than waiting for expiry. Not overridable.',
    },
    {
      label: 'Preview',
      value: NO_STORE,
      why: 'A draft is never cached anywhere.',
    },
    {
      label: 'Tags per page',
      value: `${MAX_CACHE_TAGS} max, ${MAX_CACHE_TAG_BYTES / 1024} KB of header`,
      why: `Workers Cache's own limits. A page over either is coarsened to '${SITE_TAG}', never truncated.`,
    },
    {
      label: 'In effect?',
      value: 'Not visible from here',
      why: 'Caching needs "cache": { "enabled": true } in the host\'s wrangler.jsonc. Folio sets two headers; whether anything acts on them is the deployment\'s answer, not the config\'s.',
    },
  ]
}

/* ----------------------------------------------------------------- filtering --- */

export interface HookRow {
  event: string
  /** Awaited before the write responds, rather than riding `waitUntil`. */
  awaited: boolean
}

export function hookRows(manifest: Manifest): HookRow[] {
  const hooks = manifest.hooks
  if (!hooks) return []
  const awaited = new Set(hooks.awaited)
  return hooks.declared.map((event) => ({ event, awaited: awaited.has(event) }))
}

/**
 * Every section's rows, filtered, in one call — so the screen renders a section
 * from a single value and the jump nav is derived from the same one.
 *
 * The filter narrows *every* section rather than only the long one. A box that
 * silently applied to blocks and not to document types would be a control whose
 * scope a reader has to guess, and the short sections cost nothing to include.
 */
export interface SettingsView {
  types: TypeRow[]
  blocks: BlockCard[]
  globals: GlobalRow[]
  locales: LocaleRow[]
  providers: ProviderRow[]
  session: Fact[]
  hooks: HookRow[]
  cache: Fact[]
  /** Totals before filtering, per section, so a heading can say `4 of 87`. */
  totals: Record<SectionId, number>
}

export function settingsView(
  manifest: Manifest,
  schema: Record<string, BlockSchema>,
  /**
   * `Me.policy`, from `GET {base}/api/me`. **Two arguments and not one**, because
   * the screen is fed by two routes on purpose: the manifest describes what the
   * host declared and is public, the policy describes a security decision and is
   * not. Threading it through here rather than reading it off a `Me` keeps this
   * file unaware of roles and permissions, which it has no business deciding.
   */
  policy: AuthPolicy | undefined,
  q: string,
): SettingsView {
  const allTypes = typeRows(manifest, schema)
  const allBlocks = blockCards(manifest)
  const allGlobals = globalRows(manifest)
  const allLocales = localeRows(manifest.locales)
  const allProviders = providerRows(policy)
  const allSession = sessionFacts(policy)
  const allHooks = hookRows(manifest)
  const allCache = cacheFacts()

  return {
    types: allTypes.filter((t) =>
      matchesQuery(q, t.name, t.label, t.kind, t.root, t.group, t.where, t.titleField),
    ),
    blocks: filterBlocks(allBlocks, q),
    globals: allGlobals.filter((g) => matchesQuery(q, g.name, g.label, g.root)),
    locales: allLocales.filter((l) => matchesQuery(q, l.code, l.label)),
    providers: allProviders.filter((p) => matchesQuery(q, p.id, p.label, p.flow)),
    session: allSession.filter((f) => matchesQuery(q, f.label, f.value)),
    hooks: allHooks.filter((h) => matchesQuery(q, h.event)),
    cache: allCache.filter((f) => matchesQuery(q, f.label, f.value)),
    totals: {
      types: allTypes.length,
      blocks: allBlocks.length,
      globals: allGlobals.length,
      locales: allLocales.length,
      signin: allProviders.length + allSession.length,
      hooks: allHooks.length,
      caching: allCache.length,
    },
  }
}

/** How many rows a section is currently showing, for its heading's count. */
export function shownIn(view: SettingsView, id: SectionId): number {
  switch (id) {
    case 'types':
      return view.types.length
    case 'blocks':
      return view.blocks.length
    case 'globals':
      return view.globals.length
    case 'locales':
      return view.locales.length
    case 'signin':
      return view.providers.length + view.session.length
    case 'hooks':
      return view.hooks.length
    case 'caching':
      return view.cache.length
  }
}

/**
 * Which sections the jump nav lists and the screen draws.
 *
 * With no filter, all of them — including the empty ones, because "this site
 * declares no locales" is an answer somebody came for, and a section that
 * vanishes when it is empty makes its absence indistinguishable from a screen
 * that forgot to render it. With a filter, only the sections that matched:
 * keeping the rest would be seven headings over one row.
 */
export function visibleSections(view: SettingsView, q: string): Section[] {
  if (!q.trim()) return [...SECTIONS]
  return SECTIONS.filter((section) => shownIn(view, section.id) > 0)
}

/** True when the filter matched nothing anywhere — one empty state for the whole
 * screen, rather than seven. */
export function isEmpty(view: SettingsView, q: string): boolean {
  return Boolean(q.trim()) && visibleSections(view, q).length === 0
}
