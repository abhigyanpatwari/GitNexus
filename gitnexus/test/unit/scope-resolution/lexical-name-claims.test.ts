import { describe, expect, it } from 'vitest';
import {
  lookupLexicalName,
  nameClaimsFor,
  rangesOverlap,
  type BindingRef,
  type ImportEdge,
  type Scope,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';
import {
  findCallableBindingInScope,
  findClassBindingInScope,
  findReceiverTypeBinding,
  isNamespaceNameShadowed,
} from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { findCallableBindingsAndAdlBlocker } from '../../../src/core/ingestion/languages/cpp/callable-bindings.js';
import { followChainPostFinalize } from '../../../src/core/ingestion/scope-resolution/passes/imported-return-types.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const range = { startLine: 4, startCol: 0, endLine: 4, endCol: 20 };
const target: SymbolDefinition = { nodeId: 'outer:helper', filePath: 'outer.ts', type: 'Function' };
const binding: BindingRef = { def: target, origin: 'import' };
function scope(id: string, parent: string | null, extra: Partial<Scope> = {}): Scope {
  return {
    id,
    parent,
    kind: parent === null ? 'Module' : 'Function',
    filePath: 'caller.ts',
    range,
    bindings: new Map(),
    imports: [],
    ownedDefs: [],
    typeBindings: new Map(),
    ...extra,
  };
}
function indexes(
  inner: Scope,
  outer = scope('module', null, { bindings: new Map([['helper', [binding]]]) }),
): ScopeResolutionIndexes {
  return {
    scopeTree: {
      getScope: (id: string) => [inner, outer].find((s) => s.id === id),
      byId: new Map([
        [inner.id, inner],
        [outer.id, outer],
      ]),
    },
    moduleScopes: new Map([['caller.ts', outer.id]]),
    bindings: new Map(),
    bindingAugmentations: new Map(),
    imports: new Map(),
    defs: { get: () => target },
    qualifiedNames: { get: () => [target.nodeId] },
  } as unknown as ScopeResolutionIndexes;
}

describe('lexical name ownership', () => {
  it('keeps touching half-open import ranges separate', () => {
    const earlier = { startLine: 1, startCol: 0, endLine: 1, endCol: 10 };
    const later = { startLine: 1, startCol: 10, endLine: 1, endCol: 20 };
    expect(rangesOverlap(earlier, later)).toBe(false);
    expect(rangesOverlap(later, earlier)).toBe(false);
    expect(rangesOverlap(earlier, { ...earlier, startCol: 9 })).toBe(true);
    const edge = (atRange: typeof earlier, targetFile: string): ImportEdge => ({
      localName: 'helper',
      kind: 'namespace',
      targetFile,
      targetExportedName: '',
      atRange,
    });
    const first = edge(earlier, 'earlier.ts');
    const second = edge(later, 'later.ts');
    const module = scope('module', null, {
      nameClaims: [{ name: 'helper', kind: 'import', range: later }],
      imports: [first, second],
    });
    expect(
      lookupLexicalName(module.id, 'helper', { scopes: { getScope: () => module } }).imports,
    ).toEqual([second]);
  });

  it('indexes each immutable snapshot without retaining replaced claims or import edges', () => {
    const first: ImportEdge = {
      localName: 'helper',
      kind: 'namespace',
      targetFile: 'first.ts',
      targetExportedName: '',
    };
    const second: ImportEdge = { ...first, targetFile: 'second.ts' };
    const original = scope('module', null, { imports: Object.freeze([first]) });
    const replaced = {
      ...original,
      imports: Object.freeze([second]),
      nameClaims: Object.freeze([{ name: 'helper', kind: 'blocked' as const, range }]),
    };
    const lookup = (owner: Scope) =>
      lookupLexicalName(owner.id, 'helper', { scopes: { getScope: () => owner } });
    expect(lookup(original).imports).toEqual([first]);
    expect(lookup({ ...original, imports: replaced.imports }).imports).toEqual([second]);
    expect(lookup(replaced).status).toBe('blocked');
    expect(nameClaimsFor(original, 'helper')).toEqual([]);
    expect(nameClaimsFor(replaced, 'helper')).toHaveLength(1);
    expect(lookup(original).imports).toEqual([first]);
  });
  const at = (line: number) => ({ startLine: line, startCol: 0, endLine: line, endCol: 20 });
  const lexical = (inner: Scope, outer: Scope, line: number, purpose: 'value' | 'type' = 'value') =>
    lookupLexicalName(
      inner.id,
      'helper',
      { scopes: { getScope: (id) => [inner, outer].find((s) => s.id === id) } },
      { position: at(line), purpose },
    );
  it('permits the outer callable only when the local name is absent', () => {
    expect(findCallableBindingInScope('fn', 'helper', indexes(scope('fn', 'module')))).toBe(target);
  });
  it('stops at an untyped parameter without a symbol definition', () => {
    const inner = scope('fn', 'module', { lexicalNames: new Set(['helper']) });
    expect(findCallableBindingInScope('fn', 'helper', indexes(inner))).toBeUndefined();
  });
  it('treats inferred reassignment as a read of the outer binding only with complete claims', () => {
    const outer = scope('module', null, { bindings: new Map([['helper', [binding]]]) });
    const inner = scope('fn', outer.id, {
      nameClaims: [],
      typeBindings: new Map([
        ['helper', { rawName: 'other', source: 'assignment-inferred', declaredAtScope: 'fn' }],
      ]),
    });
    expect(lexical(inner, outer, 5).scope?.id).toBe(inner.id);
    const complete = { ...inner, lookupPolicy: { nameClaimsComplete: true } };
    expect(lexical(complete, outer, 5).bindings).toEqual([binding]);
    const parameter = {
      ...complete,
      typeBindings: new Map<string, TypeRef>([
        ['helper', { rawName: 'Callback', source: 'parameter-annotation', declaredAtScope: 'fn' }],
      ]),
    };
    expect(lexical(parameter, outer, 5).scope?.id).toBe(inner.id);
    expect(lexical(parameter, outer, 5).typeBinding?.rawName).toBe('Callback');
  });
  it('joins a hoisted return annotation to the selected declaration anchor', () => {
    const method: SymbolDefinition = {
      nodeId: 'def:caller.ts#4:0:Method:helper',
      filePath: 'caller.ts',
      type: 'Method',
    };
    const outer = scope('module', null, {
      typeBindings: new Map([
        [
          'helper',
          {
            rawName: 'User',
            source: 'return-annotation',
            declaredAtScope: 'module',
            bindingRange: range,
          },
        ],
      ]),
    });
    const inner = scope('class', outer.id, {
      kind: 'Class',
      bindings: new Map([['helper', [{ def: method, origin: 'local' }]]]),
    });
    const start: TypeRef = {
      rawName: 'helper',
      source: 'assignment-inferred',
      declaredAtScope: inner.id,
    };
    expect(followChainPostFinalize(start, inner.id, indexes(inner, outer)).rawName).toBe('User');
    const differentDeclaration = {
      ...inner,
      bindings: new Map<string, readonly BindingRef[]>([
        [
          'helper',
          [{ def: { ...method, nodeId: 'def:caller.ts#5:0:Method:helper' }, origin: 'local' }],
        ],
      ]),
    };
    expect(
      followChainPostFinalize(start, inner.id, indexes(differentDeclaration, outer)).rawName,
    ).toBe('helper');
  });
  it('stops at a nearer noncallable binding before kind filtering', () => {
    const local: BindingRef = {
      def: { ...target, nodeId: 'local:helper', type: 'Variable' },
      origin: 'local',
    };
    const inner = scope('fn', 'module', {
      bindings: new Map([['helper', [local]]]),
      nameClaims: [{ name: 'helper', kind: 'binding', range }],
    });
    expect(findCallableBindingInScope('fn', 'helper', indexes(inner))).toBeUndefined();
  });
  it('preserves separate legacy value and callable namespaces without provider claims', () => {
    const local: BindingRef = {
      def: { ...target, nodeId: 'local:helper', type: 'Variable' },
      origin: 'local',
    };
    const inner = scope('fn', 'module', { bindings: new Map([['helper', [local]]]) });
    expect(findCallableBindingInScope('fn', 'helper', indexes(inner))).toBe(target);
  });
  it('preserves local-over-include precedence despite an unrelated claim', () => {
    const local = { ...target, nodeId: 'local:helper' };
    const inner = scope('fn', 'module', {
      bindings: new Map([['helper', [{ def: local, origin: 'local' }]]]),
      nameClaims: [{ name: 'other', kind: 'blocked', range }],
    });
    const state = {
      ...indexes(inner),
      bindings: new Map([[inner.id, new Map([['helper', [binding]]])]]),
    };
    expect(findCallableBindingsAndAdlBlocker(inner.id, 'helper', state).callables).toEqual([local]);
  });
  it('retains directive augmentations beside a local callable at the same tier', () => {
    const local = { ...target, nodeId: 'local:helper' };
    const inner = scope('fn', 'module', {
      bindings: new Map([['helper', [{ def: local, origin: 'local' }]]]),
    });
    const augmented: BindingRef = {
      ...binding,
      origin: 'namespace',
      declarationRange: at(2),
      availableFrom: at(3),
    };
    const state = {
      ...indexes(inner),
      bindingAugmentations: new Map([[inner.id, new Map([['helper', [augmented]]])]]),
    };
    expect(
      findCallableBindingsAndAdlBlocker(inner.id, 'helper', state, { position: at(5) }).callables,
    ).toEqual([local, target]);
  });
  it('does not let a future directive reintroduce a weaker include beside a local callable', () => {
    const local = {
      ...target,
      nodeId: 'def:caller.ts#2:0:Function:helper',
      filePath: 'caller.ts',
      qualifiedName: 'helper',
      parameterCount: 0,
      parameterTypes: [],
    };
    const included = {
      ...local,
      nodeId: 'def:header.hpp#1:0:Function:helper',
      filePath: 'header.hpp',
    };
    const future = { ...local, nodeId: 'using:helper', namespacePrefix: 'future' };
    const edge: ImportEdge = {
      localName: 'helper',
      targetFile: 'header.hpp',
      targetExportedName: 'helper',
      kind: 'wildcard-expanded',
      targetDefId: included.nodeId,
    };
    const inner = scope('module', null, {
      bindings: new Map([['helper', [{ def: local, origin: 'local' }]]]),
      imports: [edge],
    });
    const header = scope('header', null, { filePath: 'header.hpp' });
    const body = scope('body', inner.id, { range: at(2), ownedDefs: [local] });
    const base = indexes(inner, header);
    const scopeById = new Map([
      [inner.id, inner],
      [header.id, header],
      [body.id, body],
    ]);
    const augmented: BindingRef = {
      def: future,
      origin: 'namespace',
      declarationRange: at(8),
      availableFrom: at(9),
    };
    const state = {
      ...base,
      scopeTree: {
        ...base.scopeTree,
        byId: scopeById,
        getScope: (id: string) => scopeById.get(id),
      },
      bindings: new Map([
        [
          inner.id,
          new Map<string, readonly BindingRef[]>([
            ['helper', [{ def: included, origin: 'wildcard', via: edge }]],
          ]),
        ],
      ]),
      bindingAugmentations: new Map([[inner.id, new Map([['helper', [augmented]]])]]),
    };
    expect(
      findCallableBindingsAndAdlBlocker(inner.id, 'helper', state, { position: at(5) }).callables,
    ).toEqual([local]);
    expect(
      findCallableBindingsAndAdlBlocker(inner.id, 'helper', state, { position: at(10) }).callables,
    ).toEqual([local, future]);
  });
  it('retains an unresolved import as a claim on its spelling', () => {
    const inner = scope('fn', 'module', {
      imports: [
        {
          localName: 'helper',
          targetFile: null,
          targetExportedName: 'helper',
          kind: 'named',
          linkStatus: 'unresolved',
        },
      ],
    });
    expect(findCallableBindingInScope('fn', 'helper', indexes(inner))).toBeUndefined();
  });
  it('does not use the global class fallback through a nonclass local', () => {
    const classDef = { ...target, type: 'Class' as const };
    const inner = scope('fn', 'module', { lexicalNames: new Set(['helper']) });
    const state = indexes(
      inner,
      scope('module', null, {
        bindings: new Map([['helper', [{ def: classDef, origin: 'import' }]]]),
      }),
    );
    expect(findClassBindingInScope('fn', 'helper', state)).toBeUndefined();
  });
  it('keeps a local namespace loader visible after activation without shadowing itself', () => {
    const edge: ImportEdge = {
      localName: 'helper',
      kind: 'namespace',
      targetFile: 'helpers.ts',
      targetExportedName: '*',
      atRange: at(4),
    };
    const inner = scope('fn', 'module', {
      bindings: new Map([
        [
          'helper',
          [{ def: { ...target, type: 'Variable' }, origin: 'local', declarationRange: at(4) }],
        ],
      ]),
      imports: [edge],
      nameClaims: [{ name: 'helper', kind: 'import', range: at(4), availableFrom: at(5) }],
    });
    expect(isNamespaceNameShadowed('helper', inner.id, indexes(inner), false, at(3))).toBe(true);
    expect(isNamespaceNameShadowed('helper', inner.id, indexes(inner), false, at(6))).toBe(false);
  });
  it('does not reuse an earlier import target for a later ordinary binding', () => {
    const edge: ImportEdge = {
      localName: 'helper',
      kind: 'named',
      targetFile: 'helpers.ts',
      targetExportedName: 'helper',
      atRange: at(2),
    };
    const inner = scope('fn', 'module', {
      imports: [edge],
      bindings: new Map([['helper', [{ ...binding, via: edge }]]]),
      nameClaims: [
        { name: 'helper', kind: 'import', range: at(2) },
        { name: 'helper', kind: 'binding', range: at(4) },
      ],
    });
    expect(
      findCallableBindingInScope(inner.id, 'helper', indexes(inner), { position: at(6) }),
    ).toBeUndefined();
  });
  it('allows an ordered initializer to see an outer name until its local binder activates', () => {
    const outer = scope('module', null, { bindings: new Map([['helper', [binding]]]) });
    const inner = scope('fn', outer.id, {
      nameClaims: [
        { name: 'helper', kind: 'binding', range: at(4), availableFrom: at(5), inactive: 'outer' },
      ],
    });
    expect(lexical(inner, outer, 4).bindings).toEqual([binding]);
    expect(lexical(inner, outer, 6).status).toBe('blocked');
  });
  it('separates type-space ownership from runtime lookup', () => {
    const outer = scope('module', null, { bindings: new Map([['helper', [binding]]]) });
    const inner = scope('fn', outer.id, {
      nameClaims: [{ name: 'helper', kind: 'blocked', purpose: 'type', range }],
    });
    expect(lexical(inner, outer, 6, 'value').bindings).toEqual([binding]);
    expect(lexical(inner, outer, 6, 'type').status).toBe('blocked');
  });
  it('keeps a local receiver type whose producer lookup is in another file', () => {
    const typeRef: TypeRef = {
      rawName: 'User',
      declaredAtScope: 'producer',
      lookupPosition: at(100),
      bindingRange: at(4),
      source: 'return-annotation',
    };
    const inner = scope('fn', 'module', {
      nameClaims: [{ name: 'helper', kind: 'binding', range: at(4) }],
      typeBindings: new Map([['helper', typeRef]]),
    });
    expect(lexical(inner, scope('module', null), 6).typeBinding).toBe(typeRef);
  });
  it.each(['constructor-inferred', 'assignment-inferred'] as const)(
    'retains a %s fact assigned to the same lexical binding',
    (source) => {
      const typeRef: TypeRef = {
        rawName: 'User',
        declaredAtScope: 'fn',
        bindingRange: at(8),
        lookupPosition: at(8),
        source,
      };
      const inner = scope('fn', 'module', {
        nameClaims: [{ name: 'helper', kind: 'binding', range: at(4), availableFrom: at(5) }],
        typeBindings: new Map([['helper', typeRef]]),
      });
      expect(lexical(inner, scope('module', null), 10).typeBinding).toBe(typeRef);
    },
  );
  it.each(['constructor-inferred', 'assignment-inferred'] as const)(
    'does not attach a later %s binder to an earlier binding during its initializer',
    (source) => {
      const typeRef: TypeRef = {
        rawName: 'LaterUser',
        declaredAtScope: 'producer',
        bindingRange: at(8),
        // Producer lookup happens before the later binder becomes active.
        lookupPosition: at(8),
        source,
      };
      const inner = scope('fn', 'module', {
        nameClaims: [
          { name: 'helper', kind: 'binding', range: at(4), availableFrom: at(5) },
          {
            name: 'helper',
            kind: 'binding',
            range: at(8),
            availableFrom: { startLine: 8, startCol: 20 },
          },
        ],
        typeBindings: new Map([['helper', typeRef]]),
      });
      expect(lexical(inner, scope('module', null), 8).typeBinding).toBeUndefined();
      expect(lexical(inner, scope('module', null), 10).typeBinding).toBe(typeRef);
    },
  );
  it('preserves the initializer lookup position while following an alias', () => {
    const inner = scope('fn', 'module', {
      nameClaims: [{ name: 'first', kind: 'binding', range: at(3) }],
      typeBindings: new Map([
        [
          'first',
          {
            rawName: 'User',
            declaredAtScope: 'module',
            lookupPosition: at(3),
            bindingRange: at(3),
            source: 'assignment-inferred',
          },
        ],
      ]),
    });
    const alias: TypeRef = {
      rawName: 'first',
      declaredAtScope: inner.id,
      lookupPosition: at(12),
      bindingRange: at(12),
      source: 'assignment-inferred',
    };
    expect(followChainPostFinalize(alias, inner.id, indexes(inner))).toEqual({
      rawName: 'User',
      declaredAtScope: 'module',
      lookupPosition: at(3),
      bindingRange: at(12),
      source: 'assignment-inferred',
    });
  });
  it('relaxes parent activation only after crossing a deferred function environment', () => {
    const outer = scope('module', null, {
      bindings: new Map([['helper', [{ ...binding, origin: 'local', declarationRange: at(10) }]]]),
      nameClaims: [{ name: 'helper', kind: 'binding', range: at(10), availableFrom: at(11) }],
    });
    const inner = scope('fn', outer.id, { lookupPolicy: { deferParentActivation: true } });
    expect(lexical(inner, outer, 5).bindings).toHaveLength(1);
    expect(lexical(scope('block', outer.id, { kind: 'Block' }), outer, 5).status).toBe('blocked');
  });
  it('fails closed on a cyclic lexical parent chain', () => {
    const inner = scope('fn', 'fn');
    expect(lexical(inner, scope('module', null), 5).status).toBe('blocked');
  });
  it('keeps ADL ordinary lookup aligned with an ordered namespace augmentation', () => {
    const imported = { ...target, nodeId: 'using:helper' };
    const inner = scope('fn', 'module');
    const state = indexes(inner);
    (state.bindingAugmentations as Map<string, Map<string, readonly BindingRef[]>>).set(
      inner.id,
      new Map([
        [
          'helper',
          [{ def: imported, origin: 'import', declarationRange: at(4), availableFrom: at(5) }],
        ],
      ]),
    );
    expect(
      findCallableBindingsAndAdlBlocker(inner.id, 'helper', state, { position: at(3) }).callables,
    ).toEqual([target]);
    expect(
      findCallableBindingsAndAdlBlocker(inner.id, 'helper', state, { position: at(6) }),
    ).toEqual({ callables: [imported], nonCallableFound: false, blockScopeDeclFound: false });
  });
  it('does not reuse an enclosing function definition for a redirected assignment', () => {
    const enclosing = { startLine: 1, startCol: 0, endLine: 8, endCol: 20 };
    const outer = scope('module', null, {
      bindings: new Map([
        ['helper', [{ def: target, origin: 'local', declarationRange: enclosing }]],
      ]),
      nameClaims: [{ name: 'helper', kind: 'blocked', range: at(4) }],
    });
    const inner = scope('fn', outer.id, {
      nameClaims: [{ name: 'helper', kind: 'binding', range: at(4), redirect: 'module' }],
    });
    expect(
      findCallableBindingInScope(inner.id, 'helper', indexes(inner, outer), { position: at(6) }),
    ).toBeUndefined();
  });
  it('retains a callable expression contained inside its assignment claim', () => {
    const inner = scope('fn', 'module', {
      bindings: new Map([
        [
          'helper',
          [{ def: target, origin: 'local', declarationRange: { ...at(4), startCol: 10 } }],
        ],
      ]),
      nameClaims: [{ name: 'helper', kind: 'binding', range: at(4) }],
    });
    expect(
      findCallableBindingInScope(inner.id, 'helper', indexes(inner), { position: at(6) }),
    ).toBe(target);
  });
  it('retains only explicit lexical self names in a skipped class environment', () => {
    const local: BindingRef = { ...binding, origin: 'local' };
    const klass = scope('class', 'module', {
      kind: 'Class',
      lookupPolicy: { skipFromChildren: true, visibleNamesFromChildren: ['Self'] },
      bindings: new Map([
        ['Self', [local]],
        ['helper', [local]],
      ]),
      nameClaims: [{ name: 'Self', kind: 'binding', range }],
    });
    const method = scope('method', klass.id);
    const outer = scope('module', null);
    const sources = {
      scopes: { getScope: (id: string) => [method, klass, outer].find((s) => s.id === id) },
    };
    expect(lookupLexicalName(method.id, 'Self', sources).bindings).toEqual([local]);
    expect(lookupLexicalName(method.id, 'helper', sources).status).toBe('absent');
  });
  it('does not recover a skipped class type binding while keeping the explicit receiver typed', () => {
    const fieldType: TypeRef = {
      rawName: 'User',
      declaredAtScope: 'class',
      source: 'constructor-inferred',
    };
    const selfType: TypeRef = {
      rawName: 'Container',
      declaredAtScope: 'class',
      source: 'parameter-annotation',
    };
    const klass = scope('class', null, {
      kind: 'Class',
      lookupPolicy: { skipFromChildren: true },
      typeBindings: new Map([['value', fieldType]]),
    });
    const method = scope('method', klass.id, {
      nameClaims: [{ name: 'self', kind: 'binding', range }],
      typeBindings: new Map([['self', selfType]]),
    });
    const state = indexes(method, klass);
    expect(findReceiverTypeBinding(method.id, 'value', state)).toBeUndefined();
    expect(findReceiverTypeBinding(method.id, 'self', state)).toBe(selfType);
  });
  it('keeps an owned but unbound receiver from borrowing an enclosing receiver type', () => {
    const outer = scope('module', null, {
      typeBindings: new Map([
        [
          'this',
          { rawName: 'Container', declaredAtScope: 'module', source: 'parameter-annotation' },
        ],
      ]),
    });
    const inner = scope('fn', outer.id, { nameClaims: [], ownsReceivers: new Set(['this']) });
    expect(findReceiverTypeBinding(inner.id, 'this', indexes(inner, outer))).toBeUndefined();
  });
});
