import { useEffect, useState } from 'react'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import css from './Documents.module.css'
import type { DocumentRow } from './documents-model'
import { messageOf } from './useContent'

/** What `GET {base}/api/documents/:id/usage` answers. */
interface Usage {
  published: { id: string; title: string; path: string | null; url: string; kind: string }[]
  /** Distinct published documents — what "used on N published pages" counts. */
  total: number
  links: number
  references: number
}

/**
 * The confirmation before deleting a record, and it is where
 * `docs/specs/content-model/data-documents.md` decision 4 actually lands: **it warns
 * with a count and proceeds.**
 *
 * Not a block, and the reason is worth keeping in view. Refusing would mean
 * maintaining referential integrity across draft documents nobody can see, and a
 * broken reference already degrades safely — `resolveReference` returns null and the
 * block renders its empty state. So the dialog's job is to make sure the person
 * pressing Delete knows what points here, not to decide for them.
 *
 * The old admin had this dialog too, in `Editor.tsx`, reached from the Data table in
 * the editor's stage. It moves here with the table. What changes is that the usage
 * fetch is the dialog's own rather than the editor's: a screen that owns a delete
 * owns what the delete has to say for itself.
 */
export function DeleteDialog({
  apiBase,
  row,
  onClose,
  onConfirm,
}: {
  apiBase: string
  row: DocumentRow
  onClose: () => void
  onConfirm: () => void
}) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch(`${apiBase}/documents/${encodeURIComponent(row.id)}/usage`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await messageOf(res))
        return (await res.json()) as Usage
      })
      .then((body) => {
        if (live) setUsage(body)
      })
      .catch((e: Error) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [apiBase, row.id])

  const name = row.title || 'this document'

  return (
    <Dialog
      title={`Delete ${name}?`}
      description="This cannot be undone."
      danger
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>
            Delete
          </Button>
        </>
      }
    >
      <p className={css.dialogNote}>The document, its version history and its index rows all go.</p>
      {error ? (
        // A failed usage read must not block the delete, only the reassurance:
        // the count is advisory, so saying it is unknown is honest and leaving the
        // Delete button live is correct.
        <p className={css.dialogNote}>Could not check what references this: {error}</p>
      ) : usage === null ? (
        <p className={css.dialogNote}>Checking what references this…</p>
      ) : usage.total === 0 ? (
        <p className={css.dialogNote}>No published document references this one.</p>
      ) : (
        <>
          <p className={css.dialogNote}>
            Used on <b>{usage.total}</b> published {usage.total === 1 ? 'document' : 'documents'},
            which will keep pointing at nothing:
          </p>
          <ul className={css.usage}>
            {usage.published.slice(0, USAGE_SHOWN).map((ref) => (
              <li key={`${ref.id}:${ref.kind}`}>
                <span className={css.usageTitle}>{ref.title || 'Untitled'}</span>
                {/* The path, because it is what tells two same-titled pages apart.
                    A record referencing a record has none, and says so rather than
                    rendering an empty code span. */}
                <code className={css.usagePath}>
                  {ref.path === null ? 'not routed' : ref.path === '' ? '/' : `/${ref.path}`}
                </code>
              </li>
            ))}
          </ul>
          {usage.published.length > USAGE_SHOWN ? (
            <p className={css.dialogNote}>…and {usage.published.length - USAGE_SHOWN} more.</p>
          ) : null}
        </>
      )}
    </Dialog>
  )
}

/** Enough to recognise the problem, few enough that the dialog does not scroll into
 * a list. The count above it is the exact number either way. */
const USAGE_SHOWN = 5
