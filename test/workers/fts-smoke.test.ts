import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The phase 1 gate for full-text search
 * (`docs/specs/content-model/full-text-search.md`), and two platform
 * measurements the rest of that spec is sized around.
 *
 * **Why this file exists at all.** Spec 30's write path leans on one FTS5
 * behaviour this repo had never observed: the special `'delete'` command issued
 * as a *multi-row* `insert into content_fts(content_fts, rowid, title, body)
 * select 'delete', id, title, body from content_text where story_id = ?`. FTS5's
 * documented examples all delete one row at a time with a `values` clause; the
 * argument that a `select` is equivalent is that FTS5's `xUpdate` is called per
 * row either way, which is true of SQLite's virtual-table interface but is not
 * something the FTS5 documentation states. A document is multi-locale, so the
 * per-publish de-index is inherently multi-row — if this did not work, the design
 * would have to read the old rows into JS first and the spec would go back to the
 * owner. It works; this is what says so, and what will keep saying so across a
 * workerd bump.
 *
 * Nothing here goes through `src/`: there is no code reading these tables yet, and
 * the point is what the *database* does. It is deliberately written against the
 * exact SQL text `server/content-index.ts` will emit in phase 3, so the two cannot
 * drift into "the test proves a statement nobody runs".
 */

const clear = async () => {
  // `content_fts` is external content: dropping the rows from `content_text`
  // without de-indexing first would leave the index describing prose that is no
  // longer there, so this uses the same two statements the real unpublish will.
  await env.DB.batch([
    env.DB.prepare(
      `insert into content_fts(content_fts, rowid, title, body)
       select 'delete', id, title, body from content_text`,
    ),
    env.DB.prepare('delete from content_text'),
  ])
}

const insertRow = (storyId: string, locale: string, title: string, body: string) =>
  env.DB.prepare(
    'insert into content_text (story_id, locale, title, body) values (?, ?, ?, ?)',
  ).bind(storyId, locale, title, body)

const indexRows = (storyId: string) =>
  env.DB.prepare(
    `insert into content_fts(rowid, title, body)
     select id, title, body from content_text where story_id = ?`,
  ).bind(storyId)

/**
 * Two stories, one of them in two locales, indexed the way a publish batch will
 * index them. `sty_a` carries "sunset" in its title and its body and "harbour" in
 * both; `sty_b` carries "harbour" in its body only, so title weighting is visible.
 */
const seed = async () => {
  await env.DB.batch([
    insertRow('sty_a', '', 'Harbour Sunset', 'The harbour at sunset was very quiet indeed.'),
    insertRow('sty_a', 'fr', 'Coucher de soleil', 'Le port au coucher de soleil était calme.'),
    insertRow('sty_b', '', 'Fishing Notes', 'A note about the harbour and the boats moored in it.'),
    indexRows('sty_a'),
    indexRows('sty_b'),
  ])
}

const matched = async (query: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    `select t.story_id as story_id, t.locale as locale
     from content_fts f
     join content_text t on t.id = f.rowid
     where content_fts match ?
     order by t.story_id, t.locale`,
  )
    .bind(query)
    .all<{ story_id: string; locale: string }>()
  return results.map((r) => `${r.story_id}:${r.locale || '-'}`)
}

