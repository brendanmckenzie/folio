/**
 * The Documents screen's arithmetic: which columns a type has, what a cell reads,
 * which of those columns can be sorted, and how the screen's state gets into and
 * out of a URL.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node test
 * can reach it. `content-model.ts` is the pattern and this is the second instance
 * of it.
 *
 * It replaces the pure half of `DataTable.tsx` — `dataColumns`, `cellText`,
 * `sortRows`, `filterRows`, `pageCount` — of which only the first two survive as
 * ideas. The other three were **client-side** sorting, searching and paging over a
 * list the admin had already fetched whole, and all three are now the server's
 * (`GET {base}/api/documents`). That is the shape of this port: half the file was
 * doing work a route should have been doing.
 */
import { type IndexedCell, indexedFields } from "../../../core/index-projection";
import type { DocumentType, SchemaIndex } from "../../../core/schema";
import type { DocumentSort, StoryFilter, StoryMeta, StoryState } from "../../../core/story";

/* -------------------------------------------------------------------- rows --- */

/**
 * A row as `GET {base}/api/documents` answers it: the story, plus the values of its
 * type's `indexed` fields. Published ones, except that a caller who may read drafts
 * gets the draft's where it differs, each such cell marked `draft`
 * (`server/stories.ts`'s `DocumentRow`).
 *
 * The values are on the row rather than in a sibling map keyed by id, which is
 * what the unpaged route used to answer with. `server/stories.ts`'s `DocumentRow`
 * carries the reason; the consequence here is that a cell is a property lookup and
 * nothing has to be zipped.
 */
export interface DocumentRow extends StoryMeta {
  indexed: Record<string, IndexedCell>;
}

/* ----------------------------------------------------------------- columns --- */

export type ColumnKind = "title" | "field" | "state" | "updated";

export interface DocumentColumn {
  /** Unique, and what a sortable header reports back. */
  key: string;
  label: string;
  kind: ColumnKind;
  /** Set for `kind: 'field'`: the `indexed` field this column reads. */
  field?: string;
  /** The ordering this header asks the route for, or absent when the column
   * cannot be sorted. See `SORTABLE`. */
  sort?: DocumentSort;
}

/**
 * Which columns can be sorted: the title, last edited, and **every `field` column**
 * (`field:<name>`, issue #82), which the server orders by the value the cell shows,
 * draft or published, nulls last (`core/story.ts`'s `DocumentSort`). This was every
 * column but the `field` ones until draft values made the sort worth having.
 *
 * `documentColumns` still skips the type's `titleField` as a field column, because
 * its value *is* the title column, so "sort people by name" is `title`.
 *
 * `ord` is deliberately **not** offered by the screen even though the route
 * accepts it. It is a real ordering (`createStory` appends, so it reads as the
 * order documents were added) with nothing to show for itself: `stories` has no
 * `created_at`, so there is no cell whose value the ordering would explain. A sort
 * whose result a person cannot verify against anything on screen is a sort that
 * looks broken.
 */
const SORTABLE: Partial<Record<ColumnKind, DocumentSort>> = {
  title: "title",
  updated: "edited",
};

/**
 * The columns for one type: its title, then its root block's `indexed` fields, then
 * state and last-edited.
 *
 * The type's `titleField` is skipped as a field column — its value already *is* the
 * title, since that is what the row's title is derived from, and a table showing
 * "Ada Lovelace" twice would be a bug that looks like a feature. Carried unchanged
 * from `DataTable.tsx`'s `dataColumns`, which got this right.
 */
export function documentColumns(
  schema: SchemaIndex,
  type: DocumentType,
  labelOf: (field: string, fallback: string) => string = (_f, fallback) => fallback,
): DocumentColumn[] {
  const columns: DocumentColumn[] = [
    column("title", type.titleField ? labelOf(type.titleField, "Title") : "Title", "title"),
  ];
  for (const [name, field] of indexedFields(schema, type.root)) {
    if (name === type.titleField) continue;
    columns.push({
      ...column(`f:${name}`, field.label ?? name, "field"),
      field: name,
      sort: `field:${name}`,
    });
  }
  columns.push(column("state", "Status", "state"));
  columns.push(column("updated", "Last edited", "updated"));
  return columns;
}

function column(key: string, label: string, kind: ColumnKind): DocumentColumn {
  const sort = SORTABLE[kind];
  return { key, label, kind, ...(sort ? { sort } : {}) };
}

/**
 * What one cell shows, for every kind except `state` and `updated` — those two are
 * a badge and a relative timestamp, which are the component's business rather than
 * a string's.
 *
 * `''` for a field with no value, published or (where the caller may read drafts)
 * in the draft. The screen turns that into a dash. A value from the draft that the
 * published copy does not have is marked by `isDraftCell`; for a caller who may not
 * read drafts the cells are published values only, and the row's `changed` badge
 * is what says they may disagree with the document.
 */
export function cellText(row: DocumentRow, column: DocumentColumn): string {
  if (column.kind === "title") return row.title;
  if (column.kind === "field") return row.indexed[column.field ?? ""]?.text ?? "";
  return "";
}

/**
 * Does this row's published snapshot disagree with its draft?
 *
 * On this screen a `changed` row is one where a cell may not say what the document
 * currently says: a caller who may read drafts sees the draft values marked
 * `draft`, and one who may not sees published ones, so the badge is the only hint.
 * A stronger claim than Content's badge, which only says there is something to
 * publish.
 */
export function isStale(row: Pick<DocumentRow, "state">): boolean {
  return row.state === "changed";
}

