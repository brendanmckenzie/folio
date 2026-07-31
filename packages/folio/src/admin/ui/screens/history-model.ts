/**
 * The history slide-over's arithmetic: what a version row says, what one
 * transaction in the activity trail says, how an actor string reads, and how a
 * second page joins the first.
 *
 * Pure functions, for the admin's testing convention — no admin test mounts a
 * component (`vitest.config.ts` runs the unit project under `environment:
 * 'node'`), so a screen's logic has to live somewhere a Node test can reach it.
 * `settings-model.ts` and `content-model.ts` are the pattern.
 *
 * Two of these were unreachable by any test before the port and are the two most
 * likely to be wrong:
 *
 *   - **`describeEdit`** is `admin/History.tsx`'s private `describe`, moved out.
 *     It phrases a transaction from the *current* document, so a mutation touching
 *     a since-deleted block has to degrade rather than throw. That was true of the
 *     original too; nothing could check it.
 *   - **`actorForm`** is new, and it is the answer to a raw actor string. See its
 *     own comment: the rule is *parse, do not resolve*, because there is no route
 *     that turns `usr_…` into a name for a caller who is not an admin.
 */
import type { Doc } from '../../../core/doc'
import type { Mutation } from '../../../core/mutations'
import type { ActivityEntry } from '../../../core/protocol'
import type { BlockSchema, SchemaIndex } from '../../../core/schema'
import type { VersionKind, VersionMeta } from '../../../server/versions'
import type { BadgeTone } from '../Badge'

/* ------------------------------------------------------------------ paging --- */

/**
 * A held list plus the page that continues it, appending rather than replacing.
 *
 * **Appending is the control both of these lists get** (`ui-architecture.md`'s
 * editor section gives history a cursor for the first time), and the reason is not
 * the one `content-model.ts`'s `Level` gives even though the shape is identical.
 * There, a tree level appends because its rows have expanded descendants nested
 * inside them and replacing page one would orphan them. Here both lists are one
 * **chronology**, and the newest row is the reference point every other row is
 * understood against: a version list is read as "what changed since *that*", which
 * is the same comparison the amber frame and the top bar are showing. Paging the
 * newest publish off the top of the panel would remove the thing being compared
 * to.
 *
 * Rejected: next / previous, which is every other list in this admin
 * (`ui-architecture.md` Resolved 5) and right for a table you scan for one row.
 * A log is scanned for *when*, so "older" is a direction rather than a page, and
 * nobody wants to link to page 3 of a history that grows on every keystroke.
 *
 * Rejected: fetching on scroll. A reference surface you consult and dismiss must
 * not issue requests because a trackpad moved, and an infinite list has no end for
 * a keyboard to reach.
 *
 * Deduplicated by key, which is not defensive padding: a checkpoint saved from
 * this very panel between two pages of the same list would otherwise appear twice,
 * because the keyset moved under the cursor.
 */
