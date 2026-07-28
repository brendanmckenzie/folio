/**
 * The shapes a host application configures Folio with, and the ones the route
 * files share with each other.
 *
 * Types only, with no runtime half: a route module can name the request context
 * and the config without importing the factory that builds them, which is what
 * keeps `index.tsx` free to import every route module in turn.
 */
import type { ReactNode } from 'react'
import type { AnyBlockDef, Registry } from '../core/block'
import type { Doc } from '../core/doc'
import type { Resolution } from '../core/resolve'
import type { StoryMeta, StoryNode } from '../core/story'
import type { StoryDO } from './story-do'

export interface FolioBindings {
  db: D1Database
  story: DurableObjectNamespace<StoryDO>
  /** R2 bucket for uploads. Without it the media library is read-only. */
  media?: R2Bucket
  /**
   * Images binding. Without it assets serve at their original size, which keeps
   * Folio working on a bare `wrangler dev` with nothing else configured.
   */
  images?: ImagesBinding
}

/**
 * The Durable Object's RPC surface, derived from the class rather than restated.
 *
 * `DurableObjectStub<StoryDO>` is what `story.get()` returns and is the honest
 * type, but *calling* a method on it fails to compile with TS2589 ("type
 * instantiation is excessively deep"): the RPC type mapper cannot chew through
 * `Doc`, whose value type is recursive. Picking the methods off the class keeps
 * every signature generated from the one definition — a hand-written mirror of
 * them drifts the moment the class changes — and never instantiates the mapper.
 * test/workers/smoke.test.ts hits the same wall and says so.
 */
export type StoryStub = Pick<StoryDO, 'getOrInit' | 'recent' | 'purge' | 'fetch'>

export interface FolioConfig<Env> {
  blocks: readonly AnyBlockDef[] | Registry
  /** Block type used as the document root. Also where page metadata lives. */
  root: string
  bindings: (env: Env) => FolioBindings
  /** Where these routes are mounted. Default `/folio`. */
  basePath?: string
  /**
   * Public URL for a story path. `''` is the site root. `previewUrl` (see
   * `withUrls` in server/runtime.ts) is this same URL with a preview flag
   * appended, loaded straight into the admin's iframe — so it is a hard
   * requirement, not a courtesy, that it resolve to the *same origin* the
   * admin itself is served from. The admin↔preview postMessage bridge (see
   * core/protocol.ts and admin/hooks/usePreviewBridge.ts) checks
   * `event.origin` on every frame in both directions and drops anything else
   * silently; a `route` that points a story at a different origin does not
   * degrade to a broken preview, the iframe just never talks to the editor
   * at all.
   */
  route?: (path: string) => string
  adminCss?: string[]
  previewCss?: string[]
  /** Pass the `__FOLIO_ASSETS__` global the Vite plugin defines. */
  assets?: {
    admin: string
    preview: string
    devClient?: string
    adminCss?: string[]
    previewCss?: string[]
  }
}

export interface Folio<Env> {
  /**
   * Mount in the host's fetch handler. Returns null for anything Folio does
   * not own, so the host's own routes always win.
   */
  handle: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response | null>
  /** Published document for a URL path, or null. */
  published: (env: Env, path: string) => Promise<Doc | null>
  /** Live draft for a story id, creating it on first touch. */
  draft: (env: Env, id: string) => Promise<Doc>
  /** Every story, for sitemaps and static generation. */
  stories: (env: Env) => Promise<StoryMeta[]>
  tree: (env: Env) => Promise<StoryNode[]>
  registry: Registry
  /**
   * Context the document deliberately does not contain: story ids to their
   * current URLs, and so on. Await it before rendering.
   *
   * Resolution happens per render rather than being baked in at publish, because
   * a link stores a story id: renaming the linked-to page has to change every
   * href pointing at it, and a snapshot taken at publish time could not.
   */
  resolve: (env: Env, doc?: Doc) => Promise<Resolution>
  render: (doc: Doc, opts?: { edit?: boolean; resolution?: Resolution }) => ReactNode
}

/**
 * Request-scoped values the handlers read off the context.
 *
 * `bindings` is set for every request by the middleware in middleware.ts, which
 * is the one place the host's `Env` is turned into Folio's own bindings.
 *
 * It is a call rather than a value, and that is the whole point: `config.bindings`
 * belongs to the host, so *invoking* it is observable — it may throw, or read
 * something lazily. The routes that answer without touching D1, R2 or the Durable
 * Object (`/schema`, which is a pure manifest; any 404; a socket upgrade refused
 * for want of the header) must not start depending on it merely because a
 * middleware runs ahead of them. The thunk is memoised per request, so a route
 * that does need the bindings costs exactly one call however many times it and
 * its middleware ask.
 *
 * `story` is only set on the routes that mount `loadStory`, and is typed as
 * always-present because Hono has no way to say otherwise: reading it in a
 * handler that does not sit behind that middleware is the mistake this comment
 * exists to name.
 */
export interface FolioVars {
  bindings: () => FolioBindings
  story: StoryMeta
}

/**
 * Hono's env for every Folio app and sub-app.
 *
 * `Env & object` rather than `Env`: Hono constrains `Bindings` to `object`, and
 * `createFolio`'s `Env` is deliberately unconstrained so a host can pass
 * whatever shape its Worker's env has. Intersecting satisfies the constraint and
 * leaves `c.env` assignable to `Env`, so `config.bindings(c.env)` needs no cast
 * — the previous `Bindings: never` made every handler write one.
 */
export interface FolioEnv<Env> {
  Bindings: Env & object
  Variables: FolioVars
}
