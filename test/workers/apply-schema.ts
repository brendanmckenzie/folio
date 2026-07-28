import { env } from 'cloudflare:test'
import { beforeAll } from 'vitest'
// The very file examples/demo hands to `wrangler d1 execute --file`, so the test
// database and a real deployment can never drift.
import schema from '../../schema.sql?raw'

/**
 * Splits schema.sql into executable statements.
 *
 * Comments are stripped *before* splitting on ';' because schema.sql has `--`
 * comments that contain semicolons ("...without loading every Durable Object;
 * the document is the source of truth"), and a naive split tears both the
 * comment and the statement that follows it in half. No string literal in the
 * file contains '--', which is what makes the blunt regex safe.
 */
function statementsOf(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/**
 * D1's `exec()` is line-oriented and rejects a multi-line `create table`, and
 * `batch()` wraps everything in one transaction, so statements go one at a time.
 *
 * Runs once per test file. The pool's isolated storage undoes writes made by
 * each test but keeps what setup files and `beforeAll` wrote, so every file
 * starts from exactly the seed rows in schema.sql.
 */
beforeAll(async () => {
  for (const statement of statementsOf(schema)) {
    await env.DB.prepare(statement).run()
  }
})
