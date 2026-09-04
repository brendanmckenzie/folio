/**
 * `preview_document`: the one tool that is not a v1 route
 * (`../../../docs/specs/platform/mcp-server.md` decisions 5, 5a, phase 5).
 *
 * **No test here can observe an image.** Browser Rendering — Cloudflare's
 * product has since renamed itself "Browser Run" — is not simulated by
 * miniflare, the same position `platform/caching.md` is in with Workers Cache.
 * So this file is split on exactly that line: `resolveViewport`, `clipSelector`
 * and `chooseTarget` are pure and unit-tested directly; `captureScreenshot` is
 * the one function that reaches the binding and cannot be exercised for real
 * outside a deployment; `previewDocument` orchestrates the two and is exercised
 * in `test/workers/mcp.test.ts` for everything **except** what a screenshot
 * shows.
 *
 * **No new runtime dependency.** Driving Browser Rendering used to mean
 * `@cloudflare/puppeteer` — a real package, a real dependency, and decision 9
 * rejected the MCP SDK partly on exactly that kind of weight. It turns out not
 * to be necessary: the `browser` binding now answers a `quickAction()` method
 * directly (Cloudflare's "Quick Actions" surface, shipped after the spec was
 * written), which takes a URL and screenshot options and hands back a plain
 * `Response` carrying the PNG — no browser automation library, no CDP client,
 * nothing to install. `BrowserRun`'s type ships in `@cloudflare/workers-types`,
 * already a devDependency for every other binding in `ReadBindings`. So
 * `ReadBindings.browser?: BrowserRun` costs Folio nothing new at all, not even
 * an optional peer dependency — the ambient type is free, and the binding
 * itself is the host's own opt-in `wrangler.jsonc` entry.
 *
 * One real limit, worth stating because it explains a test result rather than
 * a bug: `quickAction()` is not simulated locally either (Cloudflare's own
 * docs: "not yet supported in local development mode" short of `remote: true`,
 * and even then the browser is remote and cannot reach `localhost`). So
 * against `pnpm dev` this always takes the no-binding shape of the answer,
 * which is exactly `scripts/mcp-test.mjs`'s premise.
 */
import type { Blok } from '../../core/doc'
import type { DocumentKind } from '../../core/schema'
import type { StoryMeta } from '../../core/story'
import { FolioError } from '../errors'
import { previewPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import { storyById } from '../stories'
import type { ReadBindings } from '../types'

/* -------------------------------------------------------------- viewport --- */

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const

export interface Viewport {
  width: number
  height: number
}

/** A pixel dimension outside this range has an obvious right answer — the
 * nearest one in range — rather than being a caller error, the same reasoning
 * `validate.ts`'s `limitParam` gives for a query-string limit. */
export const MIN_DIMENSION = 200
export const MAX_DIMENSION = 4000

/**
 * Defaulted and clamped. `1440×900` rather than the binding's own `1920×1080`
 * default, because the point of this tool is catching a responsive break —
 * `viewport` exists so an agent can pass a mobile size instead — and a
 * full-width desktop default would make the mobile case the one that needs an
 * argument rather than the other way round.
 */
export function resolveViewport(input?: { width?: unknown; height?: unknown } | null): Viewport {
  return {
    width: clampDimension(input?.width, DEFAULT_VIEWPORT.width),
    height: clampDimension(input?.height, DEFAULT_VIEWPORT.height),
  }
}

function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.round(value), MIN_DIMENSION), MAX_DIMENSION)
}

/* ---------------------------------------------------------------- clip --- */

/**
 * `[data-folio-uid="…"]` — the selector `preview/mount.tsx`'s own
 * `markSelected` already relies on to find a block in the editor, and the same
 * one `draft` mode's render puts on a host element (`preview/Render.tsx`,
 * decision 5a).
 *
 * A real uid is always `newUid()`'s sixteen lowercase hex characters, so this
 * never actually needs to escape anything: `previewDocument` only calls it
 * after confirming the uid is a key in the draft `Doc`, which guarantees that
 * shape. The escaping below is defence in depth for a string about to leave
 * the Worker as part of a request to a remote service, not a load-bearing
 * screen — there is no injection to defend against once the key lookup has
 * already succeeded.
 */
