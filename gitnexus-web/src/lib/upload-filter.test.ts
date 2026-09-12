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

  it('excludes emitted _next output, including the Capacitor/Cordova copy', () => {
    // `.next` was listed but `_next` was not, so a mobile-wrapped Next.js app
    // uploaded its whole minified bundle against the server's caps for files
    // the analyzer then discards anyway (#3007).
    const input = [
      f('repo/android/app/src/main/assets/public/_next/static/chunks/main.js'),
      f('repo/ios/App/App/public/_next/static/chunks/framework.js'),
      f('repo/_next/static/chunks/x.js'),
      f('repo/src/index.ts'),
      f('repo/src/_nextgen/index.ts'),
    ];
    const r = filterRepoFiles(input);
    expect(r.manifest).toEqual(['repo/src/index.ts', 'repo/src/_nextgen/index.ts']);
    expect(r.droppedCount).toBe(3);
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
