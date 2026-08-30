# Feature: Documentation that ships with the package

> **Group:** foundation
> **Build order:** 26, per docs/specs/README.md
> **Size:** M
> **Status:** done — but not as planned; see `## Implementation notes`
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-08-29

## Summary

Folio has 2,878 lines of documentation and a consumer receives none of it. The
subtree split carried `packages/folio` and nothing else, so
`brendanmckenzie/folio` — the repository the two private sites actually install
from — had seven entries at its root, no README, no licence and no prose of any
kind. Everything a host developer needs was in this workspace, which is not the
artifact they get.

That is the distribution half. The other half is that what exists is
**descriptive**: `README.md` is organised by feature and explains what each thing
is and why it is shaped that way. Nothing states how to build a host, in what
order, or what a newcomer will get wrong — and we know what they get wrong,
because the one real integration outside the demo found four traps, none of
which was written down anywhere a consumer or their coding agent could read.

**The answer turned out to be structural rather than editorial.** The package
moved to the repository root and the split was deleted, so the README a
consumer receives is simply the README, with no copy, no move and no second
artifact to keep in step. See `## Implementation notes`.

## Ground truth

Verified against the tree at `cdcfec2`.

**the package (`packages/folio/`):**
- **There is no `README.md` and no `LICENSE`.** `find packages/folio -maxdepth 2
  -iname "*.md"` returns nothing. The root of the split branch
  (`git ls-tree --name-only folio-package-only`) is exactly `migrations`,
  `package.json`, `src`, `test`, `tsconfig.build.json`, `tsconfig.json`,
  `vitest.config.ts`.
- `package.json` is `"private": true` at `"version": "0.0.0"`, with
  `"files": ["dist", "src", "migrations"]`. `files` governs an npm publish, not a
  git install — a git consumer gets the whole repository — so the absence of a
  README is the split's doing, not `files`'.
- **Seven export subpaths.** Four (`./core`, `./engine`, `./server`, `./vite`)
  carry a `development` / `types` / `default` triple into `dist/`. Three
  (`./render`, `./preview`, `./admin-entry`) are bare strings pointing at
  **source** `.tsx`, with no types entry — `./render` is the one a framework host
  reaches for, added because `FolioDoc` was previously only reachable through
  `folio/server`.

**the workspace docs:**
- `README.md` is **2,174 lines** across 25 sections. It is a usage guide, not
  only a reference: "The integration surface" walks define-blocks → mount → render
  with working code. Its own "Not built yet" section already names this gap —
  what remains is "`private: true`, a version, a licence and a package-level
  README".
- `docs/api.md` (470 lines) is the `v1` contract; `docs/mcp.md` (234 lines) is how
  to point an assistant at a site. Both are consumer-facing and both are dropped
  by the split.
- **The README mixes two audiences.** "What it borrows", "Verified" (which cites
  `scripts/sync-test.mjs`, dropped by the split) and "Not built yet" are project
  status. The other 22 sections are product documentation.

**the host surface (`packages/folio/src/server/index.tsx`):**
- `handle` is defined at `:225` and returned at `:350`. It **returns `null` for
  anything Folio does not own**, which is the entire reason a host's own routes
  win at any path.
- The miss-branch calls a host makes itself: `published` `:358`, `status` `:362`,
  `storyAt` `:363`, `redirect` `:367`, `draft` `:368`, `resolve` `:411`,
  `render` `:450`.
- **A block's `render` receives no `Resolution`** (`core/block.ts:38`:
  `render?: (props: PropsOf<F> & { uid: string }) => ReactNode`), so it cannot
  `resolveAsset` a *referenced* document's asset field. Works only while such
  assets use the `url` arm. Found by the first real host, fixed nowhere, recorded
  in no document in this repository.

**the demo (`examples/demo/src/index.tsx`):**
- `folio.handle()` at `:241`, then `folio.published()` at `:253`, `folio.redirect()`
  at `:258` and `folio.status()` at `:267` in the miss branch, `folio.resolve()` at
  `:287`, `renderGlobal`/`render` at `:414`–`:417`.
