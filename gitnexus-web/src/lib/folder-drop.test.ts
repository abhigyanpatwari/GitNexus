import { describe, expect, it, vi } from 'vitest';
import {
  collectDropEntries,
  readDroppedFolder,
  DropRejection,
  MAX_DROP_FILES,
  MAX_PATH_SEGMENTS,
} from './folder-drop';
import { filterRepoFiles, MAX_FILE_BYTES } from './upload-filter';

// jsdom has no File and Directory Entries API, so the fixtures are plain
// objects with the members the walk uses: isFile/isDirectory/name,
// createReader().readEntries(ok, err) and file(ok, err).

function fileEntry(name: string, size = 1): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/browser-root/${name}`,
    file: (ok: (f: File) => void) => ok(new File([new Uint8Array(size)], name)),
  } as unknown as FileSystemFileEntry;
}

type DirFixture = FileSystemDirectoryEntry & { reads: number; readerCreated: number };

/** Directory whose reader hands `children` out in `batchSize` chunks, then `[]`. */
function dirEntry(name: string, children: FileSystemEntry[], batchSize = 100): DirFixture {
  const dir = {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/browser-root/${name}`,
    reads: 0,
    readerCreated: 0,
    createReader: () => {
      dir.readerCreated++;
      let i = 0;
      return {
        readEntries: (ok: (entries: FileSystemEntry[]) => void) => {
          dir.reads++;
          const batch = children.slice(i, i + batchSize);
          i += batch.length;
          ok(batch);
        },
      };
    },
  };
  return dir as unknown as DirFixture;
}

