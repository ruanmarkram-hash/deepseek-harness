// One-shot production bundler: apps/cli -> a single self-contained dsh-web.mjs
// whose SHA-256 covers every behavior the hosted child can execute.
// Workspace packages alias from tsconfig.base.json paths; native modules must
// be passed as --external arguments and shipped in HostedChild/node_modules.
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(`${repo}/apps/cli/package.json`)

// esbuild is a transitive dependency (vite); resolve the highest installed copy.
const candidates = readdirSync(`${repo}/node_modules/.pnpm`)
  .filter(name => name.startsWith('esbuild@'))
  .map(name => ({ version: name.slice('esbuild@'.length).split('/').join(''), dir: `${repo}/node_modules/.pnpm/${name}/node_modules/esbuild` }))
  .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
const esbuildModule = await import(pathToFileURL(`${candidates[0].dir}/lib/main.js`).href)
const esbuild = esbuildModule.default ?? esbuildModule

function stripJsonComments(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      out += char
      if (char === '\\') { out += next; i += 1 }
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue }
    if (char === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; out += ' '; continue }
    out += char
  }
  return out
}

const tsconfig = JSON.parse(stripJsonComments(readFileSync(`${repo}/tsconfig.base.json`, 'utf8')))
const paths = tsconfig.compilerOptions?.paths ?? {}
const alias = Object.fromEntries(
  Object.entries(paths)
    .filter(([key]) => !key.includes('*'))
    .map(([key, targets]) => [key, `${repo}/${targets[0]}`]),
)

const external = process.argv.slice(2)
const outfile = process.env.DSH_WEB_OUT ?? `${repo}/native/remote-host-app/dist/dsh-web.mjs`
// Requires a prior `node-gyp rebuild` inside node-pty when missing darwin-arm64 prebuilds.

await esbuild.build({
  entryPoints: [`${repo}/apps/cli/src/bin.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  alias,
  external,
  banner: {
    // Bundled CJS deps (ws, etc.) still call require() for node builtins.
    js: "import { createRequire as __cR } from 'node:module';\nconst require = __cR(import.meta.url);",
  },
  logLevel: 'info',
})
console.log(`bundled -> ${outfile}`)
