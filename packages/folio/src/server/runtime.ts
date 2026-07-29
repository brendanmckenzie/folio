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
import { buildResolution, referencedIds, type Resolution } from '../core/resolve'
import { blankSubtree, type Manifest, validatePresets } from '../core/schema'
import type { StoryMeta, StoryNode } from '../core/story'
import type { PublishDeps } from './publish'
import { listStories, publishedDocsByIds, storyById } from './stories'
import type { FolioBindings, FolioConfig, StoryStub } from './types'

const DEFAULT_BASE = '/folio'

/** Client entries and stylesheets for one of the two HTML pages Folio serves. */
export interface PageAssets {
  entries: string[]
  stylesheets: string[]
}

export interface FolioRuntime {
  registry: Registry
  /** What `GET {base}/schema` answers. Contains no functions. */
  manifest: Manifest
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
  resolve: (bindings: FolioBindings, doc?: Doc, opts?: { draft?: boolean }) => Promise<Resolution>
  /**
   * What the publish workflows need, assembled from bindings alone — the one
   * place that assembly lives, for a route today and a Durable Object alarm next
   * phase.
   */
  publishDeps: (bindings: FolioBindings) => PublishDeps
  page: (which: 'admin' | 'preview') => PageAssets
}

export function createRuntime<Env>(config: FolioConfig<Env>): FolioRuntime {
  const registry = toRegistry(config.blocks)
  const schema = toSchemaIndex(registry)
  // Construction-time, before any request is served: an invalid preset (an
  // unknown type or slot, a disallowed child, a cycle) is a config mistake,
  // not a runtime surprise a caller discovers three requests later.
  validatePresets(schema)
  const base = config.basePath ?? DEFAULT_BASE
  const route = config.route ?? ((path: string) => `/${path}`)
  const assetBase = `${base}/asset`

  const previewUrlFor = (path: string) => {
    const url = route(path)
    return `${url}${url.includes('?') ? '&' : '?'}_folio=preview`
  }

  const withUrls = <T extends StoryMeta>(story: T): T => ({
    ...story,
    url: route(story.path),
    previewUrl: previewUrlFor(story.path),
  })

  const decorate = (nodes: StoryNode[]): StoryNode[] =>
    nodes.map((n) => ({ ...withUrls(n), children: decorate(n.children) }))

  // A starting document is just the root block's own 'default' preset
  // (field-defaults-and-presets.md, decision 3) — no template config key of
  // its own. A root with no such preset seeds a bare root, exactly as before
  // this spec.
  const hasDefaultPreset = schema[config.root]?.presets?.some((p) => p.name === 'default') ?? false

  const seed = (title: string): Doc => {
    const bloks = blankSubtree(
      schema,
      config.root,
      null,
      null,
      'a0',
      hasDefaultPreset ? 'default' : undefined,
    )
    const root = bloks[0]!
    if ('title' in root.data) root.data.title = title
    return { root: root.uid, bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])) }
  }

  const stub = ({ story }: FolioBindings, id: string): StoryStub =>
    story.get(story.idFromName(id)) as unknown as StoryStub

  const draftFor = (bindings: FolioBindings, story: StoryMeta) =>
    stub(bindings, story.id).getOrInit(seed(story.title))

  const draftForWithSyncId = (bindings: FolioBindings, story: StoryMeta) =>
    stub(bindings, story.id).getOrInitWithSyncId(seed(story.title))

  const draft = async (bindings: FolioBindings, id: string) => {
    const meta = await storyById(bindings.db, id)
    return stub(bindings, id).getOrInit(seed(meta?.title ?? 'Untitled'))
  }

  /**
   * One D1 query for the story map, the same one the tree already runs, plus one
   * more only if the document actually has `reference` fields pointing somewhere.
   * Cheap enough to do per page render; a cache layer in front of it is Phase 4's
   * problem.
   *
   * `draft` is what the preview passes: an editor looking at a page that
   * references a form should see the form as they just edited it, not the last
   * published copy. A live page always resolves published content.
   */
  const resolve = async (
    bindings: FolioBindings,
    doc?: Doc,
    opts?: { draft?: boolean },
  ): Promise<Resolution> => {
    const db = bindings.db
    const resolution = buildResolution((await listStories(db)).map(withUrls), assetBase)
    if (!doc) return resolution

    const ids = referencedIds(doc, schema).filter((id) => resolution.stories[id])
    if (ids.length === 0) return resolution

    const docs = opts?.draft
      ? Object.fromEntries(
          await Promise.all(ids.map(async (id) => [id, await draft(bindings, id)] as const)),
        )
      : await publishedDocsByIds(db, ids)

    return { ...resolution, docs }
  }

  const publishDeps = (bindings: FolioBindings): PublishDeps => ({
    db: bindings.db,
    draft: (story) => draftFor(bindings, story),
    draftWithSyncId: (story) => draftForWithSyncId(bindings, story),
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
    manifest: toManifest(registry, config.root),
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
