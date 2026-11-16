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
  /** The class scope of the top-level type this one is declared in (itself
   * when top-level): the only body where a private type on the path is
   * accessible (JLS 6.6.1). */
  readonly topLevelScope: ScopeId;
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
  // One pass over the facts; the first declaration at a start position wins.
  const declarations = new Map<string, (typeof facts)[number]>();
  for (const type of facts) {
    const key = `${type.range.startLine}:${type.range.startCol}`;
    if (type.kind.endsWith('_declaration') && !declarations.has(key)) declarations.set(key, type);
  }
  const resolve = (scope: Scope): (NamedType & { readonly def: SymbolDefinition }) | undefined => {
    const known = result.get(scope.id);
    if (known !== undefined || scope.kind !== 'Class' || scope.parent === null) return known;
    const def = scope.ownedDefs.find((item) => isClassLike(item.type));
    const fact = declarations.get(`${scope.range.startLine}:${scope.range.startCol}`);
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
      topLevelScope: owner?.topLevelScope ?? scope.id,
    };
    result.set(scope.id, named);
    return named;
  };
  for (const scope of parsed.scopes) resolve(scope);
  return result;
}

const memberTypeNamesByIndexes = new WeakMap<
  ScopeResolutionIndexes,
  ReadonlyMap<string, ReadonlySet<string>>
>();

/** Simple names of the member types each workspace class declares. */
function memberTypeNamesByOwner(
  indexes: ScopeResolutionIndexes,
): ReadonlyMap<string, ReadonlySet<string>> {
  const cached = memberTypeNamesByIndexes.get(indexes);
  if (cached !== undefined) return cached;
  const names = new Map<string, Set<string>>();
  for (const def of indexes.defs.byId.values()) {
    if (def.ownerId === undefined || !(isClassLike(def.type) || def.type === 'Annotation'))
      continue;
    const spelling = def.qualifiedName ?? def.nodeId;
    const owned = names.get(def.ownerId) ?? new Set<string>();
    owned.add(spelling.slice(Math.max(spelling.lastIndexOf('.'), spelling.lastIndexOf(':')) + 1));
    names.set(def.ownerId, owned);
  }
  memberTypeNamesByIndexes.set(indexes, names);
  return names;
}

/** Whether a class enclosing `scopeId` inherits a member type named `name`,
 * which shadows every file- and package-level type of that name. A base
 * outside the workspace has no inventory, so it contributes none. */
