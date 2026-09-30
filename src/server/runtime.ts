/**
 * Everything `createFolio` derives from its config once, in one object the routes
 * and the HTML pages share.
 *
 * Nothing here knows about Hono, a Request or a Context: the helpers take the
 * bindings a caller already has. That is what lets the same document-and-D1 work
 * be reached from a route, from `Folio`'s public methods, and (next phase) from a
 * Durable Object alarm, which has no request to derive bindings from.
 */
import { toManifest, toRegistry, toSchemaIndex, type Registry } from '../core/block'
import { type Doc, newUid } from '../core/doc'
import { isBareLayer, mergeLayers } from '../core/layers'
import { indexedFieldNames } from '../core/index-projection'
import {
  dataOf,
  type LocaleConfig,
  type LocaleContext,
  localeContext,
  validateLocales,
} from '../core/locales'
import { latestMigrationId, type Migration, validateMigrations } from '../core/migrate'
import {
  collectionQueries,
  type ContentPage,
  type ContentQuery,
  type ResolvedCollection,
} from '../core/query'
import { formIds, linkedIds, referencedIdsAllLocales } from '../core/refs'
import type { PreviewWrap } from '../core/render-wrap'
import { buildResolution, type Resolution } from '../core/resolve'
import {
  blankSubtree,
  defaultType,
  type DocumentType,
  type Manifest,
  type SchemaIndex,
  titleFieldOf,
  titleOf,
  typeByName,
  validateGlobals,
  validatePresets,
  validateTypes,
} from '../core/schema'
import {
  layerId,
  layerSeed,
  type Registry as SiteRegistry,
  servingRegistry,
  SHARED_SCOPE,
  SINGLE_SITE_CHAIN,
  type SiteContext,
  type SiteRef,
  singletonTypeOf,
  type Surface,
} from '../core/sites'
import { ancestorPaths, type StoryMeta, type StoryNode } from '../core/story'
import { type ResolvedAuth, resolveAuth, validateSitesAuth } from './auth/config'
import { cachePurgeHooks, type PurgeCapability } from './cache-purge'
import type { AuditContext } from './audit'
import { type ContentProjection, contentProjection } from './content-index'
import { type ResolvedDescribe, validateDescribe } from './describe'
import { type ResolvedForms, validateForms } from './form-responses'
import { compileForm, formsByIds } from './forms'
import { type ResolvedGate, validateGate } from './gate'
import {
  createHookRunner,
  type FolioHooks,
  type HookRunner,
  type HookRunnerCtx,
  validateHooks,
} from './hooks'
import type { PublishDeps } from './publish'
import { type QueryDeps, runQuery } from './query'
import { spaceBroadcastHooks, spaceNameFor } from './space-events'
import { redirectsAtPaths } from './redirects'
import { readRegistry, registrySnapshot, type ResolvedSites, SITE_ID } from './sites'
import {
  ensureSingleton,
  listStories,
  pickServing,
  publishedDocsByIds,
  storiesFor,
  storyById,
} from './stories'
import type {
  BrandRef,
  FolioBrand,
  FolioBrandedConfig,
  FolioConfig,
  FolioLogger,
  FolioSingleConfig,
  PreviewMode,
  ReadBindings,
  SpaceStub,
  StoryStub,
} from './types'
import type { FolioDb } from './db'

const DEFAULT_BASE = '/folio'

