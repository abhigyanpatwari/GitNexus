import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCodeUnits } from '../compare.mjs';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const javaDirectory = fileURLToPath(new URL('.', import.meta.url));
const products = globSync(['product/*.ts', 'test/provider/*.ts'], { cwd: javaDirectory })
  .sort(compareCodeUnits)
  .map((name) => path.join(javaDirectory, name));
assert.ok(products.length, 'No Java product conformance checks found');
const spring = fileURLToPath(new URL('./spring-check.mjs', import.meta.url));
const correctnessEnv = { ...process.env };
delete correctnessEnv.GITNEXUS_BENCH;
for (const args of [
  ['--test', fileURLToPath(new URL('./fixture-ownership.test.mjs', import.meta.url))],
  [fileURLToPath(new URL('./check-fixture-ownership.mjs', import.meta.url))],
  [fileURLToPath(new URL('./check-compiler.mjs', import.meta.url)), ...process.argv.slice(2)],
  [fileURLToPath(new URL('./check-resolution.mjs', import.meta.url))],
  [spring],
  [
    '--experimental-test-module-mocks',
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    ...products,
  ],
]) {
  execFileSync(process.execPath, args, { cwd: packageRoot, stdio: 'inherit', env: correctnessEnv });
}

// Run timing assertions without V8 instrumentation. The ordinary Spring pass
// checks correctness with coverage enabled on the same fixture families.
if (process.env.GITNEXUS_BENCH === '1') {
  const timingEnv = { ...process.env };
  delete timingEnv.NODE_V8_COVERAGE;
  execFileSync(
    process.execPath,
    [spring, 'annotation-scaling', 'aspect-scaling', 'route-scaling'],
    {
      cwd: packageRoot,
      stdio: 'inherit',
      env: timingEnv,
    },
  );
}
