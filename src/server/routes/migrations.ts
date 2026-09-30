/**
 * Content migrations over HTTP (`../../../docs/specs/foundation/schema-migrations.md`).
 *
 * Three routes, and the split between them is the spec's decision 7: reading
 * what is pending is cheap and near-universal, *running* a migration is
 * destructive-ish and `admin`, and the drift audit is a separate read-only
 * report rather than a side effect of the run — an audit that happens as part of
 * a write is an audit nobody reads.
 */
import { Hono } from 'hono'
import { actorString, ADMIN, READ_DRAFT } from '../auth/roles'
import { audit, DEFAULT_AUDIT_BATCH, MAX_AUDIT_BATCH } from '../audit'
import { migrationStatus, runMigrations } from '../migrate'
import { brandIdOf, hookCtx, requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { idParam, limitParam, MigrateBody, parseOptionalBody } from '../validate'
import { brandOf, draftOf, sweepOf } from './stories'

export function migrationRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * What is configured, what has run, how many documents are behind — and, with
   * `?story=`, whether *that* document is behind and what it is missing. The
   * editor's banner reads the last part.
   *
   * `READ_DRAFT` rather than the spec's route table's `editor+`, deliberately.
   * This is the access the editor page itself requires
   * (`requireHtmlAccess(rt, READ_DRAFT)`), and a route the editor page always
   * fetches must not require more than the page: a `viewer` who can open the
   * editor would otherwise get a silent 403 where the explanation should be.
   * What it discloses is migration ids and descriptions — code metadata, on a
   * deployment whose `/schema` manifest is ungated entirely.
   */
  app.get('/migrations', requireAccess<Env>(rt, READ_DRAFT), async (c) => {
    const raw = c.req.query('story')
    return c.json(
      await migrationStatus(
        c.var.bindings().db,
        brandOf(c).migrations,
        raw === undefined ? undefined : idParam('story', raw),
        (await sweepOf(c, rt))?.scopes,
      ),
    )
  })

  /**
   * Runs the pending migrations over one batch of documents and answers a report
   * with a `continueFrom` cursor; the client re-calls until it is null (the
   * spec's resolved open question — batched, not streamed).
   *
   * `admin`, because it writes to every document on the site. Nothing here is
   * automatic: a migration that ran itself on the first request after a deploy
   * would run inside a request whose CPU limit it can exceed, on a cold Worker,
   * with nobody watching (checkpoint 5).
   */
  app.post('/migrate', requireAccess<Env>(rt, ADMIN), async (c) => {
    const body = await parseOptionalBody(c.req, MigrateBody)
    const bindings = c.var.bindings()
    const brand = brandOf(c)
    const sweep = await sweepOf(c, rt)
    const report = await runMigrations(
      {
        db: bindings.db,
        schema: brand.schema,
        migrations: brand.migrations,
        typeOf: brand.typeOf,
        draft: draftOf(c, rt),
        stub: (id) => rt.stub(bindings, id),
        // As in `folio.migrate`: re-project, or the index describes the
        // document as it was before the migration rewrote it.
        projection: brand.projection,
        hooks: rt.hookRunner(hookCtx(c), brandIdOf(c)),
        // This brand's list over this brand's scopes only.
        ...(sweep ? { brand: { id: sweep.id, scopes: sweep.scopes } } : {}),
      },
      {
        dryRun: body.dryRun,
        continueFrom: body.continueFrom,
        batch: body.batch,
        // Off the session, never the body: "who migrated this" is not a field
        // anybody should be able to type into.
        actor: actorString(c.var.actor),
      },
    )
    // On a deployment with `brands` the report names the brand it migrated, and
    // every count in it — `complete` included — is that brand's (`MigrateReport.brand`).
    return c.json(sweep ? { ...report, brand: sweep.id } : report)
  })

  /**
   * The drift report. Read-only; no document is modified.
   *
   * `locales` and `types` are passed for the same reason `folio.audit(env)` passes
   * them: the locale checks (`../../../docs/specs/content-model/localisation.md`) and the `indexed`
   * checks (`../../../docs/specs/content-model/collections.md`) are config-dependent, and a route
   * that answered differently from the method would be a report nobody could
   * trust.
   *
   * **Batched, like `/migrate` above** (`../../../../docs/specs/foundation/
   * pagination.md`'s route table): `?continueFrom=&batch=` reads one window of
   * published documents and answers a cursor, and the client merges the reports.
   * It read the whole table until the admin's Model screen was built on it, which
   * is the one place a read-only report can still take a Worker down.
   *
   * `continueFrom` is an `idParam` and a bad one is a 400 — it names a story, so
   * unlike an opaque keyset cursor it can be checked without decoding. `batch`
   * clamps rather than refusing, per `limitParam`: an out-of-range limit is a
   * stale bookmark with an obvious right answer.
   */
  app.get('/audit', requireAccess<Env>(rt, ADMIN), async (c) => {
    const raw = c.req.query('continueFrom')
    const brand = brandOf(c)
    const sweep = await sweepOf(c, rt)
    return c.json(
      await audit(
        c.var.bindings().db,
        brand.schema,
        await brand.auditContext(c.env),
        {
          continueFrom: raw === undefined ? null : idParam('continueFrom', raw),
          batch: limitParam(c.req.query('batch'), DEFAULT_AUDIT_BATCH, MAX_AUDIT_BATCH),
        },
        sweep,
      ),
    )
  })

  return app
}