export function clipSelector(uid: string): string {
  return `[data-folio-uid="${uid.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

/* -------------------------------------------------------------- target --- */

export type PreviewTarget =
  | { kind: 'page'; url: string }
  | { kind: 'global'; url: string }
  | { kind: 'none' }

/**
 * `draftUrl` when the document has one (`withUrls`, decision 5) — a routed
 * page. Otherwise, for a declared **global** (a singleton), the bare preview
 * at `{base}/preview/global/:name`, put into `draft` mode by the query
 * parameter that route now reads (phase 4's review, item 1: it was still
 * hard-coded to `preview`, which is the editing chrome the whole point of this
 * tool exists to avoid photographing). A plain **record** has no page and no
 * bare preview — nothing to render, so `'none'`.
 *
 * Built from `base`, the story's own `type` and `withUrls`'s own output, never
 * by concatenating anything a caller sent onto a path — which is what keeps
 * `?as=` and every other query parameter unreachable through this tool
 * (edge cases: "not reachable through the tool... never by concatenating
 * caller input onto a path").
 */
export function chooseTarget(
  base: string,
  story: { draftUrl?: string | null; type: string },
  kind: DocumentKind | undefined,
): PreviewTarget {
  if (story.draftUrl) return { kind: 'page', url: story.draftUrl }
  if (kind === 'singleton') {
    return {
      kind: 'global',
      url: `${base}/preview/global/${encodeURIComponent(story.type)}?mode=draft`,
    }
  }
  return { kind: 'none' }
}

/** One sentence, honest about what a screenshot of this target actually shows
 * (phase 4 review: "say in the tool result what it photographed"). */
function captionFor(target: { kind: 'page' | 'global' }): string {
  return target.kind === 'page'
    ? "This shows the draft's content rendered on the host's block CSS inside Folio's own preview shell, not the host's real page layout — the document itself is node-for-node what the published page renders, but the chrome around it is Folio's approximation, not the host's."
    : "This is a bare preview of the global's own draft, alone on Folio's preview shell — a global has no page of its own to show it in context."
}

/* -------------------------------------------------------------- capture --- */

export interface CaptureOptions {
  url: string
  viewport: Viewport
  fullPage: boolean
  selector?: string
  /** `authorization`/`cookie`, copied from the caller — nothing else, the same
   * rule `routes/mcp.ts`'s internal dispatch follows for a v1 tool. */
  headers: Readonly<Record<string, string>>
}

/**
 * One `screenshot` Quick Action. Waits for the network to be idle before
 * capturing (`gotoOptions.waitUntil: 'networkidle0'`, stricter than the
 * binding's own `domcontentloaded` default) — the most likely defect an agent
 * asks about is a missing image, and a screenshot taken before the network
 * settles manufactures one. Safe to make strict here specifically because
 * `draft` mode ships no client entry and opens no socket (`pages.tsx`), so
 * there is nothing long-lived to keep the network from going idle.
 *
 * Throws on anything short of a 200 with image bytes — a selector matching no
 * element, a target the binding cannot reach (`localhost` in dev; Cloudflare's
 * browser is remote), or the service erroring all look the same from here.
 * `previewDocument` is where each is told apart.
 */
export async function captureScreenshot(
  browser: BrowserRun,
  opts: CaptureOptions,
): Promise<Uint8Array> {
  const res = await browser.quickAction('screenshot', {
    url: opts.url,
    viewport: { width: opts.viewport.width, height: opts.viewport.height },
    selector: opts.selector,
    gotoOptions: { waitUntil: 'networkidle0' },
    setExtraHTTPHeaders: opts.headers,
    // A selector is a clip to one element's own box; `fullPage` is a page-level
    // concept and the two together would be a contradiction the binding should
    // not be asked to resolve.
    screenshotOptions: opts.selector ? { type: 'png' } : { type: 'png', fullPage: opts.fullPage },
  })
  if (!res.ok) throw new Error(await browserErrorMessage(res))
  return new Uint8Array(await res.arrayBuffer())
}

async function browserErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { errors?: { message: string }[] }
    if (body.errors?.[0]?.message) return body.errors[0].message
  } catch {
    // Not JSON — the status is all there is to report.
  }
  return `Browser Rendering answered ${res.status}.`
}

/* --------------------------------------------------------- orchestration --- */

export interface PreviewDocumentContext {
  /** The dispatched request's own URL, so a relative preview URL (a host's
   * `route` may return one, and `{base}/preview/global/:name` always is)
   * becomes an absolute one a remote browser — or a person — can reach. */
  origin: string
  headers: Readonly<Record<string, string>>
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const text = (value: string): Content => ({ type: 'text', text: value })

async function renderDraftHtml(
  rt: FolioRuntime,
  bindings: ReadBindings,
  story: StoryMeta,
  target: PreviewTarget & { kind: 'page' | 'global' },
): Promise<string> {
  const res = await previewPage(
    rt,
    bindings,
    story,
    target.kind === 'global' ? { bare: true, mode: 'draft' } : { mode: 'draft' },
  )
  return res.text()
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'an unknown error'
}

/**
 * Loosely typed on purpose: nothing validates a tool's `inputSchema` on the
 * way in (the same rule `fillPath` states for every other tool), and this is
 * the one tool with no v1 route behind it to do that validation instead. `id`
 * is the only field a bad shape refuses outright — everything else has an
 * obvious default.
 */
export function previewDocument(
  rt: FolioRuntime,
  bindings: ReadBindings,
  ctx: PreviewDocumentContext,
  args: Record<string, unknown>,
): Promise<{ content: Content[] }> {
  const id = args.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new FolioError('bad_request', 'id is required')
  }
  const blok = typeof args.blok === 'string' ? args.blok : undefined
  const viewport = resolveViewport(
    typeof args.viewport === 'object' && args.viewport !== null
      ? (args.viewport as Record<string, unknown>)
      : undefined,
  )
  const fullPage = args.fullPage === true

  return run(rt, bindings, ctx, id, { blok, viewport, fullPage })
}

async function run(
  rt: FolioRuntime,
  bindings: ReadBindings,
  ctx: PreviewDocumentContext,
  id: string,
  args: { blok?: string; viewport: Viewport; fullPage: boolean },
): Promise<{ content: Content[] }> {
  const story = await storyById(bindings.db, id)
  if (!story) throw new FolioError('not_found', 'Unknown document')

  const decorated = rt.withUrls(story)
  const target = chooseTarget(rt.base, decorated, rt.typeOf(story.type)?.kind)

  if (target.kind === 'none') {
    return {
      content: [
        text(
          `"${story.title}" is a record with no page of its own — there is nothing to render, so there is nothing to screenshot.`,
        ),
      ],
    }
  }

  const url = new URL(target.url, ctx.origin).toString()
  const caption = captionFor(target)

  // A named uid has to exist in the draft *document* before anything is
  // attempted. Absent-from-the-document and present-but-unclippable (a
  // component-returning block never gets a marker in `draft` mode) look
  // identical from the rendered HTML alone and have opposite fixes (decision
  // 5a, the edge cases) — the `Doc` is what tells them apart.
  let blokType: string | undefined
  if (args.blok !== undefined) {
    const doc = await rt.draftFor(bindings, story)
    const found: Blok | undefined = doc.bloks[args.blok]
    if (!found) {
      return {
        content: [
          text(
            `No block with uid "${args.blok}" exists in this document's draft. Check the uid against get_document's content.`,
          ),
        ],
      }
    }
    blokType = found.type
  }

  const degrade = async (reason: string): Promise<{ content: Content[] }> => ({
    content: [
      text(
        `${reason} ${caption} Here is the draft URL and its rendered HTML instead.\n\nURL: ${url}`,
      ),
      text(await renderDraftHtml(rt, bindings, story, target)),
    ],
  })

  if (!bindings.browser) {
    return degrade('No `browser` binding is configured, so no screenshot was taken.')
  }

  const headers = ctx.headers
  let png: Uint8Array | undefined
  let note = caption

  if (args.blok !== undefined) {
    try {
      png = await captureScreenshot(bindings.browser, {
        url,
        viewport: args.viewport,
        fullPage: false,
        selector: clipSelector(args.blok),
        headers,
      })
      note += ` Clipped to block "${args.blok}" (${blokType}).`
    } catch {
      // Falls through to the unclipped attempt below. Either this block has
      // no clip target in `draft` mode, or the browser cannot reach the
      // target at all — only the next attempt tells the two apart, because
      // only the second failure repeats there.
    }
  }

  if (!png) {
    try {
      png = await captureScreenshot(bindings.browser, {
        url,
        viewport: args.viewport,
        fullPage: args.fullPage,
        headers,
      })
      if (args.blok !== undefined) {
        note += ` Block "${args.blok}" (${blokType}) has no clip target in the draft render — it does not render a host element there — so this is the whole viewport instead.`
      }
    } catch (err) {
      return degrade(
        `No screenshot was taken: the \`browser\` binding could not render this page (${messageOf(err)}).`,
      )
    }
  }

  return {
    content: [text(note), { type: 'image', data: base64(png), mimeType: 'image/png' }],
  }
}
