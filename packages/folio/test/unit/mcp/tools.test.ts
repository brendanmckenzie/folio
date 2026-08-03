import { describe, expect, it } from 'vitest'
import { blocks, defineBlock, defineRecord, text } from '../../../src/core'
import type { DocumentType } from '../../../src/core/schema'
import { ADMIN, MANAGE } from '../../../src/server/auth/roles'
import { MAX_DIMENSION, MIN_DIMENSION } from '../../../src/server/mcp/shot'
import {
  fillPath,
  MCP_TOOLS,
  type McpTool,
  nonBodyKeys,
  toolByName,
} from '../../../src/server/mcp/tools'
import { apiRoutes } from '../../../src/server/routes/api'
import { createRuntime } from '../../../src/server/runtime'
import { STORY_STATE } from '../../../src/server/validate'

/**
 * **The tool table must not drift from the API** — the point of this file, and
 * the reason `../../../../docs/specs/platform/mcp-server.md` decision 2 is
 * enforceable rather than aspirational.
 *
 * Every tool names a `{method, path}` and the handler dispatches it to the
 * mounted app's own `fetch`. So a typo in a path is not a compile error, it is a
 * 404 the first time an agent tries the tool. Both directions are asserted here:
 *
 *   1. Every tool resolves to a route the v1 app actually declares.
 *   2. Every route the v1 app declares is either a tool or **named** in
 *      `NOT_TOOLS` with a reason — so adding a v1 route becomes a deliberate
 *      decision about whether an agent gets it, rather than a silent no.
 *
 * The route list is read off Hono itself (`app.routes`) rather than restated,
 * because a restated list is a third copy to keep in step.
 */

const link = defineBlock({
  name: 'link',
  label: 'Link',
  fields: { label: text() },
  render: () => null,
})

const page = defineBlock({
  name: 'page',
  label: 'Page',
  fields: { title: text(), body: blocks({ allow: ['link'] }) },
  render: () => null,
})

const product = defineRecord({ name: 'product', label: 'Product', fields: { sku: text() } })

const types: DocumentType[] = [
  { name: 'pageType', label: 'Page', kind: 'page', root: 'page', default: true },
  { name: 'productType', label: 'Product', kind: 'record', root: 'product' },
]

const rt = createRuntime({
  blocks: [page, link, product],
  types,
  bindings: () => ({}) as never,
  auth: 'open',
})

/**
 * `${METHOD} ${path}` for every route the v1 app declares, deduplicated:
 * `app.get(path, requireAccess(...), handler)` registers one entry per handler,
 * so the middleware and the handler both appear.
 */
const v1Routes = new Set(apiRoutes(rt).routes.map((route) => `${route.method} ${route.path}`))

const routeOf = (tool: { method: string; path: string }) => `${tool.method} ${tool.path}`

/**
 * Every row but `preview_document` (`../../../src/server/mcp/tools.ts`'s
 * header comment): the one tool with no v1 route behind it, dispatched
 * straight to `../../../src/server/mcp/shot.ts` by `routes/mcp.ts` instead of
 * through the round-trip this file otherwise pins.
 */
const routed = (tool: McpTool): tool is McpTool & { method: string; path: string } =>
  tool.path !== undefined

/**
 * The v1 routes an agent deliberately does not get. Each one is a decision, not
 * an omission — which is the whole reason this list is named rather than
 * inferred.
 */
const NOT_TOOLS: readonly string[] = [
  /**
   * A second way to address the read `get_document` already does. An agent
   * resolves "the pricing page" with `search_documents`, which sees drafts too;
   * `by-path` needs the exact path up front, which is the one thing the agent
   * does not have. Two tools that answer the same question is how a model picks
   * the wrong one.
   */
  'GET /documents/by-path',
  'GET /documents/by-path/:path{.*}',
  /**
   * Browsing the media library. `feedback.md`'s parity list names *uploading* an
   * asset, which `upload_asset` is; picking from what is already there is the
   * media picker's job, and an agent that needs an existing asset's value reads
   * it off the document already using it.
   */
  'GET /assets',
  /**
   * A named checkpoint. Absent from the spec's tool table on purpose: publishing
   * already records a version, so an agent has no snapshot verb to reach for,
   * and this route is `PUBLISH`-gated precisely because a checkpoint is an
   * editorial act rather than a step in a write.
   */
  'POST /documents/:id/versions',
]

