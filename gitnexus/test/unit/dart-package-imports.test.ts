import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdtemp, mkdir, rm, symlink, writeFile, chmod, rename } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { dartScopeResolver } from '../../src/core/ingestion/languages/dart/scope-resolver.js';
import {
  loadDartPackageConfig,
  captureDartPackageConfig,
} from '../../src/core/ingestion/languages/dart/package-config.js';
import { scanPhase } from '../../src/core/ingestion/pipeline-phases/scan.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { CountingSet } from '../helpers/counting-file-set.js';
import { _captureLogger } from '../../src/core/logger.js';

const files = new Set(['lib/main.dart', 'lib/http.dart', 'lib/models.dart', 'tool/run.dart']);
const config = { packages: new Map([['app', 'lib']]) };

describe('Dart package identity (#2963)', () => {
  it('does not resolve a package URI that has no library path', () => {
    expect(
      dartScopeResolver.resolveImportTarget('package:app', 'lib/main.dart', files, config),
    ).toBeNull();
    expect(
      dartScopeResolver.resolveImportTarget('package:app/', 'lib/main.dart', files, config),
    ).toBeNull();
  });

  it('does not resolve a pub dependency to a same-named local file', () => {
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:http/http.dart',
        'lib/main.dart',
        files,
        config,
      ),
    ).toBeNull();
  });

  it('resolves this package through its declared lib directory', () => {
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:app/models.dart',
        'lib/main.dart',
        files,
        config,
      ),
    ).toBe('lib/models.dart');
  });

  it('does not guess package identity when no pubspec config is available', () => {
    expect(
      dartScopeResolver.resolveImportTarget('package:app/models.dart', 'lib/main.dart', files),
    ).toBeNull();
  });

  it('does not fall back to non-library files', () => {
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:app/tool/run.dart',
        'lib/main.dart',
        files,
        config,
      ),
    ).toBeNull();
  });

  it.each([
    '',
    '../http.dart',
    'src/../../http.dart',
    '/http.dart',
    'src\\http.dart',
    '%2e%2e/http.dart',
    'http.dart?q',
    'http.dart#part',
  ])('rejects unsupported package paths: %s', (target) => {
    expect(
      dartScopeResolver.resolveImportTarget(
        `package:app/${target}`,
        'lib/main.dart',
        files,
        config,
      ),
    ).toBeNull();
  });

  it('uses exact package roots even with earlier same-suffix files', () => {
    const workspace = new Set([
      'decoy/lib/models.dart',
      'packages/data/lib/models.dart',
      'lib/models.dart',
    ]);
    const monorepo = {
      packages: new Map([
        ['app', 'lib'],
        ['data', 'packages/data/lib'],
      ]),
    };
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:data/models.dart',
        'lib/main.dart',
        workspace,
        monorepo,
      ),
    ).toBe('packages/data/lib/models.dart');
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:app/models.dart',
        'packages/data/lib/main.dart',
        workspace,
        monorepo,
      ),
    ).toBe('lib/models.dart');
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:missing/models.dart',
        'lib/main.dart',
        workspace,
        monorepo,
      ),
    ).toBeNull();
  });

  it('does not suffix-match a missing file in a known package', () => {
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:app/models.dart',
        'lib/main.dart',
        new Set(['other/lib/models.dart']),
        config,
      ),
    ).toBeNull();
  });

  it('uses no workspace scans for package hits or misses', () => {
    const workspace = new CountingSet(files);
    for (let i = 0; i < 200; i++) {
      expect(
        dartScopeResolver.resolveImportTarget(
          'package:app/models.dart',
          'lib/main.dart',
          workspace,
          config,
        ),
      ).toBe('lib/models.dart');
      expect(
        dartScopeResolver.resolveImportTarget(
          `package:external${i}/http.dart`,
          'lib/main.dart',
          workspace,
          config,
        ),
      ).toBeNull();
    }
    expect(workspace.scans).toBe(0);
  });

  it('still ignores SDK imports and resolves relative paths without config', () => {
    expect(
      dartScopeResolver.resolveImportTarget('dart:core', 'lib/main.dart', files, config),
    ).toBeNull();
    expect(dartScopeResolver.resolveImportTarget('./models.dart', 'lib/main.dart', files)).toBe(
      'lib/models.dart',
    );
    expect(dartScopeResolver.resolveImportTarget('../tool/run.dart', 'lib/main.dart', files)).toBe(
      'tool/run.dart',
    );
  });
});

