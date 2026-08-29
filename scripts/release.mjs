/**
 * Publishes this repository to GitHub, which is how consumers install Folio.
 *
 * There is no second repository and no split. `package.json` sits at the root,
 * so `github:brendanmckenzie/folio#<sha>` finds it where npm expects it and
 * `git push` is the whole of publishing. This used to be a
 * `git subtree split --prefix=packages/folio` into a parallel repository with an
 * unrelated history that had to be re-derived byte-identically on every release
 * or every pinned SHA was orphaned. That machinery existed only because the
 * package lived in a subdirectory and npm cannot install from one.
 *
 *   node scripts/release.mjs           # gate, smoke-test, print the push command
 *   node scripts/release.mjs --push    # …and push it
 *   node scripts/release.mjs --no-gate # skip the gates (they were just run)
 *
 * What it does NOT do is push by default. Publishing is an explicit act, and the
 * printed command is one paste.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REMOTE = 'origin'
const REMOTE_BRANCH = 'main'

const args = new Set(process.argv.slice(2))
const push = args.has('--push')
const gate = !args.has('--no-gate')
const force = args.has('--force')

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

function die(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/**
 * Gates are run by exit code, never by reading output. `biome ci` prints a
 * reassuring `Lint: No issues found` even when its *format* check failed further
 * up, and a shell hook can rewrite `pnpm exec biome` into something that prints a
 * plausible summary and never runs biome at all — so the direct binary, and the
 * status, are the only things trusted here. See CLAUDE.md.
 */
function runGate(label, command, commandArgs) {
  process.stdout.write(`· ${label} … `)
  const result = spawnSync(command, commandArgs, { stdio: 'pipe' })
  if (result.status !== 0) {
    console.log('FAILED')
    process.stdout.write(result.stdout?.toString() ?? '')
    process.stderr.write(result.stderr?.toString() ?? '')
    die(`${label} failed (exit ${result.status}). Nothing has been pushed.`)
  }
  console.log('ok')
}

// ── preconditions ────────────────────────────────────────────────────────────

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== REMOTE_BRANCH) {
  die(`on "${branch}", not ${REMOTE_BRANCH}. Release from there.`)
}
if (git('status', '--porcelain')) {
  die('working tree is dirty. A push ships commits, so uncommitted work would ship as nothing.')
}

const head = git('rev-parse', 'HEAD')

// ── gates ────────────────────────────────────────────────────────────────────

if (gate) {
  console.log('Gates:')
  runGate('tests', 'pnpm', ['test'])
  runGate('biome', './node_modules/.bin/biome', ['ci', '.'])
  runGate('typecheck', 'pnpm', ['typecheck'])
} else {
  console.log('Gates skipped (--no-gate).')
}

// ── smoke test ───────────────────────────────────────────────────────────────

/**
 * Installs this repo the way a consumer does, over `git+file:` so it runs
 * *before* the push rather than after.
 *
 * The gates above run against the workspace. Nobody installs the workspace.
 * A consumer installs this repository and npm runs its `prepare`, which is an
 * esbuild and a `tsc` — a build that exists only on the consumer's machine and
 * that no gate here has ever executed. Typechecking the workspace says nothing
 * about whether the package builds from a clean clone with only what `files`
 * ships.
 *
 * Both export shapes are checked because the package uses both: `./core` and
 * friends resolve into `dist/` and therefore prove `prepare` ran, while
 * `./render`, `./preview` and `./admin-entry` are plain strings into `src/` that
 * the consumer's own bundler compiles — those prove `files` still carries `src`.
 * A build that half-works fails one set and not the other.
 *
 * It also proves the docs ship. `files` is an allowlist, and a consumer reading
 * `node_modules/folio` is the only reader some of them will ever have.
 */
