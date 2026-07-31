/**
 * The content tree: CRUD over stories, the draft a `reference` field resolves
 * against, and publishing.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { cloneDoc } from '../../core/clone'
import { isKnownLocale, translationStatus } from '../../core/locales'
import type { Page } from '../../core/pagination'
import type { DocumentType } from '../../core/schema'
import { ancestorPaths, type StoryMeta } from '../../core/story'
import { actorString } from '../auth/roles'
import { CREATE, EDIT, MANAGE, PUBLISH, READ, READ_DRAFT } from '../auth/roles'
import { FolioError, rethrow } from '../errors'
import type { StoryChange } from '../hooks'
import { hookCtx, loadStory, requireAccess } from '../middleware'
import { publish, unpublish } from '../publish'
import type { FolioRuntime } from '../runtime'
import {
  createStory,
  deleteStoryStatement,
  documentUsage,
  duplicateStory,
  ensureSingleton,
  countStories,
  listDocumentPage,
  listRecentlyEdited,
  listSingletons,
  listStoriesFlat,
  listStoryLevel,
  searchStories,
  storiesForChunked,
  updateStoryStatement,
} from '../stories'
import type { FolioEnv } from '../types'
import {
  documentSortQuery,
  flatSortQuery,
  idListQuery,
  idParam,
  limitParam,
  parseBody,
  parseOptionalBody,
  pathListQuery,
  requireCursor,
  searchKindQuery,
  searchSortQuery,
  sortDirQuery,
  StoryCreateBody,
  StoryDuplicateBody,
  StoryPatchBody,
  storyFilterQuery,
  typeNameQuery,
} from '../validate'
import { deleteVersionsStatement } from '../versions'

/**
 * Who did this, for a hook payload and for `versions.actor`.
 *
 * Server-resolved and nothing else (`identity-and-access.md`): a person's own
 * `users.id`, `token:<name>` for a script, and null under `auth: 'open'`, where
 * there is genuinely nobody to attribute a change to. The `x-folio-actor` header
 * this used to read is gone — a history that can be rewritten by editing a
 * JavaScript variable is worse than one that admits it does not know.
 */
function actorFor<Env>(c: Context<FolioEnv<Env>>): string | null {
  return actorString(c.var.actor)
}

/**
 * `rt.withUrls` over a page's rows, keeping the envelope.
 *
 * A page is `{ rows, cursor, total? }` and only `rows` is content, so a spread
 * rather than a rebuild: `total` is absent unless it was asked for, and rebuilding
 * the object by hand is how an absent key becomes `total: undefined` and starts
 * appearing in the JSON.
 */
function decorated<T extends StoryMeta>(rt: FolioRuntime, page: Page<T>): Page<T> {
  return { ...page, rows: page.rows.map(rt.withUrls) }
}

