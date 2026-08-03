/**
 * `/folio/api/v1/documents` — the documented, token-scoped door into content
 * (`../../../../../docs/specs/platform/content-api.md`).
 *
 * **Why this is a second surface rather than the existing routes declared public**
 * (architecture decision 2): the admin ships inside this library, so its routes
 * are internal and free to change with it. An API is a contract with somebody's
 * script. Declaring `/folio/stories` public would freeze it and make every admin
 * refactor a breaking change for people who never asked to depend on it. So: two
 * surfaces, one set of services — every handler here calls the same
 * `createStory`, `publish`, `deleteStoryStatement`, `listVersions` the admin's
 * routes do, and adds only the translation to and from the nested shape.
 *
 * Everything a consumer sees is stable on purpose: the nested document shape
 * (`core/nested.ts`), the `ContentPage` a query answers, and the one error
 * envelope `errors.ts` produces. Nothing here invents a shape of its own.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { deepEqual } from '../../../core/diff'
import type { Doc, Json } from '../../../core/doc'
import { isKnownLocale } from '../../../core/locales'
import type { Mutation } from '../../../core/mutations'
import { fieldShapeError, fromNested, type NestedDoc, toNested } from '../../../core/nested'
import { type DocumentType, SINGLETON_PREFIX, typeByName } from '../../../core/schema'
import type { StoryMeta, StoryState } from '../../../core/story'
import {
  actorName,
  actorString,
  CREATE,
  EDIT,
  MANAGE,
  PUBLISH,
  READ,
  READ_DRAFT,
} from '../../auth/roles'
import { deleteDocument, type DocumentDeps, duplicateDocument, moveDocument } from '../../documents'
import { FolioError, rethrow } from '../../errors'
import { ensureAccess, hookCtx, requireAccess } from '../../middleware'
import { checkpoint, publish, unpublish } from '../../publish'
import type { FolioRuntime } from '../../runtime'
import {
  createStory,
  ensureSingleton,
  publishedDocsByIds,
  storyByPath,
  storyById,
} from '../../stories'
import type { FolioBindings, FolioEnv } from '../../types'
import {
  CheckpointBody,
  ContentPutBody,
  DocumentCreateBody,
  FieldsPatchBody,
  idempotencyKeyHeader,
  idParam,
  limitParam,
  localeQuery,
  parseBody,
  parseOptionalBody,
  RestoreBody,
  StoryDuplicateBody,
  StoryPatchBody,
  storyPathParam,
} from '../../validate'
import { getVersion, listVersions } from '../../versions'
import { commitAll, writeDocument, type WriteActor } from '../../write'
import { queryFromParams } from '../content'

/** A document's row, as the API reports it. Every field is stable surface. */
export interface ApiDocumentMeta {
  id: string
  /** Document type name, not the root block's name. */
  type: string
  title: string
  /** `null` for an unrouted document — a record or a singleton has no URL. */
  path: string | null
  url: string | null
  /** The editing render: `folio-editing`, uid markers, the postMessage bridge. */
  previewUrl: string | null
  /** The same document rendered as the site would serve it (`mcp-server.md` decision 5). */
  draftUrl: string | null
  /** Lifecycle: never published, live, taken down, or live with newer draft. */
  state: StoryState
  publishedAt: number | null
  updatedAt: number
}

export interface ApiDocument extends ApiDocumentMeta {
  /** Which snapshot `content` is: the published one, or the live draft. */
  source: 'published' | 'draft'
  /**
   * Present only on a locale-resolved read, where `content.fields` hold that
   * locale's values and `i18n` is gone. Its presence is the flag that says this
   * payload is for reading and must not be written back.
   */
  locale?: string
  content: NestedDoc
}

/** The token's own name, or the person's id. Never anything a client sent. */
function writeActor<Env>(c: Context<FolioEnv<Env>>): WriteActor {
  return {
    id: actorString(c.var.actor) ?? 'api',
    name: actorName(c.var.actor) ?? 'API',
  }
}