function smokeTest(sha) {
  const repoRoot = git('rev-parse', '--show-toplevel')
  const dir = mkdtempSync(join(tmpdir(), 'folio-release-'))
  try {
    execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' })

    process.stdout.write('· consumer install (runs prepare) … ')
    const install = spawnSync(
      'npm',
      ['install', `git+file://${repoRoot}#${sha}`, '--no-audit', '--no-fund'],
      { cwd: dir, stdio: 'pipe' },
    )
    if (install.status !== 0) {
      console.log('FAILED')
      process.stderr.write(install.stderr?.toString() ?? '')
      die('the package does not install. Nothing has been pushed.')
    }
    console.log('ok')

    const root = join(dir, 'node_modules', 'folio')

    process.stdout.write('· exports resolve … ')
    const { exports: map } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const missing = []
    // Conditions nest, so collect every leaf string rather than assuming a shape.
    const walk = (subpath, node) => {
      if (typeof node === 'string') {
        if (!existsSync(join(root, node))) missing.push(`${subpath} -> ${node}`)
        return
      }
      if (node && typeof node === 'object') {
        for (const [, child] of Object.entries(node)) walk(subpath, child)
      }
    }
    for (const [subpath, node] of Object.entries(map ?? {})) walk(subpath, node)
    if (missing.length) {
      console.log('FAILED')
      for (const m of missing) console.error(`    missing: ${m}`)
      die(`${missing.length} export target(s) absent from the built package.`)
    }
    console.log(`ok (${Object.keys(map ?? {}).length} subpaths)`)

    process.stdout.write('· docs ship … ')
    const docs = ['README.md', 'AGENTS.md'].filter((f) => !existsSync(join(root, f)))
    if (docs.length) {
      console.log('FAILED')
      die(
        `${docs.join(' and ')} absent from the installed package. ` +
          'A consumer reading node_modules is the only reader some docs get.',
      )
    }
    console.log('ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── compare with what is published ───────────────────────────────────────────

let remoteHead = null
try {
  remoteHead = git('rev-parse', `${REMOTE}/${REMOTE_BRANCH}`)
} catch {
  console.log(`· no ${REMOTE}/${REMOTE_BRANCH} locally — run \`git fetch ${REMOTE}\` to compare.`)
}

if (remoteHead === head) {
  console.log(`\n✓ ${REMOTE}/${REMOTE_BRANCH} is already ${head.slice(0, 7)}. Nothing to publish.`)
  process.exit(0)
}

if (remoteHead) {
  const fastForward =
    spawnSync('git', ['merge-base', '--is-ancestor', remoteHead, head]).status === 0
  if (!fastForward && !force) {
    die(
      `${head.slice(0, 7)} is not a fast-forward of ${REMOTE}/${REMOTE_BRANCH} ` +
        `(${remoteHead.slice(0, 7)}).\n` +
        '  Pushing would orphan every SHA a consumer has pinned, so work out why first.\n' +
        '  The one sanctioned exception is the cutover from the old subtree-split\n' +
        '  history, whose commits are unrelated to these by construction. That is what\n' +
        '  --force is for, and it is a one-time act: re-pin both consumers afterwards.',
    )
  }
  if (fastForward) {
    const ahead = git('rev-list', '--count', `${remoteHead}..${head}`)
    console.log(`· ${ahead} commit(s) ahead of ${REMOTE}/${REMOTE_BRANCH}`)
  } else {
    console.log(`· UNRELATED to ${REMOTE}/${REMOTE_BRANCH} — forcing (one-time cutover)`)
  }
}

if (gate) {
  console.log('\nSmoke test (what a consumer actually runs):')
  smokeTest(head)
} else {
  console.log('Smoke test skipped (--no-gate).')
}

// ── publish ──────────────────────────────────────────────────────────────────

const pushArgs = [
  'push',
  ...(force ? ['--force'] : []),
  REMOTE,
  `${REMOTE_BRANCH}:${REMOTE_BRANCH}`,
]

if (!push) {
  console.log(`\nReady. To publish:\n\n  git ${pushArgs.join(' ')}\n`)
  process.exit(0)
}

process.stdout.write('\n· pushing … ')
const result = spawnSync('git', pushArgs, { stdio: 'pipe' })
if (result.status !== 0) {
  console.log('FAILED')
  process.stderr.write(result.stderr?.toString() ?? '')
  die('push failed.')
}
console.log('ok')
console.log(`\n✓ Published ${head.slice(0, 7)}.`)
console.log(`  Consumers pin: "folio": "github:brendanmckenzie/folio#${head}"`)
