/**
 * `ContentQuery` → SQL (`../../docs/specs/content-model/collections.md`
 * architecture decision 4).
 *
 * The shape of a query, its canonical form and its key live in `core/query.ts`,
 * because the admin and the renderer share them. This file is the half that knows
 * about D1, and it has three jobs and no others: refuse a field the schema does not
 * declare `indexed`, bind every value, and clamp the page.
 *
 * **Nothing is interpolated.** Every table and column name in here is a literal;
 * the only names a caller supplies — a document type, a field, a locale — are
 * *values* in this schema and travel as binds. So there is no string a client can
 * send that reaches SQL as SQL, and the `indexed` check exists for a different
 * reason: a filter on a field nobody indexed must be a 400 naming the field, never
 * a silent empty result. That is the failure mode that costs an afternoon.
 *
 * Offset pagination, not keyset (decision 2). Keyset is strictly better at scale
 * and the scale is wrong: a CMS index page is hundreds of rows deep, not millions,
 * and offset is what lets a page render "page 4 of 9" — which keyset cannot without
 * a count anyway. Revisit past ~10k rows in one collection.
 */
import type { Blok, Doc } from "../core/doc";
import type { LocaleContext } from "../core/locales";
import {
  BUILT_IN_ORDERS,
  type ContentItem,
  type ContentPage,
  type ContentQuery,
  type ContentSlice,
  type ContentWhere,
  isRangeOp,
  MAX_PER_PAGE,
  normaliseQuery,
} from "../core/query";
import { dataOf } from "../core/locales";
import { ftsQuery, splitSnippet } from "../core/search-projection";
import { projectValue } from "../core/index-projection";
import type { StoryMeta } from "../core/story";
import { FolioError } from "./errors";
import { LIKE_ESCAPE, likePattern } from "./like";
import { SINGLE_SITE_CHAIN } from "../core/sites";
import { servedClause, STORY_COLS, type StoryRow, toStoryMeta } from "./stories";
import { D1_BIND_CAP, type FolioDb } from "./db";

/** A statement's text and its binds, kept together so a test can read both. */
export interface Sql {
  text: string;
  binds: unknown[];
}

/** The three columns the search statement adds to a story row. Absent from
 * every non-search query, which is why each is optional here. */
interface SearchRow {
  score?: number;
  snippet?: string | null;
  fts_rowid?: number;
}

/** `stories` columns the built-in sort keys name. */
const BUILT_IN_COLUMNS: Readonly<Record<string, string>> = {
  publishedAt: "stories.published_at",
  ord: "stories.ord",
  title: "stories.title",
};

/**
 * One `where` clause as an `exists` (or `not exists`) subquery against
 * `(story_id, locale, field)` — the leading columns of `content_index`'s primary
 * key, so each one is an index seek. Several clauses are anded.
 */
function wherePredicate(w: ContentWhere, locale: string, n: number): Sql {
  const alias = `ci${n}`;
  const head = `select 1 from content_index ${alias}
     where ${alias}.story_id = stories.id and ${alias}.locale = ? and ${alias}.field = ?`;
  const binds: unknown[] = [locale, w.field];

  if (isRangeOp(w.op)) {
    const op = w.op === "gt" ? ">" : w.op === "gte" ? ">=" : w.op === "lt" ? "<" : "<=";
    // A numeric bound compares `num_value`, a string bound `text_value`. An ISO
    // date is stored in both columns, so either spelling of "since March" works.
    const column = typeof w.value === "number" ? "num_value" : "text_value";
    binds.push(w.value);
    return { text: `exists (${head} and ${alias}.${column} ${op} ?)`, binds };
  }

  switch (w.op) {
    case "eq":
      binds.push(scalar(w.value));
      return { text: `exists (${head} and ${alias}.text_value = ?)`, binds };
    case "ne": {
      // `not exists`, deliberately, so a document with **no value** for the field
      // matches. "topic is not 'ai'" is true of an insight with no topic, and an
      // `exists (… <> ?)` would silently exclude every one of them.
      binds.push(scalar(w.value));
      return { text: `not exists (${head} and ${alias}.text_value = ?)`, binds };
    }
    case "in": {
      const values = Array.isArray(w.value) ? w.value : [w.value];
      if (values.length === 0) return { text: "0 = 1", binds: [] };
      const holes = values.map(() => "?").join(", ");
      binds.push(...values);
      return { text: `exists (${head} and ${alias}.text_value in (${holes}))`, binds };
    }
    case "startsWith":
      binds.push(likePattern(String(scalar(w.value)), { leading: false }));
      return { text: `exists (${head} and ${alias}.text_value like ? ${LIKE_ESCAPE})`, binds };
    case "contains":
      binds.push(likePattern(String(scalar(w.value))));
      return { text: `exists (${head} and ${alias}.text_value like ? ${LIKE_ESCAPE})`, binds };
  }
}

