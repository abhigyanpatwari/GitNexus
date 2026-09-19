import { describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { javaProvider } from '../../src/core/ingestion/languages/java.js';
import { javaRuntimeSymbolStrategy } from '../../src/core/ingestion/languages/java/spring-actuator.js';

function method(name: string, properties: GraphNode['properties'] = {}): GraphNode {
  return {
    id: `method:${name}:${JSON.stringify(properties.parameterTypes)}`,
    label: 'Method',
    properties: { name, filePath: 'Controller.java', ...properties },
  };
}

describe('javaRuntimeSymbolStrategy', () => {
  it('is registered on the Java language provider', () => {
    expect(javaProvider.runtimeSymbolStrategy).toBe(javaRuntimeSymbolStrategy);
  });

  it('uses erased JVM descriptor types to distinguish same-arity overloads', () => {
    const runtime = {
      name: 'lookup',
      descriptorParameterTypes: ['java/lang/String'],
    };

    expect(
      javaRuntimeSymbolStrategy.matchesCallable(
        method('lookup', { parameterCount: 1, parameterTypes: ['String'] }),
        runtime,
      ),
    ).toBe(true);
    expect(
      javaRuntimeSymbolStrategy.matchesCallable(
        method('lookup', { parameterCount: 1, parameterTypes: ['Integer'] }),
        runtime,
      ),
    ).toBe(false);
  });

  it('maps primitive descriptors and normalizes qualified, generic, and array source types', () => {
    expect(
      javaRuntimeSymbolStrategy.matchesCallable(
        method('search', {
          parameterCount: 3,
          parameterTypes: ['int', 'java.util.List<User>', 'String[]'],
        }),
        {
          name: 'search',
          descriptorParameterTypes: ['I', 'java/util/List', 'java/lang/String[]'],
        },
      ),
    ).toBe(true);
  });

  it('distinguishes JVM array descriptors from same-arity scalar overloads', () => {
    const runtime = {
      name: 'consume',
      descriptorParameterTypes: ['I[]'],
    };

    expect(
      javaRuntimeSymbolStrategy.matchesCallable(
        method('consume', { parameterCount: 1, parameterTypes: ['int[]'] }),
        runtime,
      ),
    ).toBe(true);
    expect(
      javaRuntimeSymbolStrategy.matchesCallable(
        method('consume', { parameterCount: 1, parameterTypes: ['int'] }),
        runtime,
      ),
    ).toBe(false);
  });

  it('matches Java varargs whose graph parameter count is open-ended', () => {
    expect(
      javaRuntimeSymbolStrategy.matchesCallable(method('tags', { parameterTypes: ['String'] }), {
        name: 'tags',
        descriptorParameterTypes: ['java/lang/String'],
      }),
    ).toBe(true);
  });

  it('keeps incomplete and generic source metadata conservative', () => {
    const runtime = {
      name: 'convert',
      descriptorParameterTypes: ['java/lang/Object'],
    };

    expect(javaRuntimeSymbolStrategy.matchesCallable(method('convert'), runtime)).toBe(true);
    expect(
      javaRuntimeSymbolStrategy.matchesCallable(
        method('convert', { parameterCount: 1, parameterTypes: ['T[]'] }),
        runtime,
      ),
    ).toBe(true);
  });

  it('rejects wrong names, labels, and arity', () => {
    expect(
      javaRuntimeSymbolStrategy.matchesCallable(method('other', { parameterCount: 0 }), {
        name: 'run',
        descriptorParameterTypes: [],
      }),
    ).toBe(false);
    expect(
      javaRuntimeSymbolStrategy.matchesCallable(
        { ...method('run'), label: 'Function' },
        { name: 'run', descriptorParameterTypes: [] },
      ),
    ).toBe(false);
    expect(
      javaRuntimeSymbolStrategy.matchesCallable(method('run', { parameterCount: 1 }), {
        name: 'run',
        descriptorParameterTypes: [],
      }),
    ).toBe(false);
  });
});
