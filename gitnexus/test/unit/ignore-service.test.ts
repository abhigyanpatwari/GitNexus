import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  shouldIgnorePath,
  isHardcodedIgnoredDirectory,
  loadIgnoreRules,
  createIgnoreFilter,
} from '../../src/config/ignore-service.js';

describe('shouldIgnorePath', () => {
  describe('version control directories', () => {
    it.each(['.git', '.svn', '.hg', '.bzr'])('ignores %s directory', (dir) => {
      expect(shouldIgnorePath(`${dir}/config`)).toBe(true);
      expect(shouldIgnorePath(`project/${dir}/HEAD`)).toBe(true);
    });
  });

  describe('IDE/editor directories', () => {
    it.each(['.idea', '.vscode', '.vs'])('ignores %s directory', (dir) => {
      expect(shouldIgnorePath(`${dir}/settings.json`)).toBe(true);
    });
  });

  describe('dependency directories', () => {
    it.each([
      'node_modules',
      'vendor',
      'venv',
      '.venv',
      '__pycache__',
      'site-packages',
      '.mypy_cache',
      '.pytest_cache',
    ])('ignores %s directory', (dir) => {
      expect(shouldIgnorePath(`project/${dir}/some-file.js`)).toBe(true);
    });
  });

  describe('build output directories', () => {
    it.each([
      'dist',
      'build',
      'out',
      'output',
      'bin',
      'obj',
      'target',
      '.next',
      '.nuxt',
      '.vercel',
      '.parcel-cache',
      '.turbo',
    ])('ignores %s directory', (dir) => {
      expect(shouldIgnorePath(`${dir}/bundle.js`)).toBe(true);
    });
  });

  describe('test/coverage directories', () => {
    it.each(['coverage', '__tests__', '__mocks__', '.nyc_output'])(
      'ignores %s directory',
      (dir) => {
        expect(shouldIgnorePath(`${dir}/results.json`)).toBe(true);
      },
    );
  });

  describe('ignored file extensions', () => {
    it.each([
      // Images
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.svg',
      '.ico',
      '.webp',
      // Archives
      '.zip',
      '.tar',
      '.gz',
      '.rar',
      // Binary/Compiled
      '.exe',
      '.dll',
      '.so',
      '.dylib',
      '.class',
      '.jar',
      '.pyc',
      '.wasm',
      // Documents
      '.pdf',
      '.doc',
      '.docx',
      // Media
      '.mp4',
      '.mp3',
      '.wav',
      // Fonts
      '.woff',
      '.woff2',
      '.ttf',
      // Databases
      '.db',
      '.sqlite',
      // Source maps
      '.map',
      // Lock files
      '.lock',
      // Certificates
      '.pem',
      '.key',
      '.crt',
      // Data files
      '.csv',
      '.parquet',
      '.pkl',
    ])('ignores files with %s extension', (ext) => {
      expect(shouldIgnorePath(`assets/file${ext}`)).toBe(true);
    });
  });

  describe('ignored files by exact name', () => {
    it.each([
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'composer.lock',
      'Cargo.lock',
      'go.sum',
      '.gitignore',
      '.gitattributes',
      '.npmrc',
      '.editorconfig',
      '.prettierrc',
      '.eslintignore',
      '.dockerignore',
      'LICENSE',
      'LICENSE.md',
      'CHANGELOG.md',
      '.env',
      '.env.local',
      '.env.production',
    ])('ignores %s', (fileName) => {
      expect(shouldIgnorePath(fileName)).toBe(true);
      expect(shouldIgnorePath(`project/${fileName}`)).toBe(true);
    });
  });

  describe('compound extensions', () => {
    it('ignores .min.js files', () => {
      expect(shouldIgnorePath('dist/bundle.min.js')).toBe(true);
    });

    it('ignores .bundle.js files', () => {
      expect(shouldIgnorePath('dist/app.bundle.js')).toBe(true);
    });

    it('ignores .chunk.js files', () => {
      expect(shouldIgnorePath('dist/vendor.chunk.js')).toBe(true);
    });

    it('ignores .min.css files', () => {
      expect(shouldIgnorePath('dist/styles.min.css')).toBe(true);
    });
  });

  describe('generated files', () => {
    it('ignores .generated. files', () => {
      expect(shouldIgnorePath('src/api.generated.ts')).toBe(true);
    });

    it('ignores TypeScript declaration files', () => {
      expect(shouldIgnorePath('types/index.d.ts')).toBe(true);
    });
  });

  describe('Windows path normalization', () => {
    it('normalizes backslashes to forward slashes', () => {
      expect(shouldIgnorePath('node_modules\\express\\index.js')).toBe(true);
      expect(shouldIgnorePath('project\\.git\\HEAD')).toBe(true);
    });
  });

  describe('files that should NOT be ignored', () => {
    it.each([
      'src/index.ts',
      'src/components/Button.tsx',
      'lib/utils.py',
      'cmd/server/main.go',
      'src/main.rs',
      'app/Models/User.php',
      'Sources/App.swift',
      'src/App.java',
      'src/main.c',
      'src/main.cpp',
      'src/Program.cs',
    ])('does not ignore source file %s', (filePath) => {
      expect(shouldIgnorePath(filePath)).toBe(false);
    });
  });
});