const scalar = (value: string | number | readonly string[]): string | number =>
  Array.isArray(value) ? (value[0] ?? "") : (value as string | number);

/**
 * What `contentSql` needs of `ResolvedGate` (`gate.ts`) to scope a search
 * (`../../docs/specs/content-model/full-text-search.md` decision 11). Structural
 * rather than the resolved object itself, so this file stays a pure compiler
 * with no opinion about how a gate is configured or validated.
 */
export interface SearchGate {
  /** The root-block field holding the gate value. `indexed: true`, guaranteed. */
  field: string;
  /** The one value that means "no gate". */
  public: string | number | boolean;
  /**
   * The **document type** names whose root declares the field — `stories.type`,
   * which is the only thing SQL can see. Not the root block names: SQL cannot
   * see those, and two types may share one root.
   */
  types: ReadonlySet<string>;
}

/**
 * Decision 11: on a gated deployment a search is scoped to the gate's public
 * value, because `snippet()` hands back a marked extract of precisely the prose
 * `redactDoc` exists to withhold.
 *
 * **The predicate keys off `stories.type`, and that is the load-bearing line in
 * this file.** `projectValue` answers null for an absent value, so a document
 * with no value for an indexed field gets *no* `content_index` row — which makes
 * two very different documents identical to any test for a missing row: a
 * `record` whose root never declares the gate field, which must stay searchable,
 * and a gated `page` that declares it and holds nothing, which spec 31
 * checkpoint 2 fails **closed**. `exists … or not exists …` would admit the
 * second and silently reverse that checkpoint; requiring the row outright would
 * exclude the first and make records unsearchable. The type list tells them
 * apart: absence from it means "this type has no gate at all", and a declaring
 * type with no value falls to the `exists` and is excluded, which is what
 * fail-closed means here.
 */
function gatePredicate(gate: SearchGate, locale: string): Sql {
  const types = [...gate.types];
  const holes = types.map(() => "?").join(", ");
  // The value as `content_index` stores it, through the same function publish
  // wrote the row with: a `boolean` is 'true'/'false' there and a `number` is
  // its digits, so comparing against the raw config value would compare a
  // boolean bind to a text column. Null (an empty-string `public`) binds `''`,
  // which no row holds either — the same exclusion, arrived at honestly.
  const value = projectValue(gate.public)?.text ?? "";
  return {
    text: `(stories.type not in (${holes})
      or exists (select 1 from content_index cg
                  where cg.story_id = stories.id and cg.locale = ?
                    and cg.field = ? and cg.text_value = ?))`,
    binds: [...types, locale, gate.field, value],
  };
}

/**
 * The `where` clauses a query shares across every statement it can compile to, and
 * their binds, in the order they sit in the text.
 *
 * `fold` is the one place the indexed-order path differs: a `where` on the **sort
 * field** tests the very `content_index` row the ordered statement already walks
 * (the primary key `(story_id, locale, field)`), so it is returned in `folded` for
 * `foldPredicate` to state on that row, and the clause stops being a probe per story.
 * `null` for every other statement, which is why `contentSql`'s text is not one
 * character different.
 */
function filterClauses(
  n: ReturnType<typeof normaliseQuery>,
  locale: string,
  gate: SearchGate | undefined,
  chain: readonly string[] | undefined,
  searching: boolean,
  fold: string | null,
): { clauses: string[]; binds: unknown[]; folded: ContentWhere[] } {
  const clauses: string[] = ["stories.published_doc is not null"];
  const binds: unknown[] = [];

  if (n.type.length > 0) {
    clauses.push(`stories.type in (${n.type.map(() => "?").join(", ")})`);
    binds.push(...n.type);
  }
  if (n.parent !== undefined) {
    if (n.parent === null) clauses.push("stories.parent_id is null");
    else {
      clauses.push("stories.parent_id = ?");
      binds.push(n.parent);
    }
  }
  const folded: ContentWhere[] = [];
  n.where.forEach((w, i) => {
    // Left out of the clauses, not replaced in them: the caller states it on the
    // index row's own alias, inside the walk (`foldPredicate`).
    if (fold === w.field && foldPredicate(w, "co") !== null) {
      folded.push(w);
      return;
    }
    const pred = wherePredicate(w, locale, i);
    clauses.push(pred.text);
    binds.push(...pred.binds);
  });

  // Decision 11, and its opt-out. A caller who names the gate field in a `where`
  // has taken the scoping on itself — `where: [{ field: 'access', op: 'in',
  // value: ['public', 'members'] }]` is how a host builds a members' search over
  // members' content — and the same double enforcement `filterable` uses says
  // the caller wins. Emitted last, so its binds land last among the where binds.
  if (gate && n.search !== undefined && gate.types.size > 0) {
    if (!n.where.some((w) => w.field === gate.field)) {
      const pred = gatePredicate(gate, locale);
      clauses.push(pred.text);
      binds.push(...pred.binds);
    }
  }

  // Decision 5's empty token set. The clause rather than an early return so
  // every other refusal above has already had its say.
  if (n.search !== undefined && !searching) clauses.push("0 = 1");

  // Last, so every bind above keeps the position it had before scopes existed.
  if (chain) {
    const served = servedClause(chain);
    clauses.push(served.sql);
    binds.push(...served.binds);
  }

  return { clauses, binds, folded };
}

