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
      // Auto-ratchet: vitest bumps thresholds when coverage exceeds them.
      // CI will fail if a PR drops below these floors.
      thresholds: {
        statements: 26,
        branches: 23,
        functions: 28,
        lines: 27,
        autoUpdate: true,
      },
    },
  },
});
