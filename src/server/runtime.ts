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
import { linkedIds, referencedIdsAllLocales } from '../core/refs'
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
import { ancestorPaths, type StoryMeta, type StoryNode } from '../core/story'
import { type ResolvedAuth, resolveAuth } from './auth/config'
import { cachePurgeHooks } from './cache-purge'
import { type ContentProjection, contentProjection } from './content-index'
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
import { ensureSingleton, listStories, publishedDocsByIds, storiesFor, storyById } from './stories'
import type { FolioBindings, FolioConfig, PreviewMode, SpaceStub, StoryStub } from './types'

const DEFAULT_BASE = '/folio'

/** Client entries and stylesheets for one of the two HTML pages Folio serves. */
export interface PageAssets {
  entries: string[]
  stylesheets: string[]
}

/**
 * What a render needs beyond the document
 * (`../content-model/collections.md` decision 6).
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
  /** Where the routes are mounted, with no trailing slash. */
  base: string
  /** True when a Vite dev client is configured, so the pages ship the preamble. */
  dev: boolean
  /** A story's public URL, and the same URL with the preview flag on it. */
  withUrls: <T extends StoryMeta>(story: T) => T
  /** `withUrls` over a whole tree. */
  decorate: (nodes: StoryNode[]) => StoryNode[]
  /**
   * A starting document for one document type: its root block's `'default'`
   * preset, with the title written into the type's own title field.
   *
   * Exposed because `../platform/content-api.md`'s create is two writes across two
   * stores and the order matters: it validates the caller's content against this
   * seed *before* the D1 row exists, then seeds the object with the finished
   * document in one `getOrInit` rather than seeding blank and committing after —
   * so a refused payload writes nothing at all, and a created document's initial
   * content lands with it rather than as a separate transaction. `duplicate`
   * already does the same thing with `cloneDoc`.
   */
  seed: (type: DocumentType | undefined, title: string) => Doc
  stub: (bindings: FolioBindings, id: string) => StoryStub
  /**
   * The one space object (`../editing/live-collaboration.md`), or null when the
   * host has not declared the binding — in which case everything that channel
   * carries is simply absent rather than broken.
   *
   * One instance for the whole site, named `'space'`: it is the only thing that
   * can know who is in the site rather than in a document, and sharding it is
   * named as the escape hatch rather than built.
   */
  space: (bindings: FolioBindings) => SpaceStub | null
  /**
   * The live draft for a story whose row the caller already has. Preferred over
   * `draft` wherever that is true: `draft` exists to look the row up.
   */
  draftFor: (bindings: FolioBindings, story: StoryMeta) => Promise<Doc>
  draft: (bindings: FolioBindings, id: string) => Promise<Doc>
  /** `draftFor` plus the syncId it was read at, atomically. See `PublishDeps.draftWithSyncId`. */
  draftForWithSyncId: (
    bindings: FolioBindings,
    story: StoryMeta,
  ) => Promise<{ doc: Doc; syncId: number }>
  resolve: (bindings: FolioBindings, doc?: Doc, opts?: ResolveOptions) => Promise<Resolution>
  /** `ContentQuery` over published content (`../content-model/collections.md`). */
  query: (bindings: FolioBindings, q: ContentQuery) => Promise<ContentPage>
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
   * is the point (`../platform/publish-hooks.md` decision 3). Every route that
   * mutates a story reads `.hooks` off the result, not only the publish/
   * unpublish/checkpoint routes that also want the rest of `PublishDeps`.
   */
  publishDeps: (bindings: FolioBindings, hookCtx: HookRunnerCtx) => PublishDeps
  /**
   * The hook runner on its own, for the two write paths that fire an event and
   * need none of the rest of `PublishDeps`: `runMigrations` and `reindex`
   * (`../platform/caching.md`). Same host hooks, same internal list, same
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

export function createRuntime<Env>(config: FolioConfig<Env>): FolioRuntime {
  const registry = toRegistry(config.blocks)
  const schema = toSchemaIndex(registry)
  // Construction-time, before any request is served: an invalid preset (an
  // unknown type or slot, a disallowed child, a cycle) is a config mistake,
  // not a runtime surprise a caller discovers three requests later.
  validatePresets(schema)
  // Same timing, same reason, and the same for `types`: an unknown root block,
  // two defaults, a duplicate name or an `under` chain that never reaches the
  // top level all throw here (`../foundation/document-types.md`).
  const types = documentTypes(config)
  validateTypes(types, schema)
  // Same timing, same reason: a typo in `hooks` (or in `await`) should fail
  // loudly once, not silently never fire (`../platform/publish-hooks.md`).
  validateHooks(config.hooks)
  // Same timing, same reason: `globals` naming an unknown type or a non-
  // singleton one is a config mistake, not a runtime surprise the first page
  // render discovers (`../../docs/specs/content-model/globals.md`).
  validateGlobals(config.globals, types)
  // Same timing, same reason: a duplicate migration id, or a set whose declared
  // order and lexicographic order disagree, would migrate documents in an order
  // that depends on which comparison happened to be used
  // (`../foundation/schema-migrations.md`).
  validateMigrations(config.migrations)
  // Same timing, same reason: a default locale that is not available, a duplicate
  // code, a fallback that does not exist or one that cycles would each turn into
  // a page rendered in the wrong language rather than an error
  // (`../content-model/localisation.md`).
  validateLocales(config.locales)
  // Same timing, one rung more insistent: `auth` has no default at all, so an
  // absent key throws here rather than quietly leaving the CMS open
  // (`identity-and-access.md` checkpoint 2). The widening cast is explained on
  // `FolioRuntime.auth`.
  const auth = resolveAuth(config.auth) as ResolvedAuth<unknown>
  const globals = config.globals ?? []
  const locales = config.locales
  const migrations = config.migrations ?? []
  const schemaId = latestMigrationId(migrations)
  const typeOf = (name: string | undefined) => typeByName(types, name)
  const fallbackType = defaultType(types)
  // Root blocks only (`../content-model/collections.md` decision 2): the index is
  // a *fixed* projection of a document, so which fields it holds cannot depend on
  // which blocks happen to be inside it. `/folio/audit` reports an `indexed` flag
  // on a block that is no type's root, which would otherwise do nothing silently.
  const indexed = indexedFieldNames(schema, types)
  const base = config.basePath ?? DEFAULT_BASE
  const route = config.route ?? ((path: string) => `/${path}`)
  const assetBase = `${base}/asset`

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
  const previewUrlFor = (path: string, locale?: string, mode: PreviewMode = 'preview') => {
    const url = route(path, locale)
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
  const withUrls = <T extends StoryMeta>(story: T): T => {
    if (story.path === null) return story
    const path = story.path
    const decorated: T = {
      ...story,
      url: route(path),
      previewUrl: previewUrlFor(path),
      draftUrl: previewUrlFor(path, undefined, 'draft'),
    }
    if (!locales) return decorated
    return {
      ...decorated,
      urls: Object.fromEntries(locales.available.map((l) => [l.code, route(path, l.code)])),
      previewUrls: Object.fromEntries(
        locales.available.map((l) => [l.code, previewUrlFor(path, l.code)]),
      ),
      draftUrls: Object.fromEntries(
        locales.available.map((l) => [l.code, previewUrlFor(path, l.code, 'draft')]),
      ),
    }
  }

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

  const decorate = (nodes: StoryNode[]): StoryNode[] =>
    nodes.map((n) => ({ ...withUrls(n), children: decorate(n.children) }))

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

  const stub = ({ story }: FolioBindings, id: string): StoryStub =>
    story.get(story.idFromName(id)) as unknown as StoryStub

  /** The single space instance, or null for a host without the binding. */
  const space = ({ space: ns }: FolioBindings): SpaceStub | null =>
    ns ? (ns.get(ns.idFromName(SPACE_NAME)) as unknown as SpaceStub) : null

  const draftFor = (bindings: FolioBindings, story: StoryMeta) =>
    stub(bindings, story.id).getOrInit(seed(typeOf(story.type), story.title))

  const draftForWithSyncId = (bindings: FolioBindings, story: StoryMeta) =>
    stub(bindings, story.id).getOrInitWithSyncId(seed(typeOf(story.type), story.title))

  const draft = async (bindings: FolioBindings, id: string) => {
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
   * (`../content-model/collections.md` decision 6). Invisible at 40 pages and
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
    bindings: FolioBindings,
    doc?: Doc,
    opts?: ResolveOptions,
  ): Promise<Resolution> => {
    const db = bindings.db
    const active = localeOf(opts?.locale)
    // Absent for the source locale, so a default-locale resolution is byte-
    // identical to a pre-localisation one (`localisation.md` decision 5). Every
    // read in `RenderBlok` goes through this one value.
    const localeField = active ? { locale: active } : {}
    const pageField = opts?.page !== undefined ? { page: opts.page } : {}
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
    remember(
      wantAll
        ? await listStories(db)
        : await storiesFor(
            db,
            [...new Set([...directIds, ...globalIds])],
            ancestorPaths(opts?.story?.path ?? null),
          ),
    )

    /** Pass two: the documents this one pulls in — references, and every global. */
    let docs: Record<string, Doc> = {}
    let globalDocs: Record<string, Doc> | undefined
    // A reference to an id with no story row is unresolvable, and in draft mode
    // asking for its draft would *create* a Durable Object for a deleted story.
    const liveRefIds = refIds.filter((id) => known.has(id))

    if (globals.length > 0 || liveRefIds.length > 0) {
      if (opts?.draft) {
        const [refEntries, globalEntries] = await Promise.all([
          Promise.all(liveRefIds.map(async (id) => [id, await draft(bindings, id)] as const)),
          Promise.all(
            globals.map(async (name) => {
              const type = typeOf(name)!
              const meta = await ensureSingleton(db, type, schemaId)
              return [name, await draftFor(bindings, meta)] as const
            }),
          ),
        ])
        docs = Object.fromEntries(refEntries)
        globalDocs = globals.length ? Object.fromEntries(globalEntries) : undefined
      } else {
        const combined = await publishedDocsByIds(db, [...liveRefIds, ...globalIds])
        docs = Object.fromEntries(
          liveRefIds.filter((id) => combined[id]).map((id) => [id, combined[id]!]),
        )
        globalDocs = globals.length
          ? Object.fromEntries(
              globals
                .map((name, i) => [name, combined[globalIds[i]!]] as const)
                .filter((entry): entry is [string, Doc] => Boolean(entry[1])),
            )
          : undefined
      }
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
      if (nested.size > 0) remember(await storiesFor(db, [...nested]))
    }

    const resolution: Resolution = {
      ...buildResolution([...known.values()].map(withUrls), assetBase),
      ...localeField,
      ...pageField,
      // Absent rather than `{}` when there is nothing to pull in, so a document
      // with no references bootstraps the byte-identical payload it always did.
      ...(Object.keys(docs).length > 0 ? { docs } : {}),
      ...(globalDocs ? { globals: globalDocs } : {}),
    }

    /** Pass four: the collection queries this document contains, run once each. */
    const queries = doc
      ? collectionQueries(doc, schema, opts?.page, active)
      : new Map<string, ContentQuery>()
    if (queries.size === 0) return resolution

    const answers = await Promise.all(
      [...queries].map(
        async ([key, q]) => [key, await runQuery(queryDeps(db), q, { locale: active })] as const,
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
                        doc,
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
  const queryDeps = (db: D1Database): QueryDeps => ({
    db,
    indexed,
    // `''` for the source locale, an undeclared code, or a site with no locales —
    // exactly what `indexRowsFor` writes for the same three cases.
    localeKey: (code) => localeOf(code)?.code ?? '',
    withUrls,
  })

  const query = (bindings: FolioBindings, q: ContentQuery): Promise<ContentPage> =>
    runQuery(queryDeps(bindings.db), q, { locale: localeOf(q.locale) })

  /**
   * The `content_index` / `content_refs` rows a publish writes
   * (`../content-model/collections.md`). Here rather than inside `publish()` for
   * the same reason `titleFor` is: the projection needs the schema, the document
   * type and the locale config, which only this factory has.
   */
  const projection = (story: StoryMeta, doc: Doc): ContentProjection =>
    contentProjection(story.id, doc, typeOf(story.type), schema, locales)

  /**
   * Hooks Folio registers on itself, run before any host hook for the same
   * event (`hooks.ts`'s `InternalHooks`) — the seam
   * `../platform/publish-hooks.md` decision 5 built so there would be one
   * after-commit path rather than two conventions.
   *
   * Two occupants now, each a plain `FolioHooks` literal written exactly the
   * way a host writes one: the space channel's broadcast, and the cache purge
   * (`../platform/caching.md`). No second path, no ordering of its own beyond
   * this array's, and nothing for a future internal consumer to copy except
   * these.
   *
   * The purge is second on purpose. Both are after-commit and neither depends
   * on the other, but telling the open editors is the one whose latency a
   * person is watching, and the purge is the one that awaits a network call.
   */
  const internalHooks: FolioHooks<Env>[] = [
    spaceBroadcastHooks<Env>(config, globals),
    cachePurgeHooks<Env>(globals),
  ]

  const hookRunner = (hookCtx: HookRunnerCtx): HookRunner<unknown> =>
    createHookRunner<Env>(
      config.hooks,
      { env: hookCtx.env as Env, waitUntil: hookCtx.waitUntil },
      internalHooks,
    )

  const publishDeps = (bindings: FolioBindings, hookCtx: HookRunnerCtx): PublishDeps => ({
    db: bindings.db,
    draft: (story) => draftFor(bindings, story),
    draftWithSyncId: (story) => draftForWithSyncId(bindings, story),
    titleFor,
    titlesFor,
    projection,
    hooks: hookRunner(hookCtx),
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
    typeOf,
    defaultType: fallbackType,
    titleFor,
    titlesFor,
    base,
    dev: Boolean(config.assets?.devClient),
    withUrls,
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
 * take a `waitUntil` from (`../platform/publish-hooks.md` decision 3): the
 * fallback runs the task and catches anything it rejects with itself, so an
 * unawaited hook cannot turn into an unhandled rejection inside the alarm
 * handler the way an HTTP response has `executionCtx.waitUntil` to catch it
 * for free. A hook marked `{ await: true }` is still awaited under this
 * fallback — the runner does not know or care which kind of `waitUntil` it
 * was handed.
 */
export function alarmHookCtx<Env>(env: Env): HookRunnerCtx<Env> {
  return {
    env,
    waitUntil: (p) => {
      void p.catch((err) =>
        console.error('folio: hook rejected with no waitUntil to catch it', err),
      )
    },
  }
}
