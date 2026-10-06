// Harness-owned config: benchmark candidates must not be able to weaken test
// discovery, setup hooks, or pass-with-no-tests behavior through repo config.
export default {
  root: process.cwd(),
  test: {
    environment: 'node',
    globals: false,
    setupFiles: [],
    globalSetup: [],
    passWithNoTests: false,
    // Cold source CLI loads can exceed Vitest's five-second default.
    testTimeout: 120_000,
    // Declared dependency trees are mounted read-only during verification.
    cache: false,
    include: ['../.wfbench-oracle-*/*.oracle.test.ts'],
    exclude: [],
  },
};
