import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **Every backticked relative path in a source comment resolves.**
 *
 * Cross-referencing is this codebase's documentation strategy — `AGENTS.md` is
 * written for an agent that follows these paths, and `src/` ships in the package,
 * so a consumer's editor cannot follow a broken one either. A 20% miss rate on the
 * mechanism the whole tree leans on is worth a guard rather than a sweep.
 *
 * **The guard is the deliverable, not the 86 rewrites**, and this run is the
 * evidence: the `../<group>/<file>.md` shorthand — which only resolves from inside
 * `docs/specs/` — came back **six times during phase 2 alone**, from three
 * different agents and once by hand, purely by copying the shape of a nearby
 * comment (fixed in `9907d9f`). A one-off sweep of a 440-reference corpus that
 * anybody can re-break by pattern-matching a neighbour is a snapshot, not a fix.
 *
 * From `src/server/` the correct form is `../../docs/specs/<group>/<file>.md`; from
 * `src/server/routes/` it is one deeper; from `src/admin/ui/screens/` it is
 * `../../../../docs/…`. **Count the levels for the file you are in** — there is no
 * single prefix that is right everywhere, which is most of why the shorthand is so
 * easy to reintroduce.
 */

/** The repo root, from this file rather than the working directory: a test that
 * only passes when vitest happens to run from the root is a test that will one day
 * fail for a reason nobody can find. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|css|mjs)$/.test(p)) out.push(p)
  }
  return out
}

/**
 * The four things that look like a dead reference and are not.
 *
 * Each is here with its reason because the failure mode of a checker like this is
 * not a false negative — it is somebody hitting a red build over a string that was
 * never a citation, widening the pattern until it passes, and taking the real
 * findings out with it. A narrow rule with a reason survives that; a broad one does
 * not.
 */
function excused(ref: string): boolean {
  // 1. The path is computed. `../../../src/admin/${path}` cannot be checked
  //    statically, and the four in the tree are all a test walking a directory.
  if (ref.includes('${')) return true
  // 2. A module specifier, not a file path. TypeScript resolves `./stories` to
  //    `stories.ts`, and `./admin-entry` is a package `exports` subpath that is not
  //    a file at all — demanding an extension of either is asking the wrong
  //    question about a string that is already verified by the compiler.
  if (!/\.\w+$/.test(ref)) return true
  // 3. An attack string rather than a citation. `../../etc/passwd` and `.env` are
  //    what the upload and form-file tests try to traverse to; a guard that reports
  //    them is reporting that the security test exists. Matched narrowly — a
  //    basename, not a substring — so a real file whose name merely contains one of
  //    these is still checked.
  const base = ref.split('/').pop() ?? ''
  if (ref.includes('etc/passwd') || base === '.env' || base.startsWith('.env.')) return true
  // 4. A placeholder in prose, not a path: `../<group>/<file>.md` is how this file
  //    and several source comments *describe* the shorthand in order to warn about
  //    it. Angle brackets never appear in a real path here.
  if (ref.includes('<') || ref.includes('>')) return true
  return false
}

/**
 * A backticked token beginning `./` or `../`. A `:line` suffix is stripped before
 * resolving — `` `foo.ts:42` `` is a common and correct citation in this tree.
 */
const RE = /`((?:\.{1,2}\/)[^`\s]+?)(?::\d+)?`/g

interface Dead {
  file: string
  line: number
  ref: string
}

function scan() {
  const files = [...walk(`${ROOT}/src`), ...walk(`${ROOT}/test`)]
  const dead: Dead[] = []
  let checked = 0
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      for (const m of line.matchAll(RE)) {
        const ref = (m[1] ?? '').replace(/#.*$/, '').replace(/[.,;:)]+$/, '')
        if (!ref || excused(ref)) continue
        checked++
        if (!existsSync(resolve(dirname(file), ref))) {
          dead.push({ file: file.slice(ROOT.length + 1), line: i + 1, ref })
        }
      }
    }
  }
  return { files, dead, checked }
}

describe('every relative reference in a source comment resolves', () => {
  const { files, dead, checked } = scan()

  it('found the corpus it is supposed to be checking', () => {
    // **The assertion that stops this file going vacuous**, and it is not
    // hypothetical: everything below is `expect(dead).toEqual([])`, which passes
    // beautifully when `dead` is empty because nothing was read. A directory
    // rename, a changed extension list, a `walk` that throws into an empty array —
    // any of those turns the guard into a green no-op that reports a clean tree
    // for ever. The floors are deliberately far below the real numbers (441
    // references across ~460 files at the time of writing) so ordinary growth and
    // ordinary deletion never touch them, and only a broken scan does.
    expect(files.length).toBeGreaterThan(300)
    expect(checked).toBeGreaterThan(350)
  })

  it('resolves all of them', () => {
    const formatted = dead.map((d) => `  ${d.file}:${d.line} \`${d.ref}\``).join('\n')
    // The message names the file, the line and the reference, because a bare count
    // is useless to whoever hits this: the fix is per-file — it depends on how deep
    // that file sits — so "17 dead references" is not actionable and this is.
    expect(
      dead,
      `${dead.length} relative reference(s) in source comments do not resolve:\n${formatted}\n\n` +
        'From src/server/ the shorthand `../<group>/<file>.md` needs to be\n' +
        '`../../docs/specs/<group>/<file>.md`. Count the levels for the file you are in.',
    ).toEqual([])
  })
})
