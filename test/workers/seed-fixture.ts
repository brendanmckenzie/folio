import { splitSqlStatements } from './sql-split'

/**
 * The exact file `pnpm db:seed` runs against a real deployment
 * (examples/demo/seed.sql), inlined at build time the same way apply-schema.ts
 * inlines the migrations directory: `import.meta.glob` + `?raw` needs no
 * filesystem access inside workerd.
 *
 * Every workers test that needs "the three demo stories" (sty_home, sty_about,
 * sty_team) runs *this* rather than hand-typing the same three inserts a third
 * time: three independent copies of the same rows can drift from seed.sql and
 * from each other with nothing to notice, which is what happened before this
 * file existed (smoke.test.ts, http.test.ts and stories.test.ts each hand-
 * rolled the insert). Running the real file here means a wrong column order or
 * a typo in it fails the same tests that already assume it worked, instead of
 * shipping silently.
 */
const modules = import.meta.glob('../../examples/demo/seed.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const seedSql = Object.values(modules)[0]
if (seedSql === undefined) throw new Error('examples/demo/seed.sql not found from test/workers')

const statements = splitSqlStatements(seedSql)

/**
 * Inserts the three demo stories (see examples/demo/seed.sql) into `db`.
 *
 * **Clears what the seed itself writes credentials into, first.** `seed.sql` is a
 * file that runs once against a fresh deployment, so every row in it has a fixed
 * primary key and several have unique columns besides — `users.email`,
 * `api_tokens.id`, `shares.token_hash` — and re-applying it inside a `beforeEach`
 * collides on the second test in a file.
 *
 * That has now been discovered three times, once per table the seed grew
 * (identity-and-access added the editors, content-api the token, draft-sharing the
 * preview link), and each time it was fixed by adding a `delete` to whichever test
 * file failed — so the next file to call this got the same failure again. It belongs
 * here: this module is the one thing that knows which tables `seed.sql` writes.
 *
 * `stories` is deliberately **not** cleared here. Every caller already resets the
 * tree on its own terms — some seed extra rows around the demo three — and taking
 * that decision away from them would be a wider change than this fixture is for.
 */
export async function applySeedFixture(db: D1Database): Promise<void> {
  // `api_tokens.created_by` points at a `users` row, so it goes first; `shares` has
  // no foreign key at all and could go anywhere.
  await db.batch([
    db.prepare('delete from shares'),
    db.prepare('delete from api_tokens'),
    db.prepare('delete from users'),
  ])
  await db.batch(statements.map((sql) => db.prepare(sql)))
}
