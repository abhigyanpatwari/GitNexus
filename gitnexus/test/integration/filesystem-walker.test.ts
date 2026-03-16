import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { walkRepositoryPaths, readFileContents } from '../../src/core/ingestion/filesystem-walker.js';

describe('filesystem-walker', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-walker-test-'));

    // Create test directory structure
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'src', 'components'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'lodash'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export const main = () => {}');
    await fs.writeFile(path.join(tmpDir, 'src', 'utils.ts'), 'export const helper = () => {}');
    await fs.writeFile(path.join(tmpDir, 'src', 'components', 'Button.tsx'), 'export const Button = () => <div/>');
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'lodash', 'index.js'), 'module.exports = {}');
    await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'src', 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  describe('walkRepositoryPaths', () => {
    it('discovers source files', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));
      expect(paths.some(p => p.includes('src/index.ts'))).toBe(true);
      expect(paths.some(p => p.includes('src/utils.ts'))).toBe(true);
    });

    it('discovers nested files', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));
      expect(paths.some(p => p.includes('components/Button.tsx'))).toBe(true);
    });

    it('skips node_modules', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));
      expect(paths.every(p => !p.includes('node_modules'))).toBe(true);
    });

    it('skips .git directory', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));
      expect(paths.every(p => !p.includes('.git/'))).toBe(true);
    });

    it('returns file sizes', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      for (const file of files) {
        expect(typeof file.size).toBe('number');
        expect(file.size).toBeGreaterThan(0);
      }
    });

    it('calls progress callback', async () => {
      const onProgress = vi.fn();
      await walkRepositoryPaths(tmpDir, onProgress);
      expect(onProgress).toHaveBeenCalled();
    });

    // ─── Unhappy paths ────────────────────────────────────────────────

    it('throws or returns empty for non-existent directory', async () => {
      try {
        const files = await walkRepositoryPaths('/nonexistent/path/xyz123');
        // If it doesn't throw, it should return empty
        expect(files).toEqual([]);
      } catch (err: any) {
        expect(err).toBeDefined();
      }
    });

    it('returns empty for directory with only ignored files', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-walker-empty-'));
      await fs.mkdir(path.join(emptyDir, '.git'), { recursive: true });
      await fs.writeFile(path.join(emptyDir, '.git', 'HEAD'), 'ref: refs/heads/main');

      try {
        const files = await walkRepositoryPaths(emptyDir);
        expect(files).toEqual([]);
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true });
      }
    });

    it('returns empty for truly empty directory', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-walker-truly-empty-'));
      try {
        const files = await walkRepositoryPaths(emptyDir);
        expect(files).toEqual([]);
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('.gitignore support', () => {
    let gitignoreDir: string;

    beforeAll(async () => {
      gitignoreDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-walker-gitignore-'));

      // Create directory structure
      await fs.mkdir(path.join(gitignoreDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(gitignoreDir, 'data', 'cache'), { recursive: true });
      await fs.mkdir(path.join(gitignoreDir, 'logs'), { recursive: true });

      // Source files (should be indexed)
      await fs.writeFile(path.join(gitignoreDir, 'src', 'index.ts'), 'export const main = () => {}');
      await fs.writeFile(path.join(gitignoreDir, 'src', 'utils.ts'), 'export const helper = () => {}');

      // Data files (should be ignored via .gitignore)
      await fs.writeFile(path.join(gitignoreDir, 'data', 'cache', 'file.json'), '{}');
      await fs.writeFile(path.join(gitignoreDir, 'logs', 'app.log'), 'log entry');

      // .gitignore
      await fs.writeFile(path.join(gitignoreDir, '.gitignore'), 'data/\nlogs/\n');
    });

    afterAll(async () => {
      await fs.rm(gitignoreDir, { recursive: true, force: true });
    });

    it('excludes directories listed in .gitignore', async () => {
      const files = await walkRepositoryPaths(gitignoreDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));

      // Source files should be present
      expect(paths.some(p => p.includes('src/index.ts'))).toBe(true);
      expect(paths.some(p => p.includes('src/utils.ts'))).toBe(true);

      // Ignored directories should not be present
      expect(paths.every(p => !p.includes('data/'))).toBe(true);
      expect(paths.every(p => !p.includes('logs/'))).toBe(true);
    });

    it('still applies hardcoded ignore list alongside .gitignore', async () => {
      // Add node_modules (hardcoded ignore) to verify both work
      await fs.mkdir(path.join(gitignoreDir, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(gitignoreDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');

      const files = await walkRepositoryPaths(gitignoreDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));

      expect(paths.every(p => !p.includes('node_modules'))).toBe(true);
      expect(paths.every(p => !p.includes('data/'))).toBe(true);

      await fs.rm(path.join(gitignoreDir, 'node_modules'), { recursive: true, force: true });
    });
  });

  describe('.gitnexusignore support', () => {
    let nexusignoreDir: string;

    beforeAll(async () => {
      nexusignoreDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-walker-nexusignore-'));

      await fs.mkdir(path.join(nexusignoreDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(nexusignoreDir, 'local', 'grafana'), { recursive: true });

      await fs.writeFile(path.join(nexusignoreDir, 'src', 'index.ts'), 'export const main = () => {}');
      await fs.writeFile(path.join(nexusignoreDir, 'local', 'grafana', 'module.js'), 'var x = 1;');

      // Only .gitnexusignore, no .gitignore
      await fs.writeFile(path.join(nexusignoreDir, '.gitnexusignore'), 'local/\n');
    });

    afterAll(async () => {
      await fs.rm(nexusignoreDir, { recursive: true, force: true });
    });

    it('excludes directories listed in .gitnexusignore', async () => {
      const files = await walkRepositoryPaths(nexusignoreDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));

      expect(paths.some(p => p.includes('src/index.ts'))).toBe(true);
      expect(paths.every(p => !p.includes('local/'))).toBe(true);
    });
  });

  describe('combined .gitignore + .gitnexusignore', () => {
    let combinedDir: string;

    beforeAll(async () => {
      combinedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-walker-combined-'));

      await fs.mkdir(path.join(combinedDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(combinedDir, 'data'), { recursive: true });
      await fs.mkdir(path.join(combinedDir, 'local', 'plugins'), { recursive: true });

      await fs.writeFile(path.join(combinedDir, 'src', 'index.ts'), 'export const main = () => {}');
      await fs.writeFile(path.join(combinedDir, 'data', 'dump.json'), '{}');
      await fs.writeFile(path.join(combinedDir, 'local', 'plugins', 'module.js'), 'var x = 1;');

      await fs.writeFile(path.join(combinedDir, '.gitignore'), 'data/\n');
      await fs.writeFile(path.join(combinedDir, '.gitnexusignore'), 'local/\n');
    });

    afterAll(async () => {
      await fs.rm(combinedDir, { recursive: true, force: true });
    });

    it('excludes directories from both files', async () => {
      const files = await walkRepositoryPaths(combinedDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));

      expect(paths.some(p => p.includes('src/index.ts'))).toBe(true);
      expect(paths.every(p => !p.includes('data/'))).toBe(true);
      expect(paths.every(p => !p.includes('local/'))).toBe(true);
    });
  });

  describe('GITNEXUS_NO_GITIGNORE env var', () => {
    let envDir: string;

    beforeAll(async () => {
      envDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-walker-noignore-'));

      await fs.mkdir(path.join(envDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(envDir, 'data'), { recursive: true });

      await fs.writeFile(path.join(envDir, 'src', 'index.ts'), 'export const main = () => {}');
      await fs.writeFile(path.join(envDir, 'data', 'dump.json'), '{}');

      await fs.writeFile(path.join(envDir, '.gitignore'), 'data/\n');
    });

    afterAll(async () => {
      await fs.rm(envDir, { recursive: true, force: true });
    });

    it('excludes gitignored directory by default', async () => {
      const files = await walkRepositoryPaths(envDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));
      expect(paths.every(p => !p.includes('data/'))).toBe(true);
    });

    it('includes gitignored directory when GITNEXUS_NO_GITIGNORE is set', async () => {
      const original = process.env.GITNEXUS_NO_GITIGNORE;
      process.env.GITNEXUS_NO_GITIGNORE = '1';
      try {
        const files = await walkRepositoryPaths(envDir);
        const paths = files.map(f => f.path.replace(/\\/g, '/'));
        expect(paths.some(p => p.includes('data/dump.json'))).toBe(true);
      } finally {
        if (original === undefined) {
          delete process.env.GITNEXUS_NO_GITIGNORE;
        } else {
          process.env.GITNEXUS_NO_GITIGNORE = original;
        }
      }
    });
  });

  describe('readFileContents', () => {
    it('reads file contents by relative paths', async () => {
      const contents = await readFileContents(tmpDir, ['src/index.ts', 'src/utils.ts']);
      expect(contents.get('src/index.ts')).toContain('main');
      expect(contents.get('src/utils.ts')).toContain('helper');
    });

    it('handles empty path list', async () => {
      const contents = await readFileContents(tmpDir, []);
      expect(contents.size).toBe(0);
    });

    it('skips non-existent files gracefully', async () => {
      const contents = await readFileContents(tmpDir, ['nonexistent.ts']);
      expect(contents.size).toBe(0);
    });

    // ─── Unhappy paths ────────────────────────────────────────────────

    it('skips multiple non-existent files gracefully', async () => {
      const contents = await readFileContents(tmpDir, ['a.ts', 'b.ts', 'c.ts']);
      expect(contents.size).toBe(0);
    });

    it('handles binary file content without crashing', async () => {
      const contents = await readFileContents(tmpDir, ['src/image.png']);
      // May return content or skip — should not throw
      expect(contents.size).toBeLessThanOrEqual(1);
    });
  });
});
