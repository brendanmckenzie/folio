import type { summariseDiff } from '../core/diff'
import type { Doc } from '../core/doc'
import type { VersionMeta } from '../server/versions'
import { formatWhen } from './History'

/**
 * Phrased from the viewer's standpoint: they are looking at the version, so
 * differences are described as what the *draft* has done since.
 *
 * `diff(live, version)` turns the draft into the version, so an `insert` is a
 * block this version has that the draft lacks, and a `remove` is one the draft
 * gained afterwards.
 */
export function describeAgainstDraft(d: ReturnType<typeof summariseDiff> | null): string {
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
  version: VersionMeta
  doc: Doc
  delta: ReturnType<typeof summariseDiff> | null
  busy: boolean
  onExit: () => void
  onRestore: (version: VersionMeta, preloaded: Doc) => void
}

/** The banner over the stage while a past version is on screen. */
export function ViewingBar({ version, doc, delta, busy, onExit, onRestore }: Props) {
  return (
    <div className="viewbar">
      <span className="viewbar__dot" />
      <span className="viewbar__text">
        Viewing{' '}
        <strong>
          {version.label || (version.kind === 'publish' ? 'a published version' : 'a checkpoint')}
        </strong>{' '}
        from {formatWhen(version.createdAt)}
        <span className="viewbar__delta">
          {' · '}
          {describeAgainstDraft(delta)}
        </span>
      </span>
      <button type="button" onClick={onExit}>
        Close
      </button>
      <button
        type="button"
        className="btn-primary"
        disabled={busy || delta?.total === 0}
        onClick={() => onRestore(version, doc)}
      >
        Restore this version
      </button>
    </div>
  )
}
