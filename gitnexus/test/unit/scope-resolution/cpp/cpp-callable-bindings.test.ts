import { describe, expect, it } from 'vitest';
import type { BindingRef, Scope, SymbolDefinition } from 'gitnexus-shared';
import { cppScopeResolver } from '../../../../src/core/ingestion/languages/cpp/scope-resolver.js';
import { lookupNameClaim } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';

const at = (line: number) => ({ startLine: line, startCol: 0, endLine: line, endCol: 20 });
const definition = (filePath: string, parameter: string): SymbolDefinition => ({
  nodeId: `def:${filePath}#1:0:Function:choose`,
  filePath,
  type: 'Function',
  qualifiedName: 'choose',
  parameterCount: 1,
  parameterTypes: [parameter],
});
const included = (def: SymbolDefinition): BindingRef => ({
  def,
  origin: 'import',
  via: {
    kind: 'wildcard-expanded',
    localName: 'choose',
    targetFile: def.filePath,
    targetExportedName: 'choose',
    targetDefId: def.nodeId,
  },
});
function scope(id: string, extra: Partial<Scope> = {}): Scope {
  return {
    id,
    parent: null,
    kind: 'Module',
    filePath: 'main.cpp',
    range: at(1),
    bindings: new Map(),
    imports: [],
    ownedDefs: [],
    typeBindings: new Map(),
    ...extra,
  };
}
function indexes(
  scopes: readonly Scope[],
  finalized: readonly BindingRef[],
): ScopeResolutionIndexes {
  const byId = new Map(scopes.map((item) => [item.id, item]));
  return {
    scopeTree: { byId, getScope: (id: string) => byId.get(id) },
    bindings: new Map([['module', new Map([['choose', finalized]])]]),
    bindingAugmentations: new Map(),
    imports: new Map(),
  } as unknown as ScopeResolutionIndexes;
}

describe('C++ ordinary callable lookup provider boundary', () => {
  it('adds included overloads only through the provider hook', () => {
    const local = definition('main.cpp', 'double');
    const header = definition('overloads.hpp', 'int');
    const module = scope('module', {
      bindings: new Map([['choose', [{ def: local, origin: 'local' }]]]),
    });
    const state = indexes([module], [included(header)]);

    expect(lookupNameClaim(module.id, 'choose', state).bindings.map((ref) => ref.def)).toEqual([
      local,
    ]);
    expect(cppScopeResolver.resolveOrdinaryCallables?.(module.id, 'choose', state)).toEqual({
      callables: [local, header],
      nonCallableFound: false,
      blockScopeDeclFound: false,
    });
  });

  it.each([false, true])('coalesces only a prototype, with included body=%s', (headerHasBody) => {
    const local = definition('main.cpp', 'int');
    const header = definition('overloads.hpp', 'int');
    const module = scope('module', {
      bindings: new Map([['choose', [{ def: local, origin: 'local' }]]]),
    });
    const state = indexes(
      [
        module,
        scope('local-body', { kind: 'Function', parent: module.id, ownedDefs: [local] }),
        scope('header', { filePath: header.filePath }),
        ...(headerHasBody
          ? [
              scope('header-body', {
                filePath: header.filePath,
                kind: 'Function',
                parent: 'header',
              }),
            ]
          : []),
      ],
      [included(header)],
    );

    expect(
      cppScopeResolver.resolveOrdinaryCallables?.(module.id, 'choose', state).callables,
    ).toEqual(headerHasBody ? [local, header] : [local]);
  });

  it('recovers only constructors owned by the selected class', () => {
    const owner: SymbolDefinition = {
      nodeId: 'def:main.cpp#1:0:Class:choose',
      filePath: 'main.cpp',
      type: 'Class',
    };
    const constructor = { ...definition('main.cpp', 'int'), ownerId: owner.nodeId };
    const foreign = { ...definition('other.hpp', 'int'), ownerId: 'other:choose' };
    const module = scope('module', {
      bindings: new Map([['choose', [{ def: owner, origin: 'local' }]]]),
    });
    const state = indexes([module], [{ def: constructor, origin: 'local' }, included(foreign)]);

    expect(lookupNameClaim(module.id, 'choose', state).bindings.map((ref) => ref.def)).toEqual([
      owner,
    ]);
    expect(cppScopeResolver.resolveOrdinaryCallables?.(module.id, 'choose', state)).toEqual({
      callables: [constructor],
      nonCallableFound: true,
      blockScopeDeclFound: false,
    });
  });
});
