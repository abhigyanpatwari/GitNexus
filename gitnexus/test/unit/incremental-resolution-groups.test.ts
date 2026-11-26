import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectResolutionGroupFiles,
  hasResolutionGroups,
} from '../../src/core/incremental/resolution-groups.js';

afterEach(() => vi.unstubAllEnvs());

describe('incremental resolution groups', () => {
  it('refreshes Java across directories when an unmentioned package type changes or is deleted', () => {
    const javaFiles = ['models/Foo.java', 'generated/Mid.java', 'app/A.java'];
    const mixed = [...javaFiles, 'models/Other.kt', 'models/Other.ts'];
    for (const changed of ['generated/Mid.java', 'removed/Base.java', 'New.java']) {
      expect(collectResolutionGroupFiles([changed], mixed)).toEqual(new Set(javaFiles));
    }
  });

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

  it.each([
    ['a Java file', ['web/app.ts', 'models/Foo.java'], true],
    ['a Go file', ['pkg/method.go'], true],
    ['only languages without a group', ['web/app.ts', 'models/Other.kt', 'README.md'], false],
    ['no files', [], false],
  ])('reports whether a repository with %s has a resolution group', (_label, paths, expected) => {
    expect(hasResolutionGroups(paths)).toBe(expected);
  });
});

describe('property-dispatch budget invalidation', () => {
  it.each(['added.ts', 'removed.js', 'pkg/deleted.go', 'views/deleted.vue'])(
    'checks current source rows after a change to %s when the budget is enabled',
    async (changed) => {
      vi.resetModules();
      vi.stubEnv('GITNEXUS_MAX_PROPERTY_DISPATCH_EDGES_PER_KEY', '5');
      const { collectResolutionGroupFiles, hasResolutionGroups } =
        await import('../../src/core/incremental/resolution-groups.js');
      const sources = ['left.ts', 'right.js', 'view.vue', 'pkg/model.go', 'Model.java'];
      expect(collectResolutionGroupFiles([changed], [...sources, 'README.md'])).toEqual(
        new Set(sources),
      );
      expect(collectResolutionGroupFiles([], sources)).toEqual(new Set());
      expect(collectResolutionGroupFiles(['README.md'], sources)).toEqual(new Set());
      expect(hasResolutionGroups(['left.ts'])).toBe(true);
      expect(hasResolutionGroups(['README.md'])).toBe(false);
    },
  );
});
