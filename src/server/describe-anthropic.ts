/**
 * The one adapter, and the only place in Folio that names a vendor
 * (`../../docs/specs/content-model/media-library.md` decision 8).
 *
 * **This is a convenience over the seam, not a second seam.** `describe.fn` is
 * and stays a host function; this returns one. It has no privileged access to
 * anything — no binding, no runtime, no D1 — and a host that deletes it and
 * writes twenty lines of their own `fn` loses nothing but the twenty lines.
 * That is what keeps the vendor out of the design: `types.ts`'s `FolioDescribe`
 * would be identical if this file did not exist.
 *
 * ```ts
 * import { anthropicDescriber, createFolio } from 'folio/server'
 *
 * createFolio({
 *   // …
 *   describe: { fn: anthropicDescriber({ apiKey: env.ANTHROPIC_API_KEY }) },
 * })
 * ```
 *
 * **Never run against a live model.** Every test of this file uses a stubbed
 * `fetch`, because no API key exists in the repository and a suite that needed
 * one would be a suite nobody could run. The request shape below is written
 * from the documented Messages API and the response reader is written to
 * survive being wrong about it — but *proven* it is not, and the README says so
 * where a host will read it. Treat the first live run as the test.
 *
 * Three things it deliberately does not do:
 *
 *  - **No SDK.** `@anthropic-ai/sdk` is the documented way to call this API and
 *    it is the right choice in an application. This is a library whose
 *    `folio/server` entry every host Worker imports, built with
 *    `--packages=external`, so a dependency here is a dependency in every
 *    deployment — including the majority that configure no `describe` at all —
 *    and it is megabytes against a Worker size limit for one POST to one
 *    endpoint. A host who wants the SDK writes `fn` with it in four lines.
 *  - **No retry, no timeout.** Both are policy, and decision 8's whole argument
 *    is that Folio owns none: a retry budget belongs to whoever is paying for
 *    the calls. A failure is *recorded* (`describe_error`) and the asset stays
 *    reachable through the backlog filter, which is the retry. A host who wants
 *    a deadline wraps this function in one.
 *  - **No clamping.** Whatever comes back is handed on raw and
 *    `server/describe.ts` clamps, truncates and type-checks it — that file's
 *    "a model is a caller" rule holds for every `fn`, and an adapter that
 *    pre-cleaned its own output would be the one path where it is enforced
 *    twice and could drift.
 */
import type { DescribeInput, DescribeResult } from './types'

/**
 * The default, and it is the most capable model rather than the cheapest.
 *
 * Picking a cheaper one for a host would be Folio deciding what their alt text
 * is worth, which is the same overreach decision 8 refuses at every other
 * level. `model` is the first option for exactly this reason: a library of
 * forty thousand photographs is a real bill, and a smaller model is very
 * probably right for it — but that is the host's call, made once, in their own
 * config, with their own invoice in front of them.
 */
export const DEFAULT_DESCRIBE_MODEL = 'claude-opus-5'

/** The endpoint, and the API version it is pinned to. */
const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

/**
 * Enough for alt text, a paragraph and a handful of tags, and nowhere near
 * enough for a model that decided to write an essay. `DescribeResult` is
 * clamped to 500 + 2000 characters downstream, so a larger ceiling would only
 * buy tokens that are thrown away.
 */
const MAX_TOKENS = 1024

/**
 * The default prompt: alt text, a description, and tags **from the list**.
 *
 * The vocabulary constraint is repeated because it is the one instruction that
 * cannot be enforced by the request — `server/describe.ts`'s `matchTags` drops
 * anything unmatched and counts it, so a model that invents freely costs money
 * and produces `tagsIgnored`, which is a fine safety net and a poor prompt.
 *
 * The two text fields are told apart in the words an editor would use, because
 * a model handed "alt" and "description" with no distinction writes the same
 * sentence twice: alt text is what a screen reader says *instead of* the image,
 * and a description is what the file is, for somebody searching a library.
 */
