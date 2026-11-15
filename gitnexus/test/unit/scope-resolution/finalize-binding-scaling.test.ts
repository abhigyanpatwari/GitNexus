import { describe, expect, it } from 'vitest';
import { finalize, type BindingRef, type FinalizeFile, type ScopeId } from 'gitnexus-shared';
import { dartScopeResolver } from '../../../src/core/ingestion/languages/dart/scope-resolver.js';
import { rubyScopeResolver } from '../../../src/core/ingestion/languages/ruby/scope-resolver.js';

describe('crowded-class binding materialization', () => {
  // The merge hook and its associativity opt-in are read from the provider the
  // pipeline runs, so a provider that stops opting in fails the count below.
  it.each([
    { language: 'dart', resolver: dartScopeResolver },
    { language: 'ruby', resolver: rubyScopeResolver },
  ])('merges each $language name once per scope', ({ resolver }) => {
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
      const merge = (
        existing: readonly BindingRef[],
        incoming: readonly BindingRef[],
        scopeId: ScopeId,
      ) => {
        visited += existing.length + incoming.length;
        return resolver.mergeBindings(existing, incoming, scopeId);
      };
      const result = finalize(
        { files: [file], workspaceIndex: undefined as never },
        {
          resolveImportTarget: () => null,
          expandsWildcardTo: () => [],
          mergeBindings: merge,
          mergeBindingsAreAssociative: resolver.mergeBindingsAreAssociative,
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
