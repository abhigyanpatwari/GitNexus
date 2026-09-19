import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDetectChangesResult } from '../../src/cli/detect-changes-format.js';
import { setCliLanguage } from '../../src/cli/i18n/index.js';

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
