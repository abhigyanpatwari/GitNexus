import { describe, expect, it } from 'vitest';
import { normalizePath, resolveFilePath } from '../../src/lib/path-resolution';

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
