import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Two test trees:
//   test/unit/**     — pure logic, runs in Node (core/, admin store, preview render)
//   test/workers/**  — server + Durable Object tests, runs in workerd via
//                      @cloudflare/vitest-pool-workers (own project config added
//                      alongside its scaffolding).
//
// Sharp edges of the workers project, in the order they bite:
//
//  1. @cloudflare/vitest-pool-workers 0.18 dropped the '/config' entrypoint.
//     There is no `defineWorkersProject` and no `test.poolOptions.workers` any
//     more: what used to go in poolOptions is now the argument to the
//     `cloudflareTest()` Vite plugin, which sets `pool` and `poolRunner` on the
//     project itself. The package ships a codemod for the old shape at
//     @cloudflare/vitest-pool-workers/codemods/vitest-v3-to-v4.
//  2. `isolatedStorage`, `singleWorker` and friends are gone from the options
//     schema, and so is the per-test storage stack they configured. Verified
//     behaviour: storage is isolated per test *file* (one file cannot see
//     another's rows or R2 objects) but writes persist from one test to the next
//     inside a file. Mutate the seed data and you clean up after yourself.
//  3. The plugin belongs on the *project*, not the root config, so it cannot
//     rewrite the 'unit' project's resolve conditions to workerd's.
//  4. `main` is relative to this config's directory; the `main` inside
//     test/workers/wrangler.jsonc is relative to that file. Both must point at
//     test/workers/worker.ts, which is what makes the STORY binding resolvable
//     without an explicit `scriptName`.
//  5. Coverage must use the istanbul provider if it is ever turned on; the v8
//     provider needs node:inspector, which workerd does not have.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.{ts,tsx}'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: './test/workers/worker.ts',
            wrangler: { configPath: './test/workers/wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/workers/**/*.test.{ts,tsx}'],
          setupFiles: ['./test/workers/apply-schema.ts'],
        },
      },
    ],
  },
})
