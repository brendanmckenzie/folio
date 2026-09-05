/**
 * Folders: the media library's browse spine
 * (`../../docs/specs/content-model/media-library.md` decisions 1, 3 and 14).
 *
 * **A folder is metadata and nothing else.** It is never part of an R2 key and
 * never part of a URL (decision 1): an asset's key is minted once by
 * `uploadAsset` and baked into published HTML through `Resolution.assetBase`, so
 * filing a file sets one column on one row and issues no R2 operation. Nothing
 * in this file touches a bucket, and nothing in it may ever start to.
 *
 * **The structure is `parent_id`; the query is `path`** — a slash-joined chain of
 * slugified ancestor names, this folder last, `unique`, recomputed on rename and
 * on move. That is `stories.path`'s shape (`core/story.ts`'s `derivePaths`) and
 * it is copied on purpose. Three properties follow and each is load-bearing:
 *
 *  - **Descendant filtering is a range, not a recursion.** No recursive CTE, no
 *    materialising a list of ids, and — the part that matters most here — **no
 *    caller-sized bind list**. Every statement in this file binds a fixed number
 *    of parameters (five at the widest), so `D1_BIND_CAP` cannot be reached by a
 *    deep tree, a wide one, or a folder holding forty thousand assets. That is
 *    the reason to prefer the materialised path over an id list, not a
 *    micro-optimisation.
 *  - **`order by path` is depth-first *and* alphabetical among siblings**, by
 *    construction, so `listFolders` keyset-pages like every other list and a
 *    client appends rows to a tree in arrival order with no sort of its own.
 *  - **A subtree move is one statement**, below.
 *
 * **The range is a comparison, never `like`.** SQLite's `LIKE` is
 * case-insensitive for ASCII by default, so `path like 'shoots%'` both matches
 * rows it must not — `shoots-2024` is a *sibling* of `shoots`, not a child — and
 * cannot use the index on `path`. `'/'` is `0x2F` and `'0'` is `0x30`, and
 * nothing else in ASCII sits between them, so every descendant of `p` and no
 * other row sorts inside `[p || '/', p || '0')`. Getting this wrong is not a
 * slow query, it is a subtree of somebody else's folders silently moved.
 *
 * **Deleting a folder deletes no asset and no descendant** (decision 14).
 * Children re-parent to the deleted folder's own parent and its assets land back
 * in *Unfiled*. Filing is meant to be cheap to undo: an editor who miscategorised
 * forty photographs must not be able to delete them by tidying up.
 */
import type { AssetFolder } from '../core/assets'
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import { slugify } from '../core/story'
import type { FolioDb } from './db'
import { FolioError } from './errors'
import { type Keyset, keysetWhere, orderBy, whereOf } from './keyset'

const COLS = `id, parent_id as parentId, name, path, created_at as createdAt`

/**
 * The one ordering, and the only list in this repo whose keyset is a single
 * column — legal because `path` is `unique`, which is what `keyset.ts` requires
 * of a lone component. It is also the whole point of decision 3: this ordering
 * *is* tree order, so paging it needs no second column and no client-side sort.
 */
const FOLDER_ORDER: Keyset = { columns: ['path'], direction: 'asc' }

