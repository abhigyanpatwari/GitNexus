import { describe, expect, it } from 'vitest';
import { validateAnalyzePath } from '../../src/server/api.js';

describe('analyze path validation', () => {
  it('accepts absolute paths with trailing separator', () => {
    expect(validateAnalyzePath('/home/user/project/')).toBeNull();
    expect(validateAnalyzePath('/home/user/project//')).toBeNull();
  });

  it('accepts normalized absolute paths', () => {
    expect(validateAnalyzePath('/home/user/project')).toBeNull();
  });

  it('rejects traversal segments from raw input', () => {
    expect(validateAnalyzePath('/tmp/project/../other')).toBe(
      '"path" must not contain traversal sequences',
    );
  });

  it('rejects relative paths', () => {
    expect(validateAnalyzePath('tmp/project')).toBe('"path" must be an absolute path');
  });

  it('accepts Windows drive roots', () => {
    expect(validateAnalyzePath('C:\\')).toBeNull();
  });
});
