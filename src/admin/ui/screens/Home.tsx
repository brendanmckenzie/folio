import { useId, useRef, useState } from 'react'
import type { DocumentType } from '../../../core/schema'
import type { StoryMeta } from '../../../core/story'
import type { RecentPublish } from '../../../server/versions'
import { canCreateContent, type Me } from '../../me'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { List, Row } from '../List'
import { href, type Screen } from '../route'
import { type AssetRow, addedAgo, isRenderableImage, thumbUrl, typeLabel } from './assets-model'
import { stateTone, when } from './content-rows'
import {
  type ActorDirectory,
  type ActorLabel,
  type Attention as AttentionModel,
  EDITOR_UNKNOWN_NOTE,
  MEDIA_LIMIT,
  placeOf,
  publishActor,
  type QuickCard,
  quickCards,
  RECENT_LIMIT,
} from './home-model'
import { ListHeader } from '../List'
import css from './Home.module.css'
import { messageOf } from './useContent'
import { type Block, useHome } from './useHome'

interface Props {
  apiBase: string
  mount: string
  /** Every declared document type, off the manifest. */
  types: readonly DocumentType[]
  /** `FolioConfig.globals` — a subset of the singleton types. */
  globals: readonly string[]
  me: Me
  onOpen: (screen: Screen) => void
  onNotice: (message: string) => void
}

/**
 * Placeholder rows and tiles, **as many as the request will bring back**.
 *
 * Derived from the limits rather than a hand-picked four, which is the one thing
 * every other screen's skeleton can afford to get wrong and this one cannot: those
 * lists are fifty rows long and page, so their placeholder count is decorative,
 * while these are exactly six and eight — so a hard-coded number means the block
 * visibly grows or shrinks the moment it loads, and the whole screen below it moves.
 * Named keys rather than indices, matching Content's and Documents'.
 */
const SKELETON = Array.from({ length: RECENT_LIMIT }, (_, i) => `s${i}`)
const TILES = Array.from({ length: MEDIA_LIMIT }, (_, i) => `t${i}`)

/**
 * The one width *Latest media* asks the transform route for.
 *
 * One number and not a set: every distinct clamped transform is its own billable
 * Images invocation and its own immutable cache entry (`thumbUrl` says so), and 320
 * is the 160px tile at 2× — the same width the Assets grid asks for, so the two
 * screens share cache entries instead of minting a second variant of every file.
 */
const TILE_WIDTH = 320

/**
 * **Recency and quick access, which is what every comparable product's home screen
 * turned out to be** — `docs/ui-architecture.md`'s port phase 6, and the last of the
 * platform screens because it links to all of them.
 *
 * The spec's account of how it got here is worth keeping in front of whoever touches
 * this file: an earlier draft made Home a work queue led by "everything with
 * unpublished changes", a survey of six comparable products found that **not one of
 * them leads with a work queue**, and the block the author had been most confident
 * about became a filter chip on Content instead. So the five blocks below are
 * evidence rather than taste, and the rejected list in that section is rejected with
 * reasons: charts and consumption metrics (there is no analytics binding to feed
 * them, and inventing one to fill a panel is the definition of furniture),
 * assigned-to-me and mentions (there is no workflow or assignment model), a profile
 * widget (who you are belongs in the user menu), a getting-started checklist (this is
 * a tool for the person who built the site).
 *
 * Three conventions this screen holds harder than the others do:
 *
 * 1. **Nothing here is plausible-but-fake.** The version of this file that this one
 *    replaces said so and it was right: a made-up list on a home screen is the
 *    easiest thing in the admin to mistake for a working feature. Where a field does
 *    not exist, the screen says so once and shows what it has — see
 *    `EDITOR_UNKNOWN_NOTE` on *Latest changes* and `publishActor`'s degradation on
 *    *Latest published*.
 * 2. **A failed block is absent, not an error box.** Six requests, six possible
 *    failures, and a launchpad carrying five red panels is worse than one carrying
 *    four blocks and a gap. The failure is announced once as a toast instead
 *    (`useHome`), which is where the cross-cutting rule puts a transient one.
 * 3. **Loading is skeleton rows and skeleton tiles**, never a spinner — a spinner is
 *    for an action in flight and belongs in the button that started it. With one
 *    deliberate exception: *Needs attention* has no skeleton, because a placeholder
 *    that resolves to nothing would have claimed something was wrong for as long as
 *    it was on screen.
 *
 * The section headings are `h2` under the screen's own `h1`, and **not**
 * `ListHeader`, for a reason that survives even though `ListHeader` now has a
 * screen-title register: it emits a heading with no `id`, so a
 * `<section aria-labelledby>` has nothing to point at. Model — the only other screen
 * with several sections — reached the same conclusion independently. The title itself
 * *is* `ListHeader level={1}`, so all eight screens name themselves the same way;
 * this screen rolled its own `h1` first, which is what exposed the fact that every
 * other one had no `h1` at all.
 *
 * Two blocks carry no "see all" link, and that is a real absence rather than an
 * oversight: **no screen lists recency across every type.** Content's flat mode
 * sorted by last edited is the closest thing and it is pages only, which is exactly
 * the difference `?recent=1` exists for. So `GET /stories?recent=1` and
 * `GET /published` are Home's alone.
 */
