import { useCallback, useId, useState } from 'react'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { Field, Input, Select } from '../Field'
import { ListHeader } from '../List'
import { type Column, Table } from '../Table'
import css from './Redirects.module.css'
import {
  BLANK_DRAFT,
  createdLabel,
  deletePath,
  deleteWarning,
  draftRefusal,
  isExternal,
  isNarrowed,
  parseRedirectsUrl,
  pathLabel,
  type RedirectDraft,
  type RedirectRow,
  type RedirectStatus,
  type RedirectsUrl,
  redirectsQuery,
  showing,
  SOURCES,
  sourceHint,
  sourceLabel,
  STATUSES,
  statusLabel,
  targetLabel,
} from './redirects-model'
import { messageOf } from './useContent'
import { useRedirects } from './useRedirects'

interface Props {
  apiBase: string
  query: Readonly<Record<string, string>>
  /** `replace`, not `push`: a filter keystroke must not be a history entry. */
  onQuery: (next: Record<string, string | undefined>) => void
  onNotice: (message: string) => void
}

/** Six placeholder rows, named rather than indexed — matching Content's and
 * Documents'. Skeletons and not a spinner, because `--row-h` is fixed and a known
 * row height means the shape of the answer can be shown before the answer
 * (`ui-architecture.md`, Cross-cutting). */
const SKELETON = ['s1', 's2', 's3', 's4', 's5', 's6']

/**
 * The redirect table as a screen — `docs/ui-architecture.md`'s port phase 5, and
 * the retirement of `admin/Redirects.tsx`.
 *
 * `ui-architecture.md` describes this one as "the table it already is, and the one
 * list route in the codebase that already pages properly", which is true of the
 * route and understates the screen by three things:
 *
 * 1. **It pages.** `listRedirects` had a real keyset cursor before the pagination
 *    work started — it is where `core/pagination.ts` came from — and the old screen
 *    read the first page and stopped. Redirect 51 was unreachable on a site that
 *    had been renaming pages for a year, which is exactly the site where this table
 *    matters.
 * 2. **`source` gets a real treatment.** The old list printed the raw column value,
 *    `auto` or `manual`, in a coloured chip. Those two words are the only thing on
 *    this screen that answers "is it safe to delete this row", so they are spelled
 *    out and the confirmation says what removing each one actually does —
 *    `redirects-model.ts`'s `sourceLabel` and `deleteWarning` carry the argument.
 * 3. **Searching and filtering are the server's.** Both were impossible before: one
 *    page held everything the screen knew about, so a client-side predicate over it
 *    would have filtered the page rather than the table. `?q=` matches both paths,
 *    because "what still points at /offers" is as real a question as "what happens
 *    to /old-services".
 *
 * What it deliberately does not do is offer a sort. One ordering, newest first, for
 * the reason `listRedirects` states: a second keyset over `from_path` buys scrolling
 * to a path the search box already jumps to.
 */
