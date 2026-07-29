import { useState } from 'react'
import type { Redirect } from '../server/redirects'
import type { RedirectFilter } from './hooks/useRedirects'

interface Props {
  rows: Redirect[]
  loading: boolean
  source: RedirectFilter
  onSourceChange: (source: RedirectFilter) => void
  onCreate: (from: string, to: string) => Promise<void>
  onDelete: (from: string) => Promise<void>
}

/**
 * redirects.md's admin screen: a flat list is enough. `source` is a filter
 * over one table rather than two tables, the same reason it is a single
 * column in D1 — the lookup, the safety check and this list are identical
 * either way (architecture decision 4).
 */
export function Redirects({ rows, loading, source, onSourceChange, onCreate, onDelete }: Props) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  return (
    <div className="redirects">
      <header className="redirects__head">
        <h2>Redirects</h2>
        <select
          value={source}
          onChange={(e) => onSourceChange(e.target.value as RedirectFilter)}
          aria-label="Filter by source"
        >
          <option value="all">All</option>
          <option value="auto">Automatic</option>
          <option value="manual">Manual</option>
        </select>
      </header>

      <form
        className="redirects__new"
        onSubmit={(e) => {
          e.preventDefault()
          const f = from.trim()
          const t = to.trim()
          if (!f || !t) return
          void onCreate(f, t).then(() => {
            setFrom('')
            setTo('')
          })
        }}
      >
        <input
          placeholder="old-path"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="Redirect from"
        />
        <span aria-hidden="true">→</span>
        <input
          placeholder="new-path or https://…"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Redirect to"
        />
        <button type="submit" className="btn-primary">
          Add
        </button>
      </form>

      {loading ? (
        <p className="redirects__loading">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="redirects__empty">No redirects yet.</p>
      ) : (
        <ul className="redirects__list">
          {rows.map((r) => (
            <li key={r.from} className="redirects__row">
              <code className="redirects__from">/{r.from}</code>
              <span aria-hidden="true">→</span>
              <code className="redirects__to">{r.to}</code>
              <span className="redirects__status">{r.status}</span>
              <span className={`redirects__badge redirects__badge--${r.source}`}>{r.source}</span>
              <button type="button" title="Delete redirect" onClick={() => void onDelete(r.from)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