/** What a row carries back besides its story columns; see the note in `contentSql`. */
function rowProjection(withDoc: boolean): string {
  return withDoc
    ? "published_doc"
    : `(published_doc is not null) as has_doc,
       json_extract(published_doc, '$.bloks."' || json_extract(published_doc, '$.root') || '"') as root_blok`;
}

/**
 * A `where` on the sort field, stated on the ordered statement's own `content_index`
 * row (`co`) instead of as an `exists` probe. Range and `eq` only, and the column
 * and operator are exactly `wherePredicate`'s, so the rows that match are the same
 * ones. `ne`, `in`, `startsWith` and `contains` keep their `exists` form.
 */
function foldPredicate(w: ContentWhere, alias: string): Sql | null {
  if (isRangeOp(w.op)) {
    const op = w.op === "gt" ? ">" : w.op === "gte" ? ">=" : w.op === "lt" ? "<" : "<=";
    const column = typeof w.value === "number" ? "num_value" : "text_value";
    return { text: `${alias}.${column} ${op} ?`, binds: [w.value] };
  }
  if (w.op === "eq") return { text: `${alias}.text_value = ?`, binds: [scalar(w.value)] };
  return null;
}

/**
 * The two statements a query runs: a `count(*)` for `total`, and the page itself.
 *
 * The page reads the document alongside the story columns rather than taking a
 * third round trip through `publishedDocsByIds`: the id list it would bind is the
 * id list this statement just produced. The spec costed the read at three
 * statements; two is the same work with one fewer hop.
 *
 * **"The bytes are identical either way" is no longer true, and that is the
 * point.** It said so until 2026-09-06, when the whole `published_doc` was the
 * only shape a row came back in. A list needs the root block, not the document,
 * so `projection` below has SQLite pull just that out unless the query asked for
 * the rest — twenty times less to ship, on the uncached render of every page
 * carrying a list.
 */
