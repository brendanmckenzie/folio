import { describe, expect, it } from 'vitest'
import type { FormField } from '../../../src/core/forms'
import {
  ABSENT,
  ageLabel,
  answerLines,
  answerText,
  cellText,
  csvHref,
  deleteConfirmation,
  deleteOneWarning,
  deleteRefusal,
  fileHref,
  isNarrowed,
  isTicked,
  NOTHING,
  parseResponsesUrl,
  responseFilterOf,
  responsesParams,
  responsesQuery,
  retentionNote,
  retryLabel,
  runReport,
  selectAll,
  selectionBody,
  selectionSummary,
  sizeLabel,
  submittedLabel,
  tableColumns,
  type Ticked,
  tickAllShown,
  tickCount,
  toggleTick,
} from '../../../src/admin/ui/screens/responses-model'
import type { ResponseRow } from '../../../src/server/form-responses'

/**
 * The Responses screen's model (`docs/specs/content-model/forms.md` phase 7).
 *
 * No admin test mounts a component, so everything the screen *decides* lives
 * here and is tested here. Four groups, and each has one property that is silent
 * when it breaks:
 *
 *  - **The date filter's `to` is the day after the one typed**, because the
 *    route's `to` is exclusive. Off by one and the last day somebody names is
 *    missing from their own filter.
 *  - **A retired key is shown and marked, never dropped.** A drawer that quietly
 *    hid the answers to questions since removed is a record of something else.
 *  - **A select-all carries the count the person read**, unchanged, or the
 *    server's guard is comparing against a number nobody agreed to.
 *  - **The confirmation names the invisible part.** Acting on more than you can
 *    see is the hazard, and nothing on this screen is recoverable.
 */

const field = (name: string, over: Partial<FormField> = {}): FormField =>
  ({ name, kind: 'text', label: name, ...over }) as FormField

const row = (over: Partial<ResponseRow> = {}): ResponseRow => ({
  id: 'res_0123456789ab',
  formId: 'frm_0123456789ab',
  version: 2,
  createdAt: Date.UTC(2026, 8, 6, 9, 30),
  data: {},
  locale: '',
  page: '',
  files: [],
  ...over,
})

const DAY = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------------ URL --- */

