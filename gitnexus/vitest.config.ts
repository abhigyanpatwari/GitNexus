import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    globals: true,
    setupFiles: ['test/setup.ts'],
    teardownTimeout: 3000,
    dangerouslyIgnoreUnhandledErrors: true, // KuzuDB N-API destructor segfaults on fork exit — not a test failure
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli/index.ts',          // CLI entry point (commander wiring)
        'src/server/**',              // HTTP server (requires network)
        'src/core/wiki/**',           // Wiki generation (requires LLM)
      ],
      // Ratchet these up as coverage improves — CI will fail if a PR drops below
      thresholds: {
        statements: 25,
        branches: 22,
        functions: 25,
        lines: 25,
      },
    },
  },
});
