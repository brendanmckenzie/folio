/**
 * Splits a `.sql` file into the statements a driver executes one at a time,
 * and orders migration filenames, matching wrangler 4.114's own
 * `splitSqlIntoStatements` / `compareMigrationPaths` closely enough that this
 * harness and a real `wrangler d1 migrations apply` run can never parse the
 * same file two different ways. Shared by apply-schema.ts (the migrations
 * directory) and seed-fixture.ts (examples/demo/seed.sql), so both read
 * exactly what wrangler would.
 */

/**
 * Quote- and comment-aware, unlike a blunt `strip '--' then split on ';'`:
 * that approach breaks the moment a string literal contains either character,
 * and neither this file nor wrangler's parser may assume no migration ever
 * will. `BEGIN ... END` is tracked so a trigger or view body's internal `;`
 * stays inside one statement instead of splitting it in two.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let beginDepth = 0
  let i = 0
  const n = sql.length

  const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch)
  // A comment-only chunk (or nothing at all) between two ';'s is not a
  // statement — executing it would hand the driver an empty prepare().
  const hasContent = (chunk: string) =>
    chunk
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim().length > 0

  while (i < n) {
    const ch = sql[i] as string

    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      current += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      current += sql.slice(i, stop)
      i = stop
      continue
    }
    // String and identifier literals: copied verbatim, doubled-quote escapes
    // (`''` inside a `'...'`) included, so nothing inside one is mistaken for
    // the statement terminator or a comment starting mid-literal.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      current += sql.slice(i, j)
      i = j
      continue
    }
    if (isWordChar(ch)) {
      let j = i
      while (j < n && isWordChar(sql[j] as string)) j++
      const word = sql.slice(i, j)
      const lower = word.toLowerCase()
      if (lower === 'begin') beginDepth++
      else if (lower === 'end' && beginDepth > 0) beginDepth--
      current += word
      i = j
      continue
    }
    if (ch === ';' && beginDepth === 0) {
      if (hasContent(current)) statements.push(current.trim())
      current = ''
      i++
      continue
    }
    current += ch
    i++
  }

  if (hasContent(current)) statements.push(current.trim())
  return statements
}

/**
 * wrangler's `compareMigrationPaths` sorts on `parseInt` of the leading
 * `<number>_` prefix, not the filename string, so `2_x.sql` orders before
 * `10_y.sql`. This repo's files are zero-padded (0001, 0002, ...) so a plain
 * string sort has so far agreed with it by coincidence; a future migration
 * numbered without padding would apply in the opposite order here versus a
 * real `wrangler d1 migrations apply` run if this harness kept using string
 * comparison.
 */
export function compareMigrationFilenames(a: string, b: string): number {
  const numberOf = (name: string) => {
    const match = /^(\d+)_/.exec(name)
    return match ? Number.parseInt(match[1] as string, 10) : Number.POSITIVE_INFINITY
  }
  const diff = numberOf(a) - numberOf(b)
  if (diff !== 0) return diff
  return a < b ? -1 : a > b ? 1 : 0
}