/* --------------------------------------------------------------------- URL --- */

/** The state filter's "no filter" value. A chip needs a value for "All", and
 * `undefined` cannot be one. Same shape as Content's. */
export type StateFilter = "all" | StoryState;

export interface DocumentsUrl {
  sort: DocumentSort;
  /** Absent means the sort's own natural direction — `title` ascending, `edited`
   * newest first. Only present once somebody has clicked a header twice. */
  dir: "asc" | "desc" | undefined;
  state: StateFilter;
  q: string;
}

export function parseDocumentsUrl(query: Readonly<Record<string, string>>): DocumentsUrl {
  return {
    sort: isDocumentSort(query.sort) ? query.sort : "title",
    dir: query.dir === "asc" || query.dir === "desc" ? query.dir : undefined,
    state: isStateFilter(query.state) ? query.state : "all",
    q: query.q ?? "",
  };
}

/**
 * The inverse, as the query object `href` takes. Defaults are written as
 * `undefined` so they leave the URL rather than sitting in it: `?sort=title&dir=asc`
 * says exactly what the bare path says.
 */
export function documentsQuery(url: DocumentsUrl): Record<string, string | undefined> {
  return {
    sort: url.sort === "title" ? undefined : url.sort,
    dir: url.dir === naturalDir(url.sort) ? undefined : url.dir,
    state: url.state === "all" ? undefined : url.state,
    q: url.q || undefined,
  };
}

/**
 * Each sort's own direction — the one a header shows on its first click.
 *
 * Alphabetical ascending and newest-edited-first are both what a person means by
 * clicking the column once. The route knows the same thing (`?dir=` is absent for
 * it), so this is stated in two places on purpose and they have to agree: the URL
 * is written here and read there.
 */
export function naturalDir(sort: DocumentSort): "asc" | "desc" {
  return sort === "edited" ? "desc" : "asc";
}

/** The direction in force, resolving the absent case. */
export function dirOf(url: DocumentsUrl): "asc" | "desc" {
  return url.dir ?? naturalDir(url.sort);
}

/**
 * What clicking a sortable header means: the same column flips direction, a
 * different one starts at its own natural direction.
 *
 * The second half is the part worth stating. Carrying the previous column's
 * direction over is the obvious implementation and it is wrong — clicking `Last
 * edited` while sorted `Z→A` would give you oldest-first, which nobody asked for
 * and which reads as a bug rather than a preserved preference.
 */
export function withSort(url: DocumentsUrl, sort: DocumentSort): DocumentsUrl {
  if (url.sort !== sort) return { ...url, sort, dir: naturalDir(sort) };
  return { ...url, dir: dirOf(url) === "asc" ? "desc" : "asc" };
}

/**
 * The `StoryFilter` a URL means. `type` is absent because it is the screen's
 * *identity* — it is in the path, not the query — and the route takes it as its own
 * argument for the same reason.
 */
export function filterOf(url: DocumentsUrl): StoryFilter {
  return {
    ...(url.state === "all" ? {} : { state: url.state }),
    ...(url.q.trim() ? { q: url.q.trim() } : {}),
  };
}

/**
 * Telling "no records yet" from "nothing matches", which are different empty
 * states — offering *clear filters* under the first is offering to clear nothing.
 */
export function isNarrowed(filter: StoryFilter): boolean {
  return Boolean(filter.state || filter.q);
}

/**
 * The request `GET {base}/api/documents` gets for a screen state.
 *
 * One function so the URL the screen shows and the request it makes cannot
 * disagree — the same rule `content-model.ts`'s `filterParams` follows, and here it
 * also covers the sort, which is the parameter the two could most easily drift on.
 */
export function documentsParams(
  url: DocumentsUrl,
  type: string,
  opts: { limit: number; cursor?: string | null; count?: boolean },
): URLSearchParams {
  const filter = filterOf(url);
  const params = new URLSearchParams({
    type,
    sort: url.sort,
    dir: dirOf(url),
    limit: String(opts.limit),
  });
  if (filter.state) params.set("state", filter.state);
  if (filter.q) params.set("q", filter.q);
  if (opts.count) params.set("count", "1");
  if (opts.cursor) params.set("cursor", opts.cursor);
  return params;
}

function isDocumentSort(raw: string | undefined): raw is DocumentSort {
  return (
    raw === "ord" || raw === "title" || raw === "edited" || (raw?.startsWith("field:") ?? false)
  );
}

/**
 * The URL, with a `field:` sort that names no column of this type put back to the
 * default. A stale or hand-typed `?sort=field:gone` would otherwise be a 400 and an
 * error screen for a list that is perfectly readable in its default order.
 */
export function knownSort(url: DocumentsUrl, columns: readonly DocumentColumn[]): DocumentsUrl {
  if (!url.sort.startsWith("field:") || columns.some((c) => c.sort === url.sort)) return url;
  return { ...url, sort: "title", dir: undefined };
}

/**
 * Whether a cell's value is the draft's, so the screen can mark it. Absent for any
 * column that is not a field, and for a value the published copy already agrees
 * with: the server sets `draft` only where the two differ.
 */
export function isDraftCell(row: DocumentRow, column: DocumentColumn): boolean {
  return column.kind === "field" && row.indexed[column.field ?? ""]?.draft === true;
}

function isStateFilter(raw: string | undefined): raw is StateFilter {
  return (
    raw === "all" || raw === "draft" || raw === "live" || raw === "changed" || raw === "unpublished"
  );
}
