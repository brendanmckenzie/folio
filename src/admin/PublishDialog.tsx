import { useId, useRef } from 'react'
import type { LocaleConfig, TranslationStatus } from '../core/locales'
import { useFocusTrap } from './hooks/useFocusTrap'

/**
 * "80% of French" — the number an editor actually asks for, and the one the
 * badge in the tree shows too.
 *
 * A locale with nothing translatable at all reads 100%: there is no work owed, so
 * calling it 0% would put a permanent warning on a page that cannot be
 * translated any further.
 */
export function percentDone(status: TranslationStatus): number {
  if (status.total === 0) return 100
  return Math.round((status.translated / status.total) * 100)
}

/** A locale's label from the config, or its bare code. */
export function localeLabel(locales: LocaleConfig | undefined, code: string): string {
  return locales?.available.find((l) => l.code === code)?.label ?? code
}

/** The first few missing fields, named. Truncated because a warning nobody reads
 * is the same as no warning: five names and a count is legible, forty is not. */
const SHOWN = 5

export function missingSummary(status: TranslationStatus): string {
  const names = status.missing.slice(0, SHOWN).map((m) => m.label)
  const rest = status.missing.length - names.length
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ')
}

interface Props {
  gaps: readonly TranslationStatus[]
  locales: LocaleConfig | undefined
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The mitigation `localisation.md` checkpoint 3 promised.
 *
 * Publishing publishes **every locale at once**: one document, one
 * `published_doc`, one atomic snapshot. That is the right trade — a locale
 * column on the publish path would mean N version rows per publish and an editor
 * able to publish a page whose English is three revisions ahead of its French —
 * but it does mean a half-translated page goes live with fallbacks, and going
 * live is not the moment to discover that.
 *
 * So this confirmation appears **only when a locale is incomplete**, and it
 * *names what is missing* rather than saying "some translations are incomplete".
 * A complete page publishes on one click, exactly as before this spec: a
 * confirmation that always appears is a confirmation nobody reads.
 *
 * Never a refusal. Publishing a half-translated page with fallbacks is a
 * legitimate and common thing to want — launching English first is how most
 * sites ship — so this says what will happen and gets out of the way.
 */
export function PublishDialog({ gaps, locales, busy, onConfirm, onCancel }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Inert while the publish is in flight, matching the Cancel button beneath.
  // `publish.publish` reports its own failures and always resolves, so `busy`
  // always clears.
  const dismiss = () => {
    if (!busy) onCancel()
  }
  useFocusTrap(panel, dismiss)

  return (
    <div className="discard">
      {/* Clicking the backdrop cancels, matching every other confirmation here.
          `tabIndex={-1}` keeps it out of the cycle: the visible Cancel button is
          the keyboard route out. */}
      <button
        type="button"
        className="discard__scrim"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={dismiss}
      />
      {/* The dialog is the panel, not the overlay, so the scrim's own "Cancel"
          label stays outside the region the dialog names. */}
      <div
        ref={panel}
        className="discard__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId}>Publish with incomplete translations?</h3>

        <p>
          Publishing publishes every language at once. These will go live with the source language
          showing wherever a field is untranslated:
        </p>

        <ul className="publish-gaps">
          {gaps.map((gap) => (
            <li key={gap.locale}>
              <strong>{localeLabel(locales, gap.locale)}</strong> — {percentDone(gap)}% translated,
              missing {missingSummary(gap)}
            </li>
          ))}
        </ul>

        <div className="discard__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Publishing…' : 'Publish anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}