export function contentSql(
  q: ContentQuery,
  indexed: ReadonlySet<string>,
  /** The index locale key: `''` for the source locale. */
  locale: string,
  perPageMax = MAX_PER_PAGE,
  /** `ResolvedGate`, narrowed. Decision 11; absent on an ungated deployment,
   * and then not one character of SQL below changes. */
  gate?: SearchGate,
  /**
   * The rendering scope's chain (`../../docs/specs/foundation/multi-site.md`
   * decision 6): the rows are the chain's **served set** (`servedClause`), so a
   * collection on one site never lists another's rows, nor a shared row the site
   * has forked or redirected away. Every runtime caller passes one — the
   * single-site chain included, because `stories_type` leads with `site_id` since
   * `0011` and a query that does not bind it scans. Absent emits nothing, which is
   * what this function's own unit tests pin.
   */
  chain?: readonly string[],
): { count: Sql; page: Sql; normalised: ReturnType<typeof normaliseQuery> } {
  const n = normaliseQuery(q, perPageMax);

  for (const w of n.where) {
    if (!indexed.has(w.field)) throw unknownField(w.field, indexed);
  }
  const builtInOrder = n.order.field in BUILT_IN_ORDERS;
  if (!builtInOrder && !indexed.has(n.order.field)) throw unknownField(n.order.field, indexed);
  // `relevance` sorts by a column that is only in the statement when there is a
  // `MATCH` to score. Refused rather than quietly demoted to `publishedAt`: a
  // list silently sorted by something other than what was asked for is the
  // failure nobody notices.
  if (n.order.field === "relevance" && n.search === undefined) {
    throw new FolioError("bad_request", "order 'relevance' needs a search");
  }

  // `contains` is a `like '%x%'`, which cannot use the index — it is a scan of
  // every row for the field. Allowed, and capped: only alongside something that
  // *can* narrow first, so the scan is over a type's rows rather than the site's.
  // `search` counts as narrowing, and is the strongest of the four: the join
  // hands the scan the handful of rows FTS5 matched.
  const narrowing =
    n.search !== undefined ||
    n.type.length > 0 ||
    n.parent !== undefined ||
    n.where.some((w) => w.op !== "contains");
  if (n.where.some((w) => w.op === "contains") && !narrowing) {
    throw new FolioError(
      "bad_request",
      "A 'contains' filter is a scan; combine it with a type, a parent or another filter",
    );
  }

  // Visitor input as `MATCH` syntax, or null when it held no token at all
  // (`???`, an emoji). Null is an *answer*, not an error: the statement below
  // gets `0 = 1` and no join, which is an honest empty page rather than a 500
  // or — far worse — everything.
  const match = n.search === undefined ? null : ftsQuery(n.search);
  const searching = match !== null;

  const { clauses, binds } = filterClauses(n, locale, gate, chain, searching, null);

  const where = clauses.join(" and ");
  const dir = n.order.dir === "asc" ? "asc" : "desc";

  // `s.id` is appended to every sort, always. Without a total order, offset
  // pagination is free to show one row on two pages and skip another entirely.
  const orderBinds: unknown[] = [];
  let join = "";
  let orderBy: string;
  if (n.order.field === "relevance") {
    // No join to sort by when the term held no token: the page is empty and the
    // id tiebreak is the whole of the order.
    orderBy = searching ? `fts.score ${dir}, stories.id asc` : "stories.id asc";
  } else if (builtInOrder) {
    orderBy = `${BUILT_IN_COLUMNS[n.order.field]} ${dir}, stories.id asc`;
  } else {
    join = `left join content_index co
              on co.story_id = stories.id and co.locale = ? and co.field = ?`;
    orderBinds.push(locale, n.order.field);
    // `nulls last` spelled out rather than left to SQLite's default: a document
    // with no value for the sort field has no index row, and where it lands must
    // not depend on the direction. `num_value` first so a date or a number sorts
    // numerically, `text_value` behind it for a field that is neither.
    orderBy = `co.num_value ${dir} nulls last, co.text_value ${dir} nulls last, stories.id asc`;
  }

  const limit = [n.perPage, (n.page - 1) * n.perPage];

  /**
   * **What a row has to carry back, and why it is usually not the document.**
   *
   * An item needs `data` — the root block's fields, which is what a card
   * renders from — and `data` lives inside `published_doc`. Selecting the whole
   * blob to read one object out of it means D1 ships every paragraph of every
   * listed page on every cache miss: measured on a production
   * database, 542 kB of documents against 27 kB of root blocks across 32
   * published pages, and an eleven-item guides rail is a fifth of that on every
   * uncached render of every page that shows the rail.
   *
   * So SQLite does the projection. The path is built from the document's own
   * `root` and the key is quoted, because a uid is `[A-Za-z0-9_-]{1,64}`
   * (`core/nested.ts`'s `UID_RE`) and an unquoted `-` in a JSON path is not
   * something to rely on. Verified against every published row in both of that
   * host's databases: zero extractions returned null.
   *
   * `has_doc` rides along rather than being inferred from the projection: an
   * unpublished row must be skipped (it always was), and a projection that
   * somehow answered null must *not* silently drop a published page from a
   * list. The two cases are indistinguishable without it.
   */
  const projection = rowProjection(n.withDoc);

  // An `in` list cannot be chunked, so the only honest limit is D1's own: refuse a
  // statement exactly when it would carry more binds than D1 accepts, counted from
  // what it really binds (search adds three, a non-built-in order two, limit and
  // offset two). A query that fits is never refused.
  const pageBinds = (searching ? 3 : 0) + orderBinds.length + binds.length + limit.length;
  if (pageBinds > D1_BIND_CAP) {
    throw new FolioError(
      "bad_request",
      `This query binds ${pageBinds} values and D1 allows ${D1_BIND_CAP}. Narrow the 'in' lists, filters or types`,
    );
  }

  if (!searching) {
    return {
      count: { text: `select count(*) as n from stories where ${where}`, binds },
      page: {
        // Order binds come first: they are in the JOIN, which precedes the WHERE.
        text: `select ${STORY_COLS}, ${projection} from stories ${join} where ${where}
             order by ${orderBy} limit ? offset ?`,
        binds: [...orderBinds, ...binds, ...limit],
      },
      normalised: n,
    };
  }

  // One row per matching (story, locale), and the locale filter is an equality
  // *after* the match rather than a term inside it: fallback text is indexed
  // under each locale at publish, so a French visitor's hit is a French row.
  // `content_fts` is never aliased in here — FTS5's hidden `MATCH` column bears
  // the table's own name, and an alias makes `content_fts match ?` unresolvable.
  const matchJoin = (cols: string) => `join (select ${cols}
                      from content_fts
                      join content_text ct on ct.id = content_fts.rowid
                     where content_fts match ? and ct.locale = ?) fts
                 on fts.story_id = stories.id`;

  const inner = `select ${STORY_COLS}, ${projection}, fts.score, fts.rowid as fts_rowid
             from stories
             ${matchJoin("ct.story_id, ct.id as rowid, -bm25(content_fts, 10.0, 1.0) as score")}
             ${join} where ${where}
             order by ${orderBy} limit ? offset ?`;

  return {
    count: {
      text: `select count(*) as n from stories
             ${matchJoin("ct.story_id")}
             where ${where}`,
      binds: [match, locale, ...binds],
    },
    page: {
      // **The snippet is a correlated subquery over the paged rows, and that is
      // the whole reason for the nesting.** Inside the match subquery `snippet()`
      // would run for every hit before the sort — a 2,000-hit query reading 2,000
      // bodies to show twenty. Out here it runs `perPage` times, and
      // `match ? and rowid = ?` is an equality probe FTS5 answers directly.
      //
      // The select-list `?` is textually first, so it binds first: the order is
      // [snippet match, join match, locale, order, where, limit, offset].
      text: `select p.*,
                    (select snippet(content_fts, 1, char(1), char(2), '…', 32)
                       from content_fts
                      where content_fts match ? and content_fts.rowid = p.fts_rowid) as snippet
             from (${inner}) p`,
      binds: [match, match, locale, ...orderBinds, ...binds, ...limit],
    },
    normalised: n,
  };
}

