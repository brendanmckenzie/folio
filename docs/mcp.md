# Folio's MCP server — connecting an assistant

Every Folio deployment serves an MCP endpoint at **`{base}/mcp`** — `/folio/mcp` with the
default `basePath`. There is nothing to install and no second artifact to deploy: it is a
route in the host Worker, authenticated by the same `api_tokens` table as `{base}/api/v1`,
and it exists the moment a host upgrades.

Sixteen tools, each one an existing v1 route dispatched internally (see
`docs/specs/platform/mcp-server.md` decision 2). So an assistant can do what a person can
do, an agent's edit appears live in an open editor, and it lands in the activity trail
attributed to the token rather than to whoever minted it.

## 1. Mint a token

In the admin, **Access → Tokens → New token**. Name it for the job it does — the name is
what appears in the activity trail, so `claude` reads better than `token 3`. Pick the
narrowest scope set that lets it work; the tool list is filtered by scope, so a tool the
token cannot call **is never offered**, and a read-only assistant simply never sees
`write_content`.

**The token is shown once and stored as a hash.** There is nothing to read it back from.

The Access screen is absent under `auth: 'open'`, which has no access control by choice.
Scopes, and what each buys:

| Scope | Tools it unlocks |
| --- | --- |
| `content:read` | `get_schema`, `search_documents`, `query_documents`, `get_document`, `list_versions` |
| `content:read:draft` | the above, plus `preview_document` |
| `content:write` | the above, plus `create_document`, `write_content`, `patch_fields`, `move_document`, `duplicate_document`, `restore_version` |
| `publish` | the reads, plus `publish_document`, `unpublish_document` |
| `assets:write` | `upload_asset`, **and nothing else** |
| `admin` | everything, including `delete_document` |

Two of those are worth knowing rather than discovering:

- **`assets:write` implies no content access at all**, which is the whole reason it is a
  separate scope. A token holding only it gets one tool.
- **`delete_document` needs `admin`, not `content:write`**, although its route accepts
  `content:write`. A delete is the one action in the list whose mistake no other tool call
  can undo. A script that means to delete asks for `admin`; an assistant helping with copy
  does not.

## 2. Connect a client

### Claude Code

```bash
claude mcp add --transport http folio https://your-site.example/folio/mcp \
  --header "Authorization: Bearer folio_<your token>"
```

`--scope` controls where it is written: `local` (the default, this project only), `project`
(a checked-in `.mcp.json`), or `user` (all your projects). `--header` may be repeated.

To hand-write it instead, a project-scope `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "folio": {
      "type": "http",
      "url": "https://your-site.example/folio/mcp",
      "headers": { "Authorization": "Bearer ${FOLIO_TOKEN}" }
    }
  }
}
```

`${FOLIO_TOKEN}` is expanded from the environment when the config loads, which is how a
project-scoped file gets committed without the token going with it.

### Claude Agent SDK

```typescript
mcpServers: {
  folio: {
    type: 'http',
    url: 'https://your-site.example/folio/mcp',
    headers: { Authorization: `Bearer ${process.env.FOLIO_TOKEN}` },
  },
}
```

### The Messages API MCP connector

```json
{
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://your-site.example/folio/mcp",
      "name": "folio",
      "authorization_token": "folio_<your token>"
    }
  ]
}
```

Pass the raw token, not `Bearer <token>` — the connector adds the scheme. This needs the
`anthropic-beta: mcp-client-2025-11-20` header.

### claude.ai — works, but check it is enabled for you

Folio authenticates with a bearer token in a header and **deliberately does not implement
OAuth 2.1** (`mcp-server.md`, Out of scope: Folio is an OIDC *client*, not a provider). On
claude.ai, static-header auth for a custom connector is a **beta** capability that is still
being rolled out, so it may not be visible to your organisation yet.

If it is available: **Add custom connector**, then the **Request headers** section. Choose
`authorization` from the allowlist and enter the value **including the scheme** —
`Bearer folio_<your token>`, with the space. Leave every OAuth field blank; `Authorization`
cannot be set as a request header on a connection that also has OAuth configured. On Team
and Enterprise plans only an owner can add the connector.