export function appendRows<T>(
  held: readonly T[],
  incoming: readonly T[],
  keyOf: (row: T) => string | number,
): T[] {
  const seen = new Set(held.map(keyOf))
  const out = [...held]
  for (const row of incoming) {
    const key = keyOf(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/* ---------------------------------------------------------------- versions --- */

/** What an unlabelled version is called. A publish names itself; a checkpoint
 * nobody named is still a checkpoint. */
export function versionKindLabel(kind: VersionKind): string {
  return kind === 'publish' ? 'Published' : 'Checkpoint'
}

/** The row's heading: the label somebody typed, or what kind of version it is. */
export function versionTitle(version: Pick<VersionMeta, 'kind' | 'label'>): string {
  return version.label?.trim() || versionKindLabel(version.kind)
}

/**
 * One tone per kind, from `design-system.md`'s state palette rather than invented
 * here: a publish is `ok` because it is a completed thing that went live, and a
 * checkpoint is `warn` because amber is *history and drift* in this system — the
 * same hue the viewing frame uses, which is what ties the badge to the amber edge
 * that appears when the version is opened.
 */
export function versionTone(kind: VersionKind): BadgeTone {
  return kind === 'publish' ? 'ok' : 'warn'
}

/* ------------------------------------------------------------------- clock --- */

/**
 * A history timestamp: relative for the last day, then a date **with a time**.
 *
 * Deliberately not `content-rows.ts`'s `when`, which coarsens to a bare date past
 * a day. A tree row is scanned at a glance and "14 Mar" is enough; a version is
 * chosen by matching it against a memory — "the one from Tuesday afternoon, before
 * the rewrite" — and a date with no time cannot answer that. Same reason the row
 * carries `historyExactly` as its title: the design system's rule is that
 * shortened text always has an escape.
 *
 * `now` is a parameter so this is pure, the same choice `when` made.
 */
export function historyWhen(at: number, now: number = Date.now()): string {
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** The full timestamp, for the title on a row whose visible form is relative. */
export function historyExactly(at: number): string {
  return new Date(at).toLocaleString()
}

/* ------------------------------------------------------------------ actors --- */

/**
 * How an actor reads. Four shapes, because the string has four:
 *
 *   - **`none`** — null, which is what `actorString` returns under `auth: 'open'`.
 *     The row shows a time and no author, rather than "by nobody".
 *   - **`token`** — `token:deploy-bot`, whose *name* is right there in the string.
 *     A programmatic write, and the panel says so with a badge: "who published
 *     this" being a script rather than a person is the interesting half.
 *   - **`name`** — a display name somebody already knows, either because the
 *     activity trail captured one (`ActivityEntry.actorName`) or because the
 *     person is in the room right now (presence carries `actor` and `name`).
 *   - **`id`** — `usr_…` and nothing better. Shown **as an id**, in mono, per
 *     `design-system.md`'s third commitment: an identifier is a typographic
 *     citizen, not something to hide behind an invented label.
 *
 * **Parse, do not resolve.** The obvious move is `useModel.ts`'s trick — collect
 * the ids and batch-resolve them, the way `useStoryTitles` does over
 * `GET {base}/api/stories?ids=`. There is no equivalent for people: `GET
 * {base}/api/users` is `ADMIN`-only and takes no `?ids=`, so an editor reading the
 * history of their own page would get a 403 for a decoration, and a site on
 * `auth: 'open'` has no users table at all. So the panel resolves what it already
 * holds and shows the id for the rest, rather than fetching a name it may not be
 * allowed to see or inventing one that does not exist.
 *
 * Total over shapes it does not recognise, the same discipline `conditionText`
 * keeps in `settings-model.ts`: a string that is neither prefix is treated as a
 * name, because that is the only reading of it that is not a lie.
 */
export type ActorForm =
  | { kind: 'none' }
  | { kind: 'token'; label: string }
  | { kind: 'name'; label: string }
  | { kind: 'id'; label: string }

const TOKEN_PREFIX = 'token:'
const USER_PREFIX = 'usr_'

export function actorForm(
  actor: string | null | undefined,
  names: Readonly<Record<string, string>> = {},
): ActorForm {
  const raw = actor?.trim() ?? ''
  if (raw === '') return { kind: 'none' }
  if (raw.startsWith(TOKEN_PREFIX)) {
    const name = raw.slice(TOKEN_PREFIX.length).trim()
    // A token with no name cannot be created (`TokenCreateBody` requires one),
    // but the string is data on the wire and `token:` alone must still render.
    return { kind: 'token', label: name === '' ? 'an API token' : name }
  }
  const known = names[raw]?.trim()
  if (known) return { kind: 'name', label: known }
  if (raw.startsWith(USER_PREFIX)) return { kind: 'id', label: raw }
  return { kind: 'name', label: raw }
}

/**
 * Actor id → display name, built from the activity trail the panel already has.
 *
 * This is the whole of the resolution story and it costs nothing: every
 * `ActivityEntry` carries both the raw `actor` and the `actorName` the socket's
 * `hello` supplied, so a version whose actor also appears in the trail is named
 * for free. A version by somebody who has not touched the document since keeps its
 * id — which is honest, and better than a request an editor is not allowed to
 * make.
 *
 * `seed` is whatever the caller already knows, and presence is the intended
 * source: peers in the room carry `actor` and `name` on every broadcast. It is
 * layered *under* the trail rather than over it so a name captured at the time of
 * the edit wins over one someone is using right now.
 */
export function actorNames(
  activity: readonly ActivityEntry[],
  seed: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = { ...seed }
  for (const entry of activity) {
    const name = entry.actorName?.trim()
    if (name) out[entry.actor] = name
  }
  return out
}

/* -------------------------------------------------------------- activity --- */

/**
 * What the root block's row is called: "Page settings", "Person settings", plain
 * "Settings" when the root type is not in the schema at all.
 *
 * The same rule as `BlockTree.tsx`'s `rootSettingsLabel`, restated rather than
 * imported: that file belongs to the old single-screen editor and goes with it
 * (`ui-architecture.md`'s port plan makes the same amendment for `StoryTree.tsx`
 * and `AssetInput.tsx`), so importing from it would leave a live dependency on a
 * file whose deletion is the point of the phase after this one.
 */
export function rootLabel(rootDef: BlockSchema | undefined): string {
  return rootDef?.label ? `${rootDef.label} settings` : 'Settings'
}

/**
 * Best-effort phrase for one transaction, from `admin/History.tsx`'s `describe`.
 *
 * Block and field labels come from the **current** document, so a mutation
 * touching a since-deleted block degrades to a generic description rather than
 * failing. That is what makes the trail readable at all: the log outlives the
 * blocks it names.
 */
export function describeEdit(
  mutations: readonly Mutation[],
  doc: Doc,
  schema: SchemaIndex,
): string {
  const first = mutations[0]
  if (!first) return 'No change'

  const labelFor = (uid: string) => {
    const blok = doc.bloks[uid]
    if (!blok) return 'a block'
    if (uid === doc.root) return rootLabel(schema[blok.type])
    return schema[blok.type]?.label ?? blok.type
  }

  let phrase: string
  switch (first.t) {
    case 'set': {
      const blok = doc.bloks[first.uid]
      const field = blok ? schema[blok.type]?.fields[first.field] : undefined
      phrase = `Changed ${labelFor(first.uid)} · ${field?.label ?? first.field}`
      break
    }
    case 'insert':
      phrase = `Added ${schema[first.blok.type]?.label ?? first.blok.type}`
      break
    case 'remove':
      phrase = `Removed ${labelFor(first.uid)}`
      break
    case 'move':
      phrase = `Moved ${labelFor(first.uid)}`
      break
    case 'retype':
      // The *new* type's label comes from the schema rather than from the
      // document: a retype is almost always a content migration, and by the time
      // this renders the document already carries the new type — so `labelFor`
      // would name the destination twice and never the source.
      phrase = `Changed ${labelFor(first.uid)} to ${schema[first.type]?.label ?? first.type}`
      break
  }

  const rest = mutations.length - 1
  return rest > 0 ? `${phrase} +${rest} more` : phrase
}

/**
 * What the two sections say about themselves.
 *
 * `server/routes/history.ts`'s own header states the distinction this makes
 * visible — versions in D1 are coarse and restorable, the activity trail from the
 * Durable Object's mutation log is fine-grained and **not** restorable — and the
 * whole risk of stacking two lists in one panel is that they read as
 * interchangeable. So it is written down per section rather than implied by the
 * absence of a button.
 */
export const VERSIONS_NOTE =
  'Coarse and restorable. Publishing saves one automatically; a checkpoint is one you name. ' +
  'Restoring applies the difference as a single edit, so it reaches everyone in the document and ⌘Z undoes it.'

export const ACTIVITY_NOTE =
  'Every transaction on this document, from its own log. Fine-grained, and not restorable — ' +
  'use ⌘Z for the last few, or restore a version above.'
