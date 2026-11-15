import { describe, expect, it } from 'vitest';
import { finalize, type BindingRef, type FinalizeFile } from 'gitnexus-shared';
import { dartMergeBindings } from '../../../src/core/ingestion/languages/dart/merge-bindings.js';
import { rubyMergeBindings } from '../../../src/core/ingestion/languages/ruby/merge-bindings.js';

describe('crowded-class binding materialization', () => {
  it.each(['dart', 'ruby'] as const)('merges each %s name once per scope', (language) => {
    for (const count of [16, 64, 256, 1024]) {
      const refs: BindingRef[] = Array.from({ length: count }, (_, i) => ({
        def: {
          nodeId: `method-${String(i).padStart(4, '0')}`,
          filePath: 'app',
          type: 'Method',
          name: 'run',
          qualifiedName: `C${i}.run`,
          ownerId: `class-${i}`,
        },
        origin: 'local',
      }));
      const file: FinalizeFile = {
        filePath: 'app',
        moduleScope: 'module',
        moduleBindings: new Map(),
        localDefs: refs.map((ref) => ref.def),
        parsedImports: [],
      };
      let visited = 0;
      const merge = (existing: readonly BindingRef[], incoming: readonly BindingRef[]) => {
        visited += existing.length + incoming.length;
        return language === 'dart'
          ? dartMergeBindings([...existing, ...incoming])
          : rubyMergeBindings(existing, incoming, 'module');
      };
      const result = finalize(
        { files: [file], workspaceIndex: undefined as never },
        {
          resolveImportTarget: () => null,
          expandsWildcardTo: () => [],
          mergeBindings: merge,
          mergeBindingsAreAssociative: true,
        },
      );
      expect(
        result.bindings
          .get('module')
          ?.get('run')
          ?.map((ref) => ref.def.nodeId),
      ).toEqual(refs.map((ref) => ref.def.nodeId));
      expect(visited).toBe(count);
    }
  });
});