If you do not see a **Request headers** section, that feature is not enabled for your
organisation and there is no workaround on that surface — a Folio token cannot be presented
through the OAuth fields. Use Claude Code or the SDK, or contact Anthropic for access.

## 3. Check it worked

Ask the assistant to list its tools, or:

```bash
curl -s -X POST https://your-site.example/folio/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $FOLIO_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

**An empty tool list is the symptom of a missing or wrong credential, not of a broken
server.** `initialize` deliberately succeeds with no credential at all — an MCP client
probes before it is configured, and a 401 there presents as "the server is down" rather
than "the token is missing" — so an unauthenticated session connects cleanly and then
offers nothing. If `tools/list` is `[]`, check the header before anything else.

Other things that are working as intended:

- **`GET {base}/mcp` answers 405** with `Allow: POST`. This server never initiates a
  message to the client, so there is no stream to open and nothing to GET.
- **`{base}/api/mcp` and `{base}/api/v1/mcp` both 404.** The endpoint sits outside the
  `/api` partition on purpose: everything under `/api` answers Folio's single error
  envelope, and MCP answers JSON-RPC's own. It is also unversioned, because MCP negotiates
  its own version and tools are discovered per session.
- **A tool you were not offered still refuses if you call it by name**, with the v1 route's
  own `forbidden` naming the scope you lack, rather than a message this layer invented.

To turn the endpoint off entirely: `createFolio({ mcp: false })`. It is on by default,
because it is gated by the same token table as `/api/v1` and so adds no surface a token
could not already reach — but a host that has minted no tokens should be able to say so in
config rather than leave it to be inferred.

## 4. Screenshots need one more thing

`preview_document` is the only tool that is not a v1 route: it renders the draft at
`?_folio=draft` and photographs it, so an assistant can *look* at a page rather than infer
it from markup. That needs **Cloudflare Browser Rendering**, a paid add-on the host binds
itself:

```jsonc
// wrangler.jsonc
{ "browser": { "binding": "BROWSER" } }
```

and passed through the host's `bindings` as `browser`. Folio needs no extra package for
this — the binding is driven directly and its type ships in `@cloudflare/workers-types`.

**Without the binding the tool still works**: it answers the draft's URL and the rendered
HTML, and says plainly that no screenshot was taken and why. An assistant with its own
browser can then go and look; one without can still check the content is there.

**It cannot work against `pnpm dev` at all.** Cloudflare's browser is remote and cannot
reach `localhost:5199`, so local development always takes the no-binding path. That is not
a misconfiguration, and it is what `scripts/mcp-test.mjs` asserts.

Two limits the tool reports rather than hides:

- **What it photographs is Folio's preview shell, not your page layout.** The document's
  own content is node-for-node what the published page renders — which is what a screenshot
  clipped to one block is about — but the chrome around it stacks globals above the document
  instead of placing them the way your host does. Every result says so. A draft rendered
  inside a host's own layout is a real feature and a different one; see `ROADMAP.md`.
- **`blok` clips to one block, and not every block can be clipped.** A block whose `render`
  returns a component rather than an element has no addressable node in the draft render (a
  deliberate trade: the wrapper that would carry one is an extra grid child, which is the
  most likely visual defect and exactly what the tool exists to catch). Naming one falls
  back to the viewport shot **and says it did**, so a model never draws conclusions about
  geometry from the wrong picture.

## 5. What an agent's edits look like afterwards

Every write goes through the mutation log, the same seam a keystroke uses. So an edit made
over MCP:

- appears **live** in an editor someone has open, through the same per-keystroke machinery;
- is attributed in the activity trail as **`token:<name>`** — the agent, not whoever minted
  the credential;
- is **undone by Cmd+Z** in that editor, in one step;
- reports `changed: 0` and writes nothing at all when a payload matches what is already
  stored, so a retried write is a no-op rather than a duplicate.

A double create is refused as a `conflict` by a unique index rather than making two pages,
which is why no tool asks a model to remember an idempotency key.

## See also

- `docs/api.md` — the v1 Content API every tool dispatches to, including the document
  shape `write_content` and `patch_fields` take.
- `docs/specs/platform/mcp-server.md` — why it is built this way, every alternative
  rejected, and the implementation notes.
