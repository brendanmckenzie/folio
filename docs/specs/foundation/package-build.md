# Feature: Build artifacts and type declarations

> **Group:** foundation
> **Build order:** 22, per docs/specs/README.md
> **Size:** S
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-07-31

## Summary

`packages/folio` shipped TypeScript source and every consumer compiled it. That
worked because the only consumer in the repo is `examples/demo`, a workspace link.
It fails the moment somebody installs the package: a `.ts` entry point requires the
consumer to have the same TypeScript version, compatible `compilerOptions`, and a
bundler configured to transpile `node_modules` — and it hands them no `.d.ts`, so a
type error inside Folio surfaces inside *their* build. `ROADMAP.md` called it "fine
for now, wrong for a release", and `docs/completion-plan.md` gap 5 is the last
delivery gap in that list.

This builds the library to distributable JavaScript with source maps, points
`exports` at the build, and keeps two entry points as source on purpose because
they are inputs to the *host's* bundler rather than modules a host imports.

## Ground truth

**package (`packages/folio/package.json`, before):**

- Six subpath exports, every one a `.ts`/`.tsx` file under `src/`. No `.` entry —
  bare `folio` was not importable, before or after this spec, and that is
  deliberate: `CLAUDE.md`'s "Where things live" makes `folio/core` and
  `folio/engine` a documented split, not a convenience.
- No `files`, no build script, no `.d.ts` anywhere in the repo.
- `vite ^7 || ^8` is already a **peer dependency**, which is the fact decision 3
  turns on.

**entries, by who consumes them:**

- `./core` (`src/core/index.ts`), `./engine` (`src/core/engine.ts`), `./server`
  (`src/server/index.tsx`) are imported by a host's Worker. No CSS anywhere in
  their graphs — verified: `src/server` and `src/core` contain no `.css` import,
  and neither imports `../admin` or `../preview`.
- `./vite` (`src/vite/index.ts`) is imported by a host's `vite.config.ts`, which
  **Node loads**, not Vite's resolver. See decision 5.
- `./preview` (`src/preview/mount.tsx`) and `./admin-entry`
  (`src/admin/main.tsx`) are neither: `src/vite/index.ts:50-52` puts both into
  `environments.client.build.rollupOptions.input`. They are entry points of the
  host's client bundle. Between them they reach 33 stylesheets — `src/admin/ui/`
  has 31 `*.module.css` plus `tokens.css`, and `src/preview/preview.css`.
- `src/preview/mount.tsx` is generated into by the plugin: the
  `virtual:folio/preview` module emits `import { mountPreview } from
  'folio/preview'` plus an import of the *host's* blocks, so that bundle is
  per-project by construction.

**external specifiers across `src/`:** `@tiptap/*`, `fractional-indexing`, `hono`,
`valibot`, `react`, `react-dom`, `react-dom/client`, `react-dom/server.edge`,
`cloudflare:workers`, `node:module`, `node:path`, `vite`. All are `dependencies`,
`peerDependencies` or platform modules — nothing needs bundling into the artifact.
One dynamic import: `await import('cloudflare:workers')` in
`src/server/cache-purge.ts:81`, which must stay dynamic (spec 17).

**the CSS tripwire:** `src/admin/main.tsx`'s header comment. `Prototype` is a
**static** import because `/folio-admin.css` only exists while a stylesheet is
reachable from that entry's static graph; a dynamic import renames it to a hashed
chunk asset and the admin ships unstyled. Only `pnpm build` catches it — dev serves
CSS through the module graph either way. Baseline before this spec:
`examples/demo/dist/client/folio-admin.css` at 82,822 bytes.

**resolution, in the repo:** `examples/demo/tsconfig.json` and
`packages/folio/tsconfig.json` both use `moduleResolution: "bundler"`, which
supports `customConditions`. `noEmit: true` in both.

**toolchain already in the lockfile:** `vite@8.1.5` (which bundles with
`rolldown@1.1.5`, not esbuild), `typescript@7.0.2`, and **`esbuild@0.28.1`** — an
optional peer of Vite 8, fully installed with its platform binaries.

## Architecture decisions

### 1. esbuild bundles the JavaScript; `tsc --emitDeclarationOnly` writes the types