/**
 * An ordered listing sorted by an indexed field, as **one statement** that returns
 * exactly the rows, in exactly the order, of `contentSql`'s `left join` statement
 * (which stays the reference: `test/workers/query-order.test.ts` runs both and
 * compares).
 *
 * **Why not that statement.** It drives from `stories` through a `left join`, so
 * SQLite visits and sorts every story of the type before it can take twelve: three
 * rows read per post, however small the page. This one drives from `content_index` in
 * sort order and stops at the limit. The old order was `num_value, text_value, id`,
 * each `nulls last`, so the rows fall into three groups that never interleave, and
 * each group is one arm of a `union all`:
 *
 *  1. a numeric value (a date, a number, a boolean), by `num_value` then `text_value`;
 *  2. a text value only, by `text_value`;
 *  3. no value for the field at all, by `id`.
 *
 * Each arm keeps at most `L = offset + limit` rows, which is all the page can use, and
 * the outer query orders the (at most 3L) rows and applies the offset. An arm is only
 * *run* when the arms before it did not fill `L`, which the arm tests against a
 * materialised copy of them (`a1`, `a2`), so a full first page never touches arm 2 or 3.
 * One statement means one round trip and one consistent read, however many groups a
 * page spans.
 *
 * **The walk is capped, because the index is not per type.** `content_index` has no
 * type or site column, so walking `(field, locale, num_value)` visits every story in
 * the database that has the field, other types and other sites included, and a small
 * listing in a shared field would read all of them to find its few rows. The walk is
 * therefore a derived table with `limit K` (`K` a few times the page), so it reads at
 * most `K` index rows and `K` primary-key probes however the data is shaped. When the
 * cap is what stopped an arm short of `L` the answer is not known to be complete, and
 * `runQuery` runs the old statement instead: the worst case is the old cost plus
 * about `2K` rows, and the common case (one type or site owns the field) never gets
 * there. `exhausted` is the one question that settles an under-full answer: did every
 * walk end before its cap.
 *
 * `cross join` is the load-bearing word. SQLite never reorders one, so the index walk
 * stays the outer loop; a plain join is re-planned `stories`-first as soon as the
 * database has statistics, and the saving silently disappears.
 *
 * A group a filter has already emptied is not compiled: a numeric range on the sort
 * field needs a numeric value, so only group 1 can match; any non-`ne` filter on it
 * needs a row, so group 3 cannot.
 */
export interface IndexedOrder {
  /** The listing statement for `limit` rows from `offset`, or null when it is not worth it. */
  page: (limit: number, offset: number) => Sql | null;
  /** For an empty answer, which carries no `ok`: true when every capped walk ended before its cap. */
  exhausted: (limit: number, offset: number) => Sql;
}

/** The deepest `offset + limit` the capped walk is used for; past it the old statement runs. */
const ORDERED_WINDOW_MAX = 150;
/** A walk reads at most `WALK_FACTOR * window + WALK_SLACK` index rows. */
const WALK_FACTOR = 2;
const WALK_SLACK = 4;

/**
 * Null when the query is not an indexed-field ordering (a built-in order, a search),
 * which keeps `contentSql`'s statement. `contentSql` has already refused whatever
 * is malformed, so this only compiles.
 */