export function documentRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  const requireType = (name: string | undefined): DocumentType => {
    if (name === undefined) return rt.defaultType
    const type = rt.typeOf(name)
    if (!type) throw new FolioError('unsupported', `Unknown document type: ${name}`)
    return type
  }

  /**
   * The row behind an id, or 404.
   *
   * **A `sng_*` id is addressable here, exactly like an ordinary story id**, which
   * is this spec's answer to the question `globals.md` left it: a global is an
   * ordinary document with a derived id, and an API that could not read or write
   * site settings would be missing the case a deploy script most wants. Asking is
   * what creates a singleton (`document-types.md` decision 7) — an editor never
   * does — so a first read of one that nothing has opened yet ensures the row, the
   * same as `GET /folio/documents` already does at the same access level. Bounded
   * and predictable: only an id whose `sng_` prefix names a *declared* singleton
   * type can cause that write.
   */
  const load = async (bindings: FolioBindings, id: string): Promise<StoryMeta> => {
    if (id.startsWith(SINGLETON_PREFIX)) {
      const type = typeByName(rt.types, id.slice(SINGLETON_PREFIX.length))
      if (type?.kind === 'singleton') return ensureSingleton(bindings.db, type, rt.schemaId)
    }
    const story = await storyById(bindings.db, id)
    if (!story) throw new FolioError('not_found', 'Unknown document')
    return story
  }

  const meta = (story: StoryMeta): ApiDocumentMeta => {
    const decorated = rt.withUrls(story)
    return {
      id: story.id,
      type: story.type,
      title: story.title,
      path: story.path,
      url: decorated.url ?? null,
      previewUrl: decorated.previewUrl ?? null,
      draftUrl: decorated.draftUrl ?? null,
      state: story.state,
      publishedAt: story.publishedAt,
      updatedAt: story.updatedAt,
    }
  }

  /**
   * One document, in the nested shape.
   *
   * `?locale=` reads every field through `fieldValue`'s fallback chain and drops
   * `i18n`, which is what a French mobile app wants. Without it the payload is the
   * authoring shape — source values plus translations alongside — and that is the
   * one that round-trips through `PUT`.
   */
  const payload = (
    story: StoryMeta,
    doc: Doc,
    source: 'published' | 'draft',
    locale: string | undefined,
  ): ApiDocument => ({
    ...meta(story),
    source,
    ...(locale !== undefined ? { locale } : {}),
    content: toNested(doc, rt.schema, { locale: rt.localeOf(locale) }),
  })

  /** `?locale=`, screened and checked against the declared set. */
  const askedLocale = (c: Context<FolioEnv<Env>>): string | undefined => {
    const raw = c.req.query('locale')
    if (raw === undefined) return undefined
    const code = localeQuery(raw)
    if (!isKnownLocale(rt.locales, code)) {
      throw new FolioError('unsupported', `Unknown locale: ${code}`)
    }
    return code
  }

  const deps = (bindings: FolioBindings, story: StoryMeta) => ({
    draft: () => rt.draftFor(bindings, story),
    stub: rt.stub(bindings, story.id),
  })

  /**
   * What `documents.ts`' three workflows need, off this request — the same object
   * `routes/stories.ts` builds.
   *
   * This is where the API's own copy of the delete batch and the two patch hooks
   * went. It used to hold both inline, under a comment saying "reimplementing either
   * would mean two orderings to keep right" above a reimplementation of both; a
   * third caller (`routes/bulk.ts`) is what made keeping them honest impossible by
   * hand. What each route still owns is its answer to *absence*: this one 404s where
   * the admin's answers `{ deleted: [] }`.
   */
  const documentDeps = (c: Context<FolioEnv<Env>>): DocumentDeps<unknown> => {
    const bindings = c.var.bindings()
    return {
      db: bindings.db,
      types: rt.types,
      stub: (id: string) => rt.stub(bindings, id),
      draft: (story: StoryMeta) => rt.draftFor(bindings, story),
      hooks: rt.hookRunner(hookCtx(c)),
    }
  }

  /* ------------------------------------------------------------- reading --- */

  /**
   * `ContentQuery` over published content, spelled as query parameters — the same
   * parser `GET /folio/content` uses, so the two cannot answer differently.
   *
   * **`?status=draft` is refused rather than ignored** (decision 4). A draft lives
   * in a Durable Object, so a query over drafts means opening one object per
   * candidate row; the honest answer is "that is not a query this API runs", and
   * `GET /documents/:id?status=draft` is the per-document read that is. Ignoring
   * the parameter would silently hand back published content for a request that
   * asked for drafts, which is the worst of the three options.
   */
  app.get('/documents', requireAccess<Env>(rt, READ), async (c) => {
    const url = new URL(c.req.url)
    const status = url.searchParams.get('status')
    if (status !== null && status !== 'published') {
      throw new FolioError(
        'unsupported',
        'This route queries published content only. A draft lives in its own Durable Object, so it is read one document at a time: GET /documents/:id?status=draft.',
      )
    }
    return c.json(await rt.query(c.var.bindings(), queryFromParams(url.searchParams)))
  })

  /**
   * One document. `?status=draft` needs `content:read:draft`, checked here rather
   * than at the mount because which access this route needs is decided by what the
   * request asked for.
   */
  app.get('/documents/:id', requireAccess<Env>(rt, READ), async (c) => {
    const bindings = c.var.bindings()
    const story = await load(bindings, idParam('id', c.req.param('id')))
    const locale = askedLocale(c)
    const wantDraft = c.req.query('status') === 'draft'

    if (wantDraft) {
      ensureAccess(rt, c.var.actor, READ_DRAFT)
      return c.json(payload(story, await rt.draftFor(bindings, story), 'draft', locale))
    }
    const published = await publishedFor(bindings, story)
    return c.json(payload(story, published, 'published', locale))
  })

  /**
   * The same document, addressed by its public path. `''` (a bare
   * `/documents/by-path/`) is the root story.
   *
   * An unrouted document is a 404 here by design (`document-types.md`): a record
   * has no path, so there is no URL that could name one. `storyByPath` matches on
   * `path = ?` and an unrouted row stores NULL, so this falls out of the SQL — the
   * check is spelled out below anyway, because it is a rule rather than an
   * accident of semantics.
   */
  const byPath = async (c: Context<FolioEnv<Env>>) => {
    const bindings = c.var.bindings()
    const path = storyPathParam(c.req.param('path'))
    const story = await storyByPath(bindings.db, path)
    if (!story || story.path === null) throw new FolioError('not_found', 'No document at that path')
    const locale = askedLocale(c)
    if (c.req.query('status') === 'draft') {
      ensureAccess(rt, c.var.actor, READ_DRAFT)
      return c.json(payload(story, await rt.draftFor(bindings, story), 'draft', locale))
    }
    return c.json(payload(story, await publishedFor(bindings, story), 'published', locale))
  }
  app.get('/documents/by-path', requireAccess<Env>(rt, READ), byPath)
  app.get('/documents/by-path/:path{.*}', requireAccess<Env>(rt, READ), byPath)

  const publishedFor = async (bindings: FolioBindings, story: StoryMeta): Promise<Doc> => {
    const docs = await publishedDocsByIds(bindings.db, [story.id])
    const doc = docs[story.id]
    if (!doc) {
      throw new FolioError(
        'not_found',
        'That document has nothing published. Add ?status=draft to read the draft.',
      )
    }
    return doc
  }

  app.get('/documents/:id/versions', requireAccess<Env>(rt, READ), async (c) =>
    c.json({
      // `.rows` rather than the envelope: this route's contract is a `versions`
      // array, and v1 does not change shape. Paging it with numbers is its own
      // change, and nobody has asked for a hundredth version of a document.
      versions: (
        await listVersions(c.var.bindings().db, idParam('id', c.req.param('id')), {
          limit: limitParam(c.req.query('perPage'), 50, 200),
        })
      ).rows,
    }),
  )

  /* ------------------------------------------------------------- writing --- */

  /**
   * Create a document: a D1 row and a Durable Object, in that order.
   *
   * **Not atomic across the two stores, and it cannot be** (decision 5): D1 and a
   * Durable Object share no transaction. So the order is chosen for its failure
   * mode. Row first leaves, at worst, a story whose document is blank — which is
   * indistinguishable from a page an editor created and never filled in, a state
   * the system already understands and can recover from. Document first would
   * leave an orphaned object nothing points at and nothing cleans up.
   *
   * The content is validated and turned into a document *before* the row is
   * written, and then seeded in one `getOrInit` — so a refused payload writes
   * nothing at all, and a created document's content arrives with it rather than
   * as a follow-up transaction there is nobody yet to broadcast to.
   */
  app.post('/documents', requireAccess<Env>(rt, CREATE), async (c) => {
    const body = await parseBody(c.req, DocumentCreateBody)
    const bindings = c.var.bindings()
    const type = requireType(body.type)
    if (type.kind === 'singleton') {
      throw new FolioError(
        'conflict',
        `'${type.name}' is a singleton and already exists; write to '${SINGLETON_PREFIX}${type.name}' instead of creating one`,
      )
    }

    // Before any write, so a payload the schema refuses costs nothing.
    let seeded = rt.seed(type, body.title)
    if (body.content !== undefined) {
      try {
        seeded = fromNested(body.content, rt.schema, seeded, { mode: 'merge' })
      } catch (e) {
        rethrow(e)
      }
    }

    let story: StoryMeta
    try {
      story = await createStory(bindings.db, { ...body, type, schemaId: rt.schemaId }, rt.types)
    } catch (e) {
      rethrow(e)
    }

    const actor = actorString(c.var.actor)
    await rt.publishDeps(bindings, hookCtx(c)).hooks?.run('created', { story, actor })

    try {
      await rt.stub(bindings, story.id).getOrInit(seeded)
    } catch {
      // The row is already committed, so success would be a lie and a 500 would
      // blame this server for a request that half-worked. Names the id, because
      // what the caller does next — retry the content, or delete the row —
      // depends on knowing it exists.
      throw new FolioError(
        'incomplete',
        `Document '${story.id}' was created, but its content could not be written. Retry with PUT /documents/${story.id}/content.`,
      )
    }

    return c.json(payload(story, seeded, 'draft', undefined), 201)
  })

  /**
   * Replace, or (by default) merge, a document's content.
   *
   * Read the draft, build the target, `diff`, commit. So an open editor receives
   * the delta and re-renders through the same per-keystroke machinery, the activity
   * trail says `token:<name>`, Cmd+Z undoes it, and an unchanged payload produces
   * zero mutations and writes nothing at all.
   *
   * `mode: 'merge'` is the default (the spec's resolved open question): absent
   * fields are left alone, which makes a partial payload safe and makes the whole
   * locale problem go away. `mode: 'replace'` is opt-in and is the only mode that
   * can discard content it was not told about — see `fromNested`.
   */
  app.put('/documents/:id/content', requireAccess<Env>(rt, EDIT), putContent)

  async function putContent(c: Context<FolioEnv<Env>>) {
    const body = await parseBody(c.req, ContentPutBody)
    const key = idempotencyKeyHeader(c.req.header('idempotency-key'))
    const bindings = c.var.bindings()
    const story = await load(bindings, idParam('id', c.req.param('id')))

    try {
      return c.json(
        await writeDocument(
          deps(bindings, story),
          (current) => fromNested(body.content, rt.schema, current, { mode: body.mode ?? 'merge' }),
          writeActor(c),
          key,
        ),
      )
    } catch (e) {
      rethrow(e)
    }
  }

  /**
   * Targeted field writes: one `set` per field and nothing else.
   *
   * Skips the diff entirely, which is what a bulk price update wants — it never
   * touches structure, so it cannot reorder or remove a block by accident. `fields`
   * names the root blok (where a document's own metadata lives), `bloks` names any
   * other by uid, and `locale` scopes the whole request to one language.
   *
   * A uid this document does not have is **dropped rather than 404'd**: it is a
   * no-op by the mutation vocabulary's own rule, and the response reporting
   * `changed: 0` is the honest answer. 404 would turn a legitimate
   * concurrent-delete race into an error. A field whose value already equals what
   * is stored is dropped for the same reason — a write that changes nothing should
   * log nothing, or every no-op sync would leave the story reporting unpublished
   * changes.
   */
  app.patch('/documents/:id/fields', requireAccess<Env>(rt, EDIT), async (c) => {
    const body = await parseBody(c.req, FieldsPatchBody)
    const key = idempotencyKeyHeader(c.req.header('idempotency-key'))
    const bindings = c.var.bindings()
    const story = await load(bindings, idParam('id', c.req.param('id')))

    const locale = body.locale
    if (locale !== undefined && !isKnownLocale(rt.locales, locale)) {
      throw new FolioError('unsupported', `Unknown locale: ${locale}`)
    }

    const draft = await rt.draftFor(bindings, story)
    const mutations: Mutation[] = []
    const setsFor = (uid: string, fields: Record<string, unknown>, where: string) => {
      const blok = draft.bloks[uid]
      if (!blok) return
      const def = rt.schema[blok.type]
      for (const [name, value] of Object.entries(fields)) {
        const field = def?.fields[name]
        if (!field) {
          throw new FolioError('bad_request', `${where}.${name} is not a field of '${blok.type}'`)
        }
        if (field.kind === 'blocks') {
          throw new FolioError(
            'bad_request',
            `${where}.${name} holds blocks, not a value — use PUT /content to change structure`,
          )
        }
        const shape = fieldShapeError(field, value)
        if (shape) throw new FolioError('bad_request', `${where}.${name} ${shape}`)

        const current = locale === undefined ? blok.data[name] : blok.i18n?.[locale]?.[name]
        if (deepEqual(current ?? null, (value ?? null) as Json)) continue
        mutations.push(
          locale === undefined
            ? { t: 'set', uid, field: name, value: value as Json }
            : { t: 'set', uid, field: name, value: value as Json, locale },
        )
      }
    }

    setsFor(draft.root, body.fields ?? {}, 'fields')
    for (const [i, entry] of (body.bloks ?? []).entries()) {
      setsFor(entry.uid, entry.fields, `bloks[${i}].fields`)
    }

    return c.json(await commitAll(deps(bindings, story).stub, mutations, writeActor(c), key))
  })

  /**
   * Row metadata: title, slug, parent, position. Deliberately not content — a
   * page's own title lives on its root block and is written through
   * `PATCH /fields`; this is the URL and the tree.
   *
   * `MANAGE` (publisher+), matching the admin's own gate and for the reason the
   * role table gives: all four of these change what URLs the site serves, which is
   * a publishing act even when nothing is published in the same breath.
   */
  app.patch('/documents/:id', requireAccess<Env>(rt, MANAGE), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseBody(c.req, StoryPatchBody)

    let next: StoryMeta
    try {
      // `moveDocument` fires both hooks the admin's own PATCH fires, which is what
      // keeps a host hook from being able to tell which door a write came through.
      next = (await moveDocument(documentDeps(c), id, body, actorString(c.var.actor))).next
    } catch (e) {
      rethrow(e)
    }

    return c.json(meta(next))
  })

  /**
   * Delete a document, its descendants, their versions and their index rows.
   *
   * The same four-statement batch and the same purge-after-commit ordering the
   * admin's delete uses, comments and all — see `routes/stories.ts`. Reimplementing
   * either would mean two orderings to keep right.
   */
  app.delete('/documents/:id', requireAccess<Env>(rt, MANAGE), async (c) => {
    const target = idParam('id', c.req.param('id'))
    const redirect = c.req.query('redirect') !== 'false'

    let found: Awaited<ReturnType<typeof deleteDocument>>
    try {
      found = await deleteDocument(documentDeps(c), target, { redirect }, actorString(c.var.actor))
    } catch (e) {
      rethrow(e)
    }
    // A 404 where the admin's route answers `{ deleted: [] }`, and the difference is
    // deliberate: this is a contract with a script, and a script deleting an id that
    // is not there has a bug worth surfacing.
    if (!found) throw new FolioError('not_found', 'Unknown document')

    return c.json({ deleted: found.deleted })
  })

  /** Publish the draft. `publish()` does the work; this only translates. */
  app.post('/documents/:id/publish', requireAccess<Env>(rt, PUBLISH), async (c) => {
    const bindings = c.var.bindings()
    const story = await load(bindings, idParam('id', c.req.param('id')))
    const result = await publish(
      rt.publishDeps(bindings, hookCtx(c)),
      story,
      actorString(c.var.actor),
    )
    return c.json(result)
  })

  /**
   * A named checkpoint of the draft.
   *
   * **`PUBLISH`, not `content:write`, and that is a deliberate narrowing of the
   * spec's route table.** A checkpoint publishes nothing, so `content:write` is
   * arguable — but the admin already gates the identical operation at `publisher`+
   * with the `publish` scope, and the same act being cheaper over the API than in
   * the editor is a hole rather than a feature. A token that needs to snapshot
   * before an import asks for `publish`, which it almost certainly wants anyway.
   */
  app.post('/documents/:id/versions', requireAccess<Env>(rt, PUBLISH), async (c) => {
    const bindings = c.var.bindings()
    const story = await load(bindings, idParam('id', c.req.param('id')))
    const body = await parseOptionalBody(c.req, CheckpointBody)
    return c.json(
      await checkpoint(rt.publishDeps(bindings, hookCtx(c)), story, {
        label: body.label,
        actor: actorString(c.var.actor),
      }),
      201,
    )
  })

  /**
   * Take the document down. `unpublish()` (`../../publish.ts`) is idempotent —
   * unpublishing an already-unpublished document answers the existing timestamp
   * and writes nothing — so this route needs no guard of its own, matching the
   * admin's own `/story/:id/unpublish` (`routes/stories.ts:503`).
   *
   * `unpublish()` reports only the timestamp, not the row, so the response
   * re-loads it: cheaper than re-deriving the state transition `unpublish()`
   * already computed and threw away.
   */
  app.post('/documents/:id/unpublish', requireAccess<Env>(rt, PUBLISH), async (c) => {
    const bindings = c.var.bindings()
    const id = idParam('id', c.req.param('id'))
    const story = await load(bindings, id)
    await unpublish(rt.publishDeps(bindings, hookCtx(c)), story, actorString(c.var.actor))
    return c.json({ story: meta(await load(bindings, id)) })
  })

  /**
   * Copy a document (mirrors `routes/stories.ts:439`'s `/stories/:id/duplicate`).
   *
   * No `index?` in the body, though the spec's own first draft of this route
   * table had one: `duplicateDocument` (`../../documents.ts`) has no positioning
   * argument, and neither does the admin's own `StoryDuplicateBody`. A caller
   * wanting a specific position already has `PATCH /documents/:id` for a second
   * call — two requests, which is also what dragging a duplicated row is.
   */
  app.post('/documents/:id/duplicate', requireAccess<Env>(rt, CREATE), async (c) => {
    const bindings = c.var.bindings()
    const story = await load(bindings, idParam('id', c.req.param('id')))
    const body = await parseOptionalBody(c.req, StoryDuplicateBody)

    let created: StoryMeta
    try {
      created = await duplicateDocument(documentDeps(c), story, body, actorString(c.var.actor))
    } catch (e) {
      rethrow(e)
    }

    return c.json({ document: meta(created) }, 201)
  })

  /**
   * Restore a version: read-diff-commit, with the version's document as the
   * target instead of a payload's — `writeDocument` (`../../write.ts:175`) is
   * `PUT /content` in three lines, and this is the same three lines.
   *
   * `getVersion`'s third argument is load-bearing, not optional
   * (`../../versions.ts:93`): a version stored under an earlier `schemaId` is
   * migrated on read, so `diff(live, target)` never reintroduces a pre-migration
   * field key. The object is assembled exactly as `routes/history.ts:70` already
   * does for the version-read route — reused, not rebuilt.
   *
   * A version naming a different `story_id` is refused with 400, not 404: the
   * version id is globally unique, so the lookup would succeed and the diff
   * would rewrite this document from a stranger's history — a caller error,
   * not a missing thing.
   */
  app.post('/documents/:id/restore', requireAccess<Env>(rt, EDIT), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseBody(c.req, RestoreBody)
    const key = idempotencyKeyHeader(c.req.header('idempotency-key'))
    const bindings = c.var.bindings()
    const story = await load(bindings, id)

    const found = await getVersion(bindings.db, body.versionId, {
      migrations: rt.migrations,
      schema: rt.schema,
      typeOf: rt.typeOf,
    })
    if (!found) throw new FolioError('not_found', 'Unknown version')
    if (found.meta.storyId !== id) {
      throw new FolioError('bad_request', 'That version belongs to a different document')
    }

    try {
      return c.json(await writeDocument(deps(bindings, story), () => found.doc, writeActor(c), key))
    } catch (e) {
      rethrow(e)
    }
  })

  return app
}
