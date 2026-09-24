import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ['../../tsconfig.base.json'] }),
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { V3_PROVISIONING_TOKEN: 'test_v3_provisioning_token_that_is_long_123456' } },
    }),
  ],
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
