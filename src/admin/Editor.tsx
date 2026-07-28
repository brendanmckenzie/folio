import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildResolution } from '../core/resolve'
import type { SchemaIndex } from '../core/schema'
import { BlockTree } from './BlockTree'
import { FolioProvider, useStoreState } from './FolioContext'
import { History } from './History'
import { useBlocks } from './hooks/useBlocks'
import { useNotice } from './hooks/useNotice'
import { usePreviewBridge } from './hooks/usePreviewBridge'
import { usePublish } from './hooks/usePublish'
import { useReferencedDocs } from './hooks/useReferencedDocs'
import { useStories } from './hooks/useStories'
import { useUndoShortcut } from './hooks/useUndoShortcut'
import { useVersions } from './hooks/useVersions'
import { Inspector } from './Inspector'
import { PageAddress } from './PageAddress'
import { StoryStore } from './store'
import { StoryTree } from './StoryTree'
import { TopBar, VIEWPORTS, type Viewport } from './TopBar'
import { ViewingBar } from './ViewingBar'

interface Props {
  storyId: string
  schema: SchemaIndex
  apiBase: string
}

type Rail = 'content' | 'blocks' | 'history'

/**
 * Composition and layout only. Every domain — the story tree, versions, the
 * preview bridge, referenced documents, block mutations — lives in its own hook
 * under hooks/, and everything the panels share reaches them through
 * FolioProvider rather than as props.
 */
export function Editor({ storyId: initialStoryId, schema, apiBase }: Props) {
  const [rail, setRail] = useState<Rail>('blocks')
  const [viewport, setViewport] = useState<Viewport>('Desktop')

  const { notice, notify } = useNotice()
  const stories = useStories(apiBase, initialStoryId, notify)
  const { storyId, flat, current } = stories

  const store = useMemo(() => new StoryStore(storyId, apiBase), [storyId, apiBase])
  const state = useStoreState(store)

  const blocks = useBlocks(store, schema)
  const versions = useVersions({
    store,
    apiBase,
    storyId,
    liveDoc: state.doc,
    notify,
    active: rail === 'history',
  })

  // A publish changes the tree's draft badge and adds a retained version.
  const afterPublish = useCallback(async () => {
    await Promise.all([stories.reload(), versions.reload()])
  }, [stories.reload, versions.reload])
  const publish = usePublish({ apiBase, storyId, notify, onPublished: afterPublish })

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
    () => ({ store, schema, apiBase, stories: flat }),
    [apiBase, flat, schema, store],
  )

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
        />

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
            </div>

            {rail === 'content' ? (
              <StoryTree
                tree={stories.tree}
                currentId={storyId}
                onOpen={(story) => stories.open(story.id)}
                onCreate={stories.create}
                onMove={(id, parentId, index) => stories.patch(id, { parentId, index })}
                onDelete={stories.remove}
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
            ) : shownDoc ? (
              <BlockTree
                doc={shownDoc}
                selection={state.selection}
                peers={state.peers}
                onSelect={(uid) => store.select(uid)}
                onAdd={blocks.add}
                onMove={blocks.move}
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
              />
            ) : null}

            <div
              className={`stage__frame ${readOnly ? 'is-viewing' : ''}`}
              style={{ width: VIEWPORTS[viewport] }}
            >
              {current ? (
                <iframe key={current.id} ref={frame} title="Preview" src={current.previewUrl} />
              ) : null}
            </div>
          </div>

          <Inspector
            blok={selected}
            readOnly={readOnly}
            onChange={blocks.setField}
            onRemove={blocks.remove}
            address={
              isRootBlok && current ? (
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
