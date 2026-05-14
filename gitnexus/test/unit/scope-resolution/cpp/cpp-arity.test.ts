/**
 * Unit tests for C++ arity compatibility and metadata.
 */

import { describe, it, expect } from 'vitest';
import { cppArityCompatibility } from '../../../../src/core/ingestion/languages/cpp/arity.js';
import {
  computeCppDeclarationArity,
  computeCppCallArity,
} from '../../../../src/core/ingestion/languages/cpp/arity-metadata.js';
import { getCppParser } from '../../../../src/core/ingestion/languages/cpp/query.js';
import type { SyntaxNode } from '../../../../src/core/ingestion/utils/ast-helpers.js';
import type { SymbolDefinition, Callsite } from 'gitnexus-shared';

function parseFuncDef(src: string): SyntaxNode | null {
  const tree = getCppParser().parse(src);
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (child?.type === 'function_definition') return child as SyntaxNode;
  }
  return null;
}

function parseCallExpr(src: string): SyntaxNode | null {
  const tree = getCppParser().parse(src);
  const walk = (node: SyntaxNode): SyntaxNode | null => {
    if (node.type === 'call_expression') return node;
    for (let i = 0; i < node.namedChildCount; i++) {
      const found = walk(node.namedChild(i) as SyntaxNode);
      if (found) return found;
    }
    return null;
  };
  return walk(tree.rootNode as SyntaxNode);
}

function mkDef(overrides: Partial<SymbolDefinition> = {}): SymbolDefinition {
  return {
    nodeId: 'test-def',
    qualifiedName: 'test',
    filePath: 'test.cpp',
    type: 'Function',
    ...overrides,
  } as SymbolDefinition;
}

function mkCallsite(arity: number): Callsite {
  return { arity } as Callsite;
}

// ── Declaration arity ───────────────────────────────────────────────────────

describe('computeCppDeclarationArity', () => {
  it('computes arity for zero-parameter function', () => {
    const node = parseFuncDef('void foo() {}');
    expect(node).not.toBeNull();
    const arity = computeCppDeclarationArity(node!);
    expect(arity.parameterCount).toBe(0);
    expect(arity.requiredParameterCount).toBe(0);
  });

  it('computes arity for (void) parameter', () => {
    const node = parseFuncDef('void foo(void) {}');
    expect(node).not.toBeNull();
    const arity = computeCppDeclarationArity(node!);
    expect(arity.parameterCount).toBe(0);
    expect(arity.requiredParameterCount).toBe(0);
  });

  it('computes arity for multiple parameters', () => {
    const node = parseFuncDef('void foo(int x, int y, int z) {}');
    expect(node).not.toBeNull();
    const arity = computeCppDeclarationArity(node!);
    expect(arity.parameterCount).toBe(3);
    expect(arity.requiredParameterCount).toBe(3);
  });

  it('computes arity with default parameters', () => {
    const node = parseFuncDef('void foo(int x, int y = 5, int z = 10) {}');
    expect(node).not.toBeNull();
    const arity = computeCppDeclarationArity(node!);
    expect(arity.parameterCount).toBe(3);
    expect(arity.requiredParameterCount).toBe(1);
  });

  it('detects variadic function', () => {
    const node = parseFuncDef('void foo(int x, ...) {}');
    expect(node).not.toBeNull();
    const arity = computeCppDeclarationArity(node!);
    expect(arity.parameterCount).toBeUndefined(); // variadic → undefined max
    expect(arity.requiredParameterCount).toBe(1);
    expect(arity.parameterTypes).toContain('...');
  });

  it('handles pointer return type', () => {
    const node = parseFuncDef('int* create(int size) {}');
    expect(node).not.toBeNull();
    const arity = computeCppDeclarationArity(node!);
    expect(arity.parameterCount).toBe(1);
  });
});

// ── Call-site arity ─────────────────────────────────────────────────────────

describe('computeCppCallArity', () => {
  it('computes arity for no-argument call', () => {
    const node = parseCallExpr('void f() { foo(); }');
    expect(node).not.toBeNull();
    expect(computeCppCallArity(node!)).toBe(0);
  });

  it('computes arity for multi-argument call', () => {
    const node = parseCallExpr('void f() { foo(1, 2, 3); }');
    expect(node).not.toBeNull();
    expect(computeCppCallArity(node!)).toBe(3);
  });

  it('computes arity for single-argument call', () => {
    const node = parseCallExpr('void f() { foo(42); }');
    expect(node).not.toBeNull();
    expect(computeCppCallArity(node!)).toBe(1);
  });
});

// ── Arity compatibility ─────────────────────────────────────────────────────

describe('cppArityCompatibility', () => {
  it('returns compatible for exact match', () => {
    const def = mkDef({ parameterCount: 2, requiredParameterCount: 2 });
    expect(cppArityCompatibility(def, mkCallsite(2))).toBe('compatible');
  });

  it('returns compatible when call uses default params', () => {
    const def = mkDef({ parameterCount: 3, requiredParameterCount: 1 });
    expect(cppArityCompatibility(def, mkCallsite(1))).toBe('compatible');
    expect(cppArityCompatibility(def, mkCallsite(2))).toBe('compatible');
    expect(cppArityCompatibility(def, mkCallsite(3))).toBe('compatible');
  });

  it('returns incompatible for too few args', () => {
    const def = mkDef({ parameterCount: 3, requiredParameterCount: 2 });
    expect(cppArityCompatibility(def, mkCallsite(1))).toBe('incompatible');
  });

  it('returns incompatible for too many args (non-variadic)', () => {
    const def = mkDef({ parameterCount: 2, requiredParameterCount: 2 });
    expect(cppArityCompatibility(def, mkCallsite(5))).toBe('incompatible');
  });

  it('returns compatible for variadic with extra args', () => {
    const def = mkDef({
      parameterCount: undefined,
      requiredParameterCount: 1,
      parameterTypes: ['int', '...'],
    });
    expect(cppArityCompatibility(def, mkCallsite(5))).toBe('compatible');
  });

  it('returns unknown when no metadata', () => {
    const def = mkDef({});
    expect(cppArityCompatibility(def, mkCallsite(2))).toBe('unknown');
  });

  it('returns unknown for negative arity', () => {
    const def = mkDef({ parameterCount: 2, requiredParameterCount: 2 });
    expect(cppArityCompatibility(def, mkCallsite(-1))).toBe('unknown');
  });
});
