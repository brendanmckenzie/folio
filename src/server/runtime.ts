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
import type { Doc } from '../core/doc'
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
  singletonId,
  titleFieldOf,
  titleOf,
  typeByName,
  validateGlobals,
  validatePresets,
  validateTypes,
} from '../core/schema'
import {
  type Registry as SiteRegistry,
  SINGLE_SITE_CHAIN,
  type SiteContext,
  type SiteRef,
  type Surface,
} from '../core/sites'
import { ancestorPaths, type StoryMeta, type StoryNode } from '../core/story'
import { type ResolvedAuth, resolveAuth } from './auth/config'
import { cachePurgeHooks, type PurgeCapability } from './cache-purge'
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
import { SPACE_NAME, spaceBroadcastHooks } from './space-events'
import { redirectsAtPaths } from './redirects'
import { readRegistry, registrySnapshot, type ResolvedSites } from './sites'
import {
  ensureSingleton,
  listStories,
  pickServing,
  publishedDocsByIds,
  storiesFor,
  storyById,
} from './stories'
import type {
  FolioLogger,
  ReadBindings,
  FolioConfig,
  PreviewMode,
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
   * multi-site render for no site: an empty chain, which resolves nothing.
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
  /** The configured globals and the settings type: every document that layers. */
  layered: readonly string[]
  /** The raw binding, for the `first-primary` registry read and nothing else. */
  rawDb: (env: unknown) => D1Database
}