/** `fld_<12 hex>`, minted exactly the way `uploadAsset` mints an asset id. */
export function newFolderId(): string {
  return `fld_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * `path` and everything under it, as a `where` fragment with its binds.
 *
 * The half-open range is stated here once so no caller writes it again: the
 * equality picks the folder itself, and `(> p || '/' and < p || '0')` picks every
 * descendant and nothing else. A prefix `like` would additionally sweep in every
 * *sibling* whose name starts with this one's — `Shoots 2024` next to `Shoots` —
 * which on a move is a silent, unrecoverable mangling of rows nobody touched.
 *
 * `column` is a caller-supplied SQL identifier and never a value: the two call
 * sites pass `'path'` and `'f.path'`. It is not bound and must never become
 * something a request can choose.
 */
export function subtreeWhere(column: string, path: string): { sql: string; binds: string[] } {
  return {
    sql: `(${column} = ? or (${column} > ? and ${column} < ?))`,
    binds: [path, `${path}/`, `${path}0`],
  }
}

/**
 * The same range with the folder itself excluded, for the one operation where
 * the named row is going away rather than moving: `deleteFolder` rewrites its
 * descendants and then deletes it, and including it would rewrite a path that is
 * about to stop existing.
 *
 * Two builders rather than one with a flag, following `clearIndexStatements` /
 * `clearInboundRefStatements`: the difference between them is a correctness
 * decision at each call site and a boolean argument hides which one was meant.
 */
export function descendantsWhere(column: string, path: string): { sql: string; binds: string[] } {
  return { sql: `(${column} > ? and ${column} < ?)`, binds: [`${path}/`, `${path}0`] }
}

/** Where a folder named `name` sits under `parentPath` (null for the top level). */
function childPath(parentPath: string | null, name: string): string {
  const slug = slugify(name)
  return parentPath ? `${parentPath}/${slug}` : slug
}

export async function folderById(db: FolioDb, id: string): Promise<AssetFolder | null> {
  return db.prepare(`select ${COLS} from asset_folders where id = ?`).bind(id).first<AssetFolder>()
}

export async function folderByPath(db: FolioDb, path: string): Promise<AssetFolder | null> {
  return db
    .prepare(`select ${COLS} from asset_folders where path = ?`)
    .bind(path)
    .first<AssetFolder>()
}

export interface ListFoldersOptions {
  limit?: number
  cursor?: string
  /** Adds `total`. One extra `count(*)`, only when asked
   * (`../../docs/specs/foundation/pagination.md` decision 5). */
  count?: boolean
}

/**
 * The tree, paged — and the page order *is* the tree order, which is the
 * property `path` was denormalised for. A client renders rows as they arrive:
 * every folder appears after its parent and siblings appear alphabetically,
 * because that is what sorting a slugified materialised path does.
 *
 * A higher default and ceiling than the asset lists (100/500 against 50/200):
 * this is a sidebar that wants the whole tree, over a table bounded by folders
 * somebody created by hand.
 */
export async function listFolders(
  db: FolioDb,
  opts: ListFoldersOptions = {},
): Promise<Page<AssetFolder>> {
  const limit = clampLimit(opts.limit, 100, 500)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const resume = keysetWhere(FOLDER_ORDER, cursor)

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLS} from asset_folders ${whereOf(resume.sql)} ${orderBy(FOLDER_ORDER)} limit ?`,
      )
      .bind(...resume.binds, limit + 1)
      .all<AssetFolder>(),
    // The count ignores the cursor deliberately, the same as every other list: it
    // counts the whole table, which is what a header means by "of 43".
    opts.count
      ? db.prepare('select count(*) as n from asset_folders').first<{ n: number }>()
      : null,
  ])

  const page = paginate(rows.results, limit, (row) => [row.path])
  return total ? { ...page, total: total.n } : page
}

/**
 * Refuses a path another folder already occupies, naming it.
 *
 * A 409 rather than a silent de-duplication: two siblings whose names slugify
 * identically are *different names*, and the editor is the one who should choose
 * which survives. The `unique` on `path` would refuse the write anyway, but D1's
 * constraint text names the table and the column and `errors.ts`'s pattern for it
 * answers with a message about *stories* — so the check is here, before the
 * write, where the message can say what actually happened.
 */
async function refuseCollision(db: FolioDb, path: string, exceptId: string | null): Promise<void> {
  const clash = await db
    .prepare('select id, name from asset_folders where path = ?')
    .bind(path)
    .first<{ id: string; name: string }>()
  if (clash && clash.id !== exceptId) {
    throw new FolioError('conflict', `A folder named '${clash.name}' already occupies '${path}'`)
  }
}

export interface CreateFolderInput {
  name: string
  parentId?: string | null
}