Beat **`tsc` alone**, which is the obvious choice and cannot work here: the library
uses extensionless relative specifiers throughout (`scripts/lib/ts-resolve.mjs`
exists to cope with them), `moduleResolution: "bundler"` permits them, and tsc
emits them **verbatim**. `dist/core.js` would contain `from './doc'`, which Node
cannot resolve and which makes the artifact bundler-only for no gain.

Beat **Vite library mode**, which needs no new dependency at all since `vite` is
already a devDependency here. Rejected because Vite 8's pipeline is aimed at
browsers: `build.lib` over four non-DOM entries means fighting `define`,
`import.meta` handling and rolldown's lib-mode defaults, for output that esbuild
produces in 20ms with flags that say exactly what they do.

esbuild costs one devDependency line and **zero new packages** — the lockfile grew
by three lines because `esbuild@0.28.1` was already resolved as Vite's optional
peer.

`--packages=external` is the load-bearing flag: only Folio's own source is
bundled, and every bare specifier stays an import the host resolves. Verified in
the output — `hono`, `valibot`, `react/jsx-runtime` and `cloudflare:workers` all
survive as imports. `--splitting` is the second one: without it `dist/core.js` and
`dist/server.js` would each carry their own copy of `core/`, and a host importing
both would link two. With it they share three chunks.

### 2. CSS stays source, because only the host-bundled entries import it

Beat **pre-processing the CSS modules** into a shipped `folio-admin.css` plus a
class-name map. That means the library owning a second bundler pipeline, hashed
class names baked into the package, and the Vite plugin having to `emitFile` the
stylesheet into the host's output — which moves the "`/folio-admin.css` exists and
is not a hashed chunk" failure into library code, where **no host build catches
it**. `src/admin/main.tsx` documents that failure precisely because it is invisible
until `pnpm build`.

Beat **shipping both**, which is two sources of truth for the admin's styling and
therefore a drift bug waiting for whoever edits one.

The reason source is safe is not an assumption: nothing in `core`, `engine` or
`server` imports a stylesheet, so the three entries a host *imports* have no CSS in
them at all. Every stylesheet is reachable only from `./preview` and
`./admin-entry`, and those are decision 3.

### 3. The admin bundle stays a host build step

`./preview` and `./admin-entry` keep pointing at `.tsx`, permanently, and `files`
ships `src/`.

Beat **prebuilding the admin into the package**. Four reasons, in order of weight:
the CSS tripwire above; React must be the host's single copy, which it is for free
when the entry is in the host's own module graph; `mountPreview(blocks)` takes the
*host's* components, so the preview bundle is per-project whatever we do; and
`folio/vite` already declares `vite` a peer dependency, so a project that can reach
these entries has Vite by construction. Shipping them as source is not "the host
compiles our source" in the sense `ROADMAP.md` complained about — it is the host
compiling its own bundle, which contains our entry.

### 4. No minification, source maps with content, and `src/` ships

Beat **minifying**, which would be the library deciding something that belongs to
the host: the host's build minifies its worker and its client bundles anyway, and a
minified dependency only makes its own stack traces unreadable. A Worker whose
trace points into minified library output is one nobody can debug.

`--sourcemap` keeps `sourcesContent`. Beat **`--sources-content=false`** plus the
shipped `src/`, which is tidier by about 1MB and relies on every downstream map
composer resolving a relative source path when it re-bundles `dist/server.js`.
Inline content survives that; a path may not.

### 5. Conditional `exports`: `development` for the dev loop, `default` for the build

The map gains a `development` condition pointing at source, which Vite applies in
`serve` and not in `build`, so:

- `pnpm dev` resolves `folio/core`, `folio/engine` and `folio/server` to
  TypeScript and edits to the library are live. **Verified with
  `packages/folio/dist/{core,engine,server}.js` deleted**: the dev server starts
  and `/__debug` answers 200, in the workerd environment as well as the client one.
- `pnpm build` resolves them to `dist/`, so the demo's production build exercises
  the artifact on every run rather than being a second consumer of source.

Beat **`publishConfig.exports`**, which pnpm substitutes at publish time and which
would leave the in-repo `exports` pointing at source — nothing in the repo would
ever resolve the build, so nothing would ever prove it works.

Beat **`resolve.alias` in the demo**, which would make the reference host stop being
a real consumer.

