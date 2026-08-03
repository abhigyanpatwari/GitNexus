/**
 * Symbolic-link handling in the analyzer runtime-payload scan (#2798).
 *
 * `collectArtifacts` used to fuse two unrelated facts into one condition:
 * "this name is never runtime payload" and "a symlink must not reach the
 * file-payload branch". Only the four pruned names got the symlink half, so any
 * OTHER symlinked directory inside a scanned package root — `dist -> build`, a
 * vendored-grammar link, anything in a workspace-linked sibling checkout — fell
 * through to `snapshotReadableFile`, which stats the target, sees a directory,
 * and throws `Analyzer identity input is not a file`, aborting the whole
 * analyze. Workspace-linked packages became scannable on this branch, so the
 * crash is newly reachable (this worktree's own `gitnexus-shared/node_modules`
 * is a symlink).
 *
 * These tests pin the split: prune by NAME alone, and route every symlink that
 * does not resolve to a regular file into a link-text artifact instead of the
 * payload branch.
 */

import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  _clearAnalyzerIdentityProcessCacheForTests,
  resolveAnalyzerRunnerIdentity,
} from '../../src/core/analyzer-identity.js';
import { createTempDir } from '../helpers/test-db.js';

type Fixture = {
  root: string;
  modulePath: string;
  cacheDirectory: string;
  packageRoot: string;
};

/** A package root with one resolvable dependency whose payload tree we mutate. */
async function createFixture(root: string): Promise<Fixture> {
  const modulePath = path.join(root, 'src', 'core', 'analyzer.ts');
  const packageRoot = path.join(root, 'node_modules', 'runtime-package');
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(path.join(packageRoot, 'build'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture-analyzer',
      version: '9.8.7',
      dependencies: { 'runtime-package': '1.0.0' },
    }),
  );
  await writeFile(modulePath, 'export const analyzer = 1;\n');
  await writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'runtime-package', version: '1.0.0' }),
  );
  await writeFile(path.join(packageRoot, 'runtime.js'), 'export const runtime = 1;\n');
  await writeFile(path.join(packageRoot, 'build', 'native.node'), 'native-v1');
  return { root, modulePath, cacheDirectory: path.join(root, 'identity-cache'), packageRoot };
}

/**
 * Create a symbolic link, reporting whether the platform allowed it. Windows
 * runners without the developer-mode privilege cannot create links at all;
 * mirrors the guard used by the sibling analyzer-identity suite.
 */