describe('Dart pubspec package discovery', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function fixture(manifests: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-dart-pubspec-'));
    roots.push(root);
    for (const [relative, content] of Object.entries(manifests)) {
      const destination = path.join(root, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    return root;
  }

  it('loads root and nested package names through the production hook', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: "app" # root package\ndependencies:\n  http: ^1.0.0\n',
      'packages/data/pubspec.yaml': 'name: data\n',
      'packages/unnamed/pubspec.yaml': 'description: no package name\n',
    });
    const loaded = await dartScopeResolver.loadResolutionConfig?.(root);
    expect(loaded).toMatchObject({
      packages: new Map([
        ['app', 'lib'],
        ['data', 'packages/data/lib'],
      ]),
    });
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:data/models.dart',
        'lib/main.dart',
        new Set(['packages/data/lib/models.dart']),
        loaded,
      ),
    ).toBe('packages/data/lib/models.dart');
  });

  it('suppresses duplicate names even across three packages', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: app',
      'a/pubspec.yaml': 'name: repeated',
      'b/pubspec.yaml': 'name: repeated',
      'c/pubspec.yaml': 'name: repeated',
    });
    const loaded = await loadDartPackageConfig(root);
    expect(loaded.packages).toEqual(config.packages);
    expect(loaded.manifestsByName.get('repeated')).toEqual(['a/pubspec.yaml', 'b/pubspec.yaml']);
  });

  it('accepts an underscore-prefixed package name', async () => {
    const root = await fixture({ 'pubspec.yaml': 'name: _app' });
    expect((await loadDartPackageConfig(root)).packages).toEqual(new Map([['_app', 'lib']]));
  });

  it.each(['.gitignore', '.gitnexusignore'])(
    'ignores duplicate names in directories excluded by %s',
    async (ignoreFile) => {
      const root = await fixture({
        'pubspec.yaml': 'name: app',
        [ignoreFile]: 'backup/\n',
        'backup/pubspec.yaml': 'name: app',
      });
      expect((await loadDartPackageConfig(root)).packages).toEqual(config.packages);
    },
  );

  it('honors explicitly re-included package directories', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: app',
      '.gitnexusignore': '!vendor/\n',
      'vendor/pubspec.yaml': 'name: local_vendor',
    });
    expect(await loadDartPackageConfig(root)).toMatchObject({
      packages: new Map([
        ['app', 'lib'],
        ['local_vendor', 'vendor/lib'],
      ]),
    });
  });

  it.each(['.gitignore', '.gitnexusignore'])(
    'does not read manifests excluded individually by %s',
    async (ignoreFile) => {
      const root = await fixture({
        'pubspec.yaml': 'name: app',
        [ignoreFile]: 'backup/pubspec.yaml\nbroken/pubspec.yaml\n',
        'backup/pubspec.yaml': 'name: app',
        'broken/pubspec.yaml': 'name: [invalid',
      });
      expect((await loadDartPackageConfig(root)).packages).toEqual(config.packages);
    },
  );

  it('excludes hidden directories just like the production file scanner', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: app',
      '.backup/pubspec.yaml': 'name: app',
      '.broken/pubspec.yaml': 'name: [invalid',
    });
    expect((await loadDartPackageConfig(root)).packages).toEqual(config.packages);
  });

  it('reports invalid YAML without exposing contents or discarding valid packages', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: app',
      'nested/pubspec.yaml': 'name: [private-manifest-content',
    });
    const capture = _captureLogger();
    try {
      expect((await loadDartPackageConfig(root)).packages).toEqual(config.packages);
      expect(capture.records()).toEqual([
        expect.objectContaining({
          level: 40,
          reason: 'invalid-yaml',
          relativePath: 'nested/pubspec.yaml',
          msg: 'Dart pubspec discovery could not read a valid package declaration.',
        }),
      ]);
      expect(capture.text()).not.toContain('private-manifest-content');
      expect(capture.text()).not.toContain(root);
    } finally {
      capture.restore();
    }
  });

  it.each(['name: [bad', 'name: one\nname: two', '!!js/function function() {}'])(
    'does not interpret invalid YAML as a package declaration: %s',
    async (manifest) => {
      const root = await fixture({ 'pubspec.yaml': 'name: app', 'nested/pubspec.yaml': manifest });
      expect((await loadDartPackageConfig(root)).packages).toEqual(config.packages);
    },
  );

  it.each(['null', '- name: app', 'name: 42', 'name: ../app', 'description: app'])(
    'does not infer a name from %s',
    async (manifest) => {
      expect(
        (await loadDartPackageConfig(await fixture({ 'pubspec.yaml': manifest }))).packages.size,
      ).toBe(0);
    },
  );

  it('does not read generated or installed pubspecs', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: app',
      '.dart_tool/pubspec.yaml': 'name: app',
      '.pub-cache/pubspec.yaml': 'name: app',
      'node_modules/dependency/pubspec.yaml': 'name: app',
    });
    expect((await loadDartPackageConfig(root)).packages).toEqual(config.packages);
  });

  it('does not follow directory links outside the repository', async () => {
    const outside = await fixture({ 'pubspec.yaml': 'name: app' });
    const root = await fixture({ 'pubspec.yaml': 'name: app' });
    await symlink(
      outside,
      path.join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect((await loadDartPackageConfig(root)).packages).toEqual(config.packages);
  });

  it('returns no packages when no pubspec is present', async () => {
    expect((await loadDartPackageConfig(await fixture({}))).packages.size).toBe(0);
  });

  it('refuses oversized manifests instead of parsing an unbounded document', async () => {
    const root = await fixture({ 'pubspec.yaml': `name: app\n#${'x'.repeat(1024 * 1024)}` });
    await expect(loadDartPackageConfig(root)).rejects.toThrow(
      'Dart pubspec discovery failed (manifest-size)',
    );
  });

  it('discovers declared packages on Windows', async () => {
    const root = await fixture({ 'pubspec.yaml': 'name: app' });
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      expect((await loadDartPackageConfig(root)).packages).toEqual(config.packages);
    } finally {
      platform.mockRestore();
    }
  });

  it('fails when repository ignore rules cannot be read', async () => {
    const root = await fixture({ 'pubspec.yaml': 'name: app' });
    await mkdir(path.join(root, '.gitignore'));
    await expect(loadDartPackageConfig(root)).rejects.toThrow('(scan-inputs)');
  });

  for (const ignoreFile of ['.gitignore', '.gitnexusignore']) {
    it(`applies linked ${ignoreFile} to TypeScript scans while keeping Dart capture strict`, async (context) => {
      const root = await fixture({ 'main.ts': 'export {};', 'ignored.ts': 'export {};' });
      const outside = await fixture({ rules: 'ignored.ts\n' });
      try {
        await symlink(path.join(outside, 'rules'), path.join(root, ignoreFile), 'file');
      } catch (error) {
        if (
          process.platform === 'win32' &&
          ['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')
        ) {
          context.skip('Windows file symlinks are unavailable');
        }
        throw error;
      }
      const scanContext = {
        repoPath: root,
        graph: createKnowledgeGraph(),
        onProgress: () => {},
        pipelineStart: Date.now(),
      };
      const scanned = await scanPhase.execute(scanContext, new Map());
      expect(scanned.allPaths).toEqual(['main.ts']);
      expect(scanned.resolutionConfigs?.has(SupportedLanguages.Dart)).toBe(false);

      // Dart capture validates its scan inputs even when no pubspec was discovered.
      await writeFile(path.join(root, 'main.dart'), 'void main() {}');
      await expect(scanPhase.execute(scanContext, new Map())).rejects.toThrow('(scan-inputs)');
    });
  }

  it('fails when the repository root is missing', async () => {
    const root = await fixture({});
    await expect(loadDartPackageConfig(path.join(root, 'missing'))).rejects.toThrow(
      '(scan-inputs)',
    );
  });

  it('fails metadata capture when glob cannot enumerate a nonignored directory', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: app',
      'packages/duplicate/pubspec.yaml': 'name: app',
    });
    const realReaddir = nodeFs.readdir;
    let denied = 0;
    const spy = vi.spyOn(nodeFs, 'readdir').mockImplementation((directory, options, callback) => {
      if (directory === path.join(root, 'packages')) {
        denied++;
        callback(Object.assign(new Error('directory denied'), { code: 'EACCES' }), []);
      } else {
        realReaddir(directory, options, callback);
      }
    });
    syncBuiltinESMExports();
    try {
      await expect(loadDartPackageConfig(root)).rejects.toThrow('(scan-inputs)');
      expect(denied).toBe(1);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('fails instead of returning a partial map when a captured candidate is missing', async () => {
    const root = await fixture({ 'pubspec.yaml': 'name: app', 'nested/keep.txt': '' });
    await expect(
      captureDartPackageConfig(root, ['pubspec.yaml', 'nested/pubspec.yaml']),
    ).rejects.toThrow('Dart pubspec discovery failed (read-pubspec): nested/pubspec.yaml');
  });

  it('fails closed at the manifest budget', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: app',
      'nested/pubspec.yaml': 'name: data',
    });
    await expect(loadDartPackageConfig(root, { manifestLimit: 1 })).rejects.toThrow(
      'Dart pubspec discovery failed (manifest-limit)',
    );
  });

  it('captures a deep package without holding directory descriptors', async () => {
    const manifest = `${'a/'.repeat(70)}pubspec.yaml`;
    const root = await fixture({ [manifest]: 'name: data' });
    expect((await captureDartPackageConfig(root, [manifest])).packages.get('data')).toBe(
      `${'a/'.repeat(70)}lib`,
    );
  });

  it('does not treat the same candidate twice as a duplicate package', async () => {
    const root = await fixture({ 'pubspec.yaml': 'name: app' });
    expect(
      (await captureDartPackageConfig(root, ['pubspec.yaml', 'pubspec.yaml'])).packages,
    ).toEqual(config.packages);
  });

  it.each(['../pubspec.yaml', '/pubspec.yaml', 'C:/pubspec.yaml', 'a/../pubspec.yaml'])(
    'rejects a non-repository manifest path: %s',
    async (candidate) => {
      const root = await fixture({ 'pubspec.yaml': 'name: app' });
      await expect(captureDartPackageConfig(root, [candidate])).rejects.toThrow('(manifest-path)');
    },
  );

  it('rejects an enumerated nonregular manifest', async () => {
    const root = await fixture({});
    await mkdir(path.join(root, 'pubspec.yaml'));
    await expect(captureDartPackageConfig(root, ['pubspec.yaml'])).rejects.toThrow(
      '(read-pubspec)',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'does not block on a FIFO manifest',
    async () => {
      const root = await fixture({});
      execFileSync('mkfifo', [path.join(root, 'pubspec.yaml')]);
      await expect(captureDartPackageConfig(root, ['pubspec.yaml'])).rejects.toThrow(
        '(read-pubspec)',
      );
    },
    3_000,
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed when a pubspec cannot be read',
    async () => {
      const root = await fixture({ 'pubspec.yaml': 'name: app' });
      await chmod(path.join(root, 'pubspec.yaml'), 0o000);
      await expect(loadDartPackageConfig(root)).rejects.toThrow('(read-pubspec)');
    },
  );

  it.skipIf(process.platform === 'win32')('does not follow a symlinked manifest', async () => {
    const outside = await fixture({ 'pubspec.yaml': 'name: foreign' });
    const root = await fixture({ 'nested/pubspec.yaml': 'name: data' });
    await symlink(path.join(outside, 'pubspec.yaml'), path.join(root, 'pubspec.yaml'));
    expect(
      (await captureDartPackageConfig(root, ['pubspec.yaml', 'nested/pubspec.yaml'])).packages,
    ).toEqual(new Map([['data', 'nested/lib']]));
  });

  it.skipIf(process.platform === 'win32')(
    'closes a symlinked manifest without reading when no-follow is unavailable',
    async () => {
      const outside = await fixture({ 'pubspec.yaml': 'name: foreign' });
      const root = await fixture({ 'nested/pubspec.yaml': 'name: data' });
      const manifest = path.join(root, 'pubspec.yaml');
      await symlink(path.join(outside, 'pubspec.yaml'), manifest);
      const realOpen = fs.open;
      let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
      const read = vi.fn();
      let restoreRead = () => {};
      const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (file !== manifest) return realOpen(file, flags, mode);
        const handle = await realOpen(
          file,
          typeof flags === 'number' ? flags & ~(fs.constants.O_NOFOLLOW ?? 0) : flags,
          mode,
        );
        opened = handle;
        const readSpy = vi.spyOn(handle, 'read').mockImplementation(read);
        restoreRead = () => readSpy.mockRestore();
        return handle;
      });
      syncBuiltinESMExports();
      try {
        expect(
          (await captureDartPackageConfig(root, ['pubspec.yaml', 'nested/pubspec.yaml'])).packages,
        ).toEqual(new Map([['data', 'nested/lib']]));
        expect(read).not.toHaveBeenCalled();
        expect(spy.mock.calls.filter(([file]) => file === manifest)).toHaveLength(1);
        expect(opened?.fd).toBe(-1);
      } finally {
        restoreRead();
        spy.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );

  it('excludes candidates below directory symlinks or Windows junctions', async () => {
    const outside = await fixture({ 'nested/pubspec.yaml': 'name: foreign' });
    const root = await fixture({ 'pubspec.yaml': 'name: app' });
    await symlink(
      outside,
      path.join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (await captureDartPackageConfig(root, ['pubspec.yaml', 'linked/nested/pubspec.yaml']))
        .packages,
    ).toEqual(config.packages);
  });

  it('pins the manifest before pathname validation can race with replacement', async () => {
    const root = await fixture({ 'pubspec.yaml': 'name: app' });
    const manifest = path.join(root, 'pubspec.yaml');
    const original = await fs.lstat(manifest, { bigint: true });
    const realOpen = fs.open;
    const realLstat = fs.lstat;
    let replaced = false;
    let openedInode: bigint | undefined;
    const statSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (file, options) => {
      const info = await realLstat(file, options);
      if (file === manifest && !replaced) {
        replaced = true;
        await rename(manifest, path.join(root, 'old.yaml'));
        await fs.utimes(path.join(root, 'old.yaml'), 1, 1);
        await writeFile(manifest, 'name: foreign');
      }
      return info;
    });
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      if (file === manifest) openedInode = (await handle.stat({ bigint: true })).ino;
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(captureDartPackageConfig(root, ['pubspec.yaml'])).rejects.toThrow(
        '(read-pubspec)',
      );
      expect(replaced).toBe(true);
      expect(openedInode).toBe(original.ino);
    } finally {
      spy.mockRestore();
      statSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('closes a descriptor without reading when its pathname is replaced after open', async () => {
    const root = await fixture({ 'pubspec.yaml': 'name: app' });
    const manifest = path.join(root, 'pubspec.yaml');
    const realOpen = fs.open;
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    const read = vi.fn();
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      if (file === manifest) {
        opened = handle;
        vi.spyOn(handle, 'read').mockImplementation(read);
        await rename(manifest, path.join(root, 'old.yaml'));
        await writeFile(manifest, 'name: foreign');
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(captureDartPackageConfig(root, ['pubspec.yaml'])).rejects.toThrow(
        '(read-pubspec)',
      );
      expect(read).not.toHaveBeenCalled();
      expect(opened?.fd).toBe(-1);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('rejects a same-size manifest edit after the initial descriptor check', async () => {
    const root = await fixture({ 'pubspec.yaml': 'name: app' });
    const manifest = path.join(root, 'pubspec.yaml');
    const realOpen = fs.open;
    let changed = false;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      if (file === manifest) {
        const realStat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
          const before = await realStat({ bigint: true });
          await writeFile(manifest, 'name: new');
          // Force an observable change even on a filesystem with coarse timestamps.
          await fs.utimes(manifest, 1, 1);
          changed = true;
          return before;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(captureDartPackageConfig(root, ['pubspec.yaml'])).rejects.toThrow(
        '(read-pubspec)',
      );
      expect(changed).toBe(true);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('uses only captured package identity after the repository path is replaced', async () => {
    const root = await fixture({
      'pubspec.yaml': 'name: app',
      'lib/models.dart': 'class Model {}',
    });
    const captured = await scanPhase.execute(
      {
        repoPath: root,
        graph: createKnowledgeGraph(),
        onProgress: () => {},
        pipelineStart: Date.now(),
      },
      new Map(),
    );
    const resolutionConfig = captured.resolutionConfigs?.get(SupportedLanguages.Dart);
    expect(resolutionConfig).toBeDefined();
    const moved = `${root}-moved`;
    await rename(root, moved);
    roots.push(moved);
    await mkdir(root);
    await writeFile(path.join(root, 'pubspec.yaml'), 'name: foreign');
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:app/models.dart',
        'lib/main.dart',
        new Set(captured.allPaths),
        resolutionConfig,
      ),
    ).toBe('lib/models.dart');
    expect(
      dartScopeResolver.resolveImportTarget(
        'package:foreign/models.dart',
        'lib/main.dart',
        new Set(captured.allPaths),
        resolutionConfig,
      ),
    ).toBeNull();
  });

  it('rejects oversized captured metadata before the shared scanner can filter it away', async () => {
    const root = await fixture({
      'pubspec.yaml': `name: app\n#${'x'.repeat(1024 * 1024)}`,
      'lib/main.dart': 'void main() {}',
    });
    await expect(
      scanPhase.execute(
        {
          repoPath: root,
          graph: createKnowledgeGraph(),
          onProgress: () => {},
          pipelineStart: Date.now(),
        },
        new Map(),
      ),
    ).rejects.toThrow('(manifest-size)');
  });

  it('opens only manifest candidates and checks each shared parent once', async () => {
    const root = await fixture({
      'packages/a/pubspec.yaml': 'name: a',
      'packages/b/pubspec.yaml': 'name: b',
    });
    const paths = Array.from({ length: 10_000 }, (_, i) => `other/file${i}.dart`);
    paths.push('packages/a/pubspec.yaml', 'packages/b/pubspec.yaml');
    const openSpy = vi.spyOn(fs, 'open');
    const statSpy = vi.spyOn(fs, 'lstat');
    syncBuiltinESMExports();
    try {
      expect((await captureDartPackageConfig(root, paths)).packages.size).toBe(2);
      expect(openSpy).toHaveBeenCalledTimes(2);
      expect(
        statSpy.mock.calls.filter(([file]) => file === path.join(root, 'packages')),
      ).toHaveLength(1);
    } finally {
      openSpy.mockRestore();
      statSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
