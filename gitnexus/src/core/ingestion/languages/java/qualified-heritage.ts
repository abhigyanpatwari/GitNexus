import type { ParsedFile, ReferenceSite, ScopeId } from 'gitnexus-shared';
import { isJvmSourceVisible } from '../jvm/source-visibility.js';
import type { JavaWorkspaceTypeInventory, TypeEntry } from './lombok-workspace-proof.js';
import {
  getJavaOverloadFacts,
  javaOverloadRangeKey,
  javaRangeContains,
} from './overload-argument-facts.js';
import { KNOWN_JAVA_PLATFORM_TYPES } from './overload-types.js';
import { eraseJavaTypeArguments, JAVA_QUALIFIED_NAME, stripGaps } from './type-spelling.js';

const qualifiedName = new RegExp('^' + JAVA_QUALIFIED_NAME + '$', 'u');

/** A package contains top-level declarations. Subsequent segments must be
 * actual members of the type that precedes them. */
function namedTypes(written: string, inventory: JavaWorkspaceTypeInventory): TypeEntry[] {
  const parts = written.split('.');
  const result: TypeEntry[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    let types = inventory.packageTypes.get(parts.slice(0, i).join('.'))?.get(parts[i]!);
    if (types === undefined) continue;
    for (const member of parts.slice(i + 1))
      types = types.flatMap((type) =>
        type.members.filter((child) => child.fact.simpleName === member),
      );
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
    const replacements = new Map<ReferenceSite, ScopeId>();
    const fileRoots = new Map<string, boolean>();
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
        let candidates = typesByName.get(written);
        if (candidates === undefined) {
          candidates = namedTypes(written, inventory);
          typesByName.set(written, candidates);
        }
        if (candidates.length === 0) continue;
        const root = written.slice(0, dot);
        let available = fileRoots.get(root);
        if (available === undefined) {
          available =
            !inventory.packageTypes.get(owner.packageName)?.has(root) &&
            !KNOWN_JAVA_PLATFORM_TYPES.has('java.lang.' + root) &&
            !owner.facts.imports.some((item) => {
              const name = stripGaps(item.name);
              return item.wildcard
                ? item.static || (inventory.packageTypes.get(name)?.has(root) ?? true)
                : name.split('.').at(-1) === root;
            });
          fileRoots.set(root, available);
        }
        if (!available || !headerCanNamePackage(owner, root, file.moduleScope, inventory)) continue;
        const visible = candidates.filter((candidate) => accessible(candidate, owner, inventory));
        if (visible.length !== 1) continue;
        const target = visible[0]!;
        if (target.parent === undefined && target.facts.types.length > 1) {
          // Member types can also have a module binding. A module scope alone
          // cannot identify the intended top-level declaration in that case.
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
          if (duplicates.has(site.name)) continue;
        }
        if (target.declaringScope != null) replacements.set(site, target.declaringScope);
      }
    }
    if (replacements.size > 0) {
      files[index] = {
        ...file,
        referenceSites: file.referenceSites.map((site) => {
          const lookupScope = replacements.get(site);
          return lookupScope === undefined ? site : { ...site, lookupScope };
        }),
      };
    }
  }
}