export const DEFAULT_DESCRIBE_PROMPT = `You are describing an image for a content management system's media library.

Answer with a single JSON object and nothing else — no prose before it, no code fence around it:

{"alt": "…", "description": "…", "tags": ["…"]}

- "alt": alt text for the image, at most a sentence. Write what a screen reader should say in place of the picture: the content and function of the image, not the fact that it is an image. Do not begin with "Image of" or "Photo of". Leave it out if the image is purely decorative.
- "description": one or two sentences saying what the file is, for somebody searching a library of thousands. Include what a filename cannot: who or what is in it, the setting, the occasion, any legible text.
- "tags": choose only from the tag list given below, copying each name exactly. Choose every tag that genuinely applies and none that do not. If none apply, answer an empty array. Never invent a tag that is not on the list — an invented tag is discarded, so it costs the user money and describes nothing.`

export interface AnthropicDescriberOptions {
  /**
   * The host's own API key. Folio stores it nowhere, logs it nowhere and sends
   * it to exactly one URL. Read it from a Worker secret, never from the config
   * file itself.
   */
  apiKey: string
  /** Defaults to {@link DEFAULT_DESCRIBE_MODEL}. */
  model?: string
  /**
   * Replaces {@link DEFAULT_DESCRIBE_PROMPT} entirely rather than adding to it.
   * A prompt is one instruction, and merging two would give a host no way to
   * remove a sentence they disagree with. **A replacement must still ask for
   * the JSON object above**, because that is what the reader below parses.
   */
  prompt?: string
}

/**
 * Builds a `describe.fn`.
 *
 * The returned function takes only the input: `env` is the second parameter of
 * the seam and this adapter has no use for it, having been handed its key at
 * construction.
 */
export function anthropicDescriber(
  options: AnthropicDescriberOptions,
): (input: DescribeInput) => Promise<DescribeResult> {
  const { apiKey } = options
  const model = options.model ?? DEFAULT_DESCRIBE_MODEL
  const prompt = options.prompt ?? DEFAULT_DESCRIBE_PROMPT
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new Error('anthropicDescriber: `apiKey` is required')
  }

  return async function describeWithAnthropic(input: DescribeInput): Promise<DescribeResult> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        // The instruction and the vocabulary go in `system`, the image in the
        // message: the first two are identical for every asset in a run and
        // the third is not, which is the order a cached prefix wants
        // (system before messages) even though nothing here asks for one.
        //
        // Nothing else is sent. No `thinking`, no `output_config.effort`, no
        // beta header — because `model` is the host's, and every one of those
        // is refused by *some* model a host might reasonably name. An adapter
        // that 400s on the cheap model somebody chose to afford the run is
        // worse than one that leaves a knob unturned.
        system: `${prompt}\n\n${vocabularyOf(input.tags)}`,
        messages: [
          {
            role: 'user',
            content: [
              await imageBlock(input),
              { type: 'text', text: `The file is named ${input.filename}.` },
            ],
          },
        ],
      }),
    })

    if (!res.ok) {
      // The body is the useful half — an invalid key, a rate limit and an
      // unsupported model are all told apart by it — and it is bounded here
      // because `describe_error` is a column somebody reads in a table.
      throw new Error(`anthropic: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }

    const body = (await res.json()) as AnthropicMessage
    // A refusal is a 200 with nothing usable in it. Recorded as a failure
    // rather than as an empty result: an empty result would stamp
    // `described_at` with no error and quietly retire the asset from the
    // backlog, which is exactly the row somebody wants to find again.
    if (body.stop_reason === 'refusal') {
      throw new Error(`anthropic: the model declined (${body.stop_details?.category ?? 'refusal'})`)
    }

    return parseDescribeJson(textOf(body))
  }
}

/* ----------------------------------------------------------- the request --- */

/**
 * The vocabulary, as the prompt sees it.
 *
 * Names rather than slugs, because a name is what an editor typed and what a
 * model reads best — `matchTags` slugifies whatever comes back, so "Head Shot"
 * finds the tag whose slug is `head-shot` either way.
 */
function vocabularyOf(tags: DescribeInput['tags']): string {
  if (tags.length === 0) {
    return 'No tags exist in this library yet. Answer an empty array for "tags".'
  }
  return `The only tags that exist in this library are:\n${tags.map((tag) => `- ${tag.name}`).join('\n')}`
}

/**
 * The image, as bytes.
 *
 * **Never as a URL.** Handing the Messages API a URL to fetch was the original
 * design and it does not survive the platform Folio runs on: that fetch comes
 * from Anthropic's network as `Claude-User`, Cloudflare's AI-crawler blocking is
 * a user-agent list, and a content site is right to be on it. The first host to
 * press *Describe* got a 403 from their own WAF, reported as `anthropic: 400
 * Unable to download the file` — a paid call refused by the site paying for it,
 * with an error naming neither party. Verified against `allaboutafrica.au` on
 * 2026-09-07: `curl` 200 and `Claude-User/1.0` 403, same URL, same second.
 *
 * The old comment called that "a deployment that is routable but not readable"
 * and handed it to the host to write their own `fn`. Wrong owner: it is the
 * default posture of the only platform Folio targets, and it fails identically
 * for every host who ever ticks the box.
 *
 * `input.inline()` does the reading, and the memory objection the URL path was
 * built on goes with it — what comes back is a 512px WebP wherever an Images
 * binding exists, a couple of hundred kilobytes rather than twenty megabytes,
 * transformed in the isolate from the R2 stream. A first pass had *this* file
 * fetch `input.url` instead, which looks equivalent and is not: a Worker
 * fetching its own asset route needs an `image-resizing` loop guard, and when
 * the self-fetch failed the only thing left to send was the full-size original.
 * `describe.ts`'s `renditionOf` carries that story.
 */
async function imageBlock(input: DescribeInput): Promise<unknown> {
  const { media, bytes } = await input.inline()
  if (!INLINE_TYPES.has(media)) {
    throw new Error(`anthropic: ${media} cannot be sent inline`)
  }
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new Error(
      `anthropic: the image is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, over the API's 5MB limit — configure an Images binding so Folio can send a resized rendition`,
    )
  }
  return { type: 'image', source: { type: 'base64', media_type: media, data: base64(bytes) } }
}

