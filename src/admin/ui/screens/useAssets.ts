import type { Dispatch, DragEvent, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Page } from '../../../core/pagination'
import { type AssetRow, type AssetsUrl, assetsParams, type UploadEntry } from './assets-model'
import { messageOf } from './useContent'

/**
 * The Assets screen's impure half: one page of the media library, and the upload
 * queue. Everything decidable is in `assets-model.ts`; what is here is `fetch` and
 * the state it lands in.
 *
 * Both hooks are used by **both mounts** — the screen and the picker dialog — which
 * is what makes "one implementation, two mounts" true of the data as well as the
 * markup. The screen keeps its state in the URL and the picker keeps it in
 * `useState`; neither of those facts reaches in here.
 */

/**
 * Rows per request.
 *
 * 48 rather than the route's default 50, and the reason is the grid: at the tile
 * sizes this screen uses a row is 2, 3, 4, 6 or 8 tiles wide depending on the
 * viewport, and 48 divides by every one of them. 50 leaves a ragged pair on the last
 * row at four columns and a single tile at six, which reads as a loading failure
 * rather than the end of a page.
 */
const PAGE = 48

/**
 * How long the search box waits before it is a request.
 *
 * **Not optional, and `pagination.md` decision 5 says why.** The list header asks
 * `?count=1`, so an undebounced box does not just run a query per keystroke — it
 * drags a full `count(*)` over `assets` behind each one. One request per *settled*
 * query is how this honours it, which is also the only query whose number is worth
 * reading.
 *
 * **The second instance of this hook in `screens/`**, after `useDocuments.ts`, whose
 * own comment says it stays local "until it has a second caller". This is that
 * caller, so the promotion to a shared `ui/useDebounced.ts` is now owed — and is
 * deliberately not done here, because it means editing `useDocuments.ts`, which
 * belongs to a port phase that has already landed and is not this one's to reopen.
 */
const DEBOUNCE_MS = 150

export interface AssetsData {
  page: Page<AssetRow> & { loading: boolean; error?: string }
  /** Cursors already visited, so *previous* is a pop rather than a reverse query.
   * Keyset paging only goes forwards; a client-side stack is what makes next /
   * previous work without the route learning a second direction. */
  canGoBack: boolean
  nextPage: () => void
  prevPage: () => void
  /** Re-read the current page, after an upload or a delete. */
  reload: () => void
}

export function useAssets(apiBase: string, url: AssetsUrl): AssetsData {
  const [page, setPage] = useState<AssetsData['page']>({
    rows: [],
    cursor: null,
    loading: true,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly (string | null)[]>([])

  /**
   * The query the *request* uses, which trails the box by `DEBOUNCE_MS`.
   *
   * Only `q` is debounced. A chip, a sort, a view and a page are single deliberate
   * gestures and should answer immediately; a search term arrives one character at a
   * time, and it is the only one of them whose intermediate states nobody asked to
   * see.
   */
  const q = useDebounced(url.q)
  const settled = { ...url, q }

  // Serialised, because a fresh object every render would restart the effect below.
  // The string is also exactly what goes on the wire, so there is no second
  // representation to keep in step.
  const params = assetsParams(settled, { limit: PAGE, cursor, count: true }).toString()

  const fetchPage = useCallback(async () => {
    setPage((prev) => ({ ...prev, loading: true }))
    try {
      const res = await fetch(`${apiBase}/assets?${params}`)
      if (!res.ok) throw new Error(await messageOf(res))
      setPage({ ...((await res.json()) as Page<AssetRow>), loading: false })
    } catch (e) {
      setPage({ rows: [], cursor: null, loading: false, error: (e as Error).message })
    }
  }, [apiBase, params])

  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

  /**
   * A filter, a sort or a direction change invalidates the cursor stack: each is a
   * different ordering or a different set, so a cursor from the old one would resume
   * at a position that no longer exists.
   *
   * Keyed on the request *minus* the cursor — the same string the fetch uses, with
   * the one parameter allowed to change without a reset taken out. Deriving it rather
   * than listing `sort`, `dir`, `kind` and `q` separately is what keeps a fifth
   * filter from being added without a reset. Note that `view` is not in it: grid and
   * table are two arrangements of one query, so switching costs no request.
   */
  const identity = assetsParams(settled, { limit: PAGE, count: true }).toString()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `identity` is the trigger, not a value the body reads — it only clears. Naming it is the point; reading it to satisfy the rule would misstate what this depends on
  useEffect(() => {
    setCursor(null)
    setHistory([])
  }, [identity])

  const nextPage = useCallback(() => {
    if (!page.cursor) return
    setHistory((prev) => [...prev, cursor])
    setCursor(page.cursor)
  }, [page.cursor, cursor])

  const prevPage = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev
      setCursor(prev[prev.length - 1] ?? null)
      return prev.slice(0, -1)
    })
  }, [])

  return { page, canGoBack: history.length > 0, nextPage, prevPage, reload: fetchPage }
}

