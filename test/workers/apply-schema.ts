import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'
import { compareMigrationFilenames, splitSqlStatements } from './sql-split'

/**
 * The same directory `wrangler d1 migrations apply` reads for examples/demo
 * and any real deployment, so the test database and a production one can
 * never drift onto different schema histories.
 *
 * `applyD1Migrations` (from `cloudflare:test`) is the pool's own helper for
 * this, and normally pairs with a `readD1Migrations(path)` that reads the
 * directory from disk on the Node side and hands the array across as a
 * binding. That doesn't fit here: `readD1Migrations` is documented as living
 * at `@cloudflare/vitest-pool-workers/config`, but this pool version (0.18)
 * doesn't publish that subpath — it exports straight off the package root,
 * which is a Node/Vite-config module that pulls in workerd's own binary and
 * cannot be imported from code that gets bundled *into* the worker, which
 * this setup file is. Wiring it through a binding also means editing
 * vitest.config.ts, outside this file's ownership.
 *
 * Vite's `import.meta.glob` sidesteps both problems the way the old single-
 * file `?raw` import did: `eager` + `query: '?raw'` inlines every migration's
 * text as a plain string at build time, so no filesystem read happens inside
 * workerd at all.
 *
 * Splitting the file into statements and ordering the files both go through
 * sql-split.ts rather than a blunt strip-then-split and a plain string sort:
 * see that file for why (wrangler 4.114's own parser is quote- and
 * BEGIN/END-aware, and orders on the numeric migration prefix, not the
 * filename string).
 */
const modules = import.meta.glob('../../migrations/*.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const migrations = Object.entries(modules)
  .map(([path, sql]) => ({ name: path.split('/').at(-1) ?? path, sql }))
  .sort((a, b) => compareMigrationFilenames(a.name, b.name))
  .map(({ name, sql }) => ({ name, queries: splitSqlStatements(sql) }))

/**
 * Runs once per test file. The pool's isolated storage undoes writes made by
 * each test but keeps what setup files and `beforeAll` wrote, so every file
 * starts from exactly the structure the migrations produce — no seed rows,
 * since migrations are structure only. Tests that need a story on hand seed
 * one explicitly (see the fixtures in smoke.test.ts, http.test.ts and
 * stories.test.ts's `resetStories`).
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations)
})