export interface FolioRuntime {
  registry: Registry
  /**
   * `FolioConfig.previewWrap`, unchanged. See its doc comment, and the note at
   * the render site in `server/pages.tsx`.
   */
  previewWrap: PreviewWrap | undefined
  /** The block schemas, indexed by name. What a migration and the audit both walk. */
  schema: SchemaIndex
  /** What `GET {base}/schema` answers. Contains no functions. */
  manifest: Manifest
  /** Every declared document type, with `root` sugar already expanded. */
  types: readonly DocumentType[]
  /** `FolioConfig.globals`, validated. Every name is a declared `singleton`. */
  globals: readonly string[]
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
  /** `FolioConfig.migrations`, validated, in run order (`schema-migrations.md`). */
  migrations: readonly Migration[]
  /**
   * The id a fully-migrated document carries: the last configured migration, or
   * null when there are none. Stamped on every document and version row created
   * from now on, so a document born from the current schema is never reported
   * behind it.
   */
  schemaId: string | null
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
   * `FolioConfig.gate`, validated, or **null for a site with no gate at all** —
   * which is the case that must stay free (`../../docs/specs/platform/visitor-access.md`): no
   * field is read, no host code runs, and every page keeps the cache headers it
   * always had.
   *
   * Widened to `unknown` for the same reason `auth` is. Carries the two
   * precomputed sets `validateGate` builds in one walk: `roots` for
   * `reader.page()`, which holds a document and can only see its root block's
   * name, and `types` for the search predicate, which sees `stories.type` and
   * cannot see a root block's name at all.
   */
  gate: ResolvedGate | null
  /**
   * `FolioConfig.describe`, validated and defaulted, or **null for a host that
   * configured none** — which is the whole of "this site does not do this": the
   * describe routes answer `unsupported`, no machine column is ever written, and
   * an upload behaves exactly as it did before the feature existed
   * (`../../docs/specs/content-model/media-library.md` decision 8).
   */
  describe: ResolvedDescribe | null
  /**
   * `FolioConfig.forms`, validated and defaulted, or **null for a host that
   * configured none** — which is not "forms are off": the honeypot still runs and
   * the default rate limit still applies. What is null is the half only a host can
   * supply, `verify` (`../../docs/specs/content-model/forms.md` decision 9).
   */
  forms: ResolvedForms | null
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
  /** A declared type by name, or undefined — a row whose type was removed from
   * the code still reads, it just has no schema to render ("Unknown type"). */
  typeOf: (name: string | undefined) => DocumentType | undefined
  /** The type a bare "New page" creates. */
  defaultType: DocumentType
  /** What a document is called, per its type's `titleField`. */
  titleFor: (story: StoryMeta, doc: Doc) => string
  /**
   * The same title in every declared non-source locale, for `stories.title_i18n`
   * (`localisation.md` architecture decision 7). Undefined — not an empty object
   * — when there are no locales, which is what tells `publishStoryStatement` to
   * leave the column alone rather than clear it.
   */
  titlesFor: (story: StoryMeta, doc: Doc) => Record<string, string> | undefined
  /**
   * The `content_index` / `content_refs` / `content_text` rows for one published
   * document, as `publishDeps` already receives.
   *
   * Exposed on the runtime for the sake of `runMigrations`, which rewrites
   * `published_doc` and must re-project the index in the same batch
   * (`content-model/full-text-search.md` decision 8). Both of its call sites build
   * `MigrateDeps` from a `FolioRuntime` rather than from inside `createRuntime`,
   * and a migration that rewrites prose without this leaves the index describing
   * text no document contains any more — silently, until somebody reindexes.
   */
  projection: (story: StoryMeta, doc: Doc) => ContentProjection
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
  /**
   * A starting document for one document type: its root block's `'default'`
   * preset, with the title written into the type's own title field.
   *
   * Exposed because `../../docs/specs/platform/content-api.md`'s create is two writes across two
   * stores and the order matters: it validates the caller's content against this
   * seed *before* the D1 row exists, then seeds the object with the finished
   * document in one `getOrInit` rather than seeding blank and committing after —
   * so a refused payload writes nothing at all, and a created document's initial
   * content lands with it rather than as a separate transaction. `duplicate`
   * already does the same thing with `cloneDoc`.
   */
  seed: (type: DocumentType | undefined, title: string) => Doc
  stub: (bindings: ReadBindings, id: string) => StoryStub
  /**
   * The one space object (`../../docs/specs/editing/live-collaboration.md`), or null when the
   * host has not declared the binding — in which case everything that channel
   * carries is simply absent rather than broken.
   *
   * One instance for the whole site, named `'space'`: it is the only thing that
   * can know who is in the site rather than in a document, and sharding it is
   * named as the escape hatch rather than built.
   */
  space: (bindings: ReadBindings) => SpaceStub | null
  /**
   * The live draft for a story whose row the caller already has. Preferred over
   * `draft` wherever that is true: `draft` exists to look the row up.
   */
  draftFor: (bindings: ReadBindings, story: StoryMeta) => Promise<Doc>
  draft: (bindings: ReadBindings, id: string) => Promise<Doc>
  /** `draftFor` plus the syncId it was read at, atomically. See `PublishDeps.draftWithSyncId`. */
  draftForWithSyncId: (
    bindings: ReadBindings,
    story: StoryMeta,
  ) => Promise<{ doc: Doc; syncId: number }>
  resolve: (bindings: ReadBindings, doc?: Doc, opts?: ResolveOptions) => Promise<Resolution>
  /**
   * `ContentQuery` over published content (`../../docs/specs/content-model/collections.md`),
   * within a chain's served set. Absent is the single-site chain.
   */
  query: (
    bindings: ReadBindings,
    q: ContentQuery,
    chain?: readonly string[],
    site?: SiteRef,
  ) => Promise<ContentPage>
  /**
   * Field names marked `indexed: true` on some declared type's root block — what a
   * `where` or an `order` is checked against before it reaches SQL, and what the
   * admin's collection input offers as filters.
   */
  indexedFields: ReadonlySet<string>
  /**
   * What the publish workflows need, assembled from bindings alone — the one
   * place that assembly lives, for a route today and a Durable Object alarm next
   * phase. `hookCtx` is `{ env, waitUntil }`: the host's own `env` and a way to
   * run something after the response, built differently by an HTTP call site
   * (`c.env`, `c.executionCtx.waitUntil`) and a Durable Object alarm
   * (`alarmHookCtx`, this file) — `publish()` cannot tell the difference, which
   * is the point (`../../docs/specs/platform/publish-hooks.md` decision 3). Every route that
   * mutates a story reads `.hooks` off the result, not only the publish/
   * unpublish/checkpoint routes that also want the rest of `PublishDeps`.
   *
   * **Carries `logger` too**, widened past `publish.ts`'s own `PublishDeps` —
   * `scheduler.ts`'s `runSchedules` and `bulk.ts`'s `runBulk` both take
   * `deps.logger` for their own "unreportable failure" lines, and every one of
   * their real call sites builds its deps from this function (directly, or by
   * spreading it), so the resolved logger reaches them with no change to those
   * call sites at all.
   */
  publishDeps: (
    bindings: ReadBindings,
    hookCtx: HookRunnerCtx,
  ) => PublishDeps & { logger: FolioLogger }
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
export function documentTypes<Env>(config: FolioConfig<Env>): readonly DocumentType[] {
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
export function validateAssets(assets: FolioConfig<unknown>['assets']): void {
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
 */
export function validateSites<Env>(
  config: FolioConfig<Env>,
  types: readonly DocumentType[],
  logger: FolioLogger,
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
  if (sites.settings !== undefined && typeByName(types, sites.settings)?.kind !== 'singleton') {
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
  const layered = [...(config.globals ?? []), ...(sites.settings ? [sites.settings] : [])]
  for (const name of layered) {
    if (`sng_${name}:`.length + 32 > 64) {
      throw new Error(
        `folio: '${name}' is too long to layer: its layer ids would exceed 64 characters`,
      )
    }
  }
  if (config.auth === 'open') {
    logger.warn(
      "folio: 'sites' with auth: 'open' — every scope is editable and every preview origin shows drafts to anyone who reaches it",
    )
  }
  return {
    admin: admin.origin,
    adminHost: admin.hostname,
    settings: sites.settings,
    resolve: sites.resolve,
  }
}

export function createRuntime<Env>(config: FolioConfig<Env>): FolioRuntime {
  const registry = toRegistry(config.blocks)
  const schema = toSchemaIndex(registry)
  // Construction-time, before any request is served: an invalid preset (an
  // unknown type or slot, a disallowed child, a cycle) is a config mistake,
  // not a runtime surprise a caller discovers three requests later.
  validatePresets(schema)
  // Same timing, same reason, and the same for `types`: an unknown root block,
  // two defaults, a duplicate name or an `under` chain that never reaches the
  // top level all throw here (`../../docs/specs/foundation/document-types.md`).
  const types = documentTypes(config)
  validateTypes(types, schema)
  // Same timing, same reason: a typo in `hooks` (or in `await`) should fail
  // loudly once, not silently never fire (`../../docs/specs/platform/publish-hooks.md`).
  validateHooks(config.hooks)
  // Same timing, same reason, and after `validateTypes` because it needs both
  // `types` and `schema`: a `gate` whose field is translatable, unindexed, the
  // wrong kind, or declared on no `page` root is a gate the editor believes in
  // and nothing enforces (`../../docs/specs/platform/visitor-access.md` decision 8).
  const gate = validateGate(config.gate, types, schema)
  // Same timing, same reason: `describe.fn` that is not a function, an unknown
  // key, or a `concurrency` outside 1–8 is a config mistake, and the request
  // that would otherwise discover it is a background `waitUntil` after an
  // upload — where nobody is looking and the only symptom is alt text that
  // never appears (`../../docs/specs/content-model/media-library.md` decision 8).
  const describe = validateDescribe(config.describe)
  // Same timing, same reason, one rung more insistent than `describe`: the
  // request that would otherwise discover a `verify` that is not a function is an
  // anonymous POST from the public internet, and `verify` fails closed — so the
  // symptom is a contact form that silently collects nothing, on the one route in
  // this library a stranger can reach (`../../docs/specs/content-model/forms.md` decision 11).
  const forms = validateForms(config.forms)
  // Same timing, same reason: `globals` naming an unknown type or a non-
  // singleton one is a config mistake, not a runtime surprise the first page
  // render discovers (`../../docs/specs/content-model/globals.md`).
  validateGlobals(config.globals, types)
  // Same timing, same reason: a duplicate migration id, or a set whose declared
  // order and lexicographic order disagree, would migrate documents in an order
  // that depends on which comparison happened to be used
  // (`../../docs/specs/foundation/schema-migrations.md`).
  validateMigrations(config.migrations)
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
  const globals = config.globals ?? []
  const locales = config.locales
  const migrations = config.migrations ?? []
  const schemaId = latestMigrationId(migrations)
  const typeOf = (name: string | undefined) => typeByName(types, name)
  const fallbackType = defaultType(types)
  // Root blocks only (`../../docs/specs/content-model/collections.md` decision 2): the index is
  // a *fixed* projection of a document, so which fields it holds cannot depend on
  // which blocks happen to be inside it. `/folio/audit` reports an `indexed` flag
  // on a block that is no type's root, which would otherwise do nothing silently.
  const indexed = indexedFieldNames(schema, types)
  const base = config.basePath ?? DEFAULT_BASE
  const route: FolioRuntime['route'] = config.route ?? ((path: string) => `/${path}`)
  const assetBase = `${base}/asset`

  // Same timing, same reason: an admin origin that is not one, or a settings type
  // that is not a singleton, is a deployment that serves nothing
  // (`../../docs/specs/foundation/multi-site.md`). Null with no `sites`, and then
  // no snapshot exists and nothing below ever reads the registry.
  const resolvedSites = validateSites(config, types, logger)
  const sites: SitesRuntime | null = resolvedSites
    ? (() => {
        const snapshot = registrySnapshot()
        const rawDb = (env: unknown) => config.bindings(env as Env).db
        return {
          ...resolvedSites,
          registry: (env: unknown) => snapshot.get(rawDb(env)),
          fresh: (env: unknown) => readRegistry(rawDb(env)),
          drop: snapshot.drop,
          layered: [...globals, ...(resolvedSites.settings ? [resolvedSites.settings] : [])],
          rawDb,
        }
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

  const stub = ({ story }: ReadBindings, id: string): StoryStub =>
    story.get(story.idFromName(id)) as unknown as StoryStub

  /** The single space instance, or null for a host without the binding. */
  const space = ({ space: ns }: ReadBindings): SpaceStub | null =>
    ns ? (ns.get(ns.idFromName(SPACE_NAME)) as unknown as SpaceStub) : null

  const draftFor = (bindings: ReadBindings, story: StoryMeta) =>
    stub(bindings, story.id).getOrInit(seed(typeOf(story.type), story.title))

  const draftForWithSyncId = (bindings: ReadBindings, story: StoryMeta) =>
    stub(bindings, story.id).getOrInitWithSyncId(seed(typeOf(story.type), story.title))

  const draft = async (bindings: ReadBindings, id: string) => {
    const meta = await storyById(bindings.db, id)
    return stub(bindings, id).getOrInit(seed(typeOf(meta?.type), meta?.title ?? 'Untitled'))
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
    const globalIds = globals.map((name) => singletonId(typeOf(name)!))

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
    // Not yet scoped by the chain: forms are `forms.ts`'s, and scoping them is
    // spec 23's phase 7 (`multi-site.md`, "Implementation plan").
    const formRows = formsByIds(db, doc ? formIds(doc, schema) : [], logger)

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
      if (globals.length > 0 || liveRefIds.length > 0) {
        const [refEntries, globalEntries] = await Promise.all([
          Promise.all(liveRefIds.map(async (id) => [id, await draft(bindings, id)] as const)),
          Promise.all(
            globals.map(async (name, i) => {
              const type = typeOf(name)!
              // **A render on a multi-site deployment never writes** (decision
              // 8): a global with no row in the chain is absent rather than
              // ensured into existence. Layers are spec 23's phase 4; until
              // then a site reads only the rows its chain already holds.
              if (sites) {
                const meta = known.get(globalIds[i]!)
                return meta ? ([name, await draftFor(bindings, meta)] as const) : null
              }
              const meta = await ensureSingleton(db, type, schemaId)
              return [name, await draftFor(bindings, meta)] as const
            }),
          ),
        ])
        docs = Object.fromEntries(refEntries)
        globalDocs = globals.length
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
      globalDocs = globals.length
        ? Object.fromEntries(
            globals
              .map((name, i) => [name, combined[globalIds[i]!]] as const)
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
          [key, await runQuery(queryDeps(db, chain, render?.site), q, { locale: active })] as const,
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
  ): Promise<ContentPage> =>
    runQuery(queryDeps(bindings.db, chain, site), q, { locale: localeOf(q.locale) })

  /** `Resolution.site` for a render (`multi-site.md` decision 15). */
  const siteContext = (render: SiteRender): SiteContext => ({
    id: render.site.id,
    name: render.site.name,
    group: render.site.group,
    status: render.site.status,
    surface: render.surface,
    chain: render.chain,
    layered: sites?.layered ?? globals,
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
   */
  const internalHooks: FolioHooks<Env>[] = [
    spaceBroadcastHooks<Env>(config, globals, logger),
    // `undefined` for the capability, not omitted: a positional default only
    // applies when the argument itself is `undefined`, and skipping past it
    // to reach `logger` would mean naming the third parameter, which JS has
    // no syntax for.
    cachePurgeHooks<Env>(
      globals,
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

  const publishDeps = (
    bindings: ReadBindings,
    hookCtx: HookRunnerCtx,
  ): PublishDeps & { logger: FolioLogger } => ({
    db: bindings.db,
    draft: (story) => draftFor(bindings, story),
    draftWithSyncId: (story) => draftForWithSyncId(bindings, story),
    titleFor,
    titlesFor,
    projection,
    hooks: hookRunner(hookCtx),
    logger,
  })

  /**
   * The two orders below are not the same, and are as configured today: the admin
   * page puts the plugin's stylesheets before the host's, the preview the other
   * way around.
   */
  const page = (which: 'admin' | 'preview'): PageAssets => {
    const assets = config.assets
    // Throws rather than serving a scriptless page. See `validateAssets`.
    validateAssets(assets)
    return {
      entries: assets
        ? assets.devClient
          ? [assets.devClient, assets[which]]
          : [assets[which]]
        : [],
      stylesheets:
        which === 'admin'
          ? [...(assets?.adminCss ?? []), ...(config.adminCss ?? [])]
          : [...(config.previewCss ?? []), ...(assets?.previewCss ?? [])],
    }
  }

  return {
    registry,
    previewWrap: config.previewWrap,
    schema,
    /**
     * The manifest, plus the one thing `toManifest` cannot know.
     *
     * Spread here rather than by widening `toManifest`'s signature: that function
     * lives in `core/block.ts` and takes a registry, the types, the globals and
     * the locales — all four of which are *content model*. `hooks` is server
     * configuration, so making `core` take it would have meant `core/block.ts`
     * importing `server/hooks.ts`.
     */
    manifest: {
      ...toManifest(registry, types, globals, locales),
      ...manifestHooks(config.hooks),
    },
    types,
    globals,
    locales,
    localeOf,
    pathForLocale,
    migrations,
    schemaId,
    auth,
    gate,
    describe,
    forms,
    logger,
    formPurgeCapability,
    typeOf,
    defaultType: fallbackType,
    titleFor,
    titlesFor,
    projection,
    base,
    sites,
    route,
    dev: Boolean(config.assets?.devClient),
    draftMode: config.draftMode === true,
    withUrls,
    urlsFor,
    decorate,
    seed,
    stub,
    space,
    draftFor,
    draftForWithSyncId,
    draft,
    resolve,
    query,
    indexedFields: indexed,
    publishDeps,
    hookRunner,
    page,
  }
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
