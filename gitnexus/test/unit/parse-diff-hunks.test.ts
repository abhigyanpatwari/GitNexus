import { describe, it, expect } from 'vitest';
import { parseDiffHunks } from '../../src/storage/git.js';

describe('parseDiffHunks', () => {
  it('parses a single file with one hunk', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,0 +11,3 @@ some context',
      '+line1',
      '+line2',
      '+line3',
    ].join('\n');
    const result = parseDiffHunks(diff);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('src/foo.ts');
    expect(result[0].hunks).toEqual([{ startLine: 11, endLine: 13 }]);
  });

  it('parses multiple hunks in a single file', () => {
    const diff = [
      'diff --git a/src/bar.ts b/src/bar.ts',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -5,2 +5,4 @@ context',
      ' unchanged',
      '+added',
      '@@ -20,0 +22,1 @@ more context',
      '+another line',
    ].join('\n');
    const result = parseDiffHunks(diff);
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toHaveLength(2);
    expect(result[0].hunks[0]).toEqual({ startLine: 5, endLine: 8 });
    expect(result[0].hunks[1]).toEqual({ startLine: 22, endLine: 22 });
  });

  it('parses multiple files', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +1,2 @@',
      '+line',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -10,3 +10,5 @@',
      ' ctx',
    ].join('\n');
    const result = parseDiffHunks(diff);
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe('a.ts');
    expect(result[0].hunks).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(result[1].filePath).toBe('b.ts');
    expect(result[1].hunks).toEqual([{ startLine: 10, endLine: 14 }]);
  });

  it('handles single-line hunks without count', () => {
    // When count is omitted from @@ header, it defaults to 1
    const diff = ['+++ b/src/single.ts', '@@ -5,0 +6 @@ context', '+one line'].join('\n');
    const result = parseDiffHunks(diff);
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toEqual([{ startLine: 6, endLine: 6 }]);
  });

  it('skips pure-deletion hunks (count=0)', () => {
    const diff = ['+++ b/src/del.ts', '@@ -10,3 +10,0 @@ context'].join('\n');
    const result = parseDiffHunks(diff);
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toHaveLength(0);
  });

  it('returns empty array for empty diff output', () => {
    expect(parseDiffHunks('')).toEqual([]);
  });

  it('returns empty array for diff with no file headers', () => {
    expect(parseDiffHunks('nothing useful here\n')).toEqual([]);
  });

  it('assigns hunks to the correct file when files are interleaved', () => {
    // Realistic multi-file diff with context lines between
    const diff = [
      'diff --git a/src/alpha.ts b/src/alpha.ts',
      'index abc..def 100644',
      '--- a/src/alpha.ts',
      '+++ b/src/alpha.ts',
      '@@ -100,0 +101,2 @@ export function alpha() {',
      '+  const x = 1;',
      '+  return x;',
      'diff --git a/src/beta.ts b/src/beta.ts',
      'index 111..222 100644',
      '--- a/src/beta.ts',
      '+++ b/src/beta.ts',
      '@@ -50,0 +51,1 @@ export class Beta {',
      '+  private val = 0;',
      '@@ -80,0 +82,3 @@ export class Beta {',
      '+  doStuff() {',
      '+    return this.val;',
      '+  }',
    ].join('\n');
    const result = parseDiffHunks(diff);
    expect(result).toHaveLength(2);

    expect(result[0].filePath).toBe('src/alpha.ts');
    expect(result[0].hunks).toEqual([{ startLine: 101, endLine: 102 }]);

    expect(result[1].filePath).toBe('src/beta.ts');
    expect(result[1].hunks).toHaveLength(2);
    expect(result[1].hunks[0]).toEqual({ startLine: 51, endLine: 51 });
    expect(result[1].hunks[1]).toEqual({ startLine: 82, endLine: 84 });
  });
});
