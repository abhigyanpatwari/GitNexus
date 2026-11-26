import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const platform = process.argv.includes('--platform');
const selected = platform
  ? [
      'product/analysis-embedding-flow.ts',
      'product/analysis-generation-routing.ts',
      'product/analysis-publication-flow.ts',
      'product/analyze-atomic-swap.ts',
      'product/analyze-dirty-snapshot.ts',
      'product/analyze-wal-checkpoint-failure.ts',
      'product/class-expression-owners.ts',
      'product/cli-e2e.ts',
      'product/cross-platform-test-arguments.ts',
      'product/dangling-owner-edges.ts',
      'product/embedding-identity-integrity.ts',
      'product/embedding-input-isolation.ts',
      'product/fetch-wrapper-persistence.ts',
      'product/filesystem-walker.ts',
      'product/fts-extension-e2e.ts',
      'product/git-working-tree.ts',
      'product/graphql-resolve-symbol.ts',
      'product/ignore-and-skip-e2e.ts',
      'product/local-import-persistence.ts',
      'product/local-import-worker-parity.ts',
      'product/mcp-refresh-index-e2e.ts',
      'product/opencode-plugin.ts',
      'product/pipeline-graph-golden.ts',
      'product/query-symbol-integrity.ts',
      'product/rename.ts',
      'product/shared-store-embedding-reuse.ts',
      'product/skills-e2e.ts',
      'product/watch-filesystem.ts',
      'provider/rename-typescript-member-keys.ts',
    ]
  : globSync(['product/*.ts', 'provider/*.ts'], { cwd: directory });
// The atomic-rename publication path runs on POSIX. Windows publishes in place.
const files = selected
  .filter((file) => process.platform !== 'win32' || file !== 'product/analyze-atomic-swap.ts')
  .sort()
  .map((file) => path.join(directory, file));
assert.ok(files.length, 'No TypeScript product checks found');
execFileSync(
  process.execPath,
  [
    '--experimental-test-module-mocks',
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-reporter=' + new URL('../native-reporter.mjs', import.meta.url).href,
    ...files,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      GITNEXUS_E2E_CLI: process.env.GITNEXUS_E2E_CLI ?? 'dist',
      GITNEXUS_CONFORMANCE_TEST_FILES: JSON.stringify(files),
    },
  },
);
if (platform) {
  execFileSync(
    process.execPath,
    [
      path.join(directory, 'check.mjs'),
      path.resolve(directory, '../../../test/fixtures/compiler-conformance/typescript-bindings'),
    ],
    { stdio: 'inherit' },
  );
}
