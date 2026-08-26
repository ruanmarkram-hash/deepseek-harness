// Materialize the hosted child's dynamic-import closure INSIDE the signed app.
// Never create external symlinks: inherited FD198/199 must not reach mutable code.
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repo = dirname(dirname(dirname(scriptDir)))
const outDir = process.argv[2]
const manifestOut = process.argv[3]
const manifestOnly = process.argv[4] === '--manifest-only'
if (!outDir || !manifestOut || !outDir.endsWith('/HostedChild/node_modules') || !manifestOut.endsWith('/HostedChild/TreeManifest.plist') || (process.argv[4] !== undefined && !manifestOnly)) {
  console.error('usage: assemble-hosted-node-modules.mjs <Resources/HostedChild/node_modules> <Resources/HostedChild/TreeManifest.plist> [--manifest-only]')
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

const nameToTarget = new Map()
const manifests = new Map()
const scannedModuleRoots = new Set()
const pnpmRoots = readdirSync(`${repo}/node_modules/.pnpm`)
function resolveFromPnpmStore(name) {
  const encoded = name.replace('/', '+')
  for (const storeName of pnpmRoots) {
    if (!storeName.startsWith(`${encoded}@`)) continue
    const candidate = join(repo, 'node_modules/.pnpm', storeName, 'node_modules', name)
    try { addName(name, candidate); return } catch {}
  }
}
function addName(name, candidate) {
  let target
  try { target = realpathSync(candidate) } catch { return }
  try { if (!statSync(target).isDirectory()) return } catch { return }
  nameToTarget.set(name, target)
  try { manifests.set(name, JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))) } catch {}
  scanNodeModules(join(target, 'node_modules'))
}
function scanNodeModules(directory) {
  let canonical
  try { canonical = realpathSync(directory) } catch { return }
  if (scannedModuleRoots.has(canonical)) return
  scannedModuleRoots.add(canonical)
  let names
  try { names = readdirSync(directory) } catch { return }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = join(directory, name)
    let stat
    try { stat = lstatSync(full) } catch { continue }
    if (name.startsWith('@') && statSync(full).isDirectory()) {
      for (const child of readdirSync(full)) addName(`${name}/${child}`, join(full, child))
    } else addName(name, full)
  }
}
scanNodeModules(`${repo}/node_modules`)
scanNodeModules(`${repo}/apps/cli/node_modules`)
addName('@deepseek-ai/dsh', `${repo}/apps/cli`)
for (const group of readdirSync(`${repo}/packages`)) {
  const groupDir = join(repo, 'packages', group)
  let packages
  try { packages = readdirSync(groupDir) } catch { continue }
  for (const pkg of packages) {
    const packageDir = join(groupDir, pkg)
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      if (typeof manifest.name === 'string' && manifest.name.includes('/')) addName(manifest.name, packageDir)
    } catch {}
    scanNodeModules(join(packageDir, 'node_modules'))
  }
}
for (const packageDir of readdirSync(`${repo}/vendor`).map(name => join(repo, 'vendor', name))) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    if (typeof manifest.name === 'string') addName(manifest.name, packageDir)
  } catch {}
  scanNodeModules(join(packageDir, 'node_modules'))
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
]
const selected = new Set()
const pending = roots.map(name => ({ name, optional: false }))
while (pending.length > 0) {
  const candidate = pending.pop()
  if (candidate === undefined || selected.has(candidate.name)) continue
  const { name, optional } = candidate
  if (!nameToTarget.has(name)) resolveFromPnpmStore(name)
  const manifest = manifests.get(name)
  if (manifest === undefined || !nameToTarget.has(name)) {
    // A signed child may omit only a declared optional dependency. Required
    // and peer edges must be present in the sealed tree: treating either as a
    // platform omission would silently defer a packaging defect to runtime.
    if (optional) {
      console.warn(`omitting unavailable optional package: ${name}`)
      continue
    }
    throw new Error(`required hosted runtime package is unavailable: ${name}`)
  }
  selected.add(name)
  for (const dependency of Object.keys(manifest.dependencies ?? {})) pending.push({ name: dependency, optional: false })
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
    const peerMetadata = manifest.peerDependenciesMeta?.[dependency]
    pending.push({ name: dependency, optional: peerMetadata?.optional === true })
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) pending.push({ name: dependency, optional: true })
}

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
const bundlePackages = [...selected]
  .map(name => ({ name, target: nameToTarget.get(name) }))
  .filter((entry) => entry.target !== undefined
    && workspaceSourcePrefixes.some(prefix => entry.target.startsWith(prefix)))
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
cpSync(join(repo, 'apps/cli/config/agent-presets'), join(hostedChild, 'config/agent-presets'), { recursive: true, dereference: true })
const hostedRoot = join(repo, 'apps/cli/config/hosted-root.yml')
if (!statSync(hostedRoot).isFile()) throw new Error('missing sealed CLI hosted-root.yml')
mkdirSync(join(hostedChild, 'config'), { recursive: true })
cpSync(hostedRoot, join(hostedChild, 'config/hosted-root.yml'), { dereference: true })

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
for (const name of [...selected].sort((a, b) => a.localeCompare(b))) {
  const target = nameToTarget.get(name)
  if (target === undefined) throw new Error(`selected hosted runtime package disappeared: ${name}`)
  const destination = join(outDir, name)
  mkdirSync(dirname(destination), { recursive: true })
  // The closure is flattened at the sealed root; nested package-manager links
  // cannot escape the app because every resolvable name is collected above.
  const manifest = manifests.get(name)
  const published = Array.isArray(manifest?.files) ? manifest.files : undefined
  const allowedPrefixes = published?.map(file => String(file).replace(/\*.*$/, '').replace(/\/$/, ''))
  const publishedHasGlob = published?.some(file => String(file).includes('*')) === true
  cpSync(target, destination, {
    recursive: true,
    dereference: true,
    filter: source => {
      const rel = relative(target, source).split(sep).join('/')
      if (rel === '') return true
      if (rel === 'node_modules' || rel.startsWith('node_modules/')) return false
      if (rel.split('/').some(part => ['test', 'tests', 'docs', '.git', '.github'].includes(part))) return false
      if (rel.split('/').includes('src') && name !== 'koffi'
        && !allowedPrefixes?.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`) || prefix.startsWith(`${rel}/`))) return false
      if (rel.endsWith('.md') || rel.endsWith('.ts') || rel.endsWith('.map')) return false
      if (rel === 'package.json') return true
      if (name === '@img/colour' || allowedPrefixes === undefined || publishedHasGlob) return true
      return allowedPrefixes.some(prefix => prefix !== '' && (rel === prefix || rel.startsWith(`${prefix}/`) || prefix.startsWith(`${rel}/`)))
    },
  })
}

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
console.log(`copied ${selected.size} reachable runtime packages into signed HostedChild/node_modules`)
console.log(`sealed ${entries} hosted child files -> ${manifestOut}`)
