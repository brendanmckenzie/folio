/**
 * Writing and clearing `content_index` / `content_refs`
 * (`../../docs/specs/content-model/collections.md` architecture decision 3) and
 * the full-text pair `content_text` / `content_fts`
 * (`../../docs/specs/content-model/full-text-search.md` architecture decision 1) —
 * a third table written by the same functions into the same batch, which is the
 * whole answer to spec 18's objection that FTS5 would be "a second write path to
 * keep in step with the first".
 *
 * Every function here returns **unrun** statements, for one reason: they join the
 * batch that publishes, unpublishes or deletes the story they describe. `publish()`
 * already batches the version insert with the `stories` update precisely so the two
 * cannot disagree about what is live; the index rows join that same batch, so the
 * index can never describe a document that is not published, and a failed publish
 * leaves neither.
 *
 * Delete-then-insert rather than upsert, deliberately: the set of rows *shrinks*
 * when a field is cleared or a locale is removed from the config, and a diffing
 * upsert would have to work that out. Two statements per table, always, whatever
 * changed.
 */
import type { Doc } from '../core/doc'
import { indexRowsFor, type IndexRow } from '../core/index-projection'
import type { LocaleConfig } from '../core/locales'
import { outboundRefs, type OutboundRef } from '../core/refs'
import type { DocumentType, SchemaIndex } from '../core/schema'
import { type SearchRow, searchRowsFor } from '../core/search-projection'
import { bindChunks, type FolioDb } from './db'

/** What one document projects to. Computed by `contentProjection`, written by `indexStatements`. */
export interface ContentProjection {
  index: IndexRow[]
  refs: OutboundRef[]
  /** One `content_text` row per locale that has any prose (`full-text-search.md` decision 3). */
  search: SearchRow[]
}

export const EMPTY_PROJECTION: ContentProjection = { index: [], refs: [], search: [] }

/**
 * The projection for one document, from the pure core walks. The one place the
 * three halves are computed together, so publish and reindex cannot drift.
 */
export function contentProjection(
  storyId: string,
  doc: Doc,
  type: DocumentType | undefined,
  schema: SchemaIndex,
  locales?: LocaleConfig,
): ContentProjection {
  return {
    index: indexRowsFor(doc, type, schema, locales),
    refs: outboundRefs(doc, schema, storyId),
    search: searchRowsFor(doc, type, schema, locales),
  }
}

/**
 * A cap on how many rows one document may contribute.
 *
 * **What this used to guard against, it never guarded against.** The comment here
 * said 400 rows kept one document from producing "a single SQL statement large
 * enough to fail the whole publish batch", and it was sized against a D1
 * bound-parameter ceiling that does not exist: the real cap is exactly 100 per
 * statement (`db.ts`'s `D1_BIND_CAP`), so at five binds per index row and three
 * per ref row this failed the whole publish batch at **21 index rows** and at
 * **34 outbound refs** — a page with thirty-four internal links, which
 * `pagination.md`'s edge cases call legitimate input. `MAX_ROWS = 400` was not a
 * generous margin above the danger; it was four hundred rows *past* it.
 *
 * The statement size is now the chunker's problem, not this constant's, so what
 * is left for `MAX_ROWS` to mean is the honest thing it always described: a bound
 * on how much one document may contribute to the publish batch **at all**. A
 * hand-written schema marking forty fields indexed across six locales is 240 rows
 * and a dozen statements; ten thousand would be a batch nobody meant to write.
 * Rows past it are dropped, exactly as before, and dropping them is now the only
 * effect it has rather than a second line of defence behind a broken first.
 *
 * Unchanged at 400 because the number was never the problem, and two other
 * comments quote it as the bound on a document's outbound edges
 * (`assets.ts`, `documentUsage`).
 */
const MAX_ROWS = 400

/** Bound parameters per row of each multi-row insert below, for `bindChunks`. */
const INDEX_BINDS = 5
const REFS_BINDS = 3
const SEARCH_BINDS = 4

/**
 * The index, ref and full-text rows for one story, replacing whatever is there.
 *
 * Multi-row inserts rather than one statement per row: a D1 batch is a real
 * transaction but each statement is a round trip inside it, and a document with
 * three indexed fields across two locales is six rows. Bound parameters
 * throughout — nothing here is interpolated, including the field name, which is a
 * value in this schema rather than a column.
 *
 * **Several inserts per table rather than one, sized by `bindChunks` from the
 * binds each row costs.** D1 refuses the 101st bound parameter on a statement,
 * and both of these bind a caller-sized list. Chunking is what this file's header
 * rule demands rather than a departure from it: the extra statements join the
 * *same* returned array and therefore the same batch, so a publish is still one
 * transaction and the index still cannot describe a document that is not
 * published. The chunk size comes off `INDEX_BINDS` / `REFS_BINDS` rather than a
 * number written here, so adding a column to either insert re-sizes its chunks
 * instead of quietly putting it back over the cap.
 */
