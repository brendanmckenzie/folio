import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Three test trees:
//   test/unit/**            — pure logic, runs in Node (core/, admin models, preview render)
//   test/unit/admin/render/** — the admin mounted, in a DOM (happy-dom)
//   test/workers/**         — server + Durable Object tests, runs in workerd via
//                             @cloudflare/vitest-pool-workers (own project config added
//                             alongside its scaffolding).
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
//
// Sharp edges of the 'render' project, which is new and has its own:
//
//  6. **`unit` must exclude what `render` includes.** `unit`'s glob is the whole
//     of `test/unit/**`, so without the exclusion below every render file would
//     run twice — once in Node, where `document` does not exist — and the second
//     failure reads as a broken test rather than as a misconfigured project.
//  7. **It is a subdirectory, not the whole of `test/unit/admin/**`.** Issue #14's
//     setup note called for a DOM "for `test/unit/admin/**` specifically, not for
//     the whole project", and the point of that clause is the second half: the
//     core and server tests have no use for a DOM, and `test/unit/preview/*.tsx`
//     renders through `react-dom/server` and wants Node. Narrowing further, to the
//     files that actually mount something, keeps the other 45 admin test files
//     running exactly as they did — they are pure model and router tests, and
//     giving them DOM globals changes what they prove without being asked to.
//     The line the config now records is *pure versus mounted*, which is the real
//     distinction; `admin/` versus everything else is a directory accident.
//  8. **Vite processes CSS modules here, so `css.wrap` is a real hashed class**
//     (`_wrap_ee5c16`), not `undefined` and not the bare key. That is what makes
//     `scoped(css.wrap)` assertable against a rendered node's `classList`, which
//     is the whole point of `render/ui-scope-render.test.tsx`. Do not assume the
//     opposite and reach for a source-text check; `ui-scope.test.ts` reads CSS as
//     text for a different reason — it checks the *stylesheet's* selectors.
//  9. happy-dom rather than jsdom: it is the faster of the two and it carries
//     everything this admin touches on mount, `ResizeObserver` included (`ui/fit.ts`
//     constructs one). Nothing here needs a layout engine — these are smoke tests,
//     and every assertion about geometry in this repo is a source-text or CSS-text
//     assertion for exactly that reason.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.{ts,tsx}'],
          exclude: ['test/unit/admin/render/**'],
        },
      },
      {
        test: {
          name: 'render',
          environment: 'happy-dom',
          include: ['test/unit/admin/render/**/*.test.{ts,tsx}'],
          setupFiles: ['./test/unit/admin/render/setup.ts'],
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