describe('isHardcodedIgnoredDirectory', () => {
  it('returns true for known ignored directories', () => {
    expect(isHardcodedIgnoredDirectory('node_modules')).toBe(true);
    expect(isHardcodedIgnoredDirectory('.git')).toBe(true);
    expect(isHardcodedIgnoredDirectory('dist')).toBe(true);
    expect(isHardcodedIgnoredDirectory('__pycache__')).toBe(true);
  });

  it('returns false for source directories', () => {
    expect(isHardcodedIgnoredDirectory('src')).toBe(false);
    expect(isHardcodedIgnoredDirectory('lib')).toBe(false);
    expect(isHardcodedIgnoredDirectory('app')).toBe(false);
    expect(isHardcodedIgnoredDirectory('local')).toBe(false);
  });
});

// ─── GITNEXUS_INDEX_TEST_DIRS opt-in (#771) ─────────────────────────
//
// The env var lets Quality Engineering users opt into indexing
// __tests__ and __mocks__ so they can trace test coverage via CALLS
// edges. These tests lock in:
//   - default behaviour (env unset) is byte-identical to pre-#771
//   - env set removes EXACTLY __tests__ and __mocks__ from the
//     effective ignore set — other hardcoded entries stay ignored
//   - test-adjacent dirs the issue did NOT ask for (__snapshots__,
//     snapshots, fixtures, .jest) remain ignored regardless — this
//     is a scope-discipline lock; a future expansion would fail here
//   - `isHardcodedIgnoredDirectory` export semantic is unchanged
//     (it's a raw-membership query, not an effective-runtime query)
describe('GITNEXUS_INDEX_TEST_DIRS opt-in (#771)', () => {
  const savedEnv = process.env.GITNEXUS_INDEX_TEST_DIRS;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.GITNEXUS_INDEX_TEST_DIRS;
    } else {
      process.env.GITNEXUS_INDEX_TEST_DIRS = savedEnv;
    }
  });

  describe('default behaviour — env unset', () => {
    beforeEach(() => {
      delete process.env.GITNEXUS_INDEX_TEST_DIRS;
    });

    it('ignores __tests__ directory paths', () => {
      expect(shouldIgnorePath('src/__tests__/foo.test.ts')).toBe(true);
      expect(shouldIgnorePath('__tests__/index.test.js')).toBe(true);
    });

    it('ignores __mocks__ directory paths', () => {
      expect(shouldIgnorePath('src/__mocks__/api.ts')).toBe(true);
      expect(shouldIgnorePath('pkg/__mocks__/fs.js')).toBe(true);
    });
  });

  describe('opt-in behaviour — env set', () => {
    beforeEach(() => {
      process.env.GITNEXUS_INDEX_TEST_DIRS = '1';
    });

    it('does NOT ignore __tests__ paths', () => {
      expect(shouldIgnorePath('src/__tests__/foo.test.ts')).toBe(false);
      expect(shouldIgnorePath('__tests__/index.test.js')).toBe(false);
    });

    it('does NOT ignore __mocks__ paths', () => {
      expect(shouldIgnorePath('src/__mocks__/api.ts')).toBe(false);
      expect(shouldIgnorePath('pkg/__mocks__/fs.js')).toBe(false);
    });

    it('still ignores other hardcoded entries (node_modules, .git, dist, __pycache__)', () => {
      // Opt-in is scoped narrowly — every other auto-filter stays active.
      expect(shouldIgnorePath('node_modules/foo.js')).toBe(true);
      expect(shouldIgnorePath('.git/HEAD')).toBe(true);
      expect(shouldIgnorePath('dist/bundle.js')).toBe(true);
      expect(shouldIgnorePath('src/__pycache__/module.pyc')).toBe(true);
    });

    it('still ignores test-adjacent dirs the issue did NOT ask to unlock', () => {
      // Scope-discipline guard — #771 explicitly names __tests__ and
      // __mocks__. Other test-adjacent entries (__snapshots__, snapshots,
      // fixtures, .jest) stay ignored. A future PR that widens the
      // opt-in without filing a new issue would fail here.
      expect(shouldIgnorePath('src/__snapshots__/foo.snap')).toBe(true);
      expect(shouldIgnorePath('test/snapshots/foo.snap')).toBe(true);
      expect(shouldIgnorePath('pkg/fixtures/data.json')).toBe(true);
      expect(shouldIgnorePath('.jest/cache.js')).toBe(true);
    });
  });

  describe('isHardcodedIgnoredDirectory export is unchanged by env var', () => {
    it('returns true for __tests__ regardless of env', () => {
      // The raw-membership query has a different contract from the
      // effective-runtime query. `isHardcodedIgnoredDirectory` is
      // "is this in the hardcoded list?" — the list itself does not
      // change. The runtime decision changes via shouldIgnorePath.
      delete process.env.GITNEXUS_INDEX_TEST_DIRS;
      expect(isHardcodedIgnoredDirectory('__tests__')).toBe(true);
      expect(isHardcodedIgnoredDirectory('__mocks__')).toBe(true);

      process.env.GITNEXUS_INDEX_TEST_DIRS = '1';
      expect(isHardcodedIgnoredDirectory('__tests__')).toBe(true);
      expect(isHardcodedIgnoredDirectory('__mocks__')).toBe(true);
    });
  });
});

