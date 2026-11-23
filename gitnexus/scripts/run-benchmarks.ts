import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [selection] = process.argv.slice(2);
if (selection !== undefined && selection !== '--java' && selection !== '--exclude-java') {
  throw new Error('Usage: npm run test:benchmarks -- [--java | --exclude-java]');
}
// Discover the opt-in suites from source so a new benchmark cannot silently
// miss a hand-maintained workflow list. Keep wall-clock measurements serial.
const files = globSync('test/**/*.test.ts', { cwd: root })
  .map((file) => file.replaceAll('\\', '/'))
  .filter(
    (file) => selection === undefined || file.startsWith('test/java/') === (selection === '--java'),
  )
  .filter((file) =>
    /process\.env(?:\.GITNEXUS_BENCH|\[['"]GITNEXUS_BENCH['"]\])/.test(
      readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
    ),
  )
  .sort();
if (!files.length) throw new Error('No benchmark test suites discovered');
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--no-file-parallelism',
    ...files,
    '--reporter=default',
    '--reporter=./scripts/execution-reporter.ts',
    selection === '--java' ? '--outputFile=java-benchmarks.json' : '--outputFile=benchmarks.json',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, GITNEXUS_BENCH: '1' },
  },
);
