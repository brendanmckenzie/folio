import type { MiddlewareHandler } from 'hono'
import { FolioError } from './errors'
import { storyById } from './stories'
import type { FolioBindings, FolioConfig, FolioEnv } from './types'
import { idParam } from './validate'

/**
 * The one place the host's `Env` becomes Folio's bindings. Every handler then
 * reads `c.var.bindings()`, instead of each one calling `config.bindings` on an
 * env it first has to cast.
 *
 * What is stored is a memoised thunk, not the bindings: this middleware runs
 * ahead of every route, and the ones that answer from the config alone — the
 * `/schema` manifest, a 404, a refused socket upgrade — answered without the
 * host's accessor before it existed and must keep doing so. See `FolioVars` in
 * types.ts. Memoising means the routes that do need it (and their own
 * middleware, which asks first) still call it exactly once per request.
 */
export function withBindings<Env>(config: FolioConfig<Env>): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    let resolved: FolioBindings | undefined
    c.set('bindings', () => (resolved ??= config.bindings(c.env)))
    await next()
  }
}

/**
 * Screens the `:id` in the path and loads the story row behind it, or 404s.
 *
 * Mounted on the routes that need the row itself — its `title` seeds the draft on
 * first touch — so the existence check and the read are one query rather than the
 * two the same handler used to run back to back. Routes whose 404 is not a JSON
 * envelope (the admin HTML pages) or not a 404 at all (the sync socket, which
 * upgrades and closes) do their own lookup instead; see their own comments.
 */
export function loadStory<Env>(): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    const id = idParam('id', c.req.param('id'))
    const story = await storyById(c.var.bindings().db, id)
    if (!story) throw new FolioError('not_found', 'Unknown story')
    c.set('story', story)
    await next()
  }
}
