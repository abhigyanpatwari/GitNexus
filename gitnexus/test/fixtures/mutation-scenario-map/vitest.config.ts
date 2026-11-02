/**
 * Vitest config of the scenario-map controls fixture (Phase 1 plan U17). The `controls` stage of
 * tools/scenario-map (U14) runs every layer on this project, with the fixture's `src/` modules as
 * production files, and compares the verdicts with expected.json. Like
 * test/fixtures/mutation-conformance/vitest.config.ts, only the settings the vitest5 runner
 * requires (forks, isolation, task locations) are set, so a change to gitnexus/vitest.config.ts
 * cannot move the controls. Test order is pinned: the `order-dependent` pair passes only in file
 * order.
 *
 * The fixture's tests are `*.case.ts` files, which no repo Vitest project collects. When
 * GITNEXUS_MUTATION_SCOPE names a scope file (tools/mutation/scope-file.ts), its `testFiles` are
 * the include list, as in tools/mutation/vitest.mutation.config.ts; without it every case file of
 * the fixture runs. Include paths are relative to the `gitnexus/` package, the working directory
 * of every caller.
 *
 * Usage, from gitnexus/:
 *   npx vitest run --config test/fixtures/mutation-scenario-map/vitest.config.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import {
  MUTATION_SCOPE_ENV,
  parseMutationScope,
  resolveMutationScopePath,
} from '../../../tools/mutation/scope-file.js';

const packageDir = fileURLToPath(new URL('../../../', import.meta.url));

/** Every case file of the fixture, relative to the package. */
const ALL_CASES = 'test/fixtures/mutation-scenario-map/*.case.ts';

const include: string[] =
  (process.env[MUTATION_SCOPE_ENV] ?? '') === ''
    ? [ALL_CASES]
    : parseMutationScope(readFileSync(resolveMutationScopePath(process.env, packageDir), 'utf8'))
        .testFiles;

export default defineConfig({
  test: {
    pool: 'forks',
    isolate: true,
    includeTaskLocation: true,
    sequence: { shuffle: false, concurrent: false },
    // Every test finishes in milliseconds; the limits only bound a mutant that loops.
    testTimeout: 5000,
    hookTimeout: 5000,
    teardownTimeout: 1000,
    dangerouslyIgnoreUnhandledErrors: false,
    projects: [{ extends: true, test: { name: 'scenario-map-controls', include } }],
  },
});
