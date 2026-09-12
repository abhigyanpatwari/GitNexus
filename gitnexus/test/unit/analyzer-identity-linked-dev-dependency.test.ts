/**
 * Locally linked dev dependencies in the analyzer identity receipt (#2798).
 *
 * `dependencyNames` admits a devDependency whose declared SPECIFIER is
 * checkout-local (`file:`/`link:`/`workspace:`/`portal:` and bare local paths).
 * `npm link <pkg>` leaves the specifier a registry range and only replaces the
 * `node_modules` entry with a symlink into a checkout, so the specifier check is
 * blind to it while the linked code is just as load-bearing for analyzer
 * semantics as a declared `file:` sibling.
 *
 * The second, RESOLVED-LOCATION half closes that: the resolver already returns a
 * realpath, so a linked package reports a root carrying no `node_modules`
 * segment. These tests pin the three properties that make it affordable and
 * safe — root-only scoping, the pnpm-store exclusion, and the admission cap —
 * plus the declared half it does not replace.
 */

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  _clearAnalyzerIdentityProcessCacheForTests,
  _hasNodeModulesSegmentForTests,
  resolveAnalyzerRunnerIdentity,
} from '../../src/core/analyzer-identity.js';
import type { AnalyzerRunnerIdentity } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

type Fixture = { root: string; modulePath: string };

type FixtureOptions = {
  /** Root `devDependencies`, verbatim. */
  devDependencies?: Record<string, string>;
  /** `devDependencies` for the nested runtime dependency (root-only scoping). */
  nestedDevDependencies?: Record<string, string>;
};

/**
 * A package root with one ordinary resolvable runtime dependency, so every
 * fixture starts from `packageCount: 2` (root + `runtime-package`).
 */
async function createFixture(root: string, options: FixtureOptions = {}): Promise<Fixture> {
  const modulePath = path.join(root, 'src', 'core', 'analyzer.ts');
  const runtimeRoot = path.join(root, 'node_modules', 'runtime-package');
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture-analyzer',
      version: '9.8.7',
      dependencies: { 'runtime-package': '1.0.0' },
      ...(options.devDependencies ? { devDependencies: options.devDependencies } : {}),
    }),
  );
  await writeFile(modulePath, 'export const analyzer = 1;\n');
  await writeFile(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify({
      name: 'runtime-package',
      version: '1.0.0',
      ...(options.nestedDevDependencies ? { devDependencies: options.nestedDevDependencies } : {}),
    }),
  );
  await writeFile(path.join(runtimeRoot, 'runtime.js'), 'export const runtime = 1;\n');
  return { root, modulePath };
}

/** A checkout-local package: a real directory OUTSIDE any `node_modules` tree. */
async function createCheckout(root: string, name: string, payload: string): Promise<string> {
  const checkout = path.join(root, 'checkouts', name);
  await mkdir(checkout, { recursive: true });
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  await writeFile(path.join(checkout, 'tool.js'), payload);
  return checkout;
}

/**
 * Resolve cold. Each call gets its own cache directory AND drops the in-process
 * LRU, whose key does not include the cache directory — without both, a second
 * resolution in the same test would echo the first receipt instead of
 * recomputing it, which is precisely what these assertions must not do.
 */
function resolveCold(
  fixture: Fixture,
  run: number,
  onGuardCount?: (guardCount: number) => void,
): AnalyzerRunnerIdentity {
  _clearAnalyzerIdentityProcessCacheForTests();
  return resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
    cacheDirectory: path.join(fixture.root, `identity-cache-${run}`),
    onCacheValidationPass: ({ guardCount }) => onGuardCount?.(guardCount),
  });
}

