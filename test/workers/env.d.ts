/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { SpaceDO, StoryDO } from '../../src/server'

/**
 * Types for the bindings declared in test/workers/wrangler.jsonc.
 *
 * `wrangler types` would generate this, but it needs a real project; hand-writing
 * the augmentation keeps the test tree self-contained. Shapes must match
 * FolioBindings in src/server/types.ts.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      STORY: DurableObjectNamespace<StoryDO>
      /** The space channel (editing/live-collaboration.md). Optional on
       * FolioBindings; bound here, because there are tests that drive it. */
      SPACE: DurableObjectNamespace<SpaceDO>
      MEDIA: R2Bucket
      /**
       * Optional, and deliberately not bound in wrangler.jsonc: tests exercise
       * the no-Images fallback. Typed here so a test can assert it is absent.
       */
      IMAGES?: ImagesBinding
    }
  }
}
