/**
 * The tool table: what `{base}/mcp` offers an agent, and which v1 route each
 * tool *is* (`../../../../docs/specs/platform/mcp-server.md` decision 2).
 *
 * **Declarative on purpose, and this is the file a new tool is added to.** A row
 * names a method, a path under `{base}/api/v1`, how its arguments reach that
 * path, and the access it needs. Nothing here implements anything: the handler
 * builds a `Request` from the row and calls the mounted app's own `fetch`, so the
 * v1 route runs with its own middleware, its own validator, its own gate and its
 * own error envelope. **A verb that is not a v1 route cannot be a tool**, and a
 * tool cannot quietly reach further than the API does.
 *
 * **Fifteen rows, not one per block type** (decision 7). MCP clients discover a
 * tool list once per session and cache it, so a list generated from a host's
 * manifest changes shape when the host deploys a block and two sessions against
 * one site disagree about what exists. `get_schema` reports the fields;
 * `write_content` takes them.
 *
 * **`preview_document` is the sixteenth row and is not here yet.** It is the one
 * tool in the spec's table that is *not* a v1 route — it is `?_folio=draft` plus
 * a `browser` binding — and both belong to phases 4 and 5. When it lands, the
 * `method`/`path` pair becomes optional and `test/unit/mcp/tools.test.ts`'s
 * round-trip has to skip a tool that has none.
 */
import {
  type Access,
  type Actor,
  ADMIN,
  allows,
  ASSETS,
  CREATE,
  EDIT,
  MANAGE,
  PUBLISH,
  READ,
} from '../auth/roles'
import { FolioError } from '../errors'

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

/** As much JSON Schema as an `inputSchema` needs, and no more. */
export interface JsonSchema {
  /**
   * A list rather than one name where the route genuinely accepts either — a
   * body field read through `v.nullish(ID)` takes `null` as a value, and a
   * client that validates arguments against this schema has to be told so.
   */
  type?: JsonType | readonly JsonType[]
  description?: string
  enum?: readonly string[]
  items?: JsonSchema
  properties?: Readonly<Record<string, JsonSchema>>
  required?: readonly string[]
  additionalProperties?: boolean
}

export type ToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface McpTool {
  /** What a client calls. Snake case, verb first, as every MCP server spells it. */
  name: string
  description: string
  /** MCP's own name for the JSON Schema of a tool's arguments. */
  inputSchema: JsonSchema
  method: ToolMethod
  /** The path under `{base}/api/v1`. Every `:name` is filled from that argument. */
  path: string
  /** Arguments that travel as query parameters. An array argument repeats the key. */
  query?: readonly string[]
  /**
   * Boolean arguments whose route spells "on" as `1` rather than `true`.
   * `search_documents`' `count` alone — `GET /search` reads `count === '1'`, and
   * a tool should not make a model remember that.
   */
  flags?: readonly string[]
  /**
   * How the remaining arguments become the request body. Absent sends none.
   * `base64` is `upload_asset` alone, whose route reads raw bytes off the body
   * (`routes/api/index.ts`) — JSON-RPC cannot carry bytes, so the `data`
   * argument is base64 and is decoded here.
   */
  body?: 'json' | 'base64'
  /**
   * What `tools/list` filters on — **the same `Access` the route declares**, so
   * a token is filtered by scope and a session cookie by role with no special
   * case (decision 6, `auth/roles.ts`'s `allows`).
   */
  need: Access
  /**
   * Set only where `need` is *stricter* than the route's own gate, which makes
   * it a check the MCP layer has to make itself before dispatching. Exactly one
   * row: see `delete_document`.
   */
  narrowed?: true
  /**
   * Names from the site's own manifest to append to the description at list
   * time — a bounded list of strings, not their fields (decision 7), because
   * that is dynamic per session at zero cost and saves the agent a round trip
   * to learn what a document may contain. Phase 5 step 4 owns growing this.
   */
  manifest?: 'types' | 'blocks'
}

const ID: JsonSchema = { type: 'string', description: 'The document id.' }

