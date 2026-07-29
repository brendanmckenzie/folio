import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildResolution } from '../core/resolve'
import type { DocumentType, SchemaIndex } from '../core/schema'
import type { StoryNode } from '../core/story'
import { BlockTree } from './BlockTree'
import { DataList } from './DataList'
import { DeleteDialog } from './DeleteDialog'
import { DiscardDialog } from './DiscardDialog'
import { DuplicateDialog } from './DuplicateDialog'
import { FolioProvider, useStoreState } from './FolioContext'
import { History } from './History'
import { useBlocks } from './hooks/useBlocks'
import { useClipboardShortcuts } from './hooks/useClipboardShortcuts'
import { useNotice } from './hooks/useNotice'
import { usePreviewBridge } from './hooks/usePreviewBridge'
import { usePublish } from './hooks/usePublish'
import { usePublishedDoc } from './hooks/usePublishedDoc'
import { useRedirects } from './hooks/useRedirects'
import { useReferencedDocs } from './hooks/useReferencedDocs'
import { useStories } from './hooks/useStories'
import { useUndoShortcut } from './hooks/useUndoShortcut'
import { useVersions, useVersionsList } from './hooks/useVersions'
import { Inspector } from './Inspector'
import { PageAddress } from './PageAddress'
import { Redirects } from './Redirects'
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
  apiBase: string
}

type Rail = 'content' | 'data' | 'blocks' | 'history' | 'redirects'

/**
 * Composition and layout only. Every domain — the story tree, versions, the
 * preview bridge, referenced documents, block mutations — lives in its own hook
 * under hooks/, and everything the panels share reaches them through
 * FolioProvider rather than as props.
 */
export function Editor({ storyId: initialStoryId, schema, types, apiBase }: Props) {
  const [rail, setRail] = useState<Rail>('blocks')
  const [viewport, setViewport] = useState<Viewport>('Desktop')

  const { notice, notify } = useNotice()
  const stories = useStories(apiBase, initialStoryId, notify)
  const { storyId, flat, current } = stories

  const store = useMemo(() => new StoryStore(storyId, apiBase), [storyId, apiBase])
  const state = useStoreState(store)

  const blocks = useBlocks(store, schema, notify, current?.path ?? '')
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

  // Same shape again, for duplicate-and-paste.md's document duplication.
  const [confirmingDuplicateFor, setConfirmingDuplicateFor] = useState<StoryNode | null>(null)
  const [duplicating, setDuplicating] = useState(false)

  // Discard has no story-switching hazard to guard against the way the two
  // above do — it is only reachable while the comparison view for *this*
  // story is open, and that view itself closes on navigation — but the same
  // "confirming, not just open" shape keeps it consistent with them.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const redirects = useRedirects(apiBase, notify, rail === 'redirects')

  /**
   * `/folio/stories` already returns every story's id, path and URL, so links
   * resolve with no extra fetching. Rebuilt only when the tree changes, which is
   * exactly when a rename or move can have altered a URL.
   */
  const base = useMemo(() => buildResolution(flat, `${apiBase}/asset`), [apiBase, flat])
  const docs = useReferencedDocs(apiBase, state.doc, schema)
  const resolution = useMemo(() => ({ ...base, docs }), [base, docs])

  const showBlocks = useCallback(() => setRail('blocks'), [])
  const frame = usePreviewBridge({
    store,
    resolution,
    source: versions.source,
    selection: state.selection,
    root: state.doc?.root,
    blocks,
    onPick: showBlocks,
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
  const readOnly = versions.source.mode === 'viewing'
  // While previewing, the tree and the inspector both show the version's document.
  const shownDoc = viewing?.doc ?? state.doc
  const selected = state.selection && shownDoc ? (shownDoc.bloks[state.selection] ?? null) : null
  const isRootBlok = Boolean(!readOnly && state.doc && state.selection === state.doc.root)

  const context = useMemo(
    () => ({ store, schema, types, apiBase, stories: flat }),
    [apiBase, flat, schema, store, types],
  )

  // A record or a singleton has no URL, so there is no page to preview and no
  // address to edit. The real record-editing UI (a form rather than an iframe)
  // is `../../../docs/specs/content-model/data-documents.md`'s; until then the
  // block tree and the inspector are the whole editor for one.
  const routed = current ? current.path !== null : true
  const hasDataTypes = types.some((t) => t.kind !== 'page')

  return (
    <FolioProvider value={context}>
      <div className="editor">
        {/* Out of the toolbar's flow: a transient message must never reflow
            controls the user is about to click. */}
        {notice ? <div className="toast">{notice}</div> : null}

        <TopBar
          current={current}
          viewport={viewport}
          onViewport={setViewport}
          mode={versions.source.mode}
          publishing={publish.publishing}
          published={publish.published}
          onPublish={() => void publish.publish()}
          onRequestUnpublish={() => setConfirmingUnpublishFor(storyId)}
          everPublished={published.version !== null}
          delta={published.delta}
          onCompare={() => {
            if (published.version) void versions.view(published.version)
          }}
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

        <div className="editor__body">
          <div className="rail">
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
            </div>

            {rail === 'content' ? (
              <StoryTree
                tree={stories.tree}
                currentId={storyId}
                onOpen={(story) => stories.open(story.id)}
                onCreate={stories.create}
                onMove={(id, parentId, index) => stories.patch(id, { parentId, index })}
                onDelete={(story) => setConfirmingDeleteFor(story)}
                onDuplicate={(story) => setConfirmingDuplicateFor(story)}
                onNotice={notify}
              />
            ) : rail === 'data' ? (
              <DataList
                documents={stories.documents}
                currentId={storyId}
                onOpen={(story) => stories.open(story.id)}
                onCreate={stories.create}
                onDelete={(story) => setConfirmingDeleteFor(story)}
                onDuplicate={(story) => setConfirmingDuplicateFor(story)}
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

          <div className="stage">
            {viewing ? (
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

            <div
              className={`stage__frame ${readOnly ? 'is-viewing' : ''}`}
              style={{ width: VIEWPORTS[viewport] }}
            >
              {current && routed && current.previewUrl ? (
                <iframe key={current.id} ref={frame} title="Preview" src={current.previewUrl} />
              ) : current && !routed ? (
                <div className="stage__nopreview">
                  <p>
                    <strong>{current.title}</strong> has no page of its own.
                  </p>
                  <p>
                    Edit its fields on the right. Records and singletons are content other pages
                    pull in, so there is nothing to preview here.
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          <Inspector
            blok={selected}
            readOnly={readOnly}
            onChange={blocks.setField}
            onRemove={blocks.remove}
            onDuplicate={blocks.duplicate}
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
