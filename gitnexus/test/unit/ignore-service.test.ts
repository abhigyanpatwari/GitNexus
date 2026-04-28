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

// ─── .gitnexusignore negation can override hardcoded list (#771) ────
//
// Per @magyargergo's review: `.gitnexusignore` should honour
// `.gitignore`-style negation against the hardcoded DEFAULT_IGNORE_LIST.
// A `!__tests__/` line in `.gitnexusignore` must re-enable indexing of
// `__tests__/` even though the hardcoded list would normally block it.
// These tests exercise the full `createIgnoreFilter` surface with real
// temp files (the negation logic lives in `createIgnoreFilter`, not in
// `shouldIgnorePath` — the latter stays pure-hardcoded for callers like
// the wiki generator that don't have per-repo config context).
//
// Locks in:
//   1. Default (no .gitnexusignore) — hardcoded list still blocks
//      __tests__ / __mocks__ / node_modules (byte-identical pre-#771).
//   2. `!__tests__/` negation — __tests__ and its descendants are
//      indexed; other hardcoded entries (node_modules, .git) stay
//      blocked.
//   3. Broader negation (e.g. `!node_modules/`) also works — design is
//      general, not special-cased to the 2 test dirs.
//   4. Negation applies both to the directory itself (`childrenIgnored`
//      allows descent) AND to descendants (`ignored` allows files).
//   5. `shouldIgnorePath` pure-hardcoded contract is preserved — the
//      wiki generator and other callers without per-repo config get
//      deterministic behavior.
describe('.gitnexusignore negation overrides hardcoded DEFAULT_IGNORE_LIST (#771)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-negation-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Synthetic path-scurry Path helper. `createIgnoreFilter.ignored` /
   *  `childrenIgnored` only look at `.relative()` and `.name`, so a
   *  minimal shape with those two is enough to exercise the logic. */
  const mkPath = (rel: string) =>
    ({
      relative: () => rel.replace(/\\/g, '/'),
      name: rel.split(/[/\\]/).pop() || rel,
    }) as unknown as Parameters<Awaited<ReturnType<typeof createIgnoreFilter>>['ignored']>[0];

  it('default (no .gitnexusignore): __tests__ still blocked by hardcoded list', async () => {
    const filter = await createIgnoreFilter(tmpDir);
    expect(filter.ignored(mkPath('__tests__/foo.test.ts'))).toBe(true);
    expect(filter.childrenIgnored(mkPath('__tests__'))).toBe(true);
  });

  it('`!__tests__/` negation unlocks the directory and its descendants', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '!__tests__/\n');
    const filter = await createIgnoreFilter(tmpDir);
    expect(filter.childrenIgnored(mkPath('__tests__'))).toBe(false);
    expect(filter.ignored(mkPath('__tests__/foo.test.ts'))).toBe(false);
    expect(filter.ignored(mkPath('src/__tests__/nested.test.ts'))).toBe(false);
  });

  it('`!__mocks__/` negation unlocks __mocks__ but NOT __tests__', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '!__mocks__/\n');
    const filter = await createIgnoreFilter(tmpDir);
    expect(filter.ignored(mkPath('__mocks__/api.ts'))).toBe(false);
    // __tests__ not negated — hardcoded list still blocks it.
    expect(filter.ignored(mkPath('__tests__/foo.test.ts'))).toBe(true);
    expect(filter.childrenIgnored(mkPath('__tests__'))).toBe(true);
  });

  it('negation generalises — `!node_modules/` unlocks a different hardcoded entry', async () => {
    // The design isn't special-cased to the two names from the issue —
    // it honours any negation the user writes. Lock this in with a
    // broader example that proves the mechanism, not the dir name.
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '!node_modules/\n');
    const filter = await createIgnoreFilter(tmpDir);
    expect(filter.childrenIgnored(mkPath('node_modules'))).toBe(false);
    expect(filter.ignored(mkPath('node_modules/express/index.js'))).toBe(false);
  });

  it('negation of one hardcoded entry does not leak to others', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '!__tests__/\n');
    const filter = await createIgnoreFilter(tmpDir);
    // __tests__ negated → allowed.
    expect(filter.ignored(mkPath('__tests__/foo.test.ts'))).toBe(false);
    // But node_modules / .git / dist not negated → still blocked.
    expect(filter.ignored(mkPath('node_modules/pkg/index.js'))).toBe(true);
    expect(filter.ignored(mkPath('.git/HEAD'))).toBe(true);
    expect(filter.ignored(mkPath('dist/bundle.js'))).toBe(true);
    expect(filter.childrenIgnored(mkPath('node_modules'))).toBe(true);
    expect(filter.childrenIgnored(mkPath('.git'))).toBe(true);
  });

  it('standard `.gitignore` rules (no negation) still layer on top of hardcoded', async () => {
    // Pre-#771 behaviour: if .gitnexusignore says `my-dir/`, that dir
    // is ignored in addition to the hardcoded list. Non-negation
    // rules are unaffected by this PR.
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), 'my-dir/\n');
    const filter = await createIgnoreFilter(tmpDir);
    expect(filter.ignored(mkPath('my-dir/file.ts'))).toBe(true);
    expect(filter.childrenIgnored(mkPath('my-dir'))).toBe(true);
    // Hardcoded still blocks unaffected paths.
    expect(filter.ignored(mkPath('node_modules/foo.js'))).toBe(true);
  });

  it('`!parent/` + `parent/child/` re-ignore: child still blocked (last-match-wins)', async () => {
    // .gitignore semantics: a later more-specific rule overrides an
    // earlier negation. The negation unlocks the hardcoded block on
    // `__tests__/`, but the subsequent `__tests__/generated/` line
    // re-ignores that subset. `__tests__/foo.test.ts` stays allowed;
    // `__tests__/generated/foo.ts` stays blocked. This locks in the
    // guarantee the design comment makes about "standard rules still
    // layer on top" for the compound case.
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '!__tests__/\n__tests__/generated/\n');
    const filter = await createIgnoreFilter(tmpDir);
    // Parent negation still in effect: top-level tests allowed.
    expect(filter.ignored(mkPath('__tests__/foo.test.ts'))).toBe(false);
    expect(filter.childrenIgnored(mkPath('__tests__'))).toBe(false);
    // Re-ignored subdirectory: children blocked at file level AND at
    // the directory-descent level, so ingestion never walks in.
    expect(filter.ignored(mkPath('__tests__/generated/foo.ts'))).toBe(true);
    expect(filter.childrenIgnored(mkPath('__tests__/generated'))).toBe(true);
  });

  it('shouldIgnorePath (raw hardcoded check) is unchanged — wiki / external callers unaffected', async () => {
    // `shouldIgnorePath` is called from `core/wiki/generator.ts` and
    // doesn't have access to per-repo `.gitnexusignore` config. Its
    // contract stays "is this path in the hardcoded list?". The #771
    // negation override lives only inside `createIgnoreFilter`, which
    // IS called with config context. This asymmetry is deliberate.
    expect(shouldIgnorePath('__tests__/foo.test.ts')).toBe(true);
    expect(shouldIgnorePath('__mocks__/api.ts')).toBe(true);
    expect(shouldIgnorePath('node_modules/pkg/index.js')).toBe(true);
  });

  it('isHardcodedIgnoredDirectory (raw membership) unchanged by negation', async () => {
    // Pure membership query — the list itself doesn't mutate.
    expect(isHardcodedIgnoredDirectory('__tests__')).toBe(true);
    expect(isHardcodedIgnoredDirectory('__mocks__')).toBe(true);
    expect(isHardcodedIgnoredDirectory('node_modules')).toBe(true);
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

  // Also skip under uid=0: root bypasses POSIX read-permission checks, so
  // chmod 000 does NOT trigger EACCES — fs.readFile reads the file anyway
  // and loadIgnoreRules returns parsed rules instead of null. This makes
  // the test fail in any privileged environment (rootful Docker, CI runners
  // configured with root). The non-root branch still exercises the real
  // EACCES path; root just can't reproduce the failure mode.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'warns on EACCES but does not throw',
    async () => {
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
    },
  );
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
