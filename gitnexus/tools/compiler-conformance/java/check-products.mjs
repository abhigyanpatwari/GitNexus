import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCodeUnits } from '../compare.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const platform = process.argv.includes('--platform');
const selected = platform
  ? [
      'product/rename.ts',
      'product/managed-rename.ts',
      'product/lombok-worker-cache.ts',
      'product/overload-impact-persistence.ts',
      'test/provider/parser-loader-abi.ts',
    ]
  : globSync(['product/*.ts', 'test/provider/*.ts'], { cwd: directory });
const files = selected.sort(compareCodeUnits).map((name) => path.join(directory, name));
assert.ok(files.length, 'No Java product conformance checks found');
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
    [path.join(directory, 'check-resolution.mjs'), 'r5-non-ascii-identifiers'],
    { stdio: 'inherit' },
  );
}
