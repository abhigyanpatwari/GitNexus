/**
 * Vitest config of the gate 2 conformance fixture (U4). The conformance driver
 * (tools/mutation/conformance/run-conformance.ts) runs it through the scope driver with the
 * vitest5 runner: `configFile` is this file and the project is `conformance`. Only the settings
 * the runner requires (forks, isolation, task locations) and the fixture's short timeouts are set,
 * so a change to gitnexus/vitest.config.ts cannot move the pinned results.
 *
 * Like tools/mutation/vitest.mutation.config.ts, the include list is the `testFiles` of the scope
 * file named by GITNEXUS_MUTATION_SCOPE. The fixture's tests are `*.case.ts` files, which no repo
 * Vitest project collects.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import {
  parseMutationScope,
  resolveMutationScopePath,
} from '../../../tools/mutation/scope-file.js';

const packageDir = fileURLToPath(new URL('../../../', import.meta.url));
const scope = parseMutationScope(
  readFileSync(resolveMutationScopePath(process.env, packageDir), 'utf8'),
);

export default defineConfig({
  test: {
    pool: 'forks',
    isolate: true,
    includeTaskLocation: true,
    // Short limits keep the timeout cases quick; every passing test finishes in milliseconds.
    testTimeout: 2000,
    hookTimeout: 2000,
    teardownTimeout: 1000,
    dangerouslyIgnoreUnhandledErrors: false,
    projects: [{ extends: true, test: { name: 'conformance', include: scope.testFiles } }],
  },
});
