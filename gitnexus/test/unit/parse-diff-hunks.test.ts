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

  it('anchors a pure-deletion hunk (count=0) on the line the removed text followed', () => {
    // A unified diff spells an empty new range as the line BEFORE it: `+10,0`
    // means the removed text sat between new lines 10 and 11. Line 10 alone,
    // never the pair straddling the gap — a symbol that CONTAINED the deleted
    // text also contains 10, whereas extending to 11 would additionally claim a
    // symbol that merely STARTS after the gap, the widening `coalesceHunks`
    // guarantees never happens.
    //
    // Dropping the hunk left the file entry with no hunks, so `detect_changes`
    // contributed no bound for the path and a deletion-only commit reported
    // `{changed_count: 0, changed_files: 1, risk_level: 'low'}` — rendered as
    // "No changes detected." for a commit that deleted a function (#2915).
    const diff = ['+++ b/src/del.ts', '@@ -10,3 +10,0 @@ context'].join('\n');
    const result = parseDiffHunks(diff);
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toEqual([{ startLine: 10, endLine: 10 }]);
  });

  it('clamps a head-of-file deletion (+0,0) to line 1', () => {
    // git writes `+0,0` when the deletion takes the very first lines: there is
    // no "line before" to anchor on. Line numbers here are 1-based (#2377), so
    // an unclamped 0 would convert to the graph line -1 and match nothing.
    const diff = ['+++ b/src/head.ts', '@@ -1,2 +0,0 @@'].join('\n');
    const result = parseDiffHunks(diff);
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toEqual([{ startLine: 1, endLine: 1 }]);
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