describe('FTS5 in workerd', () => {
  beforeEach(async () => {
    await clear()
    await seed()
  })

  it('matches on a word in either column, across locales', async () => {
    expect(await matched('harbour')).toEqual(['sty_a:-', 'sty_b:-'])
    expect(await matched('sunset')).toEqual(['sty_a:-'])
    // The French row is a row like any other; the tokenizer is not locale-aware
    // and does not need to be.
    expect(await matched('coucher')).toEqual(['sty_a:fr'])
    expect(await matched('nothingatallliketh1s')).toEqual([])
  })

  it('folds diacritics, which is what makes one tokenizer serve every locale', async () => {
    // `remove_diacritics 2` in the DDL. "était" indexed, "etait" typed.
    expect(await matched('etait')).toEqual(['sty_a:fr'])
    expect(await matched('était')).toEqual(['sty_a:fr'])
  })

  it("answers a prefix query as a seek, which is what `prefix='2 3'` buys", async () => {
    // The query compiler appends `*` to a visitor's last token (decision 3).
    expect(await matched('harb*')).toEqual(['sty_a:-', 'sty_b:-'])
  })

  it('returns a bm25 score, and title weighting puts the titled document first', async () => {
    const { results } = await env.DB.prepare(
      `select t.story_id as story_id, -bm25(content_fts, 10.0, 1.0) as score
       from content_fts f
       join content_text t on t.id = f.rowid
       where content_fts match ?
       order by score desc`,
    )
      .bind('harbour')
      .all<{ story_id: string; score: number }>()

    expect(results.map((r) => r.story_id)).toEqual(['sty_a', 'sty_b'])
    // Negated in the SQL so higher is better and `relevance` sorts `desc` like
    // every other "best first" order (decision 2).
    for (const row of results) expect(row.score).toBeGreaterThan(0)
    expect((results[0] as { score: number }).score).toBeGreaterThan(
      (results[1] as { score: number }).score,
    )
  })

  it('returns a snippet marked with char(1)/char(2), from the external content table', async () => {
    // `snippet()` reads the matched columns out of `content_text`, which is the
    // half of external content that `contentless_delete=1` would have cost.
    //
    // C0 controls as markers rather than `<mark>`: the projection strips U+0001
    // and U+0002 from every indexed value, so a marker can never be prose, and
    // `splitSnippet` turns the result into `SnippetPart[]` without ever building
    // a string a renderer has to trust (decision 6).
    const row = await env.DB.prepare(
      `select snippet(content_fts, 1, char(1), char(2), '…', 8) as s
       from content_fts
       where content_fts match ? and rowid = (select id from content_text where story_id = 'sty_a' and locale = '')`,
    )
      .bind('sunset')
      .first<{ s: string }>()

    expect(row?.s).toContain('\u0001sunset\u0002')
    // `replaceAll` on the two literals rather than a character class: a regex
    // holding a C0 control is `lint/suspicious/noControlCharactersInRegex`, and
    // the rule is right, an invisible character inside a `[...]` is exactly the
    // thing nobody reviewing this would see.
    const plain = (row?.s ?? '').replaceAll('\u0001', '').replaceAll('\u0002', '')
    expect(plain).toContain('The harbour at sunset')
  })

  it("de-indexes a whole story with one multi-row `'delete'` … select — THE GATE", async () => {
    // The exact two statements `indexStatements` will emit for the replace half of
    // a publish, and for an unpublish and a delete. `sty_a` has *two* rows, so the
    // `select` feeds the command column twice in one statement: the thing this
    // file exists to prove.
    await env.DB.batch([
      env.DB.prepare(
        `insert into content_fts(content_fts, rowid, title, body)
         select 'delete', id, title, body from content_text where story_id = ?`,
      ).bind('sty_a'),
      env.DB.prepare('delete from content_text where story_id = ?').bind('sty_a'),
    ])

    // Both of `sty_a`'s locales are gone from the index, and `sty_b` is untouched.
    expect(await matched('harbour')).toEqual(['sty_b:-'])
    expect(await matched('sunset')).toEqual([])
    expect(await matched('coucher')).toEqual([])
    expect(await matched('etait')).toEqual([])

    // `matched` joins back to `content_text`, so it would also report an empty set
    // for tokens FTS5 still held. Ask the index on its own terms as well: a
    // lingering token entry would answer a rowid here.
    const orphan = await env.DB.prepare(
      'select count(*) as n from content_fts where content_fts match ?',
    )
      .bind('sunset OR coucher')
      .first<{ n: number }>()
    expect(orphan?.n).toBe(0)
  })

  it("passes FTS5's own integrity-check after that delete", async () => {
    // The only assertion that can see a *partial* de-index: `integrity-check`
    // walks the index and the content table together and errors if they disagree.
    // "match returns nothing" would also be true of an index that had silently
    // dropped everything.
    await env.DB.batch([
      env.DB.prepare(
        `insert into content_fts(content_fts, rowid, title, body)
         select 'delete', id, title, body from content_text where story_id = ?`,
      ).bind('sty_a'),
      env.DB.prepare('delete from content_text where story_id = ?').bind('sty_a'),
    ])

    await expect(
      env.DB.prepare("insert into content_fts(content_fts) values('integrity-check')").run(),
    ).resolves.toBeTruthy()

    // And the surviving story is still fully indexed, not merely still matching.
    expect(await matched('boats')).toEqual(['sty_b:-'])
  })

  it('round-trips a 64 kB body through one bound parameter', async () => {
    // `MAX_SEARCH_BODY` is 65_536, and the body is one bind of the four-bind
    // insert. D1's documented maximum string size is 2 MB, so this is well inside
    // it — asserted because the cap was chosen on that basis.
    const needle = 'zqxjubilant'
    const body = `${'lorem ipsum dolor sit amet '.repeat(2400)}${needle}`
    expect(body.length).toBeGreaterThan(64_000)

    await env.DB.batch([insertRow('sty_big', '', 'Big', body), indexRows('sty_big')])
    expect(await matched(needle)).toEqual(['sty_big:-'])
  })
})

