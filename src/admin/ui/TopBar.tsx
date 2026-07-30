import type { ReactNode } from 'react'
import { Menu, type MenuItem } from './Menu'
import { type Crumb, href } from './route'
import css from './TopBar.module.css'

interface Props {
  crumbs: readonly Crumb[]
  mount: string
  /** Presence avatars, and anything else that belongs to the session rather than
   * the screen. A slot rather than a prop-per-thing, because the editor is the
   * only surface that fills it and the platform screens leave it empty. */
  presence?: ReactNode
  onSearch: () => void
  /** The signed-in actor's name, or null under `auth: 'open'` where there is
   * nobody to name and therefore no menu to draw. */
  actor: string | null
  user: readonly MenuItem[]
}

/**
 * The top bar: **a breadcrumb, not a title** (`docs/ui-architecture.md`, the
 * shell). That is the fix for the review's finding that a record opened from a
 * list had no way back to it — every segment but the last is a link, and the last
 * is where you are.
 *
 * 40px, one hairline, and nothing on it that belongs to a screen. Per-screen
 * actions live on the screen, where the thing they act on is.
 */
export function TopBar({ crumbs, mount, presence, onSearch, actor, user }: Props) {
  return (
    <header className={css.bar}>
      <nav className={css.crumbs} aria-label="Breadcrumb">
        {crumbs.map((crumb, i) => (
          // Keyed on the destination, which every crumb but the last has, and on
          // the text for the last one — of which there is exactly one. Unique
          // without an index, so React reuses the right node when a trail grows a
          // level rather than reusing by position.
          <span className={css.crumb} key={crumb.screen ? href(crumb.screen, mount) : crumb.text}>
            {i > 0 ? (
              <span className={css.sep} aria-hidden="true">
                /
              </span>
            ) : null}
            {crumb.screen ? (
              <a className={css.link} href={href(crumb.screen, mount)}>
                {crumb.text}
              </a>
            ) : (
              <span className={css.here} aria-current="page">
                {crumb.text}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div className={css.right}>
        {presence}
        {/*
          A button rather than an input. The palette is a modal surface with its
          own focus management (`Palette.tsx`), and a text field that discards its
          own value the moment it is clicked is the worst of both — this states the
          chord instead, which is also how the shortcut becomes discoverable
          without reading `?`.
        */}
        <button type="button" className={css.search} onClick={onSearch}>
          <span>Search</span>
          <kbd className={css.kbd}>⌘K</kbd>
        </button>
        {actor ? (
          <Menu trigger={actor} items={user} />
        ) : (
          <span className={css.anon}>Not signed in</span>
        )}
      </div>
    </header>
  )
}