/** The nested document shape `core/nested.ts` validates. Its fields come from `get_schema`. */
const CONTENT: JsonSchema = {
  type: 'object',
  description:
    "The document in Folio's nested shape: `{ type, fields }`, where a `blocks` field holds an array of the same shape. Call get_schema for the fields each block declares. A payload that does not fit is refused with the path and reason.",
}

export const MCP_TOOLS: readonly McpTool[] = [
  /* --------------------------------------------------------------- reads --- */
  {
    name: 'get_schema',
    description:
      'The site manifest: every document type, every block and the fields it declares, and the configured locales. Read this before writing content.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    method: 'GET',
    path: '/schema',
    need: READ,
  },
  {
    name: 'search_documents',
    description:
      'Find documents by title, slug or path, including drafts that have never been published. This is how "the pricing page" becomes an id. Keyset-paged: pass the previous answer\'s `cursor` for the next page.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Substring of the title, slug or path.' },
        type: { type: 'string', description: 'A declared document type name.' },
        state: {
          type: 'string',
          // Exactly `StoryState`'s four names, which the route screens with a
          // picklist (`validate.ts`'s `STORY_STATE`). `live` rather than
          // `published` is the trap here: an advertised `published` would be the
          // obvious value for a model to send and a `bad_request` every time —
          // an `enum` in an input schema is a second copy of the route's
          // validation, which is the fork decision 2 exists to prevent, so
          // `tools.test.ts` pins this list against the picklist itself.
          enum: ['draft', 'unpublished', 'live', 'changed'],
          description:
            'Lifecycle state: `draft` (never published), `live` (published, no newer draft), `changed` (published with unpublished edits), `unpublished` (taken down).',
        },
        parentId: {
          type: 'string',
          description: 'Children of this document. Empty string means the top level.',
        },
        routed: {
          type: 'boolean',
          description: 'true for pages (documents with a URL), false for records.',
        },
        limit: { type: 'integer', description: 'Rows per page, up to 100. Default 20.' },
        cursor: { type: 'string', description: "The previous answer's `cursor`." },
        count: { type: 'boolean', description: 'Include a `total` for the whole result set.' },
      },
      additionalProperties: false,
    },
    method: 'GET',
    path: '/search',
    query: ['q', 'type', 'state', 'parentId', 'routed', 'limit', 'cursor'],
    flags: ['count'],
    need: READ,
    manifest: 'types',
  },
  {
    name: 'query_documents',
    description:
      'Query *published* content by indexed field: the primitive behind a news list or a product grid. Page-numbered. Drafts are invisible here — use search_documents for those.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'A declared document type name.' },
        parent: {
          type: 'string',
          description: 'Children of this document id. Empty string means the top level.',
        },
        locale: { type: 'string', description: 'Read every field in this locale.' },
        where: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filters, each `field:op:value` — e.g. `price:lt:100`. Only a field the root block declares `indexed` may be named; anything else is refused naming the field.',
        },
        order: { type: 'string', description: '`field` or `field:asc|desc`.' },
        page: { type: 'integer', description: '1-based page number.' },
        perPage: { type: 'integer', description: 'Rows per page.' },
      },
      additionalProperties: false,
    },
    method: 'GET',
    path: '/documents',
    query: ['type', 'parent', 'locale', 'where', 'order', 'page', 'perPage'],
    need: READ,
    manifest: 'types',
  },
  {
    name: 'get_document',
    description:
      "One document's content in the nested shape. `status: draft` reads the live draft — what an editor is looking at — and needs the content:read:draft scope; without it the published snapshot is returned.",
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        status: { type: 'string', enum: ['published', 'draft'], description: 'Default published.' },
        locale: {
          type: 'string',
          description:
            'Read every field in this locale and drop the translations. Omit to get the authoring shape, which is the one that can be written back.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'GET',
    path: '/documents/:id',
    query: ['status', 'locale'],
    need: READ,
  },
  {
    name: 'list_versions',
    description:
      "A document's version history, newest first: every publish and every named checkpoint, with who made it. A version id from here is what restore_version takes.",
    inputSchema: {
      type: 'object',
      properties: { id: ID, perPage: { type: 'integer', description: 'Up to 200. Default 50.' } },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'GET',
    path: '/documents/:id/versions',
    query: ['perPage'],
    need: READ,
  },

  /* -------------------------------------------------------------- writes --- */
  {
    name: 'create_document',
    description:
      'Create a document. A slug is derived from the title unless one is given; `parentId` places it in the page tree. Creating the same title twice under one parent is refused as a conflict rather than making two pages.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The document title.' },
        slug: { type: 'string', description: 'URL segment. Derived from the title if absent.' },
        parentId: {
          // `['string', 'null']`, not `'string'`: the route reads this one out of
          // a JSON body through `v.nullish(ID)`, so `null` is the real value for
          // the top level rather than a way of describing its absence. A client
          // that validates arguments against this schema would otherwise reject
          // the correct value before it was ever sent.
          type: ['string', 'null'],
          description: 'Parent document id, or null for the top level.',
        },
        type: { type: 'string', description: 'A declared document type name.' },
        content: CONTENT,
      },
      required: ['title'],
      additionalProperties: false,
    },
    method: 'POST',
    path: '/documents',
    body: 'json',
    need: CREATE,
    manifest: 'types',
  },
  {
    name: 'write_content',
    description:
      "Write a document's content. `merge` (the default) leaves fields the payload does not mention alone, so a partial payload is safe; `replace` discards anything it was not told about. The write appears live in any open editor, lands in the activity trail under this token's name, and is undoable there.",
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        content: CONTENT,
        mode: { type: 'string', enum: ['merge', 'replace'], description: 'Default merge.' },
      },
      required: ['id', 'content'],
      additionalProperties: false,
    },
    method: 'PUT',
    path: '/documents/:id/content',
    body: 'json',
    need: EDIT,
    manifest: 'blocks',
  },
  {
    name: 'patch_fields',
    description:
      "Set named fields and nothing else — no structure is touched, so no block can be reordered or removed by accident. `fields` names the document's own root block; `bloks` names any other by uid. This is the tool for a copy change.",
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        fields: {
          type: 'object',
          description: "Field name to value, on the document's root block.",
        },
        bloks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { uid: { type: 'string' }, fields: { type: 'object' } },
            required: ['uid', 'fields'],
          },
          description: 'Per-block writes, addressed by the uid get_document reports.',
        },
        locale: {
          type: 'string',
          description: 'Write every field in this locale instead of the source one.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'PATCH',
    path: '/documents/:id/fields',
    body: 'json',
    need: EDIT,
  },
  {
    name: 'move_document',
    description:
      "A document's title, slug, parent and position in the tree — the URL and the structure, not the content. Moving or renaming a live page changes what the site serves, so this needs more than editing does.",
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        title: { type: 'string' },
        slug: { type: 'string' },
        // Nullable for the same reason as `create_document`'s: a JSON body field
        // whose route reads it through `v.nullish(ID)`.
        parentId: {
          type: ['string', 'null'],
          description: 'New parent id, or null for the top level.',
        },
        index: { type: 'integer', description: 'Position among its siblings, from 0.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'PATCH',
    path: '/documents/:id',
    body: 'json',
    need: MANAGE,
  },
  {
    name: 'duplicate_document',
    description:
      'Copy a document and its content. The copy is a draft; an absent title becomes "<title> (copy)" and an absent parent is the source\'s own. Position it afterwards with move_document.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        title: { type: 'string' },
        parentId: { type: 'string', description: "Defaults to the source's parent." },
      },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'POST',
    path: '/documents/:id/duplicate',
    body: 'json',
    need: CREATE,
  },
  {
    name: 'restore_version',
    description:
      'Restore a version of a document: its content is diffed against the live draft and committed, so it is one undo step in the editor rather than an overwrite. A version stored before a schema migration is migrated on read, so no stale field key comes back.',
    inputSchema: {
      type: 'object',
      properties: { id: ID, versionId: { type: 'string', description: 'From list_versions.' } },
      required: ['id', 'versionId'],
      additionalProperties: false,
    },
    method: 'POST',
    path: '/documents/:id/restore',
    body: 'json',
    need: EDIT,
  },
  {
    name: 'publish_document',
    description:
      'Publish the draft: the document becomes what the site serves, and a version is recorded. Publishing an unchanged draft is harmless.',
    inputSchema: {
      type: 'object',
      properties: { id: ID },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'POST',
    path: '/documents/:id/publish',
    need: PUBLISH,
  },
  {
    name: 'unpublish_document',
    description:
      'Take a document down. The draft and its history survive; the page stops being served. Unpublishing something already down does nothing.',
    inputSchema: {
      type: 'object',
      properties: { id: ID },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'POST',
    path: '/documents/:id/unpublish',
    need: PUBLISH,
  },
  {
    /**
     * **`admin`, not `MANAGE`'s `content:write`.** A deliberate narrowing of the
     * same kind `POST /documents/:id/versions` already makes: the route is
     * reachable by a `content:write` token and this *tool* is not, because a
     * delete is the one action in the table whose mistake is not recoverable by
     * another tool call. A script that means to delete asks for `admin`; an
     * assistant helping with copy does not (owner checkpoint 3, which resolved
     * "no confirmation argument" by putting the tool behind `admin` instead).
     *
     * This is the one place the MCP layer gates a call itself rather than
     * letting the route refuse it — hence `narrowed`. Everywhere else, a tool
     * absent from `tools/list` that is called by name anyway is refused by the
     * route's own `forbidden`, which is the whole point of decision 2.
     */
    name: 'delete_document',
    description:
      'Delete a document and its descendants, their versions and their index rows. A redirect is left behind for each deleted path unless `redirect` is false. This cannot be undone by another tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        redirect: {
          type: 'boolean',
          description: 'Leave a redirect for each deleted path. Default true.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'DELETE',
    path: '/documents/:id',
    query: ['redirect'],
    need: ADMIN,
    narrowed: true,
  },
  {
    name: 'upload_asset',
    description:
      'Upload an image or file to the media library and get back the value an `asset` field takes. Bytes are base64 in `data`, because JSON-RPC cannot carry them any other way.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Original filename, including its extension.' },
        data: { type: 'string', description: 'The file bytes, base64-encoded.' },
      },
      required: ['filename', 'data'],
      additionalProperties: false,
    },
    method: 'POST',
    path: '/assets',
    query: ['filename'],
    body: 'base64',
    need: ASSETS,
  },
]

