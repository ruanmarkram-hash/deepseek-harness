// Bundle the launcher while resolving published packages from the copied,
// signed HostedChild/node_modules closure. The tree manifest covers both.
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// esbuild is a transitive dependency (vite); resolve the highest installed copy.
const candidates = readdirSync(`${repo}/node_modules/.pnpm`)
  .filter(name => name.startsWith('esbuild@'))
  .map(name => ({ version: name.slice('esbuild@'.length).split('/').join(''), dir: `${repo}/node_modules/.pnpm/${name}/node_modules/esbuild` }))
  .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
const esbuildModule = await import(pathToFileURL(`${candidates[0].dir}/lib/main.js`).href)
const esbuild = esbuildModule.default ?? esbuildModule

const external = process.argv.slice(2)
const outfile = process.env.DSH_WEB_OUT ?? `${repo}/native/remote-host-app/dist/dsh-web.mjs`
// Requires a prior `node-gyp rebuild` inside node-pty when missing darwin-arm64 prebuilds.

await esbuild.build({
  stdin: {
    contents: "import { runCli } from './apps/cli/src/bin.ts'; await runCli();",
    resolveDir: repo,
    sourcefile: 'hosted-cli-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  packages: 'external',
  define: { 'import.meta.main': 'false' },
  external,
  banner: {
    // Bundled CJS deps (ws, etc.) still call require() for node builtins.
    js: "import { createRequire as __cR } from 'node:module';\nconst require = __cR(import.meta.url);",
  },
  logLevel: 'info',
})
console.log(`bundled -> ${outfile}`)
