import { describe, expect, it } from 'vitest';
import {
  InvalidBranchError,
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
});
