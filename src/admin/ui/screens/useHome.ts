import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Page } from '../../../core/pagination'
import type { MigrationStatus } from '../../../server/migrate'
import type { StoryMeta } from '../../../core/story'
import type { RecentPublish } from '../../../server/versions'
import { canManageAccess, type Me } from '../../me'
import type { AccessUser } from './access-model'
import type { AssetRow } from './assets-model'
import {
  type ActorDirectory,
  actorDirectory,
  type Attention,
  attention,
  homeRequests,
  type SiteCounts,
} from './home-model'
import { type AuditBatch, auditScope, canReadAudit } from './model-model'
import { messageOf } from './useContent'
import { type Uploads, useUploads } from './useAssets'

/**
 * The Home screen's data: five blocks' worth, from seven requests.
 *
 * **Parallel and independently resilient**, which is the one structural
 * requirement this hook exists to meet and the reason it is not a single
 * `Promise.all`. Home asks seven different questions of six different tables; with
 * one combined promise the slowest of them would hold the rendering of all seven,
 * and the first rejection would empty the screen. So each request is its own state,
 * lands on its own, and fails on its own.
 *
 * A failed block renders **nothing** — `Home.tsx` argues that; the launchpad is
 * better as four blocks and a gap than as five error boxes. Which leaves the
 * failure with nowhere to go on screen, so it goes to the toast instead
 * (`ui-architecture.md`'s cross-cutting rule: transient failures are toasts,
 * persistent conditions are banners in flow), once per reload rather than once per
 * block: on an expired session all six would fail with the same sentence.
 *
 * Two of the seven are **gated rather than attempted**, the same restraint
 * `useModel` and `useAccess` show. `GET /audit` is `ADMIN` and `GET /users` is
 * `ADMIN` plus a configured auth, so asking as an editor would turn "this is not
 * for you" into a failed request — and, here, into a toast — on every load of a
 * screen the sidebar offers to everybody.
 */

/** One recency block, as the screen holds it. */
export interface Block<T> {
  rows: readonly T[]
  loading: boolean
  /** The screen renders nothing at all for a failed block. */
  failed: boolean
}

export interface HomeData {
  /**
   * Quick access numbers, or null. Null covers both "not yet" and "the request
   * failed", because the cards read the same in either: they render without
   * numbers rather than not at all, since the card set comes from the manifest and
   * the number is the only part a request owns.
   */
  counts: SiteCounts | null
  /** The library's total, from the same request that fills `media`. */
  assetCount: number | undefined
  changes: Block<StoryMeta>
  published: Block<RecentPublish>
  media: Block<AssetRow>
  /** Editor names for the publish rows. Empty for anybody who cannot read
   * `/users`, which `publishActor` degrades for. */
  directory: ActorDirectory
  attention: Attention
  /** What the audit report actually covered, or `''` — the sentence that keeps a
   * single batch from reading as the whole site. */
  auditScope: string
  /** Re-read every block. */
  reload: () => void
  /** The Assets card's create action, and the empty *Latest media* block's. */
  uploads: Uploads
}

