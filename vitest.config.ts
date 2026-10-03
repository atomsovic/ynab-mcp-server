import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Transform the provider so Node tests can mock only the Cloudflare runtime
    // base class while exercising the actual OAuth protocol implementation.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
