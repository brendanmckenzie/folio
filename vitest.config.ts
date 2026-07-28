import { defineConfig } from 'vitest/config'

// Two test trees:
//   test/unit/**     — pure logic, runs in Node (core/, admin store, preview render)
//   test/workers/**  — server + Durable Object tests, runs in workerd via
//                      @cloudflare/vitest-pool-workers (own project config added
//                      alongside its scaffolding).
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
    ],
  },
})
