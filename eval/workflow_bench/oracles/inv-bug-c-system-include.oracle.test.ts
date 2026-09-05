import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

import { SCOPE_RESOLVERS } from '../gitnexus/src/core/ingestion/scope-resolution/pipeline/registry.js';

describe('hidden oracle: C system headers do not bind to repository decoys', () => {
  it('rejects a stdio.h decoy while preserving local-header resolution', () => {
    const resolver = SCOPE_RESOLVERS.get(SupportedLanguages.C);
    expect(resolver).toBeDefined();
    const files = new Set(['src/stdio.h', 'include/util.h', 'src/main.c']);
    const context = { parsedFiles: [] };

    const external = resolver!.resolveImportTarget(
      'stdio.h',
      'src/main.c',
      files,
      undefined,
      context,
    );
    const local = resolver!.resolveImportTarget('util.h', 'src/main.c', files, undefined, context);

    expect(external).toBeNull();
    expect(local).toBe('include/util.h');
  });
});
