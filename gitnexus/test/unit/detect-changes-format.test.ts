import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDetectChangesResult } from '../../src/cli/detect-changes-format.js';
import { setCliLanguage } from '../../src/cli/i18n/index.js';
import { parseDiffHunks } from '../../src/storage/git.js';

describe('formatDetectChangesResult — zero-symbol honesty (#3131)', () => {
  beforeEach(() => {
    setCliLanguage('en');
  });

  afterEach(() => {
    setCliLanguage(null);
  });

  it('prints backend parse-fail message instead of a generic all-clear', () => {
    const text = formatDetectChangesResult({
      partial: true,
      summary: {
        changed_count: 0,
        affected_count: 0,
        risk_level: 'unknown',
        message: 'Could not parse the git diff output — no file headers recognised.',
      },
    });
    expect(text).toContain('PARTIAL RESULT');
    expect(text).toContain('Could not parse the git diff output');
    expect(text).not.toContain('No changes detected.');
  });

  it('does not call a parsed diff with no symbol overlap a clean tree', () => {
    const text = formatDetectChangesResult({
      summary: {
        changed_count: 0,
        affected_count: 0,
        changed_files: 1,
        risk_level: 'low',
      },
    });
    expect(text).toMatch(/Diff touched 1 file/);
    expect(text).not.toContain('No changes detected.');
    expect(text).not.toContain('PARTIAL RESULT');
  });

  it('does not claim no-overlap when a degraded query left changed_count at zero', () => {
    const text = formatDetectChangesResult({
      partial: true,
      summary: {
        changed_count: 0,
        affected_count: 0,
        changed_files: 1,
        risk_level: 'unknown',
      },
    });
    expect(text).toContain('PARTIAL RESULT');
    expect(text).not.toMatch(/no indexed symbols overlap/i);
    expect(text).not.toContain('No changes detected.');
  });

  it('keeps the clean-tree sentence only when git produced no files', () => {
    const text = formatDetectChangesResult({
      summary: { changed_count: 0, affected_count: 0, changed_files: 0, risk_level: 'none' },
    });
    expect(text).toBe('No changes detected.');
  });

  it('explains unmapped source files without claiming a query failed or retry will repair the index', () => {
    const text = formatDetectChangesResult({
      partial: true,
      unmapped_files: ['src/index-lock.ts'],
      summary: { changed_count: 0, affected_count: 0, changed_files: 1, risk_level: 'unknown' },
    });
    expect(text).toContain('PARTIAL RESULT');
    expect(text).toContain('src/index-lock.ts');
    expect(text).toMatch(/rebuild/i);
    expect(text).not.toMatch(/queries failed|No changes detected|no indexed symbols overlap/i);
  });

  it('escapes Git-decoded terminal controls while leaving structured paths intact', () => {
    const diff = [
      'diff --git "a/evil\\033]52;c;VEVTVA==\\007.ts" "b/evil\\033]52;c;VEVTVA==\\007.ts"',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    const paths = parseDiffHunks(diff).map((file) => file.filePath);
    expect(paths[0]).toContain('\u001b');
    const text = formatDetectChangesResult({
      partial: true,
      unmapped_files: paths,
      summary: { changed_count: 0, changed_files: 1, risk_level: 'unknown' },
    });
    expect(text).toContain('\\u001b]52;c;VEVTVA==\\u0007.ts');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(paths[0]).toContain('\u0007');
  });

  it('leads a populated summary with the incomplete source-mapping explanation', () => {
    const text = formatDetectChangesResult({
      partial: true,
      unmapped_files: ['other.ts'],
      summary: { changed_count: 1, changed_files: 2, affected_count: 0, risk_level: 'unknown' },
      changed_symbols: [{ type: 'Function', name: 'known', filePath: 'code.py' }],
    });
    expect(text.indexOf('other.ts')).toBeLessThan(text.indexOf('Changes:'));
    expect(text).toContain('known');
    expect(text).toContain('unknown');
  });

  it('localizes the production clean-tree payload that carries English summary.message', () => {
    setCliLanguage('zh-CN');
    const text = formatDetectChangesResult({
      summary: {
        changed_count: 0,
        affected_count: 0,
        risk_level: 'none',
        message: 'No changes detected.',
      },
    });
    expect(text).toBe('未检测到变更。');
  });

  it('localizes confirmed no-overlap under GITNEXUS_LANG=zh-CN', () => {
    setCliLanguage('zh-CN');
    const text = formatDetectChangesResult({
      summary: {
        changed_count: 0,
        affected_count: 0,
        changed_files: 1,
        risk_level: 'low',
      },
    });
    expect(text).toContain('diff 触及 1 个文件');
    expect(text).not.toContain('未检测到变更。');
    expect(text).not.toContain('No changes detected.');
  });
});
