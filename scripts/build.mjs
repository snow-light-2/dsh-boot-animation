/**
 * Build the four artifacts of dsh-boot-animation, in a fixed order.
 *
 * Run as `npm run build` (or `bash scripts/build.sh`, which just delegates here).
 * Node rather than bash on purpose: the host half is developed on Windows, and a
 * build that only runs under Git Bash is a build half the contributors cannot run.
 *
 * The order matters and is enforced rather than documented:
 *   1. the host half is copied, so a lib/ that exists is never older than src/
 *   2. the settings vocabulary is transpiled, so the host's import target exists
 *      before anything tries to load lib/index.js
 *   3. the embedded clips are regenerated from media/
 *   4. the browser half is bundled
 *   5. every expected artifact is checked, and a missing one FAILS the build
 *
 * Step 5 is the one that matters: this repository commits lib/, and a committed
 * artifact that silently did not regenerate is how a source fix ships as the bug
 * it was meant to remove.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

const step = (title) => console.log(`=== ${title} ===`)

/** Copy one source file, creating the destination directory. */
function copy(from, to) {
  mkdirSync(dirname(join(ROOT, to)), { recursive: true })
  copyFileSync(join(ROOT, from), join(ROOT, to))
}

/**
 * Run one child to completion, inheriting stdio, and fail the build on error.
 *
 * `useShell` is opt-in and only needed for a `.cmd` shim: with `shell: true` an
 * executable path containing a space - `C:\Program Files\nodejs\node.exe` - is
 * split at the space and the build dies with "'C:\Program' is not recognized".
 * Everything that can be invoked through `process.execPath` therefore avoids the
 * shell entirely.
 */
function run(command, args, useShell = false) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: useShell,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`)
  }
}

/** The TypeScript compiler, invoked through this process's own node. */
function tsc(args) {
  run(process.execPath, [join('node_modules', 'typescript', 'bin', 'tsc'), ...args])
}

step('host half: src/host.js -> lib/index.js (no compile needed)')
copy('src/host.js', 'lib/index.js')

step('settings vocabulary: src/shared/settings.ts -> lib/settings.shared.mjs')
// Transpiled rather than copied, because the vocabulary is TypeScript: the client
// half imports it as a module and the host half needs runnable ESM. One source
// file, two consumers, and this step is why they cannot be built from different
// revisions of it.
//
// The emit lands in a scratch directory and is then MOVED to a name with an explicit
// `.mjs` extension: `tsc` names an ESM emit `.js` (correct by its rules, since the
// package is `"type": "module"`), but a file whose name always says what it is -
// and that cannot be confused with the generated clips or the client bundle - is
// worth one rename.
tsc(['-p', 'tsconfig.shared.json'])
const sharedEmit = join(ROOT, 'lib', '.shared-build', 'settings.js')
if (!existsSync(sharedEmit)) {
  throw new Error('build: tsconfig.shared.json did not emit the shared settings module')
}
const sharedTarget = join(ROOT, 'lib', 'settings.shared.mjs')
rmSync(sharedTarget, { force: true })
renameSync(sharedEmit, sharedTarget)
rmSync(join(ROOT, 'lib', '.shared-build'), { recursive: true, force: true })

step('built-in clips: embedding media/*.mp4 as base64')
run(process.execPath, ['scripts/embed-clips.mjs'])

step('browser half: tsdown (lib/client.js)')
// The `.cmd` shim is the one child that needs a shell on Windows, and `cmd.exe`
// treats a forward slash in a command position as an option - so the path is given
// with native separators.
const tsdown = process.platform === 'win32' ? 'node_modules\\.bin\\tsdown.cmd' : 'node_modules/.bin/tsdown'
if (!existsSync(join(ROOT, tsdown))) {
  throw new Error("build: tsdown is not installed - run 'npm install' first")
}
run(tsdown, [], process.platform === 'win32')

step('verify every artifact exists')
const required = [
  'lib/index.js',
  'lib/settings.shared.mjs',
  'lib/client.js',
  'lib/clips.meta.js',
  'lib/clips.data.js',
  'cordis.patch.yml',
]
const missing = required.filter((file) => !existsSync(join(ROOT, file)))
if (missing.length > 0) {
  throw new Error(`build: missing artifacts: ${missing.join(', ')}`)
}
for (const file of required) console.log(`  ok ${file}`)

step('syntax check the host half')
run(process.execPath, ['--check', 'lib/index.js'])
run(process.execPath, ['--check', 'lib/settings.shared.mjs'])

console.log('=== Build complete ===')
