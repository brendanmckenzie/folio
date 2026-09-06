import { useEffect, useState } from 'react'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import css from './Forms.module.css'
import { messageOf } from './useContent'

/** What `GET {base}/api/forms/:id/usage` answers — a superset of the asset and
 *  document usage shapes (`server/forms.ts`'s `formUsage` says why). */
interface FormUsage {
  published: { id: string; title: string; path: string | null }[]
  total: number
  responses: number
  files: number
}

/** Enough to recognise the problem, few enough that the dialog does not scroll
 *  into a list — the same rule `AssetDeleteDialog.tsx` and `DeleteDialog.tsx`
 *  follow. */
const USAGE_SHOWN = 5

/**
 * The confirmation before deleting a form — decision 17's "warn on both counts
 * and then cascade", the media library's decision 14 in another costume. Every
 * number the delete is about to destroy, named before it runs: the published
 * pages that render this form, its responses, and the files inside them.
 *
 * Shared between the list screen (`Forms.tsx`) and the builder
 * (`FormBuilder.tsx`), which is why it takes `id`/`label` rather than either
 * screen's own row shape and fetches its own usage rather than trusting a
 * caller to have one already — `FormBuilder` does hold a usage read from
 * `useForm`, but a dialog that sometimes fetches and sometimes doesn't is two
 * behaviours to reason about for one extra request.
 *
 * A failed usage read must not block the delete, only the reassurance — the
 * count is advisory, so leaving Delete live while saying "could not check" is
 * the honest answer, the same posture the two existing usage dialogs take.
 */
export function FormDeleteDialog({
  apiBase,
  id,
  label,
  onClose,
  onConfirm,
}: {
  apiBase: string
  id: string
  label: string
  onClose: () => void
  onConfirm: () => void
}) {
  const [usage, setUsage] = useState<FormUsage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch(`${apiBase}/forms/${encodeURIComponent(id)}/usage`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await messageOf(res))
        return (await res.json()) as FormUsage
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
  }, [apiBase, id])

  return (
    <Dialog
      title={`Delete "${label || 'Untitled form'}"?`}
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
      <p className={css.dialogNote}>The form, every response and every uploaded file all go.</p>
      {error ? (
        <p className={css.dialogNote}>Could not check what this affects: {error}</p>
      ) : usage === null ? (
        <p className={css.dialogNote}>Checking what this affects…</p>
      ) : (
        <>
          <p className={css.dialogNote}>
            <b>{usage.responses}</b> {usage.responses === 1 ? 'response' : 'responses'} and{' '}
            <b>{usage.files}</b> uploaded {usage.files === 1 ? 'file' : 'files'} will be destroyed
            with it.
          </p>
          {usage.total === 0 ? (
            <p className={css.dialogNote}>No published page renders this form.</p>
          ) : (
            <>
              <p className={css.dialogNote}>
                Rendered on <b>{usage.total}</b> published {usage.total === 1 ? 'page' : 'pages'},
                which will show nothing where it was:
              </p>
              <ul className={css.usage}>
                {usage.published.slice(0, USAGE_SHOWN).map((ref) => (
                  <li key={ref.id}>
                    <span className={css.usageTitle}>{ref.title || 'Untitled'}</span>
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
        </>
      )}
    </Dialog>
  )
}
