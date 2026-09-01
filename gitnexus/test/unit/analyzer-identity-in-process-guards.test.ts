/**
 * #3092 item 6 — ≥128 identity cache guards stay in a subprocess unless
 * `GITNEXUS_ANALYZER_IDENTITY_IN_PROCESS_GUARDS` is truthy or packageRoot /
 * buildRoot fail `W_OK` with EACCES/EROFS. Persist/cache write failure is not
 * that signal. Mutation still fail-closes on both paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const spawnCtx = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnCtx.spawnSync.mockImplementation(((...args: Parameters<typeof actual.spawnSync>) =>
    actual.spawnSync(...args)) as typeof actual.spawnSync);
  return {
    ...actual,
    spawnSync: ((...args: Parameters<typeof actual.spawnSync>) =>
      spawnCtx.spawnSync(...args)) as typeof actual.spawnSync,
  };
});

const fsCtx = vi.hoisted(() => ({
  accessSync: vi.fn(),
  unwritableExact: new Set<string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsCtx.accessSync.mockImplementation(((
    p: Parameters<typeof actual.accessSync>[0],
    mode?: number,
  ) => {
    const pathStr = String(p);
    if (mode === actual.constants.W_OK && fsCtx.unwritableExact.has(pathStr)) {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }
    return actual.accessSync(p, mode);
  }) as typeof actual.accessSync);
  return {
    ...actual,
    accessSync: ((...args: Parameters<typeof actual.accessSync>) =>
      fsCtx.accessSync(...args)) as typeof actual.accessSync,
  };
});

import {
  _clearAnalyzerIdentityProcessCacheForTests,
  resolveAnalyzerRunnerIdentity,
} from '../../src/core/analyzer-identity.js';
import { createTempDir } from '../helpers/test-db.js';

const ENV_KEY = 'GITNEXUS_ANALYZER_IDENTITY_IN_PROCESS_GUARDS';

const isCacheGuardSpawn = (call: unknown[]): boolean => {
  const argv = call[1];
  return Array.isArray(argv) && argv.includes('--input-type=commonjs') && argv.includes('-e');
};

const cacheGuardSpawnCount = (): number =>
  spawnCtx.spawnSync.mock.calls.filter((call) => isCacheGuardSpawn(call as unknown[])).length;

async function seedWideBuildTree(root: string): Promise<{
  modulePath: string;
  sourceRoot: string;
  packageRoot: string;
  mutatedPath: string;
}> {
  const packageRoot = root;
  const sourceRoot = path.join(root, 'src');
  const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
  await mkdir(path.dirname(modulePath), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    '{"name":"fixture-analyzer","version":"9.8.7"}\n',
  );
  await writeFile(modulePath, 'export const analyzer = 1;\n');
  for (let i = 0; i < 140; i += 1) {
    await writeFile(path.join(sourceRoot, `wide-${i}.ts`), `export const n${i} = ${i};\n`);
  }
  return {
    modulePath,
    sourceRoot,
    packageRoot,
    mutatedPath: path.join(sourceRoot, 'wide-0.ts'),
  };
}

describe('analyzer identity in-process cache guards (#3092)', () => {
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    spawnCtx.spawnSync.mockClear();
    fsCtx.unwritableExact.clear();
    _clearAnalyzerIdentityProcessCacheForTests();
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previousEnv;
    fsCtx.unwritableExact.clear();
    _clearAnalyzerIdentityProcessCacheForTests();
  });

  it('uses spawnSync for ≥128 guards on a writable tree when env is unset', async () => {
    const fixture = await createTempDir();
    try {
      const tree = await seedWideBuildTree(fixture.dbPath);
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      let guardCount = 0;
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, {
        cacheDirectory,
        onCacheValidationPass: ({ guardCount: n }) => {
          guardCount = n;
        },
      });
      expect(guardCount).toBeGreaterThanOrEqual(128);
      spawnCtx.spawnSync.mockClear();
      _clearAnalyzerIdentityProcessCacheForTests();
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, { cacheDirectory });
      expect(cacheGuardSpawnCount()).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['1', 'true', 'yes'])('skips spawn when env is %j', async (value) => {
    const fixture = await createTempDir();
    try {
      process.env[ENV_KEY] = value;
      const tree = await seedWideBuildTree(fixture.dbPath);
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, { cacheDirectory });
      spawnCtx.spawnSync.mockClear();
      _clearAnalyzerIdentityProcessCacheForTests();
      const warm = resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, {
        cacheDirectory,
      });
      expect(cacheGuardSpawnCount()).toBe(0);
      expect(warm.schemaVersion).toBe(4);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['0', 'false', 'off', ''])('still spawns when env is %j', async (value) => {
    const fixture = await createTempDir();
    try {
      process.env[ENV_KEY] = value;
      const tree = await seedWideBuildTree(fixture.dbPath);
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, { cacheDirectory });
      spawnCtx.spawnSync.mockClear();
      _clearAnalyzerIdentityProcessCacheForTests();
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, { cacheDirectory });
      expect(cacheGuardSpawnCount()).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses in-process snapshots when packageRoot W_OK fails with EACCES', async () => {
    const fixture = await createTempDir();
    try {
      const tree = await seedWideBuildTree(fixture.dbPath);
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, { cacheDirectory });
      fsCtx.unwritableExact.add(tree.packageRoot);
      spawnCtx.spawnSync.mockClear();
      _clearAnalyzerIdentityProcessCacheForTests();
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, { cacheDirectory });
      expect(cacheGuardSpawnCount()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not treat persist-cache W_OK failure as an unwritable install', async () => {
    const fixture = await createTempDir();
    try {
      const tree = await seedWideBuildTree(fixture.dbPath);
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, { cacheDirectory });
      fsCtx.unwritableExact.add(cacheDirectory);
      spawnCtx.spawnSync.mockClear();
      _clearAnalyzerIdentityProcessCacheForTests();
      resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, { cacheDirectory });
      expect(cacheGuardSpawnCount()).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fail-closes on mutation with the default spawn path', async () => {
    const fixture = await createTempDir();
    try {
      const tree = await seedWideBuildTree(fixture.dbPath);
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, {
        cacheDirectory,
      });
      spawnCtx.spawnSync.mockClear();
      _clearAnalyzerIdentityProcessCacheForTests();
      let mutated = false;
      const second = resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, {
        cacheDirectory,
        onCacheValidationPass: () => {
          if (!mutated) {
            mutated = true;
            writeFileSync(tree.mutatedPath, 'export const n0 = 999;\n');
          }
        },
      });
      expect(cacheGuardSpawnCount()).toBeGreaterThan(0);
      expect(second.build.digest).not.toBe(first.build.digest);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fail-closes on mutation when in-process guards are opted in', async () => {
    const fixture = await createTempDir();
    try {
      process.env[ENV_KEY] = '1';
      const tree = await seedWideBuildTree(fixture.dbPath);
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, {
        cacheDirectory,
      });
      spawnCtx.spawnSync.mockClear();
      _clearAnalyzerIdentityProcessCacheForTests();
      let mutated = false;
      const second = resolveAnalyzerRunnerIdentity(pathToFileURL(tree.modulePath).href, {
        cacheDirectory,
        onCacheValidationPass: () => {
          if (!mutated) {
            mutated = true;
            writeFileSync(tree.mutatedPath, 'export const n0 = 1000;\n');
          }
        },
      });
      expect(cacheGuardSpawnCount()).toBe(0);
      expect(second.build.digest).not.toBe(first.build.digest);
    } finally {
      await fixture.cleanup();
    }
  });
});
