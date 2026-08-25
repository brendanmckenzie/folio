/**
 * Publishes `packages/folio` to the public repo that consumers install from.
 *
 * `brendanmckenzie/folio` on GitHub is **not this repository**. It holds a
 * `git subtree split --prefix=packages/folio` of it: the package hoisted to the
 * root, so `github:brendanmckenzie/folio#<sha>` finds a `package.json` where npm
 * expects one. npm cannot install from a subdirectory of a git dependency, which
 * is the whole reason the split exists.
 *
 * The two histories are unrelated — no common ancestor, parallel commits with
 * the same messages — so nothing about the split is automatic. It was a
 * remembered incantation before this script, and it had already drifted a commit
 * behind. That is what this exists to stop.
 *
 *   node scripts/release.mjs           # gate, split, print the push command
 *   node scripts/release.mjs --push    # …and push it
 *   node scripts/release.mjs --no-gate # skip the gates (they were just run)
 *
 * What it does NOT do is push by default. Publishing is an explicit act, and the
 * printed command is one paste.
 */
import { execFileSync, spawnSync } from 'node:child_process'

const PREFIX = 'packages/folio'
const SPLIT_BRANCH = 'folio-package-only'
const REMOTE = 'origin'
const REMOTE_BRANCH = 'main'

const args = new Set(process.argv.slice(2))
const push = args.has('--push')
const gate = !args.has('--no-gate')

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
    die(`${label} failed (exit ${result.status}). Nothing has been split or pushed.`)
  }
  console.log('ok')
}

// ── preconditions ────────────────────────────────────────────────────────────

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') {
  die(`on "${branch}", not main. The split takes whatever main holds; release from there.`)
}
if (git('status', '--porcelain')) {
  die('working tree is dirty. The split reads commits, so uncommitted work would ship as nothing.')
}

// ── gates ────────────────────────────────────────────────────────────────────

if (gate) {
  console.log('Gates (CI runs exactly these):')
  runGate('tests', 'pnpm', ['test'])
  runGate('biome', './node_modules/.bin/biome', ['ci', '.'])
  runGate('typecheck', 'pnpm', ['typecheck'])
} else {
  console.log('Gates skipped (--no-gate).')
}

// ── split ────────────────────────────────────────────────────────────────────

console.log(`\nSplitting ${PREFIX} …`)
// Deterministic: the same (tree, parent, message, author, date) yields the same
// commit, so re-splitting an unchanged history reproduces the published SHAs
// rather than orphaning every consumer's pin.
const splitSha = execFileSync('git', ['subtree', 'split', `--prefix=${PREFIX}`, 'main'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  // `git subtree split` writes a per-commit progress counter to stderr, which is
  // hundreds of lines of noise around the one line that matters. Captured rather
  // than silenced: `execFileSync` attaches it to the thrown error on a failure.
  stdio: ['ignore', 'pipe', 'pipe'],
})
  .trim()
  .split('\n')
  .pop()

git('branch', '-f', SPLIT_BRANCH, splitSha)

let remoteHead = null
try {
  remoteHead = git('rev-parse', `${REMOTE}/${REMOTE_BRANCH}`)
} catch {
  console.log(`· no ${REMOTE}/${REMOTE_BRANCH} locally — run \`git fetch ${REMOTE}\` to compare.`)
}

if (remoteHead === splitSha) {
  console.log(
    `\n✓ ${REMOTE}/${REMOTE_BRANCH} is already ${splitSha.slice(0, 7)}. Nothing to publish.`,
  )
  process.exit(0)
}

if (remoteHead) {
  // A non-fast-forward means the published history and this one have diverged,
  // which for a deterministic split means main was rewritten. Pushing over it
  // would orphan the SHAs consumers pin.
  const fastForward =
    spawnSync('git', ['merge-base', '--is-ancestor', remoteHead, splitSha]).status === 0
  if (!fastForward) {
    die(
      `${splitSha.slice(0, 7)} is not a fast-forward of ${REMOTE}/${REMOTE_BRANCH} ` +
        `(${remoteHead.slice(0, 7)}).\n  main has been rewritten since the last release. Pushing ` +
        'would orphan every pinned SHA — work out why before forcing anything.',
    )
  }
  const ahead = git('rev-list', '--count', `${remoteHead}..${splitSha}`)
  console.log(`· ${ahead} commit(s) ahead of ${REMOTE}/${REMOTE_BRANCH}`)
}

console.log(`· ${SPLIT_BRANCH} -> ${splitSha}`)

// ── publish ──────────────────────────────────────────────────────────────────

const pushArgs = ['push', REMOTE, `${SPLIT_BRANCH}:${REMOTE_BRANCH}`]

if (!push) {
  console.log(`\nTo publish:\n  git ${pushArgs.join(' ')}\n`)
  console.log(`Then pin consumers at:\n  github:brendanmckenzie/folio#${splitSha}`)
  process.exit(0)
}

console.log(`\nPushing to ${REMOTE}/${REMOTE_BRANCH} …`)
const pushed = spawnSync('git', pushArgs, { stdio: 'inherit' })
if (pushed.status !== 0) die(`push failed (exit ${pushed.status})`)

console.log(`\n✓ published\n\nPin consumers at:\n  github:brendanmckenzie/folio#${splitSha}`)
