import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type LocaleConfig,
  localeContext,
  translationGaps,
  translationStatus,
} from '../core/locales'
import type { SpaceEvent, SpacePresence } from '../core/protocol'
import { buildResolution } from '../core/resolve'
import { type DocumentType, type SchemaIndex, singletonId, typeByName } from '../core/schema'
import type { StoryNode } from '../core/story'
import { Access } from './Access'
import { BlockTree } from './BlockTree'
import { DataList } from './DataList'
import { DataTable } from './DataTable'
import { DeleteDialog } from './DeleteDialog'
import { DiscardDialog } from './DiscardDialog'
import { DuplicateDialog } from './DuplicateDialog'
import { FolioProvider, useStoreState } from './FolioContext'
import { globalPreviewUrl, GlobalsList } from './GlobalsList'
import { History } from './History'
import { useAccess } from './hooks/useAccess'
import { useBlocks } from './hooks/useBlocks'
import { useClipboardShortcuts } from './hooks/useClipboardShortcuts'
import { useCollections } from './hooks/useCollections'
import { useDocumentUsage } from './hooks/useDocumentUsage'
import { useGlobalDocs } from './hooks/useGlobalDocs'
import { useMigrations } from './hooks/useMigrations'
import { useNotice } from './hooks/useNotice'
import { usePreviewBridge } from './hooks/usePreviewBridge'
import { usePublish } from './hooks/usePublish'
import { usePublishedDoc } from './hooks/usePublishedDoc'
import { useRedirects } from './hooks/useRedirects'
import { spaceEventEffect, useSpace } from './hooks/useSpace'
import { useReferencedDocs } from './hooks/useReferencedDocs'
import { useStories } from './hooks/useStories'
import { useUndoShortcut } from './hooks/useUndoShortcut'
import { useVersions, useVersionsList } from './hooks/useVersions'
import { Inspector } from './Inspector'
import { canCreateContent, canEdit, canManageAccess, canManageContent, type Me, whyNot } from './me'
import { MigrationBanner, Migrations } from './Migrations'
import { PageAddress } from './PageAddress'
import { PublishDialog } from './PublishDialog'
import { Redirects } from './Redirects'
import type { SpaceAvatar } from './spaceStore'
import { StoryStore } from './store'
import { StoryTree } from './StoryTree'
import { TopBar, VIEWPORTS, type Viewport } from './TopBar'
import { UnpublishDialog } from './UnpublishDialog'
import { ViewingBar } from './ViewingBar'

interface Props {
  storyId: string
  schema: SchemaIndex
  /** Every declared document type, off the manifest (`document-types.md`). */
  types: readonly DocumentType[]
  /** `FolioConfig.globals`, off the manifest (`content-model/globals.md`). */
  globals: readonly string[]
  /** `FolioConfig.locales`, off the manifest (`content-model/localisation.md`).
   * Undefined for a single-locale site, and every locale affordance in the editor
   * is absent in that case rather than present-and-trivial. */
  locales?: LocaleConfig
  /** Who is signed in, from `GET /folio/me` (`identity-and-access.md`). */
  me: Me
  /**
   * Whether the host declared the `SPACE` binding
   * (`../../../docs/specs/editing/live-collaboration.md`). False and everything
   * that channel carries — cross-story presence, a tree that updates itself when
   * somebody else renames a page — is absent, and nothing is attempted or logged.
   */
  space?: boolean
  apiBase: string
}

type Rail = 'content' | 'data' | 'blocks' | 'history' | 'redirects' | 'model' | 'access'

/**
 * Composition and layout only. Every domain — the story tree, versions, the
 * preview bridge, referenced documents, block mutations — lives in its own hook
 * under hooks/, and everything the panels share reaches them through
 * FolioProvider rather than as props.
 */
