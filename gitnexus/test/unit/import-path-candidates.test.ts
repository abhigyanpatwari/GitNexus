import { describe, expect, it } from 'vitest';
import {
  buildSuffixIndex,
  suffixResolve,
  tryResolveWithExtensions,
} from '../../src/core/ingestion/utils/suffix-index.js';

describe('caller-owned import path candidates', () => {
  const files = ['pkg/item.alpha', 'pkg/item.beta'];
  const extensions = ['.beta', '.alpha'];

  it('uses the caller priority and refuses extensions the caller did not select', () => {
    const paths = new Set(files);
    expect(tryResolveWithExtensions('pkg/item', paths, extensions)).toBe('pkg/item.beta');
    expect(tryResolveWithExtensions('pkg/item', paths, ['.missing'])).toBeNull();
  });

  it.each(['indexed', 'linear'])('uses the same candidate policy for %s suffix lookup', (mode) => {
    const index = mode === 'indexed' ? buildSuffixIndex(files, files) : undefined;
    expect(suffixResolve(['item'], files, files, extensions, index)).toBe('pkg/item.beta');
    expect(suffixResolve(['item'], files, files, ['.missing'], index)).toBeNull();
  });
});
