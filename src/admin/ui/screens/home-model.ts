/**
 * The Home screen's arithmetic: which quick-access cards a site has and which of
 * them can create something, where a recently edited document lives, who a publish
 * is attributable to, and what — if anything — needs attention.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node test
 * can reach it. `content-model.ts`, `documents-model.ts`, `model-model.ts`,
 * `access-model.ts` and `assets-model.ts` are the pattern; this is the sixth
 * instance.
 *
 * Two things about this file are unusual and both are deliberate.
 *
 * **It is mostly composition of other screens' models.** `driftBanner`,
 * `auditGroups` and `auditScope` come from `model-model.ts`; `addedAgo`,
 * `thumbUrl` and `isRenderableImage` come from `assets-model.ts`; `when` comes
 * from `content-rows.ts`. Home is five other screens' subjects seen from a
 * distance, so a second implementation of any of them would be a second opinion
 * about what "2m ago" or "needs attention" means — see `homeRequests` for the one
 * place that is *not* shared and why.
 *
 * **What it will not do is invent a field.** `StoryMeta` records no author (see
 * `EDITOR_UNKNOWN_NOTE`) and a `versions` row records an actor *id* rather than a
 * name (`publishActor`), and both are answered by saying so rather than by
 * guessing. A plausible fake list on a home screen is the single easiest thing
 * here to mistake for a working feature.
 */
import type { DocumentType } from '../../../core/schema'
import { singletonId } from '../../../core/schema'
import type { StoryMeta } from '../../../core/story'
import type { MigrationStatus } from '../../../server/migrate'
import type { Me } from '../../me'
import type { Screen } from '../route'
import { type AuditBatch, auditGroups, driftBanner } from './model-model'

/* ------------------------------------------------------------------ counts --- */

/**
 * What `GET {base}/api/counts` answers.
 *
 * Declared here rather than imported because the route builds the object inline
 * (`server/routes/stories.ts`) and there is no server type to share. One request
 * for every card's number is the whole reason that route exists: a site with
 * twenty record types would otherwise render this screen with twenty
 * `?type=X&limit=1&count=1` calls.
 *
 * `pages` is **not** the sum of `types`' page kinds, and the difference is
 * load-bearing: a card labelled "Pages" means the tree, and a second page type's
 * documents are in the tree too. `countStories`' third argument is that
 * distinction and `test/workers/recency.test.ts` pins it.
 */
export interface SiteCounts {
  pages: number
  types: Record<string, number>
}

/* ----------------------------------------------------------- quick access --- */

/**
 * What a card's create action does. A union rather than a callback, so the
 * *decision* is testable in Node and only the doing of it needs a component.
 *
 * Two members and not four, which is the interesting part — see `quickCards` for
 * why the Pages card and a global's card have no action at all.
 */
export type CardCreate =
  /** `POST /stories { type }`, then open the document it made. Documents'
   * `NewDocumentButton` is the shape. */
  | { kind: 'document'; type: string; label: string }
  /** A file picker into `POST /assets`. */
  | { kind: 'upload'; label: string }

export interface QuickCard {
  key: string
  label: string
  /** Where the card itself goes. */
  screen: Screen
  /**
   * Absent when there is no number to show — either because `/counts` has not
   * answered yet or because the card is a thing there is exactly one of.
   *
   * Absent rather than `0`: a zero that turns into `1,284` a moment later reads as
   * data loss for as long as it is wrong.
   */
  count?: number
  note: string
  create?: CardCreate
}