**`./vite` is the exception, and it is the one entry whose `development` condition
Node ignores.** Vite's config loader externalises bare specifiers and hands them to
Node, and Node knows no `development` condition, so `import { folio } from
'folio/vite'` in a `vite.config.ts` *always* takes `default` — the build. Verified
as a failure first: with no `dist`, `pnpm dev` died with `ERR_MODULE_NOT_FOUND` on
`folio/dist/vite.js`. That is also why `./vite` must be built JavaScript for a real
consumer at all: installed into `node_modules`, a `.ts` plugin is a module Node
cannot load.

The condition still has to be *there*, and removing it as dead config was a real
regression caught by the gates rather than by reading: **tsc honours it** through
`customConditions`, and `examples/demo/vite.config.ts` imports `folio/vite`. Without
it, `pnpm typecheck` needs `dist/types/vite/index.d.ts` on disk and fails
`TS7016: Could not find a declaration file for module 'folio/vite'` after any
`pnpm dev`, which builds `build:js` and not the types. Node takes `default`, tsc and
Vite's module graph take `development`; both readings are live.

So the demo's `dev` becomes `pnpm --filter folio build:js && vite` and its `build`
becomes `pnpm --filter folio build && vite build`. That is the one build step this
spec adds to the demo, and `dev` pays 20ms for it. The four root scripts CI runs
keep their names *and* their bodies.

Beat **`predev` / `prebuild` lifecycle scripts**, which read better and depend on
pnpm's `enable-pre-post-scripts` default. It is unset in this repo, CI has no
`packageManager` field pinning a pnpm version, and a silently-skipped prerequisite
here fails as `ERR_MODULE_NOT_FOUND` on `folio/dist/vite.js`. `&&` cannot be
defaulted away.

### 6. `folio/core`, `folio/engine` and `folio/server` keep `types` at source, together

Declaration emit for `src/server` fails, and it is not degradable:

```
src/server/story-do.ts(173,17): error TS4094: Property 'sql' of exported
  anonymous class type may not be private or protected.
src/server/space-do.ts(127,17): error TS4094: Property 'broadcast' of exported
  anonymous class type may not be private or protected.
```

`createStoryDO` and `createSpaceDO` each `return class ... extends DurableObject`
— a class expression tsc cannot name — holding thirteen `private` members between
them. tsc writes **no file at all** for either module, and `server/types.d.ts`
needs `StoryDO` for `DurableObjectNamespace<StoryDO>`. `--noCheck` does not help:
the diagnostic comes from the declaration emitter, not the checker.

The three entries move together, which is the non-obvious half. **A half-built type
surface is worse than none.** With `folio/core` resolved to `dist/types` and
`folio/server` resolved to source, this fails:

```
createFolio({ blocks: [defineBlock({ … })] })
// Type 'BlockDef<{…}>' is not assignable to type 'AnyBlockDef'
```

Both declarations of `AnyBlockDef` are textually `BlockDef<any>`, and it still
fails: TypeScript's variance fast path applies only to two references to the *same*
declaration, so across two copies `strictFunctionTypes` compares `render`'s
parameter structurally and `PropsOf<any>` stops absorbing the specific one. That is
the first call in every host's entry file. Verified both ways in an out-of-tree
consumer: it fails with the entries split and passes with them together.

`./vite` can and does point at `dist/types`, because its whole surface is
`FolioPluginOptions` and Vite's `Plugin` — it shares no type with `core`, so there
is nothing to be inconsistent with. `dist/types/core/**` is emitted anyway: it is
the artifact the move needs, and it is what proves the pipeline works today.

The fix is in those two files — a declared return type on each factory, or
`#private` members — and it is deliberately **not** in this spec's diff, because
`src/server/` was owned by two other agents while this landed.

## Acceptance criteria

### The artifact

```
GIVEN a clean `packages/folio`
WHEN `pnpm --filter folio build` runs
THEN dist/{core,engine,server,vite}.js exist with .map siblings
AND dist/types/core/index.d.ts, dist/types/core/engine.d.ts and
    dist/types/vite/index.d.ts exist
AND `node -e "import('./dist/core.js')"` resolves 101 exports
AND no bare specifier in the output was inlined
```

### The host build still styles the admin

```
GIVEN the library is built
WHEN `pnpm build` runs
THEN examples/demo/dist/client/folio-admin.css exists
AND it is over 50KB, carries a hashed shell class and a
    `prefers-color-scheme: dark` block
```

### The development loop needs no artifact