describe('the tool table', () => {
  it('names sixteen tools, each once — fifteen route-backed and preview_document with none', () => {
    // Fifteen are a `{method, path}` over the v1 app; `preview_document` is
    // `?_folio=draft` plus a `browser` binding (decisions 5, 5a) and has
    // neither — `routes/mcp.ts`'s `tools/call` branches to it before the
    // internal dispatch the other fifteen share.
    expect(MCP_TOOLS).toHaveLength(16)
    expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(16)
    const preview = toolByName('preview_document')
    expect(preview?.method).toBeUndefined()
    expect(preview?.path).toBeUndefined()
    expect(MCP_TOOLS.filter((tool) => !routed(tool)).map((tool) => tool.name)).toEqual([
      'preview_document',
    ])
  })

  it('resolves every route-backed tool to a route the v1 app declares', () => {
    for (const tool of MCP_TOOLS) {
      if (!routed(tool)) continue
      expect([tool.name, routeOf(tool), v1Routes.has(routeOf(tool))]).toEqual([
        tool.name,
        routeOf(tool),
        true,
      ])
    }
  })

  it('accounts for every v1 route: a tool, or a named exclusion', () => {
    // Over the route-backed tools only — `preview_document` names no v1 route
    // at all, so it is neither a claim on `v1Routes` nor something that could
    // shadow one.
    const claimed = new Set(MCP_TOOLS.filter(routed).map(routeOf))
    for (const route of v1Routes) {
      const accounted = claimed.has(route) || NOT_TOOLS.includes(route)
      expect([route, accounted]).toEqual([route, true])
    }
  })

  it('keeps no stale exclusion, so a retired route cannot hide here', () => {
    for (const route of NOT_TOOLS) {
      expect([route, v1Routes.has(route)]).toEqual([route, true])
    }
    // And the two lists partition the whole route-backed surface rather than
    // overlapping it. `preview_document` is deliberately outside this count —
    // it is accounted for above, by name, not by a route it does not have.
    const claimed = new Set(MCP_TOOLS.filter(routed).map(routeOf))
    for (const route of NOT_TOOLS) expect(claimed.has(route)).toBe(false)
    expect(claimed.size + NOT_TOOLS.length).toBe(v1Routes.size)
  })

  /* -------------------------------------------------------------- shapes --- */

  it('declares every path parameter as a required argument', () => {
    for (const tool of MCP_TOOLS) {
      if (!tool.path) continue
      for (const match of tool.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = match[1]!
        expect([tool.name, name, tool.inputSchema.required ?? []]).toEqual([
          tool.name,
          name,
          expect.arrayContaining([name]),
        ])
        expect([tool.name, name, Object.keys(tool.inputSchema.properties ?? {})]).toEqual([
          tool.name,
          name,
          expect.arrayContaining([name]),
        ])
      }
    }
  })

  it('declares every query and flag argument in the input schema', () => {
    for (const tool of MCP_TOOLS) {
      const declared = Object.keys(tool.inputSchema.properties ?? {})
      for (const key of [...(tool.query ?? []), ...(tool.flags ?? [])]) {
        expect([tool.name, key, declared.includes(key)]).toEqual([tool.name, key, true])
      }
    }
  })

  /**
   * **An `enum` in an input schema is a second copy of the route's validation**,
   * which is the fork decision 2 exists to prevent — one layer in from the place
   * that decision is usually argued. It shipped wrong once: the advertised list
   * read `published`, which `StoryState` does not name, while omitting `live`,
   * which is the value that actually means published. A model following the
   * schema would have sent the one value guaranteed to be refused.
   *
   * So every advertised domain is pinned against the screen the route puts the
   * argument through, by value rather than by eye. `STORY_STATE` is a valibot
   * picklist, so its options are readable off the schema itself and the two
   * cannot drift apart without failing here.
   */
  it('advertises exactly the values the route screens for', () => {
    const state = toolByName('search_documents')?.inputSchema.properties?.state
    expect(state?.enum).toEqual(STORY_STATE.options)
    // Stated as a literal too, so the assertion above cannot pass by both sides
    // moving together — a picklist edit has to be a deliberate change here.
    expect(state?.enum).toEqual(['draft', 'unpublished', 'live', 'changed'])
  })

  /**
   * A body field the route reads through `v.nullish(ID)` takes `null` as a real
   * value — the top of the tree — so the schema has to say so. Advertising a
   * bare `'string'` while the description says "or null" means a client that
   * validates arguments rejects the correct value before sending it.
   */
  it('types a nullable parent as accepting null, not just as described', () => {
    for (const name of ['create_document', 'move_document'] as const) {
      const parentId = toolByName(name)?.inputSchema.properties?.parentId
      expect([name, parentId?.type]).toEqual([name, ['string', 'null']])
    }
  })

  /**
   * `preview_document`'s `viewport` bounds are the one place this file has to
   * pin a *number*, not a string enum: `../mcp/tools.ts` interpolates
   * `MIN_DIMENSION`/`MAX_DIMENSION` from `shot.ts` into the description rather
   * than retyping them, precisely so the advertised range cannot drift from
   * the clamp `resolveViewport` actually applies. Same fork decision 2 exists
   * to prevent, one layer in — pinned the same way `state`'s enum is pinned
   * against `STORY_STATE`, above.
   */
  it('advertises the viewport bounds it actually clamps to', () => {
    const viewport = toolByName('preview_document')?.inputSchema.properties?.viewport
    const bounds = `${MIN_DIMENSION}-${MAX_DIMENSION}`
    expect(viewport?.properties?.width?.description).toContain(bounds)
    expect(viewport?.properties?.height?.description).toContain(bounds)
    // Stated as a literal too, so the assertion above cannot pass by both
    // sides moving together — a clamp edit has to be a deliberate change here.
    expect([MIN_DIMENSION, MAX_DIMENSION]).toEqual([200, 4000])
  })

  /**
   * `fullPage` and `blok` typed as what `previewDocument`
   * (`../../../src/server/mcp/shot.ts`) actually reads off `args` —
   * `args.fullPage === true` and `typeof args.blok === 'string'` — rather than
   * as a guess. A schema that advertised, say, `blok` as an array would be a
   * contract the tool does not honour.
   */
  it('types preview_document’s arguments as what previewDocument reads', () => {
    const props = toolByName('preview_document')?.inputSchema.properties
    expect(props?.viewport?.type).toBe('object')
    expect(props?.viewport?.properties?.width?.type).toBe('integer')
    expect(props?.viewport?.properties?.height?.type).toBe('integer')
    expect(props?.fullPage?.type).toBe('boolean')
    expect(props?.blok?.type).toBe('string')
  })

  it('sends no body on a GET, and one on every route that reads one', () => {
    for (const tool of MCP_TOOLS) {
      if (tool.method === 'GET' || tool.method === 'DELETE') {
        expect([tool.name, tool.body]).toEqual([tool.name, undefined])
      }
    }
    // The one route that reads raw bytes rather than JSON.
    expect(toolByName('upload_asset')?.body).toBe('base64')
  })

  it('gives every tool a description a model can act on', () => {
    for (const tool of MCP_TOOLS) {
      expect([tool.name, tool.description.length > 40]).toEqual([tool.name, true])
    }
  })

  /* --------------------------------------------------------- the narrowing --- */

  /**
   * **`narrowed` means two different things now** (`McpTool.narrowed`'s own
   * comment): `delete_document`'s `need` is stricter than its route's, so the
   * MCP layer has to gate it itself; `preview_document` has no route at all,
   * so it has nothing else to be gated by. Both are the one place the MCP
   * layer checks access itself rather than letting a v1 route refuse it — and
   * nothing else in the table needs to.
   */
  it('narrows delete_document to admin and preview_document for having no route, nothing else', () => {
    const deleteTool = toolByName('delete_document')
    expect(deleteTool?.need).toBe(ADMIN)
    expect(deleteTool?.narrowed).toBe(true)
    // The route itself is only `MANAGE`, which is what makes this a narrowing
    // rather than a restatement.
    expect(MANAGE.scope).toBe('content:write')

    const preview = toolByName('preview_document')
    expect(preview?.narrowed).toBe(true)
    // Narrowed for the other reason `McpTool.narrowed` names: no route to
    // narrow against at all, rather than a stricter `need` than one declares.
    expect(preview?.path).toBeUndefined()

    expect(MCP_TOOLS.filter((tool) => tool.narrowed).map((tool) => tool.name)).toEqual([
      'preview_document',
      'delete_document',
    ])
  })

  it('matches the spec’s own need column, scope for scope', () => {
    const need = Object.fromEntries(MCP_TOOLS.map((tool) => [tool.name, tool.need.scope]))
    expect(need).toEqual({
      get_schema: 'content:read',
      search_documents: 'content:read',
      query_documents: 'content:read',
      get_document: 'content:read',
      list_versions: 'content:read',
      preview_document: 'content:read:draft',
      create_document: 'content:write',
      write_content: 'content:write',
      patch_fields: 'content:write',
      move_document: 'content:write',
      duplicate_document: 'content:write',
      restore_version: 'content:write',
      publish_document: 'publish',
      unpublish_document: 'publish',
      delete_document: 'admin',
      upload_asset: 'assets:write',
    })
  })
})