/**
 * One card per document type, plus globals and assets — Payload's entire default
 * dashboard and WordPress's At a Glance, and `ui-architecture.md` argues it does
 * double duty: the fastest route to anything, and how somebody new learns what the
 * site contains. Generated from the manifest rather than configured, because the
 * manifest already carries every type and its label.
 *
 * **Which cards get a create action, and why the other two do not.**
 *
 * - A **record** gets one: `POST /stories { type }` then open, which is exactly
 *   `NewDocumentButton` on the Documents screen. Nothing about a record needs a
 *   position or a parent, so there is no decision to take somewhere else first.
 * - **Assets** gets one: a file picker. `useAssets.ts`'s `useUploads` already owns
 *   the queue, so this is the same upload the Assets screen performs.
 * - **Pages** gets none, deliberately. A page needs a parent and a position, and
 *   which page *types* may sit at the root is `DocumentType.under`'s answer — so a
 *   create action here would be a second copy of Content's `NewPageButton`,
 *   including its `under` filtering, with a second chance to disagree with it. The
 *   card is a link to Content, where creating a page already lives and where the
 *   new page's place in the tree is visible the moment it exists.
 * - A **global** gets none, and needs none: there is exactly one of each by
 *   construction, its id is derived from its type name, so the card *is* the link
 *   to the document. It carries no count for the same reason — printing "1" on
 *   every global card is noise dressed as information.
 *
 * `mayCreate` gates both actions rather than each having its own flag. `CREATE` and
 * `ASSETS` are both the `editor` role and differ only in a token's scope
 * (`server/auth/roles.ts`), and `admin/me.ts` models roles rather than asset
 * scopes — so one flag is the honest resolution of the vocabulary available, not a
 * simplification of two different rules.
 */
export function quickCards(input: {
  types: readonly DocumentType[]
  /** `FolioConfig.globals` — a subset of the singleton types. */
  globals: readonly string[]
  /** Null until `/counts` answers, and null forever if it failed: the cards render
   * without numbers rather than not at all. */
  counts: SiteCounts | null
  /** The library's total, from the same request that fills *Latest media*. */
  assets: number | undefined
  mayCreate: boolean
}): QuickCard[] {
  const { types, globals, counts, assets, mayCreate } = input
  const cards: QuickCard[] = [
    {
      key: 'pages',
      label: 'Pages',
      screen: { name: 'content' },
      ...(counts ? { count: counts.pages } : {}),
      note: 'The tree. Every one has a URL.',
    },
  ]

  for (const type of types) {
    if (type.kind !== 'record') continue
    cards.push({
      key: `type:${type.name}`,
      label: type.label,
      screen: { name: 'documents', type: type.name },
      ...(counts ? { count: counts.types[type.name] ?? 0 } : {}),
      note: 'Records, edited as a table.',
      ...(mayCreate
        ? {
            create: {
              kind: 'document',
              type: type.name,
              label: `New ${type.label.toLowerCase()}`,
            },
          }
        : {}),
    })
  }

  for (const type of singletonOrder(types, globals)) {
    cards.push({
      key: `global:${type.name}`,
      label: type.label,
      // Straight at the document, exactly as the sidebar does: a singleton's id is
      // derived from its type name, so no request is needed to address it.
      screen: { name: 'edit', id: singletonId(type) },
      note: 'One document, always.',
    })
  }

  cards.push({
    key: 'assets',
    label: 'Assets',
    screen: { name: 'assets' },
    ...(assets === undefined ? {} : { count: assets }),
    note: 'The media library.',
    ...(mayCreate ? { create: { kind: 'upload', label: 'Upload' } } : {}),
  })

  return cards
}

/**
 * Every singleton, declared globals first and then the rest in declaration order —
 * **the same rule `ui/nav.ts`'s `globalsGroup` applies**, restated because that
 * function is local to the sidebar and returns nav items rather than types.
 *
 * Including the singletons that are *not* declared globals is the part worth
 * stating. `Manifest.globals` is a subset, and a singleton outside it is still
 * exactly one document somebody has to reach; the sidebar already lists it for that
 * reason, so a Home card set that omitted it would make Quick access a narrower
 * answer to "what does this site contain" than the nav beside it.
 */
function singletonOrder(
  types: readonly DocumentType[],
  globals: readonly string[],
): DocumentType[] {
  const singles = types.filter((type) => type.kind === 'singleton')
  const declared = globals.filter((name) => singles.some((type) => type.name === name))
  const byName = new Map(singles.map((type) => [type.name, type]))
  const order = [
    ...declared,
    ...singles.map((type) => type.name).filter((name) => !declared.includes(name)),
  ]
  return order.flatMap((name) => {
    const type = byName.get(name)
    return type ? [type] : []
  })
}

