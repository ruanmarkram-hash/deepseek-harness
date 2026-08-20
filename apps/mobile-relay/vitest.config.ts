import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ['../../tsconfig.base.json'] }),
    cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } }),
  ],
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