/** Directory whose reader fails, like a subtree the browser may not read. */
function unreadableDir(name: string): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/browser-root/${name}`,
    createReader: () => ({
      readEntries: (_ok: unknown, err: (e: Error) => void) => err(new Error('EACCES')),
    }),
  } as unknown as FileSystemDirectoryEntry;
}

function dataTransfer(entries: (FileSystemEntry | null)[], supported = true): DataTransfer {
  const items = entries.map((e) => (supported ? { webkitGetAsEntry: () => e } : {}));
  return { items, types: ['Files'], files: [] } as unknown as DataTransfer;
}

const paths = (files: File[]) => files.map((f) => f.webkitRelativePath);

describe('collectDropEntries', () => {
  it('returns the entries synchronously and skips null (non-file) items', () => {
    const dir = dirEntry('repo', []);
    const entries = collectDropEntries(dataTransfer([dir, null]));
    expect(entries).toEqual([dir]);
  });

  it('returns nothing for an empty transfer', () => {
    expect(collectDropEntries({ items: [] } as unknown as DataTransfer)).toEqual([]);
  });

  it('rejects a browser without webkitGetAsEntry', () => {
    let caught: unknown;
    try {
      collectDropEntries(dataTransfer([dirEntry('repo', [])], false));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DropRejection);
    expect((caught as DropRejection).reason).toBe('unsupported');
  });
});

describe('readDroppedFolder', () => {
  it('builds <folder>/<rest> paths with forward slashes from entry names', async () => {
    const root = dirEntry('repo', [
      fileEntry('README.md'),
      dirEntry('src', [fileEntry('a.ts'), dirEntry('deep', [fileEntry('b.ts')])]),
    ]);
    const { files, skipped } = await readDroppedFolder([root]);
    expect(paths(files)).toEqual(['repo/README.md', 'repo/src/a.ts', 'repo/src/deep/b.ts']);
    expect(files.every((f) => f instanceof File)).toBe(true);
    expect(skipped).toBe(0);
  });

  it('loops readEntries until an empty batch', async () => {
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`f${i}.ts`));
    const root = dirEntry('repo', children, 100);
    const { files } = await readDroppedFolder([root]);
    expect(files).toHaveLength(250);
    // two full 100-entry batches, one 50-entry batch, then the empty read
    expect(root.reads).toBe(4);
  });

  it('prunes excluded directories before reading them and counts them', async () => {
    const nodeModules = dirEntry('node_modules', [fileEntry('x.js')]);
    const git = dirEntry('.git', [fileEntry('HEAD')]);
    const root = dirEntry('repo', [nodeModules, git, dirEntry('src', [fileEntry('a.ts')])]);
    const { files, skipped } = await readDroppedFolder([root]);
    expect(paths(files)).toEqual(['repo/src/a.ts']);
    expect(skipped).toBe(2);
    expect(nodeModules.readerCreated).toBe(0);
    expect(git.readerCreated).toBe(0);
  });

  it('rejects a loose file', async () => {
    await expect(readDroppedFolder([fileEntry('a.ts')])).rejects.toMatchObject({
      name: 'DropRejection',
      reason: 'notSingleFolder',
    });
  });

  it('rejects several roots', async () => {
    await expect(
      readDroppedFolder([dirEntry('a', [fileEntry('x')]), dirEntry('b', [fileEntry('y')])]),
    ).rejects.toMatchObject({ reason: 'notSingleFolder' });
  });

  it('rejects an empty drop', async () => {
    await expect(readDroppedFolder([])).rejects.toMatchObject({ reason: 'notSingleFolder' });
  });

  it('stops past MAX_DROP_FILES', async () => {
    const children = Array.from({ length: MAX_DROP_FILES + 1 }, (_, i) => fileEntry(`f${i}`));
    await expect(readDroppedFolder([dirEntry('repo', children)])).rejects.toMatchObject({
      reason: 'tooManyFiles',
      max: MAX_DROP_FILES,
    });
  });

  it('does not count oversized files toward MAX_DROP_FILES', async () => {
    const oversized = fileEntry('big.bin', MAX_FILE_BYTES + 1);
    const keepers = Array.from({ length: MAX_DROP_FILES }, (_, i) => fileEntry(`f${i}`));
    const { files, oversized: oversizedCount } = await readDroppedFolder([
      dirEntry('repo', [oversized, ...keepers]),
    ]);
    expect(files).toHaveLength(MAX_DROP_FILES);
    expect(paths(files)).not.toContain('repo/big.bin');
    expect(oversizedCount).toBe(1);
  });

  it('skips oversized files before they reach filterRepoFiles', async () => {
    const { files, skipped, oversized } = await readDroppedFolder([
      dirEntry('repo', [fileEntry('a.ts'), fileEntry('big.bin', MAX_FILE_BYTES + 1)]),
    ]);
    expect(paths(files)).toEqual(['repo/a.ts']);
    expect(skipped).toBe(0);
    expect(oversized).toBe(1);
  });

  it('aborts mid-walk and does not read later siblings', async () => {
    const controller = new AbortController();
    const later = dirEntry('later', [fileEntry('z.ts')]);
    const root = dirEntry('repo', [
      dirEntry(
        'first',
        Array.from({ length: 60 }, (_, i) => fileEntry(`f${i}`)),
      ),
      later,
    ]);
    const promise = readDroppedFolder([root], {
      signal: controller.signal,
      // progress is reported every 50 files; abort on the first report
      onProgress: () => controller.abort(),
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(later.readerCreated).toBe(0);
  });

  it('rejects when the abort lands during the last file read', async () => {
    const controller = new AbortController();
    const last = {
      isFile: true,
      isDirectory: false,
      name: 'last.ts',
      fullPath: '/browser-root/last.ts',
      file: (ok: (f: File) => void) => {
        controller.abort();
        ok(new File(['x'], 'last.ts'));
      },
    } as unknown as FileSystemFileEntry;
    const onProgress = vi.fn();
    await expect(
      readDroppedFolder([dirEntry('repo', [fileEntry('a.ts'), last])], {
        signal: controller.signal,
        onProgress,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('skips an unreadable subtree and keeps the rest', async () => {
    const root = dirEntry('repo', [unreadableDir('locked'), dirEntry('src', [fileEntry('a.ts')])]);
    const { files, skipped } = await readDroppedFolder([root]);
    expect(paths(files)).toEqual(['repo/src/a.ts']);
    expect(skipped).toBe(1);
  });

  it('skips a file whose file() call fails and keeps the rest', async () => {
    const broken = {
      isFile: true,
      isDirectory: false,
      name: 'dangling-symlink',
      fullPath: '/browser-root/dangling-symlink',
      file: (_ok: unknown, err: (e: Error) => void) =>
        err(new DOMException('not found', 'NotFoundError')),
    } as unknown as FileSystemFileEntry;
    const root = dirEntry('repo', [fileEntry('a.ts'), broken, fileEntry('b.ts')]);
    const { files, skipped } = await readDroppedFolder([root]);
    expect(paths(files)).toEqual(['repo/a.ts', 'repo/b.ts']);
    expect(skipped).toBe(1);
  });

  it('answers a folder named like build output without walking it', async () => {
    const root = dirEntry('dist', [fileEntry('bundle.js')]);
    const { files, skipped } = await readDroppedFolder([root]);
    expect(files).toEqual([]);
    expect(skipped).toBe(1);
    expect(root.readerCreated).toBe(0);
  });

  it('skips files that would exceed the server path depth', async () => {
    // A file directly inside a directory at depth d has d + 1 segments.
    const build = (depth: number, leaf: string): FileSystemEntry => {
      let entry: FileSystemEntry = fileEntry(leaf);
      for (let i = depth; i >= 2; i--) entry = dirEntry(`d${i}`, [entry]);
      return entry;
    };
    // root (1) + 62 dirs = 63 segments, leaf makes 64: allowed
    const okChain = build(63, 'ok.ts');
    // root (1) + 63 dirs = 64 segments, leaf would make 65: skipped
    const tooDeep = build(64, 'deep.ts');
    const root = dirEntry('repo', [okChain, tooDeep]);
    const { files, skipped } = await readDroppedFolder([root]);
    expect(skipped).toBe(1);
    const rels = paths(files);
    expect(rels).toHaveLength(1);
    const [only] = rels;
    expect(only?.endsWith('/ok.ts')).toBe(true);
    expect(only?.split('/')).toHaveLength(MAX_PATH_SEGMENTS);
  });

  it('reports progress every 50 files and once at the end', async () => {
    const onProgress = vi.fn();
    const children = Array.from({ length: 120 }, (_, i) => fileEntry(`f${i}`));
    await readDroppedFolder([dirEntry('repo', children)], { onProgress });
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([50, 100, 120]);
  });

  it('produces files that filterRepoFiles turns into an aligned manifest', async () => {
    const root = dirEntry('repo', [
      fileEntry('a.ts'),
      fileEntry('big.bin', MAX_FILE_BYTES + 1),
      dirEntry('src', [fileEntry('b.ts')]),
    ]);
    const { files } = await readDroppedFolder([root]);
    const result = filterRepoFiles(files);
    expect(result.manifest).toEqual(['repo/a.ts', 'repo/src/b.ts']);
    expect(result.droppedCount).toBe(0);
    result.files.forEach((f, i) => expect(f.webkitRelativePath).toBe(result.manifest[i]));
  });
});
