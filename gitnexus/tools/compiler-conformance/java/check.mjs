import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const spring = fileURLToPath(new URL('./spring-check.mjs', import.meta.url));
const correctnessEnv = { ...process.env };
delete correctnessEnv.GITNEXUS_BENCH;
for (const args of [
  [
    '--test',
    ...['fixture-ownership', 'native-reporter', 'platform-packages'].map((name) =>
      fileURLToPath(new URL('./' + name + '.test.mjs', import.meta.url)),
    ),
  ],
  [fileURLToPath(new URL('./check-fixture-ownership.mjs', import.meta.url))],
  [fileURLToPath(new URL('./check-compiler.mjs', import.meta.url)), ...process.argv.slice(2)],
  [fileURLToPath(new URL('./check-resolution.mjs', import.meta.url))],
  [spring],
  [fileURLToPath(new URL('./check-products.mjs', import.meta.url))],
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
