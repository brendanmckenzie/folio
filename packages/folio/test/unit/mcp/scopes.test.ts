import { describe, expect, it } from 'vitest'
import type { Role, Scope, TokenActor, UserActor } from '../../../src/server/auth/roles'
import { MCP_TOOLS, toolsFor } from '../../../src/server/mcp/tools'

/**
 * **A tool you cannot call does not appear** (`mcp-server.md` decision 6), one
 * scope at a time.
 *
 * The tool list is the only place an agent learns what it may do, so a list that
 * overstates the grant is a lie told at the one moment the agent is deciding what
 * to attempt. The filter is `allows`, which is `hasScope` for a token and a role
 * comparison for a person — one predicate, so a session cookie needs no special
 * case.
 *
 * Watch `IMPLIES` (`auth/roles.ts`): it is spelled out rather than derived
 * because the relationships are **not a chain**. `publish` implies reading the
 * draft it is about to publish and says nothing about writing one, and
 * `assets:write` implies nothing about content at all.
 */

const token = (...scopes: Scope[]): TokenActor => ({
  kind: 'token',
  id: 'tok_1',
  name: 'claude',
  scopes,
})

const user = (role: Role): UserActor => ({
  kind: 'user',
  id: 'usr_1',
  name: 'Sam',
  colour: '#000',
  role,
  session: 'ses_1',
  expiresAt: Date.now() + 60_000,
})

const named = (actor: Parameters<typeof toolsFor>[0]) => toolsFor(actor).map((tool) => tool.name)

const READS = ['get_schema', 'search_documents', 'query_documents', 'get_document', 'list_versions']
const WRITES = [
  'create_document',
  'write_content',
  'patch_fields',
  'move_document',
  'duplicate_document',
  'restore_version',
]

describe('tools/list, per token scope', () => {
  it('offers nothing at all with no actor', () => {
    // An MCP client probes before it is configured: `initialize` succeeds and
    // this is empty, which is the honest answer rather than "the server is
    // broken".
    expect(named(null)).toEqual([])
  })

  it('content:read — every read, and no write, publish or delete', () => {
    const offered = named(token('content:read'))
    expect(offered).toEqual(READS)
    for (const name of [...WRITES, 'publish_document', 'delete_document', 'upload_asset']) {
      expect([name, offered]).toEqual([name, expect.not.arrayContaining([name])])
    }
  })

  it('content:read:draft — the same list, because reads are gated at content:read', () => {
    // `IMPLIES` grants `content:read` from `content:read:draft`, and no tool
    // declares `READ_DRAFT` today: the draft read is `get_document`'s
    // `?status=draft`, checked inside the route by `ensureAccess` rather than at
    // its mount, so the *tool* is offered at `content:read` and the narrower
    // read is refused by the route if the scope is missing.
    expect(named(token('content:read:draft'))).toEqual(READS)
  })

  it('content:write — the reads and the writes, and still not delete', () => {
    const offered = named(token('content:write'))
    expect(offered).toEqual([...READS, ...WRITES])
    expect(offered).not.toContain('delete_document')
    expect(offered).not.toContain('publish_document')
    expect(offered).not.toContain('upload_asset')
  })

  it('publish — publish and unpublish, plus the reads it implies, but no writes', () => {
    const offered = named(token('publish'))
    expect(offered).toEqual([...READS, 'publish_document', 'unpublish_document'])
    for (const name of WRITES) {
      expect([name, offered]).toEqual([name, expect.not.arrayContaining([name])])
    }
  })

  /**
   * **The whole reason `assets:write` is a separate scope**: it implies nothing
   * about content, so a token minted to push images cannot read a page.
   */
  it('assets:write — upload_asset and nothing else', () => {
    expect(named(token('assets:write'))).toEqual(['upload_asset'])
  })

  it('admin — every tool in the table', () => {
    expect(named(token('admin'))).toEqual(MCP_TOOLS.map((tool) => tool.name))
  })

  it('adds up: two scopes are the union of what each grants', () => {
    expect(named(token('content:write', 'publish'))).toEqual([
      ...READS,
      ...WRITES,
      'publish_document',
      'unpublish_document',
    ])
  })
})

describe('tools/list, per session role', () => {
  /**
   * A `UserActor` arrives by session cookie and is filtered through the same
   * `Access` pair, by role rather than by scope. The roles are a total order, so
   * this is a ladder where the scopes are not.
   */
  it('viewer reads, editor writes, publisher publishes, admin deletes', () => {
    expect(named(user('viewer'))).toEqual(READS)

    const editor = named(user('editor'))
    expect(editor).toContain('write_content')
    expect(editor).toContain('upload_asset')
    // `MANAGE` is `publisher`+ because moving or renaming changes a URL the site
    // already serves.
    expect(editor).not.toContain('move_document')
    expect(editor).not.toContain('publish_document')

    const publisher = named(user('publisher'))
    expect(publisher).toContain('move_document')
    expect(publisher).toContain('publish_document')
    expect(publisher).not.toContain('delete_document')

    expect(named(user('admin'))).toEqual(MCP_TOOLS.map((tool) => tool.name))
  })
})