export function indexStatements(
  db: FolioDb,
  storyId: string,
  projection: ContentProjection,
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [
    db.prepare('delete from content_index where story_id = ?').bind(storyId),
    db.prepare('delete from content_refs where from_story = ?').bind(storyId),
  ]

  for (const chunk of bindChunks(projection.index.slice(0, MAX_ROWS), INDEX_BINDS)) {
    const values = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')
    out.push(
      db
        .prepare(
          `insert into content_index (story_id, locale, field, text_value, num_value)
           values ${values}`,
        )
        .bind(...chunk.flatMap((r) => [storyId, r.locale, r.field, r.text, r.num])),
    )
  }

  // `or ignore`, not a plain insert: the same target can legitimately appear
  // twice in one document (two links to the same page), and the primary key
  // makes the second row a duplicate rather than a second fact. It also makes
  // chunking free of a new hazard — a duplicate split across two chunks is
  // ignored by the second statement exactly as it would have been by the first.
  //
  // `to_id` holds whatever `kind` says: a story id for `link` and `reference`,
  // an R2 object key for `asset` (`migrations/0002_asset_refs.sql`). Asset rows
  // land in the same batch as everything else here, which is the property this
  // file's header is about — the index can never describe a document that is not
  // published, and that has to be as true of "which pages use this photograph"
  // as it is of "which pages reference this record".
  for (const chunk of bindChunks(projection.refs.slice(0, MAX_ROWS), REFS_BINDS)) {
    const values = chunk.map(() => '(?, ?, ?)').join(', ')
    out.push(
      db
        .prepare(`insert or ignore into content_refs (from_story, to_id, kind) values ${values}`)
        .bind(...chunk.flatMap((r) => [storyId, r.to, r.kind])),
    )
  }

  // The full-text pair, appended after the two tables above (decision 1). Four
  // statements, and **the order of the first two is load-bearing and silent when
  // it is wrong**: FTS5's special `'delete'` command de-indexes a row by being
  // handed that row's *old* column values, and the only place they exist is
  // `content_text` itself. Read them first and the tokens go; drop the rows first
  // and the command reads an empty `select`, raises nothing, and leaves the old
  // tokens in the index for ever — matching documents that no longer contain the
  // words. Every ordinary reader joins `content_fts` back to `content_text` and
  // so sees an empty result either way; only asking the index on its own terms
  // (`test/workers/search.test.ts`'s `orphanedTokens`) or running FTS5's
  // `'integrity-check'` can tell the two apart, and a *partial* de-index is
  // visible to nothing but the latter.
  //
  // The `select` is deliberately multi-row: a document is multi-locale, so the
  // de-index is inherently more than one row and the command column is fed once
  // per row by SQLite's per-row `xUpdate`. That was the one behaviour this design
  // leaned on and had not observed; `fts-smoke.test.ts` observes it.
  out.push(
    db
      .prepare(
        `insert into content_fts(content_fts, rowid, title, body)
         select 'delete', id, title, body from content_text where story_id = ?`,
      )
      .bind(storyId),
    db.prepare('delete from content_text where story_id = ?').bind(storyId),
  )

  // Four binds a row against `db.ts`'s ninety-parameter budget is twenty-two rows
  // a statement, and `MAX_SEARCH_ROWS` is twenty-four — so a site with enough
  // declared locales chunks here exactly as the two tables above do, into
  // statements that join this same array and therefore the same transaction.
  for (const chunk of bindChunks(projection.search, SEARCH_BINDS)) {
    const values = chunk.map(() => '(?, ?, ?, ?)').join(', ')
    out.push(
      db
        .prepare(`insert into content_text (story_id, locale, title, body) values ${values}`)
        .bind(...chunk.flatMap((r) => [storyId, r.locale, r.title, r.body])),
    )
  }

  // Last, and after **every** insert chunk: this is the statement that indexes
  // the new rows, and it finds them by reading `content_text` back by story id.
  // Emitted anywhere before the inserts it sees an empty table and indexes
  // nothing at all, which is a document that exists, reads correctly and cannot
  // be found. Inside the loop it would re-index each earlier chunk once more per
  // chunk — harmless but wasteful, and not the shape the batch is meant to have.
  //
  // Omitted entirely for a document with no prose, which leaves the two deletes
  // above and nothing else — the shrink case, exactly as `content_index`'s bare
  // deletes handle a field losing `indexed`.
  if (projection.search.length > 0) {
    out.push(
      db
        .prepare(
          `insert into content_fts(rowid, title, body)
           select id, title, body from content_text where story_id = ?`,
        )
        .bind(storyId),
    )
  }

  return out
}