/* ---------------------------------------------------------- latest changes --- */

/**
 * **`StoryMeta` cannot say who edited a document, and this is that admission.**
 *
 * Every field on the row is either an identifier, a timestamp or a derived state
 * (`core/story.ts`); nothing on it names a person, and nothing in the `stories`
 * table does either. Who touched a document lives in the per-document mutation log
 * inside its Durable Object, which the activity trail in the editor reads one
 * document at a time — so answering it for a site-wide list of six would be six
 * Durable Object round trips for a secondary line.
 *
 * So the block shows what the row genuinely knows — where the document lives, its
 * state and when it changed — and says this once underneath rather than rendering a
 * column of dashes headed "Who". `ui-architecture.md` asks for "who and when"; this
 * is the honest half of it, and *Latest published* below is where a real actor
 * exists because a `versions` row stores one.
 */
export const EDITOR_UNKNOWN_NOTE =
  'Who made an edit is recorded per document, in its activity trail — not on the row, so it is not on this list.'

/**
 * Where a document lives, for a row's secondary line: its path, or its type's label
 * when it has none.
 *
 * `path === null` is an unrouted document — a record or a singleton — which "leaves
 * the page tree entirely rather than squatting a URL". `path === ''` is the home
 * page, whose path is genuinely the empty string, and `/` is what a person reads
 * that as. The same three cases the palette's hint distinguishes
 * (`Prototype.tsx`'s `usePaletteActions`), and stated here instead of a fourth time
 * because this is the second list to need them.
 */
export function placeOf(
  row: Pick<StoryMeta, 'path' | 'type'>,
  types: readonly DocumentType[],
): string {
  if (row.path === null) return types.find((type) => type.name === row.type)?.label ?? row.type
  return row.path === '' ? '/' : row.path
}

/* -------------------------------------------------------- latest published --- */

/** What `VersionMeta.actor` prefixes a token with (`actorString`). */
const TOKEN_PREFIX = 'token:'

/**
 * How a publish's actor reads, and how far it resolved.
 *
 * The kind exists so the screen can style an unresolved id as an identifier —
 * monospaced, per `design-system.md`'s third commitment — instead of setting a raw
 * `usr_…` in prose as though it were somebody's name.
 */
export type ActorKind = 'self' | 'user' | 'token' | 'id' | 'none'

export interface ActorLabel {
  kind: ActorKind
  text: string
}

/** Editor ids to display names, for the actors a page of publishes names. */
export type ActorDirectory = Readonly<Record<string, string>>

/**
 * Who published something.
 *
 * `VersionMeta.actor` is `actorString`'s output: a user id, `token:<name>`, or null.
 * Never a display name — the column is written from the session on purpose, so that
 * "who published this" is not a field anybody can type into — which means this
 * screen has to resolve it and has to have an answer for when it cannot.
 *
 * Four cases, in this order, and the ordering matters at the first one:
 *
 * 1. **A token stays `token:<name>`**, checked before anything else because a token
 *    is not a user id and must never be looked up as one. The whole string, matching
 *    `admin/me.ts`'s `actorLabel` — the user menu already writes a token that way,
 *    so the two surfaces name the same actor identically.
 * 2. **You are "You."** Free, needs no request, and works for every role — which is
 *    what makes the degradation below acceptable on a small site, where most
 *    publishes are your own.
 * 3. **A resolved id is a name**, from `GET {base}/api/users`.
 * 4. **An unresolved id is the id**, monospaced. Honest rather than pretty: it is
 *    exactly what the version row records.
 *
 * Case 4 is normal rather than exceptional, and the reason is a real platform gap
 * worth naming: `/users` is `ADMIN`-only and 404s under `auth: 'open'`, so an
 * editor or a publisher has **no route** that maps a user id to a name. Closing it
 * means either a `?ids=` on `/users` readable at a weaker role or a display name
 * stored beside the actor on the version row; both are server changes and neither
 * belongs in this file.
 */
