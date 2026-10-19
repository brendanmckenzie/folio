# Changelog

One section per release tag. Each lists **Breaking changes** first, separately,
because they are the half you need before you bump; what you must run or edit to
absorb them is in [`UPGRADING.md`](UPGRADING.md), under the entry whose heading
names the tag. Folio follows [semver](https://semver.org/) from 1.0.0: a major
version is a removal or narrowing of the `exports` surface or of a `createFolio()`
config key. D1 migrations arrive in minor versions and are listed in
[the schema ledger](UPGRADING.md#the-schema-ledger).

## Unreleased

On `main`, not yet tagged. The next tag is a minor (`1.1.0`): it adds a migration
and new form keys, and removes nothing.

### Behaviour changes to know about

- **`ResolvedFormField.required` means "required unconditionally".** A question
  whose requiredness depends on a `requireIf` reads `false` here, so a host
  rendering the `required` attribute without the engine never blocks a
  no-JavaScript submission; the server still enforces it. Forms with no conditions
  read exactly as before.
- **A form's `version` bumps on `min`, `max`, `pattern`, `accept` and `maxBytes`
  edits,** because the server enforces them.
- **A cold draft opens with its real content.** A story whose D1 row exists but
  whose Durable Object holds nothing (a database copied between environments) now
  seeds from its published document, else its newest version, instead of opening
  blank under a fresh root. Objects that already hold state are untouched.

### Added

- **Conditional form logic** (spec 35): `showIf` and `requireIf` on questions,
  sections that can be hidden as one, `hold`, and `prefill: 'query'`. `formState`
  in `folio/core` decides what is asked and required, and the submit route re-runs
  it: an unasked required question never blocks, and an answer or file posted for
  one is dropped. Responses record unasked questions, shown as "not asked".
  **Apply `0014_form_logic.sql` before deploying**
  ([UPGRADING](UPGRADING.md#conditional-questions-sections-and-prefill-2026-10-19-v110)).

### Fixed

- **A restore across differing roots works.** `restoreVersion` re-roots a version
  onto the live root, so a document that opened blank after a database copy is
  repaired by restoring its newest publish. A version whose root is another block
  type is refused with 409.

## 1.0.0

The first tagged release. Before it, Folio had no version number and consumers pinned
a full commit SHA. From here a consumer pins `github:brendanmckenzie/folio#v1.0.0`,
and the lockfile still records the commit that tag resolved to.

### Breaking changes

Relative to the last pre-1.0 commits the two live consumers were pinned to.

- **Roles are grants on a scope.** `0011_sites.sql` moves each person's role off
  `users` into `site_roles`, and is the first migration that is not purely additive.
  `users.role` and `users.role_from` are dropped by a later release, so the old
  columns remain until then. It changes what a rollback can do: read
  [the 0011 entry](UPGRADING.md#0011-roles-move-to-site_roles-2026-09-29-v100)
  before applying it.
- **Every read goes through a scope's brand.** `FolioRuntime` no longer carries
  `schema`, `types`, `registry`, `globals`, `forms`, `resolve` or `page` of its own.
  A route reads its brand from the request, and an entry point off a request reaches
  `rt.forScope` or `rt.brands`. A single-brand deployment is one brand like any other.
  A repeated block name in a registry is now a construction error rather than the last
  one winning.
- **`folio.reader` needs a request or a site on a multi-site deployment**, and
  `folio.cacheProps` takes `(req, env)`.
- **37 exported names are gone.** They were internals that leaked through an `index`
  re-export, among them the socket's server-side frames, which were never a host's
  to build against. The wire is private again. The exported surface that remains is
  documented in [the handbook](docs/handbook.md#the-exported-surface), so removing
  any of it from now on is a major version.
- **Wire protocol version 5.** A browser tab left open across a deploy is told to
  reload. The version guards a stale tab and is not part of the semver contract.
- **A title-only patch no longer moves the page**: `PATCH /documents/:id` with a
  `title` and no `slug` used to re-derive the slug, so renaming a page changed its
  URL. Pass `slug` to move one.
- **`item.doc` is absent from collection items unless the query asks for it.**
  `item.data` is unchanged. See the entry in `UPGRADING.md` for how to ask.
- **Migrations `0001` to `0008`, `0010`, `0011` and `0013`.** `0009` is a permanent
  gap and `0012` is claimed for the release that drops `users.role`. Apply them
  before the Worker that needs them goes live.

### Behaviour changes to know about

Not breaking in the semver sense: no export, `createFolio()` key or stored shape is
removed or narrowed, and nothing needs a migration or a host edit. Each changes what
a running site does, so read them before you bump.

- **Restore goes through the server.** The admin no longer diffs in the browser. A
  restore, from the admin or from `POST {base}/api/v1/documents/:id/restore`, first
  saves a "before restore" checkpoint version and fires the `checkpointed` hook for
  any actor who may restore, so a host with a `checkpointed` handler will now see
  one per restore. Cmd+Z does not undo a restore (the checkpoint is the way back),
  and restoring a bare layer unsets the fields it inherits.
- **A collection filter's `in` list is refused only when the whole statement would
  exceed D1's 100 bound parameters**, with a `bad_request` naming it. Every other
  caller-sized bind is now bounded, so a long publish, a wide page render or a large
  Data list no longer fails on the cap.
- **Forms inside globals and referenced documents resolve** to a `ResolvedForm`
  instead of `null`.
- **`render(props, resolution)`.** A block's `render` receives the page's
  `Resolution` as a second argument, so it can `resolveAsset` a referenced
  document's asset. Existing one-argument renders are unaffected.
- **Dependencies:** `vitest` 4.1.11, `@tiptap/core` 3.30.5 and `hono` 4.13.7, all
  security updates.

### Added

- **Multi-site.** A registry of sites and groups, a shared scope every site
  inherits from, per-site and per-group content layers, a role per scope, preview
  origins reached through a one-time handoff, and a scoped cache tag on every render.
- **Multi-brand.** Many brands in one deployment, each with its own block registry,
  types, globals, forms, migrations and preview bundle. The Vite plugin builds one
  preview bundle per brand.
- **Forms and responses.** A `form` field kind, a `ResolvedForm` on the resolution,
  a public `POST {base}/f/:id` route with abuse controls, a responses screen, a CSV
  export and a `submitted` hook. Form questions can sit beside each other in rows.
- **A media library with folders and tags**, and an optional AI describer for alt
  text.
- **Search** over published content, scoped to the public fields on a gated
  deployment.
- **Visitor gating** for a site whose membership lives outside Folio.
- **Auth providers:** magic link, OIDC, Cloudflare Access, trusted identity with SSO
  role mapping, passkeys, and an audit trail.
- **Editor share links** that give a reviewer one draft page without an account,
  and a share-a-preview control in the top bar.
- **The Content API** at `{base}/api/v1`: token-scoped, versioned, writing through
  the mutation log, documented in [`docs/api.md`](docs/api.md).
- **An MCP server**, documented in [`docs/mcp.md`](docs/mcp.md).
- **Caching of published pages with a purge on publish.** The tag set is computed at
  render from the resolution. `cacheControl`, `SITE_TAG` and `ANY_TYPE_TAG` are
  documented for hosts that assemble headers or purge by hand.
- **D1 read replication.** Reads run on a session, so a replica serves them.
- **Content migrations**, field-level localisation, collections, data documents,
  globals, redirects, scheduled publishing, and page history with restore.

### Packaging and documentation

- `folio init` scaffolds the release tag it came from, not a SHA or a branch.
- `prepare` cleans `dist/` before building, as `prepack` does, and source maps no
  longer embed the source (`src/` ships beside them and the declaration maps point
  at it).
- The links in the installed README to contributor material are absolute URLs on
  the `v1.0.0` tag.
- `scripts/release.mjs` checks the names a host imports from each built entry, not
  only that the files exist, and refuses a tag whose remote copy points at a
  different commit.
- The handbook's exported-surface section now covers `toRegistry`, `cacheControl`,
  `ANY_TYPE_TAG`, `SITE_TAG`, `asAsset`, `newUid` and `ResolvedFormField`.