describe('loadIgnoreRules', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-test-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no ignore files exist', async () => {
    const result = await loadIgnoreRules(tmpDir);
    expect(result).toBeNull();
  });

  it('parses .gitignore file', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'data/\nlogs/\n');
    const ig = await loadIgnoreRules(tmpDir);
    expect(ig).not.toBeNull();
    expect(ig!.ignores('data/file.txt')).toBe(true);
    expect(ig!.ignores('logs/app.log')).toBe(true);
    expect(ig!.ignores('src/index.ts')).toBe(false);
    await fs.unlink(path.join(tmpDir, '.gitignore'));
  });

  it('parses .gitnexusignore file', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), 'vendor/\n*.test.ts\n');
    const ig = await loadIgnoreRules(tmpDir);
    expect(ig).not.toBeNull();
    expect(ig!.ignores('vendor/lib.js')).toBe(true);
    expect(ig!.ignores('src/app.test.ts')).toBe(true);
    expect(ig!.ignores('src/app.ts')).toBe(false);
    await fs.unlink(path.join(tmpDir, '.gitnexusignore'));
  });

  it('combines both files', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'data/\n');
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), 'vendor/\n');
    const ig = await loadIgnoreRules(tmpDir);
    expect(ig).not.toBeNull();
    expect(ig!.ignores('data/file.txt')).toBe(true);
    expect(ig!.ignores('vendor/lib.js')).toBe(true);
    expect(ig!.ignores('src/index.ts')).toBe(false);
    await fs.unlink(path.join(tmpDir, '.gitignore'));
    await fs.unlink(path.join(tmpDir, '.gitnexusignore'));
  });

  it('handles comments and blank lines', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.gitignore'),
      '# comment\n\ndata/\n\n# another comment\n',
    );
    const ig = await loadIgnoreRules(tmpDir);
    expect(ig).not.toBeNull();
    expect(ig!.ignores('data/file.txt')).toBe(true);
    expect(ig!.ignores('src/index.ts')).toBe(false);
    await fs.unlink(path.join(tmpDir, '.gitignore'));
  });
});

