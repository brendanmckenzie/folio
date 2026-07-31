import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scoped, UI_SCOPE } from '../../../src/admin/ui/scope'

/**
 * `tokens.css`'s global layer is opt-in, and this pins the opting-in.
 *
 * The bug being guarded against actually shipped: for the whole of the eight-phase
 * port `.folio-ui` was on `Kitchen.tsx` and nothing else, so in the real admin
 * `box-sizing: border-box` never applied and **every `width: 100%` control was its
 * own padding-plus-border wider than the panel holding it** — 18px, clipped at the
 * panel's edge. It was reported as "the right panel has no padding".
 *
 * It is a source-text test because the admin's suite mounts nothing (see
 * `vitest.config.ts`): there is no DOM here to ask for a computed style. That makes
 * it a weaker assertion than a rendered one — it proves the class is *applied*, not
 * that it lands on the outermost node — and it is still worth having, because the
 * failure it catches is a silent omission in a file nobody was editing.
 */

const src = (path: string) =>
  readFileSync(new URL(`../../../src/admin/${path}`, import.meta.url), 'utf8')

/** Every `.tsx` under `admin/`, so a new portal is caught without a list to update. */
function tsxFiles(dir = 'ui'): string[] {
  const out: string[] = []
  for (const entry of readdirSync(new URL(`../../../src/admin/${dir}`, import.meta.url), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) out.push(...tsxFiles(`${dir}/${entry.name}`))
    else if (entry.name.endsWith('.tsx')) out.push(`${dir}/${entry.name}`)
  }
  return out
}

/**
 * Every declaration block, flattened, with comments stripped and at-rules
 * transparent — a `@media`'s inner selectors are ordinary selectors and are
 * exactly what needs checking. A scanner rather than a regex because a regex over
 * CSS matched the header of the reduced-motion comment as a selector.
 */
function rules(css: string): { selector: string; body: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { selector: string; body: string }[] = []
  let head = ''
  const stack: string[] = []
  for (const ch of clean) {
    if (ch === '{') {
      stack.push(head.trim())
      head = ''
    } else if (ch === '}') {
      const selector = stack.pop() ?? ''
      // `head` is whatever preceded the brace: declarations for a rule, nothing
      // for an at-rule whose children were themselves blocks.
      if (selector) out.push({ selector, body: head })
      head = ''
    } else head += ch
  }
  return out
}

describe('the styling scope', () => {
  it('is the class tokens.css scopes its global layer under', () => {
    const tokens = readFileSync(
      new URL('../../../src/admin/ui/tokens.css', import.meta.url),
      'utf8',
    )
    // The rules that go inert without the class. Each is here because losing it
    // produces a defect that looks like something else entirely.
    expect(tokens).toContain(`.${UI_SCOPE} *,`)
    expect(tokens).toContain('box-sizing: border-box')
    expect(tokens).toContain(`.${UI_SCOPE} :focus-visible`)
  })

  it('lets nothing but color-scheme set a real property outside the scope', () => {
    const tokens = readFileSync(
      new URL('../../../src/admin/ui/tokens.css', import.meta.url),
      'utf8',
    )
    // An unscoped selector that declares a real property would restyle the
    // *host's* document, which is the whole reason for scoping. A selector that
    // declares nothing but custom properties is fine and is how the token tier
    // works: `:root` and `[data-theme="dark"]` are variable tables, inert until
    // something under the scope consumes them.
    //
    // `color-scheme` is the single exception, and it is one because the user agent
    // — not Folio — reads it, to colour the scrollbar and native controls. Scoped
    // to a subtree it cannot reach them. tokens.css states the reasoning in place.
    const offenders: string[] = []
    for (const { selector, body } of rules(tokens)) {
      if (selector.includes(UI_SCOPE) || selector.startsWith('@')) continue
      const real = body
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && !d.startsWith('--') && !d.startsWith('color-scheme'))
      if (real.length > 0) offenders.push(`${selector} sets ${real.join('; ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('is applied at the shell, which is the root of every screen', () => {
    expect(src('ui/Shell.tsx')).toMatch(/scoped\(css\.shell\)/)
  })

  it('is re-declared by every portal, because a portal leaves the shell', () => {
    const portals = tsxFiles().filter((f) => src(f).includes('createPortal'))
    // Four today: Dialog, Palette, FocusMode, HistoryPanel. The count is asserted
    // so that adding a fifth is a decision rather than an accident.
    expect(portals.length).toBeGreaterThanOrEqual(4)
    for (const file of portals) {
      expect(src(file), `${file} portals without re-declaring ${UI_SCOPE}`).toMatch(/scoped\(/)
    }
  })

  it('is never spelled as a literal, so the grep for it finds every site', () => {
    for (const file of tsxFiles()) {
      // `scope.ts` is the one place the string lives.
      expect(src(file), `${file} hard-codes the scope class`).not.toContain(`'${UI_SCOPE}`)
      expect(src(file), `${file} hard-codes the scope class`).not.toContain(`${UI_SCOPE} $`)
    }
  })
})

describe('scoped()', () => {
  it('puts the scope first and keeps the component classes', () => {
    expect(scoped('a', 'b')).toBe(`${UI_SCOPE} a b`)
  })

  it('drops the falsy ones, so a conditional class needs no ternary to empty string', () => {
    expect(scoped('a', false, undefined, 'b')).toBe(`${UI_SCOPE} a b`)
  })

  it('is just the scope when a caller has no classes of its own', () => {
    expect(scoped()).toBe(UI_SCOPE)
  })
})