/** `url`'s path, query and fragment on another origin. */
function onOrigin(url: string, origin: string): string {
  const parsed = new URL(url, origin)
  return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** Client entries and stylesheets for one of the two HTML pages Folio serves. */
export interface PageAssets {
  entries: string[]
  stylesheets: string[]
}

/**
 * What a render needs beyond the document
 * (`../../docs/specs/content-model/collections.md` decision 6).
 *
 * Everything here is optional and every default is the cheapest answer, which is
 * the point: `resolve(bindings, doc)` now costs one bounded query instead of a
 * full table scan, and a caller opts *up* from there.
 */
export interface ResolveOptions {
  /** Resolve pulled-in documents from their live drafts. The preview's mode. */
  draft?: boolean
  locale?: string
  /** 1-based page for every `collection` field in the document. */
  page?: number
  /**
   * A full-text term for every `searchable` `collection` field in the document
   * (`../../docs/specs/content-model/full-text-search.md` architecture decision 10), threaded
   * through to `collectionQueries` beside `page`. A `collection` that does not
   * declare `searchable: true` ignores it, the same double enforcement
   * `filterable` already has.
   */
  search?: string
  /**
   * The story being rendered. Two things need it: its ancestors join the
   * resolution (a breadcrumb has to resolve), and in `draft` mode its draft values
   * are patched over its published row in any collection that lists it.
   *
   * A subset of `StoryMeta` rather than the row, so a host that has an id, a path
   * and a type can pass a literal.
   */
  story?: Pick<StoryMeta, 'id' | 'path' | 'type' | 'title'>
  /**
   * `'all'` loads every story, exactly as this function did before collections —
   * the full map a navigation built from the tree wants. Default `'needed'`: the
   * document's own links, references, ancestors and the documents it pulls in.
   */
  stories?: 'needed' | 'all'
  /**
   * The site this render is for (`../../docs/specs/foundation/multi-site.md`
   * decision 3), on a deployment with `sites`. **Every id-set read takes its
   * chain**, so a reference, a link, a collection or an ancestor on one site never
   * resolves to another site's content: an id outside the chain resolves exactly
   * like a deleted one. It also fills `Resolution.site` and `.path`.
   *
   * Absent is the single-site chain, and a resolution with neither field — which
   * is what keeps a deployment with no `sites` byte-identical. `null` is a
   * multi-site render for no site: an empty chain, which resolves nothing. On a
   * deployment with `brands` it is required, and must be the resolving brand's
   * own site (`BrandRuntime.resolve`): absent would be `default`'s chain, whatever
   * brand that is.
   */
  site?: SiteRender | null
}

/** The rendering site as `resolve` takes it: the gated row, its surface, its chain. */
export interface SiteRender {
  site: SiteRef
  surface: Surface
  chain: readonly string[]
}

/**
 * `FolioConfig.sites`, validated, plus the one registry snapshot this isolate
 * holds (`server/sites.ts`). Null on a deployment with no `sites`, and then
 * nothing anywhere reads the registry.
 */
export interface SitesRuntime extends ResolvedSites {
  /** The registry, from this isolate's ten-second snapshot. */
  registry: (env: unknown) => Promise<SiteRegistry>
  /** The registry straight from the primary, for a write validating a claim. */
  fresh: (env: unknown) => Promise<SiteRegistry>
  /** Drop the snapshot, after this isolate wrote a registry change. */
  drop: () => void
  /**
   * The configured globals and the settings type: every document that layers. On a
   * deployment with `brands`, every brand's, which is what the one purge and space
   * broadcast hook set is built over; a render reads its own brand's `layered`.
   */
  layered: readonly string[]
  /** The raw binding, for the reads that must be `first-primary`: the registry and preview grants. */
  rawDb: (env: unknown) => D1Database
  /**
   * The configured brand ids (`multi-brand.md` decision 4), or null with no
   * `brands`. `registry` is served from the rows of these brands only; `fresh`
   * holds every row, for the registry writes that validate against all of them.
   */
  brands: readonly string[] | null
}

/**
 * Everything a block registry decides, for one brand (`multi-brand.md` decision
 * 6). A deployment with no `brands` has exactly one, whose `brand` is null, and
 * `FolioRuntime`'s old members of the same names answer from it; one with
 * `brands` has one per brand, and those members throw.
 *
 * **A request finds its brand once**, in `withScope` (`c.var.brand`); off a
 * request, from the gated site (`rt.forScope`). Nothing picks a brand by default.
 */
export interface BrandRuntime {
  /** `{ id, label }`, or null for the one brand of a deployment with no `brands`. */
  brand: BrandRef | null
  registry: Registry
  /** The block schemas, indexed by name. What a migration and the audit both walk. */
  schema: SchemaIndex
  /** Every declared document type, with `root` sugar already expanded. */
  types: readonly DocumentType[]
  typeOf: (name: string | undefined) => DocumentType | undefined
  defaultType: DocumentType
  /** What `GET {base}/schema` answers for this brand. Contains no functions. */
  manifest: Manifest
  globals: readonly string[]
  /** The globals and the settings type: the documents that layer, on a deployment with `sites`. */
  layered: readonly string[]
  /** The site-settings singleton, or undefined. */
  settings: string | undefined
  migrations: readonly Migration[]
  schemaId: string | null
  indexedFields: ReadonlySet<string>
  gate: ResolvedGate | null
  forms: ResolvedForms | null
  describe: ResolvedDescribe | null
  previewWrap: PreviewWrap | undefined
  /** This brand's preview entry and stylesheets (decision 9). */
  page: (which: 'preview') => PageAssets
  seed: (type: DocumentType | undefined, title: string) => Doc
  /**
   * How `story`'s draft starts if its object does not exist yet. On a deployment
   * with `brands` a layer's seed depends on its scope's chain (decision 5), so a
   * layer needs `registry` and throws without one rather than guess.
   */
  seedFor: (story: { id: string; type: string; title: string }, registry?: SiteRegistry) => Doc
  draftFor: (bindings: ReadBindings, story: StoryMeta, registry?: SiteRegistry) => Promise<Doc>
  draftForWithSyncId: (
    bindings: ReadBindings,
    story: StoryMeta,
    registry?: SiteRegistry,
  ) => Promise<{ doc: Doc; syncId: number }>
  draft: (bindings: ReadBindings, id: string, registry?: SiteRegistry) => Promise<Doc>
  titleFor: (story: StoryMeta, doc: Doc) => string
  titlesFor: (story: StoryMeta, doc: Doc) => Record<string, string> | undefined
  projection: (story: StoryMeta, doc: Doc) => ContentProjection
  /** `FolioRuntime.resolve`, with this brand's schema. On a branded runtime `opts.site` is required and must be this brand's. */
  resolve: (bindings: ReadBindings, doc?: Doc, opts?: ResolveOptions) => Promise<Resolution>
  /** `FolioRuntime.query`, with this brand's indexed fields and gate. Branded: `site` is required and must be this brand's. */
  query: (
    bindings: ReadBindings,
    q: ContentQuery,
    chain?: readonly string[],
    site?: SiteRef,
  ) => Promise<ContentPage>
  publishDeps: (
    bindings: ReadBindings,
    hookCtx: HookRunnerCtx,
  ) => PublishDeps & { logger: FolioLogger }
  /** `FolioRuntime.auditContext` for this brand: its types, its settings type, its own rows. */
  auditContext: (env: unknown) => Promise<AuditContext>
}

export interface FolioRuntime {
  /**
   * One `BrandRuntime` per brand, keyed by id; a deployment with no `brands` has
   * one, keyed `null` (`multi-brand.md` decision 6).
   */
  brands: ReadonlyMap<string | null, BrandRuntime>
  /**
   * The brand of a scope or site, by the registry snapshot the caller already
   * holds. With no `brands`: always the one. With them: null for `shared`, for no
   * scope, and for a scope the snapshot does not hold — which decision 4 has
   * already fenced off. **Never a default brand.**
   */
  forScope: (registry: SiteRegistry, scope: string | null) => BrandRuntime | null
  /**
   * `FolioConfig.locales`, validated, or undefined for a single-locale site
   * (`localisation.md`). Undefined is the case that must stay free: no locale
   * reaches a `Resolution`, no URL grows a prefix, no story row grows a `urls`
   * map.
   */
  locales: LocaleConfig | undefined
  /**
   * The `LocaleContext` for a code, or undefined for the source locale, an
   * undeclared code, or no locales at all. The one place a string turns into the
   * fallback chain the renderer reads.
   */
  localeOf: (code: string | undefined) => LocaleContext | undefined
  /**
   * The story path a locale-decorated URL names, per the host's **own** `route`.
   *
   * Folio builds its preview URLs by calling `route(path, locale)`, so it can
   * recover the path by asking the same function rather than by assuming a
   * convention: for each candidate produced by dropping leading segments, does
   * `route(candidate, locale)` equal the pathname we were given? The first match
   * is the answer, exactly. A host that encodes the locale as a subdomain or a
   * query parameter has no prefix to drop and gets the pathname back unchanged,
   * with no special case written for it (decision 5's "the host owns the URL
   * shape").
   */
  pathForLocale: (pathname: string, locale: string | undefined) => string
  /**
   * `FolioConfig.auth`, resolved and validated
   * (`../../docs/specs/foundation/identity-and-access.md`). `mode: 'open'` is
   * the deliberately-open deployment; every route gate short-circuits on it.
   *
   * Typed at `unknown` rather than making `FolioRuntime` generic: the only thing
   * a provider's `Env` parameter is ever handed is the same `c.env` the host's
   * own `bindings` accessor gets, so widening it here costs nothing real and
   * saves threading a type parameter through every route module.
   */
  auth: ResolvedAuth<unknown>
  /**
   * `FolioConfig.logger`, defaulted to `console` — never null, unlike `gate` and
   * `describe`. Every one of the roughly forty call sites this replaces used to
   * log unconditionally, so an unconfigured host must keep doing exactly that
   * rather than start silently doing nothing.
   */
  logger: FolioLogger
  /**
   * Not `FolioConfig`'s — there is no public key for this, and there never
   * should be. `formRoutes`' PATCH handler calls `purgeFormLayout(id,
   * rt.formPurgeCapability, rt.logger)` rather than passing `undefined`
   * (`platformPurge`'s own default) so a workers test can inject a fake
   * `PurgeCapability` and observe the route's own call to it — otherwise
   * unobservable in this environment, `cache-purge.ts`'s own header explains
   * why. Undefined for every real host, which is exactly `purgeFormLayout`'s
   * own default and therefore no behaviour change at all.
   */
  formPurgeCapability?: PurgeCapability
  /** Where the routes are mounted, with no trailing slash. */
  base: string
  /** `FolioConfig.sites`, validated, or null for a deployment with no `sites`. */
  sites: SitesRuntime | null
  /** The host's `route`, or the single-site default. */
  route: (path: string, locale?: string, site?: SiteRef) => string
  /** True when a Vite dev client is configured, so the pages ship the preamble. */
  dev: boolean
  /**
   * The host's promise that its `fetch` calls `folio.draftAt`
   * (`../../docs/specs/platform/draft-mode.md` decision 4). Read in exactly one
   * place — where a share link picks its destination.
   */
  draftMode: boolean
  /** A story's public URL, and the same URL with the preview flag on it. */
  withUrls: <T extends StoryMeta>(story: T) => T
  /**
   * `withUrls` for one site of a multi-site deployment: `route` is handed the
   * site, and the preview URLs are on its preview origin. A function returning
   * the decorator, rather than a second parameter on `withUrls`, because
   * `rows.map(rt.withUrls)` is the idiom and would hand it the index.
   */
  urlsFor: (site: SiteRef | undefined) => <T extends StoryMeta>(story: T) => T
  /** `withUrls` over a whole tree. */
  decorate: (nodes: StoryNode[], site?: SiteRef) => StoryNode[]
  stub: (bindings: ReadBindings, id: string) => StoryStub
  /**
   * The one space object (`../../docs/specs/editing/live-collaboration.md`), or null when the
   * host has not declared the binding — in which case everything that channel
   * carries is simply absent rather than broken.
   *
   * One instance per **scope** (`multi-site.md` decision 19): `'space'` for
   * `default`, which is every deployment with no `sites`, and `'space:<scope>'`
   * otherwise. It is the only thing that can know who is in the site rather than in
   * a document, so it must not know who is in another one. An absent scope is
   * `default`.
   */
  space: (bindings: ReadBindings, scope?: string | null) => SpaceStub | null
  /**
   * The hook runner on its own, for the two write paths that fire an event and
   * need none of the rest of `PublishDeps`: `runMigrations` and `reindex`
   * (`../../docs/specs/platform/caching.md`). Same host hooks, same internal list, same
   * ordering — `publishDeps` builds its own `hooks` from this, so there is one
   * place a runner is assembled rather than two that could register different
   * internal consumers.
   */
  hookRunner: (hookCtx: HookRunnerCtx) => HookRunner<unknown>
  page: (which: 'admin' | 'preview') => PageAssets
}

/**
 * `types`, with the `root: 'page'` sugar expanded (`document-types.md`
 * architecture decision 1). Mutually exclusive: both keys, or neither, is a
 * config mistake that throws here rather than turning into a 500 on whichever
 * route reaches it first.
 */
export function documentTypes<Env>(
  config: Pick<FolioSingleConfig<Env>, 'types' | 'root'>,
): readonly DocumentType[] {
  if (config.types && config.root !== undefined) {
    throw new Error(
      "folio: pass either `types` or `root`, not both — `root` is sugar for one 'page' type",
    )
  }
  if (config.types) return config.types
  if (config.root !== undefined) {
    // `name: 'page'` regardless of the root block's own name: that is the value
    // 0006 defaults every existing row's `type` column to.
    return [{ name: 'page', label: 'Page', kind: 'page', root: config.root }]
  }
  throw new Error(
    'folio: no document types configured — pass `types` (or `root` for a single page type)',
  )
}

/**
 * Which publish hooks the host declared, by name. Absent when there are none, so
 * the screen can tell "no hooks" from "hooks I failed to read".
 *
 * On the manifest, and staying there: a declared hook is a fact about the host's
 * *code*, which is exactly what `server/app.ts`'s rule for the ungated `/schema`
 * route covers. Its sibling — the sign-in providers and session policy — started
 * here and moved to `GET {base}/api/me`, because a security decision is not a
 * declaration and does not inherit that licence. See `auth/config.ts`'s
 * `AuthPolicy`.
 *
 * `Object.keys` rather than a list checked against `HOOK_EVENTS`: `validateHooks`
 * has already thrown for anything not in that vocabulary, so every key here is a
 * real event and a new event needs no edit in this function.
 */
export function manifestHooks<Env>(hooks: FolioHooks<Env> | undefined): Pick<Manifest, 'hooks'> {
  if (!hooks) return {}
  const declared = Object.keys(hooks).filter((key) => key !== 'await')
  if (declared.length === 0) return {}
  return { hooks: { declared, awaited: [...(hooks.await ?? [])] } }
}

/**
 * Checks `FolioConfig.assets` **at the point the admin or preview page is
 * built**, not at construction, and the timing is the decision.
 *
 * The failure it replaces is the worst one in the config surface: with no
 * `assets`, the page below builds an empty `entries` array and the admin answers
 * *200 with a mount point and no script tag* — a blank white page, an empty
 * console, and a network tab in which every request succeeded. Nothing about it
 * points at the cause.
 *
 * The value is the `__FOLIO_ASSETS__` global `folio/vite` defines, and the host
 * has to hand it over rather than Folio reading it, because a `define` only
 * rewrites the source the host's own Vite compiles — Folio's server code is a
 * dependency and is never transformed. That extra step is what makes it easy to
 * forget.
 *
 * **Not** in `createRuntime` beside `validateAuth` and friends, even though it
 * reads like one of them. Those describe the content model and are wrong for any
 * host; this one is wrong only for a host that serves the admin, and sixteen
 * workers fixtures construct a Folio to exercise routing and content without
 * ever asking for an admin page. Making them all declare a field they do not use
 * would be noise around the real signal. Failing here instead puts the error at
 * the URL somebody is looking at while they are confused by it.
 *
 * The shape is checked as well as the presence, because the two fields that
 * matter are the two a host is likely to fumble when hand-rolling the object
 * instead of passing the global straight through.
 */
export function validateAssets(assets: FolioSingleConfig<unknown>['assets']): void {
  const fix =
    "pass the plugin's global: `assets: __FOLIO_ASSETS__` in the same file as `createFolio`"
  if (!assets) {
    throw new Error(
      `folio: 'assets' is required — without it the admin page renders no script tag and shows a blank screen. ${fix}`,
    )
  }
  for (const key of ['admin', 'preview'] as const) {
    if (typeof assets[key] !== 'string' || !assets[key]) {
      throw new Error(`folio: 'assets.${key}' must be a non-empty string. ${fix}`)
    }
  }
}

/**
 * `validateAssets` for a deployment with `brands`, at the same moment and for the
 * same reason: the admin entry, and for a preview the brand's own bundle, which the
 * plugin's record form bakes into `assets.brands` (`multi-brand.md` decision 9).
 * Construction has already checked that `assets.brands` names exactly the brands.
 * `brand` null checks the admin half only and answers nothing useful.
 */
export function validateBrandedAssets(
  assets: FolioBrandedConfig<unknown>['assets'],
  brand: string | null,
): { preview: string; previewCss?: string[] } {
  const fix =
    "pass the plugin's global, built with a `blocks` record: `assets: __FOLIO_ASSETS__` in the same file as `createFolio`"
  if (!assets) {
    throw new Error(
      `folio: 'assets' is required — without it the admin page renders no script tag and shows a blank screen. ${fix}`,
    )
  }
  if (typeof assets.admin !== 'string' || !assets.admin) {
    throw new Error(`folio: 'assets.admin' must be a non-empty string. ${fix}`)
  }
  if (brand === null) return { preview: '' }
  const bundle = assets.brands?.[brand]
  if (typeof bundle?.preview !== 'string' || !bundle.preview) {
    throw new Error(`folio: 'assets.brands.${brand}.preview' must be a non-empty string. ${fix}`)
  }
  return bundle
}

/** A registry's rows of one brand. */
const ownRows = (registry: SiteRegistry, brand: string): SiteRegistry => ({
  sites: registry.sites.filter((s) => s.brand === brand),
  groups: registry.groups.filter((g) => g.brand === brand),
  shared: registry.shared,
})

/**
 * `FolioConfig.sites`, checked at construction (`multi-site.md`, "Construction-time
 * validation"), like every other key above: a mistake here is a deployment that
 * serves nothing, and the request that would discover it is the first visitor's.
 *
 * Only what the config itself can get wrong. Everything about particular sites —
 * ids, hostnames, preview origins, the claims between them — is validated where
 * it is written, on the registry routes (`server/sites.ts`).
 *
 * - `admin` is an absolute origin, `https:` (or `http:` on `localhost`): the one
 *   origin sign-in and passkeys bind to.
 * - `settings`, when named, is a declared `singleton`.
 * - `route` is present, because every site's URLs leave the admin origin and a
 *   default relative `route` would resolve against it.
 * - every layered type's layer id fits a story id (64 characters) for the longest
 *   scope id a registry write accepts (32).
 * - the provisioning rules of decision 17 (`validateSitesAuth`), beside the
 *   `resolveAuth` that produced `auth`: a provider this deployment's grants cannot
 *   honour throws here, not at the first sign-in.
 */
export function validateSites<Env>(
  config: FolioConfig<Env>,
  brands: readonly Pick<PreparedBrand, 'types' | 'globals' | 'settings'>[],
  logger: FolioLogger,
  auth: ResolvedAuth<unknown>,
): ResolvedSites | null {
  const sites = config.sites
  if (!sites) return null

  let admin: URL
  try {
    admin = new URL(sites.admin)
  } catch {
    throw new Error(`folio: 'sites.admin' must be an absolute origin, like 'https://cms.example'`)
  }
  const local = admin.hostname === 'localhost' || admin.hostname.endsWith('.localhost')
  if (admin.protocol !== 'https:' && !(admin.protocol === 'http:' && local)) {
    throw new Error(`folio: 'sites.admin' must be https (or http on localhost)`)
  }
  if (sites.admin.replace(/\/+$/, '') !== admin.origin) {
    throw new Error(`folio: 'sites.admin' must be an origin with no path, like '${admin.origin}'`)
  }
  // With `brands` a brand's own `settings` is checked with the rest of the brand
  // (`prepareBrand`), and `sites.settings` is refused outright (`validateBrands`).
  if (
    !config.brands &&
    sites.settings !== undefined &&
    typeByName(brands[0]?.types ?? [], sites.settings)?.kind !== 'singleton'
  ) {
    throw new Error(
      `folio: 'sites.settings' names '${sites.settings}', which is not a singleton type`,
    )
  }
  if (!config.route) {
    throw new Error(
      "folio: 'route' is required with 'sites': every site's URLs are absolute, on its own hosts",
    )
  }
  // `sng_` + type + `:` + a 32-character scope id, within `validate.ts`'s 64.
  for (const brand of brands) {
    const layered = [...brand.globals, ...(brand.settings ? [brand.settings] : [])]
    for (const name of layered) {
      if (`sng_${name}:`.length + 32 > 64) {
        throw new Error(
          `folio: '${name}' is too long to layer: its layer ids would exceed 64 characters`,
        )
      }
    }
  }
  validateSitesAuth(auth)
  if (config.auth === 'open') {
    logger.warn(
      "folio: 'sites' with auth: 'open' — every scope is editable and every preview origin shows drafts to anyone who reaches it",
    )
  }
  return {
    admin: admin.origin,
    adminHost: admin.hostname,
    settings: config.brands ? undefined : sites.settings,
    resolve: sites.resolve,
  }
}

/** The keys that move into a brand (`multi-brand.md` decision 3), refused beside `brands`. */
const BRAND_KEYS = [
  'blocks',
  'root',
  'types',
  'globals',
  'previewCss',
  'previewWrap',
  'gate',
  'forms',
  'describe',
  'migrations',
] as const

/**
 * `FolioConfig.brands`, checked at construction (`multi-brand.md` decision 3), before
 * any brand's own checks run: each refusal a throw naming the key. Null for a
 * config with no `brands`, which is every config that existed before them.
 *
 * `assets` may be absent, as it may on a single-brand config: it is checked where
 * the admin or a preview page is built (`validateAssets`). When present, its
 * `brands` must name exactly the configured brands, because a preview for a brand
 * with no bundle is a blank page and a bundle for a brand nobody configured is a
 * key pointing at the wrong module.
 */
export function validateBrands<Env>(
  config: FolioConfig<Env>,
): readonly (readonly [string, FolioBrand<Env>])[] | null {
  if (config.brands === undefined) return null
  const brands = config.brands
  // A JS host, or a cast, can reach these; the union type already refuses them.
  const loose = config as unknown as Record<string, unknown>
  if (typeof brands !== 'object' || brands === null) {
    throw new Error("folio: 'brands' must be an object keyed by brand id")
  }
  if (!config.sites) {
    throw new Error(
      "folio: 'brands' needs 'sites': a brand is a property of a site row, and a deployment with no sites has one",
    )
  }
  const entries = Object.entries(brands)
  if (entries.length === 0) {
    throw new Error("folio: 'brands' is empty: name at least one, or leave 'brands' out")
  }
  for (const [id, brand] of entries) {
    if (!SITE_ID.test(id)) {
      throw new Error(
        `folio: brand id '${id}' must be 1–32 lowercase letters, digits or inner hyphens, like a site id`,
      )
    }
    if (typeof brand?.label !== 'string' || !brand.label.trim()) {
      throw new Error(`folio: 'brands.${id}.label' must be a non-empty string`)
    }
  }
  for (const key of BRAND_KEYS) {
    if (loose[key] !== undefined) {
      throw new Error(
        `folio: '${key}' belongs to a brand beside 'brands': set 'brands.<id>.${key}'`,
      )
    }
  }
  if ((config.sites as { settings?: unknown }).settings !== undefined) {
    throw new Error(
      "folio: 'sites.settings' belongs to a brand beside 'brands': set 'brands.<id>.settings'",
    )
  }
  const assets = loose.assets as Record<string, unknown> | undefined
  if (assets !== undefined) {
    for (const key of ['preview', 'previewCss'] as const) {
      if (assets[key] !== undefined) {
        throw new Error(
          `folio: 'assets.${key}' belongs to a brand beside 'brands': pass the plugin's 'assets.brands'`,
        )
      }
    }
    const bundles = assets.brands
    const named = bundles && typeof bundles === 'object' ? Object.keys(bundles).sort() : []
    const configured = entries.map(([id]) => id).sort()
    if (named.join('\n') !== configured.join('\n')) {
      throw new Error(
        `folio: 'assets.brands' must name exactly the brands in 'brands' (${configured.join(', ')}); it names ${named.length ? named.join(', ') : 'none'}`,
      )
    }
  }
  return entries
}

/** One brand's config, validated: what `createRuntime` builds a `BrandRuntime` from. */
interface PreparedBrand {
  id: string | null
  label: string | null
  registry: Registry
  schema: SchemaIndex
  types: readonly DocumentType[]
  globals: readonly string[]
  settings: string | undefined
  migrations: readonly Migration[]
  gate: ResolvedGate | null
  describe: ResolvedDescribe | null
  forms: ResolvedForms | null
  previewCss: readonly string[]
  previewWrap: PreviewWrap | undefined
}

/**
 * Every check a single-brand config gets, for one brand, in the order it always ran
 * them. A branded deployment's refusals name the brand; a single-brand one's messages
 * are exactly what they were.
 */
function prepareBrand<Env>(
  id: string | null,
  brand: FolioBrand<Env> | FolioSingleConfig<Env>,
  settings: string | undefined,
): PreparedBrand {
  try {
    const registry = toRegistry(brand.blocks)
    const schema = toSchemaIndex(registry)
    // Construction-time, before any request is served: an invalid preset (an
    // unknown type or slot, a disallowed child, a cycle) is a config mistake,
    // not a runtime surprise a caller discovers three requests later.
    validatePresets(schema)
    // Same timing, same reason, and the same for `types`: an unknown root block,
    // two defaults, a duplicate name or an `under` chain that never reaches the
    // top level all throw here (`../../docs/specs/foundation/document-types.md`).
    const types = documentTypes(brand)
    validateTypes(types, schema)
    // Same timing, same reason, and after `validateTypes` because it needs both
    // `types` and `schema`: a `gate` whose field is translatable, unindexed, the
    // wrong kind, or declared on no `page` root is a gate the editor believes in
    // and nothing enforces (`../../docs/specs/platform/visitor-access.md` decision 8).
    const gate = validateGate(brand.gate, types, schema)
    // Same timing, same reason: `describe.fn` that is not a function, an unknown
    // key, or a `concurrency` outside 1–8 is a config mistake, and the request
    // that would otherwise discover it is a background `waitUntil` after an
    // upload — where nobody is looking and the only symptom is alt text that
    // never appears (`../../docs/specs/content-model/media-library.md` decision 8).
    const describe = validateDescribe(brand.describe)
    // Same timing, same reason, one rung more insistent than `describe`: the
    // request that would otherwise discover a `verify` that is not a function is an
    // anonymous POST from the public internet, and `verify` fails closed — so the
    // symptom is a contact form that silently collects nothing, on the one route in
    // this library a stranger can reach (`../../docs/specs/content-model/forms.md` decision 11).
    const forms = validateForms(brand.forms)
    // Same timing, same reason: `globals` naming an unknown type or a non-
    // singleton one is a config mistake, not a runtime surprise the first page
    // render discovers (`../../docs/specs/content-model/globals.md`).
    validateGlobals(brand.globals, types)
    // Same timing, same reason: a duplicate migration id, or a set whose declared
    // order and lexicographic order disagree, would migrate documents in an order
    // that depends on which comparison happened to be used
    // (`../../docs/specs/foundation/schema-migrations.md`). **A brand's ids carry
    // the brand** (`multi-brand.md` decision 16), because `schema_migrations` is
    // one table keyed by id; the rules below the prefix are the single-brand ones.
    const migrations = brand.migrations ?? []
    if (id !== null) {
      for (const m of migrations) {
        if (typeof m.id !== 'string' || !m.id.startsWith(`${id}/`)) {
          throw new Error(
            `folio: migration id '${m.id}' must start with its brand, '${id}/' (like '${id}/0001-…'): schema_migrations is keyed by id alone`,
          )
        }
      }
      validateMigrations(migrations.map((m) => ({ ...m, id: m.id.slice(id.length + 1) })))
    } else {
      validateMigrations(migrations)
    }
    if (
      id !== null &&
      settings !== undefined &&
      typeByName(types, settings)?.kind !== 'singleton'
    ) {
      throw new Error(`folio: 'settings' names '${settings}', which is not a singleton type`)
    }
    return {
      id,
      label: 'label' in brand ? brand.label : null,
      registry,
      schema,
      types,
      globals: brand.globals ?? [],
      settings,
      migrations,
      gate,
      describe,
      forms,
      previewCss: brand.previewCss ?? [],
      previewWrap: brand.previewWrap,
    }
  } catch (err) {
    if (id === null || !(err instanceof Error)) throw err
    throw new Error(`folio: brand '${id}': ${err.message.replace(/^folio: /, '')}`, { cause: err })
  }
}

/** The error every old `rt.*` member answers on a branded runtime (`BRAND_MEMBERS`). */
function noBrand(key: string): Error {
  return new Error(
    `folio: rt.${key} has no brand on a deployment with 'brands': read it from c.var.brand, or from rt.forScope(registry, scope)`,
  )
}

export function createRuntime<Env>(config: FolioConfig<Env>): FolioRuntime {
  // `brands`' own refusals first (`multi-brand.md` decision 3): a moved key at the
  // top level, `brands` without `sites`, an `assets.brands` naming other brands.
  // Null with no `brands`, and then everything below is one brand, as it always was.
  const brandEntries = validateBrands(config)
  const branded = brandEntries !== null
  // Every check a single-brand config gets, per brand (`prepareBrand`), in the order
  // they always ran among themselves; a branded deployment's refusals name the
  // brand. The deployment's own checks — hooks, locales, auth, sites — follow.
  const prepared: readonly PreparedBrand[] = brandEntries
    ? brandEntries.map(([id, brand]) => prepareBrand(id, brand, brand.settings))
    : [
        prepareBrand(
          null,
          config as FolioSingleConfig<Env>,
          (config as FolioSingleConfig<Env>).sites?.settings,
        ),
      ]
  // Same timing, same reason: a typo in `hooks` (or in `await`) should fail
  // loudly once, not silently never fire (`../../docs/specs/platform/publish-hooks.md`).
  validateHooks(config.hooks)
  // Same timing, same reason: a default locale that is not available, a duplicate
  // code, a fallback that does not exist or one that cycles would each turn into
  // a page rendered in the wrong language rather than an error
  // (`../../docs/specs/content-model/localisation.md`).
  validateLocales(config.locales)
  // Same timing, one rung more insistent: `auth` has no default at all, so an
  // absent key throws here rather than quietly leaving the CMS open
  // (`identity-and-access.md` checkpoint 2). The widening cast is explained on
  // `FolioRuntime.auth`.
  const auth = resolveAuth(config.auth) as ResolvedAuth<unknown>
  // No validation, unlike everything above: there is nothing to get wrong about
  // a value that is either absent (default `console`, unchanged behaviour) or a
  // host's own object satisfying two methods.
  const logger: FolioLogger = config.logger ?? console
  // Not a `FolioConfig` key — see `FolioRuntime.formPurgeCapability`. No public
  // type names this, so a real `config` object can never carry it; the cast is
  // local to this one read.
  const formPurgeCapability = (
    config as FolioConfig<Env> & { formPurgeCapability?: PurgeCapability }
  ).formPurgeCapability
  const locales = config.locales
  const base = config.basePath ?? DEFAULT_BASE
  const route: FolioRuntime['route'] = config.route ?? ((path: string) => `/${path}`)
  const assetBase = `${base}/asset`

  // Same timing, same reason: an admin origin that is not one, or a settings type
  // that is not a singleton, is a deployment that serves nothing
  // (`../../docs/specs/foundation/multi-site.md`). Null with no `sites`, and then
  // no snapshot exists and nothing below ever reads the registry.
  const resolvedSites = validateSites(config, prepared, logger, auth)
  /** A brand's layered documents: its globals and its settings type, once each. */
  const layeredOf = (b: PreparedBrand): readonly string[] => [
    ...new Set([...b.globals, ...(b.settings ? [b.settings] : [])]),
  ]
  // Every brand's, for the one internal hook set; a single brand's is its own.
  const allGlobals = [...new Set(prepared.flatMap((b) => b.globals))]
  const brandIds = brandEntries ? brandEntries.map(([id]) => id) : null
  const sites: SitesRuntime | null = resolvedSites
    ? (() => {
        const rawDb = (env: unknown) => config.bindings(env as Env).db
        // With `brands`, the snapshot is served from the configured brands' rows
        // only (`servingRegistry`, decision 4): a row of no configured brand is no
        // candidate and has no chain. `fresh` is every row, for the writes.
        const fresh = (env: unknown) => readRegistry(rawDb(env), { branded })
        const snapshot = registrySnapshot({
          read: (db) =>
            readRegistry(db, { branded }).then((registry) =>
              brandIds ? servingRegistry(registry, brandIds) : registry,
            ),
        })
        const out: SitesRuntime = {
          ...resolvedSites,
          registry: (env: unknown) => snapshot.get(rawDb(env)),
          fresh,
          drop: snapshot.drop,
          layered: [...new Set(prepared.flatMap(layeredOf))],
          rawDb,
          brands: brandIds,
        }
        return out
      })()
    : null

  const localeOf = (code: string | undefined) => localeContext(locales, code)
  /** Declared locales other than the source, in declaration order. */
  const otherLocales = (locales?.available ?? [])
    .map((l) => l.code)
    .filter((code) => code !== locales?.default)

  /**
   * `route`'s URL with the preview flag on it, and — for a non-source locale —
   * the locale as a query parameter as well.
   *
   * The locale is in the query rather than inferred from the path because
   * `handle()` has to read it back and the path is the host's shape, not Folio's.
   * Omitted for the source locale, so a site with locales configured and viewing
   * its default produces the byte-identical preview URL it always did.
   *
   * `mode` defaults to `'preview'` so both existing call sites (`withUrls`,
   * immediately below) are unchanged; `'draft'` is `platform/mcp-server.md`
   * decision 5's chrome-free render, added by `withUrls` for `draftUrl`.
   */
  const previewUrlFor = (
    path: string,
    locale?: string,
    mode: PreviewMode = 'preview',
    site?: SiteRef,
  ) => {
    const live = route(path, locale, site)
    // On a multi-site deployment drafts are served only on a site's preview
    // origin (`multi-site.md` decision 13), so the preview URL is the live URL's
    // path on that origin. A site with no preview origin keeps the live URL: its
    // preview is unavailable, and the page it lands on says so.
    const url = site?.preview ? onOrigin(live, site.preview) : live
    const flagged = `${url}${url.includes('?') ? '&' : '?'}_folio=${mode}`
    return locale === undefined || locale === locales?.default
      ? flagged
      : `${flagged}&locale=${encodeURIComponent(locale)}`
  }

  /**
   * An unrouted document is handed back untouched: it has no path, so there is
   * no public URL and no preview URL to build (`document-types.md` architecture
   * decision 2). `url`/`previewUrl` stay absent rather than becoming `''`, so
   * nothing can accidentally navigate to one.
   *
   * `urls`/`previewUrls` appear only when locales are configured, so a
   * single-locale site's payload is unchanged (`localisation.md`). `url` remains
   * the source locale's, which keeps every existing consumer — a sitemap, the
   * admin's "View live" — reading the same value it always did.
   */
  const urlsFor =
    (site: SiteRef | undefined) =>
    <T extends StoryMeta>(story: T): T => {
      if (story.path === null) return story
      const path = story.path
      const decorated: T = {
        ...story,
        url: route(path, undefined, site),
        previewUrl: previewUrlFor(path, undefined, 'preview', site),
        draftUrl: previewUrlFor(path, undefined, 'draft', site),
      }
      if (!locales) return decorated
      return {
        ...decorated,
        urls: Object.fromEntries(locales.available.map((l) => [l.code, route(path, l.code, site)])),
        previewUrls: Object.fromEntries(
          locales.available.map((l) => [l.code, previewUrlFor(path, l.code, 'preview', site)]),
        ),
        draftUrls: Object.fromEntries(
          locales.available.map((l) => [l.code, previewUrlFor(path, l.code, 'draft', site)]),
        ),
      }
    }
  const withUrls = urlsFor(undefined)

  /**
   * The inverse of `route`, for the one place Folio needs it: its own preview
   * branch, which is handed a URL the *admin* built from `previewUrls` and has to
   * find the story behind it. See `FolioRuntime.pathForLocale`.
   */
  const trim = (path: string) => path.split('?')[0]!.replace(/^\/+|\/+$/g, '')

  const pathForLocale = (pathname: string, locale: string | undefined): string => {
    const clean = trim(pathname)
    if (locale === undefined || locale === locales?.default) return clean
    const segments = clean ? clean.split('/') : []
    for (let i = 0; i <= segments.length; i++) {
      const candidate = segments.slice(i).join('/')
      if (trim(route(candidate, locale)) === clean) return candidate
    }
    // No candidate reproduces this URL, so the host encodes its locale somewhere
    // other than the path. The pathname is the path.
    return clean
  }

  const decorate = (nodes: StoryNode[], site?: SiteRef): StoryNode[] =>
    nodes.map((n) => ({ ...urlsFor(site)(n), children: decorate(n.children, site) }))

  const stub = ({ story }: ReadBindings, id: string): StoryStub =>
    story.get(story.idFromName(id)) as unknown as StoryStub

  /** The scope's space instance, or null for a host without the binding. */
  const space = ({ space: ns }: ReadBindings, scope: string | null = null): SpaceStub | null =>
    ns ? (ns.get(ns.idFromName(spaceNameFor(scope))) as unknown as SpaceStub) : null

  /**
   * Hooks Folio registers on itself, run before any host hook for the same
   * event (`hooks.ts`'s `InternalHooks`) — the seam
   * `../../docs/specs/platform/publish-hooks.md` decision 5 built so there would be one
   * after-commit path rather than two conventions.
   *
   * Two occupants now, each a plain `FolioHooks` literal written exactly the
   * way a host writes one: the space channel's broadcast, and the cache purge
   * (`../../docs/specs/platform/caching.md`). No second path, no ordering of its own beyond
   * this array's, and nothing for a future internal consumer to copy except
   * these.
   *
   * The purge is second on purpose. Both are after-commit and neither depends
   * on the other, but telling the open editors is the one whose latency a
   * person is watching, and the purge is the one that awaits a network call.
   *
   * **One set for the deployment, over every brand's globals and layered types**
   * (`multi-brand.md` decision 15): the runner, `await` and every purge are
   * deployment-level, and a type that is a global in any brand is purged as one.
   */
  const internalHooks: FolioHooks<Env>[] = [
    spaceBroadcastHooks<Env>(config, allGlobals, logger),
    // `undefined` for the capability, not omitted: a positional default only
    // applies when the argument itself is `undefined`, and skipping past it
    // to reach `logger` would mean naming the third parameter, which JS has
    // no syntax for.
    cachePurgeHooks<Env>(
      allGlobals,
      undefined,
      logger,
      sites ? { registry: sites.registry, layered: sites.layered } : undefined,
    ),
  ]

  const hookRunner = (hookCtx: HookRunnerCtx): HookRunner<unknown> =>
    createHookRunner<Env>(
      config.hooks,
      { env: hookCtx.env as Env, waitUntil: hookCtx.waitUntil },
      internalHooks,
      logger,
    )

  /**
   * One brand's half of the runtime (`multi-brand.md` decision 6): every closure
   * below reads this brand's registry, types and policy, and nothing else's. A
   * deployment with no `brands` builds exactly one, from the top-level config, and
   * it is the runtime it always was.
   */
  const buildBrand = (b: PreparedBrand): BrandRuntime => {
    const { registry, schema, types, globals, migrations, gate, describe, forms } = b
    const schemaId = latestMigrationId(migrations)
    const typeOf = (name: string | undefined) => typeByName(types, name)
    const fallbackType = defaultType(types)
    // Root blocks only (`../../docs/specs/content-model/collections.md` decision 2): the index is
    // a *fixed* projection of a document, so which fields it holds cannot depend on
    // which blocks happen to be inside it. `/folio/audit` reports an `indexed` flag
    // on a block that is no type's root, which would otherwise do nothing silently.
    const indexed = indexedFieldNames(schema, types)
    const layered = layeredOf(b)

    /**
     * A render or query for a site of another brand, or for none, is refused
     * rather than answered with this brand's schema (decision 6's "never a
     * default brand").
     */
    const assertOwnSite = (site: SiteRef | undefined, what: string) => {
      if (site?.brand !== b.id) {
        throw new Error(
          `folio: brand '${b.id}' cannot ${what} ${site ? `site '${site.id}' (brand '${site.brand}')` : 'with no site'}: a chain never crosses a brand`,
        )
      }
    }

    /**
     * A starting document for one document type: its root block's own 'default'
     * preset (field-defaults-and-presets.md, decision 3) — no template config key
     * of its own. A root with no such preset seeds a bare root, exactly as before
     * that spec.
     *
     * The title is written into the *type's* title field rather than always
     * `title`, so a `person` record whose root has `fullName` and no `title` gets
     * its name where the schema actually keeps it (`titleFieldOf`).
     */
    const seed = (type: DocumentType | undefined, title: string): Doc => {
      const t = type ?? fallbackType
      const def = schema[t.root]
      const preset = def?.presets?.some((p) => p.name === 'default') ? 'default' : undefined
      const bloks = blankSubtree(schema, t.root, null, null, 'a0', preset)
      const root = bloks[0]!
      const field = titleFieldOf(t, def)
      if (field && field in root.data) root.data[field] = title
      return { root: root.uid, bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])) }
    }

    /**
     * A layer that has something below it starts **bare** (`multi-site.md`
     * decision 8): a root with `data: {}`, no preset and no title, so every field
     * reads as inherited. A root seeded with defaults would override the whole
     * chain below it on the first keystroke.
     */
    const bareSeed = (type: DocumentType | undefined): Doc => {
      const t = type ?? fallbackType
      const uid = newUid()
      return {
        root: uid,
        bloks: { [uid]: { uid, type: t.root, parent: null, slot: null, order: 'a0', data: {} } },
      }
    }

    /** `seedFor` once the layer question is answered: `'bare'`, or anything else is `seed`. */
    const seedAs = (story: { type: string; title: string }, layer: 'bare' | 'full' | null): Doc =>
      layer === 'bare' ? bareSeed(typeOf(story.type)) : seed(typeOf(story.type), story.title)

    /**
     * How `story`'s draft starts if its object does not exist yet: bare for a
     * layer with something below it, else `seed`. **Only a multi-site deployment
     * layers**, so a single-site singleton (`sng_<type>`, the `default` layer of a
     * chain of one) seeds exactly as it always did.
     *
     * **With `brands` the layer's chain decides** (`multi-brand.md` decision 5):
     * there is no `shared` below every scope, so a group's layer and a layer on a
     * site with no group are the bottom of their chains and seed full. That needs the
     * registry, and a layer asked for without one throws rather than guess bare.
     * Without `brands` the id alone answers (`isBareLayer`), exactly as before.
     */
    const seedFor = (
      story: { id: string; type: string; title: string },
      registry?: SiteRegistry,
    ): Doc => {
      if (!sites) return seedAs(story, null)
      if (!branded) return seedAs(story, isBareLayer(story.id) ? 'bare' : 'full')
      const layer = singletonTypeOf(story.id)
      if (!layer) return seedAs(story, null)
      if (!registry) {
        throw new Error(
          `folio: the layer '${story.id}' seeds by its chain on a deployment with 'brands': pass the registry`,
        )
      }
      return seedAs(story, layerSeed(registry, layer.scope))
    }

    const draftFor = (bindings: ReadBindings, story: StoryMeta, registry?: SiteRegistry) =>
      stub(bindings, story.id).getOrInit(seedFor(story, registry))

    const draftForWithSyncId = (
      bindings: ReadBindings,
      story: StoryMeta,
      registry?: SiteRegistry,
    ) => stub(bindings, story.id).getOrInitWithSyncId(seedFor(story, registry))

    const draft = async (bindings: ReadBindings, id: string, registry?: SiteRegistry) => {
      const meta = await storyById(bindings.db, id)
      return stub(bindings, id).getOrInit(
        meta ? seedFor(meta, registry) : seed(undefined, 'Untitled'),
      )
    }

    /**
     * The seed of a layer read inside a render's chain, on a deployment with `brands`:
     * the chain a render holds is the registry's answer already, and a layer's own
     * chain is its tail from the layer's scope (a site's is itself, its group; a
     * group's is itself), so the layer is bare exactly when a scope sits below it.
     */
    const seedInChain = (story: StoryMeta, chain: readonly string[]): Doc => {
      const layer = singletonTypeOf(story.id)
      if (!layer) return seedAs(story, null)
      const at = chain.indexOf(layer.scope)
      return seedAs(story, at !== -1 && at < chain.length - 1 ? 'bare' : 'full')
    }

    /**
     * What a document is called, from its own type's title field, falling back to
     * the row's cached title rather than to the literal `'Untitled'`: the row is
     * the better answer for a root block that offers no title field at all.
     */
    const titleFor = (story: StoryMeta, doc: Doc) =>
      titleOf(doc, typeOf(story.type), schema, story.title)

    /**
     * The title in every non-source locale, for the tree's per-locale label cache.
     *
     * A locale whose title field is untranslated is **omitted** rather than
     * recorded with the source value: the admin falls back to `title` for a missing
     * entry anyway, and storing the English under `fr` would make a stale cache
     * indistinguishable from a real translation the moment somebody added one.
     */
    const titlesFor = (story: StoryMeta, doc: Doc): Record<string, string> | undefined => {
      if (!locales) return undefined
      const source = titleFor(story, doc)
      const out: Record<string, string> = {}
      for (const code of otherLocales) {
        const translated = titleOf(doc, typeOf(story.type), schema, source, localeOf(code))
        if (translated !== source) out[code] = translated
      }
      return out
    }

    /**
     * The context a document needs that the document itself cannot hold.
     *
     * **This used to load every story in the site, on every page render**
     * (`../../docs/specs/content-model/collections.md` decision 6). Invisible at 40 pages and
     * fatal at 800, and collections are what made it urgent — an insights index is
     * exactly the site that has 800 rows. It now loads the ids the document actually
     * needs:
     *
     *   - the targets of its `multilink` fields **and of the link marks inside its
     *     richtext**. The second half is not optional and is the trap: a Folio-native
     *     link mark stores a structured `attrs.link` and has no `href` at all,
     *     because the href is derived from the resolution at render time. Miss those
     *     ids and every internal link inside prose renders as unstyled text with no
     *     `<a>` around it (see `core/refs.ts`).
     *   - the targets of its `reference` fields, across every locale.
     *   - the same two sets again for each document it pulls in — a referenced person
     *     card and a global header both contain links of their own, and `RenderBlok`
     *     empties `docs` on the way down but never `stories`.
     *   - its own ancestors, by path, for a breadcrumb (`opts.story`).
     *
     * `opts.stories: 'all'` is the escape hatch: every story, exactly as before, for
     * a host that wants the full map (a navigation built from the tree). A sitemap
     * should call `folio.stories(env)` or `folio.query(env, …)` instead.
     *
     * `draft` is what the preview passes: an editor looking at a page that
     * references a form should see the form as they just edited it, not the last
     * published copy. A live page always resolves published content. The same
     * split applies to globals — but only in draft mode is a global's row
     * ensured into existence (`ensureSingleton`): that write is fine for an
     * editor's preview, rare and never on the hot path, while a live page must
     * cost nothing extra for a global nobody has ever opened in the admin, so
     * the published branch below only *reads* the derived id and lets a missing
     * row mean exactly what a missing published_doc already means — nothing to
     * show, no error thrown.
     */
    const resolve = async (
      bindings: ReadBindings,
      doc?: Doc,
      opts?: ResolveOptions,
    ): Promise<Resolution> => {
      const db = bindings.db
      // **A brand renders only its own sites** (`multi-brand.md` decision 6): with
      // `brands` a render names its site, and the site is this brand's, or it is not
      // a render this brand may make. Absent would be the `default` chain, which may
      // belong to another brand; `null` is still "no site", an empty chain.
      if (branded && opts?.site !== null) assertOwnSite(opts?.site?.site, 'resolve')
      // The rendering site's chain, or the one scope of a deployment with no
      // `sites`. Bound on every id-set read below either way (`stories.ts`'s
      // `chainClause`).
      const render = opts?.site ?? undefined
      const chain = opts?.site === null ? [] : (render?.chain ?? SINGLE_SITE_CHAIN)
      const urlsOf = urlsFor(render?.site)
      const active = localeOf(opts?.locale)
      // Absent for the source locale, so a default-locale resolution is byte-
      // identical to a pre-localisation one (`localisation.md` decision 5). Every
      // read in `RenderBlok` goes through this one value.
      const localeField = active ? { locale: active } : {}
      const pageField = opts?.page !== undefined ? { page: opts.page } : {}
      const searchField = opts?.search !== undefined ? { search: opts.search } : {}
      // The documents this render loads as globals, and each one's layer ids in the
      // chain, most general first (`multi-site.md` decision 8). With no `sites` the
      // chain is `['default']` and `layerId` is `sng_<type>`, so this is the list,
      // the ids and the statements it always was; on a multi-site deployment the
      // settings type is loaded too, and every chain scope contributes a layer.
      const loaded = sites ? layered : globals
      const layerIds = new Map(
        loaded.map((name) => [name, [...chain].reverse().map((scope) => layerId(name, scope))]),
      )
      const globalIds = [...layerIds.values()].flat()

      // A caller with no document at all wants the map and nothing else, so it gets
      // every story: there is no document to narrow to, and answering with an empty
      // map would be a silent behaviour change for `folio.resolve(env)`.
      const wantAll = opts?.stories === 'all' || !doc

      /** Pass one: what `doc` itself points at, plus the ancestors of its story. */
      const directIds = doc
        ? [...linkedIds(doc, schema), ...referencedIdsAllLocales(doc, schema)]
        : []
      const refIds = doc ? referencedIdsAllLocales(doc, schema) : []

      const known = new Map<string, StoryMeta>()
      const remember = (rows: readonly StoryMeta[]) => {
        for (const row of rows) known.set(row.id, row)
      }
      const requested = [...new Set([...directIds, ...globalIds])]
      const ancestors = wantAll ? [] : ancestorPaths(opts?.story?.path ?? null)
      const pass1 = wantAll
        ? listStories(db, undefined, chain)
        : storiesFor(db, requested, ancestors, chain)
      /**
       * **Breadcrumb ancestors follow decision 5** (`multi-site.md`): pass one reads
       * every scope's row at each ancestor path, and keeps per path only the row
       * `pickServing` would serve there — so a site that forked `info` shows its own
       * Info in the breadcrumb of an inherited `info/parking`, and a nearer redirect
       * leaves the crumb out rather than linking to a page the site does not serve.
       *
       * The redirects at those paths are a second statement, sent alongside pass
       * one, and only on a chain of more than one scope: with one scope there is no
       * shadowing to decide, which is why a single-site render's statement count
       * does not move (`read-session.test.ts`).
       */
      const ancestorRedirects =
        chain.length > 1 && ancestors.length > 0
          ? redirectsAtPaths(db, chain, ancestors)
          : Promise.resolve([])
      const served = async (rows: readonly StoryMeta[]): Promise<StoryMeta[]> => {
        if (chain.length <= 1 || ancestors.length === 0) return [...rows]
        const redirects = await ancestorRedirects
        // A row asked for by id stays whatever it is — a link to the shared `info`
        // still resolves to it — and a row that is only here as a crumb stays only
        // if it is the one this site serves at its path.
        const byId = new Set(requested)
        const crumb = (row: StoryMeta) => row.path !== null && ancestors.includes(row.path)
        const out = rows.filter((row) => byId.has(row.id) || !crumb(row))
        for (const path of ancestors) {
          const here = rows.filter((row) => row.path === path)
          const at = redirects.filter((r) => r.path === path)
          const pick = pickServing(chain, here, at)
          if (pick?.kind === 'story' && !byId.has(pick.story.id)) out.push(pick.story)
        }
        return out
      }

      /**
       * The forms this document embeds (`../../docs/specs/content-model/forms.md` decision 4),
       * **issued here rather than awaited later**: the ids come straight off the
       * document walk and depend on nothing pass one returns, so the read goes out
       * alongside it and both branches below wait once instead of twice. Serialising
       * it would cost a whole round trip per page render for nothing — the mistake
       * the published branch's comment below records having already made once.
       *
       * A document with no `form` field issues no query at all: `formIds` answers
       * an empty array and this never touches D1.
       */
      // Within the render's chain like every other id-set read here (`multi-site.md`
      // decision 3): a form owned by a scope outside it resolves exactly like a deleted
      // one, so its questions and its `action` are never handed to a page that is not
      // entitled to them.
      const formRows = formsByIds(db, doc ? formIds(doc, schema) : [], logger, chain)

      /** Pass two: the documents this one pulls in — references, and every global. */
      let docs: Record<string, Doc> = {}
      let globalDocs: Record<string, Doc> | undefined

      if (opts?.draft) {
        remember(await served(await pass1))
        // A reference to an id with no story row is unresolvable, and in draft mode
        // asking for its draft would *create* a Durable Object for a deleted story.
        // That is what keeps this branch sequential where the published one below
        // is not: the filter is load-bearing here and merely tidy there.
        const liveRefIds = refIds.filter((id) => known.has(id))
        if (loaded.length > 0 || liveRefIds.length > 0) {
          const [refEntries, globalEntries] = await Promise.all([
            Promise.all(
              liveRefIds.map(
                async (id) =>
                  [
                    id,
                    branded
                      ? await stub(bindings, id).getOrInit(seedInChain(known.get(id)!, chain))
                      : await draft(bindings, id),
                  ] as const,
              ),
            ),
            Promise.all(
              loaded.map(async (name) => {
                // **A render on a multi-site deployment never writes** (decision
                // 8): a layer with no row in the chain is absent, which reads as
                // every field inherited, rather than ensured into existence. A
                // layer row and its object are made by an editor's first write, so
                // a draft site that was only ever previewed stays deletable.
                if (sites) {
                  const layers = await Promise.all(
                    layerIds.get(name)!.map((id) => {
                      const meta = known.get(id)
                      if (!meta) return undefined
                      return branded
                        ? stub(bindings, meta.id).getOrInit(seedInChain(meta, chain))
                        : draftFor(bindings, meta)
                    }),
                  )
                  const merged = mergeLayers(layers, schema)
                  return merged ? ([name, merged] as const) : null
                }
                const meta = await ensureSingleton(db, typeOf(name)!, schemaId)
                return [name, await draftFor(bindings, meta)] as const
              }),
            ),
          ])
          docs = Object.fromEntries(refEntries)
          globalDocs = loaded.length
            ? Object.fromEntries(
                globalEntries.filter((entry): entry is readonly [string, Doc] => entry !== null),
              )
            : undefined
        }
      } else {
        /**
         * The published branch runs both passes at once, because on this branch
         * pass two does not actually need pass one's answer: `publishedDocsByIds`
         * returns nothing for an id with no row, and the `known.has` screen below
         * drops the same ids the pre-filter used to. Waiting was costing a whole
         * network round trip per page render for a filter that changes nothing —
         * ~280ms of it on a host whose primary is a continent away.
         */
        const wanted = [...new Set([...refIds, ...globalIds])]
        const [rows, combined] = await Promise.all([
          pass1.then(served),
          wanted.length > 0
            ? publishedDocsByIds(db, wanted, chain)
            : Promise.resolve<Record<string, Doc>>({}),
        ])
        remember(rows)
        docs = Object.fromEntries(
          refIds
            .filter((id) => known.has(id) && combined[id])
            .map((id) => [id, combined[id]!] as const),
        )
        globalDocs = loaded.length
          ? Object.fromEntries(
              loaded
                .map(
                  (name) =>
                    [
                      name,
                      mergeLayers(
                        layerIds.get(name)!.map((id) => combined[id]),
                        schema,
                      ),
                    ] as const,
                )
                .filter((entry): entry is [string, Doc] => Boolean(entry[1])),
            )
          : undefined
      }

      /**
       * Pass three: the ids those documents point at. One level, matching the bound
       * `RenderBlok` already enforces on `docs` — but `stories` survives that
       * emptying, so a link inside a global's navigation or inside a referenced card
       * has to resolve. Skipped entirely when the whole map is already loaded, and
       * when nothing new turned up, which is the ordinary case.
       */
      if (!wantAll) {
        const nested = new Set<string>()
        for (const pulled of [...Object.values(docs), ...Object.values(globalDocs ?? {})]) {
          for (const id of linkedIds(pulled, schema)) if (!known.has(id)) nested.add(id)
          for (const id of referencedIdsAllLocales(pulled, schema)) {
            if (!known.has(id)) nested.add(id)
          }
        }
        if (nested.size > 0) remember(await storiesFor(db, [...nested], [], chain))
      }

      /**
       * The descriptors, compiled from the rows the read above fetched. The action URL
       * is built from this runtime's `base` and the `_folio_page` hidden input from
       * the story's own URL through the host's `route` — so a submission comes back
       * to the page it was made on, in the locale it was rendered in.
       *
       * A form the document points at that has since been deleted is simply absent
       * from the map, and `resolveValue` answers `null` for it: the same posture a
       * `reference` to a deleted document takes.
       */
      const formPage =
        opts?.story?.path != null ? route(opts.story.path, active?.code, render?.site) : undefined
      const forms = Object.fromEntries(
        (await formRows).map((form) => [
          form.id,
          compileForm(form, {
            base,
            ...(active ? { locale: active } : {}),
            ...(formPage !== undefined ? { page: formPage } : {}),
          }),
        ]),
      )

      const resolution: Resolution = {
        ...buildResolution([...known.values()].map(urlsOf), assetBase),
        ...localeField,
        ...pageField,
        ...searchField,
        // Absent rather than `{}` when there is nothing to pull in, so a document
        // with no references bootstraps the byte-identical payload it always did.
        ...(Object.keys(docs).length > 0 ? { docs } : {}),
        ...(globalDocs ? { globals: globalDocs } : {}),
        ...(Object.keys(forms).length > 0 ? { forms } : {}),
        // Multi-site only, and last, so a single-site resolution has neither key
        // and serialises byte for byte as it always did (decision 15).
        ...(render ? { site: siteContext(render) } : {}),
        ...(render && opts?.story?.path != null ? { path: opts.story.path } : {}),
      }

      /** Pass four: the collection queries this document contains, run once each. */
      const queries = doc
        ? collectionQueries(doc, schema, opts?.page, active, opts?.search)
        : new Map<string, ContentQuery>()
      if (queries.size === 0) return resolution

      const answers = await Promise.all(
        [...queries].map(
          async ([key, q]) =>
            [
              key,
              await runQuery(queryDeps(db, chain, render?.site), q, { locale: active }),
            ] as const,
        ),
      )
      const collections: Record<string, ResolvedCollection> = Object.fromEntries(answers)

      // Decision 3: a preview resolves collections against **published** content.
      // Querying drafts would mean opening every candidate Durable Object on every
      // keystroke. So the list is marked `stale` — a block can say "this list shows
      // published items" — and the open story's own draft is patched over its
      // published row where it is a member, which is the one difference an editor
      // looking at an index page actually notices.
      if (opts?.draft) {
        const open = opts.story
        const root = doc?.bloks[doc.root]
        for (const key of Object.keys(collections)) {
          const answer = collections[key]!
          collections[key] = {
            ...answer,
            stale: true,
            items:
              doc && open && root
                ? answer.items.map((item) =>
                    item.id === open.id
                      ? {
                          ...item,
                          // Patched only where the answer carries documents at all
                          // (`core/query.ts`'s `ContentQuery.withDoc`). Adding one
                          // unconditionally would put the open draft's whole body
                          // into a card rail that asked for none — and give the
                          // editor an item shaped unlike its ten neighbours.
                          ...(item.doc ? { doc } : {}),
                          data: dataOf(root, active),
                          title: titleOf(doc, typeOf(open.type), schema, item.title, active),
                        }
                      : item,
                  )
                : answer.items,
          }
        }
      }

      return { ...resolution, collections }
    }

    /** What `runQuery` needs, assembled from this runtime. */
    const queryDeps = (
      db: FolioDb,
      chain: readonly string[] = SINGLE_SITE_CHAIN,
      site?: SiteRef,
    ): QueryDeps => ({
      db,
      indexed,
      // `''` for the source locale, an undeclared code, or a site with no locales —
      // exactly what `indexRowsFor` writes for the same three cases.
      localeKey: (code) => localeOf(code)?.code ?? '',
      withUrls: urlsFor(site),
      chain,
      // `ResolvedGate` narrowed to the three things a SQL predicate can use
      // (`../../docs/specs/content-model/full-text-search.md` decision 11). `types`, not
      // `roots`: SQL sees `stories.type` and cannot see a root block's name.
      // Absent on a deployment with no gate, and then `contentSql` emits nothing.
      ...(gate
        ? { gate: { field: gate.config.field, public: gate.config.public, types: gate.types } }
        : {}),
    })

    const query = (
      bindings: ReadBindings,
      q: ContentQuery,
      chain: readonly string[] = SINGLE_SITE_CHAIN,
      site?: SiteRef,
    ): Promise<ContentPage> => {
      // As `resolve`: with `brands` a query is for one of this brand's sites. A
      // rejection rather than a throw, so a caller sees what `runQuery` would give.
      if (branded) {
        try {
          assertOwnSite(site, 'query')
        } catch (err) {
          return Promise.reject(err)
        }
      }
      return runQuery(queryDeps(bindings.db, chain, site), q, { locale: localeOf(q.locale) })
    }

    /** `Resolution.site` for a render (`multi-site.md` decision 15). */
    const siteContext = (render: SiteRender): SiteContext => ({
      id: render.site.id,
      name: render.site.name,
      group: render.site.group,
      status: render.site.status,
      surface: render.surface,
      chain: render.chain,
      layered: sites ? layered : globals,
      // Only with `brands`, and last, so a single-brand resolution serialises byte
      // for byte as it did (`multi-site-pin.test.ts`).
      ...(b.id !== null ? { brand: b.id } : {}),
    })

    /**
     * The `content_index` / `content_refs` rows a publish writes
     * (`../../docs/specs/content-model/collections.md`). Here rather than inside `publish()` for
     * the same reason `titleFor` is: the projection needs the schema, the document
     * type and the locale config, which only this factory has.
     */
    const projection = (story: StoryMeta, doc: Doc): ContentProjection =>
      contentProjection(story.id, doc, typeOf(story.type), schema, locales)

    /**
     * With `brands` a layer's seed needs the registry (`seedFor`), and a publish is
     * handed only its bindings and hook context — whose `env` is the host's, so the
     * snapshot is one read away, and only for a layer.
     */
    const registryFor = async (story: StoryMeta, env: unknown) =>
      branded && sites && singletonTypeOf(story.id) ? sites.registry(env) : undefined

    const publishDeps = (
      bindings: ReadBindings,
      hookCtx: HookRunnerCtx,
    ): PublishDeps & { logger: FolioLogger } => ({
      db: bindings.db,
      draft: async (story) => draftFor(bindings, story, await registryFor(story, hookCtx.env)),
      draftWithSyncId: async (story) =>
        draftForWithSyncId(bindings, story, await registryFor(story, hookCtx.env)),
      titleFor,
      titlesFor,
      projection,
      hooks: hookRunner(hookCtx),
      logger,
    })

    /**
     * The two orders are not the same, and are as configured today: the admin page
     * puts the plugin's stylesheets before the host's, the preview the other way
     * around (`page`, below).
     */
    const previewPage = (): PageAssets => {
      if (b.id === null) {
        const assets = (config as FolioSingleConfig<Env>).assets
        // Throws rather than serving a scriptless page. See `validateAssets`.
        validateAssets(assets)
        return {
          entries: assets
            ? assets.devClient
              ? [assets.devClient, assets.preview]
              : [assets.preview]
            : [],
          stylesheets: [...b.previewCss, ...(assets?.previewCss ?? [])],
        }
      }
      const assets = (config as FolioBrandedConfig<Env>).assets
      const bundle = validateBrandedAssets(assets, b.id)
      return {
        entries: assets?.devClient ? [assets.devClient, bundle.preview] : [bundle.preview],
        stylesheets: [...b.previewCss, ...(bundle.previewCss ?? [])],
      }
    }

    const auditContext = async (env: unknown): Promise<AuditContext> => ({
      locales,
      types,
      ...(sites && b.settings
        ? {
            sites: {
              settings: b.settings,
              registry:
                b.id === null
                  ? await sites.registry(env)
                  : ownRows(await sites.registry(env), b.id),
            },
          }
        : {}),
    })

    return {
      brand: b.id !== null && b.label !== null ? { id: b.id, label: b.label } : null,
      registry,
      schema,
      types,
      typeOf,
      defaultType: fallbackType,
      /**
       * The manifest, plus the one thing `toManifest` cannot know.
       *
       * Spread here rather than by widening `toManifest`'s signature: that function
       * lives in `core/block.ts` and takes a registry, the types, the globals and
       * the locales — all four of which are *content model*. `hooks` is server
       * configuration, so making `core` take it would have meant `core/block.ts`
       * importing `server/hooks.ts`. With `brands`, the brand and its settings
       * type ride last (decision 12); without, neither key exists.
       */
      manifest: {
        ...toManifest(registry, types, globals, locales),
        ...manifestHooks(config.hooks),
        ...(b.id !== null && b.label !== null ? { brand: { id: b.id, label: b.label } } : {}),
        ...(b.id !== null && b.settings ? { settings: b.settings } : {}),
      },
      globals,
      layered,
      settings: b.settings,
      migrations,
      schemaId,
      indexedFields: indexed,
      gate,
      forms,
      describe,
      previewWrap: b.previewWrap,
      page: () => previewPage(),
      seed,
      seedFor,
      draftFor,
      draftForWithSyncId,
      draft,
      titleFor,
      titlesFor,
      projection,
      resolve,
      query,
      publishDeps,
      auditContext,
    }
  }

  const brands: ReadonlyMap<string | null, BrandRuntime> = new Map(
    prepared.map((b) => [b.id, buildBrand(b)] as const),
  )
  // The one brand of a deployment with no `brands`; undefined on one with them.
  const only = branded ? undefined : brands.get(null)

  const forScope = (registry: SiteRegistry, scope: string | null): BrandRuntime | null => {
    if (only) return only
    if (scope === null || scope === SHARED_SCOPE) return null
    const row =
      registry.sites.find((s) => s.id === scope) ?? registry.groups.find((g) => g.id === scope)
    return row?.brand ? (brands.get(row.brand) ?? null) : null
  }

  /**
   * Folio's two HTML pages' assets. The admin page is the deployment's; a preview is
   * a brand's (`BrandRuntime.page`), so with `brands` asking the runtime for one
   * throws rather than answer the first brand's bundle.
   */
  const page = (which: 'admin' | 'preview'): PageAssets => {
    if (which === 'preview') {
      if (!only) throw noBrand("page('preview')")
      return only.page('preview')
    }
    if (!branded) {
      const assets = (config as FolioSingleConfig<Env>).assets
      // Throws rather than serving a scriptless page. See `validateAssets`.
      validateAssets(assets)
      return {
        entries: assets
          ? assets.devClient
            ? [assets.devClient, assets.admin]
            : [assets.admin]
          : [],
        stylesheets: [...(assets?.adminCss ?? []), ...(config.adminCss ?? [])],
      }
    }
    const assets = (config as FolioBrandedConfig<Env>).assets
    validateBrandedAssets(assets, null)
    return {
      entries: assets?.devClient ? [assets.devClient, assets.admin] : [assets!.admin],
      stylesheets: [...(assets?.adminCss ?? []), ...(config.adminCss ?? [])],
    }
  }

  const deployment = {
    brands,
    forScope,
    locales,
    localeOf,
    pathForLocale,
    auth,
    logger,
    formPurgeCapability,
    base,
    sites,
    route,
    dev: Boolean(config.assets?.devClient),
    draftMode: config.draftMode === true,
    withUrls,
    urlsFor,
    decorate,
    stub,
    space,
    hookRunner,
    page,
  }

  return { ...deployment } as FolioRuntime
}

/**
 * `hookCtx` for a Durable Object alarm, which has no `ExecutionContext` to
 * take a `waitUntil` from (`../../docs/specs/platform/publish-hooks.md` decision 3): the
 * fallback runs the task and catches anything it rejects with itself, so an
 * unawaited hook cannot turn into an unhandled rejection inside the alarm
 * handler the way an HTTP response has `executionCtx.waitUntil` to catch it
 * for free. A hook marked `{ await: true }` is still awaited under this
 * fallback — the runner does not know or care which kind of `waitUntil` it
 * was handed.
 *
 * `logger` defaults to `console` for a caller with no `FolioRuntime` in hand;
 * every call site inside this library has one and passes `rt.logger`.
 */
export function alarmHookCtx<Env>(env: Env, logger: FolioLogger = console): HookRunnerCtx<Env> {
  return {
    env,
    waitUntil: (p) => {
      void p.catch((err) => logger.error('folio: hook rejected with no waitUntil to catch it', err))
    },
  }
}
