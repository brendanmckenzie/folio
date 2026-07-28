import { generateKeyBetween } from 'fractional-indexing'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { diff, summariseDiff } from '../core/diff'
import { childrenOf, type Doc, type Json } from '../core/doc'
import type { ActivityEntry } from '../core/protocol'
import { buildResolution, referencedIds } from '../core/resolve'
import { blankBlok, type SchemaIndex } from '../core/schema'
import type { StoryNode } from '../core/story'
import type { VersionMeta } from '../server/versions'
import { BlockTree } from './BlockTree'
import { formatWhen, History } from './History'
import { Inspector } from './Inspector'
import { PageAddress } from './PageAddress'
import { StoryTree } from './StoryTree'
import { StoryStore } from './store'

const VIEWPORTS = { Desktop: '100%', Tablet: '834px', Phone: '390px' } as const
type Viewport = keyof typeof VIEWPORTS

/**
 * Phrased from the viewer's standpoint: they are looking at the version, so
 * differences are described as what the *draft* has done since.
 *
 * `diff(live, version)` turns the draft into the version, so an `insert` is a
 * block this version has that the draft lacks, and a `remove` is one the draft
 * gained afterwards.
 */
function describeAgainstDraft(d: ReturnType<typeof summariseDiff> | null): string {
  if (!d || d.total === 0) return 'identical to the current draft'
  const parts = [
    d.edited && `${d.edited} block${d.edited === 1 ? '' : 's'} changed since`,
    d.added && `${d.added} block${d.added === 1 ? '' : 's'} later deleted`,
    d.removed && `${d.removed} block${d.removed === 1 ? '' : 's'} added since`,
    d.moved && `${d.moved} moved`,
  ].filter(Boolean)
  return parts.join(', ')
}

interface Props {
  storyId: string
  schema: SchemaIndex
  apiBase: string
}

function flatten(nodes: StoryNode[]): StoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)])
}