- **The demo renders its page inline in the same `fetch` as `handle()`**, because
  it is a bare Worker with no router to hand off to. This is the shape a reader
  copies, and it is the one that does not generalise.

**the Vite plugin (`packages/folio/src/vite/index.ts`):**
- `react-dom/server.edge` is CommonJS and is force-included in `optimizeDeps`
  (`:78`–`:79`), with the reason in a comment at `:55`. Left external it stops the
  Worker at startup.
- `cssBundledIntoOne` reads the host's own `userConfig` (`:258`–`:259`) and
  `configResolved` throws at `:284`–`:288` when the client build resolved to
  `cssCodeSplit: false` without the host setting it — because by then the asset
  paths are baked and refusing to ship is all that is left.
- `foldClientEntries(resolved)` at `:209`, for a framework plugin contributing an
  array of client entries.

**the release gate (`scripts/release.mjs`):**
- `smokeTest(sha)` at `:121` **installs the split the way a consumer does**
  (`git+file://${repoRoot}#${sha}`, `:130`) and walks the `exports` map asserting
  every subpath resolves (`:140`–`:160`). It is the only check that runs against
  what a consumer receives, and therefore the only place a docs check can live
  and mean anything.

## Owner decision checkpoints

1. **The product documentation moves rather than being copied.**
   `packages/folio/README.md` becomes the one copy; the root `README.md` shrinks
   to a project readme (what Folio is, how to work on the workspace, where the
   product docs now live). Recommended, because two copies of 2,174 lines drift
   within one release and the drift is invisible from either side. The cost is
   that this repository's front page stops being the thing you read to learn
   Folio, and `CLAUDE.md`'s "where things live" gains a redirect.

2. **How the agent-facing guidance actually reaches an agent.** `AGENTS.md`
   inside `node_modules/folio` is not read by a coding agent working in a
   consumer repository — it reads the *consumer's* root instructions. So the file
   is necessary and not sufficient. Three ways to close it, and this is the one
   real product decision in the spec:
   - **A documented paste block** the consumer copies into their own
     `AGENTS.md` / `CLAUDE.md`. Zero machinery, goes stale silently.
   - **`npx folio init`**, which writes that block into the consumer's
     instructions file and can rewrite it on upgrade. Real machinery, and Folio
     ships no bin today.
   - **An MCP resource.** `{base}/mcp` already exists and is already how an
     assistant reaches a site; serving the integration guide as a resource means
     an agent can fetch current guidance rather than a pinned copy. But it
     requires a *running* Folio, and the moment this guidance matters most is
     before the host boots.

   Recommended: the paste block now, `npx folio init` named as the follow-up, MCP
   rejected for the bootstrap reason above. **Resolved 2026-08-30: the paste
   block**, carried in `AGENTS.md` under "Point your own agent at this file" and
   delimited by `<!-- folio:begin -->` / `<!-- folio:end -->` so an upgrade can
   replace it wholesale without disturbing what surrounds it. The markers are the
   whole of what `npx folio init` would need later; shipping them now costs
   nothing and means the follow-up is not a migration.

3. **A licence.** The package has none, which makes "two private sites pin a SHA"
   a question nobody has asked out loud yet. Out of scope for this spec's
   engineering but it is the same commit, and the answer wants to be the owner's.
   **Resolved 2026-08-30: MIT**, owner's call, on the reasoning that the repository
   is public, the consumers are client sites built by the owner's own agency, and a
   permissive licence is the one that puts no friction on that. Copyleft would
   have to be arguing against something, and there is nothing here it is arguing
   against.

## User stories

### A developer starts a host and does not read this repository
**As** a developer given `github:brendanmckenzie/folio#<sha>` **I want to** find a
README at the root of what I installed **so that** I can mount the library
without being handed a second repository and told which 2,174 lines matter.

### A coding agent builds a host
**As** an agent asked to add Folio to a project **I want to** be told the one
correct integration shape and the errors that mean I got it wrong **so that** I do
not invent an arrangement that typechecks, builds, and dies at startup.

