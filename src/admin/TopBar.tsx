import { useState } from 'react'
import type { StoryNode } from '../core/story'
import { useFolio, useStoreState } from './FolioContext'
import type { PreviewMode } from './hooks/useVersions'

/** Stage widths. The value is the CSS width the frame is given, not a breakpoint. */
export const VIEWPORTS = { Desktop: '100%', Tablet: '834px', Phone: '390px' } as const
export type Viewport = keyof typeof VIEWPORTS

interface Props {
  current: StoryNode | undefined
  viewport: Viewport
  onViewport: (v: Viewport) => void
  mode: PreviewMode
  publishing: boolean
  published: boolean
  onPublish: () => void
  /** Opens the confirmation; Editor.tsx owns whether it is showing. */
  onRequestUnpublish: () => void
}

export function TopBar({
  current,
  viewport,
  onViewport,
  mode,
  publishing,
  published,
  onPublish,
  onRequestUnpublish,
}: Props) {
  const { store } = useFolio()
  const state = useStoreState(store)
  // The first secondary publishing action, so it earns a small menu rather
  // than a second button squeezed in beside Publish.
  const [menuOpen, setMenuOpen] = useState(false)
  const canUnpublish = current?.state === 'live' && mode !== 'viewing'

  return (
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
          <button
            key={v}
            type="button"
            className={viewport === v ? 'is-active' : ''}
            onClick={() => onViewport(v)}
          >
            {v}
          </button>
        ))}
      </div>

      <div className="topbar__right">
        <div className="peers">
          <span
            className="peer peer--me"
            style={{ background: store.colour }}
            title={`${store.name} (you)`}
          />
          {state.peers.map((p) => (
            <span key={p.actor} className="peer" style={{ background: p.colour }} title={p.name} />
          ))}
        </div>
        <button
          type="button"
          disabled={!state.canUndo}
          onClick={() => store.undo()}
          title="Undo (Cmd+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!state.canRedo}
          onClick={() => store.redo()}
          title="Redo (Shift+Cmd+Z)"
        >
          Redo
        </button>
        {current ? (
          <a className="topbar__link" href={current.url} target="_blank" rel="noreferrer">
            View live
          </a>
        ) : null}
        <div className="publish-menu">
          <button
            type="button"
            className="btn-primary publish-menu__main"
            onClick={onPublish}
            // Publishing sends the live draft, not what a version preview shows.
            disabled={publishing || !state.doc || mode === 'viewing'}
            title={mode === 'viewing' ? 'Close the version preview first' : undefined}
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
          <button
            type="button"
            className="btn-primary publish-menu__toggle"
            aria-label="More publishing actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={!current}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ▾
          </button>
          {menuOpen ? (
            <>
              {/* Clicking outside closes the menu, the same pattern the media
                  library's modal scrim uses. */}
              <button
                type="button"
                className="publish-menu__scrim"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
              />
              <div className="publish-menu__list" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canUnpublish}
                  title={canUnpublish ? undefined : 'Only a live page can be unpublished'}
                  onClick={() => {
                    setMenuOpen(false)
                    onRequestUnpublish()
                  }}
                >
                  Unpublish…
                </button>
              </div>
            </>
          ) : null}
        </div>
        {published ? <span className="topbar__flash">Published</span> : null}
      </div>
    </header>
  )
}
