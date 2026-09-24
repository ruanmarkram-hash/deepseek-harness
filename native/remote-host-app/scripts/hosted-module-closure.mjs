// Resolve the installed dependency graph before placing a symlink-free Node tree.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

function installedPackage(parent, name) {
  const require = createRequire(join(parent, 'package.json'))
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = join(directory, name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  }
}

/** Read only production and peer edges from each package's actual installation. */
export function collectHostedGraph(roots) {
  const nodes = new Map()
  const pending = roots.map(root => realpathSync(root.target))
  while (pending.length > 0) {
    const target = pending.pop()
    if (nodes.has(target)) continue
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    if (typeof manifest.name !== 'string') throw new Error(`hosted package has no name: ${target}`)
    const edges = new Map()
    const absent = new Set()
    nodes.set(target, { target, manifest, edges, absent })
    const requirements = new Map(Object.keys(manifest.dependencies ?? {}).map(name => [name, false]))
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (!requirements.has(name)) requirements.set(name, manifest.peerDependenciesMeta?.[name]?.optional === true)
    }
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) requirements.set(name, true)
    for (const [name, optional] of requirements) {
      const dependency = installedPackage(target, name)
      if (dependency === undefined) {
        if (!optional) throw new Error(`required hosted dependency is unavailable: ${manifest.name} -> ${name}`)
        absent.add(name)
        continue
      }
      edges.set(name, dependency)
      pending.push(dependency)
    }
  }
  return { nodes, roots: roots.map(root => ({ name: root.name, target: realpathSync(root.target) })) }
}

/** Place competing versions locally, retaining one root identity for every first-party package. */
export function planHostedLayout(graph, outDir) {
  const choices = new Map()
  function note(name, target) {
    const targets = choices.get(name) ?? new Map()
    targets.set(target, (targets.get(target) ?? 0) + 1)
    choices.set(name, targets)
  }
  for (const node of graph.nodes.values()) for (const [name, target] of node.edges) note(name, target)
  for (const root of graph.roots) note(root.name, root.target)
  const rootTargets = new Map(graph.roots.map(root => [root.name, root.target]))
  const placements = new Map()
  const pending = []
  function place(destination, target) {
    if (placements.has(destination)) {
      if (placements.get(destination) !== target) throw new Error(`conflicting hosted placement: ${destination}`)
      return
    }
    if (placements.size > 10_000) throw new Error('hosted dependency layout cannot be represented within its package bound')
    placements.set(destination, target)
    pending.push(destination)
  }
  for (const [name, targets] of [...choices].sort(([a], [b]) => a.localeCompare(b))) {
    if (name.startsWith('@deepseek-ai/') && targets.size !== 1) {
      throw new Error(`hosted first-party singleton has competing installed identities: ${name}`)
    }
    const target = rootTargets.get(name) ?? [...targets].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))[0][0]
    place(join(outDir, name), target)
  }
  function lookup(parent, name) {
    const require = createRequire(join(parent, 'package.json'))
    for (const directory of require.resolve.paths(name) ?? []) {
      const distance = relative(outDir, directory)
      if (distance === '..' || distance.startsWith(`..${sep}`)) continue
      const candidate = join(directory, name)
      if (placements.has(candidate)) return placements.get(candidate)
    }
  }
  for (let index = 0; index < pending.length; index += 1) {
    const destination = pending[index]
    const node = graph.nodes.get(placements.get(destination))
    for (const [name, target] of node.edges) {
      if (lookup(destination, name) === target) continue
      if (name.startsWith('@deepseek-ai/')) throw new Error(`hosted singleton edge cannot retain its root identity: ${node.manifest.name} -> ${name}`)
      place(join(destination, 'node_modules', name), target)
    }
  }
  // Verify after all placements, since a later ancestor can shadow an earlier edge.
  for (const [destination, target] of placements) {
    const node = graph.nodes.get(target)
    for (const [name, expected] of node.edges) {
      if (lookup(destination, name) !== expected) throw new Error(`hosted dependency edge changed: ${node.manifest.name} -> ${name}`)
    }
    for (const name of node.absent) {
      if (lookup(destination, name) !== undefined) throw new Error(`hosted optional dependency gained an unintended provider: ${node.manifest.name} -> ${name}`)
    }
    if (dirname(destination) === destination) throw new Error('invalid hosted package destination')
  }
  return placements
}

const execute = promisify(execFile)
const publicationCache = new Map()

/** Ask npm for its publication list without running package scripts or accessing the network. */
async function publishedFiles(target) {
  let pending = publicationCache.get(target)
  if (pending === undefined) {
    pending = (async () => {
      const { stdout } = await execute('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--offline', '--workspaces=false'], {
        cwd: target, maxBuffer: 16 * 1024 * 1024,
      })
      const result = JSON.parse(stdout)
      if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]?.files)) {
        throw new Error(`npm returned an invalid hosted publication list: ${target}`)
      }
      const files = []
      for (const entry of result[0].files) {
        const path = entry?.path
        if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
          throw new Error(`npm returned an unsafe hosted publication path: ${target}`)
        }
        // Installed dependency edges are copied by the graph, never npm's bundle traversal.
        if (path.split(/[\\/]/).includes('node_modules')) continue
        const source = resolve(target, path)
        if (!source.startsWith(target + sep)) throw new Error(`hosted publication escaped its package: ${target}`)
        let current = target
        for (const part of relative(target, source).split(sep)) {
          current = join(current, part)
          if (lstatSync(current).isSymbolicLink()) throw new Error(`hosted publication contains a symlink: ${target}`)
        }
        if (!lstatSync(source).isFile()) throw new Error(`hosted publication contains a non-file: ${target}`)
        files.push(path)
      }
      if (!files.includes('package.json')) throw new Error(`hosted publication omits package.json: ${target}`)
      return files
    })()
    publicationCache.set(target, pending)
  }
  return pending
}

/** Materialize npm-selected regular files with at most six concurrent publication subprocesses. */
export async function copyHostedPackages(graph, placements) {
  const targets = [...graph.nodes.keys()]
  let index = 0
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, async () => {
    while (index < targets.length) await publishedFiles(targets[index++])
  }))
  for (const [destination, target] of [...placements].sort(([a], [b]) => a.localeCompare(b))) {
    for (const file of await publishedFiles(target)) {
      const output = join(destination, file)
      mkdirSync(dirname(output), { recursive: true })
      cpSync(join(target, file), output, { dereference: false })
    }
  }
}
