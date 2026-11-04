/**
 * The smallest MCP client the CLI needs: one JSON-RPC request over a plain POST.
 *
 * Revision `2026-07-28` has no handshake, so every request declares its version in
 * an `MCP-Protocol-Version` header that agrees with the body's `_meta`, plus
 * `Mcp-Method` and, for a `tools/call`, `Mcp-Name` (as `scripts/mcp-test.mjs`
 * does). The revision is a literal because nothing in `bin/` may import `src/`;
 * `mcp.test.ts` pins it to `MCP_PROTOCOL_VERSION` in `src/server/mcp/rpc.ts`.
 */

export const MCP_VERSION = "2026-07-28";

let nextId = 0;

/**
 * @param {{ endpoint: string, method: string, params?: object, token?: string | null,
 *   fetch?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<{ status: number, json: any, text: string }>} status 0 when nothing answered
 */
export async function rpc({
  endpoint,
  method,
  params = {},
  token,
  fetch = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": MCP_VERSION,
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": params.name } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++nextId,
        method,
        params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_VERSION } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.message ?? err) };
  }
}
