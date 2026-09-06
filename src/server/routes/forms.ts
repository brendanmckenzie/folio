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
import { honeypotName } from '../../core/forms'
import { actorString, ADMIN, EDIT, READ } from '../auth/roles'
import { FolioError } from '../errors'
import {
  type AnswerRefusal,
  bodyHash,
  capFor,
  clientIp,
  DEFAULT_RATE_PER_HOUR,
  insertResponse,
  ipHash,
  newResponseId,
  rawBodyOf,
  readSubmission,
  recentSubmissionCount,
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
  formUsage,
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
  FormCreateBody,
  FormPatchBody,
  formIdParam,
  limitParam,
  parseBody,
  requireCursor,
  safeNext,
  wantsJson,
} from '../validate'

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
    const result = await updateForm(c.var.bindings().db, id, body)
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
    const result = await deleteForm(c.var.bindings().db, id)
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
 *  8. **Validation**, then the insert, then the hook.
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
    const db = c.var.bindings().db
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

    const body = await readSubmission(req, capFor(form))

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

    const { values, errors } = validateSubmission(form.fields, body)
    const invalid = Object.keys(errors)
    if (invalid.length > 0) {
      return replyTo({
        ...reply,
        status: 'invalid',
        invalid,
        fields: errors,
        code: 'invalid',
        message: 'Some answers need another look.',
        httpStatus: 422,
      })
    }

    const inserted = await insertResponse(db, {
      form,
      data: values,
      // Whatever the descriptor's hidden input said, run back through the
      // runtime's own locale resolution: an undeclared code — or one a submitter
      // invented — is stored as `''`, the source-locale convention `content_index`
      // already uses.
      locale: rt.localeOf(body.get(LOCALE_INPUT)?.[0])?.code ?? '',
      page,
      ipHash: hash,
      bodyHash: await bodyHash(values),
      files: [],
      now,
    })

    if (inserted.stored) {
      await rt.hookRunner(hookCtx(c)).run('submitted', {
        form: formMeta(form),
        response: inserted.response,
        files: [],
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