export function useHome(apiBase: string, me: Me, onNotice: (message: string) => void): HomeData {
  const requests = useMemo(() => homeRequests(apiBase), [apiBase])

  /**
   * Bumped by `reload`, and every block's effect depends on it.
   *
   * One counter for the whole screen rather than a `reload` per block: what a person
   * means by refreshing a launchpad is "all of it", and seven independent reload
   * functions would be seven things for the screen to wire up and one for the
   * upload callback to forget.
   */
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  /** Read once as booleans so the effects key on the answer rather than on the
   * identity of the `Me` object it came from — a caller that rebuilt `me` per render
   * would otherwise re-fetch on every one. */
  const mayAudit = canReadAudit(me)
  const mayResolveNames = canManageAccess(me)

  const counts = useFetched<SiteCounts>(requests.counts, nonce)
  const changes = useFetched<Page<StoryMeta>>(requests.changes, nonce)
  const published = useFetched<Page<RecentPublish>>(requests.published, nonce)
  const media = useFetched<Page<AssetRow>>(requests.media, nonce)
  const migrations = useFetched<MigrationStatus>(requests.migrations, nonce)
  const audit = useFetched<AuditBatch>(mayAudit ? requests.audit : null, nonce)
  const users = useFetched<{ users: AccessUser[] }>(mayResolveNames ? requests.users : null, nonce)

  /**
   * The first failure, announced once.
   *
   * `users` is deliberately not in the chain: failing to resolve names costs a
   * display name and nothing else, and `publishActor` already has an honest answer
   * for an unresolved id, so a toast about it would report a degradation as a fault.
   *
   * Keyed on the message rather than on `nonce`, which has one consequence worth
   * knowing: a Refresh that fails identically does not re-announce. The sentence has
   * not changed and the gap on screen is still there, so re-toasting the same words
   * would be the noisier of the two wrong answers.
   */
  const failure =
    counts.failed ??
    changes.failed ??
    published.failed ??
    media.failed ??
    migrations.failed ??
    audit.failed
  useEffect(() => {
    if (failure) onNotice(`Some of this screen could not be loaded: ${failure}`)
  }, [failure, onNotice])

  const directory = useMemo(() => actorDirectory(users.value?.users ?? []), [users.value])
  const needs = useMemo(
    () => attention({ status: migrations.value ?? null, audit: audit.value ?? null }),
    [migrations.value, audit.value],
  )

  const uploads = useUploads(apiBase, (done, failed) => {
    if (failed === 0) {
      onNotice(
        done.length === 1 ? `Uploaded ${done[0]?.filename}` : `Uploaded ${done.length} files`,
      )
    } else {
      // The per-file reason lives in `Uploads.entries`, which the Assets screen
      // renders as a list and this one does not: a queue report is a media-library
      // surface, and putting it on the launchpad would be the second copy of it.
      // So the toast says how many and where the detail is.
      onNotice(
        done.length === 0
          ? 'Upload failed. Open Assets to see why.'
          : `Uploaded ${done.length} of ${done.length + failed}. Open Assets to see which failed.`,
      )
    }
    // Both the tiles and the Assets card's count are now wrong.
    reload()
  })

  return {
    counts: counts.value ?? null,
    assetCount: media.value?.total,
    changes: blockOf(changes),
    published: blockOf(published),
    media: blockOf(media),
    directory,
    attention: needs,
    // `batches: 1` because that is the truth: `AUDIT_BATCH` documents, once, with no
    // walk. The sentence it produces for a non-null `continueFrom` is the whole
    // reason a single batch is acceptable here.
    auditScope: auditScope({ data: audit.value ?? null, loading: audit.loading, batches: 1 }),
    reload,
    uploads,
  }
}

/* ------------------------------------------------------------------ one GET --- */

interface Fetched<T> {
  /** Undefined until it answers, and forever if it failed. */
  value: T | undefined
  loading: boolean
  /** The failure message, or undefined. Nothing on screen renders it — a failed
   * block is absent — but `useHome` announces the first one. */
  failed: string | undefined
}

/**
 * One request, on its own.
 *
 * Deliberately not `useDocuments`' shape: there is no cursor, no page and no
 * search here, because none of these lists is navigated — Home shows the first N of
 * six things and links to the screen that pages each one properly. What it needs
 * instead is the property that hook does not have to care about: seven of these run
 * at once and none may hold or empty another.
 *
 * `url === null` means **do not ask** — a route this actor is not allowed to reach —
 * and resolves to the same state as a finished request with no value, so a gated
 * block and an empty one render identically. That is the intended reading: a person
 * who cannot see the audit should see a screen with no audit on it, not one with a
 * hole where a refusal was.
 */
function useFetched<T>(url: string | null, nonce: number): Fetched<T> {
  const [state, setState] = useState<Fetched<T>>({
    value: undefined,
    loading: url !== null,
    failed: undefined,
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the trigger, not a value the body reads — bumping it is the whole of what `reload` does. Naming it is the point; the alternative, reading it inside to satisfy the rule, would misstate what this depends on. Same shape as `useDocuments.ts`'s `identity` effect
  useEffect(() => {
    if (url === null) {
      setState({ value: undefined, loading: false, failed: undefined })
      return
    }
    let live = true
    setState((prev) => ({ ...prev, loading: true, failed: undefined }))
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(await messageOf(res))
        return (await res.json()) as T
      })
      .then((value) => {
        if (live) setState({ value, loading: false, failed: undefined })
      })
      .catch((e: Error) => {
        // The previous value is dropped rather than kept: a block showing stale rows
        // under a heading whose refresh just failed is the one outcome that is worse
        // than the gap, because nothing on screen would say the rows are old.
        if (live) setState({ value: undefined, loading: false, failed: e.message })
      })
    return () => {
      live = false
    }
  }, [url, nonce])

  return state
}

function blockOf<T>(fetched: Fetched<Page<T>>): Block<T> {
  return {
    rows: fetched.value?.rows ?? [],
    loading: fetched.loading,
    failed: fetched.failed !== undefined,
  }
}
