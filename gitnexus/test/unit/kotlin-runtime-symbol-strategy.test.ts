import { describe, expect, it } from 'vitest';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import {
  extractKotlinRuntimeSymbolProperties,
  kotlinRuntimeSymbolStrategy,
} from '../../src/core/ingestion/languages/kotlin/spring-actuator.js';
import { getKotlinParser } from '../../src/core/ingestion/languages/kotlin/query.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

function node(label: NodeLabel, properties: GraphNode['properties']): GraphNode {
  return { id: `n:${String(properties.name)}`, label, properties };
}

describe('kotlinRuntimeSymbolStrategy', () => {
  it('accepts a trailing Continuation parameter only for suspend callables', () => {
    const runtime = {
      name: 'suspended',
      descriptorParameterTypes: ['I', 'kotlin/coroutines/Continuation'],
    };
    expect(
      kotlinRuntimeSymbolStrategy.matchesCallable(
        node('Method', {
          name: 'suspended',
          filePath: 'a.kt',
          parameterCount: 1,
          kotlinSuspend: true,
        }),
        runtime,
      ),
    ).toBe(true);
    expect(
      kotlinRuntimeSymbolStrategy.matchesCallable(
        node('Method', { name: 'suspended', filePath: 'a.kt', parameterCount: 1 }),
        runtime,
      ),
    ).toBe(false);
  });

  it('maps getter names and boolean is-prefixed properties', () => {
    expect(
      kotlinRuntimeSymbolStrategy.matchesCallable(
        node('Property', { name: 'status', filePath: 'a.kt', parameterCount: 0 }),
        { name: 'getStatus', descriptorParameterTypes: [] },
      ),
    ).toBe(true);
    expect(
      kotlinRuntimeSymbolStrategy.matchesCallable(
        node('Property', { name: 'isReady', filePath: 'a.kt', parameterCount: 0 }),
        { name: 'isReady', descriptorParameterTypes: [] },
      ),
    ).toBe(true);
    expect(
      kotlinRuntimeSymbolStrategy.matchesCallable(
        node('Property', { name: 'isReady', filePath: 'a.kt', parameterCount: 0 }),
        { name: 'getIsReady', descriptorParameterTypes: [] },
      ),
    ).toBe(false);
    expect(
      kotlinRuntimeSymbolStrategy.matchesCallable(
        node('Method', {
          name: 'getStatus',
          filePath: 'a.kt',
          parameterCount: 0,
          synthetic: 'kotlin-jvm',
        }),
        { name: 'getStatus', descriptorParameterTypes: [] },
      ),
    ).toBe(false);
  });

  it('strips $default names and skips arity when the synthetic default bridge is unique', () => {
    expect(
      kotlinRuntimeSymbolStrategy.matchesCallable(
        node('Method', { name: 'withDefault', filePath: 'a.kt', parameterCount: 1 }),
        {
          name: 'withDefault$default',
          descriptorParameterTypes: ['com/example/KotlinController', 'I', 'I', 'java/lang/Object'],
        },
      ),
    ).toBe(true);
  });

  it('exposes companion and file-facade owner aliases without inventing named companions', () => {
    expect(
      kotlinRuntimeSymbolStrategy.callableOwnerAliases?.(
        node('Method', { name: 'companionHandler', filePath: 'a.kt', isStatic: true }),
        node('Class', {
          name: 'KotlinController',
          filePath: 'a.kt',
          qualifiedName: 'com.example.KotlinController',
        }),
      ),
    ).toEqual(['com.example.KotlinController', 'com.example.KotlinController.Companion']);
    expect(
      kotlinRuntimeSymbolStrategy.callableOwnerAliases?.(
        node('Function', {
          name: 'topLevelHandler',
          filePath: 'a.kt',
          runtimeOwnerAliases: ['com.example.CustomHandlers'],
        }),
        undefined,
      ),
    ).toEqual(['com.example.CustomHandlers']);
  });

  it('assigns file-facade owners to top-level properties and honors aliased JvmName', () => {
    const source = `package com.example
import kotlin.jvm.JvmName as Rename

val facadeStatus: String get() = "ok"

@get:Rename("fetchName")
val renamed: String get() = "ok"
`;
    const root = getKotlinParser().parse(source).rootNode as unknown as SyntaxNode;
    const properties: SyntaxNode[] = [];
    const visit = (node: SyntaxNode): void => {
      if (node.type === 'property_declaration') properties.push(node);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) visit(child);
      }
    };
    visit(root);
    expect(properties).toHaveLength(2);
    const facadeNode = properties[0];
    const renamedNode = properties[1];
    if (facadeNode === undefined || renamedNode === undefined) {
      throw new Error('expected two top-level property declarations');
    }
    const imports = [
      {
        kind: 'alias' as const,
        localName: 'Rename',
        importedName: 'JvmName',
        alias: 'Rename',
        targetRaw: 'kotlin.jvm',
      },
    ];
    expect(
      extractKotlinRuntimeSymbolProperties({
        nodeLabel: 'Property',
        nodeName: 'facadeStatus',
        filePath: 'Handlers.kt',
        definitionNode: facadeNode,
        parsedImports: imports,
        isExported: true,
      }),
    ).toMatchObject({ runtimeOwnerAliases: ['com.example.HandlersKt'] });
    expect(
      extractKotlinRuntimeSymbolProperties({
        nodeLabel: 'Property',
        nodeName: 'renamed',
        filePath: 'Handlers.kt',
        definitionNode: renamedNode,
        parsedImports: imports,
        isExported: true,
      }),
    ).toMatchObject({
      runtimeCallableAliases: ['fetchName'],
      runtimeOwnerAliases: ['com.example.HandlersKt'],
    });
  });

  it('recognizes fully-qualified kotlin.jvm.JvmName without an import', () => {
    const source = `package com.example

@file:kotlin.jvm.JvmName("CustomHandlers")

@get:kotlin.jvm.JvmName("fetchName")
val renamed: String get() = "ok"
`;
    const root = getKotlinParser().parse(source).rootNode as unknown as SyntaxNode;
    const properties: SyntaxNode[] = [];
    const visit = (node: SyntaxNode): void => {
      if (node.type === 'property_declaration') properties.push(node);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) visit(child);
      }
    };
    visit(root);
    const renamedNode = properties[0];
    if (renamedNode === undefined) {
      throw new Error('expected a top-level property declaration');
    }
    expect(
      extractKotlinRuntimeSymbolProperties({
        nodeLabel: 'Property',
        nodeName: 'renamed',
        filePath: 'Handlers.kt',
        definitionNode: renamedNode,
        parsedImports: [],
        isExported: true,
      }),
    ).toMatchObject({
      runtimeCallableAliases: ['fetchName'],
      runtimeOwnerAliases: ['com.example.CustomHandlers'],
    });
  });
});