export function Editor({
  storyId: initialStoryId,
  schema,
  types,
  globals,
  locales,
  me,
  space = false,
  apiBase,
}: Props) {
  const [rail, setRail] = useState<Rail>('blocks')
  const [viewport, setViewport] = useState<Viewport>('Desktop')
  // The active locale, defaulting to the source. Editor state rather than a URL
  // parameter: it is a property of this editing session, and the *preview* URL is
  // what carries it into the iframe (`localisation.md` decision 6).
  const [locale, setLocale] = useState(locales?.default ?? '')
  const isSourceLocale = !locales || locale === locales.default
  const localeCtx = useMemo(() => localeContext(locales, locale), [locales, locale])

  const { notice, notify } = useNotice()
  const stories = useStories(apiBase, initialStoryId, notify)
  const { storyId, flat, current } = stories

  const store = useMemo(() => new StoryStore(storyId, apiBase), [storyId, apiBase])
  const state = useStoreState(store)

  const blocks = useBlocks(store, schema, notify, current?.path ?? '')

  // Which language this client is editing in, announced with its presence so a
  // peer ring can say so (`live-collaboration.md`). Null on the source locale, so
  // a single-locale site announces nothing new at all.
  useEffect(() => {
    store.setLocale(isSourceLocale ? null : locale)
  }, [isSourceLocale, locale, store])

  // Loaded unconditionally, not only while the History rail is open: the top
  // bar's own state (below) needs the newest publish version on every load
  // (`unpublished-changes.md`'s phase 1 note on `useVersions`).
  const versionsList = useVersionsList(apiBase, storyId)
  const versions = useVersions({
    store,
    apiBase,
    storyId,
    liveDoc: state.doc,
    notify,
    active: rail === 'history',
    versions: versionsList.versions,
    reloadVersions: versionsList.reload,
  })
  // "Published" is the newest `publish` version, not a second read of
  // published_doc (architecture decision 1): what the top bar's state and the
  // comparison view are both built from.
  const published = usePublishedDoc({
    apiBase,
    versions: versionsList.versions,
    liveDoc: state.doc,
  })

  // A publish or unpublish changes the tree's badge and adds a retained
  // version (unpublish adds none, but reloading unconditionally costs nothing
  // extra and keeps the two writes sharing one afterWrite path).
  const afterPublish = useCallback(async () => {
    await Promise.all([stories.reload(), versions.reload()])
  }, [stories.reload, versions.reload])
  const publish = usePublish({ apiBase, storyId, notify, onPublished: afterPublish })

  // Which story the confirmation is open for, not just whether it is open:
  // switching pages while it is up must not leave it confirming unpublish for
  // whatever story is now current. Comparing against `storyId` below closes it
  // on navigation for free, with no effect needed to reset it.
  const [confirmingUnpublishFor, setConfirmingUnpublishFor] = useState<string | null>(null)

  // Same reasoning as `confirmingUnpublishFor`, but the dialog needs the whole
  // node (its path, for the redirect-target label) rather than just an id.
  const [confirmingDeleteFor, setConfirmingDeleteFor] = useState<StoryNode | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Fetched only while a delete confirmation is open (`data-documents.md`
  // decision 4): it costs a query over `content_refs`, and nobody wants the
  // answer until they are about to delete something.
  const usage = useDocumentUsage(apiBase, confirmingDeleteFor?.id ?? null)

  // Same shape again, for duplicate-and-paste.md's document duplication.
  const [confirmingDuplicateFor, setConfirmingDuplicateFor] = useState<StoryNode | null>(null)
  const [duplicating, setDuplicating] = useState(false)

  // Discard has no story-switching hazard to guard against the way the two
  // above do — it is only reachable while the comparison view for *this*
  // story is open, and that view itself closes on navigation — but the same
  // "confirming, not just open" shape keeps it consistent with them.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  /**
   * Which locales are incomplete on the document as it stands, computed from the
   * draft the store already holds — no request, so it is right at the instant
   * Publish is clicked rather than as of the last fetch.
   */
  const gaps = useMemo(
    () => (state.doc ? translationGaps(state.doc, schema, locales) : []),
    [locales, schema, state.doc],
  )
  const [confirmingPublish, setConfirmingPublish] = useState(false)

  /** The open story's own completeness, for the tree's badge. Free and live: the
   * draft is already in the store, so this needs no request. */
  const translation = useMemo(
    () => (state.doc && !isSourceLocale ? translationStatus(state.doc, schema, locale) : null),
    [isSourceLocale, locale, schema, state.doc],
  )

  /**
   * Publish, warning first when a locale is incomplete (checkpoint 3's
   * mitigation). A complete page — and every page on a single-locale site —
   * publishes on one click, exactly as before: a confirmation that always appears
   * is a confirmation nobody reads.
   */
  const requestPublish = useCallback(() => {
    if (gaps.length > 0) setConfirmingPublish(true)
    else void publish.publish()
  }, [gaps.length, publish])

  const redirects = useRedirects(apiBase, notify, rail === 'redirects')
  // Loaded on every story load, not lazily like `redirects` above: the banner
  // below is drawn from it, and a banner that only appears once you open an
  // unrelated tab is not a banner (`schema-migrations.md` checkpoint 4).
  const migrations = useMigrations(apiBase, storyId, notify)
  const showAccess = canManageAccess(me)
  const access = useAccess(apiBase, notify, rail === 'access')

  /**
   * Signs out and reloads rather than navigating to the login page directly: the
   * cookie is cleared by the response, and a reload is what makes every other
   * piece of state in the editor — the socket included — re-derive itself from a
   * browser that is no longer signed in.
   */
  const signOut = useCallback(() => {
    void fetch(`${apiBase}/logout`, { method: 'POST' }).then(() => window.location.reload())
  }, [apiBase])

  /**
   * Follow-mode (`live-collaboration.md` decision 6): open where a peer is, in
   * their locale, on their block. **Nothing new on the wire** — it is the reason
   * `selection` rides the space channel at all.
   *
   * The selection is applied against the *new* story's document, which the store
   * for that story has not loaded yet, so it is held and applied by the effect
   * below once the document arrives. Continuous following — moving as they move —
   * is deliberately not built: it needs an exit affordance, a "they left" state
   * and scroll sync the preview bridge does not carry.
   */
  const [followTo, setFollowTo] = useState<{ storyId: string; uid: string | null } | null>(null)
  const follow = useCallback(
    (peer: SpaceAvatar) => {
      if (!peer.storyId) return
      if (peer.locale && locales?.available.some((l) => l.code === peer.locale)) {
        setLocale(peer.locale)
      } else if (!peer.locale && locales) {
        setLocale(locales.default)
      }
      setFollowTo({ storyId: peer.storyId, uid: peer.selection?.uid ?? null })
      stories.open(peer.storyId)
    },
    [locales, stories.open],
  )

  /**
   * `/folio/stories` already returns every story's id, path and URL, so links
   * resolve with no extra fetching. Rebuilt only when the tree changes, which is
   * exactly when a rename or move can have altered a URL.
   */
  const base = useMemo(() => buildResolution(flat, `${apiBase}/asset`), [apiBase, flat])
  const docs = useReferencedDocs(apiBase, state.doc, schema)
  // Fetched once per global, not per keystroke: the admin's own copy exists
  // only so a clicked uid can be traced back to the global it belongs to
  // (`globals.md` checkpoint 3), never to render anything itself — the
  // preview iframe renders every global server-side, fresh, on its own.
  const globalDocs = useGlobalDocs(apiBase, types, globals)
  // Fetched when the *set of queries* changes, never per keystroke — the same
  // discipline `useReferencedDocs` has, one level up
  // (`../../../docs/specs/content-model/collections.md` decision 5). Published
  // content, marked `stale`, exactly as the server's own preview branch resolves it.
  const collections = useCollections(apiBase, state.doc, schema, localeCtx)
  const resolution = useMemo(
    () => ({ ...base, docs, globals: globalDocs.docs, collections }),
    [base, collections, docs, globalDocs.docs],
  )

  /**
   * The space channel (`live-collaboration.md`). Everything about it is optional:
   * with no `SPACE` binding `useSpace` builds no store and opens no socket, so the
   * editor is exactly what it was before this spec — no retry loop, nothing logged.
   *
   * `onEvent` closes over the tree and the open story, so it changes identity on
   * every render; `useSpace` holds it in a ref rather than as a dependency, which
   * is what keeps the socket from being rebuilt underneath it.
   */
  const spacePeers = useRef<readonly SpacePresence[]>([])
  const spaceHandler = useCallback(
    (event: SpaceEvent) => {
      const effect = spaceEventEffect(event, {
        openStoryId: storyId,
        myActor: me.actor?.kind === 'user' ? me.actor.id : null,
        // The name comes off the peer list this same channel already carries, so
        // no display name has to ride on the event. Somebody who has since closed
        // their tab is "Someone", which is honest.
        nameOf: (actor) => spacePeers.current.find((p) => p.actor === actor)?.name ?? 'Someone',
      })
      if (effect.notice) notify(effect.notice)
      if (effect.reload) void stories.reload()
      if (effect.globals) globalDocs.reload()
    },
    [globalDocs.reload, me.actor, notify, stories.reload, storyId],
  )
  const spaceChannel = useSpace({
    apiBase,
    enabled: space,
    identity: { actor: store.actor, name: store.name, colour: store.colour },
    storyId,
    storyTitle: current?.title ?? null,
    locale: isSourceLocale ? null : locale,
    // The story-level selection, mirrored: follow-mode needs to land on a block,
    // and the deliberate duplication is decision 2's — two cheap frames beat one
    // object trying to be both channels.
    selection: state.selection === null ? null : { uid: state.selection, field: state.focus },
    onEvent: spaceHandler,
  })
  // Read inside `spaceHandler` without making the peer list a dependency of it:
  // presence moves constantly and the handler must stay stable.
  spacePeers.current = spaceChannel.peers

  // A block inside a global was clicked while previewing something else: the
  // name of the global to offer "Edit `<name>` →" for, until the next normal
  // selection or a story switch clears it.
  const [globalHint, setGlobalHint] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: storyId and state.selection are deliberate — neither is read in the body, both are what should clear a stale hint
  useEffect(() => setGlobalHint(null), [storyId, state.selection])

  const showBlocks = useCallback(() => setRail('blocks'), [])
  const frame = usePreviewBridge({
    store,
    resolution,
    source: versions.source,
    selection: state.selection,
    root: state.doc?.root,
    blocks,
    onPick: showBlocks,
    onGlobalClick: setGlobalHint,
  })

  useUndoShortcut(store, versions.source.mode === 'live')
  useClipboardShortcuts(blocks, state.selection, versions.source.mode === 'live')

  /**
   * The object's refusals — a rejected transaction, an unreadable or wrongly
   * versioned frame — reach the screen through the same toast as local failures.
   * Without this the only sign of a refused edit is the value snapping back. Each
   * refusal follows a dispatch, which clears the store's notice, so a repeat of
   * the same reason still shows.
   */
  useEffect(() => {
    if (state.notice) notify(state.notice)
  }, [notify, state.notice])

  const viewing = versions.viewing
  // Two independent reasons to be read-only, deliberately folded into one flag:
  // looking at a past version, and holding a role that may not edit. The
  // inspector already knew how to be read-only for the first, so the second is
  // free (`identity-and-access.md` phase 4, step 4).
  const mayEdit = canEdit(me)
  const mayManage = canManageContent(me)
  const mayCreate = canCreateContent(me)
  const readOnly = versions.source.mode === 'viewing' || !mayEdit

  /**
   * Stands in for every create / delete / move affordance a non-publisher may
   * still click, and says why. The server refuses these too (403); this is so an
   * editor is told *before* the request rather than by it, exactly as
   * `StoryTree`'s existing `onNotice` does for a refused drag.
   */
  const refuseManage = useCallback(() => {
    notify(whyNot(me, 'manage') ?? 'Your role may not do that')
  }, [me, notify])
  const refuseCreate = useCallback(() => {
    notify(whyNot(me, 'create') ?? 'Your role may not do that')
  }, [me, notify])
  // While previewing, the tree and the inspector both show the version's document.
  const shownDoc = viewing?.doc ?? state.doc
  const selected = state.selection && shownDoc ? (shownDoc.bloks[state.selection] ?? null) : null
  const isRootBlok = Boolean(!readOnly && state.doc && state.selection === state.doc.root)

  const context = useMemo(
    () => ({
      store,
      schema,
      types,
      globals,
      apiBase,
      stories: flat,
      locales,
      locale,
      localeCtx,
      isSourceLocale,
      setLocale,
      resolution,
      translation,
    }),
    [
      apiBase,
      flat,
      globals,
      isSourceLocale,
      locale,
      localeCtx,
      locales,
      resolution,
      schema,
      store,
      translation,
      types,
    ],
  )

  // A record or a singleton has no URL, so there is no page to preview and no
  // address to edit: it is edited **full width with no preview**
  // (`../../../docs/specs/content-model/data-documents.md` checkpoint 3). There
  // is nothing to preview, and previewing the record inside a page that
  // references it is ambiguous the moment two pages reference it differently.
  // A singleton gets a real preview after all when it is a *global*, in the
  // context its type declares (`content-model/globals.md` decision 4) — the one
  // carve-out, and it exists because a header genuinely renders in one place
  // while a person does not.
  const routed = current ? current.path !== null : true
  /**
   * The preview URL for the active locale, falling back to the source one.
   *
   * Keyed into the iframe below alongside the story id, which is what makes
   * switching locale a **reload** rather than a pushed frame (decision 6): the
   * host's own chrome, its `<html lang>` and possibly its stylesheet all change,
   * and no postMessage reaches those. Everything after the reload is
   * per-keystroke as usual.
   */
  const previewUrl = current
    ? ((isSourceLocale ? current.previewUrl : current.previewUrls?.[locale]) ?? current.previewUrl)
    : undefined
  const currentType = current ? typeByName(types, current.type) : undefined
  const globalPreview =
    current && currentType?.kind === 'singleton'
      ? globalPreviewUrl(currentType, flat, apiBase)
      : undefined
  const hasDataTypes = types.some((t) => t.kind !== 'page')

  /**
   * The type whose list view the stage is showing, or null for the ordinary
   * preview. Set by clicking a type in the Data rail and cleared by opening a
   * document, so the table is a *destination* rather than a mode you have to get
   * out of.
   */
  const [dataType, setDataType] = useState<string | null>(null)
  const openedType = dataType ? typeByName(types, dataType) : undefined
  const listing = rail === 'data' && openedType ? openedType : undefined

  /**
   * Form mode (checkpoint 3): the rails go full width and the stage is gone
   * entirely. A layout branch, not a rewrite — `Editor` has been a composition
   * over hooks with the iframe and the rails as siblings since the earlier
   * refactor, so "no iframe" is one class and one conditional.
   *
   * Publish, History, undo, presence and multiplayer are all untouched, because
   * none of them ever depended on there being a preview.
   */
  const formMode = Boolean(current) && !routed && !globalPreview && !listing

  /**
   * In form mode there is no preview to click, so nothing would ever select the
   * root and the inspector would sit empty asking to be clicked in a pane that
   * does not exist. A record's own fields *are* the form (checkpoint 3), so
   * select it as soon as the document arrives.
   *
   * Only while nothing is selected, so an editor who has clicked into a nested
   * block — a person's list of accreditations — keeps their place.
   */
  useEffect(() => {
    if (formMode && state.doc && !state.selection) store.select(state.doc.root)
  }, [formMode, state.doc, state.selection, store])

  /**
   * The second half of follow-mode: the block a peer had selected, applied once
   * this story's document has arrived. A uid the document does not have is
   * dropped rather than being an error — they may be a delta ahead of us, and the
   * page is still the right place to have landed.
   */
  useEffect(() => {
    if (!followTo || followTo.storyId !== storyId || !state.doc) return
    if (followTo.uid && state.doc.bloks[followTo.uid]) store.select(followTo.uid)
    setFollowTo(null)
  }, [followTo, state.doc, storyId, store])

  return (
    <FolioProvider value={context}>
      <div className="editor">
        {/* Out of the toolbar's flow: a transient message must never reflow
            controls the user is about to click.
            Always mounted, never conditionally rendered: a live region has to
            already be in the DOM before its text changes for a screen reader to
            announce it reliably, so only the text toggles here. Empty, it is
            collapsed to nothing by .toast:empty in admin.css rather than removed. */}
        <div className="toast" role="status" aria-live="polite">
          {notice}
        </div>

        <TopBar
          current={current}
          viewport={viewport}
          onViewport={setViewport}
          // No viewport switcher and no "View live" for a document with no page
          // of its own: both would be controls that cannot do anything.
          hasPreview={!formMode}
          mode={versions.source.mode}
          publishing={publish.publishing}
          published={publish.published}
          onPublish={requestPublish}
          onRequestUnpublish={() => setConfirmingUnpublishFor(storyId)}
          everPublished={published.version !== null}
          delta={published.delta}
          onCompare={() => {
            if (published.version) void versions.view(published.version)
          }}
          me={me}
          onSignOut={signOut}
          spaceAvatars={spaceChannel.avatars}
          onFollow={follow}
        />

        {confirmingUnpublishFor === storyId && current ? (
          <UnpublishDialog
            story={current}
            tree={flat}
            busy={publish.unpublishing}
            onCancel={() => setConfirmingUnpublishFor(null)}
            onConfirm={() => {
              void publish.unpublish().then(() => setConfirmingUnpublishFor(null))
            }}
          />
        ) : null}

        {confirmingDeleteFor ? (
          <DeleteDialog
            story={confirmingDeleteFor}
            tree={flat}
            busy={deleting}
            usage={usage.usage}
            onCancel={() => setConfirmingDeleteFor(null)}
            onConfirm={(redirect) => {
              setDeleting(true)
              void stories.remove(confirmingDeleteFor, redirect).then(() => {
                setDeleting(false)
                setConfirmingDeleteFor(null)
              })
            }}
          />
        ) : null}

        {confirmingDuplicateFor ? (
          <DuplicateDialog
            story={confirmingDuplicateFor}
            busy={duplicating}
            onCancel={() => setConfirmingDuplicateFor(null)}
            onConfirm={(title) => {
              setDuplicating(true)
              void stories.duplicate(confirmingDuplicateFor, title).then(() => {
                setDuplicating(false)
                setConfirmingDuplicateFor(null)
              })
            }}
          />
        ) : null}

        {confirmingPublish ? (
          <PublishDialog
            gaps={gaps}
            locales={locales}
            busy={publish.publishing}
            onCancel={() => setConfirmingPublish(false)}
            onConfirm={() => {
              void publish.publish().then(() => setConfirmingPublish(false))
            }}
          />
        ) : null}

        {confirmingDiscard && viewing ? (
          <DiscardDialog
            delta={versions.delta}
            busy={versions.busy}
            onCancel={() => setConfirmingDiscard(false)}
            onConfirm={() => {
              void versions
                .restore(viewing.version, viewing.doc)
                .then(() => setConfirmingDiscard(false))
            }}
          />
        ) : null}

        {/* The banner lives inside the stage for a page, and there is no stage in
            form mode — so it appears here instead rather than becoming
            unreachable for a record that is behind the model. Full width, which
            for a banner is if anything better; the page layout is untouched. */}
        {formMode ? <MigrationBanner status={migrations.status} /> : null}

        <div className={`editor__body ${formMode ? 'is-form' : ''}`}>
          <div className="rail">
            <GlobalsList
              documents={stories.documents}
              currentId={storyId}
              onOpen={(id) => stories.open(id)}
            />

            <div className="rail__tabs">
              <button
                type="button"
                className={rail === 'content' ? 'is-active' : ''}
                onClick={() => setRail('content')}
              >
                Content
              </button>
              {/* Only when the site actually has records or singletons: an
                  empty Data tab on a pages-only site is noise. */}
              {hasDataTypes ? (
                <button
                  type="button"
                  className={rail === 'data' ? 'is-active' : ''}
                  onClick={() => setRail('data')}
                >
                  Data
                </button>
              ) : null}
              <button
                type="button"
                className={rail === 'blocks' ? 'is-active' : ''}
                onClick={() => setRail('blocks')}
              >
                Blocks
              </button>
              <button
                type="button"
                className={rail === 'history' ? 'is-active' : ''}
                onClick={() => setRail('history')}
              >
                History
              </button>
              <button
                type="button"
                className={rail === 'redirects' ? 'is-active' : ''}
                onClick={() => setRail('redirects')}
              >
                Redirects
              </button>
              {/* Only when the host has declared migrations at all: an empty
                  screen on a site with none is noise, the same rule the Data tab
                  follows. Visible to every role, because the banner it explains
                  is — only the Run button is admin-only. */}
              {migrations.status && migrations.status.migrations.length > 0 ? (
                <button
                  type="button"
                  className={rail === 'model' ? 'is-active' : ''}
                  onClick={() => setRail('model')}
                >
                  Model
                </button>
              ) : null}
              {/* Admins only, and the routes behind it 404 under `auth: 'open'`
                  and 403 for everyone else regardless. */}
              {showAccess ? (
                <button
                  type="button"
                  className={rail === 'access' ? 'is-active' : ''}
                  onClick={() => setRail('access')}
                >
                  Access
                </button>
              ) : null}
            </div>

            {rail === 'content' ? (
              <StoryTree
                tree={stories.tree}
                currentId={storyId}
                onOpen={(story) => stories.open(story.id)}
                // Deleting and moving are publisher acts: both change or
                // withdraw a URL the site already serves, which is a publishing
                // act even when nothing is published in the same breath.
                // Creating is not — a new document is an unpublished draft at a
                // path nothing links to yet — so it sits at `editor`.
                onCreate={
                  mayCreate
                    ? stories.create
                    : async () => {
                        refuseCreate()
                      }
                }
                onMove={
                  mayManage
                    ? (id, parentId, index) => stories.patch(id, { parentId, index })
                    : async () => {
                        refuseManage()
                      }
                }
                onDelete={mayManage ? (story) => setConfirmingDeleteFor(story) : refuseManage}
                onDuplicate={mayCreate ? (story) => setConfirmingDuplicateFor(story) : refuseCreate}
                onNotice={notify}
                presence={spaceChannel.peers}
              />
            ) : rail === 'data' ? (
              <DataList
                documents={stories.documents}
                selectedType={dataType}
                currentId={storyId}
                onSelectType={setDataType}
                onOpen={(story) => {
                  setDataType(null)
                  stories.open(story.id)
                }}
              />
            ) : rail === 'history' ? (
              state.doc ? (
                <History
                  versions={versions.versions}
                  activity={versions.activity}
                  doc={state.doc}
                  busy={versions.busy}
                  viewingId={viewing?.version.id ?? null}
                  onCheckpoint={versions.checkpoint}
                  onView={versions.view}
                  onExitView={versions.exit}
                  onRefresh={() => void versions.reload()}
                />
              ) : (
                <p className="rail__loading">Loading…</p>
              )
            ) : rail === 'access' && showAccess ? (
              <Access state={access} selfId={me.actor?.kind === 'user' ? me.actor.id : null} />
            ) : rail === 'model' ? (
              <Migrations
                status={migrations.status}
                report={migrations.report}
                busy={migrations.busy}
                canRun={showAccess}
                onRun={(opts) => void migrations.run(opts)}
                onRefresh={() => void migrations.reload()}
              />
            ) : rail === 'redirects' ? (
              <Redirects
                rows={redirects.rows}
                loading={redirects.loading}
                source={redirects.source}
                onSourceChange={redirects.setSource}
                onCreate={redirects.create}
                onDelete={redirects.remove}
              />
            ) : shownDoc ? (
              <BlockTree
                doc={shownDoc}
                selection={state.selection}
                peers={state.peers}
                onSelect={(uid) => store.select(uid)}
                onAdd={blocks.add}
                onMove={blocks.move}
                onDuplicate={blocks.duplicate}
                onCopy={(uid) => void blocks.copy(uid)}
              />
            ) : (
              <p className="rail__loading">Loading…</p>
            )}
          </div>

          {/* Form mode: no stage at all. Not an empty stage, and not a stage
              apologising for having nothing in it — the rails simply take the
              width (`data-documents.md` checkpoint 3). */}
          {formMode ? null : (
            <div className={`stage ${listing ? 'stage--list' : ''}`}>
              {/* A banner, never a lock (checkpoint 4): refusing to serve the
                editor until somebody runs a migration would turn a schema drift
                into an outage. An empty field that is explained is a different
                experience from an empty field that is mysterious. */}
              <MigrationBanner status={migrations.status} />
              {listing ? (
                /* The per-type list view (`data-documents.md` decision 2, and the
                 piece collections.md deferred here). In the stage rather than the
                 rail: twenty-four people do not fit in a 280px column, and this
                 is the only wide space the editor has. */
                <DataTable
                  type={listing}
                  documents={stories.documents.filter((d) => d.type === listing.name)}
                  indexed={stories.indexed}
                  currentId={storyId}
                  canManage={mayManage}
                  canCreate={mayCreate}
                  onOpen={(story) => {
                    setDataType(null)
                    stories.open(story.id)
                  }}
                  onCreate={
                    mayCreate
                      ? async (title, parentId, type) => {
                          setDataType(null)
                          await stories.create(title, parentId, type)
                        }
                      : async () => {
                          refuseCreate()
                        }
                  }
                  onDelete={mayManage ? (story) => setConfirmingDeleteFor(story) : refuseManage}
                  onDuplicate={
                    mayCreate ? (story) => setConfirmingDuplicateFor(story) : refuseCreate
                  }
                />
              ) : null}
              {!listing && viewing ? (
                <ViewingBar
                  version={viewing.version}
                  doc={viewing.doc}
                  delta={versions.delta}
                  busy={versions.busy}
                  onExit={versions.exit}
                  onRestore={(version, preloaded) => void versions.restore(version, preloaded)}
                  canDiscard={published.version?.id === viewing.version.id}
                  onRequestDiscard={() => setConfirmingDiscard(true)}
                />
              ) : null}

              {listing ? null : (
                <div
                  className={`stage__frame ${readOnly ? 'is-viewing' : ''}`}
                  style={{ width: VIEWPORTS[viewport] }}
                >
                  {current && routed && previewUrl ? (
                    <iframe
                      key={`${current.id}:${locale}`}
                      ref={frame}
                      title="Preview"
                      src={previewUrl}
                    />
                  ) : current && globalPreview ? (
                    <iframe key={current.id} ref={frame} title="Preview" src={globalPreview} />
                  ) : null}
                </div>
              )}
            </div>
          )}

          <Inspector
            blok={selected}
            readOnly={readOnly}
            onChange={blocks.setField}
            onRemove={blocks.remove}
            onDuplicate={blocks.duplicate}
            globalHint={
              globalHint
                ? { name: globalHint, label: typeByName(types, globalHint)?.label ?? globalHint }
                : null
            }
            onEditGlobal={(name) => stories.open(singletonId(name))}
            address={
              isRootBlok && current && routed ? (
                <PageAddress
                  story={current}
                  onChange={(patch) => stories.patch(current.id, patch)}
                />
              ) : null
            }
          />
        </div>
      </div>
    </FolioProvider>
  )
}
