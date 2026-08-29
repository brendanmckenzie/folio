import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { href } from '../route'
import type { AssetRow } from './assets-model'
import { useUsage } from './AssetDetail'
import css from './Assets.module.css'

/** Enough to recognise the problem, few enough that the dialog does not scroll into
 * a list. The count above it is the exact number either way — the same rule
 * `DeleteDialog.tsx` follows for a document. */
const USAGE_SHOWN = 5

/**
 * The confirmation before deleting a file, and **it warns and proceeds** — the same
 * call `DeleteDialog.tsx` makes for a referenced document, and for the same reason,
 * which `server/assets.ts`'s `assetUsage` states at the source: maintaining
 * referential integrity across drafts nobody can see costs more than a broken
 * reference, and a missing image already degrades safely. It is visible and fixable,
 * whereas a delete that refuses leaves an editor with no way to remove a file at all.
 *
 * **This is the thing phase 4 is fixing.** The old library put a red `Delete` link
 * under every tile and fired it on the click — no confirmation, no idea what the file
 * was on, and `docs/ui-architecture.md` singles it out. So the dialog's whole job is
 * to name what will break before the click, which is what `GET
 * {base}/api/assets/:id/usage` exists for (dependency 4).
 *
 * A failed usage read must not block the delete, only the reassurance: the count is
 * advisory, so saying it is unknown is honest and leaving Delete live is correct.
 */
export function AssetDeleteDialog({
  apiBase,
  mount,
  row,
  onClose,
  onConfirm,
}: {
  apiBase: string
  mount: string
  row: AssetRow
  onClose: () => void
  onConfirm: () => void
}) {
  const usage = useUsage(apiBase, row.id)

  return (
    <Dialog
      title={`Delete ${row.filename}?`}
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
      <p className={css.dialogNote}>
        The library row and the stored file both go. Documents that use it are left alone and will
        render a missing image — rewriting other pages&rsquo; drafts from here would bypass the
        mutation log, and a silent edit nobody saw is worse than a gap somebody can see.
      </p>
      {usage.error ? (
        <p className={css.dialogNote}>Could not check what uses this: {usage.error}</p>
      ) : usage.data === null ? (
        <p className={css.dialogNote}>Checking what uses this…</p>
      ) : usage.data.total === 0 ? (
        // "No *published* document", precisely: `content_refs` is written at publish,
        // so a draft that has placed this image is not counted and the sentence must
        // not claim otherwise.
        <p className={css.dialogNote}>No published document uses this file.</p>
      ) : (
        <>
          <p className={css.dialogNote}>
            Used on <b>{usage.data.total}</b> published{' '}
            {usage.data.total === 1 ? 'document' : 'documents'}, which will show a missing image:
          </p>
          <ul className={css.usageList}>
            {usage.data.published.slice(0, USAGE_SHOWN).map((ref) => (
              <li key={ref.id}>
                <a className={css.usageLink} href={href({ name: 'edit', id: ref.id }, mount)}>
                  {ref.title || 'Untitled'}
                </a>
                {/* The path, because it is what tells two same-titled pages apart. A
                    record using an asset has none and says so rather than rendering an
                    empty code span. */}
                <code className={css.usagePath}>
                  {ref.path === null ? 'not routed' : ref.path === '' ? '/' : `/${ref.path}`}
                </code>
              </li>
            ))}
          </ul>
          {usage.data.published.length > USAGE_SHOWN ? (
            <p className={css.dialogNote}>…and {usage.data.published.length - USAGE_SHOWN} more.</p>
          ) : null}
        </>
      )}
    </Dialog>
  )
}
