import type { SpaceDO, StoryDO } from 'folio/server'

/**
 * The bindings declared in wrangler.jsonc.
 *
 * Hand-written so this project starts small. Once you have more bindings than
 * this, run `npm run cf-typegen` — `wrangler types` generates the real thing
 * into `worker-configuration.d.ts` from wrangler.jsonc, which is one fewer
 * place to keep in step. Delete this file when you do.
 */
declare global {
  interface Env {
    DB: D1Database
    STORY: DurableObjectNamespace<StoryDO>
    SPACE: DurableObjectNamespace<SpaceDO>
    MEDIA: R2Bucket
    IMAGES: ImagesBinding
    ASSETS: Fetcher
  }
}

export {}
