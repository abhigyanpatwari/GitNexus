import { describe, expect, it } from 'vitest';
import { formatDetectChangesResult } from '../../src/cli/detect-changes-format.js';

describe('formatDetectChangesResult — zero-symbol honesty (#3131)', () => {
  it('prints backend summary.message instead of a generic all-clear', () => {
    const text = formatDetectChangesResult({
      summary: {
        changed_count: 0,
        affected_count: 0,
        changed_files: 0,
        risk_level: 'unknown',
        message: 'Could not parse the git diff output — no file headers recognised.',
      },
    });
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
  });

  it('keeps the clean-tree sentence only when git produced no files', () => {
    const text = formatDetectChangesResult({
      summary: { changed_count: 0, affected_count: 0, changed_files: 0, risk_level: 'none' },
    });
    expect(text).toBe('No changes detected.');
  });
});