/**
 * Drops every index row, every *outbound* ref row and every full-text row for a
 * set of stories — what an unpublish and a delete both need.
 *
 * Outbound only, because this is the half an unpublish means: the story still
 * exists, so a row pointing *at* it is still another document's true fact and
 * still what `data-documents.md`'s "used by N" warning reads. Unpublishing a
 * referenced record must keep warning that four pages point at it. The full-text
 * rows carry no such distinction — they describe the story's own prose, so they
 * go with the index rows.
 *
 * A delete is the case where the target stops existing, and it pairs this with
 * `clearInboundRefStatements` in the same batch.
 *
 * Asset edges are outbound rows too, so unpublishing a page stops it counting as
 * a usage of the photograph on it — which is correct without any code here, and is
 * the reason asset usage was widened into this table rather than given its own
 * (`migrations/0002_asset_refs.sql`). "Used by N **published** documents" is the
 * claim the Assets panel makes.
 *
 * **The `in (…)` list is chunked against `BIND_BUDGET`, and it has to be.** `ids`
 * is a delete's whole subtree, and deleting a section of a real site is an
 * ordinary act that goes past ninety documents — one bind per id, so the budget
 * is the chunk size and each chunk costs four statements. They all join the
 * returned array and therefore the same batch: the cap is per *statement*, never
 * per batch, so more statements buys the fix without costing the delete its
 * transaction. This used to bind the whole list in one go and say so, on the
 * reasoning that `deleteStoryStatement` returns five arrays that all bind it and
 * a half-fix would move the failure to the next while reading as fixed. That was
 * true, and all five chunk now.
 *
 * **Grouped per chunk rather than per table**, and the last two are why: FTS5's
 * `'delete'` reads a row's old values out of `content_text`, so it has to precede
 * the `delete` that removes them. Interleaving the groups is safe because a
 * chunk's four statements only ever name that chunk's own ids — chunk one's
 * `delete from content_text` cannot empty the rows chunk two's `'delete'` is
 * about to read.
 *
 * No length guard: `bindChunks` is empty in, empty out, which is what keeps
 * `in ()` — not valid SQL — unreachable.
 */
