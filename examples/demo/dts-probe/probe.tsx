/**
 * What an *installed* consumer sees — a tool, not a test.
 *
 * Everything else in this repo resolves `folio/*` through the `development`
 * condition, which points at TypeScript source (see the demo's own
 * `tsconfig.json`). So `pnpm typecheck` cannot observe the `types` condition at
 * all, and the declarations in `packages/folio/dist/types` are unreached by any
 * gate. This file is the one place they are reached.
 *
 * It exists for `foundation/package-build.md` decision 6: the `types` conditions
 * for `folio/core`, `folio/engine` and `folio/server` must move together,
 * because structurally identical declarations of a generic type are not
 * interchangeable across two copies. Point any one of them back at source and
 * the `createFolio` call below fails with
 *
 *   Type 'BlockDef<{…}>' is not assignable to type 'AnyBlockDef'
 *
 * which is the first call in every host's entry file.
 *
 * Run it with `pnpm --filter demo typecheck:dist`, after `pnpm --filter folio
 * build` — it reads `dist/types`, which is gitignored, so it cannot gate CI
 * without ordering a build in front of it. Same standing as
 * `scripts/cache-probe.mjs`.
 */
import { defineBlock, text, type Doc } from 'folio/core'
import { fromNested } from 'folio/engine'
import { createFolio, SpaceDO, StoryDO } from 'folio/server'

const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  fields: { heading: text({ label: 'Heading' }) },
  render: ({ heading }) => <h1>{heading}</h1>,
})

interface ProbeEnv {
  DB: D1Database
  STORY: DurableObjectNamespace<StoryDO>
  SPACE: DurableObjectNamespace<SpaceDO>
}

/**
 * Three entries in one call: `defineBlock` from `folio/core`, and namespaces
 * typed by `StoryDO` / `SpaceDO` from `folio/server`. Two different copies of
 * the library's types is exactly what this line stops compiling under.
 */
export const folio = createFolio<ProbeEnv>({
  blocks: [hero],
  types: [{ name: 'page', label: 'Page', kind: 'page', root: 'hero' }],
  auth: 'open',
  bindings: (env) => ({ db: env.DB, story: env.STORY, space: env.SPACE }),
})

/** `folio/engine`'s half of the same question: its `Doc` and core's must agree. */
export const doc: Doc = fromNested({ type: 'hero', fields: { heading: 'hi' } }, {})