export async function createFolder(db: FolioDb, input: CreateFolderInput): Promise<AssetFolder> {
  const parentId = input.parentId ?? null
  const parent = parentId === null ? null : await folderById(db, parentId)
  if (parentId !== null && !parent) throw new FolioError('bad_request', 'Unknown parent folder')

  const path = childPath(parent?.path ?? null, input.name)
  await refuseCollision(db, path, null)

  const row: AssetFolder = {
    id: newFolderId(),
    parentId,
    name: input.name,
    path,
    createdAt: Date.now(),
  }
  await db
    .prepare(
      'insert into asset_folders (id, parent_id, name, path, created_at) values (?, ?, ?, ?, ?)',
    )
    .bind(row.id, row.parentId, row.name, row.path, row.createdAt)
    .run()
  return row
}

export interface FolderPatch {
  name?: string
  /** `null` is the top level. Absent means "leave the parent alone", which is
   * why this is checked with `!== undefined` and never for truthiness. */
  parentId?: string | null
}

/**
 * Renames and/or moves a folder, and rewrites its whole subtree's paths.
 *
 * **A rename and a move are the same operation on a materialised path** — work
 * out my new path, then rewrite mine and everything under it — so there is one
 * implementation of the statement that does it. `renameFolder` and `moveFolder`
 * below are the two names the spec's phase plan uses; they are wrappers, on
 * purpose, because two copies of this statement is how the two come to disagree
 * about the range.
 *
 * The rewrite:
 *
 * ```sql
 * update asset_folders
 *    set path = ? || substr(path, length(?) + 1)
 *  where (path = ? or (path > ? and path < ?))
 * ```
 *
 * Five binds, whatever the shape of the tree. `substr(path, length(?) + 1)` takes
 * the old path's *own* length from SQLite rather than from JavaScript: `String`'s
 * `length` counts UTF-16 code units and SQLite's `length()` counts characters, and
 * a folder named with an astral character would otherwise cut one byte short and
 * corrupt every descendant beneath it.
 *
 * **The cycle check is a string comparison**, which is the whole reason the path
 * is materialised: a destination is illegal exactly when it is inside my own
 * subtree, and `parent.path === mine || parent.path.startsWith(mine + '/')` is
 * that question. Moving a folder into itself is the same test — a self-move makes
 * `parent.path` equal to mine — so there is one guard and not two. Missing it
 * detaches a subtree from the tree with no recursive query anywhere here to find
 * it again, which is why it is checked before anything is written and why
 * `test/workers/asset-folders.test.ts` pins both spellings of it.
 */
export async function updateFolder(
  db: FolioDb,
  id: string,
  patch: FolderPatch,
): Promise<AssetFolder | null> {
  const row = await folderById(db, id)
  if (!row) return null

  const name = patch.name ?? row.name
  const parentId = patch.parentId !== undefined ? patch.parentId : row.parentId

  let parentPath: string | null = null
  if (parentId !== null) {
    const parent = await folderById(db, parentId)
    if (!parent) throw new FolioError('bad_request', 'Unknown parent folder')
    if (parent.path === row.path || parent.path.startsWith(`${row.path}/`)) {
      throw new FolioError(
        'conflict',
        parent.id === id
          ? `Cannot move '${row.name}' into itself ('${row.path}')`
          : `Cannot move '${row.name}' into its own descendant ('${parent.path}')`,
      )
    }
    parentPath = parent.path
  }

  const path = childPath(parentPath, name)
  if (path === row.path && name === row.name && parentId === row.parentId) return row
  if (path !== row.path) await refuseCollision(db, path, id)

  const range = subtreeWhere('path', row.path)
  await db.batch([
    db
      .prepare(
        `update asset_folders set path = ? || substr(path, length(?) + 1) where ${range.sql}`,
      )
      .bind(path, row.path, ...range.binds),
    // By id, and after the rewrite, which matched on the old path. `name` and
    // `parent_id` are the structure; `path` is the query key derived from it.
    db
      .prepare('update asset_folders set parent_id = ?, name = ? where id = ?')
      .bind(parentId, name, id),
  ])
  return { ...row, name, parentId, path }
}

