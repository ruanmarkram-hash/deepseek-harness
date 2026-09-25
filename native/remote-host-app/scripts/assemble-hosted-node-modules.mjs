// Materialize the hosted child's dynamic-import closure INSIDE the signed app.
// Never create external symlinks: inherited FD198/199 must not reach mutable code.
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectHostedGraph, copyHostedPackages, planHostedLayout } from './hosted-module-closure.mjs'
import { approvedHostedPlugins, verifyApprovedCopied } from './approved-hosted-plugins.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repo = dirname(dirname(dirname(scriptDir)))
const outDir = process.argv[2]
const manifestOut = process.argv[3]
const manifestOnly = process.argv[4] === '--manifest-only'
const approvalFile = process.argv[4] === '--approved-plugins' ? process.argv[5] : undefined
if (!outDir || !manifestOut || !outDir.endsWith('/HostedChild/node_modules') || !manifestOut.endsWith('/HostedChild/TreeManifest.plist') || (manifestOnly && process.argv.length !== 5) || (approvalFile && process.argv.length !== 6) || (!manifestOnly && !approvalFile && process.argv[4] !== undefined)) {
  console.error('usage: assemble-hosted-node-modules.mjs <Resources/HostedChild/node_modules> <Resources/HostedChild/TreeManifest.plist> [--approved-plugins /absolute/approval.json | --manifest-only]')
  process.exit(64)
}

