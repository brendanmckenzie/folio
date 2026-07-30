/**
 * The rebuilt admin's HTML, at every path its router owns.
 *
 * # Why it is mounted at `{base}/ui` and not at `{base}`
 *
 * `docs/ui-architecture.md` gives the screens the bare paths — `{base}/content`,
 * `{base}/assets`, `{base}/documents/:type`, `{base}/redirects`. **Four of those
 * are JSON routes today**, and one of them (`GET {base}/content`) is the content
 * index query the published site itself uses. A screen cannot take a path a
 * fetch is already answering on, and the collision is total rather than
 * incidental: the screens and the API are named after the same resources, because
 * they are about the same resources.
 *
 * So the shell is mounted under a prefix until the API moves out of the way.
 *
 * **Decided 2026-07-31** (`docs/specs/foundation/pagination.md` decision 3, its
 * phase 3): the admin's internal JSON moves to `{base}/api/`, beside the existing
 * `{base}/api/v1/*`, and the screens take the bare paths. One rule keeps the two
 * apart, and it is worth knowing before adding any route here:
 *
 * > **A version segment is a promise. Its absence is the absence of one.**
 * > `{base}/api/v1/*` is a contract with somebody's script and changes by adding a
 * > `v2`. `{base}/api/*` with no version is internal to the admin, ships in the
 * > same deploy as its only caller, and may change shape in any commit.
 *
 * A workers test pins that partition, because the objection to sharing one prefix
 * was that the two surfaces would look like siblings — which they do, so the
 * difference is asserted rather than left to a reader's memory.
 *
 * When that lands, this file loses `SHELL_PREFIX` and mounts at `{base}`. The
 * client needs no edit: `admin/ui/route.ts` is relative to its mount by necessity,
 * since `basePath` is host-configurable.
 */
import { Hono } from 'hono'
import { READ_DRAFT } from '../auth/roles'
import { requireHtmlAccess } from '../middleware'
import { shellPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'

/** The one segment. Exported so a test and the client's own boot value cannot
 * drift from it. */
export const SHELL_PREFIX = 'ui'

export function shellRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()
  const mount = `${rt.base}/${SHELL_PREFIX}`

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
  app.get(`/${SHELL_PREFIX}`, requireHtmlAccess<Env>(rt, READ_DRAFT), () => shellPage(rt, mount))
  app.get(`/${SHELL_PREFIX}/*`, requireHtmlAccess<Env>(rt, READ_DRAFT), () => shellPage(rt, mount))

  return app
}
