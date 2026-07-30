import type { ReactNode } from 'react'
import css from './Badge.module.css'

/**
 * One tone per meaning, enforced by there being no others. From
 * `docs/design-system.md`'s state palette: `ok` is completeness, `warn` is drift
 * and history, `danger` is withdrawal and refusal, `accent` is attention, and
 * `neutral` is a fact about the row rather than a state to act on.
 */
export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

interface Props {
  tone?: BadgeTone
  /** Paths, slugs, ids, scopes. See the brief's third commitment. */
  mono?: boolean
  /** Tabular numerals, for a count that must not jitter as it changes. */
  numeric?: boolean
  title?: string
  children: ReactNode
}

/**
 * Replaces five separate badge implementations (`.stories__badge`,
 * `.stories__chip`, `.redirects__badge`, `.migrations__badge`, `.stories__i18n`),
 * each of which had picked its own palette.
 *
 * Note what is *not* here: a `draft` tone. A draft is `neutral` — the normal
 * state of new content, not a warning — which is the one deliberate change to
 * the state palette the review argued for.
 */
export function Badge({ tone = 'neutral', mono, numeric, title, children }: Props) {
  return (
    <span
      title={title}
      className={[css.badge, css[tone], mono ? css.mono : '', numeric ? css.numeric : ''].join(' ')}
    >
      {children}
    </span>
  )
}