describe('createIgnoreFilter', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-filter-test-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a filter with ignored and childrenIgnored methods', async () => {
    const filter = await createIgnoreFilter(tmpDir);
    expect(typeof filter.ignored).toBe('function');
    expect(typeof filter.childrenIgnored).toBe('function');
  });

  it('childrenIgnored returns true for hardcoded directories', async () => {
    const filter = await createIgnoreFilter(tmpDir);
    // Simulate a Path-like object
    const mockPath = { name: 'node_modules', relative: () => 'node_modules' } as any;
    expect(filter.childrenIgnored(mockPath)).toBe(true);

    const srcPath = { name: 'src', relative: () => 'src' } as any;
    expect(filter.childrenIgnored(srcPath)).toBe(false);
  });

  it('childrenIgnored returns true for gitignored directories', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'local/\n');
    const filter = await createIgnoreFilter(tmpDir);

    const localPath = { name: 'local', relative: () => 'local' } as any;
    expect(filter.childrenIgnored(localPath)).toBe(true);

    const srcPath = { name: 'src', relative: () => 'src' } as any;
    expect(filter.childrenIgnored(srcPath)).toBe(false);

    await fs.unlink(path.join(tmpDir, '.gitignore'));
  });

  it('childrenIgnored returns true for bare-name directory patterns (no trailing slash)', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'local\n');
    const filter = await createIgnoreFilter(tmpDir);

    const localPath = { name: 'local', relative: () => 'local' } as any;
    expect(filter.childrenIgnored(localPath)).toBe(true);

    const srcPath = { name: 'src', relative: () => 'src' } as any;
    expect(filter.childrenIgnored(srcPath)).toBe(false);

    await fs.unlink(path.join(tmpDir, '.gitignore'));
  });

  it('childrenIgnored respects negation patterns (exclude-all + whitelist)', async () => {
    // Reproduces https://github.com/abhigyanpatwari/GitNexus/issues/596
    // Pattern: `*` (exclude all) + `!iOS/` + `!iOS/**` (whitelist iOS)
    await fs.writeFile(
      path.join(tmpDir, '.gitnexusignore'),
      '*\n!iOS/\n!iOS/**\n!backend/\n!backend/living_plan/\n!backend/living_plan/**\n',
    );
    const filter = await createIgnoreFilter(tmpDir);

    // Whitelisted directories must NOT be pruned
    const iosPath = { name: 'iOS', relative: () => 'iOS' } as any;
    expect(filter.childrenIgnored(iosPath)).toBe(false);

    const backendPath = { name: 'backend', relative: () => 'backend' } as any;
    expect(filter.childrenIgnored(backendPath)).toBe(false);

    const livingPlanPath = { name: 'living_plan', relative: () => 'backend/living_plan' } as any;
    expect(filter.childrenIgnored(livingPlanPath)).toBe(false);

    // Non-whitelisted directories must still be pruned
    const srcPath = { name: 'src', relative: () => 'src' } as any;
    expect(filter.childrenIgnored(srcPath)).toBe(true);

    const libPath = { name: 'lib', relative: () => 'lib' } as any;
    expect(filter.childrenIgnored(libPath)).toBe(true);

    await fs.unlink(path.join(tmpDir, '.gitnexusignore'));
  });

  it('childrenIgnored respects negation patterns without trailing slash (!dir vs !dir/)', async () => {
    // Per gitignore spec: `!iOS` (no slash) negates both files and directories
    // named `iOS`, while `!iOS/` is directory-only. The `ignore` package
    // normalizes both forms so that `ig.ignores('iOS/')` returns false in either case.
    // Ref: https://github.com/kaelzhang/node-ignore#2-filenames-and-dirnames (see #596)
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '*\n!iOS\n!iOS/**\n');
    const filter = await createIgnoreFilter(tmpDir);

    // Bare negation `!iOS` must also un-ignore the iOS/ directory
    const iosPath = { name: 'iOS', relative: () => 'iOS' } as any;
    expect(filter.childrenIgnored(iosPath)).toBe(false);

    // Non-whitelisted directories still pruned
    const srcPath = { name: 'src', relative: () => 'src' } as any;
    expect(filter.childrenIgnored(srcPath)).toBe(true);

    await fs.unlink(path.join(tmpDir, '.gitnexusignore'));
  });

  it('ignored respects negation patterns for files under whitelisted directories', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '*\n!iOS/\n!iOS/**\n');
    const filter = await createIgnoreFilter(tmpDir);

    // Files under whitelisted directory should NOT be ignored
    const swiftFile = { name: 'App.swift', relative: () => 'iOS/App.swift' } as any;
    expect(filter.ignored(swiftFile)).toBe(false);

    // Files outside whitelisted directory should be ignored
    const pyFile = { name: 'main.py', relative: () => 'scripts/main.py' } as any;
    expect(filter.ignored(pyFile)).toBe(true);

    await fs.unlink(path.join(tmpDir, '.gitnexusignore'));
  });

  it('ignored returns true for file-glob patterns like *.log', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '*.log\n');
    const filter = await createIgnoreFilter(tmpDir);

    const logPath = { name: 'app.log', relative: () => 'app.log' } as any;
    expect(filter.ignored(logPath)).toBe(true);

    const tsPath = { name: 'index.ts', relative: () => 'src/index.ts' } as any;
    expect(filter.ignored(tsPath)).toBe(false);

    await fs.unlink(path.join(tmpDir, '.gitignore'));
  });
});

