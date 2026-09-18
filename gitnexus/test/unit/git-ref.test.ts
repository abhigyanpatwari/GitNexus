import { describe, expect, it } from 'vitest';
import {
  InvalidBranchError,
  formatRejectedBranchForLog,
  sanitizeDetectedBranch,
  validateBranchName,
} from '../../src/core/git-ref.js';

describe('core/git-ref', () => {
  it('throws InvalidBranchError with name "InvalidBranchError"', () => {
    expect(() => validateBranchName('HEAD', 'src')).toThrow(InvalidBranchError);
    try {
      validateBranchName('HEAD', 'src');
      throw new Error('expected InvalidBranchError');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidBranchError);
      expect((err as Error).name).toBe('InvalidBranchError');
    }
  });

  it('sanitizeDetectedBranch returns the trimmed name for a legal branch', () => {
    expect(sanitizeDetectedBranch('develop')).toBe('develop');
    expect(sanitizeDetectedBranch('  feature/foo-bar  ')).toBe('feature/foo-bar');
  });

  it('sanitizeDetectedBranch returns undefined for null, empty, or whitespace', () => {
    expect(sanitizeDetectedBranch(null)).toBeUndefined();
    expect(sanitizeDetectedBranch(undefined)).toBeUndefined();
    expect(sanitizeDetectedBranch('')).toBeUndefined();
    expect(sanitizeDetectedBranch('   ')).toBeUndefined();
  });

  it('sanitizeDetectedBranch swallows InvalidBranchError and does not throw', () => {
    expect(sanitizeDetectedBranch('feat`x')).toBeUndefined();
    expect(sanitizeDetectedBranch('main`evil')).toBeUndefined();
    expect(sanitizeDetectedBranch('HEAD')).toBeUndefined();
    expect(() => sanitizeDetectedBranch('feat`x')).not.toThrow();
  });

  it('formatRejectedBranchForLog keeps backticks visible and escapes bidi, quotes, and line separators', () => {
    expect(formatRejectedBranchForLog('feat`x')).toBe('feat`x');
    expect(formatRejectedBranchForLog('a"b')).toBe('a\\"b');
    expect(formatRejectedBranchForLog(`ok${'\u202e'}bad`)).toBe('ok\\u202ebad');
    expect(formatRejectedBranchForLog(`zw${'\u200b'}sp`)).toBe('zw\\u200bsp');
    expect(formatRejectedBranchForLog(`foo${'\u2028'}bar`)).toBe('foo\\u2028bar');
    expect(formatRejectedBranchForLog(`foo${'\u2029'}bar`)).toBe('foo\\u2029bar');
  });

  it('formatRejectedBranchForLog escapes NBSP, NEL, and other C1 as \\uXXXX', () => {
    expect(formatRejectedBranchForLog(`foo${'\u00a0'}bar`)).toBe('foo\\u00a0bar');
    const nelBacktick = formatRejectedBranchForLog(`feat${'\u0085'}\``);
    expect(nelBacktick).toContain('\\u0085');
    expect(nelBacktick).toContain('`');
    expect(nelBacktick).not.toContain('\u0085');
    expect(formatRejectedBranchForLog(`x${'\u009f'}y`)).toBe('x\\u009fy');
  });

  it('sanitizeDetectedBranch rejects git-legal U+2028/U+2029 as whitespace', () => {
    expect(sanitizeDetectedBranch(`foo${'\u2028'}bar`)).toBeUndefined();
    expect(sanitizeDetectedBranch(`foo${'\u2029'}bar`)).toBeUndefined();
  });
});
