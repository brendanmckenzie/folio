import type { ReactNode } from 'react'
import css from './Stub.module.css'

/**
 * A screen that exists as a URL and says what it will be.
 *
 * Phase 1 of the port plan is explicit that "every route renders a stub", and
 * this is why: the thing being proven first is that **every screen is reachable,
 * linkable and named** — the sidebar lights up, the breadcrumb reads correctly,
 * the back button works, a refresh lands in the same place. A stub proves all of
 * that; a mock would prove it while also inviting somebody to judge a design
 * nobody has built.
 *
 * So each one states what it replaces and what it needs, which is the honest
 * content of a screen that is not written yet.
 */
export function Stub({
  title,
  children,
  needs,
}: {
  title: string
  children: ReactNode
  needs?: ReactNode
}) {
  return (
    <div className={css.screen}>
      <h1 className={css.title}>{title}</h1>
      <p className={css.body}>{children}</p>
      {needs ? (
        <section>
          <h2 className={css.heading}>Needs</h2>
          <ul className={css.needs}>{needs}</ul>
        </section>
      ) : null}
    </div>
  )
}
