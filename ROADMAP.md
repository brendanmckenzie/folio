# Roadmap

Gaps, ordered. Informed by reading `the reference project`,
a production Storyblok + Next.js build (87 block schemas, 38 component folders).

## Done

**Stable story IDs.** Stories are keyed by an opaque `id`, which is also the
Durable Object name, so renaming or moving a page never orphans its draft or
mutation log. `path` is derived from the ancestor chain and recomputed for the
whole affected subtree on rename or move.

**Content tree.** `parent_id` + a fractional `ord`, the same ordering primitive
as blocks. Full CRUD (`GET/POST/PATCH/DELETE /folio/stories`), drag to reorder
and reparent, cascade delete, cycle rejection, slug collision handling.

**Content at `/`.** The root story has `path = ''`. No `home` special-case
anywhere, unlike the reference project which special-cases it in three places.

**Non-CMS routes.** `folio.handle()` returns `null` for anything it does not
own, *including* a preview request for a path with no story behind it, so host
routes always win. No system-path blocklist needed.

**Page metadata in the document.** `title`, `description`, `socialImage`,
`noindex` are ordinary fields on the root block, selectable in the tree as
"Page settings". They inherit sync, multiplayer, undo and versioning, and
publish atomically with content. Only routing structure lives in D1; `title` is
denormalised there purely as a cache for rendering the tree.

**Page history.** Two separate things, deliberately not conflated:

- **Versions** in D1 — coarse and meaningful. Every publish writes one; editors
  can name a checkpoint. Listable without opening a socket, and the list query
  omits the document payload.
- **Activity** from the DO log — fine-grained who-changed-what, summarised into
  phrases like "Changed Hero · Heading +2 more". Good for "who broke this",
  useless for restoring.

**Restore never overwrites the document.** `diff(live, target)` in core produces
a minimal mutation set, which is applied as one ordinary transaction. So a
restore syncs to other editors, appears in the activity trail, and Cmd+Z undoes
it. Verified: reverting a title change plus an added block yields exactly two
mutations, not a wholesale replace.

**Content model completeness.** `multilink`, `asset`, `multiasset`, `richtext` and
`reference` all work end to end. Links and references store ids and resolve at
render, so renaming a page fixes every link to it without rewriting a document.
Richtext is TipTap in the admin and a JSON walker everywhere else, so published
pages still ship nothing. See `PARITY.md` for what was deliberately left
out.

## Next

### 1. Scheduled publishing

A DO alarm per story. Small, and a real Cloudflare advantage: no cron worker, no
queue, no polling. Now unblocked: a scheduled publish writes a version like any
other.

## Uncovered from the reference project

**Cookie-based draft mode.** Preview today is iframe-only (`?_folio=preview`).
Editors also need to browse the *real* site in draft, across navigations. The
reference does this with `/api/preview` + `/api/exit-preview` setting a signed
cookie. We should do the same; it also makes share-a-preview-link work.

**Cache invalidation on publish.** The reference runs `revalidate = 60` plus a
Storyblok webhook hitting `/api/revalidate` with a shared secret. We own both
sides, so publish can purge directly — no webhook, no secret, no eventual
consistency window. Needs a cache layer first (Cache API or KV in front of D1).

**Per-story access control.** The reference has an `access_level` field on story
content and gates rendering on the user's roles. With metadata now living on the
root block, this is just another field — the gap is the auth layer beneath it.

**Editor identity is currently self-reported.** The client sends its own `name`
and `colour` in the `hello` message, which is trivially spoofable. The Worker
must validate the session *before* the WebSocket upgrade and pass the verified
user into the Durable Object. Sessions in D1 behind a signed httpOnly cookie:
OIDC against Microsoft 365 for staff, magic link for client editors. Cloudflare
Access is deliberately not the plan — it is IdP-shaped and awkward for
per-space editor roles.

**Multiple content types.** The reference has `page`, `insights`, `resources`,
each with different fields and different routing. `createFolio` currently takes
a single `root` block type. Should become a set of document types.

**Singleton / config documents.** The reference has a `config` story holding
global settings and navigation, fetched separately and cached. Folio needs
globals that are not routable pages.

**Story enumeration.** `sitemap.ts` and `generateStaticParams` both page through
every story. Folio needs a public list/query API, not just the tree.

**SEO metadata.** Mostly done: `title`, `description`, `socialImage`, `noindex`
are fields on the root block and the demo renders them into `<head>`. Still
missing schema.org / article structured data, which the reference generates.

**Scale of the block picker.** 87 block types. The current "+ Add block" menu is
an unsorted flat list, which stops working somewhere around 15.

## Known smaller issues

- No auth anywhere. Anyone reaching `/folio/edit/*` can edit and publish. Now
  the single biggest gap: validation, the error envelope and the versioned wire
  protocol were built with it in mind, and `publish()` no longer needs a
  Request, so the auth layer has clean seams to land on.
- The library ships TypeScript source; the host compiles it. Fine for now, wrong
  for a release. (The `folio/core` / `folio/engine` export split is done; build
  artifacts and `.d.ts` generation are not.)
- The DO mutation log grows without bound. Fine against the 10GB per-object
  limit, but it wants compaction eventually. The `tx_id` unique index and
  contiguous syncIds make a compaction watermark straightforward now.
- `versions` also grows without bound: every publish stores a full doc copy and
  nothing prunes checkpoints. Wants a retention policy.
- a11y in the admin: click-only tree rows, no keyboard reorder, no focus trap in
  the media library, no aria-live on toasts. Biome's a11y rules are deliberately
  off until this is done properly (see biome.json).
- `MultiAssetInput` keys cards by index, so reordering drops focus; needs stable
  local ids (noted inline where the suppression lives).

## Fixed 2026-07-29 (the hardening pass)

Everything below was a "known issue" or review finding before this date;
recorded here so the list above stays honest. Tests: 584 across unit (Node) and
workers (workerd). CI runs typecheck, Biome, both suites and the demo build.

- Publishing is atomic (version row + `published_doc` in one batch) and every
  publish retains a version.
- Deleting a story purges its Durable Object; drafts no longer resurrect.
- The sync engine converges: clients rebase pending txs over server order,
  offline edits queue and replay with txId dedupe, the watermark is contiguous,
  invalid mutations (cycles, orphans, root moves, uid collisions) are rejected
  at the door and no-ops on replay. See docs/sync-design.md.
- `diff()` emits inserts → moves → sets → removes, so version restore cannot
  destroy rescued children (property-tested).
- Every HTTP input is validated (valibot) and every failure is one envelope
  shape; wire frames are versioned, size-capped and shape-checked.
- Uploads are typed by magic bytes and size-capped before buffering; SVG and
  unknown types download instead of executing; transforms are clamped and
  cached.
- `javascript:` URLs die in `asLink`, richtext link marks and `resolveLink`.
- D1 has real migrations; `db:remote` can no longer drop tables.
