import type {
  BindingRef,
  NameClaimResult,
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
import {
  hasJavaSamePackageType,
  isJavaPackageSiblingVisibilityIncomplete,
} from './package-siblings.js';
import { javaImportedSpellingFacts, javaReturnElementFacts } from './capture-side-channel.js';
import { javaReturnElementRef, type JavaImportedSpellingFact } from './declared-type-captures.js';

/** A top-level or member type, the only kinds a type spelling can name. */
interface NamedType {
  readonly fqn: string;
  /** The package of the file that declares it. */
  readonly packageName: string;
  /** The supertypes it names (`extends` / `implements`), type arguments
   * erased. Without one, it inherits no member type: `Object`, `Enum` and
   * `Record` declare none. */
  readonly bases: readonly string[];
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
      packageName,
      bases: fact.bases.map((base) => eraseJavaTypeArguments(base).replaceAll(/\s+/g, '')),
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

interface MemberTypeNames {
  /** Owner def id, then member type simple name, then the member types' def ids. */
  readonly byOwner: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** Every member type name in the workspace, so most roots skip the walk. */
  readonly all: ReadonlySet<string>;
}

const memberTypeNamesByIndexes = new WeakMap<ScopeResolutionIndexes, MemberTypeNames>();

/** The member types each workspace class declares, by simple name. */
function memberTypeNamesByOwner(indexes: ScopeResolutionIndexes): MemberTypeNames {
  const cached = memberTypeNamesByIndexes.get(indexes);
  if (cached !== undefined) return cached;
  const byOwner = new Map<string, Map<string, string[]>>();
  const all = new Set<string>();
  for (const def of indexes.defs.byId.values()) {
    if (def.ownerId === undefined || !(isClassLike(def.type) || def.type === 'Annotation'))
      continue;
    const spelling = def.qualifiedName ?? def.nodeId;
    const name = spelling.slice(Math.max(spelling.lastIndexOf('.'), spelling.lastIndexOf(':')) + 1);
    let owned = byOwner.get(def.ownerId);
    if (owned === undefined) byOwner.set(def.ownerId, (owned = new Map()));
    const ids = owned.get(name);
    if (ids === undefined) owned.set(name, [def.nodeId]);
    else ids.push(def.nodeId);
    all.add(name);
  }
  const names = { byOwner, all };
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
  if (!memberTypes.all.has(name)) return false;
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
      if (memberTypes.byOwner.get(ancestor)?.has(name) === true) return true;
  }
  return false;
}

/** A member type that an enclosing class inherits under a qualifier root. */
export interface JavaInheritedMemberType {
  readonly id: string;
  readonly fqn: string;
  /** Index of the inheriting class in the enclosing-class list. */
  readonly depth: number;
}

/**
 * The member type named `name` that the nearest enclosing class inherits
 * (JLS 8.5), which shadows every file- and package-level type and every
 * package of that name in that class's body (JLS 6.4.1). `classes` lists the
 * class def ids enclosing the use site, innermost first; `undefined` marks a
 * class this index has no definition for.
 *
 * Returns `undefined` when no enclosing class inherits a workspace member type
 * of that name, or when a nearer class declares one itself (lexical lookup
 * answers that). Returns `null` when the reading is not provable: two
 * declarations are inherited, the member type is private or not accessible
 * from the use site's package, the supertype that declares it is not reached
 * through the supertypes the classes on the way actually name (an `extends
 * lib.Base` outside the workspace is not `app.Base`), or a nearer class may
 * inherit an unseen type of that name (a class without a definition, or one
 * that names a supertype yet inherits no workspace member type of that name).
 */
export function javaInheritedMemberType(
  classes: readonly (string | undefined)[],
  name: string,
  filePath: string,
  indexes: ScopeResolutionIndexes,
): JavaInheritedMemberType | null | undefined {
  const memberTypes = memberTypeNamesByOwner(indexes);
  if (!memberTypes.all.has(name)) return undefined;
  const namedTypes = namedTypesByIndexes.get(indexes);
  let nearerUnknown = false;
  for (const [depth, classId] of classes.entries()) {
    if (classId === undefined) {
      nearerUnknown = true;
      continue;
    }
    if (memberTypes.byOwner.get(classId)?.has(name) === true) return undefined;
    // Member type def id -> the supertype that declares it.
    const inherited = new Map<string, string>();
    for (const ancestor of indexes.methodDispatch.mroFor(classId))
      for (const id of memberTypes.byOwner.get(ancestor)?.get(name) ?? [])
        inherited.set(id, ancestor);
    if (inherited.size === 0) {
      if (namedTypes?.get(classId)?.bases.length !== 0) nearerUnknown = true;
      continue;
    }
    if (nearerUnknown || inherited.size !== 1 || namedTypes === undefined) return null;
    const [[id, declaringOwner]] = inherited;
    const named = namedTypes.get(id);
    if (named === undefined || named.private) return null;
    if (!named.public) {
      const pkg = getJavaPackageFact(filePath);
      if (pkg?.status !== 'known' || pkg.packageName !== named.packageName) return null;
    }
    if (!reachesThroughWrittenBases(classId, declaringOwner, namedTypes, indexes)) return null;
    return { id, fqn: named.fqn, depth };
  }
  return undefined;
}

/** Whether `ancestorId` is reached from `classId` one written supertype at a
 * time: each step goes to an MRO entry whose FQN the class's own base spelling
 * names (in full, or as a suffix such as `Base` or `Outer.Base`). */
function reachesThroughWrittenBases(
  classId: string,
  ancestorId: string,
  namedTypes: ReadonlyMap<string, NamedType>,
  indexes: ScopeResolutionIndexes,
): boolean {
  const pending = [classId];
  const seen = new Set(pending);
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current === ancestorId) return true;
    const bases = namedTypes.get(current)?.bases ?? [];
    if (bases.length === 0) continue;
    for (const parent of indexes.methodDispatch.mroFor(current)) {
      const fqn = namedTypes.get(parent)?.fqn;
      if (
        fqn === undefined ||
        seen.has(parent) ||
        !bases.some((base) => fqn === base || fqn.endsWith(`.${base}`))
      )
        continue;
      seen.add(parent);
      pending.push(parent);
    }
  }
  return false;
}

