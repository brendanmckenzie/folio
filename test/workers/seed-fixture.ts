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
const modules = import.meta.glob('../../../../examples/demo/seed.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const seedSql = Object.values(modules)[0]
if (seedSql === undefined) throw new Error('examples/demo/seed.sql not found from test/workers')

const statements = splitSqlStatements(seedSql)

/** Inserts the three demo stories (see examples/demo/seed.sql) into `db`. */
export async function applySeedFixture(db: D1Database): Promise<void> {
  await db.batch(statements.map((sql) => db.prepare(sql)))
}
