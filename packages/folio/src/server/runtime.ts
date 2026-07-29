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
import {
  type LocaleConfig,
  type LocaleContext,
  localeContext,
  validateLocales,
} from '../core/locales'
import { latestMigrationId, type Migration, validateMigrations } from '../core/migrate'
import { buildResolution, referencedIds, type Resolution } from '../core/resolve'
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
import type { StoryMeta, StoryNode } from '../core/story'
import { type ResolvedAuth, resolveAuth } from './auth/config'
import { createHookRunner, type FolioHooks, type HookRunnerCtx, validateHooks } from './hooks'
import type { PublishDeps } from './publish'
import { ensureSingleton, listStories, publishedDocsByIds, storyById } from './stories'
import type { FolioBindings, FolioConfig, StoryStub } from './types'

const DEFAULT_BASE = '/folio'

/** Client entries and stylesheets for one of the two HTML pages Folio serves. */
export interface PageAssets {
  entries: string[]
  stylesheets: string[]
}

export interface FolioRuntime {
  registry: Registry
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
   * (`../../../docs/specs/foundation/identity-and-access.md`). `mode: 'open'` is
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
  stub: (bindings: FolioBindings, id: string) => StoryStub
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
  resolve: (
    bindings: FolioBindings,
    doc?: Doc,
    opts?: { draft?: boolean; locale?: string },
  ) => Promise<Resolution>
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
  // render discovers (`../../../docs/specs/content-model/globals.md`).
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
   */
  const previewUrlFor = (path: string, locale?: string) => {
    const url = route(path, locale)
    const flagged = `${url}${url.includes('?') ? '&' : '?'}_folio=preview`
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
    }
    if (!locales) return decorated
    return {
      ...decorated,
      urls: Object.fromEntries(locales.available.map((l) => [l.code, route(path, l.code)])),
      previewUrls: Object.fromEntries(
        locales.available.map((l) => [l.code, previewUrlFor(path, l.code)]),
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
   * One D1 query for the story map, the same one the tree already runs, plus one
   * more only if the document actually has `reference` fields pointing somewhere
   * — and now, every configured global rides along in that same second query
   * (`globals.md` architecture decision 1), so a site with globals costs no
   * extra D1 read over one with references alone.
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
    opts?: { draft?: boolean; locale?: string },
  ): Promise<Resolution> => {
    const db = bindings.db
    const active = localeOf(opts?.locale)
    // Absent for the source locale, so a default-locale resolution is byte-
    // identical to a pre-localisation one (`localisation.md` decision 5). Every
    // read in `RenderBlok` goes through this one value.
    const localeField = active ? { locale: active } : {}
    const resolution: Resolution = {
      ...buildResolution((await listStories(db)).map(withUrls), assetBase),
      ...localeField,
    }

    const refIds = doc ? referencedIds(doc, schema).filter((id) => resolution.stories[id]) : []
    if (refIds.length === 0 && globals.length === 0) return resolution

    if (opts?.draft) {
      const [refEntries, globalEntries] = await Promise.all([
        Promise.all(refIds.map(async (id) => [id, await draft(bindings, id)] as const)),
        Promise.all(
          globals.map(async (name) => {
            const type = typeOf(name)!
            const meta = await ensureSingleton(db, type, schemaId)
            return [name, await draftFor(bindings, meta)] as const
          }),
        ),
      ])
      return {
        ...resolution,
        docs: Object.fromEntries(refEntries),
        globals: globals.length ? Object.fromEntries(globalEntries) : undefined,
      }
    }

    const globalIds = globals.map((name) => singletonId(typeOf(name)!))
    const combined = await publishedDocsByIds(db, [...refIds, ...globalIds])
    const docs = Object.fromEntries(
      refIds.filter((id) => combined[id]).map((id) => [id, combined[id]!]),
    )
    const globalDocs = Object.fromEntries(
      globals
        .map((name, i) => [name, combined[globalIds[i]!]] as const)
        .filter((entry): entry is [string, Doc] => Boolean(entry[1])),
    )
    return {
      ...resolution,
      docs,
      globals: globals.length ? globalDocs : undefined,
    }
  }

  /**
   * Hooks Folio registers on itself, run before any host hook for the same
   * event (`hooks.ts`'s `InternalHooks`) — the seam
   * `../editing/live-collaboration.md`'s space-channel broadcast hangs its own
   * entry off (`../platform/publish-hooks.md` decision 5). Empty today: this
   * spec has no internal consumer of its own, only the seam for the next one.
   */
  const internalHooks: FolioHooks<Env>[] = []

  const publishDeps = (bindings: FolioBindings, hookCtx: HookRunnerCtx): PublishDeps => ({
    db: bindings.db,
    draft: (story) => draftFor(bindings, story),
    draftWithSyncId: (story) => draftForWithSyncId(bindings, story),
    titleFor,
    titlesFor,
    hooks: createHookRunner<Env>(
      config.hooks,
      { env: hookCtx.env as Env, waitUntil: hookCtx.waitUntil },
      internalHooks,
    ),
  })

  /**
   * The two orders below are not the same, and are as configured today: the admin
   * page puts the plugin's stylesheets before the host's, the preview the other
   * way around.
   */
  const page = (which: 'admin' | 'preview'): PageAssets => {
    const assets = config.assets
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
    schema,
    manifest: toManifest(registry, types, globals, locales),
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
    stub,
    draftFor,
    draftForWithSyncId,
    draft,
    resolve,
    publishDeps,
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
