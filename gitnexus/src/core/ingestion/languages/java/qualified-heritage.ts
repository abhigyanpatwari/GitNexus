import type { ParsedFile, Range, ReferenceSite, ScopeId, TypeParameter } from 'gitnexus-shared';
import { isJvmSourceVisible } from '../jvm/source-visibility.js';
import { platformPackageHasType } from './platform-packages.js';
import type { JavaWorkspaceTypeInventory, TypeEntry } from './lombok-workspace-proof.js';
import {
  getJavaOverloadFacts,
  javaOverloadRangeKey,
  javaRangeContains,
} from './overload-argument-facts.js';
import { eraseJavaTypeArguments, JAVA_QUALIFIED_NAME, stripGaps } from './type-spelling.js';

const qualifiedName = new RegExp('^' + JAVA_QUALIFIED_NAME + '$', 'u');

const namesByMembers = new WeakMap<readonly TypeEntry[], ReadonlyMap<string, TypeEntry[]>>();

function membersNamed(members: readonly TypeEntry[], name: string): TypeEntry[] {
  let index = namesByMembers.get(members);
  if (!index) {
    const byName = new Map<string, TypeEntry[]>();
    for (const entry of members) {
      const key = entry.fact.simpleName;
      const entries = byName.get(key);
      if (entries) entries.push(entry);
      else byName.set(key, [entry]);
    }
    namesByMembers.set(members, byName);
    index = byName;
  }
  return index.get(name) ?? [];
}

type QualifiedType = { type: TypeEntry; qualifier?: QualifiedType };

function nestedTypes(
  roots: QualifiedType[],
  members: string[],
  inventory: JavaWorkspaceTypeInventory,
): QualifiedType[] {
  return members.reduce(
    (types, name) =>
      types.flatMap((qualifier) => {
        const { type } = qualifier;
        let matches = membersNamed(type.members, name);
        if (matches.length === 0) {
          const inherited = inventory.namesOf(type);
          if (inherited.unknown) return [];
          matches = membersNamed(inherited.members, name);
        }
        return matches.map((entry) => ({ type: entry, qualifier }));
      }),
    roots,
  );
}

/** A package contains top-level declarations. Subsequent segments must be
 * actual members of the type that precedes them. */
function namedTypes(written: string, inventory: JavaWorkspaceTypeInventory): QualifiedType[] {
  const parts = written.split('.');
  const result: QualifiedType[] = [];
  // A bare root names a top-level declaration in the unnamed package.
  const first = parts.length === 1 ? 0 : 1;
  for (let i = parts.length - 1; i >= first; i--) {
    const roots = inventory.packageTypes.get(parts.slice(0, i).join('.'))?.get(parts[i]!);
    if (roots)
      result.push(
        ...nestedTypes(
          roots.map((type) => ({ type })),
          parts.slice(i + 1),
          inventory,
        ),
      );
  }
  return result;
}

type RootOrigin = 'package' | 'shadowed' | 'uncertain' | { type: string; local?: TypeEntry };
type HeaderParameterLookup = (range: Range, name: string) => RootOrigin;

function shadowsHeaderRoot(
  type: TypeEntry,
  root: string,
  inventory: JavaWorkspaceTypeInventory,
): boolean {
  if (type.memberNames.has(root)) return true;
  const inherited = inventory.namesOf(type);
  return inherited.unknown || inherited.names.has(root);
}

function classHeaderRoot(
  owner: TypeEntry,
  root: string,
  module: ScopeId,
  inventory: JavaWorkspaceTypeInventory,
  parameter: HeaderParameterLookup,
): RootOrigin | undefined {
  for (let type: TypeEntry | undefined = owner; type !== undefined; type = type.parent) {
    if (type.fact.simpleName === root) return 'shadowed';
    if (type.fact.typeParameters.includes(root)) return parameter(type.fact.range, root);
    if (type !== owner && shadowsHeaderRoot(type, root, inventory)) return 'shadowed';
    if (type.parent === undefined) {
      return type.declaringScope === module
        ? undefined
        : executableHeaderRoot(owner, root, module, inventory, parameter);
    }
  }
  return undefined;
}

/** A local or anonymous declaration can use a package-qualified base. A type
 * declared in an enclosing block is visible only after its declaration. */
