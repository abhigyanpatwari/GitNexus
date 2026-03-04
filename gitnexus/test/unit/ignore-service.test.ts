import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  shouldIgnorePath,
  filterRepositoryPathsSync,
  getRelevantChangedFilesSinceCommit,
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
      'node_modules', 'vendor', 'venv', '.venv', '__pycache__',
      'site-packages', '.mypy_cache', '.pytest_cache',
    ])('ignores %s directory', (dir) => {
      expect(shouldIgnorePath(`project/${dir}/some-file.js`)).toBe(true);
    });
  });

  describe('build output directories', () => {
    it.each([
      'dist', 'build', 'out', 'output', 'bin', 'obj', 'target',
      '.next', '.nuxt', '.vercel', '.parcel-cache', '.turbo',
    ])('ignores %s directory', (dir) => {
      expect(shouldIgnorePath(`${dir}/bundle.js`)).toBe(true);
    });
  });

  describe('test/coverage directories', () => {
    it.each(['coverage', '__tests__', '__mocks__', '.nyc_output'])('ignores %s directory', (dir) => {
      expect(shouldIgnorePath(`${dir}/results.json`)).toBe(true);
    });
  });

  describe('ignored file extensions', () => {
    it.each([
      // Images
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
      // Archives
      '.zip', '.tar', '.gz', '.rar',
      // Binary/Compiled
      '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.pyc', '.wasm',
      // Documents
      '.pdf', '.doc', '.docx',
      // Media
      '.mp4', '.mp3', '.wav',
      // Fonts
      '.woff', '.woff2', '.ttf',
      // Databases
      '.db', '.sqlite',
      // Source maps
      '.map',
      // Lock files
      '.lock',
      // Certificates
      '.pem', '.key', '.crt',
      // Data files
      '.csv', '.parquet', '.pkl',
    ])('ignores files with %s extension', (ext) => {
      expect(shouldIgnorePath(`assets/file${ext}`)).toBe(true);
    });
  });

  describe('ignored files by exact name', () => {
    it.each([
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      'composer.lock', 'Cargo.lock', 'go.sum',
      '.gitignore', '.gitattributes', '.npmrc', '.editorconfig',
      '.prettierrc', '.eslintignore', '.dockerignore',
      'LICENSE', 'LICENSE.md', 'CHANGELOG.md',
      '.env', '.env.local', '.env.production',
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

describe('filterRepositoryPathsSync', () => {
  it('respects .gitignore via git check-ignore', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'cdk.out/\n**/deploy-v1/\n');
      const input = [
        'src/index.ts',
        'cdk.out/template.json',
        'apps/product-suite-web/deploy-v1/apps/index.html',
      ];
      const filtered = filterRepositoryPathsSync(tmpDir, input);
      expect(filtered).toEqual(['src/index.ts']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps tracked files even when they match .gitignore patterns', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-tracked-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'force-added.ts\n');
      await fs.writeFile(path.join(tmpDir, 'force-added.ts'), 'export const x = 1;\n');
      execFileSync('git', ['add', '-f', 'force-added.ts'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });

      const filtered = filterRepositoryPathsSync(tmpDir, ['force-added.ts']);
      expect(filtered).toEqual(['force-added.ts']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('lets custom unignore rules override built-in ignore defaults', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-custom-over-builtins-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '!dist/keep.ts\n');
      await fs.writeFile(path.join(tmpDir, 'dist', 'keep.ts'), 'export const keep = true;\n');
      await fs.writeFile(path.join(tmpDir, 'dist', 'drop.ts'), 'export const drop = true;\n');

      const filtered = filterRepositoryPathsSync(tmpDir, [
        'dist/keep.ts',
        'dist/drop.ts',
      ]);
      expect(filtered).toEqual(['dist/keep.ts']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('honors custom unignore rules before .gitignore exclusion', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-custom-over-gitignore-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.mkdir(path.join(tmpDir, 'generated'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'generated/\n');
      await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), '!generated/typed-client.ts\n');
      await fs.writeFile(path.join(tmpDir, 'generated', 'typed-client.ts'), 'export const typed = true;\n');
      await fs.writeFile(path.join(tmpDir, 'generated', 'other.ts'), 'export const other = true;\n');

      const filtered = filterRepositoryPathsSync(tmpDir, [
        'generated/typed-client.ts',
        'generated/other.ts',
        'src/index.ts',
      ]);
      expect(filtered).toEqual([
        'generated/typed-client.ts',
        'src/index.ts',
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports custom profile ignore files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-profile-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.writeFile(path.join(tmpDir, '.gitnexusignore.focused'), 'test/\ndocs/internal/atlas/\n');
      const input = [
        'src/index.ts',
        'test/unit/foo.test.ts',
        'docs/internal/atlas/system-topology.mdx',
      ];
      const filtered = filterRepositoryPathsSync(tmpDir, input, { ignoreFile: '.gitnexusignore.focused' });
      expect(filtered).toEqual(['src/index.ts']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats null ignore options as explicit no override (no env fallback)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-null-explicit-'));
    const previousIgnoreFileEnv = process.env.GITNEXUS_IGNORE_FILE;
    const previousIgnoreProfileEnv = process.env.GITNEXUS_IGNORE_PROFILE;
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.writeFile(path.join(tmpDir, '.gitnexusignore.env'), 'tmp-ignore/\n');
      process.env.GITNEXUS_IGNORE_FILE = '.gitnexusignore.env';
      process.env.GITNEXUS_IGNORE_PROFILE = 'env-profile';

      const input = [
        'src/index.ts',
        'tmp-ignore/value.ts',
      ];

      const envDriven = filterRepositoryPathsSync(tmpDir, input);
      expect(envDriven).toEqual(['src/index.ts']);

      const explicitNull = filterRepositoryPathsSync(tmpDir, input, {
        ignoreFile: null,
        ignoreProfile: null,
      });
      expect(explicitNull).toEqual([
        'src/index.ts',
        'tmp-ignore/value.ts',
      ]);
    } finally {
      if (previousIgnoreFileEnv === undefined) delete process.env.GITNEXUS_IGNORE_FILE;
      else process.env.GITNEXUS_IGNORE_FILE = previousIgnoreFileEnv;

      if (previousIgnoreProfileEnv === undefined) delete process.env.GITNEXUS_IGNORE_PROFILE;
      else process.env.GITNEXUS_IGNORE_PROFILE = previousIgnoreProfileEnv;

      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('invalidates cached custom patterns when ignore file contents change', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-cache-invalidate-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), 'docs/\n');

      const input = [
        'src/index.ts',
        'docs/architecture.md',
        'tests/unit.ts',
      ];

      const first = filterRepositoryPathsSync(tmpDir, input);
      expect(first).toEqual([
        'src/index.ts',
        'tests/unit.ts',
      ]);

      await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), 'tests/\n');

      const second = filterRepositoryPathsSync(tmpDir, input);
      expect(second).toEqual([
        'src/index.ts',
        'docs/architecture.md',
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps directory-only semantics for custom rules', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-dironly-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), 'deploy-v1/\n');
      const input = [
        'src/index.ts',
        'src/deploy-v1',
        'src/deploy-v1/runtime.json',
        'apps/site/deploy-v1',
        'apps/site/deploy-v1/bundle.js',
      ];
      const filtered = filterRepositoryPathsSync(tmpDir, input);
      expect(filtered).toEqual([
        'src/index.ts',
        'src/deploy-v1',
        'apps/site/deploy-v1',
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps deleted tracked paths in relevance filtering', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ignore-deleted-tracked-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['config', 'user.name', 'GitNexus Test'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'force-added.ts\n');
      await fs.writeFile(path.join(tmpDir, 'force-added.ts'), 'export const tracked = true;\n');

      execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['add', '-f', 'force-added.ts'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['commit', '-q', '-m', 'initial tracked file'], { cwd: tmpDir, stdio: 'ignore' });
      const previousCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      await fs.rm(path.join(tmpDir, 'force-added.ts'));
      execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['commit', '-q', '-m', 'delete tracked file'], { cwd: tmpDir, stdio: 'ignore' });

      const result = getRelevantChangedFilesSinceCommit(tmpDir, previousCommit);
      expect(result.allChangedFiles).toContain('force-added.ts');
      expect(result.relevantChangedFiles).toContain('force-added.ts');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('large git outputs', () => {
  it('handles large git diff outputs in change filtering', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-large-diff-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['config', 'user.name', 'GitNexus Test'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });

      await fs.writeFile(path.join(tmpDir, 'src.ts'), 'export const base = 1;\n');
      execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: tmpDir, stdio: 'ignore' });
      const lastCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const longDir = path.join(
        tmpDir,
        'src',
        'segment-a-1234567890',
        'segment-b-1234567890',
        'segment-c-1234567890',
      );
      await fs.mkdir(longDir, { recursive: true });
      const fileCount = 9000;
      const longNameCore = 'segmentwithlotsofcharacters1234567890'.repeat(2); // 72 chars
      for (let i = 0; i < fileCount; i += 1) {
        await fs.writeFile(
          path.join(longDir, `${longNameCore}-${String(i).padStart(5, '0')}.ts`),
          'export const x = 1;\n',
        );
      }

      execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('git', ['commit', '-q', '-m', 'large change set'], { cwd: tmpDir, stdio: 'ignore' });

      const result = getRelevantChangedFilesSinceCommit(tmpDir, lastCommit);
      expect(result.allChangedFiles.length).toBe(fileCount);
      expect(result.relevantChangedFiles.length).toBe(fileCount);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('handles large git check-ignore outputs for path filtering', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-large-ignore-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'ignored-large/**\n');

      const input = ['src/index.ts'];
      const fileCount = 3500;
      const longPrefix = `ignored-large/${'segmentwithlotsofcharacters1234567890-'.repeat(8)}`;
      for (let i = 0; i < fileCount; i += 1) {
        input.push(`${longPrefix}/file-${String(i).padStart(4, '0')}.ts`);
      }

      const filtered = filterRepositoryPathsSync(tmpDir, input);
      expect(filtered).toEqual(['src/index.ts']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});
