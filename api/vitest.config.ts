import { defineConfig } from 'vitest/config';

// The pure helpers under test (filter parser, paging, formatters, ETag) are
// runtime-independent, so the default node environment is enough — no Workers
// pool needed. Endpoint-level tests that need D1 can be added later behind a
// Miniflare/wrangler harness.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
