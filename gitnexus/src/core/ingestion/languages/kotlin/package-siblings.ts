import { createJvmPackageSiblingVisibility } from '../jvm/package-siblings.js';
import { getKotlinPackageFact } from './package-facts.js';
import type { BindingRef, ScopeId } from 'gitnexus-shared';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';

const kotlinPackageSiblingVisibility = createJvmPackageSiblingVisibility({
  languageLabel: 'kotlin',
  getPackageFact: getKotlinPackageFact,
});

export const populateKotlinPackageSiblings: typeof kotlinPackageSiblingVisibility.populateNamespaceSiblings =
  (...args) => {
    kotlinPackageSiblingVisibility.populateNamespaceSiblings(...args);
    const [parsedFiles, indexes] = args;
    const qualified = new Map<string, BindingRef[]>(
      [...(indexes.workspaceFqnBindings ?? [])].map(([name, refs]) => [name, [...refs]]),
    );
    const augmented = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
    for (const parsed of parsedFiles) {
      const fact = getKotlinPackageFact(parsed.filePath);
      if (fact?.status !== 'known' || fact.packageName.length === 0) continue;
      const moduleScope = parsed.scopes.find((scope) => scope.kind === 'Module');
      if (moduleScope === undefined) continue;
      for (const refs of moduleScope.bindings.values()) {
        for (const binding of refs) {
          const def = binding.def;
          if (
            binding.origin !== 'local' ||
            def.filePath !== parsed.filePath ||
            !isClassLike(def.type) ||
            def.qualifiedName === undefined
          )
            continue;
          const name = `${fact.packageName}.${def.qualifiedName}`;
          const ref: BindingRef = { def, origin: 'namespace' };
          const candidates = qualified.get(name) ?? [];
          candidates.push(ref);
          qualified.set(name, candidates);
          let own = augmented.get(moduleScope.id);
          if (own === undefined) {
            own = new Map();
            augmented.set(moduleScope.id, own);
          }
          const local = own.get(name) ?? [];
          local.push(ref);
          own.set(name, local);
        }
      }
    }
    Object.assign(indexes, { workspaceFqnBindings: qualified });
  };

export const isKotlinPackageSiblingVisibilityIncomplete =
  kotlinPackageSiblingVisibility.isVisibilityIncomplete;

export const resolveKotlinSamePackageBase =
  kotlinPackageSiblingVisibility.resolveImplicitInheritanceBase;