export function indexedOrderSql(
  q: ContentQuery,
  locale: string,
  perPageMax = MAX_PER_PAGE,
  chain?: readonly string[],
): IndexedOrder | null {
  const n = normaliseQuery(q, perPageMax);
  if (n.search !== undefined || n.order.field in BUILT_IN_ORDERS) return null;

  const { clauses, binds, folded } = filterClauses(
    n,
    locale,
    undefined,
    chain,
    false,
    n.order.field,
  );
  const where = clauses.join(" and ");
  const dir = n.order.dir === "asc" ? "asc" : "desc";
  const cols = `${STORY_COLS}, ${rowProjection(n.withDoc)}`;
  const field = n.order.field;

  // The folded filters, stated on the index row inside each walk.
  const foldSql = folded.map((w) => foldPredicate(w, "ci")!);
  const foldText = foldSql.map((f) => ` and ${f.text}`).join("");
  const foldBinds = foldSql.flatMap((f) => f.binds);

  const numericRange = folded.some((w) => isRangeOp(w.op) && typeof w.value === "number");
  const needsRow = n.where.some((w) => w.field === field && w.op !== "ne");
  const withText = !numericRange;
  const withAbsent = !needsRow;

  const numeric = "ci.num_value is not null";
  const textual = "ci.num_value is null and ci.text_value is not null";

  /** A capped walk of one group's index rows, in the group's sort order. */
  const walk = (valued: string, order: string) =>
    `(select ci.story_id, ci.num_value, ci.text_value from content_index ci
       where ci.field = ? and ci.locale = ? and ${valued}${foldText}
       order by ${order} limit ?) co cross join stories on stories.id = co.story_id`;
  const walkBinds = (k: number) => [field, locale, ...foldBinds, k];
  /** How many index rows a group's walk would see, capped: it is exhausted when under the cap. */
  const seen = (valued: string) =>
    `(select count(*) from (select 1 from content_index ci
       where ci.field = ? and ci.locale = ? and ${valued}${foldText} limit ?))`;

  const order1 = `ci.num_value ${dir}, ci.text_value ${dir} nulls last, ci.story_id asc`;
  const order2 = `ci.text_value ${dir}, ci.story_id asc`;
  const outer1 = `co.num_value ${dir}, co.text_value ${dir} nulls last, stories.id asc`;
  const outer2 = `co.text_value ${dir}, stories.id asc`;

  const build = (limit: number, offset: number): Sql | null => {
    const window = offset + limit;
    if (window > ORDERED_WINDOW_MAX) return null;
    const k = WALK_FACTOR * window + WALK_SLACK;
    const arms: string[] = [];
    const armBinds: unknown[] = [];
    const ctes: string[] = [];
    const cteBinds: unknown[] = [];
    // `have` is the SQL for "rows the earlier arms produced", `open` the tests that
    // every earlier walk ended before its cap, which is what lets a later arm run.
    let have = "";
    let open = "";
    let openBinds: unknown[] = [];

    ctes.push(`a1 as (select ${cols}, 1 as g, co.num_value as k1, co.text_value as k2
          from ${walk(numeric, order1)} where ${where} order by ${outer1} limit ?)`);
    cteBinds.push(...walkBinds(k), ...binds, window);
    arms.push("select * from a1");
    have = "(select count(*) from a1)";

    if (withText) {
      const test = `${have} < ? and ${seen(numeric)} < ?`;
      const testBinds = [window, field, locale, ...foldBinds, k, k];
      // The test is the one row a leading `select` yields or does not: with it as the
      // outer loop, a failed test means the walk below never starts, which a `where`
      // term would not do (SQLite would read every row and test each).
      ctes.push(`a2 as (select ${cols}, 2 as g, co.num_value as k1, co.text_value as k2
          from (select 1 as go where ${test}) gate cross join ${walk(textual, order2)}
          where ${where} order by ${outer2} limit ?)`);
      cteBinds.push(...testBinds, ...walkBinds(k), ...binds, window);
      arms.push("select * from a2");
      open = `${seen(numeric)} < ?`;
      openBinds = [field, locale, ...foldBinds, k, k];
      have = `((select count(*) from a1) + (select count(*) from a2))`;
      if (withAbsent) {
        // A story with no index row, or one holding neither value: no value at all.
        const absent = `not exists (select 1 from content_index cx
                      where cx.story_id = stories.id and cx.locale = ? and cx.field = ?
                        and (cx.num_value is not null or cx.text_value is not null))`;
        const test3 = `${have} < ? and ${open} and ${seen(textual)} < ?`;
        const test3Binds = [window, ...openBinds, field, locale, ...foldBinds, k, k];
        arms.push(`select * from (select ${cols}, 3 as g, null as k1, null as k2
          from (select 1 as go where ${test3}) gate cross join stories
          where ${where} and ${absent}
          order by stories.id asc limit ?)`);
        armBinds.push(...test3Binds, ...binds, locale, field, window);
      }
    }

    // `ok` rides on every row: 1 when the page is full (whatever the walks saw, every
    // arm yields a prefix of its group's order) and otherwise whether every walk ended
    // before its cap, evaluated only for a short answer so a full page never pays for it.
    const tests = [numeric, ...(withText ? [textual] : [])];
    const done = tests.map((t) => `${seen(t)} < ?`).join(" and ");
    const doneBinds = tests.flatMap(() => [field, locale, ...foldBinds, k, k]);
    const sql = `with ${ctes.join(",\n")}
      select *, case when count(*) over () >= ? then 1 else (${done}) end as ok
        from (${arms.join("\n union all\n ")})
      order by g, k1 ${dir}, k2 ${dir} nulls last, id asc limit ? offset ?`;
    const bound = [...cteBinds, window, ...doneBinds, ...armBinds, limit, offset];
    return bound.length > D1_BIND_CAP ? null : { text: sql, binds: bound };
  };

  return {
    page: build,
    exhausted: (limit, offset) => {
      const k = WALK_FACTOR * (offset + limit) + WALK_SLACK;
      const tests = [numeric, ...(withText ? [textual] : [])];
      return {
        text: `select ${tests.map((t) => `${seen(t)} < ?`).join(" and ")} as done`,
        binds: tests.flatMap(() => [field, locale, ...foldBinds, k, k]),
      };
    },
  };
}