export function publishActor(
  actor: string | null,
  ctx: { me: Me; directory: ActorDirectory },
): ActorLabel {
  if (actor === null) return { kind: 'none', text: 'Unknown' }
  if (actor.startsWith(TOKEN_PREFIX)) return { kind: 'token', text: actor }
  const self = ctx.me.actor
  if (self?.kind === 'user' && self.id === actor) return { kind: 'self', text: 'You' }
  const name = ctx.directory[actor]
  if (name) return { kind: 'user', text: name }
  return { kind: 'id', text: actor }
}

/** One page of `GET {base}/api/users` as a directory. Only the two fields this
 * screen reads, so it takes the narrowest shape rather than `AccessUser`. */
export function actorDirectory(users: readonly { id: string; name: string }[]): ActorDirectory {
  return Object.fromEntries(users.filter((user) => user.name).map((user) => [user.id, user.name]))
}

/* -------------------------------------------------------------- attention --- */

/**
 * How many rows the block draws before it stops and points at Model.
 *
 * A cap rather than the whole report, because Home is a launchpad and the Model
 * screen is where a drift report is read properly. Six is two more than the four
 * skeleton rows every other block here uses, so a capped list still looks like a
 * list rather than like a truncation.
 */
export const ATTENTION_LIMIT = 6

export interface AttentionRow {
  key: string
  kind: 'migration' | 'finding'
  /** What is wrong, in words. */
  title: string
  /**
   * The identifier it is about — a migration id, `hero.heading`, a story id.
   * Rendered monospaced, and absent when there is nothing to name.
   *
   * `AuditRow.subject` is null for a finding whose subject *is* a document, so that
   * the Model panel does not draw the story id as a mono subject next to a link to
   * the same id. Here it becomes the story id, because this block draws no such link
   * — the whole row navigates — so the id appears once rather than twice.
   */
  subject?: string
  /** One short line about the finding. `AuditRow.note` when there is one — the
   * varying half, which is what a single row wants — and the full sentence
   * otherwise. */
  detail?: string
  /** Where the row goes: the document for a finding that names one, Model for a
   * migration and for a schema fault, which is about code and names no document. */
  screen: Screen
}

export interface Attention {
  /** `driftBanner`'s sentence about the ledger, or null. */
  banner: string | null
  rows: AttentionRow[]
  /** Rows the cap left off. */
  more: number
  /** True when there is nothing wrong, and the block must not render at all. */
  quiet: boolean
}

/**
 * Pending migrations and audit findings, one row each — and **nothing at all when
 * the site is clean**.
 *
 * `quiet` is the whole character of this block and `ui-architecture.md` states it
 * outright: absent entirely when there is nothing wrong, no green tick, no "all
 * clear" panel. `model-model.ts`'s `auditGroups` already follows the same rule for
 * the Model screen's panel and gives the same argument — a panel that is always on
 * screen is one nobody reads. It also means there is deliberately **no skeleton**
 * for this block: a placeholder that resolves to nothing would have claimed
 * something was wrong for as long as it was on screen.
 *
 * Migrations come first because they are few, bounded by the host's own migration
 * literal, and actionable in one click; findings fill whatever is left of the cap.
 *
 * The banner is `driftBanner`'s rather than a sentence of this screen's own,
 * including its awkward third case — a migration pending over an empty set, which
 * reads as a contradiction until it is spelled out. That is also why `banner` alone
 * can make the block non-`quiet`: `behind > 0` with nothing pending means documents
 * that failed or arrived after a run, which is a true "needs attention" with no
 * pending migration to hang a row on.
 */
