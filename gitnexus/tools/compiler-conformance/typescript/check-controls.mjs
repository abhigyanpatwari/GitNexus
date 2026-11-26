import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const controls = fileURLToPath(new URL('./controls.test.mjs', import.meta.url));
const reporter = new URL('../java/native-reporter.mjs', import.meta.url);
execFileSync(process.execPath, ['--test', '--test-reporter=' + reporter.href, controls], {
  stdio: 'inherit',
  env: { ...process.env, GITNEXUS_CONFORMANCE_TEST_FILES: JSON.stringify([controls]) },
});
