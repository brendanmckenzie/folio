/**
 * Tags: the media library's cross-cutting filter
 * (`../../docs/specs/content-model/media-library.md` decisions 4, 11, 12 and 14).
 *
 * **The slug is the identity; the name is decoration.** `tagSlug`
 * (`core/assets.ts`) lowercases, trims and drops inner whitespace, so
 * `Headshots`, `headshots` and `  Head Shots ` are one tag and not three. Every
 * lookup in this file goes through `slug` and never through `name`, and creating
 * a tag that slugifies onto an existing one **returns the existing row** rather
 * than erroring — which is what makes free-form entry with autocomplete tolerable
 * for a person, and what makes the constrained vocabulary phase 6 hands a model
 * (decision 11) a real set rather than a word cloud. Match on `name` instead and
 * the vocabulary quietly grows a near-duplicate per typist.
 *
 * **A tag is metadata, and deleting metadata must not delete content**
 * (decision 14). `deleteTag` removes `asset_taggings` rows and the `asset_tags`
 * row. There is no statement in this file that touches `assets`, and there must
 * never be one: an editor tidying up a vocabulary must not be able to destroy
 * forty photographs by doing it.
 *
 * **The bind budget is the reason for two numbers here**, not taste:
 *
 *  - `MAX_TAG_FILTER` is 8 because the AND filter binds one parameter per tag
 *    plus one for the `having` (`assets.ts`'s `assetFilterSql`), and `db.ts`'s
 *    `D1_BIND_CAP` is 100 per statement with the rest of the filter and the
 *    keyset sharing it.
 *  - `tagsForAssets` and `setAssetTags` bind **caller-sized** lists — a page of
 *    the grid's assets, an editor's whole tag set — so both go through
 *    `bindChunks`. That shape has been a live bug in this repo twice; it is
 *    chunked here so no call site has to remember.
 */
import { type AssetTag, tagSlug } from '../core/assets'
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import { bindChunks, type FolioDb } from './db'
import { FolioError } from './errors'
import { type Keyset, keysetWhere, orderBy, whereOf } from './keyset'

/**
 * How many tags one filter may AND together.
 *
 * **A bind budget, not a product decision.** `assetFilterSql`'s tag clause binds
 * one parameter per slug plus one for `having count(*) = ?`, and `D1_BIND_CAP`
 * is 100 for the *whole* statement — which also carries `q`'s five, `kind`'s
 * one, `folder`'s three, the keyset's and the `limit`. Eight leaves the rest of
 * the filter room to grow without the cap becoming a surprise later. Raising it
 * is an arithmetic exercise against `BIND_BUDGET`, not a debate.
 */
export const MAX_TAG_FILTER = 8

/**
 * How many tags one asset may carry through a single `PATCH`.
 *
 * Unlike `MAX_TAG_FILTER` this is a bound on a request body rather than on a
 * statement — `setAssetTags` chunks, so the binds are safe at any length — and it
 * exists so an unbounded array cannot be parsed and turned into statements. Fifty
 * is far past what anybody tags a photograph with.
 */
export const MAX_ASSET_TAGS = 50

/**
 * The one ordering, and — like `asset-folders.ts`'s `path` — the only kind of
 * keyset `keyset.ts` allows a single column for: `slug` is `unique`, so it is
 * already a total order and a tiebreak clause could never fire.
 *
 * Qualified with the table alias because the counted variant joins
 * `asset_taggings`, and one `Keyset` shared by both spellings is what keeps the
 * resume comparison and the `order by` from disagreeing about which list they
 * are paging.
 */
const TAG_ORDER: Keyset = { columns: ['t.slug'], direction: 'asc' }

