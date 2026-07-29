import { useState } from 'react'
import type { summariseDiff } from '../core/diff'
import type { StoryNode } from '../core/story'
import { useFolio, useStoreState } from './FolioContext'
import type { PreviewMode } from './hooks/useVersions'
import { actorLabel, canPublish, type Me, whyNot } from './me'

/** Stage widths. The value is the CSS width the frame is given, not a breakpoint. */
export const VIEWPORTS = { Desktop: '100%', Tablet: '834px', Phone: '390px' } as const
export type Viewport = keyof typeof VIEWPORTS

type Delta = ReturnType<typeof summariseDiff>

export interface PublishStatus {
  label: string
  /** Only the "N unpublished changes" state is; it is the door into the
   * comparison view. */
  clickable: boolean
  /** Publish is pointless when true (owner decision 2): the story is
   * currently live and identical to what was published. */
  nothingToPublish: boolean
}

/**
 * The top bar's state machine (`unpublished-changes.md`'s phase 1, step 3),
 * replacing the bare "Synced" label. Order matters: connection state first,
 * since neither "up to date" nor a count means anything while the socket has
 * not settled; then whether this story has ever been published at all; only
 * then the draft-vs-published diff itself.
 *
 * `isLive` is the story's *current* state, not merely "has a publish version
 * ever existed": a story taken down (`unpublish.md`'s `'unpublished'` state)
 * can be identical to its last publish and still have something worth
 * publishing — bringing it back live — so "nothing to publish" only applies
 * while the page is actually serving the public.
 */
export function publishStatus(
  connected: boolean,
  inflight: number,
  everPublished: boolean,
  isLive: boolean,
  delta: Delta | null,
): PublishStatus {
  if (!connected) return { label: 'Connecting…', clickable: false, nothingToPublish: false }
  if (inflight > 0) return { label: 'Saving…', clickable: false, nothingToPublish: false }
  if (!everPublished) {
    return { label: 'Not published yet', clickable: false, nothingToPublish: false }
  }
  if (!delta || delta.total === 0) {
    return { label: 'Up to date', clickable: false, nothingToPublish: isLive }
  }
  return {
    label: `${delta.total} unpublished change${delta.total === 1 ? '' : 's'}`,
    clickable: true,
    nothingToPublish: false,
  }
}

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
  /** Whether this story has a `publish` version at all, and how the live
   * draft differs from the newest one (`usePublishedDoc`). */
  everPublished: boolean
  delta: Delta | null
  /** Enters the comparison view against the newest publish version. */
  onCompare: () => void
  /** Who is signed in, and therefore what this bar may offer
   * (`identity-and-access.md`). */
  me: Me
  /** Signs out and reloads. Owned by Editor.tsx, which knows the api base. */
  onSignOut: () => void
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
  everPublished,
  delta,
  onCompare,
  me,
  onSignOut,
}: Props) {
  const { store, locales, locale, setLocale } = useFolio()
  const state = useStoreState(store)
  // The first secondary publishing action, so it earns a small menu rather
  // than a second button squeezed in beside Publish.
  const [menuOpen, setMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  // The server is the authority; this only keeps the bar from offering an
  // action it will refuse (`identity-and-access.md` decision 5).
  const mayPublish = canPublish(me)
  const publishReason = whyNot(me, 'publish')
  const canUnpublish = current?.state === 'live' && mode !== 'viewing' && mayPublish
  const status = publishStatus(
    state.connected,
    state.inflight,
    everPublished,
    current?.state === 'live',
    delta,
  )

  return (
    <header className="topbar">
      <div className="topbar__left">
        <strong>Folio</strong>
        <span className="topbar__slug">{current?.url ?? '/'}</span>
        <span className={`dot ${state.connected ? 'dot--ok' : 'dot--off'}`} />
        {status.clickable ? (
          <button type="button" className="topbar__status topbar__status--link" onClick={onCompare}>
            {status.label}
          </button>
        ) : (
          <span className="topbar__status">{status.label}</span>
        )}
      </div>

      <div className="topbar__mid">
        {/* Only where there is more than one language to switch between: a
            switcher offering one option is furniture
            (`../../../docs/specs/content-model/localisation.md` phase 3). */}
        {locales && locales.available.length > 1 ? (
          <select
            className="topbar__locale"
            aria-label="Editing language"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
          >
            {locales.available.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
                {l.code === locales.default ? ' (source)' : ''}
              </option>
            ))}
          </select>
        ) : null}
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
          {/* The verified identity when there is one; the store's own generated
              pair only under `auth: 'open'`, where nothing else tells two
              anonymous tabs apart. */}
          <span
            className="peer peer--me"
            style={{ background: me.actor?.kind === 'user' ? me.actor.colour : store.colour }}
            title={`${actorLabel(me) ?? store.name} (you)`}
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
            disabled={
              publishing ||
              !state.doc ||
              mode === 'viewing' ||
              status.nothingToPublish ||
              !mayPublish
            }
            title={
              publishReason ??
              (mode === 'viewing'
                ? 'Close the version preview first'
                : status.nothingToPublish
                  ? 'No changes to publish'
                  : undefined)
            }
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
                  title={
                    canUnpublish
                      ? undefined
                      : (publishReason ?? 'Only a live page can be unpublished')
                  }
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

        {/* Only where there is an account to sign out of: under `auth: 'open'`
            there is nobody to name and nothing to end. */}
        {me.mode === 'session' ? (
          <div className="user-menu">
            <button
              type="button"
              className="user-menu__toggle"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((v) => !v)}
            >
              {actorLabel(me) ?? 'Signed out'}
            </button>
            {userMenuOpen ? (
              <>
                <button
                  type="button"
                  className="user-menu__scrim"
                  aria-label="Close menu"
                  onClick={() => setUserMenuOpen(false)}
                />
                <div className="user-menu__list" role="menu">
                  <span className="user-menu__role">
                    {me.actor?.kind === 'user' ? me.actor.role : 'no account'}
                  </span>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setUserMenuOpen(false)
                      onSignOut()
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  )
}