describe('loadIgnoreRules — error handling', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-err-test-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('warns on EACCES but does not throw', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'data/\n');
    await fs.chmod(gitignorePath, 0o000);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadIgnoreRules(tmpDir);
    // Should still return (null or partial), not throw
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('.gitignore'));

    warnSpy.mockRestore();
    await fs.chmod(gitignorePath, 0o644);
    await fs.unlink(gitignorePath);
  });
});

describe('loadIgnoreRules — GITNEXUS_NO_GITIGNORE env var', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-noignore-test-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('skips .gitignore when GITNEXUS_NO_GITIGNORE is set', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'data/\n');

    const original = process.env.GITNEXUS_NO_GITIGNORE;
    process.env.GITNEXUS_NO_GITIGNORE = '1';
    try {
      const ig = await loadIgnoreRules(tmpDir);
      // .gitignore should be skipped — no rules loaded
      expect(ig).toBeNull();
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_NO_GITIGNORE;
      } else {
        process.env.GITNEXUS_NO_GITIGNORE = original;
      }
      await fs.unlink(path.join(tmpDir, '.gitignore'));
    }
  });

  it('still reads .gitnexusignore when GITNEXUS_NO_GITIGNORE is set', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), 'vendor/\n');

    const original = process.env.GITNEXUS_NO_GITIGNORE;
    process.env.GITNEXUS_NO_GITIGNORE = '1';
    try {
      const ig = await loadIgnoreRules(tmpDir);
      expect(ig).not.toBeNull();
      expect(ig!.ignores('vendor/lib.js')).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_NO_GITIGNORE;
      } else {
        process.env.GITNEXUS_NO_GITIGNORE = original;
      }
      await fs.unlink(path.join(tmpDir, '.gitnexusignore'));
    }
  });
});
