import { singletonId } from '../core/schema'
import { FolioDoc, renderGlobalNode } from '../preview/Render'
import { createApp } from './app'
import { credentialOf, resolveActor } from './auth/resolve'
import { allows, READ_DRAFT } from './auth/roles'
import { previewPage } from './pages'
import { lookupRedirect } from './redirects'
import { createRuntime } from './runtime'
import {
  listStories,
  publishedDoc,
  publishedDocsByIds,
  storyByPath,
  storyStatus,
  storyTree,
} from './stories'
import { StoryDO } from './story-do'
import type { Folio, FolioConfig } from './types'

export { StoryDO }
export type { DocumentKind, DocumentType } from '../core/schema'
export type { VersionKind, VersionMeta } from './versions'
export type { Redirect } from './redirects'
export type {
  CheckpointedHookPayload,
  CreatedHookPayload,
  DeletedHookPayload,
  FolioHooks,
  HookEvent,
  PathsChangedHookPayload,
  PublishedHookPayload,
  UnpublishedHookPayload,
} from './hooks'
export { FolioError } from './errors'
export type { ErrorEnvelope, FolioErrorCode } from './errors'
export { magicLink } from './auth/magic-link'
export { oidc } from './auth/oidc'
export {
  ADMIN,
  ASSETS,
  atLeast,
  EDIT,
  hasScope,
  MANAGE,
  PUBLISH,
  READ,
  READ_DRAFT,
  ROLES,
  SCOPES,
} from './auth/roles'
export type { Access, Actor, Role, Scope, TokenActor, UserActor } from './auth/roles'
export type {
  AuthConfig,
  AuthProvider,
  MagicLinkMail,
  Provisioning,
  VerifiedIdentity,
} from './auth/config'
export type { UserRow } from './auth/users'
export type { TokenRow } from './auth/tokens'
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

      // A preview renders the *draft*, so it needs the same gate the API routes
      // got in identity-and-access.md — and it is the one such surface that lives
      // outside `basePath`, so the app's own middleware never sees it. Without
      // this, appending `?_folio=preview` to any URL would read unpublished
      // content on a site that had otherwise closed its editor entirely.
      //
      // Refused by handing the request *back* rather than by answering 401: to
      // an unauthenticated visitor the flag then means nothing at all and the
      // host serves its ordinary published page, which is both the safe answer
      // and the least surprising one.
      if (rt.auth.mode === 'session') {
        const actor = await resolveActor(() => bindings.db, rt.auth, credentialOf(req))
        if (!allows(actor, READ_DRAFT)) return null
      }

      const path = url.pathname.replace(/^\/+|\/+$/g, '')
      const story = await storyByPath(bindings.db, path)
      // Not a story: hand it back so the host's own routing wins. An unrouted
      // document can never be reached here anyway — `storyByPath` matches on
      // `path = ?` and one stores NULL — but the check is spelled out because
      // "a preview request for a record is the host's, not Folio's" is a rule
      // (`document-types.md`), not an accident of SQL semantics.
      if (!story || story.path === null) return null

      // `as` previews a singleton in the context of this page (`globals.md`
      // decision 4). Naming anything that is not a configured global is the
      // same refusal shape as a path with no story: null, so the host's own
      // routes win rather than Folio guessing at what was meant.
      const as = url.searchParams.get('as')
      if (as !== null) {
        const type = rt.typeOf(as)
        if (type?.kind !== 'singleton' || !rt.globals.includes(as)) return null
        return previewPage(rt, bindings, story, { as })
      }

      return previewPage(rt, bindings, story)
    }

    return null
  }

  return {
    handle,
    published: (env, path) => publishedDoc(config.bindings(env).db, path),
    status: (env, path) => storyStatus(config.bindings(env).db, path),
    redirect: (env, path) => lookupRedirect(config.bindings(env).db, path),
    draft: (env, id) => rt.draft(config.bindings(env), id),
    stories: async (env) => (await listStories(config.bindings(env).db)).map(rt.withUrls),
    tree: async (env) => rt.decorate(await storyTree(config.bindings(env).db)),
    registry: rt.registry,
    resolve: (env, doc) => rt.resolve(config.bindings(env), doc),
    render: (doc, opts) => (
      <FolioDoc doc={doc} registry={rt.registry} edit={opts?.edit} resolution={opts?.resolution} />
    ),
    global: async (env, name) => {
      const type = rt.typeOf(name)
      if (type?.kind !== 'singleton') return null
      const id = singletonId(type)
      const docs = await publishedDocsByIds(config.bindings(env).db, [id])
      return docs[id] ?? null
    },
    renderGlobal: (resolution, name, opts) => renderGlobalNode(rt.registry, resolution, name, opts),
  }
}
