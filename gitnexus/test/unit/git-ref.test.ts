import { describe, expect, it } from 'vitest';
import { InvalidBranchError, validateBranchName } from '../../src/core/git-ref.js';

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
});
