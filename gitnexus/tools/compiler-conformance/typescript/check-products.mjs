import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const platform = process.argv.includes('--platform');
const selected = platform
  ? [
      'product/dangling-owner-edges.ts',
      'product/fetch-wrapper-persistence.ts',
      'product/ignore-and-skip-e2e.ts',
      'product/pipeline-graph-golden.ts',
      'product/rename.ts',
      'provider/rename-typescript-member-keys.ts',
    ]
  : globSync(['product/*.ts', 'provider/*.ts'], { cwd: directory });
const files = selected.sort().map((file) => path.join(directory, file));
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
    env: { ...process.env, GITNEXUS_CONFORMANCE_TEST_FILES: JSON.stringify(files) },
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
