import type { BindingRef, ParsedFile, ScopeId, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  bindsTypeParameter,
  isClassLike,
  lookupNameClaim,
} from '../../scope-resolution/scope/walkers.js';
import { isJvmSourceVisible } from '../jvm/source-visibility.js';
import { getJavaOverloadFacts } from './overload-argument-facts.js';
import { getJavaPackageFact } from './package-facts.js';
import { eraseJavaTypeArguments } from './type-spelling.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';

function packageRootIsUnclaimed(
  ref: TypeRef,
  spelling: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  const root = spelling.split('.')[0]!;
  const file = indexes.scopeTree.getScope(ref.declaredAtScope)?.filePath;
  return (
    file !== undefined &&
    !isJavaPackageSiblingVisibilityIncomplete(file) &&
    !bindsTypeParameter(ref.declaredAtScope, root, indexes) &&
    lookupNameClaim(ref.declaredAtScope, root, indexes, {
      purpose: 'type',
      position: ref.lookupPosition,
    }).status === 'absent'
  );
}

/** Register only written FQNs, grounded in package headers and source roots.
 * A duplicate visible declaration refuses the name instead of ranking owners. */
export function populateJavaQualifiedTypeBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const candidates = new Map<
    string,
    { binding: BindingRef; packageName: string; public: boolean }[]
  >();
  for (const parsed of parsedFiles) {
    const pkg = getJavaPackageFact(parsed.filePath);
    if (pkg?.status !== 'known') continue;
    const module = parsed.scopes.find((scope) => scope.kind === 'Module');
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class' || scope.parent !== module?.id) continue;
      const def = scope.ownedDefs.find((item) => isClassLike(item.type));
      if (def?.qualifiedName === undefined) continue;
      const fact = getJavaOverloadFacts(parsed.filePath)?.types.find(
        (type) =>
          type.range.startLine === scope.range.startLine &&
          type.range.startCol === scope.range.startCol,
      );
      if (fact === undefined) continue;
      const fqn =
        pkg.packageName === '' ? def.qualifiedName : `${pkg.packageName}.${def.qualifiedName}`;
      const entries = candidates.get(fqn) ?? [];
      entries.push({
        binding: { def, origin: 'namespace' },
        packageName: pkg.packageName,
        public: fact.modifiers.includes('public'),
      });
      candidates.set(fqn, entries);
    }
  }
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
  for (const parsed of parsedFiles) {
    const module = parsed.scopes.find((scope) => scope.kind === 'Module');
    const pkg = getJavaPackageFact(parsed.filePath);
    if (module === undefined || pkg?.status !== 'known') continue;
    const needed = new Set<string>();
    const refused = new Set<string>();
    for (const scope of parsed.scopes)
      for (const ref of scope.typeBindings.values()) {
        if (ref.source === 'assignment-inferred' && ref.declaredSpelling === undefined) continue;
        const spelling = eraseJavaTypeArguments(ref.declaredSpelling ?? ref.rawName).replace(
          /(?:\[\])+$/,
          '',
        );
        if (spelling.includes('.')) {
          needed.add(spelling);
          if (!packageRootIsUnclaimed(ref, spelling, indexes)) refused.add(spelling);
        }
      }
    for (const spelling of needed) {
      if (refused.has(spelling)) continue;
      const visible = (candidates.get(spelling) ?? []).filter(
        (candidate) =>
          (candidate.public || candidate.packageName === pkg.packageName) &&
          isJvmSourceVisible(parsed.filePath, candidate.binding.def.filePath),
      );
      if (visible.length !== 1) continue;
      let names = augmentations.get(module.id);
      if (names === undefined) augmentations.set(module.id, (names = new Map()));
      names.set(spelling, [visible[0]!.binding]);
    }
  }
}

/** A missing qualified type is a final refusal, never a simple-name retry. */
export function javaQualifiedTypeLookupSpelling(
  ref: TypeRef,
  indexes?: ScopeResolutionIndexes,
): string | null | undefined {
  if (ref.declaredSpelling === undefined) return undefined;
  const spelling = eraseJavaTypeArguments(ref.declaredSpelling);
  if (!spelling.includes('.')) return undefined;
  if (spelling.endsWith('[]') || indexes === undefined) return null;
  if (!packageRootIsUnclaimed(ref, spelling, indexes)) return null;
  let scope = indexes.scopeTree.getScope(ref.declaredAtScope);
  while (scope !== undefined && scope.kind !== 'Module')
    scope = scope.parent === null ? undefined : indexes.scopeTree.getScope(scope.parent);
  return scope !== undefined &&
    indexes.bindingAugmentations.get(scope.id)?.get(spelling)?.length === 1
    ? spelling
    : null;
}