### A maintainer changes the host surface
**As** whoever changes `folio.handle()`'s contract **I want to** the docs to live
beside the code they describe **so that** the change and its documentation are one
commit rather than two repositories.

## Architecture decisions

### 1. The package moves to the repository root, and the split is deleted

The whole problem is that the package lived in `packages/folio/` and npm cannot
install from a subdirectory of a git dependency. Every consequence followed from
that one fact: the second repository, the unrelated history, the determinism
rule, the release incantation, and a package that shipped no prose because the
prose lived above the split prefix.

So `package.json` moves to the root, beside `src/`, `test/` and `migrations/`.
`github:brendanmckenzie/folio#<sha>` then finds it where npm expects it, `git
push` becomes the whole of publishing, and the README a consumer gets is the
README — npm includes it automatically. `docs/`, `examples/` and `scripts/`
remain siblings that `files` does not ship.

Rejected: **moving the docs inside the split prefix**, which was this spec's
original decision 1. It solves the symptom — a package with no README — while
leaving the mechanism that caused it, and it makes the workspace's own front page
a stub pointing at a subdirectory. Rejected: **a documentation site**, a second
artifact to build, deploy and version, and not where either a developer with
`node_modules` open or an agent reading a dependency looks. Rejected: **publishing
to npm**, which would also retire the split, on the owner's instruction that
installing from GitHub stays the primary flow.

The cost, and it is the real one: `docs/`, `ROADMAP.md`, `CLAUDE.md` and
`docs/feedback.md` become publicly visible, because the repository consumers
install from is now the repository the work happens in. Confirmed by the owner
before the move.

### 2. One sanctioned integration shape, stated as *the* shape

The host owns its Worker and its routing. Folio goes first as a miss-through, and
published pages stay the **host's own routes** whose loader calls
`folio.published()`:

```tsx
// 1. Folio's own surfaces (admin, api, mcp, preview). null for everything else.
const handled = await folio.handle(req, env, ctx)
if (handled) return handled

// 2. …then your router, unchanged. A published page is YOUR route.
```

and inside that route:

```tsx
const doc = await folio.published(env, path, locale)
if (!doc) {
  const hit = await folio.redirect(env, path)      // a rename
  if (hit) return Response.redirect(hit.to, hit.status)
  return new Response(null, { status: await folio.status(env, path) })
}
const resolution = await folio.resolve(env, doc, { locale })
return renderInYourLayout(folio.render(doc, { resolution }))
```