describe('fillPath', () => {
  it('substitutes each named parameter', () => {
    expect(fillPath('/documents/:id/content', { id: 'sto_1' })).toBe('/documents/sto_1/content')
    expect(fillPath('/schema', {})).toBe('/schema')
  })

  /**
   * **Load-bearing, and the reason the internal dispatch cannot be pointed
   * somewhere else.** A `/` in an argument becomes `%2F`, which `new URL()` does
   * not decode — so the value stays one path segment and reaches the route's own
   * `idParam` screen rather than resolving to a different route. `new URL()`
   * normalises `..` before any router sees the path, so a `String(value)` here
   * would silently let `get_document` address `{base}/login`.
   */
  it('encodes the separator, so an argument cannot introduce a path segment', () => {
    expect(fillPath('/documents/:id', { id: 'a/b' })).toBe('/documents/a%2Fb')
    expect(fillPath('/documents/:id', { id: '../../../login' })).toBe(
      '/documents/..%2F..%2F..%2Flogin',
    )
    // The property, stated over the result rather than over the input: whatever
    // an argument holds, the filled path has exactly the segments the template
    // does.
    for (const id of ['../..', '/etc/passwd', 'a%2Fb', 'a\\b', '?x=1', '#frag']) {
      expect([id, fillPath('/documents/:id/publish', { id }).split('/')]).toEqual([
        id,
        ['', 'documents', expect.any(String), 'publish'],
      ])
    }
  })

  /**
   * `bad_request`, so `rpcCodeFor` turns it into JSON-RPC's *invalid params*:
   * nothing validates a tool's `inputSchema` on the way in — MCP advertises it
   * so a client can build a well-formed call — and the server still has to
   * answer a malformed one legibly.
   */
  it('refuses a missing parameter as bad_request, naming it', () => {
    expect(() => fillPath('/documents/:id', {})).toThrowError(/id is required/)
    expect(() => fillPath('/documents/:id', { id: null })).toThrowError(/id is required/)
    expect(() => fillPath('/documents/:id', { id: {} })).toThrowError(/id is required/)
  })
})

describe('nonBodyKeys', () => {
  it('is the path, query and flag names, so everything else is the body', () => {
    expect(nonBodyKeys(toolByName('write_content')!)).toEqual(new Set(['id']))
    expect(nonBodyKeys(toolByName('delete_document')!)).toEqual(new Set(['id', 'redirect']))
    expect(nonBodyKeys(toolByName('search_documents')!)).toEqual(
      new Set(['q', 'type', 'state', 'parentId', 'routed', 'limit', 'cursor', 'count']),
    )
  })
})
