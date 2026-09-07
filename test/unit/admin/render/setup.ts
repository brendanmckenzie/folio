/**
 * The `render` project's setup: a DOM, and the two traps that make "it rendered"
 * mean something.
 *
 * **A smoke test that only checks `render()` did not throw proves very little.**
 * React reports most of what goes wrong in a mounted tree by *logging* rather
 * than throwing — a bad key, an invalid DOM nesting, a state update on an
 * unmounted component, a hook order change, an `act` violation — and an error
 * inside a `useEffect`'s promise becomes an unhandled rejection that vitest will
 * happily let a passing test carry. So both are turned into failures here:
 *
 *   - `console.error` fails the test. Safe to be this strict because **nothing
 *     under `src/admin/` calls `console.*` at all** (verified: zero occurrences),
 *     so every call during one of these tests is React's own.
 *   - an unhandled rejection fails the test, attributed to whichever test was
 *     running when it landed.
 *
 * Without the first of those, the `.folio-ui` omission this whole issue is named
 * after would still not have been caught: it is a *rendered* fact, and the tree
 * containing it renders perfectly happily.
 */
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect } from 'vitest'

/**
 * React's own switch for `act`.
 *
 * Without it every `act()` call logs "The current testing environment is not
 * configured to support act(...)" — which the trap below correctly turns into a
 * failure, so this is not optional decoration. Testing Library sets it itself
 * when it detects a global `jest`; there is no `jest` here.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** What React logged, and what rejected, during the test currently running. */
let logged: string[] = []
let rejected: string[] = []

const realConsoleError = console.error

function onRejection(reason: unknown) {
  rejected.push(reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason))
}

beforeEach(() => {
  logged = []
  rejected = []
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  }
  process.on('unhandledRejection', onRejection)
})

afterEach(() => {
  // Unmount before the assertions below, so a teardown-time error — an effect
  // cleanup that throws, a `setState` after unmount — is attributed to the test
  // that caused it rather than to whichever one runs next.
  cleanup()
  console.error = realConsoleError
  process.off('unhandledRejection', onRejection)

  const problems = [
    ...logged.map((m) => `console.error: ${m}`),
    ...rejected.map((m) => `unhandled rejection: ${m}`),
  ]
  expect(problems, problems.join('\n\n')).toEqual([])
})

/**
 * **No real sockets.** Mounting `{base}/edit/:id` constructs a `StoryStore`,
 * which opens a `WebSocket` — and `useEditor` builds it without options, so there
 * is no `createSocket` seam to inject from out here. Left alone, happy-dom dials
 * a real `ws://localhost` and the failed connect arrives as a stream error on a
 * later tick, attributed to whichever test happened to be running.
 *
 * Stubbed rather than seamed open: what the socket *does* is `store.test.ts`'s
 * subject and it has the injection point for it, so a render test that opened one
 * would be asserting the environment's socket implementation and nothing else.
 */
class SilentSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = SilentSocket.CONNECTING
  onopen: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  onmessage: unknown = null
  send() {}
  close() {
    this.readyState = SilentSocket.CLOSED
  }
  addEventListener() {}
  removeEventListener() {}
}
;(globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket

/**
 * `ui/fit.ts` constructs one on mount. happy-dom ships it, so this is a
 * guard against a future environment change rather than a polyfill in use —
 * asserted rather than assumed, because a missing constructor here would fail as
 * "the Assets screen does not render".
 */
if (typeof ResizeObserver !== 'function') {
  throw new Error('the render project needs a DOM with ResizeObserver; check vitest.config.ts')
}
