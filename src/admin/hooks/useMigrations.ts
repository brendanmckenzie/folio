import { useCallback, useEffect, useState } from 'react'
import type { MigrateReport, MigrationStatus } from '../../server/migrate'
import { expectJson, send } from '../api'
import type { Notify } from './useNotice'

export interface Migrations {
  status: MigrationStatus | null
  /** The most recent report from a dry run or a real run, for the screen. */
  report: MigrateReport | null
  /** A run is in flight; the Run and Preview buttons stay disabled. */
  busy: boolean
  reload: () => Promise<void>
  /** `dryRun` computes and writes nothing, including no ledger row. */
  run: (opts: { dryRun: boolean }) => Promise<void>
}

/**
 * The admin's side of content migrations (`schema-migrations.md` phase 4).
 *
 * Loaded on **every** story load, not only when the Migrations rail is open —
 * unlike `useRedirects` and `useVersions`, whose lazy load this deliberately does
 * not follow. The editor's banner ("this page has not been updated for the
 * latest content model") is drawn from `status.story`, and a banner that only
 * appears once you happen to open an unrelated tab is not a banner.
 *
 * One request per story, `?story=` included, so the per-document answer and the
 * site-wide one arrive together: `schema_migrations` is per-migration and would
 * say "nothing pending" while this one page was still behind.
 *
 * A failure is swallowed rather than notified. This is an explanation, not an
 * action: a toast about a failed status read, on a page that is working, is
 * noise — and the route is deliberately gated no harder than the editor page
 * itself, so a 403 here means a deployment change rather than something the
 * editor did.
 */
export function useMigrations(apiBase: string, storyId: string, notify: Notify): Migrations {
  const [status, setStatus] = useState<MigrationStatus | null>(null)
  const [report, setReport] = useState<MigrateReport | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setStatus(
        await expectJson<MigrationStatus>(
          await fetch(`${apiBase}/migrations?story=${encodeURIComponent(storyId)}`),
        ),
      )
    } catch {
      // See the note above: silent on purpose.
    }
  }, [apiBase, storyId])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * Runs (or previews) the pending migrations, following the cursor to the end.
   *
   * The loop is the client half of the resolved open question: `POST /migrate`
   * answers one batch and a `continueFrom`, and the caller re-calls. Counts are
   * accumulated across the calls so the screen reports the whole run rather than
   * whichever batch happened to be last. Bounded, because a cursor that stopped
   * advancing would otherwise be an infinite loop in a browser tab.
   */
  const run = useCallback(
    async ({ dryRun }: { dryRun: boolean }) => {
      setBusy(true)
      setReport(null)
      try {
        let cursor: string | null = null
        let total: MigrateReport | null = null
        for (let calls = 0; calls < 500; calls++) {
          const batch: MigrateReport = await expectJson<MigrateReport>(
            await send(`${apiBase}/migrate`, 'POST', { dryRun, continueFrom: cursor }),
          )
          total = total === null ? batch : mergeReports(total, batch)
          cursor = batch.continueFrom
          if (cursor === null) break
        }
        setReport(total)
      } catch (e) {
        notify((e as Error).message)
      } finally {
        setBusy(false)
        await reload()
      }
    },
    [apiBase, notify, reload],
  )

  return { status, report, busy, reload, run }
}

/**
 * Two batches of one run, as one report. The later batch wins for everything
 * that describes where the run *got to* (`continueFrom`, `behind`, `complete`);
 * everything that counts adds up.
 */
export function mergeReports(a: MigrateReport, b: MigrateReport): MigrateReport {
  return {
    ...b,
    pending: a.pending,
    stories: a.stories + b.stories,
    changed: a.changed + b.changed,
    unchanged: a.unchanged + b.unchanged,
    mutations: a.mutations + b.mutations,
    publishedMutations: a.publishedMutations + b.publishedMutations,
    transactions: a.transactions + b.transactions,
    oversized: [...a.oversized, ...b.oversized],
    failed: [...a.failed, ...b.failed],
  }
}