/**
 * What the API accepts as inline bytes. Narrower than what Folio stores —
 * `uploadAsset` also admits AVIF and SVG — and with a binding configured it is
 * almost always moot, because the rendition is WebP whatever went in. It bites
 * on the no-binding path, where a message naming the type beats a 400 from
 * somebody else's API.
 */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * The API's per-image ceiling, checked before the call rather than after.
 *
 * A round trip to be told something `byteLength` already knows is a wasted
 * request, and the resulting 400 reads like a bug in Folio. Reachable in
 * practice only without an Images binding, or when a transform failed and the
 * original stood in — so the message names the binding that would have avoided
 * both.
 */
const MAX_INLINE_BYTES = 5 * 1024 * 1024

/** `btoa` takes a binary string, and a 20MB `apply(...)` overflows the stack. */
function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/* ---------------------------------------------------------- the response --- */

/** Only the fields this file reads. Not a mirror of the API's response. */
interface AnthropicMessage {
  content?: unknown
  stop_reason?: string
  stop_details?: { category?: string } | null
}

function textOf(body: AnthropicMessage): string {
  if (!Array.isArray(body.content)) return ''
  return body.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
}

/**
 * The model's JSON, read forgivingly.
 *
 * **Forgiving about the wrapping, strict about the absence.** A model that
 * answers "Here is the JSON:" and then a fenced block has done what was asked
 * and formatted it politely; throwing that away over a code fence would spend a
 * call and store nothing. A model that answers no object at all has failed, and
 * that has to be a `describe_error` rather than a silent empty result — an
 * empty result stamps `described_at`, retires the row from the backlog and
 * leaves nothing to find it by.
 *
 * The braces are matched from the first `{` to the *last* `}` rather than by
 * counting, which is enough for one object and is not a JSON parser. If the
 * span does not parse, that is the failure.
 *
 * Nothing is validated beyond "it is an object": `DescribeResult`'s three
 * fields are all optional, and `describeAsset` type-checks, clamps and matches
 * every one of them. Repeating that here is the drift.
 */
export function parseDescribeJson(text: string): DescribeResult {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`anthropic: no JSON object in the answer (${text.slice(0, 200)})`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error(`anthropic: the answer was not JSON (${text.slice(start, start + 200)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('anthropic: the answer was not a JSON object')
  }

  const { alt, description, tags } = parsed as DescribeResult
  return { alt, description, tags }
}
