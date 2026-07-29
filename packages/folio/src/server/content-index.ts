/**
 * Writing and clearing `content_index` / `content_refs`
 * (`../../../docs/specs/content-model/collections.md` architecture decision 3).
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
  db: D1Database,
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
    const values = refs.map(() => '(?, ?, ?)').join(', ')
    out.push(
      db
        .prepare(`insert or ignore into content_refs (from_story, to_story, kind) values ${values}`)
        .bind(...refs.flatMap((r) => [storyId, r.to, r.kind])),
    )
  }

  return out
}

/**
 * Drops every index and ref row for a set of stories — what an unpublish and a
 * delete both need.
 *
 * `to_story` rows are deliberately left alone on a delete: another document still
 * points here, and that is exactly the fact `data-documents.md`'s "used by N"
 * warning is about. They are cleaned up when *that* document is next published,
 * which is the same moment its own outbound set is recomputed.
 */
export function clearIndexStatements(
  db: D1Database,
  ids: readonly string[],
): D1PreparedStatement[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  return [
    db.prepare(`delete from content_index where story_id in (${placeholders})`).bind(...ids),
    db.prepare(`delete from content_refs where from_story in (${placeholders})`).bind(...ids),
  ]
}

/**
 * How many published documents point at `id`, by kind
 * (`data-documents.md`: "deleting a referenced record warns with a count, and
 * proceeds"). Published references only, which is what the table holds.
 */
export async function countReferencesTo(
  db: D1Database,
  id: string,
): Promise<{ total: number; links: number; references: number }> {
  const { results } = await db
    .prepare('select kind, count(*) as n from content_refs where to_story = ? group by kind')
    .bind(id)
    .all<{ kind: string; n: number }>()
  const links = results.find((r) => r.kind === 'link')?.n ?? 0
  const references = results.find((r) => r.kind === 'reference')?.n ?? 0
  return { total: links + references, links, references }
}

/** The distinct documents pointing at `id`, for a warning that names them. */
export async function referencesTo(
  db: D1Database,
  id: string,
): Promise<{ from: string; kind: string }[]> {
  const { results } = await db
    .prepare(
      'select from_story as "from", kind from content_refs where to_story = ? order by "from"',
    )
    .bind(id)
    .all<{ from: string; kind: string }>()
  return results
}
