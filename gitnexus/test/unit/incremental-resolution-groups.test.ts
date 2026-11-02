import { describe, expect, it } from 'vitest';
import { collectResolutionGroupFiles } from '../../src/core/incremental/resolution-groups.js';

describe('incremental resolution groups', () => {
  const files = [
    'pkg/value_linux.go',
    'pkg/method.go',
    'pkg/internal_test.go',
    'pkg/external_test.go',
    'pkg/other.ts',
    'pkg/sub/value.go',
    'elsewhere/value.go',
  ];

  it('includes current package siblings when the changed path was deleted', () => {
    expect(collectResolutionGroupFiles(['pkg/value_windows.go'], files)).toEqual(
      new Set(files.slice(0, 4)),
    );
  });

  it('groups added and edited members without crossing directories or languages', () => {
    const changed = ['pkg/value_linux.go', 'pkg/method.go', 'pkg/new.go', 'elsewhere/value.go'];
    expect(collectResolutionGroupFiles(changed, [...files, 'pkg/new.go'])).toEqual(
      new Set([...files.slice(0, 4), 'pkg/new.go', 'elsewhere/value.go']),
    );
  });

  it('does not expand files whose provider has no resolution grouping hook', () => {
    expect(collectResolutionGroupFiles(['pkg/other.ts', 'pkg/README.md'], files)).toEqual(
      new Set(),
    );
    expect(collectResolutionGroupFiles([], files)).toEqual(new Set());
  });

  it('supports root packages and normalized directory keys for Windows paths', () => {
    expect(collectResolutionGroupFiles(['removed.go'], ['method.go', 'sub/method.go'])).toEqual(
      new Set(['method.go']),
    );
    expect(collectResolutionGroupFiles(['pkg\\removed.go'], files)).toEqual(
      new Set(files.slice(0, 4)),
    );
  });
});
