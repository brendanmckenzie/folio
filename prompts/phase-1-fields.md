# Kickoff prompt: Phase 1 — content model completeness

Paste into a fresh session started in `/Users/brendan.mckenzie/work/personal/folio`.

---

We're building Folio, a Cloudflare-native block CMS with a Storyblok-style visual
editor, structured as a library rather than an application. Read `README.md`,
`ROADMAP.md` and `PARITY.md` first — they explain the architecture and
why the load-bearing decisions were made.

Your job is **Phase 1 of `PARITY.md`: content model completeness.** The
field types currently in the library are POC placeholders, and nothing else can
be built on them. In the real reference project (`the reference project`)
the usage counts are: `multilink` 37, `asset` 32, `richtext` 31, `multiasset` 2.

## Scope

1. **`richtext`** — TipTap in the admin, stored as structured JSON, with a
   renderer that walks the JSON. Marks and nodes must be constrainable per field
   (e.g. a caption allows bold and links only).
2. **`asset` / `multiasset`** — upload to R2, a reusable media library, alt text,
   focal point, and image resizing.
3. **`multilink`** — a union: internal story reference, external URL, email,
   in-page anchor, or asset.
4. **`reference`** — point at another story and resolve its content at render.
   The reference project does this for a form picker (`Form Selection.form`).

Deliver them one at a time, each fully working end to end before starting the
next. Suggested order: `multilink` (smallest, exercises story references),
`asset`, then `richtext` (largest).

## Invariants you must not break

These are the decisions the whole design rests on. Read the code before changing
any of them, and raise it with me rather than working around it.

- **The admin is a prebuilt, project-agnostic bundle** that learns about a
  project's blocks by fetching `/folio/schema` at runtime. So field *config* must
  stay JSON-serializable (`packages/folio/src/core/fields.ts`), and field *editor
  UI* must live in the library's admin (`packages/folio/src/admin/Inspector.tsx`),
  never in the host project. Host-defined custom field UI is a separate, deferred
  design.

- **Published pages ship zero JavaScript.** `scripts/sync-test.mjs` asserts a
  published page contains no `<script>` tag. This means **the richtext renderer
  must not import TipTap** — it walks the JSON and emits plain React. TipTap
  belongs in the admin bundle only. This is the easiest way to accidentally
  regress the whole value proposition, so check the built output.

- **Every document change is a mutation** (`core/mutations.ts`), applied
  optimistically and synced through the story's Durable Object. A richtext editor
  emits `set` mutations like any other field. Do not add a side channel.

- **Story links must store the story id, not its path.** Paths are derived and
  are recomputed when a page is renamed or moved, so a link that captures a path
  breaks on rename. Store `{ kind: 'story', id }` and resolve id → current path
  at render time. This follows directly from the stable-id decision in
  `ROADMAP.md`.

- **`diff()` already handles nested JSON** via `deepEqual`
  (`packages/folio/src/core/diff.ts`), so richtext trees will diff and restore
  correctly without changes. Don't reinvent it; do add test coverage.

## Decisions I want you to raise, not silently pick

- **Richtext granularity.** Storing a whole richtext tree as one field value
  means concurrent edits to the same field are last-write-wins, same as
  Storyblok. Decomposing it into the blok graph would give finer-grained merging
  but is a much bigger change. Tell me which you recommend and why before
  building.

- **Asset upload path.** Proxying the upload through the Worker to an R2 binding
  is simplest and needs no credentials; presigned URLs need the S3-compatible API.
  Recommend one.

- **Image resizing.** Cloudflare Images versus `/cdn-cgi/image/`. Note that
  `/cdn-cgi/image/` needs a zone with Image Resizing enabled and does not work on
  `workers.dev`, which affects local and preview environments.

- **Reference resolution timing.** Server-side during SSR is easy, but the
  preview client re-renders in the browser and needs resolved data too. Propose
  an approach that works in both without a per-render fetch.

## How to verify

Do not report something as working until you have seen it work.

```bash
pnpm install
cd examples/demo
pnpm exec wrangler d1 execute folio --local --file=../../packages/folio/schema.sql
pnpm dev                      # serves on 5199
```

Then, from the repo root:

```bash
node scripts/sync-test.mjs       # 12 checks, the sync engine
node scripts/history-test.mjs    # 19 checks, versioning and diff
```

Both must stay green, and add coverage for what you build. Also run
`pnpm exec tsc --noEmit` and `pnpm exec vite build` in `examples/demo`.

**Check it in a browser.** Two bugs in this project were invisible to headless
tests — a missing Vite react-refresh preamble, and a store that never reconnected
under React StrictMode — because HTTP status and the WebSocket protocol both
looked fine. Open `/folio/edit`, add a block, type into a field, confirm the
preview updates per keystroke.

Gotcha: **Durable Object state outlives a D1 reseed.** If a test starts from
unexpected content, that is why; `scripts/history-test.mjs` shows the clean-slate
pattern.

## Out of scope

Multiple document types, the query/filter API, full-text search, auth, caching,
scheduled publishing, the block picker at scale, and the Storyblok importer. They
are later phases in `PARITY.md`. Flag anything you find that blocks them,
but don't build it.

## Working style

Match the existing code: comments explain *why* rather than restating the code,
and the docs favour plain prose over bullet soup. Update `README.md` and
`PARITY.md` as you land each field type. Tell me plainly when something
does not work or you had to cut scope.