function executableHeaderRoot(
  owner: TypeEntry,
  root: string,
  module: ScopeId,
  inventory: JavaWorkspaceTypeInventory,
  parameter: HeaderParameterLookup,
): RootOrigin | undefined {
  const at = owner.fact.range;
  let nearest: { range: Range; origin: RootOrigin } | undefined;
  function consider(range: Range, origin: RootOrigin) {
    if (javaRangeContains(range, at) && (!nearest || javaRangeContains(nearest.range, range))) {
      nearest = { range, origin };
    }
  }
  for (const method of owner.facts.methods.filter((method) =>
    method.typeParameters.includes(root),
  )) {
    if (javaRangeContains(method.range, at)) consider(method.range, parameter(method.range, root));
  }
  for (const entry of inventory.byFile.get(owner.filePath)?.values() ?? []) {
    if (entry.declaringScope !== module && entry.fact.simpleName === root)
      consider(entry.fact.visible, { type: entry.fact.name, local: entry });
    if (!javaRangeContains(entry.fact.range, at)) continue;
    if (entry.fact.typeParameters.includes(root))
      consider(entry.fact.range, parameter(entry.fact.range, root));
    if (entry === owner || entry.memberNames.has(root)) continue;
    const origin = inheritedHeaderOrigin(entry, root, inventory);
    if (origin !== undefined) consider(entry.fact.range, origin);
  }
  return nearest?.origin;
}

function inheritedHeaderOrigin(
  entry: TypeEntry,
  root: string,
  inventory: JavaWorkspaceTypeInventory,
): RootOrigin | undefined {
  const inherited = inventory.namesOf(entry);
  const candidates = membersNamed(inherited.members, root);
  if (inherited.unknown || candidates.length > 1) return 'uncertain';
  const member = candidates[0];
  return member && { type: member.fact.name, local: member };
}

function fileRootOrigin(
  owner: TypeEntry,
  root: string,
  inventory: JavaWorkspaceTypeInventory,
): RootOrigin {
  const staticImport = inventory.staticImportsType(owner, root);
  if (staticImport === 'uncertain') return 'uncertain';
  if (staticImport === true) return 'shadowed';
  const imports = owner.facts.imports
    .filter((item) => !item.static && !item.wildcard)
    .map((item) => stripGaps(item.name))
    .filter((name) => name.split('.').at(-1) === root);
  const single = new Set(imports);
  if (single.size === 1) return { type: imports[0]! };
  if (single.size > 1) return 'shadowed';
  if (inventory.packageTypes.get(owner.packageName)?.has(root))
    return { type: owner.packageName ? owner.packageName + '.' + root : root };
  return wildcardRootOrigin(owner, root, inventory);
}

function wildcardRootOrigin(
  owner: TypeEntry,
  root: string,
  inventory: JavaWorkspaceTypeInventory,
): RootOrigin {
  let importedType = platformPackageHasType('java.lang', root) ? 'java.lang.' + root : undefined;
  for (const item of owner.facts.imports) {
    if (!item.wildcard) continue;
    const name = stripGaps(item.name);
    const match = wildcardImportOrigin(owner, root, name, item.static, inventory);
    if (match === undefined) continue;
    if (typeof match === 'string') return match;
    const candidate = match.type;
    if (importedType && candidate !== importedType) return 'uncertain';
    importedType = candidate;
  }
  return importedType ? { type: importedType } : 'package';
}

function wildcardImportOrigin(
  owner: TypeEntry,
  root: string,
  name: string,
  isStatic: boolean,
  inventory: JavaWorkspaceTypeInventory,
): RootOrigin | undefined {
  if (isStatic) {
    const member = inventory.staticMemberType(owner, name, root);
    if (member === true) return 'shadowed';
    return member === 'uncertain' ? 'uncertain' : undefined;
  }
  const source = inventory.packageTypes.get(name);
  const platform = platformPackageHasType(name, root);
  if (!source && platform === undefined) return 'uncertain';
  return source?.has(root) || platform ? { type: name + '.' + root } : undefined;
}

function boundRootOrigin(
  parameter: TypeParameter | undefined,
  declaration: Range,
  owner: TypeEntry,
  inventory: JavaWorkspaceTypeInventory,
): RootOrigin {
  if (!parameter) return 'shadowed';
  if (!parameter.bound) return 'uncertain'; // Object declares no member types.
  const bound = eraseJavaTypeArguments(stripGaps(parameter.bound));
  if (!qualifiedName.test(bound)) return 'shadowed';
  const [first, ...tail] = bound.split('.') as [string, ...string[]];
  // The bound is read at the parameter declaration, outside the derived class.
  let nearest: TypeEntry | undefined;
  for (const type of inventory.byFile.get(owner.filePath)?.values() ?? []) {
    if (
      type.fact.simpleName === first &&
      javaRangeContains(type.fact.visible, declaration) &&
      (!nearest || javaRangeContains(nearest.fact.visible, type.fact.visible))
    )
      nearest = type;
  }
  if (nearest) {
    const accessibleBounds = nestedTypes([{ type: nearest }], tail, inventory).filter((type) =>
      accessible(type, owner, inventory),
    );
    const target = accessibleBounds[0]?.type;
    if (!target || accessibleBounds.length !== 1) return 'uncertain';
    return { type: target.fact.name, local: target };
  }
  const declared = fileRootOrigin(owner, first, inventory);
  if (declared === 'package') return bound.includes('.') ? { type: bound } : 'shadowed';
  return typeof declared === 'string'
    ? declared
    : { type: declared.type + bound.slice(first.length) };
}