export function Editor({ storyId: initialStoryId, schema, apiBase }: Props) {
  // Switching pages is client-side: the rail keeps its state, the story tree
  // stays put, and there is no full reload.
  const [storyId, setStoryId] = useState(initialStoryId)
  const store = useMemo(() => new StoryStore(storyId, apiBase), [storyId, apiBase])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const frame = useRef<HTMLIFrameElement>(null)

  const [tree, setTree] = useState<StoryNode[]>([])
  const [rail, setRail] = useState<'content' | 'blocks' | 'history'>('blocks')
  const [viewport, setViewport] = useState<Viewport>('Desktop')
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)
  const [versions, setVersions] = useState<VersionMeta[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * Read-only preview of a past version. The store is untouched: the version's
   * document is pushed straight into the preview iframe, and live mutations stop
   * being forwarded so they cannot corrupt what is on screen.
   */
  const [viewing, setViewing] = useState<{ version: VersionMeta; doc: Doc } | null>(null)
  // Holds the document, not just a flag, so an iframe reload mid-preview can be
  // re-seeded with the version rather than the live draft.
  const viewingRef = useRef<Doc | null>(null)
  viewingRef.current = viewing?.doc ?? null

  const flat = useMemo(() => flatten(tree), [tree])
  const current = useMemo(() => flat.find((s) => s.id === storyId), [flat, storyId])

  /**
   * `/folio/stories` already returns every story's id, path and URL, so links
   * resolve with no extra fetching. Rebuilt only when the tree changes, which is
   * exactly when a rename or move can have altered a URL.
   */
  const base = useMemo(() => buildResolution(flat, `${apiBase}/asset`), [apiBase, flat])

  /**
   * Documents pulled in by `reference` fields. Keyed by story id and fetched only
   * when the *set* of referenced ids changes — never per render, because the
   * preview re-renders on every keystroke with no network in the loop.
   */
  const [refDocs, setRefDocs] = useState<Record<string, Doc>>({})
  const wantedIds = useMemo(
    () => (state.doc ? referencedIds(state.doc, schema).sort().join(',') : ''),
    [schema, state.doc],
  )

  useEffect(() => {
    const ids = wantedIds ? wantedIds.split(',') : []
    const missing = ids.filter((id) => !refDocs[id])
    if (missing.length === 0) return
    let live = true
    void Promise.all(
      missing.map(async (id) => {
        const res = await fetch(`${apiBase}/story/${encodeURIComponent(id)}/document`)
        return res.ok ? ([id, ((await res.json()) as { doc: Doc }).doc] as const) : null
      }),
    ).then((loaded) => {
      const found = loaded.filter((entry): entry is [string, Doc] => entry !== null)
      if (live && found.length) setRefDocs((prev) => ({ ...prev, ...Object.fromEntries(found) }))
    })
    return () => {
      live = false
    }
  }, [apiBase, refDocs, wantedIds])

  const resolution = useMemo(() => ({ ...base, docs: refDocs }), [base, refDocs])
  const resolutionRef = useRef(resolution)
  resolutionRef.current = resolution

  const loadTree = useCallback(async () => {
    const res = await fetch(`${apiBase}/stories`)
    if (res.ok) setTree((await res.json()) as StoryNode[])
  }, [apiBase])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  const loadHistory = useCallback(async () => {
    const [v, a] = await Promise.all([
      fetch(`${apiBase}/story/${encodeURIComponent(storyId)}/versions`),
      fetch(`${apiBase}/story/${encodeURIComponent(storyId)}/activity`),
    ])
    if (v.ok) setVersions((await v.json()) as VersionMeta[])
    if (a.ok) setActivity((await a.json()) as ActivityEntry[])
  }, [apiBase, storyId])

  useEffect(() => {
    if (rail === 'history') void loadHistory()
  }, [loadHistory, rail])

  const openStory = useCallback(
    (id: string) => {
      if (id === storyId) return
      setStoryId(id)
      window.history.pushState({ folioStoryId: id }, '', `${apiBase}/edit/${id}`)
    },
    [apiBase, storyId],
  )

  useEffect(() => {
    const onPop = () => {
      const id = window.location.pathname.split('/').pop()
      if (id) setStoryId(id)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (current) document.title = `${current.title} · Folio`
  }, [current])

  const toFrame = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: 'folio-admin', ...msg }, window.location.origin)
  }, [])

  const keyAt = useCallback(
    (parent: string, slot: string, index: number, ignore?: string) => {
      const doc = store.getSnapshot().doc
      if (!doc) return generateKeyBetween(null, null)
      const sibs = childrenOf(doc, parent, slot).filter((b) => b.uid !== ignore)
      return generateKeyBetween(index > 0 ? (sibs[index - 1]?.order ?? null) : null, sibs[index]?.order ?? null)
    },
    [store],
  )

  const addBlock = useCallback(
    (parent: string, slot: string, type: string, index: number) => {
      const blok = blankBlok(schema, type, parent, slot, keyAt(parent, slot, index))
      store.tx([{ t: 'insert', blok }])
      store.select(blok.uid)
    },
    [keyAt, schema, store],
  )

  const moveBlock = useCallback(
    (uid: string, parent: string, slot: string, index: number) => {
      const doc = store.getSnapshot().doc
      if (!doc) return
      for (let cur: string | null = parent; cur; cur = doc.bloks[cur]?.parent ?? null) {
        if (cur === uid) return
      }
      const field = schema[doc.bloks[parent]?.type ?? '']?.fields[slot]
      if (field?.kind !== 'blocks' || !field.allow.includes(doc.bloks[uid]?.type ?? '')) return
      store.tx([{ t: 'move', uid, parent, slot, order: keyAt(parent, slot, index, uid) }])
    },
    [keyAt, schema, store],
  )

  useEffect(() => {
    store.onMutations = (mutations) => {
      // While previewing a version the iframe is showing something other than
      // the live document, so live edits must not be applied to it.
      if (viewingRef.current) return
      toFrame({ type: 'apply', mutations })
    }
    store.onReset = (doc) => {
      if (viewingRef.current) return
      toFrame({ type: 'replace', doc })
    }
    store.connect()
    return () => store.disconnect()
  }, [store, toFrame])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const msg = e.data as { source?: string; type?: string; uid?: string; parent?: string; slot?: string }
      if (msg?.source !== 'folio-preview') return

      if (msg.type === 'ready') {
        const doc = viewingRef.current ?? store.getSnapshot().doc
        toFrame({ type: 'resolve', resolution: resolutionRef.current })
        if (doc) toFrame({ type: 'replace', doc })
      } else if (msg.type === 'select' && msg.uid) {
        store.select(msg.uid)
        if (!viewingRef.current) setRail('blocks')
      } else if (msg.type === 'add' && msg.parent && msg.slot) {
        if (viewingRef.current) return
        const field = schema[store.getSnapshot().doc?.bloks[msg.parent]?.type ?? '']?.fields[msg.slot]
        const first = field?.kind === 'blocks' ? field.allow[0] : undefined
        if (first) addBlock(msg.parent, msg.slot, first, 0)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [addBlock, schema, store, toFrame])

  useEffect(() => {
    // The root block wraps the whole page, so outlining it in the preview would
    // just frame everything. Select it in the inspector without highlighting.
    const uid = state.selection === state.doc?.root ? null : state.selection
    toFrame({ type: 'select', uid })
  }, [state.doc?.root, state.selection, toFrame])

  // Renaming or moving a page changes what a story link resolves to, so the
  // preview needs the new mapping without re-rendering from the server.
  useEffect(() => {
    toFrame({ type: 'resolve', resolution })
  }, [resolution, toFrame])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      // Undo would edit the live document while the screen shows a version.
      if (viewingRef.current) return
      e.preventDefault()
      if (e.shiftKey) store.redo()
      else store.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  const setField = useCallback(
    (field: string, value: Json) => {
      if (state.selection) store.tx([{ t: 'set', uid: state.selection, field, value }])
    },
    [state.selection, store],
  )

  const publish = useCallback(async () => {
    setPublishing(true)
    try {
      await fetch(`${apiBase}/story/${encodeURIComponent(storyId)}/publish`, { method: 'POST' })
      setPublished(true)
      setTimeout(() => setPublished(false), 2000)
      await Promise.all([loadTree(), loadHistory()])
    } finally {
      setPublishing(false)
    }
  }, [apiBase, loadHistory, loadTree, storyId])

  const saveCheckpoint = useCallback(
    async (label: string) => {
      setHistoryBusy(true)
      try {
        await fetch(`${apiBase}/story/${encodeURIComponent(storyId)}/versions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label, actor: store.name }),
        })
        await loadHistory()
      } finally {
        setHistoryBusy(false)
      }
    },
    [apiBase, loadHistory, store.name, storyId],
  )

  const viewVersion = useCallback(
    async (version: VersionMeta) => {
      setHistoryBusy(true)
      try {
        const res = await fetch(`${apiBase}/versions/${encodeURIComponent(version.id)}`)
        if (!res.ok) {
          setNotice('Could not load that version.')
          return
        }
        const { doc } = (await res.json()) as { doc: Doc }
        setViewing({ version, doc })
        viewingRef.current = doc
        toFrame({ type: 'replace', doc })
        store.select(null)
      } finally {
        setHistoryBusy(false)
      }
    },
    [apiBase, store, toFrame],
  )

  const exitView = useCallback(() => {
    setViewing(null)
    viewingRef.current = null
    const live = store.getSnapshot().doc
    if (live) toFrame({ type: 'replace', doc: live })
    store.select(live?.root ?? null)
  }, [store, toFrame])

  /**
   * Restore does not overwrite the document. It diffs the live document against
   * the version and applies the result as one transaction, so the restore
   * reaches other editors and Cmd+Z undoes it.
   */
  const restore = useCallback(
    async (version: VersionMeta, preloaded?: Doc) => {
      const live = store.getSnapshot().doc
      if (!live) return
      setHistoryBusy(true)
      try {
        let target = preloaded
        if (!target) {
          const res = await fetch(`${apiBase}/versions/${encodeURIComponent(version.id)}`)
          if (!res.ok) {
            setNotice('Could not load that version.')
            return
          }
          target = ((await res.json()) as { doc: Doc }).doc
        }
        const mutations = diff(live, target)
        if (mutations.length === 0) {
          setNotice('Already identical to that version.')
          return
        }
        // Leave preview first so the live document flows to the iframe again.
        setViewing(null)
        viewingRef.current = null
        store.tx(mutations)
        const s = summariseDiff(mutations)
        setNotice(
          `Restored: ${[
            s.edited && `${s.edited} edited`,
            s.added && `${s.added} added`,
            s.removed && `${s.removed} removed`,
            s.moved && `${s.moved} moved`,
          ]
            .filter(Boolean)
            .join(', ')}. Cmd+Z to undo.`,
        )
        await loadHistory()
      } catch (e) {
        setNotice((e as Error).message)
      } finally {
        setHistoryBusy(false)
      }
    },
    [apiBase, loadHistory, store],
  )

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const patchStory = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      await fetch(`${apiBase}/stories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await loadTree()
    },
    [apiBase, loadTree],
  )

  const createStory = useCallback(
    async (title: string, parentId: string | null) => {
      const res = await fetch(`${apiBase}/stories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, parentId }),
      })
      if (!res.ok) return
      const story = (await res.json()) as StoryNode
      await loadTree()
      // Stay on the Content tab: you have just been working with the tree.
      openStory(story.id)
    },
    [apiBase, loadTree, openStory],
  )

  const removeStory = useCallback(
    async (story: StoryNode) => {
      await fetch(`${apiBase}/stories/${encodeURIComponent(story.id)}`, { method: 'DELETE' })
      await loadTree()
      if (story.id === storyId) {
        const fallback = flat.find((s) => s.path === '') ?? flat.find((s) => s.id !== story.id)
        if (fallback) openStory(fallback.id)
      }
    },
    [apiBase, flat, loadTree, openStory, storyId],
  )

  // While previewing, the tree and the iframe both show the version's document.
  const shownDoc = viewing?.doc ?? state.doc
  const selected = state.selection && shownDoc ? (shownDoc.bloks[state.selection] ?? null) : null
  const isRootBlok = Boolean(!viewing && state.doc && state.selection === state.doc.root)

  const viewingDelta = useMemo(() => {
    if (!viewing || !state.doc) return null
    try {
      return summariseDiff(diff(state.doc, viewing.doc))
    } catch {
      return null
    }
  }, [state.doc, viewing])

  return (
    <div className="editor">
      {/* Out of the toolbar's flow: a transient message must never reflow
          controls the user is about to click. */}
      {notice ? <div className="toast">{notice}</div> : null}

      <header className="topbar">
        <div className="topbar__left">
          <strong>Folio</strong>
          <span className="topbar__slug">{current?.url ?? '/'}</span>
          <span className={`dot ${state.connected ? 'dot--ok' : 'dot--off'}`} />
          <span className="topbar__status">
            {state.connected ? (state.inflight > 0 ? 'Saving…' : 'Synced') : 'Connecting…'}
          </span>
        </div>

        <div className="topbar__mid">
          {(Object.keys(VIEWPORTS) as Viewport[]).map((v) => (
            <button key={v} type="button" className={viewport === v ? 'is-active' : ''} onClick={() => setViewport(v)}>
              {v}
            </button>
          ))}
        </div>

        <div className="topbar__right">
          <div className="peers">
            <span className="peer peer--me" style={{ background: store.colour }} title={`${store.name} (you)`} />
            {state.peers.map((p) => (
              <span key={p.actor} className="peer" style={{ background: p.colour }} title={p.name} />
            ))}
          </div>
          <button type="button" disabled={!state.canUndo} onClick={() => store.undo()} title="Undo (Cmd+Z)">
            Undo
          </button>
          <button type="button" disabled={!state.canRedo} onClick={() => store.redo()} title="Redo (Shift+Cmd+Z)">
            Redo
          </button>
          {current ? (
            <a className="topbar__link" href={current.url} target="_blank" rel="noreferrer">
              View live
            </a>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            onClick={publish}
            // Publishing sends the live draft, not what a version preview shows.
            disabled={publishing || !state.doc || viewing !== null}
            title={viewing ? 'Close the version preview first' : undefined}
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
          {published ? <span className="topbar__flash">Published</span> : null}
        </div>
      </header>

      <div className="editor__body">
        <div className="rail">
          <div className="rail__tabs">
            <button type="button" className={rail === 'content' ? 'is-active' : ''} onClick={() => setRail('content')}>
              Content
            </button>
            <button type="button" className={rail === 'blocks' ? 'is-active' : ''} onClick={() => setRail('blocks')}>
              Blocks
            </button>
            <button type="button" className={rail === 'history' ? 'is-active' : ''} onClick={() => setRail('history')}>
              History
            </button>
          </div>

          {rail === 'content' ? (
            <StoryTree
              tree={tree}
              currentId={storyId}
              onOpen={(story) => openStory(story.id)}
              onCreate={createStory}
              onMove={(id, parentId, index) => patchStory(id, { parentId, index })}
              onDelete={removeStory}
            />
          ) : rail === 'history' ? (
            state.doc ? (
              <History
                versions={versions}
                activity={activity}
                doc={state.doc}
                schema={schema}
                busy={historyBusy}
                viewingId={viewing?.version.id ?? null}
                onCheckpoint={saveCheckpoint}
                onView={viewVersion}
                onExitView={exitView}
                onRefresh={() => void loadHistory()}
              />
            ) : (
              <p className="rail__loading">Loading…</p>
            )
          ) : shownDoc ? (
            <BlockTree
              doc={shownDoc}
              schema={schema}
              selection={state.selection}
              peers={state.peers}
              onSelect={(uid) => store.select(uid)}
              onAdd={addBlock}
              onMove={moveBlock}
            />
          ) : (
            <p className="rail__loading">Loading…</p>
          )}
        </div>

        <div className="stage">
          {viewing ? (
            <div className="viewbar">
              <span className="viewbar__dot" />
              <span className="viewbar__text">
                Viewing{' '}
                <strong>
                  {viewing.version.label || (viewing.version.kind === 'publish' ? 'a published version' : 'a checkpoint')}
                </strong>{' '}
                from {formatWhen(viewing.version.createdAt)}
                <span className="viewbar__delta">
                  {' · '}
                  {describeAgainstDraft(viewingDelta)}
                </span>
              </span>
              <button type="button" onClick={exitView}>
                Close
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={historyBusy || viewingDelta?.total === 0}
                onClick={() => void restore(viewing.version, viewing.doc)}
              >
                Restore this version
              </button>
            </div>
          ) : null}

          <div className={`stage__frame ${viewing ? 'is-viewing' : ''}`} style={{ width: VIEWPORTS[viewport] }}>
            {current ? (
              <iframe key={current.id} ref={frame} title="Preview" src={current.previewUrl} />
            ) : null}
          </div>
        </div>

        <Inspector
          blok={selected}
          schema={schema}
          stories={flat}
          apiBase={apiBase}
          readOnly={viewing !== null}
          onChange={setField}
          onRemove={(uid) => {
            store.tx([{ t: 'remove', uid }])
            store.select(null)
          }}
          address={
            isRootBlok && current ? (
              <PageAddress
                story={current}
                all={flat}
                onChange={(patch) => patchStory(current.id, patch)}
              />
            ) : null
          }
        />
      </div>
    </div>
  )
}
