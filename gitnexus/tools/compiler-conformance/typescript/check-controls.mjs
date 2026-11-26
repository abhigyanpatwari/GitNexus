import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const controls = ['controls.test.mjs', 'capture-controls.test.mjs', 'product/mcp-tools.ts'].map(
  (file) => fileURLToPath(new URL(file, import.meta.url)),
);
const reporter = new URL('../java/native-reporter.mjs', import.meta.url);
execFileSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-reporter=' + reporter.href, ...controls],
  {
    stdio: 'inherit',
    env: { ...process.env, GITNEXUS_CONFORMANCE_TEST_FILES: JSON.stringify(controls) },
  },
);
