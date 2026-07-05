import { describe, expect, it } from 'vitest';
import { filterRepoFiles, MAX_FILE_BYTES } from './upload-filter';

type FileLike = { name: string; size: number; webkitRelativePath?: string };

function f(webkitRelativePath: string, size = 10): FileLike {
  const name = webkitRelativePath.split('/').pop() ?? webkitRelativePath;
  return { name, size, webkitRelativePath };
}

describe('filterRepoFiles', () => {
  it('keeps source files and builds an order-aligned manifest', () => {
    const input = [f('repo/src/index.ts', 100), f('repo/README.md', 50)];
    const r = filterRepoFiles(input);
    expect(r.files).toHaveLength(2);
    expect(r.manifest).toEqual(['repo/src/index.ts', 'repo/README.md']);
    expect(r.totalBytes).toBe(150);
    expect(r.droppedCount).toBe(0);
  });

  it('excludes .git / node_modules / build dirs anywhere in the path', () => {
    const input = [
      f('repo/.git/HEAD'),
      f('repo/node_modules/x/index.js'),
      f('repo/dist/bundle.js'),
      f('repo/src/app.ts'),
      f('repo/.gitnexus/meta.json'),
    ];
    const r = filterRepoFiles(input);
    expect(r.manifest).toEqual(['repo/src/app.ts']);
    expect(r.droppedCount).toBe(4);
  });

  it('drops files over the per-file size cap', () => {
    const input = [f('repo/big.bin', MAX_FILE_BYTES + 1), f('repo/small.ts', 10)];
    const r = filterRepoFiles(input);
    expect(r.manifest).toEqual(['repo/small.ts']);
    expect(r.droppedCount).toBe(1);
  });

  it('falls back to name when webkitRelativePath is absent', () => {
    const r = filterRepoFiles([{ name: 'lone.ts', size: 5 }]);
    expect(r.manifest).toEqual(['lone.ts']);
  });
});
