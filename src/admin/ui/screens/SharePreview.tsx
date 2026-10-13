import { useState } from 'react'
import type { StoryMeta } from '../../../core/story'
import type { ShareRow } from '../../../server/auth/shares'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { Field, Input } from '../Field'
import { OneTimeSecretDialog } from './OneTimeSecretDialog'
import css from './SharePreview.module.css'
import {
  DEFAULT_SHARE_DAYS,
  expiresPhrase,
  MAX_NOTE,
  MAX_SHARE_DAYS,
  MIN_SHARE_DAYS,
  openedPhrase,
  shareBody,
  shareDays,
  sharedBy,
} from './share-model'
import { usePaged } from './useAccess'
import { messageOf } from './useContent'

/**
 * "Share a preview": make a link that shows one unpublished page to someone with no
 * account, and list the links still working for it.
 *
 * `apiBase` is the **scoped** base the rest of the admin is handed, so on a
 * multi-site deployment the `~<site>` segment rides along and the route's `?site=`
 * defaults to the scope being shown — the same reason the Access screen calls
 * `/tokens` through it and never hard-codes `{base}/api`.
 *
 * Two dialogs in sequence, never stacked: the form and list, then — once a link is
 * made — the one-time display in its place. The list lives here, above both, so it
 * survives the swap and is re-read when the form comes back.
 */
export function SharePreview({
  apiBase,
  story,
  selfId,
  onClose,
  onNotice,
}: {
  apiBase: string
  story: Pick<StoryMeta, 'id' | 'title'>
  /** The caller's own user id, for "You" in the list; null for a token or `open`. */
  selfId: string | null
  onClose: () => void
  onNotice: (message: string) => void
}) {
  const shares = usePaged<ShareRow>(apiBase, '/shares', 'shares', true, {
    story: story.id,
    state: 'live',
  })
  const [url, setUrl] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [days, setDays] = useState(String(DEFAULT_SHARE_DAYS))
  const [pending, setPending] = useState(false)
  // Revoked in this session, hidden at once: the reload below confirms it, and until
  // then a Revoke button that is still clickable would 404 on its second press.
  const [revoked, setRevoked] = useState<ReadonlySet<string>>(new Set())

  const parsed = shareDays(days)
  const rows = shares.page.rows.filter((row) => !revoked.has(row.id))

  const create = async () => {
    if (!parsed.ok) return
    setPending(true)
    try {
      const res = await fetch(`${apiBase}/story/${encodeURIComponent(story.id)}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(shareBody(note, parsed.days)),
      })
      if (!res.ok) throw new Error(await messageOf(res))
      setUrl(((await res.json()) as { url: string }).url)
      setNote('')
      shares.reload()
    } catch (e) {
      // The form stays standing: a refusal must not throw away the note.
      onNotice((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  const revoke = async (share: ShareRow) => {
    try {
      const res = await fetch(`${apiBase}/shares/${encodeURIComponent(share.id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(await messageOf(res))
      setRevoked((prev) => new Set(prev).add(share.id))
      onNotice('That preview link no longer works.')
      shares.reload()
    } catch (e) {
      onNotice((e as Error).message)
    }
  }

  if (url !== null) {
    return (
      <OneTimeSecretDialog
        title="Copy this link now"
        description="This is the only time it is shown."
        secret={url}
        onClose={() => setUrl(null)}
      >
        <p className={css.meta}>
          Anyone with this link sees the draft of <b>{story.title || 'this page'}</b> at its real
          address, with no sign-in. It cannot be shown again, so copy it before closing; make a new
          one if it is lost.
        </p>
      </OneTimeSecretDialog>
    )
  }

  return (
    <Dialog
      title="Share a preview"
      description="A link that shows this page's draft to someone without an account."
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={pending || !parsed.ok}
            reason={pending ? 'Creating…' : parsed.ok ? undefined : parsed.reason}
            onClick={() => void create()}
          >
            Create link
          </Button>
        </>
      }
    >
      <div className={css.form}>
        <Field label="Note" help="Only you and other editors see it. “For Rachel’s Friday review”.">
          {(id) => (
            <Input
              id={id}
              value={note}
              maxLength={MAX_NOTE}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Works for (days)"
          help={`Between ${MIN_SHARE_DAYS} and ${MAX_SHARE_DAYS}. Revoke it sooner below.`}
          error={parsed.ok ? undefined : parsed.reason}
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={MIN_SHARE_DAYS}
              max={MAX_SHARE_DAYS}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          )}
        </Field>
      </div>

      <h3 className={css.heading}>Working links</h3>
      {shares.page.error ? (
        <p className={css.empty}>{shares.page.error}</p>
      ) : rows.length === 0 ? (
        <p className={css.empty}>{shares.page.loading ? 'Loading…' : 'No links for this page.'}</p>
      ) : (
        <ul className={css.list}>
          {rows.map((share) => (
            <li key={share.id} className={css.row}>
              <span className={css.what}>
                <span className={css.note}>{share.note || 'No note'}</span>
                <span className={css.meta}>
                  {sharedBy(share, selfId)} · {expiresPhrase(share)} · {openedPhrase(share)}
                </span>
              </span>
              <Button size="sm" variant="danger" onClick={() => void revoke(share)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
