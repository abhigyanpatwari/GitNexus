import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dartScopeResolver } from '../../src/core/ingestion/languages/dart/scope-resolver.js';
import { loadDartPackageConfig } from '../../src/core/ingestion/languages/dart/package-config.js';
import { CountingSet } from '../helpers/counting-file-set.js';
import { _captureLogger } from '../../src/core/logger.js';

const files = new Set(['lib/main.dart', 'lib/http.dart', 'lib/models.dart', 'tool/run.dart']);
const config = { packages: new Map([['app', 'lib']]) };

describe('Dart package identity (#2963)', () => {
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

  it('refuses an incomplete scan rather than persisting untracked identity changes', async () => {
    const root = await fixture({});
    await expect(loadDartPackageConfig(path.join(root, 'missing'))).rejects.toThrow(
      'Dart pubspec discovery failed (read-directory)',
    );
  });
});