function unknownField(field: string, indexed: ReadonlySet<string>): FolioError {
  const known = [...indexed].sort().join(", ");
  return new FolioError(
    "bad_request",
    known
      ? `No indexed field named '${field}'. Queryable fields: ${known}`
      : `No indexed field named '${field}'. No field is marked 'indexed: true' on a root block`,
  );
}

export interface QueryDeps {
  db: FolioDb;
  /** Field names marked `indexed` on some declared type's root block. */
  indexed: ReadonlySet<string>;
  /** A locale code as `content_index` keys it: `''` for the source or an unknown code. */
  localeKey: (code: string | undefined) => string;
  /** A story's public URL, for the item's `url`. `FolioRuntime.withUrls`. */
  withUrls: <T extends StoryMeta>(story: T) => T;
  /** `FolioRuntime.gate`, narrowed — absent on a deployment with no gate.
   * Scopes a `search` and nothing else (decision 11). */
  gate?: SearchGate;
  /**
   * The chain the query reads (`contentSql`'s `chain`). Defaulted to the
   * single-site chain, which is every row a deployment with no `sites` has.
   */
  chain?: readonly string[];
}

/**
 * A query, run: two statements, then the page's rows turned into
 * `ReferenceTarget`s — the shape `reference` already resolves to, so a block author
 * who can render a reference can render a collection item.
 *
 * `locale` reads each item's root-block `data` in the render's language, exactly as
 * `resolveReference` does, so an item's fields and a referenced document's fields
 * come back in the same language.
 */
export async function runQuery(
  deps: QueryDeps,
  q: ContentQuery,
  opts: { locale?: LocaleContext; perPageMax?: number } = {},
): Promise<ContentPage> {
  return (await execute(deps, q, opts, true)) as ContentPage;
}

/**
 * `runQuery` without the `count(*)`: reads one row past the page and answers
 * `hasMore` in place of `total` and `pages`. For a caller that never reads them.
 */
export async function runQuerySlice(
  deps: QueryDeps,
  q: ContentQuery,
  opts: { locale?: LocaleContext; perPageMax?: number } = {},
): Promise<ContentSlice> {
  return (await execute(deps, q, opts, false)) as ContentSlice;
}

