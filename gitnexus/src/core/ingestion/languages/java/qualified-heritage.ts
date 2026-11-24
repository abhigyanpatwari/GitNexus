import type { ParsedFile, ReferenceSite, ScopeId } from 'gitnexus-shared';
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

/** A package contains top-level declarations. Subsequent segments must be
 * actual members of the type that precedes them. */
function namedTypes(written: string, inventory: JavaWorkspaceTypeInventory): TypeEntry[] {
  const parts = written.split('.');
  const result: TypeEntry[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    let types = inventory.packageTypes.get(parts.slice(0, i).join('.'))?.get(parts[i]!);
    if (types === undefined) continue;
    for (const member of parts.slice(i + 1))
      types = types.flatMap((type) => {
        const declared = membersNamed(type.members, member);
        if (declared.length) return declared;
        const inherited = inventory.namesOf(type);
        return inherited.unknown ? [] : membersNamed(inherited.members, member);
      });
    result.push(...types);
  }
  return result;
}

function headerCanNamePackage(
  owner: TypeEntry,
  root: string,
  module: ScopeId,
  inventory: JavaWorkspaceTypeInventory,
): boolean {
  for (let type: TypeEntry | undefined = owner; type !== undefined; type = type.parent) {
    if (type.fact.simpleName === root || type.fact.typeParameters.includes(root)) return false;
    if (type !== owner) {
      if (type.memberNames.has(root)) return false;
      const inherited = inventory.namesOf(type);
      if (inherited.unknown || inherited.names.has(root)) return false;
    }
    // A local or anonymous class can see names from an enclosing executable.
    if (type.parent === undefined) return type.declaringScope === module;
  }
  return false;
}

type RootOrigin = 'package' | 'shadowed' | 'uncertain' | { type: string };

function fileRootOrigin(
  owner: TypeEntry,
  root: string,
  inventory: JavaWorkspaceTypeInventory,
): RootOrigin {
  if (inventory.staticImportsType(owner, root) !== false) return 'shadowed';
  const imports = owner.facts.imports
    .filter((item) => !item.static && !item.wildcard)
    .map((item) => stripGaps(item.name))
    .filter((name) => name.split('.').at(-1) === root);
  const single = new Set(imports);
  if (single.size === 1) return { type: imports[0]! };
  if (single.size > 1) return 'shadowed';
  if (inventory.packageTypes.get(owner.packageName)?.has(root))
    return { type: owner.packageName ? owner.packageName + '.' + root : root };
  let importedType = platformPackageHasType('java.lang', root) ? 'java.lang.' + root : undefined;
  for (const item of owner.facts.imports) {
    if (!item.wildcard) continue;
    const name = stripGaps(item.name);
    if (item.static) {
      const member = inventory.staticMemberType(owner, name, root);
      if (member === true) return 'shadowed';
      if (member === 'uncertain') return 'uncertain';
      continue;
    }
    const source = inventory.packageTypes.get(name);
    const platform = platformPackageHasType(name, root);
    if (!source && platform === undefined) return 'uncertain';
    if (!source?.has(root) && !platform) continue;
    const candidate = name + '.' + root;
    if (importedType && candidate !== importedType) return 'uncertain';
    importedType = candidate;
  }
  return importedType ? { type: importedType } : 'package';
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
  target: TypeEntry,
  owner: TypeEntry,
  inventory: JavaWorkspaceTypeInventory,
): boolean {
  if (!isJvmSourceVisible(owner.filePath, target.filePath)) return false;
  for (let type: TypeEntry | undefined = target; type !== undefined; type = type.parent) {
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
  const typesByName = new Map<string, TypeEntry[]>();
  const duplicateNamesByFile = new Map<string, Set<string>>();
  for (const [index, file] of files.entries()) {
    const entries = inventory.byFile.get(file.filePath);
    if (
      entries === undefined ||
      !getJavaOverloadFacts(file.filePath)?.types.some((type) =>
        type.bases.some((base) => base.includes('.')),
      )
    )
      continue;
    const sites = new Map<ScopeId, ReferenceSite[]>();
    for (const site of file.referenceSites) {
      if (site.kind !== 'inherits') continue;
      const list = sites.get(site.inScope);
      if (list === undefined) sites.set(site.inScope, [site]);
      else list.push(site);
    }
    const replacements = new Map<ReferenceSite, ReferenceSite>();
    const fileRoots = new Map<string, RootOrigin>();
    for (const scope of file.scopes) {
      const references = sites.get(scope.id);
      const owner =
        references === undefined ? undefined : entries.get(javaOverloadRangeKey(scope.range));
      if (
        owner === undefined ||
        references === undefined ||
        references.length !== owner.fact.bases.length
      )
        continue;
      // The parser records extends and implements in source order, including
      // two interfaces with the same simple name and different packages.
      references.sort(
        (a, b) =>
          a.atRange.startLine - b.atRange.startLine || a.atRange.startCol - b.atRange.startCol,
      );
      for (const [i, site] of references.entries()) {
        const written = eraseJavaTypeArguments(stripGaps(owner.fact.bases[i]!));
        const dot = written.indexOf('.');
        if (dot < 0 || !written.endsWith('.' + site.name) || !qualifiedName.test(written)) continue;
        const root = written.slice(0, dot);
        if (!headerCanNamePackage(owner, root, file.moduleScope, inventory)) continue;
        let origin = fileRoots.get(root);
        if (origin === undefined) {
          origin = fileRootOrigin(owner, root, inventory);
          fileRoots.set(root, origin);
        }
        if (origin === 'uncertain') {
          replacements.set(site, { ...site, unresolvedInheritanceBase: true });
          continue;
        }
        if (origin === 'shadowed') continue;
        // An implicitly imported type shadows the workspace package even when
        // no source declaration models the platform type's members (JLS 6.5.2).
        const qualified = origin === 'package' ? written : origin.type + written.slice(dot);
        let candidates = typesByName.get(qualified);
        if (candidates === undefined) {
          candidates = namedTypes(qualified, inventory);
          typesByName.set(qualified, candidates);
        }
        if (candidates.length === 0) {
          if (
            origin === 'package' ||
            (origin.type.includes('.') && namedTypes(origin.type, inventory).length === 0)
          )
            replacements.set(site, { ...site, unresolvedInheritanceBase: true });
          continue;
        }
        const visible = candidates.filter((candidate) => accessible(candidate, owner, inventory));
        if (visible.length !== 1) continue;
        const target = visible[0]!;
        if (target.parent === undefined && target.facts.types.length > 1) {
          // A nested declaration can share this module binding. The class extractor
          // gives colliding declarations distinct qualified names.
          let duplicates = duplicateNamesByFile.get(target.filePath);
          if (duplicates === undefined) {
            const seen = new Set<string>();
            duplicates = new Set<string>();
            for (const { simpleName } of target.facts.types) {
              if (seen.has(simpleName)) duplicates.add(simpleName);
              seen.add(simpleName);
            }
            duplicateNamesByFile.set(target.filePath, duplicates);
          }
          if (duplicates.has(site.name) && target.declaringScope != null) {
            replacements.set(site, {
              ...site,
              lookupScope: target.declaringScope,
              rawQualifiedName: qualified,
            });
            continue;
          }
        }
        if (target.declaringScope != null)
          replacements.set(site, { ...site, lookupScope: target.declaringScope });
      }
    }
    if (replacements.size > 0) {
      files[index] = {
        ...file,
        referenceSites: file.referenceSites.map((site) => replacements.get(site) ?? site),
      };
    }
  }
}