/* --------------------------------------------------------------- one asset --- */

export interface AssetLookup {
  row: AssetRow | null
  /** The route answered 404: the file has been deleted. Separate from `error` on
   * purpose — see `PanelSubject`. */
  gone: boolean
  error: string | null
  loading: boolean
  /** Ask again. Only ever offered for `error`: a 404 is not something a retry
   * changes, and offering one would suggest the file might come back. */
  retry: () => void
}

/**
 * One asset by id, from `GET {base}/api/assets/:id`.
 *
 * **This is what makes `{base}/assets?asset=<id>` a link rather than a hint.** Without
 * it, a cold load of that URL could only show the panel when the asset happened to be
 * on the first page the list returned — which is most of the time under the default
 * newest-first sort, and never once somebody has filtered or paged. The route was
 * added for this; the screen was what could say it was owed.
 *
 * **`id` is `undefined` when there is nothing to resolve**, which is how the caller
 * says "the row is already in hand" and how this stays free in the common case. A
 * `skip` boolean beside a live id was the alternative and it is worse: it leaves the
 * id in the argument list while meaning it should be ignored, so the one thing a
 * reader has to know — that a resolved row makes no request — is expressed by a
 * second parameter agreeing with the first.
 *
 * **404 is not an error.** It is the honest answer to a stale link and the panel says
 * something different about it: a file that has been deleted is a fact, and a fetch
 * that failed is a retry. Reporting both as "could not load" would either send
 * somebody looking for a network problem that is not there, or tell them their file
 * was deleted because their wifi dropped.
 */