function qualifiedCandidates(
  origin: 'package' | { type: string; local?: TypeEntry },
  written: string,
  tail: string,
  inventory: JavaWorkspaceTypeInventory,
  cache: Map<string, QualifiedType[]>,
): QualifiedType[] {
  // A type root shadows a package. Local roots in different blocks can have
  // the same source spelling, so use their declaration identity in the cache.
  let key = written;
  if (origin !== 'package') {
    const root = origin.local;
    key =
      (root ? root.filePath + '#' + javaOverloadRangeKey(root.fact.range) : origin.type) +
      '/' +
      tail;
  }
  let candidates = cache.get(key);
  if (!candidates) {
    if (origin === 'package') candidates = namedTypes(written, inventory);
    else {
      const roots = origin.local ? [{ type: origin.local }] : namedTypes(origin.type, inventory);
      candidates = nestedTypes(roots, tail.split('.'), inventory);
    }
    cache.set(key, candidates);
  }
  return candidates;
}

function sharesTopLevelDeclaration(member: TypeEntry, owner: TypeEntry): boolean {
  if (member.filePath !== owner.filePath) return false;
  let top = member;
  while (top.parent) top = top.parent;
  return javaRangeContains(top.fact.range, owner.fact.range);
}

function enclosingSubclassInheritsMember(
  owner: TypeEntry,
  member: TypeEntry,
  inventory: JavaWorkspaceTypeInventory,
): boolean {
  // The extends clause is inside the bodies of the enclosing classes (JLS 6.6.2.1).
  // Compare declarations since an enclosing class can hide the inherited name.
  for (let enclosing = owner.parent; enclosing !== undefined; enclosing = enclosing.parent) {
    if (inventory.namesOf(enclosing).members.includes(member)) return true;
  }
  return false;
}

function accessible(
  target: QualifiedType,
  owner: TypeEntry,
  inventory: JavaWorkspaceTypeInventory,
): boolean {
  // An inherited public member may be named through a public subclass even
  // when its declaring superclass is package-private (JLS 6.6.1).
  for (let path: QualifiedType | undefined = target; path; path = path.qualifier) {
    const { type } = path;
    if (!isJvmSourceVisible(owner.filePath, type.filePath)) return false;
    const access = type.fact.modifiers;
    if (access?.includes('private') && !sharesTopLevelDeclaration(type, owner)) return false;
    if (type.packageName === owner.packageName || access?.includes('public')) continue;
    if (!access?.includes('protected') || !enclosingSubclassInheritsMember(owner, type, inventory))
      return false;
  }
  return true;
}

/** Bind the tail in the scope denoted by its written qualifier; retain the
 * deriving class as the structural owner used for the edge and the MRO. */
export function bindJavaQualifiedHeritage(
  files: ParsedFile[],
  inventory: JavaWorkspaceTypeInventory,
): void {
  const typesByName = new Map<string, QualifiedType[]>();
  const duplicateNamesByFile = new Map<string, Set<string>>();
  for (const [index, file] of files.entries()) {
    const entries = inventory.byFile.get(file.filePath);
    if (
      !entries ||
      !getJavaOverloadFacts(file.filePath)?.types.some((type) =>
        type.bases.some((base) => base.includes('.')),
      )
    )
      continue;
    files[index] = bindFileHeritage(file, entries, {
      inventory,
      typesByName,
      duplicateNamesByFile,
    });
  }
}

interface HeritageLookup {
  inventory: JavaWorkspaceTypeInventory;
  typesByName: Map<string, QualifiedType[]>;
  duplicateNamesByFile: Map<string, Set<string>>;
}

function inheritanceSites(file: ParsedFile): Map<ScopeId, ReferenceSite[]> {
  const sites = new Map<ScopeId, ReferenceSite[]>();
  for (const site of file.referenceSites) {
    if (site.kind !== 'inherits') continue;
    const list = sites.get(site.inScope);
    if (list) list.push(site);
    else sites.set(site.inScope, [site]);
  }
  return sites;
}

