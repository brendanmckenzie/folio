/**
 * This project's content migrations
 * (`../../../docs/specs/foundation/schema-migrations.md`).
 *
 * A migration is a **pure function from a document to a list of mutations**. It
 * never writes: the runner takes what it returns and applies it three ways — as
 * a logged transaction on the story's live draft (so it syncs to open editors,
 * lands in the activity trail and is undoable), as one D1 write over the
 * published snapshot, and, for a version row, on read only, so history stays
 * byte-true.
 *
 * Two rules, and the second is the one that matters:
 *
 *  1. **No I/O, no clock, no `env`.** A migration that depends on either is not
 *     re-runnable.
 *  2. **Idempotent.** Run against an already-migrated document it must produce
 *     *zero* mutations. Every `field.*` / `block.*` helper implements that for
 *     you, which is why they exist at all — so it is implemented once rather
 *     than in every migration here.
 *
 * The ids are the run order and they sort lexicographically, so they are
 * zero-padded. `createFolio` checks that rather than trusting it.
 *
 * Nothing runs on boot. `POST /folio/migrate` (admin), or `folio.migrate(env)`
 * from a deploy step.
 */
import { defineMigration, field } from 'folio/engine'

/**
 * `pullquote.attribution` → `pullquote.credit`.
 *
 * The canonical case, and the reason the feature exists: renaming the field in
 * `blocks/prose.tsx` left every stored document still writing to `attribution`,
 * which nothing renders any more — the value is there, invisible, and the input
 * the admin now draws is empty.
 *
 * `field.rename` sets the new key and clears the old one. "Clears" is `set …
 * null`, because the mutation vocabulary has no delete-key; null is what every
 * reader already treats as empty, and it is what makes the second run produce
 * nothing.
 */
export const pullquoteCredit = defineMigration({
  id: '0001-pullquote-attribution-to-credit',
  description: 'Pull quote: attribution → credit',
  up: (_doc, ctx) => ctx.each('pullquote', (blok) => field.rename(blok, 'attribution', 'credit')),
})

/**
 * A retroactive default for `pullquote.tone`, added to the block after documents
 * already existed.
 *
 * `Field.default` is consulted at creation only, deliberately — a schema edit
 * must not change what an already-published page says. This is the other half
 * that `field-defaults-and-presets.md` deferred to here: filling the gap is an
 * explicit, auditable migration rather than a silent change of meaning on the
 * next render.
 *
 * Strictly fills an *absent* key. A pull quote whose tone an editor set to
 * `loud` is left alone, and so is one they cleared.
 */
export const pullquoteTone = defineMigration({
  id: '0002-pullquote-tone-default',
  description: 'Pull quote: tone defaults to quiet',
  up: (_doc, ctx) => ctx.each('pullquote', (blok) => field.default(blok, 'tone', 'quiet')),
})

/**
 * Kept as a worked example rather than run: this project has no block pair to
 * consolidate, and inventing one would be schema churn for a demonstration.
 * `block.retype` is what turns every `bigQuote` into a `quote` with a size,
 * keeping the uid, the position and the children — the one edit the mutation
 * vocabulary could not express before this spec.
 *
 * ```ts
 * defineMigration({
 *   id: '0003-bigquote-to-quote',
 *   description: 'bigQuote → quote, size large',
 *   up: (_doc, ctx) => ctx.each('bigQuote', (b) => block.retype(b, 'quote', { size: 'large' })),
 * })
 * ```
 */

/** In run order. `createFolio` refuses a set whose declared order and sort order disagree. */
export const migrations = [pullquoteCredit, pullquoteTone]