/** `tag_<12 hex>`, minted exactly the way `uploadAsset` mints an asset id. */
export function newTagId(): string {
  return `tag_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export async function tagById(db: FolioDb, id: string): Promise<AssetTag | null> {
  return db.prepare('select id, name, slug from asset_tags where id = ?').bind(id).first<AssetTag>()
}

/** By slug, which is the identity. There is deliberately no `tagByName`. */
export async function tagBySlug(db: FolioDb, slug: string): Promise<AssetTag | null> {
  return db
    .prepare('select id, name, slug from asset_tags where slug = ?')
    .bind(slug)
    .first<AssetTag>()
}

export interface ListTagsOptions {
  limit?: number
  cursor?: string
  /**
   * Adds `count` — how many assets carry each tag — to every row on the page.
   *
   * Opt-in for `?count=1`'s reason (`../../docs/specs/foundation/pagination.md`
   * decision 5): a sidebar rendering chips wants it, an autocomplete typing into
   * a picker does not, and the unasked-for case should not pay a `group by` over
   * the join table.
   *
   * Note there is **no `count` (singular) here**, unlike `listFolders`. Two
   * options one letter apart, one meaning "the total number of tags" and the
   * other "the number of assets per tag", is the `{base}/asset/:key` versus
   * `{base}/api/assets` trap written into an options object. The vocabulary is
   * hundreds of rows and a caller that wants its size pages it.
   */
  counts?: boolean
}

/**
 * The vocabulary, paged over `slug` — so the page order is the order a chip list
 * renders in, alphabetically by identity rather than by whatever case somebody
 * typed first.
 *
 * The counted variant is **one statement**, not a second query joined in
 * JavaScript: a `left join` and a `group by` give a tag nothing has been filed
 * under a `count` of 0, which is exactly the row an editor needs to see to
 * delete it.
 *
 * The same 100/500 default and ceiling as `listFolders`, for the same reason:
 * this is a sidebar that wants its whole list, not a table of user-uploaded rows.
 */
export async function listTags(db: FolioDb, opts: ListTagsOptions = {}): Promise<Page<AssetTag>> {
  const limit = clampLimit(opts.limit, 100, 500)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const resume = keysetWhere(TAG_ORDER, cursor)

  // `"count"` is quoted because it is also a function name; SQLite reads a
  // double-quoted token as an identifier, so the alias cannot be mistaken.
  const select = opts.counts
    ? `select t.id, t.name, t.slug, count(g.asset_id) as "count"
         from asset_tags t left join asset_taggings g on g.tag_id = t.id`
    : 'select t.id, t.name, t.slug from asset_tags t'
  const group = opts.counts ? 'group by t.id' : ''

  const { results } = await db
    .prepare(`${select} ${whereOf(resume.sql)} ${group} ${orderBy(TAG_ORDER)} limit ?`)
    .bind(...resume.binds, limit + 1)
    .all<AssetTag>()

  return paginate(results, limit, (row) => [row.slug])
}

/**
 * The tag for `name`, creating it only if its **slug** is new.
 *
 * `created` is what the route turns into 201 versus 200, and it is the whole
 * contract: a client that types `Headshots` where `headshot` already exists gets
 * `headshot` back and files the asset under the tag that already has forty
 * photographs in it. Matching on `name` instead would mint a second row, and the
 * two would then split every filter that used either.
 *
 * **`insert … on conflict (slug) do nothing`, then read back**, rather than
 * read-then-insert. Two callers creating the same tag in the same instant is not
 * hypothetical — it is two editors typing into an autocomplete — and the
 * read-then-insert form answers one of them a `UNIQUE constraint failed` that
 * `errors.ts` has no pattern for. The `unique` index is the arbiter and the
 * read-back is what says who won.
 */
export async function ensureTag(
  db: FolioDb,
  name: string,
): Promise<{ tag: AssetTag; created: boolean }> {
  const slug = tagSlug(name)
  if (slug === '') throw new FolioError('bad_request', 'A tag name cannot be blank')

  const id = newTagId()
  await db
    .prepare(
      `insert into asset_tags (id, name, slug, created_at) values (?, ?, ?, ?)
         on conflict (slug) do nothing`,
    )
    .bind(id, name.trim(), slug, Date.now())
    .run()

  const tag = await tagBySlug(db, slug)
  // Unreachable: the insert either wrote this row or lost to one that is there.
  if (!tag) throw new FolioError('conflict', `Could not create the tag '${slug}'`)
  return { tag, created: tag.id === id }
}

/**
 * Renames a tag, re-slugging it — and **refuses to merge**.
 *
 * A rename onto another tag's slug is a 409 naming it, not a silent merge. A
 * merge would rewrite `asset_taggings` rows for assets the editor is not looking
 * at and cannot undo, which is decision 14's instinct applied to the operation
 * one step before a delete. Renaming *within* one slug — `head shots` to
 * `Headshots` — changes only what is displayed and is always allowed, because it
 * is the same tag by the only identity there is.
 */
export async function renameTag(db: FolioDb, id: string, name: string): Promise<AssetTag | null> {
  const row = await tagById(db, id)
  if (!row) return null

  const slug = tagSlug(name)
  if (slug === '') throw new FolioError('bad_request', 'A tag name cannot be blank')
  if (slug !== row.slug) {
    const clash = await tagBySlug(db, slug)
    if (clash) {
      throw new FolioError('conflict', `A tag named '${clash.name}' already occupies '${slug}'`)
    }
  }

  const renamed = { ...row, name: name.trim(), slug }
  await db
    .prepare('update asset_tags set name = ?, slug = ? where id = ?')
    .bind(renamed.name, renamed.slug, id)
    .run()
  return renamed
}

export interface TagDeletion {
  /** Assets that carried this tag and no longer do. **None of them was deleted.** */
  removedFrom: number
}

/**
 * Deletes a tag and its taggings, and **nothing else** (decision 14).
 *
 * `asset_taggings` rows go; `assets` rows do not, and no R2 object is touched. A
 * tag is a way of finding files, and an editor pruning a vocabulary they no
 * longer use must not discover that they have deleted the files as well.
 *
 * The count is read before the batch so the dialog can say what happened rather
 * than guess. Both statements commit together, so a reader can never see a
 * tagging row pointing at a tag that is gone.
 */
export async function deleteTag(db: FolioDb, id: string): Promise<TagDeletion | null> {
  const row = await tagById(db, id)
  if (!row) return null

  const used = await db
    .prepare('select count(*) as n from asset_taggings where tag_id = ?')
    .bind(id)
    .first<{ n: number }>()

  await db.batch([
    db.prepare('delete from asset_taggings where tag_id = ?').bind(id),
    db.prepare('delete from asset_tags where id = ?').bind(id),
  ])

  return { removedFrom: used?.n ?? 0 }
}

/**
 * The tags for a set of ids, slug-ordered, chunked so no caller can overrun the
 * bind cap.
 *
 * Duplicates are collapsed first, so `ids` is really "the distinct ids", and the
 * chunking is **by asset**: every row for one asset therefore lands in one
 * statement, which is what makes the per-asset `order by t.slug` a real ordering
 * rather than one that holds until the page crosses a chunk boundary.
 */
export async function tagsByIds(db: FolioDb, ids: readonly string[]): Promise<AssetTag[]> {
  const pages = await Promise.all(
    bindChunks([...new Set(ids)], 1).map(async (chunk) => {
      const { results } = await db
        .prepare(
          `select id, name, slug from asset_tags
            where id in (${chunk.map(() => '?').join(', ')}) order by slug asc`,
        )
        .bind(...chunk)
        .all<AssetTag>()
      return results
    }),
  )
  return pages.flat()
}

/**
 * Every listed asset's tags in one read, keyed by asset id.
 *
 * **This is the shape that must chunk.** The grid asks for a whole page of
 * assets' tags at once and a page is up to 200 rows, which is twice
 * `D1_BIND_CAP` on its own; `bindChunks` sizes the statements from
 * `BIND_BUDGET`. An asset carrying no tag is simply absent from the map, so a
 * caller reads `map.get(id) ?? []`.
 */
export async function tagsForAssets(
  db: FolioDb,
  ids: readonly string[],
): Promise<Map<string, AssetTag[]>> {
  const out = new Map<string, AssetTag[]>()
  if (ids.length === 0) return out

  const pages = await Promise.all(
    bindChunks([...new Set(ids)], 1).map(async (chunk) => {
      const { results } = await db
        .prepare(
          `select g.asset_id as assetId, t.id, t.name, t.slug
             from asset_taggings g join asset_tags t on t.id = g.tag_id
            where g.asset_id in (${chunk.map(() => '?').join(', ')})
            order by t.slug asc`,
        )
        .bind(...chunk)
        .all<AssetTag & { assetId: string }>()
      return results
    }),
  )

  for (const rows of pages) {
    for (const { assetId, ...tag } of rows) {
      const carried = out.get(assetId)
      if (carried) carried.push(tag)
      else out.set(assetId, [tag])
    }
  }
  return out
}

/**
 * Replaces an asset's whole tag set, and answers what it now carries.
 *
 * **Replace, not merge**, because that is what `AssetPatchBody.tags` means: the
 * editor's chip list is the truth, and removing a chip has to remove the tagging.
 * Adding and removing across a *selection* is phase 5's `runAssetBulk`, which is
 * a different operation with a different route for exactly that reason.
 *
 * **An unknown id is refused, never dropped.** `asset_taggings` has no foreign
 * key (D1 has them off, and decision 14 wants a delete to null things out rather
 * than cascade), so an id nothing is behind would insert a row that no join ever
 * returns — a tag the editor can see they applied and no filter can find. The
 * ids are read first, which also gives the caller the resolved rows for free.
 *
 * The delete and the inserts are one batch, so a failed insert cannot leave the
 * asset with fewer tags than it started with. `bindChunks(…, 2)` sizes the
 * inserts: two binds per row, and the whole set is caller-supplied.
 */
export async function setAssetTags(
  db: FolioDb,
  assetId: string,
  tagIds: readonly string[],
): Promise<AssetTag[]> {
  const wanted = [...new Set(tagIds)]
  const tags = wanted.length === 0 ? [] : await tagsByIds(db, wanted)
  if (tags.length !== wanted.length) {
    const known = new Set(tags.map((tag) => tag.id))
    const missing = wanted.find((id) => !known.has(id))
    throw new FolioError('bad_request', `Unknown tag '${missing}'`)
  }

  const statements = [db.prepare('delete from asset_taggings where asset_id = ?').bind(assetId)]
  for (const chunk of bindChunks(tags, 2)) {
    statements.push(
      db
        .prepare(
          `insert into asset_taggings (asset_id, tag_id)
             values ${chunk.map(() => '(?, ?)').join(', ')}`,
        )
        .bind(...chunk.flatMap((tag) => [assetId, tag.id])),
    )
  }
  await db.batch(statements)
  return tags
}