/** `javaInheritedMemberType` for the classes enclosing a scope, with the
 * inheriting class's scope. */
function inheritedMemberTypeAt(
  scopeId: ScopeId,
  name: string,
  filePath: string,
  indexes: ScopeResolutionIndexes,
): (JavaInheritedMemberType & { readonly scope: ScopeId }) | null | undefined {
  if (!memberTypeNamesByOwner(indexes).all.has(name)) return undefined;
  const classes: (string | undefined)[] = [];
  const classScopes: ScopeId[] = [];
  const seen = new Set<ScopeId>();
  for (
    let scope = indexes.scopeTree.getScope(scopeId);
    scope !== undefined && !seen.has(scope.id);
    scope = scope.parent === null ? undefined : indexes.scopeTree.getScope(scope.parent)
  ) {
    seen.add(scope.id);
    if (scope.kind !== 'Class') continue;
    classes.push(scope.ownedDefs.find((def) => isClassLike(def.type))?.nodeId);
    classScopes.push(scope.id);
  }
  const found = javaInheritedMemberType(classes, name, filePath, indexes);
  if (found === null) return null;
  if (found === undefined) return undefined;
  return { ...found, scope: classScopes[found.depth]! };
}

/**
 * Whether a static on-demand import of `owner` (JLS 7.5.4) is known to bring
 * in no type named `name`. It imports every accessible static member type of
 * that owner, inherited ones included, so only a single workspace owner that
 * names no supertype and declares no member type of that name is known.
 */
