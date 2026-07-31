/**
 * The mounted app: one error envelope, one bindings middleware, and a sub-app per
 * resource. Everything under `basePath` is answered from here.
 */
import { Hono } from 'hono'
import { envelope, FolioError, INTERNAL } from './errors'
import { withActor, withBindings } from './middleware'
import { accessRoutes } from './routes/access'
import { API_VERSION, apiRoutes } from './routes/api'
import { assetFileRoutes, assetRoutes } from './routes/assets'
import { authRoutes, sessionRoutes } from './routes/auth'
import { bulkRoutes } from './routes/bulk'
import { contentRoutes } from './routes/content'
import { editorPageRoutes, editorRoutes } from './routes/editor'
import { historyRoutes } from './routes/history'
import { migrationRoutes } from './routes/migrations'
import { redirectRoutes } from './routes/redirects'
import { scheduleRoutes } from './routes/schedules'
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

  /*
   * ## Where a route goes, and why
   *
   * **A version segment is a promise. Its absence is the absence of one.**
   * (`../../../docs/specs/foundation/pagination.md` decision 3.)
   *
   *   `{base}/api/v1/*`  a contract with somebody's script. Changes by adding a
   *                      `v2`, never by changing what `v1` answers.
   *   `{base}/api/*`     internal to the admin. Ships in the same deploy as its
   *                      only caller and may change shape in any commit.
   *   `{base}/*`         pages and public files: the shell's screens, the sign-in
   *                      flow, a story's preview, an asset's bytes.
   *
   * The two `/api` surfaces look like siblings and are not, which was the
   * objection to sharing one prefix. `test/workers/api-partition.test.ts` asserts
   * the split rather than leaving it to a reader's memory, so adding
   * `{base}/api/v1/stories` by reflex fails CI. **An internal route may never be
   * named `v1` or `v2`.**
   *
   * Mount order below is load-bearing in three places, each marked.
   */

  // (1) `/api/v1` first, so `/api/v1/documents/:id` is never read as one of the
  // internal routes' `:id` patterns. Mounted *after* `withActor`, like everything
  // else, so a token and a session cookie are resolved by the same middleware.
  app.route(`/api/${API_VERSION}`, apiRoutes<Env>(rt))

  /**
   * The manifest is derived from the config alone: no bindings, no I/O, no way for
   * the host's environment to turn this into a 500. Deliberately ungated, because
   * the admin bundle needs it before it can render a sign-in prompt of its own.
   *
   * **The rule for what may go in it, since "it describes the code, not the
   * content" has already been read too widely once.** The manifest carries the
   * *declarations a client needs before it can authenticate* — document types,
   * block schemas, locales, globals, declared publish hooks. **Anything that
   * describes a security decision belongs behind `withActor` instead, however
   * configuration-shaped it looks.**
   *
   * The case that set the rule: sign-in providers and session policy were added
   * here for the Settings screen and taken straight back out. `provision` told an
   * unauthenticated stranger whether any account at the configured IdP becomes an
   * editor and at what role, and `linksPerHour` published the exact throttle on
   * the sign-in flow. Neither made the site more exploitable — an attacker learns
   * both by trying — but both turned something you had to attempt into something
   * you could read, and a public route is the wrong place to answer either. They
   * live on `GET {base}/api/me` now, which is the route that already knows who is
   * asking; `auth/config.ts`'s `AuthPolicy` carries the argument in full.
   *
   * So, before adding a field here: would you be content to see it in an
   * unauthenticated `curl`? If the answer needs a caveat, it goes on `/me`.
   */
  app.get('/api/schema', (c) => c.json(rt.manifest))

  // (2) Inside `/api`, `/login/verify` has no counterpart to be confused with, but
  // `/story/:id/...` patterns are still shadow-prone, so the specific ones go
  // first. Nothing in `sessionRoutes` needs a credential to *reach*, which is what
  // makes it safe ahead of any gate.
  app.route('/api', sessionRoutes<Env>(rt))
  app.route('/api', accessRoutes<Env>(rt))
  app.route('/api', storyRoutes<Env>(rt))
  // After `storyRoutes`, which owns `/story/:id/publish` and `/unpublish`. Order is
  // not load-bearing here — `/story/:id/schedule` is a distinct literal segment,
  // not a `:param` either one could swallow — and it reads next to its siblings.
  app.route('/api', scheduleRoutes<Env>(rt))
  // Also after `storyRoutes`, and order is not load-bearing here either: `/bulk/*`
  // shares no prefix with anything else on this mount. It reads next to the routes
  // whose per-document twins it performs in a loop.
  app.route('/api', bulkRoutes<Env>(rt))
  app.route('/api', historyRoutes<Env>(rt))
  app.route('/api', assetRoutes<Env>(rt))
  app.route('/api', editorRoutes<Env>(rt))
  app.route('/api', redirectRoutes<Env>(rt))
  app.route('/api', migrationRoutes<Env>(rt))
  app.route('/api', contentRoutes<Env>(rt))
  app.route('/api', spaceRoutes<Env>(rt))

  /**
   * An unmatched path under `/api` is a **JSON 404**, and this line is what makes
   * it one.
   *
   * Without it the shell's wildcard below catches everything unmatched — including
   * a typo'd or retired API path — and answers 200 with an HTML document. A `fetch`
   * then fails inside `res.json()` with a syntax error pointing at `<!doctype`,
   * which is about as far from the real problem as a message can get.
   * `test/workers/api-partition.test.ts` found this, and now asserts it.
   *
   * `app.all`, not `app.get`: a POST to a path that no longer exists deserves the
   * same answer as a GET to one.
   */
  app.all('/api/*', () => {
    throw new FolioError('not_found', 'No such API route')
  })

  // The bare mount: pages and public bytes. All of these are navigated to or
  // embedded in HTML, so none of them may move under `/api`.
  //
  // `authRoutes` stays ahead of the rest for its original reason: `/login/verify`
  // must not be read as `/login/:provider`.
  app.route('/', authRoutes<Env>(rt))
  app.route('/', assetFileRoutes<Env>())

  // (3) `shellRoutes`' wildcard covers every bare path, and it now covers
  // `{base}/edit/:id` too — **port phase 7 landed, so the rebuilt editor owns the
  // URL.** `editorPageRoutes` used to be registered ahead of it for exactly the
  // reason the comment here recorded: that ordering is what kept the working
  // single-screen editor serving while the shell was built around it, and removing
  // the registration was the whole of the handover.
  //
  // `editorPageRoutes` still precedes it, and still must: it resolves `/edit/:id`
  // server-side and 404s an unknown id before the host's bindings are taken, which a
  // wildcard cannot do. What changed is what it *renders* — the shell, not the old
  // admin's bootstrap.
  //
  // **Port phase 8 landed too**: the old admin is deleted, so there is no longer a
  // second application to keep unreachable. The comment that used to be here listed
  // eight pure functions the new editor imported out of it, as the prerequisite for
  // deleting the files — there turned out to be **ten**, the ninth being a *hook*,
  // which a list assembled by reasoning about pure functions could not see. All ten
  // moved to the file that uses them.
  app.route('/', editorPageRoutes<Env>(rt))
  app.route('/', shellRoutes<Env>(rt))

  return app
}
