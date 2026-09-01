import type { GraphNode } from 'gitnexus-shared';
import type { RuntimeCallableIdentity, RuntimeSymbolStrategy } from '../../language-provider.js';

const JVM_PRIMITIVES: Readonly<Record<string, string>> = {
  B: 'byte',
  C: 'char',
  D: 'double',
  F: 'float',
  I: 'int',
  J: 'long',
  S: 'short',
  Z: 'boolean',
};

function normalizedType(value: string, runtime: boolean): string {
  let erased = value.trim();
  let arrayDimensions = 0;
  if (erased.endsWith('...')) {
    arrayDimensions++;
    erased = erased.slice(0, -3);
  }
  while (erased.endsWith('[]')) {
    arrayDimensions++;
    erased = erased.slice(0, -2);
  }
  erased = erased.replace(/<.*>$/, '').replaceAll('$', '.').replaceAll('/', '.');
  const simple = erased.slice(erased.lastIndexOf('.') + 1);
  const base = runtime ? (JVM_PRIMITIVES[simple] ?? simple) : simple;
  return `${base}${'[]'.repeat(arrayDimensions)}`;
}

function sourceTypeIsUnknown(value: string): boolean {
  const type = normalizedType(value, false).replace(/(?:\[\])+$/, '');
  return type === '?' || /^[A-Z]$/.test(type);
}

function matchesJavaCallable(node: GraphNode, runtime: RuntimeCallableIdentity): boolean {
  if (node.label !== 'Method' || node.properties.name !== runtime.name) return false;

  const descriptorTypes = runtime.descriptorParameterTypes;
  if (descriptorTypes === undefined) return true;

  const parameterCount = node.properties.parameterCount;
  if (typeof parameterCount === 'number' && parameterCount !== descriptorTypes.length) return false;

  const sourceTypes = node.properties.parameterTypes;
  if (
    !Array.isArray(sourceTypes) ||
    sourceTypes.length !== descriptorTypes.length ||
    !sourceTypes.every((type): type is string => typeof type === 'string')
  ) {
    return true;
  }

  return sourceTypes.every((sourceType, index) => {
    if (sourceTypeIsUnknown(sourceType)) return true;
    const source = normalizedType(sourceType, false);
    const descriptor = normalizedType(descriptorTypes[index] ?? '', true);
    if (source === descriptor) return true;
    // Java parser metadata currently drops the ellipsis from varargs and also
    // leaves parameterCount open-ended. Only in that shape may T match JVM T[].
    return (
      typeof parameterCount !== 'number' &&
      descriptor.endsWith('[]') &&
      source === descriptor.slice(0, -2)
    );
  });
}

export const javaRuntimeSymbolStrategy: RuntimeSymbolStrategy = {
  matchesCallable: matchesJavaCallable,
};
