import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';

import { objectiveCSourceIdentity } from './identity.js';

const annotationValue = (
  definition: SymbolDefinition,
  prefix: string,
): string | undefined =>
  definition.annotations?.find((annotation) => annotation.startsWith(prefix))?.slice(prefix.length);

const hasAnnotation = (definition: SymbolDefinition, value: string): boolean =>
  definition.annotations?.includes(value) ?? false;

function uniquePrimaryImplementations(
  parsedFiles: readonly ParsedFile[],
): ReadonlyMap<string, SymbolDefinition> {
  const candidates = new Map<string, SymbolDefinition | null>();
  for (const parsed of parsedFiles) {
    for (const definition of parsed.localDefs) {
      if (definition.type !== 'Class') continue;
      if (annotationValue(definition, 'objc:site:') !== 'implementation') continue;
      if (
        annotationValue(definition, 'objc:category:') !== undefined ||
        hasAnnotation(definition, 'objc:class-extension')
      ) {
        continue;
      }
      const owner = annotationValue(definition, 'objc:owner:');
      if (owner === undefined) continue;
      const existing = candidates.get(owner);
      candidates.set(owner, existing === undefined ? definition : null);
    }
  }

  const unique = new Map<string, SymbolDefinition>();
  for (const [owner, definition] of candidates) {
    if (definition !== null) unique.set(owner, definition);
  }
  return unique;
}

/**
 * Objective-C categories and compiler-synthesized property accessors belong to
 * the concrete class even when their source declaration lives in another file.
 * Stamp that ownership before semantic-model reconciliation so ordinary member
 * dispatch can see those definitions without adding language branches to the
 * shared resolver.
 */
export function populateObjectiveCWorkspaceOwners(parsedFiles: readonly ParsedFile[]): void {
  const implementations = uniquePrimaryImplementations(parsedFiles);
  const dynamicProperties = new Set<string>();
  for (const parsed of parsedFiles) {
    for (const definition of parsed.localDefs) {
      if (
        definition.type !== 'Property' ||
        !hasAnnotation(definition, 'objc:property-implementation:dynamic')
      ) {
        continue;
      }
      const owner = annotationValue(definition, 'objc:owner:');
      const name = definition.qualifiedName?.split('.').pop();
      if (owner !== undefined && name !== undefined) dynamicProperties.add(`${owner}\0${name}`);
    }
  }

  for (const parsed of parsedFiles) {
    for (const definition of parsed.localDefs) {
      const owner = annotationValue(definition, 'objc:owner:');
      if (owner === undefined) continue;
      const concreteOwner = implementations.get(owner);
      if (concreteOwner === undefined) continue;

      const role = annotationValue(definition, 'objc:site:');
      if (
        definition.type === 'Property' &&
        role === 'declaration' &&
        annotationValue(definition, 'objc:category:') === undefined &&
        !definition.annotations?.some((annotation) => annotation.startsWith('objc:protocol:'))
      ) {
        definition.ownerId = concreteOwner.nodeId;
        continue;
      }
      if (definition.type !== 'Method') continue;
      const isCategoryImplementation =
        role === 'implementation' && annotationValue(definition, 'objc:category:') !== undefined;
      const propertyName = annotationValue(definition, 'objc:property-name:');
      const isSynthesizablePropertyAccessor =
        role === 'declaration' &&
        hasAnnotation(definition, 'objc:property-accessor') &&
        propertyName !== undefined &&
        !dynamicProperties.has(`${owner}\0${propertyName}`) &&
        annotationValue(definition, 'objc:category:') === undefined &&
        !definition.annotations?.some((annotation) => annotation.startsWith('objc:protocol:'));
      if (isSynthesizablePropertyAccessor) {
        const signedSelector = definition.qualifiedName?.split('.').pop() ?? '';
        definition.filePath = concreteOwner.filePath;
        definition.sourceIdentity = objectiveCSourceIdentity({
          label: 'Method',
          owner,
          declarationScope: '<primary>',
          sourceRole: 'synthesized',
          member: signedSelector,
        });
        definition.annotations = [
          ...(definition.annotations ?? []).filter((annotation) => !annotation.startsWith('objc:site:')),
          'objc:site:synthesized',
        ];
      }
      if (role === 'synthesized' || isSynthesizablePropertyAccessor || isCategoryImplementation) {
        definition.ownerId = concreteOwner.nodeId;
      }
    }
  }
}
