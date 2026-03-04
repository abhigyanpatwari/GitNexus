import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
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
    await fs.mkdir(path.join(tmpDir, 'generated'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export const main = () => {}');
    await fs.writeFile(path.join(tmpDir, 'src', 'utils.ts'), 'export const helper = () => {}');
    await fs.writeFile(path.join(tmpDir, 'src', 'components', 'Button.tsx'), 'export const Button = () => <div/>');
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'lodash', 'index.js'), 'module.exports = {}');
    await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'generated/\n');
    await fs.writeFile(path.join(tmpDir, 'generated', 'snapshot.ts'), 'export const generated = true;');
    await fs.writeFile(path.join(tmpDir, 'src', 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));

    // Initialize git so git check-ignore can evaluate .gitignore rules.
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
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

    it('skips gitignored paths', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map(f => f.path.replace(/\\/g, '/'));
      expect(paths.every(p => !p.includes('generated/snapshot.ts'))).toBe(true);
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
  });
});