function writeTreeManifest(hostedChild, output) {
  const resources = dirname(hostedChild)
  const entries = []
  function collect(directory) {
    for (const name of readdirSync(directory)) {
      if (name === '.DS_Store' || name === 'TreeManifest.plist') continue
      const full = join(directory, name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error(`hosted child contains forbidden symlink: ${full}`)
      if (stat.isDirectory()) { collect(full); continue }
      if (!stat.isFile()) throw new Error(`hosted child contains unsupported non-file: ${full}`)
      const path = relative(resources, full).split(sep).join('/')
      if (!path.startsWith('HostedChild/') || path.includes('../')) throw new Error(`hosted child escaped bundle: ${full}`)
      entries.push({ relativePath: path, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') })
    }
  }
  collect(hostedChild)
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const jsonPath = `${output}.json`
  writeFileSync(jsonPath, JSON.stringify({ formatVersion: 2, entries }))
  execFileSync('plutil', ['-convert', 'xml1', jsonPath, '-o', output])
  rmSync(jsonPath)
  return entries.length
}

if (manifestOnly) {
  const entries = writeTreeManifest(dirname(outDir), manifestOut)
  console.log(`sealed ${entries} hosted child files -> ${manifestOut}`)
  process.exit(0)
}

// Workspace discovery names explicit composition roots only. Dependency edges
// below are always resolved from their own installed declaring package.
const workspaceTargets = new Map([['@deepseek-ai/dsh', join(repo, 'apps/cli')]])
for (const group of readdirSync(`${repo}/packages`)) {
  const groupDir = join(repo, 'packages', group)
  let packages
  try { packages = readdirSync(groupDir) } catch { continue }
  for (const pkg of packages) {
    const packageDir = join(groupDir, pkg)
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      if (typeof manifest.name === 'string') workspaceTargets.set(manifest.name, packageDir)
    } catch {}
  }
}

// `web` is a concrete profile, not an arbitrary plugin manager.  Follow just
// its bundle roots and production dependency edges.  This prevents accidental
// inclusion of unrelated workspace packages, tests, and developer tooling.
const roots = [
  // Agent presets are signed CLI resources and may dynamically load any
  // plugin declared by the CLI package. The CLI itself is therefore a real
  // closure root, not merely a source for package.json/config copies.
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-remote-host-fd199',
  // The signed Host carries the opt-in policy without making the public CLI
  // require an experimental provider. Configuration still owns activation.
  '@deepseek-ai/dsh-experimental-computer-use-policy',
]
const approved = approvalFile ? await approvedHostedPlugins(approvalFile) : []
const graph = collectHostedGraph([...roots.map(name => {
  const target = workspaceTargets.get(name)
  if (target === undefined) throw new Error(`required hosted composition root is unavailable: ${name}`)
  return { name, target }
}), ...approved.map(({ name, target }) => ({ name, target }))])
const placements = planHostedLayout(graph, outDir)

// Loader entries are dynamic bare imports.  The signed closure must therefore
// contain current published JS for every selected workspace package, not just
// fresh `.d.ts` output.  Run each package's declared bundle recipe before its
// files are copied, in a deterministic order.  This never installs packages
// or mutates the shared dependency store.
// The copied closure also contains third-party packages resolved beneath the
// repository's node_modules directory.  Only build first-party workspace
// packages: third-party package scripts are neither part of our build contract
// nor safe to execute while sealing the hosted runtime.
const workspaceSourcePrefixes = [
  join(repo, 'packages') + sep,
  join(repo, 'vendor') + sep,
  join(repo, 'apps') + sep,
]
const bundlePackages = [...graph.nodes.values()]
  .map(({ manifest, target }) => ({ name: manifest.name, target }))
  .filter((entry) => workspaceSourcePrefixes.some(prefix => entry.target.startsWith(prefix)))
  .filter((entry) => {
    try { return typeof JSON.parse(readFileSync(join(entry.target, 'package.json'), 'utf8')).scripts?.bundle === 'string' }
    catch { return false }
  })
  .sort((a, b) => a.name.localeCompare(b.name))
for (const { name, target } of bundlePackages) {
  console.log(`building dynamic hosted workspace package: ${name}`)
  // Several package bundle recipes intentionally take their JavaScript entry
  // from `lib/types`.  Rebuild that project first so a signed closure cannot
  // pair a current source graph with an earlier emitted import graph.
  // `-b` follows only that package's declared references; it does not install
  // anything or rewrite the shared package-manager store.
  if (statSync(join(target, 'tsconfig.json'), { throwIfNoEntry: false })?.isFile()) {
    execFileSync(join(repo, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: target, stdio: 'inherit' })
  }
  execFileSync('npm', ['run', 'bundle'], { cwd: target, stdio: 'inherit' })
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const hostedChild = dirname(outDir)
// These are runtime data/installation anchors, not a code escape hatch: both
// become ordinary hashed Resources/HostedChild files below.
cpSync(join(repo, 'apps/cli/package.json'), join(hostedChild, 'package.json'))
// Preset patches are published resources of dsh-web-app in 0.1.7. They are
// copied with that package below; the removed CLI agent-presets tree is not
// a release input.
const hostedRoot = join(repo, 'apps/cli/config/hosted-root.yml')
if (!statSync(hostedRoot).isFile()) throw new Error('missing sealed CLI hosted-root.yml')
mkdirSync(join(hostedChild, 'config'), { recursive: true })
cpSync(hostedRoot, join(hostedChild, 'config/hosted-root.yml'), { dereference: true })
writeFileSync(join(hostedChild, 'config/approved-plugins.json'), JSON.stringify({
  formatVersion: 1,
  plugins: approved.map(({ id, name, version, sha256 }) => ({ id, name, version, sha256 })),
}) + '\n')

// The FD199 transition is dynamically loaded through the copied package, not
// the top-level CLI bundle. Fail assembly if its published entry still has a
// previous wire grammar, which otherwise only surfaces after a live child has
// prepared its store.
const fd199Source = join(repo, 'packages/mobile/remote-host-fd199/src/protocol.ts')
const fd199Published = join(repo, 'packages/mobile/remote-host-fd199/lib/index.js')
const fd199SourceText = readFileSync(fd199Source, 'utf8')
const fd199PublishedText = readFileSync(fd199Published, 'utf8')
if (!fd199SourceText.includes("kind: 'releasing'")
  || !fd199PublishedText.includes('kind: "releasing"')
  || /kind:\s*["']released["']/.test(fd199PublishedText)) {
  throw new Error('stale FD199 published runtime: run npm run bundle in packages/mobile/remote-host-fd199 before assembly')
}
// npm selects package files; the canonical installed graph owns all dependency placements.
await copyHostedPackages(graph, placements)
await verifyApprovedCopied(approved, outDir)

// Published runtime code must resolve through a package export inside the
// sealed closure. A `.../src/foo.ts` specifier works in the development graph
// but either reaches mutable workspace source or fails after packaging. Keep
// that boundary explicit and reject it before the tree is signed.
function assertNoSourceTypeScriptImports(directory) {
  for (const name of readdirSync(directory)) {
    const full = join(directory, name)
    const stat = lstatSync(full)
    if (stat.isDirectory()) { assertNoSourceTypeScriptImports(full); continue }
    if (!stat.isFile() || !/\.(?:[cm]?js)$/.test(name)) continue
    const source = readFileSync(full, 'utf8')
    if (/(?:\bfrom\s*|\bimport\s*\()(['"])[^'"\n]*\/src\/[^'"\n]*\.ts\1/.test(source)) {
      throw new Error(`published hosted runtime imports workspace TypeScript source: ${full}`)
    }
  }
}
assertNoSourceTypeScriptImports(outDir)

const entries = writeTreeManifest(hostedChild, manifestOut)
console.log(`copied ${graph.nodes.size} installed runtime identities into ${placements.size} signed package locations`)
console.log(`sealed ${entries} hosted child files -> ${manifestOut}`)