export function javaStaticOnDemandImportBringsNoType(
  owner: string,
  name: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  const byFqn = namedTypesByFqnByIndexes.get(indexes);
  const owners = byFqn?.get(owner) ?? [];
  return (
    owners.length === 1 &&
    owners[0]!.bases.length === 0 &&
    (byFqn?.get(`${owner}.${name}`)?.length ?? 0) === 0
  );
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

/** Per file, how each dotted element spelling is read at its binding anchor. */
const importedSpellingsByIndexes = new WeakMap<
  ScopeResolutionIndexes,
  ReadonlyMap<string, ReadonlyMap<string, JavaImportedSpellingFact['status']>>
>();

const importedSpellingKey = (line: number, col: number, spelling: string): string =>
  `${line}:${col}:${spelling}`;

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
 * A single static import of that name also refuses, and so does a static
 * on-demand import whose owner may bring in a type of that name: an owner
 * outside the workspace, or one whose member types are not all known.
 * Mirrors `qualifierRoot` in overload-resolution.ts.
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
    if (item.static) {
      if (!javaStaticOnDemandImportBringsNoType(item.name, root, indexes)) return null;
      continue;
    }
    matches.push(...(byFqn?.get(`${item.name}.${root}`) ?? []));
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

const NO_CLAIM: NameClaimResult = { status: 'absent', bindings: [], imports: [], claims: [] };

/** A declaration that can name a type, the only kind a qualifier root of a
 * type spelling can resolve to. */
const isJavaTypeDefinition = (definition: SymbolDefinition): boolean =>
  isClassLike(definition.type) || definition.type === 'Annotation';

/**
 * Name lookup for the first identifier of a qualified type spelling. In a
 * type, the qualifier of `Q.Id` is a PackageOrTypeName (JLS 6.5.4.1, 6.5.5.2):
 * only types and packages compete for it, and a variable never obscures it
 * (JLS 6.4.2 covers ambiguous expression names only). So a scope where the
 * name is only a field, parameter, local, lambda parameter, record component or
 * method is passed over, and a scope that binds a type of that name as well
 * keeps only the type. Any scope that claims or imports the name, or binds it
 * to a type, answers as before. Each retry starts outside the scope that
 * answered, so it runs at most once per enclosing scope.
 */
function lookupQualifierRootClaim(
  scopeId: ScopeId,
  root: string,
  indexes: ScopeResolutionIndexes,
  position: TypeRef['lookupPosition'],
): NameClaimResult {
  const seen = new Set<ScopeId>();
  for (let start: ScopeId | null = scopeId; start !== null && !seen.has(start); ) {
    seen.add(start);
    const claim = lookupNameClaim(start, root, indexes, { purpose: 'type', position });
    const scope = claim.scope;
    // A scope also owns a name through a variable's own type fact or lexical
    // name with no binding (`blocked`): that is a value too.
    if (
      claim.status === 'absent' ||
      scope === undefined ||
      claim.imports.length > 0 ||
      claim.claims.length > 0
    )
      return claim;
    const types = claim.bindings.filter((binding) => isJavaTypeDefinition(binding.def));
    if (types.length > 0)
      return types.length === claim.bindings.length ? claim : { ...claim, bindings: types };
    start = scope.lookupPolicy?.parentScope ?? scope.parent;
  }
  return NO_CLAIM;
}

/**
 * The FQN a dotted type spelling names at its own use site, or `null`.
 *
 * A root that an enclosing class inherits as a member type names that member
 * type (`models.User` in a subclass of `Base` is `Base.models.User`); an
 * ambiguous, inaccessible or unprovable inherited reading refuses. Otherwise
 * an unclaimed root is a package (`models.User`). A root that names one type
 * declared in this file and in scope here makes the rest member types of that
 * type (`Outer.Inner`). A member type's name is also bound at file level, so
 * that binding is ignored outside the type that declares it, unless the use
 * site may inherit it. A root that names one type from another file (a
 * same-package type or an import, on-demand included) is a type too, so
 * `prefix.User` is the member type even when a package `prefix` declares a
 * `User`. Each reference answers for itself, so one shadowed spelling
 * elsewhere in the file cannot refuse another.
 *
 * An inferred element written as a simple name that a single-type import
 * brings in is spelled with the import's canonical name instead. That spelling
 * is never looked up here: it names the imported type (see
 * `JavaImportedSpellingFact`).
 */
function qualifiedTypeKey(
  ref: TypeRef,
  spelling: string,
  indexes: ScopeResolutionIndexes,
): string | null {
  const root = spelling.split('.')[0]!;
  const file = indexes.scopeTree.getScope(ref.declaredAtScope)?.filePath;
  const position = ref.lookupPosition;
  const imported =
    file === undefined || position === undefined
      ? undefined
      : importedSpellingsByIndexes
          .get(indexes)
          ?.get(file)
          ?.get(importedSpellingKey(position.startLine, position.startCol, spelling));
  if (imported === 'ambiguous') return null;
  // A single-type import's canonical name: no type in scope where the element
  // was written renames its root. Only an inherited member type of the simple
  // name shadows the import there (JLS 6.4.1), which refuses.
  if (imported === 'import')
    return inheritsJavaMemberTypeNamed(
      ref.declaredAtScope,
      spelling.slice(spelling.lastIndexOf('.') + 1),
      indexes,
    )
      ? null
      : spelling;
  if (
    file === undefined ||
    bindsTypeParameter(ref.declaredAtScope, root, indexes) ||
    // Sibling injection is capped for cost and skips very large packages, so
    // the lookup below may miss a same-package type named `root`. Sibling
    // injection binds nothing else, so the lookup is exact for a name the
    // uncapped package index does not hold.
    (isJavaPackageSiblingVisibilityIncomplete(file) && hasJavaSamePackageType(file, root) !== false)
  )
    return null;
  const claim = lookupQualifierRootClaim(ref.declaredAtScope, root, indexes, ref.lookupPosition);
  const scope = ref.declaredAtScope;
  // Name lookup binds no inherited member type, yet one shadows every type
  // and package of that name from farther out (JLS 6.4.1): the spelling is a
  // member path of the supertype that declares it. A claim at or inside the
  // inheriting class is nearer and keeps its reading below. Mirrors
  // `qualifierRoot` in overload-resolution.ts.
  const inherited = inheritedMemberTypeAt(scope, root, file, indexes);
  if (inherited === null) return null;
  if (inherited !== undefined) {
    if (claim.status === 'absent') return `${inherited.fqn}${spelling.slice(root.length)}`;
    if (claim.scope === undefined) return null;
    if (
      claim.scope.id !== inherited.scope &&
      !indexes.scopeTree.getAncestors(claim.scope.id).includes(inherited.scope)
    )
      return `${inherited.fqn}${spelling.slice(root.length)}`;
  }
  if (claim.status === 'absent') {
    const imported = onDemandQualifier(file, root, indexes);
    return imported === 'package'
      ? spelling
      : imported === null
        ? null
        : `${imported.fqn}${spelling.slice(root.length)}`;
  }
  const owners = new Set(claim.bindings.map((binding) => binding.def));
  const [owner] = owners;
  if (claim.status !== 'resolved' || owners.size !== 1 || owner === undefined) return null;
  const named = namedTypesByIndexes.get(indexes)?.get(owner.nodeId);
  if (named === undefined) return null;
  if (owner.filePath !== file) {
    // A type from another file is in scope here only through the file level:
    // a same-package type or a single-type import. It still shadows a package
    // of that name (JLS 6.5.4.1). An inherited member type of that name was
    // read above; any other inheritance of it refuses. Mirrors `qualifierRoot`
    // in overload-resolution.ts.
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
  const importedSpellings = new Map<string, Map<string, JavaImportedSpellingFact['status']>>();
  for (const parsed of parsedFiles) {
    const facts = javaImportedSpellingFacts(parsed);
    if (facts.length > 0)
      importedSpellings.set(
        parsed.filePath,
        new Map(
          facts.map((fact) => [
            importedSpellingKey(fact.line, fact.col, fact.spelling),
            fact.status,
          ]),
        ),
      );
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
  importedSpellingsByIndexes.set(indexes, importedSpellings);
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