export function clearIndexStatements(db: FolioDb, ids: readonly string[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = []
  for (const chunk of bindChunks(ids, 1)) {
    const placeholders = chunk.map(() => '?').join(', ')
    out.push(
      db.prepare(`delete from content_index where story_id in (${placeholders})`).bind(...chunk),
      db.prepare(`delete from content_refs where from_story in (${placeholders})`).bind(...chunk),
      // De-index before the rows go, for the reason `indexStatements` spells out:
      // FTS5's `'delete'` reads the old values out of `content_text`, so after the
      // delete it reads nothing, raises nothing, and orphans the tokens.
      db
        .prepare(
          `insert into content_fts(content_fts, rowid, title, body)
           select 'delete', id, title, body from content_text where story_id in (${placeholders})`,
        )
        .bind(...chunk),
      db.prepare(`delete from content_text where story_id in (${placeholders})`).bind(...chunk),
    )
  }
  return out
}

/**
 * Drops the *inbound* ref rows for a set of targets: the edges where one of
 * `targets` is pointed at. What a delete adds on top of `clearIndexStatements`.
 *
 * The row `(A → B)` is the fact "A names B", and deleting B does not stop A
 * naming it — but nothing reads that fact once B is gone. Every reader of `to_id`
 * (`countReferencesTo`, `referencesTo`, `assetReferences`) is asked about a thing
 * somebody is looking at, and `documentUsage` already drops a row whose source
 * has vanished. Left behind, the row is only ever rewritten when A is next
 * published, so a site that never republishes accumulates edges to ids with no
 * document behind them.
 *
 * **`targets`, not `ids`, and that is the widening earning its keep**: a deleted
 * *asset* is exactly the same operation with an R2 key in place of a story id
 * (`deleteAsset`). No kind filter, deliberately — the statement means "nothing
 * points at these any more", which is true of every kind of edge at once, and a
 * key cannot collide with a story id in the first place.
 *
 * Separate from `clearIndexStatements` rather than a flag on it, because the two
 * callers genuinely differ: an unpublish must keep them and a delete must not.
 * A `boolean` parameter would put that distinction at the call site, where the
 * reason for it is invisible.
 *
 * Chunked for the reason `clearIndexStatements` is, and separately from it: the
 * two are called with the same subtree by `deleteStoryStatement`, so a delete
 * that chunked one and not the other would fail on whichever was left — in the
 * same batch, at the same width, and looking fixed.
 */
export function clearInboundRefStatements(
  db: FolioDb,
  targets: readonly string[],
): D1PreparedStatement[] {
  return bindChunks(targets, 1).map((chunk) => {
    const placeholders = chunk.map(() => '?').join(', ')
    return db.prepare(`delete from content_refs where to_id in (${placeholders})`).bind(...chunk)
  })
}

/**
 * How many published documents point at `id`, by kind
 * (`data-documents.md`: "deleting a referenced record warns with a count, and
 * proceeds"). Published references only, which is what the table holds.
 *
 * `total` is `links + references` rather than the sum of the group-by, so an
 * `asset` row could not contribute to it even if a key somehow equalled a story
 * id. The two namespaces do not overlap, so this is belt over braces.
 */
export async function countReferencesTo(
  db: FolioDb,
  id: string,
): Promise<{ total: number; links: number; references: number }> {
  const { results } = await db
    .prepare('select kind, count(*) as n from content_refs where to_id = ? group by kind')
    .bind(id)
    .all<{ kind: string; n: number }>()
  const links = results.find((r) => r.kind === 'link')?.n ?? 0
  const references = results.find((r) => r.kind === 'reference')?.n ?? 0
  return { total: links + references, links, references }
}

/**
 * One indexed field's value for one document, as a table cell wants it.
 *
 * Two halves because `content_index` has two columns for a reason: `text` is
 * filled for every scalar and is what a cell *shows*; `num` is filled only where
 * a number is genuinely meant (a `number` field, a boolean's 0/1, an ISO date's
 * epoch milliseconds) and is what a numeric sort uses. Sorting a publish-date
 * column lexicographically on `text` would be right by accident for ISO dates and
 * wrong for everything else.
 */
export interface IndexedValue {
  text: string
  num: number | null
}

/** Indexed values keyed by story id, then by field name. */
export type IndexedValues = Record<string, Record<string, IndexedValue>>

/**
 * The indexed values for a set of documents, for the admin's Data list view
 * columns (`data-documents.md` architecture decision 2).
 *
 * One query for the whole list, which is the only reason a table of columns is
 * affordable at all: reading each document's draft instead would be one Durable
 * Object per row, exactly what `localisation.md` refused for its per-row badge.
 *
 * Two honest limits, both visible in the UI rather than hidden:
 *
 *  - **Published values.** `content_index` is written inside the publish batch, so
 *    a document with nothing published has no rows and its cells are blank. The
 *    same row carries a draft-state badge, so a blank cell beside "Draft" reads
 *    as "not published yet" rather than as "empty".
 *  - **The source locale only** (`locale = ''`). The list is a management view;
 *    a column per locale would be a second dimension nobody asked for, and the
 *    document itself is where a translation is read.
 */
export async function indexedValuesFor(
  db: FolioDb,
  ids: readonly string[],
): Promise<IndexedValues> {
  if (ids.length === 0) return {}
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `select story_id as storyId, field, text_value as text, num_value as num
       from content_index where locale = '' and story_id in (${placeholders})`,
    )
    .bind(...ids)
    .all<{ storyId: string; field: string; text: string | null; num: number | null }>()

  const out: IndexedValues = {}
  for (const row of results) {
    out[row.storyId] ??= {}
    out[row.storyId]![row.field] = { text: row.text ?? '', num: row.num ?? null }
  }
  return out
}

/** The distinct documents pointing at `id`, for a warning that names them. */
export async function referencesTo(
  db: FolioDb,
  id: string,
): Promise<{ from: string; kind: string }[]> {
  const { results } = await db
    .prepare('select from_story as "from", kind from content_refs where to_id = ? order by "from"')
    .bind(id)
    .all<{ from: string; kind: string }>()
  return results
}

/**
 * The published documents using one asset, by its R2 key — the inbound half of
 * `content_refs` for an `asset` edge (`docs/ui-architecture.md` dependency 4).
 *
 * Story ids, unadorned. One row per document rather than per use: the primary key
 * is `(from_story, to_id, kind)` and every asset edge is one kind, so a page that
 * embeds a photograph *and* links to it appears once, which is what "used by 4
 * published pages" counts. `server/assets.ts`'s `assetUsage` turns these into rows
 * a dialog can name.
 *
 * Its own reader rather than `referencesTo(db, key)`, which would in fact return
 * the same rows — a key cannot collide with a story id, so the kind filter is not
 * what makes this correct. It exists because a caller asking "who uses this asset"
 * should not have to know that the answer happens to fall out of a story reader,
 * and because the `and kind = ?` is the one line that would have to be added if
 * an asset ever *did* share a namespace with anything else in this column.
 *
 * `kind` is bound rather than interpolated, like every other value in this file:
 * the moment one literal goes inline, the next one is a field name off a request.
 */
export async function assetReferences(db: FolioDb, key: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `select from_story as "from" from content_refs
       where to_id = ? and kind = ? order by "from"`,
    )
    .bind(key, 'asset')
    .all<{ from: string }>()
  return results.map((row) => row.from)
}
