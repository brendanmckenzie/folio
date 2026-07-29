import { FolioDoc } from '../preview/Render'
import { createApp } from './app'
import { previewPage } from './pages'
import { createRuntime } from './runtime'
import { listStories, publishedDoc, storyByPath, storyStatus, storyTree } from './stories'
import { StoryDO } from './story-do'
import type { Folio, FolioConfig } from './types'

export { StoryDO }
export type { VersionKind, VersionMeta } from './versions'
export { FolioError } from './errors'
export type { ErrorEnvelope, FolioErrorCode } from './errors'
export { FolioDoc } from '../preview/Render'
export { Shell, serializeJson } from './Document'
export type { StoryMeta, StoryNode } from '../core/story'
export type { Resolution } from '../core/resolve'
export type { AssetRow } from './assets'
export type { Folio, FolioBindings, FolioConfig } from './types'

/**
 * Wires a block registry and a set of bindings into the HTTP surface, the
 * document helpers a host renders with, and nothing else: this factory owns the
 * composition and none of the behaviour.
 *
 * The pieces, in the order a request meets them: runtime.ts derives everything
 * that comes off the config once, app.ts mounts a sub-app per resource under
 * `basePath`, and publish.ts holds the workflows a route only translates for.
 */
export function createFolio<Env>(config: FolioConfig<Env>): Folio<Env> {
  const rt = createRuntime(config)
  const app = createApp(config, rt)

  const handle: Folio<Env>['handle'] = async (req, env, ctx) => {
    const url = new URL(req.url)

    if (url.pathname === rt.base || url.pathname.startsWith(`${rt.base}/`)) {
      // The one cast in the server: `Env` is unconstrained by design, and Hono
      // requires an object. See `FolioEnv` in types.ts.
      return app.fetch(req, env as Env & object, ctx)
    }

    if (url.searchParams.get('_folio') === 'preview') {
      const bindings = config.bindings(env)
      const path = url.pathname.replace(/^\/+|\/+$/g, '')
      const story = await storyByPath(bindings.db, path)
      // Not a story: hand it back so the host's own routing wins.
      if (!story) return null
      return previewPage(rt, bindings, story)
    }

    return null
  }

  return {
    handle,
    published: (env, path) => publishedDoc(config.bindings(env).db, path),
    status: (env, path) => storyStatus(config.bindings(env).db, path),
    draft: (env, id) => rt.draft(config.bindings(env), id),
    stories: async (env) => (await listStories(config.bindings(env).db)).map(rt.withUrls),
    tree: async (env) => rt.decorate(await storyTree(config.bindings(env).db)),
    registry: rt.registry,
    resolve: (env, doc) => rt.resolve(config.bindings(env), doc),
    render: (doc, opts) => (
      <FolioDoc doc={doc} registry={rt.registry} edit={opts?.edit} resolution={opts?.resolution} />
    ),
  }
}
