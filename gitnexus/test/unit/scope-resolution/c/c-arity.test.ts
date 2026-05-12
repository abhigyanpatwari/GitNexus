/**
 * Unit tests for C arity computation and compatibility.
 */

import { describe, it, expect } from 'vitest';
import { getCParser } from '../../../../src/core/ingestion/languages/c/query.js';
import {
  computeCDeclarationArity,
  computeCCallArity,
} from '../../../../src/core/ingestion/languages/c/arity-metadata.js';
import { cArityCompatibility } from '../../../../src/core/ingestion/languages/c/arity.js';
import type { SyntaxNode } from '../../../../src/core/ingestion/utils/ast-helpers.js';
import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

function parseFunctionNode(src: string): SyntaxNode | null {
  const tree = getCParser().parse(src);
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (child?.type === 'function_definition' || child?.type === 'declaration') {
      return child as SyntaxNode;
    }
  }
  return null;
}

function parseCallNode(src: string): SyntaxNode | null {
  const tree = getCParser().parse(src);
  // Walk deeper to find call_expression
  function findCall(node: SyntaxNode): SyntaxNode | null {
    if (node.type === 'call_expression') return node;
    for (let i = 0; i < node.namedChildCount; i++) {
      const found = findCall(node.namedChild(i) as SyntaxNode);
      if (found !== null) return found;
    }
    return null;
  }
  return findCall(tree.rootNode as SyntaxNode);
}

describe('computeCDeclarationArity', () => {
  it('returns count for simple parameters', () => {
    const node = parseFunctionNode('int add(int a, int b) { return a + b; }');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    expect(arity.parameterCount).toBe(2);
    expect(arity.requiredParameterCount).toBe(2);
  });

  it('returns zero for (void) parameter list', () => {
    const node = parseFunctionNode('void f(void) { }');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    expect(arity.parameterCount).toBe(0);
    expect(arity.requiredParameterCount).toBe(0);
    expect(arity.parameterTypes).toEqual([]);
  });

  it('handles variadic functions — parameterCount is undefined', () => {
    const node = parseFunctionNode('int printf(const char *fmt, ...) { return 0; }');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    expect(arity.parameterCount).toBeUndefined();
    expect(arity.requiredParameterCount).toBe(1);
    expect(arity.parameterTypes).toContain('...');
  });

  it('extracts parameter types', () => {
    const node = parseFunctionNode('void f(int a, float b, char *c) { }');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    expect(arity.parameterTypes).toEqual(['int', 'float', 'char']);
  });

  it('handles pointer-return function', () => {
    const node = parseFunctionNode('int *create(int size) { return 0; }');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    expect(arity.parameterCount).toBe(1);
  });

  it('handles function prototype (no body)', () => {
    const node = parseFunctionNode('int add(int a, int b);');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    expect(arity.parameterCount).toBe(2);
  });

  it('returns empty for non-function node', () => {
    const node = parseFunctionNode('int x = 5;');
    // This might be a declaration node, but without function_declarator
    if (node !== null) {
      const arity = computeCDeclarationArity(node);
      expect(arity.parameterCount).toBeUndefined();
    }
  });

  it('handles single parameter', () => {
    const node = parseFunctionNode('void f(int x) { }');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    expect(arity.parameterCount).toBe(1);
    expect(arity.requiredParameterCount).toBe(1);
  });

  it('returns unknown arity for K&R empty parameter list int foo()', () => {
    const node = parseFunctionNode('int foo() { return 0; }');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    // K&R old-style: unspecified parameters, NOT zero parameters
    expect(arity.parameterCount).toBeUndefined();
    expect(arity.requiredParameterCount).toBeUndefined();
    expect(arity.parameterTypes).toBeUndefined();
  });

  it('distinguishes K&R int foo() from explicit int foo(void)', () => {
    const knrNode = parseFunctionNode('int foo() { return 0; }');
    const voidNode = parseFunctionNode('int foo(void) { return 0; }');
    expect(knrNode).not.toBeNull();
    expect(voidNode).not.toBeNull();

    const knrArity = computeCDeclarationArity(knrNode!);
    const voidArity = computeCDeclarationArity(voidNode!);

    // K&R: unknown arity
    expect(knrArity.parameterCount).toBeUndefined();
    // Explicit void: zero params
    expect(voidArity.parameterCount).toBe(0);
    expect(voidArity.requiredParameterCount).toBe(0);
  });

  it('returns unknown arity for K&R prototype int foo();', () => {
    const node = parseFunctionNode('int foo();');
    expect(node).not.toBeNull();
    const arity = computeCDeclarationArity(node!);
    expect(arity.parameterCount).toBeUndefined();
    expect(arity.requiredParameterCount).toBeUndefined();
  });
});

describe('computeCCallArity', () => {
  it('counts zero arguments', () => {
    const node = parseCallNode('void f(void) { init(); }');
    expect(node).not.toBeNull();
    expect(computeCCallArity(node!)).toBe(0);
  });

  it('counts two arguments', () => {
    const node = parseCallNode('void f(void) { add(1, 2); }');
    expect(node).not.toBeNull();
    expect(computeCCallArity(node!)).toBe(2);
  });

  it('counts three arguments', () => {
    const node = parseCallNode('void f(void) { func(a, b, c); }');
    expect(node).not.toBeNull();
    expect(computeCCallArity(node!)).toBe(3);
  });

  it('counts string literal arguments', () => {
    const node = parseCallNode('void f(void) { printf("hello %s", name); }');
    expect(node).not.toBeNull();
    expect(computeCCallArity(node!)).toBe(2);
  });
});

describe('cArityCompatibility', () => {
  function makeDef(params: Partial<SymbolDefinition>): SymbolDefinition {
    return {
      nodeId: 'test',
      filePath: 'test.c',
      type: 'Function',
      ...params,
    };
  }

  function makeCallsite(arity: number): Callsite {
    return { arity } as Callsite;
  }

  it('returns compatible for exact match', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    expect(cArityCompatibility(def, makeCallsite(2))).toBe('compatible');
  });

  it('returns incompatible for too few args', () => {
    const def = makeDef({ parameterCount: 3, requiredParameterCount: 3 });
    expect(cArityCompatibility(def, makeCallsite(1))).toBe('incompatible');
  });

  it('returns incompatible for too many args (non-variadic)', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    expect(cArityCompatibility(def, makeCallsite(5))).toBe('incompatible');
  });

  it('returns compatible for variadic with enough args', () => {
    const def = makeDef({
      requiredParameterCount: 1,
      parameterTypes: ['const char *', '...'],
    });
    expect(cArityCompatibility(def, makeCallsite(3))).toBe('compatible');
  });

  it('returns unknown when no arity info on def', () => {
    const def = makeDef({});
    expect(cArityCompatibility(def, makeCallsite(2))).toBe('unknown');
  });

  it('returns unknown for negative callsite arity', () => {
    const def = makeDef({ parameterCount: 2, requiredParameterCount: 2 });
    expect(cArityCompatibility(def, makeCallsite(-1))).toBe('unknown');
  });
});
