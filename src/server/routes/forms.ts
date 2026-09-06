/**
 * The forms an editor builds: list, create, read, save, delete, and what a
 * delete would break (`../../../docs/specs/content-model/forms.md` phase 2).
 *
 * **All under `{base}/api`, none under `{base}/api/v1`** (checkpoint 20). A
 * version segment is a promise to somebody's script and nobody has asked for
 * this one; the `submitted` hook is the entire programmatic surface for a host,
 * and adding a versioned route later is additive.
 * `test/workers/api-partition.test.ts` pins the split.
 *
 * The public submit route is deliberately *not* here: it lives on the bare mount
 * beside `assetFileRoutes`, because a browser navigates to it and its URL is
 * baked into published HTML (decision 3). It is phase 4's.
 *
 * Three access levels, and the ladder is checkpoint 8's: building a form is
 * `EDIT`, reading one is `READ`, and only `ADMIN` may destroy one — because a
 * form's delete takes every response with it.
 */
import { Hono } from 'hono'
import { wasRefused } from '../../core/bulk'
import { NO_STORE } from '../../core/cache-tags'
import { honeypotName } from '../../core/forms'
import { actorString, ADMIN, EDIT, FORMS, READ } from '../auth/roles'
import { FolioError } from '../errors'
import {
  type AnswerRefusal,
  bodyHash,
  capFor,
  clientIp,
  DEFAULT_RATE_PER_HOUR,
  deleteResponse,
  deleteResponses,
  filePartsOf,
  insertResponse,
  ipHash,
  isDuplicateSubmission,
  listResponses,
  newResponseId,
  type PreparedUpload,
  prepareUploads,
  putUploads,
  rawBodyOf,
  readSubmission,
  recentSubmissionCount,
  responseById,
  responseCsv,
  responseFileOf,
  storedFilesOf,
  type SubmissionBody,
  throttleHashes,
  validateSubmission,
} from '../form-responses'
import {
  createForm,
  deleteForm,
  type Form,
  formById,
  formMeta,
  deleteUploads,
  formUsage,
  hasFileQuestion,
  isOpen,
  listForms,
  LOCALE_INPUT,
  PAGE_INPUT,
  updateForm,
} from '../forms'
import { hookCtx, requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import {
  DOWNLOAD_CONTENT_TYPE,
  fieldNameParam,
  FormCreateBody,
  FormPatchBody,
  formIdParam,
  limitParam,
  parseBody,
  requireCursor,
  ResponseBulkBody,
  responseFilterQuery,
  responseIdParam,
  safeNext,
  wantsJson,
} from '../validate'

/**
 * The refusal a host with no `media` binding gets for anything file-shaped
 * (`../../../docs/specs/content-model/forms.md` decision 15).
 *
 * **Legible, and it names the binding** — the shape `FolioBindings` already sets
 * for `media`, `images` and `browser`, and the reason `unsupported` exists as a
 * code at all: "this deployment is not configured for that" is a different fact
 * from "you may not" and from "there is no such thing", and a host debugging a
 * form that refuses every CV needs to be told which of the three it is.
 */
function noMedia(): FolioError {
  return new FolioError('unsupported', 'No media bucket is configured, so a form cannot take files')
}

export function formRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * Most recently changed first, keyset-paged
   * (`../../../docs/specs/foundation/pagination.md`).
   *
   * Two opt-in aggregates rather than one, because they cost different things.
   * `?count=1` is a `count(*)` over `forms`, a table bounded by what a person
   * will build; `?counts=1` is a grouped read of `form_responses`, which is
   * unbounded and grows for as long as the site is up. The list screen asks for
   * both; a client walking the cursor should ask for neither.
   */
  app.get('/forms', requireAccess<Env>(rt, READ), async (c) => {
    const db = c.var.bindings().db
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    return c.json(
      await listForms(db, {
        limit: limitParam(c.req.query('limit'), 50, 200),
        cursor,
        count: c.req.query('count') === '1',
        counts: c.req.query('counts') === '1',
      }),
    )
  })

  /**
   * A new, empty form. `EDIT`, not `MANAGE`: a form with no questions is
   * reachable from nothing and breaks nothing, the same reading that put
   * `CREATE` at editor for documents.
   */
  app.post('/forms', requireAccess<Env>(rt, EDIT), async (c) => {
    const body = await parseBody(c.req, FormCreateBody)
    const form = await createForm(c.var.bindings().db, body)
    return c.json(form, 201)
  })

  app.get('/forms/:id', requireAccess<Env>(rt, READ), async (c) => {
    const form = await formById(c.var.bindings().db, formIdParam(c.req.param('id')))
    if (!form) throw new FolioError('not_found', 'Unknown form')
    return c.json(form)
  })

  /**
   * A builder save.
   *
   * **`formChanged` fires only on a structural save**, which is what makes the
   * purge honest: a page cached for a week holds the old markup, and if the form
   * gained a required field every cached visitor would submit something the live
   * form refuses and see an error they could not possibly fix. A label edit
   * changes no constraint, so it purges nothing (decision 7).
   *
   * The 409 for a stale `expectedUpdatedAt` comes out of `updateForm`, where the
   * guard is part of the `update` rather than a read in front of it.
   */
  app.patch('/forms/:id', requireAccess<Env>(rt, EDIT), async (c) => {
    const id = formIdParam(c.req.param('id'))
    const body = await parseBody(c.req, FormPatchBody)
    const { db, media } = c.var.bindings()

    // The builder half of decision 15's refusal. Checked on the *incoming*
    // fields rather than the stored ones, so this refuses adding the question
    // rather than refusing to save a form that already has one — and it is the
    // reason `deleteForm` can treat "files with no bucket" as unreachable.
    if (!media && body.fields?.some((field) => field.kind === 'file')) throw noMedia()

    const result = await updateForm(db, id, body)
    if (!result) throw new FolioError('not_found', 'Unknown form')

    if (result.structural) {
      await rt.hookRunner(hookCtx(c)).run('formChanged', {
        form: formMeta(result.form),
        version: result.form.version,
        actor: actorString(c.var.actor),
      })
    }
    return c.json(result.form)
  })

  /**
   * The form, its responses and their files — all of it, and the counts of what
   * went.
   *
   * **`ADMIN`, and it cascades** (checkpoint 17). The alternative considered and
   * rejected was refusing while a count is non-zero, which leaves an editor
   * unable to remove a finished campaign at all. What makes the cascade safe is
   * that it is never a surprise: `GET /forms/:id/usage` answers all three
   * numbers the dialog names, in one call, before anything is destroyed.
   */
  app.delete('/forms/:id', requireAccess<Env>(rt, ADMIN), async (c) => {
    const id = formIdParam(c.req.param('id'))
    const { db, media } = c.var.bindings()
    // The bucket, so the objects go with the rows. `deleteForm` throws rather
    // than silently orphaning them if it is absent and there is anything to
    // delete, which is why this is passed unconditionally instead of guarded.
    const result = await deleteForm(db, id, media)
    if (!result.deleted) throw new FolioError('not_found', 'Unknown form')
    return c.json(result)
  })

  /**
   * What a delete would break and what it would destroy: the published documents
   * that render this form, and the responses and files that go with it.
   *
   * **`EDIT`, matching `GET {base}/api/assets/:id/usage` exactly** — it reports
   * on published content an editor can already read, so the lower bar leaks
   * nothing. The delete it precedes is `ADMIN`, which is the one place the two
   * usage routes differ in consequence rather than in shape.
   *
   * It **404s an unknown id** rather than answering an empty usage, for the
   * asset route's reason: the row has to be read to answer at all, and "no such
   * form" is a more useful answer than "used by nobody" for a stale link.
   */
  app.get('/forms/:id/usage', requireAccess<Env>(rt, EDIT), async (c) => {
    const db = c.var.bindings().db
    const id = formIdParam(c.req.param('id'))
    const form = await formById(db, id)
    if (!form) throw new FolioError('not_found', 'Unknown form')

    const usage = await formUsage(db, id)
    return c.json({
      published: usage.published.map((story) => ({
        id: story.id,
        title: story.title,
        path: story.path,
        // `''` rather than absent for an unrouted document, matching both other
        // usage routes: a record embedding a form has no URL to offer.
        url: rt.withUrls(story).url ?? '',
      })),
      total: usage.total,
      responses: usage.responses,
      files: usage.files,
    })
  })

  /* ---------------------------------------------------------- responses --- */

  /**
   * One page of a form's responses, newest first
   * (`../../../docs/specs/content-model/forms.md` phase 7).
   *
   * **`FORMS`, which is `publisher` plus `forms:read`** — checkpoint 8's ladder:
   * an editor who may build the form is not thereby somebody who may read what
   * strangers typed into it. Exporting and deleting are `ADMIN`, one rung further.
   *
   * **No existence check on the form**, deliberately, and it is the one place in
   * this file that departs from `/forms/:id/usage`'s "404 a stale link" rule. The
   * screen fetches `GET /forms/:id` for the questions it draws columns from, so
   * an unknown id is already a 404 somebody sees; adding a second read here would
   * put a `select` on every keystroke of the search box, which is the budget
   * `pagination.md` decision 5 spends its whole argument protecting. Every reader
   * binds `form_id`, so a bogus id answers an empty page rather than somebody
   * else's rows.
   *
   * `?count=1` answers **two** numbers: `total` for the header and for a
   * select-all's guard, and `oldest` — the age of this form's oldest surviving
   * response, which is what makes manual retention visible on the surface that
   * would show the symptom (decision 17). `oldest` ignores the filter on purpose.
   */
  app.get('/forms/:id/responses', requireAccess<Env>(rt, FORMS), async (c) => {
    const db = c.var.bindings().db
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    return c.json(
      await listResponses(db, formIdParam(c.req.param('id')), {
        limit: limitParam(c.req.query('limit'), 50, 200),
        cursor,
        filter: responseFilterQuery({ query: (key) => c.req.query(key) }),
        count: c.req.query('count') === '1',
      }),
    )
  })

  /**
   * The CSV, streamed and filtered exactly as the table is
   * (`../../../docs/specs/content-model/forms.md` decision 16).
   *
   * **`ADMIN`.** A table on a screen is one publisher reading enquiries; a file is
   * a copy of every stranger's answers leaving the building, and checkpoint 8 puts
   * that a rung higher.
   *
   * **Not JSON, and it says so in three headers.** `content-disposition:
   * attachment` because the point of it is a file; `no-store` because a copy of a
   * form's whole response table has no business in any cache; `nosniff` because a
   * `text/csv` a browser felt free to reinterpret is the one way a de-fanged cell
   * gets a second chance.
   *
   * The form is read first because the header needs its questions — so this route
   * *does* 404 a stale link, without spending a query to do it.
   */
  app.get('/forms/:id/responses.csv', requireAccess<Env>(rt, ADMIN), async (c) => {
    const db = c.var.bindings().db
    const form = await formById(db, formIdParam(c.req.param('id')))
    if (!form) throw new FolioError('not_found', 'Unknown form')

    const { filename, body } = await responseCsv(
      db,
      form,
      responseFilterQuery({ query: (key) => c.req.query(key) }),
    )
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        // `filename` is `safeFilename`'s output — lowercase ASCII, no quote, no
        // newline, no path separator — so the header cannot be split by it.
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': NO_STORE,
        'x-content-type-options': 'nosniff',
      },
    })
  })

  /**
   * One response, every key it holds.
   *
   * The drawer marks the keys the form no longer declares, and it does that from
   * the *form* rather than from a flag on the row — which is why this answers the
   * response and nothing else. `responseById` binds `form_id` as well as the id,
   * so a response cannot be read through another form's URL.
   */
  app.get('/forms/:id/responses/:rid', requireAccess<Env>(rt, FORMS), async (c) => {
    const response = await responseById(
      c.var.bindings().db,
      formIdParam(c.req.param('id')),
      responseIdParam(c.req.param('rid')),
    )
    if (!response) throw new FolioError('not_found', 'Unknown response')
    return c.json(response)
  })

  /**
   * One response and its uploads. **`ADMIN`** (checkpoint 8).
   *
   * `media` is passed unconditionally rather than guarded: a host with no bucket
   * has a form with no file question, so there is nothing to remove, and
   * `deleteResponse` swallows the R2 half either way — the row is already gone by
   * the time it is reached (`deleteAsset`'s rule, and the inverse of
   * `deleteForm`'s, which is argued where each of them lives).
   */
  app.delete('/forms/:id/responses/:rid', requireAccess<Env>(rt, ADMIN), async (c) => {
    const { db, media } = c.var.bindings()
    const result = await deleteResponse(
      db,
      formIdParam(c.req.param('id')),
      responseIdParam(c.req.param('rid')),
      media,
    )
    if (!result.deleted) throw new FolioError('not_found', 'Unknown response')
    return c.json(result)
  })

  /**
   * A bulk delete over a selection — the ids somebody ticked, or a captured
   * filter plus the count they were shown (`core/bulk.ts`).
   *
   * The 409 body is `routes/assets.ts`' `answer` verbatim: the error envelope a
   * generic fetch wrapper already reads, plus the machine-readable counts beside
   * it, so a refusal is **a door rather than a wall** — "somebody submitted three
   * more while you were reading the number" is re-confirmed in one click instead
   * of investigated.
   */
  app.post('/forms/:id/responses/delete', requireAccess<Env>(rt, ADMIN), async (c) => {
    const { db, media } = c.var.bindings()
    const id = formIdParam(c.req.param('id'))
    const body = await parseBody(c.req, ResponseBulkBody)
    requireCursor(body.continueFrom ?? undefined)

    const outcome = await deleteResponses({ db, media }, id, body.selection, {
      ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
      ...(body.continueFrom === undefined ? {} : { continueFrom: body.continueFrom }),
      ...(body.batch === undefined ? {} : { batch: body.batch }),
    })
    if (!wasRefused(outcome)) return c.json(outcome)
    return c.json(
      {
        error: {
          code: 'conflict',
          message: `${outcome.expected} responses matched when you chose them and ${outcome.actual} match now. Check the number and try again.`,
        },
        refused: outcome.refused,
        expected: outcome.expected,
        actual: outcome.actual,
      },
      409,
    )
  })

  /**
   * One response's uploaded file, streamed from R2
   * (`../../../docs/specs/content-model/forms.md` decision 15).
   *
   * **`FORMS`, which is `publisher` plus `forms:read`.** These are a stranger's
   * bytes about themselves — a CV, an invoice, a photograph — and reading them
   * is a different permission from reading the site's own content, which is why
   * the scope is implied by `admin` and by nothing else.
   *
   * Three things separate this from `{base}/asset/:key`, and each is the reason
   * a form's uploads are not assets:
   *
   *  - **The public route physically cannot serve one.** Keys are minted `sub_…`
   *    and `ASSET_KEY` is anchored to `^ast_…`, so that route answers 400 from
   *    the parameter validator before a handler runs. No new guard, so no new
   *    guard to forget.
   *  - **The type is always `application/octet-stream` and the disposition is
   *    always `attachment`, however the bytes sniffed.** `serveAsset` renders an
   *    allowlisted type inline because a Folio asset is the site's own image in
   *    the site's own markup; there is no case at all for rendering a stranger's
   *    upload in a tab on this origin, so the branch does not exist rather than
   *    being narrow.
   *  - **`no-store`.** Nothing about this belongs in a shared cache, and
   *    `cacheVerdictFor` bypasses it anyway for carrying a session cookie — this
   *    is the half that also covers a browser and a corporate proxy.
   *
   * The URL names the **question**, not the key: one file per question, and a
   * route whose parameter is a bucket path is a route that reads whatever that
   * path names. `responseFileOf` binds the form id as well, so a response id
   * cannot be walked in through a different form's URL.
   */
  app.get('/forms/:id/responses/:rid/file/:name', requireAccess<Env>(rt, FORMS), async (c) => {
    const { db, media } = c.var.bindings()
    if (!media) throw noMedia()

    const file = await responseFileOf(
      db,
      formIdParam(c.req.param('id')),
      responseIdParam(c.req.param('rid')),
      fieldNameParam(c.req.param('name')),
    )
    if (!file) throw new FolioError('not_found', 'No such file')

    const object = await media.get(file.key)
    if (!object) throw new FolioError('not_found', 'No such file')

    return new Response(object.body, {
      headers: {
        'content-type': DOWNLOAD_CONTENT_TYPE,
        // `filename` is `safeFilename`'s output, so it holds no quote, no
        // newline and no path separator — the header cannot be split by it.
        'content-disposition': `attachment; filename="${file.filename}"`,
        'cache-control': NO_STORE,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  })

  return app
}

/* ------------------------------------------------------ the public route --- */

/**
 * What the redirect's `folio_status` says happened, and what a JSON caller reads
 * back as `status` (`../../../docs/specs/content-model/forms.md` decision 6).
 *
 * Six tokens rather than "it worked" and "it did not", because a host has
 * something different and true to say about each: a closed form is not a
 * validation error, a rate limit is not a captcha failure, and telling a genuine
 * visitor behind a shared NAT that their message was "invalid" is the one wrong
 * answer available.
 */
type SubmitStatus = 'ok' | 'invalid' | 'closed' | 'rate' | 'verify' | 'error'

interface Reply {
  json: boolean
  status: SubmitStatus
  /** Where a native POST lands. Already same-origin, or the form's own
   *  `redirectTo`. */
  target: string
  /** The request's URL, for resolving `target` when it is a path. */
  from: string
  /** Present once the form is known: the slug rides back as `folio_form` so a
   *  page carrying two forms can tell which one answered. */
  form?: Form
  /** Success only. Minted even for a submission that was not stored, so a bot
   *  cannot tell the honeypot and a duplicate apart from a real one. */
  responseId?: string
  /** `invalid` only: the field names, and never their values. */
  invalid?: readonly string[]
  fields?: Record<string, AnswerRefusal>
  code?: string
  message?: string
  httpStatus?: number
}

/**
 * The 303's `Location`.
 *
 * **Three parameters, and none of them names anything personal** (decision 6). A
 * URL is a cache key, a `Referer`, a history entry and a log line at once, so a
 * thank-you page carrying somebody's email address is all four. What that buys is
 * the good half: because the parameters name nothing personal,
 * `?folio_status=ok` is an ordinary cacheable page, and the next person to submit
 * is served it as a hit.
 */
function locationFor(reply: Reply): string {
  const url = new URL(reply.target, reply.from)
  url.searchParams.set('folio_status', reply.status)
  if (reply.form) url.searchParams.set('folio_form', reply.form.name)
  if (reply.invalid?.length) url.searchParams.set('folio_invalid', reply.invalid.join(','))
  return url.toString()
}

/**
 * One answer, in whichever of the two transports this caller asked for
 * (decision 5).
 *
 * Built as a plain `Response` rather than through `c.json` / `c.redirect` so the
 * negotiation is a pure function of its input — the half of this route that has
 * six outcomes and two shapes each is the half worth being able to reason about
 * without a `Context`.
 *
 * **303 rather than 302**, so the follow-up is a GET whatever the browser would
 * otherwise have done and a refresh on the thank-you page does not re-post.
 */
function replyTo(reply: Reply): Response {
  if (!reply.json) {
    return new Response(null, { status: 303, headers: { location: locationFor(reply) } })
  }

  const body =
    reply.status === 'ok'
      ? { ok: true, status: reply.status, id: reply.responseId }
      : {
          error: { code: reply.code ?? reply.status, message: reply.message ?? 'Refused' },
          status: reply.status,
          ...(reply.fields ? { fields: reply.fields } : {}),
        }

  return new Response(JSON.stringify(body), {
    status: reply.httpStatus ?? (reply.status === 'ok' ? 200 : 400),
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  })
}

/**
 * The page a submission came from, when the markup did not say.
 *
 * `Referer` is the fallback rather than the source of truth — it is stripped by
 * privacy tooling and forged by anything that wants to, so `_folio_page` is what
 * gets *stored* (decision 11) and this only decides where a browser lands. A
 * cross-origin referrer is refused outright: an open redirect out of a form
 * endpoint would be the most-scanned URL on the site.
 */
function refererPath(req: Request): string {
  const raw = req.headers.get('referer')
  if (!raw) return '/'
  try {
    const url = new URL(raw)
    if (url.origin !== new URL(req.url).origin) return '/'
    return safeNext(`${url.pathname}${url.search}`, '/')
  } catch {
    return '/'
  }
}

/**
 * `{base}/f/:id` — **the one route in Folio an anonymous stranger may POST to.**
 *
 * On the bare mount beside `assetFileRoutes`, never under `{base}/api`, because a
 * browser *navigates* to it: its URL is baked into published HTML that is cached
 * for a week, so the thing it names has to be the form's immutable id rather than
 * a slug somebody might rename (decision 3).
 *
 * The order of the checks is the design, and each one is ahead of the next
 * because it is cheaper or because being behind it would leak something:
 *
 *  1. **The id**, anchored to `frm_<12 hex>` by `formIdParam`. A public route
 *     whose parameter is screened by charset rather than by mint format is a
 *     primitive somebody finds a use for.
 *  2. **The form**, and its absence is `error` rather than a 404 page: a page
 *     cached before the form was deleted is still out there posting to it.
 *  3. **The body**, under `capFor(form)` — a cap derived from the questions the
 *     editor built, not from `MAX_UPLOAD_BYTES`.
 *  4. **Closed**, from `isOpen`: the switch *and* the clock. The markup on a
 *     cached page is stale by design and the route is the enforcement
 *     (decision 14).
 *  5. **The honeypot**, before `verify` so a bot costs no host call, and answered
 *     as success so it cannot tell it was caught.
 *  6. **`verify`**, which receives the raw body because the token's name belongs
 *     to the host's widget (decision 13), and which fails closed on a throw.
 *  7. **The rate limit**, after `verify` so a verified submission is never
 *     refused for an unverified one's traffic.
 *  8. **The uploads**, bounded per question, typed from their own bytes and
 *     hashed — with nothing written to R2. Behind every abuse control above,
 *     because buffering an attachment for a bot is the cost the honeypot exists
 *     to avoid, and ahead of validation because a `file` question's `required`
 *     is the question "did an acceptable file arrive".
 *  9. **Validation**, then the duplicate check, then the put, then the insert,
 *     then the hook. The put is between the last two reads and the write for
 *     `uploadAsset`'s reason: a row naming an object that never landed is worse
 *     than an object with no row, and the second is closed by a compensating
 *     delete on either failure.
 *
 * Nothing about the answer distinguishes a stored row from a collapsed duplicate
 * or from a caught honeypot: all three answer `ok` with a minted id. That is
 * decision 9's point about the honeypot and decision 14's about the duplicate,
 * and it is one property rather than two.
 */
export function formSubmitRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  app.post('/f/:id', async (c) => {
    const req = c.req.raw
    const json = wantsJson(req)
    const from = c.req.url
    const now = Date.now()

    const id = formIdParam(c.req.param('id'))
    const { db, media } = c.var.bindings()
    const form = await formById(db, id)
    if (!form) {
      return replyTo({
        json,
        status: 'error',
        target: refererPath(req),
        from,
        code: 'not_found',
        message: 'Unknown form',
        httpStatus: 404,
      })
    }

    // Before the body is read, not after: a form that has nowhere to put a CV
    // must not spend a Worker's memory buffering one first. Unreachable through
    // the builder, which refuses the question — this is the route's own half of
    // the same refusal, for a host that lost the binding after the form existed.
    if (!media && hasFileQuestion(form.fields)) {
      return replyTo({
        json,
        status: 'error',
        target: refererPath(req),
        from,
        form,
        code: 'unsupported',
        message: noMedia().message,
        httpStatus: 501,
      })
    }

    const { body, files: parts } = await readSubmission(req, capFor(form))

    // The host's own hidden input, through `safeNext` — which already exists to
    // stop a redirect parameter becoming an open redirect, and which bounds this
    // at 500 characters as a side effect. `''` is a legitimate answer: a form can
    // be posted from a client that sets neither this nor a `Referer`.
    const page = safeNext(body.get(PAGE_INPUT)?.[0], '')
    const target = page || refererPath(req)
    const reply: Reply = { json, status: 'ok', target, from, form }

    if (!isOpen(form, now)) {
      return replyTo({
        ...reply,
        status: 'closed',
        code: 'closed',
        message: form.closedMessage || 'This form is closed.',
        httpStatus: 409,
      })
    }

    // Named from the form id out of a fixed pool, exactly as the descriptor named
    // it, so a page cached for a week and the live route always agree on which
    // input is the decoy.
    const decoy = honeypotName(
      form.id,
      form.fields.map((f) => f.name),
    )
    if ((body.get(decoy)?.[0] ?? '').trim() !== '') {
      // Success-shaped, storing nothing and firing nothing. A refusal here tells
      // whoever is writing the bot which field to leave alone next time.
      return replyTo({ ...reply, responseId: newResponseId(), ...successTarget(form, target) })
    }

    if (!(await verified(rt, c.env, req, form, body))) {
      return replyTo({
        ...reply,
        status: 'verify',
        code: 'verify',
        message: 'We could not verify that submission.',
        httpStatus: 403,
      })
    }

    const rate = rt.forms?.ratePerHour ?? DEFAULT_RATE_PER_HOUR
    const ip = clientIp(req)
    let hash: string | null = null
    if (ip && rate > 0) {
      const hashes = await throttleHashes(ip, form.id, now)
      hash = hashes[0]
      if ((await recentSubmissionCount(db, hashes, now)) >= rate) {
        return replyTo({
          ...reply,
          status: 'rate',
          code: 'rate',
          message: 'Too many submissions from this address. Try again later.',
          httpStatus: 429,
        })
      }
    } else if (ip) {
      hash = await ipHash(ip, form.id, now)
    }

    // The uploads: bounded per question, sniffed, hashed and keyed — and
    // **nothing written to R2 yet**. Ahead of the text validator because its
    // `required` check for a `file` question is the answer to "did a file
    // arrive", and behind every abuse control because buffering an attachment
    // for a bot is the one cost the honeypot exists to avoid.
    const uploads = await prepareUploads(form.fields, parts)
    const { values, errors } = validateSubmission(
      form.fields,
      body,
      new Set(uploads.files.map((file) => file.field)),
    )
    // The file's own refusal wins: a required question whose CV was too large
    // should say `too_long`, not `required`.
    const refusals = { ...errors, ...uploads.errors }
    const invalid = Object.keys(refusals)
    if (invalid.length > 0) {
      return replyTo({
        ...reply,
        status: 'invalid',
        invalid,
        fields: refusals,
        code: 'invalid',
        message: 'Some answers need another look.',
        httpStatus: 422,
      })
    }

    // Over the answers **and** each file's bytes, which is what lets the
    // duplicate check below run before the put (decision 14).
    const hashed = await bodyHash(values, filePartsOf(uploads.files))

    // A double-click on a 5MB application: knowably a duplicate, so nothing is
    // written. The single-statement collapse inside `insertResponse` is still the
    // arbiter — this only saves the megabytes, and only when there are megabytes.
    if (uploads.files.length > 0 && (await isDuplicateSubmission(db, form.id, hashed, now))) {
      return replyTo({ ...reply, responseId: newResponseId(), ...successTarget(form, target) })
    }

    // R2 first, then the row: a row naming an object that never landed is a
    // download button that 404s for a publisher with no way to explain it, while
    // an object with no row is closed by the compensating delete below.
    // `uploadAsset`'s order, and its reasoning.
    if (media && uploads.files.length > 0) await putUploads(media, uploads.files)

    let inserted: Awaited<ReturnType<typeof insertResponse>>
    try {
      inserted = await insertResponse(db, {
        form,
        data: values,
        // Whatever the descriptor's hidden input said, run back through the
        // runtime's own locale resolution: an undeclared code — or one a submitter
        // invented — is stored as `''`, the source-locale convention `content_index`
        // already uses.
        locale: rt.localeOf(body.get(LOCALE_INPUT)?.[0])?.code ?? '',
        page,
        ipHash: hash,
        bodyHash: hashed,
        files: storedFilesOf(uploads.files),
        now,
      })
    } catch (err) {
      await compensate(media, uploads.files)
      throw err
    }

    // The narrow race the pre-check cannot close: two clicks that both got past
    // it, one of which lost the `not exists`. Its objects have no row and never
    // will, so they go now (decision 15: *"a compensating `bucket.delete` if the
    // insert throws **or the duplicate guard fires**"*).
    if (!inserted.stored) await compensate(media, uploads.files)

    if (inserted.stored) {
      await rt.hookRunner(hookCtx(c)).run('submitted', {
        form: formMeta(form),
        response: inserted.response,
        files: storedFilesOf(uploads.files),
        // The route is unauthenticated and the row is a stranger's. Attributing it
        // to whichever editor happened to be signed in in this browser would be a
        // lie about who filled the form in.
        actor: null,
      })
    }

    return replyTo({
      ...reply,
      responseId: inserted.response.id,
      ...successTarget(form, target),
    })
  })

  return app
}

/**
 * The objects, when the row they were supposed to belong to did not happen.
 *
 * **Swallowed, exactly as `uploadAsset`'s own compensating delete is.** The
 * failure worth reporting is the one being compensated for — a D1 insert that
 * threw is what the caller needs to see and debug — and a cleanup that also
 * failed is a secondary, orphaned object rather than the reportable error. This
 * is the opposite call from `deleteForm`, and the difference is what a retry can
 * reach: there the rows survive and name the keys, so throwing leaves something
 * repeatable; here nothing will ever name these keys again either way.
 */
async function compensate(
  bucket: R2Bucket | undefined,
  files: readonly PreparedUpload[],
): Promise<void> {
  if (!bucket || files.length === 0) return
  try {
    await deleteUploads(
      bucket,
      files.map((file) => file.key),
    )
  } catch (err) {
    console.error('folio: form upload cleanup failed', err)
  }
}

/** Where a *successful* submission lands: the form's own `redirectTo` when it
 *  sets one, otherwise back where it came from. A refusal never uses it — sending
 *  somebody to a thank-you page for a message that was not accepted is worse than
 *  saying nothing. */
function successTarget(form: Form, target: string): { target: string } {
  return { target: form.redirectTo || target }
}

/**
 * The host's `verify`, and the whole of decision 11: **false refuses, and a throw
 * refuses too.**
 *
 * `=== true` rather than truthiness, so a `verify` that forgot to return refuses
 * rather than passing everything. One logged line for a throw, the shape `runOne`
 * logs a failed hook with — and then a refusal, because failing open converts a
 * vendor outage from "the form is briefly unavailable" into "the form is briefly
 * unprotected", and the second is the state somebody is waiting for.
 */
async function verified<Env>(
  rt: FolioRuntime,
  env: Env,
  req: Request,
  form: Form,
  body: SubmissionBody,
): Promise<boolean> {
  const verify = rt.forms?.config.verify
  if (!verify) return true
  try {
    return (await verify({ req, body: rawBodyOf(body), form: formMeta(form) }, env)) === true
  } catch (err) {
    console.error('folio: form verify failed', err)
    return false
  }
}