async function trySymlink(
  target: string,
  linkPath: string,
  type: 'dir' | 'file',
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

describe('analyzer identity runtime-payload symbolic links (#2798)', () => {
  it('records a symlinked directory instead of aborting the scan', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath);
      // NOT one of the four pruned names: this is the case that used to throw
      // `Analyzer identity input is not a file` and abort the entire analyze.
      const linked = await trySymlink(
        path.join(fixture.packageRoot, 'build'),
        path.join(fixture.packageRoot, 'dist'),
        'dir',
      );
      if (!linked) return;

      const identity = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });

      // runtime.js + build/native.node + the recorded `dist` link.
      expect(identity.dependencyRuntime).toMatchObject({
        packageCount: 2,
        artifactCount: 3,
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
    } finally {
      await temp.cleanup();
    }
  });

  it('moves the receipt when a recorded directory link is retargeted', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath);
      await mkdir(path.join(fixture.packageRoot, 'build-next'));
      await writeFile(path.join(fixture.packageRoot, 'build-next', 'native.node'), 'native-v1');
      const linkPath = path.join(fixture.packageRoot, 'dist');
      if (!(await trySymlink(path.join(fixture.packageRoot, 'build'), linkPath, 'dir'))) return;

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });

      await unlink(linkPath);
      await symlink(path.join(fixture.packageRoot, 'build-next'), linkPath, 'dir');
      _clearAnalyzerIdentityProcessCacheForTests();
      const retargeted = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });

      // Both targets hold byte-identical payloads, so only the link TEXT
      // distinguishes them. Recording it is what keeps the retarget visible.
      expect(retargeted.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);
    } finally {
      await temp.cleanup();
    }
  });

  it('reuses the warm cache for a recorded directory link', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath);
      const linked = await trySymlink(
        path.join(fixture.packageRoot, 'build'),
        path.join(fixture.packageRoot, 'dist'),
        'dir',
      );
      if (!linked) return;

      const cold = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });

      // Drop the in-process reuse so the second call must load, validate, and
      // accept the persisted cache — including the link artifact's guard.
      _clearAnalyzerIdentityProcessCacheForTests();
      let work = 0;
      let hashes = 0;
      const warm = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
        onCacheMissWork: () => {
          work += 1;
        },
        onHashedInput: () => {
          hashes += 1;
        },
      });

      expect(warm).toEqual(cold);
      expect({ work, hashes }).toEqual({ work: 0, hashes: 0 });
    } finally {
      await temp.cleanup();
    }
  });

  it('records a dangling link rather than failing the whole analyze', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath);
      const linkPath = path.join(fixture.packageRoot, 'dangling.js');
      if (!(await trySymlink(path.join(fixture.packageRoot, 'absent.js'), linkPath, 'file')))
        return;

      const identity = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });
      expect(identity.dependencyRuntime.artifactCount).toBe(3);

      // Creating the target promotes the link to a content-hashed payload.
      await writeFile(path.join(fixture.packageRoot, 'absent.js'), 'export const late = 1;\n');
      _clearAnalyzerIdentityProcessCacheForTests();
      const resolved = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });
      expect(resolved.dependencyRuntime.digest).not.toBe(identity.dependencyRuntime.digest);
    } finally {
      await temp.cleanup();
    }
  });

  it('does not follow a self-referential link into the depth limit', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath);
      // Following links would recurse here until `runtimeDepth` THREW — trading
      // one hard abort for another. Recording the link text is cycle-free.
      if (!(await trySymlink(fixture.packageRoot, path.join(fixture.packageRoot, 'self'), 'dir'))) {
        return;
      }

      const identity = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
        traversalLimits: { runtimeDepth: 4 },
      });
      expect(identity.dependencyRuntime.artifactCount).toBe(3);
    } finally {
      await temp.cleanup();
    }
  });

  it('still hashes the target content behind a link to a regular file', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath);
      const target = path.join(fixture.packageRoot, 'build', 'native.node');
      if (!(await trySymlink(target, path.join(fixture.packageRoot, 'linked.node'), 'file')))
        return;

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });
      expect(first.dependencyRuntime.artifactCount).toBe(3);

      // Only the TARGET's bytes change; the link text and its lstat are
      // untouched. A link-text-only recording would go blind here, so this is
      // the guard that the file-payload branch still owns resolvable links.
      await writeFile(target, 'native-v2-changed');
      _clearAnalyzerIdentityProcessCacheForTests();
      const changed = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });
      expect(changed.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);
    } finally {
      await temp.cleanup();
    }
  });

  it('prunes the VCS/nested-install names by name alone, whatever their type', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath);
      // A `.git` FILE is what a submodule or linked worktree checkout carries;
      // it is a gitdir pointer, never analyzer payload, and it churns whenever
      // the checkout moves. Pruning on the name alone keeps it out.
      const gitPointer = path.join(fixture.packageRoot, '.git');
      await writeFile(gitPointer, 'gitdir: /elsewhere/.git/worktrees/one\n');

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });
      expect(first.dependencyRuntime.artifactCount).toBe(2);

      await writeFile(gitPointer, 'gitdir: /moved/.git/worktrees/two\n');
      _clearAnalyzerIdentityProcessCacheForTests();
      const moved = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });
      expect(moved.dependencyRuntime.digest).toBe(first.dependencyRuntime.digest);
    } finally {
      await temp.cleanup();
    }
  });

  it('keeps pruning a linked node_modules tree it never owned', async () => {
    const temp = await createTempDir();
    try {
      const fixture = await createFixture(temp.dbPath);
      const shared = path.join(temp.dbPath, 'shared-store');
      await mkdir(path.join(shared, 'nested'), { recursive: true });
      await writeFile(path.join(shared, 'nested', 'payload.js'), 'export const nested = 1;\n');
      // The shape this worktree ships: a workspace checkout whose
      // `node_modules` is a symbolic link into a shared store.
      if (!(await trySymlink(shared, path.join(fixture.packageRoot, 'node_modules'), 'dir')))
        return;

      const identity = resolveAnalyzerRunnerIdentity(pathToFileURL(fixture.modulePath).href, {
        cacheDirectory: fixture.cacheDirectory,
      });
      expect(identity.dependencyRuntime.artifactCount).toBe(2);
    } finally {
      await temp.cleanup();
    }
  });
});
