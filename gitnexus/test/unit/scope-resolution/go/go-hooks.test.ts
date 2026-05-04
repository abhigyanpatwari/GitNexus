import { describe, expect, it } from 'vitest';
import type { BindingRef, Callsite, SymbolDefinition, Scope } from 'gitnexus-shared';
import {
  goArityCompatibility,
  goMergeBindings,
  goReceiverBinding,
} from '../../../../src/core/ingestion/languages/go/index.js';

describe('Go arity compatibility', () => {
  const makeDef = (overrides: Partial<SymbolDefinition> = {}): SymbolDefinition => ({
    nodeId: 'def:1',
    filePath: 'a.go',
    type: 'Function',
    qualifiedName: 'F',
    ...overrides,
  });

  it('returns unknown when no param count info', () => {
    const def = makeDef();
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 1,
    };
    expect(goArityCompatibility(def, callsite)).toBe('unknown');
  });

  it('exact match is compatible', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 2,
    };
    expect(goArityCompatibility(def, callsite)).toBe('compatible');
  });

  it('too few args is incompatible', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 1,
    };
    expect(goArityCompatibility(def, callsite)).toBe('incompatible');
  });

  it('variadic accepts extra args', () => {
    const def = makeDef({
      parameterCount: 2,
      requiredParameterCount: 1,
      parameterTypes: ['string', '...string'],
    });
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 5,
    };
    expect(goArityCompatibility(def, callsite)).toBe('compatible');
  });

  it('non-variadic rejects extra args', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    const callsite: Callsite = {
      name: 'F',
      inScope: 's',
      atRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
      kind: 'call',
      arity: 3,
    };
    expect(goArityCompatibility(def, callsite)).toBe('incompatible');
  });
});

describe('Go merge bindings', () => {
  it('local wins over import', () => {
    const local: BindingRef = {
      origin: 'local',
      def: { nodeId: 'def:local', filePath: 'main.go', type: 'Function', qualifiedName: 'Save' },
    };
    const imported: BindingRef = {
      origin: 'import',
      def: { nodeId: 'def:import', filePath: 'util.go', type: 'Function', qualifiedName: 'Save' },
    };
    const merged = goMergeBindings([imported], [local], 'scope:1');
    expect(merged[0].def.nodeId).toBe('def:local');
  });

  it('deduplicates by DefId', () => {
    const a: BindingRef = {
      origin: 'local',
      def: { nodeId: 'def:1', filePath: 'a.go', type: 'Function', qualifiedName: 'F' },
    };
    const b: BindingRef = {
      origin: 'local',
      def: { nodeId: 'def:1', filePath: 'a.go', type: 'Function', qualifiedName: 'F' },
    };
    expect(goMergeBindings([], [a, b], 'scope:1').length).toBe(1);
  });
});

describe('Go receiver binding', () => {
  it('reads self type binding from function scope', () => {
    const scope = {
      kind: 'Function',
      typeBindings: new Map([
        ['u', { rawName: 'User', declaredAtScope: 'scope:1', source: 'self' }],
      ]),
    } as unknown as Scope;
    expect(goReceiverBinding(scope)?.rawName).toBe('User');
  });

  it('returns null for non-Function scope', () => {
    const scope = { kind: 'Module', typeBindings: new Map() } as unknown as Scope;
    expect(goReceiverBinding(scope)).toBeNull();
  });

  it('returns null when no self binding', () => {
    const scope = { kind: 'Function', typeBindings: new Map() } as unknown as Scope;
    expect(goReceiverBinding(scope)).toBeNull();
  });
});