export function inheritsJavaMemberTypeNamed(
  scopeId: ScopeId,
  name: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  const memberTypes = memberTypeNamesByOwner(indexes);
  const seen = new Set<ScopeId>();
  for (
    let scope = indexes.scopeTree.getScope(scopeId);
    scope !== undefined && !seen.has(scope.id);
    scope = scope.parent === null ? undefined : indexes.scopeTree.getScope(scope.parent)
  ) {
    seen.add(scope.id);
    if (scope.kind !== 'Class') continue;
    const owner = scope.ownedDefs.find((def) => isClassLike(def.type));
    if (owner === undefined) continue;
    for (const ancestor of indexes.methodDispatch.mroFor(owner.nodeId))
      if (memberTypes.get(ancestor)?.has(name) === true) return true;
  }
  return false;
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

const namedTypesByFqnByIndexes = new WeakMap<
  ScopeResolutionIndexes,
  ReadonlyMap<string, readonly NamedType[]>
>();

/**
 * What an unclaimed qualifier root names through this file's on-demand
 * imports, which name lookup does not bind: one public workspace type, which
 * makes the spelling a member path; `package` when no imported package
 * declares that name; or `null` when the root is ambiguous, inaccessible, or
 * may be a member type a static import brings in (JLS 6.5.4.1, 7.5.2).
 * A single static import of that name also refuses.
 */
function onDemandQualifier(
  file: string,
  root: string,
  indexes: ScopeResolutionIndexes,
): NamedType | 'package' | null {
  const imports = importIndex(file);
  if (imports.staticSingleNames.has(root)) return null;
  const byFqn = namedTypesByFqnByIndexes.get(indexes);
  const matches: NamedType[] = [];
  for (const item of imports.onDemand) {
    const found = byFqn?.get(`${item.name}.${root}`) ?? [];
    if (found.length > 0 && item.static) return null;
    matches.push(...found);
  }
  if (matches.length === 0) return 'package';
  return matches.length === 1 && matches[0]!.public ? matches[0]! : null;
}

interface ImportIndex {
  readonly staticSingleNames: ReadonlySet<string>;
  readonly onDemand: readonly { readonly name: string; readonly static: boolean }[];
}
const importIndexes = new WeakMap<object, ImportIndex>();
const NO_IMPORTS: ImportIndex = { staticSingleNames: new Set(), onDemand: [] };

/** One pass over a file's imports, shared by every qualified spelling in it. */
function importIndex(file: string): ImportIndex {
  const facts = getJavaOverloadFacts(file);
  if (facts === undefined) return NO_IMPORTS;
  const cached = importIndexes.get(facts);
  if (cached !== undefined) return cached;
  const staticSingleNames = new Set<string>();
  const onDemand: ImportIndex['onDemand'][number][] = [];
  for (const item of facts.imports) {
    if (item.wildcard) onDemand.push(item);
    else if (item.static) staticSingleNames.add(item.name.slice(item.name.lastIndexOf('.') + 1));
  }
  const index = { staticSingleNames, onDemand };
  importIndexes.set(facts, index);
  return index;
}

/**
 * The FQN a dotted type spelling names at its own use site, or `null`.
 *
 * An unclaimed root is a package (`models.User`). A root that names one type
 * declared in this file and in scope here makes the rest member types of that
 * type (`Outer.Inner`). A member type's name is also bound at file level, so
 * that binding is ignored outside the type that declares it, unless the use
 * site may inherit it. A root that names one type from another file (a
 * same-package type or an import, on-demand included) is a type too, so
 * `prefix.User` is the member type even when a package `prefix` declares a
 * `User`. Each reference answers for itself, so one shadowed spelling
 * elsewhere in the file cannot refuse another.
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
  if (claim.status === 'absent') {
    const imported = onDemandQualifier(file, root, indexes);
    return imported === 'package'
      ? spelling
      : imported === null || inheritsJavaMemberTypeNamed(ref.declaredAtScope, root, indexes)
        ? null
        : `${imported.fqn}${spelling.slice(root.length)}`;
  }
  const owners = new Set(claim.bindings.map((binding) => binding.def));
  const [owner] = owners;
  if (claim.status !== 'resolved' || owners.size !== 1 || owner === undefined) return null;
  const named = namedTypesByIndexes.get(indexes)?.get(owner.nodeId);
  if (named === undefined) return null;
  const scope = ref.declaredAtScope;
  if (owner.filePath !== file) {
    // A type from another file is in scope here only through the file level:
    // a same-package type or a single-type import. It still shadows a package
    // of that name (JLS 6.5.4.1), unless an enclosing class inherits a member
    // type of that name. Mirrors `qualifierRoot` in overload-resolution.ts.
    return claim.scope?.kind === 'Module' &&
      claim.bindings.every((binding) => binding.origin !== 'local') &&
      !inheritsJavaMemberTypeNamed(scope, root, indexes)
      ? `${named.fqn}${spelling.slice(root.length)}`
      : null;
  }
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
  const namedTypesByFqn = new Map<string, NamedType[]>();
  for (const parsed of parsedFiles) {
    const pkg = getJavaPackageFact(parsed.filePath);
    if (pkg?.status !== 'known') continue;
    for (const { def, ...named } of collectNamedTypes(parsed, pkg.packageName).values()) {
      namedTypes.set(def.nodeId, named);
      const sameName = namedTypesByFqn.get(named.fqn) ?? [];
      sameName.push(named);
      namedTypesByFqn.set(named.fqn, sameName);
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
  namedTypesByFqnByIndexes.set(indexes, namedTypesByFqn);
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
  const bindings =
    scope === undefined ? undefined : indexes.bindingAugmentations.get(scope.id)?.get(key);
  if (bindings?.length !== 1) return null;
  // The module-level binding serves every use in the file. A private type on
  // the path is accessible only inside its own top-level type's body, not from
  // another top-level type in the same file (JLS 6.6.1).
  const named = namedTypesByIndexes.get(indexes)?.get(bindings[0]!.def.nodeId);
  return named?.private !== true ||
    ref.declaredAtScope === named.topLevelScope ||
    indexes.scopeTree.getAncestors(ref.declaredAtScope).includes(named.topLevelScope)
    ? key
    : null;
}