/**
 * **D1 binds at most 100 parameters per statement.** Measured here rather than
 * taken on trust, because two places in this repo assumed otherwise and the
 * Cloudflare docs were not found to settle it when spec 30 was drafted.
 *
 * They agree, as it turns out: `d1/platform/limits` says "Maximum bound
 * parameters per query: 100", and workerd's SQLite refuses the 101st with
 * `D1_ERROR: too many SQL variables`. So the number is not a local artefact of
 * the test runtime, and a statement that passes here passes in production.
 *
 * What it costs, recorded because it is a live bug rather than a hypothetical:
 * `server/content-index.ts` builds one multi-row insert per table, five binds per
 * `content_index` row and three per `content_refs` row, capped at
 * `MAX_ROWS = 400`. Twenty-one index rows (five indexed fields across five
 * locales) or thirty-four outbound refs (a page with thirty-four internal links)
 * therefore fail the *whole publish batch* today. `MAX_ROWS` was sized against a
 * ceiling that does not exist. Spec 30 phase 3 chunks both.
 */
describe('D1 bound-parameter cap', () => {
  const bindN = async (n: number): Promise<string | null> => {
    const holes = Array.from({ length: n }, () => '?').join(', ')
    try {
      await env.DB.prepare(`select count(*) as n from stories where id in (${holes})`)
        .bind(...Array.from({ length: n }, (_, i) => `sty_${i}`))
        .first()
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  it('accepts exactly 100 and refuses 101', async () => {
    expect(await bindN(1)).toBeNull()
    expect(await bindN(99)).toBeNull()
    expect(await bindN(100)).toBeNull()
    expect(await bindN(101)).toMatch(/too many SQL variables/)
  })

  it('refuses 150, 500 and 2000 the same way, so nothing about it is a soft limit', async () => {
    // The three the spec asked for. There is no degradation and no truncation:
    // one error, at the same offset, for every size above the cap.
    for (const n of [150, 500, 2000]) {
      expect(await bindN(n)).toMatch(/too many SQL variables/)
    }
  })

  it("is what breaks `content_index`'s multi-row insert above twenty rows", async () => {
    // Exactly the statement `indexStatements` emits, at five binds a row.
    const insertIndex = (rows: number) => {
      const values = Array.from({ length: rows }, () => '(?, ?, ?, ?, ?)').join(', ')
      const binds = Array.from({ length: rows }, (_, i) => [
        'sty_cap',
        '',
        `field_${i}`,
        'value',
        null,
      ]).flat()
      return env.DB.prepare(
        `insert into content_index (story_id, locale, field, text_value, num_value) values ${values}`,
      )
        .bind(...binds)
        .run()
    }

    await expect(insertIndex(20)).resolves.toBeTruthy()
    await expect(insertIndex(21)).rejects.toThrow(/too many SQL variables/)
    await env.DB.prepare('delete from content_index').run()
  })

  it("is what breaks `content_refs`' multi-row insert above thirty-three rows", async () => {
    // Three binds a row, so the reachable limit is lower: a page with thirty-four
    // internal links, which `pagination.md`'s edge cases call legitimate.
    const insertRefs = (rows: number) => {
      const values = Array.from({ length: rows }, () => '(?, ?, ?)').join(', ')
      const binds = Array.from({ length: rows }, (_, i) => [
        'sty_cap',
        `sty_target_${i}`,
        'link',
      ]).flat()
      return env.DB.prepare(
        `insert or ignore into content_refs (from_story, to_id, kind) values ${values}`,
      )
        .bind(...binds)
        .run()
    }

    await expect(insertRefs(33)).resolves.toBeTruthy()
    await expect(insertRefs(34)).rejects.toThrow(/too many SQL variables/)
    await env.DB.prepare('delete from content_refs').run()
  })

  it('applies per statement, not per batch, so chunking is the whole fix', async () => {
    // Four statements of a hundred binds each in one transaction is fine. That is
    // what makes "split the insert into chunks and batch them" a fix rather than a
    // trade: a publish stays one transaction.
    const hundred = () => {
      const holes = Array.from({ length: 100 }, () => '?').join(', ')
      return env.DB.prepare(`select count(*) as n from stories where id in (${holes})`).bind(
        ...Array.from({ length: 100 }, (_, i) => `sty_${i}`),
      )
    }
    const out = await env.DB.batch([hundred(), hundred(), hundred(), hundred()])
    expect(out).toHaveLength(4)
  })
})
