import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { shouldIgnorePath, filterRepositoryPathsSync } from '../../src/config/ignore-service.js';

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
});
