/**
 * The vocabulary of a bulk write — the selection a person made, and the report
 * they get back (`../../docs/specs/platform/bulk-writes.md`,
 * `../../docs/specs/content-model/media-library.md` decision 6).
 *
 * **Generic over the filter, and here rather than in `server/`, for one reason:
 * the value appears in a URL.** A select-all captures conditions off a list
 * route's query string and posts them back to a bulk route, so the screen that
 * writes it and the runner that performs it have to share one vocabulary, and
 * `core/` is the only thing both import. That rule put these types in
 * `core/story.ts` in the first place; what changed is that none of them is about
 * stories. `BulkSelection<StoryFilter>` for the Content screen,
 * `BulkSelection<AssetFilter>` for the media library, one implementation of the
 * count guard for both.
 *
 * **No default type parameter.** `BulkSelection<F = StoryFilter>` would have kept
 * every existing call site unedited, and it is exactly how the asset runner ends
 * up silently holding a `StoryFilter` and compiling.
 *
 * **The runners are not generic** and deliberately so: `runBulk` (`server/bulk.ts`)
 * reads the story table five ways and `runAssetBulk` (`server/asset-bulk.ts`)
 * reads the library four, and one runner over both would be a union of two
 * unrelated dependency bags for the sake of a `for` loop. What they share is
 * this file — the selection shapes, the report shapes, and the rules written on
 * them here.
 */

import { type CursorPart, decodeCursor, encodeCursor } from './pagination'

/**
 * The rows somebody ticked. Small by construction: you can only tick what you
 * can see, a page at a time.
 */
export interface IdSelection {
  ids: string[]
  all?: never
}

/**
 * Everything matching a filter, as it stood when somebody clicked *select all* —
 * a flag, the conditions **captured** at that moment, the count they were shown,
 * and whatever they ticked off afterwards (`ui-architecture.md` decision 7a).
 *
 * **No ids are materialised at all**, which is the whole point: "select all
 * 51,420 matching" is the same amount of data as "select all 12 matching", so the
 * question of a ceiling never arises. And it *captures* rather than tracks, which
 * is what makes a selection survive a filter change — the filter here is a
 * snapshot, not a live read of whatever the screen's chips currently say.
 */
export interface FilterSelection<F> {
  all: true
  filter: F
  /**
   * The count the person was shown — `total` from `?count=1` on the list they
   * were looking at (`pagination.md` decision 5, which insists one `count(*)`
   * serves the header and this guard so the two cannot drift).
   *
   * **The safety mechanism, and the job's ceiling.** The server re-runs the
   * filter once at the start and refuses on a mismatch, so an operation is never
   * quietly applied to a different set than the one that was agreed to; and no
   * run ever touches more rows than this number, so a set that grows underneath a
   * long job cannot make it act on more than was agreed.
   */
  expected: number
  /** Rows ticked *off* after the select-all. Bounded by what a person can see. */
  exclude?: string[]
  ids?: never
}

/**
 * One selection, in the two shapes a selection comes in.
 *
 * One type rather than two endpoints: the action half of a bulk request is
 * identical either way, and a client that had to choose a *URL* by selection mode
 * would be encoding the mode twice.
 */
export type BulkSelection<F> = IdSelection | FilterSelection<F>

/**
 * A row the job could not act on, and why.
 *
 * `message` rather than the `reason` `MigrateFailure` and `ScheduleFailure`
 * carry, and the difference is the audience: those two are diagnostics for
 * whoever reads a report, and this is prose that goes straight into a toast — the
 * admin's `reportOf(action, done, failures)` takes `{ title, message }[]`, so this
 * shape feeds it with no mapping step in between. `id` rides along for a screen
 * that wants to leave the refused rows selected.
 */
export interface BulkFailure {
  id: string
  title: string
  message: string
}

/**
 * What one call of a batched job did.
 *
 * Generic over the action for the same reason the selection is generic over the
 * filter: the two runners have different action sets — five for documents, four
 * for the library — and a `string` here would let a client read `report.action`
 * and switch on a value the server can never send.
 */
export interface BulkReport<A extends string> {
  action: A
  /**
   * Rows this **call** acted on successfully. Per call, not cumulative: the
   * server cannot know what earlier calls did, so a client that batches sums
   * these itself and calls `reportOf` once at the end.
   */
  done: number
  /** The same, refused — one entry each, named. Per call, like `done`. */
  failed: BulkFailure[]
  /**
   * How many rows this selection agreed to act on: `ids.length`, or
   * `expected - exclude.length`. About the **job**, not this call, and it is what
   * a progress display divides by.
   */
  total: number
  /**
   * How many the job has consumed, this call included — the cursor's own counter,
   * so it is cumulative even though `done` is not. `seen === total` and
   * `continueFrom === null` are the same fact from either end.
   */
  seen: number
  /**
   * Pass back as `continueFrom` to do the next batch. Null when the job is
   * finished. **Loop on this**, not on `seen < total`: a batch whose rows were
   * all refused still advances the cursor, and a comparison of counts would spin.
   */
  continueFrom: string | null
  /** Reports what it would do and writes nothing. */
  dryRun: boolean
}

/**
 * The set moved between the number a person read and the button they pressed.
 *
 * **A door, not a wall**: it carries the *new* count, so re-confirming is one
 * click rather than a mystery. `refused` is a literal so a client can tell this
 * apart from a report without duck-typing, and there is deliberately only one
 * value for it — the count is the only thing this can refuse over.
 */
export interface BulkRefusal {
  refused: 'count'
  expected: number
  actual: number
}

/** A run either happened or was refused before it started. */
export type BulkOutcome<A extends string> = BulkReport<A> | BulkRefusal

export function wasRefused<A extends string>(outcome: BulkOutcome<A>): outcome is BulkRefusal {
  return 'refused' in outcome
}

/**
 * A job's cursor: the id it stopped on, and how many rows it has consumed
 * (`bulk-writes.md` decision 12).
 *
 * Two components, and only the first is a sort key — which is why this is
 * `encodeCursor` directly rather than a `Page<T>`. The counter is what enforces
 * the ceiling across calls, and putting it in the opaque cursor rather than in the
 * body means the caller cannot advance the job's allowance by editing a number.
 *
 * A client *can* still fabricate a whole cursor and skip the count guard with it,
 * which is worth naming: it buys nothing. The guard confirms intent; the role
 * check is the security boundary, and a caller authorised to post this could
 * equally post the ids.
 *
 * Here rather than in either runner because **both runners walk the same cursor**,
 * and two codecs for one opaque string is how a media-library cursor comes to be
 * readable by the document runner and mean something else.
 */
export function writeBulkCursor(after: string, seen: number): string {
  return encodeCursor([after, seen])
}

/** `null` for anything that is not one of ours. Each runner turns that into its
 * own refusal, because `core/` has no error type and should not grow one. */
export function readBulkCursor(raw: string): { after: string; seen: number } | null {
  const parts: CursorPart[] | null = decodeCursor(raw)
  const [after, seen] = parts ?? []
  if (typeof after !== 'string' || typeof seen !== 'number' || seen < 0) return null
  return { after, seen: Math.trunc(seen) }
}
