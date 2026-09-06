import { useCallback, useEffect, useState } from 'react'
import type { Form, FormUsage, UpdateFormInput } from '../../../server/forms'
import { messageOf } from './useContent'

/**
 * The builder's data: one form, its usage (for the rename warning and the
 * delete dialog), and a save that carries the concurrency guard itself so no
 * caller can forget it.
 *
 * Everything decidable — the field reducers, the naming rules — is in
 * `form-model.ts`; this is `fetch` and the state it lands in, `useRedirects`'s
 * split applied to one row instead of a page of them.
 */

export type SaveResult =
  | { ok: true; form: Form }
  | { ok: false; conflict: boolean; message: string }

export interface FormDetail {
  form: Form | null
  usage: FormUsage | null
  loading: boolean
  error?: string
  /** `GET {base}/api/forms/:id` answered 404 — a stale link, or a form deleted
   *  in another tab. Distinct from `error`: this is not a request that failed,
   *  it is one that succeeded in saying there is nothing here. */
  notFound: boolean
  /** Re-read both the form and its usage — what a 409 conflict does on its
   *  own, and what a delete dialog wants after a cancelled delete leaves the
   *  count possibly stale. */
  reload: () => void
  /**
   * Saves a patch against the loaded form's own `updatedAt` — the caller never
   * supplies `expectedUpdatedAt` itself, which is what makes forgetting the
   * guard impossible rather than merely discouraged (decision 18).
   *
   * A stale save (409) is not thrown: it reloads the form in place and answers
   * `{ ok: false, conflict: true, message }`, so the builder's job is to show
   * `message` and let the reloaded `form` replace whatever the caller was
   * editing — "the builder reloads and says so", the edge case's own words.
   */
  save: (patch: Omit<UpdateFormInput, 'expectedUpdatedAt'>) => Promise<SaveResult>
}

export function useForm(apiBase: string, id: string): FormDetail {
  const [form, setForm] = useState<Form | null>(null)
  const [usage, setUsage] = useState<FormUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notFound, setNotFound] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [formRes, usageRes] = await Promise.all([
        fetch(`${apiBase}/forms/${encodeURIComponent(id)}`),
        fetch(`${apiBase}/forms/${encodeURIComponent(id)}/usage`),
      ])
      if (formRes.status === 404) {
        setNotFound(true)
        setForm(null)
        setUsage(null)
        return
      }
      setNotFound(false)
      if (!formRes.ok) throw new Error(await messageOf(formRes))
      setForm((await formRes.json()) as Form)
      // The usage read is advisory (the rename warning, the delete dialog's
      // counts) — its own failure must not stop the builder from opening,
      // `AssetDeleteDialog.tsx`'s rule applied one level up.
      setUsage(usageRes.ok ? ((await usageRes.json()) as FormUsage) : null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [apiBase, id])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async (patch: Omit<UpdateFormInput, 'expectedUpdatedAt'>): Promise<SaveResult> => {
      if (!form) return { ok: false, conflict: false, message: 'The form has not loaded yet.' }
      const res = await fetch(`${apiBase}/forms/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...patch, expectedUpdatedAt: form.updatedAt }),
      })
      if (res.status === 409) {
        const message = await messageOf(res)
        await load()
        return { ok: false, conflict: true, message }
      }
      if (!res.ok) return { ok: false, conflict: false, message: await messageOf(res) }
      const next = (await res.json()) as Form
      setForm(next)
      return { ok: true, form: next }
    },
    [apiBase, id, form, load],
  )

  return { form, usage, loading, error, notFound, reload: load, save }
}
