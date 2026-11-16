import type {
  BindingRef,
  ParsedFile,
  Scope,
  ScopeId,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';
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
import { javaReturnElementFacts } from './capture-side-channel.js';
import { javaReturnElementRef } from './declared-type-captures.js';

/** A top-level or member type, the only kinds a type spelling can name. */
interface NamedType {
  readonly fqn: string;
  /** The scope the declaration sits in: the module, or the enclosing type. */
  readonly enclosingScope: ScopeId;
  /** The enclosing type's def; absent for a top-level type. */
  readonly ownerId?: string;
  /** Every type on the path from the package is `public`. */
  readonly public: boolean;
  /** Some type on the path from the package is `private`. */
  readonly private: boolean;
}

const namedTypesByIndexes = new WeakMap<ScopeResolutionIndexes, ReadonlyMap<string, NamedType>>();

/** Top-level and member types of one file, keyed by scope. Local, anonymous
 * and enum-constant classes have no FQN, so they are left out. */
function collectNamedTypes(
  parsed: ParsedFile,
  packageName: string,
): Map<ScopeId, NamedType & { readonly def: SymbolDefinition }> {
  const result = new Map<ScopeId, NamedType & { readonly def: SymbolDefinition }>();
  const facts = getJavaOverloadFacts(parsed.filePath)?.types;
  const module = parsed.scopes.find((scope) => scope.kind === 'Module');
  if (facts === undefined || module === undefined) return result;
  const byId = new Map<ScopeId, Scope>(parsed.scopes.map((scope) => [scope.id, scope]));
  const resolve = (scope: Scope): (NamedType & { readonly def: SymbolDefinition }) | undefined => {
    const known = result.get(scope.id);
    if (known !== undefined || scope.kind !== 'Class' || scope.parent === null) return known;
    const def = scope.ownedDefs.find((item) => isClassLike(item.type));
    const fact = facts.find(
      (type) =>
        type.kind.endsWith('_declaration') &&
        type.range.startLine === scope.range.startLine &&
        type.range.startCol === scope.range.startCol,
    );
    if (def?.qualifiedName === undefined || fact === undefined) return undefined;
    const parent = byId.get(scope.parent);
    const owner =
      scope.parent === module.id ? undefined : parent === undefined ? undefined : resolve(parent);
    if (scope.parent !== module.id && owner === undefined) return undefined;
    const modifiers = fact.modifiers ?? [];
    const prefix = owner?.fqn ?? packageName;
    const named = {
      def,
      fqn: prefix === '' ? fact.simpleName : `${prefix}.${fact.simpleName}`,
      enclosingScope: scope.parent,
      ...(owner === undefined ? {} : { ownerId: owner.def.nodeId }),
      public: (owner?.public ?? true) && modifiers.includes('public'),
      private: (owner?.private ?? false) || modifiers.includes('private'),
    };
    result.set(scope.id, named);
    return named;
  };
  for (const scope of parsed.scopes) resolve(scope);
  return result;
}

function enclosingTypeInherits(
  scopeId: ScopeId,
  ownerId: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  for (const id of [scopeId, ...indexes.scopeTree.getAncestors(scopeId)]) {
    const scope = indexes.scopeTree.getScope(id);
    if (scope?.kind !== 'Class') continue;
    const def = scope.ownedDefs.find((item) => isClassLike(item.type));
    if (def !== undefined && indexes.methodDispatch.mroFor(def.nodeId).includes(ownerId))
      return true;
  }
  return false;
}

/**
 * The FQN a dotted type spelling names at its own use site, or `null`.
 *
 * An unclaimed root is a package (`models.User`). A root that names one type
 * declared in this file and in scope here makes the rest member types of that
 * type (`Outer.Inner`). A member type's name is also bound at file level, so
 * that binding is ignored outside the type that declares it, unless the use
 * site may inherit it. A root that names a type from another file refuses,
 * because Java method selection reads that spelling as a package path and the
 * two readings must not pick different owners. Each reference answers for
 * itself, so one shadowed spelling elsewhere in the file cannot refuse another.
 */
function qualifiedTypeKey(
  ref: TypeRef,
  spelling: string,
  indexes: ScopeResolutionIndexes,
): string | null {
  const root = spelling.split('.')[0]!;
  const file = indexes.scopeTree.getScope(ref.declaredAtScope)?.filePath;
  if (
    file === undefined ||
    isJavaPackageSiblingVisibilityIncomplete(file) ||
    bindsTypeParameter(ref.declaredAtScope, root, indexes)
  )
    return null;
  const claim = lookupNameClaim(ref.declaredAtScope, root, indexes, {
    purpose: 'type',
    position: ref.lookupPosition,
  });
  if (claim.status === 'absent') return spelling;
  const owners = new Set(claim.bindings.map((binding) => binding.def));
  const [owner] = owners;
  if (claim.status !== 'resolved' || owners.size !== 1 || owner === undefined) return null;
  const named = namedTypesByIndexes.get(indexes)?.get(owner.nodeId);
  if (named === undefined || owner.filePath !== file) return null;
  const scope = ref.declaredAtScope;
  if (
    scope === named.enclosingScope ||
    indexes.scopeTree.getAncestors(scope).includes(named.enclosingScope)
  )
    return `${named.fqn}${spelling.slice(root.length)}`;
  if (
    claim.scope?.kind !== 'Module' ||
    named.ownerId === undefined ||
    enclosingTypeInherits(scope, named.ownerId, indexes)
  )
    return null;
  return claim.bindings.every((binding) => binding.origin === 'local') ? spelling : null;
}

/** Register only written FQNs, grounded in package headers and source roots.
 * A duplicate visible declaration refuses the name instead of ranking owners. */
export function populateJavaQualifiedTypeBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const candidates = new Map<
    string,
    { binding: BindingRef; packageName: string; public: boolean; private: boolean }[]
  >();
  const namedTypes = new Map<string, NamedType>();
  for (const parsed of parsedFiles) {
    const pkg = getJavaPackageFact(parsed.filePath);
    if (pkg?.status !== 'known') continue;
    for (const { def, ...named } of collectNamedTypes(parsed, pkg.packageName).values()) {
      namedTypes.set(def.nodeId, named);
      const entries = candidates.get(named.fqn) ?? [];
      entries.push({
        binding: { def, origin: 'namespace' },
        packageName: pkg.packageName,
        public: named.public,
        private: named.private,
      });
      candidates.set(named.fqn, entries);
    }
  }
  namedTypesByIndexes.set(indexes, namedTypes);
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
  for (const parsed of parsedFiles) {
    const module = parsed.scopes.find((scope) => scope.kind === 'Module');
    const pkg = getJavaPackageFact(parsed.filePath);
    if (module === undefined || pkg?.status !== 'known') continue;
    const needed = new Set<string>();
    const need = (ref: TypeRef): void => {
      if (ref.source === 'assignment-inferred' && ref.declaredSpelling === undefined) return;
      const spelling = eraseJavaTypeArguments(ref.declaredSpelling ?? ref.rawName).replace(
        /(?:\[\])+$/,
        '',
      );
      if (!spelling.includes('.')) return;
      const key = qualifiedTypeKey(ref, spelling, indexes);
      if (key !== null) needed.add(key);
    };
    for (const scope of parsed.scopes) for (const ref of scope.typeBindings.values()) need(ref);
    // A caller's loop variable may later take a declared return type's element,
    // which is looked up here, where that return type was written.
    for (const fact of javaReturnElementFacts(parsed))
      for (const element of fact.elements)
        if (indexes.scopeTree.getScope(element.scope) !== undefined)
          need(javaReturnElementRef(fact, element));
    for (const key of needed) {
      const visible = (candidates.get(key) ?? []).filter(
        (candidate) =>
          (candidate.public ||
            (candidate.packageName === pkg.packageName &&
              (!candidate.private || candidate.binding.def.filePath === parsed.filePath))) &&
          isJvmSourceVisible(parsed.filePath, candidate.binding.def.filePath),
      );
      if (visible.length !== 1) continue;
      let names = augmentations.get(module.id);
      if (names === undefined) augmentations.set(module.id, (names = new Map()));
      names.set(key, [visible[0]!.binding]);
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
  const key = qualifiedTypeKey(ref, spelling, indexes);
  if (key === null) return null;
  let scope = indexes.scopeTree.getScope(ref.declaredAtScope);
  while (scope !== undefined && scope.kind !== 'Module')
    scope = scope.parent === null ? undefined : indexes.scopeTree.getScope(scope.parent);
  return scope !== undefined && indexes.bindingAugmentations.get(scope.id)?.get(key)?.length === 1
    ? key
    : null;
}
