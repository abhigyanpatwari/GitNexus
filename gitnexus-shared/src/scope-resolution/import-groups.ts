/**
 * `ImportVisibility` over shared import groups.
 *
 * An import statement that resolves to a whole list of files, and binds no
 * name from them, is stored once: a group holding the statement and the list.
 * The list is the provider's own array, so every scope that imports the same
 * package refers to one array and one membership set. Imports that bind a name
 * or carry a definition stay ordinary edges.
 *
 * Storage is one entry per statement plus one set per distinct list, instead
 * of one edge per (importing scope, file).
 */

import type { ImportEdge, ScopeId } from './types.js';
import {
  importTargetDirectory,
  isSelectableImport,
  type ImportMembership,
  type ImportVisibility,
} from './import-visibility.js';

/** One import statement that stands for every file of a shared list. */
export interface ImportGroup {
  /** How the statement is written: kind, position, presence flags. It names
   *  no single file, so `targetFile` is null. */
  readonly via: ImportEdge;
  /** The files the statement reaches. Shared, never copied, never mutated. */
  readonly targetFiles: readonly string[];
}

/** A scope's imports in the order they are written. */
export type ImportEntry = ImportEdge | ImportGroup;

const isGroup = (entry: ImportEntry): entry is ImportGroup => 'targetFiles' in entry;

interface SharedList {
  readonly files: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

/**
 * @param entriesByScope every recorded scope with its edges and groups in
 *   statement order.
 * @param edgesByScope the same scopes with their edges only, when the caller
 *   already holds those lists; otherwise they are derived on first request.
 */
export function createGroupedImportVisibility(
  entriesByScope: ReadonlyMap<ScopeId, readonly ImportEntry[]>,
  edgesByScope?: ReadonlyMap<ScopeId, readonly ImportEdge[]>,
): ImportVisibility {
  // A group is left out of `edgesAt`, which is only sound for an import no
  // reader can select by name, definition or kind. Refuse anything else here,
  // where the group is made, rather than let a lookup miss it later.
  for (const entries of entriesByScope.values()) {
    for (const entry of entries) {
      if (isGroup(entry) && isSelectableImport(entry.via))
        throw new Error(
          `Import group must be a nameless wildcard, got kind=${entry.via.kind} localName=${entry.via.localName}`,
        );
    }
  }

  // One index per distinct list, built the first time any scope asks about it.
  const sharedLists = new WeakMap<readonly string[], SharedList>();
  const shared = (targetFiles: readonly string[]): SharedList => {
    let list = sharedLists.get(targetFiles);
    if (list === undefined) {
      list = {
        files: new Set(targetFiles),
        directories: new Set(targetFiles.map(importTargetDirectory)),
      };
      sharedLists.set(targetFiles, list);
    }
    return list;
  };

  // The edges of each scope, without its groups. Built once per scope, on first
  // request, so `edgesAt` returns the same array every time.
  const edges = new Map<ScopeId, readonly ImportEdge[]>();
  const memberships = new Map<ScopeId, ImportMembership>();

  return {
    edgesAt(scope) {
      const entries = entriesByScope.get(scope);
      if (entries === undefined) return undefined;
      let own = edgesByScope?.get(scope) ?? edges.get(scope);
      if (own === undefined) {
        own = Object.freeze(entries.filter((entry): entry is ImportEdge => !isGroup(entry)));
        edges.set(scope, own);
      }
      return own;
    },
    scopes: () => entriesByScope.keys(),
    reaches(scope, targetFile) {
      for (const entry of entriesByScope.get(scope) ?? []) {
        if (
          isGroup(entry)
            ? shared(entry.targetFiles).files.has(targetFile)
            : entry.targetFile === targetFile
        )
          return true;
      }
      return false;
    },
    reachesDirectory(scope, directory) {
      for (const entry of entriesByScope.get(scope) ?? []) {
        if (
          isGroup(entry)
            ? shared(entry.targetFiles).directories.has(directory)
            : entry.targetFile !== null && importTargetDirectory(entry.targetFile) === directory
        )
          return true;
      }
      return false;
    },
    membership(scope) {
      const cached = memberships.get(scope);
      if (cached !== undefined) return cached;
      const own = new Set<string>();
      const lists: ReadonlySet<string>[] = [];
      for (const entry of entriesByScope.get(scope) ?? []) {
        if (isGroup(entry)) lists.push(shared(entry.targetFiles).files);
        else if (entry.targetFile !== null) own.add(entry.targetFile);
      }
      const all = [own, ...lists];
      const view: ImportMembership = {
        has: (targetFile) => all.some((files) => files.has(targetFile)),
        hasOtherThan: (file) =>
          all.some((files) => files.size > 1 || (files.size === 1 && !files.has(file))),
      };
      memberships.set(scope, view);
      return view;
    },
    forEachTarget(scope, visit) {
      for (const entry of entriesByScope.get(scope) ?? []) {
        if (isGroup(entry))
          for (const targetFile of entry.targetFiles) visit(targetFile, entry.via);
        else if (entry.targetFile !== null) visit(entry.targetFile, entry);
      }
    },
  };
}
