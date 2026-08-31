import { describe, expect, it } from 'vitest';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import { kotlinRuntimeSymbolStrategy } from '../../src/core/ingestion/languages/kotlin/spring-actuator.js';

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
});
