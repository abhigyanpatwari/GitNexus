/**
 * Vitest config for mutation runs (KTD9). It runs only inside a prepared copy
 * (tools/mutation/prepare/prepare.ts) or a Stryker sandbox of one.
 *
 * Differences from gitnexus/vitest.config.ts, each on gate 1's allowed list:
 * - the root test settings are reused, but `projects` is replaced by one `mutation` project
 *   whose `include` is the `testFiles` of the scope file named by GITNEXUS_MUTATION_SCOPE
 *   (tools/mutation/scope-file.ts);
 * - `gitnexus-shared` imports resolve, through one regex alias per package `exports` key, to the
 *   relocated sources next to this file's copy (KTD8), never to the checkout's package;
 * - `dangerouslyIgnoreUnhandledErrors` is off, so an unhandled error fails the run.
 *
 * Usage (from the prepared gitnexus/ dir):
 *   GITNEXUS_MUTATION_SCOPE=<scope.json> npx vitest run --config tools/mutation/vitest.mutation.config.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.config.js';
import {
  RELOCATED_SHARED_DIR,
  deriveSharedAliases,
  parseSharedPackageJson,
} from './prepare/path-map.js';
import { parseMutationScope, resolveMutationScopePath } from './scope-file.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const sharedDir = path.join(packageDir, RELOCATED_SHARED_DIR);
const sharedManifest = path.join(sharedDir, 'package.json');
if (!existsSync(sharedManifest)) {
  throw new Error(
    `vitest.mutation.config: ${sharedManifest} is missing; run this config inside a prepared copy ` +
      '(npm run test:mutation:prepare)',
  );
}
const aliases = deriveSharedAliases(
  parseSharedPackageJson(readFileSync(sharedManifest, 'utf8')),
  sharedDir,
);
for (const alias of aliases) {
  if (!existsSync(alias.replacement)) {
    throw new Error(`vitest.mutation.config: alias target ${alias.replacement} is missing`);
  }
}
const scope = parseMutationScope(
  readFileSync(resolveMutationScopePath(process.env, packageDir), 'utf8'),
);

const { projects: _baseProjects, ...rootTest } = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: aliases.map(({ find, replacement }) => ({ find, replacement })),
  },
  test: {
    ...rootTest,
    dangerouslyIgnoreUnhandledErrors: false,
    projects: [{ extends: true, test: { name: 'mutation', include: scope.testFiles } }],
  },
});
