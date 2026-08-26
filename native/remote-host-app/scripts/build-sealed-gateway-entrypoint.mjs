import { readdir, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import process from 'node:process'

const arguments_ = process.argv.slice(2)
if (arguments_.length !== 2 || arguments_[0] !== '--output' || !arguments_[1]?.startsWith('/')) {
  process.stderr.write('usage: build-sealed-gateway-entrypoint.mjs --output /absolute/dsh-remote-host-v3.mjs\n')
  process.exit(64)
}

const root = resolve(import.meta.dirname, '..')
const projectRoot = resolve(root, '../..')
const output = resolve(arguments_[1])
const staged = `${output}.staging-${process.pid}`
const entry = resolve(root, 'GatewayRuntime/entrypoint.ts')
const maximumBytes = 4 * 1024 * 1024
const permittedNodeBuiltins = new Set(['node:buffer', 'node:crypto', 'node:events', 'node:fs', 'node:fs/promises', 'node:net', 'node:os', 'node:path', 'node:stream', 'node:url', 'node:util', 'node:zlib'])
const execute = promisify(execFile)

if (!output.endsWith('.mjs')) throw new Error('sealed gateway output must end in .mjs')
try { await stat(output); throw new Error('sealed gateway output already exists') } catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
}
await mkdir(dirname(output), { recursive: true })
try {
  const esbuild = await resolveEsbuild(projectRoot)
  await execute('/usr/bin/arch', ['-arm64', esbuild, entry, '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${staged}`, '--legal-comments=none', '--tree-shaking=true'], { cwd: projectRoot })
  const source = await readFile(staged, 'utf8')
  if (Buffer.byteLength(source) === 0 || Buffer.byteLength(source) > maximumBytes) throw new Error('sealed gateway output is outside its byte budget')
  if (/\b(?:require|import)\s*\(/.test(source) || /\bprocess\.env\b/.test(source) || /\b(?:node:)?child_process\b/.test(source)) throw new Error('sealed gateway output contains forbidden runtime discovery or child-process access')
  if (/\b(?:createServer|createConnection)\s*\(/.test(source) || /\.connect\s*\(/.test(source) || /\bWebSocket\b/.test(source) || /127\.0\.0\.1|\b3080\b/.test(source)) {
    throw new Error('sealed gateway output contains a network listener, outbound connector, or loopback carrier')
  }
  const imports = [...source.matchAll(/\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)].map(match => match[1])
  if (imports.some(specifier => !permittedNodeBuiltins.has(specifier))) throw new Error('sealed gateway output has a non-builtin import')
  await rename(staged, output)
} catch (error) {
  await rm(staged, { force: true })
  throw error
}

/** Finds the already-locked local compiler without fetching or resolving a global tool. */
async function resolveEsbuild(project) {
  const pnpmStore = resolve(project, 'node_modules/.pnpm')
  const candidates = (await readdir(pnpmStore)).filter(name => /^esbuild@[0-9]/.test(name)).sort().reverse()
  for (const candidate of candidates) {
    const executable = resolve(pnpmStore, candidate, 'node_modules/esbuild/bin/esbuild')
    try {
      const metadata = await stat(executable)
      if (metadata.isFile()) return executable
    } catch {
      // Continue only through the already-installed lockfile store.
    }
  }
  throw new Error('the locked local esbuild compiler is unavailable')
}