export function Home({ apiBase, mount, types, globals, me, onOpen, onNotice }: Props) {
  const data = useHome(apiBase, me, onNotice)
  const cards = quickCards({
    types,
    globals,
    counts: data.counts,
    assets: data.assetCount,
    // One flag for both create actions, and `home-model.ts` argues it: `CREATE` and
    // `ASSETS` are both the `editor` role, and `admin/me.ts` models roles.
    //
    // **Absent rather than disabled**, per the cross-cutting rule — a viewer's create
    // is impossible, not refusable. `ui-architecture.md`'s open question 8 notes that
    // Content and Documents are both still wrong about this and asks for one rule
    // applied to every screen rather than a branch in whichever was touched last;
    // this uses that one rule (`canCreateContent`) rather than inventing a local one,
    // so it is the same fix arriving early rather than a seventh opinion.
    //
    // It does flicker once on a cold load: `me` is the optimistic `OPEN` until
    // `/me` answers, so a viewer sees the actions for one round trip and then does
    // not. Access got a `loading` prop for exactly this; the wrong direction here is
    // cheap (an action that disappears, never one that appears late), so this screen
    // does not ask for one.
    mayCreate: canCreateContent(me),
  })

  return (
    <div className={css.screen}>
      <ListHeader level={1}>Home</ListHeader>

      <QuickAccess
        cards={cards}
        mount={mount}
        apiBase={apiBase}
        busy={data.uploads.busy}
        onOpen={onOpen}
        onNotice={onNotice}
        onFiles={data.uploads.add}
        onCreated={data.reload}
      />

      <Changes block={data.changes} types={types} mount={mount} onOpen={onOpen} />

      <Published
        block={data.published}
        me={me}
        directory={data.directory}
        mount={mount}
        onOpen={onOpen}
      />

      <Media block={data.media} mount={mount} busy={data.uploads.busy} onFiles={data.uploads.add} />

      <Attention attention={data.attention} scope={data.auditScope} mount={mount} onOpen={onOpen} />
    </div>
  )
}

/* --------------------------------------------------------------- a heading --- */

/**
 * A block's heading, with room for one trailing link.
 *
 * The link is a real `<a>` rather than a `Button` calling `onOpen`, so it
 * middle-clicks, copies and opens in a tab like every other route in this admin —
 * the same reason the quick-access cards are anchors. `onOpen` is kept for the
 * navigations that cannot be links: opening a document that did not exist when the
 * page rendered, and a `Row`, whose click belongs to the whole row.
 */
