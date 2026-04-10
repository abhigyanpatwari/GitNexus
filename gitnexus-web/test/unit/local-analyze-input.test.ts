import { describe, expect, it } from 'vitest';
import { isValidLocalAnalyzePath } from '../../src/lib/local-analyze-input';

describe('isValidLocalAnalyzePath', () => {
  it('accepts Unix absolute paths', () => {
    expect(isValidLocalAnalyzePath('/mnt/projects/gitnexus')).toBe(true);
  });

  it('accepts Windows drive-letter paths', () => {
    expect(isValidLocalAnalyzePath('C:\\Users\\you\\project')).toBe(true);
    expect(isValidLocalAnalyzePath('D:/work/repo')).toBe(true);
  });

  it('accepts Windows UNC paths', () => {
    expect(isValidLocalAnalyzePath('\\\\server\\share\\repo')).toBe(true);
  });

  it('rejects relative or shell-expanded paths', () => {
    expect(isValidLocalAnalyzePath('project')).toBe(false);
    expect(isValidLocalAnalyzePath('./project')).toBe(false);
    expect(isValidLocalAnalyzePath('../project')).toBe(false);
    expect(isValidLocalAnalyzePath('~/project')).toBe(false);
  });
});
