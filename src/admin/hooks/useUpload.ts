import { useCallback, useState } from 'react'
import type { AssetValue } from '../../core/values'
import { expectJson } from '../api'

/**
 * Uploads one file and answers with the value a field stores. The route also
 * returns the library row it just wrote; nothing here needs it, so it is not in
 * the return type.
 */
export async function uploadAsset(apiBase: string, file: File): Promise<AssetValue> {
  const res = await fetch(`${apiBase}/assets?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    // A bare `POST` with a File body would have the browser pick a type; the
    // route stores what it is told, so the type is stated explicitly.
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  const body = await expectJson<{ value: AssetValue }>(res, `Upload failed (${res.status})`)
  return body.value
}

export interface Upload {
  /** An upload is in flight: the button that started it stays disabled. */
  busy: boolean
  /** The last failure, or null. Shown next to the control that failed. */
  error: string | null
  /** One file. Null means nothing to do, or a failure already reported. */
  one: (file: File | undefined) => Promise<AssetValue | null>
  /** Up to `room` files, all or nothing. Null as for `one`. */
  many: (files: FileList | null, room: number) => Promise<AssetValue[] | null>
}

/**
 * The one upload state machine. Three controls need it — a single asset field, a
 * multi-asset field, and the media library's own upload button — and each used to
 * carry its own copy of busy/error/try/finally.
 *
 * Failure is reported through `error` and signalled to the caller as null rather
 * than thrown: every caller's response to a failed upload is to leave the field's
 * value alone, and `null` makes that the shape of the code.
 */
export function useUpload(apiBase: string): Upload {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async <T>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true)
    setError(null)
    try {
      return await work()
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  const one = useCallback(
    (file: File | undefined) =>
      file ? run(() => uploadAsset(apiBase, file)) : Promise.resolve(null),
    [apiBase, run],
  )

  const many = useCallback(
    (files: FileList | null, room: number) =>
      files?.length
        ? run(() => Promise.all([...files].slice(0, room).map((f) => uploadAsset(apiBase, f))))
        : Promise.resolve(null),
    [apiBase, run],
  )

  return { busy, error, one, many }
}
