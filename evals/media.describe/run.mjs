/**
 * Runs one `media.describe` case through Folio's own adapter, so the eval
 * exercises the request the library really sends.
 *
 * `client` is `{ apiKey, anthropicDescriber }`: the harness supplies the adapter
 * (it bundles `src/server/describe-anthropic.ts`, which is TypeScript and
 * imports JSON), and this file stays plain JavaScript so it also runs from
 * `node_modules/folio/evals`, where Node does not strip types.
 *
 * `input` is `input.json` plus `dir`, the case directory.
 *
 * Returns `{ output, usage, latencyMs, contractErrors }`. `contractErrors[].kind`
 * is `schema` (no JSON object in the answer), `truncated` (`max_tokens` hit),
 * `refused`, or `api` (a non-2xx: this is where a model that rejects a request
 * parameter shows up). `transient` marks an error worth one more attempt.
 *
 * @param {string} model
 * @param {{ dir: string, filename: string, contentType: string, image: string, tags: { id: string, name: string }[] }} input
 * @param {{ apiKey: string, anthropicDescriber: Function }} client
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function runCase(model, input, client) {
  const bytes = await readFile(join(input.dir, input.image));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const usages = [];
  const describe = client.anthropicDescriber({
    apiKey: client.apiKey,
    model,
    onUsage: (u) => {
      usages.push(u);
    },
  });
  const started = Date.now();
  const contractErrors = [];
  let output = null;
  try {
    output = await describe({
      id: input.filename,
      filename: input.filename,
      contentType: input.contentType,
      width: null,
      height: null,
      url: `https://example.invalid/${input.filename}`,
      inline: async () => ({ media: input.contentType, bytes: buffer }),
      tags: input.tags,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = usages[0]?.outcome;
    const status = /^anthropic: (\d{3}) /.exec(message)?.[1];
    contractErrors.push({
      kind:
        outcome === "truncated"
          ? "truncated"
          : outcome === "refused"
            ? "refused"
            : status
              ? "api"
              : "schema",
      message: message.slice(0, 300),
      transient: status !== undefined && (status === "429" || status.startsWith("5")),
    });
  }
  const usage = usages[0] ?? null;
  if (output && usage?.outcome === "truncated") {
    contractErrors.push({ kind: "truncated", message: "stop_reason max_tokens", transient: false });
  }
  return { output, usage, latencyMs: usage?.latencyMs ?? Date.now() - started, contractErrors };
}
