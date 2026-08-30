import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';

describe('nested repository boundaries and ignore files', () => {
  it('honors nested .gitignore rules and does not enter nested Git checkouts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gitnexus-nested-ignore-'));
    await mkdir(path.join(root, 'service'), { recursive: true });
    await writeFile(path.join(root, 'service', '.gitignore'), '*.generated.ts\n');
    await writeFile(path.join(root, 'service', 'keep.ts'), 'export const keep = 1;');
    await writeFile(path.join(root, 'service', 'skip.generated.ts'), 'generated');
    await mkdir(path.join(root, 'vendor', '.git'), { recursive: true });
    await writeFile(path.join(root, 'vendor', 'foreign.ts'), 'foreign');

    const entries = await walkRepositoryPaths(root);
    const paths = entries.map(({ path: filePath }) => filePath);

    expect(paths).toContain('service/keep.ts');
    expect(paths).not.toContain('service/skip.generated.ts');
    expect(paths).not.toContain('vendor/foreign.ts');
  });
});
