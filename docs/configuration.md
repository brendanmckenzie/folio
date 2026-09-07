# Configuring Folio

Every knob, with its default and — more usefully — what happens when you leave
it out. Folio's optional keys are designed so that *absent* is a complete,
defined behaviour rather than a gap: no `locales` is a single-locale site, no
`gate` is a public site, no `describe` is a media library that does not write
alt text for you. None of them is a half-configured state.

Four things configure a Folio deployment, and they have to agree with each
other:

1. **`createFolio()`** in your Worker — everything below.
2. **`wrangler.jsonc`** — the bindings `bindings` reads, plus the cron trigger,
   the D1 migrations directory, and the caching flag.
3. **`folio/vite`** — the admin bundle, the preview bundle and the asset
   constants.
4. **Two things nothing will remind you about** — a seeded admin user and a
   cron. See [Deploy-time obligations](#deploy-time-obligations).

Where a mistake can be caught at construction, it is: `createFolio` throws when
the config is wrong rather than letting the error surface as a 500 on whichever
request happens to reach that code path first. The [Refused at
construction](#refused-at-construction) section is the list.

---

## `createFolio(config)`

### Required

#### `blocks: readonly AnyBlockDef[] | Registry`

Your block definitions — the array you export from `src/blocks/index.ts`. Every
block a document can contain, including the root blocks named by `types`.

Nothing distinguishes a root block from any other; it is a root because a
document type names it.

#### `auth: AuthConfig<Env> | 'open'`

**No default, on purpose.** Either name your sign-in providers, or write
`auth: 'open'` to say deliberately that anyone who reaches the editor may edit
and publish. `createFolio` throws when the key is missing, because a host that
simply forgot it used to get a publicly editable CMS in silence, whose failure
mode is a defaced site.

```ts
auth: {
  providers: [
    magicLink({ send: (env, { email, url }) => sendMail(env, email, url) }),
    passkeys(),
  ],
  sessionDays: 30,   // default 30
  linksPerHour: 5,   // sign-in links per address per hour. Default 5
}
```

| Provider | From `folio/server` | What it is |
| --- | --- | --- |
| `magicLink({ send })` | ✔ | Emailed sign-in link. Folio renders the URL and owns the session; **you** send the mail, because only you have the binding and the from-address. |
| `oidc({ … })` | ✔ | Any OIDC provider: Google, Okta, Entra. Redirect kind. |
| `cloudflareAccess({ … })` | ✔ | Trusted-identity provider that **verifies** the Access JWT against your team's published keys. |
| `trusted({ resolve })` | ✔ | You verify an identity however you like and hand it back. The verification is the whole of the security. |
| `passkeys()` | ✔ | WebAuthn. Listing it is the entire opt-in. |

Each provider also takes `domains` (route `@acme.com` addresses to this
provider and no other), `provision` (`'refuse'` — the default — or
`{ create: true, role }`), and `roleFrom` (map an SSO claim to a Folio role
with `roleFromClaim`).

`provision: 'refuse'` means an address your IdP verified but Folio has never
heard of is turned away: access is a list somebody maintains, not a consequence
of holding an account at the provider.

> **Site-visitor auth is not this key.** `auth` is who may *edit*. Who may
> *read* a published page is [`gate`](#gate-foliogateenv).

#### `bindings: (env: Env) => FolioBindings`

Maps your Worker's env to what Folio needs.

| Binding | | Without it |
| --- | --- | --- |
| `db: D1Database` | **required** | — |
| `story: DurableObjectNamespace<StoryDO>` | **required** | — |
| `space: DurableObjectNamespace<SpaceDO>` | optional | Cross-story presence and live tree updates degrade to per-story presence and a tree you refresh yourself. No error: the admin is told through its bootstrap and never opens the socket. |
| `media: R2Bucket` | optional | The media library is read-only. |
| `images: ImagesBinding` | optional | Assets serve at their original size. Everything else works. |
| `browser: BrowserRun` | optional | The MCP `preview_document` tool answers a URL and HTML instead of a screenshot, and says why. Cannot reach a local `wrangler dev` at all — Cloudflare's browser is remote. |

```ts
bindings: (env) => ({
  db: env.DB,
  story: env.STORY,
  space: env.SPACE,
  media: env.MEDIA,
  images: env.IMAGES,
}),
```

---

### Document model

#### `types: readonly DocumentType[]`

Every shape of document this site has. Each declares its own root block, so a
person record is not a page with six unused fields.

```ts
types: [
  { name: 'page',     label: 'Page',          kind: 'page',      root: 'page' },
  { name: 'insight',  label: 'Insight',       kind: 'page',      root: 'insightPage', under: ['page'] },
  { name: 'person',   label: 'Person',        kind: 'record',    root: 'personRecord', titleField: 'fullName' },
  { name: 'settings', label: 'Site settings', kind: 'singleton', root: 'settingsRoot' },
]
```

| Field | | Meaning |
| --- | --- | --- |
| `name` | required | Stored in `stories.type`. |
| `label` | required | What editors see. |
| `kind` | required | `'page'` lives in the tree and owns a URL. `'record'` and `'singleton'` leave the tree entirely (`parent_id` and `path` are both null), so naming a person "Contact" cannot take `/contact` from the page that needs it. |
| `root` | required | The block type used as this document's root. Page metadata lives there. |
| `titleField` | | Root field holding the display title. Defaults to `title` when the root block has one, then the root block's `summary` field, then nothing. |
| `under` | | `page` kinds only. Constrains where a document may be created *and* dragged, with a refusal notice. Declaring it also means the type can never sit at the top level. |
| `default` | | The type a bare "New page" creates. Implicitly the first `page` type. |
| `group` | | Sidebar heading. `record` kinds only, purely presentational. Worth it above roughly eight record types. |
| `previewPath` | | `singleton` kinds only: the path of a routed document whose preview the admin loads with `&as=<name>`, so a header previews on a real page rather than a blank background. `''` is the root story. |

> `root: 'page'` (the string form, without `types`) is the older sugar for a
> single routable page type. It still works and is deprecated. `types` and
> `root` are mutually exclusive, and passing both — or neither — throws.

#### `globals: readonly string[]`

The `singleton` types loaded into **every** page's `Resolution`, so your layout
can place a header and footer that editors control.

```ts
globals: ['header', 'settings'],
```

An explicit list rather than "every declared singleton", because a singleton
your host reads once at boot with `folio.global()` has no business in a
per-request resolution. Every name must name a declared `singleton`.

#### `locales: LocaleConfig`

```ts
locales: {
  default: 'en',                       // the SOURCE locale — the one `Blok.data` holds
  available: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
    { code: 'fr-CA', label: 'Français (CA)', fallback: 'fr' },
  ],
},
```

**Absent means a single-locale site**: no locale reaches a `Resolution`, every
read is the source locale, and nothing about any document or any URL changes.

One document holds every language. `default` is the source locale;
everything else is a per-field override in `Blok.i18n`, so publishing publishes
all languages at once. Mark a field `translatable: true` to put it in front of
a translator.

`fallback` is the locale an untranslated field tries *before* the source; the
chain is followed to its end.

> Changing `default` later is a **content migration** (swap `data` with
> `i18n[new]`), not a config edit. Nothing here rewrites documents.

---

### Routing and rendering

#### `basePath: string`

Where Folio's routes mount. Default `/folio`. Must match the Vite plugin's
`basePath`.

#### `route: (path: string, locale?: string) => string`

Public URL for a story path. `''` is the site root.

```ts
route: (path, locale) => {
  const prefix = locale && locale !== 'en' ? `/${locale}` : ''
  return path ? `${prefix}/${path}` : prefix || '/'
},
```

**You own the URL shape** — a path prefix, a subdomain, a query parameter —
because only you know how you encoded it. `locale` is the second parameter and
the only place a locale reaches a URL; Folio needs the inverse only for its own
preview route, and derives it by asking this function rather than assuming a
convention.

> **The URL this returns must resolve to the same origin the admin is served
> from.** The preview URL is this URL with a flag appended, loaded into the
> admin's iframe, and the admin↔preview bridge checks `event.origin` on every
> frame in both directions. A `route` pointing at a different origin does not
> degrade to a broken preview — the iframe simply never talks to the editor.

#### `draftMode: boolean`

Default `false`. **A promise that your own route calls `reader.page()` (or
`folio.draftAt`).**

With it, a share link redirects a reviewer to the story's real URL, so they
approve the page as it will actually ship. Without it they land on
`?_folio=draft`, which Folio answers itself with its preview shell.

Not inferred, because there is nothing to infer from — Folio cannot see whether
your miss branch calls `draftAt`. Not defaulted on, because the failure mode of
guessing wrong is the worst one available: a reviewer confidently approving a
*published* page that looks correct and is stale.

**The one way to hold this wrong** is to set it and not write the branch.

#### `previewWrap: PreviewWrap`

Wraps the previewed document in your own providers — a router, a theme, an i18n
context — for the **server** render of the preview page.

On a published page those come from your own tree, but Folio's preview mounts a
document and nothing else, so a block calling `useLocation()` throws before a
byte is sent, from a stack that names the block and not the missing provider.

**Its client half is a `wrap` export from your blocks module**, which the Vite
plugin's generated preview entry passes to `mountPreview`. Both are required:
this one alone and hydration throws; that one alone and the server render
throws; two different ones and React discards the server markup as a mismatch.
Export the component once and name it in both places.

A memory router is usually right — the iframe's URL is Folio's, not the
page's — but that is your call.

#### `assets`, `adminCss`, `previewCss`

```ts
declare const __FOLIO_ASSETS__: { admin: string; preview: string; devClient?: string; adminCss?: string[]; previewCss?: string[] }

assets: __FOLIO_ASSETS__,     // the global the Vite plugin defines
previewCss: ['/site.css'],    // your site stylesheet, so the preview looks like the site
adminCss: ['/admin-tweaks.css'],
```

`assets` is not something you author — pass the plugin's global through, in the
same file as `createFolio`.

---

### Behaviour

#### `hooks: FolioHooks<Env>`

After-commit callbacks in your own Worker. Not webhooks: your host and Folio are
the same Worker, so a notification is a typed function call rather than an HTTP
round trip to yourself.

They run **after** a write has landed, never inside it. There is no `before`
hook and no way to veto or rewrite a publish.

| Event | Fires when |
| --- | --- |
| `published` / `unpublished` | A document went live, or was taken down |
| `created` / `deleted` | A document was created or deleted |
| `updated` | A published document changed without its path changing (a title-only patch) |
| `pathsChanged` | A move or rename rewrote descendant paths |
| `checkpointed` | A version was written |
| `migrated` | `runMigrations` rewrote `published_doc` |
| `reindexed` | `POST {base}/reindex` changed what every collection answers |
| `redirectsChanged` | A manual redirect was added or removed |
| `formChanged` | A form's shape changed |
| `submitted` | Somebody filled in a form. **This is the entire programmatic surface for responses** — no API route, no MCP tool. Forward to a CRM here. |
| `await` | `readonly HookEvent[]` — the subset a write waits for before responding. Everything else rides `waitUntil`. |

Unknown keys throw at construction, naming the typo and listing the valid names.

> **Do not put a cache purge here.** Folio purges by tag internally, from the
> render's own dependency set. And never call `caches.default.delete()` keyed on
> a path: that delete is per-colo, and a hook runs in exactly one data centre,
> so every other one keeps serving the stale page. Invalidation in appearance
> only.

#### `logger: FolioLogger`

Where Folio sends its own operational log lines: a cache purge that did not
happen, a scheduled publish that failed three times, a sign-in provider whose
mapper threw. Default `console`, so an unconfigured host's log output does not
change.

```ts
interface FolioLogger {
  error(message: string, ...detail: unknown[]): void
  warn(message: string, ...detail: unknown[]): void
}
```

```ts
logger: {
  error: (message, ...detail) => captureException(message, detail),
  warn: (message, ...detail) => captureMessage(message, detail),
},
```

Two methods, not a level, a filter, or structured fields (request id, trigger,
story id) — every one of the roughly forty existing call sites already knows
whether it is `error` or `warn`, and a structured shape can arrive later as an
**additional optional argument** without touching this signature. `...detail`
is a rest parameter rather than a fixed second one because the calls it
replaces pass an `Error` in most places, a plain string in some, and an array
of D1's own errors in one — this interface does not decide anything about
their shape, and the messages themselves, including their `folio:` prefix, are
unchanged.

Threaded through `FolioRuntime` the way `hooks` and `gate` are: resolved once
at construction, then read at every call site. A Durable Object (`StoryDO`,
`SpaceDO`) is the one exception — it is constructed by the platform from a
config with no path back to `createFolio`'s, so its two log lines stay on
`console` regardless of this key.

#### `gate: FolioGate<Env>`

Members-only pages, for a site whose membership lives outside Folio.

```ts
gate: {
  field: 'access',        // a root-block field
  public: 'public',       // the one stored value meaning "no gate"
  visitor: (req, env) => lookUpMember(req, env),          // who is asking
  allows: (visitor, value, ctx) => visitor !== null,      // may they read it
},
```

**Absent is the whole of "this site is public"**: no field is read, no host code
runs, and every page answers `access: 'public'` with the cache headers it always
had.

Folio owns only the cheap part — reading one named field and comparing it
strictly to `public`. That comparison happens **before** `visitor` is touched,
which is the property the design turns on: a public page stays cacheable and
costs no host call, and code that may verify a token or call an IdP runs only
when a document has asked for it.

Anything other than `public` — including no value at all — reaches `allows`, so
a document created before the field existed fails closed rather than open.

`field` must be one of the five scalar kinds, `indexed: true`, never
`translatable`, and declared on a `page` root. Each is checked at construction,
because a gate the editor believes in and nothing enforces is worse than none.

#### `forms: FolioForms<Env>`

```ts
forms: {
  ratePerHour: 20,                          // per IP-hash. Default 10, valid 1–100, 0 disables
  verify: async ({ req, body, form }, env) => turnstile(env, body['cf-turnstile-response']),
},
```

**Absent is a complete answer, not a gap** — the honeypot always runs and the
default limit still applies. What is missing is only the verification Folio
cannot do on your behalf.

`verify` receives the **raw** body, before undeclared keys are dropped, because
the token's field name belongs to your widget and Folio does not know it. It
**fails closed, including on a throw** — the opposite posture to the hooks
above, and deliberately: a hook runs after a write and must never undo one,
while `verify` runs before and its whole job is to refuse traffic nobody can
vouch for. A captcha that opens on error is decorative.

Validated a rung more insistently than `gate` or `describe`, because the request
that would otherwise discover a broken `verify` is an anonymous POST from the
public internet — so the symptom would be a contact form that silently collects
nothing.

#### `describe: FolioDescribe<Env>`

Machine-written alt text, descriptions and tags for the media library. One
function; Folio holds no API key and chooses no model.

```ts
describe: {
  fn: async (input, env) => callYourModel(env, input.url),
  onUpload: true,    // describe new uploads in the background. Default true
  concurrency: 4,    // in-flight model calls per batch. Default 4, range 1–8
},
```

**Absent is the whole of "this site does not do this"**: the describe routes
answer `unsupported`, no machine column is ever written, and an upload behaves
exactly as it does today.

`input` gives you `url` (a 512px WebP wherever `images` is bound — an order of
magnitude fewer tokens than a 20MB original) and `bytes()` (lazy, for a
deployment a model API cannot reach). Whatever your function returns is clamped
and bounded before a byte of it is stored: it is arbitrary text from a model,
and a model is a caller.

`folio/server` exports an Anthropic-shaped helper if you want one rather than
writing the call yourself.

#### `migrations: readonly Migration[]`

Content migrations, in run order. Each is a pure function from a document to a
list of mutations, written with `defineMigration` from `folio/engine`.

```ts
// src/migrations.ts
import { defineMigration, field } from 'folio/engine'

export const migrations = [
  defineMigration({
    id: '0001-hero-heading-to-title',
    description: 'Hero: heading → title',
    up: (_doc, ctx) => ctx.each('hero', (blok) => field.rename(blok, 'heading', 'title')),
  }),
]
```

Declared rather than discovered, because **the order is the contract**:
`stories.schema_id` records how far a document has come and compares
lexicographically, so the ids must sort in run order. `createFolio` checks that
rather than assuming it.

**Nothing runs automatically.** `folio.migrate(env)` from a script or a deploy
step, or `POST {base}/api/migrate` from the admin. A migration that ran itself on
the first request after a deploy would run inside a request whose CPU limit it
can exceed, on a cold Worker, with nobody watching.

See [`UPGRADING.md`](../UPGRADING.md) for how these relate to D1 schema
migrations — they are unrelated ledgers with confusingly similar names.

#### `mcp: boolean`

Default `true`. `false` removes `{base}/mcp` entirely.

On by default because it is gated by the same `api_tokens` table as
`/api/v1`: every tool is one of those routes, dispatched internally with the
caller's own credential, so "on" adds no reachable surface a token could not
already reach. Turn it off if you have minted no tokens, or do not want an agent
surface at all.

---

## `wrangler.jsonc`

```jsonc
{
  "main": "./src/index.tsx",
  "compatibility_date": "2026-07-27",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS" },

  // Workers Caching. The whole of the opt-in: no API token, no zone, no paid
  // plan. Without it the headers `folio.cacheHeaders()` returns are inert and
  // every purge is a no-op — which is what makes it safe to adopt the headers
  // first and this flag second.
  "cache": { "enabled": true },

  // Scheduled publish/unpublish. This key plus a `scheduled()` handler is the
  // whole integration — no queue, no polling loop, no external cron.
  "triggers": { "crons": ["* * * * *"] },

  "d1_databases": [{
    "binding": "DB",
    "database_name": "folio",
    "database_id": "<from `wrangler d1 create folio`>",
    // The package's copy, so your project and Folio share one migration history.
    "migrations_dir": "./node_modules/folio/migrations"
  }],

  "durable_objects": { "bindings": [
    { "name": "STORY", "class_name": "StoryDO" },
    { "name": "SPACE", "class_name": "SpaceDO" }
  ]},

  // `new_sqlite_classes` cannot be changed for an already-deployed class, and
  // SpaceDO holds no storage at all — presence lives in socket attachments.
  // Getting this wrong is not fixable in place, which is why each class gets
  // its own tag rather than sharing one.
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["StoryDO"] },
    { "tag": "v2", "new_classes": ["SpaceDO"] }
  ],

  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "folio-media" }],
  "images": { "binding": "IMAGES" },
  "observability": { "enabled": true }
}
```

### Caching goes on an entrypoint, never Worker-wide

This is a security property, not a tuning choice. Workers Caching is **opt-out**:
a `200` with no `Cache-Control` is stored for two hours under heuristic
freshness. The admin is authenticated by a cookie, and a request cookie is not a
bypass condition — only `Set-Cookie` on the *response* is. So `cache.enabled` on
the default entrypoint puts the admin's authenticated JSON in a shared cache.

Disable it on the default entrypoint, enable it on one cached entrypoint, and
gate what reaches that with `folio.cacheVerdict(req)`.

And note the corollary: **a purge is scoped to the entrypoint that issued it.**
A host that caches on one entrypoint and handles writes on another purges an
empty namespace and keeps serving the stale page for its whole TTL, silently.
Route writes — and `runSchedules` from `scheduled()` — through the cached
entrypoint.

### D1 read replication

Turn it on in the Cloudflare dashboard: **D1 → your database → Settings →
Enable Read Replication.** Folio issues every read on a session, but without
this flag every session still resolves to the primary.

Then make sure every page read goes through `folio.reader(env, req)`. The
top-level calls (`folio.published`, `folio.storyAt`, …) each open their own
session and are for one-shot use from a cron or a deploy script. A page render
makes three or four reads; a reader runs them on one session, which is both what
lets a replica near the visitor answer them and what guarantees they all see the
same version of the database.

On the first host to run this in production, an unsessioned query cost ~280ms.

---

## The Vite plugin

```ts
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { folio } from 'folio/vite'

export default defineConfig({
  plugins: [
    react(),
    folio({
      blocks: './src/blocks/index.ts',  // module with a named `blocks` export
      basePath: '/folio',               // must match createFolio. Default /folio
    }),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
})
```

The admin is **not** rebuilt per project — it is schema-driven and ships
compiled, so your block code never enters that bundle. The plugin supplies the
admin entry, generates the preview entry from your blocks, and defines
`__FOLIO_ASSETS__`.

Two things it does that you can undo by accident:

- **It force-includes `react-dom/server.edge` in `optimizeDeps`.** That module
  is CommonJS; left external, workerd throws `ReferenceError: require is not
  defined` *during startup*, from a stack naming neither Folio nor react-dom.
  If you override `optimizeDeps`, re-include it. If you rename the Worker
  environment away from `ssr`, repeat the include under your name.
- **It needs `build.cssCodeSplit: false` set in your own config.** If a
  framework plugin sets it instead, the plugin cannot see that and throws at
  `configResolved` naming the cause — because by then the asset paths are baked
  and refusing to ship is all that is left.

---

## Deploy-time obligations

Two things nothing in Folio will remind you about.

**1. Seed the first admin user.** A CMS with accounts has a chicken-and-egg
problem: nobody can sign in until a row exists, and no route may create the
first admin — an endpoint that creates an admin is an endpoint that creates an
admin. So it is a deploy step:

```bash
wrangler d1 execute folio --remote \
  --command "insert into users (id, email, name, role, created_at) values ('usr_$(openssl rand -hex 8)', 'you@example.com', 'You', 'admin', unixepoch() * 1000)"
```

> If login "does nothing", this is almost always why. The login route answers
> 200 identically whether or not an address is known — so it cannot be used to
> enumerate accounts — and an unknown email therefore looks exactly like a
> successful one.

**2. Wire the crons.** Two sweeps, both host obligations, both silent when
forgotten:

```ts
async scheduled(_controller, env, _ctx) {
  // Scheduled publish/unpublish. Loop on `continueFrom`, never on
  // `report.remaining` — a schedule that failed transiently is still due, so
  // that loop spins.
  let cursor: string | null = null
  let batches = 0
  do {
    const report = await folio.runSchedules(env, { continueFrom: cursor })
    cursor = report.continueFrom
  } while (cursor !== null && ++batches < 20)

  // Auth housekeeping: expired sessions, consumed challenges, auth_events past
  // its 90-day retention. Nothing breaks when this is never wired up — an
  // expired session already fails on read — so the failure mode is unbounded
  // growth rather than an outage, and nothing anywhere says so. `GET
  // {base}/api/auth-events`'s `oldestAt` is the one surface that shows it.
  await folio.sweepAuth(env)
}
```

---

## Refused at construction

`createFolio` throws rather than deferring the error to a request. The list, so
you can recognise one:

| What | Why |
| --- | --- |
| `auth` missing | A forgotten key used to mean a publicly editable CMS |
| `types` and `root` both given, or neither | A configuration mistake should not become a 500 on one code path |
| A `globals` entry that is not a declared `singleton` | It would resolve to nothing, per request, in silence |
| `locales`: a default that is not available, a duplicate code, a fallback that does not exist, a fallback cycle | Each produces an unterminated read at render time |
| `gate.field` translatable, unindexed, the wrong kind, or on no `page` root | A gate the editor believes in and nothing enforces |
| `describe.fn` not a function, or `concurrency` outside 1–8 | Would 500 on whichever request reached it first |
| `forms.verify` not a function, `ratePerHour` outside 0–100 | The discovering request is an anonymous POST from the internet |
| An unknown key in `hooks` (or in `hooks.await`) | A typo means a hook that silently never fires |
| `migrations` whose declared order and sort order disagree | Documents would migrate in an order depending on which comparison ran |
| A `presets` entry naming a field the block does not declare | The preset would silently do nothing |

---

## See also

- [`README.md`](../README.md) — the tour and the quick start.
- [`AGENTS.md`](../AGENTS.md) — the integration shape, in order, with the traps.
- [`docs/handbook.md`](handbook.md) — what each of these features actually does.
- [`UPGRADING.md`](../UPGRADING.md) — bumping the pin and applying migrations.
- [`examples/starter`](../examples/starter) — the smallest correct configuration.
- [`examples/demo`](../examples/demo) — nearly every key on this page, with the
  reasoning inline.
