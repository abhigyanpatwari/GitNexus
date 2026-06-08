import { describe, it, expect } from 'vitest';
import { generateId, normalizeFilePath } from '../../src/lib/utils.js';

describe('generateId', () => {
  it('creates id from label and name', () => {
    expect(generateId('Function', 'main')).toBe('Function:main');
  });

  it('handles labels with various node types', () => {
    expect(generateId('File', 'src/index.ts')).toBe('File:src/index.ts');
    expect(generateId('Class', 'UserService')).toBe('Class:UserService');
    expect(generateId('Method', 'getData')).toBe('Method:getData');
    expect(generateId('Folder', 'src')).toBe('Folder:src');
    expect(generateId('Interface', 'IUser')).toBe('Interface:IUser');
  });

  it('handles special characters in name', () => {
    expect(generateId('Function', 'path/to/file.ts:init')).toBe('Function:path/to/file.ts:init');
  });

  it('handles empty strings', () => {
    expect(generateId('', '')).toBe(':');
    expect(generateId('', 'name')).toBe(':name');
    expect(generateId('label', '')).toBe('label:');
  });

  it('handles relationship IDs', () => {
    expect(generateId('CONTAINS', 'Folder:src->File:src/index.ts')).toBe('CONTAINS:Folder:src->File:src/index.ts');
  });

  it('handles multi-language node types', () => {
    expect(generateId('Struct', 'Point')).toBe('Struct:Point');
    expect(generateId('Trait', 'Display')).toBe('Trait:Display');
    expect(generateId('Impl', 'Display for Point')).toBe('Impl:Display for Point');
    expect(generateId('Enum', 'Color')).toBe('Enum:Color');
    expect(generateId('Namespace', 'std')).toBe('Namespace:std');
    expect(generateId('Constructor', 'User')).toBe('Constructor:User');
  });
});

describe('normalizeFilePath', () => {
  // Backslashes → forward slashes
  it('converts backslashes to forward slashes', () => {
    expect(normalizeFilePath('src\\foo\\bar.ts')).toBe('src/foo/bar.ts');
  });

  it('converts mixed separators', () => {
    expect(normalizeFilePath('.\\src\\foo.ts')).toBe('src/foo.ts');
  });

  // Leading "./" stripped
  it('strips a single leading "./"', () => {
    expect(normalizeFilePath('./src/foo.ts')).toBe('src/foo.ts');
  });

  // Combined: "./src\foo.ts" → "src/foo.ts"
  it('strips leading "./" and converts backslashes together', () => {
    expect(normalizeFilePath('./src\\foo.ts')).toBe('src/foo.ts');
  });

  // Idempotent: already-relative unchanged
  it('returns an already-normalized relative path unchanged', () => {
    expect(normalizeFilePath('src/a.ts')).toBe('src/a.ts');
  });

  it('is idempotent when applied twice', () => {
    const once = normalizeFilePath('.\\src\\foo.ts');
    const twice = normalizeFilePath(once);
    expect(twice).toBe(once);
  });

  // Boundaries — no crash
  it('returns empty string unchanged for empty input', () => {
    expect(normalizeFilePath('')).toBe('');
  });

  it('returns empty string for "./"', () => {
    expect(normalizeFilePath('./')).toBe('');
  });

  // Windows-style absolute: "C:\..\a.ts" → "C:/../a.ts"
  it('normalizes Windows-style absolute paths (interior "../" preserved)', () => {
    expect(normalizeFilePath('C:\\..\\a.ts')).toBe('C:/../a.ts');
  });

  // Interior "./" preserved: "./a/./b.ts" → "a/./b.ts"
  it('preserves interior "./" segments (only leading is stripped)', () => {
    expect(normalizeFilePath('./a/./b.ts')).toBe('a/./b.ts');
  });

  // Backslash + interior "./" combined: ".\a\.\b.ts" → "a/./b.ts"
  it('preserves interior "./" while converting backslashes', () => {
    expect(normalizeFilePath('.\\a\\.\\b.ts')).toBe('a/./b.ts');
  });

  // callsite-parity — Invariant #6: byte-identical to the prior inline form
  // (local-backend.ts rename text-search path: file.replace(/\\/g,'/').replace(/^\.\//,''))
  it('produces byte-identical output to the prior inline rename form (Invariant #6)', () => {
    const priorInline = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
    const fixtures: string[] = [
      './src\\foo.ts',
      'src\\a\\b.ts',
      './a/./b.ts',
      'C:\\..\\a.ts',
      'src/a.ts',
    ];
    for (const input of fixtures) {
      expect(normalizeFilePath(input)).toBe(priorInline(input));
    }
  });
});
