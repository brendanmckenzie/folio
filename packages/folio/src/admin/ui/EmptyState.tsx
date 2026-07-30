import type { ReactNode } from 'react'
import css from './EmptyState.module.css'

interface Props {
  title: ReactNode
  /** What to do about it. An empty state with no next step is an error message. */
  body?: ReactNode
  action?: ReactNode
}

/**
 * Replaces six ad-hoc empty paragraphs (`.library__empty`, `.history__empty`,
 * `.redirects__empty`, `.migrations__empty`, `.data__empty`,
 * `.datatable__empty`), which had four different alignments between them.
 */
export function EmptyState({ title, body, action }: Props) {
  return (
    <div className={css.empty}>
      <p className={css.title}>{title}</p>
      {body ? <p className={css.body}>{body}</p> : null}
      {action ? <div className={css.action}>{action}</div> : null}
    </div>
  )
}
