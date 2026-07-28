/**
 * The mounted app: one error envelope, one bindings middleware, and a sub-app per
 * resource. Everything under `basePath` is answered from here.
 */
import { Hono } from 'hono'
import { envelope, FolioError, INTERNAL } from './errors'
import { withBindings } from './middleware'
import { assetRoutes } from './routes/assets'
import { editorRoutes } from './routes/editor'
import { historyRoutes } from './routes/history'
import { storyRoutes } from './routes/stories'
import type { FolioRuntime } from './runtime'
import type { FolioConfig, FolioEnv } from './types'

export function createApp<Env>(config: FolioConfig<Env>, rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>().basePath(rt.base)

  /**
   * Every failed request answers `{ error: { code, message } }`.
   *
   * A FolioError carries a message a route wrote deliberately. Anything else is
   * a bug or a platform failure: it is logged with the route that raised it —
   * the library's first observability hook, and the only place an internal
   * message is allowed to appear — and the client is told nothing beyond a
   * generic 500, so raw D1 text never travels.
   *
   * It lives on this app alone: Hono ignores a mounted sub-app's own `onError`,
   * which is the point — one envelope, in one place, for every route below.
   */
  app.onError((err, c) => {
    if (err instanceof FolioError) return c.json(envelope(err), err.status)
    console.error(`folio: unhandled error in ${c.req.method} ${c.req.path}`, err)
    return c.json(INTERNAL, 500)
  })

  // Ahead of every route, because Hono runs middleware in registration order and
  // a handler registered first would never see it. All it installs is a thunk, so
  // running in front of a route that never asks for the bindings costs that route
  // nothing and — the part that matters — makes it depend on nothing new. See
  // middleware.ts.
  app.use('*', withBindings(config))

  // The manifest is derived from the config alone: no bindings, no I/O, no way
  // for the host's environment to turn this into a 500.
  app.get('/schema', (c) => c.json(rt.manifest))

  app.route('/', storyRoutes<Env>(rt))
  app.route('/', historyRoutes<Env>(rt))
  app.route('/', assetRoutes<Env>())
  app.route('/', editorRoutes<Env>(rt))

  return app
}
