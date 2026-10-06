import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Discover the opt-in suites from source so a new benchmark cannot silently
// miss a hand-maintained workflow list. Keep wall-clock measurements serial.
const files = globSync('test/**/*.test.ts', { cwd: root })
  .filter((file) =>
    /process\.env(?:\.GITNEXUS_BENCH|\[['"]GITNEXUS_BENCH['"]\])/.test(
      readFileSync(new URL(`../${file.replaceAll('\\', '/')}`, import.meta.url), 'utf8'),
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
    '--outputFile=benchmarks.json',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, GITNEXUS_BENCH: '1' },
  },
);
