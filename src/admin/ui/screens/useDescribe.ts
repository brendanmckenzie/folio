import { useEffect, useState } from 'react'

/**
 * Whether this deployment describes anything, and what a run of it will cost
 * (`docs/specs/content-model/media-library.md` decisions 8 and 10).
 *
 * **The admin cannot read this off the manifest.** `Manifest` (`core/schema.ts`)
 * carries the content model and, by `server/app.ts`'s standing rule,
 * deliberately not the configuration a screen needs — sign-in providers are
 * answered by `GET {base}/api/me` for exactly that reason. So `describe` has its
 * own one-field read, `GET {base}/api/assets/describe`, and every control this
 * feature adds is drawn *after* it answers.
 *
 * **Absence renders nothing, rather than something that fails when pressed.** A
 * host with no `describe` in config gets no *Describe* button on the detail
 * panel and none in the bulk bar: the routes answer `unsupported` and a control
 * whose only outcome is that message is furniture. This is also why a failed
 * read is indistinguishable from an absent one here and reports no error — a
 * toast about a capability probe is noise, and the screen degrades to what it
 * was before this feature existed.
 *
 * **One instance per component that needs it**, matching `useFolders` and
 * `useTags`: the detail panel and the browser each ask. It is one small `GET`
 * per mount over a value that cannot change without a deploy, and threading it
 * through `Assets.tsx` to reach a sibling is a bigger change than the saving.
 */
export interface DescribeConfig {
  /** Whether the host configured `describe`. **False until the read lands**, so
   * a control is never drawn on an optimistic guess. */
  configured: boolean
  /** Whether a new upload is described in the background. Reported so the run
   * panel can say why the backlog is empty on a fresh library. */
  onUpload: boolean
  /** Whether the Images binding is bound. Without it the *original* bytes are
   * described rather than a 512px WebP: it works, and it costs more, and the run
   * panel says so once. */
  images: boolean
  /** Rows per call of a run — the server's own default, so the panel's progress
   * arithmetic and the server's batching cannot drift. */
  batch: number
}

const ABSENT: DescribeConfig = { configured: false, onUpload: false, images: false, batch: 10 }

export function useDescribe(apiBase: string): DescribeConfig {
  const [config, setConfig] = useState<DescribeConfig>(ABSENT)

  useEffect(() => {
    let live = true
    fetch(`${apiBase}/assets/describe`)
      .then(async (res) => (res.ok ? ((await res.json()) as Partial<DescribeConfig>) : null))
      .then((body) => {
        if (!live || !body?.configured) return
        setConfig({
          configured: true,
          onUpload: body.onUpload === true,
          images: body.images === true,
          batch: typeof body.batch === 'number' ? body.batch : ABSENT.batch,
        })
      })
      .catch(() => {
        // Deliberately silent — see the header. The screen is the one it was
        // before this feature existed.
      })
    return () => {
      live = false
    }
  }, [apiBase])

  return config
}
