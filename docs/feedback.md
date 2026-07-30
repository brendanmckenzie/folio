# Feedback / wants

Raw notes, kept verbatim, with where each one ended up. The specs are in
`docs/specs/` — see `docs/specs/README.md` for the build order and the dependency
graph.

| Note | Spec | Reading taken |
| --- | --- | --- |
| i18n | [content-model/localisation.md](specs/content-model/localisation.md) | **Field-level locales**: one document per story, translatable values per locale on the blok, structure shared. Chosen over a story-per-locale model because a translation becomes a `set` with a locale on it and inherits multiplayer, undo, versioning and preview with no new machinery. Trade: a translator cannot restructure a page. Translated slugs are deferred. |
| save without publish (drafts) - phase5? | [editing/unpublished-changes.md](specs/editing/unpublished-changes.md) | Saving without publishing already works — every keystroke lands in the draft and publish is a separate snapshot. What is missing is **seeing and undoing it**: an unpublished-changes count, a read-only comparison against what is live, discard-back-to-published, and a tree-wide marker. Parallel named drafts (branches) are named as out of scope. Not phase 5: it is first, because the diff, the read-only preview and the restore path all already exist pointed at versions. |
| model migrations | [foundation/schema-migrations.md](specs/foundation/schema-migrations.md) | A migration is a pure `(doc) => Mutation[]`, so the same function migrates a live draft through the log, a published snapshot in place, and a version document on read. Found on the way: the mutation vocabulary cannot express a block type change at all, so `retype` is added. |
| collections | [content-model/collections.md](specs/content-model/collections.md) | A collection is a query, not a folder: a publish-time index of selected root fields, a filter/sort/paginate engine, and a `collection` field a block declares and an editor narrows. Also fixes `resolve()` loading every story in the site on every render. |
| global "variables" - i.e., for headers/footers. | [content-model/globals.md](specs/content-model/globals.md) | Read as **shared content**, not string interpolation: a global is a singleton document with drafts, versions and multiplayer, loaded into every render's resolution and placed by the host's own shell. `{{ settings.phone }}`-style templating is explicitly out of scope, with reasons. |
| data objects (i.e., non-visual content) | [content-model/data-documents.md](specs/content-model/data-documents.md) | Record types with an optional renderer, edited as a table and a form rather than a tree and a preview, plus a `references()` field for hand-picked ordered lists and a usage count before deletion. |
| programmable data access (read/write) | [platform/content-api.md](specs/platform/content-api.md) | A versioned `/folio/api/v1` surface. The load-bearing decision: **writes go through the mutation log**, so a script's edit appears live in open editors, lands in the activity trail, and is undoable. Gives the Storyblok importer its two missing functions. |
| proper multiplayer: can see what others are working on, live updates from their content changes | [editing/live-collaboration.md](specs/editing/live-collaboration.md) | A space-level Durable Object carrying presence across stories plus structural events, so a peer's rename fixes the links in your open preview live. Adds field-level presence, an overwrite notice, and the fix for richtext stealing your caret when someone else edits the same field. |

## Added because the list needed them

| Spec | Why |
| --- | --- |
| [foundation/document-types.md](specs/foundation/document-types.md) | Collections, globals and data objects are all "a document that is not a page", and `createFolio` takes exactly one root block type. Three of the wants above are unspecifiable without it. |
| [foundation/identity-and-access.md](specs/foundation/identity-and-access.md) | Programmable access needs tokens and scopes; proper multiplayer needs an identity that is not self-reported. Two of the wants above are blocked on it, and `ROADMAP.md` already calls it the biggest standing gap. |

## From the competitor scan, 2026-07-29

Looked at Payload, Strapi, Contentful, EmDash, Storyblok and Sanity for cheap wins.
"Cheap" here means the mutation log, schema-as-code or one-DO-per-document already does
the work — these are the six that passed that test, and none of them is blocked on
anything above.

| Spec | Who has it | Why it is cheap here |
| --- | --- | --- |
| [editing/unpublish.md](specs/editing/unpublish.md) | all six treat publish/unpublish as a pair | `publishedDoc` returns null when the column is null, so nulling it *is* the liveness switch. Today the only way to take a page down is to delete it, which drops the subtree, the versions and the Durable Object. |
| [platform/redirects.md](specs/platform/redirects.md) | only Payload, via a plugin; the rest punt to the app | `updateStory` already computes every old path and its replacement, in one batch, at the moment it is true. Nobody else in the comparison is structurally placed to do this well. |
| [editing/conditional-fields.md](specs/editing/conditional-fields.md) | Payload `admin.condition`, Sanity `hidden`, Strapi v5 | One filter in `Inspector.tsx` and a pure predicate. Forced design detail: the manifest is JSON served to a prebuilt admin, so a condition must be data, never a function. |
| [editing/field-defaults-and-presets.md](specs/editing/field-defaults-and-presets.md) | Payload `defaultValue`, Sanity `initialValue`, Storyblok presets | `blankBlok` is the only place a block is ever created. One mechanism covers field defaults, named block variants, and a document's starting content — the last for free, since a document's root block can have a preset. |
| [editing/duplicate-and-paste.md](specs/editing/duplicate-and-paste.md) | all six duplicate documents; Storyblok pastes blocks across stories | A duplicate is `insert` mutations with fresh uids, so it syncs, undoes in one step and lands in the activity trail. A duplicated document seeds a new Durable Object with a clone, needing no new entry point. |
| [platform/publish-hooks.md](specs/platform/publish-hooks.md) | Payload hooks; the rest use webhooks | Folio needs no webhooks at all: the host's Worker and Folio are the same process, so a hook is a typed function call with no secret, no retries and no delivery log. Unblocks cache purging, search indexing and notifications. |

