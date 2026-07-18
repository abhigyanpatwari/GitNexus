import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { link, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  _clearAnalyzerIdentityProcessCacheForTests,
  _hashAnalyzerIdentityFramesForTests,
  analyzerRunnerIdentitiesEqual,
  captureAnalyzerIdentityBeforeLoad,
  finalizeAnalyzerRunnerIdentity,
  normalizeAnalyzerRunnerIdentityForComparison,
  resolveAnalyzerRunnerIdentity,
} from '../../src/core/analyzer-identity.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { createTempDir } from '../helpers/test-db.js';

describe('analyzer runner identity', () => {
  it('is versioned, resolved, and changes when the analyzer build tree changes', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(path.join(fixture.dbPath, 'package-lock.json'), '{"lockfileVersion":3}\n');
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(first).toMatchObject({
        schemaVersion: 4,
        cliVersion: '9.8.7',
        runtime: {
          executablePath: expect.any(String),
          version: process.version,
          platform: process.platform,
          architecture: process.arch,
          modulesAbi: process.versions.modules ?? 'unknown',
          libc: expect.any(String),
        },
        invokedArtifact: {
          path: modulePath,
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        build: {
          kind: 'source',
          rootPath: sourceRoot,
          canonicalization: 'gitnexus-analyzer-build-v2',
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        dependencyRuntime: {
          manifestPath: path.join(fixture.dbPath, 'package.json'),
          lockfilePath: path.join(fixture.dbPath, 'package-lock.json'),
          canonicalization: 'gitnexus-analyzer-dependency-runtime-v4',
          packageCount: 1,
          artifactCount: 0,
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });

      await writeFile(path.join(sourceRoot, 'new-module.ts'), 'export const changed = true;\n');
      const second = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(second.invokedArtifact.digest).toBe(first.invokedArtifact.digest);
      expect(second.build.digest).not.toBe(first.build.digest);
      expect(second.dependencyRuntime.digest).toBe(first.dependencyRuntime.digest);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects build-tree symlinks instead of trusting unchanged link metadata', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const importedTarget = path.join(fixture.dbPath, 'outside-build-input.ts');
      const importedLink = path.join(sourceRoot, 'linked-input.ts');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(importedTarget, 'export const imported = 1;\n');
      try {
        await symlink(importedTarget, importedLink, 'file');
      } catch (error) {
        if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }

      const resolve = () =>
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory: path.join(fixture.dbPath, 'identity-cache'),
        });
      expect(resolve).toThrow(/build symbolic links are not supported/);

      // Changing only target bytes leaves the symlink inode/text unchanged.
      // The resolver must continue to fail closed, never return an old digest.
      await writeFile(importedTarget, 'export const imported = 200;\n');
      expect(resolve).toThrow(/build symbolic links are not supported/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('versions runtime semantics and rejects a cache from another runtime variant', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, Buffer.alloc(128 * 1024, 0x5a));

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(first.runtime).toMatchObject({
        version: process.version,
        platform: process.platform,
        architecture: process.arch,
        modulesAbi: process.versions.modules ?? 'unknown',
        libc: expect.stringMatching(/\S/),
      });
      expect(
        analyzerRunnerIdentitiesEqual(
          { ...first, runtime: { ...first.runtime, platform: `${first.runtime.platform}-other` } },
          first,
        ),
      ).toBe(false);
      expect(
        analyzerRunnerIdentitiesEqual(
          {
            ...first,
            runtime: { ...first.runtime, architecture: `${first.runtime.architecture}-other` },
          },
          first,
        ),
      ).toBe(false);
      expect(
        analyzerRunnerIdentitiesEqual(
          {
            ...first,
            runtime: { ...first.runtime, modulesAbi: `${first.runtime.modulesAbi}-other` },
          },
          first,
        ),
      ).toBe(false);
      expect(
        analyzerRunnerIdentitiesEqual(
          { ...first, runtime: { ...first.runtime, libc: `${first.runtime.libc}-other` } },
          first,
        ),
      ).toBe(false);

      const [cacheFile] = await readdir(cacheDirectory);
      const cachePath = path.join(cacheDirectory, cacheFile);
      const envelope = JSON.parse(await readFile(cachePath, 'utf8')) as {
        payload: {
          schemaVersion: number;
          runtimeVariant: {
            nodeVersion: string;
            platform: string;
            architecture: string;
            modulesAbi: string;
            libc: string;
          };
        };
        checksum: string;
      };
      expect(envelope.payload).toMatchObject({
        schemaVersion: 6,
        runtimeVariant: {
          nodeVersion: process.version,
          platform: process.platform,
          architecture: process.arch,
          modulesAbi: process.versions.modules ?? 'unknown',
          libc: first.runtime.libc,
        },
      });

      envelope.payload.runtimeVariant.platform = `${process.platform}-stale-cache`;
      envelope.checksum = `sha256:${createHash('sha256')
        .update(JSON.stringify(envelope.payload))
        .digest('hex')}`;
      await writeFile(cachePath, `${JSON.stringify(envelope)}\n`);
      _clearAnalyzerIdentityProcessCacheForTests();

      let hashedBytes = 0;
      const afterIncompatibleCache = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
        onHashedInput: ({ bytes }) => {
          hashedBytes += bytes;
        },
      });
      expect(afterIncompatibleCache).toEqual(first);
      expect(hashedBytes).toBeGreaterThanOrEqual(128 * 1024);
    } finally {
      await fixture.cleanup();
    }
  });

  it('disables the default persistent cache without getuid but trusts an explicit override', async () => {
    const fixture = await createTempDir();
    const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid');
    const originalEnvironment = {
      TMPDIR: process.env.TMPDIR,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    };
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const tempRoot = path.join(fixture.dbPath, 'tmp');
      const explicitCache = path.join(fixture.dbPath, 'operator-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(tempRoot, { mode: 0o700 });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, Buffer.alloc(64 * 1024, 0x33));
      process.env.TMPDIR = tempRoot;
      delete process.env.XDG_RUNTIME_DIR;
      Object.defineProperty(process, 'getuid', {
        value: undefined,
        configurable: true,
        enumerable: true,
        writable: true,
      });

      const hashedWith = (cacheDirectory?: string): number => {
        let bytes = 0;
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          ...(cacheDirectory ? { cacheDirectory } : {}),
          onHashedInput: (input) => {
            bytes += input.bytes;
          },
        });
        return bytes;
      };

      expect(hashedWith()).toBeGreaterThanOrEqual(64 * 1024);
      // Cross-platform process-local reuse remains available even when secure
      // default persistence cannot be proved.
      expect(hashedWith()).toBe(0);
      expect(await readdir(tempRoot)).toEqual([]);

      _clearAnalyzerIdentityProcessCacheForTests();
      expect(hashedWith(explicitCache)).toBeGreaterThanOrEqual(64 * 1024);
      _clearAnalyzerIdentityProcessCacheForTests();
      expect(hashedWith(explicitCache)).toBe(0);
    } finally {
      if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid);
      else Reflect.deleteProperty(process, 'getuid');
      if (originalEnvironment.TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalEnvironment.TMPDIR;
      if (originalEnvironment.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = originalEnvironment.XDG_RUNTIME_DIR;
      await fixture.cleanup();
    }
  });

  it('supports only an absolute, pre-provisioned, external operator-trusted cache directory', async () => {
    const fixture = await createTempDir();
    const protectedCache = await createTempDir();
    const previous = process.env.GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR;
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, Buffer.alloc(64 * 1024, 0x37));
      const url = pathToFileURL(modulePath).href;
      const hashedBytes = (): number => {
        let bytes = 0;
        resolveAnalyzerRunnerIdentity(url, {
          onHashedInput: (input) => {
            bytes += input.bytes;
          },
        });
        return bytes;
      };

      process.env.GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR = protectedCache.dbPath;
      _clearAnalyzerIdentityProcessCacheForTests();
      expect(hashedBytes()).toBeGreaterThanOrEqual(64 * 1024);
      _clearAnalyzerIdentityProcessCacheForTests();
      expect(hashedBytes()).toBe(0);

      for (const invalid of [
        'relative/cache',
        path.join(fixture.dbPath, 'missing-cache'),
        fixture.dbPath,
        sourceRoot,
      ]) {
        process.env.GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR = invalid;
        _clearAnalyzerIdentityProcessCacheForTests();
        expect(() => resolveAnalyzerRunnerIdentity(url)).toThrow(
          /GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR/,
        );
      }

      const linkedCache = path.join(fixture.dbPath, 'cache-link');
      try {
        await symlink(protectedCache.dbPath, linkedCache, 'dir');
        process.env.GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR = linkedCache;
        _clearAnalyzerIdentityProcessCacheForTests();
        expect(() => resolveAnalyzerRunnerIdentity(url)).toThrow(/non-symlink|symbolic links/);
        await unlink(linkedCache);
      } catch (error) {
        if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR;
      else process.env.GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR = previous;
      _clearAnalyzerIdentityProcessCacheForTests();
      await protectedCache.cleanup();
      await fixture.cleanup();
    }
  });

  it('changes on lock and native/parser mutations while ignoring model caches', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const grammarRoot = path.join(fixture.dbPath, 'vendor', 'tree-sitter-fixture');
      const nativePath = path.join(
        grammarRoot,
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'tree-sitter-fixture.node',
      );
      const sharedLibraryPath = path.join(
        path.dirname(nativePath),
        process.platform === 'win32'
          ? 'tree-sitter-fixture.dll'
          : process.platform === 'darwin'
            ? 'libtree-sitter-fixture.dylib'
            : 'libtree-sitter-fixture.so.1',
      );
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(path.dirname(nativePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      const originalLock = '{"name":"fixture-analyzer","lockfileVersion":3}\n';
      await writeFile(path.join(fixture.dbPath, 'package-lock.json'), originalLock);
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(
        path.join(grammarRoot, 'package.json'),
        '{"name":"tree-sitter-fixture","version":"1.0.0"}\n',
      );
      await writeFile(nativePath, 'native-v1');
      await writeFile(sharedLibraryPath, 'shared-v1');
      await writeFile(path.join(grammarRoot, 'tree-sitter-fixture.wasm'), 'wasm-v1');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      let hashedBytes = 0;
      let runtimeArtifactHashes = 0;
      const resolve = () =>
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory,
          onHashedInput: (input) => {
            hashedBytes += input.bytes;
            if (input.kind === 'runtime-artifact') runtimeArtifactHashes += 1;
          },
        });

      const first = resolve();
      expect(first.dependencyRuntime.artifactCount).toBe(3);
      expect(runtimeArtifactHashes).toBe(3);
      expect(hashedBytes).toBeGreaterThan(0);
      expect(analyzerRunnerIdentitiesEqual(structuredClone(first), first)).toBe(true);
      expect(analyzerRunnerIdentitiesEqual({ ...first, schemaVersion: 1 }, first)).toBe(false);

      // The second resolver call models a fresh status/analyze process: the
      // persistent cache is reloaded from disk, and unchanged payload bytes are
      // never read even though both build/dependency inventories are validated.
      hashedBytes = 0;
      runtimeArtifactHashes = 0;
      expect(resolve()).toEqual(first);
      expect(runtimeArtifactHashes).toBe(0);
      expect(hashedBytes).toBe(0);

      await writeFile(
        path.join(fixture.dbPath, 'package-lock.json'),
        '{"name":"fixture-analyzer","lockfileVersion":4}\n',
      );
      const lockChanged = resolve();
      expect(lockChanged.build.digest).toBe(first.build.digest);
      expect(lockChanged.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);
      expect(analyzerRunnerIdentitiesEqual(lockChanged, first)).toBe(false);
      expect(runtimeArtifactHashes).toBe(0);

      await writeFile(path.join(fixture.dbPath, 'package-lock.json'), originalLock);
      await writeFile(nativePath, 'native-v2');
      runtimeArtifactHashes = 0;
      const nativeChanged = resolve();
      expect(nativeChanged.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);
      expect(runtimeArtifactHashes).toBe(1);

      await writeFile(nativePath, 'native-v1');
      await writeFile(sharedLibraryPath, 'shared-v2');
      const sharedLibraryChanged = resolve();
      expect(sharedLibraryChanged.dependencyRuntime.digest).not.toBe(
        first.dependencyRuntime.digest,
      );

      const modelCache = path.join(fixture.dbPath, '.cache', 'models');
      await mkdir(modelCache, { recursive: true });
      await writeFile(path.join(modelCache, 'weights.bin'), 'large-model-placeholder');
      runtimeArtifactHashes = 0;
      const cacheChanged = resolve();
      expect(cacheChanged.dependencyRuntime).toEqual(sharedLibraryChanged.dependencyRuntime);
      expect(runtimeArtifactHashes).toBe(0);

      // A corrupt cache is fail-closed: valid inventory stats cannot rescue
      // unverifiable cached digests, so every expensive artifact is rehashed.
      const [cacheFile] = await readdir(cacheDirectory);
      await writeFile(path.join(cacheDirectory, cacheFile), '{"payload":{},"checksum":"bad"}\n');
      _clearAnalyzerIdentityProcessCacheForTests();
      runtimeArtifactHashes = 0;
      hashedBytes = 0;
      resolve();
      expect(runtimeArtifactHashes).toBe(3);
      expect(hashedBytes).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reuses the secure runtime cache across isolated HOME and GITNEXUS_HOME values', async () => {
    const fixture = await createTempDir();
    const previous = {
      HOME: process.env.HOME,
      GITNEXUS_HOME: process.env.GITNEXUS_HOME,
      TMPDIR: process.env.TMPDIR,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    };
    const restore = (name: keyof typeof previous): void => {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const grammarRoot = path.join(fixture.dbPath, 'vendor', 'tree-sitter-fixture');
      const nativePath = path.join(
        grammarRoot,
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'tree-sitter-fixture.node',
      );
      const tempRoot = path.join(fixture.dbPath, 'runtime-cache-root');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(path.dirname(nativePath), { recursive: true });
      await mkdir(tempRoot, { mode: 0o700 });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(
        path.join(grammarRoot, 'package.json'),
        '{"name":"tree-sitter-fixture","version":"1.0.0"}\n',
      );
      await writeFile(nativePath, Buffer.alloc(2 * 1024 * 1024, 0x5a));

      delete process.env.XDG_RUNTIME_DIR;
      process.env.TMPDIR = tempRoot;
      process.env.HOME = path.join(fixture.dbPath, 'home-a');
      process.env.GITNEXUS_HOME = path.join(fixture.dbPath, 'gitnexus-home-a');
      let runtimeHashes = 0;
      let hashedBytes = 0;
      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        onHashedInput: (input) => {
          if (input.kind === 'runtime-artifact') runtimeHashes += 1;
          hashedBytes += input.bytes;
        },
      });
      expect(runtimeHashes).toBe(1);
      expect(hashedBytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);

      process.env.HOME = path.join(fixture.dbPath, 'home-b');
      process.env.GITNEXUS_HOME = path.join(fixture.dbPath, 'gitnexus-home-b');
      _clearAnalyzerIdentityProcessCacheForTests();
      runtimeHashes = 0;
      hashedBytes = 0;
      let cacheMissWalks = 0;
      let cacheMissReads = 0;
      const second = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        onHashedInput: (input) => {
          if (input.kind === 'runtime-artifact') runtimeHashes += 1;
          hashedBytes += input.bytes;
        },
        onCacheMissWork: (input) => {
          if (input.kind === 'directory-walk') cacheMissWalks += 1;
          else cacheMissReads += 1;
        },
      });
      expect(second).toEqual(first);
      expect(runtimeHashes).toBe(0);
      expect(hashedBytes).toBe(0);
      expect(cacheMissWalks).toBe(0);
      expect(cacheMissReads).toBe(0);
    } finally {
      restore('HOME');
      restore('GITNEXUS_HOME');
      restore('TMPDIR');
      restore('XDG_RUNTIME_DIR');
      await fixture.cleanup();
    }
  });

  it('keeps warm identities stable when unrelated siblings churn in a shared parent', async () => {
    const fixture = await createTempDir();
    let unrelated: Awaited<ReturnType<typeof createTempDir>> | null = null;
    try {
      const modulePath = path.join(fixture.dbPath, 'src', 'core', 'analyzer.ts');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      unrelated = await createTempDir();
      _clearAnalyzerIdentityProcessCacheForTests();
      let cacheMissWork = 0;
      const second = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
        onCacheMissWork: () => {
          cacheMissWork += 1;
        },
      });

      expect(second).toEqual(first);
      expect(cacheMissWork).toBe(0);
    } finally {
      if (unrelated) await unrelated.cleanup();
      await fixture.cleanup();
    }
  });

  it('invalidates an absent path guard when a nearer ancestor package lock appears', async () => {
    const fixture = await createTempDir();
    try {
      const packageRoot = path.join(fixture.dbPath, 'packages', 'fixture-analyzer');
      const modulePath = path.join(packageRoot, 'src', 'core', 'analyzer.ts');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      const ancestorLock = path.join(fixture.dbPath, 'package-lock.json');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(packageRoot, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');

      const withoutLock = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(withoutLock.dependencyRuntime.lockfilePath).toBeNull();

      await writeFile(ancestorLock, '{"lockfileVersion":3}\n');
      const withLock = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(withLock.dependencyRuntime.lockfilePath).toBe(ancestorLock);
      expect(withLock.dependencyRuntime.digest).not.toBe(withoutLock.dependencyRuntime.digest);
    } finally {
      await fixture.cleanup();
    }
  });

  it('invalidates an absent path guard when a nearer dependency shadows a hoisted one', async () => {
    const fixture = await createTempDir();
    try {
      const packageRoot = path.join(fixture.dbPath, 'packages', 'fixture-analyzer');
      const modulePath = path.join(packageRoot, 'src', 'core', 'analyzer.ts');
      const hoistedRoot = path.join(fixture.dbPath, 'node_modules', 'runtime-package');
      const nearerRoot = path.join(fixture.dbPath, 'packages', 'node_modules', 'runtime-package');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(hoistedRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'fixture-analyzer',
          version: '9.8.7',
          dependencies: { 'runtime-package': '1.0.0' },
        }),
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(
        path.join(hoistedRoot, 'package.json'),
        JSON.stringify({ name: 'runtime-package', version: '1.0.0' }),
      );
      await writeFile(path.join(hoistedRoot, 'runtime.js'), 'export const source = "hoisted";\n');

      const hoisted = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });

      await mkdir(nearerRoot, { recursive: true });
      await writeFile(
        path.join(nearerRoot, 'package.json'),
        JSON.stringify({ name: 'runtime-package', version: '2.0.0' }),
      );
      await writeFile(path.join(nearerRoot, 'runtime.js'), 'export const source = "nearer";\n');
      const shadowed = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });

      expect(shadowed.dependencyRuntime.digest).not.toBe(hoisted.dependencyRuntime.digest);
    } finally {
      await fixture.cleanup();
    }
  });

  it('invalidates a warm identity when an intermediate package symlink is retargeted', async () => {
    const fixture = await createTempDir();
    try {
      const packageRoot = path.join(fixture.dbPath, 'fixture-analyzer');
      const modulePath = path.join(packageRoot, 'src', 'core', 'analyzer.ts');
      const nodeModulesRoot = path.join(packageRoot, 'node_modules');
      const packageLink = path.join(nodeModulesRoot, 'runtime-package');
      const storeA = path.join(fixture.dbPath, 'store-a');
      const storeB = path.join(fixture.dbPath, 'store-b');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(nodeModulesRoot, { recursive: true });
      await mkdir(storeA);
      await mkdir(storeB);
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'fixture-analyzer',
          version: '9.8.7',
          dependencies: { 'runtime-package': '1.0.0' },
        }),
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(
        path.join(storeA, 'package.json'),
        JSON.stringify({ name: 'runtime-package', version: '1.0.0' }),
      );
      // Keep the final candidate manifest's inode and stat state identical so
      // only an exact lexical-component guard can observe the retarget.
      await link(path.join(storeA, 'package.json'), path.join(storeB, 'package.json'));
      await writeFile(path.join(storeA, 'runtime.js'), 'export const source = "a";\n');
      await writeFile(path.join(storeB, 'runtime.js'), 'export const source = "b changed";\n');
      try {
        await symlink(storeA, packageLink, 'dir');
      } catch (error) {
        if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      await unlink(packageLink);
      await symlink(storeB, packageLink, 'dir');
      _clearAnalyzerIdentityProcessCacheForTests();
      let cacheMissWork = 0;
      const retargeted = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
        onCacheMissWork: () => {
          cacheMissWork += 1;
        },
      });

      expect(retargeted.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);
      expect(cacheMissWork).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('invalidates direct-stat guards for build, topology, and artifact inventory changes', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const grammarRoot = path.join(fixture.dbPath, 'vendor', 'tree-sitter-fixture');
      const artifactDir = path.join(
        grammarRoot,
        'prebuilds',
        `${process.platform}-${process.arch}`,
      );
      const nativePath = path.join(artifactDir, 'tree-sitter-fixture.node');
      const addedNativePath = path.join(artifactDir, 'tree-sitter-extra.node');
      const manifestPath = path.join(grammarRoot, 'package.json');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(manifestPath, '{"name":"tree-sitter-fixture","version":"1.0.0"}\n');
      await writeFile(nativePath, 'native-v1');

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(first.dependencyRuntime.artifactCount).toBe(1);

      let walks = 0;
      let reads = 0;
      let hashes = 0;
      const resolve = () =>
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory,
          onCacheMissWork: (input) => {
            if (input.kind === 'directory-walk') walks += 1;
            else reads += 1;
          },
          onHashedInput: () => {
            hashes += 1;
          },
        });
      const reset = () => {
        walks = 0;
        reads = 0;
        hashes = 0;
      };

      expect(resolve()).toEqual(first);
      expect({ walks, reads, hashes }).toEqual({ walks: 0, reads: 0, hashes: 0 });

      await writeFile(path.join(sourceRoot, 'added.ts'), 'export const added = true;\n');
      reset();
      const buildAdded = resolve();
      expect(buildAdded.build.digest).not.toBe(first.build.digest);
      expect(walks).toBeGreaterThan(0);

      await writeFile(addedNativePath, 'native-extra');
      reset();
      const artifactAdded = resolve();
      expect(artifactAdded.dependencyRuntime.artifactCount).toBe(2);
      expect(artifactAdded.dependencyRuntime.digest).not.toBe(buildAdded.dependencyRuntime.digest);
      expect(walks).toBeGreaterThan(0);
      expect(hashes).toBe(1);

      await writeFile(manifestPath, '{"name":"tree-sitter-fixture","version":"2.0.0"}\n');
      reset();
      const manifestChanged = resolve();
      expect(manifestChanged.dependencyRuntime.digest).not.toBe(
        artifactAdded.dependencyRuntime.digest,
      );
      expect(reads).toBeGreaterThan(0);

      await unlink(nativePath);
      reset();
      const artifactDeleted = resolve();
      expect(artifactDeleted.dependencyRuntime.artifactCount).toBe(1);
      expect(artifactDeleted.dependencyRuntime.digest).not.toBe(
        manifestChanged.dependencyRuntime.digest,
      );
      expect(walks).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps same-name/version dependency instances distinct by package-root locator', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const nestedA = path.join(
        fixture.dbPath,
        'node_modules',
        'parent-a',
        'node_modules',
        'duplicate',
      );
      const nestedB = path.join(
        fixture.dbPath,
        'node_modules',
        'parent-b',
        'node_modules',
        'duplicate',
      );
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(nestedA, { recursive: true });
      await mkdir(nestedB, { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        JSON.stringify({
          name: 'fixture-analyzer',
          version: '9.8.7',
          dependencies: { 'parent-a': '1.0.0', 'parent-b': '1.0.0' },
        }),
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      for (const parentName of ['parent-a', 'parent-b']) {
        await writeFile(
          path.join(fixture.dbPath, 'node_modules', parentName, 'package.json'),
          JSON.stringify({
            name: parentName,
            version: '1.0.0',
            dependencies: { duplicate: '1.0.0' },
          }),
        );
      }
      for (const nestedRoot of [nestedA, nestedB]) {
        await writeFile(
          path.join(nestedRoot, 'package.json'),
          JSON.stringify({ name: 'duplicate', version: '1.0.0' }),
        );
        await writeFile(path.join(nestedRoot, 'runtime.wasm'), 'same-runtime-bytes');
      }

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(first.dependencyRuntime.packageCount).toBe(5);
      expect(first.dependencyRuntime.artifactCount).toBe(2);

      const [cacheFile] = await readdir(cacheDirectory);
      const envelope = JSON.parse(await readFile(path.join(cacheDirectory, cacheFile), 'utf8')) as {
        payload: { artifactEntries: Array<{ canonicalPath: string }> };
      };
      const artifactLocators = envelope.payload.artifactEntries.map((entry) => entry.canonicalPath);
      expect(artifactLocators).toEqual(
        expect.arrayContaining([
          expect.stringContaining('node_modules/parent-a/node_modules/duplicate/runtime.wasm'),
          expect.stringContaining('node_modules/parent-b/node_modules/duplicate/runtime.wasm'),
        ]),
      );
      expect(new Set(artifactLocators).size).toBe(2);

      await writeFile(
        path.join(nestedB, 'package.json'),
        JSON.stringify({ name: 'duplicate', version: '1.0.0', instance: 'parent-b' }),
      );
      const changedOneInstance = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(changedOneInstance.dependencyRuntime.packageCount).toBe(5);
      expect(changedOneInstance.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);
    } finally {
      await fixture.cleanup();
    }
  });

  it('discovers runtime artifacts in every resolved package without an allowlist', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const dependencyRoot = path.join(fixture.dbPath, 'node_modules', 'ordinary-runtime');
      const nativePath = path.join(dependencyRoot, 'build', 'addon.node');
      const wasmPath = path.join(dependencyRoot, 'codec', 'runtime.wasm');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(path.dirname(nativePath), { recursive: true });
      await mkdir(path.dirname(wasmPath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        JSON.stringify({
          name: 'fixture-analyzer',
          version: '9.8.7',
          dependencies: { 'ordinary-runtime': '1.0.0' },
        }),
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(
        path.join(dependencyRoot, 'package.json'),
        JSON.stringify({ name: 'ordinary-runtime', version: '1.0.0' }),
      );
      await writeFile(nativePath, 'native-v1');
      await writeFile(wasmPath, 'wasm-v1');

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(first.dependencyRuntime).toMatchObject({ packageCount: 2, artifactCount: 2 });

      await writeFile(nativePath, 'native-v2-with-a-different-size');
      const changed = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(changed.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);
    } finally {
      await fixture.cleanup();
    }
  });

  it('tracks generic runtime directories and filename-mismatched native payloads on cold and warm scans', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const dependencyRoot = path.join(fixture.dbPath, 'node_modules', 'runtime-package');
      const foreignPlatform = process.platform === 'linux' ? 'darwin' : 'linux';
      const foreignArchitecture = process.arch === 'x64' ? 'arm64' : 'x64';
      const payloadPaths = [
        path.join(dependencyRoot, '.cache', 'generated-loader.js'),
        path.join(
          dependencyRoot,
          'cache',
          `${foreignPlatform}-${foreignArchitecture}`,
          'addon.node',
        ),
        path.join(dependencyRoot, 'models', 'runtime-model.wasm'),
        path.join(
          dependencyRoot,
          'prebuilds',
          `${foreignPlatform}-${foreignArchitecture}`,
          'foreign-target.node',
        ),
        path.join(
          dependencyRoot,
          'codec',
          `runtime-${foreignPlatform}-${foreignArchitecture}.wasm`,
        ),
      ];
      await mkdir(path.dirname(modulePath), { recursive: true });
      for (const payloadPath of payloadPaths) {
        await mkdir(path.dirname(payloadPath), { recursive: true });
      }
      await mkdir(path.join(dependencyRoot, '.git'), { recursive: true });
      await mkdir(path.join(dependencyRoot, '.hg'), { recursive: true });
      await mkdir(path.join(dependencyRoot, '.svn'), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        JSON.stringify({
          name: 'fixture-analyzer',
          version: '9.8.7',
          dependencies: { 'runtime-package': '1.0.0' },
        }),
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(
        path.join(dependencyRoot, 'package.json'),
        JSON.stringify({ name: 'runtime-package', version: '1.0.0' }),
      );
      await writeFile(path.join(dependencyRoot, '.git', 'config'), 'ignored-vcs-state');
      await writeFile(path.join(dependencyRoot, '.hg', 'dirstate'), 'ignored-vcs-state');
      await writeFile(path.join(dependencyRoot, '.svn', 'wc.db'), 'ignored-vcs-state');

      for (const payloadPath of payloadPaths) await writeFile(payloadPath, 'payload-v1');
      const baseline = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory: path.join(fixture.dbPath, 'baseline-cache'),
      });
      expect(baseline.dependencyRuntime.artifactCount).toBe(payloadPaths.length);

      for (const payloadPath of payloadPaths) {
        await writeFile(payloadPath, `payload-v2:${path.basename(payloadPath)}`);
      }
      const warmCacheDirectory = path.join(fixture.dbPath, 'warm-cache');
      let runtimeHashes = 0;
      const coldAfterMutation = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory: warmCacheDirectory,
        onHashedInput: (input) => {
          if (input.kind === 'runtime-artifact') runtimeHashes += 1;
        },
      });
      expect(coldAfterMutation.dependencyRuntime.digest).not.toBe(
        baseline.dependencyRuntime.digest,
      );
      expect(runtimeHashes).toBe(payloadPaths.length);

      runtimeHashes = 0;
      expect(
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory: warmCacheDirectory,
          onHashedInput: (input) => {
            if (input.kind === 'runtime-artifact') runtimeHashes += 1;
          },
        }),
      ).toEqual(coldAfterMutation);
      expect(runtimeHashes).toBe(0);

      for (const payloadPath of payloadPaths) {
        await writeFile(payloadPath, `payload-v3-with-new-bytes:${path.basename(payloadPath)}`);
      }
      runtimeHashes = 0;
      const warmAfterMutation = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory: warmCacheDirectory,
        onHashedInput: (input) => {
          if (input.kind === 'runtime-artifact') runtimeHashes += 1;
        },
      });
      expect(warmAfterMutation.dependencyRuntime.digest).not.toBe(
        coldAfterMutation.dependencyRuntime.digest,
      );
      expect(runtimeHashes).toBe(payloadPaths.length);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed when a resolved-package artifact walk exceeds its depth bound', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const dependencyRoot = path.join(fixture.dbPath, 'node_modules', 'deep-runtime');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        JSON.stringify({
          name: 'fixture-analyzer',
          version: '9.8.7',
          dependencies: { 'deep-runtime': '1.0.0' },
        }),
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(
        path.join(dependencyRoot, 'package.json'),
        JSON.stringify({ name: 'deep-runtime', version: '1.0.0' }),
      );
      let cursor = dependencyRoot;
      for (let depth = 0; depth < 66; depth += 1) {
        cursor = path.join(cursor, 'd');
        await mkdir(cursor);
      }

      expect(() =>
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory: path.join(fixture.dbPath, 'identity-cache'),
        }),
      ).toThrow(/payload scan exceeded depth 64/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('stable-reads symlinked package locks and rejects broken lock links', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const lockTarget = path.join(fixture.dbPath, 'actual-package-lock.json');
      const lockLink = path.join(fixture.dbPath, 'package-lock.json');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(lockTarget, '{"lockfileVersion":3}\n');
      try {
        await symlink(lockTarget, lockLink, 'file');
      } catch (error) {
        if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }

      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(first.dependencyRuntime.lockfilePath).toBe(lockLink);

      await writeFile(lockTarget, '{"lockfileVersion":4,"changed":true}\n');
      const targetChanged = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(targetChanged.dependencyRuntime.digest).not.toBe(first.dependencyRuntime.digest);

      await unlink(lockLink);
      await symlink(path.join(fixture.dbPath, 'missing-lock-target.json'), lockLink, 'file');
      expect(() =>
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, { cacheDirectory }),
      ).toThrow(/package lock symbolic link does not resolve to a file/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses one final warm validation pass and notices immediate file and topology changes', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const addedPath = path.join(sourceRoot, 'added-at-boundary.ts');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });

      let validationPasses = 0;
      expect(
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory,
          onCacheValidationPass: () => {
            validationPasses += 1;
          },
        }),
      ).toEqual(first);
      expect(validationPasses).toBe(1);

      validationPasses = 0;
      let changedFile = false;
      const fileChanged = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
        onCacheValidationPass: () => {
          validationPasses += 1;
          if (!changedFile) {
            changedFile = true;
            writeFileSync(modulePath, 'export const analyzer = 200;\n');
          }
        },
      });
      expect(fileChanged.build.digest).not.toBe(first.build.digest);
      expect(validationPasses).toBe(2);

      validationPasses = 0;
      let changedTopology = false;
      const topologyChanged = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
        onCacheValidationPass: () => {
          validationPasses += 1;
          if (!changedTopology) {
            changedTopology = true;
            writeFileSync(addedPath, 'export const added = true;\n');
          }
        },
      });
      expect(topologyChanged.build.digest).not.toBe(fileChanged.build.digest);
      expect(validationPasses).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps warm-cache work at zero and materially below cold-path latency', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const payloadPath = path.join(sourceRoot, 'large-runtime-source.bin');
      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      const payloadBytes = 32 * 1024 * 1024;
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(payloadPath, Buffer.alloc(payloadBytes, 0x61));

      let coldHashedBytes = 0;
      let coldTopologyWork = 0;
      let coldValidationPasses = 0;
      const coldStarted = performance.now();
      const coldIdentity = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
        onHashedInput: ({ bytes }) => {
          coldHashedBytes += bytes;
        },
        onCacheMissWork: () => {
          coldTopologyWork += 1;
        },
        onCacheValidationPass: () => {
          coldValidationPasses += 1;
        },
      });
      const coldDurationMs = performance.now() - coldStarted;
      expect(coldHashedBytes).toBeGreaterThanOrEqual(payloadBytes);
      expect(coldTopologyWork).toBeGreaterThan(0);
      expect(coldValidationPasses).toBe(1);

      const warmDurationsMs: number[] = [];
      for (let iteration = 0; iteration < 5; iteration += 1) {
        let warmHashedBytes = 0;
        let warmTopologyWork = 0;
        let warmValidationPasses = 0;
        const warmStarted = performance.now();
        const warmIdentity = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory,
          onHashedInput: ({ bytes }) => {
            warmHashedBytes += bytes;
          },
          onCacheMissWork: () => {
            warmTopologyWork += 1;
          },
          onCacheValidationPass: () => {
            warmValidationPasses += 1;
          },
        });
        warmDurationsMs.push(performance.now() - warmStarted);
        expect(warmIdentity).toEqual(coldIdentity);
        expect(warmHashedBytes).toBe(0);
        expect(warmTopologyWork).toBe(0);
        expect(warmValidationPasses).toBe(1);
      }
      warmDurationsMs.sort((a, b) => a - b);
      const medianWarmDurationMs = warmDurationsMs[Math.floor(warmDurationsMs.length / 2)];
      expect(medianWarmDurationMs).toBeLessThan(coldDurationMs);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses non-ambiguous framing and treats the invoked entrypoint as diagnostic', async () => {
    const leftOldEncoding = Buffer.concat([
      Buffer.from('a'),
      Buffer.from([0]),
      Buffer.from('b\0c'),
      Buffer.from([0]),
    ]);
    const rightOldEncoding = Buffer.concat([
      Buffer.from('a\0b'),
      Buffer.from([0]),
      Buffer.from('c'),
      Buffer.from([0]),
    ]);
    expect(leftOldEncoding).toEqual(rightOldEncoding);
    expect(_hashAnalyzerIdentityFramesForTests([['entry', 'a', 'b\0c']])).not.toBe(
      _hashAnalyzerIdentityFramesForTests([['entry', 'a\0b', 'c']]),
    );

    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      const options = { cacheDirectory: path.join(fixture.dbPath, 'identity-cache') };
      const identity = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, options);
      const alternateEntrypoint = {
        ...identity,
        invokedArtifact: {
          path: path.join(sourceRoot, 'server', 'analyze-worker.ts'),
          digest: `sha256:${'a'.repeat(64)}`,
        },
      };
      expect(analyzerRunnerIdentitiesEqual(alternateEntrypoint, identity)).toBe(true);
      expect(normalizeAnalyzerRunnerIdentityForComparison(alternateEntrypoint)).toEqual(
        normalizeAnalyzerRunnerIdentityForComparison(identity),
      );
      expect(normalizeAnalyzerRunnerIdentityForComparison({ schemaVersion: 4 })).toBeNull();
      expect(
        analyzerRunnerIdentitiesEqual(
          { ...alternateEntrypoint, invokedArtifact: { path: '', digest: 'bad' } },
          identity,
        ),
      ).toBe(false);

      await writeFile(
        path.join(sourceRoot, 'new-semantic-input.ts'),
        'export const changed = 1;\n',
      );
      expect(() =>
        finalizeAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, identity, options),
      ).toThrow(/changed during analysis/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('captures before loading and rejects a replacement that races module evaluation', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"9.8.7"}\n',
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      const options = { cacheDirectory: path.join(fixture.dbPath, 'identity-cache') };

      const prepared = await captureAnalyzerIdentityBeforeLoad(
        pathToFileURL(modulePath).href,
        async () => {
          // Change the size as well as the bytes so filesystems with coarse
          // timestamp granularity cannot make this race regression flaky.
          await writeFile(modulePath, 'export const analyzer = 200;\n');
          return 'loaded-after-replacement';
        },
        options,
      );
      expect(prepared.loaded).toBe('loaded-after-replacement');
      expect(() =>
        finalizeAnalyzerRunnerIdentity(
          pathToFileURL(modulePath).href,
          prepared.runnerIdentity,
          options,
        ),
      ).toThrow(/changed during analysis/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('content-addresses every resolved package payload and reuses it without byte reads', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const dependencyRoot = path.join(fixture.dbPath, 'node_modules', 'runtime-package');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        JSON.stringify({
          name: 'fixture-analyzer',
          version: '9.8.7',
          dependencies: { 'runtime-package': '1.0.0' },
        }),
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(
        path.join(dependencyRoot, 'package.json'),
        JSON.stringify({ name: 'runtime-package', version: '1.0.0' }),
      );
      const payloadNames = [
        'index.js',
        'legacy.cjs',
        'module.mjs',
        'data.json',
        'addon.node',
        'runtime.wasm',
        'extensionless',
        'runtime-config.txt',
      ];
      for (const name of payloadNames)
        await writeFile(path.join(dependencyRoot, name), `${name}:v1`);

      const cacheDirectory = path.join(fixture.dbPath, 'identity-cache');
      const first = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory,
      });
      expect(first.dependencyRuntime.artifactCount).toBe(payloadNames.length);

      let warmBytes = 0;
      expect(
        resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory,
          onHashedInput: ({ bytes }) => {
            warmBytes += bytes;
          },
        }),
      ).toEqual(first);
      expect(warmBytes).toBe(0);

      let priorDigest = first.dependencyRuntime.digest;
      for (const name of payloadNames) {
        await writeFile(path.join(dependencyRoot, name), `${name}:v2-with-new-bytes`);
        const changed = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
          cacheDirectory,
        });
        expect(changed.dependencyRuntime.digest).not.toBe(priorDigest);
        priorDigest = changed.dependencyRuntime.digest;
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('enforces iterative build, package, edge, entry, payload, byte, depth, and resolution bounds', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      const dependencyRoot = path.join(fixture.dbPath, 'node_modules', 'runtime-package');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await mkdir(path.join(dependencyRoot, 'deep', 'deeper'), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        JSON.stringify({
          name: 'fixture-analyzer',
          version: '9.8.7',
          dependencies: { 'runtime-package': '1.0.0', missing: '1.0.0' },
        }),
      );
      await writeFile(modulePath, 'export const analyzer = 1;\n');
      await writeFile(path.join(sourceRoot, 'extra.ts'), 'export const extra = true;\n');
      await mkdir(path.join(sourceRoot, 'nested', 'deeper'), { recursive: true });
      await writeFile(path.join(sourceRoot, 'nested', 'deeper', 'leaf.ts'), 'export {};\n');
      await writeFile(
        path.join(dependencyRoot, 'package.json'),
        JSON.stringify({ name: 'runtime-package', version: '1.0.0' }),
      );
      await writeFile(path.join(dependencyRoot, 'a.js'), 'a');
      await writeFile(path.join(dependencyRoot, 'b.json'), '{}');
      await writeFile(path.join(dependencyRoot, 'deep', 'deeper', 'c.mjs'), 'c');
      const url = pathToFileURL(modulePath).href;
      let sequence = 0;
      const bounded = (traversalLimits: Record<string, number>) => () =>
        resolveAnalyzerRunnerIdentity(url, {
          cacheDirectory: path.join(fixture.dbPath, `cache-${sequence++}`),
          traversalLimits,
        });

      expect(bounded({ buildEntries: 1 })).toThrow(/build scan exceeded 1 entries/);
      expect(bounded({ buildDepth: 1 })).toThrow(/build scan exceeded depth 1/);
      expect(bounded({ buildBytes: 1 })).toThrow(/build scan exceeded 1 bytes/);
      expect(bounded({ runtimePackages: 1 })).toThrow(/dependency graph exceeded 1 packages/);
      expect(bounded({ runtimeEdges: 1 })).toThrow(/dependency graph exceeded 1 edges/);
      expect(bounded({ runtimeEntries: 1 })).toThrow(/payload scan exceeded 1 entries/);
      expect(bounded({ runtimeDepth: 1 })).toThrow(/payload scan exceeded depth 1/);
      expect(bounded({ runtimePayloads: 1 })).toThrow(/payload scan exceeded 1 payloads/);
      expect(bounded({ runtimeBytes: 1 })).toThrow(/runtime scan exceeded 1 bytes/);
      expect(bounded({ resolutionAncestors: 1 })).toThrow(/exceeded 1 ancestors/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('persists the same receipt to both metadata mirrors on full and incremental runs', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      );

      const { storagePath } = getStoragePaths(repo.dbPath);
      const first = await loadMeta(storagePath);
      const expectedIdentity = resolveAnalyzerRunnerIdentity(
        pathToFileURL(path.resolve(__dirname, '../../src/core/run-analyze.ts')).href,
      );
      expect(first?.runnerIdentity).toEqual(expectedIdentity);
      expect(first?.runnerIdentity).toMatchObject({
        schemaVersion: 4,
        cliVersion: expect.any(String),
        invokedArtifact: { digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
        build: { digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
        dependencyRuntime: { digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      });
      if (!first?.runnerIdentity) throw new Error('analysis did not persist a runner identity');

      const legacyMeta = {
        ...first,
        runnerIdentity: { ...first.runnerIdentity, schemaVersion: 1 },
      } as unknown as RepoMeta;
      await saveMeta(storagePath, legacyMeta);
      const upgraded = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      );
      expect(upgraded.alreadyUpToDate).toBeUndefined();
      expect((await loadMeta(storagePath))?.runnerIdentity).toEqual(first.runnerIdentity);

      const changedPath = path.join(repo.dbPath, 'src', 'logger.ts');
      const before = await readFile(changedPath, 'utf8');
      await writeFile(changedPath, `${before}\n// force incremental identity restamp\n`, 'utf8');
      const incremental = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      );
      expect(incremental.alreadyUpToDate).toBeUndefined();

      const second = await loadMeta(storagePath);
      expect(second?.runnerIdentity).toEqual(first?.runnerIdentity);
      const primary = JSON.parse(
        await readFile(path.join(storagePath, 'gitnexus.json'), 'utf8'),
      ) as { runnerIdentity?: unknown };
      const legacy = JSON.parse(await readFile(path.join(storagePath, 'meta.json'), 'utf8')) as {
        runnerIdentity?: unknown;
      };
      expect(primary.runnerIdentity).toEqual(second?.runnerIdentity);
      expect(legacy.runnerIdentity).toEqual(second?.runnerIdentity);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);
});
