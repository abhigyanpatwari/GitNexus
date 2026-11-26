import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const platform = process.argv.includes('--platform');
const shardFlag = process.argv.indexOf('--shard');
const shard = shardFlag === -1 ? '1/1' : process.argv[shardFlag + 1];
assert.match(shard ?? '', /^[1-9]\d*\/[1-9]\d*$/, 'Expected --shard INDEX/TOTAL');
const [index, total] = shard.split('/').map(Number);
assert.ok(index <= total, 'Shard index exceeds shard count');
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
      'product/embedding-job-controller.ts',
      'product/embedding-source-admission.ts',
      'product/fetch-wrapper-persistence.ts',
      'product/filesystem-walker.ts',
      'product/fts-extension-e2e.ts',
      'product/git-index-source-paths.ts',
      'product/git-working-tree.ts',
      'product/graphql-resolve-symbol.ts',
      'product/ignore-and-skip-e2e.ts',
      'product/impact-private-type-source.ts',
      'product/incremental-dirty-recovery.ts',
      'product/incremental-index-extension-dml-gate.ts',
      'product/incremental-vector-extension-ordering.ts',
      'product/indexed-reference-sites.ts',
      'product/local-binding-identities.ts',
      'product/local-import-persistence.ts',
      'product/local-import-worker-parity.ts',
      'product/mcp-refresh-index-e2e.ts',
      'product/opencode-plugin.ts',
      'product/pipeline-graph-golden.ts',
      'product/query-symbol-integrity.ts',
      'product/rename.ts',
      'product/rename-plan.ts',
      'product/rename-preview-plans.ts',
      'product/shard-timings-roundtrip.ts',
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
  .filter((_, offset) => offset % total === index - 1)
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