### Named but not cheap

- **Host-defined field components.** `README.md` already lists this as not built, and
  the prebuilt schema-driven admin is what makes it structurally hard rather than
  fiddly. [EmDash's answer is sandboxed plugin isolates on Dynamic
  Workers](https://blog.cloudflare.com/emdash-wordpress/), which is probably a non-goal
  here: Folio is a library, the host owns the Worker, and there is no third-party
  plugin ecosystem to defend against. The cheap 80% is a `widget` hint selecting among
  built-in inputs.
- **Releases / environments** (Contentful, Storyblok). "Publish these nine pages
  together" is the same machinery as the parallel drafts left out of scope in
  `unpublished-changes.md`.
- **Archive / soft delete** (Contentful). Cheap column; "filter it everywhere" is the
  real cost.
- **Media library search, tags and usage counts** (Strapi, Storyblok, Contentful).
  `listAssets` is `order by created_at desc limit 200` with no search. Search and a
  type filter are trivial; usage counts want asset keys in `collections.md`'s
  `content_refs`.

### Deliberately not

Schema-in-UI content-type building (Strapi's headline feature) contradicts
schema-as-code, which is what keeps the admin form, the prop types and the HTML from
drifting. Same for a second query language alongside `ContentQuery`, and for a plugin
marketplace.

## After the current spec set, 2026-07-29

Two wants that come *after* specs 1–16 land, recorded now so the specs above are built
with them in mind. Neither is specced yet, and neither should be started before its own
review.

| Note | Spec | Reading taken |
| --- | --- | --- |
| a full ui sweep to flesh it out into a proper platform but also adopt a linear-esque ui look and feel but obviously still retaining a bit of uniqueness. this will need a proper ui review and design system plan before we jump into it. this is/should be a big one. | not written — wants a UI review and a design system plan first | Explicitly **two pieces of work, review before build**. The sweep cannot be scoped until someone audits what the admin actually is today, and the design system is the thing that makes the sweep finishable rather than endless. Size is **XL**, above anything in the table above. |
| i'd like this to be super ai-friendly. i.e., mcp's where claude/codex/etc. can help author content and manipulate the content basically all the same functions a person can do i want ai to be able to help with. even down to previewing a page before publishing. | not written — sits on top of [platform/content-api.md](specs/platform/content-api.md) and [foundation/identity-and-access.md](specs/foundation/identity-and-access.md) | The bar is **parity with a person**, not a read API with a chat wrapper. That is already the content API's load-bearing decision: writes go through the mutation log, so an agent's edit appears live in an open editor, lands in the activity trail and is undoable — the same seam a human's keystroke uses. An MCP server is then mostly a tool surface over `/folio/api/v1` plus a token scope. |

### What each one still owes

**The UI sweep.**

- *Review first.* What the admin is today, screen by screen: the tree, the inspector,
  the media library, versions, the preview frame. What is missing to read as a platform
  rather than an editor.
- *Design system second.* Tokens, spacing, type scale, the component set, and the
  keyboard-first, density-first, command-palette posture Linear is actually known for —
  the look is downstream of that. "Retaining a bit of uniqueness" needs writing down as
  a positive brief, not as a caveat, or the sweep converges on a clone.
- *Then the sweep.* It should absorb the a11y debt `ROADMAP.md` still carries
  (click-only tree rows, no keyboard reorder, no focus trap in the media library, no
  aria-live on toasts, Biome's a11y rules switched off in `biome.json`) rather than
  leaving it to a second pass. A keyboard-first redesign that is not accessible would be
  an odd result.
- *Ordering.* After 1–16, because several of those add surface it would otherwise have
  to redraw: document types puts non-page documents in the tree, data documents add a
  table-and-form editor, localisation adds a locale switcher, collections add a query
  builder, live collaboration adds presence.

**AI-friendliness.**

- *The functions.* Enumerate what a person can do and hold the MCP to that list: create,
  edit, move, duplicate, publish, unpublish, restore a version, upload an asset, read
  the schema. Schema-as-code is the advantage here — the block manifest is already JSON,
  so an agent can be told what shape a document must take instead of guessing.
- *Preview before publish.* The one item on the note that the content API does not
  already reach. Today preview is the admin's iframe plus a postMessage bootstrap;
  an agent wants an addressable draft preview it can fetch and read back. Closest
  existing machinery is `unpublished-changes.md`'s read-only comparison against what is
  live. Likely wants a scoped, expiring preview URL, which is `identity-and-access.md`'s
  token table and nothing new.
- *Identity.* An agent is not a person: `api_tokens` already models this (a token has
  scopes, not a role). Whatever an agent does must be attributable in the activity trail
  as the agent, not as whoever minted the token.
- *Not just MCP.* An MCP server is one client. The durable surface is the versioned HTTP
  API underneath it, which Codex, a CI script and a future agent all reach the same way.
