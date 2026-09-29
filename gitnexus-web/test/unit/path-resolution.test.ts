import { describe, expect, it } from 'vitest';
import {
  normalizePath,
  resolveFilePath,
  resolveUniqueIndexedPath,
} from '../../src/lib/path-resolution';

describe('path-resolution utilities', () => {
  const contents = new Map<string, string>([
    ['src/components/Header.tsx', ''],
    ['src/core/utils/index.ts', ''],
    ['README.md', ''],
    ['src/lib/path-resolution.ts', ''],
  ]);

  it('normalizes leading ./ and backslashes', () => {
    expect(normalizePath('./src\\components\\Header.tsx')).toBe('src/components/Header.tsx');
  });

  it('prefers exact matches', () => {
    expect(resolveFilePath(contents, 'src/components/Header.tsx')).toBe(
      'src/components/Header.tsx',
    );
  });

  it('resolves ends-with partials', () => {
    expect(resolveFilePath(contents, 'core/utils/index.ts')).toBe('src/core/utils/index.ts');
  });

  it('falls back to segment matching', () => {
    expect(resolveFilePath(contents, 'lib/path')).toBe('src/lib/path-resolution.ts');
  });

  it('returns null for empty requests', () => {
    expect(resolveFilePath(contents, '')).toBeNull();
  });
});

describe('resolveUniqueIndexedPath', () => {
  const index = new Map<string, string>([
    ['src/components/Header.tsx', 'src/components/Header.tsx'],
    ['src/index.ts', 'src/index.ts'],
    ['lib/index.ts', 'lib/index.ts'],
    ['packages/core/utils.ts', 'packages/core/utils.ts'],
  ]);

  it('prefers an exact indexed path', () => {
    expect(resolveUniqueIndexedPath(index, 'src/index.ts')).toBe('src/index.ts');
  });

  it('resolves a unique suffix', () => {
    expect(resolveUniqueIndexedPath(index, 'core/utils.ts')).toBe('packages/core/utils.ts');
  });

  it('resolves a unique filename only at a path-component boundary', () => {
    expect(resolveUniqueIndexedPath(index, 'Header.tsx')).toBe('src/components/Header.tsx');
  });

  it('does not treat a filename substring as a unique suffix', () => {
    const substringIndex = new Map<string, string>([['src/myindex.ts', 'src/myindex.ts']]);
    expect(resolveUniqueIndexedPath(substringIndex, 'index.ts')).toBeNull();
  });

  it('returns null when more than one file shares the suffix', () => {
    expect(resolveUniqueIndexedPath(index, 'index.ts')).toBeNull();
  });

  it('returns null for an empty request instead of matching every key', () => {
    expect(resolveUniqueIndexedPath(index, '')).toBeNull();
    expect(resolveUniqueIndexedPath(index, './')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(resolveUniqueIndexedPath(index, 'missing.ts')).toBeNull();
  });
});
