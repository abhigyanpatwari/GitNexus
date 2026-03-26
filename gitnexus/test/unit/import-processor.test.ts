import { describe, it, expect, beforeEach } from 'vitest';
import { buildImportResolutionContext } from '../../src/core/ingestion/import-processor.js';
import type { ImportResolutionContext } from '../../src/core/ingestion/import-resolvers/types.js';
import { createResolutionContext } from '../../src/core/ingestion/resolution-context.js';

describe('ResolutionContext.importMap', () => {
  it('creates an empty Map', () => {
    const map = createResolutionContext().importMap;
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it('can be used to store import relationships', () => {
    const map = createResolutionContext().importMap;
    map.set('src/index.ts', new Set(['src/utils.ts', 'src/types.ts']));
    expect(map.get('src/index.ts')!.size).toBe(2);
    expect(map.get('src/index.ts')!.has('src/utils.ts')).toBe(true);
  });
});

describe('buildImportResolutionContext', () => {
  let ctx: ImportResolutionContext;
  const testPaths = [
    'src/index.ts',
    'src/utils.ts',
    'src/components/Button.tsx',
    'src/lib/helpers.ts',
  ];

  beforeEach(() => {
    ctx = buildImportResolutionContext(testPaths);
  });

  it('creates a Set of all file paths', () => {
    expect(ctx.allFilePaths).toBeInstanceOf(Set);
    expect(ctx.allFilePaths.size).toBe(4);
    expect(ctx.allFilePaths.has('src/index.ts')).toBe(true);
  });

  it('stores the original file list', () => {
    expect(ctx.allFileList).toBe(testPaths);
  });

  it('creates normalized file list with forward slashes', () => {
    const winPaths = ['src\\index.ts', 'src\\utils.ts'];
    const winCtx = buildImportResolutionContext(winPaths);
    expect(winCtx.normalizedFileList[0]).toBe('src/index.ts');
    expect(winCtx.normalizedFileList[1]).toBe('src/utils.ts');
  });

  it('creates a suffix index for O(1) lookups', () => {
    expect(ctx.index).toBeDefined();
    expect(typeof ctx.index.get).toBe('function');
  });

  it('initializes empty resolve cache', () => {
    expect(ctx.resolveCache).toBeInstanceOf(Map);
    expect(ctx.resolveCache.size).toBe(0);
  });

  it('handles empty paths array', () => {
    const emptyCtx = buildImportResolutionContext([]);
    expect(emptyCtx.allFilePaths.size).toBe(0);
    expect(emptyCtx.allFileList).toHaveLength(0);
  });

  describe('suffix index', () => {
    it('resolves file by suffix', () => {
      const result = ctx.index.get('utils.ts');
      expect(result).toBeDefined();
    });

    it('resolves file by full path', () => {
      const result = ctx.index.get('src/index.ts');
      expect(result).toBeDefined();
    });

    it('resolves nested component path', () => {
      const result = ctx.index.get('components/Button.tsx');
      expect(result).toBeDefined();
    });

    it('returns undefined for non-existent suffix', () => {
      const result = ctx.index.get('nonexistent.ts');
      expect(result).toBeUndefined();
    });
  });
});