describe('the URL', () => {
  it('reads the three filters, and refuses anything that is not a date', () => {
    expect(parseResponsesUrl({ from: '2026-09-01', to: '2026-09-03', q: 'ada' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-03',
      q: 'ada',
    })
    // A half-typed date must not become a request the server refuses.
    expect(parseResponsesUrl({ from: '2026-09', to: 'yesterday' })).toEqual({
      from: '',
      to: '',
      q: '',
    })
  })

  it('writes defaults as undefined, so they leave the URL rather than sitting in it', () => {
    expect(responsesQuery({ from: '', to: '', q: '' })).toEqual({
      from: undefined,
      to: undefined,
      q: undefined,
    })
  })

  it('knows whether the list is narrowed, which is what "clear filters" is for', () => {
    expect(isNarrowed({ from: '', to: '', q: '' })).toBe(false)
    expect(isNarrowed({ from: '', to: '', q: '  ' })).toBe(false)
    expect(isNarrowed({ from: '2026-09-01', to: '', q: '' })).toBe(true)
    expect(isNarrowed({ from: '', to: '', q: 'ada' })).toBe(true)
  })
})

describe('responseFilterOf', () => {
  it('takes `from` as the start of that UTC day', () => {
    expect(responseFilterOf({ from: '2026-09-01', to: '', q: '' })).toEqual({
      from: Date.UTC(2026, 8, 1),
    })
  })

  it('takes `to` as the start of the **next** day, because the route’s bound is exclusive', () => {
    // The whole of 3 September is inside the filter. Off by one and the last day
    // somebody names is silently missing from their own results.
    expect(responseFilterOf({ from: '', to: '2026-09-03', q: '' })).toEqual({
      to: Date.UTC(2026, 8, 3) + DAY,
    })
  })

  it('trims the search term and omits an empty one', () => {
    expect(responseFilterOf({ from: '', to: '', q: '  ada  ' })).toEqual({ q: 'ada' })
    expect(responseFilterOf({ from: '', to: '', q: '   ' })).toEqual({})
  })

  it('omits a malformed date entirely rather than sending something', () => {
    expect(responseFilterOf({ from: 'nope', to: '', q: '' })).toEqual({})
  })
})

describe('responsesParams and csvHref', () => {
  const url = { from: '2026-09-01', to: '2026-09-03', q: 'ada' }

  it('sends the same three clauses the filter names, plus the paging', () => {
    const params = responsesParams(url, { limit: 50, count: true, cursor: 'abc' })
    expect(params.get('from')).toBe(String(Date.UTC(2026, 8, 1)))
    expect(params.get('to')).toBe(String(Date.UTC(2026, 8, 3) + DAY))
    expect(params.get('q')).toBe('ada')
    expect(params.get('limit')).toBe('50')
    expect(params.get('count')).toBe('1')
    expect(params.get('cursor')).toBe('abc')
  })

  it('omits the cursor and the count when they were not asked for', () => {
    const params = responsesParams(url, { limit: 50 })
    expect(params.get('cursor')).toBeNull()
    expect(params.get('count')).toBeNull()
  })

  it('gives the export the table’s own filter, and no paging at all', () => {
    // Decision 16: the export honours the filter the table is showing, which is
    // only true if one function builds both.
    const href = csvHref('/folio/api', 'frm_0123456789ab', url)
    expect(href).toContain('/folio/api/forms/frm_0123456789ab/responses.csv?')
    expect(href).toContain(`from=${Date.UTC(2026, 8, 1)}`)
    expect(href).toContain('q=ada')
    expect(href).not.toContain('limit=')
  })

  it('leaves the export’s URL bare when nothing is filtered', () => {
    expect(csvHref('/folio/api', 'frm_0123456789ab', { from: '', to: '', q: '' })).toBe(
      '/folio/api/forms/frm_0123456789ab/responses.csv',
    )
  })
})

/* ----------------------------------------------------------------- rows --- */

describe('the table’s cells', () => {
  it('draws a column per current question and none for a statement', () => {
    const fields = [field('a'), field('note', { kind: 'statement' }), field('b')]
    expect(tableColumns(fields).map((f) => f.name)).toEqual(['a', 'b'])
  })

  it('renders an unanswered current question as an em dash', () => {
    expect(cellText(field('a'), row())).toBe(ABSENT)
    expect(cellText(field('a'), row({ data: { a: 'yes' } }))).toBe('yes')
  })

  it('reads a file question from the files column, since it stores no answer', () => {
    const withFile = row({
      files: [{ field: 'cv', key: 'sub_x', filename: 'cv.pdf', size: 12, contentType: 'x' }],
    })
    expect(cellText(field('cv', { kind: 'file' }), withFile)).toBe('cv.pdf')
    expect(cellText(field('cv', { kind: 'file' }), row())).toBe(ABSENT)
  })

  it('renders a list joined and a tick box in a person’s words', () => {
    expect(answerText(['a', 'b'])).toBe('a, b')
    expect(answerText([])).toBe(ABSENT)
    expect(answerText(true)).toBe('yes')
    expect(answerText(false)).toBe('no')
    expect(answerText(12)).toBe('12')
    expect(answerText(undefined)).toBe(ABSENT)
  })

  it('shows a year in a date, unlike the content tree’s own stamp', () => {
    const now = Date.UTC(2026, 8, 6, 12)
    expect(submittedLabel(now - 30 * 1000, now)).toBe('just now')
    expect(submittedLabel(now - 5 * 60 * 1000, now)).toBe('5m ago')
    expect(submittedLabel(now - 5 * 60 * 60 * 1000, now)).toBe('5h ago')
    expect(submittedLabel(now - 5 * DAY, now)).toBe('5d ago')
    // A table whose whole point is that rows accumulate for years cannot render
    // a two-year-old row as "6 Sep".
    expect(submittedLabel(now - 400 * DAY, now)).toMatch(/202[45]/)
  })

  it('sizes a file the way a person reads one', () => {
    expect(sizeLabel(400)).toBe('400 B')
    expect(sizeLabel(2048)).toBe('2 KB')
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

/* --------------------------------------------------------------- drawer --- */

describe('answerLines', () => {
  const fields = [field('full_name'), field('cv', { kind: 'file' })]

  it('lists the current questions first, in the builder’s order', () => {
    const lines = answerLines(row({ data: { full_name: 'Ada' } }), fields)
    expect(lines.map((line) => line.name)).toEqual(['full_name', 'cv'])
    expect(lines[0]?.value).toBe('Ada')
    expect(lines[0]?.retired).toBe(false)
  })

  it('shows a key the form no longer declares, and marks it retired', () => {
    // Decision 7: a two-year-old response has to stay readable after the form has
    // moved on, and this is how it says so.
    const lines = answerLines(row({ data: { full_name: 'Ada', fax: '555' } }), fields)
    const fax = lines.find((line) => line.name === 'fax')
    expect(fax).toBeDefined()
    expect(fax?.retired).toBe(true)
    expect(fax?.value).toBe('555')
  })

  it('keeps a current question the response never answered, as an em dash', () => {
    const lines = answerLines(row(), fields)
    expect(lines.find((line) => line.name === 'full_name')?.value).toBe(ABSENT)
  })

  it('surfaces a retired **file** question, which leaves no key in `data` at all', () => {
    // Without this the drawer says the response holds nothing while an object
    // with somebody's CV in it sits in the bucket.
    const lines = answerLines(
      row({
        files: [{ field: 'resume', key: 'sub_x', filename: 'me.pdf', size: 9, contentType: 'x' }],
      }),
      [field('full_name')],
    )
    const line = lines.find((one) => one.name === 'resume')
    expect(line?.retired).toBe(true)
    expect(line?.file?.filename).toBe('me.pdf')
  })

  it('sorts the retired keys, so the drawer is stable between two responses', () => {
    const lines = answerLines(row({ data: { zip: '1', company: '2' } }), [])
    expect(lines.map((line) => line.name)).toEqual(['company', 'zip'])
  })

  it('addresses a download by the question, never by the R2 key', () => {
    expect(fileHref('/folio/api', 'frm_a', 'res_b', 'cv')).toBe(
      '/folio/api/forms/frm_a/responses/res_b/file/cv',
    )
  })
})

/* ------------------------------------------------------------ selection --- */

describe('the selection', () => {
  const rows = [row({ id: 'res_a' }), row({ id: 'res_b' }), row({ id: 'res_c' })]
  const url = { from: '', to: '', q: 'ada' }

  it('ticks and unticks an explicit list', () => {
    let ticked: Ticked = NOTHING
    ticked = toggleTick(ticked, 'res_a')
    expect(isTicked(ticked, 'res_a')).toBe(true)
    expect(tickCount(ticked)).toBe(1)
    ticked = toggleTick(ticked, 'res_a')
    expect(tickCount(ticked)).toBe(0)
  })

  it('captures the filter and the count the person read, unchanged', () => {
    const ticked = selectAll(url, 51_420)
    expect(ticked.all).toBe(true)
    expect(tickCount(ticked)).toBe(51_420)
    expect(selectionBody(ticked)).toEqual({ all: true, filter: { q: 'ada' }, expected: 51_420 })
  })

  it('ticking a row off a select-all adds to `exclude` rather than materialising ids', () => {
    // This is what keeps "all 51,420 except these two" four small JSON fields.
    const ticked = toggleTick(selectAll(url, 51_420), 'res_a')
    expect(tickCount(ticked)).toBe(51_419)
    expect(selectionBody(ticked)).toEqual({
      all: true,
      filter: { q: 'ada' },
      expected: 51_420,
      exclude: ['res_a'],
    })
  })

  it('omits an empty `exclude` rather than sending it, because the route is strict', () => {
    expect(selectionBody(selectAll(url, 3))).not.toHaveProperty('exclude')
  })

  it('never counts below zero when `exclude` outgrows what still matches', () => {
    let ticked = selectAll(url, 1)
    for (const one of rows) ticked = toggleTick(ticked, one.id)
    expect(tickCount(ticked)).toBe(0)
  })

  it('selects and deselects everything shown, in both selection shapes', () => {
    const all = tickAllShown(NOTHING, rows)
    expect(tickCount(all)).toBe(3)
    expect(tickCount(tickAllShown(all, rows))).toBe(0)

    const captured = tickAllShown(selectAll(url, 10), rows)
    expect(tickCount(captured)).toBe(7)
  })

  it('names the part of the selection that is not on screen', () => {
    expect(selectionSummary(NOTHING, rows)).toBe('Nothing selected')
    expect(selectionSummary(tickAllShown(NOTHING, rows), rows)).toBe('3 responses selected')
    expect(selectionSummary(selectAll(url, 51_420), rows)).toBe(
      'All 51,420 matching · 3 shown here',
    )
    expect(selectionSummary(selectAll(url, 51_420), [])).toBe(
      'All 51,420 matching, none shown here',
    )
  })
})

/* -------------------------------------------------------- confirmations --- */

describe('the confirmations', () => {
  const rows = [row({ id: 'res_a' }), row({ id: 'res_b' })]
  const url = { from: '', to: '', q: '' }

  it('asks nothing when nothing is selected', () => {
    expect(deleteConfirmation(NOTHING, rows, false)).toBeNull()
  })

  it('always asks, and always as a danger, however visible the selection is', () => {
    // Unlike the Content screen's, which skips the question for a fully visible
    // non-delete selection: there is no non-delete action here and nothing is
    // recoverable.
    const confirmation = deleteConfirmation(tickAllShown(NOTHING, rows), rows, false)
    expect(confirmation?.danger).toBe(true)
    expect(confirmation?.title).toBe('Delete 2 responses?')
    expect(confirmation?.body).toContain('cannot be undone')
  })

  it('names the rows that are not on screen', () => {
    const confirmation = deleteConfirmation(selectAll(url, 51_420), rows, false)
    expect(confirmation?.title).toBe('Delete 51,420 responses?')
    expect(confirmation?.body).toContain('51,418 are not shown by the current filter')
    expect(confirmation?.body).toContain('as it stood when you chose it')
  })

  it('says the files go too, only when the form has any', () => {
    const ticked = tickAllShown(NOTHING, rows)
    expect(deleteConfirmation(ticked, rows, true)?.body).toContain('files people attached')
    expect(deleteConfirmation(ticked, rows, false)?.body).not.toContain('files people attached')
  })

  it('re-confirms a refusal against the new count, as a door rather than a wall', () => {
    const refusal = deleteRefusal({ expected: 40, actual: 43 })
    expect(refusal.title).toBe('43 responses match now, not 40')
    expect(refusal.body).toContain('Delete the 43')
    expect(retryLabel({ actual: 43 })).toBe('Delete 43 responses')
    expect(retryLabel({ actual: 1 })).toBe('Delete 1 response')
  })

  it('reports a finished run without implying it was atomic', () => {
    expect(runReport(12, [])).toBe('Deleted 12 responses')
    expect(runReport(1, [])).toBe('Deleted 1 response')
    expect(runReport(10, [{ title: '2026-09-06 09:30', message: 'Locked' }])).toBe(
      'Deleted 10, 1 refused: 2026-09-06 09:30 (Locked)',
    )
    expect(runReport(0, [{ title: '', message: 'Locked' }])).toBe(
      'Could not delete it: a response (Locked)',
    )
  })

  it('names the files a single delete destroys, because they are the part nobody thinks of', () => {
    expect(deleteOneWarning(row())).not.toContain('file')
    const one = deleteOneWarning(
      row({ files: [{ field: 'cv', key: 'k', filename: 'cv.pdf', size: 1, contentType: 'x' }] }),
    )
    expect(one).toContain('The file attached to it goes too')
  })
})

/* -------------------------------------------------------------- ageing --- */

describe('the retention line', () => {
  const now = Date.UTC(2026, 8, 6)

  it('answers in the coarsest unit that is still true', () => {
    expect(ageLabel(now - 3 * 60 * 60 * 1000, now)).toBe('less than a day')
    expect(ageLabel(now - DAY, now)).toBe('1 day')
    expect(ageLabel(now - 10 * DAY, now)).toBe('10 days')
    expect(ageLabel(now - 200 * DAY, now)).toBe('6 months')
    expect(ageLabel(now - 900 * DAY, now)).toBe('2 years')
  })

  it('says nothing at all for a form nobody has answered', () => {
    // Decision 17's line exists to make manual retention visible; on an empty
    // table it would be a sentence about nothing.
    expect(retentionNote(null)).toBeNull()
    expect(retentionNote(undefined)).toBeNull()
  })

  it('says what accumulates and that nothing will clear it', () => {
    expect(retentionNote(now - 400 * DAY, now)).toBe(
      'The oldest response here is 13 months old. Folio never deletes one for you.',
    )
  })
})
