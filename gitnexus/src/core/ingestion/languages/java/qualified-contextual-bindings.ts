import type { ParsedFile, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { bindsTypeParameter, lookupNameClaim } from '../../scope-resolution/scope/walkers.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';

/**
 * Raw `java.*` source spelling is a JDK container only when its package root
 * is not a visible type. Run after package sibling injection: another source
 * file can declare `java` with nested `util.List`, despite no local lookalike.
 *
 * Only contextual inference carries receiver-propagated source here. Explicit
 * declarations and single-type-import evidence remain independent. Aliases
 * retain the source and lookup anchor of the inferred binding they followed,
 * so removing each dependent fact preserves their ordinary ownership barriers.
 */
export function validateJavaQualifiedContextualBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const validity = new Map<TypeRef, boolean>();
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      for (const [name, ref] of scope.typeBindings) {
        if (ref.source !== 'receiver-propagated') continue;
        let valid = validity.get(ref);
        if (valid === undefined) {
          const file = indexes.scopeTree.getScope(ref.declaredAtScope)?.filePath ?? parsed.filePath;
          valid =
            !isJavaPackageSiblingVisibilityIncomplete(file) &&
            !bindsTypeParameter(ref.declaredAtScope, 'java', indexes) &&
            lookupNameClaim(ref.declaredAtScope, 'java', indexes, {
              purpose: 'type',
              position: ref.lookupPosition,
            }).status === 'absent';
          validity.set(ref, valid);
        }
        if (!valid) (scope.typeBindings as Map<string, TypeRef>).delete(name);
      }
    }
  }
}