export function attention(input: {
  status: MigrationStatus | null
  audit: AuditBatch | null
}): Attention {
  const { status, audit } = input
  const banner = driftBanner(status)

  const migrations: AttentionRow[] = (status?.pending ?? []).map((id) => {
    const found = status?.migrations.find((migration) => migration.id === id)
    return {
      key: `migration:${id}`,
      kind: 'migration',
      title: 'Migration not run',
      subject: id,
      ...(found?.description ? { detail: found.description } : {}),
      screen: { name: 'model' },
    }
  })

  const findings: AttentionRow[] = auditGroups(audit).flatMap((group) =>
    group.families.flatMap((family) =>
      family.rows.map((row): AttentionRow => {
        const story = row.stories[0]
        const subject = row.subject ?? story
        const detail = row.note ?? row.detail
        return {
          key: `finding:${row.key}`,
          kind: 'finding',
          title: family.title,
          ...(subject ? { subject } : {}),
          ...(detail ? { detail } : {}),
          // The document when the finding names one, which is what makes a report a
          // tool rather than a list. A schema fault names no document — it is a code
          // mistake — so it goes to Model, where the family's explanation is.
          screen: story ? { name: 'edit', id: story } : { name: 'model' },
        }
      }),
    ),
  )

  const all = [...migrations, ...findings]
  return {
    banner,
    rows: all.slice(0, ATTENTION_LIMIT),
    more: Math.max(0, all.length - ATTENTION_LIMIT),
    quiet: banner === null && all.length === 0,
  }
}

/* --------------------------------------------------------------- requests --- */

/** Rows in *Latest changes* and *Latest published*. Six is a glance; the screens
 * behind them are where a list is read. */
export const RECENT_LIMIT = 6

/** Tiles in *Latest media*. Eight, because the grid is `auto-fill` and eight fills
 * two rows at the widths this screen is used at without leaving a ragged one. */
export const MEDIA_LIMIT = 8

/**
 * Published documents in the one audit batch Home asks for.
 *
 * **One batch and no walk**, unlike the Model screen, which offers to continue to
 * exhaustion. Each audited document is JSON-parsed and walked blok by blok — the
 * most expensive read per row in the admin — and this one fires on every load of
 * the launchpad. The honest consequence is that a partial report says so:
 * `auditScope` is rendered under the block, and it is the sentence that stops a
 * report over the first hundred documents of a thousand reading as the whole
 * answer.
 */
export const AUDIT_BATCH = 100

/**
 * Editors resolved for the actor directory, in one page.
 *
 * A page of users rather than the ids the publish rows actually name, because
 * `/users` has no `?ids=`. The clamp is 200 and a page of publishes names at most
 * `RECENT_LIMIT` distinct actors, so this over-fetches on a large team and
 * under-resolves on a very large one — where `publishActor` degrades to the id.
 */
export const DIRECTORY_LIMIT = 200

/**
 * Every request Home makes, as one object.
 *
 * Named here rather than assembled at each call site so a test can pin the two
 * that are easy to get subtly wrong, and both were wrong in an earlier draft of the
 * server work:
 *
 * - **`?recent=1`, never `?flat=1`.** Flat mode filters `path is not null`, so it
 *   is every routed *page*; "what changed lately" on a site whose editors spent the
 *   afternoon on People has to include People.
 *   `test/workers/recency.test.ts` asserts the same difference from the other end.
 * - **`/counts` once, not one count per card.** A count per type is inherently a
 *   set, and the route answers it as one.
 *
 * `/assets` carries `count=1` so the *Assets* card's number and the *Latest media*
 * tiles are one request rather than two: the count is over the whole filter, which
 * is exactly what the card means.
 */
export interface HomeRequests {
  counts: string
  changes: string
  published: string
  media: string
  migrations: string
  audit: string
  users: string
}

export function homeRequests(apiBase: string): HomeRequests {
  return {
    counts: `${apiBase}/counts`,
    changes: `${apiBase}/stories?recent=1&limit=${RECENT_LIMIT}`,
    published: `${apiBase}/published?limit=${RECENT_LIMIT}`,
    // `sort=created` is the route's default and newest-first, so it is omitted:
    // a URL that states a default is a URL that has to be kept in step with one.
    media: `${apiBase}/assets?limit=${MEDIA_LIMIT}&count=1`,
    // No `?story=`: that parameter answers "is *this document* behind", which is the
    // editor's banner. This is the site-wide question.
    migrations: `${apiBase}/migrations`,
    audit: `${apiBase}/audit?batch=${AUDIT_BATCH}`,
    users: `${apiBase}/users?limit=${DIRECTORY_LIMIT}`,
  }
}