export function storyRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * A declared document type by name, or `unsupported` (501) — not `not_found`:
   * the request is perfectly well-formed, the server simply has no such type
   * declared (`document-types.md`). An absent name is the default page type, so
   * a client written before types existed keeps working.
   */
  const requireType = (name: string | undefined): DocumentType => {
    if (name === undefined) return rt.defaultType
    const type = rt.typeOf(name)
    if (!type) throw new FolioError('unsupported', `Unknown document type: ${name}`)
    return type
  }

  /**
   * The page tree, in one of three modes — and **none of them is the whole
   * tree** any more (`../../../docs/specs/foundation/pagination.md` decision 2).
   *
   *   `?parentId=`            one parent's children, keyset over `(ord, id)`.
   *                           Absent means the top level.
   *   `?flat=1&sort=`         every routed page, no structure, one of three
   *                           orderings (decision 2a).
   *   `?ids=` / `?paths=`     a batch by identity, uncursored: a batch is not a
   *                           page (decision 7).
   *
   * The modes are checked most-specific first, so `?ids=` wins over `?flat=1`
   * and `?flat=1` over the level walk. A request naming two of them gets the
   * narrower one rather than a 400: they are not contradictory, one is simply
   * more specific, and refusing would make a URL harder to assemble by hand for
   * no gain in clarity.
   *
   * All three share `?type=`, `?state=` and `?q=`, which is what makes a Content
   * filter chip mean the same thing in either view — and what makes it mean
   * anything at all once the list is longer than one page.
   */
  app.get('/stories', requireAccess<Env>(rt, READ), async (c) => {
    const db = c.var.bindings().db

    const ids = idListQuery(c.req.query('ids'))
    const paths = pathListQuery(c.req.query('paths'))
    if (ids.length > 0 || paths.length > 0) {
      const rows = await storiesForChunked(db, ids, paths)
      // `?ancestors=1` pulls each row's breadcrumb chain in the same request.
      // Two queries rather than one, and worth it: the caller cannot compute
      // `ancestorPaths` before it knows the row's `path`, so the alternative is
      // a second round trip for something the server already has in hand.
      const chain =
        c.req.query('ancestors') === '1'
          ? await storiesForChunked(
              db,
              [],
              [...new Set(rows.flatMap((row) => ancestorPaths(row.path)))],
            )
          : []
      const merged = new Map(rows.map((row) => [row.id, row]))
      for (const row of chain) merged.set(row.id, row)
      return c.json({ rows: [...merged.values()].map(rt.withUrls) })
    }

    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const opts = {
      limit: limitParam(c.req.query('limit'), 50, 200),
      cursor,
      filter: storyFilterQuery(c.req),
      count: c.req.query('count') === '1',
    }

    /**
     * `?recent=1` — the most recently edited documents across **every** type, which
     * `?flat=1` deliberately is not: flat mode filters `path is not null`, so it is
     * every routed *page*. "What was touched last" on a site whose editors spent the
     * afternoon on People has to include People.
     *
     * Checked before `flat`, so a request naming both gets the wider set. Same
     * most-specific-first rule the `?ids=` branch above follows.
     */
    if (c.req.query('recent') === '1') {
      return c.json(decorated(rt, await listRecentlyEdited(db, opts)))
    }

    if (c.req.query('flat') === '1') {
      return c.json(
        decorated(rt, await listStoriesFlat(db, flatSortQuery(c.req.query('sort')), opts)),
      )
    }

    // An absent `parentId` is the top level; `parentId=` (empty) is the same
    // request, so a client can build the URL without a conditional.
    const raw = c.req.query('parentId')
    const parentId = raw ? idParam('parentId', raw) : null
    return c.json(decorated(rt, await listStoryLevel(db, parentId, opts)))
  })

  /**
   * The per-type listing records and singletons are addressed through, since they
   * are deliberately not in the tree — and the Documents screen's whole data
   * source (`../../../docs/ui-architecture.md` port phase 3).
   *
   * **This was the last unbounded read in the admin.** It stayed that way on
   * purpose while the screen over it was undecided (`foundation/pagination.md`'s
   * implementation notes say so), because two things about its shape were the
   * screen's to settle and deciding them twice would have been the cost of doing
   * it earlier. Both are settled here:
   *
   *   `?kind=singleton`  ensures every declared singleton and returns them,
   *                      **uncursored** — the set is bounded by the schema rather
   *                      than by content, so it is a batch and not a page.
   *                      *Asking is what creates a singleton* now lives here.
   *   `?type=&sort=`     one type's documents, keyset over `(ord, id)`,
   *                      `(title, id)` or `(coalesce(draft_updated_at,
   *                      updated_at), id)`. Every row carries the published values
   *                      of its type's `indexed` fields, on the row rather than in
   *                      a sibling map — see `DocumentRow`.
   *
   * A singleton type asked for by `?type=` is ensured too, so the one document
   * exists whichever way you arrive at it. No `?type` is every unrouted document
   * across every type, paged, and ensures nothing: a write must not depend on
   * which page was requested.
   */
  app.get('/documents', requireAccess<Env>(rt, READ), async (c) => {
    const bindings = c.var.bindings()

    if (c.req.query('kind') === 'singleton') {
      const rows = await listSingletons(bindings.db, rt.types, rt.schemaId)
      return c.json({ rows: rows.map(rt.withUrls) })
    }

    const raw = c.req.query('type')
    const wanted = raw === undefined ? undefined : requireType(typeNameQuery(raw))
    if (wanted?.kind === 'singleton') await ensureSingleton(bindings.db, wanted, rt.schemaId)

    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const page = await listDocumentPage(
      bindings.db,
      wanted?.name,
      documentSortQuery(c.req.query('sort')),
      {
        limit: limitParam(c.req.query('limit'), 50, 200),
        cursor,
        filter: storyFilterQuery(c.req),
        count: c.req.query('count') === '1',
        dir: sortDirQuery(c.req.query('dir')),
        // Skipped on a site that marks nothing `indexed`, where the query would
        // be a round trip for an empty answer.
        indexed: rt.indexedFields.size > 0,
      },
    )
    return c.json(decorated(rt, page))
  })

  /**
   * How many documents there are, per declared type — the Home screen's quick-access
   * cards, and nothing else so far.
   *
   * **One request rather than one per type**, and that is the whole reason this route
   * exists rather than the cards each asking `?type=X&limit=1&count=1`. Home shows a
   * card per declared type plus one for pages and one for assets; on a site with
   * twenty record types that is twenty requests to render a screen whose entire job
   * is being the fast way to somewhere else. A count per type is inherently a *set*,
   * so it gets a route shaped like one.
   *
   * A screen-shaped route is a smell and this is deliberately not one: it answers a
   * question about the content model — "how many of each" — that any caller might
   * ask, and it takes no parameters that only Home would send. What makes it safe to
   * add at all is decision 3's rule that `{base}/api/*` with no version segment is
   * internal to the admin and may change shape in any commit.
   *
   * `pages` is separate from the per-type counts on purpose: a page type's documents
   * and *the tree* are different lists — a second page type's records are in the tree
   * too — so a card labelled "Pages" wants the routed count, not the sum of the page
   * kinds. `countStories`' third argument is that distinction.
   */
  app.get('/counts', requireAccess<Env>(rt, READ), async (c) => {
    const db = c.var.bindings().db
    // Sequential over a handful of declared types would be a round trip each, and
    // these are independent aggregates over one indexed table.
    const [pages, ...perType] = await Promise.all([
      countStories(db, undefined, true),
      ...rt.types.map((type) => countStories(db, { type: type.name })),
    ])
    return c.json({
      pages,
      types: Object.fromEntries(rt.types.map((type, at) => [type.name, perType[at] ?? 0])),
    })
  })

  /**
   * One search route for the palette, every screen's search box and both pickers
   * (`foundation/pagination.md` decision 8).
   *
   * The palette got page search from `?flat=1&q=` when the shell stopped holding
   * every story, which answered the urgent half and left two things owed: a
   * *record* was unreachable from it, and `content_index`'s values were unreachable
   * from any search box at all. Both are what this adds — `?kind=` is the axis that
   * makes one route serve a picker narrowed to pages and a palette that is not.
   *
   * `Page<StoryMeta>` rather than a `StoryRef` projection, which is what the spec
   * named. A ref is `{ id, title, url }` and every consumer wants more: the palette
   * shows a path to tell two same-titled pages apart, a picker shows the state
   * badge, and a screen's search box shows the row it would show anyway. Sending
   * the row the other list routes already send means one shape to consume and no
   * second projection to keep in step.
   */
  app.get('/search', requireAccess<Env>(rt, READ), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    // `kind` becomes a list of declared type names here rather than in the
    // reader: nothing on a story row records a kind, so the manifest is the only
    // thing that can answer it. A kind no type declares resolves to an **empty
    // list**, which the reader reads as "no type matches" rather than "every
    // type" — the distinction absent-versus-empty that `?parentId=` also turns
    // on. Not a 400: the request is well-formed and the honest answer is that this
    // site declares none.
    const kind = searchKindQuery(c.req.query('kind'))
    return c.json(
      decorated(
        rt,
        await searchStories(c.var.bindings().db, {
          ...(kind ? { types: rt.types.filter((t) => t.kind === kind).map((t) => t.name) } : {}),
          sort: searchSortQuery(c.req.query('sort')),
          limit: limitParam(c.req.query('limit'), 20, 100),
          cursor,
          filter: storyFilterQuery(c.req),
          count: c.req.query('count') === '1',
        }),
      ),
    )
  })

  /**
   * What points at this document, for the confirmation shown before deleting it
   * (`data-documents.md` architecture decision 4).
   *
   * **Warns with a count and proceeds** — this route informs a dialog, it does
   * not gate a delete. Blocking would mean maintaining referential integrity
   * across draft documents nobody can see, and a broken reference already
   * degrades safely: `resolveReference` returns null and the block renders its
   * empty state.
   *
   * `EDIT` (editor+), per the spec's route table. It reports on published content
   * an editor can already read, so nothing is leaked by the lower bar; the delete
   * it precedes is `MANAGE`, so a plain editor never sees the dialog anyway — they
   * may create and duplicate (`CREATE`), but not delete.
   */
  app.get('/documents/:id/usage', requireAccess<Env>(rt, EDIT), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const usage = await documentUsage(c.var.bindings().db, id)
    return c.json({
      published: usage.published.map(({ story, kind }) => {
        const decorated = rt.withUrls(story)
        return {
          id: story.id,
          title: story.title,
          path: story.path,
          // `''` rather than absent for an unrouted source, matching
          // `StoryRef.url`: a record referencing a record has no URL to offer.
          url: decorated.url ?? '',
          kind,
        }
      }),
      total: usage.total,
      links: usage.links,
      references: usage.references,
    })
  })

  app.post('/stories', requireAccess<Env>(rt, CREATE), async (c) => {
    const body = await parseBody(c.req, StoryCreateBody)
    const bindings = c.var.bindings()
    const type = requireType(body.type)
    // A singleton is created by first access, never by a request that asks for
    // one: there is exactly one, its id is derived, and `POST` has no way to
    // express "the" rather than "a".
    if (type.kind === 'singleton') {
      throw new FolioError(
        'conflict',
        `'${type.name}' is a singleton and already exists; open it instead of creating one`,
      )
    }

    let story: StoryMeta
    try {
      // Born up to date: `blankSubtree` seeds the document from the current
      // schema, so stamping the latest migration is the true answer and keeps a
      // page created five seconds ago out of the behind-the-model banner
      // (`schema-migrations.md`).
      story = await createStory(bindings.db, { ...body, type, schemaId: rt.schemaId }, rt.types)
    } catch (e) {
      // `Unknown parent` is the client's mistake; a path collision is a
      // conflict; a D1 failure is nobody's business but the log's.
      rethrow(e)
    }

    const actor = actorFor(c)
    await rt.publishDeps(bindings, hookCtx(c)).hooks?.run('created', { story, actor })

    return c.json(rt.withUrls(story))
  })

  app.patch('/stories/:id', requireAccess<Env>(rt, MANAGE), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseBody(c.req, StoryPatchBody)
    const bindings = c.var.bindings()

    let next: StoryMeta
    let changes: { id: string; from: string; to: string }[]
    let updated: StoryChange[]
    try {
      const result = await updateStoryStatement(bindings.db, id, body, rt.types)
      next = result.next
      changes = result.changes
      updated = result.updated
      if (result.statements.length) await bindings.db.batch(result.statements)
    } catch (e) {
      rethrow(e)
    }

    const actor = actorFor(c)
    // Nothing renamed or moved (a plain title edit, say) has no old path for
    // a host to purge, so `pathsChanged` stays silent rather than firing an
    // empty `changes` array.
    if (changes.length) {
      await rt.publishDeps(bindings, hookCtx(c)).hooks?.run('pathsChanged', { changes, actor })
    }
    // ...and `updated` is the event that fires for exactly the case
    // `pathsChanged` skips (`../../../docs/specs/platform/caching.md`): a
    // title-only patch changes `StoryRef.title` on every page linking here and
    // used to fire nothing at all. Both fire for a rename, which is correct —
    // they describe different facts about the same write.
    if (updated.length) {
      await rt
        .publishDeps(bindings, hookCtx(c))
        .hooks?.run('updated', { story: next, changed: updated, actor })
    }

    return c.json(rt.withUrls(next))
  })

  /**
   * Duplicate a document (`duplicate-and-paste.md`). Row first, seed second
   * (architecture decision 4): if `duplicateStory`'s insert fails, nothing
   * else has happened; if the DO seed after it fails, the result is a story
   * row with a blank document — a state this system already understands (a
   * page someone created and never filled in), not an orphaned Durable
   * Object. The *draft* is cloned, not the published snapshot: an editor
   * duplicating a page means "give me what I am looking at" (decision 4's
   * sibling on version history — the copy starts with none of its own).
   *
   * A singleton is refused, inside `duplicateStory` rather than here so a direct
   * caller cannot route around it: there is exactly one of a singleton by
   * definition, so a second copy is not a document its own schema can describe.
   * This is the debt `duplicate-and-paste.md` deferred to
   * `../foundation/document-types.md`, which is what makes "singleton" mean
   * anything at all.
   */
  app.post(
    '/stories/:id/duplicate',
    requireAccess<Env>(rt, CREATE),
    loadStory<Env>(),
    async (c) => {
      const bindings = c.var.bindings()
      const source = c.var.story
      const body = await parseOptionalBody(c.req, StoryDuplicateBody)

      let created: Awaited<ReturnType<typeof duplicateStory>>
      try {
        created = await duplicateStory(bindings.db, source.id, body, rt.types)
      } catch (e) {
        rethrow(e)
      }

      // Fired the moment the row exists, same as a plain create: the D1 insert
      // already committed, and a story with no draft seeded yet is a state this
      // system already understands (a page someone created and never filled in).
      const actor = actorFor(c)
      await rt.publishDeps(bindings, hookCtx(c)).hooks?.run('created', { story: created, actor })

      const draft = await rt.draftFor(bindings, source)
      await rt.stub(bindings, created.id).getOrInit(cloneDoc(draft))

      return c.json({ story: rt.withUrls(created) }, 201)
    },
  )

  app.delete('/stories/:id', requireAccess<Env>(rt, MANAGE), async (c) => {
    const bindings = c.var.bindings()
    const target = idParam('id', c.req.param('id'))
    // redirects.md's architecture decision 4: checked by default in the admin's
    // confirmation, an escape hatch for a page that should genuinely 404.
    const redirect = c.req.query('redirect') !== 'false'

    let found: Awaited<ReturnType<typeof deleteStoryStatement>>
    try {
      found = await deleteStoryStatement(bindings.db, target, { redirect }, rt.types)
      if (!found) return c.json({ deleted: [] })

      // One batch for the story rows, their version history, their query-index
      // rows and (optionally) the redirect to the parent: all four disappear or
      // land together, so a reader never finds versions for a story that is
      // already gone, a collection that still lists it, or a redirect for a
      // delete that never actually committed.
      const versions = deleteVersionsStatement(bindings.db, found.ids)
      await bindings.db.batch([
        found.statement,
        ...found.redirectStatements,
        ...found.indexStatements,
        ...(versions ? [versions] : []),
      ])
    } catch (e) {
      // Nothing has committed yet at this point, so reporting a failure here
      // is accurate. `Cannot delete the root story` is a conflict; a failed
      // batch is internal.
      rethrow(e)
    }

    // The Durable Object is purged only once that batch has committed.
    // Purging first and then failing the D1 write would leave this id
    // deletable-again while its object already has a blank doc — the
    // opposite of the bug this guards against, but a data-loss bug all the
    // same. Purging after means a crash between the two leaves an orphaned
    // object rather than a resurrected one, which is the safer side to fail on.
    //
    // This runs outside the try/catch above on purpose: the D1 rows are
    // already gone by now, so a purge failure must never be reported back as
    // a failed delete — the caller already got what it asked for. It is
    // best-effort cleanup of an object that a reused id would otherwise
    // resurrect from; an object left un-purged here still cannot be reached
    // under this id (D1 no longer has it), only under a *reused* one, which is
    // the narrow, already-documented window above.
    await Promise.all(
      found.ids.map((id) =>
        rt
          .stub(bindings, id)
          .purge()
          .catch(() => {}),
      ),
    )

    // Fires even if a purge above failed: the rows are gone regardless, and a
    // host's cache must be purged regardless (`publish-hooks.md`'s edge case
    // "partial success in the delete path"). The purge failure is swallowed
    // above, as it already was before this hook existed.
    const actor = actorFor(c)
    await rt
      .publishDeps(bindings, hookCtx(c))
      .hooks?.run('deleted', { ids: found.ids, paths: found.paths, types: found.types, actor })

    return c.json({ deleted: found.ids })
  })

  /**
   * A translation layer over publish.ts and nothing more: both inputs are checked
   * before any work happens — neither the Durable Object nor D1 should be touched
   * on a request that cannot land — and the story's own existence is the
   * workflow's to check, because a scheduled publish has to check it too.
   */
  app.post('/story/:id/publish', requireAccess<Env>(rt, PUBLISH), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const actor = actorFor(c)

    const { publishedAt, publishedSyncId, version } = await publish(
      rt.publishDeps(c.var.bindings(), hookCtx(c)),
      id,
      actor,
    )
    return c.json({ ok: true, publishedAt, publishedSyncId, version })
  })

  /**
   * Clears the published snapshot. `loadStory` runs first so an unknown id
   * 404s before `unpublish` does anything, and hands the row it already found
   * straight to the workflow instead of a second lookup by id.
   */
  app.post('/story/:id/unpublish', requireAccess<Env>(rt, PUBLISH), loadStory<Env>(), async (c) => {
    const actor = actorFor(c)
    const { unpublishedAt } = await unpublish(
      rt.publishDeps(c.var.bindings(), hookCtx(c)),
      c.var.story,
      actor,
    )
    return c.json({ ok: true, unpublishedAt })
  })

  /**
   * A story's live draft, for resolving a `reference` in the admin.
   *
   * The admin fetches this when the *set* of referenced ids changes, not per
   * render, and pushes the result into the preview with the resolution. The
   * preview re-renders on every keystroke and must never reach the network.
   */
  app.get('/story/:id/document', requireAccess<Env>(rt, READ_DRAFT), loadStory<Env>(), async (c) =>
    c.json({ doc: await rt.draftFor(c.var.bindings(), c.var.story) }),
  )

  /**
   * How complete one locale's translation of this document is
   * (`../../../docs/specs/content-model/localisation.md`), for the tree's
   * per-story badge.
   *
   * This route exists *only* for the tree. The open story's own completeness is
   * computed client-side from the draft the admin already holds, per keystroke,
   * because a network round trip in that loop is the thing this codebase exists
   * to avoid — so this is for the rows an editor is not currently editing.
   *
   * `READ_DRAFT`, matching `/document` above: it reports on the draft, and the
   * editor page that draws the badge already requires no less.
   *
   * 501 rather than 404 for a locale this site never declared: the request is
   * perfectly well-formed, the server simply has no such locale — the same shape
   * `requireType` uses for an unknown document type.
   */
  app.get(
    '/story/:id/translation',
    requireAccess<Env>(rt, READ_DRAFT),
    loadStory<Env>(),
    async (c) => {
      const locale = c.req.query('locale')
      if (locale === undefined) {
        throw new FolioError('bad_request', 'A `locale` query parameter is required')
      }
      if (!isKnownLocale(rt.locales, locale)) {
        throw new FolioError('unsupported', `Unknown locale: ${locale}`)
      }
      const doc = await rt.draftFor(c.var.bindings(), c.var.story)
      return c.json(translationStatus(doc, rt.schema, locale))
    },
  )

  return app
}
