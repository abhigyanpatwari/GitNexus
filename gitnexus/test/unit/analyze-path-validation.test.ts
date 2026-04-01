import path from 'path';
import { describe, expect, it } from 'vitest';

const hasTraversalSequence = (repoLocalPath: string): boolean => {
  const normalizedInput = path.normalize(repoLocalPath);
  const resolvedInput = path.resolve(repoLocalPath);
  const stripTrailingSeparator = (p: string): string => {
    if (p.length <= 1) return p;
    return p.replace(/[\\/]+$/, '');
  };

  return stripTrailingSeparator(normalizedInput) !== stripTrailingSeparator(resolvedInput);
};

describe('analyze path validation', () => {
  it('accepts absolute paths with trailing separator', () => {
    expect(hasTraversalSequence('/home/user/project/')).toBe(false);
    expect(hasTraversalSequence('/home/user/project//')).toBe(false);
  });

  it('accepts normalized absolute paths', () => {
    expect(hasTraversalSequence('/home/user/project')).toBe(false);
  });

  it('rejects traversal sequences', () => {
    expect(hasTraversalSequence('/tmp/project/../other')).toBe(true);
  });
});