function Head({
  id,
  children,
  link,
}: {
  id: string
  children: string
  link?: { text: string; href: string }
}) {
  return (
    <div className={css.head}>
      <h2 className={css.heading} id={id}>
        {children}
      </h2>
      {link ? (
        <a className={css.more} href={link.href}>
          {link.text}
        </a>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ quick access --- */

function QuickAccess({
  cards,
  mount,
  apiBase,
  busy,
  onOpen,
  onNotice,
  onFiles,
  onCreated,
}: {
  cards: readonly QuickCard[]
  mount: string
  apiBase: string
  busy: boolean
  onOpen: (screen: Screen) => void
  onNotice: (message: string) => void
  onFiles: (files: FileList | null) => void
  onCreated: () => void
}) {
  const id = useId()
  return (
    <section aria-labelledby={id}>
      <Head id={id}>Quick access</Head>
      <div className={css.cards}>
        {cards.map((card) => (
          <div className={css.card} key={card.key}>
            {/*
              The card is a link and the create action is a button beside it, rather
              than one clickable card that does two things. A `<button>` inside an
              `<a>` is invalid and unusable by keyboard; the alternative — the whole
              card as a button with a link inside it — has the same fault the other
              way round.
            */}
            <a className={css.cardFace} href={href(card.screen, mount)}>
              <span className={css.cardLabel}>{card.label}</span>
              {/*
                Always rendered, empty when there is no number: a card with no count
                (a global has exactly one document, so printing "1" would be noise
                dressed as information) keeps the line, so the notes sit on one
                baseline across the grid and nothing reflows when `/counts` lands.
              */}
              <span className={css.cardCount}>{card.count?.toLocaleString() ?? ''}</span>
              <span className={css.cardNote}>{card.note}</span>
            </a>
            {card.create ? (
              <div className={css.cardAction}>
                {card.create.kind === 'document' ? (
                  <NewDocumentButton
                    apiBase={apiBase}
                    type={card.create.type}
                    label={card.create.label}
                    onCreated={(storyId) => {
                      onCreated()
                      onOpen({ name: 'edit', id: storyId })
                    }}
                    onNotice={onNotice}
                  />
                ) : (
                  <UploadButton label={card.create.label} busy={busy} onFiles={onFiles} />
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * `POST /stories`, then open what it made — the same shape as Documents'
 * `NewDocumentButton` and Content's `NewPageButton`, and deliberately not a dialog
 * asking for a name first.
 *
 * A record's title is derived from its `titleField`, so a name typed into a
 * one-field form before the document exists is a name typed into the wrong place:
 * the field it belongs to is the first thing on the form this opens, and typing it
 * there updates the title cache through the ordinary write path.
 *
 * Written here rather than imported from `Documents.tsx`: that one takes the whole
 * `DocumentType` and lives in a screen file with no exports, and this has only a type
 * *name*. Fifteen lines of `fetch` against a route whose body is three fields — a
 * shared button would mean a twelfth file in `ui/`, and the primitive set is fixed.
 */
function NewDocumentButton({
  apiBase,
  type,
  label,
  onCreated,
  onNotice,
}: {
  apiBase: string
  type: string
  label: string
  onCreated: (id: string) => void
  onNotice: (message: string) => void
}) {
  const [pending, setPending] = useState(false)

  const create = async () => {
    setPending(true)
    try {
      const res = await fetch(`${apiBase}/stories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Untitled', parentId: null, type }),
      })
      if (!res.ok) throw new Error(await messageOf(res))
      onCreated(((await res.json()) as { id: string }).id)
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Button
      size="sm"
      variant="subtle"
      disabled={pending}
      reason="Creating…"
      onClick={() => void create()}
    >
      {label}
    </Button>
  )
}

/**
 * A file picker into `POST /assets`, through the queue `useAssets.ts` already owns —
 * so this is the same upload the Assets screen performs, sequentially and with
 * per-file outcomes, rather than a second implementation of it.
 *
 * `display: none` on the input rather than `aria-hidden` and a negative tabindex: it
 * takes the element out of the tab order *and* the accessibility tree, which is what
 * is wanted, since the `Button` beside it is the control and it is the one a keyboard
 * reaches. Two mounts of this exist (the Assets card, and the empty media block),
 * each with its own input — one ref shared between two buttons is a bug waiting for
 * whichever renders second.
 */
function UploadButton({
  label,
  busy,
  onFiles,
}: {
  label: string
  busy: boolean
  onFiles: (files: FileList | null) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        size="sm"
        variant="subtle"
        disabled={busy}
        reason="Uploading…"
        onClick={() => input.current?.click()}
      >
        {label}
      </Button>
      <input
        ref={input}
        className={css.file}
        type="file"
        multiple
        // No `accept`: the library takes whatever the route takes, and a filter here
        // would be a second, staler copy of `SERVED_CONTENT_TYPES`.
        onChange={(e) => {
          onFiles(e.target.files)
          // Cleared, so choosing the same file twice in a row fires `change` twice.
          e.target.value = ''
        }}
      />
    </>
  )
}

/* ---------------------------------------------------------- latest changes --- */

/**
 * Recently edited across **every** type, which is why it reads `?recent=1` and not
 * `?flat=1` — flat mode filters `path is not null`, so it is every routed page, and a
 * site whose editors spent the afternoon on People has to see People here.
 */
function Changes({
  block,
  types,
  mount,
  onOpen,
}: {
  block: Block<StoryMeta>
  types: readonly DocumentType[]
  mount: string
  onOpen: (screen: Screen) => void
}) {
  const id = useId()
  if (block.failed) return null

  return (
    <section aria-labelledby={id}>
      <Head id={id}>Latest changes</Head>
      {block.loading && block.rows.length === 0 ? (
        <Skeletons />
      ) : block.rows.length === 0 ? (
        <EmptyState
          title="Nothing has been edited yet"
          body="Every document you touch appears here, whether or not it is a page."
          action={
            <a className={css.more} href={href({ name: 'content' }, mount)}>
              Go to Content
            </a>
          }
        />
      ) : (
        <List label="Latest changes">
          {block.rows.map((row) => (
            <Row
              key={row.id}
              meta={placeOf(row, types)}
              trailing={
                <>
                  <Badge tone={stateTone(row.state)}>{row.state}</Badge>
                  {/*
                    `when`, which coalesces `draftUpdatedAt` over `updatedAt` — the one
                    rule that makes "last edited" mean what an editor means by it, and
                    the same coalesce `?recent=1` sorts on. Not a second
                    implementation: one rule, stated once in SQL and once here.
                  */}
                  <span className={css.stamp}>{when(row)}</span>
                </>
              }
              onOpen={() => onOpen({ name: 'edit', id: row.id })}
            >
              {row.title || <span className={css.untitled}>Untitled</span>}
            </Row>
          ))}
        </List>
      )}
      {/*
        The admission, once, under the block — rather than a column of dashes headed
        "Who". `home-model.ts` carries the argument: no field on a story row names a
        person, and the only thing that knows is the per-document mutation log.
      */}
      <p className={css.note}>{EDITOR_UNKNOWN_NOTE}</p>
    </section>
  )
}

/* -------------------------------------------------------- latest published --- */

function Published({
  block,
  me,
  directory,
  mount,
  onOpen,
}: {
  block: Block<RecentPublish>
  me: Me
  directory: ActorDirectory
  mount: string
  onOpen: (screen: Screen) => void
}) {
  const id = useId()
  if (block.failed) return null

  return (
    <section aria-labelledby={id}>
      <Head id={id}>Latest published</Head>
      {block.loading && block.rows.length === 0 ? (
        <Skeletons />
      ) : block.rows.length === 0 ? (
        <EmptyState
          title="Nothing has been published yet"
          body="A publish writes a version row, and the version rows are what this list reads — so a checkpoint saved while editing is not counted as a release."
          action={
            <a className={css.more} href={href({ name: 'content' }, mount)}>
              Go to Content
            </a>
          }
        />
      ) : (
        <List label="Latest published">
          {block.rows.map(({ version, story }) => (
            <Row
              key={version.id}
              meta={<Actor who={publishActor(version.actor, { me, directory })} />}
              trailing={
                // `addedAgo` and not `when`: a publish has one timestamp, and `when`'s
                // whole purpose is the coalesce over a *document's* two. Same scale,
                // and the name is asset-flavoured only because the media library got
                // there first — a third relative-timestamp implementation is how two
                // screens start disagreeing about what "2m ago" means.
                <span className={css.stamp}>{addedAgo(version.createdAt)}</span>
              }
              actions={
                story.url ? (
                  // The live page — what the route decorated the *story* half of each
                  // row for. `stopPropagation` because the row itself opens the
                  // editor, and a link inside it would otherwise do both.
                  <a
                    className={css.view}
                    href={story.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    View
                  </a>
                ) : null
              }
              onOpen={() => onOpen({ name: 'edit', id: story.id })}
            >
              {/*
                The **version's** title, not the story's, and that is why this route
                answers two halves rather than one merged row: the title as it was at
                publish time is what "what went live" means, and a page renamed since
                is not what was published. The story is what the link needs.
              */}
              {version.title || <span className={css.untitled}>Untitled</span>}
            </Row>
          ))}
        </List>
      )}
    </section>
  )
}

/**
 * An actor, styled by how far it resolved.
 *
 * An unresolved id is set as an identifier rather than in prose, which is
 * `design-system.md`'s third commitment and also the honest rendering: `usr_9f2c…`
 * is exactly what the version row records, and typesetting it like somebody's name
 * would be the one thing this screen must not do.
 */
function Actor({ who }: { who: ActorLabel }) {
  if (who.kind === 'id') {
    return (
      <span className={css.actorId} title="No display name is resolvable for this editor here.">
        {who.text}
      </span>
    )
  }
  return <>{who.text}</>
}

/* ------------------------------------------------------------ latest media --- */

/** The newest uploads as thumbnails — the one block nobody else's dashboard has by
 * default, and nearly free: `listAssets` is already ordered by `created_at`
 * descending, so this is the library's first page at a small limit. */
function Media({
  block,
  mount,
  busy,
  onFiles,
}: {
  block: Block<AssetRow>
  mount: string
  busy: boolean
  onFiles: (files: FileList | null) => void
}) {
  const id = useId()
  if (block.failed) return null

  return (
    <section aria-labelledby={id}>
      <Head id={id} link={{ text: 'All media', href: href({ name: 'assets' }, mount) }}>
        Latest media
      </Head>
      {block.loading && block.rows.length === 0 ? (
        <div className={css.tiles} aria-hidden="true">
          {TILES.map((key) => (
            <div className={css.tileSkeleton} key={key} />
          ))}
        </div>
      ) : block.rows.length === 0 ? (
        <EmptyState
          title="No files yet"
          body="Uploads land here newest first."
          action={<UploadButton label="Upload" busy={busy} onFiles={onFiles} />}
        />
      ) : (
        <div className={css.tiles}>
          {block.rows.map((row) => (
            // Straight to the asset's detail panel on the Assets screen: `?asset=` is
            // in that screen's URL precisely because an asset is a thing somebody
            // sends a colleague.
            <a
              className={css.tile}
              key={row.id}
              href={href({ name: 'assets' }, mount, { asset: row.key })}
            >
              <span className={css.tileFrame}>
                {isRenderableImage(row) ? (
                  /*
                   * Through the transform route, so a 4MB original is never the
                   * 160px tile.
                   *
                   * `alt` is the asset's **own column**, not the filename: an empty
                   * alt means decorative and `alt=""` is the correct rendering of
                   * that. The link's accessible name comes from the filename
                   * underneath, which is why an empty alt costs nothing here.
                   */
                  <img
                    className={css.tileImage}
                    src={thumbUrl(mount, row, TILE_WIDTH)}
                    alt={row.alt}
                  />
                ) : (
                  // A file the transform route will not render inline — everything
                  // outside the five raster types, svg included, because serving SVG
                  // from this origin is a script-execution vector. Its extension is
                  // the picture, the same answer the Assets grid gives.
                  <span className={css.tileExt} aria-hidden="true">
                    {typeLabel(row)}
                  </span>
                )}
              </span>
              <span className={css.tileName}>{row.filename}</span>
              <span className={css.tileMeta}>{addedAgo(row.createdAt)}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  )
}

/* --------------------------------------------------------- needs attention --- */

/**
 * Pending migrations and audit findings — **and nothing at all when there is nothing
 * wrong**. No green tick, no "all clear" panel, and no skeleton on the way to finding
 * out: that is explicit in `ui-architecture.md` and it is the block's whole
 * character. `attention`'s `quiet` is the flag, and `model-model.ts`'s `auditGroups`
 * follows the same rule for the Model screen's panel, for the same reason — a panel
 * that is always on screen is one nobody reads.
 */
function Attention({
  attention,
  scope,
  mount,
  onOpen,
}: {
  attention: AttentionModel
  scope: string
  mount: string
  onOpen: (screen: Screen) => void
}) {
  const id = useId()
  if (attention.quiet) return null

  const footnote = [attention.more > 0 ? `${attention.more} more on Content model.` : '', scope]
    .filter(Boolean)
    .join(' ')

  return (
    <section aria-labelledby={id}>
      <Head id={id} link={{ text: 'Content model', href: href({ name: 'model' }, mount) }}>
        Needs attention
      </Head>
      {/*
        A banner in flow, never an overlay: an explanation somebody reads once and
        carries on past is not an alert. `driftBanner`'s words rather than this
        screen's, so Home and Model say the same thing about the same ledger —
        including its awkward third case, a migration pending over an empty set.
      */}
      {attention.banner ? <p className={css.banner}>{attention.banner}</p> : null}
      {attention.rows.length > 0 ? (
        <List label="Needs attention">
          {attention.rows.map((row) => (
            <Row
              key={row.key}
              {...(row.detail ? { meta: row.detail } : {})}
              {...(row.subject
                ? {
                    trailing: (
                      <Badge tone={row.kind === 'migration' ? 'warn' : 'danger'} mono>
                        {row.subject}
                      </Badge>
                    ),
                  }
                : {})}
              // A finding links to the document it is about, a migration and a schema
              // fault to Model. `attention` decides which; this only navigates.
              onOpen={() => onOpen(row.screen)}
            >
              {row.title}
            </Row>
          ))}
        </List>
      ) : null}
      {footnote ? <p className={css.note}>{footnote}</p> : null}
    </section>
  )
}

/* ------------------------------------------------------------------ shared --- */

function Skeletons() {
  return (
    <div className={css.skeletons} aria-hidden="true">
      {SKELETON.map((key) => (
        <div className={css.skeleton} key={key} />
      ))}
    </div>
  )
}