This is the shape the first real host chose and the one to repeat: Folio supplies
content and blocks, the framework keeps its layout, its `meta` exports and its SEO
helpers. It works because `Resolution` is plain JSON — the rich objects
(`asset.srcFor`, a reference's `content`) are built from it at render time, so
nothing about it needs to survive a loader boundary.

Rejected: **documenting the alternatives.** A library with one real consumer
outside its own demo has not earned a menu, and ambiguity is precisely what makes
an agent improvise. The arrangements that lose are named as anti-patterns with
their symptoms rather than as options with trade-offs.

### 3. The demo is labelled as the degenerate case, not the template

`examples/demo/src/index.tsx` calls `folio.handle()` and then renders its page
**inline in the same `fetch`**, because a bare Worker has nowhere to hand off to.
A reader copying that into a React Router or Hono host puts the page render inside
the Worker entry and then discovers their framework's layout, meta and error
boundaries are all bypassed — with no error, because it works.

So the docs teach decision 2's shape, and the demo carries a header saying which
part of itself not to copy. Rejected: **rewriting the demo onto a framework.** It
exists to exercise the library against `vite dev` and the production build with as
little between the two as possible, and putting a router in it buys the
documentation something the documentation can just say.

### 4. Anti-patterns are documented by symptom

An agent meets these as an error message, never as a principle, so the file is
indexed on what you see:

| What you see | What it is |
| --- | --- |
| `ReferenceError: require is not defined` at Worker startup, stack naming nothing you wrote | `react-dom/server.edge` is CJS and was left external. The plugin force-includes it (`vite/index.ts:78`); a host that overrode `optimizeDeps` dropped it. |
| Admin renders unstyled, stylesheet 404s behind a 200 | `build.cssCodeSplit: false` set by a *plugin* rather than in `vite.config.ts`, so `config()` could not see it. `configResolved` throws for this and names it. |
| A referenced document's asset field is empty | A block's `render` gets no `Resolution` (`core/block.ts:38`). Only the `url` arm works today. Known, unfixed. |
| Typecheck sees two `Plugin` types | Folio installed by directory path (symlink), resolving `vite` from its own workspace. Use a tarball or a git SHA. |
| A path Folio should own 404s | Your router ran first. `handle()` must precede it; it returns `null` and never intercepts. |
| A page taken down reads as 404 | `folio.status()` exists to tell "unpublished on purpose" from "never existed" and was not called. |

Rejected: **a prose section per trap.** Four of the six are indistinguishable from
a library bug at the moment you hit them, and prose organised by cause is
unsearchable by someone holding an effect.

### 5. Two files, because they have two readers

`README.md` is narrative and for a person: what Folio is, the integration surface,
then the feature sections. `AGENTS.md` is imperative and for a machine: the
sanctioned shape as steps, the symptom table, the invariants stated as rules, and
an explicit "do not" list.

Rejected: **one file.** The merged document is worse for both — a person reading
imperative rules about errors they have not hit, an agent parsing narrative for
the two paragraphs that constrain it. The duplication is small and is mostly the
code block in decision 2, which is short enough to keep in step by eye.

### 6. The release gate refuses a package with no docs

`smokeTest` already installs the split as a consumer and walks the `exports` map
(`release.mjs:140`). It gains an assertion that `README.md` and `AGENTS.md` exist
in the installed package. Without it this decays the first time a file moves, and
it decays in the one direction nobody in this workspace can see — every gate we
run reads the workspace, and nobody installs the workspace.

Rejected: **a unit test asserting the files exist on disk.** It passes in the
workspace whatever the split does, which is the failure mode being guarded
against.

## Wire & schema changes

None. No migration, no `PROTOCOL_VERSION` bump, no route added or changed.

### Package changes

- `packages/folio/package.json`: `files` gains `"docs"`, `"README.md"`,
  `"AGENTS.md"`. `private` and `version` are checkpoint 3's business, not this
  spec's.
- New: `packages/folio/README.md`, `packages/folio/AGENTS.md`,
  `packages/folio/docs/api.md`, `packages/folio/docs/mcp.md`.
- Root `README.md` shrinks to a project readme; `docs/api.md` and `docs/mcp.md`
  are deleted from the workspace root (moved, not copied).

## Acceptance criteria

### A consumer receives documentation

```
GIVEN a clean directory
WHEN `npm install git+file://<repo>#<split sha>` runs
THEN node_modules/folio/README.md exists and describes the integration surface
AND node_modules/folio/AGENTS.md exists
AND node_modules/folio/docs/api.md exists
```

### The gate cannot be passed without them

```
GIVEN packages/folio/README.md has been deleted
WHEN `node scripts/release.mjs` runs
THEN it fails at the smoke test, naming the missing file
AND it does not print a push command
```

### The public repository has a front page

```
GIVEN the split has been re-run and pushed
WHEN github.com/brendanmckenzie/folio is opened
THEN a rendered README describes what the package is and how to mount it
```

### One copy, not two

```
GIVEN the product documentation now lives in packages/folio/README.md
WHEN the workspace root README.md is read
THEN it describes the project and points at the package for product docs
AND it does not restate the integration surface
```

## Implementation plan

### Phase 1 — Move the product docs into the package

1. `git mv README.md packages/folio/README.md`, then cut the three
   project-status sections ("What it borrows", "Verified", "Not built yet") back
   out into a new root `README.md`. Verified cites `scripts/`, which the split
   drops, so it cannot stay in the package on accuracy grounds alone.
2. `git mv docs/api.md docs/mcp.md packages/folio/docs/`. Fix the relative links
   in both — `api.md`'s header points at `README.md`'s "Content API" section and
   at `docs/specs/platform/content-api.md`, and the second of those is now outside
   the package and must become prose rather than a dangling link.
3. Root `README.md`: what Folio is, the borrowing table, project status, and a
   pointer to `packages/folio/README.md`.
4. `packages/folio/package.json`: extend `files`.
5. `CLAUDE.md`: "Where things live" gains the redirect, and the release section
   notes that the package's docs are the ones a consumer sees.

Leaves the tree green: no source changes, no test changes.

### Phase 2 — `AGENTS.md`

1. The sanctioned shape from decision 2, as numbered steps with the two code
   blocks.
2. The symptom table from decision 4.
3. The host-facing invariants, stated as rules: `handle()` first and it returns
   `null`; `redirect()`/`status()` belong in your own miss branch; read fields
   with `fieldValue`/`dataOf` and never `blok.data[name]`; `folio/core` is the
   contract for defining blocks, `folio/engine` bypasses sync and undo and is for
   bulk imports only.
4. A "do not" list, each entry with the reason: do not render pages inside the
   Worker entry when you have a router; do not install by directory path; do not
   override `optimizeDeps` without re-including `react-dom/server.edge`; do not
   call `apply()` outside a transaction on live content.

### Phase 3 — Distribution (gated on checkpoint 2)

1. The paste block, in `AGENTS.md` and in the README's integration section.
2. If `npx folio init` is chosen: a `bin`, and the block written into the
   consumer's instructions file with delimiters that let an upgrade rewrite it.

### Phase 4 — The gate

1. `smokeTest` asserts the three files exist in the installed package, in the
   same walk that checks the exports map.
2. Re-split, and confirm the public root gains its README.

### Phase 5 — Demo header

1. A header comment in `examples/demo/src/index.tsx` saying which part of it is
   the degenerate case and pointing at the sanctioned shape.

## Edge cases

- **A consumer pinned to an older SHA** → gets no docs, exactly as today, and
  nothing breaks. Documentation is additive and this is greenfield; there is no
  migration story to write.
- **The split is re-run over unchanged history** → deterministic, so the published
  SHAs are reproduced and no pin is orphaned. Adding files to
  `packages/folio` changes future SHAs only.
- **A relative link in the moved docs pointing outside the package**
  (`docs/specs/…`, `scripts/…`, `examples/…`) → resolves in the workspace and
  404s on GitHub for a consumer. Every such link must become prose or be dropped;
  this is the phase 1 chore that is easy to declare done while wrong.
- **A framework host that cannot run code before its router** → decision 2's shape
  does not apply, and the honest answer is that Folio does not support it today
  rather than a second documented arrangement. Named in `AGENTS.md` as a
  limitation.
- **The README's own "Not built yet" claims** → three of them are stale the moment
  this lands (the package-level README is the thing being built). Restating that
  section is part of phase 1, not a follow-up.

## Testing requirements

**Unit (`packages/folio/test/unit/`):**
- None that is worth writing. A test asserting a Markdown file exists on disk in
  the workspace passes regardless of what the split publishes, which is the exact
  failure this guards against — see decision 6.

**Workers:** none. Nothing about this reaches workerd.

**End to end (`scripts/`):**
- `release.mjs`'s `smokeTest` gains the assertion, and it is exercised the way it
  already is: by running `node scripts/release.mjs` without `--push`.
- Verify by deletion once, by hand: remove `packages/folio/README.md`, run the
  script, confirm it fails at the smoke test and prints no push command.

**By inspection:**
- Every relative link in the two moved files, resolved from
  `packages/folio/` rather than from the workspace root.

## Dependencies

- None on other specs. Nothing here touches a list route, the wire, or the
  schema, so it does not queue behind 23 or 25 and does not conflict with either.
- Checkpoint 2 gates phase 3 only; phases 1, 2, 4 and 5 can land without it.

## Out of scope

- **A licence, a version and `private: false`.** Named in checkpoint 3 because
  they are the same commit's neighbours, but they are the owner's call and not an
  engineering task.
- **Fixing the traps the docs describe.** `render` getting no `Resolution` is a
  real defect and documenting it is not fixing it; it stays on `ROADMAP.md` — where
  this spec puts it, since it is currently in neither.
- **A documentation site**, rejected in decision 1.
- **Per-framework guides.** One sanctioned shape, and React Router 7 is the only
  framework anybody has actually run it against.
- **Reworking `docs/specs/`.** Internal, correctly dropped by the split, and the
  audience is whoever works on Folio rather than whoever uses it.

## Open questions

- Checkpoint 2's distribution mechanism is the only one, and it blocks phase 3
  alone.

## Implementation notes

Landed 2026-08-29, in one commit, and **the plan above is the second answer to
the question rather than the one that shipped**. The spec was written assuming
the split was a fixed constraint and that the fix was editorial: move the prose
inside the split prefix so it rides along. The owner's response to reading it was
that the split itself was the confusing thing, and that installing from GitHub —
not publishing to npm — is the flow to preserve. That reframing made a structural
answer available which is strictly simpler than the editorial one, and decision 1
above was rewritten in place to record it.

What actually landed:

- **`packages/folio/*` moved to the repository root.** `src/`, `test/`,
  `migrations/`, both `tsconfig`s and `vitest.config.ts`. The two `package.json`s
  merged: the library's fields plus the workspace scripts. `pnpm-workspace.yaml`
  gained `.` so `examples/demo`'s `"folio": "workspace:*"` still resolves.
- **`scripts/release.mjs` lost the split** and kept everything that was never
  about it: the three gates by exit code, the consumer-shaped smoke test (now
  `git+file:` against this repo directly), the non-fast-forward refusal. It gained
  a `--force` documented for exactly one act, the cutover from the old history.
- **The smoke test now also asserts `README.md` and `AGENTS.md` are in the
  installed package**, which is decision 6 and the only place such a check means
  anything.
- **`AGENTS.md` is new** and is decision 2's sanctioned shape, decision 4's
  symptom table, the rules and the do-not list.
- **`package.json` `files`** gained `README.md`, `AGENTS.md`, `docs/api.md` and
  `docs/mcp.md`.

A fourth trap, found the moment the two consumers were re-pinned and worth more
than the three below because it breaks a working install: **npm skips a git
dependency's `prepare` when `node_modules/<pkg>` already exists**, so bumping a
pinned SHA in place leaves the package with no `dist/` and no error. It is what
had left one of the two consumers stale for weeks. A clean install has never
reproduced it, which is exactly why it survives unnoticed. Recorded in
`AGENTS.md`'s symptom table and beside the install instruction.

Three findings worth keeping:

- **Phase 1's link chore was much larger than "fix the relative links", and the
  links were already broken.** 170 relative `docs/*.md` references live in source
  comments; **168 of them did not resolve** before the move, at three
  inconsistent depths. They were decorative and had never worked. The move made
  the correct depth computable per file, so all 170 resolve now — a repair the
  spec did not anticipate because it assumed they were correct and at risk.
- **`files` is respected on a git install**, verified against a real consumer's
  `node_modules/folio`: `test/` and `vitest.config.ts` are absent from it despite
  being in the published repo. This is what makes one repo safe — the workspace's
  own material is visible on GitHub but never reaches a consumer's tree.
- **The `api/migrations/**` paths in three workers tests were already wrong**
  before the move and were corrected on the way past. Nothing referenced that
  directory.

**Phase 3 landed 2026-08-30**, a day after the rest, once the owner answered both
open checkpoints: the paste block for distribution and MIT for the licence. Both
are recorded against their checkpoints above. `LICENSE` is at the root and
`package.json` carries `"license": "MIT"`; npm includes a licence file in the pack
regardless of `files`, the same as a README.

`npx folio init` remains unbuilt and is now cheaper than it was: the paste block
ships with the markers it would rewrite, so the follow-up is a `bin` that
substitutes between two delimiters rather than a format migration.

One consequence to watch: the first push after this is **not a fast-forward** of
the old split history and never can be, because the two histories are unrelated by
construction. It orphans the SHA both consumers pin, so both need re-pinning in
the same sitting. That is the one-time cost of the move and it does not recur.
