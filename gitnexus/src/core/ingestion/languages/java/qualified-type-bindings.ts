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
import {
  JAVA_PLATFORM_OWNERS_WITHOUT_MEMBER_TYPES,
  splitJavaTypeArguments,
} from './overload-types.js';
import { eraseJavaTypeArguments, JAVA_IDENTIFIER } from './type-spelling.js';
import {
  hasJavaSamePackageType,
  isJavaPackageSiblingVisibilityIncomplete,
} from './package-siblings.js';
import { javaImportedSpellingFacts, javaReturnElementFacts } from './capture-side-channel.js';
import { javaReturnElementRef, type JavaImportedSpellingFact } from './declared-type-captures.js';
import { populateJavaInheritedFieldTypes, type DirectParents } from './inherited-field-types.js';

/** A top-level, member or local type with a source declaration. */
interface NamedType {
  /** Qualified lookup key. A local declaration roots this key in its unique node ID. */
  readonly fqn: string;
  /** A local class or its member's source spelling, separate from its declaration key. */
  readonly localSpelling?: string;
  /** The package of the file that declares it. */
  readonly packageName: string;
  /** The supertypes it names (`extends` / `implements`), type arguments
   * erased. Without one, it inherits no member type: `Object`, `Enum` and
   * `Record` declare none. */
  readonly bases: readonly string[];
  /** The scope containing the declaration. */
  readonly enclosingScope: ScopeId;
  /** The enclosing type's def; absent for a top-level type. */
  readonly ownerId?: string;
  /** Its own access: the modifier written, or the `public` an interface or
   * annotation member implies (the type facts add it, JLS 9.5), or package
   * access when none applies. */
  readonly access: 'public' | 'protected' | 'package' | 'private';
  /** Every type on the path from the package is `public`. */
  readonly public: boolean;
  /** Some type on the path from the package is `private`. */
  readonly private: boolean;
  /** Some type on the path from the package has package access, so only its
   * own package reaches it. */
  readonly packageAccess: boolean;
  /** The enclosing type of each `protected` type on the path. From another
   * package such a type is accessible only in the body of a subclass of that
   * enclosing type (JLS 6.6.2.1). */
  readonly protectedOwners: readonly string[];
  /** The type is `static`, written or implied: top-level, or a member enum,
   * record, interface or annotation, or a member of an interface (JLS 8.5.1,
   * 9.5). Only a static member type can be statically imported (JLS 7.5.3). */
  readonly static: boolean;
  /** The class scope of the top-level type this one is declared in (itself
   * when top-level): the only body where a private type on the path is
   * accessible (JLS 6.6.1). */
  readonly topLevelScope: ScopeId;
}

const namedTypesByIndexes = new WeakMap<ScopeResolutionIndexes, ReadonlyMap<string, NamedType>>();

interface ClassHierarchy {
  readonly name: string;
  readonly bases: readonly string[];
}
const hierarchiesByIndexes = new WeakMap<
  ScopeResolutionIndexes,
  ReadonlyMap<string, ClassHierarchy>
>();

/** Index named types by scope. A local type uses its declaration identity as
 * a private lookup key so two blocks can each declare the same member path. */
function namedTypeIdentity(local: boolean, id: string, prefix: string, name: string): string {
  if (local) return `\0${id}`;
  return prefix ? `${prefix}.${name}` : name;
}

