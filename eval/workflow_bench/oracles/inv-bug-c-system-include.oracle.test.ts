import { describe, expect, it } from 'vitest';
import { cScopeResolver } from '../gitnexus/src/core/ingestion/languages/c/scope-resolver.js';

describe('hidden oracle: C system headers do not bind to repository decoys', () => {
  it.each([
    ['stdio.h', true, null],
    ['project.h', true, null],
    ['stdio.h', false, 'src/stdio.h'],
    ['util.h', false, 'include/util.h'],
  ] as const)(
    'resolves %s with isSystem=%s from its include form',
    (targetRaw, isSystem, expected) => {
      const files = new Set(['src/stdio.h', 'include/project.h', 'include/util.h', 'src/main.c']);
      const parsedImport = { kind: 'wildcard' as const, targetRaw, isSystem };

      // Both spellings name stdio.h. Preserve the parsed include form;
      // refusing every header by name would break the quoted local include.
      const resolved = cScopeResolver.resolveImportTarget(
        parsedImport.targetRaw,
        'src/main.c',
        files,
        undefined,
        { parsedFiles: [], parsedImport },
      );
      expect(resolved).toBe(expected);
    },
  );
});