export function useAsset(apiBase: string, id: string | undefined): AssetLookup {
  const [state, setState] = useState<Omit<AssetLookup, 'retry'>>({
    row: null,
    gone: false,
    error: null,
    loading: false,
  })
  // A nonce rather than a `fetch` the caller can invoke: the request has to be the
  // effect's, or a retry and an id change could be in flight together and the loser
  // would overwrite the winner.
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the trigger, not a value the body reads — it exists so `retry` can re-run this. Reading it to satisfy the rule would misstate what the request depends on
  useEffect(() => {
    if (!id) {
      setState({ row: null, gone: false, error: null, loading: false })
      return
    }
    let live = true
    setState({ row: null, gone: false, error: null, loading: true })
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/assets/${encodeURIComponent(id)}`)
        // Read before the `ok` check so a 404 is told apart by its status rather than
        // by matching its message text, which is a string somebody is free to reword.
        if (res.status === 404) {
          if (live) setState({ row: null, gone: true, error: null, loading: false })
          return
        }
        if (!res.ok) throw new Error(await messageOf(res))
        const row = (await res.json()) as AssetRow
        if (live) setState({ row, gone: false, error: null, loading: false })
      } catch (e) {
        if (live) {
          setState({ row: null, gone: false, error: (e as Error).message, loading: false })
        }
      }
    })()
    return () => {
      live = false
    }
  }, [apiBase, id, attempt])

  return { ...state, retry }
}

/* ----------------------------------------------------------------- uploads --- */

export interface Uploads {
  /** The batch in flight, or the one that just finished. Empty when there is
   * nothing to say. */
  entries: readonly UploadEntry[]
  busy: boolean
  add: (files: FileList | readonly File[] | null) => void
  /** Clear the report. Only offered once nothing is in flight. */
  dismiss: () => void
}

/**
 * The upload queue: one entry per file, each with its own outcome.
 *
 * Three decisions, and all three are about a batch being able to *partly* succeed —
 * which it can, because `MAX_UPLOAD_BYTES` and the content-length check refuse per
 * request:
 *
 * 1. **Sequential, not `Promise.all`.** Every upload buffers its whole body inside
 *    the Worker (`readCappedBody`), so twenty in parallel is twenty invocations
 *    holding up to 20MB each; and a parallel batch can only report "uploading 20
 *    files" where a serial one can say which. `useUpload.ts` — the hook this
 *    replaces for the library half — used `Promise.all` and reported one error for
 *    the batch, so a single oversized file lost the other nineteen's outcomes.
 * 2. **No client-side size pre-check**, deliberately. It would mean either
 *    duplicating `MAX_UPLOAD_BYTES` in the admin bundle or importing a Worker
 *    module to read it, and it buys nothing: `contentLengthHeader` refuses an
 *    over-cap declared length *before a byte is read*, and its message already
 *    names the limit. The failure is immediate and per-file either way.
 * 3. **Status, not a percentage.** `fetch` has no upload-progress event; only
 *    `XMLHttpRequest` does. Swapping the one request in this admin that would want
 *    it for XHR, to draw a bar, is not a trade worth making — so a file is queued,
 *    uploading, done or failed, and the summary line carries "3 of 7".
 *
 * `onFinished` is held in a ref rather than named as a dependency: the screen's
 * callback closes over its URL state (it selects what was just uploaded), so it is
 * a new function every render and naming it would rebuild `add` on each one.
 */
export function useUploads(
  apiBase: string,
  onFinished: (done: readonly AssetRow[], failed: number) => void,
): Uploads {
  const [entries, setEntries] = useState<readonly UploadEntry[]>([])
  const finished = useRef(onFinished)
  finished.current = onFinished
  const live = useRef(true)
  useEffect(
    () => () => {
      live.current = false
    },
    [],
  )

  const add = useCallback(
    (files: FileList | readonly File[] | null) => {
      const list = files ? [...files] : []
      if (list.length === 0) return

      // A new batch replaces the previous report rather than appending to it.
      // Keeping old failures would let the list grow without bound across a session
      // and would mix a file that failed ten minutes ago into the outcome of the
      // drop that just happened.
      const stamp = Date.now()
      const batch: UploadEntry[] = list.map((file, i) => ({
        id: `${stamp}:${i}:${file.name}`,
        filename: file.name,
        status: 'uploading',
      }))
      setEntries(batch)

      void (async () => {
        const done: AssetRow[] = []
        let failed = 0
        for (const [i, file] of list.entries()) {
          const id = batch[i]!.id
          try {
            done.push(await uploadOne(apiBase, file))
            if (live.current) mark(setEntries, id, 'done')
          } catch (e) {
            failed += 1
            if (live.current) mark(setEntries, id, 'failed', (e as Error).message)
          }
        }
        if (!live.current) return
        // A clean batch clears its own report: the new rows appearing in the grid
        // are the confirmation, and a list of ticks beside them is furniture. A
        // batch with any failure keeps the whole list, successes included, because
        // "which of the ten did not make it" is the question being answered.
        if (failed === 0) setEntries([])
        finished.current(done, failed)
      })()
    },
    [apiBase],
  )

  const dismiss = useCallback(() => setEntries([]), [])

  return { entries, busy: entries.some((e) => e.status === 'uploading'), add, dismiss }
}

function mark(
  setEntries: Dispatch<SetStateAction<readonly UploadEntry[]>>,
  id: string,
  status: UploadEntry['status'],
  error?: string,
) {
  setEntries((prev) =>
    prev.map((entry) =>
      entry.id === id ? { ...entry, status, ...(error ? { error } : {}) } : entry,
    ),
  )
}

/**
 * One file. **A raw body with the filename in a query parameter**, not multipart —
 * `server/routes/assets.ts` explains why: it keeps the Worker out of the business of
 * parsing form data, and the browser sets Content-Type and Content-Length from the
 * `File` for free.
 *
 * The content-type header is a hint only and the route knows it: `uploadAsset`
 * sniffs the bytes and stores what *they* say, so a lying header is overridden. Sent
 * anyway because the declared length beside it is what makes the cap refuse an
 * oversized file before reading it.
 */
async function uploadOne(apiBase: string, file: File): Promise<AssetRow> {
  const res = await fetch(`${apiBase}/assets?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) throw new Error(await messageOf(res))
  return ((await res.json()) as { asset: AssetRow }).asset
}

/* ------------------------------------------------------------------- drops --- */

export interface DropTarget {
  /** A drag is over the target: the caller draws the invitation. */
  over: boolean
  handlers: {
    onDragEnter: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

/**
 * "Upload by dropping anywhere on the screen", as handlers a caller spreads onto
 * whatever *anywhere* means for it — the whole screen in one mount, the dialog body
 * in the other.
 *
 * The counter is the part that is easy to get wrong: `dragleave` fires every time
 * the pointer crosses into a child element, so a boolean set on enter and cleared on
 * leave flickers off the moment the drag passes over a tile. Counting enters and
 * leaves is what makes it stable, and it is why this is a hook rather than four
 * inline handlers.
 *
 * Drag and drop is **never the only route**: every caller also has a real file
 * input, because a pointer gesture is not keyboard-operable and
 * `ui-architecture.md`'s acceptance for every phase includes that it is.
 */
export function useDropTarget(onFiles: (files: FileList | null) => void): DropTarget {
  const [depth, setDepth] = useState(0)

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDepth((d) => d + 1)
  }, [])

  const onDragOver = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return
    // Without this the browser navigates to the dropped file, which is the default
    // and is the single most common way a drop target silently does not work.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return
    setDepth((d) => Math.max(0, d - 1))
  }, [])

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDepth(0)
      onFiles(e.dataTransfer.files)
    },
    [onFiles],
  )

  return { over: depth > 0, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}

/** Whether this drag carries files at all. A dragged *link* or a text selection
 * also fires these events, and offering to upload one would be a lie. */
function hasFiles(e: DragEvent): boolean {
  return [...e.dataTransfer.types].includes('Files')
}

/**
 * A value that trails its input by `DEBOUNCE_MS`. See `DEBOUNCE_MS` for why this is
 * the second copy and where the shared one belongs.
 */
function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value])
  return settled
}