/** `updateFolder` under the name the spec's phase plan uses. One implementation
 * of the subtree rewrite, two ways to ask for it. */
export function renameFolder(db: FolioDb, id: string, name: string): Promise<AssetFolder | null> {
  return updateFolder(db, id, { name })
}

/** The same. `null` moves the folder to the top level. */
export function moveFolder(
  db: FolioDb,
  id: string,
  parentId: string | null,
): Promise<AssetFolder | null> {
  return updateFolder(db, id, { parentId })
}

export interface FolderDeletion {
  /** Direct children lifted to this folder's own parent. */
  reparented: number
  /** Assets filed directly here, now back in *Unfiled*. **Not deleted.** */
  unfiled: number
}

/**
 * Deletes a folder and **nothing else** (decision 14).
 *
 * No asset is deleted, no descendant folder is deleted, and no R2 object is
 * touched. Direct children re-parent to this folder's own parent and their whole
 * subtrees' paths shift up by one segment in one statement; assets filed directly
 * here get `folder_id = null` and land in *Unfiled*.
 *
 * The alternatives — cascade, or refuse while non-empty — fail the same way: they
 * make an organisational mistake destructive. This is `deleteAsset`'s "warn and
 * proceed" one level up.
 *
 * The whole thing is four statements in one batch, each binding at most four
 * parameters, so a folder holding forty thousand assets costs exactly what a
 * folder holding one does. That is the materialised path earning its keep: the id
 * list this would otherwise bind is the caller-sized bind list `db.ts` warns
 * about.
 *
 * **Assets whose folder was deleted mid-request** are covered by the same batch:
 * `folder_id` is not a foreign key, and the `update` that nulls them commits with
 * the `delete` that removes the row, so a reader can never see a dangling id from
 * this path.
 */
export async function deleteFolder(db: FolioDb, id: string): Promise<FolderDeletion | null> {
  const row = await folderById(db, id)
  if (!row) return null

  // The parent's path taken from my own, rather than by reading the parent row:
  // the rewrite operates on paths, so deriving the prefix from the path it is
  // rewriting cannot disagree with itself even if `parent_id` were dangling.
  const cut = row.path.lastIndexOf('/')
  const prefix = cut === -1 ? '' : `${row.path.slice(0, cut)}/`
  const range = descendantsWhere('path', row.path)

  // A child whose lifted path is already taken — delete `a/x` where both `a/x/y`
  // and `a/y` exist — refused before anything is written, and named. Only direct
  // children need checking: a grandchild can only collide if its own parent does,
  // because a path exists only where every folder along it exists.
  const clash = await db
    .prepare(
      `select c.name as name, o.path as at
         from asset_folders c
         join asset_folders o on o.path = ? || substr(c.path, length(?) + 2)
        where c.parent_id = ? and o.id <> c.id`,
    )
    .bind(prefix, row.path, id)
    .first<{ name: string; at: string }>()
  if (clash) {
    throw new FolioError(
      'conflict',
      `Cannot delete '${row.name}': its subfolder '${clash.name}' would collide with '${clash.at}'`,
    )
  }

  const [children, assets] = await Promise.all([
    db
      .prepare('select count(*) as n from asset_folders where parent_id = ?')
      .bind(id)
      .first<{ n: number }>(),
    db
      .prepare('select count(*) as n from assets where folder_id = ?')
      .bind(id)
      .first<{ n: number }>(),
  ])

  await db.batch([
    // `+ 2` rather than `+ 1`: this drops the separator too, because the segment
    // being removed is mine and the descendants are moving up a level.
    db
      .prepare(
        `update asset_folders set path = ? || substr(path, length(?) + 2) where ${range.sql}`,
      )
      .bind(prefix, row.path, ...range.binds),
    db.prepare('update asset_folders set parent_id = ? where parent_id = ?').bind(row.parentId, id),
    db.prepare('update assets set folder_id = null where folder_id = ?').bind(id),
    db.prepare('delete from asset_folders where id = ?').bind(id),
  ])

  return { reparented: children?.n ?? 0, unfiled: assets?.n ?? 0 }
}
