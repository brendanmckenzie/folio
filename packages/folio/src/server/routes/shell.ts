/**
 * The rebuilt admin's HTML, at every path its router owns — which is **every bare
 * path under the mount**, via a wildcard.
 *
 * That is possible because the admin's internal JSON moved to `{base}/api/`
 * (`../../../docs/specs/foundation/pagination.md` decision 3, phase 3). Before it
 * did, four screens collided head-on with JSON routes — `{base}/content`,
 * `{base}/assets`, `{base}/documents/:type`, `{base}/redirects` — and the shell had
 * to live under a `/ui` prefix. The collision was total rather than incidental: the
 * screens and the API are named after the same resources because they are about
 * the same resources.
 *
 * One rule keeps the two `/api` surfaces apart, and it is worth knowing before
 * adding any route anywhere in `server/`:
 *
 * > **A version segment is a promise. Its absence is the absence of one.**
 * > `{base}/api/v1/*` is a contract with somebody's script and changes by adding a
 * > `v2`. `{base}/api/*` with no version is internal to the admin, ships in the
 * > same deploy as its only caller, and may change shape in any commit.
 *
 * `test/workers/api-partition.test.ts` asserts that split, because the objection
 * to sharing one prefix was that the two surfaces would look like siblings — which
 * they do, so the difference is a test rather than a reader's memory.
 *
 * **This wildcard is registered last on purpose.** Anything that must keep a bare
 * path registers ahead of it in `app.ts`: the sign-in flow, an asset's bytes, a
 * singleton's preview, and `{base}/edit/:id`, which the working single-screen
 * editor keeps until port phase 7 replaces it.
 */
import { Hono } from 'hono'
import { READ_DRAFT } from '../auth/roles'
import { requireHtmlAccess } from '../middleware'
import { shellPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'

export function shellRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * Gated exactly like the editor page (`READ_DRAFT`), and for the same reason:
   * every screen behind here shows unpublished content, and an HTML route owes a
   * sign-in redirect rather than a JSON envelope.
   *
   * A wildcard, deliberately: an unknown path answers the shell, which renders
   * its own "not found" screen with the nav still around it. A 404 from the
   * server would be correct and useless — the person mistyped a URL inside an
   * application they are signed in to, and the recovery is one click away in a
   * sidebar the server cannot draw.
   */
  app.get('/', requireHtmlAccess<Env>(rt, READ_DRAFT), () => shellPage(rt))
  app.get('/*', requireHtmlAccess<Env>(rt, READ_DRAFT), () => shellPage(rt))

  return app
}
