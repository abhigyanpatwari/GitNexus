import { describe, it, expect } from 'vitest';
import type { FileHashDiff } from '../../src/storage/file-hash.js';
import {
  computeIncrementalWritableFiles,
  DEFAULT_MAX_IMPORTER_BFS_DEPTH,
} from '../../src/core/incremental/affected-files.js';

const diff = (partial: Partial<FileHashDiff>): FileHashDiff => ({
  changed: [],
  added: [],
  deleted: [],
  toWrite: [],
  ...partial,
});

const queryFrom =
  (imports: Readonly<Record<string, readonly string[]>>) =>
  async (targetFilePath: string): Promise<readonly string[]> =>
    imports[targetFilePath] ?? [];

describe('computeIncrementalWritableFiles', () => {
  it('starts with changed/added files as the writable set', async () => {
    const result = await computeIncrementalWritableFiles({
      hashDiff: diff({
        changed: ['src/a.ts'],
        added: ['src/b.ts'],
        toWrite: ['src/a.ts', 'src/b.ts'],
      }),
      priorFileSet: new Set(),
      queryImporters: queryFrom({}),
    });

    expect([...result.writableFiles].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.importerExpansionCount).toBe(0);
    expect(result.shadowSeeds).toEqual([]);
    expect(result.importerQueryFailures).toEqual([]);
  });

  it('adds direct and transitive previous-run importers through bounded BFS', async () => {
    const result = await computeIncrementalWritableFiles({
      hashDiff: diff({
        changed: ['src/leaf.ts'],
        toWrite: ['src/leaf.ts'],
      }),
      priorFileSet: new Set(['src/leaf.ts', 'src/mid.ts', 'src/root.ts']),
      queryImporters: queryFrom({
        'src/leaf.ts': ['src/mid.ts'],
        'src/mid.ts': ['src/root.ts'],
      }),
    });

    expect([...result.writableFiles].sort()).toEqual([
      'src/leaf.ts',
      'src/mid.ts',
      'src/root.ts',
    ]);
    expect(result.importerExpansionCount).toBe(2);
  });

  it('uses deleted files as importer-frontier seeds without adding them to writableFiles', async () => {
    const result = await computeIncrementalWritableFiles({
      hashDiff: diff({
        deleted: ['src/deleted.ts'],
      }),
      priorFileSet: new Set(['src/deleted.ts', 'src/importer.ts']),
      queryImporters: queryFrom({
        'src/deleted.ts': ['src/importer.ts'],
      }),
    });

    expect([...result.writableFiles]).toEqual(['src/importer.ts']);
    expect(result.importerExpansionCount).toBe(1);
  });

  it('seeds importer traversal with added-file shadow candidates from the prior file set', async () => {
    const result = await computeIncrementalWritableFiles({
      hashDiff: diff({
        added: ['src/foo.ts'],
        toWrite: ['src/foo.ts'],
      }),
      priorFileSet: new Set(['src/foo/index.ts', 'src/consumer.ts']),
      queryImporters: queryFrom({
        'src/foo/index.ts': ['src/consumer.ts'],
      }),
    });

    expect(result.shadowSeeds).toContain('src/foo/index.ts');
    expect([...result.writableFiles].sort()).toEqual(['src/consumer.ts', 'src/foo.ts']);
    expect(result.importerExpansionCount).toBe(1);
  });

  it('does not traverse beyond the configured importer depth', async () => {
    const result = await computeIncrementalWritableFiles({
      hashDiff: diff({
        changed: ['src/leaf.ts'],
        toWrite: ['src/leaf.ts'],
      }),
      priorFileSet: new Set(['src/leaf.ts', 'src/d1.ts', 'src/d2.ts']),
      queryImporters: queryFrom({
        'src/leaf.ts': ['src/d1.ts'],
        'src/d1.ts': ['src/d2.ts'],
      }),
      maxImporterDepth: 1,
    });

    expect([...result.writableFiles].sort()).toEqual(['src/d1.ts', 'src/leaf.ts']);
    expect(result.importerExpansionCount).toBe(1);
  });

  it('records importer query failures while preserving best-effort expansion', async () => {
    const result = await computeIncrementalWritableFiles({
      hashDiff: diff({
        changed: ['src/a.ts', 'src/b.ts'],
        toWrite: ['src/a.ts', 'src/b.ts'],
      }),
      priorFileSet: new Set(),
      queryImporters: async (targetFilePath) => {
        if (targetFilePath === 'src/a.ts') throw new Error('db unavailable for a');
        return ['src/b-importer.ts'];
      },
      maxImporterDepth: DEFAULT_MAX_IMPORTER_BFS_DEPTH,
    });

    expect(result.importerQueryFailures).toEqual(['src/a.ts']);
    expect([...result.writableFiles].sort()).toEqual([
      'src/a.ts',
      'src/b-importer.ts',
      'src/b.ts',
    ]);
    expect(result.importerExpansionCount).toBe(1);
  });
});
