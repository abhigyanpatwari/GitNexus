import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countScanCandidates,
  walkRepositoryPaths,
} from '../../src/core/ingestion/filesystem-walker.js';

// #3524: refresh_index admits a rebuild from this count of the working tree,
// so it must see what analyze's scan sees, and stop once it passes the limit.

let root: string;

async function write(relativePath: string, content = 'export const x = 1;\n'): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

beforeEach(async () => {
  vi.stubEnv('GITNEXUS_INCLUDE_DOT_DIRS', undefined);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-scan-count-'));
  await write('src/a.ts');
  await write('src/b.ts');
  await write('README.md', '# readme\n');
  await write('.gitignore', 'generated/\n');
  await write('generated/out.ts');
  await write('node_modules/dep/index.js');
  await write('.hidden/c.ts');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('countScanCandidates', () => {
  it('counts the paths the scan walks, with its ignore rules', async () => {
    const scanned = await walkRepositoryPaths(root, undefined, { quiet: true });
    expect(scanned.map((file) => file.path).sort()).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
    await expect(countScanCandidates(root, 100)).resolves.toBe(scanned.length);
  });

  it('stops once the count passes the limit', async () => {
    await expect(countScanCandidates(root, 1)).resolves.toBe(2);
    await expect(countScanCandidates(root, 3)).resolves.toBe(3);
  });

  it('counts files the scan later drops for their size', async () => {
    await write('src/big.ts', 'x'.repeat(64));
    const scanned = await walkRepositoryPaths(root, undefined, {
      quiet: true,
      maxFileSizeBytes: 32,
    });
    expect(scanned.map((file) => file.path)).not.toContain('src/big.ts');
    await expect(countScanCandidates(root, 100)).resolves.toBe(scanned.length + 1);
  });

  it('rejects a path that is not a directory, like the scan', async () => {
    await expect(countScanCandidates(path.join(root, 'missing'), 10)).rejects.toThrow(
      /walkRepositoryPaths: path does not exist/,
    );
  });
});