export function Redirects({ apiBase, query, onQuery, onNotice }: Props) {
  const url = parseRedirectsUrl(query)
  const data = useRedirects(apiBase, url)

  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<RedirectRow | null>(null)
  const [busy, setBusy] = useState(false)

  const go = useCallback((next: RedirectsUrl) => onQuery(redirectsQuery(next)), [onQuery])

  const create = useCallback(
    async (draft: RedirectDraft) => {
      setBusy(true)
      try {
        const res = await fetch(`${apiBase}/redirects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            from: draft.from.trim(),
            to: draft.to.trim(),
            status: draft.status,
          }),
        })
        if (!res.ok) throw new Error(await messageOf(res))
        setCreating(false)
        onNotice(`${pathLabel(draft.from.trim())} now redirects`)
        data.reload()
      } catch (e) {
        // Left open, deliberately: the two refusals that matter here — a live page
        // at `from`, and a target that redirects back — are things the person can
        // fix by editing what they typed, and closing the dialog would throw the
        // rest of the form away to show a toast about one field.
        onNotice((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [apiBase, data, onNotice],
  )

  const remove = useCallback(
    async (row: RedirectRow) => {
      setBusy(true)
      try {
        const res = await fetch(`${apiBase}/redirects/${deletePath(row.from)}`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error(await messageOf(res))
        onNotice(`${pathLabel(row.from)} no longer redirects`)
        data.reload()
      } catch (e) {
        onNotice((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [apiBase, data, onNotice],
  )

  const columns: Column<RedirectRow>[] = [
    {
      key: 'from',
      label: 'From',
      cell: (row) => <code className={css.path}>{pathLabel(row.from)}</code>,
    },
    {
      key: 'to',
      label: 'To',
      cell: (row) => (
        <code
          className={css.path}
          // An absolute URL says "off-site" by being one, so there is no badge
          // beside it — an unlabelled glyph is the thing `docs/ui-review.md`
          // objected to twice. The title is for the case a long URL truncates.
          title={isExternal(row.to) ? `Redirects off this site: ${row.to}` : undefined}
        >
          {targetLabel(row.to)}
        </code>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      // Not `numeric`, even though it is a number. `Table`'s numeric column is
      // right-aligned, which is right for a trailing column of sizes or counts and
      // wrong for a three-digit code in the middle of five columns — it would sit
      // hard against Source and read as belonging to it. Tabular figures without
      // the alignment, in the cell's own class.
      cell: (row) => (
        <span className={css.status} title={statusLabel(row.status)}>
          {row.status}
        </span>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      // Neutral for both, which is the state palette rather than an omission: a
      // hue means one state to act on, and where a row came from is a fact about
      // the row. The word and its title carry the difference.
      cell: (row) => <Badge title={sourceHint(row.source)}>{sourceLabel(row.source)}</Badge>,
    },
    {
      key: 'created',
      label: 'Created',
      cell: (row) => <span className={css.stamp}>{createdLabel(row)}</span>,
    },
  ]

  if (data.page.error && data.page.rows.length === 0) {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Redirects</ListHeader>
        <EmptyState
          title="Could not load redirects"
          body={data.page.error}
          action={
            <Button size="sm" onClick={data.reload}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  const firstLoad = data.page.loading && data.page.rows.length === 0
  const narrowed = isNarrowed(url)

  return (
    <div className={css.screen}>
      <ListHeader
        level={1}
        actions={
          <>
            <input
              className={css.search}
              type="search"
              value={url.q}
              placeholder="Search paths"
              aria-label="Search redirects by path"
              onChange={(e) => go({ ...url, q: e.target.value })}
            />
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              New redirect
            </Button>
          </>
        }
      >
        Redirects
      </ListHeader>

      <div className={css.controls}>
        {/* A `<fieldset>` with a hidden `<legend>` rather than `role="group"` plus
            an `aria-label`, per Biome's `useSemanticElements` — and the reset it
            needs is in the stylesheet with a note on why it is not optional. */}
        <fieldset className={css.chips}>
          <legend className={css.srOnly}>Filter by source</legend>
          {SOURCES.map((source) => (
            <button
              key={source.value}
              type="button"
              className={`${css.chip} ${url.source === source.value ? css.chipOn : ''}`}
              aria-pressed={url.source === source.value}
              onClick={() => go({ ...url, source: source.value })}
            >
              {source.label}
            </button>
          ))}
        </fieldset>
      </div>

      {firstLoad ? (
        <div className={css.skeletons} aria-hidden="true">
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      ) : (
        <Table
          label="Redirects"
          columns={columns}
          rows={data.page.rows}
          // `from_path` is the table's primary key, so the row's own identity is
          // the React key — no synthetic one, and no id column to show for it.
          rowKey={(row) => row.from}
          /* No `onOpen`. A redirect is not a document, and the story that vacated
             the path may be gone — `redirects.md` decision 5 keeps `story_id` as
             information rather than a foreign key precisely so a redirect can
             outlive it. A first column that looked clickable and answered nothing
             would be worse than one that does not. */
          actions={(row) => (
            <span className={css.rowActions}>
              <Button
                size="sm"
                variant="subtle"
                disabled={busy}
                title={`Delete the redirect from ${pathLabel(row.from)}`}
                onClick={() => setDeleting(row)}
              >
                Delete
              </Button>
            </span>
          )}
          empty={
            <EmptyState
              title={narrowed ? 'Nothing matches' : 'No redirects yet'}
              body={
                narrowed
                  ? 'Try a different source, or clear the search.'
                  : 'Renaming, moving or deleting a page writes one of these automatically, so this fills itself over time. Add one by hand for a URL that never existed here — a print campaign, or a page from an older site.'
              }
              action={
                narrowed ? (
                  <Button size="sm" onClick={() => go({ source: 'all', q: '' })}>
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                    New redirect
                  </Button>
                )
              }
            />
          }
        />
      )}

      <div className={css.footer}>
        {/*
          `Showing n of N`, never page numbers (`ui-architecture.md` Resolved 5) —
          which over a table somebody else is renaming pages into was a lie anyway.
        */}
        <span className={css.count}>{showing(data.page.rows.length, data.page.total)}</span>
        <span className={css.pager}>
          <Button
            size="sm"
            disabled={!data.canGoBack}
            reason="This is the first page"
            onClick={data.prevPage}
          >
            Previous
          </Button>
          <Button
            size="sm"
            disabled={data.page.cursor === null}
            reason="This is the last page"
            onClick={data.nextPage}
          >
            Next
          </Button>
        </span>
      </div>

      {creating ? (
        <NewRedirectDialog
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={(draft) => void create(draft)}
        />
      ) : null}

      {deleting ? (
        <DeleteRedirectDialog
          row={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const row = deleting
            setDeleting(null)
            void remove(row)
          }}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ create --- */

/**
 * Adding a redirect by hand — `redirects.md`'s third user story, the printed QR
 * code for a page that never existed in Folio.
 *
 * A dialog rather than the old screen's inline three-control form, for a reason the
 * old one demonstrates: `from`, `to` *and* a status is three controls plus a submit,
 * and the status was simply missing, so every hand-added redirect was a 301 whether
 * or not the page had permanently moved. Three fields with labels and help text is
 * a dialog; a header is not the place for it.
 *
 * **Client-side validation goes exactly as far as being useful** and no further —
 * see `draftRefusal`. The two refusals that matter most here are the server's, and
 * both are things only it can know: a live page already occupying `from`, and a
 * target that redirects straight back. Its messages are ones a route wrote
 * deliberately, so they arrive through `messageOf` as a toast and the dialog stays
 * open with what was typed still in it.
 */
function NewRedirectDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean
  onClose: () => void
  onSubmit: (draft: RedirectDraft) => void
}) {
  const [draft, setDraft] = useState<RedirectDraft>(BLANK_DRAFT)
  /** Refusals appear on the first submit, not on the first keystroke: a `from`
   * field that says "type the path this should redirect from" before anybody has
   * typed anything is scolding, not help. */
  const [submitted, setSubmitted] = useState(false)
  const formId = useId()

  const refusal = draftRefusal(draft)
  const shown = submitted ? refusal : null

  const submit = () => {
    setSubmitted(true)
    if (!refusal) onSubmit(draft)
  }

  return (
    <Dialog
      title="New redirect"
      description="Point a path that has nothing on it at one that does."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {/*
            `type="submit"` associated with the form by id rather than nested in
            it: the dialog's footer is outside the panel's body, and the
            association is what makes Enter in a text field submit. The
            alternative — a keydown handler on each input — reimplements a
            browser behaviour three times.
          */}
          <Button variant="primary" type="submit" form={formId} disabled={busy} reason="Saving…">
            Add redirect
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={css.form}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field
          label="From"
          required
          help="A path on this site, with or without a leading slash. Case and trailing slashes do not matter."
          error={shown?.field === 'from' ? shown.message : undefined}
        >
          {(id) => (
            <Input
              id={id}
              value={draft.from}
              placeholder="summer-sale"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          )}
        </Field>

        <Field
          label="To"
          required
          help="A path on this site, or a full URL to send people off-site. If that path itself redirects, the browser follows both hops — Folio only refuses a target that points straight back here."
          error={shown?.field === 'to' ? shown.message : undefined}
        >
          {(id) => (
            <Input
              id={id}
              value={draft.to}
              placeholder="offers"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          )}
        </Field>

        <Field
          label="Status"
          help="Permanent is what a rename writes, and what search engines act on. Temporary is for a page coming back."
        >
          {(id) => (
            <Select
              id={id}
              value={String(draft.status)}
              onChange={(e) =>
                setDraft({ ...draft, status: Number(e.target.value) as RedirectStatus })
              }
            >
              {STATUSES.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ delete --- */

/**
 * The confirmation, and the one place on this screen where `source` earns the
 * column it occupies: what removing a row costs depends entirely on whether Folio
 * wrote it or a person did, and `deleteWarning` says which.
 *
 * `Dialog`'s `danger` prop, which is what makes the affirmative action read as
 * heavier than Cancel — see its comment for why the button could not carry that on
 * its own.
 */
function DeleteRedirectDialog({
  row,
  onClose,
  onConfirm,
}: {
  row: RedirectRow
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      title={`Delete the redirect from ${pathLabel(row.from)}?`}
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
      <p className={css.dialogNote}>{deleteWarning(row)}</p>
      <p className={css.dialogNote}>
        <code className={css.path}>{pathLabel(row.from)}</code>
        <span aria-hidden="true"> → </span>
        <code className={css.path}>{targetLabel(row.to)}</code>
      </p>
    </Dialog>
  )
}