/** A tool by name, over the **whole** table rather than a filtered list. */
export function toolByName(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name)
}

/**
 * The tools this actor may call: `allows` per row, and nothing else.
 *
 * One predicate for both currencies, so a token is filtered by scope and a
 * person by role with no special case (decision 6). The `auth: 'open'`
 * short-circuit is **not** here — it belongs to the route, beside every other
 * gate that reads the mode, so this stays a pure function of the actor.
 */
export function toolsFor(actor: Actor | null): readonly McpTool[] {
  return MCP_TOOLS.filter((tool) => allows(actor, tool.need))
}

/**
 * `:name` segments filled from the arguments, each encoded.
 *
 * A missing one is `bad_request` — which `rpcCodeFor` turns into JSON-RPC's
 * *invalid params* — rather than a plain `Error`, because nothing validates a
 * tool's `inputSchema` on the way in: MCP's schema is advertised to the client
 * so it can build a well-formed call, and the server still has to answer a
 * malformed one legibly. Everything past the path is screened by the v1 route's
 * own validator, which is the only copy of that logic (decision 2).
 */
export function fillPath(path: string, args: Readonly<Record<string, unknown>>): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => {
    const value = args[key]
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new FolioError('bad_request', `${key} is required`)
    }
    return encodeURIComponent(String(value))
  })
}

/** The argument names a tool sends anywhere other than the request body. */
export function nonBodyKeys(tool: McpTool): Set<string> {
  const keys = new Set<string>([...(tool.query ?? []), ...(tool.flags ?? [])])
  for (const match of tool.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1]!)
  return keys
}