function headerParameterLookup(
  parametersAt: ReadonlyMap<string, readonly TypeParameter[]>,
  owner: TypeEntry,
  inventory: JavaWorkspaceTypeInventory,
): HeaderParameterLookup {
  return (range, name) =>
    boundRootOrigin(
      parametersAt.get(javaOverloadRangeKey(range))?.find((p) => p.name === name),
      range,
      owner,
      inventory,
    );
}

function bindFileHeritage(
  file: ParsedFile,
  entries: ReadonlyMap<string, TypeEntry>,
  lookup: HeritageLookup,
): ParsedFile {
  const sites = inheritanceSites(file);
  const parametersAt = new Map<string, readonly TypeParameter[]>();
  for (const scope of file.scopes) {
    const parameters = scope.ownedDefs.find((def) => def.typeParameters?.length)?.typeParameters;
    if (parameters) parametersAt.set(javaOverloadRangeKey(scope.range), parameters);
  }
  const fileRoots = new Map<string, RootOrigin>();
  const replacements = new Map<ReferenceSite, ReferenceSite>();
  for (const scope of file.scopes) {
    const references = sites.get(scope.id);
    if (!references) continue;
    const owner = entries.get(javaOverloadRangeKey(scope.range));
    if (!owner || references.length !== owner.fact.bases.length) continue;
    const parameter = headerParameterLookup(parametersAt, owner, lookup.inventory);
    // The parser records extends and implements in source order, including same-named interfaces from different packages.
    references.sort(
      (a, b) =>
        a.atRange.startLine - b.atRange.startLine || a.atRange.startCol - b.atRange.startCol,
    );
    for (const [i, site] of references.entries()) {
      const resolved = bindHeritageSite(
        site,
        owner.fact.bases[i]!,
        owner,
        file.moduleScope,
        parameter,
        fileRoots,
        lookup,
      );
      if (resolved) replacements.set(site, resolved);
    }
  }
  return replacements.size
    ? { ...file, referenceSites: file.referenceSites.map((site) => replacements.get(site) ?? site) }
    : file;
}

function bindHeritageSite(
  site: ReferenceSite,
  base: string,
  owner: TypeEntry,
  module: ScopeId,
  parameter: HeaderParameterLookup,
  fileRoots: Map<string, RootOrigin>,
  lookup: HeritageLookup,
): ReferenceSite | undefined {
  const written = eraseJavaTypeArguments(stripGaps(base));
  const dot = written.indexOf('.');
  if (dot < 0 || !written.endsWith('.' + site.name) || !qualifiedName.test(written))
    return undefined;
  const root = written.slice(0, dot);
  let origin =
    classHeaderRoot(owner, root, module, lookup.inventory, parameter) ?? fileRoots.get(root);
  if (origin === undefined) {
    origin = fileRootOrigin(owner, root, lookup.inventory);
    fileRoots.set(root, origin);
  }
  if (origin === 'shadowed') return undefined;
  if (origin === 'uncertain') return { ...site, unresolvedInheritanceBase: true };
  const candidates = qualifiedCandidates(
    origin,
    written,
    written.slice(dot + 1),
    lookup.inventory,
    lookup.typesByName,
  );
  const visible = candidates.filter((candidate) => accessible(candidate, owner, lookup.inventory));
  if (visible.length !== 1) return { ...site, unresolvedInheritanceBase: true };
  const target = visible[0]!.type;
  if (target.declaringScope == null) return undefined;
  if (hasDuplicateModuleName(target, site.name, lookup.duplicateNamesByFile)) {
    const qualified = origin === 'package' ? written : origin.type + written.slice(dot);
    return { ...site, lookupScope: target.declaringScope, rawQualifiedName: qualified };
  }
  return { ...site, lookupScope: target.declaringScope };
}

// A nested declaration can share a module binding with a top-level class.
function hasDuplicateModuleName(
  target: TypeEntry,
  name: string,
  byFile: Map<string, Set<string>>,
): boolean {
  if (target.parent !== undefined || target.facts.types.length < 2) return false;
  let duplicates = byFile.get(target.filePath);
  if (!duplicates) {
    const seen = new Set<string>();
    duplicates = new Set<string>();
    for (const { simpleName } of target.facts.types) {
      if (seen.has(simpleName)) duplicates.add(simpleName);
      seen.add(simpleName);
    }
    byFile.set(target.filePath, duplicates);
  }
  return duplicates.has(name);
}
