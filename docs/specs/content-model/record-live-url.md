# Feature: A record's live URL and "Open preview"

> **Group:** content model
> **Build order:** 47
> **Size:** S
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-11-24

## Summary

A record has no Folio path, so `story.url` is null and the editor's "View live"
(`EditorShell.tsx`, `story.url && !layout.form`) never shows for one, even when the host
publicly routes it (`/posts/<year>/<slug>`). This adds `liveUrls` to the server config, a
server-evaluated function of the published fields, and an "Open preview" control that opens
the record's draft preview in a tab.

## Ground truth

**core:** `defineRecord` is `defineBlock` (`core/block.ts`). `toSchemaIndex` copies named fields
only, so a function on a `BlockDef` never reaches the manifest or the registry digest.
`Manifest.types` is serialised as-is, which is why a function cannot ride on `DocumentType`.

**server:** `urlsFor` (`runtime.ts`) returns an unrouted story untouched, so a record has no
`url`, `previewUrl` or `draftUrl`. `url` is what the sitemap, cache purge, query items and link
checks read as "this is a page". The session cookie is `SameSite=Lax`; on a deployment with
`sites` the pane is a preview origin reached through `site/start`.

**admin:** `editor.src` is the pane's source (`paneSource`): `/?_folio=preview&record=<id>`
for a `previewRoot` record, the host page's preview URL plus `&record=<id>` for a `previewPath`
one, and the `site/start` URL on a multi-site deployment. `Open preview in a new tab` already
exists for a blocked cookie and uses it.

## Architecture decisions

### 1. `liveUrls` is `createFolio` config keyed by record type name, and runs on the server

`createFolio({ liveUrls: { post: fn } })`, per brand with `brands`, validated at construction
like `panels` (an unknown or non-record type name throws). A function cannot be in the
manifest, so the manifest names the types that have one (`Manifest.liveUrlTypes`) and the
editor asks `GET {base}/api/story/:id/live-url`. Rejected: a `liveUrl` on the `defineRecord`
block, because the generated preview entry imports the host's blocks module, so the function and
whatever it closes over would be bundled into the public `folio-preview.js` (a test bundles the
preview entry and asserts the live-url code is absent). Rejected: evaluating in the admin.

### 2. The answer is its own route, never `StoryMeta.url`

Rejected: setting `url` on a record. Every consumer that reads `url` as "this is a page" (the
sitemap, cache purge, query items, link checks, `isRoutable`-style tests) would start treating
a record as one, which is the tree `kind: 'record'` exists to avoid. Nothing about `StoryMeta`
changes, and the route answers `{ url: string | null }`.

### 3. It reads the published document and the live state

`publishedDocsByIds` over the request's chain, and only when `isLive(story.state)`. An edited
slug in the draft cannot produce a link, and a never-published or unpublished record has none.
The editor asks again when `publishedAt`, `unpublishedAt` or `publishedSyncId` moves.

### 4. "Open preview" is the pane's own request, opened top level

It links `editor.src` and adds no credential. The preview branch (`previewBranch`) still
requires the editor's session for `?record=`, refuses a share cookie and a `draft` request for
it, and hands everything else back to the host's public page, so a signed-out tab sees the
published site and nothing leaks. `Lax` sends the session on a top-level GET. No share link is
minted, which the handbook's security model forbids for a record. Rejected: a signed URL or
token in the link, which is the share link the model rules out. `mountPreview` skips the
click/hover bridge when `window.parent === window`, so links in a global block work in that tab
(it is a snapshot, not live-updating).

### 5. An answer is a plain same-site path or nothing

`safeLiveUrl` requires a string beginning with a single `/`, with no backslash, whitespace or
control character, no empty, `.` or `..` segment (also percent-encoded) and no encoded `/`, `\` or tab, that resolves to the same origin. A throw, a non-string, `javascript:`, an
absolute or protocol-relative URL are all no link. The path is returned as written.

### 6. No link on a deployment with `sites`

A record there belongs to a scope on one of several domains, and the function is not told which.
The conservative answer is none, rather than a path that may be right on one site and wrong on
another. "Open preview" still works there, through `site/start` as the pane does.

## Wire & schema changes

`Manifest.liveUrlTypes?: string[]`, present only when `liveUrls` has an entry.
`GET {base}/api/story/:id/live-url`, `READ`, `{ url: string | null }`, `no-store`; 404 for a story
outside the chain. No migration, no `PROTOCOL_VERSION` change.

## Acceptance criteria

```
GIVEN a published record whose liveUrl answers a path
WHEN the editor opens it, in form mode or with a preview pane
THEN "View live" points at the path built from the published fields
AND an unsaved or unpublished slug edit does not change it
```

```
GIVEN a never-published or unpublished record, a throwing function or an unsafe answer
THEN there is no "View live" and the editor and the API are unaffected
```

```
GIVEN a record with previewRoot, or a previewPath page that exists
THEN "Open preview" opens its draft preview in a new tab, published or not
```

## Edge cases

- **Locales** → the function is given the source locale's data and the host decorates its own
  path; Folio's `route` is not applied, because a record has no Folio path.
- **A record type without a `liveUrls` entry** → no request is made, and the manifest is unchanged.
- **A `changed` record** → still live, so the link shows, built from what is published.

## Testing requirements

**Unit:** `test/unit/server/live-url.test.ts` (safe-path rules, liveUrlFor gating, throw
handling, manifest). **Workers:** `test/workers/record-live-url.test.ts` (the route, drafts,
unpublished, unsafe answers, `story.url` still absent).

## Out of scope

- A per-record Folio path, and a share link for a record (both rejected above).
- Multi-site live URLs, until the function can be told the site.
