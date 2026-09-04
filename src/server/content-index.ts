/**
 * Writing and clearing `content_index` / `content_refs`
 * (`../../docs/specs/content-model/collections.md` architecture decision 3).
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
import type { FolioDb } from './db'

/** What one document projects to. Computed by `contentProjection`, written by `indexStatements`. */
export interface ContentProjection {
  index: IndexRow[]
  refs: OutboundRef[]
}

export const EMPTY_PROJECTION: ContentProjection = { index: [], refs: [] }

/**
 * The projection for one document, from the pure core walks. The one place the
 * two halves are computed together, so publish and reindex cannot drift.
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
  }
}

/**
 * A cap on how many rows one document may contribute, so a hand-written schema
 * marking forty fields indexed across six locales cannot produce a single SQL
 * statement large enough to fail the whole publish batch. Generously above any
 * real projection: five indexed fields across four locales is twenty rows.
 */
const MAX_ROWS = 400

/**
 * The index and ref rows for one story, replacing whatever is there.
 *
 * Multi-row inserts rather than one statement per row: a D1 batch is a real
 * transaction but each statement is a round trip inside it, and a document with
 * three indexed fields across two locales is six rows. Bound parameters
 * throughout — nothing here is interpolated, including the field name, which is a
 * value in this schema rather than a column.
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

  const index = projection.index.slice(0, MAX_ROWS)
  if (index.length > 0) {
    const values = index.map(() => '(?, ?, ?, ?, ?)').join(', ')
    out.push(
      db
        .prepare(
          `insert into content_index (story_id, locale, field, text_value, num_value)
           values ${values}`,
        )
        .bind(...index.flatMap((r) => [storyId, r.locale, r.field, r.text, r.num])),
    )
  }

  const refs = projection.refs.slice(0, MAX_ROWS)
  if (refs.length > 0) {
    // `or ignore`, not a plain insert: the same target can legitimately appear
    // twice in one document (two links to the same page), and the primary key
    // makes the second row a duplicate rather than a second fact.
    //
    // `to_id` holds whatever `kind` says: a story id for `link` and `reference`,
    // an R2 object key for `asset` (`migrations/0002_asset_refs.sql`). Asset rows
    // land in the same batch as everything else here, which is the property this
    // file's header is about — the index can never describe a document that is not
    // published, and that has to be as true of "which pages use this photograph"
    // as it is of "which pages reference this record".
    const values = refs.map(() => '(?, ?, ?)').join(', ')
    out.push(
      db
        .prepare(`insert or ignore into content_refs (from_story, to_id, kind) values ${values}`)
        .bind(...refs.flatMap((r) => [storyId, r.to, r.kind])),
    )
  }

  return out
}

/**
 * Drops every index row and every *outbound* ref row for a set of stories — what
 * an unpublish and a delete both need.
 *
 * Outbound only, because this is the half an unpublish means: the story still
 * exists, so a row pointing *at* it is still another document's true fact and
 * still what `data-documents.md`'s "used by N" warning reads. Unpublishing a
 * referenced record must keep warning that four pages point at it.
 *
 * A delete is the case where the target stops existing, and it pairs this with
 * `clearInboundRefStatements` in the same batch.
 *
 * Asset edges are outbound rows too, so unpublishing a page stops it counting as
 * a usage of the photograph on it — which is correct without any code here, and is
 * the reason asset usage was widened into this table rather than given its own
 * (`migrations/0002_asset_refs.sql`). "Used by N **published** documents" is the
 * claim the Assets panel makes.
 */
export function clearIndexStatements(db: FolioDb, ids: readonly string[]): D1PreparedStatement[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  return [
    db.prepare(`delete from content_index where story_id in (${placeholders})`).bind(...ids),
    db.prepare(`delete from content_refs where from_story in (${placeholders})`).bind(...ids),
  ]
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
 */
export function clearInboundRefStatements(
  db: FolioDb,
  targets: readonly string[],
): D1PreparedStatement[] {
  if (targets.length === 0) return []
  const placeholders = targets.map(() => '?').join(', ')
  return [db.prepare(`delete from content_refs where to_id in (${placeholders})`).bind(...targets)]
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