function collectNamedTypes(
  parsed: ParsedFile,
  packageName: string,
  hierarchies: Map<string, ClassHierarchy>,
): Map<ScopeId, NamedType & { readonly def: SymbolDefinition }> {
  const result = new Map<ScopeId, NamedType & { readonly def: SymbolDefinition }>();
  const facts = getJavaOverloadFacts(parsed.filePath)?.types;
  const module = parsed.scopes.find((scope) => scope.kind === 'Module');
  if (facts === undefined || module === undefined) return result;
  const byId = new Map<ScopeId, Scope>(parsed.scopes.map((scope) => [scope.id, scope]));
  // Anonymous class scopes start at the body instead of the creation
  // expression. Both the scope and the type fact end at the closing brace.
  const declarations = new Map<string, (typeof facts)[number]>();
  for (const type of facts) {
    const key = `${type.range.endLine}:${type.range.endCol}`;
    if (!declarations.has(key)) declarations.set(key, type);
  }
  // Declaration kind per resolved scope, so a member type sees its owner's.
  const kinds = new Map<ScopeId, string>();
  const resolve = (scope: Scope): (NamedType & { readonly def: SymbolDefinition }) | undefined => {
    const known = result.get(scope.id);
    if (known !== undefined || scope.kind !== 'Class' || scope.parent === null) return known;
    const def = scope.ownedDefs.find((item) => isClassLike(item.type));
    const fact = declarations.get(`${scope.range.endLine}:${scope.range.endCol}`);
    if (def === undefined || fact === undefined) return undefined;
    const bases = fact.bases.map((base) => eraseJavaTypeArguments(base).replaceAll(/\s+/g, ''));
    hierarchies.set(def.nodeId, { name: fact.simpleName, bases });
    if (def.qualifiedName === undefined || !fact.kind.endsWith('_declaration')) return undefined;
    const parent = byId.get(scope.parent);
    const owner = scope.parent === module.id || parent === undefined ? undefined : resolve(parent);
    const local = scope.parent !== module.id && owner === undefined;
    if (local && (!parent || parent.kind === 'Class')) return undefined;
    const modifiers = fact.modifiers ?? [];
    const prefix = owner?.fqn ?? packageName;
    let localSpelling: string | undefined;
    if (local) localSpelling = fact.simpleName;
    else if (owner?.localSpelling !== undefined)
      localSpelling = `${owner.localSpelling}.${fact.simpleName}`;
    const ownerKind = owner === undefined ? undefined : kinds.get(scope.parent);
    const access: NamedType['access'] =
      (['public', 'protected', 'private'] as const).find((modifier) =>
        modifiers.includes(modifier),
      ) ?? 'package';
    kinds.set(scope.id, fact.kind);
    const named: NamedType & { readonly def: SymbolDefinition } = {
      def,
      fqn: namedTypeIdentity(local, def.nodeId, prefix, fact.simpleName),
      ...(localSpelling === undefined ? {} : { localSpelling }),
      packageName,
      bases,
      enclosingScope: scope.parent,
      ...(owner === undefined ? {} : { ownerId: owner.def.nodeId }),
      access,
      public: (owner?.public ?? true) && access === 'public',
      private: (owner?.private ?? false) || access === 'private',
      packageAccess: (owner?.packageAccess ?? false) || access === 'package',
      protectedOwners:
        owner !== undefined && access === 'protected'
          ? [...owner.protectedOwners, owner.def.nodeId]
          : (owner?.protectedOwners ?? []),
      static:
        owner === undefined ||
        modifiers.includes('static') ||
        fact.kind !== 'class_declaration' ||
        ownerKind === 'interface_declaration' ||
        ownerKind === 'annotation_type_declaration',
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
  const hierarchies = hierarchiesByIndexes.get(indexes);
  for (const def of indexes.defs.byId.values()) {
    if (def.ownerId === undefined || !(isClassLike(def.type) || def.type === 'Annotation'))
      continue;
    const spelling = def.qualifiedName ?? def.nodeId;
    const name =
      hierarchies?.get(def.nodeId)?.name ??
      spelling.slice(Math.max(spelling.lastIndexOf('.'), spelling.lastIndexOf(':')) + 1);
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

/** Whether a class enclosing `scopeId` inherits a member type named `name`
 * (JLS 8.5), which shadows every file- and package-level type of that name, or
 * may: `inheritedMemberTypes` could not decide. A base outside the workspace
 * has no inventory, so it contributes none. */
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
    const inherited = inheritedMemberTypes(owner.nodeId, name, indexes);
    if (inherited === null || inherited.size > 0) return true;
  }
  return false;
}

const directSupertypesByIndexes = new WeakMap<
  ScopeResolutionIndexes,
  Map<string, readonly string[]>
>();

/** A class's direct supertypes in the workspace: the entries of its MRO that
 * no other entry has as an ancestor. Memoized per class. */
function directSupertypes(classId: string, indexes: ScopeResolutionIndexes): readonly string[] {
  let cache = directSupertypesByIndexes.get(indexes);
  if (cache === undefined) directSupertypesByIndexes.set(indexes, (cache = new Map()));
  const cached = cache.get(classId);
  if (cached !== undefined) return cached;
  const mro = indexes.methodDispatch.mroFor(classId);
  const above = new Set<string>();
  for (const ancestor of mro)
    for (const higher of indexes.methodDispatch.mroFor(ancestor)) above.add(higher);
  const direct = mro.filter((ancestor) => ancestor !== classId && !above.has(ancestor));
  cache.set(classId, direct);
  return direct;
}

/** Whether member type `id` passes from a supertype into class `classId`: it
 * is not private and code in `classId` can access it (JLS 8.5, 6.6). A
 * protected one always can, being reached by inheritance. A class-like
 * definition without a named-type entry in a file of known package is a local
 * or anonymous class, never a member. `undefined` when it cannot be told. */
function inheritedInto(
  id: string,
  classId: string,
  indexes: ScopeResolutionIndexes,
): boolean | undefined {
  const named = namedTypesByIndexes.get(indexes)?.get(id);
  if (named === undefined) {
    const file = indexes.defs.get(id)?.filePath;
    return file !== undefined && getJavaPackageFact(file)?.status === 'known' ? false : undefined;
  }
  if (named.access === 'public' || named.access === 'protected') return true;
  if (named.access === 'private') return false;
  const file = indexes.defs.get(classId)?.filePath;
  const pkg = file === undefined ? undefined : getJavaPackageFact(file);
  return pkg?.status === 'known' ? pkg.packageName === named.packageName : undefined;
}

const inheritedMemberTypesByIndexes = new WeakMap<
  ScopeResolutionIndexes,
  Map<string, ReadonlySet<string> | null>
>();

/**
 * The member types named `name` that class `classId` inherits (JLS 8.5): from
 * each direct supertype, the member types of that name visible there (its own
 * declaration, which hides every inherited one, or else what it inherits in
 * turn), less those that do not pass into `classId` (`inheritedInto`). A
 * private member type, or a package-access one of another package, is not
 * inherited at all, so it drops out instead of refusing. One declaration
 * reached through two supertypes counts once. `null` when this cannot be
 * decided. Memoized per class and name, so each pair reads its direct
 * supertypes once.
 */
function inheritedMemberTypes(
  classId: string,
  name: string,
  indexes: ScopeResolutionIndexes,
): ReadonlySet<string> | null {
  let cache = inheritedMemberTypesByIndexes.get(indexes);
  if (cache === undefined) inheritedMemberTypesByIndexes.set(indexes, (cache = new Map()));
  const key = `${classId}\u0000${name}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  // A cycle reads as undecidable.
  cache.set(key, null);
  const memberTypes = memberTypeNamesByOwner(indexes);
  const inherited = new Set<string>();
  for (const parent of directSupertypes(classId, indexes)) {
    const visible =
      memberTypes.byOwner.get(parent)?.get(name) ?? inheritedMemberTypes(parent, name, indexes);
    if (visible === null) return null;
    for (const id of visible) {
      const passes = inheritedInto(id, classId, indexes);
      if (passes === undefined) return null;
      if (passes) inherited.add(id);
    }
  }
  cache.set(key, inherited);
  return inherited;
}

/** A member type that an enclosing class inherits under a qualifier root. */
export interface JavaInheritedMemberType {
  readonly id: string;
  readonly fqn: string;
  /** Index of the inheriting class in the enclosing-class list. */
  readonly depth: number;
}

const unindexedBases = new WeakMap<ScopeResolutionIndexes, Map<string, boolean>>();

const writtenParentsByIndexes = new WeakMap<ScopeResolutionIndexes, Map<string, DirectParents>>();

/** A local type in scope at the declaration takes precedence over an import,
 * including when both types occur in the same superclass chain. */
function localBaseKey(
  base: string,
  root: string,
  scope: ScopeId,
  position: TypeRef['lookupPosition'],
  types: ReadonlyMap<string, NamedType>,
  indexes: ScopeResolutionIndexes,
): string | undefined {
  const claim = lookupJavaTypeNameClaim(scope, root, indexes, position);
  const first = claim.bindings[0]?.def;
  if (
    claim.status !== 'resolved' ||
    !first ||
    claim.bindings.some(({ def }) => def.nodeId !== first.nodeId)
  )
    return undefined;
  const local = types.get(first.nodeId);
  return local?.localSpelling === undefined ? undefined : local.fqn + base.slice(root.length);
}

/** Match the direct bases written in the declaration to resolved ancestors.
 * A redundant direct interface still supplies its own path (JLS 8.3). */
function writtenJavaParents(classId: string, indexes: ScopeResolutionIndexes): DirectParents {
  let cache = writtenParentsByIndexes.get(indexes);
  if (cache === undefined) writtenParentsByIndexes.set(indexes, (cache = new Map()));
  const cached = cache.get(classId);
  if (cached !== undefined) return cached;
  const hierarchies = hierarchiesByIndexes.get(indexes);
  const type = hierarchies?.get(classId);
  const definition = indexes.defs.get(classId);
  const file = definition?.filePath;
  if (type === undefined || file === undefined)
    return { ids: directSupertypes(classId, indexes), complete: false };
  const ids: string[] = [];
  let complete = true;
  if (type.bases.length > 0) {
    const types = namedTypesByIndexes.get(indexes);
    const ancestors = new Map<string, string | null>();
    for (const id of indexes.methodDispatch.mroFor(classId)) {
      const ancestor = types?.get(id);
      const fqn = ancestor?.localSpelling ?? ancestor?.fqn ?? hierarchies?.get(id)?.name;
      if (fqn === undefined || id === classId) continue;
      if (ancestor?.localSpelling !== undefined) ancestors.set(ancestor.fqn, id);
      for (let start = 0; start < fqn.length; ) {
        const spelling = fqn.slice(start);
        const previous = ancestors.get(spelling);
        ancestors.set(spelling, previous === undefined || previous === id ? id : null);
        const dot = fqn.indexOf('.', start);
        if (dot === -1) break;
        start = dot + 1;
      }
    }
    const declaration = types?.get(classId);
    for (const base of type.bases) {
      const root = base.split('.')[0]!;
      const local =
        declaration?.localSpelling !== undefined && types
          ? localBaseKey(
              base,
              root,
              declaration.enclosingScope,
              definition?.declarationRange,
              types,
              indexes,
            )
          : undefined;
      const imports = local === undefined ? importIndex(file).single.get(root) : undefined;
      if (imports !== undefined && imports.length !== 1) {
        complete = false;
        continue;
      }
      const written =
        local ?? (imports === undefined ? base : imports[0]!.name + base.slice(root.length));
      const ancestor = ancestors.get(written);
      if (ancestor === undefined && written === 'java.lang.Object') continue;
      if (ancestor == null || (imports !== undefined && types?.get(ancestor)?.fqn !== written))
        complete = false;
      else ids.push(ancestor);
    }
  }
  const result = { ids, complete };
  cache.set(classId, result);
  return result;
}

/** A dotted name may start with a member type of an unseen base. Check each
 * written supertype against the workspace hierarchy, once per class. */
export function hasUnindexedBase(classId: string, indexes: ScopeResolutionIndexes): boolean {
  let cache = unindexedBases.get(indexes);
  if (cache === undefined) unindexedBases.set(indexes, (cache = new Map()));
  const known = cache.get(classId);
  if (known !== undefined) return known;
  cache.set(classId, true); // Cycles cannot prove a complete hierarchy.
  const parents = writtenJavaParents(classId, indexes);
  const missing = !parents.complete || parents.ids.some((id) => hasUnindexedBase(id, indexes));
  cache.set(classId, missing);
  return missing;
}

/**
 * The member type named `name` that the nearest enclosing class inherits
 * (JLS 8.5), which shadows every file- and package-level type and every
 * package of that name in that class's body (JLS 6.4.1). `classes` lists the
 * class def ids enclosing the use site, innermost first; `undefined` marks a
 * class this index has no definition for. What a class inherits is read per
 * direct supertype (`inheritedMemberTypes`): `Builder` in `C extends B` is
 * `B.Builder` when `B` declares one hiding `A.Builder`, a protected member
 * type is inherited by a subclass in any package, and a private or
 * other-package package-access one is not inherited at all.
 *
 * Returns `undefined` when no enclosing class inherits a workspace member type
 * of that name, or when a nearer class declares one itself (lexical lookup
 * answers that). Returns `null` when the reading is not provable: two distinct
 * declarations are inherited, what a class inherits cannot be decided, the
 * supertype that declares it is not reached through the supertypes the classes
 * on the way actually name (an `extends lib.Base` outside the workspace is not
 * `app.Base`), or a nearer class may inherit an unseen type of that name (a
 * class without a definition, or one that names a supertype yet inherits no
 * workspace member type of that name).
 */
export function javaInheritedMemberType(
  classes: readonly (string | undefined)[],
  name: string,
  indexes: ScopeResolutionIndexes,
  checkUnindexedBases = false,
): JavaInheritedMemberType | null | undefined {
  const memberTypes = memberTypeNamesByOwner(indexes);
  const hasMember = memberTypes.all.has(name);
  if (!hasMember && !checkUnindexedBases) return undefined;
  const namedTypes = namedTypesByIndexes.get(indexes);
  let nearerUnknown = false;
  for (const [depth, classId] of classes.entries()) {
    if (classId === undefined) {
      if (checkUnindexedBases) return null;
      nearerUnknown = true;
      continue;
    }
    if (memberTypes.byOwner.get(classId)?.has(name) === true) return undefined;
    if (checkUnindexedBases && hasUnindexedBase(classId, indexes)) return null;
    if (!hasMember) continue;
    const inherited = inheritedMemberTypes(classId, name, indexes);
    if (inherited === null) return null;
    if (inherited.size === 0) {
      if (namedTypes?.get(classId)?.bases.length !== 0) nearerUnknown = true;
      continue;
    }
    if (nearerUnknown || inherited.size !== 1 || namedTypes === undefined) return null;
    const [id] = inherited;
    const named = id === undefined ? undefined : namedTypes.get(id);
    if (id === undefined || named?.ownerId === undefined) return null;
    if (!reachesThroughWrittenBases(classId, named.ownerId, namedTypes, indexes)) return null;
    return { id, fqn: named.fqn, depth };
  }
  return undefined;
}

/** Follow the declared supertypes to the owner of an inherited member type. */
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
    const type = namedTypes.get(current);
    if (!type?.bases.length) continue;
    // Local class names need lexical identity. For package and member types,
    // an MRO can contain multiple qualified declarations with the written suffix.
    const parents =
      type.localSpelling !== undefined
        ? writtenJavaParents(current, indexes).ids
        : indexes.methodDispatch.mroFor(current).filter((id) => {
            const fqn = namedTypes.get(id)?.fqn;
            return (
              fqn !== undefined &&
              type.bases.some((base) => fqn === base || fqn.endsWith(`.${base}`))
            );
          });
    for (const parent of parents) {
      if (seen.has(parent)) continue;
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
  indexes: ScopeResolutionIndexes,
  checkUnindexedBases: boolean,
): (JavaInheritedMemberType & { readonly scope: ScopeId }) | null | undefined {
  if (!checkUnindexedBases && !memberTypeNamesByOwner(indexes).all.has(name)) return undefined;
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
  const found = javaInheritedMemberType(classes, name, indexes, checkUnindexedBases);
  if (found === null) return null;
  if (found === undefined) return undefined;
  return { ...found, scope: classScopes[found.depth]! };
}

/**
 * Whether a static on-demand import of `owner` (JLS 7.5.4) is known to bring
 * in no type named `name`. It imports every accessible static member type of
 * that owner, inherited ones included. A workspace owner supplies its own
 * inventory. The platform Math class extends Object and exports no member types.
 */
export function javaStaticOnDemandImportBringsNoType(
  owner: string,
  name: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  const byFqn = namedTypesByFqnByIndexes.get(indexes);
  const owners = byFqn?.get(owner) ?? [];
  if (
    byFqn !== undefined &&
    owners.length === 0 &&
    JAVA_PLATFORM_OWNERS_WITHOUT_MEMBER_TYPES.has(owner)
  )
    return true;
  return (
    owners.length === 1 &&
    owners[0]!.bases.length === 0 &&
    !byFqn?.get(`${owner}.${name}`)?.some((member) => member.static)
  );
}

/**
 * What a single static import `import static p.Outer.Inner;` (`imported`)
 * brings into a type context under its simple name (JLS 7.5.3), for a use in
 * `filePath`. It imports the accessible static member type `Inner` of
 * `p.Outer`, which shadows a same-package or on-demand type of that name
 * (JLS 6.4.1); a static field or method of that name names no type
 * (JLS 6.5.5.2).
 *
 * Returns the member type when `p.Outer` is one workspace type that declares
 * exactly one static member type of that name, accessible from `filePath`
 * (public, or package access within its own package). Returns `none` when the
 * import provably brings no type: see `javaStaticOnDemandImportBringsNoType`.
 * Returns `null` otherwise: an owner outside the workspace, an owner whose
 * supertypes may supply an inherited member type, or an inaccessible one.
 * Mirrored by `qualifierRoot` in overload-resolution.ts.
 */
export function javaStaticSingleImportType(
  imported: string,
  filePath: string,
  indexes: ScopeResolutionIndexes,
): { readonly fqn: string } | 'none' | null {
  const dot = imported.lastIndexOf('.');
  if (dot < 0) return null;
  const owner = imported.slice(0, dot);
  const byFqn = namedTypesByFqnByIndexes.get(indexes);
  if (byFqn?.get(owner)?.length !== 1) return null;
  const members = byFqn.get(imported) ?? [];
  if (members.length === 0)
    return javaStaticOnDemandImportBringsNoType(owner, imported.slice(dot + 1), indexes)
      ? 'none'
      : null;
  const [member] = members;
  if (members.length !== 1 || member?.ownerId === undefined || !member.static) return null;
  if (member.public) return member;
  const pkg = getJavaPackageFact(filePath);
  return !member.private && pkg?.status === 'known' && pkg.packageName === member.packageName
    ? member
    : null;
}

/**
 * The FQN of the member type named `name` that a class enclosing `ref`'s
 * anchor inherits (JLS 8.5), when no declaration at or inside that class is
 * nearer: such a member type shadows every same-file, imported and
 * same-package type of that name, and any package of that name, in the class
 * body (JLS 6.4.1). `undefined` when no class there inherits one or a nearer
 * declaration answers (a member of a class on the way, a local class); `null`
 * when the inherited reading is ambiguous, inaccessible or unprovable (see
 * `javaInheritedMemberType`). `claim` is the name lookup at the anchor when
 * the caller has it already. Without one, only the scopes from the anchor out
 * to the inheriting class are read (`bindsTypeWithin`): the file level, where
 * every member type in the file is bound, is never nearer, and reading its
 * bindings on every use would grow with the file.
 */
function inheritedTypeReading(
  ref: TypeRef,
  name: string,
  indexes: ScopeResolutionIndexes,
  claim?: NameClaimResult,
): string | null | undefined {
  const inherited = inheritedMemberTypeAt(
    ref.declaredAtScope,
    name,
    indexes,
    claim?.status === 'absent' || claim?.scope?.kind === 'Module',
  );
  if (inherited === null) return null;
  if (inherited === undefined) return undefined;
  if (claim === undefined)
    return bindsTypeWithin(ref.declaredAtScope, inherited.scope, name, indexes)
      ? undefined
      : inherited.fqn;
  if (claim.status === 'absent') return inherited.fqn;
  if (claim.scope === undefined) return null;
  return claim.scope.id === inherited.scope ||
    indexes.scopeTree.getAncestors(claim.scope.id).includes(inherited.scope)
    ? undefined
    : inherited.fqn;
}

/**
 * Whether a scope from `scopeId` out to `boundary` (inclusive) binds a type
 * named `name`, such as a local class, which is nearer than a member type the
 * class of `boundary` inherits. A binding of another kind never names a type
 * (JLS 6.5.5.1). Positions are not read, so a local class declared after the
 * use also counts and leaves the name to the ordinary lookup.
 */
function bindsTypeWithin(
  scopeId: ScopeId,
  boundary: ScopeId,
  name: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  const seen = new Set<ScopeId>();
  for (
    let scope = indexes.scopeTree.getScope(scopeId);
    scope !== undefined && !seen.has(scope.id);
    scope = scope.parent === null ? undefined : indexes.scopeTree.getScope(scope.parent)
  ) {
    seen.add(scope.id);
    for (const bindings of [
      scope.bindings.get(name),
      indexes.bindings.get(scope.id)?.get(name),
      indexes.bindingAugmentations.get(scope.id)?.get(name),
    ])
      if (bindings?.some((binding) => isJavaTypeDefinition(binding.def)) === true) return true;
    if (scope.id === boundary) return false;
  }
  return false;
}

/** Sources whose `rawName` (or `declaredSpelling`) is spelled where the
 * binding was declared, so it means what it means at `declaredAtScope`. */
const WRITTEN_TYPE_SOURCES: ReadonlySet<TypeRef['source']> = new Set([
  'annotation',
  'parameter-annotation',
  'return-annotation',
  'constructor-inferred',
]);
/** A bare identifier: no qualifier, array dimension or type annotation. */
const SIMPLE_TYPE_NAME = /^[^.[\]<>@]+$/u;

/**
 * The FQN the simple type name `name`, written at `ref`'s anchor, names
 * through an inherited member type, which the scope lookup does not bind:
 * `Nested` in `class Child extends g.Base` is `g.Base.Nested` even beside a
 * same-package or same-file `Nested` or a single-type import of one.
 * `undefined` leaves the name to the ordinary lookup, as it does for a type
 * parameter of that name or a spelling not written at the anchor; `null`
 * refuses it. Gated on the workspace's member type names, so most names cost
 * one set probe.
 */
function inheritedSimpleTypeKey(
  ref: TypeRef,
  name: string,
  indexes: ScopeResolutionIndexes,
): string | null | undefined {
  if (!WRITTEN_TYPE_SOURCES.has(ref.source) || !SIMPLE_TYPE_NAME.test(name)) return undefined;
  const key = inheritedTypeReading(ref, name, indexes);
  return key === undefined || bindsTypeParameter(ref.declaredAtScope, name, indexes)
    ? undefined
    : key;
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
 * What a qualifier root names through this file's single static import of
 * that name (JLS 7.5.3), a file-level declaration that shadows same-package
 * and on-demand types (JLS 6.4.1): the imported member type, which makes the
 * spelling a member path (`Inner.Nested` after `import static p.Outer.Inner;`
 * is `p.Outer.Inner.Nested`); `none` when the import provably brings in no
 * type, so the other file-level readings go on as if it were absent; `null`
 * when it may bring in a type this workspace cannot name, or two single
 * imports name the root; `undefined` when no single static import does. See
 * `javaStaticSingleImportType`. Mirrors `qualifierRoot` in
 * overload-resolution.ts.
 */
function staticImportQualifier(
  file: string,
  root: string,
  indexes: ScopeResolutionIndexes,
): { readonly fqn: string } | 'none' | null | undefined {
  const single = importIndex(file).single.get(root);
  if (single === undefined || !single.some((item) => item.static)) return undefined;
  return single.length === 1 ? javaStaticSingleImportType(single[0]!.name, file, indexes) : null;
}

/**
 * What an unclaimed qualifier root names through this file's on-demand
 * imports, which name lookup does not bind: one public workspace type, which
 * makes the spelling a member path; `package` when no imported package
 * declares that name; or `null` when the root is ambiguous, inaccessible, or
 * may be a member type a static import brings in (JLS 6.5.4.1, 7.5.2).
 * A static on-demand import whose owner may bring in a type of that name
 * refuses too: an owner outside the workspace, or one whose member types are
 * not all known. A single static import of the root is read before this, by
 * `staticImportQualifier`. Mirrors `qualifierRoot` in overload-resolution.ts.
 */
function onDemandQualifier(
  file: string,
  root: string,
  indexes: ScopeResolutionIndexes,
): NamedType | 'package' | null {
  const imports = importIndex(file);
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

interface ImportItem {
  /** The imported name in full: `p.Outer.Inner`, or `p` for `p.*`. */
  readonly name: string;
  readonly static: boolean;
}
interface ImportIndex {
  /** Single-type and single-static imports, by the simple name they import. */
  readonly single: ReadonlyMap<string, readonly ImportItem[]>;
  readonly onDemand: readonly ImportItem[];
}
const importIndexes = new WeakMap<object, ImportIndex>();
const NO_IMPORTS: ImportIndex = { single: new Map(), onDemand: [] };

/** One pass over a file's imports, shared by every qualified spelling in it. */
function importIndex(file: string): ImportIndex {
  const facts = getJavaOverloadFacts(file);
  if (facts === undefined) return NO_IMPORTS;
  const cached = importIndexes.get(facts);
  if (cached !== undefined) return cached;
  const single = new Map<string, ImportItem[]>();
  const onDemand: ImportItem[] = [];
  for (const item of facts.imports) {
    if (item.wildcard) {
      onDemand.push(item);
      continue;
    }
    const name = item.name.slice(item.name.lastIndexOf('.') + 1);
    const items = single.get(name);
    if (items === undefined) single.set(name, [item]);
    else items.push(item);
  }
  const index = { single, onDemand };
  importIndexes.set(facts, index);
  return index;
}

const NO_CLAIM: NameClaimResult = { status: 'absent', bindings: [], imports: [], claims: [] };

/** A declaration that can name a type, the only kind a name written in a
 * type can resolve to. */
const isJavaTypeDefinition = (definition: SymbolDefinition): boolean =>
  isClassLike(definition.type) || definition.type === 'Annotation';

/**
 * Name lookup for a name written in a type: a simple type name, or the first
 * identifier of a qualified one. There, only types (and, for a qualifier,
 * packages) compete for the name: a simple type name is a TypeName and the
 * qualifier of `Q.Id` is a PackageOrTypeName (JLS 6.5.4.1, 6.5.5), and a
 * variable never obscures either (JLS 6.4.2 covers ambiguous expression names
 * only). So a scope where the name is only a field, parameter, local, lambda
 * parameter, record component or method is passed over, and a scope that binds
 * a type of that name as well keeps only the type. Any scope that claims or
 * imports the name, or binds it to a type, answers as before. Each retry
 * starts outside the scope that answered, so it runs at most once per
 * enclosing scope. Never use it for an expression, where variables come first.
 */
export function lookupJavaTypeNameClaim(
  scopeId: ScopeId,
  name: string,
  indexes: ScopeResolutionIndexes,
  position?: TypeRef['lookupPosition'],
): NameClaimResult {
  const seen = new Set<ScopeId>();
  for (let start: ScopeId | null = scopeId; start !== null && !seen.has(start); ) {
    seen.add(start);
    const claim = lookupNameClaim(start, name, indexes, { purpose: 'type', position });
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
 * type (`models.User` in a subclass of `Base` is `Base.models.User`), a
 * protected one included; an ambiguous, inaccessible or unprovable inherited
 * reading refuses. A single static import of the root comes next, before the
 * same-package and imported types it shadows (`Inner.Nested` after `import
 * static p.Outer.Inner;`). Otherwise an unclaimed root is a package
 * (`models.User`). A root that names one type
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
  if (file === undefined || bindsTypeParameter(ref.declaredAtScope, root, indexes)) return null;
  let claim = lookupJavaTypeNameClaim(ref.declaredAtScope, root, indexes, ref.lookupPosition);
  const scope = ref.declaredAtScope;
  // Name lookup binds no inherited member type, yet one shadows every type
  // and package of that name from farther out (JLS 6.4.1): the spelling is a
  // member path of the supertype that declares it. A claim at or inside the
  // inheriting class is nearer and keeps its reading below. Mirrors
  // `qualifierRoot` in overload-resolution.ts.
  const inherited = inheritedTypeReading(ref, root, indexes, claim);
  if (inherited === null) return null;
  if (inherited !== undefined) return `${inherited}${spelling.slice(root.length)}`;
  // A single static import of the root is file-level, like the imports and
  // same-package types the module scope binds, and shadows both (JLS 6.4.1),
  // so it is read before them; a type declared in this file is not shadowed.
  // An import that brings in no type leaves the root to the other readings,
  // without the binding name lookup gave the static field or method. Mirrors
  // `qualifierRoot` in overload-resolution.ts.
  if (
    claim.status === 'absent' ||
    (claim.scope?.kind === 'Module' &&
      claim.bindings.every((binding) => binding.origin !== 'local'))
  ) {
    const statically = staticImportQualifier(file, root, indexes);
    if (statically === null) return null;
    if (statically === 'none') {
      const bindings = claim.bindings.filter((binding) => binding.origin !== 'import');
      if (bindings.length !== claim.bindings.length)
        claim = bindings.length === 0 ? NO_CLAIM : { ...claim, bindings };
    } else if (statically !== undefined) return `${statically.fqn}${spelling.slice(root.length)}`;
  }
  if (claim.status === 'absent') {
    // The sibling cap can omit a top-level type from module bindings. Use
    // the uncapped package inventory before considering on-demand imports.
    if (isJavaPackageSiblingVisibilityIncomplete(file)) {
      const sibling = hasJavaSamePackageType(file, root);
      if (sibling === undefined) return null;
      if (sibling) {
        const pkg = getJavaPackageFact(file);
        if (
          pkg?.status !== 'known' ||
          importIndex(file)
            .single.get(root)
            ?.some((item) => !item.static)
        )
          return null;
        const owner = pkg.packageName === '' ? root : `${pkg.packageName}.${root}`;
        const candidates = namedTypesByFqnByIndexes.get(indexes)?.get(owner);
        return candidates?.length === 1 && candidates[0]!.ownerId === undefined
          ? owner + spelling.slice(root.length)
          : null;
      }
    }
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
  const candidates = new Map<string, { binding: BindingRef; named: NamedType }[]>();
  const hierarchies = new Map<string, ClassHierarchy>();
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
    for (const { def, ...named } of collectNamedTypes(
      parsed,
      pkg.packageName,
      hierarchies,
    ).values()) {
      namedTypes.set(def.nodeId, named);
      const sameName = namedTypesByFqn.get(named.fqn) ?? [];
      sameName.push(named);
      namedTypesByFqn.set(named.fqn, sameName);
      const entries = candidates.get(named.fqn) ?? [];
      entries.push({ binding: { def, origin: 'namespace' }, named });
      candidates.set(named.fqn, entries);
    }
  }
  namedTypesByIndexes.set(indexes, namedTypes);
  hierarchiesByIndexes.set(indexes, hierarchies);
  namedTypesByFqnByIndexes.set(indexes, namedTypesByFqn);
  importedSpellingsByIndexes.set(indexes, importedSpellings);
  // Inherited fields need the written direct bases. Install their TypeRefs
  // before collecting the qualified names needed by the class scopes below.
  populateJavaInheritedFieldTypes(parsedFiles, indexes, (id) => writtenJavaParents(id, indexes));
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
  // Package siblings share one another's module type facts, the same TypeRef
  // objects. A simple spelling's key reads no module scope, the only place
  // this loop writes, so each object is read once (`null`: no key).
  const simpleKeys = new Map<TypeRef, string | null>();
  for (const parsed of parsedFiles) {
    const module = parsed.scopes.find((scope) => scope.kind === 'Module');
    const pkg = getJavaPackageFact(parsed.filePath);
    if (module === undefined || pkg?.status !== 'known') continue;
    const needed = new Set<string>();
    const need = (ref: TypeRef): void => {
      if (ref.source === 'assignment-inferred' && ref.declaredSpelling === undefined) return;
      // A qualified type argument (`Consumer<app.Other>`) types a lambda
      // parameter where it was written (`javaSamLambdaParameterType`).
      for (const argument of qualifiedTypeArguments(ref.declaredSpelling)) {
        const key = qualifiedTypeKey(ref, argument, indexes);
        if (typeof key === 'string') needed.add(key);
      }
      const known = simpleKeys.get(ref);
      if (known !== undefined) {
        if (known !== null) needed.add(known);
        return;
      }
      const spelling = eraseJavaTypeArguments(ref.declaredSpelling ?? ref.rawName).replace(
        /(?:\[\])+$/,
        '',
      );
      if (spelling.includes('.')) {
        const key = qualifiedTypeKey(ref, spelling, indexes);
        if (typeof key === 'string') needed.add(key);
        return;
      }
      const key = inheritedSimpleTypeKey(ref, spelling.replaceAll(/\s+/g, ''), indexes);
      simpleKeys.set(ref, typeof key === 'string' ? key : null);
      if (typeof key === 'string') needed.add(key);
    };
    for (const scope of parsed.scopes) {
      for (const ref of scope.typeBindings.values()) need(ref);
      // An index step on a selected producer's result (`make()[0]`) looks the
      // array element up where the return type was written: the method's own
      // scope, as the workspace index records it. That reading can differ from
      // the hoisted module-level return binding's (an inherited member type).
      if (scope.kind !== 'Function' || scope.parent === null) continue;
      for (const def of scope.ownedDefs)
        if (def.returnType?.endsWith(']') === true)
          need({ rawName: def.returnType, declaredAtScope: scope.id, source: 'return-annotation' });
    }
    // A caller's loop variable may later take a declared return type's element,
    // which is looked up here, where that return type was written.
    for (const fact of javaReturnElementFacts(parsed))
      for (const element of fact.elements)
        if (indexes.scopeTree.getScope(element.scope) !== undefined)
          need(javaReturnElementRef(fact, element));
    for (const key of needed) {
      // A path whose only non-public types are protected is accessible from
      // another package in a subclass body only, which each use site checks
      // (`javaQualifiedTypeLookupSpelling`).
      const visible = (candidates.get(key) ?? []).filter(
        ({ binding, named }) =>
          (named.public ||
            (named.packageName === pkg.packageName &&
              (!named.private || binding.def.filePath === parsed.filePath)) ||
            (!named.private && !named.packageAccess)) &&
          isJvmSourceVisible(parsed.filePath, binding.def.filePath),
      );
      if (visible.length !== 1) continue;
      let names = augmentations.get(module.id);
      if (names === undefined) augmentations.set(module.id, (names = new Map()));
      names.set(key, [visible[0]!.binding]);
    }
  }
}

const QUALIFIED_NAME = new RegExp(`^${JAVA_IDENTIFIER}(?:\\.${JAVA_IDENTIFIER})+$`, 'u');

/** The top-level type arguments of `spelling` written as qualified class names. */
function qualifiedTypeArguments(spelling: string | undefined): string[] {
  const open = spelling?.indexOf('<') ?? -1;
  const close = spelling?.lastIndexOf('>') ?? -1;
  if (spelling === undefined || open < 0 || close < open || !spelling.includes('.', open))
    return [];
  return (splitJavaTypeArguments(spelling.slice(open + 1, close)) ?? [])
    .map((argument) => argument.replaceAll(/\s+/g, ''))
    .filter((argument) => QUALIFIED_NAME.test(argument));
}

/**
 * The module-level spelling a Java declared type is looked up by, or `null`
 * to refuse it. A missing qualified type is a final refusal, never a
 * simple-name retry. A simple name is renamed only when an enclosing class
 * inherits a member type of that name (see `inheritedSimpleTypeKey`).
 */
export function javaQualifiedTypeLookupSpelling(
  ref: TypeRef,
  indexes?: ScopeResolutionIndexes,
): string | null | undefined {
  const spelling = eraseJavaTypeArguments(ref.declaredSpelling ?? ref.rawName);
  if (!spelling.includes('.')) {
    if (indexes === undefined) return undefined;
    const key = inheritedSimpleTypeKey(ref, spelling.replaceAll(/\s+/g, ''), indexes);
    return typeof key === 'string' ? moduleTypeKey(ref, key, indexes) : key;
  }
  if (ref.declaredSpelling === undefined) return undefined;
  if (spelling.endsWith('[]') || indexes === undefined) return null;
  const key = qualifiedTypeKey(ref, spelling, indexes);
  return key === null ? null : moduleTypeKey(ref, key, indexes);
}

/** `key` when the module-level binding registered for it is accessible where
 * `ref` was written, else `null`. */
function moduleTypeKey(ref: TypeRef, key: string, indexes: ScopeResolutionIndexes): string | null {
  let scope = indexes.scopeTree.getScope(ref.declaredAtScope);
  while (scope !== undefined && scope.kind !== 'Module')
    scope = scope.parent === null ? undefined : indexes.scopeTree.getScope(scope.parent);
  const bindings =
    scope === undefined ? undefined : indexes.bindingAugmentations.get(scope.id)?.get(key);
  if (bindings?.length !== 1) return null;
  const named = namedTypesByIndexes.get(indexes)?.get(bindings[0]!.def.nodeId);
  if (named === undefined || named.public) return key;
  // The module-level binding serves every use in the file. A private type on
  // the path is accessible only inside its own top-level type's body, not from
  // another top-level type in the same file (JLS 6.6.1).
  if (named.private)
    return ref.declaredAtScope === named.topLevelScope ||
      indexes.scopeTree.getAncestors(ref.declaredAtScope).includes(named.topLevelScope)
      ? key
      : null;
  // From another package, a protected type on the path is accessible only in
  // the body of a subclass of the type that declares it (JLS 6.6.2.1).
  const pkg = scope === undefined ? undefined : getJavaPackageFact(scope.filePath);
  if (pkg?.status === 'known' && pkg.packageName === named.packageName) return key;
  return !named.packageAccess &&
    named.protectedOwners.every((owner) =>
      enclosingTypeInherits(ref.declaredAtScope, owner, indexes),
    )
    ? key
    : null;
}
