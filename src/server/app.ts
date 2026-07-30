/**
 * The mounted app: one error envelope, one bindings middleware, and a sub-app per
 * resource. Everything under `basePath` is answered from here.
 */
import { Hono } from 'hono'
import { envelope, FolioError, INTERNAL } from './errors'
import { withActor, withBindings } from './middleware'
import { accessRoutes } from './routes/access'
import { API_VERSION, apiRoutes } from './routes/api'
import { assetRoutes } from './routes/assets'
import { authRoutes } from './routes/auth'
import { contentRoutes } from './routes/content'
import { editorRoutes } from './routes/editor'
import { historyRoutes } from './routes/history'
import { migrationRoutes } from './routes/migrations'
import { redirectRoutes } from './routes/redirects'
import { shellRoutes } from './routes/shell'
import { spaceRoutes } from './routes/space'
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

  // Straight after the bindings, because it needs them (behind their thunk) and
  // because every route below reads `c.var.actor`. It resolves an identity; it
  // refuses nothing. What each route *requires* is declared at that route's own
  // mount with `requireAccess`, so the gate is visible where the handler is
  // rather than in a table of paths somewhere else
  // (identity-and-access.md architecture decision 5).
  app.use('*', withActor(rt))

  // The manifest is derived from the config alone: no bindings, no I/O, no way
  // for the host's environment to turn this into a 500. Deliberately left
  // ungated: it describes the code, not the content, and the admin bundle needs
  // it before it can render a sign-in prompt of its own.
  app.get('/schema', (c) => c.json(rt.manifest))

  // Ahead of the resource routes: `/login/verify` must not be read as
  // `/login/:provider`, and neither may be shadowed by a `:id` pattern further
  // down. Nothing in here needs a credential, which is what makes it safe to
  // mount before any gate exists (identity-and-access.md).
  app.route('/', authRoutes<Env>(rt))
  app.route('/', accessRoutes<Env>(rt))

  // Ahead of the resource routes, so `/api/v1/documents/:id` is never read as one
  // of their `:id` patterns. Two surfaces over one set of services
  // (`../../../docs/specs/platform/content-api.md` decision 2): everything below
  // this line is internal to the admin and free to change with it, everything
  // under `/api/v1` is a contract with somebody's script. Mounted *after*
  // `withActor`, like everything else, so a token and a session cookie are
  // resolved by the same middleware and each route declares what it needs at its
  // own mount.
  app.route(`/api/${API_VERSION}`, apiRoutes<Env>(rt))

  // Ahead of the resource routes, so its wildcard is never reached for a path one
  // of them owns — and it only matches under its own prefix anyway, which is the
  // reason that prefix exists (see routes/shell.ts).
  app.route('/', shellRoutes<Env>(rt))

  app.route('/', storyRoutes<Env>(rt))
  app.route('/', historyRoutes<Env>(rt))
  app.route('/', assetRoutes<Env>(rt))
  app.route('/', editorRoutes<Env>(rt))
  app.route('/', redirectRoutes<Env>(rt))
  app.route('/', migrationRoutes<Env>(rt))
  app.route('/', contentRoutes<Env>(rt))
  app.route('/', spaceRoutes<Env>(rt))

  return app
}