describe('analyzer identity resolved-location dev dependencies (#2798)', () => {
  // Every case here needs a symbolic link to exist; Windows runners without the
  // developer-mode privilege cannot create one, so the whole block is skipped
  // rather than branching inside test bodies.
  describe.skipIf(process.platform === 'win32')('npm link shape', () => {
    it('admits a registry-specifier dev dependency symlinked to a checkout', async () => {
      const temp = await createTempDir();
      try {
        const fixture = await createFixture(temp.dbPath, {
          // A registry RANGE: `isLocallyLinkedSpecifier` rejects this, so only
          // the resolved-location half can admit the package.
          devDependencies: { 'linked-tool': '^1.0.0' },
        });
        const checkout = await createCheckout(temp.dbPath, 'linked-tool', 'export const v = 1;\n');
        await symlink(checkout, path.join(temp.dbPath, 'node_modules', 'linked-tool'), 'dir');

        const first = resolveCold(fixture, 1);
        // root + runtime-package + the linked checkout.
        expect(first.dependencyRuntime.packageCount).toBe(3);

        // The regression this closes: a SEMANTIC-ONLY edit inside the linked
        // checkout moved neither digest before the resolved-location half.
        await writeFile(path.join(checkout, 'tool.js'), 'export const v = 2;\n');
        const second = resolveCold(fixture, 2);
        expect(second.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);
      } finally {
        await temp.cleanup();
      }
    });

    it('excludes a pnpm virtual-store link that stays inside node_modules', async () => {
      const temp = await createTempDir();
      try {
        const fixture = await createFixture(temp.dbPath, {
          devDependencies: { 'pnpm-tool': '^1.0.0' },
        });
        const store = path.join(
          temp.dbPath,
          'node_modules',
          '.pnpm',
          'pnpm-tool@1.0.0',
          'node_modules',
          'pnpm-tool',
        );
        await mkdir(store, { recursive: true });
        await writeFile(
          path.join(store, 'package.json'),
          JSON.stringify({ name: 'pnpm-tool', version: '1.0.0' }),
        );
        await writeFile(path.join(store, 'tool.js'), 'export const v = 1;\n');
        // pnpm's own shape: `node_modules/<pkg>` IS a symlink, but it points
        // back inside `node_modules`, so the realpath keeps the segment.
        await symlink(
          path.join('.pnpm', 'pnpm-tool@1.0.0', 'node_modules', 'pnpm-tool'),
          path.join(temp.dbPath, 'node_modules', 'pnpm-tool'),
          'dir',
        );

        const first = resolveCold(fixture, 1);
        expect(first.dependencyRuntime.packageCount).toBe(2);

        await writeFile(path.join(store, 'tool.js'), 'export const v = 2;\n');
        const second = resolveCold(fixture, 2);
        expect(second.dependencyRuntime.digest).toBe(first.dependencyRuntime.digest);
      } finally {
        await temp.cleanup();
      }
    });

    it('scopes the resolved-location probe to the root package', async () => {
      const bare = await createTempDir();
      const nested = await createTempDir();
      try {
        // Identical trees except that `runtime-package` — a NON-root package —
        // declares dev-only names that resolve to checkout-local siblings. If
        // the root-only scope is ever dropped, probing them costs extra path
        // guards (re-probed on every warm validation) and folds three more
        // packages into the receipt. Comparing the two runs pins the scope
        // without hard-coding a guard total that unrelated work would churn.
        const bareFixture = await createFixture(bare.dbPath);
        const nestedFixture = await createFixture(nested.dbPath, {
          nestedDevDependencies: {
            'nested-a': '^1.0.0',
            'nested-b': '^1.0.0',
            'nested-c': '^1.0.0',
          },
        });
        for (const name of ['nested-a', 'nested-b', 'nested-c']) {
          const checkout = await createCheckout(nested.dbPath, name, 'export const v = 1;\n');
          await symlink(checkout, path.join(nested.dbPath, 'node_modules', name), 'dir');
        }

        let bareGuards = 0;
        let nestedGuards = 0;
        const bareIdentity = resolveCold(bareFixture, 1, (count) => {
          bareGuards = count;
        });
        const nestedIdentity = resolveCold(nestedFixture, 1, (count) => {
          nestedGuards = count;
        });

        expect({
          guards: nestedGuards,
          packages: nestedIdentity.dependencyRuntime.packageCount,
        }).toEqual({ guards: bareGuards, packages: bareIdentity.dependencyRuntime.packageCount });
        // Pin the shared value too, so an accidental collapse to zero guards on
        // both sides cannot make the comparison vacuous.
        expect(bareGuards).toBeGreaterThan(0);
      } finally {
        await bare.cleanup();
        await nested.cleanup();
      }
    });

    it('disables the resolved-location channel past the admission cap', async () => {
      const under = await createTempDir();
      const over = await createTempDir();
      try {
        const names = ['tool-a', 'tool-b', 'tool-c', 'tool-d', 'tool-e'];
        const link = async (root: string, count: number): Promise<void> => {
          for (const name of names.slice(0, count)) {
            const checkout = await createCheckout(root, name, 'export const v = 1;\n');
            await symlink(checkout, path.join(root, 'node_modules', name), 'dir');
          }
        };
        const devDependencies = (count: number): Record<string, string> =>
          Object.fromEntries(names.slice(0, count).map((name) => [name, '^1.0.0']));

        const underFixture = await createFixture(under.dbPath, {
          devDependencies: devDependencies(4),
        });
        await link(under.dbPath, 4);
        const overFixture = await createFixture(over.dbPath, {
          devDependencies: devDependencies(5),
        });
        await link(over.dbPath, 5);

        // At the cap every link is admitted; one past it the channel is dropped
        // WHOLESALE rather than admitting an arbitrary prefix, because a
        // mis-firing proxy folds the entire dev tree in and
        // runtimePackages/runtimeEntries/runtimeBytes THROW rather than degrade.
        expect({
          under: resolveCold(underFixture, 1).dependencyRuntime.packageCount,
          over: resolveCold(overFixture, 1).dependencyRuntime.packageCount,
        }).toEqual({ under: 6, over: 2 });
      } finally {
        await under.cleanup();
        await over.cleanup();
      }
    });
  });

  it('keeps enumerating a declared file: dev link whose checkout is absent', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath, {
        devDependencies: { 'declared-link': 'file:./declared-link' },
      });

      // Nothing resolves: the declared half is the only thing that enumerates
      // the name at all, and it contributes a `<missing>` edge.
      const absent = resolveCold(fixture, 1);
      expect(absent.dependencyRuntime.packageCount).toBe(2);

      // Materialize it as a real DIRECTORY under node_modules — a copied
      // `file:` install. Its realpath still carries a `node_modules` segment,
      // so the resolved-location half provably cannot admit it and this
      // transition isolates the declared half.
      const materialized = path.join(temp.dbPath, 'node_modules', 'declared-link');
      await mkdir(materialized, { recursive: true });
      await writeFile(
        path.join(materialized, 'package.json'),
        JSON.stringify({ name: 'declared-link', version: '1.0.0' }),
      );
      await writeFile(path.join(materialized, 'tool.js'), 'export const v = 1;\n');

      const present = resolveCold(fixture, 2);
      expect(present.dependencyRuntime.packageCount).toBe(3);
      expect(present.dependencyRuntime.digest).not.toBe(absent.dependencyRuntime.digest);

      // Removing it returns to the `<missing>` receipt rather than to a
      // silently-dropped name.
      await rm(materialized, { recursive: true });
      const removed = resolveCold(fixture, 3);
      expect(removed.dependencyRuntime.digest).toBe(absent.dependencyRuntime.digest);
    } finally {
      await temp.cleanup();
    }
  });

  it('treats node_modules as a whole path segment, per platform separator', () => {
    expect({
      checkout: _hasNodeModulesSegmentForTests('/home/u/checkouts/tool', path.posix),
      installed: _hasNodeModulesSegmentForTests('/home/u/app/node_modules/tool', path.posix),
      substring: _hasNodeModulesSegmentForTests('/home/u/node_modules_old/tool', path.posix),
      nested: _hasNodeModulesSegmentForTests(
        '/a/node_modules/.pnpm/x@1/node_modules/x',
        path.posix,
      ),
      // `\` is a legal POSIX filename character, so it is NOT a boundary there
      // — but it is the separator win32 realpaths come back with.
      posixBackslash: _hasNodeModulesSegmentForTests('/a/node_modules\\x/tool', path.posix),
      win32Backslash: _hasNodeModulesSegmentForTests('C:\\app\\node_modules\\tool', path.win32),
      win32Substring: _hasNodeModulesSegmentForTests('C:\\app\\node_modulesx\\tool', path.win32),
    }).toEqual({
      checkout: false,
      installed: true,
      substring: false,
      nested: true,
      posixBackslash: false,
      win32Backslash: true,
      win32Substring: false,
    });
  });
});