async function execute(
  deps: QueryDeps,
  q: ContentQuery,
  opts: { locale?: LocaleContext; perPageMax?: number },
  counted: boolean,
): Promise<ContentPage | ContentSlice> {
  // `opts.locale` wins over `q.locale`: a render's locale rides on the
  // `Resolution`, deliberately *outside* the query — so `queryKey` is the same
  // string in every language and a French page and an English one share one
  // canonical form. An HTTP caller has no resolution and names the locale in the
  // query instead.
  const localeKey = opts.locale ? opts.locale.code : deps.localeKey(q.locale);
  const chain = deps.chain ?? SINGLE_SITE_CHAIN;
  const { count, page, normalised } = contentSql(
    q,
    deps.indexed,
    localeKey,
    opts.perPageMax,
    deps.gate,
    chain,
  );

  type Raw = StoryRow &
    SearchRow & {
      published_doc?: string | null;
      has_doc?: number | null;
      root_blok?: string | null;
      ok?: number | null;
    };
  const all = async (stmt: Sql) =>
    (
      await deps.db
        .prepare(stmt.text)
        .bind(...stmt.binds)
        .all<Raw>()
    ).results;
  const exhausted = async (stmt: Sql) =>
    Boolean(
      (
        await deps.db
          .prepare(stmt.text)
          .bind(...stmt.binds)
          .first<{ done: number }>()
      )?.done,
    );
  const countOf = async (stmt: Sql) =>
    (
      await deps.db
        .prepare(stmt.text)
        .bind(...stmt.binds)
        .first<{ n: number }>()
    )?.n ?? 0;

  // Without a count, one row past the page is `hasMore`, which is the whole of what a
  // "next page" link needed the count for.
  const need = normalised.perPage + (counted ? 0 : 1);
  const offset = (normalised.page - 1) * normalised.perPage;
  // `contentSql`'s page, for `need` rows: its own for a counted query, the same text
  // with the extra row's limit otherwise.
  const oldPage = (): Sql =>
    counted ? page : { text: page.text, binds: [...page.binds.slice(0, -2), need, offset] };

  const plan = indexedOrderSql(q, localeKey, opts.perPageMax, chain);
  const ordered = plan?.page(need, offset) ?? null;
  const counting = counted ? countOf(count) : null;
  counting?.catch(() => {});
  let fetched: Raw[];
  if (plan && ordered) {
    fetched = await all(ordered);
    // A full page is right whatever the walks saw. A short one is right only if it is
    // known to be complete: the statement says so (`ok`: no walk hit its cap), or it
    // accounts for every row the count found. An empty one has no row to carry `ok`.
    const complete =
      fetched.length >= need ||
      (fetched.length > 0 && Boolean(fetched[0]?.ok)) ||
      (counting !== null && offset + fetched.length === (await counting)) ||
      (counting === null &&
        fetched.length === 0 &&
        (await exhausted(plan.exhausted(need, offset))));
    // Otherwise a capped walk may have missed rows (the field is shared with other types
    // or sites): the old statement answers, at the old cost.
    if (!complete) fetched = await all(oldPage());
  } else {
    fetched = await all(oldPage());
  }
  const total = counting ? await counting : null;

  const hasMore = fetched.length > normalised.perPage;
  const shown = counted ? fetched : fetched.slice(0, normalised.perPage);
  const items: ContentItem[] = [];
  for (const raw of shown) {
    const { published_doc, has_doc, root_blok, score, snippet, fts_rowid, ok: _ok, ...row } = raw;
    // `contentSql` selects one shape or the other, never both: the whole
    // document when the query asked for it, otherwise `has_doc` plus the root
    // block SQLite projected out of it. The published-or-not test is the same
    // test in both cases and has to come first either way.
    if (!(normalised.withDoc ? published_doc : has_doc)) continue;
    const doc = published_doc ? (JSON.parse(published_doc) as Doc) : undefined;
    const story = deps.withUrls(toStoryMeta(row));
    const root: Blok | undefined = doc
      ? doc.bloks[doc.root]
      : root_blok
        ? (JSON.parse(root_blok) as Blok)
        : undefined;
    items.push({
      id: story.id,
      title: story.title,
      // `''` for an unrouted document, matching `StoryRef`: a record has no place
      // in the URL namespace, and a block testing `item.url` gets a falsy answer.
      path: story.path ?? "",
      url: story.path === null ? "" : (story.url ?? `/${story.path}`),
      data: root ? dataOf(root, opts.locale) : {},
      // **Only when the query asked** (`core/query.ts`'s `ContentQuery.withDoc`).
      // `published_doc` is still read and still parsed — `data` is the root
      // block's fields and there is nowhere else to get them — so this drops
      // bytes from the *response*, which is where they hurt: a card rail is one
      // D1 read either way, and a quarter of a megabyte of unread prose in the
      // SSR payload otherwise.
      ...(normalised.withDoc && doc ? { doc } : {}),
      // Only when the query asked, so a plain collection's items are byte for
      // byte what they were before search existed.
      ...(normalised.search === undefined
        ? {}
        : { score: score ?? 0, snippet: splitSnippet(snippet ?? null) }),
    });
  }

  if (total === null) {
    return {
      items,
      total: null,
      page: normalised.page,
      perPage: normalised.perPage,
      pages: null,
      hasMore,
    };
  }
  return {
    items,
    total,
    page: normalised.page,
    perPage: normalised.perPage,
    pages: Math.ceil(total / normalised.perPage),
  };
}