```
GIVEN packages/folio/dist/{core,engine,server}.js are deleted
WHEN `pnpm dev` runs
THEN the dev server starts and /__debug answers 200
AND `pnpm typecheck` passes with no dist directory at all
```

### An out-of-tree consumer

```
GIVEN `pnpm pack` output extracted into a project's node_modules
AND a tsconfig with moduleResolution "bundler" and no customConditions
WHEN it imports folio/core, folio/engine, folio/server and folio/vite
THEN tsc exits 0
AND `require.resolve('folio/core')` answers dist/core.js
AND `require.resolve('folio/admin-entry')` answers src/admin/main.tsx
AND bare `folio` fails with ERR_PACKAGE_PATH_NOT_EXPORTED, as designed
```

## Implementation plan

### Phase 1 — the build (done)

1. `packages/folio/package.json`: `build`, `build:js`, `build:types`, `clean`,
   `prepack`; `files`; `esbuild` devDependency; the new `exports` map.
2. `packages/folio/tsconfig.build.json`: declaration-only emit, `rootDir: src`,
   `outDir: dist/types`, `include: ["src/core", "src/vite"]`, carrying the TS4094
   explanation in place.
3. `packages/folio/src/vite/index.ts`: `adminEntry()`'s fallback was
   `path.resolve(import.meta.dirname, '../admin/main.tsx')`, which is correct from
   `src/vite/` and wrong from `dist/`. Both layouts now.
4. `examples/demo/package.json`: `dev` and `build` chain the library build ahead of
   Vite; `deploy` calls `pnpm run build` rather than `vite build`.
5. `examples/demo/tsconfig.json`: `customConditions: ["development"]`.

### Phase 2 — what closes decision 6

1. Declare a return type on `createStoryDO` and `createSpaceDO`, or make their
   `private` members `#private`.
2. `tsconfig.build.json`: `include: ["src"]`, `exclude: ["src/admin",
   "src/preview"]`.
3. `package.json`: `types` for `./core`, `./engine` and `./server` become
   `./dist/types/core/index.d.ts`, `./dist/types/core/engine.d.ts` and
   `./dist/types/server/index.d.ts`. All three in one commit.

## Edge cases

- **`dist` is stale while `src/vite/` is being edited.** `dev` rebuilds `build:js` on
  every start and Vite restarts the server when the config changes, so a plugin edit
  costs a restart — which it already did.
- **`dist` is absent when `pnpm typecheck` runs.** It resolves source through
  `customConditions`, so it passes. This is why CI needs no new step: `pnpm build`
  is the only gate that wants the artifact, and it builds it.
- **A consumer with `moduleResolution: "nodenext"`.** Not supported, and it is not
  the `.d.ts` that stops them — it is that `types` still points at `.tsx`. Phase 2
  changes the answer.
- **`.gitignore` already lists `dist`**, which matches at any depth, so
  `packages/folio/dist` was ignored before this spec existed.

## Testing requirements

No unit or workers test. The artifact is not observable from inside a vitest run
that imports source, and a test that asserts a file exists in a gitignored
directory fails on a clean checkout. What covers it instead:

- **`pnpm build`** is the real gate and CI already runs it: the demo's `prebuild`
  builds the library, the worker build consumes `dist/server.js`, and the
  `folio-admin.css` size is the assertion.
- **`pnpm pack` into a scratch consumer** covers the published shape — resolution,
  `.d.ts`, and the cross-entry identity in decision 6. A tool, not CI, for the same
  reason `scripts/cache-probe.mjs` is: it needs a tarball and a second
  `node_modules`.
- **`wrangler dev --config examples/demo/dist/ssr/wrangler.json`** runs the built
  worker under workerd. Used to verify `dist/server.js` boots and routes.

## Out of scope

- **Publishing.** `private: true` stays. A release needs a version, a licence and a
  package-level README, which are the owner's to write, and `prepack` is already
  wired for when they exist.
- **Bundling the declarations** into one `.d.ts` per entry. It would remove the
  extensionless relative specifiers from the emitted types and let a `nodenext`
  consumer in, and it costs a dependency (`rollup-plugin-dts`, `api-extractor`,
  `tsdown`). Not until decision 6's phase 2 makes the emitted types load-bearing.
- **A prebuilt admin bundle.** Decision 3, with reasons.

## Open questions

None. Decision 6's phase 2 is a known task, not an open question.
